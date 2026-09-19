import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { defaultPolicy } from '../src/policy.mjs';
import { RadarControls } from '../src/local-store.mjs';
import { RadarState } from '../src/state.mjs';
import { defaultSoftStrategy } from '../src/factor-lab.mjs';
import { discoveryScreen } from '../src/scoring.mjs';
import { Scanner, collectionEnvelope, selectExplorationBudget } from '../src/scanner.mjs';

test('factor weights change ranking but never change discovery safety rejection', () => {
  const row = {
    address: '0x0000000000000000000000000000000000000001', market_cap: 50_000,
    liquidity: 10_000, creation_timestamp: 1_000, holder_count: 100, volume_1h: 10_000,
    rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1, is_wash_trading: false, is_honeypot: false
  };
  const settings = { ...config, chain: 'bsc', minAgeSec: 300, maxAgeSec: 10_000, factorWeights: { priorityBand: 70 } };
  assert.equal(discoveryScreen(row, settings, 2_000).score, 100);
  const unsafe = discoveryScreen({ ...row, is_honeypot: true }, settings, 2_000);
  assert.equal(unsafe.pass, false);
  assert.ok(unsafe.reasons.includes('检测到貔貅盘'));
});

test('audit budget reserves 20 percent for exploration and fills unused slots from main', () => {
  const now = 10_000;
  const queue = [
    ...Array.from({ length: 8 }, (_, i) => ({ address: `main-${i}`, firstSeenAt: i, nextAuditAt: 0, score: 100-i, exploration: false })),
    ...Array.from({ length: 2 }, (_, i) => ({ address: `explore-${i}`, firstSeenAt: i, nextAuditAt: 0, score: 10-i, exploration: true }))
  ];
  const selected = selectExplorationBudget(queue, new Set(queue.map(row => row.address)), now, 1, 5);
  assert.equal(selected.length, 5);
  assert.equal(selected.filter(row => row.exploration).length, 1);
  const mainOnly = queue.filter(row => !row.exploration);
  assert.equal(selectExplorationBudget(mainOnly, new Set(mainOnly.map(row => row.address)), now, 1, 5).length, 5);
});

test('collection envelope is wider than champion soft thresholds but remains bounded', () => {
  const envelope = collectionEnvelope({
    discoveryMinMarketCap: 10_000, discoveryMaxMarketCap: 150_000,
    minLiquidity: 3_000, minAgeSec: 300, maxAgeSec: 604_800
  });
  assert.deepEqual({ min: envelope.discoveryMinMarketCap, max: envelope.discoveryMaxMarketCap, liquidity: envelope.minLiquidity, age: envelope.minAgeSec },
    { min: 5_000, max: 300_000, liquidity: 1_500, age: 150 });
});

test('scanner snapshots effective strategy, records every audited cohort and samples the factor lab', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-scanner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new RadarState(dir);
  const controls = new RadarControls(dir, config.supportedChains, 'bsc');
  state.value.activeChain = 'bsc';
  const seen = { recorded: [], collected: 0, discoverySettings: null };
  const factorLab = {
    effectiveStrategy: () => defaultSoftStrategy(defaultPolicy()),
    recordCandidate(row, options) { seen.recorded.push({ status: row.status, exploration: options.exploration }); },
    async collect() { seen.collected += 1; },
    summary: () => ({ enabled: true, tracked: seen.recorded.length, championVersion: 'v1' })
  };
  const gmgn = {
    keyEpoch: 0, nextAllowedAt: 0, disabled: false, metrics: {}, configured: async () => true,
    discover: async (_chain, settings) => {
      seen.discoverySettings = settings;
      return [{
        address: '0x0000000000000000000000000000000000000001', symbol: 'DOG', price: 1,
        market_cap: 50_000, liquidity: 10_000, creation_timestamp: Date.now()/1000-1000,
        rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1, is_wash_trading: false, is_honeypot: false
      }];
    },
    audit: async () => ({ info: { price: { price: '1' } }, security: { owner_renounced: 'no' }, pool: {}, holders: [], traders: [], candles: [], _meta: { complete: true } })
  };
  const scanner = new Scanner({ gmgn, state, controls, factorLab, settings: config });
  await scanner.cycle();
  assert.equal(seen.discoverySettings.discoveryMinMarketCap, 5_000);
  assert.equal(seen.recorded.length, 1);
  assert.equal(seen.recorded[0].status, 'HARD_REJECT');
  assert.equal(seen.collected, 1);
  assert.equal(state.value.factorLabSummary.tracked, 1);
});
