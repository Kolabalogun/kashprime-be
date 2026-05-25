const { supabaseAdmin } = require('../services/supabase.service');
const { logActivity } = require('../utils/activityLogger');
const { getPlayableBalance, settleGameStake } = require('../utils/helpers/wallet.helpers');
const {
  DEFAULT_MULTIPLIERS, DEFAULT_WEIGHTS, VALID_COLORS,
  parsePlatformSetting, generateColorResult, generateTransactionReference, validateStake
} = require('../utils/helpers/colorPick.helpers');

const getSettings = async (req, res) => {
  try {
    const { data: rows } = await supabaseAdmin
      .from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['color_pick_enabled','color_pick_min_stake','color_pick_win_rate','color_pick_multipliers','color_pick_weights']);
    const map = {};
    rows?.forEach(r => { map[r.setting_key] = r.setting_value; });
    return res.status(200).json({
      status: 'success',
      message: 'Color Pick settings retrieved successfully',
      data: {
        settings: {
          enabled:     parsePlatformSetting(map.color_pick_enabled, true),
          minStake:    parseFloat(parsePlatformSetting(map.color_pick_min_stake, '50')),
          winRate:     parseInt(parsePlatformSetting(map.color_pick_win_rate, '45')),
          multipliers: parsePlatformSetting(map.color_pick_multipliers, DEFAULT_MULTIPLIERS),
          weights:     parsePlatformSetting(map.color_pick_weights, DEFAULT_WEIGHTS),
        }
      }
    });
  } catch (err) {
    console.error('colorPick getSettings error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const playGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount, player_choice } = req.body;
    const stakeAmount = parseFloat(stake_amount);

    if (!VALID_COLORS.includes(player_choice))
      return res.status(400).json({ status: 'error', message: 'Invalid color. Choose red, green, or blue' });

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['color_pick_enabled','color_pick_min_stake','color_pick_win_rate','color_pick_multipliers','color_pick_weights']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled     = parsePlatformSetting(map.color_pick_enabled, true);
    const minStake    = parseFloat(parsePlatformSetting(map.color_pick_min_stake, '50'));
    const winRate     = parseInt(parsePlatformSetting(map.color_pick_win_rate, '45'));
    const multipliers = parsePlatformSetting(map.color_pick_multipliers, DEFAULT_MULTIPLIERS);
    const weights     = parsePlatformSetting(map.color_pick_weights, DEFAULT_WEIGHTS);

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Color Pick is currently disabled' });

    const { data: wallet } = await supabaseAdmin.from('wallets').select('bonus_balance, games_balance, withdrawable_balance').eq('user_id', userId).single();
    if (!wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const totalPlayableBalance = getPlayableBalance(wallet);

    const val = validateStake(stakeAmount, minStake, totalPlayableBalance);
    if (!val.valid)
      return res.status(400).json({ status: 'error', message: val.error });

    const { drawnColor, isWin } = generateColorResult(player_choice, winRate, weights);
    const multiplier = multipliers[drawnColor];
    const payout  = isWin ? parseFloat((stakeAmount * multiplier).toFixed(2)) : 0;
    const profit  = parseFloat((payout - stakeAmount).toFixed(2));
    
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

    const { data: round } = await supabaseAdmin.from('color_pick_rounds').insert({
      user_id: userId, stake_amount: stakeAmount, player_choice,
      drawn_color: drawnColor, multiplier, payout_amount: payout,
      profit_loss: profit, status: isWin ? 'won' : 'lost',
      ended_at: new Date().toISOString()
    }).select().single();

    const txBase = { user_id: userId, balance_type: 'games_balance', currency: 'NGN', status: 'completed' };
    await supabaseAdmin.from('transactions').insert([
      { ...txBase, transaction_type: 'gaming', earning_type: 'color_pick_stake', amount: -stakeAmount, reference: generateTransactionReference('STAKE'), description: `Color Pick stake - ₦${stakeAmount.toLocaleString()}`, metadata: { game: 'color_pick', round_id: round?.id, player_choice, stake_amount: stakeAmount } },
      ...(isWin
        ? [{ ...txBase, transaction_type: 'gaming', earning_type: 'color_pick_win', amount: payout, reference: generateTransactionReference('WIN'), description: `Color Pick win - ${drawnColor} at ${multiplier}×`, metadata: { game: 'color_pick', round_id: round?.id, drawn_color: drawnColor, multiplier, payout } }]
        : [{ ...txBase, transaction_type: 'gaming', earning_type: 'color_pick_loss', amount: -stakeAmount, reference: generateTransactionReference('LOSS'), description: `Color Pick loss - drew ${drawnColor}`, metadata: { game: 'color_pick', round_id: round?.id, drawn_color: drawnColor } }])
    ]);

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'color_pick',
      player_choice: player_choice,
      drawn_color: drawnColor,
      stake_amount: stakeAmount,
      payout_amount: payout,
      multiplier: multiplier
    }, req);

    return res.status(200).json({
      status: isWin ? 'success' : 'error',
      message: isWin
        ? `${drawnColor.toUpperCase()} drawn! You won ₦${payout.toLocaleString()} 🎨`
        : `${drawnColor.toUpperCase()} drawn. Better luck next time!`,
      data: {
        result: isWin ? 'win' : 'loss',
        round: {
          id: round?.id, stake_amount: stakeAmount, player_choice,
          drawn_color: drawnColor, multiplier, payout_amount: payout,
          profit_loss: profit, status: isWin ? 'won' : 'lost', created_at: round?.created_at
        },
        new_gaming_wallet_balance: settlement.totalPlayableBalance,
        wallet: settlement.balances
      }
    });
  } catch (err) {
    console.error('colorPick playGame error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getHistory = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    let query = supabaseAdmin.from('color_pick_rounds')
      .select('*', { count: 'exact' }).eq('user_id', req.user.id)
      .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data: rounds, count, error } = await query;
    if (error) throw error;
    return res.status(200).json({
      status: 'success', message: 'History retrieved successfully',
      data: { rounds, pagination: { current_page: page, total_pages: Math.ceil(count / limit), total_rounds: count, has_next: page * limit < count, has_prev: page > 1, limit } }
    });
  } catch (err) {
    console.error('colorPick getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin.from('color_pick_rounds')
      .select('stake_amount,payout_amount,status,player_choice').eq('user_id', req.user.id);
    const total   = rounds?.length || 0;
    const wins    = rounds?.filter(r => r.status === 'won').length || 0;
    const wagered = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount), 0) || 0;
    const won     = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount), 0) || 0;
    const byColor = { red: { played: 0, won: 0 }, green: { played: 0, won: 0 }, blue: { played: 0, won: 0 } };
    rounds?.forEach(r => { byColor[r.player_choice].played++; if (r.status === 'won') byColor[r.player_choice].won++; });
    return res.status(200).json({
      status: 'success', message: 'Statistics retrieved successfully',
      data: { stats: { total_rounds: total, total_wins: wins, total_losses: total - wins, total_wagered: wagered, total_won: won, net_profit_loss: parseFloat((won - wagered).toFixed(2)), win_rate: total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00', by_color: byColor } }
    });
  } catch (err) {
    console.error('colorPick getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all    } = await supabaseAdmin.from('color_pick_rounds').select('stake_amount,payout_amount,status,user_id,player_choice,created_at');
    const { data: todayR } = await supabaseAdmin.from('color_pick_rounds').select('stake_amount,payout_amount,status').gte('created_at', today);
    const calc = rows => ({
      total_rounds:   rows.length,
      total_wins:     rows.filter(r => r.status === 'won').length,
      total_losses:   rows.filter(r => r.status === 'lost').length,
      total_wagered:  rows.reduce((s, r) => s + parseFloat(r.stake_amount), 0),
      total_paid_out: rows.reduce((s, r) => s + parseFloat(r.payout_amount), 0),
      house_profit:   rows.reduce((s, r) => s + parseFloat(r.stake_amount) - parseFloat(r.payout_amount), 0),
    });
    const overview = calc(all || []);
    const byColor  = {
      red:   calc((all || []).filter(r => r.player_choice === 'red')),
      green: calc((all || []).filter(r => r.player_choice === 'green')),
      blue:  calc((all || []).filter(r => r.player_choice === 'blue')),
    };
    return res.status(200).json({
      status: 'success', message: 'Admin statistics retrieved successfully',
      data: {
        overview: { ...overview, unique_players: new Set((all || []).map(r => r.user_id)).size },
        today: calc(todayR || []),
        by_color: byColor,
        house_edge_percentage: overview.total_wagered > 0
          ? ((overview.house_profit / overview.total_wagered) * 100).toFixed(2) : '0.00'
      }
    });
  } catch (err) {
    console.error('colorPick getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { getSettings, playGame, getHistory, getStatistics, getAdminStatistics };
