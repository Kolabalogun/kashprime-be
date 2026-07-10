const { supabaseAdmin } = require('../services/supabase.service');

/**
 * Dynamically calculates a manager's referral performance and available balance.
 * Uses Tier 2 referrals (referrals of the manager's direct referrals).
 * @param {string} managerId - The user ID of the manager
 * @returns {Promise<{
 *   total_referrals: number,
 *   total_deposits: number,
 *   total_earned: number,
 *   total_withdrawn: number,
 *   referral_balance: number,
 *   tier1_count: number,
 *   tier2_count: number
 * }>}
 */
async function calculateManagerReferralBalance(managerId) {
  try {
    // 1. Fetch Tier 1 referrals (users directly referred by manager)
    const { data: tier1Users } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('referred_by', managerId);

    const tier1Count = tier1Users?.length || 0;

    if (!tier1Users || tier1Users.length === 0) {
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('total_withdrawn_referral')
        .eq('user_id', managerId)
        .single();
        
      const totalWithdrawn = parseFloat(wallet?.total_withdrawn_referral || 0);
      return {
        total_referrals: 0,
        total_deposits: 0,
        total_earned: 0,
        total_withdrawn: totalWithdrawn,
        referral_balance: 0,
        tier1_count: 0,
        tier2_count: 0
      };
    }

    const tier1Ids = tier1Users.map(u => u.id);

    // 2. Fetch Tier 2 referrals (users referred by Tier 1 users)
    const { data: tier2Users } = await supabaseAdmin
      .from('users')
      .select('id')
      .in('referred_by', tier1Ids);

    const tier2Count = tier2Users?.length || 0;

    if (!tier2Users || tier2Users.length === 0) {
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('total_withdrawn_referral')
        .eq('user_id', managerId)
        .single();
        
      const totalWithdrawn = parseFloat(wallet?.total_withdrawn_referral || 0);
      return {
        total_referrals: tier1Count,
        total_deposits: 0,
        total_earned: 0,
        total_withdrawn: totalWithdrawn,
        referral_balance: 0,
        tier1_count: tier1Count,
        tier2_count: 0
      };
    }

    const tier2Ids = tier2Users.map(u => u.id);

    // 3. Fetch sum of all completed direct game deposits of Tier 2 users
    const { data: depositsData, error: depositsError } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('transaction_type', 'deposit')
      .eq('status', 'completed')
      .eq('balance_type', 'games_balance')
      .in('user_id', tier2Ids);

    if (depositsError) throw depositsError;

    const totalDeposits = depositsData?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) || 0;

    // 4. Get manager commission percent setting
    const { data: managerPercentSetting } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_value')
      .eq('setting_key', 'referral_manager_deposit_percent')
      .single();

    const percent = managerPercentSetting ? parseFloat(managerPercentSetting.setting_value) : 9;
    const totalEarned = totalDeposits * (percent / 100);

    // 5. Fetch wallet to get current total_withdrawn_referral
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('total_withdrawn_referral')
      .eq('user_id', managerId)
      .single();

    if (walletError) throw walletError;

    const totalWithdrawn = parseFloat(wallet?.total_withdrawn_referral || 0);

    return {
      total_referrals: tier1Count,
      total_deposits: totalDeposits,
      total_earned: totalEarned,
      total_withdrawn: totalWithdrawn,
      referral_balance: Math.max(0, totalEarned - totalWithdrawn),
      tier1_count: tier1Count,
      tier2_count: tier2Count
    };
  } catch (error) {
    console.error('Error calculating manager referral balance:', error);
    return {
      total_referrals: 0,
      total_deposits: 0,
      total_earned: 0,
      total_withdrawn: 0,
      referral_balance: 0,
      tier1_count: 0,
      tier2_count: 0
    };
  }
}

module.exports = {
  calculateManagerReferralBalance
};
