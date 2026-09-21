export const POSITION_COST_MODEL_VERSION = 3;
export const EXIT_POLICY_VERSION = 1;
export const ENTRY_FIXED_COST_RATE = 0.025;
export const EXIT_FIXED_COST_RATE = 0.025;
export const STOP_LIQUIDATION_USDC = 70;
export const RECOVERY_LIQUIDATION_USDC = 200;
export const PRINCIPAL_USDC = 100;
export const TRAILING_DRAWDOWN_RATE = 0.35;
export const MAX_HOLD_MS = 24 * 60 * 60_000;
const STOP_LIQUIDATION_RATE = STOP_LIQUIDATION_USDC / PRINCIPAL_USDC;
const RECOVERY_LIQUIDATION_MULTIPLE = RECOVERY_LIQUIDATION_USDC / PRINCIPAL_USDC;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function positionLiquidityImpact(liquidityUsd, principalUsdc = PRINCIPAL_USDC) {
  const liquidity = finite(liquidityUsd);
  const principal = finite(principalUsdc) > 0 ? finite(principalUsdc) : PRINCIPAL_USDC;
  return clamp(principal / Math.max((liquidity || 0) / 2, principal), 0, .25);
}

function principalFor(position) {
  const allocated = finite(position?.allocatedUsdc);
  const reserved = finite(position?.portfolioStakeUsdc);
  return allocated > 0 ? allocated : reserved > 0 ? reserved : PRINCIPAL_USDC;
}

function usesLegacyDynamicCost(position) {
  return Number(position?.costModelVersion) > 0 && Number(position.costModelVersion) < POSITION_COST_MODEL_VERSION;
}

function exitMultiplier(position, liquidity) {
  const legacy = usesLegacyDynamicCost(position);
  const fixedRate = legacy ? 0.015 : EXIT_FIXED_COST_RATE;
  const impact = positionLiquidityImpact(liquidity, principalFor(position));
  return (1 - fixedRate) * (1 - impact);
}

export function netLiquidationValue(position, price, liquidity) {
  const value = finite(price);
  const units = finite(position?.remainingUnits);
  if (!(value > 0) || !(units >= 0)) return null;
  return units * value * exitMultiplier(position, liquidity);
}

function cashflow(position, { at, kind, units, price, liquidity, netUsdc }) {
  const legacy = usesLegacyDynamicCost(position);
  position.cashflows ||= [];
  position.cashflows.push({
    at: Number(at), kind: String(kind), units: Number(units), price: Number(price),
    liquidity: Number(liquidity), netUsdc: Number(netUsdc),
    fixedCostRate: legacy ? 0.015 : EXIT_FIXED_COST_RATE,
    dynamicImpactRate: positionLiquidityImpact(liquidity, principalFor(position))
  });
}

function close(position, reason, at, proceeds, units, price, liquidity) {
  if (units > 0) cashflow(position, { at, kind: reason, units, price, liquidity, netUsdc: proceeds });
  position.recoveredUsdc = Number(position.recoveredUsdc || 0) + proceeds;
  position.remainingUnits = 0;
  position.status = 'CLOSED';
  position.portfolioStatus = 'CLOSED';
  position.closedAt = Number(at);
  position.exitReason = reason;
  position.realizedNetUsdc = position.recoveredUsdc - Number(position.allocatedUsdc || PRINCIPAL_USDC);
  position.conservativeReturn = position.realizedNetUsdc / Number(position.allocatedUsdc || PRINCIPAL_USDC);
}

export function openShadowPosition(position, sample) {
  const price = finite(sample?.price);
  const at = finite(sample?.at);
  const liquidity = finite(sample?.liquidity) ?? finite(position?.factors?.liquidity);
  if (!position || position.cohort !== 'signal' || position.legacyFixedHorizonOnly === true
    || !(price > 0) || at === null || !(liquidity > 0)) return false;
  if (position.entry?.targetAt && Math.abs(at - Number(position.entry.targetAt)) > 60_000) return false;
  const principal = principalFor(position);
  position.costModelVersion = POSITION_COST_MODEL_VERSION;
  const entryImpact = positionLiquidityImpact(liquidity, principal);
  const units = principal * (1 - ENTRY_FIXED_COST_RATE) * (1 - entryImpact) / price;
  position.exitPolicyVersion = EXIT_POLICY_VERSION;
  position.allocatedUsdc = principal;
  position.recoveredUsdc = 0;
  position.remainingUnits = units;
  position.initialUnits = units;
  position.cashflows = [{
    at, kind: 'ENTRY', units, price, liquidity, netUsdc: -principal,
    fixedCostRate: ENTRY_FIXED_COST_RATE, dynamicImpactRate: entryImpact
  }];
  position.entry = {
    ...position.entry, at, price, liquidity, fixedCostRate: ENTRY_FIXED_COST_RATE,
    dynamicImpactRate: entryImpact, source: String(sample.source || 'GMGN_1M_CLOSE')
  };
  position.status = 'OPEN';
  position.portfolioStatus = 'OPEN';
  position.lastCandleAt = at;
  position.highWaterNetUsdc = netLiquidationValue(position, price, liquidity);
  return true;
}

function validCandle(candle) {
  const values = ['openAt', 'closeAt', 'open', 'high', 'low', 'close'].map(key => finite(candle?.[key]));
  if (values.some(value => value === null)) return null;
  const [openAt, closeAt, open, high, low, close] = values;
  if (!(openAt < closeAt) || !(low > 0) || high < Math.max(open, close) || low > Math.min(open, close)) return null;
  return { openAt, closeAt, open, high, low, close };
}

function thresholdPrice(position, targetNet, liquidity) {
  return targetNet / (position.remainingUnits * exitMultiplier(position, liquidity));
}

export function applyExitCandle(position, rawCandle, { exitLiquidity } = {}) {
  const candle = validCandle(rawCandle);
  if (!position || !candle || !['OPEN', 'RUNNER'].includes(position.status) || !(position.remainingUnits > 0)) {
    return { event: null, applied: false };
  }
  if (candle.openAt < Number(position.entry?.at || 0) || candle.closeAt <= Number(position.entry?.at || 0)) {
    return { event: null, applied: false, ignored: 'PRE_ENTRY_CANDLE' };
  }
  const estimateLiquidity = finite(position.entry?.liquidity);
  if (!(estimateLiquidity > 0)) return { event: null, applied: false };

  const liquidity = finite(exitLiquidity);
  const valuationLiquidity = liquidity > 0 ? liquidity : estimateLiquidity;
  const principal = principalFor(position);
  const stopTarget = principal * STOP_LIQUIDATION_RATE;
  const recoveryTarget = principal * RECOVERY_LIQUIDATION_MULTIPLE;
  if (position.status === 'OPEN') {
    const estimatedLow = netLiquidationValue(position, candle.low, valuationLiquidity);
    const estimatedHigh = netLiquidationValue(position, candle.high, valuationLiquidity);
    const candidate = estimatedLow <= stopTarget ? 'STOP_LOSS'
      : estimatedHigh >= recoveryTarget ? 'PRINCIPAL_RECOVERY' : null;
    if (!candidate) {
      position.highWaterNetUsdc = Math.max(Number(position.highWaterNetUsdc || 0), estimatedHigh || 0);
      position.lastCandleAt = candle.closeAt;
      return { event: null, applied: true };
    }
    if (!(liquidity > 0)) return { event: candidate, applied: false, pending: 'EXIT_LIQUIDITY' };
    if (candidate === 'STOP_LOSS') {
      const target = thresholdPrice(position, stopTarget, liquidity);
      const fillPrice = candle.open <= target ? candle.open : target;
      const units = position.remainingUnits;
      const proceeds = units * fillPrice * exitMultiplier(position, liquidity);
      close(position, candidate, candle.openAt, proceeds, units, fillPrice, liquidity);
      return { event: candidate, applied: true };
    }
    const target = thresholdPrice(position, recoveryTarget, liquidity);
    const fillPrice = candle.open >= target ? candle.open : target;
    const perUnit = fillPrice * exitMultiplier(position, liquidity);
    const units = Math.min(position.remainingUnits, principal / perUnit);
    const proceeds = Math.min(principal, units * perUnit);
    cashflow(position, { at: candle.openAt, kind: candidate, units, price: fillPrice, liquidity, netUsdc: proceeds });
    position.remainingUnits -= units;
    position.recoveredUsdc = proceeds;
    position.principalRecoveredAt = candle.openAt;
    position.status = 'RUNNER';
    position.portfolioStatus = 'RUNNER';
    const runnerHigh = netLiquidationValue(position, candle.high, liquidity);
    position.highWaterNetUsdc = Math.max(netLiquidationValue(position, fillPrice, liquidity) || 0, runnerHigh || 0);
    const runnerTrigger = position.highWaterNetUsdc * (1 - TRAILING_DRAWDOWN_RATE);
    const runnerLow = netLiquidationValue(position, candle.low, liquidity);
    if (runnerLow <= runnerTrigger) {
      const runnerTarget = thresholdPrice(position, runnerTrigger, liquidity);
      const runnerUnits = position.remainingUnits;
      const runnerProceeds = runnerUnits * runnerTarget * exitMultiplier(position, liquidity);
      close(position, 'TRAILING_DRAWDOWN', candle.closeAt, runnerProceeds, runnerUnits, runnerTarget, liquidity);
      return { event: 'TRAILING_DRAWDOWN', applied: true, precededBy: candidate };
    }
    position.lastCandleAt = candle.closeAt;
    return { event: candidate, applied: true };
  }

  const estimatedHigh = netLiquidationValue(position, candle.high, valuationLiquidity);
  const highWater = Math.max(Number(position.highWaterNetUsdc || 0), estimatedHigh || 0);
  const trigger = highWater * (1 - TRAILING_DRAWDOWN_RATE);
  const estimatedLow = netLiquidationValue(position, candle.low, valuationLiquidity);
  if (estimatedLow > trigger) {
    position.highWaterNetUsdc = highWater;
    position.lastCandleAt = candle.closeAt;
    return { event: null, applied: true };
  }
  if (!(liquidity > 0)) return { event: 'TRAILING_DRAWDOWN', applied: false, pending: 'EXIT_LIQUIDITY' };
  const target = thresholdPrice(position, trigger, liquidity);
  const fillPrice = candle.open <= target ? candle.open : target;
  const units = position.remainingUnits;
  const proceeds = units * fillPrice * exitMultiplier(position, liquidity);
  close(position, 'TRAILING_DRAWDOWN', candle.openAt, proceeds, units, fillPrice, liquidity);
  position.highWaterNetUsdc = highWater;
  return { event: 'TRAILING_DRAWDOWN', applied: true };
}

export function applySafetyExit(position, { at, price, liquidity, tradable = true, code = 'SAFETY_EXIT' } = {}) {
  if (!position || !['OPEN', 'RUNNER'].includes(position.status)) return false;
  const exitAt = finite(at);
  const exitPrice = finite(price);
  const exitLiquidity = finite(liquidity);
  if (tradable && exitAt !== null && exitPrice > 0 && exitLiquidity > 0) {
    const units = position.remainingUnits;
    close(position, String(code), exitAt, units * exitPrice * exitMultiplier(position, exitLiquidity), units, exitPrice, exitLiquidity);
  } else {
    position.remainingUnits = 0;
    position.status = 'CLOSED';
    position.portfolioStatus = 'CLOSED';
    position.closedAt = exitAt ?? Date.now();
    position.exitReason = String(code);
    position.realizedNetUsdc = Number(position.recoveredUsdc || 0) - Number(position.allocatedUsdc || PRINCIPAL_USDC);
    position.conservativeReturn = position.realizedNetUsdc / Number(position.allocatedUsdc || PRINCIPAL_USDC);
  }
  return true;
}

export function applyTimeoutExit(position, { at, price, liquidity } = {}) {
  const exitAt = finite(at);
  const targetAt = Number(position?.entry?.at || Infinity) + MAX_HOLD_MS;
  if (!position || !['OPEN', 'RUNNER'].includes(position.status) || exitAt === null
    || exitAt < targetAt || exitAt > targetAt + 60_000) return false;
  return applySafetyExit(position, { at: exitAt, price, liquidity, tradable: true, code: 'EXPERIMENT_TIMEOUT' });
}
