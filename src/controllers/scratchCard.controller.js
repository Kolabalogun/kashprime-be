const { supabaseAdmin } = require('../services/supabase.service');
const { logActivity } = require('../utils/activityLogger');
const { getPlayableBalance, settleGameStake } = require('../utils/helpers/wallet.helpers');
const {
  DEFAULT_WEIGHTS, DEFAULT_MULTIPLIERS,
  parsePlatformSetting, generateScratchCard, generateTransactionReference, validateStake
} = require('../utils/helpers/scratchCard.helpers');

const getSettings = async (req, res) => {
  try {
    const { data: rows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['scratch_card_enabled','scratch_card_min_stake','scratch_card_win_rate','scratch_card_symbol_weights','scratch_card_multipliers']);
    const map = {};
    rows?.forEach(r => { map[r.setting_key] = r.setting_value; });
    return res.status(200).json({
      status: 'success', message: 'Scratch Card settings retrieved successfully',
      data: { settings: {
        enabled:     parsePlatformSetting(map.scratch_card_enabled, true),
        minStake:    parseFloat(parsePlatformSetting(map.scratch_card_min_stake, '50')),
        winRate:     parseInt(parsePlatformSetting(map.scratch_card_win_rate, '40')),
        weights:     parsePlatformSetting(map.scratch_card_symbol_weights, DEFAULT_WEIGHTS),
        multipliers: parsePlatformSetting(map.scratch_card_multipliers, DEFAULT_MULTIPLIERS),
      }}
    });
  } catch (err) {
    console.error('scratchCard getSettings error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const playGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount } = req.body;
    const stakeAmount = parseFloat(stake_amount);

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['scratch_card_enabled','scratch_card_min_stake','scratch_card_win_rate','scratch_card_symbol_weights','scratch_card_multipliers']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled     = parsePlatformSetting(map.scratch_card_enabled, true);
    const minStake    = parseFloat(parsePlatformSetting(map.scratch_card_min_stake, '50'));
    const winRate     = parseInt(parsePlatformSetting(map.scratch_card_win_rate, '40'));
    const weights     = parsePlatformSetting(map.scratch_card_symbol_weights, DEFAULT_WEIGHTS);
    const multipliers = parsePlatformSetting(map.scratch_card_multipliers, DEFAULT_MULTIPLIERS);

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Scratch Card is currently disabled' });

    const { data: wallet } = await supabaseAdmin.from('wallets').select('bonus_balance, games_balance, withdrawable_balance').eq('user_id', userId).single();
    if (!wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const totalPlayableBalance = getPlayableBalance(wallet);

    const val = validateStake(stakeAmount, minStake, totalPlayableBalance);
    if (!val.valid)
      return res.status(400).json({ status: 'error', message: val.error });

    const { grid, isWin, matchedSymbol, matchCount, multiplier } = generateScratchCard(winRate, weights, multipliers);
    const payout = isWin ? parseFloat((stakeAmount * multiplier).toFixed(2)) : 0;
    const profit = parseFloat((payout - stakeAmount).toFixed(2));
    
    const settlement = settleGameStake(wallet, stakeAmount, payout);
    if (!settlement.ok) {
      return res.status(400).json({ status: 'error', message: settlement.error });
    }

    await supabaseAdmin.from('wallets')
      .update({ 
        bonus_balance: settlement.balances.bonus_balance,
        games_balance: settlement.balances.games_balance, 
        withdrawable_balance: settlement.balances.withdrawable_balance,
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    const { data: round } = await supabaseAdmin.from('scratch_card_rounds').insert({
      user_id: userId, stake_amount: stakeAmount, grid,
      matched_symbol: matchedSymbol, match_count: matchCount,
      multiplier, payout_amount: payout, profit_loss: profit,
      status: isWin ? 'won' : 'lost', ended_at: new Date().toISOString()
    }).select().single();

    const txBase = { user_id: userId, balance_type: 'games_balance', currency: 'NGN', status: 'completed' };
    await supabaseAdmin.from('transactions').insert([
      { ...txBase, transaction_type: 'gaming', earning_type: 'scratch_card_stake', amount: -stakeAmount, reference: generateTransactionReference('STAKE'), description: `Scratch Card stake - ₦${stakeAmount.toLocaleString()}`, metadata: { game: 'scratch_card', round_id: round?.id, stake_amount: stakeAmount } },
      ...(isWin
        ? [{ ...txBase, transaction_type: 'gaming', earning_type: 'scratch_card_win', amount: payout, reference: generateTransactionReference('WIN'), description: `Scratch Card win - ${matchCount}× ${matchedSymbol} at ${multiplier}×`, metadata: { game: 'scratch_card', round_id: round?.id, matched_symbol: matchedSymbol, match_count: matchCount, multiplier, payout } }]
        : [{ ...txBase, transaction_type: 'gaming', earning_type: 'scratch_card_loss', amount: -stakeAmount, reference: generateTransactionReference('LOSS'), description: 'Scratch Card - no match', metadata: { game: 'scratch_card', round_id: round?.id } }])
    ]);

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'scratch_card',
      stake: stakeAmount,
      payout: payout,
      multiplier,
      symbol: matchedSymbol,
      matches: matchCount
    }, req);

    return res.status(200).json({
      status:  isWin ? 'success' : 'error',
      message: isWin
        ? `${matchCount}× ${matchedSymbol.toUpperCase()}! Won ₦${payout.toLocaleString()} 🎰`
        : 'No match this time. Try again!',
      data: {
        result: isWin ? 'win' : 'loss',
        round: {
          id: round?.id, stake_amount: stakeAmount, grid,
          matched_symbol: matchedSymbol, match_count: matchCount,
          multiplier, payout_amount: payout, profit_loss: profit,
          status: isWin ? 'won' : 'lost', created_at: round?.created_at
        },
        new_gaming_wallet_balance: settlement.totalPlayableBalance,
        wallet: settlement.balances
      }
    });
  } catch (err) {
    console.error('scratchCard playGame error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getHistory = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    let query = supabaseAdmin.from('scratch_card_rounds')
      .select('id,stake_amount,matched_symbol,match_count,multiplier,payout_amount,profit_loss,status,created_at', { count: 'exact' })
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data: rounds, count, error } = await query;
    if (error) throw error;
    return res.status(200).json({
      status: 'success', message: 'History retrieved successfully',
      data: { rounds, pagination: { current_page: page, total_pages: Math.ceil(count / limit), total_rounds: count, has_next: page * limit < count, has_prev: page > 1, limit } }
    });
  } catch (err) {
    console.error('scratchCard getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin.from('scratch_card_rounds')
      .select('stake_amount,payout_amount,status,matched_symbol').eq('user_id', req.user.id);
    const total   = rounds?.length || 0;
    const wins    = rounds?.filter(r => r.status === 'won').length || 0;
    const wagered = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount), 0) || 0;
    const won     = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount), 0) || 0;
    return res.status(200).json({
      status: 'success', message: 'Statistics retrieved successfully',
      data: { stats: { total_rounds: total, total_wins: wins, total_losses: total - wins, total_wagered: wagered, total_won: won, net_profit_loss: parseFloat((won - wagered).toFixed(2)), win_rate: total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00' } }
    });
  } catch (err) {
    console.error('scratchCard getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all    } = await supabaseAdmin.from('scratch_card_rounds').select('stake_amount,payout_amount,status,user_id,matched_symbol,created_at');
    const { data: todayR } = await supabaseAdmin.from('scratch_card_rounds').select('stake_amount,payout_amount,status').gte('created_at', today);
    const calc = rows => ({
      total_rounds:   rows.length,
      total_wins:     rows.filter(r => r.status === 'won').length,
      total_losses:   rows.filter(r => r.status === 'lost').length,
      total_wagered:  rows.reduce((s, r) => s + parseFloat(r.stake_amount), 0),
      total_paid_out: rows.reduce((s, r) => s + parseFloat(r.payout_amount), 0),
      house_profit:   rows.reduce((s, r) => s + parseFloat(r.stake_amount) - parseFloat(r.payout_amount), 0),
    });
    const overview = calc(all || []);
    return res.status(200).json({
      status: 'success', message: 'Admin statistics retrieved successfully',
      data: {
        overview: { ...overview, unique_players: new Set((all || []).map(r => r.user_id)).size },
        today: calc(todayR || []),
        house_edge_percentage: overview.total_wagered > 0
          ? ((overview.house_profit / overview.total_wagered) * 100).toFixed(2) : '0.00'
      }
    });
  } catch (err) {
    console.error('scratchCard getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { getSettings, playGame, getHistory, getStatistics, getAdminStatistics };
