import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactorLab } from '../src/factor-lab.mjs';
import { defaultPolicy } from '../src/policy.mjs';

function completedPosition(index, overrides = {}) {
  return {
    id: 'p-' + index, chain: 'bsc', address: '0x' + String(index).padStart(40, '0'), symbol: 'P' + index,
    cohort: 'signal', evidenceTier: 'incomplete', notionalUsdc: 100, allocatedUsdc: 100,
    signalAt: index, strategyVersion: 'v1', status: 'CLOSED', entry: { at: 1, price: 1, liquidity: 10_000 },
    recoveredUsdc: 110, remainingUnits: 0, exitReason: 'TRAILING_DRAWDOWN', closedAt: 100,
    samples: {
      m5: { conservativeReturn: .05 }, m10: { conservativeReturn: .08 }, m15: { conservativeReturn: .1 }
    },
    factors: {}, ...overrides
  };
}

test('stage reports require 20 new completed 15m signals and a six-hour gap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-report-stage-'));
  try {
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 1 });
    lab.state.trades.push(...Array.from({ length: 19 }, (_, i) => completedPosition(i)));
    assert.deepEqual(lab.reportTick(6 * 60 * 60_000), []);
    lab.state.trades.push(completedPosition(20));
    const created = lab.reportTick(6 * 60 * 60_000 + 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].type, 'STAGE');
    assert.equal(created[0].completed15m, 20);
    assert.equal(lab.reportTick(6 * 60 * 60_000 + 2).length, 0);
    lab.state.trades.push(...Array.from({ length: 20 }, (_, i) => completedPosition(100 + i)));
    assert.equal(lab.reportTick(11 * 60 * 60_000).length, 0);
    assert.equal(lab.reportTick(12 * 60 * 60_000 + 2)[0].completed15m, 40);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('daily reports are immutable snapshots and capital summary uses positions only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-report-daily-'));
  try {
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 1 });
    lab.state.trades.push(
      completedPosition(1),
      completedPosition(2, { status: 'RUNNER', recoveredUsdc: 100, remainingUnits: 20, exitReason: undefined, closedAt: undefined }),
      { ...completedPosition(3), cohort: 'control', notionalUsdc: 0, allocatedUsdc: undefined, recoveredUsdc: undefined }
    );
    const daily = lab.reportTick(24 * 60 * 60_000 + 1).find(report => report.type === 'DAILY');
    assert.ok(daily);
    const frozen = structuredClone(daily);
    const summary = lab.summary(24 * 60 * 60_000 + 2);
    lab.state.trades[0].recoveredUsdc = 999;
    assert.deepEqual(daily, frozen);

    assert.deepEqual(summary.capital, {
      positionCount: 2, allocatedUsdc: 200, openPositions: 1,
      unrecoveredPrincipalUsdc: 0, principalRecovered: 2, realizedNetUsdc: 10
    });
    assert.equal(summary.exits.trailingRate, .5);
    assert.equal(summary.reportProgress.nextStageCompleted15m, 20);
    assert.equal(summary.reportProgress.completed15m, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
