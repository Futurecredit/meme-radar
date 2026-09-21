import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactorLab } from '../../src/factor-lab.mjs';
import { defaultPolicy } from '../../src/policy.mjs';

const prefix = 'meme-radar-data-trust-';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const candidate = (status, address, extra = {}) => ({
  chain: 'bsc', address, symbol: status === 'X_REVIEW' ? 'SIG' : 'CTL', status,
  experimentEligible: status === 'X_REVIEW', evidenceTier: 'incomplete',
  marketCap: 40_000, liquidity: 10_000, ageSec: 600, discoveryScore: 80,
  holders: 100, volume1h: 20_000, priorityBand: true,
  deep: { failed: [], blockingUnknownFields: [] },
  ...extra
});

try {
  let now = 1;
  let lab = new FactorLab(temporary, { policy: defaultPolicy(), now: () => now });
  const signal = lab.recordCandidate(candidate('X_REVIEW', '0x' + '1'.repeat(40), { secretSentinel: 'NEVER_EXPORT_ME' }), { now: 1 });
  const control = lab.recordCandidate(candidate('WAIT_RECHECK', '0x' + '2'.repeat(40)), { now: 2 });
  assert.equal(signal.matchedTradeId, control.id);
  assert.equal(control.matchedTradeId, signal.id);
  for (const row of [signal, control]) {
    row.entry = { targetAt: 60_000, at: 60_000, price: 1, liquidity: 10_000, source: 'FIXTURE' };
    row.portfolioStatus = 'SKIPPED_CAPACITY';
    row.portfolioStakeUsdc = 0;
  }
  now = 1_000_000;
  const unordered = [
    { openAt: 900_000, closeAt: 960_000, open: 1.4, high: 1.5, low: .85, close: .9 },
    { openAt: 300_000, closeAt: 360_000, open: 1.2, high: 1.25, low: .7, close: .8 },
    { openAt: 120_000, closeAt: 180_000, open: 1, high: 1.3, low: .9, close: 1.2 },
    { openAt: 120_000, closeAt: 180_000, open: 1, high: 1.3, low: .9, close: 1.2 },
    { openAt: 600_000, closeAt: 660_000, open: .8, high: 1.6, low: .75, close: 1.4 }
  ];
  await lab.collect({ disabled: false, nextAllowedAt: 0,
    async candlesBetween() { return unordered; }
  }, { limit: 2, now: () => now });
  const before = { ...signal.path };
  assert.ok(before.observedBars > 0 && before.coverage > 0 && before.coverage < 1);
  assert.ok(before.maeRate < 0 && before.mfeRate > 0);

  lab = new FactorLab(temporary, { policy: defaultPolicy(), now: () => now });
  const restored = lab.state.trades.find(row => row.id === signal.id);
  assert.equal(restored.matchedTradeId, control.id);
  assert.equal(restored.path.coverage, before.coverage);
  assert.equal(restored.path.maeRate, before.maeRate);
  assert.equal(restored.path.mfeRate, before.mfeRate);
  assert.equal(lab.automationTick(now).action, 'collect_only');
  const exported = JSON.stringify(lab.exportPublic());
  assert.doesNotMatch(exported, /"bars"|NEVER_EXPORT_ME|privateKey|providerPayload|[A-Z]:\\/i);
  process.stdout.write(JSON.stringify({ ok: true, trades: lab.state.trades.length,
    matchedPairs: lab.summary(now).matchedPairs, pathCoverage: restored.path.coverage, collectOnly: true }) + '\n');
} finally {
  const resolved = path.resolve(temporary);
  const root = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(root) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('unsafe_temporary_cleanup');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
