const { supabaseAdmin } = require('../services/supabase.service');
const { logActivity } = require('../utils/activityLogger');
const crypto = require('crypto');
const {
  parsePlatformSetting, getBothMultipliers,
  generateShownNumber, generateResultNumber, generateTransactionReference, validateStake
} = require('../utils/helpers/higherLower.helpers');

// ── STEP 1: Generate shown number, create waiting round ──────
const startRound = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['higher_lower_enabled','higher_lower_win_rate','higher_lower_house_edge','higher_lower_round_ttl']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled   = parsePlatformSetting(map.higher_lower_enabled, true);
    const winRate   = parseInt(parsePlatformSetting(map.higher_lower_win_rate, '47'));
    const houseEdge = parseFloat(parsePlatformSetting(map.higher_lower_house_edge, '0.05'));
    const ttl       = parseInt(parsePlatformSetting(map.higher_lower_round_ttl, '60'));

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Higher or Lower is currently disabled' });

    // Expire stale waiting rounds for this user
    await supabaseAdmin.from('higher_lower_rounds')
      .update({ status: 'lost' })
      .eq('user_id', userId).eq('status', 'waiting')
      .lt('expires_at', new Date().toISOString());

    const shownNumber = generateShownNumber();
    const multipliers = getBothMultipliers(shownNumber, houseEdge);
    const expiresAt   = new Date(Date.now() + ttl * 1000).toISOString();

    const { data: round, error: insertErr } = await supabaseAdmin.from('higher_lower_rounds').insert({
      user_id: userId, shown_number: shownNumber,
      status: 'waiting', win_rate_snapshot: winRate, expires_at: expiresAt
    }).select().single();

    if (insertErr || !round) {
      console.error('higherLower startRound insert error:', insertErr);
      return res.status(500).json({
        status: 'error',
        message: insertErr?.message || 'Failed to create game round. Please try again.'
      });
    }

    return res.status(201).json({
      status: 'success',
      message: 'Round started. Place your bet!',
      data: {
        round_id:           round.id,
        shown_number:       shownNumber,
        multipliers,          // { higher: X, lower: Y }
        expires_in_seconds: ttl
      }
    });
  } catch (err) {
    console.error('higherLower startRound error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ── STEP 2: Place bet, draw result, resolve ──────────────────
const placeBet = async (req, res) => {
  try {
    const userId = req.user.id;
    const { round_id, stake_amount, direction } = req.body;
    const stakeAmount = parseFloat(stake_amount);

    if (!['higher','lower'].includes(direction))
      return res.status(400).json({ status: 'error', message: 'Direction must be higher or lower' });

    const { data: round, error: rErr } = await supabaseAdmin.from('higher_lower_rounds')
      .select('*').eq('id', round_id).eq('user_id', userId).single();

    if (rErr || !round)
      return res.status(404).json({ status: 'error', message: 'Round not found' });
    if (round.status !== 'waiting')
      return res.status(400).json({ status: 'error', message: 'Round already played or expired' });
    if (new Date() > new Date(round.expires_at))
      return res.status(400).json({ status: 'error', message: 'Round has expired. Start a new round.' });

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['higher_lower_min_stake','higher_lower_house_edge']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });
    const minStake  = parseFloat(parsePlatformSetting(map.higher_lower_min_stake, '50'));
    const houseEdge = parseFloat(parsePlatformSetting(map.higher_lower_house_edge, '0.05'));

    const { data: wallet } = await supabaseAdmin.from('wallets').select('games_balance, withdrawable_balance').eq('user_id', userId).single();
    if (!wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    const val = validateStake(stakeAmount, minStake, totalPlayableBalance);
    if (!val.valid)
      return res.status(400).json({ status: 'error', message: val.error });

    // Use win_rate_snapshot from when the round was created
    const playerWins   = crypto.randomInt(0, 100) < round.win_rate_snapshot;
    const resultNumber = generateResultNumber(round.shown_number, direction, playerWins);
    const isWin        = direction === 'higher' ? resultNumber > round.shown_number : resultNumber < round.shown_number;

    let newGamesBalance = gamesBalance;
    let newWithdrawableBalance = withdrawableBalance;

    if (gamesBalance >= stakeAmount) {
      newGamesBalance -= stakeAmount;
    } else {
      const remainder = stakeAmount - gamesBalance;
      newGamesBalance = 0;
      newWithdrawableBalance -= remainder;
    }

    const { getBothMultipliers: getMultis } = require('../utils/helpers/higherLower.helpers');
    const multiplier = getMultis(round.shown_number, houseEdge)[direction];
    const payout  = isWin ? parseFloat((stakeAmount * multiplier).toFixed(2)) : 0;
    const profit  = parseFloat((payout - stakeAmount).toFixed(2));
    
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

    await supabaseAdmin.from('higher_lower_rounds').update({
      direction, stake_amount: stakeAmount, result_number: resultNumber,
      multiplier, payout_amount: payout, profit_loss: profit,
      status: isWin ? 'won' : 'lost', ended_at: new Date().toISOString()
    }).eq('id', round_id);

    const txBase = { user_id: userId, balance_type: 'games_balance', currency: 'NGN', status: 'completed' };
    await supabaseAdmin.from('transactions').insert([
      { ...txBase, transaction_type: 'gaming', earning_type: 'higher_lower_stake', amount: -stakeAmount, reference: generateTransactionReference('STAKE'), description: `H/L stake - ₦${stakeAmount.toLocaleString()}`, metadata: { game: 'higher_lower', round_id, shown: round.shown_number, direction, stake_amount: stakeAmount } },
      ...(isWin
        ? [{ ...txBase, transaction_type: 'gaming', earning_type: 'higher_lower_win', amount: payout, reference: generateTransactionReference('WIN'), description: `H/L win - result ${resultNumber} was ${direction} than ${round.shown_number}`, metadata: { game: 'higher_lower', round_id, result_number: resultNumber, multiplier, payout } }]
        : [{ ...txBase, transaction_type: 'gaming', earning_type: 'higher_lower_loss', amount: -stakeAmount, reference: generateTransactionReference('LOSS'), description: `H/L loss - result ${resultNumber}`, metadata: { game: 'higher_lower', round_id, result_number: resultNumber } }])
    ]);

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'higher_lower',
      stake_amount: stakeAmount,
      payout_amount: payout,
      multiplier: multiplier,
      direction: direction,
      shown_number: round.shown_number,
      result_number: resultNumber
    }, req);

    return res.status(200).json({
      status:  isWin ? 'success' : 'error',
      message: isWin
        ? `Result: ${resultNumber}! ${direction === 'higher' ? 'Higher' : 'Lower'} ✓ Won ₦${payout.toLocaleString()}`
        : `Result: ${resultNumber}. Not ${direction}. Better luck next time!`,
      data: {
        result:         isWin ? 'win' : 'loss',
        shown_number:   round.shown_number,
        result_number:  resultNumber,
        direction,
        multiplier,
        stake_amount:   stakeAmount,
        payout_amount:  payout,
        profit_loss:    profit,
        status:         isWin ? 'won' : 'lost',
        new_gaming_wallet_balance: newTotalBal
      }
    });
  } catch (err) {
    console.error('higherLower placeBet error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getHistory = async (req, res) => {
  try {
    const page   = parseInt(req.query.page) || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    let query = supabaseAdmin.from('higher_lower_rounds')
      .select('id,shown_number,result_number,direction,stake_amount,multiplier,payout_amount,profit_loss,status,created_at', { count: 'exact' })
      .eq('user_id', req.user.id).neq('status', 'waiting')
      .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data: rounds, count, error } = await query;
    if (error) throw error;
    return res.status(200).json({
      status: 'success', message: 'History retrieved successfully',
      data: { rounds, pagination: { current_page: page, total_pages: Math.ceil(count / limit), total_rounds: count, has_next: page * limit < count, has_prev: page > 1, limit } }
    });
  } catch (err) {
    console.error('higherLower getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin.from('higher_lower_rounds')
      .select('stake_amount,payout_amount,status,direction').eq('user_id', req.user.id).neq('status', 'waiting');
    const total   = rounds?.length || 0;
    const wins    = rounds?.filter(r => r.status === 'won').length || 0;
    const wagered = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount || 0), 0) || 0;
    const won     = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount || 0), 0) || 0;
    return res.status(200).json({
      status: 'success', message: 'Statistics retrieved successfully',
      data: { stats: { total_rounds: total, total_wins: wins, total_losses: total - wins, total_wagered: wagered, total_won: won, net_profit_loss: parseFloat((won - wagered).toFixed(2)), win_rate: total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00' } }
    });
  } catch (err) {
    console.error('higherLower getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all    } = await supabaseAdmin.from('higher_lower_rounds').select('stake_amount,payout_amount,status,user_id,created_at').neq('status','waiting');
    const { data: todayR } = await supabaseAdmin.from('higher_lower_rounds').select('stake_amount,payout_amount,status').gte('created_at', today).neq('status','waiting');
    const calc = rows => ({
      total_rounds:   rows.length,
      total_wins:     rows.filter(r => r.status === 'won').length,
      total_losses:   rows.filter(r => r.status === 'lost').length,
      total_wagered:  rows.reduce((s, r) => s + parseFloat(r.stake_amount || 0), 0),
      total_paid_out: rows.reduce((s, r) => s + parseFloat(r.payout_amount || 0), 0),
      house_profit:   rows.reduce((s, r) => s + parseFloat(r.stake_amount || 0) - parseFloat(r.payout_amount || 0), 0),
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
    console.error('higherLower getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { startRound, placeBet, getHistory, getStatistics, getAdminStatistics };
