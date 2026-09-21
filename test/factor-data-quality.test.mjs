import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataQualitySummary } from '../src/factor-data-quality.mjs';

test('quality gate names matched pairs as the strongest blocker after complete paths', () => {
  const trades = Array.from({ length: 22 }, (_, index) => ({
    id: String(index).padStart(32, '0'),
    cohort: 'signal',
    signalAt: index * 60_000,
    entry: { at: index * 60_000, price: 1 },
    samples: {
      m5: { conservativeReturn: .01 },
      m10: { conservativeReturn: .01 },
      m15: { conservativeReturn: .01 }
    },
    path: { observedBars: 15, expectedBars: 15, coverage: 1 }
  }));
  const quality = buildDataQualitySummary(trades, { now: 2_000_000 });
  assert.equal(quality.phase, 'DATA_TRUST');
  assert.equal(quality.collectOnly, true);
  assert.equal(quality.canGenerateCandidate, false);
  assert.equal(quality.canPromote, false);
  assert.equal(quality.primaryBlocker, 'MATCHED_PAIRS');
  assert.deepEqual(quality.targets, {
    completed15m: 100, matchedPairs: 40, horizonCoverage: .8, pathCoverage: .8
  });
  assert.equal(quality.remaining.completed15m, 78);
  assert.equal(quality.remaining.matchedPairs, 40);
});

test('malformed rows and missing path metadata lower coverage without throwing', () => {
  const quality = buildDataQualitySummary([null, {}, {
    id: 'a'.repeat(32), cohort: 'signal', entry: { at: 60_000, price: 1 }, samples: {}
  }], { now: 2_000_000 });
  assert.equal(quality.completed15m, 0);
  assert.equal(quality.pathCoverage, 0);
  assert.equal(quality.coverage.m15.rate, 0);
  assert.ok(quality.reasons.includes('PATH_COVERAGE'));
  assert.ok(Object.values(quality.remaining).every(value => Number(value) >= 0));
});

test('active source failures outrank sample-count blockers', () => {
  const quality = buildDataQualitySummary([{
    id: 'b'.repeat(32), cohort: 'signal', entry: { at: 60_000, price: 1 }, samples: {},
    path: { observedBars: 0, expectedBars: 15, coverage: 0, lastFailureCode: 'TIMEOUT' }
  }], { now: 2_000_000 });
  assert.equal(quality.primaryBlocker, 'SOURCE_INTEGRITY');
  assert.equal(quality.sourceFailures, 1);
});
