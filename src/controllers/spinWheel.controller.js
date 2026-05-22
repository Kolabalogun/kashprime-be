const { supabaseAdmin } = require('../services/supabase.service');
const {
  parsePlatformSetting,
  DEFAULT_SEGMENTS,
  generateSpinResult,
  calculatePayout,
  validateStakeAmount,
  generateTransactionReference,
} = require('../utils/helpers/spinWheel.helpers');
const { logActivity } = require('../utils/activityLogger');

// ─── GET SETTINGS ────────────────────────────────────────────────────────────
const getSettings = async (req, res) => {
  try {
    const { data: settings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['spin_wheel_enabled', 'spin_wheel_min_stake', 'spin_wheel_win_rate', 'spin_wheel_segments']);

    const map = {};
    settings?.forEach(s => { map[s.setting_key] = s.setting_value; });

    return res.status(200).json({
      status: 'success',
      message: 'Spin Wheel settings retrieved successfully',
      data: {
        settings: {
          enabled:  parsePlatformSetting(map.spin_wheel_enabled,  true),
          minStake: parseFloat(parsePlatformSetting(map.spin_wheel_min_stake, '50')),
          winRate:  parseInt(parsePlatformSetting(map.spin_wheel_win_rate, '45')),
          segments: parsePlatformSetting(map.spin_wheel_segments, DEFAULT_SEGMENTS),
        },
      },
    });
  } catch (err) {
    console.error('getSettings error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ─── PLAY GAME ───────────────────────────────────────────────────────────────
const playGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount } = req.body;
    const stakeAmount = parseFloat(stake_amount);

    // Fetch settings
    const { data: settingsRows } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['spin_wheel_enabled', 'spin_wheel_min_stake', 'spin_wheel_win_rate', 'spin_wheel_segments']);

    const map = {};
    settingsRows?.forEach(s => { map[s.setting_key] = s.setting_value; });

    const enabled  = parsePlatformSetting(map.spin_wheel_enabled,  true);
    const minStake = parseFloat(parsePlatformSetting(map.spin_wheel_min_stake, '50'));
    const winRate  = parseInt(parsePlatformSetting(map.spin_wheel_win_rate, '45'));
    const segments = parsePlatformSetting(map.spin_wheel_segments, DEFAULT_SEGMENTS);

    if (!enabled) {
      return res.status(403).json({ status: 'error', message: 'Spin Wheel game is currently disabled' });
    }

    // Get wallet balance
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from('wallets')
      .select('games_balance, withdrawable_balance')
      .eq('user_id', userId)
      .single();

    if (walletErr || !wallet) {
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });
    }

    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    const validation = validateStakeAmount(stakeAmount, minStake, totalPlayableBalance);
    if (!validation.valid) {
      return res.status(400).json({ status: 'error', message: validation.error });
    }

    // Generate result
    const { segment, isWin } = generateSpinResult(winRate, segments);
    const { payout, profit } = calculatePayout(stakeAmount, segment.multiplier);

    let newGamesBalance = gamesBalance;
    let newWithdrawableBalance = withdrawableBalance;

    if (gamesBalance >= stakeAmount) {
      newGamesBalance -= stakeAmount;
    } else {
      const remainder = stakeAmount - gamesBalance;
      newGamesBalance = 0;
      newWithdrawableBalance -= remainder;
    }

    if (isWin) {
      newWithdrawableBalance += payout;
    }

    const newTotalBal = parseFloat((newGamesBalance + newWithdrawableBalance).toFixed(2));

    // Update wallet (games_balance instead of gaming_wallet for Kashprime convention)
    const { error: walletUpdateErr } = await supabaseAdmin
      .from('wallets')
      .update({ 
        games_balance: parseFloat(newGamesBalance.toFixed(2)),
        withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)),
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    if (walletUpdateErr) {
      return res.status(500).json({ status: 'error', message: 'Failed to update wallet' });
    }

    // Create round record
    const { data: round, error: roundErr } = await supabaseAdmin
      .from('spin_wheel_rounds')
      .insert({
        user_id:       userId,
        stake_amount:  stakeAmount,
        segment_index: segment.index,
        segment_label: segment.label,
        multiplier:    segment.multiplier,
        payout_amount: payout,
        profit_loss:   profit,
        status:        isWin ? 'won' : 'lost',
        ended_at:      new Date().toISOString(),
      })
      .select()
      .single();

    if (roundErr) {
      console.error('Round insert error:', roundErr);
    }

    // Log stake transaction
    await supabaseAdmin.from('transactions').insert({
      user_id:          userId,
      transaction_type: 'gaming',
      balance_type:     'games_balance',
      amount:           -stakeAmount,
      currency:         'NGN',
      status:           'completed',
      reference:        generateTransactionReference('STAKE'),
      description:      `Spin Wheel stake - ₦${stakeAmount.toLocaleString()}`,
      metadata:         { game: 'spin_wheel', round_id: round?.id, stake_amount: stakeAmount },
    });

    if (isWin && payout > 0) {
      await supabaseAdmin.from('transactions').insert({
        user_id:          userId,
        transaction_type: 'gaming',
        balance_type:     'games_balance',
        amount:           payout,
        currency:         'NGN',
        status:           'completed',
        reference:        generateTransactionReference('WIN'),
        description:      `Spin Wheel win - ${segment.label} (${segment.multiplier}x)`,
        metadata:         { game: 'spin_wheel', round_id: round?.id, multiplier: segment.multiplier, payout },
      });
    }

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'spin_wheel',
      stake_amount: stakeAmount,
      payout_amount: payout,
      multiplier: segment.multiplier,
      segment_label: segment.label
    }, req);

    return res.status(200).json({
      status:  isWin ? 'success' : 'error',
      message: isWin ? `You won ${segment.label}! 🎉` : 'No luck this time. Try again!',
      data: {
        result: isWin ? 'win' : 'loss',
        round: {
          id:             round?.id,
          stake_amount:   stakeAmount,
          segment_index:  segment.index,
          segment_label:  segment.label,
          multiplier:     segment.multiplier,
          payout_amount:  payout,
          profit_loss:    profit,
          status:         isWin ? 'won' : 'lost',
          created_at:     round?.created_at,
        },
        new_games_balance: newTotalBal,
      },
    });
  } catch (err) {
    console.error('playGame error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ─── GET HISTORY ─────────────────────────────────────────────────────────────
const getHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const page   = parseInt(req.query.page)   || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const status = req.query.status;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('spin_wheel_rounds')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && ['won', 'lost'].includes(status)) {
      query = query.eq('status', status);
    }

    const { data: rounds, count, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      status:  'success',
      message: 'Game history retrieved successfully',
      data: {
        rounds,
        pagination: {
          current_page:  page,
          total_pages:   Math.ceil(count / limit),
          total_rounds:  count,
          has_next:      page * limit < count,
          has_prev:      page > 1,
          limit,
        },
      },
    });
  } catch (err) {
    console.error('getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ─── USER STATISTICS ─────────────────────────────────────────────────────────
const getStatistics = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: rounds, error } = await supabaseAdmin
      .from('spin_wheel_rounds')
      .select('stake_amount, payout_amount, status')
      .eq('user_id', userId);

    if (error) throw error;

    const totalRounds  = rounds.length;
    const totalWins    = rounds.filter(r => r.status === 'won').length;
    const totalLosses  = rounds.filter(r => r.status === 'lost').length;
    const totalWagered = rounds.reduce((s, r) => s + parseFloat(r.stake_amount), 0);
    const totalWon     = rounds.reduce((s, r) => s + parseFloat(r.payout_amount), 0);
    const winRate      = totalRounds > 0 ? ((totalWins / totalRounds) * 100).toFixed(2) : '0.00';

    return res.status(200).json({
      status:  'success',
      message: 'Statistics retrieved successfully',
      data: {
        stats: {
          total_rounds:    totalRounds,
          total_wins:      totalWins,
          total_losses:    totalLosses,
          total_wagered:   totalWagered,
          total_won:       totalWon,
          net_profit_loss: totalWon - totalWagered,
          win_rate:        winRate,
        },
      },
    });
  } catch (err) {
    console.error('getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ─── ADMIN STATISTICS ────────────────────────────────────────────────────────
const getAdminStatistics = async (req, res) => {
  try {
    const { data: all,   error: e1 } = await supabaseAdmin.from('spin_wheel_rounds').select('stake_amount, payout_amount, status, user_id, created_at');
    const { data: today, error: e2 } = await supabaseAdmin.from('spin_wheel_rounds').select('stake_amount, payout_amount, status').gte('created_at', new Date().toISOString().split('T')[0]);

    if (e1 || e2) throw e1 || e2;

    const calc = (rows) => ({
      total_rounds:   rows.length,
      total_wins:     rows.filter(r => r.status === 'won').length,
      total_losses:   rows.filter(r => r.status === 'lost').length,
      total_wagered:  rows.reduce((s, r) => s + parseFloat(r.stake_amount), 0),
      total_paid_out: rows.reduce((s, r) => s + parseFloat(r.payout_amount), 0),
      house_profit:   rows.reduce((s, r) => s + parseFloat(r.stake_amount) - parseFloat(r.payout_amount), 0),
    });

    const overview = calc(all);
    const uniquePlayers = new Set((all||[]).map(r => r.user_id)).size;

    return res.status(200).json({
      status:  'success',
      message: 'Admin statistics retrieved successfully',
      data: {
        overview: { ...overview, unique_players: uniquePlayers },
        today:    calc(today||[]),
        house_edge_percentage: overview.total_wagered > 0
          ? ((overview.house_profit / overview.total_wagered) * 100).toFixed(2)
          : '0.00',
      },
    });
  } catch (err) {
    console.error('getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { getSettings, playGame, getHistory, getStatistics, getAdminStatistics };
