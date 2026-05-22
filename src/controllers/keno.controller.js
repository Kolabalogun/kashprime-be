const { supabaseAdmin } = require('../services/supabase.service');
const { logActivity } = require('../utils/activityLogger');
const crypto = require('crypto');
const {
  DEFAULT_PAYOUT_TABLES, parsePlatformSetting,
  generateDrawnNumbers, evaluateResult, generateTransactionReference, validateStake
} = require('../utils/helpers/keno.helpers');

const getSettings = async (req, res) => {
  try {
    const { data: rows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['keno_enabled','keno_min_stake','keno_win_rate','keno_numbers_range','keno_draw_count','keno_min_picks','keno_max_picks','keno_payout_tables']);
    const map = {};
    rows?.forEach(r => { map[r.setting_key] = r.setting_value; });
    return res.status(200).json({
      status: 'success', message: 'Keno settings retrieved successfully',
      data: { settings: {
        enabled:       parsePlatformSetting(map.keno_enabled, true),
        minStake:      parseFloat(parsePlatformSetting(map.keno_min_stake, '50')),
        winRate:       parseInt(parsePlatformSetting(map.keno_win_rate, '45')),
        numbersRange:  parseInt(parsePlatformSetting(map.keno_numbers_range, '40')),
        drawCount:     parseInt(parsePlatformSetting(map.keno_draw_count, '20')),
        minPicks:      parseInt(parsePlatformSetting(map.keno_min_picks, '5')),
        maxPicks:      parseInt(parsePlatformSetting(map.keno_max_picks, '10')),
        payoutTables:  parsePlatformSetting(map.keno_payout_tables, DEFAULT_PAYOUT_TABLES),
      }}
    });
  } catch (err) {
    console.error('keno getSettings error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const playGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount, player_picks } = req.body;
    const stakeAmount = parseFloat(stake_amount);
    const picks       = Array.isArray(player_picks) ? player_picks.map(Number) : [];

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['keno_enabled','keno_min_stake','keno_win_rate','keno_numbers_range','keno_draw_count','keno_min_picks','keno_max_picks','keno_payout_tables']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled      = parsePlatformSetting(map.keno_enabled, true);
    const minStake     = parseFloat(parsePlatformSetting(map.keno_min_stake, '50'));
    const winRate      = parseInt(parsePlatformSetting(map.keno_win_rate, '45'));
    const numbersRange = parseInt(parsePlatformSetting(map.keno_numbers_range, '40'));
    const drawCount    = parseInt(parsePlatformSetting(map.keno_draw_count, '20'));
    const minPicks     = parseInt(parsePlatformSetting(map.keno_min_picks, '5'));
    const maxPicks     = parseInt(parsePlatformSetting(map.keno_max_picks, '10'));
    const payoutTables = parsePlatformSetting(map.keno_payout_tables, DEFAULT_PAYOUT_TABLES);

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Keno is currently disabled' });
    if (!picks.length || picks.length < minPicks || picks.length > maxPicks)
      return res.status(400).json({ status: 'error', message: `Pick between ${minPicks} and ${maxPicks} numbers` });
    if (picks.some(n => n < 1 || n > numbersRange || !Number.isInteger(n)))
      return res.status(400).json({ status: 'error', message: `All picks must be integers between 1 and ${numbersRange}` });
    if (new Set(picks).size !== picks.length)
      return res.status(400).json({ status: 'error', message: 'Duplicate numbers are not allowed' });

    const { data: wallet } = await supabaseAdmin.from('wallets').select('games_balance, withdrawable_balance').eq('user_id', userId).single();
    if (!wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    const val = validateStake(stakeAmount, minStake, totalPlayableBalance);
    if (!val.valid)
      return res.status(400).json({ status: 'error', message: val.error });

    let newGamesBalance = gamesBalance;
    let newWithdrawableBalance = withdrawableBalance;

    if (gamesBalance >= stakeAmount) {
      newGamesBalance -= stakeAmount;
    } else {
      const remainder = stakeAmount - gamesBalance;
      newGamesBalance = 0;
      newWithdrawableBalance -= remainder;
    }

    const playerWins   = crypto.randomInt(0, 100) < winRate;
    const drawnNumbers = generateDrawnNumbers(picks, drawCount, numbersRange, playerWins, payoutTables);
    const { matched, matchCount, multiplier, isWin } = evaluateResult(picks, drawnNumbers, payoutTables);

    const payout = isWin ? parseFloat((stakeAmount * multiplier).toFixed(2)) : 0;
    const profit = parseFloat((payout - stakeAmount).toFixed(2));
    
    // Add full payout to withdrawable balance
    if (isWin) {
      newWithdrawableBalance += payout;
    }

    const newTotalBal = parseFloat((newGamesBalance + newWithdrawableBalance).toFixed(2));

    await supabaseAdmin.from('wallets')
      .update({ 
        games_balance: parseFloat(newGamesBalance.toFixed(2)), 
        withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)), 
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    const { data: round } = await supabaseAdmin.from('keno_rounds').insert({
      user_id: userId, stake_amount: stakeAmount, player_picks: picks,
      drawn_numbers: drawnNumbers, matched_numbers: matched,
      match_count: matchCount, multiplier, payout_amount: payout,
      profit_loss: profit, status: isWin ? 'won' : 'lost',
      ended_at: new Date().toISOString()
    }).select().single();

    const txBase = { user_id: userId, balance_type: 'games_balance', currency: 'NGN', status: 'completed' };
    await supabaseAdmin.from('transactions').insert([
      { ...txBase, transaction_type: 'gaming', earning_type: 'keno_stake', amount: -stakeAmount, reference: generateTransactionReference('STAKE'), description: `Keno stake - ₦${stakeAmount.toLocaleString()} (${picks.length} picks)`, metadata: { game: 'keno', round_id: round?.id, picks, stake_amount: stakeAmount } },
      ...(isWin
        ? [{ ...txBase, transaction_type: 'gaming', earning_type: 'keno_win', amount: payout, reference: generateTransactionReference('WIN'), description: `Keno win - ${matchCount}/${picks.length} matches at ${multiplier}×`, metadata: { game: 'keno', round_id: round?.id, match_count: matchCount, multiplier, payout } }]
        : [{ ...txBase, transaction_type: 'gaming', earning_type: 'keno_loss', amount: -stakeAmount, reference: generateTransactionReference('LOSS'), description: `Keno loss - ${matchCount}/${picks.length} matches`, metadata: { game: 'keno', round_id: round?.id, match_count: matchCount } }])
    ]);

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'keno',
      stake: stakeAmount,
      payout: payout,
      matches: matchCount
    }, req);

    return res.status(200).json({
      status:  isWin ? 'success' : 'error',
      message: isWin
        ? `${matchCount}/${picks.length} matches! Won ₦${payout.toLocaleString()} 🎰`
        : `${matchCount}/${picks.length} matches. Not enough this time!`,
      data: {
        result: isWin ? 'win' : 'loss',
        round: {
          id: round?.id, stake_amount: stakeAmount,
          player_picks: picks, drawn_numbers: drawnNumbers,
          matched_numbers: matched, match_count: matchCount,
          multiplier, payout_amount: payout, profit_loss: profit,
          status: isWin ? 'won' : 'lost', created_at: round?.created_at
        },
        new_gaming_wallet_balance: newTotalBal
      }
    });
  } catch (err) {
    console.error('keno playGame error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getHistory = async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    let query = supabaseAdmin.from('keno_rounds')
      .select('id,stake_amount,player_picks,match_count,multiplier,payout_amount,profit_loss,status,created_at', { count: 'exact' })
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data: rounds, count, error } = await query;
    if (error) throw error;
    return res.status(200).json({
      status: 'success', message: 'History retrieved successfully',
      data: { rounds, pagination: { current_page: page, total_pages: Math.ceil(count / limit), total_rounds: count, has_next: page * limit < count, has_prev: page > 1, limit } }
    });
  } catch (err) {
    console.error('keno getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin.from('keno_rounds')
      .select('stake_amount,payout_amount,status,match_count').eq('user_id', req.user.id);
    const total    = rounds?.length || 0;
    const wins     = rounds?.filter(r => r.status === 'won').length || 0;
    const wagered  = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount), 0) || 0;
    const won      = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount), 0) || 0;
    const avgMatch = total > 0 ? (rounds.reduce((s, r) => s + (r.match_count || 0), 0) / total).toFixed(1) : '0.0';
    return res.status(200).json({
      status: 'success', message: 'Statistics retrieved successfully',
      data: { stats: { total_rounds: total, total_wins: wins, total_losses: total - wins, total_wagered: wagered, total_won: won, net_profit_loss: parseFloat((won - wagered).toFixed(2)), win_rate: total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00', avg_matches_per_round: avgMatch } }
    });
  } catch (err) {
    console.error('keno getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all    } = await supabaseAdmin.from('keno_rounds').select('stake_amount,payout_amount,status,user_id,match_count,created_at');
    const { data: todayR } = await supabaseAdmin.from('keno_rounds').select('stake_amount,payout_amount,status').gte('created_at', today);
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
    console.error('keno getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { getSettings, playGame, getHistory, getStatistics, getAdminStatistics };
