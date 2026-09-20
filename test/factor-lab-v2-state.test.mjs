import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactorLab, FACTOR_LAB_VERSION } from '../src/factor-lab.mjs';
import { defaultPolicy } from '../src/policy.mjs';
import { openShadowPosition } from '../src/shadow-position.mjs';

const row = (overrides = {}) => ({
  chain: 'bsc', address: '0x0000000000000000000000000000000000000001', symbol: 'DOG',
  status: 'X_REVIEW', marketCap: 40_000, liquidity: 10_000, ageSec: 600,
  discoveryScore: 80, holders: 100, volume1h: 20_000, priorityBand: true,
  deep: { failed: [], blockingUnknownFields: [] },
  ...overrides
});

test('V2 persists capital positions separately from zero-capital reference samples', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v2-state-'));
  try {
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 1 });
    lab.recordCandidate(row({ status: 'WAIT_RECHECK', experimentEligible: true, evidenceTier: 'incomplete' }), { now: 1 });
    lab.recordCandidate(row({
      address: '0x0000000000000000000000000000000000000002',
      status: 'WAIT_RECHECK', experimentEligible: false
    }), { now: 2 });
    lab.save();
    assert.equal(lab.state.version, 2);
    assert.equal(lab.state.positions.length, 1);
    assert.equal(lab.state.positions[0].notionalUsdc, 100);
    assert.equal(lab.state.referenceSamples.length, 1);
    assert.equal(lab.state.referenceSamples[0].notionalUsdc, 0);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'factor-lab.json'), 'utf8'));
    assert.equal(persisted.version, 2);
    assert.equal(Array.isArray(persisted.positions), true);
    assert.equal(Array.isArray(persisted.referenceSamples), true);
    assert.equal(Array.isArray(persisted.reports), true);
    assert.equal(Object.hasOwn(persisted, 'trades'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V1 history migrates to fixed-horizon references without fabricating positions or exits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v1-migrate-'));
  try {
    fs.writeFileSync(path.join(dir, 'factor-lab.json'), JSON.stringify({
      version: 1,
      trades: [
        { id: 'old-signal', cohort: 'signal', chain: 'bsc', address: '0x1', signalAt: 1, samples: { m5: { conservativeReturn: .1 } } },
        { id: 'old-control', cohort: 'control', chain: 'bsc', address: '0x2', signalAt: 2, samples: {} }
      ],
      history: []
    }));
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 10 });
    assert.equal(FACTOR_LAB_VERSION, 2);
    assert.equal(lab.state.positions.length, 0);
    assert.equal(lab.state.referenceSamples.length, 2);
    assert.ok(lab.state.referenceSamples.every(item => item.legacyFixedHorizonOnly === true));
    assert.ok(lab.state.referenceSamples.every(item => item.exitReason === undefined));
    assert.equal(lab.state.trades.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('open positions consume the read budget first and one OHLC path fills due horizons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v2-collect-'));
  try {
    let now = 400_000;
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => now });
    const position = lab.recordCandidate(row(), { now: 1 });
    openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 });
    lab.recordCandidate(row({
      address: '0x0000000000000000000000000000000000000002',
      status: 'WAIT_RECHECK', experimentEligible: false
    }), { now: 2 });
    const calls = { paths: 0, prices: 0 };
    const gmgn = {
      disabled: false, nextAllowedAt: 0,
      async candlesBetween() {
        calls.paths++;
        return [
          { openAt: 300_000, closeAt: 360_000, open: 1, high: 1.2, low: .9, close: 1.1, source: 'GMGN_1M_OHLC' }
        ];
      },
      async priceAt() { calls.prices++; return null; }
    };
    await lab.collect(gmgn, { limit: 1, now: () => now });
    assert.equal(calls.paths, 1);
    assert.equal(calls.prices, 0);
    assert.equal(position.samples.m5.price, 1.1);
    assert.equal(position.status, 'OPEN');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a confirmed hard safety failure closes an existing experimental position', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v2-safety-'));
  try {
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 120_000 });
    const position = lab.recordCandidate(row(), { now: 1 });
    openShadowPosition(position, { at: 60_000, price: 1, liquidity: 10_000 });
    lab.recordCandidate(row({ status: 'HARD_REJECT', price: .8, liquidity: 9_000 }), { now: 120_000 });
    assert.equal(position.status, 'CLOSED');
    assert.equal(position.exitReason, 'SAFETY_HARD_REJECT');
    assert.ok(position.recoveredUsdc > 0 && position.recoveredUsdc < 100);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
