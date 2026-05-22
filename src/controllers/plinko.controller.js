const { supabaseAdmin } = require('../services/supabase.service');
const { logActivity } = require('../utils/activityLogger');
const {
  DEFAULT_MULTIPLIERS, VALID_RISKS, VALID_ROWS,
  parsePlatformSetting, generatePlinkoResult,
  validateStakeAmount, generateTransactionReference,
} = require('../utils/helpers/plinko.helpers');

const getSettings = async (req, res) => {
  try {
    const { data: rows } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['plinko_enabled','plinko_min_stake','plinko_win_rate','plinko_rows_options','plinko_multipliers']);

    const map = {};
    rows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    return res.status(200).json({
      status: 'success',
      message: 'Plinko settings retrieved successfully',
      data: {
        settings: {
          enabled:     parsePlatformSetting(map.plinko_enabled, true),
          minStake:    parseFloat(parsePlatformSetting(map.plinko_min_stake, '50')),
          winRate:     parseInt(parsePlatformSetting(map.plinko_win_rate, '47')),
          rowsOptions: parsePlatformSetting(map.plinko_rows_options, [8, 12, 16]),
          multipliers: parsePlatformSetting(map.plinko_multipliers, DEFAULT_MULTIPLIERS),
        },
      },
    });
  } catch (err) {
    console.error('plinko getSettings error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const playGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount, risk_level, rows } = req.body;
    const stakeAmount = parseFloat(stake_amount);
    const rowCount    = parseInt(rows);

    const { data: settingsRows } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['plinko_enabled','plinko_min_stake','plinko_win_rate','plinko_multipliers']);

    const map = {};
    settingsRows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled     = parsePlatformSetting(map.plinko_enabled, true);
    const minStake    = parseFloat(parsePlatformSetting(map.plinko_min_stake, '50'));
    const winRate     = parseInt(parsePlatformSetting(map.plinko_win_rate, '47'));
    const multipliers = parsePlatformSetting(map.plinko_multipliers, DEFAULT_MULTIPLIERS);

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Plinko is currently disabled' });

    if (!VALID_RISKS.includes(risk_level))
      return res.status(400).json({ status: 'error', message: `Invalid risk level. Use: ${VALID_RISKS.join(', ')}` });

    if (!VALID_ROWS.includes(rowCount))
      return res.status(400).json({ status: 'error', message: `Invalid rows. Use: ${VALID_ROWS.join(', ')}` });

    // Get wallet
    const { data: wallet, error: wErr } = await supabaseAdmin
      .from('wallets').select('games_balance, withdrawable_balance').eq('user_id', userId).single();

    if (wErr || !wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    const validation = validateStakeAmount(stakeAmount, minStake, totalPlayableBalance);
    if (!validation.valid)
      return res.status(400).json({ status: 'error', message: validation.error });

    let newGamesBalance = gamesBalance;
    let newWithdrawableBalance = withdrawableBalance;

    if (gamesBalance >= stakeAmount) {
      newGamesBalance -= stakeAmount;
    } else {
      const remainder = stakeAmount - gamesBalance;
      newGamesBalance = 0;
      newWithdrawableBalance -= remainder;
    }

    // Generate result
    const { finalSlot, path, multiplier, isWin } = generatePlinkoResult(rowCount, risk_level, winRate, multipliers);
    const payout  = parseFloat((stakeAmount * multiplier).toFixed(2));
    const profit  = parseFloat((payout - stakeAmount).toFixed(2));
    
    if (isWin) {
      newWithdrawableBalance += payout;
    }

    const newTotalBal = parseFloat((newGamesBalance + newWithdrawableBalance).toFixed(2));

    // Update wallet
    const { error: updateErr } = await supabaseAdmin
      .from('wallets')
      .update({ 
        games_balance: parseFloat(newGamesBalance.toFixed(2)), 
        withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)),
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    if (updateErr)
      return res.status(500).json({ status: 'error', message: 'Failed to update wallet' });

    // Create round record
    const { data: round } = await supabaseAdmin
      .from('plinko_rounds')
      .insert({
        user_id:       userId,
        stake_amount:  stakeAmount,
        risk_level,
        rows:          rowCount,
        ball_path:     path,
        final_slot:    finalSlot,
        multiplier,
        payout_amount: payout,
        profit_loss:   profit,
        status:        isWin ? 'won' : 'lost',
        ended_at:      new Date().toISOString(),
      })
      .select().single();

    // Stake transaction
    await supabaseAdmin.from('transactions').insert({
      user_id:          userId,
      transaction_type: 'gaming',
      balance_type:     'games_balance',
      amount:           -stakeAmount,
      currency:         'NGN',
      status:           'completed',
      reference:        generateTransactionReference('STAKE'),
      description:      `Plinko stake - ₦${stakeAmount.toLocaleString()} (${risk_level}/${rowCount}R)`,
      metadata:         { game: 'plinko', round_id: round?.id, risk_level, rows: rowCount, stake_amount: stakeAmount },
    });

    // Win/loss transaction
    if (isWin && payout > 0) {
      await supabaseAdmin.from('transactions').insert({
        user_id: userId, transaction_type: 'gaming', balance_type: 'games_balance',
        amount: payout, currency: 'NGN', status: 'completed',
        reference: generateTransactionReference('WIN'),
        description: `Plinko win - ${multiplier}x at slot ${finalSlot}`,
        metadata: { game: 'plinko', round_id: round?.id, final_slot: finalSlot, multiplier, payout },
      });
    }

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'plinko',
      stake: stakeAmount,
      payout: payout,
      multiplier,
      risk_level,
      rows: rowCount
    }, req);

    return res.status(200).json({
      status:  isWin ? 'success' : 'error',
      message: isWin
        ? `Ball landed on ${multiplier}x! You won ₦${payout.toLocaleString()} 🎯`
        : `Ball landed on ${multiplier}x. No luck this time!`,
      data: {
        result: isWin ? 'win' : 'loss',
        round: {
          id:            round?.id,
          stake_amount:  stakeAmount,
          risk_level,
          rows:          rowCount,
          ball_path:     path,
          final_slot:    finalSlot,
          multiplier,
          payout_amount: payout,
          profit_loss:   profit,
          status:        isWin ? 'won' : 'lost',
          created_at:    round?.created_at,
        },
        new_games_balance: newTotalBal,
      },
    });
  } catch (err) {
    console.error('plinko playGame error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const status = req.query.status;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('plinko_rounds')
      .select('id,stake_amount,risk_level,rows,final_slot,multiplier,payout_amount,profit_loss,status,created_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && ['won', 'lost'].includes(status)) query = query.eq('status', status);

    const { data: rounds, count, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      status: 'success', message: 'Game history retrieved successfully',
      data: {
        rounds,
        pagination: {
          current_page: page, total_pages: Math.ceil(count / limit),
          total_rounds: count, has_next: page * limit < count, has_prev: page > 1, limit,
        },
      },
    });
  } catch (err) {
    console.error('plinko getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin
      .from('plinko_rounds')
      .select('stake_amount,payout_amount,status,risk_level,multiplier')
      .eq('user_id', req.user.id);

    const total   = rounds?.length || 0;
    const wins    = rounds?.filter(r => r.status === 'won').length || 0;
    const wagered = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount), 0) || 0;
    const won     = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount), 0) || 0;
    const bigWin  = rounds?.reduce((max, r) => Math.max(max, parseFloat(r.multiplier)), 0) || 0;

    return res.status(200).json({
      status: 'success', message: 'Statistics retrieved successfully',
      data: {
        stats: {
          total_rounds: total, total_wins: wins, total_losses: total - wins,
          total_wagered: wagered, total_won: won,
          net_profit_loss: parseFloat((won - wagered).toFixed(2)),
          win_rate: total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00',
          biggest_multiplier_hit: bigWin,
        },
      },
    });
  } catch (err) {
    console.error('plinko getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all    } = await supabaseAdmin.from('plinko_rounds').select('stake_amount,payout_amount,status,user_id,risk_level,created_at');
    const { data: todayR } = await supabaseAdmin.from('plinko_rounds').select('stake_amount,payout_amount,status,risk_level').gte('created_at', today);

    const calc = rows => ({
      total_rounds:   rows.length,
      total_wins:     rows.filter(r => r.status === 'won').length,
      total_losses:   rows.filter(r => r.status === 'lost').length,
      total_wagered:  rows.reduce((s, r) => s + parseFloat(r.stake_amount), 0),
      total_paid_out: rows.reduce((s, r) => s + parseFloat(r.payout_amount), 0),
      house_profit:   rows.reduce((s, r) => s + parseFloat(r.stake_amount) - parseFloat(r.payout_amount), 0),
    });

    const overview = calc(all || []);
    const uniquePlayers = new Set((all || []).map(r => r.user_id)).size;
    const byRisk = {
      low:  calc((all || []).filter(r => r.risk_level === 'low')),
      med:  calc((all || []).filter(r => r.risk_level === 'med')),
      high: calc((all || []).filter(r => r.risk_level === 'high')),
    };

    return res.status(200).json({
      status: 'success', message: 'Admin statistics retrieved successfully',
      data: {
        overview: { ...overview, unique_players: uniquePlayers },
        today:    calc(todayR || []),
        by_risk:  byRisk,
        house_edge_percentage: overview.total_wagered > 0
          ? ((overview.house_profit / overview.total_wagered) * 100).toFixed(2)
          : '0.00',
      },
    });
  } catch (err) {
    console.error('plinko getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { getSettings, playGame, getHistory, getStatistics, getAdminStatistics };
