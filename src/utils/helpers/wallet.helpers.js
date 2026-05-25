const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const getPlayableBalance = (wallet = {}) => (
  roundMoney(wallet.bonus_balance) +
  roundMoney(wallet.games_balance) +
  roundMoney(wallet.withdrawable_balance)
);

const allocateStake = (wallet = {}, stakeAmount) => {
  let remaining = roundMoney(stakeAmount);
  const balances = {
    bonus_balance: roundMoney(wallet.bonus_balance),
    games_balance: roundMoney(wallet.games_balance),
    withdrawable_balance: roundMoney(wallet.withdrawable_balance),
  };

  const allocation = {
    bonus_balance: 0,
    games_balance: 0,
    withdrawable_balance: 0,
  };

  for (const key of ['bonus_balance', 'games_balance', 'withdrawable_balance']) {
    const used = Math.min(balances[key], remaining);
    allocation[key] = roundMoney(used);
    balances[key] = roundMoney(balances[key] - used);
    remaining = roundMoney(remaining - used);
  }

  return {
    allocation,
    balances,
    hasEnoughBalance: remaining <= 0,
    remaining,
  };
};

const settleGameStake = (wallet = {}, stakeAmount, payoutAmount = 0) => {
  const stake = roundMoney(stakeAmount);
  const payout = roundMoney(payoutAmount);
  const stakeResult = allocateStake(wallet, stake);

  if (!stakeResult.hasEnoughBalance) {
    return {
      ok: false,
      error: 'Insufficient playable balance',
      totalPlayableBalance: getPlayableBalance(wallet),
    };
  }

  const balances = { ...stakeResult.balances };
  const principalReturn = Math.min(stake, payout);
  const profit = Math.max(roundMoney(payout - stake), 0);

  if (principalReturn > 0) {
    let remainingReturn = principalReturn;

    for (const key of ['bonus_balance', 'games_balance', 'withdrawable_balance']) {
      const refund = Math.min(stakeResult.allocation[key], remainingReturn);
      balances[key] = roundMoney(balances[key] + refund);
      remainingReturn = roundMoney(remainingReturn - refund);
    }
  }

  balances.withdrawable_balance = roundMoney(balances.withdrawable_balance + profit);

  return {
    ok: true,
    allocation: stakeResult.allocation,
    principalReturn: roundMoney(principalReturn),
    profit: roundMoney(profit),
    balances,
    totalPlayableBalance: roundMoney(
      balances.bonus_balance + balances.games_balance + balances.withdrawable_balance
    ),
  };
};

const settlePayoutFromAllocation = (wallet = {}, allocation = {}, stakeAmount, payoutAmount = 0) => {
  const stake = roundMoney(stakeAmount);
  const payout = roundMoney(payoutAmount);
  const hasSavedAllocation = allocation && Object.values(allocation).some((value) => roundMoney(value) > 0);
  const effectiveAllocation = hasSavedAllocation ? allocation : { games_balance: stake };
  const balances = {
    bonus_balance: roundMoney(wallet.bonus_balance),
    games_balance: roundMoney(wallet.games_balance),
    withdrawable_balance: roundMoney(wallet.withdrawable_balance),
  };
  const principalReturn = Math.min(stake, payout);
  const profit = Math.max(roundMoney(payout - stake), 0);
  let remainingReturn = principalReturn;

  for (const key of ['bonus_balance', 'games_balance', 'withdrawable_balance']) {
    const refund = Math.min(roundMoney(effectiveAllocation[key]), remainingReturn);
    balances[key] = roundMoney(balances[key] + refund);
    remainingReturn = roundMoney(remainingReturn - refund);
  }

  balances.withdrawable_balance = roundMoney(balances.withdrawable_balance + profit);

  return {
    allocation: effectiveAllocation,
    principalReturn: roundMoney(principalReturn),
    profit: roundMoney(profit),
    balances,
    totalPlayableBalance: roundMoney(
      balances.bonus_balance + balances.games_balance + balances.withdrawable_balance
    ),
  };
};

module.exports = {
  allocateStake,
  getPlayableBalance,
  roundMoney,
  settleGameStake,
  settlePayoutFromAllocation,
};
