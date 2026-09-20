import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { defaultPolicy, runtimePolicy } from '../src/policy.mjs';
import { discoveryScreen } from '../src/scoring.mjs';
import { FactorLab } from '../src/factor-lab.mjs';
import { classifyDeepResult } from '../src/scanner.mjs';

const baseRow = {
  address: '0x0000000000000000000000000000000000000001',
  symbol: 'DOG',
  market_cap: 50_000,
  liquidity: 10_000,
  creation_timestamp: 1_000
};

test('unknown discovery safety evidence proceeds to deep audit while explicit fatal evidence rejects', () => {
  const settings = { ...config, ...runtimePolicy(defaultPolicy()), chain: 'bsc' };
  const unknown = discoveryScreen(baseRow, settings, 2_000);
  assert.equal(unknown.pass, true);
  assert.deepEqual(unknown.reasons, []);
  assert.deepEqual(unknown.unknownFields.sort(), ['bundler', 'honeypot', 'insider', 'rugRatio', 'wash']);

  for (const [field, value, reason] of [
    ['rug_ratio', .31, 'rug风险过高'],
    ['bundler_rate', .31, '捆绑机器人占比过高'],
    ['rat_trader_amount_rate', .31, '内幕/老鼠仓占比过高'],
    ['is_wash_trading', true, '检测到刷量'],
    ['is_honeypot', true, '检测到貔貅盘']
  ]) {
    const screened = discoveryScreen({ ...baseRow, [field]: value }, settings, 2_000);
    assert.equal(screened.pass, false, field);
    assert.ok(screened.reasons.includes(reason), field);
  }
});

test('incomplete safe evidence becomes an experimental signal while controls and fatal samples receive no capital', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-v2-'));
  try {
    const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 1 });
    const common = {
      chain: 'bsc', marketCap: 50_000, liquidity: 10_000, ageSec: 600,
      discoveryScore: 50, holders: 20, volume1h: 5_000, priorityBand: true,
      deep: { failed: [], blockingUnknownFields: ['buyTax'] }
    };
    const incomplete = lab.recordCandidate({
      ...common, address: baseRow.address, symbol: 'INC', status: 'WAIT_RECHECK',
      experimentEligible: true, evidenceTier: 'incomplete'
    }, { now: 1 });
    const control = lab.recordCandidate({
      ...common, address: '0x0000000000000000000000000000000000000002', symbol: 'CTL',
      status: 'WAIT_RECHECK', experimentEligible: false
    }, { now: 2 });
    const fatal = lab.recordCandidate({
      ...common, address: '0x0000000000000000000000000000000000000003', symbol: 'BAD',
      status: 'HARD_REJECT'
    }, { now: 3, forceHardRejectSample: true });

    assert.equal(incomplete.cohort, 'signal');
    assert.equal(incomplete.evidenceTier, 'incomplete');
    assert.equal(incomplete.notionalUsdc, 100);
    assert.equal(control.cohort, 'control');
    assert.equal(control.notionalUsdc, 0);
    if (fatal) assert.equal(fatal.notionalUsdc, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('funnel summary separates formal, experimental, control and hard-reject outcomes and ranks loss reasons', async () => {
  const { summarizeFunnel } = await import('../src/scanner.mjs');
  assert.equal(typeof summarizeFunnel, 'function');
  const summary = summarizeFunnel({
    discovered: 6,
    screened: [
      { screen: { pass: true, reasons: [] } },
      { screen: { pass: true, reasons: [] } },
      { screen: { pass: false, reasons: ['流动性不足'] } },
      { screen: { pass: false, reasons: ['流动性不足', '超过观察年龄上限'] } }
    ],
    candidates: [
      { status: 'X_REVIEW', experimentEligible: true },
      { status: 'WAIT_RECHECK', experimentEligible: true },
      { status: 'WAIT_RECHECK', experimentEligible: false },
      { status: 'HARD_REJECT', experimentEligible: false }
    ]
  });
  assert.deepEqual(summary.counts, {
    discovered: 6, prequalified: 2, deepAudited: 4, formalCandidates: 1,
    experimentalSignals: 2, controls: 1, hardRejects: 1
  });
  assert.deepEqual(summary.scopes, {
    currentCycle: ['discovered', 'prequalified'],
    recentAuditWindow: ['deepAudited', 'formalCandidates', 'experimentalSignals', 'controls', 'hardRejects']
  });
  assert.deepEqual(summary.lossReasons[0], { reason: '流动性不足', count: 2 });
});

test('funnel recent audit counts exclude candidates older than thirty minutes', async () => {
  const { summarizeFunnel } = await import('../src/scanner.mjs');
  const now = 2_000_000;
  const summary = summarizeFunnel({
    discovered: 0,
    screened: [],
    now,
    candidates: [
      { status: 'X_REVIEW', experimentEligible: true, auditedAt: now - 29 * 60_000 },
      { status: 'HARD_REJECT', experimentEligible: false, auditedAt: now - 31 * 60_000 }
    ]
  });
  assert.equal(summary.counts.deepAudited, 1);
  assert.equal(summary.counts.formalCandidates, 1);
  assert.equal(summary.counts.hardRejects, 0);
});

test('one explicit fatal safety value cannot be softened by a related unknown field', () => {
  const tax = classifyDeepResult({
    chainPass: false, failed: ['tax'], blockingUnknownFields: ['buyTax'],
    explicitFatalChecks: ['tax'], security: { buyTax: null, sellTax: .99 }
  });
  assert.equal(tax.status, 'HARD_REJECT');
  assert.deepEqual(tax.hardFailed, ['tax']);

  const solAuthority = classifyDeepResult({
    chainPass: false, failed: ['ownerRenounced'], blockingUnknownFields: ['renouncedMint'],
    explicitFatalChecks: ['ownerRenounced'], security: { renouncedMint: null, renouncedFreezeAccount: false }
  });
  assert.equal(solAuthority.status, 'HARD_REJECT');
});
