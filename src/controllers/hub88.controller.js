const { supabaseAdmin } = require('../services/supabase.service');
const { allocateStake, getPlayableBalance, settlePayoutFromAllocation } = require('../utils/helpers/wallet.helpers');

/**
 * Generic Seamless Wallet Controller designed for Hub88 / Fivers API compatibility.
 * Mocks the verification and implements the actual Kashprime balance deductions/additions.
 */
class Hub88Controller {
  
  // 1. Get Balance
  static async getBalance(req, res) {
    try {
      // Hub88 typically sends: { user, token, request_uuid, currency }
      const { user } = req.body;

      if (!user) {
        return res.status(400).json({ status: "RS_ERROR", error: "user missing" });
      }

      // Fetch user's games balance from Kashprime
      const { data: wallet, error } = await supabaseAdmin
        .from('wallets')
        .select('bonus_balance, games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      if (error || !wallet) {
        return res.status(404).json({ status: "RS_ERROR", error: "User or wallet not found" });
      }

      const totalPlayableBalance = getPlayableBalance(wallet);

      return res.status(200).json({
        user: user,
        balance: Math.floor(totalPlayableBalance * 100), // Standard: send balance in cents (kobo)
        currency: "NGN",
        status: "RS_OK"
      });

    } catch (error) {
      console.error("Hub88 getBalance error:", error);
      res.status(500).json({ status: "RS_ERROR", error: "Internal Server Error" });
    }
  }

  // 2. Bet (Debit)
  static async bet(req, res) {
    try {
      // Hub88 sends: { user, transaction_uuid, amount, game_id, round, currency }
      const { user, transaction_uuid, amount, game_id, round } = req.body;

      // 1. Check if transaction already exists (Idempotency)
      const { data: existingTx } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', transaction_uuid)
        .single();

      if (existingTx) {
        // Return success if already processed
        return res.status(200).json({ status: "RS_OK", message: "Duplicate transaction" });
      }

      const betAmountInNaira = amount / 100; // Convert from kobo to Naira

      // 2. Debit the user's wallet
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('bonus_balance, games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      const totalPlayableBalance = wallet ? getPlayableBalance(wallet) : 0;

      if (!wallet || totalPlayableBalance < betAmountInNaira) {
        return res.status(400).json({ status: "RS_ERROR_NOT_ENOUGH_MONEY", error: "Insufficient balance" });
      }

      const stakeAllocation = allocateStake(wallet, betAmountInNaira);

      await supabaseAdmin
        .from('wallets')
        .update({ 
          bonus_balance: stakeAllocation.balances.bonus_balance,
          games_balance: stakeAllocation.balances.games_balance,
          withdrawable_balance: stakeAllocation.balances.withdrawable_balance
        })
        .eq('user_id', user);

      // 3. Record the transaction
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: user,
          transaction_type: 'gaming_bet',
          balance_type: 'games_balance',
          amount: betAmountInNaira,
          currency: 'NGN',
          status: 'completed',
          description: `Hub88 Casino Bet - Game ${game_id}`,
          reference: transaction_uuid,
          metadata: { game_id, round, provider: 'hub88', stake_allocation: stakeAllocation.allocation },
          created_at: new Date().toISOString()
        });

      return res.status(200).json({
        user: user,
        balance: Math.floor(stakeAllocation.totalPlayableBalance * 100),
        currency: "NGN",
        status: "RS_OK"
      });

    } catch (error) {
      console.error("Hub88 bet error:", error);
      res.status(500).json({ status: "RS_ERROR", error: "Internal Server Error" });
    }
  }

  // 3. Win (Credit)
  static async win(req, res) {
    try {
      // Hub88 sends: { user, transaction_uuid, amount, game_id, round, currency }
      const { user, transaction_uuid, amount, game_id, round } = req.body;

      // Check Idempotency
      const { data: existingTx } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', transaction_uuid)
        .single();

      if (existingTx) {
        return res.status(200).json({ status: "RS_OK", message: "Duplicate transaction" });
      }

      const winAmountInNaira = amount / 100;

      // 1. Fetch current wallet
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('bonus_balance, games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      if (!wallet) return res.status(404).json({ status: "RS_ERROR", error: "User not found" });

      const { data: betTx } = await supabaseAdmin
        .from('transactions')
        .select('amount, metadata')
        .eq('user_id', user)
        .eq('transaction_type', 'gaming_bet')
        .contains('metadata', { round, game_id, provider: 'hub88' })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const settlement = betTx
        ? settlePayoutFromAllocation(wallet, betTx.metadata?.stake_allocation, parseFloat(betTx.amount), winAmountInNaira)
        : {
            balances: {
              bonus_balance: parseFloat(wallet.bonus_balance || 0),
              games_balance: parseFloat(wallet.games_balance || 0),
              withdrawable_balance: parseFloat(wallet.withdrawable_balance || 0) + winAmountInNaira,
            },
            totalPlayableBalance: getPlayableBalance(wallet) + winAmountInNaira,
          };

      // 2. Credit wallet
      await supabaseAdmin
        .from('wallets')
        .update({
          bonus_balance: settlement.balances.bonus_balance,
          games_balance: settlement.balances.games_balance,
          withdrawable_balance: settlement.balances.withdrawable_balance
        })
        .eq('user_id', user);

      // 3. Record transaction
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: user,
          transaction_type: 'gaming_win',
          balance_type: 'games_balance',
          amount: winAmountInNaira,
          currency: 'NGN',
          status: 'completed',
          description: `Hub88 Casino Win - Game ${game_id}`,
          reference: transaction_uuid,
          metadata: { game_id, round, provider: 'hub88' },
          created_at: new Date().toISOString()
        });

      return res.status(200).json({
        user: user,
        balance: Math.floor(settlement.totalPlayableBalance * 100),
        currency: "NGN",
        status: "RS_OK"
      });

    } catch (error) {
      console.error("Hub88 win error:", error);
      res.status(500).json({ status: "RS_ERROR", error: "Internal Server Error" });
    }
  }

  // 4. Rollback (Cancel Bet)
  static async rollback(req, res) {
    try {
      const { user, transaction_uuid, reference_transaction_uuid } = req.body;

      // Ensure we don't rollback twice
      const { data: existingRollback } = await supabaseAdmin
        .from('transactions')
        .select('id')
        .eq('reference', transaction_uuid)
        .single();

      if (existingRollback) {
        return res.status(200).json({ status: "RS_OK", message: "Already rolled back" });
      }

      // Find original bet
      const { data: originalBet } = await supabaseAdmin
        .from('transactions')
        .select('amount, metadata')
        .eq('reference', reference_transaction_uuid)
        .single();

      if (!originalBet) {
         // Some aggregators require RS_OK even if original bet is not found (assuming it failed)
         return res.status(200).json({ status: "RS_OK" });
      }

      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('bonus_balance, games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      const balances = {
        bonus_balance: parseFloat(wallet.bonus_balance || 0),
        games_balance: parseFloat(wallet.games_balance || 0),
        withdrawable_balance: parseFloat(wallet.withdrawable_balance || 0),
      };
      let remainingRefund = parseFloat(originalBet.amount);
      for (const key of ['bonus_balance', 'games_balance', 'withdrawable_balance']) {
        const refund = Math.min(parseFloat(originalBet.metadata?.stake_allocation?.[key] || 0), remainingRefund);
        balances[key] += refund;
        remainingRefund -= refund;
      }
      const newTotalBal = balances.bonus_balance + balances.games_balance + balances.withdrawable_balance;

      // Refund the money
      await supabaseAdmin
        .from('wallets')
        .update({
          bonus_balance: parseFloat(balances.bonus_balance.toFixed(2)),
          games_balance: parseFloat(balances.games_balance.toFixed(2)),
          withdrawable_balance: parseFloat(balances.withdrawable_balance.toFixed(2))
        })
        .eq('user_id', user);

      // Record Rollback transaction
      await supabaseAdmin
        .from('transactions')
        .insert({
          user_id: user,
          transaction_type: 'gaming_refund',
          balance_type: 'games_balance',
          amount: parseFloat(originalBet.amount),
          currency: 'NGN',
          status: 'completed',
          description: `Hub88 Casino Rollback`,
          reference: transaction_uuid,
          metadata: { provider: 'hub88', rollback_for: reference_transaction_uuid },
          created_at: new Date().toISOString()
        });

      return res.status(200).json({
        user: user,
        balance: Math.floor(newTotalBal * 100),
        currency: "NGN",
        status: "RS_OK"
      });

    } catch (error) {
      console.error("Hub88 rollback error:", error);
      res.status(500).json({ status: "RS_ERROR", error: "Internal Server Error" });
    }
  }
}

module.exports = Hub88Controller;
