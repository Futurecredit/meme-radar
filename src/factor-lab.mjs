import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJsonWithBackup, tokenKey } from './local-store.mjs';

export const FACTOR_LAB_VERSION = 1;
export const FACTOR_SCHEMA_VERSION = 1;
export const COST_MODEL_VERSION = 1;
export const SHADOW_NOTIONAL_USDC = 100;
export const FIXED_ROUND_TRIP_COST = 0.03;
export const SHADOW_HORIZONS = Object.freeze({
  m5: 5 * 60_000,
  m10: 10 * 60_000,
  m15: 15 * 60_000,
  m30: 30 * 60_000,
  h1: 60 * 60_000,
  h2: 2 * 60 * 60_000,
  h24: 24 * 60 * 60_000
});

const DAY = 24 * 60 * 60_000;
const RETENTION_MS = 90 * DAY;
const MAX_TRADES = 5_000;
const MAIN_HORIZONS = Object.freeze(['m5', 'm10', 'm15']);
const WEIGHTS = Object.freeze({ m5: 0.25, m10: 0.5, m15: 0.25 });
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)))];
};

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

export function defaultSoftStrategy(policy) {
  return Object.freeze({
    version: 1,
    discovery: Object.freeze({ ...clone(policy.discovery) }),
    weights: Object.freeze({
      priorityBand: 35,
      ordinaryBand: 10,
      liquidityCap: 25,
      liquidityDivisor: 1_000,
      volumeCap: 20,
      volumeDivisor: 1_000,
      holdersCap: 20,
      holdersDivisor: 10,
      smartTwo: 7,
      smartThree: 14,
      kolPenalty: 4
    })
  });
}

export function strategyFingerprint(strategy) {
  return hash(JSON.stringify(strategy)).slice(0, 24);
}

const DISCOVERY_KEYS = Object.freeze([
  'minMarketCap', 'maxMarketCap', 'priorityMinMarketCap', 'priorityMaxMarketCap',
  'minLiquidity', 'strictLiquidity', 'minAgeMinutes', 'maxAgeMinutes'
]);
const WEIGHT_KEYS = Object.freeze([
  'priorityBand', 'ordinaryBand', 'liquidityCap', 'liquidityDivisor',
  'volumeCap', 'volumeDivisor', 'holdersCap', 'holdersDivisor',
  'smartTwo', 'smartThree', 'kolPenalty'
]);
const MUTABLE_WEIGHT_KEYS = Object.freeze([
  'priorityBand', 'ordinaryBand', 'liquidityCap', 'volumeCap',
  'holdersCap', 'smartTwo', 'smartThree', 'kolPenalty'
]);

function requireExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validateSoftStrategy(strategy) {
  if (!requireExactKeys(strategy, ['version', 'discovery', 'weights']) || strategy.version !== 1
    || !requireExactKeys(strategy.discovery, DISCOVERY_KEYS) || !requireExactKeys(strategy.weights, WEIGHT_KEYS)) return false;
  if ([...DISCOVERY_KEYS.map(key => strategy.discovery[key]), ...WEIGHT_KEYS.map(key => strategy.weights[key])]
    .some(value => !Number.isFinite(value) || value < 0)) return false;
  const d = strategy.discovery;
  return d.minMarketCap < d.maxMarketCap
    && d.priorityMinMarketCap >= d.minMarketCap
    && d.priorityMaxMarketCap <= d.maxMarketCap
    && d.priorityMinMarketCap < d.priorityMaxMarketCap
    && d.strictLiquidity >= d.minLiquidity
    && d.minAgeMinutes >= 1 && d.minAgeMinutes < d.maxAgeMinutes && d.maxAgeMinutes <= 43_200;
}

function setPath(source, section, key, value) {
  const next = clone(source);
  next[section][key] = value;
  return next;
}

export function candidateMutations(strategy) {
  if (!validateSoftStrategy(strategy)) return [];
  const rows = [];
  for (const [section, keys] of [['weights', MUTABLE_WEIGHT_KEYS], ['discovery', DISCOVERY_KEYS]]) {
    for (const key of keys) {
      for (const direction of [-1, 1]) {
        const current = strategy[section][key];
        const raw = current * (1 + direction * 0.10);
        const value = section === 'discovery' ? Math.max(key.includes('Age') ? 1 : 0, Math.round(raw)) : Math.round(raw * 1e6) / 1e6;
        const candidate = setPath(strategy, section, key, value);
        if (value !== current && validateSoftStrategy(candidate)) rows.push({
          strategy: candidate, direction, changedPaths: [`${section}.${key}`]
        });
      }
    }
  }
  return rows;
}

function seededRandom(seed) {
  let value = parseInt(hash(seed).slice(0, 8), 16) || 1;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 0x1_0000_0000;
  };
}

export function deterministicBootstrap(differences, seed, iterations = 10_000) {
  const values = differences.filter(Number.isFinite);
  if (!values.length) return { lower: null, upper: null, iterations: 0 };
  const random = seededRandom(seed);
  const results = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
    results.push(median(sample));
  }
  results.sort((a, b) => a - b);
  return {
    lower: results[Math.floor((results.length - 1) * 0.025)],
    upper: results[Math.floor((results.length - 1) * 0.975)],
    iterations: results.length
  };
}

export function applySoftStrategy(runtimeSettings, strategy) {
  const discovery = strategy?.discovery || {};
  return Object.freeze({
    ...runtimeSettings,
    discoveryMinMarketCap: discovery.minMarketCap ?? runtimeSettings.discoveryMinMarketCap,
    discoveryMaxMarketCap: discovery.maxMarketCap ?? runtimeSettings.discoveryMaxMarketCap,
    priorityMinMarketCap: discovery.priorityMinMarketCap ?? runtimeSettings.priorityMinMarketCap,
    priorityMaxMarketCap: discovery.priorityMaxMarketCap ?? runtimeSettings.priorityMaxMarketCap,
    minLiquidity: discovery.minLiquidity ?? runtimeSettings.minLiquidity,
    strictLiquidity: discovery.strictLiquidity ?? runtimeSettings.strictLiquidity,
    minAgeSec: Number.isFinite(discovery.minAgeMinutes) ? discovery.minAgeMinutes * 60 : runtimeSettings.minAgeSec,
    maxAgeSec: Number.isFinite(discovery.maxAgeMinutes) ? discovery.maxAgeMinutes * 60 : runtimeSettings.maxAgeSec,
    factorWeights: clone(strategy?.weights || {})
  });
}

export function liquidityImpact(liquidityUsd) {
  const liquidity = finite(liquidityUsd);
  return clamp(SHADOW_NOTIONAL_USDC / Math.max((liquidity || 0) / 2, SHADOW_NOTIONAL_USDC), 0, 0.25);
}

export function shadowReturn({ entryPrice, exitPrice, entryLiquidity, exitLiquidity = entryLiquidity }) {
  const entry = finite(entryPrice);
  const exit = finite(exitPrice);
  if (!(entry > 0) || !(exit > 0)) return -1;
  const entryImpact = liquidityImpact(entryLiquidity);
  const exitImpact = liquidityImpact(exitLiquidity);
  return clamp((exit / entry) * (1 - entryImpact) * (1 - exitImpact) - 1 - FIXED_ROUND_TRIP_COST, -1, 1000);
}

function factorSnapshot(candidate) {
  return Object.freeze({
    marketCap: finite(candidate.marketCap),
    liquidity: finite(candidate.liquidity),
    ageSec: finite(candidate.ageSec),
    discoveryScore: finite(candidate.discoveryScore),
    holders: finite(candidate.holders),
    volume1h: finite(candidate.volume1h),
    priorityBand: candidate.priorityBand === true,
    smartWallets: finite(candidate.deep?.marketBehavior?.smartWallets ?? candidate.deep?.marketBehavior?.smartDegenCount),
    kolOnly: candidate.deep?.marketBehavior?.kolOnly === true
  });
}

export function createShadowTrade(candidate, { cohort, signalAt = Date.now(), policy, strategy, exploration = false } = {}) {
  const frozenStrategy = clone(strategy || defaultSoftStrategy(policy));
  const normalizedAddress = String(candidate.address || '');
  const entryTargetAt = (Math.floor(signalAt / 60_000) + 1) * 60_000;
  return {
    id: hash(`${candidate.chain}:${normalizedAddress}:${cohort}:${signalAt}`).slice(0, 32),
    chain: String(candidate.chain || ''),
    address: normalizedAddress,
    symbol: String(candidate.symbol || '?').slice(0, 30),
    cohort,
    exploration: exploration === true,
    signalAt,
    signalPrice: finite(candidate.price),
    initialDecision: String(candidate.status || ''),
    latestDecision: String(candidate.status || ''),
    strategyVersion: strategyFingerprint(frozenStrategy),
    strategy: frozenStrategy,
    factorSchemaVersion: FACTOR_SCHEMA_VERSION,
    costModelVersion: COST_MODEL_VERSION,
    factors: factorSnapshot(candidate),
    entry: { targetAt: entryTargetAt },
    chaseRisk: false,
    samples: {},
    retries: {}
  };
}

export function dueShadowJobs(trades, now = Date.now()) {
  return (trades || []).flatMap(trade => {
    if (!trade.entry?.price) {
      if (now >= Number(trade.entry?.targetAt || Infinity) && now >= Number(trade.retries?.entry?.nextAt || 0)) {
        return [{ trade, tradeId: trade.id, kind: 'entry', targetAt: trade.entry.targetAt }];
      }
      return [];
    }
    return Object.entries(SHADOW_HORIZONS).filter(([key, duration]) =>
      !trade.samples?.[key] && now >= trade.entry.at + duration && now >= Number(trade.retries?.[key]?.nextAt || 0)
    ).map(([key, duration]) => ({ trade, tradeId: trade.id, kind: 'exit', key, targetAt: trade.entry.at + duration }));
  }).sort((a, b) => a.targetAt - b.targetAt);
}

export function applyPriceSample(trade, job, sample, failure = {}) {
  if (!trade || !job) return false;
  const valid = sample && finite(sample.price) > 0 && finite(sample.at) !== null
    && Math.abs(Number(sample.at) - Number(job.targetAt)) <= 60_000;
  if (job.kind === 'entry') {
    if (!valid) return false;
    trade.entry = {
      targetAt: job.targetAt,
      at: Number(sample.at),
      price: Number(sample.price),
      liquidity: finite(sample.liquidity) ?? trade.factors.liquidity,
      source: String(sample.source || 'GMGN_1M_CLOSE')
    };
    trade.chaseRisk = finite(trade.signalPrice) > 0
      && Math.abs(trade.entry.price / trade.signalPrice - 1) > 0.20;
    delete trade.retries?.entry;
    return true;
  }
  if (!job.key || trade.samples?.[job.key]) return false;
  if (!valid) {
    if (failure.confirmed === true && ['UNTRADEABLE', 'NO_LIQUIDITY', 'POOL_REMOVED'].includes(failure.code)) {
      trade.samples[job.key] = {
        targetAt: job.targetAt,
        observedReturn: null,
        conservativeReturn: -1,
        netReturn: -1,
        missingKind: 'confirmed_untradeable',
        source: String(failure.code)
      };
      delete trade.retries?.[job.key];
      return true;
    }
    return false;
  }
  const entryImpact = liquidityImpact(trade.entry.liquidity);
  const exitLiquidity = finite(sample.liquidity) ?? trade.entry.liquidity;
  const exitImpact = liquidityImpact(exitLiquidity);
  const dynamicCostRate = 1 - (1 - entryImpact) * (1 - exitImpact);
  const grossReturn = Number(sample.price) / trade.entry.price - 1;
  const netReturn = shadowReturn({ entryPrice: trade.entry.price, exitPrice: Number(sample.price), entryLiquidity: trade.entry.liquidity, exitLiquidity });
  trade.samples[job.key] = {
    targetAt: job.targetAt,
    at: Number(sample.at),
    price: Number(sample.price),
    liquidity: finite(sample.liquidity),
    liquidityEstimated: finite(sample.liquidity) === null,
    source: String(sample.source || 'GMGN_1M_CLOSE'),
    grossReturn,
    fixedCostRate: FIXED_ROUND_TRIP_COST,
    dynamicCostRate,
    observedReturn: netReturn,
    conservativeReturn: netReturn,
    netReturn
  };
  delete trade.retries?.[job.key];
  return true;
}

function matchDistance(signal, control) {
  if (signal.chain !== control.chain || control.matchedTradeId) return Infinity;
  const age = Math.abs(signal.signalAt - control.signalAt);
  if (age > 10 * 60_000) return Infinity;
  const ratios = ['marketCap', 'liquidity', 'ageSec'].map(key => {
    const a = finite(signal.factors?.[key]);
    const b = finite(control.factors?.[key]);
    if (!(a > 0) || !(b > 0)) return Infinity;
    const ratio = a / b;
    return ratio >= 0.5 && ratio <= 2 ? Math.abs(Math.log(ratio)) : Infinity;
  });
  if (ratios.some(value => !Number.isFinite(value))) return Infinity;
  return age / (10 * 60_000) + ratios.reduce((sum, value) => sum + value, 0);
}

export function matchControl(signal, controls) {
  const rows = (controls || []).map(control => ({ control, distance: matchDistance(signal, control) }))
    .filter(row => Number.isFinite(row.distance)).sort((a, b) => a.distance - b.distance);
  if (!rows.length) return null;
  const control = rows[0].control;
  control.matchedTradeId = signal.id;
  signal.matchedTradeId = control.id;
  return control;
}

export function evaluatePromotion(metrics = {}) {
  const reasons = [];
  if (Number(metrics.completed15m) < 80) reasons.push('insufficient_signal_samples');
  if (Number(metrics.matchedPairs) < 40) reasons.push('insufficient_matched_pairs');
  if (Number(metrics.spanMs) < DAY) reasons.push('insufficient_time_span');
  if (MAIN_HORIZONS.some(key => Number(metrics.coverage?.[key]) < 0.80)) reasons.push('coverage');
  if (Number(metrics.weightedMedianUplift) < 0.01) reasons.push('median_uplift');
  if (Number(metrics.weightedHitRateUplift) < 0.03) reasons.push('hit_rate_uplift');
  if (!(Number(metrics.bootstrapLower) > 0)) reasons.push('confidence');
  if (Number(metrics.worstP10Regression) > 0.02) reasons.push('tail_risk');
  return { promote: reasons.length === 0, reasons };
}

function defaultState(policy, now) {
  const strategy = defaultSoftStrategy(policy);
  return {
    version: FACTOR_LAB_VERSION,
    autoPromotionEnabled: true,
    champion: { version: strategyFingerprint(strategy), strategy, activatedAt: now },
    previousChampion: null,
    challenger: null,
    trades: [],
    aggregates: [],
    history: [{ at: now, type: 'BASELINE_CREATED', strategyVersion: strategyFingerprint(strategy), reason: 'initial_policy' }],
    lastPromotionAt: 0,
    disabledReason: ''
  };
}

function migrateState(raw, policy, now) {
  const base = defaultState(policy, now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    ...base,
    ...raw,
    version: FACTOR_LAB_VERSION,
    trades: Array.isArray(raw.trades) ? raw.trades : [],
    aggregates: Array.isArray(raw.aggregates) ? raw.aggregates : [],
    history: Array.isArray(raw.history) ? raw.history : base.history
  };
}

function cohortFor(candidate) {
  if (candidate.status === 'X_REVIEW') return 'signal';
  if (candidate.status === 'WAIT_RECHECK') return 'control';
  if (candidate.status === 'HARD_REJECT') return 'hard_reject';
  return '';
}

function shouldSampleHardReject(candidate) {
  return parseInt(hash(`${candidate.chain}:${candidate.address}`).slice(0, 2), 16) % 5 === 0;
}

function strategyAccepts(trade, strategy) {
  const d = strategy.discovery;
  const f = trade.factors || {};
  return finite(f.marketCap) >= d.minMarketCap && finite(f.marketCap) <= d.maxMarketCap
    && finite(f.liquidity) >= d.minLiquidity
    && finite(f.ageSec) >= d.minAgeMinutes * 60 && finite(f.ageSec) <= d.maxAgeMinutes * 60;
}

function strategyPerformance(trades, strategy, since = 0, now = Date.now()) {
  const rows = trades.filter(trade => trade.cohort !== 'hard_reject' && trade.signalAt >= since && strategyAccepts(trade, strategy));
  const horizons = Object.fromEntries(MAIN_HORIZONS.map(key => {
    const eligible = rows.filter(row => row.entry?.at && now >= row.entry.at + SHADOW_HORIZONS[key]);
    const values = eligible.map(row => row.samples?.[key]?.conservativeReturn).filter(Number.isFinite);
    return [key, {
      eligible: eligible.length,
      completed: values.length,
      coverage: eligible.length ? values.length / eligible.length : 0,
      median: median(values),
      hitRate: values.length ? values.filter(value => value > 0).length / values.length : null,
      p10: percentile(values, 0.10),
      values
    }];
  }));
  const weighted = metric => MAIN_HORIZONS.reduce((sum, key) => sum + WEIGHTS[key] * Number(horizons[key][metric] ?? 0), 0);
  return {
    rows,
    horizons,
    completed15m: horizons.m15.completed,
    weightedMedian: weighted('median'),
    weightedHitRate: weighted('hitRate'),
    weightedP10: weighted('p10')
  };
}

function comparisonMetrics(trades, champion, challenger, since, experimentId, now) {
  const base = strategyPerformance(trades, champion, since, now);
  const next = strategyPerformance(trades, challenger, since, now);
  const differences = [];
  for (const key of MAIN_HORIZONS) {
    const baseline = Number(base.horizons[key].median ?? 0);
    for (const value of next.horizons[key].values) differences.push((value - baseline) * WEIGHTS[key]);
  }
  const confidence = deterministicBootstrap(differences, experimentId, 10_000);
  return {
    completed15m: next.completed15m,
    matchedPairs: trades.filter(row => row.cohort === 'signal' && row.matchedTradeId && row.signalAt >= since).length,
    spanMs: next.rows.length ? Math.max(...next.rows.map(row => row.signalAt)) - Math.min(...next.rows.map(row => row.signalAt)) : 0,
    coverage: Object.fromEntries(MAIN_HORIZONS.map(key => [key, next.horizons[key].coverage])),
    weightedMedianUplift: next.weightedMedian - base.weightedMedian,
    weightedHitRateUplift: next.weightedHitRate - base.weightedHitRate,
    bootstrapLower: confidence.lower,
    worstP10Regression: Math.max(...MAIN_HORIZONS.map(key =>
      Number(base.horizons[key].p10 ?? 0) - Number(next.horizons[key].p10 ?? 0)
    )),
    base,
    next
  };
}

export class FactorLab {
  constructor(dir, { policy, now = Date.now } = {}) {
    this.file = path.join(dir, 'factor-lab.json');
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });
    const fallback = defaultState(policy, now());
    const loaded = readJsonWithBackup(this.file, fallback);
    this.state = migrateState(loaded.value, policy, now());
    if (loaded.recovered) this.state.recoveredFromBackup = true;
  }

  save() {
    atomicJson(this.file, this.state);
    return this.state;
  }

  effectiveStrategy() {
    return clone(this.state.champion.strategy);
  }

  startChallenger(strategy, now = this.now(), changedPaths = null) {
    if (!validateSoftStrategy(strategy)) throw Object.assign(new Error('invalid_soft_strategy'), { statusCode: 400 });
    const mutations = candidateMutations(this.state.champion.strategy);
    const matched = mutations.find(row => strategyFingerprint(row.strategy) === strategyFingerprint(strategy));
    if (!matched) throw Object.assign(new Error('invalid_soft_strategy'), { statusCode: 400 });
    this.state.challenger = {
      version: strategyFingerprint(strategy), strategy: clone(strategy),
      baselineVersion: this.state.champion.version,
      createdAt: now,
      changedPaths: changedPaths || matched.changedPaths,
      direction: matched.direction
    };
    this.state.history.push({ at: now, type: 'CHALLENGER_CREATED', strategyVersion: this.state.challenger.version,
      baselineVersion: this.state.champion.version, changedPaths: this.state.challenger.changedPaths });
    this.save();
    return clone(this.state.challenger);
  }

  evaluateChallenger(metrics, now = this.now()) {
    if (!this.state.challenger) return { promoted: false, reasons: ['no_challenger'] };
    const decision = evaluatePromotion(metrics);
    if (!this.state.autoPromotionEnabled) return { promoted: false, reasons: ['auto_promotion_paused', ...decision.reasons] };
    if (this.state.lastPromotionAt && now - this.state.lastPromotionAt < DAY) return { promoted: false, reasons: ['cooldown', ...decision.reasons] };
    if (!decision.promote) return { promoted: false, reasons: decision.reasons };
    const challenger = this.state.challenger;
    this.state.previousChampion = this.state.champion;
    this.state.champion = { version: challenger.version, strategy: clone(challenger.strategy), activatedAt: now };
    this.state.challenger = null;
    this.state.lastPromotionAt = now;
    this.state.history.push({ at: now, type: 'STRATEGY_PROMOTED', strategyVersion: this.state.champion.version,
      previousVersion: this.state.previousChampion.version, metrics: {
        completed15m: metrics.completed15m, matchedPairs: metrics.matchedPairs,
        weightedMedianUplift: metrics.weightedMedianUplift, weightedHitRateUplift: metrics.weightedHitRateUplift,
        bootstrapLower: metrics.bootstrapLower, worstP10Regression: metrics.worstP10Regression
      } });
    this.save();
    return { promoted: true, strategyVersion: this.state.champion.version };
  }

  evaluateRollback(metrics, now = this.now()) {
    if (!this.state.previousChampion || Number(metrics.completed) < 40) return { rolledBack: false };
    if (!(Number(metrics.weightedMedianUplift) <= -0.02 || Number(metrics.coverage) < 0.70)) return { rolledBack: false };
    const result = this.rollback(now);
    return { rolledBack: true, summary: result };
  }

  automationTick(now = this.now()) {
    if (!this.state.autoPromotionEnabled || this.state.disabledReason) return { action: 'paused' };
    try {
      if (this.state.previousChampion && this.state.champion.activatedAt) {
        const rollback = comparisonMetrics(this.state.trades, this.state.previousChampion.strategy,
          this.state.champion.strategy, this.state.champion.activatedAt, `rollback:${this.state.champion.version}`, now);
        const coverage = Math.min(...MAIN_HORIZONS.map(key => rollback.coverage[key]));
        const result = this.evaluateRollback({ completed: rollback.completed15m,
          weightedMedianUplift: rollback.weightedMedianUplift, coverage }, now);
        if (result.rolledBack) return { action: 'rolled_back' };
      }
      if (this.state.challenger) {
        const metrics = comparisonMetrics(this.state.trades, this.state.champion.strategy,
          this.state.challenger.strategy, this.state.challenger.createdAt, this.state.challenger.version, now);
        const result = this.evaluateChallenger(metrics, now);
        return { action: result.promoted ? 'promoted' : 'observing', metrics, reasons: result.reasons || [] };
      }
      const baseline = strategyPerformance(this.state.trades, this.state.champion.strategy, 0, now);
      const spanMs = baseline.rows.length ? Math.max(...baseline.rows.map(row => row.signalAt)) - Math.min(...baseline.rows.map(row => row.signalAt)) : 0;
      if (baseline.completed15m < 80 || spanMs < DAY) return { action: 'collecting' };
      const ranked = candidateMutations(this.state.champion.strategy).map(mutation => {
        const performance = strategyPerformance(this.state.trades, mutation.strategy, 0, now);
        const horizonUplifts = MAIN_HORIZONS.map(key => Number(performance.horizons[key].median ?? -Infinity)
          - Number(baseline.horizons[key].median ?? 0));
        return { ...mutation, uplift: performance.weightedMedian - baseline.weightedMedian, horizonUplifts };
      }).filter(row => row.uplift > 0.005 && row.horizonUplifts.every(value => value > 0))
        .sort((a, b) => b.uplift - a.uplift);
      if (!ranked.length) return { action: 'no_candidate' };
      this.startChallenger(ranked[0].strategy, now, ranked[0].changedPaths);
      return { action: 'challenger_created', changedPaths: ranked[0].changedPaths };
    } catch (error) {
      this.state.disabledReason = 'AUTOMATION_ERROR';
      this.state.history.push({ at: now, type: 'AUTOMATION_DISABLED', reason: 'AUTOMATION_ERROR' });
      this.save();
      return { action: 'disabled', error: String(error?.code || 'AUTOMATION_ERROR') };
    }
  }

  recordCandidate(candidate, { now = this.now(), exploration = false } = {}) {
    const cohort = cohortFor(candidate);
    if (!cohort || (cohort === 'hard_reject' && !shouldSampleHardReject(candidate))) return null;
    const key = tokenKey(candidate.chain, candidate.address);
    const duplicate = this.state.trades.find(trade => tokenKey(trade.chain, trade.address) === key && trade.cohort === cohort);
    if (duplicate) {
      duplicate.latestDecision = candidate.status;
      duplicate.lastAuditedAt = now;
      this.save();
      return duplicate;
    }
    const trade = createShadowTrade(candidate, {
      cohort, signalAt: now, policy: { discovery: this.state.champion.strategy.discovery },
      strategy: this.state.champion.strategy, exploration
    });
    this.state.trades.push(trade);
    if (cohort === 'signal') matchControl(trade, this.state.trades.filter(row => row.cohort === 'control'));
    this.prune(now);
    this.save();
    return trade;
  }

  prune(now = this.now()) {
    const fresh = this.state.trades.filter(trade => now - Number(trade.signalAt || 0) <= RETENTION_MS)
      .sort((a, b) => Number(a.signalAt || 0) - Number(b.signalAt || 0));
    if (fresh.length > MAX_TRADES) {
      const removed = fresh.slice(0, fresh.length - MAX_TRADES);
      this.state.aggregates.push({ at: now, type: 'PRUNED', count: removed.length });
    }
    this.state.trades = fresh.slice(-MAX_TRADES);
    this.state.aggregates = this.state.aggregates.slice(-1_000);
    this.state.history = this.state.history.slice(-1_000);
  }

  dueJobs(now = this.now()) {
    return dueShadowJobs(this.state.trades, now);
  }

  async collect(gmgn, { limit = 4, now = this.now, deadline = Infinity } = {}) {
    for (const job of this.dueJobs(now()).slice(0, limit)) {
      if (now() >= deadline || gmgn.disabled || gmgn.nextAllowedAt > now()) break;
      let sample = null;
      let failure = { code: 'NO_CANDLE', confirmed: false };
      try { sample = await gmgn.priceAt(job.trade.address, job.targetAt, job.trade.chain); }
      catch (error) {
        failure = { code: String(error?.code || 'READ_FAILED'), confirmed: error?.confirmed === true };
      }
      if (!applyPriceSample(job.trade, job, sample, failure)) {
        const key = job.kind === 'entry' ? 'entry' : job.key;
        const attempts = Number(job.trade.retries?.[key]?.attempts || 0) + 1;
        job.trade.retries ||= {};
        job.trade.retries[key] = {
          attempts, code: failure.code,
          nextAt: now() + Math.min(60 * 60_000, 120_000 * 2 ** Math.min(attempts - 1, 5))
        };
      }
      if (failure.code === 'GMGN_RATE_LIMITED') break;
    }
    this.prune(now());
    this.save();
    return this.state;
  }

  setAutoPromotion(enabled, now = this.now()) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('invalid_control'), { statusCode: 400 });
    this.state.autoPromotionEnabled = enabled;
    this.state.history.push({ at: now, type: enabled ? 'AUTO_PROMOTION_RESUMED' : 'AUTO_PROMOTION_PAUSED' });
    this.save();
    return this.summary(now);
  }

  rollback(now = this.now()) {
    if (!this.state.previousChampion) throw Object.assign(new Error('rollback_unavailable'), { statusCode: 409 });
    const replaced = this.state.champion;
    this.state.champion = this.state.previousChampion;
    this.state.previousChampion = replaced;
    this.state.challenger = null;
    this.state.history.push({ at: now, type: 'STRATEGY_ROLLED_BACK', strategyVersion: this.state.champion.version });
    this.save();
    return this.summary(now);
  }

  manualBaseline(policy, now = this.now()) {
    const strategy = defaultSoftStrategy(policy);
    this.state.previousChampion = this.state.champion;
    this.state.champion = { version: strategyFingerprint(strategy), strategy, activatedAt: now };
    this.state.challenger = null;
    this.state.history.push({ at: now, type: 'MANUAL_BASELINE', strategyVersion: this.state.champion.version });
    this.save();
  }

  summary(now = this.now()) {
    const signals = this.state.trades.filter(row => row.cohort === 'signal');
    const horizons = Object.fromEntries(Object.keys(SHADOW_HORIZONS).map(key => {
      const eligible = signals.filter(row => row.entry?.at && now >= row.entry.at + SHADOW_HORIZONS[key]);
      const observed = eligible.map(row => row.samples?.[key]?.observedReturn).filter(Number.isFinite);
      const conservative = eligible.map(row => row.samples?.[key]?.conservativeReturn).filter(Number.isFinite);
      return [key, {
        eligible: eligible.length,
        completed: conservative.length,
        missing: eligible.length - conservative.length,
        coverage: eligible.length ? conservative.length / eligible.length : 0,
        observedMedian: median(observed),
        conservativeMedian: median(conservative),
        hitRate: conservative.length ? conservative.filter(value => value > 0).length / conservative.length : null,
        p10: percentile(conservative, 0.10)
      }];
    }));
    return {
      enabled: true,
      autoPromotionEnabled: this.state.autoPromotionEnabled === true,
      championVersion: this.state.champion?.version || '',
      challenger: this.state.challenger ? clone(this.state.challenger) : null,
      tracked: this.state.trades.length,
      signalCount: signals.length,
      controlCount: this.state.trades.filter(row => row.cohort === 'control').length,
      hardRejectCount: this.state.trades.filter(row => row.cohort === 'hard_reject').length,
      matchedPairs: signals.filter(row => row.matchedTradeId).length,
      horizons,
      lastPromotionAt: Number(this.state.lastPromotionAt || 0),
      recoveredFromBackup: this.state.recoveredFromBackup === true,
      disabledReason: String(this.state.disabledReason || '')
    };
  }
}

export { MAIN_HORIZONS, WEIGHTS };
