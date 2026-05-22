// src/controllers/coinflip.controller.js

const { validationResult } = require('express-validator');
const { supabaseAdmin } = require('../services/supabase.service');
const {
  generateCoinFlip,
  calculatePayout,
  validateStakeAmount,
  isValidChoice,
  generateTransactionReference,
  formatCurrency,
  calculateWinRate,
  parsePlatformSetting
} = require('../utils/helpers/coinflip.helpers');
const { logActivity } = require('../utils/activityLogger');

/**
 * Get coinflip game settings
 * GET /api/coinflip/settings
 */
const getSettings = async (req, res) => {
  try {
    // Fetch all coinflip settings
    const { data: settings, error } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .like('setting_key', 'coinflip%');

    if (error) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch game settings'
      });
    }

    // Parse settings with defaults
    const gameSettings = {
      enabled: true,
      minStake: 50,
      multiplier: 1.98,
      winRate: 48
    };

    settings?.forEach(setting => {
      const value = parsePlatformSetting(setting.setting_value);
      
      if (setting.setting_key === 'coinflip_enabled') {
        gameSettings.enabled = value === true || value === 'true';
      } else if (setting.setting_key === 'coinflip_min_stake') {
        gameSettings.minStake = parseFloat(value);
      } else if (setting.setting_key === 'coinflip_multiplier') {
        gameSettings.multiplier = parseFloat(value);
      } else if (setting.setting_key === 'coinflip_win_rate') {
        gameSettings.winRate = parseFloat(value);
      }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Coinflip game settings retrieved successfully',
      data: { settings: gameSettings }
    });

  } catch (error) {
    console.error('Error in getSettings:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

/**
 * Play coinflip game (instant result)
 * POST /api/coinflip/play
 */
const playGame = async (req, res) => {
  try {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        data: { errors: errors.array() }
      });
    }

    const { stake_amount, user_choice } = req.body;
    const userId = req.user.id;

    // Validate user choice
    if (!isValidChoice(user_choice)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid choice. Must be "heads" or "tails"'
      });
    }

    // Get game settings
    const { data: settings } = await supabaseAdmin
      .from('platform_settings')
      .select('setting_key, setting_value')
      .like('setting_key', 'coinflip%');

    let isEnabled = true;
    let minStake = 50;
    let multiplier = 1.98;
    let winRate = 48;

    settings?.forEach(setting => {
      const value = parsePlatformSetting(setting.setting_value);
      if (setting.setting_key === 'coinflip_enabled') {
        isEnabled = value === true || value === 'true';
      } else if (setting.setting_key === 'coinflip_min_stake') {
        minStake = parseFloat(value);
      } else if (setting.setting_key === 'coinflip_multiplier') {
        multiplier = parseFloat(value);
      } else if (setting.setting_key === 'coinflip_win_rate') {
        winRate = parseFloat(value);
      }
    });

    // Check if game is enabled
    if (!isEnabled) {
      return res.status(403).json({
        status: 'error',
        message: 'Coinflip game is currently disabled'
      });
    }

    // Get user's gaming wallet balance
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('games_balance, withdrawable_balance')
      .eq('user_id', userId)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({
        status: 'error',
        message: 'Wallet not found'
      });
    }

    const gamesBalance = parseFloat(wallet.games_balance || 0);
    const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
    const totalPlayableBalance = gamesBalance + withdrawableBalance;

    // Validate stake amount
    const validation = validateStakeAmount(stake_amount, minStake, totalPlayableBalance);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'error',
        message: validation.error
      });
    }

    // Generate coin flip result
    const { result: coinResult, isWin } = generateCoinFlip(user_choice.toLowerCase(), winRate);

    // Calculate payout
    let payoutAmount = 0;
    let profitLoss = -stake_amount;
    
    if (isWin) {
      const payoutCalc = calculatePayout(stake_amount, multiplier);
      payoutAmount = payoutCalc.payout;
      profitLoss = payoutCalc.profit;
    }

    let newGamesBalance = gamesBalance;
    let newWithdrawableBalance = withdrawableBalance;

    if (gamesBalance >= stake_amount) {
      newGamesBalance -= stake_amount;
    } else {
      const remainder = stake_amount - gamesBalance;
      newGamesBalance = 0;
      newWithdrawableBalance -= remainder;
    }
    
    if (isWin) {
      newWithdrawableBalance += payoutAmount;
    }

    const newTotalBal = parseFloat((newGamesBalance + newWithdrawableBalance).toFixed(2));

    // Create game round
    const { data: round, error: roundError } = await supabaseAdmin
      .from('coinflip_rounds')
      .insert({
        user_id: userId,
        stake_amount,
        user_choice: user_choice.toLowerCase(),
        coin_result: coinResult,
        multiplier,
        payout_amount: payoutAmount,
        profit_loss: profitLoss,
        status: isWin ? 'won' : 'lost'
      })
      .select()
      .single();

    if (roundError) {
      console.error('Error creating round:', roundError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to create game round'
      });
    }

    // Update user's gaming wallet
    const { error: updateError } = await supabaseAdmin
      .from('wallets')
      .update({ 
        games_balance: parseFloat(newGamesBalance.toFixed(2)),
        withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2))
      })
      .eq('user_id', userId);

    if (updateError) {
      console.error('Error updating wallet:', updateError);
      // Rollback: Delete the round
      await supabaseAdmin
        .from('coinflip_rounds')
        .delete()
        .eq('id', round.id);

      return res.status(500).json({
        status: 'error',
        message: 'Failed to update wallet'
      });
    }

    // Log stake transaction
    const stakeReference = generateTransactionReference('STAKE');
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: userId,
        transaction_type: 'gaming',
        balance_type: 'games_balance',
        earning_type: 'coinflip_stake',
        amount: -stake_amount,
        currency: 'NGN',
        status: 'completed',
        reference: stakeReference,
        description: `Coinflip game stake - ₦${formatCurrency(stake_amount)}`,
        metadata: {
          game: 'coinflip',
          round_id: round.id,
          user_choice: user_choice.toLowerCase(),
          stake_amount
        }
      });

    // Log win/loss transaction
    if (isWin) {
      const winReference = generateTransactionReference('WIN');
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: userId,
          transaction_type: 'gaming',
        balance_type: 'games_balance',
          earning_type: 'coinflip_win',
          amount: payoutAmount,
          currency: 'NGN',
          status: 'completed',
          reference: winReference,
          description: `Coinflip game win - ${user_choice} at ${multiplier}x`,
          metadata: {
            game: 'coinflip',
            round_id: round.id,
            user_choice: user_choice.toLowerCase(),
            coin_result: coinResult,
            multiplier,
            payout: payoutAmount,
            profit: profitLoss
          }
        });
    } else {
      const lossReference = generateTransactionReference('LOSS');
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: userId,
          transaction_type: 'gaming',
        balance_type: 'games_balance',
          earning_type: 'coinflip_loss',
          amount: -stake_amount,
          currency: 'NGN',
          status: 'completed',
          reference: lossReference,
          description: `Coinflip game loss - ${user_choice} vs ${coinResult}`,
          metadata: {
            game: 'coinflip',
            round_id: round.id,
            user_choice: user_choice.toLowerCase(),
            coin_result: coinResult
          }
        });
    }

    // Log Activity
    await logActivity(userId, isWin ? 'game_win' : 'game_loss', {
      game: 'coinflip',
      stake: stake_amount,
      payout: payoutAmount,
      result: coinResult,
      user_choice: user_choice
    }, req);

    // Return appropriate response
    if (isWin) {
      return res.status(200).json({
        status: 'success',
        message: 'You won! 🎉',
        data: {
          result: 'win',
          round: {
            id: round.id,
            stake_amount: round.stake_amount,
            user_choice: round.user_choice,
            coin_result: round.coin_result,
            multiplier: round.multiplier,
            payout_amount: round.payout_amount,
            profit_loss: round.profit_loss,
            status: round.status,
            created_at: round.created_at
          },
          new_games_balance: newTotalBal
        }
      });
    } else {
      return res.status(200).json({
        status: 'error',
        message: 'You lost. Better luck next time!',
        data: {
          result: 'loss',
          round: {
            id: round.id,
            stake_amount: round.stake_amount,
            user_choice: round.user_choice,
            coin_result: round.coin_result,
            multiplier: round.multiplier,
            payout_amount: round.payout_amount,
            profit_loss: round.profit_loss,
            status: round.status,
            created_at: round.created_at
          },
          new_games_balance: newTotalBal
        }
      });
    }

  } catch (error) {
    console.error('Error in playGame:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

/**
 * Get user's coinflip game history
 * GET /api/coinflip/history
 */
const getHistory = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        data: { errors: errors.array() }
      });
    }

    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status;
    const offset = (page - 1) * limit;

    // Build query
    let query = supabaseAdmin
      .from('coinflip_rounds')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    if (status) {
      query = query.eq('status', status);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: rounds, error, count } = await query;

    if (error) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch game history'
      });
    }

    const totalPages = Math.ceil(count / limit);

    return res.status(200).json({
      status: 'success',
      message: 'Game history retrieved successfully',
      data: {
        rounds: rounds || [],
        pagination: {
          current_page: page,
          total_pages: totalPages,
          total_rounds: count,
          has_next: page < totalPages,
          has_prev: page > 1,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Error in getHistory:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

/**
 * Get user's coinflip statistics
 * GET /api/coinflip/statistics
 */
const getStatistics = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: rounds, error } = await supabaseAdmin
      .from('coinflip_rounds')
      .select('status, stake_amount, payout_amount, profit_loss')
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch statistics'
      });
    }

    const totalRounds = rounds?.length || 0;
    const totalWins = rounds?.filter(r => r.status === 'won').length || 0;
    const totalLosses = rounds?.filter(r => r.status === 'lost').length || 0;
    const totalWagered = rounds?.reduce((sum, r) => sum + parseFloat(r.stake_amount), 0) || 0;
    const totalWon = rounds?.reduce((sum, r) => sum + parseFloat(r.payout_amount), 0) || 0;
    const netProfitLoss = rounds?.reduce((sum, r) => sum + parseFloat(r.profit_loss), 0) || 0;
    const winRate = calculateWinRate(totalWins, totalWins + totalLosses);

    return res.status(200).json({
      status: 'success',
      message: 'Statistics retrieved successfully',
      data: {
        stats: {
          total_rounds: totalRounds,
          total_wins: totalWins,
          total_losses: totalLosses,
          total_wagered: totalWagered,
          total_won: totalWon,
          net_profit_loss: netProfitLoss,
          win_rate: winRate
        }
      }
    });

  } catch (error) {
    console.error('Error in getStatistics:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

/**
 * Get admin statistics for coinflip game
 * GET /api/coinflip/admin/statistics
 */
const getAdminStatistics = async (req, res) => {
  try {
    // Get all rounds data
    const { data: allRounds, error: allError } = await supabaseAdmin
      .from('coinflip_rounds')
      .select('status, stake_amount, payout_amount, profit_loss, created_at, user_id');

    if (allError) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to fetch admin statistics'
      });
    }

    // Calculate overall statistics
    const totalRounds = allRounds?.length || 0;
    const totalWins = allRounds?.filter(r => r.status === 'won').length || 0;
    const totalLosses = allRounds?.filter(r => r.status === 'lost').length || 0;
    const totalWagered = allRounds?.reduce((sum, r) => sum + parseFloat(r.stake_amount), 0) || 0;
    const totalPaidOut = allRounds?.reduce((sum, r) => sum + parseFloat(r.payout_amount), 0) || 0;
    const houseProfit = totalWagered - totalPaidOut;
    const winRate = calculateWinRate(totalWins, totalRounds);
    const houseEdgePercentage = totalWagered > 0 ? ((houseProfit / totalWagered) * 100).toFixed(2) : '0.00';

    // Get unique players
    const uniquePlayers = new Set(allRounds?.map(r => r.user_id)).size;

    // Today's statistics
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayRounds = allRounds?.filter(r => new Date(r.created_at) >= today) || [];
    const uniquePlayersToday = new Set(todayRounds.map(r => r.user_id)).size;

    const todayStats = {
      total_rounds: todayRounds.length,
      total_wins: todayRounds.filter(r => r.status === 'won').length,
      total_losses: todayRounds.filter(r => r.status === 'lost').length,
      total_wagered: todayRounds.reduce((sum, r) => sum + parseFloat(r.stake_amount), 0),
      total_paid_out: todayRounds.reduce((sum, r) => sum + parseFloat(r.payout_amount), 0),
      house_profit: 0
    };
    todayStats.house_profit = todayStats.total_wagered - todayStats.total_paid_out;

    // This week's statistics
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekRounds = allRounds?.filter(r => new Date(r.created_at) >= weekAgo) || [];

    const weekStats = {
      total_rounds: weekRounds.length,
      total_wins: weekRounds.filter(r => r.status === 'won').length,
      total_losses: weekRounds.filter(r => r.status === 'lost').length,
      total_wagered: weekRounds.reduce((sum, r) => sum + parseFloat(r.stake_amount), 0),
      total_paid_out: weekRounds.reduce((sum, r) => sum + parseFloat(r.payout_amount), 0),
      house_profit: 0
    };
    weekStats.house_profit = weekStats.total_wagered - weekStats.total_paid_out;

    // This month's statistics
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const monthRounds = allRounds?.filter(r => new Date(r.created_at) >= monthAgo) || [];

    const monthStats = {
      total_rounds: monthRounds.length,
      total_wins: monthRounds.filter(r => r.status === 'won').length,
      total_losses: monthRounds.filter(r => r.status === 'lost').length,
      total_wagered: monthRounds.reduce((sum, r) => sum + parseFloat(r.stake_amount), 0),
      total_paid_out: monthRounds.reduce((sum, r) => sum + parseFloat(r.payout_amount), 0),
      house_profit: 0
    };
    monthStats.house_profit = monthStats.total_wagered - monthStats.total_paid_out;

    // Top players by total wagered
    const { data: topPlayersData, error: topError } = await supabaseAdmin
      .from('coinflip_rounds')
      .select(`
        user_id,
        stake_amount,
        payout_amount,
        profit_loss,
        status,
        users!inner (
          id,
          username,
          full_name,
          user_tier
        )
      `)
      .limit(1000);

    let topPlayers = [];
    if (!topError && topPlayersData) {
      const playerMap = {};
      
      topPlayersData.forEach(round => {
        const userId = round.user_id;
        if (!playerMap[userId]) {
          playerMap[userId] = {
            user_id: userId,
            username: round.users.username,
            full_name: round.users.full_name,
            user_tier: round.users.user_tier,
            total_wagered: 0,
            total_won: 0,
            net_profit_loss: 0,
            total_rounds: 0,
            wins: 0,
            losses: 0
          };
        }

        playerMap[userId].total_wagered += parseFloat(round.stake_amount);
        playerMap[userId].total_won += parseFloat(round.payout_amount);
        playerMap[userId].net_profit_loss += parseFloat(round.profit_loss);
        playerMap[userId].total_rounds += 1;
        
        if (round.status === 'won') {
          playerMap[userId].wins += 1;
        } else {
          playerMap[userId].losses += 1;
        }
      });

      topPlayers = Object.values(playerMap)
        .sort((a, b) => b.total_wagered - a.total_wagered)
        .slice(0, 10)
        .map(player => ({
          ...player,
          win_rate: calculateWinRate(player.wins, player.wins + player.losses)
        }));
    }

    // Recent big wins
    const { data: bigWins, error: bigWinsError } = await supabaseAdmin
      .from('coinflip_rounds')
      .select(`
        id,
        stake_amount,
        user_choice,
        coin_result,
        multiplier,
        payout_amount,
        profit_loss,
        created_at,
        users!inner (
          username,
          full_name,
          user_tier
        )
      `)
      .eq('status', 'won')
      .order('payout_amount', { ascending: false })
      .limit(10);

    const recentBigWins = bigWinsError ? [] : bigWins?.map(win => ({
      round_id: win.id,
      username: win.users.username,
      full_name: win.users.full_name,
      user_tier: win.users.user_tier,
      stake_amount: win.stake_amount,
      user_choice: win.user_choice,
      coin_result: win.coin_result,
      multiplier: win.multiplier,
      payout_amount: win.payout_amount,
      profit: win.profit_loss,
      created_at: win.created_at
    })) || [];

    return res.status(200).json({
      status: 'success',
      message: 'Admin statistics retrieved successfully',
      data: {
        overview: {
          total_rounds: totalRounds,
          total_wins: totalWins,
          total_losses: totalLosses,
          win_rate: parseFloat(winRate),
          unique_players: uniquePlayers,
          unique_players_today: uniquePlayersToday
        },
        financial: {
          total_wagered: totalWagered,
          total_paid_out: totalPaidOut,
          house_profit: houseProfit,
          house_edge_percentage: parseFloat(houseEdgePercentage)
        },
        today: todayStats,
        this_week: weekStats,
        this_month: monthStats,
        top_players: topPlayers,
        recent_big_wins: recentBigWins
      }
    });

  } catch (error) {
    console.error('Error in getAdminStatistics:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
};

module.exports = {
  getSettings,
  playGame,
  getHistory,
  getStatistics,
  getAdminStatistics
};