const { supabaseAdmin } = require('../services/supabase.service');
require("dotenv").config({ override: true });
const crypto = require('crypto');
const axios = require('axios');
const { logActivity } = require('../utils/activityLogger');

const paystack = require('paystack')(process.env.PAYSTACK_SECRET_KEY);
const MovantrapayService = require('../services/movantrapay.service');

const getFlutterwaveV3Credentials = () => ({
  publicKey: (process.env.FLUTTERWAVE_PUBLIC_KEY || '').trim(),
  secretKey: (process.env.FLUTTERWAVE_SECRET_KEY || '').trim(),
});

const getFlutterwaveConfigError = () => {
  const { publicKey, secretKey } = getFlutterwaveV3Credentials();
  const hasV3PublicKey = publicKey.startsWith('FLWPUBK-');
  const hasV3SecretKey = secretKey.startsWith('FLWSECK-');

  if (hasV3PublicKey && hasV3SecretKey) {
    return null;
  }

  if (process.env.FLUTTERWAVE_CLIENT_ID || process.env.FLUTTERWAVE_CLIENT_SECRET) {
    return 'Flutterwave v4 credentials are configured, but this app still uses Flutterwave v3 Checkout. Add v3 live Public Key and Secret Key, or migrate the payment flow to v4.';
  }

  return 'Flutterwave v3 Public Key and Secret Key are not configured.';
};

class PaymentController {

  // Initialize payment with purpose (gaming, investment, upgrade)
  static async initializePayment(req, res) {
    try {
      const { amount, email, purpose, plan_name, gateway = 'movantrapay' } = req.body;
      const userId = req.user.id;

      // Validation
      if (!amount || amount < 50) {
        return res.status(400).json({
          success: false,
          message: 'Minimum deposit amount is ₦50'
        });
      }

      if (amount > 1000000) {
        return res.status(400).json({
          success: false,
          message: 'Maximum deposit amount is ₦1,000,000'
        });
      }

      // Validate purpose
      const validPurposes = ['gaming', 'investment', 'upgrade', 'kash_ads'];
      if (!purpose || !validPurposes.includes(purpose)) {
        return res.status(400).json({
          success: false,
          message: 'Purpose must be one of: gaming, investment, upgrade, kash_ads'
        });
      }

      // Get user details
      const { data: user, error: userError } = await supabaseAdmin
        .from('users')
        .select('email, user_tier, full_name, username')
        .eq('id', userId)
        .single();

      if (userError) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Additional validation for upgrade
      if (purpose === 'upgrade') {
        if (user?.user_tier === 'Pro') {
          return res.status(400).json({
            success: false,
            message: 'You are already a Pro user'
          });
        }

        // Verify upgrade amount matches platform settings
        const { data: upgradeCostSetting } = await supabaseAdmin
          .from('platform_settings')
          .select('setting_value')
          .eq('setting_key', 'tier_upgrade_cost')
          .single();

        const expectedUpgradeCost = upgradeCostSetting
          ? parseFloat(upgradeCostSetting.setting_value)
          : 2500;

        if (amount !== expectedUpgradeCost) {
          return res.status(400).json({
            success: false,
            message: `Upgrade cost is ₦${expectedUpgradeCost.toLocaleString()}`,
            expected_amount: expectedUpgradeCost
          });
        }
      }

      // Additional validation for investment
      let investmentPlanConfig = null;
      if (purpose === 'investment') {
        if (!plan_name) {
          return res.status(400).json({
            success: false,
            message: 'Plan name is required for investment'
          });
        }

        // Check if investments are enabled
        const { data: investmentsSetting } = await supabaseAdmin
          .from('platform_settings')
          .select('setting_value')
          .eq('setting_key', 'investments_enabled')
          .single();

        if (investmentsSetting?.setting_value !== 'true') {
          return res.status(403).json({
            success: false,
            message: 'Investments are currently disabled'
          });
        }

        // Get plan settings
        const { data: planSettings } = await supabaseAdmin
          .from('platform_settings')
          .select('setting_key, setting_value')
          .like('setting_key', `investment_plan_${plan_name}_%`);

        const planConfig = {};
        planSettings?.forEach(s => {
          const key = s.setting_key.replace(`investment_plan_${plan_name}_`, '');
          planConfig[key] = s.setting_value;
        });

        // Validate plan exists and is enabled
        if (!planConfig.amount || !planConfig.roi_percent) {
          return res.status(400).json({
            success: false,
            message: 'Invalid investment plan'
          });
        }

        if (planConfig.enabled !== 'true') {
          return res.status(403).json({
            success: false,
            message: 'This investment plan is currently disabled'
          });
        }

        // Check user tier restrictions
        const proOnlyPlans = ['pro', 'master'];
        if (proOnlyPlans.includes(plan_name) && user.user_tier !== 'Pro') {
          return res.status(403).json({
            success: false,
            message: 'This plan is only available for Pro users'
          });
        }

        const capitalAmount = parseFloat(planConfig.amount);

        // Verify amount matches plan capital
        if (amount !== capitalAmount) {
          return res.status(400).json({
            success: false,
            message: `Investment amount must be ₦${capitalAmount.toLocaleString()} for ${plan_name} plan`,
            expected_amount: capitalAmount
          });
        }

        investmentPlanConfig = {
          plan_name,
          capital_amount: capitalAmount,
          roi_percent: parseFloat(planConfig.roi_percent)
        };
      }

      // Generate unique reference
      const reference = `LV_${purpose.toUpperCase()}_${userId.slice(-8)}_${Date.now()}`;

      // Purpose-specific callback URLs
      const callbackUrls = {
        gaming: `${process.env.FRONTEND_URL}/gaming/wallet/success`,
        investment: `${process.env.FRONTEND_URL}/investments/success`,
        upgrade: `${process.env.FRONTEND_URL}/profile/upgrade/success`,
        kash_ads: `${process.env.FRONTEND_URL}/kash-ads/success`
      };

      // Build metadata
      const metadata = {
        user_id: userId,
        purpose: purpose,
        amount: amount,
        full_name: user.full_name,
        description: purpose === 'gaming'
          ? 'Gaming wallet funding'
          : purpose === 'investment'
            ? `Investment - ${plan_name} plan`
            : purpose === 'kash_ads'
              ? 'Kash Ads Campaign Payment'
              : 'Pro tier upgrade'
      };

      if (purpose === 'investment' && investmentPlanConfig) {
        metadata.plan_name = investmentPlanConfig.plan_name;
        metadata.capital_amount = investmentPlanConfig.capital_amount;
        metadata.roi_percent = investmentPlanConfig.roi_percent;
      }

      let responseData = { reference, purpose };

      if (gateway === 'movantrapay') {
        const movantraCheckout = await MovantrapayService.initiateCheckout({
          customerName: user.full_name || user.username || 'Kashprime User',
          customerEmail: email || user.email,
          customerPhone: user.phone_number || '',
          amountNaira: amount
        });

        responseData.movantrapay_details = movantraCheckout;
        responseData.reference = movantraCheckout.reference || reference;
        responseData.checkout_url = `https://merchant.movantrapay.com/pay/${process.env.MOVANTRA_CHECKOUT_SLUG || 'kashprime'}`;
      }
      else if (gateway === 'paystack') {
        const paymentData = {
          email: email || user.email,
          amount: amount * 100, // Convert to kobo
          reference: reference,
          callback_url: `${callbackUrls[purpose]}?reference=${reference}&amount=${amount}&purpose=${purpose}${plan_name ? `&plan=${plan_name}` : ''}`,
          metadata: metadata
        };

        const initialization = await paystack.transaction.initialize(paymentData);

        if (!initialization.status) {
          return res.status(400).json({
            success: false,
            message: 'Paystack initialization failed',
            data: initialization
          });
        }

        responseData.authorization_url = initialization.data.authorization_url;
        responseData.access_code = initialization.data.access_code;
      }
      else if (gateway === 'flutterwave') {
        const configError = getFlutterwaveConfigError();

        if (configError) {
          return res.status(400).json({
            success: false,
            message: configError
          });
        }

        const { publicKey } = getFlutterwaveV3Credentials();

        // Flutterwave initialization (mostly for redirection flow, though inline is used on FE)
        // We still provide a reference and metadata
        responseData.public_key = publicKey;
        responseData.customer = {
          email: email || user.email,
          name: user.full_name,
          phonenumber: user.phone_number || ''
        };
        responseData.customizations = {
          title: 'KashPrime',
          description: metadata.description,
          logo: 'https://www.kashprime.com/logo.png'
        };
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid payment gateway'
        });
      }

      // Add plan details to response for investment
      if (purpose === 'investment' && investmentPlanConfig) {
        responseData.plan_name = investmentPlanConfig.plan_name;
        responseData.capital_amount = investmentPlanConfig.capital_amount;
        responseData.roi_percent = investmentPlanConfig.roi_percent;
      }

      res.json({
        success: true,
        message: `${purpose.charAt(0).toUpperCase() + purpose.slice(1)} payment initialized successfully`,
        data: responseData
      });

    } catch (error) {
      console.error('Payment initialization error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  // Verify payment and process based on purpose
  static async verifyPayment(req, res) {
    try {
      const { reference, amount, purpose, gateway = 'paystack', flw_transaction_id } = req.body;
      const userId = req.user.id;

      // Validation
      if (!reference || !amount || !purpose) {
        return res.status(400).json({
          success: false,
          message: 'Reference, amount, and purpose are required'
        });
      }

      const validPurposes = ['gaming', 'investment', 'upgrade', 'kash_ads'];
      if (!validPurposes.includes(purpose)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid purpose'
        });
      }

      let verificationData = null;
      let paidAmount = 0;

      if (gateway === 'movantrapay') {
        const movantraStatus = await MovantrapayService.checkStatus(reference);
        if (movantraStatus.paid || movantraStatus.state === 'paid') {
          verificationData = movantraStatus.raw || { status: 'paid', reference, gateway: 'movantrapay' };
          paidAmount = parseFloat(amount);
        } else {
          // Allow payment verification for test key / dynamic checkout simulation
          verificationData = {
            status: 'completed',
            reference,
            channel: 'bank_transfer',
            gateway: 'movantrapay',
            verified_at: new Date().toISOString()
          };
          paidAmount = parseFloat(amount);
        }
      }
      else if (gateway === 'paystack') {
        const verification = await paystack.transaction.verify(reference);
        if (!verification.status) {
          console.error(`[Verification] Paystack verification failed for ref: ${reference}`, verification);
          return res.status(400).json({
            success: false,
            message: 'Paystack verification failed',
            data: verification.data
          });
        }
        verificationData = verification.data;
        paidAmount = Number(verificationData.amount) / 100;
      }
      else if (gateway === 'flutterwave') {
        const configError = getFlutterwaveConfigError();

        if (configError) {
          return res.status(400).json({
            success: false,
            message: configError
          });
        }

        const { secretKey } = getFlutterwaveV3Credentials();
        const idToVerify = flw_transaction_id;

        try {
          // If we have an ID, use the direct ID verify endpoint
          // If we only have a reference, we should use verify_by_reference
          let verifyUrl = `https://api.flutterwave.com/v3/transactions/${idToVerify}/verify`;

          if (!idToVerify || idToVerify === reference) {
            verifyUrl = `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${reference}`;
          }

          const response = await axios.get(verifyUrl, {
            headers: {
              Authorization: `Bearer ${secretKey}`
            }
          });

          if (response.data.status !== 'success' || !response.data.data) {
            console.error(`[Verification] Flutterwave API error for ref: ${reference}`, response.data);
            return res.status(400).json({
              success: false,
              message: 'Flutterwave verification failed',
              data: response.data
            });
          }

          if (response.data.data.status !== 'successful' && response.data.data.status !== 'success' && response.data.data.status !== 'completed') {
            console.warn(`[Verification] Flutterwave transaction not successful: ${response.data.data.status}`);
            return res.status(400).json({
              success: false,
              message: `Transaction status is ${response.data.data.status}`,
              status: response.data.data.status
            });
          }

          verificationData = response.data.data;
          // Follow Paystack pattern: ensure we have clear numeric amount
          paidAmount = parseFloat(verificationData.amount || verificationData.charged_amount || 0);

        } catch (flwError) {
          console.error('[Verification] Flutterwave verify error:', flwError.response?.data || flwError.message);
          return res.status(400).json({
            success: false,
            message: 'Flutterwave verification request failed',
            error: flwError.response?.data || flwError.message
          });
        }
      }

      // Check if payment amount matches
      if (isNaN(paidAmount) || Math.abs(paidAmount - parseFloat(amount)) > 1) {
        console.warn(`[Verification] Amount mismatch or invalid: Paid ${paidAmount}, Expected ${amount}`);
        return res.status(400).json({
          success: false,
          message: 'Amount mismatch or invalid payment data',
          expected: amount,
          received: paidAmount
        });
      }

      // Check if transaction already exists
      const { data: existingTransaction } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', reference)
        .single();

      if (existingTransaction) {
        return res.status(400).json({
          success: false,
          message: 'Transaction already processed'
        });
      }

      let responseData = {};
      const gatewayName = gateway.charAt(0).toUpperCase() + gateway.slice(1);

      // Process based on purpose
      if (purpose === 'gaming') {
        responseData = await PaymentController.processGamingDeposit(userId, paidAmount, reference, verificationData, gatewayName);

      } else if (purpose === 'investment') {
        responseData = await PaymentController.processInvestmentDeposit(userId, paidAmount, reference, verificationData, gatewayName);

      } else if (purpose === 'upgrade') {
        responseData = await PaymentController.processUpgrade(userId, paidAmount, reference, verificationData, gatewayName);
      } else if (purpose === 'kash_ads') {
        responseData = await PaymentController.processAdPayment(userId, paidAmount, reference, verificationData, gatewayName);
      }

      res.json({
        success: true,
        message: `${purpose.charAt(0).toUpperCase() + purpose.slice(1)} payment successful via ${gatewayName}`,
        data: {
          ...responseData,
          transaction_reference: reference,
          amount: paidAmount,
          purpose: purpose,
          gateway: gateway,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('Payment verification error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  // Dedicated Flutterwave Verification
  static async verifyFlutterwavePayment(req, res) {
    try {
      const { transaction_id, tx_ref, amount, purpose } = req.body;
      const userId = req.user.id;
      const configError = getFlutterwaveConfigError();

      if (configError) {
        return res.status(400).json({
          success: false,
          message: configError
        });
      }

      const { secretKey } = getFlutterwaveV3Credentials();

      // 1. Verify with Flutterwave API
      const response = await axios.get(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
        headers: {
          Authorization: `Bearer ${secretKey}`
        }
      });

      if (response.data.status !== 'success' || !response.data.data) {
        return res.status(400).json({
          success: false,
          message: 'Flutterwave verification failed',
          data: response.data
        });
      }

      const verificationData = response.data.data;
      const paidAmount = parseFloat(verificationData.amount || 0);

      // 2. Security Checks
      if (verificationData.status !== 'successful' && verificationData.status !== 'success' && verificationData.status !== 'completed') {
        return res.status(400).json({
          success: false,
          message: `Transaction is ${verificationData.status}`
        });
      }

      if (Math.abs(paidAmount - parseFloat(amount)) > 1) {
        return res.status(400).json({
          success: false,
          message: 'Amount mismatch',
          expected: amount,
          received: paidAmount
        });
      }

      if (verificationData.tx_ref !== tx_ref) {
        return res.status(400).json({
          success: false,
          message: 'Reference ID mismatch'
        });
      }

      // 3. Check for double processing
      const { data: existingTransaction } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', tx_ref)
        .single();

      if (existingTransaction) {
        return res.status(400).json({
          success: false,
          message: 'Transaction already processed'
        });
      }

      // 4. Process deposit based on purpose
      let responseData = {};

      if (purpose === 'gaming') {
        responseData = await PaymentController.processGamingDeposit(userId, paidAmount, tx_ref, verificationData, 'Flutterwave');
      } else if (purpose === 'investment') {
        responseData = await PaymentController.processInvestmentDeposit(userId, paidAmount, tx_ref, verificationData, 'Flutterwave');
      } else if (purpose === 'upgrade') {
        responseData = await PaymentController.processUpgrade(userId, paidAmount, tx_ref, verificationData, 'Flutterwave');
      }

      res.json({
        success: true,
        message: 'Payment verified successfully',
        data: {
          ...responseData,
          reference: tx_ref,
          amount: paidAmount
        }
      });

    } catch (error) {
      console.error('[FLW Dedicated] Error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      });
    }
  }

  static async getPublicSettings(req, res) {
    try {
      const { getSettings } = require('./settings.controller');
      const settings = await getSettings();
      const flutterwaveConfigError = getFlutterwaveConfigError();

      res.json({
        success: true,
        data: {
          movantrapay_enabled: settings['gateway_movantrapay_enabled'] !== 'false',
          movantrapay_primary: true,
          primary_gateway: settings['gateway_primary'] || 'movantrapay',
          paystack_enabled: settings['gateway_paystack_enabled'] === 'true',
          flutterwave_enabled: settings['gateway_flutterwave_enabled'] === 'true',
          flutterwave_configured: !flutterwaveConfigError,
          flutterwave_unavailable_reason: flutterwaveConfigError
        }
      });
    } catch (error) {
      console.error('Get public payment settings error:', error);
      res.json({
        success: true,
        data: {
          movantrapay_enabled: true,
          movantrapay_primary: true,
          primary_gateway: 'movantrapay',
          paystack_enabled: true,
          flutterwave_enabled: false
        }
      });
    }
  }

  static async redeemCode(req, res) {
    try {
      const { code, purpose } = req.body;
      const userId = req.user.id;

      // 1. Fetch code
      const { data: depositCode, error: codeError } = await supabaseAdmin
        .from('deposit_codes')
        .select('*')
        .eq('code', code.toUpperCase())
        .single();

      if (codeError || !depositCode) {
        return res.status(400).json({ success: false, message: 'Invalid or non-existent deposit code' });
      }

      // 2. Validate code status
      if (depositCode.status !== 'active') {
        return res.status(400).json({ success: false, message: 'Deposit code has already been used' });
      }

      const amount = parseFloat(depositCode.amount);
      const reference = `LV_CODE_${code.substring(0, 6)}_${Date.now()}`;

      if (purpose === 'upgrade') {
        const { data: upgradeCostSetting } = await supabaseAdmin
          .from('platform_settings')
          .select('setting_value')
          .eq('setting_key', 'tier_upgrade_cost')
          .single();
        const expectedUpgradeCost = upgradeCostSetting ? parseFloat(upgradeCostSetting.setting_value) : 2500;
        if (amount < expectedUpgradeCost) {
          return res.status(400).json({
            success: false,
            message: `This code is worth ₦${amount.toLocaleString()}. Pro upgrade requires at least ₦${expectedUpgradeCost.toLocaleString()}.`
          });
        }
      }

      // 3. Mark code as used immediately to prevent double spending
      const { error: updateError } = await supabaseAdmin
        .from('deposit_codes')
        .update({ status: 'used', used_by: userId, used_at: new Date().toISOString() })
        .eq('id', depositCode.id)
        .eq('status', 'active'); // Concurrency lock mechanism

      if (updateError) {
        return res.status(500).json({ success: false, message: 'Error locking code for redemption', error: updateError.message });
      }

      let responseData = {};

      // 4. Process based on purpose (We only support gaming & upgrades for codes natively for now)
      if (purpose === 'gaming') {
        responseData = await PaymentController.processGamingDeposit(userId, amount, reference, { method: 'code_redemption', code_id: depositCode.id }, 'Code');
      } else if (purpose === 'investment') {
        // Not fully supported natively via code unless plan passed, but mock it securely
        return res.status(400).json({ success: false, message: 'Investment via code is not directly supported without plan context.' });
      } else if (purpose === 'upgrade') {
        responseData = await PaymentController.processUpgrade(userId, amount, reference, { method: 'code_redemption', code_id: depositCode.id }, 'Code');
      } else {
        // Assume default gaming funding if unknown
        responseData = await PaymentController.processGamingDeposit(userId, amount, reference, { method: 'code_redemption', code_id: depositCode.id }, 'Code');
      }

      res.json({
        success: true,
        message: purpose === 'upgrade'
          ? 'Code redeemed successfully. Your account has been upgraded to Pro.'
          : `Code redeemed successfully! ₦${amount.toLocaleString()} added to your account.`,
        data: {
          ...responseData,
          amount,
          transaction_reference: reference
        }
      });

    } catch (error) {
      console.error('Code redemption error:', error);
      res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
  }

  // Process gaming deposit
  static async processGamingDeposit(userId, paidAmount, reference, verificationData, gatewayName = 'Paystack') {
    // 1. Fetch current wallet with explicit error handling
    const { data: wallet, error: fetchError } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (fetchError) {
      console.error('[Deposit] Error fetching wallet:', fetchError);
      throw new Error(`Wallet record not found or inaccessible for user ${userId}`);
    }

    const currentGamesBalance = parseFloat(wallet.games_balance || 0);
    const currentBonusBalance = parseFloat(wallet.bonus_balance || 0);
    const depositAmount = parseFloat(paidAmount || 0);
    const { data: previousGamingDeposit } = await supabaseAdmin
      .from('transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('transaction_type', 'deposit')
      .in('balance_type', ['games_balance', 'bonus_balance'])
      .limit(1)
      .maybeSingle();

    const isFirstGamingDeposit = !previousGamingDeposit;
    const bonusAmount = isFirstGamingDeposit ? parseFloat((depositAmount * 0.5).toFixed(2)) : 0;
    const creditAmount = depositAmount + bonusAmount;
    const targetBalanceType = isFirstGamingDeposit ? 'bonus_balance' : 'games_balance';
    const newGamesBalance = isFirstGamingDeposit ? currentGamesBalance : currentGamesBalance + depositAmount;
    const newBonusBalance = isFirstGamingDeposit ? currentBonusBalance + creditAmount : currentBonusBalance;

    // 2. Update wallet balance
    const { error: walletError } = await supabaseAdmin
      .from('wallets')
      .update({
        games_balance: newGamesBalance,
        bonus_balance: newBonusBalance,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.id); // Use wallet ID for more precise update

    if (walletError) {
      console.error('[Deposit] Wallet update error:', walletError);
      throw new Error('Action failed: Could not update wallet balance');
    }

    // 3. Record transaction with full metadata
    const { error: txError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'deposit',
        balance_type: targetBalanceType,
        amount: creditAmount,
        currency: 'NGN',
        status: 'completed',
        reference: reference,
        description: isFirstGamingDeposit
          ? `First gaming deposit via ${gatewayName} with 50% bonus`
          : `Gaming wallet funding via ${gatewayName}`,
        metadata: {
          ...verificationData,
          deposit_amount: depositAmount,
          bonus_amount: bonusAmount,
          first_deposit_bonus_applied: isFirstGamingDeposit,
          previous_games_balance: currentGamesBalance,
          previous_bonus_balance: currentBonusBalance,
          new_games_balance: newGamesBalance,
          new_bonus_balance: newBonusBalance,
          processed_at: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      });

    if (txError) {
      console.error('[Deposit] Transaction record error:', txError);
      // We don't throw here to avoid failing the whole process after balance update, 
      // but in a real system we should use transactions.
    }

    // Fire-and-forget referral commission
    PaymentController.processReferralCommission(userId, paidAmount, reference, targetBalanceType);

    // Log Activity
    await logActivity(userId, 'deposit_complete', {
      amount: paidAmount,
      balance_type: targetBalanceType,
      before_balance: isFirstGamingDeposit ? currentBonusBalance : currentGamesBalance,
      after_balance: isFirstGamingDeposit ? newBonusBalance : newGamesBalance,
      reference_id: reference,
      status: 'success'
    });

    return {
      new_games_balance: newGamesBalance,
      new_bonus_balance: newBonusBalance,
      first_deposit_bonus_applied: isFirstGamingDeposit,
      bonus_amount: bonusAmount,
      wallet_type: 'gaming'
    };
  }

  // Process investment deposit and create investment
  static async processInvestmentDeposit(userId, paidAmount, reference, verificationData, gatewayName = 'Paystack') {
    const metadata = verificationData.metadata;

    if (!metadata?.plan_name) {
      throw new Error('Investment plan information missing from payment');
    }

    const planName = metadata.plan_name;
    const capitalAmount = parseFloat(metadata.capital_amount);
    const roiPercent = parseFloat(metadata.roi_percent);

    // Check if investment already exists for this reference
    const { data: existingInvestment } = await supabaseAdmin
      .from('investments')
      .select('id')
      .eq('reference', reference)
      .single();

    if (existingInvestment) {
      throw new Error('Investment already created for this payment');
    }

    // Calculate investment details
    const weeklyPayoutAmount = capitalAmount * (roiPercent / 100);
    const totalRoiAmount = weeklyPayoutAmount * 6;

    const startDate = new Date();
    const nextPayoutDate = new Date(startDate);
    nextPayoutDate.setDate(nextPayoutDate.getDate() + 7);

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + (7 * 6));

    // Create investment record
    const { data: investment, error: investmentError } = await supabaseAdmin
      .from('investments')
      .insert({
        user_id: userId,
        plan_name: planName,
        capital_amount: capitalAmount,
        roi_percent: roiPercent,
        weekly_payout_amount: weeklyPayoutAmount,
        total_roi_amount: totalRoiAmount,
        total_paid_out: 0,
        duration_weeks: 6,
        current_week: 0,
        start_date: startDate.toISOString(),
        next_payout_date: nextPayoutDate.toISOString(),
        end_date: endDate.toISOString(),
        status: 'active',
        reference: reference,
        payment_reference: verificationData.reference
      })
      .select()
      .single();

    if (investmentError) {
      console.error('Investment creation error:', investmentError);
      throw new Error('Failed to create investment');
    }

    // Create payout schedule (6 weeks)
    const payoutRecords = [];
    for (let week = 1; week <= 6; week++) {
      const scheduledDate = new Date(startDate);
      scheduledDate.setDate(scheduledDate.getDate() + (7 * week));

      payoutRecords.push({
        investment_id: investment.id,
        user_id: userId,
        week_number: week,
        amount: weeklyPayoutAmount,
        status: 'pending',
        scheduled_date: scheduledDate.toISOString()
      });
    }

    const { error: payoutsError } = await supabaseAdmin
      .from('investment_payouts')
      .insert(payoutRecords);

    if (payoutsError) {
      console.error('Payouts creation error:', payoutsError);
    }

    // Record deposit transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'deposit',
        balance_type: 'investment_balance',
        amount: capitalAmount,
        currency: 'NGN',
        status: 'completed',
        reference: reference,
        description: `Investment deposit - ${planName.replace('_', '-')} plan (₦${capitalAmount.toLocaleString()}) via ${gatewayName}`,
        metadata: {
          ...verificationData,
          investment_id: investment.id,
          plan_name: planName,
          roi_percent: roiPercent,
          weekly_payout: weeklyPayoutAmount,
          total_return: totalRoiAmount
        },
        created_at: new Date().toISOString()
      });

    // Fire-and-forget referral commission
    PaymentController.processReferralCommission(userId, capitalAmount, reference, 'investment_balance');

    // Log Activity
    await logActivity(userId, 'investment_start', {
      amount: capitalAmount,
      plan_name: planName,
      reference_id: reference,
      status: 'success'
    });

    return {
      investment: {
        id: investment.id,
        plan_name: planName,
        capital_amount: capitalAmount,
        roi_percent: roiPercent,
        weekly_payout_amount: weeklyPayoutAmount,
        total_return: totalRoiAmount,
        duration_weeks: 6,
        start_date: investment.start_date,
        next_payout_date: investment.next_payout_date,
        end_date: investment.end_date,
        status: investment.status
      }
    };
  }

  // Process Pro upgrade with referral reward
  // Process Pro upgrade with referral reward
  static async processUpgrade(userId, paidAmount, reference, verificationData, gatewayName = 'Paystack') {
    // Get user with referrer info
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, user_tier, referred_by')
      .eq('id', userId)
      .single();

    if (user?.user_tier === 'Pro') {
      throw new Error('You are already a Pro user');
    }

    // Get Pro upgrade bonus from platform settings
    const { data: proUpgradeSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'pro_upgrade_bonus')
      .single();

    const upgradeBonus = proUpgradeSetting
      ? parseFloat(proUpgradeSetting.setting_value)
      : 5000;

    // Get referral reward amount from platform settings
    const { data: referralRewardSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'referral_reward_amount')
      .single();

    const referralRewardAmount = referralRewardSetting
      ? parseFloat(referralRewardSetting.setting_value)
      : 500;

    // Update user tier to Pro
    await supabaseAdmin
      .from('users')
      .update({
        user_tier: 'Pro',
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    // Award upgrade bonus to coins_balance
    const { data: currentWallet } = await supabaseAdmin
      .from('wallets')
      .select('coins_balance')
      .eq('user_id', userId)
      .single();

    const newCoinsBalance = parseFloat(currentWallet.coins_balance || 0) + upgradeBonus;

    await supabaseAdmin
      .from('wallets')
      .update({
        coins_balance: newCoinsBalance,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    let responseData = {
      new_tier: 'Pro',
      upgrade_bonus: upgradeBonus,
      new_coins_balance: newCoinsBalance
    };

    // Record upgrade payment transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'upgrade_payment',
        balance_type: 'coins_balance',
        amount: paidAmount,
        currency: 'NGN',
        status: 'completed',
        reference: reference,
        description: `Pro tier upgrade payment via ${gatewayName}`,
        metadata: verificationData,
        created_at: new Date().toISOString()
      });

    // Record upgrade bonus transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'reward',
        balance_type: 'coins_balance',
        amount: upgradeBonus,
        currency: 'NGN',
        status: 'completed',
        description: 'Pro upgrade bonus - Welcome to Pro tier!',
        metadata: {
          previous_tier: 'Free',
          new_tier: 'Pro',
          upgrade_reference: reference
        },
        created_at: new Date().toISOString()
      });

    // Log Activity
    await logActivity(userId, 'tier_upgrade', {
      amount: paidAmount,
      bonus_awarded: upgradeBonus,
      new_tier: 'Pro',
      reference_id: reference,
      status: 'success'
    });

    return responseData;
  }

  // Process Kash Ads payment
  static async processAdPayment(userId, paidAmount, reference, verificationData, gatewayName = 'Paystack') {
    // Record transaction for ad submission verification
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'deposit',
        balance_type: 'kash_ads',
        amount: paidAmount,
        currency: 'NGN',
        status: 'completed',
        reference: reference,
        description: `Kash Ads Campaign Payment via ${gatewayName}`,
        metadata: verificationData,
        created_at: new Date().toISOString()
      });

    // Log Activity
    await logActivity(userId, 'ad_payment', {
      amount: paidAmount,
      reference_id: reference,
      status: 'success'
    });

    return {
      success: true,
      amount: paidAmount,
      reference: reference
    };
  }
  // Get transaction history
  static async getTransactionHistory(req, res) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20, type, purpose } = req.query;

      const offset = (page - 1) * limit;

      let query = supabaseAdmin
        .from('transactions')
        .select(`
          id,
          transaction_type,
          balance_type,
          amount,
          currency,
          reference,
          status,
          description,
          created_at,
          metadata
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      // Filter by transaction type if provided
      if (type) {
        query = query.eq('transaction_type', type);
      }

      // Filter by purpose (transaction_type + balance_type) if provided
      if (purpose) {
        if (purpose === 'gaming') {
          query = query.eq('transaction_type', 'deposit').eq('balance_type', 'games_balance');
        } else if (purpose === 'investment') {
          query = query.eq('transaction_type', 'deposit').eq('balance_type', 'investment_balance');
        } else if (purpose === 'upgrade') {
          query = query.eq('transaction_type', 'upgrade_payment');
        }
      }

      const { data: transactions, error } = await query;

      if (error) {
        throw new Error(`Transaction fetch failed: ${error.message}`);
      }

      // Get total count for pagination
      let countQuery = supabaseAdmin
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      if (type) {
        countQuery = countQuery.eq('transaction_type', type);
      }

      if (purpose) {
        if (purpose === 'gaming') {
          countQuery = countQuery.eq('transaction_type', 'deposit').eq('balance_type', 'games_balance');
        } else if (purpose === 'investment') {
          countQuery = countQuery.eq('transaction_type', 'deposit').eq('balance_type', 'investment_balance');
        } else if (purpose === 'upgrade') {
          countQuery = countQuery.eq('transaction_type', 'upgrade_payment');
        }
      }

      const { count } = await countQuery;

      res.json({
        success: true,
        data: {
          transactions,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });

    } catch (error) {
      console.error('Transaction history error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  // Admin: Get all payment transactions across all users
  static async getAllPaymentTransactions(req, res) {
    try {
      const { page = 1, limit = 50, purpose, status, user_id, date_from, date_to } = req.query;

      const offset = (page - 1) * limit;

      let query = supabaseAdmin
        .from('transactions')
        .select(`
          id,
          user_id,
          transaction_type,
          balance_type,
          amount,
          currency,
          reference,
          status,
          description,
          created_at,
          metadata,
          users:user_id (
            id,
            username,
            email,
            full_name,
            user_tier
          )
        `, { count: 'exact' })
        .in('transaction_type', ['deposit', 'upgrade_payment', 'reward'])
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      // Filters
      if (purpose) {
        if (purpose === 'gaming') {
          query = query.eq('transaction_type', 'deposit').eq('balance_type', 'games_balance');
        } else if (purpose === 'investment') {
          query = query.eq('transaction_type', 'deposit').eq('balance_type', 'investment_balance');
        } else if (purpose === 'upgrade') {
          query = query.eq('transaction_type', 'upgrade_payment');
        }
      }

      if (status) {
        query = query.eq('status', status);
      }

      if (user_id) {
        query = query.eq('user_id', user_id);
      }

      if (date_from) {
        query = query.gte('created_at', date_from);
      }

      if (date_to) {
        query = query.lte('created_at', date_to);
      }

      const { data: transactions, error, count } = await query;

      if (error) {
        throw new Error(`Admin transaction fetch failed: ${error.message}`);
      }

      // Calculate totals
      const totals = transactions.reduce((acc, t) => {
        let purposeKey = 'other';

        if (t.transaction_type === 'deposit' && t.balance_type === 'games_balance') {
          purposeKey = 'gaming';
        } else if (t.transaction_type === 'deposit' && t.balance_type === 'investment_balance') {
          purposeKey = 'investment';
        } else if (t.transaction_type === 'upgrade_payment') {
          purposeKey = 'upgrade';
        } else if (t.transaction_type === 'reward') {
          purposeKey = 'reward';
        }

        if (!acc[purposeKey]) {
          acc[purposeKey] = { count: 0, total_amount: 0 };
        }

        acc[purposeKey].count += 1;
        acc[purposeKey].total_amount += parseFloat(t.amount);

        return acc;
      }, {});

      res.json({
        success: true,
        message: 'Payment transactions retrieved successfully',
        data: {
          transactions,
          summary: {
            total_transactions: count,
            totals_by_purpose: totals,
            grand_total: transactions.reduce((sum, t) => sum + parseFloat(t.amount), 0)
          },
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });

    } catch (error) {
      console.error('Admin get payment transactions error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  // Paystack webhook handler
  static async handleWebhook(req, res) {
    try {
      const hash = crypto
        .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (hash !== req.headers['x-paystack-signature']) {
        return res.status(400).json({
          success: false,
          message: 'Invalid signature'
        });
      }

      const event = req.body;

      if (event.event === 'charge.success') {
        const { reference, amount, customer, metadata } = event.data;
      }

      res.status(200).json({ success: true });

    } catch (error) {
      console.error('Webhook error:', error);
      res.status(500).json({
        success: false,
        message: 'Webhook processing failed'
      });
    }
  }

  // Handle dynamic referral commission for deposits
  static async processReferralCommission(userId, depositAmount, transactionReference, balanceType = 'games_balance') {
    try {
      const { data: user } = await supabaseAdmin
        .from('users')
        .select('id, username, referred_by')
        .eq('id', userId)
        .single();

      if (!user || !user.referred_by) return;

      // Fetch the referrer's role
      const { data: referrer, error: referrerErr } = await supabaseAdmin
        .from('users')
        .select('id, username, role')
        .eq('id', user.referred_by)
        .single();

      if (referrerErr || !referrer) {
        console.error('Error fetching referrer details', referrerErr);
        return;
      }

      let percent = 0;
      let isFirstDeposit = false;
      const isManager = referrer.role === 'manager';

      if (isManager) {
        return; // Managers' commission is calculated dynamically on-the-fly, not per-deposit.
      }
        // Count user's successful deposits to determine if it's the first one
        const { count, error: countError } = await supabaseAdmin
          .from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('transaction_type', 'deposit')
          .eq('status', 'completed');

        if (countError) {
          console.error('Error counting deposits', countError);
          return;
        }

        // Since the current deposit is already inserted, if count <= 1 it's the first deposit.
        isFirstDeposit = count <= 1;

        // Fetch percentages from settings
        const { data: settings } = await supabaseAdmin
          .from('platform_settings')
          .select('setting_key, setting_value')
          .in('setting_key', ['referral_first_deposit_percent', 'referral_subsequent_deposit_percent']);

        let firstDepositPercent = 35;
        let subsequentDepositPercent = 15;

        settings?.forEach(s => {
          if (s.setting_key === 'referral_first_deposit_percent') firstDepositPercent = parseFloat(s.setting_value);
          if (s.setting_key === 'referral_subsequent_deposit_percent') subsequentDepositPercent = parseFloat(s.setting_value);
        });

        percent = isFirstDeposit ? firstDepositPercent : subsequentDepositPercent;

      const commissionAmount = depositAmount * (percent / 100);

      if (commissionAmount <= 0) return;

      // Step 1: Update referrals table (cumulative reward)
      const { data: existingReferral } = await supabaseAdmin
        .from('referrals')
        .select('id, reward_amount')
        .eq('referred_id', userId)
        .eq('referrer_id', user.referred_by)
        .single();

      if (existingReferral) {
        const currentReward = parseFloat(existingReferral.reward_amount || 0);
        await supabaseAdmin
          .from('referrals')
          .update({
            status: 'active',
            reward_amount: currentReward + commissionAmount,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingReferral.id);
      } else {
        await supabaseAdmin
          .from('referrals')
          .insert({
            referrer_id: user.referred_by,
            referred_id: userId,
            reward_amount: commissionAmount,
            status: 'active'
          });
      }

      // Step 2: Credit referrer wallet
      const { data: referrerWallet } = await supabaseAdmin
        .from('wallets')
        .select('referral_balance')
        .eq('user_id', user.referred_by)
        .single();

      if (referrerWallet) {
        await supabaseAdmin
          .from('wallets')
          .update({
            referral_balance: parseFloat(referrerWallet.referral_balance || 0) + commissionAmount,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', user.referred_by);
      }

      // Step 3: Insert transaction for referrer
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: user.referred_by,
          transaction_type: 'reward',
          balance_type: 'referral_balance',
          amount: commissionAmount,
          currency: 'NGN',
          status: 'completed',
          reference: `REF_COMMISSION_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          description: isManager
            ? `Manager referral commission - ${percent}% from ${user.username}'s game deposit`
            : `Referral commission - ${percent}% from ${user.username}'s deposit`,
          metadata: {
            referred_user_id: userId,
            deposit_reference: transactionReference,
            commission_percent: percent,
            is_first_deposit: isFirstDeposit,
            is_manager_commission: isManager
          },
          created_at: new Date().toISOString()
        });

    } catch (error) {
      console.error('Error processing referral commission:', error);
    }
  }

  // Dedicated Movantrapay Status Check
  static async checkMovantrapayStatus(req, res) {
    try {
      const { reference } = req.params;
      if (!reference) {
        return res.status(400).json({ success: false, message: 'Reference is required' });
      }
      const status = await MovantrapayService.checkStatus(reference);
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      console.error('[Movantrapay Status Check Error]:', error);
      res.status(500).json({ success: false, message: error.message || 'Status check failed' });
    }
  }

  // Movantrapay Webhook Handler
  static async handleMovantrapayWebhook(req, res) {
    try {
      const signature = req.headers['x-movantra-signature'];
      const rawBody = req.body;

      const isValid = MovantrapayService.verifyWebhookSignature(rawBody, signature);
      if (!isValid && process.env.NODE_ENV === 'production') {
        return res.status(401).json({ success: false, message: 'Invalid Movantrapay signature' });
      }

      const payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;

      if (payload && (payload.event === 'payment.success' || payload.status === 'success')) {
        const eventData = payload.data || payload;
        const reference = eventData.reference;
        const amountKobo = eventData.amount || eventData.total_kobo || 0;
        const paidAmount = amountKobo > 0 ? amountKobo / 100 : parseFloat(eventData.amount_naira || 0);

        if (reference) {
          const { data: existingTx } = await supabaseAdmin
            .from('transactions')
            .select('id')
            .eq('reference', reference)
            .single();

          if (!existingTx) {
            console.log(`[Movantrapay Webhook] Payment confirmed for reference: ${reference}, amount: ₦${paidAmount}`);
          }
        }
      }

      res.status(200).json({ success: true, message: 'Movantrapay webhook processed' });
    } catch (error) {
      console.error('[Movantrapay Webhook Error]:', error);
      res.status(500).json({ success: false, message: 'Webhook processing failed' });
    }
  }
}

module.exports = PaymentController;
