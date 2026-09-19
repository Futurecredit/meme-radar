import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FactorLab,
  applyPriceSample,
  candidateMutations,
  createShadowTrade,
  deterministicBootstrap,
  defaultSoftStrategy,
  dueShadowJobs,
  evaluatePromotion,
  matchControl,
  shadowReturn
} from '../src/factor-lab.mjs';

const policy = {
  version: 1,
  discovery: {
    minMarketCap: 10_000, maxMarketCap: 150_000,
    priorityMinMarketCap: 20_000, priorityMaxMarketCap: 80_000,
    minLiquidity: 3_000, strictLiquidity: 8_000,
    minAgeMinutes: 5, maxAgeMinutes: 10_080
  },
  live: { minMarketCap: 10_000, maxMarketCap: 500_000, minLiquidity: 3_000, minAgeMinutes: 5 },
  scan: { intervalSeconds: 120, maxDeepAuditsPerCycle: 6 }
};

function candidate(overrides = {}) {
  return {
    chain: 'sol', address: '11111111111111111111111111111111', symbol: 'DOG',
    status: 'X_REVIEW', marketCap: 40_000, liquidity: 10_000, ageSec: 900,
    discoveryScore: 80, holders: 120, volume1h: 30_000, priorityBand: true,
    deep: { failed: [], security: { buyTax: 0, sellTax: 0 }, marketBehavior: { smartWallets: 3, kolOnly: false } },
    ...overrides
  };
}

test('shadow trade enters on first completed minute and applies 3% plus liquidity impact', () => {
  const trade = createShadowTrade(candidate(), { cohort: 'signal', signalAt: 61_000, policy, strategy: defaultSoftStrategy(policy) });
  assert.equal(trade.entry.targetAt, 120_000);
  assert.equal(dueShadowJobs([trade], 119_999).length, 0);
  assert.equal(dueShadowJobs([trade], 120_000)[0].kind, 'entry');

  applyPriceSample(trade, { kind: 'entry', targetAt: 120_000 }, { at: 120_000, price: 1 });
  assert.equal(trade.entry.price, 1);
  const five = dueShadowJobs([trade], 420_000).find(job => job.key === 'm5');
  applyPriceSample(trade, five, { at: 420_000, price: 1.1 });
  assert.ok(Math.abs(trade.samples.m5.netReturn - 0.02644) < 1e-9);
  assert.equal(trade.samples.m5.fixedCostRate, 0.03);
  assert.ok(Math.abs(trade.samples.m5.dynamicCostRate - 0.0396) < 1e-9);
});

test('late or missing prices are never backfilled and confirmed untradeable is conservative -100%', () => {
  const trade = createShadowTrade(candidate(), { cohort: 'signal', signalAt: 1, policy, strategy: defaultSoftStrategy(policy) });
  applyPriceSample(trade, { kind: 'entry', targetAt: 60_000 }, { at: 60_000, price: 1 });
  assert.equal(applyPriceSample(trade, { kind: 'exit', key: 'm5', targetAt: 360_000 }, { at: 500_000, price: 2 }), false);
  assert.equal(trade.samples.m5, undefined);
  applyPriceSample(trade, { kind: 'exit', key: 'm5', targetAt: 360_000 }, null, { code: 'UNTRADEABLE', confirmed: true });
  assert.equal(trade.samples.m5.observedReturn, null);
  assert.equal(trade.samples.m5.conservativeReturn, -1);
  assert.equal(trade.samples.m5.missingKind, 'confirmed_untradeable');
});

test('chase risk is retained and a near WAIT_RECHECK control is matched once', () => {
  const signal = createShadowTrade(candidate({ price: 1 }), { cohort: 'signal', signalAt: 600_000, policy, strategy: defaultSoftStrategy(policy) });
  applyPriceSample(signal, { kind: 'entry', targetAt: 660_000 }, { at: 660_000, price: 1.25 });
  assert.equal(signal.chaseRisk, true);

  const controls = [
    createShadowTrade(candidate({ address: '22222222222222222222222222222222', status: 'WAIT_RECHECK', marketCap: 42_000, liquidity: 9_500 }), { cohort: 'control', signalAt: 605_000, policy, strategy: defaultSoftStrategy(policy) }),
    createShadowTrade(candidate({ address: '33333333333333333333333333333333', status: 'WAIT_RECHECK', marketCap: 140_000, liquidity: 3_000 }), { cohort: 'control', signalAt: 605_000, policy, strategy: defaultSoftStrategy(policy) })
  ];
  const matched = matchControl(signal, controls);
  assert.equal(matched.address, '22222222222222222222222222222222');
  assert.equal(matchControl(signal, controls), null);
});

test('controls that later become signals are excluded and samples are versioned per strategy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-contamination-'));
  try {
    const lab = new FactorLab(dir, { policy, now: () => 1 });
    const control = lab.recordCandidate(candidate({ status: 'WAIT_RECHECK' }), { now: 1 });
    const nearby = lab.recordCandidate(candidate({ address: '22222222222222222222222222222222' }), { now: 2 });
    assert.equal(nearby.matchedTradeId, control.id);

    lab.recordCandidate(candidate({ status: 'X_REVIEW' }), { now: 3 });
    assert.equal(control.contaminatedAt, 3);
    assert.equal(control.matchedTradeId, undefined);
    assert.equal(nearby.matchedTradeId, undefined);

    const firstVersionCount = lab.state.trades.filter(row => row.cohort === 'signal').length;
    lab.manualBaseline({ ...policy, discovery: { ...policy.discovery, minMarketCap: 11_000 } }, 4);
    lab.recordCandidate(candidate({ address: '22222222222222222222222222222222' }), { now: 5 });
    assert.equal(lab.state.trades.filter(row => row.cohort === 'signal').length, firstVersionCount + 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('factor quality query applies the requested horizon', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-horizon-'));
  try {
    const lab = new FactorLab(dir, { policy, now: () => 1 });
    const trade = lab.recordCandidate(candidate(), { now: 1 });
    trade.samples.m5 = { conservativeReturn: .2 };
    trade.samples.m10 = { conservativeReturn: -.1 };
    const five = lab.query({ view: 'factors', horizon: 'm5' }).rows;
    const ten = lab.query({ view: 'factors', horizon: 'm10' }).rows;
    assert.ok(five.length > 0);
    assert.ok(five.every(row => row.horizon === 'm5' && row.medianNetReturn === .2));
    assert.ok(ten.every(row => row.horizon === 'm10' && row.medianNetReturn === -.1));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('promotion requires future sample gates, uplift, confidence and protected downside', () => {
  const eligible = evaluatePromotion({
    completed15m: 80, matchedPairs: 40, spanMs: 24 * 60 * 60_000,
    coverage: { m5: .9, m10: .9, m15: .9 },
    weightedMedianUplift: .011, weightedHitRateUplift: .04,
    bootstrapLower: .001, worstP10Regression: .019
  });
  assert.equal(eligible.promote, true);
  assert.deepEqual(eligible.reasons, []);
  const unsafe = evaluatePromotion({
    completed15m: 500, matchedPairs: 200, spanMs: 7 * 24 * 60 * 60_000,
    coverage: { m5: 1, m10: 1, m15: 1 },
    weightedMedianUplift: .5, weightedHitRateUplift: .5,
    bootstrapLower: .2, worstP10Regression: .021
  });
  assert.equal(unsafe.promote, false);
  assert.ok(unsafe.reasons.includes('tail_risk'));
});

test('soft strategy contains no safety gates and return calculation is bounded', () => {
  const strategy = defaultSoftStrategy(policy);
  const encoded = JSON.stringify(strategy);
  assert.doesNotMatch(encoded, /tax|honeypot|owner|lpLocked|insider|bot|linked/i);
  assert.equal(shadowReturn({ entryPrice: 1, exitPrice: 0, entryLiquidity: 10_000 }), -1);
  assert.equal(strategy.discovery.minMarketCap, 10_000);
  assert.equal(strategy.weights.priorityBand, 35);
  const unknown = createShadowTrade(candidate({ priorityBand: undefined, deep: { marketBehavior: {} } }),
    { cohort: 'signal', signalAt: 1, policy, strategy });
  assert.equal(unknown.factors.priorityBand, null);
  assert.equal(unknown.factors.kolOnly, null);
});

test('factor lab persists separately, recovers backup and retains at most 5000 recent trades', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-lab-'));
  try {
    const lab = new FactorLab(dir, { policy, now: () => 10_000 });
    lab.recordCandidate(candidate(), { now: 10_000 });
    assert.equal(lab.state.trades.length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'factor-lab.json')), true);
    lab.save();
    fs.writeFileSync(path.join(dir, 'factor-lab.json'), '{broken');
    const recovered = new FactorLab(dir, { policy, now: () => 20_000 });
    assert.equal(recovered.state.recoveredFromBackup, true);
    assert.equal(recovered.state.trades.length, 1);

    recovered.state.trades = Array.from({ length: 5001 }, (_, i) => ({ id: String(i), signalAt: i, cohort: 'signal', samples: {} }));
    recovered.prune(5002);
    assert.equal(recovered.state.trades.length, 5000);
    assert.equal(recovered.state.trades[0].id, '1');

    recovered.state.trades.push({
      id: 'expired', signalAt: 1, chain: 'sol', cohort: 'signal', strategyVersion: 'v1',
      factors: { liquidity: 10_000, priorityBand: true },
      samples: { m10: { observedReturn: .1, conservativeReturn: .05 } }
    });
    recovered.prune(91 * 24 * 60 * 60_000);
    const archive = recovered.state.aggregates.at(-1);
    assert.equal(archive.type, 'PRUNED');
    assert.equal(archive.groups[0].chain, 'sol');
    assert.equal(archive.groups[0].horizon, 'm10');
    assert.equal(archive.groups[0].medianConservative, .05);
    assert.ok(archive.groups[0].factorBuckets.liquidity);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('candidate generation changes exactly one soft value by 10 percent and rejects safety fields', () => {
  const strategy = defaultSoftStrategy(policy);
  const mutations = candidateMutations(strategy);
  assert.ok(mutations.length > 10);
  for (const mutation of mutations) {
    assert.equal(mutation.changedPaths.length, 1);
    assert.doesNotMatch(mutation.changedPaths[0], /(?:^|\.)(?:tax|honeypot|owner|lpLocked|insider|bot|linked)(?:$|\.)/i);
  }
  const priorityUp = mutations.find(row => row.changedPaths[0] === 'weights.priorityBand' && row.direction === 1);
  assert.equal(priorityUp.strategy.weights.priorityBand, 38.5);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-safety-'));
  try {
    const lab = new FactorLab(dir, { policy, now: () => 1 });
    assert.throws(() => lab.startChallenger({ ...strategy, maxBuyTax: .99 }, 2), /invalid_soft_strategy/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deterministic bootstrap is repeatable and automatic promotion can roll back', () => {
  const one = deterministicBootstrap([.02, .03, .01, .04], 'experiment-a', 1_000);
  const two = deterministicBootstrap([.02, .03, .01, .04], 'experiment-a', 1_000);
  assert.deepEqual(one, two);
  assert.ok(one.lower > 0);
  const stratified = deterministicBootstrap([
    { value: .01, stratum: 'sol:1' }, { value: .03, stratum: 'sol:1' },
    { value: .02, stratum: 'base:1' }, { value: .04, stratum: 'base:1' }
  ], 'stratified', 1_000);
  assert.equal(stratified.strata, 2);
  assert.deepEqual(stratified, deterministicBootstrap([
    { value: .01, stratum: 'sol:1' }, { value: .03, stratum: 'sol:1' },
    { value: .02, stratum: 'base:1' }, { value: .04, stratum: 'base:1' }
  ], 'stratified', 1_000));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-promotion-'));
  try {
    const lab = new FactorLab(dir, { policy, now: () => 1 });
    const original = lab.state.champion.version;
    const challenger = candidateMutations(lab.effectiveStrategy())[0].strategy;
    lab.startChallenger(challenger, 2);
    const promoted = lab.evaluateChallenger({
      completed15m: 80, matchedPairs: 40, spanMs: 24 * 60 * 60_000,
      coverage: { m5: .9, m10: .9, m15: .9 }, weightedMedianUplift: .02,
      weightedHitRateUplift: .04, bootstrapLower: .01, worstP10Regression: 0
    }, 3);
    assert.equal(promoted.promoted, true);
    assert.notEqual(lab.state.champion.version, original);
    assert.equal(lab.state.previousChampion.version, original);
    const rolled = lab.evaluateRollback({ completed: 40, weightedMedianUplift: -.021, coverage: .9 }, 4);
    assert.equal(rolled.rolledBack, true);
    assert.equal(lab.state.champion.version, original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mature failed challengers release the slot and manual baselines preserve audit reasons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-audit-'));
  try {
    const lab = new FactorLab(dir, { policy, now: () => 1 });
    lab.startChallenger(candidateMutations(lab.effectiveStrategy())[0].strategy, 2);
    const rejected = lab.evaluateChallenger({
      completed15m: 80, matchedPairs: 40, spanMs: 24 * 60 * 60_000,
      coverage: { m5: .9, m10: .9, m15: .9 }, weightedMedianUplift: 0,
      weightedHitRateUplift: 0, bootstrapLower: -.01, worstP10Regression: 0
    }, 3);
    assert.equal(rejected.rejected, true);
    assert.equal(lab.state.challenger, null);
    assert.equal(lab.state.history.at(-1).type, 'CHALLENGER_REJECTED');

    lab.startChallenger(candidateMutations(lab.effectiveStrategy())[1].strategy, 4);
    lab.manualBaseline(policy, 5);
    assert.equal(lab.state.history.at(-2).reason, 'manual_override');
    assert.equal(lab.state.history.at(-1).type, 'MANUAL_BASELINE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
