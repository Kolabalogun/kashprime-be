const { supabaseAdmin } = require('./supabase.service');
const {
  generateReferralCode,
  generateToken,
  hashPassword,
  comparePassword,
  encryptPassword,
  decryptPassword
} = require('../utils/helpers');
const MESSAGES = require('../utils/constants/messages');
const { sendWelcomeEmail, sendPasswordResetOTP, sendPasswordChangeConfirmation } = require('./email/sendEmail');

// Register user
const registerUser = async (userData) => {
  const {
    email,
    password,
    username,
    fullName,
    phoneNumber,
    referral,
    ip_address,
    role = 'user'
  } = userData;

  try {
    // Check if email exists
    const { data: existingEmail } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase())
      .single();

    if (existingEmail) {
      throw new Error(MESSAGES.ERROR.EMAIL_EXISTS);
    }

    // Check if username exists
    const { data: existingUsername } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("username", username.toLowerCase())
      .single();

    if (existingUsername) {
      throw new Error(MESSAGES.ERROR.USERNAME_EXISTS);
    }

    // Check referral if provided
    let directReferrer = null;
    if (referral) {
      const { data: referrer } = await supabaseAdmin
        .from("users")
        .select("id, username, referred_by")
        .eq("referral_code", referral.toLowerCase())
        .single();

      if (referrer) {
        directReferrer = referrer;
      }
    }

    // Hash password for authentication AND encrypt original for admin viewing
    const hashedPassword = await hashPassword(password);
    const encryptedOriginalPassword = encryptPassword(password);
    // Let the username be the unique referral code
    const userReferralCode = username.toLowerCase();

    // Create user with BOTH hashed and encrypted passwords
    const { data: newUser, error: userError } = await supabaseAdmin
      .from("users")
      .insert([
        {
          email: email.toLowerCase(),
          username: username.toLowerCase(),
          password: hashedPassword,                    
          original_password: encryptedOriginalPassword,
          full_name: fullName,
          phone_number: phoneNumber,
          user_tier: 'Free',
          referral_code: userReferralCode,
          referred_by: directReferrer?.id || null,
          role,
          ip_address,
        },
      ])
      .select()
      .single();

    if (userError) {
      throw new Error("Failed to create user: " + userError.message);
    }

    // Create user wallet with zero balances (no welcome bonus for Free tier)
    await supabaseAdmin.from("wallets").insert([
      {
        user_id: newUser.id,
        coins_balance: 0,
        bonus_balance: 0,
        games_balance: 0,
        referral_balance: 0,
        investment_balance: 0,
      },
    ]);

    // Create referral record WITHOUT processing rewards (rewards only on Pro upgrade)
    if (directReferrer) {
      await supabaseAdmin.from("referrals").insert([
        {
          referrer_id: directReferrer.id,
          referred_id: newUser.id,
          reward_amount: 0, 
          status: 'pending' // Pending until upgrade
        }
      ]);
    }

    // Generate token with role
    const token = generateToken({
      id: newUser.id,
      email: newUser.email,
      username: newUser.username,
      user_tier: newUser.user_tier,
      role: newUser.role,
    });

    // Send welcome email
    try {
      await sendWelcomeEmail({
        full_name: newUser.full_name,
        email: newUser.email,
        user_tier: newUser.user_tier,
      });
    } catch (emailError) {
      console.error("Failed to send welcome email:", emailError);
    }

    return {
      user: newUser,
      token,
    };
  } catch (error) {
    throw error;
  }
};

// Login user
const loginUser = async (credential, password) => {
  try {
    // Check if credential is email or username
    const isEmail = credential.includes('@');
    const field = isEmail ? 'email' : 'username';

    // First, get the user
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq(field, credential.toLowerCase())
      .eq('account_status', 'active')
      .single();

    if (error || !user) {
      throw new Error(MESSAGES.ERROR.INVALID_CREDENTIALS);
    }

    // Verify password
    const isValidPassword = await comparePassword(password, user.password);

    if (!isValidPassword) {
      // Increment failed login attempts
      await supabaseAdmin
        .from('users')
        .update({
          failed_login_attempts: (user.failed_login_attempts || 0) + 1
        })
        .eq('id', user.id);

      throw new Error(MESSAGES.ERROR.INVALID_CREDENTIALS);
    }

    // Get referrer info if exists
    let referrerInfo = null;
    if (user.referred_by) {
      const { data: referrer } = await supabaseAdmin
        .from('users')
        .select('id, username, full_name')
        .eq('id', user.referred_by)
        .single();

      if (referrer) {
        referrerInfo = {
          id: referrer.id,
          username: referrer.username,
          full_name: referrer.full_name
        };
      }
    }

    // Update last login
    await supabaseAdmin
      .from('users')
      .update({
        last_login_at: new Date().toISOString(),
        failed_login_attempts: 0
      })
      .eq('id', user.id);

    // Generate token
    const token = generateToken({
      id: user.id,
      email: user.email,
      username: user.username,
      user_tier: user.user_tier,
      role: user.role
    });

    // Format user response
    const formattedUser = {
      ...user,
      referred_by: referrerInfo
    };

    // Remove sensitive fields
    delete formattedUser.password;
    delete formattedUser.original_password;
    delete formattedUser.reset_otp;
    delete formattedUser.reset_otp_expires_at;

    return {
      user: formattedUser,
      token
    };
  } catch (error) {
    throw error;
  }
};

// Get user profile with wallet
const getUserProfile = async (userId) => {
  try {
    // Get user data
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      throw new Error(MESSAGES.ERROR.USER_NOT_FOUND);
    }

    // Get wallet data
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    // Get referrer info if exists
    let referrerInfo = null;
    if (user.referred_by) {
      const { data: referrer } = await supabaseAdmin
        .from('users')
        .select('id, username, full_name')
        .eq('id', user.referred_by)
        .single();

      if (referrer) {
        referrerInfo = {
          id: referrer.id,
          username: referrer.username,
          full_name: referrer.full_name
        };
      }
    }

    // Remove sensitive fields
    delete user.password;
    delete user.original_password;
    delete user.reset_otp;
    delete user.reset_otp_expires_at;

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      full_name: user.full_name,
      phone_number: user.phone_number,
      user_tier: user.user_tier,
      role: user.role,
      referral_code: user.referral_code,
      referred_by: referrerInfo,
      profile_picture: user.profile_picture,
      account_status: user.account_status,
      created_at: user.created_at,
      wallet: wallet || {
        games_balance: 0,
        bonus_balance: 0,
        referral_balance: 0,
        investment_balance: 0,
        coins_balance: 0,
        total_withdrawn_games: 0,
        total_withdrawn_referral: 0,
        total_withdrawn_investment: 0,
        total_withdrawn_coins: 0
      }
    };
  } catch (error) {
    throw error;
  }
};

// Forgot password
const forgotPassword = async (email) => {
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name')
      .eq('email', email.toLowerCase())
      .eq('account_status', 'active')
      .single();

    if (userError || !user) {
      throw new Error(MESSAGES.ERROR.EMAIL_NOT_FOUND);
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in users table
    const { error: otpError } = await supabaseAdmin
      .from('users')
      .update({
        reset_otp: otp,
        reset_otp_expires_at: expiresAt.toISOString(),
        reset_otp_attempts: 0
      })
      .eq('id', user.id);

    if (otpError) {
      throw new Error('Failed to generate reset code');
    }

    // Send OTP email
    await sendPasswordResetOTP({
      full_name: user.full_name,
      email: user.email
    }, otp);

    return {
      message: 'Password reset code sent to your email'
    };

  } catch (error) {
    throw error;
  }
};

// Reset password with OTP
const resetPasswordWithOTP = async (email, otp, newPassword) => {
  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('reset_otp', otp)
      .gt('reset_otp_expires_at', new Date().toISOString())
      .single();

    if (userError || !user) {
      if (!userError) {
        await supabaseAdmin
          .from('users')
          .update({
            reset_otp_attempts: (user?.reset_otp_attempts || 0) + 1
          })
          .eq('email', email.toLowerCase());
      }

      throw new Error('Invalid or expired reset code');
    }

    if (user.reset_otp_attempts >= 3) {
      throw new Error('Too many attempts. Please request a new reset code');
    }

    // Hash new password
    const hashedPassword = await hashPassword(newPassword);
    const encryptedPassword = encryptPassword(newPassword);

    // Update password
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        password: hashedPassword,
        original_password: encryptedPassword,
        reset_otp: null,
        reset_otp_expires_at: null,
        reset_otp_attempts: 0,
        last_password_change_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      throw new Error('Failed to update password');
    }

    // Send confirmation email
    try {
      await sendPasswordChangeConfirmation({
        full_name: user.full_name,
        email: user.email
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }

    return {
      message: 'Password reset successfully'
    };

  } catch (error) {
    throw error;
  }
};

// Update password
const updatePassword = async (userId, currentPassword, newPassword) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('password, email, full_name')
      .eq('id', userId)
      .single();

    if (error || !user) {
      throw new Error(MESSAGES.ERROR.USER_NOT_FOUND);
    }

    const isCurrentPasswordValid = await comparePassword(currentPassword, user.password);

    if (!isCurrentPasswordValid) {
      throw new Error(MESSAGES.ERROR.CURRENT_PASSWORD_INCORRECT);
    }

    const hashedNewPassword = await hashPassword(newPassword);
    const encryptedPassword = encryptPassword(newPassword);

    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        password: hashedNewPassword,
        original_password: encryptedPassword,
        last_password_change_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      throw new Error('Failed to update password');
    }

    try {
      await sendPasswordChangeConfirmation({
        full_name: user.full_name,
        email: user.email
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }

    return {
      message: 'Password updated successfully'
    };

  } catch (error) {
    throw error;
  }
};

// Get user referrals
const getUserReferrals = async (userId) => {
  try {
    // Check user role first
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (user?.role === 'manager') {
      // Get manager setting percent
      const { data: managerPercentSetting } = await supabaseAdmin
        .from('platform_settings')
        .select('setting_value')
        .eq('setting_key', 'referral_manager_deposit_percent')
        .single();
      const percent = managerPercentSetting ? parseFloat(managerPercentSetting.setting_value) : 9;

      // Get referred users (downlines)
      const { data: referredUsers } = await supabaseAdmin
        .from('users')
        .select('id, username, full_name, user_tier, account_status, created_at')
        .eq('referred_by', userId)
        .order('created_at', { ascending: false });

      const referredIds = referredUsers?.map(u => u.id) || [];
      let userDeposits = {};
      let totalDeposits = 0;

      if (referredIds.length > 0) {
        // Only game deposits count for manager: balance_type = 'games_balance'
        const { data: depositsData } = await supabaseAdmin
          .from('transactions')
          .select('user_id, amount')
          .in('user_id', referredIds)
          .eq('transaction_type', 'deposit')
          .eq('status', 'completed')
          .eq('balance_type', 'games_balance');

        depositsData?.forEach(d => {
          userDeposits[d.user_id] = (userDeposits[d.user_id] || 0) + parseFloat(d.amount || 0);
          totalDeposits += parseFloat(d.amount || 0);
        });
      }

      // Fetch wallet to get current total_withdrawn_referral
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('total_withdrawn_referral')
        .eq('user_id', userId)
        .single();

      const totalWithdrawn = parseFloat(wallet?.total_withdrawn_referral || 0);
      const totalEarned = totalDeposits * (percent / 100);
      const referralBalance = Math.max(0, totalEarned - totalWithdrawn);

      // Get 6-month deposits trend to group by month
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);

      let chartDataRaw = [];
      if (referredIds.length > 0) {
        const { data } = await supabaseAdmin
          .from('transactions')
          .select('amount, created_at')
          .in('user_id', referredIds)
          .eq('transaction_type', 'deposit')
          .eq('status', 'completed')
          .eq('balance_type', 'games_balance')
          .gte('created_at', sixMonthsAgo.toISOString())
          .order('created_at', { ascending: true });
        chartDataRaw = data || [];
      }

      // Group by month-year
      const monthlyEarnings = {};
      for (let i = 0; i < 6; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const label = d.toLocaleString('default', { month: 'short', year: 'numeric' });
        monthlyEarnings[label] = 0;
      }

      chartDataRaw?.forEach(t => {
        const date = new Date(t.created_at);
        const label = date.toLocaleString('default', { month: 'short', year: 'numeric' });
        if (monthlyEarnings[label] !== undefined) {
          monthlyEarnings[label] += parseFloat(t.amount || 0) * (percent / 100);
        }
      });

      const chartData = Object.entries(monthlyEarnings)
        .map(([month, amount]) => ({ month, amount }))
        .reverse();

      // Gather active referrals statistics
      const referralsStats = {
        total: referredIds.length,
        pro: referredUsers?.filter(u => u.user_tier === 'Pro').length || 0,
        free: referredUsers?.filter(u => u.user_tier !== 'Pro').length || 0,
        active: referredUsers?.filter(u => u.account_status === 'active').length || 0
      };

      return {
        is_manager: true,
        total_referrals: referredUsers?.length || 0,
        total_earnings: totalEarned,
        referral_balance: referralBalance,
        total_withdrawn: totalWithdrawn,
        total_downline_deposits: totalDeposits,
        referrals_stats: referralsStats,
        direct_referrals: referredUsers?.map(u => ({
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          user_tier: u.user_tier,
          status: u.account_status,
          reward_amount: (userDeposits[u.id] || 0) * (percent / 100),
          created_at: u.created_at,
          total_deposits: userDeposits[u.id] || 0
        })) || [],
        chart_data: chartData
      };
    }

    // Get direct referrals from users table directly for truthiness
    const { data: referredUsers } = await supabaseAdmin
      .from('users')
      .select('id, username, full_name, user_tier, created_at')
      .eq('referred_by', userId)
      .order('created_at', { ascending: false });

    // Get referral rewards directly from successful transactions for 100% accuracy
    const { data: rewardTransactions, error: rewardError } = await supabaseAdmin
      .from('transactions')
      .select('amount, metadata')
      .eq('user_id', userId)
      .eq('transaction_type', 'reward')
      .eq('balance_type', 'referral_balance')
      .eq('status', 'completed');

    if (rewardError) console.error('Error fetching rewards:', rewardError);

    // Create a map of reward amounts per user
    const rewardMap = {};
    let totalEarnings = 0;
    
    rewardTransactions?.forEach(t => {
      // Look for the source user ID in metadata
      const sourceId = t.metadata?.referred_user_id;
      if (sourceId) {
        rewardMap[sourceId] = (rewardMap[sourceId] || 0) + parseFloat(t.amount || 0);
      }
      totalEarnings += parseFloat(t.amount || 0);
    });

    const referredIds = referredUsers?.map(user => user.id) || [];
    let userDeposits = {};
    
    if (referredIds.length > 0) {
      const { data: depositsData } = await supabaseAdmin
        .from('transactions')
        .select('user_id, amount')
        .in('user_id', referredIds)
        .eq('transaction_type', 'deposit')
        .eq('status', 'completed');
        
      depositsData?.forEach(d => {
        userDeposits[d.user_id] = (userDeposits[d.user_id] || 0) + parseFloat(d.amount);
      });
    }

    return {
      direct_referrals: referredUsers?.map(user => ({
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        user_tier: user.user_tier,
        reward_amount: rewardMap[user.id] || 0,
        created_at: user.created_at,
        total_deposits: userDeposits[user.id] || 0
      })) || [],
      total_referrals: referredUsers?.length || 0,
      total_earnings: totalEarnings
    };

  } catch (error) {
    throw error;
  }
};


// Get user earnings breakdown
const getUserEarnings = async (userId) => {
  try {
    // Get wallet balances
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (walletError) {
      throw new Error('Error fetching user earnings');
    }

    // Get recent earnings from transactions (last 20)
    const { data: recentTransactions } = await supabaseAdmin
      .from('transactions')
      .select('transaction_type, balance_type, amount, description, created_at, status')
      .eq('user_id', userId)
      .in('status', ['completed'])
      .in('transaction_type', [
        'reward', 
        'video_reward', 
        'sponsored_post_reward', 
        'game_win', 
        'investment_return'
      ])
      .order('created_at', { ascending: false })
      .limit(20);

    // Calculate total earnings by balance type
    const totalEarnings = {
      games_balance: parseFloat(wallet.games_balance || 0),
      bonus_balance: parseFloat(wallet.bonus_balance || 0),
      referral_balance: parseFloat(wallet.referral_balance || 0),
      investment_balance: parseFloat(wallet.investment_balance || 0),
      coins_balance: parseFloat(wallet.coins_balance || 0),
      total: parseFloat(wallet.games_balance || 0) + 
             parseFloat(wallet.bonus_balance || 0) +
             parseFloat(wallet.referral_balance || 0) + 
             parseFloat(wallet.investment_balance || 0) + 
             parseFloat(wallet.coins_balance || 0)
    };

    // Calculate lifetime earnings (current balance + total withdrawn)
    const lifetimeEarnings = {
      games_total: parseFloat(wallet.games_balance || 0) + parseFloat(wallet.total_withdrawn_games || 0),
      referral_total: parseFloat(wallet.referral_balance || 0) + parseFloat(wallet.total_withdrawn_referral || 0),
      investment_total: parseFloat(wallet.investment_balance || 0) + parseFloat(wallet.total_withdrawn_investment || 0),
      coins_total: parseFloat(wallet.coins_balance || 0) + parseFloat(wallet.total_withdrawn_coins || 0),
      grand_total: 
        parseFloat(wallet.games_balance || 0) + parseFloat(wallet.total_withdrawn_games || 0) +
        parseFloat(wallet.referral_balance || 0) + parseFloat(wallet.total_withdrawn_referral || 0) +
        parseFloat(wallet.investment_balance || 0) + parseFloat(wallet.total_withdrawn_investment || 0) +
        parseFloat(wallet.coins_balance || 0) + parseFloat(wallet.total_withdrawn_coins || 0)
    };

    // Group recent transactions by balance type
    const earningsByType = {
      games: recentTransactions?.filter(t => t.balance_type === 'games_balance') || [],
      referral: recentTransactions?.filter(t => t.balance_type === 'referral_balance') || [],
      investment: recentTransactions?.filter(t => t.balance_type === 'investment_balance') || [],
      coins: recentTransactions?.filter(t => t.balance_type === 'coins_balance') || []
    };

    return {
      current_balances: {
        games_balance: parseFloat(wallet.games_balance || 0),
        referral_balance: parseFloat(wallet.referral_balance || 0),
        investment_balance: parseFloat(wallet.investment_balance || 0),
        coins_balance: parseFloat(wallet.coins_balance || 0),
        total_current: totalEarnings.total
      },
      total_withdrawn: {
        games_withdrawn: parseFloat(wallet.total_withdrawn_games || 0),
        referral_withdrawn: parseFloat(wallet.total_withdrawn_referral || 0),
        investment_withdrawn: parseFloat(wallet.total_withdrawn_investment || 0),
        coins_withdrawn: parseFloat(wallet.total_withdrawn_coins || 0),
        total_withdrawn: 
          parseFloat(wallet.total_withdrawn_games || 0) +
          parseFloat(wallet.total_withdrawn_referral || 0) +
          parseFloat(wallet.total_withdrawn_investment || 0) +
          parseFloat(wallet.total_withdrawn_coins || 0)
      },
      lifetime_earnings: lifetimeEarnings,
      recent_earnings: recentTransactions || [],
      earnings_by_type: earningsByType
    };

  } catch (error) {
    throw error;
  }
};

 
module.exports = {
  registerUser,
  loginUser,
  getUserProfile,
  forgotPassword,
  resetPasswordWithOTP,
  updatePassword,
  getUserReferrals, getUserEarnings
};
