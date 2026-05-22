const { supabaseAdmin } = require('../services/supabase.service');

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
        .select('games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      if (error || !wallet) {
        return res.status(404).json({ status: "RS_ERROR", error: "User or wallet not found" });
      }

      const gamesBalance = parseFloat(wallet.games_balance || 0);
      const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
      const totalPlayableBalance = gamesBalance + withdrawableBalance;

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
        .select('games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      const gamesBalance = parseFloat(wallet?.games_balance || 0);
      const withdrawableBalance = parseFloat(wallet?.withdrawable_balance || 0);
      const totalPlayableBalance = gamesBalance + withdrawableBalance;

      if (!wallet || totalPlayableBalance < betAmountInNaira) {
        return res.status(400).json({ status: "RS_ERROR_NOT_ENOUGH_MONEY", error: "Insufficient balance" });
      }

      let newGamesBalance = gamesBalance;
      let newWithdrawableBalance = withdrawableBalance;

      if (gamesBalance >= betAmountInNaira) {
        newGamesBalance -= betAmountInNaira;
      } else {
        const remainder = betAmountInNaira - gamesBalance;
        newGamesBalance = 0;
        newWithdrawableBalance -= remainder;
      }

      const newTotalBal = parseFloat((newGamesBalance + newWithdrawableBalance).toFixed(2));

      await supabaseAdmin
        .from('wallets')
        .update({ 
          games_balance: parseFloat(newGamesBalance.toFixed(2)),
          withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2))
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
          metadata: { game_id, round, provider: 'hub88' },
          created_at: new Date().toISOString()
        });

      return res.status(200).json({
        user: user,
        balance: Math.floor(newTotalBal * 100),
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
        .select('games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      if (!wallet) return res.status(404).json({ status: "RS_ERROR", error: "User not found" });

      const gamesBalance = parseFloat(wallet.games_balance || 0);
      const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
      const newWithdrawableBalance = withdrawableBalance + winAmountInNaira;
      const newTotalBal = gamesBalance + newWithdrawableBalance;

      // 2. Credit wallet
      await supabaseAdmin
        .from('wallets')
        .update({ withdrawable_balance: parseFloat(newWithdrawableBalance.toFixed(2)) })
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
        balance: Math.floor(newTotalBal * 100),
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
        .select('amount')
        .eq('reference', reference_transaction_uuid)
        .single();

      if (!originalBet) {
         // Some aggregators require RS_OK even if original bet is not found (assuming it failed)
         return res.status(200).json({ status: "RS_OK" });
      }

      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('games_balance, withdrawable_balance')
        .eq('user_id', user)
        .single();

      const gamesBalance = parseFloat(wallet.games_balance || 0);
      const withdrawableBalance = parseFloat(wallet.withdrawable_balance || 0);
      const newGamesBalance = gamesBalance + parseFloat(originalBet.amount);
      const newTotalBal = newGamesBalance + withdrawableBalance;

      // Refund the money
      await supabaseAdmin
        .from('wallets')
        .update({ games_balance: parseFloat(newGamesBalance.toFixed(2)) })
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
