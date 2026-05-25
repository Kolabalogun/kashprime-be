const { supabaseAdmin } = require('../services/supabase.service');
const {
  parsePlatformSetting,
  DEFAULT_MULTIPLIERS,
  generateDiceResult,
  getMultiplier,
  validateStakeAmount,
  generateTransactionReference,
  VALID_BET_TYPES,
} = require('../utils/helpers/diceRoll.helpers');
const { logActivity } = require('../utils/activityLogger');
const { getPlayableBalance, settleGameStake } = require('../utils/helpers/wallet.helpers');
  
const getSettings = async (req, res) => {
  try {
    const { data: rows } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', [
        'dice_roll_enabled', 'dice_roll_min_stake',
        'dice_roll_win_rate', 'dice_roll_multipliers'
      ]);

    const map = {};
    rows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    return res.status(200).json({
      status: 'success',
      message: 'Dice Roll settings retrieved successfully',
      data: {
        settings: {
          enabled:     parsePlatformSetting(map.dice_roll_enabled, true),
          minStake:    parseFloat(parsePlatformSetting(map.dice_roll_min_stake, '50')),
          winRate:     parseInt(parsePlatformSetting(map.dice_roll_win_rate, '48')),
          multipliers: parsePlatformSetting(map.dice_roll_multipliers, DEFAULT_MULTIPLIERS),
        },
      },
    });
  } catch (err) {
    console.error('getSettings error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const playGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount, bet_type, bet_value } = req.body;
    const stakeAmount = parseFloat(stake_amount);

    // Fetch settings
    const { data: rows } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', [
        'dice_roll_enabled', 'dice_roll_min_stake',
        'dice_roll_win_rate', 'dice_roll_multipliers'
      ]);

    const map = {};
    rows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled     = parsePlatformSetting(map.dice_roll_enabled, true);
    const minStake    = parseFloat(parsePlatformSetting(map.dice_roll_min_stake, '50'));
    const winRate     = parseInt(parsePlatformSetting(map.dice_roll_win_rate, '48'));
    const multipliers = parsePlatformSetting(map.dice_roll_multipliers, DEFAULT_MULTIPLIERS);

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Dice Roll is currently disabled' });

    if (!VALID_BET_TYPES.includes(bet_type))
      return res.status(400).json({ status: 'error', message: `Invalid bet type. Use: ${VALID_BET_TYPES.join(', ')}` });

    // Validate bet_value for exact/sum
    if (bet_type === 'exact') {
      const n = parseInt(bet_value);
      if (!n || n < 1 || n > 6)
        return res.status(400).json({ status: 'error', message: 'Exact bet requires a number 1–6' });
    }
    if (bet_type === 'sum') {
      const n = parseInt(bet_value);
      if (!n || n < 2 || n > 12)
        return res.status(400).json({ status: 'error', message: 'Sum bet requires a number 2–12' });
    }

    // Get wallet using Kashprime convention (games_balance, withdrawable_balance)
    const { data: wallet, error: wErr } = await supabaseAdmin
      .from('wallets')
      .select('bonus_balance, games_balance, withdrawable_balance')
      .eq('user_id', userId)
      .single();

    if (wErr || !wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const totalPlayableBalance = getPlayableBalance(wallet);

    const validation = validateStakeAmount(stakeAmount, minStake, totalPlayableBalance);
    if (!validation.valid)
      return res.status(400).json({ status: 'error', message: validation.error });

    // Generate result
    const betVal = parseInt(bet_value) || null;
    const { die1, die2, isWin } = generateDiceResult(bet_type, betVal, winRate);
    const multiplier = getMultiplier(bet_type, betVal, multipliers);
    const payout = isWin ? parseFloat((stakeAmount * multiplier).toFixed(2)) : 0;
    const profit = parseFloat((payout - stakeAmount).toFixed(2));
    
    const settlement = settleGameStake(wallet, stakeAmount, payout);
    if (!settlement.ok) {
      return res.status(400).json({ status: 'error', message: settlement.error });
    }

    // Update wallet
    const { error: updateErr } = await supabaseAdmin
      .from('wallets')
      .update({ 
        bonus_balance: settlement.balances.bonus_balance,
        games_balance: settlement.balances.games_balance, 
        withdrawable_balance: settlement.balances.withdrawable_balance,
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    if (updateErr)
      return res.status(500).json({ status: 'error', message: 'Failed to update wallet' });

    // Create round
    const { data: round } = await supabaseAdmin
      .from('dice_roll_rounds')
      .insert({
        user_id:      userId,
        stake_amount: stakeAmount,
        bet_type,
        bet_value:    betVal,
        die1,
        die2,
        multiplier,
        payout_amount: payout,
        profit_loss:   profit,
        status:       isWin ? 'won' : 'lost',
        ended_at:     new Date().toISOString(),
      })
      .select()
      .single();

    // Log transactions
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      transaction_type: 'gaming',
      balance_type: 'games_balance',
      amount: -stakeAmount,
      currency: 'NGN',
      status: 'completed',
      reference: generateTransactionReference('STAKE'),
      description: `Dice Roll stake - ₦${stakeAmount.toLocaleString()}`,
      metadata: { game: 'dice_roll', round_id: round?.id, bet_type, bet_value: betVal, stake_amount: stakeAmount },
    });
    if (isWin) {
      await supabaseAdmin.from('transactions').insert({
        user_id: userId,
        transaction_type: 'gaming',
        balance_type: 'games_balance',
        amount: payout,
        currency: 'NGN',
        status: 'completed',
        reference: generateTransactionReference('WIN'),
        description: `Dice Roll win - ${bet_type}${betVal?' '+betVal:''} at ${multiplier}×`,
        metadata: { game: 'dice_roll', round_id: round?.id, multiplier, payout },
      });
    }

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'dice_roll',
      stake_amount: stakeAmount,
      payout_amount: payout,
      multiplier: multiplier,
      bet_type: bet_type
    }, req);

    return res.status(200).json({
      status:  isWin ? 'success' : 'error',
      message: isWin ? `You won ₦${payout.toLocaleString()}! 🎲` : 'No luck this time. Try again!',
      data: {
        result: isWin ? 'win' : 'loss',
        round: {
          id: round?.id,
          stake_amount: stakeAmount,
          bet_type,
          bet_value: betVal,
          die1,
          die2,
          multiplier,
          payout_amount: payout,
          profit_loss:   profit,
          status: isWin ? 'won' : 'lost',
          created_at: round?.created_at,
        },
        new_games_balance: settlement.totalPlayableBalance,
        wallet: settlement.balances,
      },
    });
  } catch (err) {
    console.error('playGame error:', err);
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
      .from('dice_roll_rounds')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && ['won', 'lost'].includes(status)) query = query.eq('status', status);

    const { data: rounds, count, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      status: 'success',
      message: 'Game history retrieved successfully',
      data: {
        rounds,
        pagination: {
          current_page: page,
          total_pages:  Math.ceil(count / limit),
          total_rounds: count,
          has_next:     page * limit < count,
          has_prev:     page > 1,
          limit,
        },
      },
    });
  } catch (err) {
    console.error('getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin
      .from('dice_roll_rounds')
      .select('stake_amount, payout_amount, status, bet_type')
      .eq('user_id', req.user.id);

    const total     = rounds?.length || 0;
    const wins      = rounds?.filter(r => r.status === 'won').length || 0;
    const wagered   = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount), 0) || 0;
    const won       = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount), 0) || 0;

    return res.status(200).json({
      status: 'success',
      message: 'Statistics retrieved successfully',
      data: {
        stats: {
          total_rounds:    total,
          total_wins:      wins,
          total_losses:    total - wins,
          total_wagered:   wagered,
          total_won:       won,
          net_profit_loss: parseFloat((won - wagered).toFixed(2)),
          win_rate:        total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00',
        },
      },
    });
  } catch (err) {
    console.error('getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all   } = await supabaseAdmin.from('dice_roll_rounds').select('stake_amount, payout_amount, status, user_id, bet_type, created_at');
    const { data: todayR } = await supabaseAdmin.from('dice_roll_rounds').select('stake_amount, payout_amount, status').gte('created_at', today);

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

    return res.status(200).json({
      status: 'success',
      message: 'Admin statistics retrieved successfully',
      data: {
        overview: { ...overview, unique_players: uniquePlayers },
        today:    calc(todayR || []),
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
