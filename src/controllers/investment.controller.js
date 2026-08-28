const { supabaseAdmin } = require('../services/supabase.service');
const { validationResult } = require('express-validator');

const defaultAgroPlans = [
  { name: 'agro_press_1', display_name: 'Agro Press Level 1', capital: 3000, daily_return: 200, cycle_days: 90 },
  { name: 'agro_press_2', display_name: 'Agro Press Level 2', capital: 8000, daily_return: 550, cycle_days: 90 },
  { name: 'agro_press_3', display_name: 'Agro Press Level 3', capital: 10000, daily_return: 700, cycle_days: 90 },
  { name: 'agro_press_4', display_name: 'Agro Press Level 4', capital: 25000, daily_return: 2500, cycle_days: 90 },
  { name: 'agro_press_5', display_name: 'Agro Press Level 5', capital: 50000, daily_return: 5500, cycle_days: 90 },
  { name: 'agro_press_6', display_name: 'Agro Press Level 6', capital: 100000, daily_return: 9000, cycle_days: 90 },
  { name: 'agro_press_7', display_name: 'Agro Press Level 7', capital: 200000, daily_return: 35000, cycle_days: 90 },
  { name: 'agro_press_8', display_name: 'Agro Press Level 8', capital: 500000, daily_return: 60000, cycle_days: 90 },
];

// Get available investment plans
const getPlans = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user tier
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('user_tier')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Get all plan settings
    const { data: settings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .or('setting_key.like.investment_plan_%,setting_key.eq.investments_enabled');

    const settingsMap = {};
    settings?.forEach(s => {
      settingsMap[s.setting_key] = s.setting_value;
    });

    if (settingsMap['investments_enabled'] === 'false') {
      await supabaseAdmin
        .from('platform_settings')
        .upsert({ setting_key: 'investments_enabled', setting_value: 'true', updated_at: new Date().toISOString() }, { onConflict: 'setting_key' });
      settingsMap['investments_enabled'] = 'true';
    }

    // Build plans array using Agro Press levels
    const plans = defaultAgroPlans.map(plan => {
      const capital = parseFloat(settingsMap[`investment_plan_${plan.name}_amount`] || plan.capital);
      const dailyReturn = parseFloat(settingsMap[`investment_plan_${plan.name}_daily_return`] || plan.daily_return);
      const cycleDays = parseInt(settingsMap[`investment_plan_${plan.name}_cycle_days`] || plan.cycle_days);
      const enabled = settingsMap[`investment_plan_${plan.name}_enabled`] !== 'false';
      const weeklyPayout = dailyReturn * 7;
      const totalReturn = dailyReturn * cycleDays;

      return {
        name: plan.name,
        display_name: plan.display_name,
        capital,
        daily_return: dailyReturn,
        cycle_days: cycleDays,
        weekly_payout: weeklyPayout,
        total_return: totalReturn,
        duration_weeks: Math.round(cycleDays / 7),
        roi_percent: Math.round(((totalReturn - capital) / capital) * 100),
        enabled,
        available_for: ['Free', 'Pro']
      };
    });

    const availablePlans = plans.filter(p => p.enabled);

    res.json({
      status: 'success',
      message: 'Investment plans retrieved successfully',
      data: {
        plans: availablePlans,
        user_tier: user.user_tier
      }
    });

  } catch (error) {
    console.error('Get investment plans error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Invest using user wallet balance (investment_balance or games_balance)
const investFromBalance = async (req, res) => {
  try {
    const { plan_name, source_balance = 'investment_balance' } = req.body;
    const userId = req.user.id;

    if (!['investment_balance', 'games_balance'].includes(source_balance)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid balance source. Choose investment_balance or games_balance.'
      });
    }

    const { data: settings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value');

    const settingsMap = {};
    settings?.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });

    if (settingsMap['investments_enabled'] === 'false') {
      await supabaseAdmin
        .from('platform_settings')
        .upsert({ setting_key: 'investments_enabled', setting_value: 'true', updated_at: new Date().toISOString() }, { onConflict: 'setting_key' });
      settingsMap['investments_enabled'] = 'true';
    }

    const targetDefault = defaultAgroPlans.find(p => p.name === plan_name);
    if (!targetDefault) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid investment plan selected'
      });
    }

    const capital = parseFloat(settingsMap[`investment_plan_${plan_name}_amount`] || targetDefault.capital);
    const dailyReturn = parseFloat(settingsMap[`investment_plan_${plan_name}_daily_return`] || targetDefault.daily_return);
    const cycleDays = parseInt(settingsMap[`investment_plan_${plan_name}_cycle_days`] || targetDefault.cycle_days);
    const isEnabled = settingsMap[`investment_plan_${plan_name}_enabled`] !== 'false';

    if (!isEnabled) {
      return res.status(403).json({
        status: 'error',
        message: 'This investment plan is currently disabled'
      });
    }

    // Check user wallet
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('investment_balance, games_balance')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({ status: 'error', message: 'Wallet not found' });
    }

    const availableBal = parseFloat(wallet[source_balance] || 0);
    if (availableBal < capital) {
      return res.status(400).json({
        status: 'error',
        message: `Insufficient balance in ${source_balance === 'investment_balance' ? 'Investment' : 'Games'} wallet. Required: ₦${capital.toLocaleString()}`
      });
    }

    // Deduct balance
    const newBal = availableBal - capital;
    const updateObj = {};
    updateObj[source_balance] = newBal;

    const { error: updateErr } = await supabaseAdmin
      .from('wallets')
      .update(updateObj)
      .eq('user_id', userId);

    if (updateErr) throw updateErr;

    const weeklyPayout = dailyReturn * 7;
    const totalReturn = dailyReturn * cycleDays;
    const startDate = new Date();
    const nextPayoutDate = new Date(startDate);
    nextPayoutDate.setDate(nextPayoutDate.getDate() + 1); // Next daily payout in 24h

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + cycleDays);

    const reference = `INV_BAL_${plan_name.toUpperCase()}_${userId.slice(-6)}_${Date.now()}`;

    const { data: investment, error: invErr } = await supabaseAdmin
      .from('investments')
      .insert({
        user_id: userId,
        plan_name: plan_name,
        capital_amount: capital,
        weekly_payout_amount: weeklyPayout,
        total_paid_out: 0,
        current_week: 0,
        duration_weeks: Math.round(cycleDays / 7),
        next_payout_date: nextPayoutDate.toISOString(),
        status: 'active',
        reference: reference
      })
      .select()
      .single();

    if (invErr) throw invErr;

    // Log transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      transaction_type: 'investment',
      balance_type: source_balance,
      amount: capital,
      currency: 'NGN',
      status: 'completed',
      reference: reference,
      description: `Investment in ${targetDefault.display_name} (₦${capital.toLocaleString()})`,
      metadata: {
        investment_id: investment.id,
        plan_name: plan_name,
        daily_return: dailyReturn,
        cycle_days: cycleDays
      }
    });

    res.json({
      status: 'success',
      message: `Successfully invested in ${targetDefault.display_name}!`,
      data: {
        investment,
        new_balance: newBal,
        source_balance
      }
    });

  } catch (error) {
    console.error('Invest from balance error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Internal server error' });
  }
};

// Auto-process overdue investment payouts for a user or globally
const autoProcessDuePayouts = async (targetUserId = null) => {
  try {
    const currentDate = new Date();

    let query = supabaseAdmin
      .from('investments')
      .select('*')
      .eq('status', 'active')
      .lte('next_payout_date', currentDate.toISOString());

    if (targetUserId) {
      query = query.eq('user_id', targetUserId);
    }

    const { data: dueInvestments, error } = await query;
    if (error || !dueInvestments || dueInvestments.length === 0) {
      return;
    }

    for (const investment of dueInvestments) {
      try {
        let currentInv = { ...investment };

        while (currentInv.status === 'active' && new Date(currentInv.next_payout_date) <= currentDate) {
          const nextWeek = (currentInv.current_week || 0) + 1;
          const durationWeeks = currentInv.duration_weeks || 13;
          let payoutAmount = parseFloat(currentInv.weekly_payout_amount || 0);

          if (nextWeek >= durationWeeks) {
            payoutAmount += parseFloat(currentInv.capital_amount || 0);
          }

          const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('investment_balance')
            .eq('user_id', currentInv.user_id)
            .single();

          const newBalance = parseFloat(wallet?.investment_balance || 0) + payoutAmount;

          await supabaseAdmin
            .from('wallets')
            .update({ investment_balance: newBalance })
            .eq('user_id', currentInv.user_id);

          await supabaseAdmin
            .from('transactions')
            .insert({
              user_id: currentInv.user_id,
              transaction_type: 'reward',
              balance_type: 'investment_balance',
              earning_type: 'investment_return',
              amount: payoutAmount,
              currency: 'NGN',
              status: 'completed',
              reference: `INV_PAYOUT_${currentInv.id}_WK${nextWeek}_${Date.now()}`,
              description: `Investment ROI payout - Week ${nextWeek} of ${currentInv.plan_name} plan`,
              metadata: {
                investment_id: currentInv.id,
                week_number: nextWeek,
                plan_name: currentInv.plan_name
              }
            });

          await supabaseAdmin
            .from('investment_payouts')
            .insert({
              investment_id: currentInv.id,
              week_number: nextWeek,
              amount: payoutAmount,
              status: 'completed',
              scheduled_date: currentInv.next_payout_date,
              processed_at: currentDate.toISOString()
            });

          const nextPayoutDate = new Date(currentInv.next_payout_date);
          nextPayoutDate.setDate(nextPayoutDate.getDate() + 7);

          const newTotalPaidOut = parseFloat(currentInv.total_paid_out || 0) + payoutAmount;
          const isCompleted = nextWeek >= durationWeeks;

          const updatePayload = {
            current_week: nextWeek,
            total_paid_out: newTotalPaidOut,
            updated_at: currentDate.toISOString(),
            status: isCompleted ? 'completed' : 'active',
            ...(isCompleted ? {} : { next_payout_date: nextPayoutDate.toISOString() })
          };

          await supabaseAdmin
            .from('investments')
            .update(updatePayload)
            .eq('id', currentInv.id);

          currentInv = {
            ...currentInv,
            ...updatePayload
          };
        }
      } catch (err) {
        console.error(`Error auto-processing payout for investment ${investment.id}:`, err);
      }
    }
  } catch (err) {
    console.error('Auto process due payouts error:', err);
  }
};

// Get user's investments
const getMyInvestments = async (req, res) => {
  try {
    const userId = req.user.id;
    await autoProcessDuePayouts(userId);
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('investments')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: investments, error, count } = await query;

    if (error) {
      throw error;
    }

    res.json({
      status: 'success',
      message: 'Investments retrieved successfully',
      data: {
        investments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get my investments error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Get single investment details
const getInvestmentDetails = async (req, res) => {
  try {
    const { investmentId } = req.params;
    const userId = req.user.id;
    await autoProcessDuePayouts(userId);

    const { data: investment, error: investmentError } = await supabaseAdmin
      .from('investments')
      .select('*')
      .eq('id', investmentId)
      .eq('user_id', userId)
      .single();

    if (investmentError || !investment) {
      return res.status(404).json({
        status: 'error',
        message: 'Investment not found'
      });
    }

    const { data: payouts } = await supabaseAdmin
      .from('investment_payouts')
      .select('*')
      .eq('investment_id', investmentId)
      .order('week_number', { ascending: true });

    res.json({
      status: 'success',
      message: 'Investment details retrieved successfully',
      data: {
        investment,
        payouts: payouts || []
      }
    });

  } catch (error) {
    console.error('Get investment details error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Get investment dashboard
const getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    await autoProcessDuePayouts(userId);

    const { data: activeInvestments } = await supabaseAdmin
      .from('investments')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    const { data: completedInvestments } = await supabaseAdmin
      .from('investments')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed');

    const totalInvested = [...(activeInvestments || []), ...(completedInvestments || [])]
      .reduce((sum, inv) => sum + parseFloat(inv.capital_amount), 0);

    const totalRoiEarned = (completedInvestments || [])
      .reduce((sum, inv) => sum + parseFloat(inv.total_paid_out || 0), 0) +
      (activeInvestments || [])
      .reduce((sum, inv) => sum + parseFloat(inv.total_paid_out || 0), 0);

    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('investment_balance, games_balance')
      .eq('user_id', userId)
      .single();

    const nextPayout = activeInvestments && activeInvestments.length > 0
      ? activeInvestments.reduce((earliest, inv) => {
          const invDate = new Date(inv.next_payout_date);
          const earliestDate = earliest ? new Date(earliest.next_payout_date) : null;
          return !earliestDate || invDate < earliestDate ? inv : earliest;
        }, null)
      : null;

    res.json({
      status: 'success',
      message: 'Investment dashboard retrieved successfully',
      data: {
        summary: {
          total_invested: totalInvested,
          total_roi_earned: totalRoiEarned,
          withdrawable_balance: parseFloat(wallet?.investment_balance || 0),
          games_balance: parseFloat(wallet?.games_balance || 0),
          active_investments_count: activeInvestments?.length || 0,
          completed_investments_count: completedInvestments?.length || 0
        },
        next_payout: nextPayout ? {
          investment_id: nextPayout.id,
          plan_name: nextPayout.plan_name,
          amount: nextPayout.weekly_payout_amount,
          date: nextPayout.next_payout_date,
          week: nextPayout.current_week + 1
        } : null,
        active_investments: activeInvestments || [],
        recent_completed: (completedInvestments || []).slice(0, 5)
      }
    });

  } catch (error) {
    console.error('Get investment dashboard error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Request withdrawal from investment balance (Min ₦5,000)
const requestWithdrawal = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        data: { errors: errors.array() }
      });
    }

    const { amount } = req.body;
    const userId = req.user.id;

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    if (user.role === 'demo') {
      return res.status(403).json({
        status: 'error',
        message: 'Demo accounts cannot request withdrawals.'
      });
    }

    // Check if user has active or completed investments
    const { data: userInvestments } = await supabaseAdmin
      .from('investments')
      .select('id, status, current_week, duration_weeks')
      .eq('user_id', userId);

    const hasMatured = (userInvestments || []).some(inv => inv.status === 'completed' || inv.current_week >= (inv.duration_weeks || 13));
    const hasActive = (userInvestments || []).some(inv => inv.status === 'active');

    if (!userInvestments || userInvestments.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'You have no active or matured investment plans.'
      });
    }

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('investment_balance, account_name, bank_name, account_number')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({
        status: 'error',
        message: 'Wallet not found'
      });
    }

    if (!wallet.account_name || !wallet.bank_name || !wallet.account_number) {
      return res.status(400).json({
        status: 'error',
        message: 'Please set your bank account details before withdrawing'
      });
    }

    if (parseFloat(wallet.investment_balance) < amount) {
      return res.status(400).json({
        status: 'error',
        message: 'Insufficient investment balance'
      });
    }

    const newBalance = parseFloat(wallet.investment_balance) - amount;

    const { error: updateError } = await supabaseAdmin
      .from('wallets')
      .update({ investment_balance: newBalance })
      .eq('user_id', userId);

    if (updateError) {
      throw updateError;
    }

    const reference = `WD_INVESTMENT_${Date.now()}_${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    const { data: transaction, error: transactionError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'withdrawal',
        balance_type: 'investment_balance',
        amount: amount,
        currency: 'NGN',
        status: 'pending',
        reference: reference,
        description: `Investment withdrawal request - ₦${amount.toLocaleString()}`,
        withdrawal_method: 'bank_transfer',
        metadata: {
          bank_details: {
            account_name: wallet.account_name,
            bank_name: wallet.bank_name,
            account_number: wallet.account_number
          }
        }
      })
      .select()
      .single();

    if (transactionError) {
      await supabaseAdmin
        .from('wallets')
        .update({ investment_balance: wallet.investment_balance })
        .eq('user_id', userId);
      
      throw transactionError;
    }

    res.json({
      status: 'success',
      message: 'Withdrawal request submitted successfully',
      data: {
        transaction: {
          id: transaction.id,
          reference: reference,
          amount: amount,
          status: 'pending',
          created_at: transaction.created_at
        },
        new_balance: newBalance
      }
    });

  } catch (error) {
    console.error('Request investment withdrawal error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Transfer from investment balance to games balance
const transferToGames = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        data: { errors: errors.array() }
      });
    }

    const { amount } = req.body;
    const userId = req.user.id;

    const { data: minSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'investment_transfer_min_amount')
      .single();

    const minAmount = parseFloat(minSetting?.setting_value || 1000);

    if (amount < minAmount) {
      return res.status(400).json({
        status: 'error',
        message: `Minimum transfer amount is ₦${minAmount.toLocaleString()}`
      });
    }

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('investment_balance, games_balance')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      return res.status(404).json({
        status: 'error',
        message: 'Wallet not found'
      });
    }

    if (parseFloat(wallet.investment_balance) < amount) {
      return res.status(400).json({
        status: 'error',
        message: 'Insufficient investment balance'
      });
    }

    const newInvestmentBalance = parseFloat(wallet.investment_balance) - amount;
    const newGamesBalance = parseFloat(wallet.games_balance) + amount;

    const { error: updateError } = await supabaseAdmin
      .from('wallets')
      .update({
        investment_balance: newInvestmentBalance,
        games_balance: newGamesBalance
      })
      .eq('user_id', userId);

    if (updateError) {
      throw updateError;
    }

    const reference = `TRF_INV_GAMES_${Date.now()}_${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'transfer',
        balance_type: 'games_balance',
        amount: amount,
        currency: 'NGN',
        status: 'completed',
        reference: reference,
        description: `Transfer from investment to games balance - ₦${amount.toLocaleString()}`,
        metadata: {
          from_balance: 'investment_balance',
          to_balance: 'games_balance',
          previous_investment_balance: wallet.investment_balance,
          previous_games_balance: wallet.games_balance,
          new_investment_balance: newInvestmentBalance,
          new_games_balance: newGamesBalance
        }
      });

    res.json({
      status: 'success',
      message: 'Transfer successful',
      data: {
        amount: amount,
        new_investment_balance: newInvestmentBalance,
        new_games_balance: newGamesBalance
      }
    });

  } catch (error) {
    console.error('Transfer investment to games error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Admin: Get all investments
const adminGetAllInvestments = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('investments')
      .select(`
        *,
        users (
          id, username, email, full_name, phone_number, user_tier
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(`reference.ilike.%${search}%`);
    }

    const { data: investments, error, count } = await query;

    if (error) {
      throw error;
    }

    res.json({
      status: 'success',
      message: 'Investments retrieved successfully',
      data: {
        investments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit)
        }
      }
    });

  } catch (error) {
    console.error('Admin get all investments error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Admin: Get investment statistics
const adminGetInvestmentStats = async (req, res) => {
  try {
    const { data: allInvestments } = await supabaseAdmin
      .from('investments')
      .select('*');

    const activeInvestments = allInvestments?.filter(inv => inv.status === 'active') || [];
    const completedInvestments = allInvestments?.filter(inv => inv.status === 'completed') || [];

    const totalCapitalInvested = allInvestments?.reduce((sum, inv) => 
      sum + parseFloat(inv.capital_amount), 0) || 0;

    const totalRoiPaid = allInvestments?.reduce((sum, inv) => 
      sum + parseFloat(inv.total_paid_out || 0), 0) || 0;

    const activeCapital = activeInvestments.reduce((sum, inv) => 
      sum + parseFloat(inv.capital_amount), 0);

    const planBreakdown = {};
    allInvestments?.forEach(inv => {
      if (!planBreakdown[inv.plan_name]) {
        planBreakdown[inv.plan_name] = {
          count: 0,
          total_capital: 0,
          total_roi_paid: 0
        };
      }
      planBreakdown[inv.plan_name].count += 1;
      planBreakdown[inv.plan_name].total_capital += parseFloat(inv.capital_amount);
      planBreakdown[inv.plan_name].total_roi_paid += parseFloat(inv.total_paid_out || 0);
    });

    res.json({
      status: 'success',
      message: 'Investment statistics retrieved successfully',
      data: {
        overview: {
          total_investments: allInvestments?.length || 0,
          active_investments: activeInvestments.length,
          completed_investments: completedInvestments.length,
          total_capital_invested: totalCapitalInvested,
          active_capital: activeCapital,
          total_roi_paid: totalRoiPaid
        },
        plan_breakdown: planBreakdown
      }
    });

  } catch (error) {
    console.error('Admin get investment stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Admin: Process weekly payouts
const adminProcessWeeklyPayouts = async (req, res) => {
  try {
    const currentDate = new Date();
    
    const { data: dueInvestments, error: investmentError } = await supabaseAdmin
      .from('investments')
      .select('*')
      .eq('status', 'active')
      .lte('next_payout_date', currentDate.toISOString());

    if (investmentError) {
      throw investmentError;
    }

    if (!dueInvestments || dueInvestments.length === 0) {
      return res.json({
        status: 'success',
        message: 'No payouts due at this time',
        data: { processed: 0, total_amount: 0 }
      });
    }

    let processedCount = 0;
    let totalAmountPaid = 0;
    const errors = [];

    for (const investment of dueInvestments) {
      try {
        const nextWeek = investment.current_week + 1;
        let payoutAmount = parseFloat(investment.weekly_payout_amount);

        // If this is the final week, add capital back
        if (nextWeek >= (investment.duration_weeks || 13)) {
          payoutAmount += parseFloat(investment.capital_amount);
        }

        const { data: wallet } = await supabaseAdmin
          .from('wallets')
          .select('investment_balance')
          .eq('user_id', investment.user_id)
          .single();

        const newBalance = parseFloat(wallet?.investment_balance || 0) + payoutAmount;

        await supabaseAdmin
          .from('wallets')
          .update({ investment_balance: newBalance })
          .eq('user_id', investment.user_id);

        const { data: transaction } = await supabaseAdmin
          .from('transactions')
          .insert({
            user_id: investment.user_id,
            transaction_type: 'reward',
            balance_type: 'investment_balance',
            earning_type: 'investment_return',
            amount: payoutAmount,
            currency: 'NGN',
            status: 'completed',
            reference: `INV_PAYOUT_${investment.id}_WK${nextWeek}_${Date.now()}`,
            description: `Investment ROI payout - Week ${nextWeek} of ${investment.plan_name} plan`,
            metadata: {
              investment_id: investment.id,
              week_number: nextWeek,
              plan_name: investment.plan_name
            }
          })
          .select()
          .single();

        const nextPayoutDate = new Date(investment.next_payout_date);
        nextPayoutDate.setDate(nextPayoutDate.getDate() + 7);

        const newTotalPaidOut = parseFloat(investment.total_paid_out || 0) + payoutAmount;

        if (nextWeek >= (investment.duration_weeks || 13)) {
          await supabaseAdmin
            .from('investments')
            .update({
              status: 'completed',
              current_week: nextWeek,
              total_paid_out: newTotalPaidOut,
              updated_at: currentDate.toISOString()
            })
            .eq('id', investment.id);
        } else {
          await supabaseAdmin
            .from('investments')
            .update({
              current_week: nextWeek,
              next_payout_date: nextPayoutDate.toISOString(),
              total_paid_out: newTotalPaidOut,
              updated_at: currentDate.toISOString()
            })
            .eq('id', investment.id);
        }

        processedCount++;
        totalAmountPaid += payoutAmount;

      } catch (error) {
        console.error(`Error processing investment ${investment.id}:`, error);
        errors.push({ investment_id: investment.id, error: error.message });
      }
    }

    res.json({
      status: 'success',
      message: `Processed ${processedCount} payouts successfully`,
      data: {
        processed: processedCount,
        total_amount: totalAmountPaid,
        failed: errors.length
      }
    });

  } catch (error) {
    console.error('Admin process weekly payouts error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Admin: Get pending investment withdrawals
const adminGetPendingWithdrawals = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('transactions')
      .select(`
        *,
        users!transactions_user_id_fkey (
          id, username, email, full_name, phone_number
        )
      `, { count: 'exact' })
      .eq('transaction_type', 'withdrawal')
      .eq('balance_type', 'investment_balance')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (search) {
      query = query.or(`reference.ilike.%${search}%`);
    }

    const { data: withdrawals, error, count } = await query;

    if (error) {
      throw error;
    }

    res.json({
      status: 'success',
      message: 'Pending investment withdrawals retrieved successfully',
      data: {
        withdrawals,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit)
        }
      }
    });

  } catch (error) {
    console.error('Admin get pending investment withdrawals error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Admin: Process investment withdrawal (approve/decline)
const adminProcessWithdrawal = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        data: { errors: errors.array() }
      });
    }

    const { transactionId } = req.params;
    const { action, decline_reason } = req.body;
    const adminId = req.user.id;

    const { data: transaction, error: transactionError } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('transaction_type', 'withdrawal')
      .eq('balance_type', 'investment_balance')
      .eq('status', 'pending')
      .single();

    if (transactionError || !transaction) {
      return res.status(404).json({
        status: 'error',
        message: 'Withdrawal transaction not found'
      });
    }

    if (action === 'approve') {
      const { error: updateError } = await supabaseAdmin
        .from('transactions')
        .update({
          status: 'completed',
          processed_by: adminId,
          processed_at: new Date().toISOString()
        })
        .eq('id', transactionId);

      if (updateError) throw updateError;

      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('total_withdrawn_investment')
        .eq('user_id', transaction.user_id)
        .single();

      const newTotalWithdrawn = parseFloat(wallet?.total_withdrawn_investment || 0) + parseFloat(transaction.amount);

      await supabaseAdmin
        .from('wallets')
        .update({ total_withdrawn_investment: newTotalWithdrawn })
        .eq('user_id', transaction.user_id);

      res.json({
        status: 'success',
        message: 'Withdrawal approved successfully',
        data: { transactionId, action: 'approve', amount: transaction.amount }
      });

    } else if (action === 'decline') {
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('investment_balance')
        .eq('user_id', transaction.user_id)
        .single();

      const restoredBalance = parseFloat(wallet?.investment_balance || 0) + parseFloat(transaction.amount);

      await supabaseAdmin
        .from('wallets')
        .update({ investment_balance: restoredBalance })
        .eq('user_id', transaction.user_id);

      const { error: updateError } = await supabaseAdmin
        .from('transactions')
        .update({
          status: 'cancelled',
          processed_by: adminId,
          processed_at: new Date().toISOString(),
          decline_reason: decline_reason || 'Declined by admin'
        })
        .eq('id', transactionId);

      if (updateError) throw updateError;

      res.json({
        status: 'success',
        message: 'Withdrawal declined successfully',
        data: { transactionId, action: 'decline', amount: transaction.amount, restored_balance: restoredBalance }
      });

    } else {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid action. Use "approve" or "decline"'
      });
    }

  } catch (error) {
    console.error('Admin process investment withdrawal error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// Admin: Bulk process investment withdrawals
const adminBulkProcessWithdrawals = async (req, res) => {
  try {
    const { transaction_ids, action, decline_reason } = req.body;
    const adminId = req.user.id;

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'transaction_ids must be a non-empty array'
      });
    }

    let processedCount = 0;
    let totalAmount = 0;
    const processedIds = [];
    const failedIds = [];

    for (const transactionId of transaction_ids) {
      try {
        const { data: transaction } = await supabaseAdmin
          .from('transactions')
          .select('*')
          .eq('id', transactionId)
          .eq('transaction_type', 'withdrawal')
          .eq('balance_type', 'investment_balance')
          .eq('status', 'pending')
          .single();

        if (!transaction) {
          failedIds.push(transactionId);
          continue;
        }

        if (action === 'approve') {
          await supabaseAdmin
            .from('transactions')
            .update({ status: 'completed', processed_by: adminId, processed_at: new Date().toISOString() })
            .eq('id', transactionId);

          const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('total_withdrawn_investment')
            .eq('user_id', transaction.user_id)
            .single();

          const newTotalWithdrawn = parseFloat(wallet?.total_withdrawn_investment || 0) + parseFloat(transaction.amount);

          await supabaseAdmin
            .from('wallets')
            .update({ total_withdrawn_investment: newTotalWithdrawn })
            .eq('user_id', transaction.user_id);

        } else if (action === 'decline') {
          const { data: wallet } = await supabaseAdmin
            .from('wallets')
            .select('investment_balance')
            .eq('user_id', transaction.user_id)
            .single();

          const restoredBalance = parseFloat(wallet?.investment_balance || 0) + parseFloat(transaction.amount);

          await supabaseAdmin
            .from('wallets')
            .update({ investment_balance: restoredBalance })
            .eq('user_id', transaction.user_id);

          await supabaseAdmin
            .from('transactions')
            .update({ status: 'cancelled', processed_by: adminId, processed_at: new Date().toISOString(), decline_reason: decline_reason || 'Declined by admin' })
            .eq('id', transactionId);
        }

        processedCount++;
        totalAmount += parseFloat(transaction.amount);
        processedIds.push(transactionId);

      } catch (error) {
        console.error(`Error processing transaction ${transactionId}:`, error);
        failedIds.push(transactionId);
      }
    }

    res.json({
      status: 'success',
      message: `Bulk ${action} completed`,
      data: {
        processed_count: processedCount,
        failed_count: failedIds.length,
        total_amount: totalAmount,
        processed_ids: processedIds,
        failed_ids: failedIds.length > 0 ? failedIds : undefined
      }
    });

  } catch (error) {
    console.error('Admin bulk process investment withdrawals error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

module.exports = {
  getPlans,
  investFromBalance,
  getMyInvestments,
  getInvestmentDetails,
  getDashboard,
  requestWithdrawal,
  transferToGames,
  autoProcessDuePayouts,
  
  // Admin endpoints
  adminGetAllInvestments,
  adminGetInvestmentStats,
  adminProcessWeeklyPayouts,
  adminGetPendingWithdrawals,
  adminProcessWithdrawal,
  adminBulkProcessWithdrawals
};
