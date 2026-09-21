import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPathCandles, normalizePathCandles, summarizePath
} from '../src/factor-path.mjs';

const bar = (openAt, values = {}) => ({
  openAt,
  closeAt: openAt + 60_000,
  open: 1,
  high: 1.2,
  low: .8,
  close: 1.1,
  ...values
});

test('path normalization rejects future and malformed bars and deduplicates by openAt', () => {
  const bars = normalizePathCandles([
    bar(120_000, { high: 1.4, low: .9, close: 1.2 }),
    bar(60_000, { high: 1.1, close: 1 }),
    bar(120_000, { high: 1.4, low: .9, close: 1.2 }),
    bar(180_000, { high: .7, low: .9, close: 1 }),
    bar(240_000, { high: 1, low: 1, close: 1 })
  ], { now: 240_000 });
  assert.deepEqual(bars.map(row => row.openAt), [60_000, 120_000]);
});

test('path summary reports gaps and derives MAE MFE and drawdown from entry price', () => {
  const path = appendPathCandles(null, [
    bar(60_000, { high: 1.5, low: .8, close: 1.4 }),
    bar(180_000, { open: 1.4, high: 2, low: .7, close: .9 })
  ], { now: 240_000 });
  const result = summarizePath(path, { entryAt: 60_000, entryPrice: 1, throughAt: 240_000 });
  assert.deepEqual(
    { observed: result.observedBars, expected: result.expectedBars, missing: result.missingBars },
    { observed: 2, expected: 3, missing: 1 }
  );
  assert.equal(result.coverage, 2 / 3);
  assert.equal(result.continuous, false);
  assert.equal(result.mfeRate, 1);
  assert.ok(Math.abs(result.maeRate - (-.3)) < 1e-12);
  assert.equal(result.maxDrawdownRate, -.65);
});

test('path append is immutable and idempotent for duplicate bars', () => {
  const input = [bar(60_000)];
  const inputSnapshot = structuredClone(input);
  const first = appendPathCandles(null, input, { now: 120_000 });
  const firstSnapshot = structuredClone(first);
  const second = appendPathCandles(first, input, { now: 120_000 });
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(first, firstSnapshot);
  assert.equal(second.bars.length, 1);
  assert.equal(second.duplicateBars, 1);
});

test('summary ignores candles before entry and after the requested horizon', () => {
  const path = appendPathCandles(null, [
    bar(0, { high: 100, low: .01, close: 1 }),
    bar(60_000, { high: 1.2, low: .9, close: 1.1 }),
    bar(120_000, { high: 1.3, low: .8, close: 1.2 }),
    bar(180_000, { high: 50, low: .02, close: 1 })
  ], { now: 240_000 });
  const result = summarizePath(path, { entryAt: 60_000, entryPrice: 1, throughAt: 180_000 });
  assert.equal(result.observedBars, 2);
  assert.equal(result.coverage, 1);
  assert.ok(Math.abs(result.mfeRate - .3) < 1e-12);
  assert.ok(Math.abs(result.maeRate - (-.2)) < 1e-12);
});

test('empty paths report zero coverage and null return metrics', () => {
  const result = summarizePath(null, { entryAt: 60_000, entryPrice: 1, throughAt: 180_000 });
  assert.deepEqual(result, {
    observedBars: 0,
    expectedBars: 2,
    missingBars: 2,
    coverage: 0,
    continuous: false,
    mfeRate: null,
    mfeAt: null,
    maeRate: null,
    maeAt: null,
    maxDrawdownRate: null,
    lastCloseAt: null
  });
});
