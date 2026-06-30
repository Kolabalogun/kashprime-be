const { supabaseAdmin } = require('../services/supabase.service');

/**
 * Dynamically calculates a manager's referral performance and available balance.
 * @param {string} managerId - The user ID of the manager
 * @returns {Promise<{
 *   total_deposits: number,
 *   total_earned: number,
 *   total_withdrawn: number,
 *   referral_balance: number
 * }>}
 */
async function calculateManagerReferralBalance(managerId) {
  try {
    // 1. Get all referred users (downlines) of this manager
    const { data: downlines } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('referred_by', managerId);

    if (!downlines || downlines.length === 0) {
      // Get current total_withdrawn_referral to be safe
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('total_withdrawn_referral')
        .eq('user_id', managerId)
        .single();
        
      const totalWithdrawn = parseFloat(wallet?.total_withdrawn_referral || 0);
      return {
        total_deposits: 0,
        total_earned: 0,
        total_withdrawn: totalWithdrawn,
        referral_balance: 0
      };
    }

    const downlineIds = downlines.map(d => d.id);

    // 2. Fetch sum of all completed direct game deposits of these downlines
    const { data: depositsData, error: depositsError } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('transaction_type', 'deposit')
      .eq('status', 'completed')
      .eq('balance_type', 'games_balance')
      .in('user_id', downlineIds);

    if (depositsError) throw depositsError;

    const totalDeposits = depositsData?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) || 0;

    // 3. Get manager commission percent setting
    const { data: managerPercentSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'referral_manager_deposit_percent')
      .single();

    const percent = managerPercentSetting ? parseFloat(managerPercentSetting.setting_value) : 9;
    const totalEarned = totalDeposits * (percent / 100);

    // 4. Fetch wallet to get current total_withdrawn_referral
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('total_withdrawn_referral')
      .eq('user_id', managerId)
      .single();

    if (walletError) throw walletError;

    const totalWithdrawn = parseFloat(wallet?.total_withdrawn_referral || 0);

    return {
      total_deposits: totalDeposits,
      total_earned: totalEarned,
      total_withdrawn: totalWithdrawn,
      referral_balance: Math.max(0, totalEarned - totalWithdrawn)
    };
  } catch (error) {
    console.error('Error calculating manager referral balance:', error);
    return {
      total_deposits: 0,
      total_earned: 0,
      total_withdrawn: 0,
      referral_balance: 0
    };
  }
}

module.exports = {
  calculateManagerReferralBalance
};
