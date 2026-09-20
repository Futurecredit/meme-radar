export const POSITION_COST_MODEL_VERSION = 2;
export const EXIT_POLICY_VERSION = 1;
export const ENTRY_FIXED_COST_RATE = 0.015;
export const EXIT_FIXED_COST_RATE = 0.015;
export const STOP_LIQUIDATION_USDC = 70;
export const RECOVERY_LIQUIDATION_USDC = 200;
export const PRINCIPAL_USDC = 100;
export const TRAILING_DRAWDOWN_RATE = 0.35;
export const MAX_HOLD_MS = 24 * 60 * 60_000;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function positionLiquidityImpact(liquidityUsd) {
  const liquidity = finite(liquidityUsd);
  return clamp(PRINCIPAL_USDC / Math.max((liquidity || 0) / 2, PRINCIPAL_USDC), 0, .25);
}

function exitMultiplier(liquidity) {
  return (1 - EXIT_FIXED_COST_RATE) * (1 - positionLiquidityImpact(liquidity));
}

export function netLiquidationValue(position, price, liquidity) {
  const value = finite(price);
  const units = finite(position?.remainingUnits);
  if (!(value > 0) || !(units >= 0)) return null;
  return units * value * exitMultiplier(liquidity);
}

function cashflow(position, { at, kind, units, price, liquidity, netUsdc }) {
  position.cashflows ||= [];
  position.cashflows.push({
    at: Number(at), kind: String(kind), units: Number(units), price: Number(price),
    liquidity: Number(liquidity), netUsdc: Number(netUsdc),
    fixedCostRate: EXIT_FIXED_COST_RATE, dynamicImpactRate: positionLiquidityImpact(liquidity)
  });
}

function close(position, reason, at, proceeds, units, price, liquidity) {
  if (units > 0) cashflow(position, { at, kind: reason, units, price, liquidity, netUsdc: proceeds });
  position.recoveredUsdc = Number(position.recoveredUsdc || 0) + proceeds;
  position.remainingUnits = 0;
  position.status = 'CLOSED';
  position.closedAt = Number(at);
  position.exitReason = reason;
  position.realizedNetUsdc = position.recoveredUsdc - Number(position.allocatedUsdc || PRINCIPAL_USDC);
  position.conservativeReturn = position.realizedNetUsdc / Number(position.allocatedUsdc || PRINCIPAL_USDC);
}

export function openShadowPosition(position, sample) {
  const price = finite(sample?.price);
  const at = finite(sample?.at);
  const liquidity = finite(sample?.liquidity) ?? finite(position?.factors?.liquidity);
  if (!position || position.cohort !== 'signal' || !(price > 0) || at === null || !(liquidity > 0)) return false;
  if (position.entry?.targetAt && Math.abs(at - Number(position.entry.targetAt)) > 60_000) return false;
  const entryImpact = positionLiquidityImpact(liquidity);
  const units = PRINCIPAL_USDC * (1 - ENTRY_FIXED_COST_RATE) * (1 - entryImpact) / price;
  position.costModelVersion = POSITION_COST_MODEL_VERSION;
  position.exitPolicyVersion = EXIT_POLICY_VERSION;
  position.allocatedUsdc = PRINCIPAL_USDC;
  position.recoveredUsdc = 0;
  position.remainingUnits = units;
  position.initialUnits = units;
  position.cashflows = [{
    at, kind: 'ENTRY', units, price, liquidity, netUsdc: -PRINCIPAL_USDC,
    fixedCostRate: ENTRY_FIXED_COST_RATE, dynamicImpactRate: entryImpact
  }];
  position.entry = {
    ...position.entry, at, price, liquidity, fixedCostRate: ENTRY_FIXED_COST_RATE,
    dynamicImpactRate: entryImpact, source: String(sample.source || 'GMGN_1M_CLOSE')
  };
  position.status = 'OPEN';
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
  return targetNet / (position.remainingUnits * exitMultiplier(liquidity));
}

export function applyExitCandle(position, rawCandle, { exitLiquidity } = {}) {
  const candle = validCandle(rawCandle);
  if (!position || !candle || !['OPEN', 'RUNNER'].includes(position.status) || !(position.remainingUnits > 0)) {
    return { event: null, applied: false };
  }
  const estimateLiquidity = finite(position.entry?.liquidity);
  if (!(estimateLiquidity > 0)) return { event: null, applied: false };

  if (position.status === 'OPEN') {
    const estimatedLow = netLiquidationValue(position, candle.low, estimateLiquidity);
    const estimatedHigh = netLiquidationValue(position, candle.high, estimateLiquidity);
    const candidate = estimatedLow <= STOP_LIQUIDATION_USDC ? 'STOP_LOSS'
      : estimatedHigh >= RECOVERY_LIQUIDATION_USDC ? 'PRINCIPAL_RECOVERY' : null;
    if (!candidate) {
      position.highWaterNetUsdc = Math.max(Number(position.highWaterNetUsdc || 0), estimatedHigh || 0);
      position.lastCandleAt = candle.closeAt;
      return { event: null, applied: true };
    }
    const liquidity = finite(exitLiquidity);
    if (!(liquidity > 0)) return { event: candidate, applied: false, pending: 'EXIT_LIQUIDITY' };
    if (candidate === 'STOP_LOSS') {
      const target = thresholdPrice(position, STOP_LIQUIDATION_USDC, liquidity);
      const fillPrice = candle.open <= target ? candle.open : target;
      const units = position.remainingUnits;
      const proceeds = units * fillPrice * exitMultiplier(liquidity);
      close(position, candidate, candle.openAt, proceeds, units, fillPrice, liquidity);
      return { event: candidate, applied: true };
    }
    const target = thresholdPrice(position, RECOVERY_LIQUIDATION_USDC, liquidity);
    const fillPrice = candle.open >= target ? candle.open : target;
    const perUnit = fillPrice * exitMultiplier(liquidity);
    const units = Math.min(position.remainingUnits, PRINCIPAL_USDC / perUnit);
    const proceeds = Math.min(PRINCIPAL_USDC, units * perUnit);
    cashflow(position, { at: candle.openAt, kind: candidate, units, price: fillPrice, liquidity, netUsdc: proceeds });
    position.remainingUnits -= units;
    position.recoveredUsdc = proceeds;
    position.principalRecoveredAt = candle.openAt;
    position.status = 'RUNNER';
    position.highWaterNetUsdc = netLiquidationValue(position, fillPrice, liquidity);
    position.lastCandleAt = candle.closeAt;
    return { event: candidate, applied: true };
  }

  const estimatedHigh = netLiquidationValue(position, candle.high, estimateLiquidity);
  const highWater = Math.max(Number(position.highWaterNetUsdc || 0), estimatedHigh || 0);
  const trigger = highWater * (1 - TRAILING_DRAWDOWN_RATE);
  const estimatedLow = netLiquidationValue(position, candle.low, estimateLiquidity);
  if (estimatedLow > trigger) {
    position.highWaterNetUsdc = highWater;
    position.lastCandleAt = candle.closeAt;
    return { event: null, applied: true };
  }
  const liquidity = finite(exitLiquidity);
  if (!(liquidity > 0)) return { event: 'TRAILING_DRAWDOWN', applied: false, pending: 'EXIT_LIQUIDITY' };
  const target = thresholdPrice(position, trigger, liquidity);
  const fillPrice = candle.open <= target ? candle.open : target;
  const units = position.remainingUnits;
  const proceeds = units * fillPrice * exitMultiplier(liquidity);
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
    close(position, String(code), exitAt, units * exitPrice * exitMultiplier(exitLiquidity), units, exitPrice, exitLiquidity);
  } else {
    position.remainingUnits = 0;
    position.status = 'CLOSED';
    position.closedAt = exitAt ?? Date.now();
    position.exitReason = String(code);
    position.realizedNetUsdc = Number(position.recoveredUsdc || 0) - Number(position.allocatedUsdc || PRINCIPAL_USDC);
    position.conservativeReturn = -1;
  }
  return true;
}

export function applyTimeoutExit(position, { at, price, liquidity } = {}) {
  const exitAt = finite(at);
  if (!position || !['OPEN', 'RUNNER'].includes(position.status) || exitAt === null
    || exitAt < Number(position.entry?.at || Infinity) + MAX_HOLD_MS) return false;
  return applySafetyExit(position, { at: exitAt, price, liquidity, tradable: true, code: 'EXPERIMENT_TIMEOUT' });
}
