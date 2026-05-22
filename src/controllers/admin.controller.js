const { supabaseAdmin } = require('../services/supabase.service');
const { decryptPassword } = require('../utils/helpers');

// ==================== USER MANAGEMENT ====================

const getAllUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      role,
      user_tier,
      account_status,
      sort_by = 'created_at',
      sort_order = 'desc'
    } = req.query;

    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('users')
      .select(`
        id, email, username, full_name, phone_number, 
        user_tier, role, account_status, referral_code,
        original_password, created_at, last_login_at, referred_by,
        referrer:referred_by (
          id, username, email
        ),
        wallets (
          games_balance, withdrawable_balance, referral_balance, investment_balance, coins_balance,
          total_withdrawn_games, total_withdrawn_withdrawable, total_withdrawn_referral, 
          total_withdrawn_investment, total_withdrawn_coins
        )
      `)
      .range(offset, offset + parseInt(limit) - 1)
      .order(sort_by, { ascending: sort_order === 'asc' });

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,username.ilike.%${search}%`);
    }
    if (role) query = query.eq('role', role);
    if (user_tier) query = query.eq('user_tier', user_tier);
    if (account_status) query = query.eq('account_status', account_status);

    const { data: users, error } = await query;
    if (error) throw error;

    const usersWithDecryptedPasswords = users.map(user => {
      const cleanUser = {
        ...user,
        decrypted_password: user.original_password ? decryptPassword(user.original_password) : 'Not available'
      };
      delete cleanUser.original_password;
      return cleanUser;
    });

    let countQuery = supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (search) {
      countQuery = countQuery.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,username.ilike.%${search}%`);
    }
    if (role) countQuery = countQuery.eq('role', role);
    if (user_tier) countQuery = countQuery.eq('user_tier', user_tier);
    if (account_status) countQuery = countQuery.eq('account_status', account_status);

    const { count: totalUsers } = await countQuery;

    res.status(200).json({
      status: 'success',
      message: 'Users retrieved successfully',
      data: {
        users: usersWithDecryptedPasswords,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil(totalUsers / limit),
          total_users: totalUsers,
          has_next: offset + limit < totalUsers,
          has_prev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getUserDetails = async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select(`
        id, email, username, full_name, phone_number, 
        user_tier, role, account_status, referral_code, 
        password, original_password,
       
        created_at, updated_at, last_login_at, referred_by,
        referrer:referred_by (
          id, username, full_name, email, user_tier, role,
          password, original_password, phone_number, created_at,
          wallets (
            referral_balance, coins_balance
          )
        ),
        wallets (*)
      `)
      .eq('id', userId)
      .single();

    if (error) throw error;

    let userDecryptedPassword = 'Not available';
    if (user.original_password) {
      try {
        userDecryptedPassword = decryptPassword(user.original_password);
      } catch (error) {
        console.error('Error decrypting user password:', error);
        userDecryptedPassword = 'Decryption failed';
      }
    }

    let referrerInfo = null;
    if (user.referrer) {
      let referrerDecryptedPassword = 'Not available';
      if (user.referrer.original_password) {
        try {
          referrerDecryptedPassword = decryptPassword(user.referrer.original_password);
        } catch (error) {
          console.error('Error decrypting referrer password:', error);
          referrerDecryptedPassword = 'Decryption failed';
        }
      }
      referrerInfo = {
        ...user.referrer,
        decrypted_password: referrerDecryptedPassword
      };
    }

    const { data: directReferrals } = await supabaseAdmin
      .from('users')
      .select(`
        id, username, full_name, user_tier, email, 
        password, original_password, phone_number, created_at, referred_by,
        referrer:referred_by (
          id, username, full_name, email
        ),
        wallets (
          referral_balance, coins_balance
        )
      `)
      .eq('referred_by', userId)
      .order('created_at', { ascending: false });

    const directReferralsWithPasswords = directReferrals?.map(ref => {
      let decryptedPassword = 'Not available';
      if (ref.original_password) {
        try {
          decryptedPassword = decryptPassword(ref.original_password);
        } catch (error) {
          decryptedPassword = 'Decryption failed';
        }
      }
      return {
        ...ref,
        decrypted_password: decryptedPassword,
        level: 'Direct (Level 1)',
        referred_by_info: ref.referrer
      };
    }) || [];

    const tier1Referrals = [];
    if (directReferrals && directReferrals.length > 0) {
      const directReferralIds = directReferrals.map(ref => ref.id);
      const { data: tier1Data } = await supabaseAdmin
        .from('users')
        .select(`
          id, username, full_name, user_tier, email, 
          password, original_password, phone_number, created_at, referred_by,
          referrer:referred_by (
            id, username, full_name, email
          ),
          wallets (
            referral_balance, coins_balance
          )
        `)
        .in('referred_by', directReferralIds)
        .order('created_at', { ascending: false });
      
      if (tier1Data) {
        tier1Referrals.push(...tier1Data);
      }
    }

    const tier1ReferralsWithPasswords = tier1Referrals.map(ref => {
      let decryptedPassword = 'Not available';
      if (ref.original_password) {
        try {
          decryptedPassword = decryptPassword(ref.original_password);
        } catch (error) {
          decryptedPassword = 'Decryption failed';
        }
      }
      return {
        ...ref,
        decrypted_password: decryptedPassword,
        level: 'Tier 1 (Level 2)',
        referred_by_info: ref.referrer,
        referred_by_username: ref.referrer?.username || 'Unknown'
      };
    });

    const tier2Referrals = [];
    if (tier1Referrals && tier1Referrals.length > 0) {
      const tier1ReferralIds = tier1Referrals.map(ref => ref.id);
      const { data: tier2Data } = await supabaseAdmin
        .from('users')
        .select(`
          id, username, full_name, user_tier, email, 
          password, original_password, phone_number, created_at, referred_by,
          referrer:referred_by (
            id, username, full_name, email
          ),
          wallets (
            referral_balance, coins_balance
          )
        `)
        .in('referred_by', tier1ReferralIds)
        .order('created_at', { ascending: false });
      
      if (tier2Data) {
        tier2Referrals.push(...tier2Data);
      }
    }

    const tier2ReferralsWithPasswords = tier2Referrals.map(ref => {
      let decryptedPassword = 'Not available';
      if (ref.original_password) {
        try {
          decryptedPassword = decryptPassword(ref.original_password);
        } catch (error) {
          decryptedPassword = 'Decryption failed';
        }
      }
      return {
        ...ref,
        decrypted_password: decryptedPassword,
        level: 'Tier 2 (Level 3)',
        referred_by_info: ref.referrer,
        referred_by_username: ref.referrer?.username || 'Unknown'
      };
    });

    const { data: transactions } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    const { data: referralBreakdown } = await supabaseAdmin
      .from('referrals')
      .select('package_type, direct_reward, tier1_reward, tier2_reward, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    const wallet = user.wallets?.[0] || {};
    const summary = {
      total_balance: (parseFloat(wallet.games_balance || 0) + 
                     parseFloat(wallet.withdrawable_balance || 0) + 
                     parseFloat(wallet.referral_balance || 0) + 
                     parseFloat(wallet.investment_balance || 0) + 
                     parseFloat(wallet.coins_balance || 0)),
      games_balance: parseFloat(wallet.games_balance || 0),
      withdrawable_balance: parseFloat(wallet.withdrawable_balance || 0),
      referral_balance: parseFloat(wallet.referral_balance || 0),
      investment_balance: parseFloat(wallet.investment_balance || 0),
      coins_balance: parseFloat(wallet.coins_balance || 0),
      total_withdrawn: (parseFloat(wallet.total_withdrawn_games || 0) +
                       parseFloat(wallet.total_withdrawn_withdrawable || 0) +
                       parseFloat(wallet.total_withdrawn_referral || 0) +
                       parseFloat(wallet.total_withdrawn_investment || 0) +
                       parseFloat(wallet.total_withdrawn_coins || 0))
    };

    res.status(200).json({
      status: 'success',
      message: 'User details retrieved successfully',
      data: {
        user: {
          ...user,
          decrypted_password: userDecryptedPassword,
          referrer: referrerInfo
        },
        referrer_info: referrerInfo,
        referral_network: {
          direct_referrals: directReferralsWithPasswords,
          tier1_referrals: tier1ReferralsWithPasswords,
          tier2_referrals: tier2ReferralsWithPasswords
        },
        referral_stats: {
          direct_count: directReferrals?.length || 0,
          tier1_count: tier1Referrals?.length || 0,
          tier2_count: tier2Referrals?.length || 0,
          total_network: (directReferrals?.length || 0) + (tier1Referrals?.length || 0) + (tier2Referrals?.length || 0),
          breakdown: referralBreakdown
        },
        summary,
        transactions: transactions || []
      }
    });

  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const determineTransactionType = (transaction) => {
  const { transaction_type, earning_type } = transaction;
  
  const creditTypes = ['reward', 'deposit', 'transfer_in', 'refund', 'bonus'];
  const debitTypes = ['withdrawal', 'game_entry', 'investment', 'transfer_out', 'purchase'];
  const creditEarningTypes = ['referral_reward', 'tier1_reward', 'tier2_reward', 'game_win', 'investment_return'];

  if (creditTypes.includes(transaction_type)) return true;
  if (debitTypes.includes(transaction_type)) return false;
  if (earning_type && creditEarningTypes.includes(earning_type)) return true;

  return parseFloat(transaction.amount) >= 0;
};

const getUserEarningsAdmin = async (req, res) => {
  try {
    const { userId } = req.params;
    const { days = 30 } = req.query;

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError) throw walletError;

    const { data: allTransactions, error: transError } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (transError) throw transError;

    let totalEarnings = 0;
    let totalDeductions = 0;
    let recentEarnings = 0;
    let recentDeductions = 0;

    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - parseInt(days));

    const earningsBreakdown = {
      referral_rewards: 0,
      tier1_rewards: 0,
      tier2_rewards: 0,
      game_wins: 0,
      investment_returns: 0,
      deposits: 0,
      other: 0
    };

    const deductionsBreakdown = {
      withdrawals: 0,
      game_entries: 0,
      investments: 0,
      transfers: 0,
      purchases: 0,
      other: 0
    };

    const enhancedRecentTransactions = [];
    const creditTransactions = [];
    const debitTransactions = [];
    const recentCreditTransactions = [];
    const recentDebitTransactions = [];

    allTransactions.forEach(t => {
      const amount = parseFloat(t.amount);
      const isCredit = determineTransactionType(t);
      const isRecent = new Date(t.created_at) >= dateLimit;

      if (isCredit) {
        totalEarnings += amount;
        creditTransactions.push(t);
        if (isRecent) {
          recentEarnings += amount;
          recentCreditTransactions.push(t);
        }

        if (t.earning_type === 'referral_reward') earningsBreakdown.referral_rewards += amount;
        else if (t.earning_type === 'tier1_reward') earningsBreakdown.tier1_rewards += amount;
        else if (t.earning_type === 'tier2_reward') earningsBreakdown.tier2_rewards += amount;
        else if (t.earning_type === 'game_win') earningsBreakdown.game_wins += amount;
        else if (t.earning_type === 'investment_return') earningsBreakdown.investment_returns += amount;
        else if (t.transaction_type === 'deposit') earningsBreakdown.deposits += amount;
        else earningsBreakdown.other += amount;

      } else {
        totalDeductions += amount;
        debitTransactions.push(t);
        if (isRecent) {
          recentDeductions += amount;
          recentDebitTransactions.push(t);
        }

        if (t.transaction_type === 'withdrawal') deductionsBreakdown.withdrawals += amount;
        else if (t.transaction_type === 'game_entry') deductionsBreakdown.game_entries += amount;
        else if (t.transaction_type === 'investment') deductionsBreakdown.investments += amount;
        else if (t.transaction_type === 'transfer_out') deductionsBreakdown.transfers += amount;
        else if (t.transaction_type === 'purchase') deductionsBreakdown.purchases += amount;
        else deductionsBreakdown.other += amount;
      }

      if (isRecent) {
        enhancedRecentTransactions.push({
          ...t,
          type_category: isCredit ? 'credit' : 'debit'
        });
      }
    });

    const { count: directReferrals } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', userId);

    const responseData = {
      current_wallet: {
        coins_balance: parseFloat(wallet.coins_balance || 0),
        games_balance: parseFloat(wallet.games_balance || 0),
        withdrawable_balance: parseFloat(wallet.withdrawable_balance || 0),
        referral_balance: parseFloat(wallet.referral_balance || 0),
        investment_balance: parseFloat(wallet.investment_balance || 0),
        total_withdrawn_games: parseFloat(wallet.total_withdrawn_games || 0),
        total_withdrawn_withdrawable: parseFloat(wallet.total_withdrawn_withdrawable || 0),
        total_withdrawn_referral: parseFloat(wallet.total_withdrawn_referral || 0),
        total_withdrawn_investment: parseFloat(wallet.total_withdrawn_investment || 0),
        total_withdrawn_coins: parseFloat(wallet.total_withdrawn_coins || 0)
      },
      
      earnings_summary: {
        all_time: {
          total_earnings: totalEarnings,
          breakdown: earningsBreakdown,
          transaction_count: creditTransactions.length
        },
        recent_period: {
          days: parseInt(days),
          total_earnings: recentEarnings,
          transaction_count: recentCreditTransactions.length
        }
      },

      deductions_summary: {
        all_time: {
          total_deductions: totalDeductions,
          breakdown: deductionsBreakdown,
          transaction_count: debitTransactions.length
        },
        recent_period: {
          days: parseInt(days),
          total_deductions: recentDeductions,
          transaction_count: recentDebitTransactions.length
        }
      },

      net_summary: {
        all_time_net: totalEarnings - totalDeductions,
        recent_period_net: recentEarnings - recentDeductions
      },

      referral_statistics: {
        direct_referrals: directReferrals || 0,
        tier1_referrals: 0,
        tier2_referrals: 0,
        total_referrals: directReferrals || 0
      },

      recent_transactions: enhancedRecentTransactions.slice(0, 100),
      transactions: enhancedRecentTransactions,

      statistics: {
        total_transactions: (allTransactions || []).length,
        first_transaction_date: (allTransactions || []).length > 0 
          ? allTransactions[allTransactions.length - 1].created_at 
          : null,
        last_transaction_date: (allTransactions || []).length > 0 
          ? allTransactions[0].created_at 
          : null
      }
    };

    res.status(200).json({
      status: 'success',
      message: 'User earnings data retrieved successfully',
      data: responseData
    });

  } catch (error) {
    console.error('Get user earnings admin error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch user earnings data',
      data: null
    });
  }
};

const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { account_status, user_tier, role } = req.body;

    const updateData = {};
    if (account_status) updateData.account_status = account_status;
    if (user_tier) updateData.user_tier = user_tier;
    if (role) updateData.role = role;

    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    await supabaseAdmin
      .from('admin_activities')
      .insert({
        admin_id: req.user.id,
        activity_type: 'user_updated',
        description: `Updated user: ${updatedUser.username}`,
        metadata: { userId, changes: updateData }
      });

    res.status(200).json({
      status: 'success',
      message: 'User updated successfully',
      data: { user: updatedUser }
    });

  } catch (error) {
    console.error('Update user status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// ==================== WITHDRAWAL MANAGEMENT ====================

const getPendingWithdrawals = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status = 'pending',
      balance_type = '', 
      sort_by = 'created_at',
      sort_order = 'desc'
    } = req.query;

    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('transactions')
      .select(`
        id, user_id, amount, currency, description, reference,
        withdrawal_method, created_at, metadata, balance_type, status,
        users!transactions_user_id_fkey (id, username, full_name, email, phone_number)
      `)
      .eq('transaction_type', 'withdrawal')
      .range(offset, offset + parseInt(limit) - 1)
      .order(sort_by, { ascending: sort_order === 'asc' });

    // Status Filter
    if (status) {
      query = query.eq('status', status);
    }

    // Balance Type Filter (Allow specific or exclude coins by default if viewing pending)
    if (balance_type) {
      query = query.eq('balance_type', balance_type);
    } else if (status === 'pending') {
      // Traditionally, the management table excludes coins
      query = query.neq('balance_type', 'coins_balance');
    }

    if (search) {
      const { data: searchUsers, error: userError } = await supabaseAdmin
        .from('users')
        .select('id')
        .or(`username.ilike.%${search}%,full_name.ilike.%${search}%,email.ilike.%${search}%`);
      
      if (userError) throw userError;
      
      if (searchUsers.length > 0) {
        const userIds = searchUsers.map(user => user.id);
        query = query.in('user_id', userIds);
      } else {
        return res.status(200).json({
          status: 'success',
          message: 'Withdrawals retrieved successfully',
          data: {
            withdrawals: [],
            pagination: {
              current_page: parseInt(page),
              total_pages: 0,
              total_withdrawals: 0,
              has_next: false,
              has_prev: page > 1,
              limit: parseInt(limit)
            }
          }
        });
      }
    }

    const { data: withdrawals, error } = await query;
    if (error) throw error;

    let countQuery = supabaseAdmin
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('transaction_type', 'withdrawal');

    if (status) countQuery = countQuery.eq('status', status);
    if (balance_type) {
      countQuery = countQuery.eq('balance_type', balance_type);
    } else if (status === 'pending') {
      countQuery = countQuery.neq('balance_type', 'coins_balance');
    }

    if (search) {
      const { data: searchUsers, error: userError } = await supabaseAdmin
        .from('users')
        .select('id')
        .or(`username.ilike.%${search}%,full_name.ilike.%${search}%,email.ilike.%${search}%`);
      
      if (userError) throw userError;
      
      if (searchUsers.length > 0) {
        const userIds = searchUsers.map(user => user.id);
        countQuery = countQuery.in('user_id', userIds);
      }
    }

    const { count: totalCount, error: countError } = await countQuery;
    if (countError) throw countError;

    res.status(200).json({
      status: 'success',
      message: 'Pending withdrawals retrieved successfully',
      data: {
        withdrawals,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil((totalCount || 0) / limit),
          total_withdrawals: totalCount || 0,
          has_next: offset + limit < (totalCount || 0),
          has_prev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get pending withdrawals error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const processWithdrawal = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { action, decline_reason = '' } = req.body;

    if (!['approve', 'decline'].includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid action. Must be "approve" or "decline"'
      });
    }

    console.log(`=== PROCESSING WITHDRAWAL ${action.toUpperCase()}: ${transactionId} ===`);

    const { data: transaction, error: transError } = await supabaseAdmin
      .from('transactions')
      .select(`
        *, 
        users!transactions_user_id_fkey(username, full_name, email)
      `)
      .eq('id', transactionId)
      .eq('transaction_type', 'withdrawal')
      .eq('status', 'pending')
      .single();

    if (transError || !transaction) {
      console.error('Transaction not found:', transError);
      return res.status(404).json({
        status: 'error',
        message: 'Transaction not found or already processed'
      });
    }

    if (action === 'approve') {
      const { error: updateError } = await supabaseAdmin
        .from('transactions')
        .update({
          status: 'completed',
          metadata: {
            ...(transaction.metadata || {}),
            processed_by: req.user.id,
            processed_at: new Date().toISOString()
          }
        })
        .eq('id', transactionId);

      if (updateError) {
        console.error('Failed to update transaction status for approval:', updateError);
        throw updateError;
      }

      console.log('✅ Withdrawal approved successfully');

      await supabaseAdmin
        .from('admin_activities')
        .insert({
          admin_id: req.user.id,
          activity_type: 'withdrawal_approved',
          description: `Approved withdrawal for ${transaction.users?.username || 'Unknown'} - ₦${parseFloat(transaction.amount).toLocaleString()}`,
          metadata: { 
            transactionId, 
            action: 'approve', 
            amount: parseFloat(transaction.amount),
            user_id: transaction.user_id,
            balance_type: transaction.balance_type
          }
        });

      return res.status(200).json({
        status: 'success',
        message: 'Withdrawal approved successfully',
        data: { 
          transactionId, 
          action: 'approve', 
          amount: parseFloat(transaction.amount),
          username: transaction.users?.username || 'Unknown'
        }
      });

    } else if (action === 'decline') {
      console.log('Processing decline with refund...');
      const balanceType = transaction.balance_type || 'referral_balance';
      const balanceName = balanceType.replace('_balance', '');
      const totalWithdrawnField = `total_withdrawn_${balanceName}`;

      const { data: wallet, error: walletFetchError } = await supabaseAdmin
        .from('wallets')
        .select(`id, ${balanceType}, ${totalWithdrawnField}`)
        .eq('user_id', transaction.user_id)
        .single();

      if (walletFetchError || !wallet) {
        console.error('Failed to fetch user wallet:', walletFetchError);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch user wallet' });
      }

      const currentBalance = parseFloat(wallet[balanceType] || 0);
      const currentTotalWithdrawn = parseFloat(wallet[totalWithdrawnField] || 0);
      const amount = parseFloat(transaction.amount);

      const { error: updateTransactionError } = await supabaseAdmin
        .from('transactions')
        .update({
          status: 'cancelled',
          metadata: {
            ...(transaction.metadata || {}),
            decline_reason: decline_reason?.trim() || 'No reason provided',
            processed_by: req.user.id,
            processed_at: new Date().toISOString()
          }
        })
        .eq('id', transactionId);

      if (updateTransactionError) throw updateTransactionError;

      const { error: walletUpdateError } = await supabaseAdmin
        .from('wallets')
        .update({
          [balanceType]: currentBalance + amount,
          [totalWithdrawnField]: Math.max(0, currentTotalWithdrawn - amount)
        })
        .eq('user_id', transaction.user_id);

      if (walletUpdateError) {
        console.error(`Failed to refund wallet for transaction ${transactionId}:`, walletUpdateError);
        await supabaseAdmin.from('transactions').update({ status: 'pending' }).eq('id', transactionId);
        return res.status(500).json({ status: 'error', message: 'Failed to process refund' });
      }

      await supabaseAdmin
        .from('admin_activities')
        .insert({
          admin_id: req.user.id,
          activity_type: 'withdrawal_declined',
          description: `Declined withdrawal for ${transaction.users?.username || 'Unknown'} - ₦${amount.toLocaleString()}`,
          metadata: { transactionId, action: 'decline', amount, user_id: transaction.user_id, balance_type: balanceType }
        });

      return res.status(200).json({ status: 'success', message: 'Withdrawal declined successfully and amount refunded' });
    }

  } catch (error) {
    console.error(`Process withdrawal error:`, error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const bulkProcessWithdrawals = async (req, res) => {
  try {
    const { transaction_ids, action, decline_reason = '' } = req.body;

    console.log(`=== INITIATING BULK WITHDRAWAL PROCESSING: ${action} for ${transaction_ids.length} transactions ===`);

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid transaction IDs provided'
      });
    }

    if (transaction_ids.length > 50) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot process more than 50 transactions at once'
      });
    }

    if (!['approve', 'decline'].includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid action. Must be "approve" or "decline"'
      });
    }

    const { data: transactions, error: fetchError } = await supabaseAdmin
      .from('transactions')
      .select(`
        *, 
        users!transactions_user_id_fkey(username, full_name)
      `)
      .in('id', transaction_ids)
      .eq('transaction_type', 'withdrawal')
      .eq('status', 'pending');

    if (fetchError) {
      console.error('Failed to fetch transactions:', fetchError);
      throw fetchError;
    }

    if (transactions.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid pending transactions found'
      });
    }

    console.log(`Found ${transactions.length} valid transactions to process`);

    const processedIds = [];
    const failedIds = [];
    let totalAmount = 0;

    for (const transaction of transactions) {
      try {
        console.log(`Processing transaction ${transaction.id} for user ${transaction.users.username}`);

        if (action === 'approve') {
          const { error: updateError } = await supabaseAdmin
            .from('transactions')
            .update({
              status: 'completed',
              metadata: {
                ...(transaction.metadata || {}),
                processed_by: req.user.id,
                processed_at: new Date().toISOString()
              }
            })
            .eq('id', transaction.id);

          if (!updateError) {
            processedIds.push(transaction.id);
            totalAmount += parseFloat(transaction.amount);
            console.log(`✅ Approved transaction ${transaction.id}`);
          } else {
            console.error(`Failed to approve transaction ${transaction.id}:`, updateError);
            failedIds.push(transaction.id);
          }

        } else if (action === 'decline') {
          const balanceType = transaction.balance_type || 'referral_balance';
          const balanceName = balanceType.replace('_balance', '');
          const totalWithdrawnField = `total_withdrawn_${balanceName}`;
          
          const { data: wallet, error: walletFetchError } = await supabaseAdmin
            .from('wallets')
            .select(`id, ${balanceType}, ${totalWithdrawnField}`)
            .eq('user_id', transaction.user_id)
            .single();

          if (walletFetchError || !wallet) {
            console.error(`Failed to fetch wallet for transaction ${transaction.id}:`, walletFetchError);
            failedIds.push(transaction.id);
            continue;
          }

          const currentBalance = parseFloat(wallet[balanceType] || 0);
          const currentTotalWithdrawn = parseFloat(wallet[totalWithdrawnField] || 0);
          const refundAmount = parseFloat(transaction.amount);

          const { error: updateTransactionError } = await supabaseAdmin
            .from('transactions')
            .update({
              status: 'cancelled',
              metadata: {
                ...(transaction.metadata || {}),
                decline_reason: decline_reason?.trim() || 'No reason provided',
                processed_by: req.user.id,
                processed_at: new Date().toISOString()
              }
            })
            .eq('id', transaction.id);

          if (updateTransactionError) {
            console.error(`Failed to update transaction status for ${transaction.id}:`, updateTransactionError);
            failedIds.push(transaction.id);
            continue;
          }

          const { error: walletUpdateError } = await supabaseAdmin
            .from('wallets')
            .update({
              [balanceType]: currentBalance + refundAmount,
              [totalWithdrawnField]: Math.max(0, currentTotalWithdrawn - refundAmount)
            })
            .eq('user_id', transaction.user_id);

          if (walletUpdateError) {
            console.error(`Failed to update wallet balance for transaction ${transaction.id}:`, walletUpdateError);
            failedIds.push(transaction.id);
          } else {
            processedIds.push(transaction.id);
            totalAmount += parseFloat(transaction.amount);
            console.log(`✅ Refunded transaction ${transaction.id} to ${balanceType}`);
          }
        }

      } catch (error) {
        console.error(`Error processing transaction ${transaction.id}:`, error);
        failedIds.push(transaction.id);
      }
    }

    console.log(`Bulk processing completed: ${processedIds.length} successful, ${failedIds.length} failed`);

    await supabaseAdmin
      .from('admin_activities')
      .insert({
        admin_id: req.user.id,
        activity_type: `bulk_withdrawal_${action}d`,
        description: `Bulk ${action}d ${processedIds.length} withdrawals (₦${totalAmount.toLocaleString()})${failedIds.length > 0 ? `, ${failedIds.length} failed` : ''}`,
        metadata: { 
          processedIds, 
          failedIds,
          action, 
          decline_reason: action === 'decline' ? (decline_reason?.trim() || null) : null, 
          processed_count: processedIds.length,
          failed_count: failedIds.length,
          total_amount: totalAmount,
          total_requested: transaction_ids.length
        }
      });

    const response = {
      status: 'success',
      message: `Bulk ${action} completed ${failedIds.length > 0 ? 'with some failures' : 'successfully'}`,
      data: {
        processed_count: processedIds.length,
        failed_count: failedIds.length,
        total_requested: transaction_ids.length,
        total_amount: totalAmount,
        processed_ids: processedIds,
        failed_ids: failedIds
      }
    };

    if (action === 'decline') {
      response.message += failedIds.length === 0 ? ' and amounts refunded to users' : ` (${processedIds.length} refunded successfully)`;
    }

    res.status(200).json(response);

  } catch (error) {
    console.error('Bulk process withdrawals error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getWithdrawalStatistics = async (req, res) => {
  try {
    const { data: stats, error } = await supabaseAdmin
      .rpc('get_withdrawal_stats');

    if (error || !stats) {
      if (error && error.code !== 'PGRST202') {
        console.warn('RPC get_withdrawal_stats failed or missing, falling back to manual queries details:', error.message);
      }
      const [pendingResult, completedResult, cancelledResult] = await Promise.all([
        supabaseAdmin
          .from('transactions')
          .select('amount', { count: 'exact' })
          .eq('transaction_type', 'withdrawal')
          .eq('status', 'pending'),
        
        supabaseAdmin
          .from('transactions')
          .select('amount', { count: 'exact' })
          .eq('transaction_type', 'withdrawal')
          .eq('status', 'completed'),
        
        supabaseAdmin
          .from('transactions')
          .select('amount', { count: 'exact' })
          .eq('transaction_type', 'withdrawal')
          .eq('status', 'cancelled')
      ]);

      const pendingAmount = pendingResult.data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;
      const completedAmount = completedResult.data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;
      const cancelledAmount = cancelledResult.data?.reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;

      return res.status(200).json({
        status: 'success',
        message: 'Withdrawal statistics retrieved successfully',
        data: {
          pending: {
            count: pendingResult.count || 0,
            total_amount: pendingAmount
          },
          completed: {
            count: completedResult.count || 0,
            total_amount: completedAmount
          },
          cancelled: {
            count: cancelledResult.count || 0,
            total_amount: cancelledAmount
          }
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Withdrawal statistics retrieved successfully',
      data: stats
    });

  } catch (error) {
    console.error('Get withdrawal statistics error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// ==================== COINS (KASHCOIN) MANAGEMENT ====================

/**
 * GET /api/admin/kashcoin/statistics
 * Comprehensive analytics for KASHcoin system
 */
const getKashcoinStatistics = async (req, res) => {
  try {
    // 1. Get Dynamic Payout Threshold
    const { data: settings } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value');
    const settingsMap = {};
    settings?.forEach(s => settingsMap[s.setting_key] = s.setting_value);
    
    const threshold = parseFloat(settingsMap['coins_withdrawal_threshold_amount'] || 50000);

    // 2. Fetch High-Level Wallet Stats
    const { data: allWallets, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('coins_balance, user_id');

    if (walletError) throw walletError;

    const totalCoinsPool = allWallets.reduce((sum, w) => sum + parseFloat(w.coins_balance || 0), 0);
    const eligibleWallets = allWallets.filter(w => parseFloat(w.coins_balance) >= threshold);
    const totalPayableUsers = eligibleWallets.length;
    const totalPayableAmount = eligibleWallets.reduce((sum, w) => sum + parseFloat(w.coins_balance || 0), 0);
    const pendingNearThreshold = allWallets.filter(w => {
      const bal = parseFloat(w.coins_balance);
      return bal >= (threshold * 0.8) && bal < threshold;
    }).length;

    // 3. Fetch Transactional Trends (Last 30 Days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentTransactions, error: txError } = await supabaseAdmin
      .from('transactions')
      .select('amount, transaction_type, created_at, user_id, status')
      .eq('balance_type', 'coins_balance')
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (txError) throw txError;

    // Aggregate Daily Earnings
    const dailyEarnings = {};
    
    recentTransactions.forEach(tx => {
      const date = tx.created_at.split('T')[0];
      const amount = Math.abs(parseFloat(tx.amount));
      
      // Treat any positive transaction or reward-like type as an earning
      const isEarning = tx.transaction_type.toLowerCase().includes('reward') || 
                        tx.transaction_type.toLowerCase().includes('earning') ||
                        tx.transaction_type === 'gaming' ||
                        parseFloat(tx.amount) > 0;

      if (isEarning && tx.transaction_type !== 'withdrawal') {
        dailyEarnings[date] = (dailyEarnings[date] || 0) + amount;
      }
    });

    const earningsChartData = Object.keys(dailyEarnings).sort().map(date => ({
      date,
      amount: dailyEarnings[date],
      display_date: new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    }));

    // 4. Calculate PAID & EARNING Rankings
    const getRanking = async (type = 'withdrawal', days = 0) => {
      let query = supabaseAdmin
        .from('transactions')
        .select(`
          amount,
          user_id,
          transaction_type,
          users:user_id (
            username,
            full_name,
            profile_picture
          )
        `)
        .eq('balance_type', 'coins_balance');

      if (type === 'withdrawal') {
        query = query.eq('transaction_type', 'withdrawal').eq('status', 'completed');
      } else {
        // For Earnings: include everything except withdrawals
        query = query.not('transaction_type', 'eq', 'withdrawal');
      }
      
      if (days > 0) {
        const dateLimit = new Date();
        dateLimit.setDate(dateLimit.getDate() - days);
        query = query.gte('created_at', dateLimit.toISOString());
      }

      const { data } = await query;
      
      const userSums = {};
      data?.forEach(tx => {
        const uid = tx.user_id;
        if (!userSums[uid]) {
          userSums[uid] = { 
            id: uid,
            username: tx.users?.username || 'Unknown',
            full_name: tx.users?.full_name || 'N/A',
            profile_picture: tx.users?.profile_picture,
            amount: 0 
          };
        }
        userSums[uid].amount += Math.abs(parseFloat(tx.amount));
      });

      return Object.values(userSums)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);
    };

    const rankings = {
      payouts: {
        today: await getRanking('withdrawal', 1),
        week: await getRanking('withdrawal', 7),
        month: await getRanking('withdrawal', 30),
        all_time: await getRanking('withdrawal', 0)
      },
      earnings: {
        today: await getRanking('earning', 1),
        week: await getRanking('earning', 7),
        month: await getRanking('earning', 30),
        all_time: await getRanking('earning', 0)
      }
    };

    // 5. Total Coins Paid Out to Users
    const { data: allPayouts } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('balance_type', 'coins_balance')
      .eq('transaction_type', 'withdrawal')
      .eq('status', 'completed');

    const totalPaidOut = allPayouts?.reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount)), 0) || 0;

    return res.status(200).json({
      status: 'success',
      data: {
        summary: {
          total_pool: totalCoinsPool,
          total_payable_users: totalPayableUsers,
          total_payable_amount: totalPayableAmount,
          near_threshold_count: pendingNearThreshold,
          total_paid_out: totalPaidOut,
          payout_threshold: threshold
        },
        charts: {
          earnings: earningsChartData
        },
        rankings: rankings
      }
    });

  } catch (error) {
    console.error('Error fetching analytics:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch analytics' });
  }
};

const getKashcoinEligibleUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      sort_by = 'coins_balance',
      sort_order = 'desc'
    } = req.query;

    const { data: settings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['coins_withdrawal_threshold_amount', 'coins_withdrawal_threshold', 'kashcoin_withdrawal_threshold']);

    const getRawSettingValue = (key) => {
      const row = settings?.find(s => s.setting_key === key);
      if (!row) return null;
      try {
        // Platform settings might be stored as JSON strings
        const parsed = JSON.parse(row.setting_value);
        return parsed;
      } catch (e) {
        return row.setting_value;
      }
    };

    const thresholdVal = getRawSettingValue('coins_withdrawal_threshold_amount') || 50000;
    
    const threshold = parseFloat(thresholdVal) || 50000;

    const offset = (page - 1) * limit;

    // Start with wallets because that's where the balance and filtering happens
    let query = supabaseAdmin
      .from('wallets')
      .select(`
        coins_balance,
        account_name,
        bank_name,
        account_number,
        users:user_id (
          id, username, full_name, email, phone_number, created_at
        )
      `)
      .gte('coins_balance', threshold)
      .range(offset, offset + parseInt(limit) - 1)
      .order('coins_balance', { ascending: sort_order === 'asc' });

    if (search) {
      // If searching, we need to filter by user details
      // In Supabase, filtering on a joined table in a select is done via !inner or filters
      // But one of the easiest ways is to get user IDs first if search is provided
      const { data: searchUsers } = await supabaseAdmin
        .from('users')
        .select('id')
        .or(`full_name.ilike.%${search}%,email.ilike.%${search}%,username.ilike.%${search}%`);
      
      if (searchUsers && searchUsers.length > 0) {
        query = query.in('user_id', searchUsers.map(u => u.id));
      } else {
        // No users match search, return empty early
        return res.status(200).json({
          status: 'success',
          message: 'No matching users found',
          data: { users: [], threshold, pagination: { current_page: parseInt(page), total_pages: 0, total_users: 0, has_next: false, has_prev: page > 1, limit: parseInt(limit) } }
        });
      }
    }

    const { data: eligibleUsers, error } = await query;
    if (error) throw error;

    // Count query
    let countQuery = supabaseAdmin
      .from('wallets')
      .select('*', { count: 'exact', head: true })
      .gte('coins_balance', threshold);

    if (search) {
      const { data: searchUsers } = await supabaseAdmin
        .from('users')
        .select('id')
        .or(`full_name.ilike.%${search}%,email.ilike.%${search}%,username.ilike.%${search}%`);
      if (searchUsers) {
        countQuery = countQuery.in('user_id', searchUsers.map(u => u.id));
      }
    }

    const { count: totalCount } = await countQuery;

    res.status(200).json({
      status: 'success',
      message: 'Eligible users retrieved successfully',
      data: {
        users: eligibleUsers || [],
        threshold,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil((totalCount || 0) / limit),
          total_users: totalCount || 0,
          has_next: offset + limit < (totalCount || 0),
          has_prev: page > 1,
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get eligible users error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const processKashcoinPayments = async (req, res) => {
  try {
    const { user_ids } = req.body;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No users selected' });
    }

    const { data: settings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['coins_withdrawal_threshold_amount', 'coins_withdrawal_threshold', 'kashcoin_withdrawal_threshold']);

    const getRawSettingValue = (key) => {
      const row = settings?.find(s => s.setting_key === key);
      if (!row) return null;
      try { return JSON.parse(row.setting_value); }
      catch (e) { return row.setting_value; }
    };

    const thresholdVal = getRawSettingValue('coins_withdrawal_threshold_amount') 
                      || getRawSettingValue('coins_withdrawal_threshold') 
                      || getRawSettingValue('kashcoin_withdrawal_threshold') 
                      || 50000;
    
    const threshold = parseFloat(thresholdVal) || 50000;

    const results = [];
    for (const userId of user_ids) {
      const { data: wallet, error: fetchError } = await supabaseAdmin
        .from('wallets')
        .select('coins_balance, total_withdrawn_coins, account_name, bank_name, account_number')
        .eq('user_id', userId)
        .single();

      if (fetchError || !wallet) {
        results.push({ user_id: userId, status: 'error', message: 'Wallet not found' });
        continue;
      }

      const currentBalance = parseFloat(wallet.coins_balance);
      if (currentBalance < threshold) {
        results.push({ user_id: userId, status: 'error', message: 'Insufficient balance' });
        continue;
      }

      const newBalance = currentBalance - threshold;
      const newWithdrawn = parseFloat(wallet.total_withdrawn_coins || 0) + threshold;

      const { error: updateError } = await supabaseAdmin
        .from('wallets')
        .update({
          coins_balance: newBalance,
          total_withdrawn_coins: newWithdrawn,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId);

      if (updateError) {
        results.push({ user_id: userId, status: 'error', message: 'Update failed' });
        continue;
      }

      const timestamp = new Date().toISOString();
      const reference = `WD-PAYOUT-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      const txRecord = {
        user_id: userId,
        transaction_type: 'withdrawal',
        balance_type: 'coins_balance',
        earning_type: 'withdrawal_payout',
        amount: threshold,
        currency: 'NGN',
        status: 'completed',
        reference: reference,
        description: `Kashcoin withdrawal payout: ₦${threshold.toLocaleString()}`,
        withdrawal_method: 'bank_transfer',
        metadata: {
          account_name: wallet.account_name || 'N/A',
          bank_name: wallet.bank_name || 'N/A',
          account_number: wallet.account_number || 'N/A',
          processed_by_admin: req.user.id,
          processed_at: timestamp,
          payment_category: 'kashcoin_payout'
        }
      };

      console.log(`[PAYOUT] Attempting to log transaction for user ${userId}...`);
      const { data: txData, error: txError } = await supabaseAdmin.from('transactions').insert(txRecord).select().single();

      if (txError) {
        console.error(`[PAYOUT ERROR] Database rejected transaction for user ${userId}:`, txError);
        results.push({ user_id: userId, status: 'partial_success', message: txError.message });
      } else {
        console.log(`[PAYOUT SUCCESS] Transaction recorded with ID: ${txData?.id}`);
        results.push({ user_id: userId, status: 'success', transaction_id: txData?.id });
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Processing complete',
      data: { results }
    });

  } catch (error) {
    console.error('Process kashcoin payments error:', error);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};


// ==================== PLATFORM SETTINGS ====================

const getSettings = async (req, res) => {
  try {
    const { data: settings, error } = await supabaseAdmin
      .from('platform_settings')
      .select('*')
      .order('setting_key');

    if (error) throw error;

    res.status(200).json({
      status: 'success',
      message: 'Settings retrieved successfully',
      data: { settings }
    });

  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const updateSetting = async (req, res) => {
  try {
    const { setting_key, setting_value } = req.body;
    
    // Ensure we stringify objects or arrays if the DB expects JSON/Text that is stringified.
    // Given the DB stores '"true"', '"100"', we must stringify if it's not already stringified.
    let valueToStore = setting_value;
    if (typeof setting_value === 'string' || typeof setting_value === 'number' || typeof setting_value === 'boolean' || typeof setting_value === 'object') {
       valueToStore = JSON.stringify(setting_value);
    }

    const { data: updatedSetting, error } = await supabaseAdmin
      .from('platform_settings')
      .update({
        setting_value: valueToStore,
        updated_at: new Date().toISOString()
      })
      .eq('setting_key', setting_key)
      .select()
      .single();

    if (error) throw error;

    // Clear settings cache so changes apply immediately
    const { clearCache } = require('./settings.controller');
    clearCache();

    await supabaseAdmin
      .from('admin_activities')
      .insert({
        admin_id: req.user.id,
        activity_type: 'setting_updated',
        description: `Updated setting: ${setting_key}`,
        metadata: { setting_key, new_value: setting_value }
      });

    res.status(200).json({
      status: 'success',
      message: 'Setting updated successfully',
      data: { setting: updatedSetting }
    });

  } catch (error) {
    console.error('Update setting error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getDashboardStats = async (req, res) => {
  try {
    // 1. User Stats
    const { data: users, error: userError } = await supabaseAdmin
      .from('users')
      .select('user_tier, role, account_status')
      .neq('role', 'admin');

    if (userError) throw userError;

    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.account_status === 'active').length;
    
    const byTier = {
      Pro: users.filter(u => u.user_tier === 'Pro').length,
      Amateur: users.filter(u => u.user_tier === 'Amateur').length,
      Free: users.filter(u => u.user_tier === 'Free').length
    };

    // 2. Pending Withdrawals
    const { data: pendingWithdrawals, error: withdrawError } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('transaction_type', 'withdrawal')
      .eq('status', 'pending');

    if (withdrawError) throw withdrawError;

    const pendingCount = pendingWithdrawals?.length || 0;
    const pendingAmount = pendingWithdrawals?.reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount)), 0) || 0;

    // 3. Exact Revenue Breakdown (Free vs Pro)
    // Fetch all relevant completed transactions
    const { data: completedTx } = await supabaseAdmin
      .from('transactions')
      .select('user_id, transaction_type, earning_type, amount')
      .eq('status', 'completed');
    
    const userTierMap = {};
    users.forEach(u => {
      userTierMap[u.id] = u.user_tier || 'Free';
    });

    const revenue_by_plan = {
      Pro: { deposits: 0, payouts: 0, game_house_edge: 0, ad_revenue: 0, bonuses: 0, referrals: 0, net_revenue: 0 },
      Amateur: { deposits: 0, payouts: 0, game_house_edge: 0, ad_revenue: 0, bonuses: 0, referrals: 0, net_revenue: 0 },
      Free: { deposits: 0, payouts: 0, game_house_edge: 0, ad_revenue: 0, bonuses: 0, referrals: 0, net_revenue: 0 }
    };

    let totalPlatformRevenue = 0;

    (completedTx || []).forEach(tx => {
      const tier = userTierMap[tx.user_id] || 'Free';
      const amt = parseFloat(tx.amount) || 0;
      
      if (!revenue_by_plan[tier]) return;

      if (tx.transaction_type === 'deposit' || tx.transaction_type === 'subscription') {
        revenue_by_plan[tier].deposits += amt;
        totalPlatformRevenue += amt;
      } else if (tx.transaction_type === 'withdrawal') {
        revenue_by_plan[tier].payouts += Math.abs(amt);
        totalPlatformRevenue -= Math.abs(amt);
      } else if (tx.transaction_type === 'gaming') {
        if (amt < 0) {
           revenue_by_plan[tier].game_house_edge += Math.abs(amt); // User loss = house profit
           totalPlatformRevenue += Math.abs(amt);
        } else if (amt > 0) {
           revenue_by_plan[tier].game_house_edge -= amt; // User win = house loss
           totalPlatformRevenue -= amt;
        }
      } else if (tx.transaction_type === 'ad_payment' || tx.transaction_type === 'sponsored_post_payment') {
        revenue_by_plan[tier].ad_revenue += amt;
        totalPlatformRevenue += amt;
      } else if (tx.transaction_type === 'reward' || tx.transaction_type === 'bonus') {
        revenue_by_plan[tier].bonuses += Math.abs(amt);
        totalPlatformRevenue -= Math.abs(amt);
      } else if (tx.transaction_type === 'referral_bonus' || tx.transaction_type === 'referral') {
        revenue_by_plan[tier].referrals += Math.abs(amt);
        totalPlatformRevenue -= Math.abs(amt);
      }
    });

    // Calculate Nets using exact rules: Deposits + House Edge + Ad Revenue - Withdrawals - Bonuses - Referrals
    Object.keys(revenue_by_plan).forEach(tier => {
       revenue_by_plan[tier].net_revenue = 
          revenue_by_plan[tier].deposits + 
          revenue_by_plan[tier].game_house_edge +
          revenue_by_plan[tier].ad_revenue - 
          revenue_by_plan[tier].payouts -
          revenue_by_plan[tier].bonuses -
          revenue_by_plan[tier].referrals;
    });

    // 3. Wallet Analytics (Balance Breakdown)
    const { data: wallets, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('games_balance, withdrawable_balance, referral_balance, coins_balance, investment_balance');

    if (walletError) throw walletError;

    const totalGames = wallets?.reduce((sum, w) => sum + parseFloat(w.games_balance || 0), 0) || 0;
    const totalWithdrawable = wallets?.reduce((sum, w) => sum + parseFloat(w.withdrawable_balance || 0), 0) || 0;
    const totalReferral = wallets?.reduce((sum, w) => sum + parseFloat(w.referral_balance || 0), 0) || 0;
    const totalCoins = wallets?.reduce((sum, w) => sum + parseFloat(w.coins_balance || 0), 0) || 0;
    const totalInvestment = wallets?.reduce((sum, w) => sum + parseFloat(w.investment_balance || 0), 0) || 0;
    
    // Combined balance excludes investment for the "Total Balance" if desired, or includes all
    const combinedBalance = totalGames + totalWithdrawable + totalReferral + totalCoins;

    // 4. Kash Ads Stats
    const { data: kashAdsData } = await supabaseAdmin
      .from('kash_ads')
      .select('total_coins_earned, total_rewards_claimed');

    const kashAdsTotalEarned = kashAdsData?.reduce((sum, r) => sum + parseFloat(r.total_coins_earned || 0), 0) || 0;
    const kashAdsTotalClaims = kashAdsData?.reduce((sum, r) => sum + parseInt(r.total_rewards_claimed || 0), 0) || 0;
    const kashAdsParticipatingUsers = kashAdsData?.length || 0;

    // 5. Recent Users
    const { data: recentUsers } = await supabaseAdmin
      .from('users')
      .select('username, email, user_tier, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    return res.status(200).json({
      status: 'success',
      message: 'Dashboard stats retrieved successfully',
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          by_tier: byTier
        },
        withdrawals: {
          pending_count: pendingCount,
          pending_amount: pendingAmount
        },
        revenue: {
          total_platform_net: totalPlatformRevenue,
          by_plan: revenue_by_plan
        },
        balance_growth: {
          combined_balance: combinedBalance,
          total_games_balance: totalGames,
          total_withdrawable_balance: totalWithdrawable,
          total_referral_balance: totalReferral,
          total_coins_balance: totalCoins,
          total_investment_balance: totalInvestment
        },
        kash_ads: {
          total_earned: kashAdsTotalEarned,
          total_claims: kashAdsTotalClaims,
          users_count: kashAdsParticipatingUsers
        },
        recent_users: recentUsers || []
      }
    });

  } catch (error) {
    console.error('Error in getDashboardStats:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

const getTopEarners = async (req, res) => {
  try {
    const { data: topEarners, error } = await supabaseAdmin
      .from('wallets')
      .select(`
        referral_balance,
        coins_balance,
        games_balance,
        withdrawable_balance,
        investment_balance,
        users!inner (
          username,
          user_tier
        )
      `)
      .order('referral_balance', { ascending: false })
      .limit(10);

    if (error) throw error;

    const formattedEarners = topEarners?.map((entry, index) => ({
      rank: index + 1,
      username: entry.users?.username || 'N/A',
      user_tier: entry.users?.user_tier || 'Free',
      referral_balance: parseFloat(entry.referral_balance || 0),
      coins_balance: parseFloat(entry.coins_balance || 0),
      games_balance: parseFloat(entry.games_balance || 0),
      withdrawable_balance: parseFloat(entry.withdrawable_balance || 0)
    })) || [];

    res.status(200).json({
      status: 'success',
      message: 'Top earners retrieved successfully',
      data: {
        top_earners: formattedEarners
      }
    });

  } catch (error) {
    console.error('Get top earners error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

// ==================== GAME ANALYTICS ====================

/**
 * GET /api/admin/game-analytics
 * Comprehensive game analytics: revenue, success rates, heatmap, retention, alerts
 */
const getGameAnalytics = async (req, res) => {
  try {
    const { timeframe = 'daily' } = req.query;

    const now = new Date();
    const dailyStart   = new Date(now); dailyStart.setHours(0, 0, 0, 0);
    const weeklyStart  = new Date(now); weeklyStart.setDate(now.getDate() - 7);
    const monthlyStart = new Date(now); monthlyStart.setDate(now.getDate() - 30);
    const ninetyDaysAgo = new Date(now); ninetyDaysAgo.setDate(now.getDate() - 90);
    const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(now.getDate() - 30);

    const rangeStart = timeframe === 'daily' ? dailyStart
                     : timeframe === 'weekly' ? weeklyStart
                     : timeframe === 'all-time' ? new Date(0) // beginning of time
                     : monthlyStart;

    // Calculate previous period
    const prevRangeEnd = new Date(rangeStart);
    let prevRangeStart = new Date(prevRangeEnd);
    if (timeframe === 'daily') {
      prevRangeStart.setDate(prevRangeEnd.getDate() - 1);
    } else if (timeframe === 'weekly') {
      prevRangeStart.setDate(prevRangeEnd.getDate() - 7);
    } else if (timeframe === 'monthly') {
      prevRangeStart.setDate(prevRangeEnd.getDate() - 30);
    } else {
      prevRangeStart = new Date(0); // For all-time, comparison is practically 0
    }

    // ── Earning type helpers (robust to legacy null earning_type) ──
    const isWinType   = (t) => t && t.earning_type 
      ? (t.earning_type.endsWith('_win') || t.earning_type === 'win' || t.earning_type === 'cashout')
      : (t && parseFloat(t.amount || 0) > 0);

    const isStakeType = (t) => t && t.earning_type
      ? (t.earning_type.endsWith('_stake') || t.earning_type === 'bet' || t.earning_type === 'stake')
      : (t && parseFloat(t.amount || 0) < 0 && !t.earning_type?.endsWith('_loss')); // Ignore explicit loss txns so we don't double count stakes

    const isLossType  = (t) => t && t.earning_type && (t.earning_type.endsWith('_loss') || t.earning_type === 'loss' || t.earning_type === 'bust' || t.earning_type === 'bomb');

    const getGame     = (t)  => (t && t.metadata?.game) || (t && t.earning_type ? t.earning_type.split('_').slice(0, -1).join('_') : null) || 'unknown';

    // ── 1. FETCH ALL GAMING TRANSACTIONS (90 days) ──────────────────────
    let allTxns = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('transactions')
        .select('earning_type, amount, created_at, user_id, metadata')
        .eq('transaction_type', 'gaming')
        .gte('created_at', ninetyDaysAgo.toISOString())
        .order('created_at', { ascending: false })
        .limit(5000);
      if (!error) allTxns = data || [];
      else console.warn('getGameAnalytics allTxns error:', error.message);
    } catch (e) { console.warn('getGameAnalytics allTxns catch:', e.message); }

    const txnsInRange = allTxns.filter(t => new Date(t.created_at) >= rangeStart);
    const txns30d     = allTxns.filter(t => new Date(t.created_at) >= thirtyDaysAgo);

    // ── 2. REVENUE PER GAME ─────────────────────────────────────────────
    const gameRevMap = {};
    txnsInRange.forEach(t => {
      const game = getGame(t);
      if (!game) return;
      if (!gameRevMap[game]) gameRevMap[game] = { staked: 0, paid_out: 0 };
      const amt = Math.abs(parseFloat(t.amount || 0));
      if (isStakeType(t)) gameRevMap[game].staked   += amt;
      else if (isWinType(t))  gameRevMap[game].paid_out += amt;
    });

    const gameRevenue = Object.entries(gameRevMap)
      .map(([game, val]) => ({
        game,
        staked:        Math.round(val.staked),
        paid_out:      Math.round(val.paid_out),
        house_revenue: Math.round(val.staked - val.paid_out),
      }))
      .sort((a, b) => b.staked - a.staked);

    const totalRevenue = gameRevenue.reduce((s, g) => s + g.staked, 0);
    const gameRevenueWithPct = gameRevenue.map(g => ({
      ...g,
      percentage: totalRevenue > 0 ? Math.round((g.staked / totalRevenue) * 100) : 0,
      payable_rate: g.staked > 0 ? parseFloat(((g.paid_out / g.staked) * 100).toFixed(1)) : 0,
    }));

    // ── 3. GAME SUCCESS RATES ────────────────────────────────────────────
    const successMap = {};
    allTxns.forEach(t => {
      const game = getGame(t);
      if (!game) return;
      if (!successMap[game]) successMap[game] = { wins: 0, totals: 0 };
      if (isStakeType(t)) successMap[game].totals++;
      if (isWinType(t))  successMap[game].wins++;
    });

    const successRates = Object.entries(successMap)
      .map(([game, val]) => {
        const losses = Math.max(0, val.totals - val.wins);
        return {
          game,
          wins: val.wins,
          losses,
          total: val.totals,
          rate: val.totals > 0 ? parseFloat(((val.wins / val.totals) * 100).toFixed(1)) : 0,
        };
      })
      .filter(s => s.total > 0)
      .sort((a, b) => b.total - a.total);

    // ── 4. ENGAGEMENT HEATMAP (30 days, all gaming txns) ────────────────
    const heatmapMap = {};
    txns30d.forEach(t => {
      // Only count game sessions (stakes), not both stake + win for one play
      if (isStakeType(t)) {
        const d   = new Date(t.created_at);
        const key = `${d.getDay()}_${Math.floor(d.getHours() / 4)}`;
        heatmapMap[key] = (heatmapMap[key] || 0) + 1;
      }
    });

    const heatmapData = [];
    for (let day = 0; day < 7; day++)
      for (let block = 0; block < 6; block++)
        heatmapData.push({ day, hour_block: block, count: heatmapMap[`${day}_${block}`] || 0 });

    // ── 5. COHORT RETENTION ──────────────────────────────────────────────
    let cohortData = [];
    try {
      const { data: signups } = await supabaseAdmin
        .from('users')
        .select('id, created_at')
        .gte('created_at', monthlyStart.toISOString())
        .neq('role', 'admin')
        .order('created_at', { ascending: true });

      // Group by date label (day precision)
      const cohortMap = {};
      (signups || []).forEach(u => {
        const label = new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        if (!cohortMap[label]) cohortMap[label] = { users: [], signupDate: new Date(u.created_at) };
        cohortMap[label].users.push(u.id);
      });

      // Filter allTxns to just the stakes to define "returned to play"
      const allGameUserDates = allTxns.filter(t => isStakeType(t)).map(t => ({ user_id: t.user_id, created_at: new Date(t.created_at) }));

      cohortData = Object.entries(cohortMap).slice(-6).map(([label, { users, signupDate }]) => {
        const checkRetention = (daysAfter) => {
          const windowStart = new Date(signupDate); windowStart.setDate(windowStart.getDate() + daysAfter - 1);
          const windowEnd   = new Date(signupDate); windowEnd.setDate(windowEnd.getDate() + daysAfter + 1);
          if (windowEnd > now) return null;
          const returned = new Set(
            allGameUserDates
              .filter(t => users.includes(t.user_id) && t.created_at >= windowStart && t.created_at <= windowEnd)
              .map(t => t.user_id)
          ).size;
          return users.length > 0 ? Math.round((returned / users.length) * 100) : 0;
        };
        return {
          cohort: label,
          size:   users.length,
          d1:  checkRetention(1),
          d3:  checkRetention(3),
          d7:  checkRetention(7),
          d14: checkRetention(14),
          d30: checkRetention(30),
        };
      });
    } catch (e) { console.warn('cohort error:', e.message); }

    // ── 6. TOP EARNERS ───────────────────────────────────────────────────
    let topEarners = [];
    try {
      if (timeframe === 'all-time') {
        const { data: wallets } = await supabaseAdmin
          .from('wallets')
          .select('games_balance, withdrawable_balance, users!inner(username, user_tier)')
          .order('withdrawable_balance', { ascending: false })
          .limit(10);
        topEarners = (wallets || []).map((w, i) => ({
          rank:          i + 1,
          username:      w.users?.username,
          user_tier:     w.users?.user_tier,
          games_balance: parseFloat(w.games_balance || 0),
          withdrawable_balance: parseFloat(w.withdrawable_balance || 0),
        }));
      } else {
        const userNetMap = {};
        txnsInRange.forEach(t => {
          if (!t.user_id) return;
          const amt = Math.abs(parseFloat(t.amount || 0));
          if (isWinType(t)) {
            userNetMap[t.user_id] = (userNetMap[t.user_id] || 0) + amt;
          } else if (isStakeType(t)) {
            userNetMap[t.user_id] = (userNetMap[t.user_id] || 0) - amt;
          }
        });
        
        const sortedUserIds = Object.keys(userNetMap)
          .filter(uid => userNetMap[uid] > 0)
          .sort((a, b) => userNetMap[b] - userNetMap[a])
          .slice(0, 10);
          
        if (sortedUserIds.length > 0) {
          const { data: uRows } = await supabaseAdmin
            .from('users')
            .select('id, username, user_tier')
            .in('id', sortedUserIds);
          
          const map = {};
          uRows?.forEach(u => { map[u.id] = u; });
          
          topEarners = sortedUserIds.map((uid, i) => ({
            rank: i + 1,
            username: map[uid]?.username || 'N/A',
            user_tier: map[uid]?.user_tier || 'Free',
            games_balance: Math.round(userNetMap[uid]),
            withdrawable_balance: Math.round(userNetMap[uid])
          }));
        }
      }
    } catch (e) { console.warn('topEarners error:', e.message); }

    // ── 7. ALERTS (UPGRADED) ─────────────────────────────────────────────
    const alerts = [];
    try {
      const allUserIdsInScope = [...new Set(txnsInRange.map(t => t.user_id))];
      let usernameMap = {};
      if (allUserIdsInScope.length > 0) {
        const { data: uRows } = await supabaseAdmin
          .from('users').select('id, username').in('id', allUserIdsInScope);
        (uRows || []).forEach(u => { usernameMap[u.id] = u.username; });
      }

      // Group and sort transactions by user for streak/ROI analysis
      const txnsByUser = {};
      txnsInRange.forEach(t => {
        if (!t.user_id) return;
        if (!txnsByUser[t.user_id]) txnsByUser[t.user_id] = [];
        txnsByUser[t.user_id].push(t);
      });

      Object.entries(txnsByUser).forEach(([uid, uTxns]) => {
        const sorted = uTxns.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const username = usernameMap[uid] || 'User';

        // ── Trigger 1: Win Streaks (Consecutive Wins) ──
        const gameStreaks = {};
        sorted.forEach(t => {
          const game = getGame(t);
          if (isWinType(t)) {
            gameStreaks[game] = (gameStreaks[game] || 0) + 1;
            if (gameStreaks[game] >= 4) { // More than 3 in a row
              alerts.push({
                id:      `streak_${uid}_${game}_${t.created_at}`,
                type:    'critical',
                title:   'High Win Streak',
                details: `${username} won ${gameStreaks[game]} rounds consecutively on ${game}.`,
                time:    new Date(t.created_at).toLocaleTimeString(),
              });
            }
          } else if (isLossType(t)) {
            // Explicit loss breaks the streak
            gameStreaks[game] = 0;
          }
        });

        // ── Trigger 2: Extraordinary Profitability (Payables > Stakes) ──
        const uStaked  = uTxns.filter(t => isStakeType(t)).reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
        const uPaidOut = uTxns.filter(t => isWinType(t)).reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
        
        if (uStaked > 500 && uPaidOut > uStaked * 2.5) {
          alerts.push({
            id:      `profitability_${uid}`,
            type:    'warning',
            title:   'High Player ROI',
            details: `${username} has highly suspicious profit ratio (₦${uPaidOut.toLocaleString()} Won / ₦${uStaked.toLocaleString()} Staked).`,
            time:    'Trend',
          });
        }
      });

      // ── Trigger 3: Large Single Wins (Traditional Alert) ──
      txnsInRange.filter(t => isWinType(t) && parseFloat(t.amount || 0) >= 5000).slice(0, 5).forEach(tx => {
        alerts.push({
          id:      `win_large_${tx.user_id}_${tx.created_at}`,
          type:    'critical',
          title:   'Large Win Detected',
          details: `${usernameMap[tx.user_id] || 'User'} won ₦${parseFloat(tx.amount).toLocaleString()} on ${getGame(tx)}.`,
          time:    new Date(tx.created_at).toLocaleTimeString(),
        });
      });

      // ── Trigger 4: Global Activity Spikes ──
      const globalPlays = txnsInRange.filter(t => isStakeType(t)).length;
      if (globalPlays > 100) {
        alerts.push({
          id:      'activity_spike',
          type:    'warning',
          title:   'Activity Spike',
          details: `${globalPlays} game rounds played within the current ${timeframe} window.`,
          time:    'Real-time',
        });
      }

      // ── Trigger 5: Pending Withdrawals ──
      const { count: pc } = await supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true }).eq('transaction_type', 'withdrawal').eq('status', 'pending');
      if (pc > 0) {
        alerts.push({ id: 'pending_w', type: 'warning', title: 'Pending Bank Payouts', details: `${pc} withdrawal requests are currently pending review.`, time: 'Action Required' });
      }

    } catch (e) {
      console.warn('Advanced alert logic error:', e.message);
    }

    // ── 8. KPI ───────────────────────────────────────────────────────────
    const rangeStakes  = txnsInRange.filter(t => isStakeType(t));
    const rangeWins    = txnsInRange.filter(t => isWinType(t));
    const totalStaked  = rangeStakes.reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
    const totalPaidOut = rangeWins.reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
    const totalSessions = rangeStakes.length;
    
    // Previous period KPI
    const txnsInPrevRange = allTxns.filter(t => {
      const dt = new Date(t.created_at);
      return dt >= prevRangeStart && dt < prevRangeEnd;
    });
    const prevStakes = txnsInPrevRange.filter(t => isStakeType(t));
    const prevWins   = txnsInPrevRange.filter(t => isWinType(t));
    const prevTotalStaked  = prevStakes.reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
    const prevTotalPaidOut = prevWins.reduce((s, t) => s + Math.abs(parseFloat(t.amount || 0)), 0);
    const prevTotalSessions = prevStakes.length;

    const calcChange = (curr, prev) => prev > 0 ? parseFloat((((curr - prev) / prev) * 100).toFixed(1)) : (curr > 0 ? 100 : 0);

    const allWins  = allTxns.filter(t => isWinType(t)).length;
    const allPlays = allTxns.filter(t => isStakeType(t) || isLossType(t)).length; // fallback logic
    const avgWinRate = allPlays > 0 ? parseFloat(((allWins / allPlays) * 100).toFixed(1)) : 0;

    // Abandonment from 30-day stake vs win counts
    const monthStakes = txns30d.filter(t => isStakeType(t)).length;
    const monthWins   = txns30d.filter(t => isWinType(t)).length;
    const abandonmentRate = monthStakes > 0
      ? Math.round(((monthStakes - monthWins) / monthStakes) * 100) : 0;

    return res.status(200).json({
      status: 'success',
      data: {
        kpi: {
          total_revenue:    Math.round(totalStaked),
          total_payables:   Math.round(totalPaidOut),
          total_sessions:   totalSessions,
          avg_win_rate:     avgWinRate,
          alerts_count:     alerts.length,
          abandonment_rate: abandonmentRate,
          total_started:    monthStakes,
          total_cashed_out: monthWins,
          changes: {
            revenue:  calcChange(totalStaked, prevTotalStaked),
            payables: calcChange(totalPaidOut, prevTotalPaidOut),
            sessions: calcChange(totalSessions, prevTotalSessions),
          }
        },
        game_revenue:  gameRevenueWithPct,
        success_rates: successRates,
        heatmap:       heatmapData,
        cohorts:       cohortData,
        top_earners:   topEarners,
        alerts:        alerts.slice(0, 50),
        overtime:      (() => {
          const data = [];
          if (timeframe === 'daily') {
            for(let i=0; i<24; i++) data.push({ label: `${i}:00`, staked: 0, paid_out: 0 });
          } else if (timeframe === 'weekly') {
            for(let i=6; i>=0; i--) {
              const d = new Date(); d.setDate(d.getDate() - i);
              data.push({ label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), staked: 0, paid_out: 0 });
            }
          } else {
            for(let i=29; i>=0; i--) {
              const d = new Date(); d.setDate(d.getDate() - i);
              data.push({ label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), staked: 0, paid_out: 0 });
            }
          }
          txnsInRange.forEach(t => {
            const dt = new Date(t.created_at);
            let lb = timeframe === 'daily' ? dt.getHours() + ':00' : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            const b = data.find(x => x.label === lb);
            if (b) {
              const amt = Math.abs(parseFloat(t.amount || 0));
              if (isStakeType(t)) b.staked += amt;
              else if (isWinType(t)) b.paid_out += amt;
            }
          });
          return data;
        })()
      }
    });

  } catch (error) {
    console.error('getGameAnalytics error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch game analytics' });
  }
};



// ==================== ACTIVITY MONITORING CONTROLLERS ====================

const getActivityAnalytics = async (req, res) => {
  try {
    const timeframe = req.query.timeframe || 'daily';
    const now = new Date();
    let timeLimit = new Date();
    let prevTimeLimit = new Date();
    
    if (timeframe === 'daily') {
      timeLimit.setHours(timeLimit.getHours() - 24);
      prevTimeLimit.setHours(prevTimeLimit.getHours() - 48);
    } else if (timeframe === 'weekly') {
      timeLimit.setDate(timeLimit.getDate() - 7);
      prevTimeLimit.setDate(prevTimeLimit.setDate() - 14);
    } else {
      timeLimit.setDate(timeLimit.getDate() - 30);
      prevTimeLimit.setDate(prevTimeLimit.setDate() - 60);
    }

    // 1. Fetch activities for current and previous period
    const { data: activities } = await supabaseAdmin
      .from('kash_user_activities')
      .select('action_type, created_at, user_id, metadata, ip_address, users(username, email, full_name)')
      .gte('created_at', timeLimit.toISOString())
      .order('created_at', { ascending: false });

    const { data: prevActivities } = await supabaseAdmin
      .from('kash_user_activities')
      .select('action_type')
      .lt('created_at', timeLimit.toISOString())
      .gte('created_at', prevTimeLimit.toISOString());

    const validActivities = activities || [];
    const prevValidActivities = prevActivities || [];

    // ── Helper Logic (Sync with Game Analytics) ──
    const isWinType   = (t) => t && t.earning_type 
      ? (t.earning_type.endsWith('_win') || t.earning_type === 'win' || t.earning_type === 'cashout' || t.transaction_type === 'reward' || t.transaction_type === 'game_win')
      : (t && parseFloat(t.amount || 0) > 0 && !['deposit', 'transfer'].includes(t.transaction_type));

    const isStakeType = (t) => t && t.earning_type
      ? (t.earning_type.endsWith('_stake') || t.earning_type === 'bet' || t.earning_type === 'stake' || t.transaction_type === 'bet' || t.transaction_type === 'game_entry')
      : (t && parseFloat(t.amount || 0) < 0 && !['withdrawal', 'transfer'].includes(t.transaction_type));

    // 2. User Statistics
    const { data: newUsers } = await supabaseAdmin
      .from('users')
      .select('id, created_at')
      .gte('created_at', timeLimit.toISOString());

    const activeFromActions = new Set(validActivities.map(a => a.user_id));
    
    // Also consider users who made transactions in the period
    const { data: recentTxnsUsers } = await supabaseAdmin
      .from('transactions')
      .select('user_id')
      .gte('created_at', timeLimit.toISOString());
    
    const activeFromTxns = new Set(recentTxnsUsers?.map(t => t.user_id));
    const uniqueUsersSet = new Set([...activeFromActions, ...activeFromTxns]);

    const returningUsers = Array.from(uniqueUsersSet).filter(uid => !newUsers?.some(nu => nu.id === uid));
    const returningUsersPct = uniqueUsersSet.size > 0 ? ((returningUsers.length / uniqueUsersSet.size) * 100).toFixed(1) : 0;

    // 3. Transactions & Revenue
    const { data: txns } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .gte('created_at', timeLimit.toISOString());

    const totalTxns = txns?.length || 0;
    const failed_txns = txns?.filter(t => t.status === 'failed')?.length || 0;
    
    // Revenue logic (Total Stakes - Total Rewards)
    const inflow = (txns || []).filter(t => isStakeType(t) || ['ads_purchase', 'investment_start'].includes(t.transaction_type))
                               .reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount || 0)), 0);
    const outflow = (txns || []).filter(t => isWinType(t) || ['reward', 'refund', 'commission'].includes(t.transaction_type))
                                .reduce((sum, tx) => sum + Math.abs(parseFloat(tx.amount || 0)), 0);
    const totalRevenue = inflow - outflow;
    
    // Win Rate - Use All-time average to match Game Management Dashboard
    const { data: allTxns } = await supabaseAdmin.from('transactions').select('transaction_type, earning_type, amount');
    const allWinsCount = allTxns?.filter(t => isWinType(t))?.length || 0;
    const allEntriesCount = allTxns?.filter(t => isStakeType(t))?.length || 0;
    const winRate = allEntriesCount > 0 ? ((allWinsCount / allEntriesCount) * 100).toFixed(1) : 0;

    // 4. Wallet Stats
    const { data: wallets } = await supabaseAdmin
      .from('wallets')
      .select('games_balance, withdrawable_balance, coins_balance, referral_balance');
    const allBalances = (wallets || []).map(w => parseFloat(w.games_balance || 0) + parseFloat(w.withdrawable_balance || 0) + parseFloat(w.coins_balance || 0) + parseFloat(w.referral_balance || 0));
    const walletStats = {
      avg: allBalances.length > 0 ? (allBalances.reduce((a,b)=>a+b,0)/allBalances.length).toFixed(0) : 0,
      max: allBalances.length > 0 ? Math.max(...allBalances).toFixed(0) : 0,
      min: allBalances.length > 0 ? Math.min(...allBalances).toFixed(0) : 0
    };

    // 5. Action Breakdown Grouping
    const breakdownMap = validActivities.reduce((acc, act) => {
      if (!acc[act.action_type]) acc[act.action_type] = { count: 0, users: new Set() };
      acc[act.action_type].count++;
      acc[act.action_type].users.add(act.user_id);
      return acc;
    }, {});

    const breakdownList = Object.entries(breakdownMap).map(([type, stats]) => ({
       action_type: type,
       count: stats.count,
       unique_users: stats.users.size,
       prev_count: prevValidActivities.filter(pa => pa.action_type === type).length
    }));

    // 6. Overtime Trends (Chronological labels)
    const overtime = [];
    const labelsMap = new Map();

    if (timeframe === 'daily') {
       // Last 24 hours starting from current hour
       for(let i=23; i>=0; i--) {
          const d = new Date(now);
          d.setHours(d.getHours() - i);
          const label = `${d.getHours()}:00`;
          const key = timeframe + '_' + label; // Unique key for matching
          overtime.push({ label, count: 0, key });
          labelsMap.set(label, overtime[overtime.length - 1]);
       }
    } else {
       const daysToFetch = timeframe === 'weekly' ? 6 : 29;
       for(let i=daysToFetch; i>=0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
          overtime.push({ label, count: 0 });
          labelsMap.set(label, overtime[overtime.length - 1]);
       }
    }

    validActivities.forEach(act => {
      const dt = new Date(act.created_at);
      let lb = timeframe === 'daily' 
        ? dt.getHours() + ':00' 
        : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      
      const bin = labelsMap.get(lb);
      if (bin) bin.count += 1;
    });

    // 7. Detection & Behavior
    const anomalies = [];
    const impressions = breakdownMap['ad_impression']?.count || 0;
    const clicks = breakdownMap['ad_click']?.count || 0;
    const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : 0;

    if (clicks > 200 && ctr > 30) {
       anomalies.push({ user: 'System', type: 'High CTR Spike', reason: `CTR is ${ctr}% (${clicks} clicks).`, severity: 'high', timestamp: new Date() });
    }

    const userMetrics = {};
    validActivities.forEach(a => {
       if (!userMetrics[a.user_id]) userMetrics[a.user_id] = { 
           ips: new Set(), 
           actions: 0, 
           clickCount: 0,
           username: a.users?.username || 'System',
           email: a.users?.email || 'N/A'
       };
       if (a.ip_address) userMetrics[a.user_id].ips.add(a.ip_address);
       userMetrics[a.user_id].actions++;
       if (a.action_type === 'ad_click') userMetrics[a.user_id].clickCount++;
    });

    Object.entries(userMetrics).forEach(([uid, m]) => {
       if (m.ips.size > 3) anomalies.push({ user_id: uid, type: 'IP Rotation', reason: `Detected ${m.ips.size} IPs.`, severity: 'medium', timestamp: new Date() });
       if (m.clickCount > 50) anomalies.push({ user_id: uid, type: 'Click Spike', reason: `User clicked ${m.clickCount} ads.`, severity: 'high', timestamp: new Date() });
    });

    // 8. Heatmap Data
    const heatmap = [];
    for(let d=0; d<7; d++) {
       for(let h=0; h<24; h++) heatmap.push({ day: d, hour: h, count: 0 });
    }
    validActivities.forEach(a => {
       const dt = new Date(a.created_at);
       const bin = heatmap.find(h => h.day === dt.getDay() && h.hour === dt.getHours());
       if (bin) bin.count++;
    });

    return res.status(200).json({
      status: 'success',
      data: {
        kpi: {
          total_actions: validActivities.length,
          prev_total_actions: prevValidActivities.length,
          active_users: uniqueUsersSet.size,
          new_users: newUsers?.length || 0,
          total_txns: totalTxns,
          failed_txns,
          total_revenue: totalRevenue,
          win_rate: winRate,
          returning_users_pct: returningUsersPct || 0,
          avg_wallet: walletStats.avg,
          max_wallet: walletStats.max,
          min_wallet: walletStats.min,
          ctr,
          suspicious_users_count: anomalies.length
        },
        breakdownList,
        overtime,
        anomalies,
        heatmap,
        latestFeed: validActivities.slice(0, 100).map(a => ({
           id: Math.random().toString(36),
           created_at: a.created_at,
           user_id: a.user_id,
           username: a.users?.username || 'System',
           email: a.users?.email || 'N/A',
           action_type: a.action_type,
           ip_address: a.ip_address,
           severity: a.metadata?.severity || (userMetrics[a.user_id]?.clickCount > 20 ? 'high' : 'low')
        })),
        segments: {
           mostActive: Object.entries(userMetrics).sort((a,b)=>b[1].actions - a[1].actions).slice(0, 10).map(([id, m]) => ({ 
              id, 
              count: m.actions,
              username: m.username,
              email: m.email
           }))
        }
      }
    });

  } catch (error) {
    console.error('Activity analytics error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch activity analytics' });
  }
};


const getUserActivities = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const { data: activities, error, count } = await supabaseAdmin
      .from('kash_user_activities')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error && error.code !== '42P01') throw error;

    return res.status(200).json({
      status: 'success',
      data: {
        activities: activities || [],
        pagination: {
          current_page: parseInt(page),
          total_items: count || 0,
        }
      }
    });

  } catch (error) {
    console.error('Get user activities error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch user activities' });
  }
};

const getUserGameActivities = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // We can infer game activities from the transactions table
    const { data: gameTxns, error } = await supabaseAdmin
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .in('transaction_type', ['game_entry', 'game_win'])
        .order('created_at', { ascending: false })
        .limit(100);

    if (error) throw error;

    // Process transactions into logical game sessions
    const sessions = [];
    gameTxns.forEach(tx => {
       sessions.push({
          game_type: tx.metadata?.game_type || 'Unknown Game',
          action: tx.transaction_type,
          amount: parseFloat(tx.amount || 0),
          balance_type: tx.balance_type,
          created_at: tx.created_at,
          status: tx.status
       })
    });

    return res.status(200).json({
      status: 'success',
      data: sessions
    });

  } catch (error) {
    console.error('Get user game activities error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch user game activities' });
  }
};

// ─── MERCHANT MANAGEMENT ───────────────────────────────────────────────────

const getMerchantAnalytics = async (req, res) => {
  try {
    const { data: merchants, error: merchantErr } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, email, created_at, wallets(referral_balance, total_withdrawn_referral, vending_balance, total_loaded_vending, total_transferred_vending)')
      .in('role', ['merchant', 'vendor', 'super_vendor']);

    if (merchantErr) throw merchantErr;

    const { data: allReferrals } = await supabaseAdmin
      .from('referrals')
      .select('referrer_id, referred_id');

    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('id, referred_by')
      .not('referred_by', 'is', null);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentActivity } = await supabaseAdmin
      .from('kash_user_activities')
      .select('user_id')
      .gte('created_at', thirtyDaysAgo);

    const merchantStats = merchants.map(m => {
      const referralRows = (allReferrals || []).filter(r => r.referrer_id === m.id);
      const referredIds = referralRows.map(r => r.referred_id);
      const extraIds = (allUsers || [])
        .filter(u => u.referred_by === m.id && !referredIds.includes(u.id))
        .map(u => u.id);
      const allReferredIds = [...new Set([...referredIds, ...extraIds])];

      const walletData = Array.isArray(m.wallets) ? m.wallets[0] : m.wallets;
      const revenue = parseFloat(walletData?.referral_balance || 0) + parseFloat(walletData?.total_withdrawn_referral || 0);

      const activeUsers = new Set(
        (recentActivity || []).filter(a => allReferredIds.includes(a.user_id)).map(a => a.user_id)
      ).size;
      const active_rate = allReferredIds.length > 0
        ? parseFloat(((activeUsers / allReferredIds.length) * 100).toFixed(1))
        : 0;

      return {
        id: m.id,
        username: m.username,
        referralCount: allReferredIds.length,
        revenue,
        active_users: activeUsers,
        active_rate
      };
    });

    const totalMerchants = merchants.length;
    const topReferrer = [...merchantStats].sort((a, b) => b.referralCount - a.referralCount)[0] || null;
    const topRevenue = [...merchantStats].sort((a, b) => b.revenue - a.revenue)[0] || null;
    const topEngagement = [...merchantStats].sort((a, b) => b.active_rate - a.active_rate)[0] || null;

    let global_total_loaded_vending = 0;
    let global_total_transferred_vending = 0;

    merchants.forEach(m => {
      const w = Array.isArray(m.wallets) ? m.wallets[0] : m.wallets;
      if (w) {
        global_total_loaded_vending += parseFloat(w.total_loaded_vending || 0);
        global_total_transferred_vending += parseFloat(w.total_transferred_vending || 0);
      }
    });

    const topVending = [...merchants]
      .map(m => {
        const w = Array.isArray(m.wallets) ? m.wallets[0] : m.wallets;
        return {
          id: m.id,
          username: m.username,
          vending_balance: parseFloat(w?.vending_balance || 0),
          total_loaded: parseFloat(w?.total_loaded_vending || 0)
        }
      })
      .sort((a, b) => b.vending_balance - a.vending_balance)
      .slice(0, 5);

    return res.status(200).json({
      status: 'success',
      data: {
        total_merchants: totalMerchants,
        top_referrer: topReferrer,
        top_revenue: topRevenue,
        top_engagement: topEngagement,
        global_total_loaded_vending,
        global_total_transferred_vending,
        top_vending_balances: topVending
      }
    });
  } catch (error) {
    console.error('Get merchant analytics error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch merchant analytics' });
  }
};

const getMerchantsList = async (req, res) => {
  try {
    const { search, status, sort_by = 'referralCount', sort_order = 'desc', page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get merchants with wallets
    let query = supabaseAdmin
      .from('users')
      .select('id, username, full_name, email, account_status, created_at, wallets(referral_balance, total_withdrawn_referral, vending_balance)', { count: 'exact' })
      .in('role', ['merchant', 'vendor', 'super_vendor']);

    if (search) {
      query = query.or(`username.ilike.%${search}%,full_name.ilike.%${search}%,email.ilike.%${search}%`);
    }
    if (status) {
      query = query.eq('account_status', status);
    }

    const { data: merchants, count, error: mErr } = await query;
    if (mErr) throw mErr;

    // Get referrals from the referrals table (source of truth)
    const { data: allReferrals } = await supabaseAdmin
      .from('referrals')
      .select('referrer_id, referred_id');

    // Also get users.referred_by for cross-check
    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('id, referred_by')
      .not('referred_by', 'is', null);

    const { data: activities } = await supabaseAdmin
      .from('kash_user_activities')
      .select('user_id');

    const list = merchants.map(m => {
      // Count from referrals table
      const referralRows = (allReferrals || []).filter(r => r.referrer_id === m.id);
      const referredIds = referralRows.map(r => r.referred_id);

      // Also check users.referred_by in case referrals table is missing some
      const extraIds = (allUsers || [])
        .filter(u => u.referred_by === m.id && !referredIds.includes(u.id))
        .map(u => u.id);
      const allReferredIds = [...new Set([...referredIds, ...extraIds])];

      // Revenue = lifetime referral earnings (balance + withdrawn)
      const walletData = Array.isArray(m.wallets) ? m.wallets[0] : m.wallets;
      const revenue = parseFloat(walletData?.referral_balance || 0) + parseFloat(walletData?.total_withdrawn_referral || 0);

      const activityRows = (activities || []).filter(a => allReferredIds.includes(a.user_id));
      const engagement = activityRows.length;
      const activeUsers = new Set(
        activityRows.filter(a => a.created_at >= thirtyDaysAgo).map(a => a.user_id)
      ).size;
      const activeRate = allReferredIds.length > 0
        ? parseFloat(((activeUsers / allReferredIds.length) * 100).toFixed(1))
        : 0;

      const { wallets: _w, ...merchantBase } = m;
      return {
        ...merchantBase,
        referralCount: allReferredIds.length,
        revenue,
        engagement,
        active_users: activeUsers,
        active_rate: activeRate
      };
    });

    // Sort and Paginate in memory (due to complex computed columns)
    const sorted = list.sort((a, b) => {
      const valA = a[sort_by] ?? 0;
      const valB = b[sort_by] ?? 0;
      if (typeof valA === 'string') return sort_order === 'desc' ? valB.localeCompare(valA) : valA.localeCompare(valB);
      return sort_order === 'desc' ? (valB - valA) : (valA - valB);
    });

    const paginated = sorted.slice(offset, offset + parseInt(limit));

    return res.status(200).json({
      status: 'success',
      data: {
        merchants: paginated,
        pagination: {
          current_page: parseInt(page),
          total_items: count || 0,
          total_pages: Math.ceil((count || 0) / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get merchants list error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch merchants list' });
  }
};

const getMerchantCodeAnalytics = async (req, res) => {
  try {
    const { data: codes, error } = await supabaseAdmin
      .from('deposit_codes')
      .select('id, merchant_id, status, amount, created_at');

    if (error) throw error;

    const { data: merchantsRaw } = await supabaseAdmin
      .from('users')
      .select('id, username, wallets(referral_balance, total_withdrawn_referral)')
      .in('role', ['merchant', 'vendor', 'super_vendor']);

    const merchantMap = {};
    (merchantsRaw || []).forEach(m => {
      const walletData = Array.isArray(m.wallets) ? m.wallets[0] : m.wallets;
      merchantMap[m.id] = {
        username: m.username,
        revenue: parseFloat(walletData?.referral_balance || 0) + parseFloat(walletData?.total_withdrawn_referral || 0)
      };
    });

    // Referral counts
    const { data: allReferrals } = await supabaseAdmin.from('referrals').select('referrer_id, referred_id');
    const { data: allUsers } = await supabaseAdmin.from('users').select('id, referred_by').not('referred_by', 'is', null);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentActivity } = await supabaseAdmin
      .from('kash_user_activities')
      .select('user_id')
      .gte('created_at', thirtyDaysAgo);

    const statsByMerchant = {};
    codes?.forEach(c => {
      const mid = c.merchant_id;
      if (!mid) return;
      if (!statsByMerchant[mid]) {
        statsByMerchant[mid] = {
          merchant_id: mid,
          username: merchantMap[mid]?.username || 'Unknown',
          total_requested: 0,
          in_stock: 0,
          redeemed: 0,
          total_value: 0
        };
      }
      statsByMerchant[mid].total_requested++;
      if (c.status === 'active') statsByMerchant[mid].in_stock++;
      if (c.status === 'used') statsByMerchant[mid].redeemed++;
      statsByMerchant[mid].total_value += parseFloat(c.amount || 0);
    });

    // Enrich with referral + revenue + active rate
    const enriched = Object.values(statsByMerchant).map(stat => {
      const mid = stat.merchant_id;
      const refIds = new Set([
        ...(allReferrals || []).filter(r => r.referrer_id === mid).map(r => r.referred_id),
        ...(allUsers || []).filter(u => u.referred_by === mid).map(u => u.id)
      ]);
      const activeCount = new Set(
        (recentActivity || []).filter(a => refIds.has(a.user_id)).map(a => a.user_id)
      ).size;
      const activeRate = refIds.size > 0 ? parseFloat(((activeCount / refIds.size) * 100).toFixed(1)) : 0;

      return {
        ...stat,
        referral_count: refIds.size,
        merchant_revenue: merchantMap[mid]?.revenue || 0,
        active_rate: activeRate
      };
    });

    const topRequested = [...enriched].sort((a, b) => b.total_requested - a.total_requested).slice(0, 5);
    const highestStock = [...enriched].sort((a, b) => b.in_stock - a.in_stock).slice(0, 5);

    const totalCodes = codes?.length || 0;
    const usedCodes = codes?.filter(c => c.status === 'used')?.length || 0;
    const redemptionRate = totalCodes > 0 ? ((usedCodes / totalCodes) * 100).toFixed(1) : 0;

    return res.status(200).json({
      status: 'success',
      data: {
        redemption_rate: redemptionRate,
        top_requested: topRequested,
        highest_stock: highestStock,
        total_value_generated: enriched.reduce((s, m) => s + m.total_value, 0)
      }
    });
  } catch (error) {
    console.error('Get merchant code analytics error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch merchant code analytics' });
  }
};

// ─── MERCHANT DETAIL PAGE ────────────────────────────────────────────────────

const getMerchantDetail = async (req, res) => {
  try {
    const { merchantId } = req.params;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Merchant profile + wallet
    const { data: merchant, error: mErr } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, email, account_status, role, created_at, referral_code, wallets(referral_balance, total_withdrawn_referral)')
      .eq('id', merchantId)
      .single();

    if (mErr || !merchant) {
      return res.status(404).json({ status: 'error', message: 'Merchant not found' });
    }

    // 2. Referrals from referrals table
    const { data: referralRows } = await supabaseAdmin
      .from('referrals')
      .select('referred_id, status, reward_amount, created_at')
      .eq('referrer_id', merchantId);

    // Also cross-check users.referred_by
    const { data: extraUsers } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, user_tier, created_at, wallets(games_balance, withdrawable_balance, referral_balance)')
      .eq('referred_by', merchantId);

    const referredIdsFromTable = (referralRows || []).map(r => r.referred_id);
    const extraIds = (extraUsers || [])
      .filter(u => !referredIdsFromTable.includes(u.id))
      .map(u => u.id);
    const allReferredIds = [...new Set([...referredIdsFromTable, ...extraIds])];

    // 3. Referred user profiles
    let referredUsers = [];
    if (allReferredIds.length > 0) {
      const { data: rUsers } = await supabaseAdmin
        .from('users')
        .select('id, username, full_name, user_tier, created_at, wallets(games_balance, withdrawable_balance, referral_balance)')
        .in('id', allReferredIds);
      referredUsers = rUsers || [];
    }

    // 4. Active users (logged any activity in last 30 days)
    let activeUserIds = new Set();
    if (allReferredIds.length > 0) {
      const { data: recentActivity } = await supabaseAdmin
        .from('kash_user_activities')
        .select('user_id')
        .in('user_id', allReferredIds)
        .gte('created_at', thirtyDaysAgo);
      (recentActivity || []).forEach(a => activeUserIds.add(a.user_id));
    }

    // 5. Revenue (transactions) from referred users
    let referredRevenue = 0;
    if (allReferredIds.length > 0) {
      const { data: txns } = await supabaseAdmin
        .from('transactions')
        .select('user_id, amount, transaction_type')
        .in('user_id', allReferredIds)
        .eq('status', 'completed');
      referredRevenue = (txns || []).reduce((sum, t) => {
        const amt = Math.abs(parseFloat(t.amount || 0));
        if (t.transaction_type === 'deposit') return sum + amt;
        if (t.transaction_type === 'withdrawal') return sum - amt;
        return sum;
      }, 0);
    }

    // 6. Code inventory
    const { data: codes } = await supabaseAdmin
      .from('deposit_codes')
      .select('id, status, amount, created_at')
      .eq('merchant_id', merchantId);

    const codeInventory = {
      total_requested: codes?.length || 0,
      in_stock: codes?.filter(c => c.status === 'active').length || 0,
      redeemed: codes?.filter(c => c.status === 'used').length || 0,
      total_value: codes?.reduce((s, c) => s + parseFloat(c.amount || 0), 0) || 0,
      redemption_rate: codes?.length > 0
        ? ((codes.filter(c => c.status === 'used').length / codes.length) * 100).toFixed(1)
        : '0.0'
    };

    // 7. Merchant's own earnings
    const walletData = Array.isArray(merchant.wallets) ? merchant.wallets[0] : merchant.wallets;
    const merchantRevenue = parseFloat(walletData?.referral_balance || 0) + parseFloat(walletData?.total_withdrawn_referral || 0);

    const activeCount = activeUserIds.size;
    const totalReferrals = allReferredIds.length;
    const activeRate = totalReferrals > 0 ? ((activeCount / totalReferrals) * 100).toFixed(1) : '0.0';

    return res.status(200).json({
      status: 'success',
      data: {
        merchant: {
          id: merchant.id,
          username: merchant.username,
          full_name: merchant.full_name,
          email: merchant.email,
          account_status: merchant.account_status,
          role: merchant.role,
          referral_code: merchant.referral_code,
          created_at: merchant.created_at
        },
        referral_summary: {
          total_referred: totalReferrals,
          active_users: activeCount,
          active_rate: parseFloat(activeRate),
          merchant_revenue: merchantRevenue,
          referred_revenue: referredRevenue
        },
        referred_users: referredUsers.map(u => ({
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          user_tier: u.user_tier,
          is_active: activeUserIds.has(u.id),
          created_at: u.created_at
        })),
        code_inventory: codeInventory
      }
    });

  } catch (error) {
    console.error('Get merchant detail error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to fetch merchant details' });
  }
};

const loadVendingBalance = async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Valid amount is required.' });
    }

    // Verify merchant
    const { data: merchant, error: merchantErr } = await supabaseAdmin
      .from('users')
      .select('id, username, role')
      .eq('id', merchantId)
      .single();

    if (merchantErr || !merchant) {
      return res.status(404).json({ status: 'error', message: 'Merchant not found.' });
    }

    // Update wallet
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from('wallets')
      .select('id, vending_balance, total_loaded_vending')
      .eq('user_id', merchantId)
      .single();

    if (walletErr || !wallet) {
      return res.status(500).json({ status: 'error', message: 'Merchant wallet not found.' });
    }

    const newVendingBalance = parseFloat(wallet.vending_balance || 0) + parseFloat(amount);
    const newTotalLoaded = parseFloat(wallet.total_loaded_vending || 0) + parseFloat(amount);

    const { error: updateErr } = await supabaseAdmin
      .from('wallets')
      .update({
        vending_balance: newVendingBalance,
        total_loaded_vending: newTotalLoaded
      })
      .eq('user_id', merchantId);

    if (updateErr) throw updateErr;

    // Log transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: merchantId,
        amount: amount,
        currency: 'NGN',
        transaction_type: 'deposit',
        status: 'completed',
        description: `Admin loaded vending balance to ${merchant.username}`,
        reference: `VEND-LD-${Date.now()}`,
        balance_type: 'vending_balance',
        metadata: { loaded_by: req.user.id }
      });
      
    // Log admin activity
    await supabaseAdmin
      .from('admin_activities')
      .insert({
        admin_id: req.user.id,
        activity_type: 'vending_balance_loaded',
        description: `Loaded ₦${parseFloat(amount).toLocaleString()} vending balance to @${merchant.username}`,
        metadata: { merchant_id: merchantId, amount: parseFloat(amount) }
      });

    return res.status(200).json({
      status: 'success',
      message: `Successfully loaded ₦${parseFloat(amount).toLocaleString()} to merchant vending balance.`,
      data: {
        new_vending_balance: newVendingBalance
      }
    });

  } catch (error) {
    console.error('Load vending balance error:', error);
    res.status(500).json({ status: 'error', message: 'Internal server error while loading balance.' });
  }
};


module.exports = {
  getAllUsers,
  getUserDetails,
  updateUserStatus,
  getUserEarningsAdmin,
  
  getPendingWithdrawals,
  processWithdrawal,
  bulkProcessWithdrawals,
  getWithdrawalStatistics,

  getKashcoinEligibleUsers,
  processKashcoinPayments,
  getKashcoinStatistics,
  
  getSettings,
  updateSetting,
  
  getDashboardStats,
  getTopEarners,
  getGameAnalytics,
  getActivityAnalytics,
  getUserActivities,
  getUserGameActivities,

  // Merchant Management
  getMerchantAnalytics,
  getMerchantsList,
  getMerchantCodeAnalytics,
  getMerchantDetail,
  loadVendingBalance
};

