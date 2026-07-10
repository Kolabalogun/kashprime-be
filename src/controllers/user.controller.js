const { validationResult } = require('express-validator');
const { supabaseAdmin } = require('../services/supabase.service');
const { formatResponse } = require('../utils/helpers');
const { logActivity } = require('../utils/activityLogger');
const { getSettings } = require('./settings.controller');
const MESSAGES = require('../utils/constants/messages');
const bcrypt = require('bcryptjs');

/**
 * Helper function to determine if a transaction is a credit or debit
 */
const determineTransactionType = (transaction) => {
  const { transaction_type, balance_type } = transaction;
  
  // Credit transactions (money coming in)
  const creditTypes = ['reward', 'deposit', 'refund', 'bonus', 'commission'];
  
  // Balance types that indicate money coming in
  const creditBalanceTypes = [
    'coins_balance',
    'games_balance', 
    'referral_balance',
    'investment_balance'
  ];
  
  // Debit transactions (money going out)
  const debitTypes = ['withdrawal', 'transfer', 'bet', 'investment_out', 'upgrade_payment'];
  
  // Check transaction type first
  if (creditTypes.includes(transaction_type)) return true;
  if (debitTypes.includes(transaction_type)) return false;
  
  // Check balance_type as fallback
  if (balance_type && creditBalanceTypes.includes(balance_type)) {
    // Deposits to any balance are credits
    if (transaction_type === 'deposit') return true;
  }
  
  // Default: Check amount sign (negative = debit, positive = credit)
  return parseFloat(transaction.amount) >= 0;
};

/**
 * Add isCredit field to transactions
 */
const enhanceTransactionsWithCreditFlag = (transactions) => {
  if (!transactions || !Array.isArray(transactions)) return [];
  
  return transactions.map(transaction => ({
    ...transaction,
    isCredit: determineTransactionType(transaction),
    formattedAmount: determineTransactionType(transaction) 
      ? `₦${parseFloat(transaction.amount).toLocaleString()}`
      : `₦${Math.abs(parseFloat(transaction.amount)).toLocaleString()}`
  }));
};

// Get user dashboard data  
const getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select(`*, wallets (*)`)
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json(
        formatResponse('error', MESSAGES.ERROR.USER_NOT_FOUND)
      );
    }

    const { data: referralStats } = await supabaseAdmin
      .from('referrals')
      .select('status')
      .eq('referrer_id', userId);

    const pendingReferrals = referralStats?.filter(r => r.status === 'pending').length || 0;
    const activeReferrals = referralStats?.filter(r => r.status === 'active').length || 0;

    let totalReferralEarnings = 0;
    let totalReferralsCount = pendingReferrals + activeReferrals;

    if (user?.role === 'manager') {
      const { calculateManagerReferralBalance } = require('../utils/managerHelper');
      const dynamicBalance = await calculateManagerReferralBalance(userId);
      totalReferralEarnings = dynamicBalance.total_earned;
      totalReferralsCount = dynamicBalance.total_referrals;
      if (user.wallets) {
        user.wallets.referral_balance = dynamicBalance.referral_balance;
      }
    } else {
      // Calculate total referral earnings directly from transactions for accuracy
      const { data: rewardTransactions } = await supabaseAdmin
        .from('transactions')
        .select('amount')
        .eq('user_id', userId)
        .eq('transaction_type', 'reward')
        .eq('balance_type', 'referral_balance')
        .eq('status', 'completed');
        
      totalReferralEarnings = rewardTransactions?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) || 0;
    }

    const { data: recentTransactions } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    const enhancedTransactions = enhanceTransactionsWithCreditFlag(recentTransactions);

    delete user.password;
    delete user.reset_otp;
    delete user.reset_otp_expires_at;

    const { data: platformSettings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['kashskit_enabled', 'sponsored_enabled', 'kash_ads_enabled']);

    const settingsObj = (platformSettings || []).reduce((acc, curr) => {
      acc[curr.setting_key] = curr.setting_value === 'true' || curr.setting_value === true;
      return acc;
    }, {
      kashskit_enabled: true,
      sponsored_enabled: true,
      kash_ads_enabled: true
    });

    const dashboardData = {
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        user_tier: user.user_tier,
        role: user.role,
        email: user.email,
        referral_code: user.referral_code,
        profile_picture: user.profile_picture,
        last_login_at: user.last_login_at
      },
      wallet: user.wallets || {
        coins_balance: 0,
        bonus_balance: 0,
        games_balance: 0,
        referral_balance: 0,
        investment_balance: 0,
        total_withdrawn_coins: 0,
        total_withdrawn_games: 0,
        total_withdrawn_referral: 0,
        total_withdrawn_investment: 0
      },
      referral_stats: {
        pending_referrals: pendingReferrals,
        active_referrals: activeReferrals,
        total_referrals: totalReferralsCount,
        total_earnings: totalReferralEarnings
      },
      recent_transactions: enhancedTransactions,
      platform_settings: settingsObj
    };

    res.status(200).json(
      formatResponse('success', 'Dashboard data retrieved', dashboardData)
    );

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json(
      formatResponse('error', MESSAGES.ERROR.SERVER_ERROR)
    );
  }
};

// Update user profile  
const updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json(
        formatResponse('error', MESSAGES.ERROR.VALIDATION_ERROR, {
          errors: errors.array()
        })
      );
    }

    const userId = req.user.id;
    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (req.body.fullName) updateData.full_name = req.body.fullName;
    if (req.body.phoneNumber) updateData.phone_number = req.body.phoneNumber;

    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();


    if (error) {
      throw new Error('Failed to update profile');
    }

    // Log Activity
    await logActivity(userId, 'profile_update', { fields: Object.keys(updateData) }, req);

    delete updatedUser.password;
    delete updatedUser.reset_otp;
    delete updatedUser.reset_otp_expires_at;

    res.status(200).json(
      formatResponse('success', MESSAGES.SUCCESS.PROFILE_UPDATED, {
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          username: updatedUser.username,
          full_name: updatedUser.full_name,
          phone_number: updatedUser.phone_number,
          user_tier: updatedUser.user_tier,
          role: updatedUser.role,
          referral_code: updatedUser.referral_code,
        }
      })
    );

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json(
      formatResponse('error', error.message)
    );
  }
};

// Get user transactions  
const getTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type, balance_type, status, date_from, date_to } = req.query;
    
    // Validate pagination parameters
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    
    if (pageNum < 1) {
      return res.status(400).json(
        formatResponse('error', 'Page must be greater than 0')
      );
    }
    
    if (limitNum < 1 || limitNum > 100) {
      return res.status(400).json(
        formatResponse('error', 'Limit must be between 1 and 100')
      );
    }

    // Build query with count for pagination
    let query = supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Apply filters
    if (type) {
      query = query.eq('transaction_type', type);
    }
    
    if (balance_type) {
      query = query.eq('balance_type', balance_type);
    }
    
    if (status) {
      query = query.eq('status', status);
    }
    
    if (date_from) {
      query = query.gte('created_at', date_from);
    }
    
    if (date_to) {
      query = query.lte('created_at', date_to);
    }

    // Apply pagination
    const offset = (pageNum - 1) * limitNum;
    query = query.range(offset, offset + limitNum - 1);

    const { data: transactions, error, count } = await query;

    if (error) {
      console.error('Transaction fetch error:', error);
      throw new Error('Failed to fetch transactions');
    }

    // Enhance transactions with credit/debit flags
    const enhancedTransactions = enhanceTransactionsWithCreditFlag(transactions);

    // Calculate summary statistics
    const totalCredit = enhancedTransactions
      .filter(t => t.isCredit)
      .reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    const totalDebit = enhancedTransactions
      .filter(t => !t.isCredit)
      .reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);

    res.status(200).json(
      formatResponse('success', 'Transactions retrieved', {
        transactions: enhancedTransactions,
        summary: {
          total_credit: totalCredit,
          total_debit: totalDebit,
          net_amount: totalCredit - totalDebit,
          transaction_count: enhancedTransactions.length
        },
        pagination: {
          current_page: pageNum,
          limit: limitNum,
          total_items: count || 0,
          total_pages: Math.ceil((count || 0) / limitNum),
          has_next: offset + limitNum < (count || 0),
          has_previous: pageNum > 1
        },
        filters_applied: {
          type: type || null,
          balance_type: balance_type || null,
          status: status || null,
          date_from: date_from || null,
          date_to: date_to || null
        }
      })
    );

  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json(
      formatResponse('error', error.message || 'Failed to retrieve transactions')
    );
  }
};

const getWalletDetails = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    const { data: wallet, error } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      throw new Error('Failed to fetch wallet details');
    }

    if (user?.role === 'manager') {
      const { calculateManagerReferralBalance } = require('../utils/managerHelper');
      const dynamicBalance = await calculateManagerReferralBalance(userId);
      wallet.referral_balance = dynamicBalance.referral_balance;
    }

    const { data: recentTransactions } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    const enhancedTransactions = enhanceTransactionsWithCreditFlag(recentTransactions);

    const breakdown = {
      coins_balance: {
        current: parseFloat(wallet.coins_balance || 0),
        total_withdrawn: parseFloat(wallet.total_withdrawn_coins || 0)
      },
      games_balance: {
        current: parseFloat(wallet.games_balance || 0),
        total_withdrawn: parseFloat(wallet.total_withdrawn_games || 0)
      },
      bonus_balance: {
        current: parseFloat(wallet.bonus_balance || 0),
        total_withdrawn: 0
      },
      referral_balance: {
        current: parseFloat(wallet.referral_balance || 0),
        total_withdrawn: parseFloat(wallet.total_withdrawn_referral || 0)
      },
      investment_balance: {
        current: parseFloat(wallet.investment_balance || 0),
        total_withdrawn: parseFloat(wallet.total_withdrawn_investment || 0)
      }
    };

    res.status(200).json(
      formatResponse('success', 'Wallet details retrieved', {
        wallet: wallet,
        breakdown: breakdown,
        recent_transactions: enhancedTransactions
      })
    );

  } catch (error) {
    console.error('Get wallet details error:', error);
    res.status(500).json(
      formatResponse('error', error.message)
    );
  }
};

// Update wallet (PIN and bank details)
const updateWallet = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        data: { errors: errors.array() }
      });
    }

    const userId = req.user.id;
    const { pin, account_name, bank_name, account_number } = req.body;

    // Validate account information
    if (account_name !== undefined && account_name !== null && account_name !== '') {
      const trimmedAccountName = account_name.toString().trim();
      if (trimmedAccountName.length < 3) {
        return res.status(400).json({
          status: 'error',
          message: 'Account name must be at least 3 characters long'
        });
      }
      if (!/^[a-zA-Z\s]+$/.test(trimmedAccountName)) {
        return res.status(400).json({
          status: 'error',
          message: 'Account name must contain only letters and spaces'
        });
      }
    }

    if (bank_name !== undefined && bank_name !== null && bank_name !== '') {
      const trimmedBankName = bank_name.toString().trim();
      if (trimmedBankName.length < 3) {
        return res.status(400).json({
          status: 'error',
          message: 'Bank name must be at least 3 characters long'
        });
      }
    }

    if (account_number !== undefined && account_number !== null && account_number !== '') {
      const accountNumberStr = account_number.toString().trim();
      if (!/^\d{10}$/.test(accountNumberStr)) {
        return res.status(400).json({
          status: 'error',
          message: 'Account number must be exactly 10 digits'
        });
      }
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      const pinStr = pin.toString().trim();
      if (!/^\d{4,6}$/.test(pinStr)) {
        return res.status(400).json({
          status: 'error',
          message: 'Transaction PIN must be 4-6 digits'
        });
      }
    }

    const updateData = { updated_at: new Date().toISOString() };

    if (account_name !== undefined) {
      updateData.account_name = account_name !== null && account_name !== '' 
        ? account_name.toString().trim() 
        : null;
    }
    
    if (bank_name !== undefined) {
      updateData.bank_name = bank_name !== null && bank_name !== '' 
        ? bank_name.toString().trim() 
        : null;
    }
    
    if (account_number !== undefined) {
      updateData.account_number = account_number !== null && account_number !== '' 
        ? account_number.toString().trim() 
        : null;
    }

    if (pin !== undefined) {
      if (pin === null || pin === '') {
        updateData.transaction_pin = null;
      } else {
        updateData.transaction_pin = await bcrypt.hash(pin.toString(), 12);
      }
      updateData.pin_attempts = 0;
      updateData.pin_locked_until = null;
    }

    const { data: updatedWallet, error } = await supabaseAdmin
      .from('wallets')
      .update(updateData)
      .eq('user_id', userId)
      .select('account_name, bank_name, account_number, updated_at')
      .single();

    if (error) {
      console.error('Update wallet error:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to update wallet information'
      });
    }

    // Log Activity
    await logActivity(userId, 'wallet_update', { 
       bank_update: account_name || bank_name || account_number ? true : false,
       pin_update: pin !== undefined
    }, req);

    res.status(200).json({
      status: 'success',
      message: 'Wallet information updated successfully',
      data: {
        wallet: {
          ...updatedWallet,
          pin_updated: pin !== undefined
        }
      }
    });

  } catch (error) {
    console.error('Update wallet error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Get activity summary
const getActivitySummary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const { data: transactions, error } = await supabaseAdmin
      .from('transactions')
      .select('transaction_type, balance_type, amount, created_at')
      .eq('user_id', userId)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Transaction fetch error:', error);
      throw new Error('Failed to fetch transactions');
    }

    const { data: recentReferrals } = await supabaseAdmin
      .from('referrals')
      .select('*')
      .eq('referrer_id', userId)
      .gte('created_at', startDate.toISOString());

    const transactionSummary = (transactions || []).reduce((acc, transaction) => {
      // Use balance_type as the primary categorization
      const type = transaction.balance_type || transaction.transaction_type;
      const isCredit = determineTransactionType(transaction);
      
      if (!acc[type]) {
        acc[type] = { 
          count: 0, 
          total: 0,
          credit_count: 0,
          debit_count: 0,
          credit_total: 0,
          debit_total: 0
        };
      }
      
      const amount = parseFloat(transaction.amount);
      acc[type].count += 1;
      acc[type].total += amount;
      
      if (isCredit) {
        acc[type].credit_count += 1;
        acc[type].credit_total += amount;
      } else {
        acc[type].debit_count += 1;
        acc[type].debit_total += amount;
      }
      
      return acc;
    }, {});

    res.status(200).json(
      formatResponse('success', 'Activity summary retrieved', {
        period_days: parseInt(days),
        transaction_summary: transactionSummary,
        recent_referrals: recentReferrals?.length || 0,
        total_transactions: transactions?.length || 0
      })
    );

  } catch (error) {
    console.error('Get activity summary error:', error);
    res.status(500).json(
      formatResponse('error', error.message)
    );
  }
};

const applyForMerchant = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Check if they already have an application
    const { data: existingApp } = await supabaseAdmin
      .from('merchant_applications')
      .select('status')
      .eq('user_id', userId)
      .single();

    if (existingApp) {
      return res.status(400).json(
        formatResponse('error', `You already have an application with status: ${existingApp.status}`)
      );
    }

    // Checking criteria based on platform settings
    // BYPASS FOR LOCAL TESTING
    const isLocalhost = req.headers.host?.includes('localhost') || req.headers.host?.includes('127.0.0.1');
    if (!isLocalhost) {
      const limitsKeys = ['merchant_min_referrals', 'merchant_min_referral_deposit'];
      const { data: limits } = await supabaseAdmin
        .from('platform_settings')
        .select('setting_key, setting_value')
        .in('setting_key', limitsKeys);

    let minRefsNeeded = 10;
    let minRefDeposit = 5000;
    limits?.forEach(l => {
      if(l.setting_key === 'merchant_min_referrals') minRefsNeeded = parseInt(l.setting_value);
      if(l.setting_key === 'merchant_min_referral_deposit') minRefDeposit = parseFloat(l.setting_value);
    });

    const { data: directReferrals } = await supabaseAdmin
       .from('users')
       .select('id')
       .eq('referred_by', userId);

    let validCount = 0;
    if (directReferrals && directReferrals.length > 0) {
       for (const refUser of directReferrals) {
          const { data: deposits } = await supabaseAdmin
             .from('transactions')
             .select('amount')
             .eq('user_id', refUser.id)
             .eq('transaction_type', 'deposit')
             .eq('status', 'completed');
          const totalDeposit = deposits?.reduce((summ, tx) => summ + parseFloat(tx.amount), 0) || 0;
          if (totalDeposit >= minRefDeposit) {
             validCount++;
          }
       }
    }

      if (validCount < minRefsNeeded) {
         return res.status(403).json(
           formatResponse('error', `You do not meet the criteria. Valid referrals: ${validCount}/${minRefsNeeded}`)
         );
      }
    }

    // Create application
    await supabaseAdmin
      .from('merchant_applications')
      .insert({ user_id: userId, status: 'pending' });

    res.status(200).json(
      formatResponse('success', 'Merchant application submitted successfully and is pending admin approval.')
    );

  } catch (error) {
    console.error('Merchant application error:', error);
    res.status(500).json(formatResponse('error', 'Internal server error'));
  }
};

// Get list of vendors for users to buy codes
const getVendors = async (req, res) => {
  try {
    const { data: vendors, error: vendorsError } = await supabaseAdmin
      .from('users')
      .select('id, full_name, username, phone_number, role, profile_picture')
      .in('role', ['merchant', 'vendor', 'super_vendor', 'manager']);

    if (vendorsError) throw vendorsError;

    // Get counts of active deposit codes
    const { data: codeCounts, error: countError } = await supabaseAdmin
      .from('deposit_codes')
      .select('merchant_id')
      .eq('status', 'active');

    if (countError) throw countError;

    // Calculate available count for each vendor
    const vendorsWithStats = vendors.map(v => ({
      ...v,
      availableCount: codeCounts.filter(c => c.merchant_id === v.id).length
    }));

    // Grouping and Randomizing
    // Priority: Vendors with codes > Vendors without codes
    const withCodes = vendorsWithStats.filter(v => v.availableCount > 0).sort(() => Math.random() - 0.5);
    const withoutCodes = vendorsWithStats.filter(v => v.availableCount === 0).sort(() => Math.random() - 0.5);

    const merged = [...withCodes, ...withoutCodes];

    res.status(200).json(formatResponse('success', 'Vendors list fetched', merged));
  } catch (error) {
    console.error('getVendors error:', error);
    res.status(500).json(formatResponse('error', 'Failed to fetch merchants list'));
  }
};

// Get public platform settings
const getPublicSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    const publicSettings = {
      min_deposit: parseFloat(settings.min_deposit_amount || settings.min_deposit) || 100,
      min_withdrawal_games: parseFloat(settings.min_withdrawal_games_amount || settings.min_withdrawal_games) || 5000,
      min_withdrawal_referral: parseFloat(settings.min_withdrawal_referral_amount || settings.min_withdrawal_referral) || 2000,
      min_withdrawal_coins: parseFloat(settings.coins_withdrawal_threshold_amount || settings.min_withdrawal_coins_amount) || 50000,
      site_name: settings.site_name || 'KashPrime',
      contact_email: settings.contact_email || 'support@kashprime.com',
    };

    res.status(200).json(formatResponse('success', 'Public settings fetched', publicSettings));
  } catch (error) {
    console.error('getPublicSettings error:', error);
    res.status(500).json(formatResponse('error', 'Failed to fetch platform settings'));
  }
};

const transferVendingBalance = async (req, res) => {
  try {
    const merchantId = req.user.id;
    const { username, amount } = req.body;

    if (!username || !amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json(formatResponse('error', 'Valid username and amount are required.'));
    }

    // Verify the recipient user
    const { data: recipient, error: recipientErr } = await supabaseAdmin
      .from('users')
      .select('id, username')
      .eq('username', username.toLowerCase())
      .single();

    if (recipientErr || !recipient) {
      return res.status(404).json(formatResponse('error', 'Recipient user not found.'));
    }

    if (recipient.id === merchantId) {
      return res.status(400).json(formatResponse('error', 'Cannot transfer to yourself.'));
    }

    // Check merchant's vending balance
    const { data: merchantWallet, error: mwErr } = await supabaseAdmin
      .from('wallets')
      .select('id, vending_balance, total_transferred_vending')
      .eq('user_id', merchantId)
      .single();

    if (mwErr || !merchantWallet) {
      return res.status(500).json(formatResponse('error', 'Merchant wallet not found.'));
    }

    const currentVending = parseFloat(merchantWallet.vending_balance || 0);
    const transferAmount = parseFloat(amount);

    if (currentVending < transferAmount) {
      return res.status(400).json(formatResponse('error', 'Insufficient vending balance.'));
    }

    // Check recipient's games balance
    const { data: recipientWallet, error: rwErr } = await supabaseAdmin
      .from('wallets')
      .select('id, games_balance')
      .eq('user_id', recipient.id)
      .single();

    if (rwErr || !recipientWallet) {
      return res.status(500).json(formatResponse('error', 'Recipient wallet not found.'));
    }

    // Deduct from merchant
    const newMerchantVending = currentVending - transferAmount;
    const newTotalTransferred = parseFloat(merchantWallet.total_transferred_vending || 0) + transferAmount;

    await supabaseAdmin
      .from('wallets')
      .update({
        vending_balance: newMerchantVending,
        total_transferred_vending: newTotalTransferred
      })
      .eq('user_id', merchantId);

    // Credit to recipient's games balance
    const newRecipientGames = parseFloat(recipientWallet.games_balance || 0) + transferAmount;

    await supabaseAdmin
      .from('wallets')
      .update({ games_balance: newRecipientGames })
      .eq('user_id', recipient.id);

    // Record transactions
    // 1. Merchant Debit
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: merchantId,
        amount: -transferAmount,
        currency: 'NGN',
        transaction_type: 'transfer_out',
        status: 'completed',
        description: `Transferred vending balance to @${recipient.username}`,
        reference: `VEND-TXOUT-${Date.now()}`,
        balance_type: 'vending_balance'
      });

    // 2. Recipient Credit
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: recipient.id,
        amount: transferAmount,
        currency: 'NGN',
        transaction_type: 'transfer_in',
        status: 'completed',
        description: `Received game balance from @${req.user.username}`,
        reference: `VEND-TXIN-${Date.now()}`,
        balance_type: 'games_balance'
      });

    return res.status(200).json(formatResponse('success', `Successfully transferred ₦${transferAmount.toLocaleString()} to @${recipient.username}`, {
      new_vending_balance: newMerchantVending
    }));

  } catch (error) {
    console.error('Transfer vending balance error:', error);
    res.status(500).json(formatResponse('error', 'Internal server error while transferring balance.'));
  }
};

module.exports = {
  getDashboard,
  updateProfile,
  getTransactions,
  getWalletDetails,
  updateWallet,
  getActivitySummary,
  applyForMerchant,
  getVendors,
  getPublicSettings,
  transferVendingBalance
};
