import test from 'node:test';
import assert from 'node:assert/strict';

async function positionModule() {
  try { return await import('../src/shadow-position.mjs'); }
  catch { return {}; }
}

const trade = () => ({
  id: 'signal-1', cohort: 'signal', notionalUsdc: 100, signalAt: 1,
  factors: { liquidity: 10_000 }, entry: { targetAt: 60_000 },
  samples: {}, retries: {}
});
const candle = (overrides = {}) => ({
  openAt: 60_000, closeAt: 120_000, open: 1, high: 1, low: 1, close: 1,
  ...overrides
});

test('V2 entry invests 100 USDC with split fixed cost and entry impact', async () => {
  const { openShadowPosition } = await positionModule();
  assert.equal(typeof openShadowPosition, 'function');
  const position = trade();
  assert.equal(openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 }), true);
  assert.equal(position.costModelVersion, 2);
  assert.equal(position.exitPolicyVersion, 1);
  assert.equal(position.entry.fixedCostRate, .015);
  assert.ok(Math.abs(position.remainingUnits - 96.53) < 1e-9);
  assert.equal(position.allocatedUsdc, 100);
  assert.equal(position.recoveredUsdc, 0);
  assert.equal(position.status, 'OPEN');
});

test('stop loss exits all at 70 net liquidation and gap uses worse open', async () => {
  const { openShadowPosition, applyExitCandle } = await positionModule();
  const position = trade();
  openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 });
  const stopped = applyExitCandle(position, candle({ openAt: 120_000, closeAt: 180_000, open: .9, high: 1, low: .6, close: .7 }), { exitLiquidity: 10_000 });
  assert.equal(stopped.event, 'STOP_LOSS');
  assert.ok(Math.abs(position.recoveredUsdc - 70) < 1e-6);
  assert.equal(position.remainingUnits, 0);
  assert.equal(position.status, 'CLOSED');

  const gap = trade();
  openShadowPosition(gap, { at: 60_000, price: 1, liquidity: 10_000 });
  applyExitCandle(gap, candle({ openAt: 120_000, closeAt: 180_000, open: .5, high: .8, low: .4, close: .6 }), { exitLiquidity: 10_000 });
  assert.ok(gap.recoveredUsdc < 70);
  assert.equal(gap.exitReason, 'STOP_LOSS');
});

test('same candle stop and principal recovery resolves stop first', async () => {
  const { openShadowPosition, applyExitCandle } = await positionModule();
  const position = trade();
  openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 });
  const result = applyExitCandle(position, candle({ openAt: 120_000, closeAt: 180_000, open: 1, high: 3, low: .5, close: 2 }), { exitLiquidity: 10_000 });
  assert.equal(result.event, 'STOP_LOSS');
  assert.equal(position.principalRecoveredAt, undefined);
});

test('net doubling recovers exactly principal then 35 percent drawdown exits remainder', async () => {
  const { openShadowPosition, applyExitCandle } = await positionModule();
  const position = trade();
  openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 });
  const recovery = applyExitCandle(position, candle({ openAt: 120_000, closeAt: 180_000, open: 1.5, high: 2.5, low: 1.4, close: 2.2 }), { exitLiquidity: 10_000 });
  assert.equal(recovery.event, 'PRINCIPAL_RECOVERY');
  assert.ok(Math.abs(position.recoveredUsdc - 100) < 1e-9);
  assert.ok(position.remainingUnits > 0);
  assert.equal(position.status, 'RUNNER');

  const high = applyExitCandle(position, candle({ openAt: 180_000, closeAt: 240_000, open: 2.2, high: 3, low: 2.2, close: 2.8 }), { exitLiquidity: 10_000 });
  assert.equal(high.event, null);
  const trailing = applyExitCandle(position, candle({ openAt: 240_000, closeAt: 300_000, open: 2.8, high: 2.9, low: 1.7, close: 1.8 }), { exitLiquidity: 10_000 });
  assert.equal(trailing.event, 'TRAILING_DRAWDOWN');
  assert.equal(position.status, 'CLOSED');
  assert.ok(position.recoveredUsdc > 100);
});

test('detected exit waits for a real liquidity snapshot instead of estimating history', async () => {
  const { openShadowPosition, applyExitCandle } = await positionModule();
  const position = trade();
  openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 });
  const before = structuredClone(position);
  const result = applyExitCandle(position, candle({ openAt: 120_000, closeAt: 180_000, open: .8, high: .9, low: .5, close: .6 }), { exitLiquidity: null });
  assert.equal(result.pending, 'EXIT_LIQUIDITY');
  assert.equal(position.remainingUnits, before.remainingUnits);
  assert.equal(position.status, 'OPEN');
});

test('safety loss and 24 hour timeout close conservatively without future backfill', async () => {
  const { openShadowPosition, applySafetyExit, applyTimeoutExit } = await positionModule();
  const unsafe = trade();
  openShadowPosition(unsafe, { at: 60_000, price: 1, liquidity: 10_000 });
  applySafetyExit(unsafe, { at: 120_000, tradable: false, code: 'POOL_REMOVED' });
  assert.equal(unsafe.status, 'CLOSED');
  assert.equal(unsafe.conservativeReturn, -1);
  assert.equal(unsafe.exitReason, 'POOL_REMOVED');

  const timed = trade();
  openShadowPosition(timed, { at: 60_000, price: 1, liquidity: 10_000 });
  assert.equal(applyTimeoutExit(timed, { at: 60_000 + 24 * 60 * 60_000 - 1, price: 2, liquidity: 10_000 }), false);
  assert.equal(applyTimeoutExit(timed, { at: 60_000 + 24 * 60 * 60_000, price: 2, liquidity: 10_000 }), true);
  assert.equal(timed.exitReason, 'EXPERIMENT_TIMEOUT');
  assert.equal(timed.status, 'CLOSED');
});
