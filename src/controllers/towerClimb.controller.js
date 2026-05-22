const { supabaseAdmin } = require('../services/supabase.service');
const { logActivity } = require('../utils/activityLogger');
const {
  parsePlatformSetting, buildTowerData,
  calculateMultiplier, generateTransactionReference, validateStake
} = require('../utils/helpers/towerClimb.helpers');

// ── START GAME ───────────────────────────────────────────────
const startGame = async (req, res) => {
  try {
    const userId = req.user.id;
    const { stake_amount } = req.body;
    const stakeAmount = parseFloat(stake_amount);

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['tower_climb_enabled','tower_climb_min_stake','tower_climb_win_rate','tower_climb_floors','tower_climb_tiles_per_floor','tower_climb_multiplier_step','tower_climb_base_multiplier','tower_climb_multipliers']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });

    const enabled       = parsePlatformSetting(map.tower_climb_enabled, true);
    const minStake      = parseFloat(parsePlatformSetting(map.tower_climb_min_stake, '50'));
    const winRate       = parseInt(parsePlatformSetting(map.tower_climb_win_rate, '60'));
    const floors        = parseInt(parsePlatformSetting(map.tower_climb_floors, '10'));
    const tilesPerFloor = parseInt(parsePlatformSetting(map.tower_climb_tiles_per_floor, '3'));
    const step          = parseFloat(parsePlatformSetting(map.tower_climb_multiplier_step, '1.4'));
    const base          = parseFloat(parsePlatformSetting(map.tower_climb_base_multiplier, '1.0'));

    // Use custom per-floor multipliers if configured, otherwise use formula
    const customMultipliers = parsePlatformSetting(map.tower_climb_multipliers, null);
    const getMultiplierForFloor = (floorNum) => {
      if (Array.isArray(customMultipliers) && customMultipliers[floorNum - 1] !== undefined) {
        return parseFloat(Number(customMultipliers[floorNum - 1]).toFixed(2));
      }
      return calculateMultiplier(floorNum, step, base);
    };

    if (!enabled)
      return res.status(403).json({ status: 'error', message: 'Tower Climb is currently disabled' });

    const { data: wallet } = await supabaseAdmin.from('wallets').select('games_balance, withdrawable_balance').eq('user_id', userId).single();
    if (!wallet)
      return res.status(400).json({ status: 'error', message: 'Could not retrieve wallet' });

    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    const val = validateStake(stakeAmount, minStake, totalPlayableBalance);
    if (!val.valid)
      return res.status(400).json({ status: 'error', message: val.error });

    const floorData = buildTowerData(floors, tilesPerFloor, winRate);

    let newGamesBalance = gamesBalance;
    let newWithdrawableBalance = withdrawableBalance;

    if (gamesBalance >= stakeAmount) {
      newGamesBalance -= stakeAmount;
    } else {
      const remainder = stakeAmount - gamesBalance;
      newGamesBalance = 0;
      newWithdrawableBalance -= remainder;
    }

    const newTotalBal = parseFloat((newGamesBalance + newWithdrawableBalance).toFixed(2));

    await supabaseAdmin.from('wallets')
      .update({ 
        games_balance: parseFloat(newGamesBalance.toFixed(2)), 
        withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)),
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    const { data: round, error: insertErr } = await supabaseAdmin.from('tower_climb_rounds').insert({
      user_id: userId, stake_amount: stakeAmount, floors, tiles_per_floor: tilesPerFloor,
      floor_data: floorData, current_floor: 0, current_multiplier: base, status: 'active'
    }).select().single();

    if (insertErr || !round) {
      console.error('towerClimb startGame insert error:', insertErr);
      // Refund stake if insert failed
      await supabaseAdmin.from('wallets')
        .update({ games_balance: gamesBalance, withdrawable_balance: withdrawableBalance, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      return res.status(500).json({
        status: 'error',
        message: insertErr?.message || 'Failed to create game round. Please try again.'
      });
    }

    await supabaseAdmin.from('transactions').insert({
      user_id: userId, transaction_type: 'gaming', balance_type: 'games_balance', earning_type: 'tower_climb_stake',
      amount: -stakeAmount, currency: 'NGN', status: 'completed',
      reference: generateTransactionReference('STAKE'),
      description: `Tower Climb stake - ₦${stakeAmount.toLocaleString()}`,
      metadata: { game: 'tower_climb', round_id: round.id, stake_amount: stakeAmount, floors }
    });

    await logActivity(userId, 'game_start', { game: 'tower_climb', round_id: round.id, stake_amount: stakeAmount }, req);

    // Return tower WITHOUT revealing trap positions to frontend
    const safeFloorData = floorData.map(f => ({
      floor:          f.floor,
      tile_count:     tilesPerFloor,
      revealed_index: null
    }));

    // Build multiplier preview for each floor using custom table or formula
    const multiplierPreview = Array.from({ length: floors }, (_, i) =>
      getMultiplierForFloor(i + 1)
    );

    return res.status(201).json({
      status:  'success',
      message: 'Tower Climb started! Begin climbing.',
      data: {
        round_id:          round.id,
        stake_amount:      stakeAmount,
        floors,
        tiles_per_floor:   tilesPerFloor,
        current_floor:     0,
        current_multiplier: base,
        floor_data:        safeFloorData,
        multiplier_preview: multiplierPreview,
        status:            round.status,
        new_gaming_wallet_balance: newTotalBal
      }
    });
  } catch (err) {
    console.error('towerClimb startGame error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ── REVEAL TILE ──────────────────────────────────────────────
const revealTile = async (req, res) => {
  try {
    const userId   = req.user.id;
    const { round_id, tile_index } = req.body;
    const tileIdx  = parseInt(tile_index);

    const { data: round, error: rErr } = await supabaseAdmin.from('tower_climb_rounds')
      .select('*').eq('id', round_id).eq('user_id', userId).single();
    if (rErr || !round)
      return res.status(404).json({ status: 'error', message: 'Round not found' });
    if (round.status !== 'active')
      return res.status(400).json({ status: 'error', message: `Game already ended: ${round.status}` });
    if (tileIdx < 0 || tileIdx >= round.tiles_per_floor)
      return res.status(400).json({ status: 'error', message: `Invalid tile index. Choose 0–${round.tiles_per_floor - 1}` });

    const { data: sRows } = await supabaseAdmin.from('platform_settings').select('setting_key, setting_value')
      .in('setting_key', ['tower_climb_multiplier_step','tower_climb_base_multiplier','tower_climb_multipliers']);
    const map = {};
    sRows?.forEach(r => { map[r.setting_key] = r.setting_value; });
    const step = parseFloat(parsePlatformSetting(map.tower_climb_multiplier_step, '1.4'));
    const base = parseFloat(parsePlatformSetting(map.tower_climb_base_multiplier, '1.0'));
    const customMultipliers = parsePlatformSetting(map.tower_climb_multipliers, null);
    const getMultiplierForFloor = (floorNum) => {
      if (Array.isArray(customMultipliers) && customMultipliers[floorNum - 1] !== undefined) {
        return parseFloat(Number(customMultipliers[floorNum - 1]).toFixed(2));
      }
      return calculateMultiplier(floorNum, step, base);
    };

    const currentFloorIndex = round.current_floor;
    const floorData         = round.floor_data;
    const currentFloor      = floorData[currentFloorIndex];
    const tileResult        = currentFloor.tiles[tileIdx];
    const isSafe            = tileResult === 'safe';

    floorData[currentFloorIndex].revealed_index = tileIdx;

    const { data: wallet } = await supabaseAdmin.from('wallets').select('games_balance, withdrawable_balance').eq('user_id', userId).single();
    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    if (isSafe) {
      const nextFloor = currentFloorIndex + 1;
      const newMulti  = getMultiplierForFloor(nextFloor);
      const isTop     = nextFloor >= round.floors;

      if (isTop) {
        // Auto-cashout at top floor
        const payout = parseFloat((round.stake_amount * newMulti).toFixed(2));
        const profit = parseFloat((payout - round.stake_amount).toFixed(2));
        const newWithdrawableBalance = withdrawableBalance + payout;
        const newTotalBal = gamesBalance + newWithdrawableBalance;

        await supabaseAdmin.from('wallets')
          .update({ 
            games_balance: parseFloat(gamesBalance.toFixed(2)),
            withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)),
            updated_at: new Date().toISOString() 
          })
          .eq('user_id', userId);
        await supabaseAdmin.from('tower_climb_rounds').update({
          floor_data: floorData, current_floor: nextFloor, current_multiplier: newMulti,
          cashout_multiplier: newMulti, payout_amount: payout, profit_loss: profit,
          status: 'cashed_out', ended_at: new Date().toISOString()
        }).eq('id', round_id);
        await supabaseAdmin.from('transactions').insert({
          user_id: userId, transaction_type: 'gaming', balance_type: 'games_balance', earning_type: 'tower_climb_win',
          amount: payout, currency: 'NGN', status: 'completed',
          reference: generateTransactionReference('WIN'),
          description: `Tower Climb win - reached top at ${newMulti}×`,
          metadata: { game: 'tower_climb', round_id, multiplier: newMulti, payout }
        });

        await logActivity(userId, 'game_win', { game: 'tower_climb', round_id, payout_amount: payout, multiplier: newMulti, reached_floor: nextFloor }, req);

        return res.status(200).json({
          status: 'success',
          message: `You reached the TOP! ${newMulti}× 🏆 Won ₦${payout.toLocaleString()}`,
          data: { result: 'top', tile_result: 'safe', floor_reached: nextFloor, multiplier: newMulti, payout_amount: payout, profit_loss: profit, status: 'cashed_out', floor_data: floorData, new_gaming_wallet_balance: newTotalBal }
        });
      }

      await supabaseAdmin.from('tower_climb_rounds').update({
        floor_data: floorData, current_floor: nextFloor, current_multiplier: newMulti
      }).eq('id', round_id);

      // Return next floor data without exposing trap positions
      const safeData = floorData.map((f, i) =>
        i < nextFloor
          ? { floor: f.floor, tile_count: round.tiles_per_floor, revealed_index: f.revealed_index, tile_result: f.tiles[f.revealed_index] }
          : { floor: f.floor, tile_count: round.tiles_per_floor, revealed_index: null }
      );

      return res.status(200).json({
        status:  'success',
        message: `Floor ${currentFloorIndex + 1} cleared! Multiplier: ${newMulti}×`,
        data: { result: 'safe', tile_result: 'safe', current_floor: nextFloor, current_multiplier: newMulti, floor_data: safeData, can_cashout: true }
      });
    } else {
      // Hit trap
      const profit = parseFloat((-round.stake_amount).toFixed(2));
      await supabaseAdmin.from('tower_climb_rounds').update({
        floor_data: floorData, payout_amount: 0, profit_loss: profit,
        status: 'fell', ended_at: new Date().toISOString()
      }).eq('id', round_id);
      await supabaseAdmin.from('transactions').insert({
        user_id: userId, transaction_type: 'gaming', balance_type: 'games_balance', earning_type: 'tower_climb_loss',
        amount: -round.stake_amount, currency: 'NGN', status: 'completed',
        reference: generateTransactionReference('LOSS'),
        description: `Tower Climb loss - fell on floor ${currentFloorIndex + 1}`,
        metadata: { game: 'tower_climb', round_id, floor_fell: currentFloorIndex + 1 }
      });
      return res.status(200).json({
        status:  'error',
        message: `TRAP! You fell from floor ${currentFloorIndex + 1}. 💥`,
        data: { result: 'trap', tile_result: 'trap', floor_fell: currentFloorIndex + 1, trap_index: currentFloor.trap_index, payout_amount: 0, profit_loss: profit, status: 'fell', floor_data: floorData, new_gaming_wallet_balance: totalPlayableBalance }
      });
    }
  } catch (err) {
    console.error('towerClimb revealTile error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

// ── CASHOUT ──────────────────────────────────────────────────
const cashOut = async (req, res) => {
  try {
    const userId = req.user.id;
    const { round_id } = req.body;

    const { data: round } = await supabaseAdmin.from('tower_climb_rounds')
      .select('*').eq('id', round_id).eq('user_id', userId).single();
    if (!round)
      return res.status(404).json({ status: 'error', message: 'Round not found' });
    if (round.status !== 'active')
      return res.status(400).json({ status: 'error', message: 'Game already ended' });
    if (round.current_floor < 3)
      return res.status(400).json({ status: 'error', message: 'You must reach at least floor 3 to cash out.' });

    const { data: wallet } = await supabaseAdmin.from('wallets').select('games_balance, withdrawable_balance').eq('user_id', userId).single();
    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const payout  = parseFloat((round.stake_amount * round.current_multiplier).toFixed(2));
    const profit  = parseFloat((payout - round.stake_amount).toFixed(2));
    
    const newWithdrawableBalance = withdrawableBalance + payout;
    const newTotalBal = gamesBalance + newWithdrawableBalance;

    await supabaseAdmin.from('wallets')
      .update({ 
        games_balance: parseFloat(gamesBalance.toFixed(2)),
        withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)),
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);
    await supabaseAdmin.from('tower_climb_rounds').update({
      cashout_multiplier: round.current_multiplier, payout_amount: payout,
      profit_loss: profit, status: 'cashed_out', ended_at: new Date().toISOString()
    }).eq('id', round_id);
    await supabaseAdmin.from('transactions').insert({
      user_id: userId, transaction_type: 'gaming', balance_type: 'games_balance', earning_type: 'tower_climb_win',
      amount: payout, currency: 'NGN', status: 'completed',
      reference: generateTransactionReference('WIN'),
      description: `Tower Climb cashout - ${round.current_multiplier}× at floor ${round.current_floor}`,
      metadata: { game: 'tower_climb', round_id, multiplier: round.current_multiplier, floor: round.current_floor, payout }
    });

    return res.status(200).json({
      status:  'success',
      message: `Cashed out at ${round.current_multiplier}×! Won ₦${payout.toLocaleString()} 🎯`,
      data: { result: 'cashout', cashout_multiplier: round.current_multiplier, floor_reached: round.current_floor, payout_amount: payout, profit_loss: profit, status: 'cashed_out', floor_data: round.floor_data, new_gaming_wallet_balance: newTotalBal }
    });
  } catch (err) {
    console.error('towerClimb cashOut error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getHistory = async (req, res) => {
  try {
    const page   = parseInt(req.query.page) || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    let query = supabaseAdmin.from('tower_climb_rounds')
      .select('id,stake_amount,floors,current_floor,cashout_multiplier,payout_amount,profit_loss,status,created_at', { count: 'exact' })
      .eq('user_id', req.user.id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data: rounds, count, error } = await query;
    if (error) throw error;
    return res.status(200).json({
      status: 'success', message: 'History retrieved successfully',
      data: { rounds, pagination: { current_page: page, total_pages: Math.ceil(count / limit), total_rounds: count, has_next: page * limit < count, has_prev: page > 1, limit } }
    });
  } catch (err) {
    console.error('towerClimb getHistory error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getStatistics = async (req, res) => {
  try {
    const { data: rounds } = await supabaseAdmin.from('tower_climb_rounds')
      .select('stake_amount,payout_amount,status,current_floor,cashout_multiplier')
      .eq('user_id', req.user.id).neq('status', 'active');
    const total     = rounds?.length || 0;
    const wins      = rounds?.filter(r => r.status === 'cashed_out').length || 0;
    const wagered   = rounds?.reduce((s, r) => s + parseFloat(r.stake_amount), 0) || 0;
    const won       = rounds?.reduce((s, r) => s + parseFloat(r.payout_amount), 0) || 0;
    const avgFloor  = total > 0 ? (rounds.reduce((s, r) => s + (r.current_floor || 0), 0) / total).toFixed(1) : '0.0';
    const bestMulti = rounds?.reduce((max, r) => Math.max(max, parseFloat(r.cashout_multiplier || 0)), 0) || 0;
    return res.status(200).json({
      status: 'success', message: 'Statistics retrieved successfully',
      data: { stats: { total_rounds: total, total_wins: wins, total_losses: total - wins, total_wagered: wagered, total_won: won, net_profit_loss: parseFloat((won - wagered).toFixed(2)), win_rate: total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00', avg_floor_reached: avgFloor, best_multiplier_hit: bestMulti } }
    });
  } catch (err) {
    console.error('towerClimb getStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

const getAdminStatistics = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: all    } = await supabaseAdmin.from('tower_climb_rounds').select('stake_amount,payout_amount,status,user_id,current_floor,created_at').neq('status','active');
    const { data: todayR } = await supabaseAdmin.from('tower_climb_rounds').select('stake_amount,payout_amount,status').gte('created_at', today).neq('status','active');
    const calc = rows => ({
      total_rounds:   rows.length,
      total_wins:     rows.filter(r => r.status === 'cashed_out').length,
      total_losses:   rows.filter(r => r.status === 'fell').length,
      total_wagered:  rows.reduce((s, r) => s + parseFloat(r.stake_amount), 0),
      total_paid_out: rows.reduce((s, r) => s + parseFloat(r.payout_amount), 0),
      house_profit:   rows.reduce((s, r) => s + parseFloat(r.stake_amount) - parseFloat(r.payout_amount), 0),
      avg_floor:      rows.length > 0 ? (rows.reduce((s, r) => s + (r.current_floor || 0), 0) / rows.length).toFixed(1) : '0.0',
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
    console.error('towerClimb getAdminStatistics error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
};

module.exports = { startGame, revealTile, cashOut, getHistory, getStatistics, getAdminStatistics };
