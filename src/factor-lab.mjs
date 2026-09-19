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
  const discovery = Object.fromEntries(SOFT_DISCOVERY_KEYS.map(key => [key, policy.discovery[key]]));
  return Object.freeze({
    version: 1,
    discovery: Object.freeze(discovery),
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

const SOFT_DISCOVERY_KEYS = Object.freeze([
  'minMarketCap', 'maxMarketCap', 'priorityMinMarketCap', 'priorityMaxMarketCap',
  'minLiquidity', 'minAgeMinutes', 'maxAgeMinutes'
]);
const WEIGHT_KEYS = Object.freeze([
  'priorityBand', 'ordinaryBand', 'liquidityCap', 'liquidityDivisor',
  'volumeCap', 'volumeDivisor', 'holdersCap', 'holdersDivisor',
  'smartTwo', 'smartThree', 'kolPenalty'
]);
const AUTOMATIC_THRESHOLD_KEYS = Object.freeze([
  'minMarketCap', 'maxMarketCap', 'minLiquidity', 'minAgeMinutes', 'maxAgeMinutes'
]);

function requireExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validateSoftStrategy(strategy) {
  if (!requireExactKeys(strategy, ['version', 'discovery', 'weights']) || strategy.version !== 1
    || !requireExactKeys(strategy.discovery, SOFT_DISCOVERY_KEYS) || !requireExactKeys(strategy.weights, WEIGHT_KEYS)) return false;
  if ([...SOFT_DISCOVERY_KEYS.map(key => strategy.discovery[key]), ...WEIGHT_KEYS.map(key => strategy.weights[key])]
    .some(value => !Number.isFinite(value) || value < 0)) return false;
  const d = strategy.discovery;
  return d.minMarketCap < d.maxMarketCap
    && d.priorityMinMarketCap >= d.minMarketCap
    && d.priorityMaxMarketCap <= d.maxMarketCap
    && d.priorityMinMarketCap < d.priorityMaxMarketCap
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
  for (const [section, keys] of [['discovery', AUTOMATIC_THRESHOLD_KEYS]]) {
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
  const observations = differences.map(item => typeof item === 'object' && item !== null
    ? { value: finite(item.value), stratum: String(item.stratum || 'all') }
    : { value: finite(item), stratum: 'all' }).filter(item => Number.isFinite(item.value));
  const groups = new Map();
  for (const item of observations) {
    if (!groups.has(item.stratum)) groups.set(item.stratum, []);
    groups.get(item.stratum).push(item.value);
  }
  if (!observations.length) return { lower: null, upper: null, iterations: 0, strata: 0 };
  const random = seededRandom(seed);
  const results = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = [];
    for (const values of groups.values()) {
      for (let index = 0; index < values.length; index++) sample.push(values[Math.floor(random() * values.length)]);
    }
    results.push(median(sample));
  }
  results.sort((a, b) => a - b);
  return {
    lower: results[Math.floor((results.length - 1) * 0.025)],
    upper: results[Math.floor((results.length - 1) * 0.975)],
    iterations: results.length,
    strata: groups.size
  };
}

function comparisonBootstrap(baseObservations, nextObservations, seed, iterations = 10_000) {
  const group = rows => {
    const groups = new Map();
    for (const row of rows.filter(item => Number.isFinite(item.value))) {
      if (!groups.has(row.stratum)) groups.set(row.stratum, []);
      groups.get(row.stratum).push(row.value);
    }
    return groups;
  };
  const baseGroups = group(baseObservations), nextGroups = group(nextObservations);
  const strata = [...nextGroups.keys()].filter(key => baseGroups.has(key));
  const comparable = strata.reduce((sum, key) => sum + Math.min(baseGroups.get(key).length, nextGroups.get(key).length), 0);
  if (!strata.length) return { lower: null, upper: null, iterations: 0, strata: 0, comparable: 0 };
  const random = seededRandom(seed), results = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const baseSample = [], nextSample = [];
    for (const key of strata) {
      const before = baseGroups.get(key), after = nextGroups.get(key);
      for (let index = 0; index < before.length; index++) baseSample.push(before[Math.floor(random() * before.length)]);
      for (let index = 0; index < after.length; index++) nextSample.push(after[Math.floor(random() * after.length)]);
    }
    results.push(median(nextSample) - median(baseSample));
  }
  results.sort((a, b) => a - b);
  return { lower: results[Math.floor((results.length - 1) * .025)], upper: results[Math.floor((results.length - 1) * .975)],
    iterations: results.length, strata: strata.length, comparable };
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
  const category = value => typeof value === 'boolean' ? value : null;
  return Object.freeze({
    marketCap: finite(candidate.marketCap),
    liquidity: finite(candidate.liquidity),
    ageSec: finite(candidate.ageSec),
    discoveryScore: finite(candidate.discoveryScore),
    holders: finite(candidate.holders),
    volume1h: finite(candidate.volume1h),
    priorityBand: category(candidate.priorityBand),
    smartWallets: finite(candidate.discoverySmartWallets ?? candidate.deep?.marketBehavior?.smartWallets ?? candidate.deep?.marketBehavior?.smartDegenCount),
    kolOnly: category(candidate.discoveryKolOnly ?? candidate.deep?.marketBehavior?.kolOnly)
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
      if (trade.entry?.missingKind) return [];
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
  if (signal.chain !== control.chain || control.matchedTradeId || control.contaminatedAt) return Infinity;
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
  if (Number(metrics.comparablePairs) < 40) reasons.push('insufficient_comparable_pairs');
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

function normalizePersistedStrategy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = clone(value);
  if (normalized.discovery && Object.hasOwn(normalized.discovery, 'strictLiquidity')) delete normalized.discovery.strictLiquidity;
  return validateSoftStrategy(normalized) ? normalized : null;
}

function migrateState(raw, policy, now) {
  const base = defaultState(policy, now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  let repaired = raw.version !== FACTOR_LAB_VERSION;
  if (raw.champion?.strategy?.discovery && Object.hasOwn(raw.champion.strategy.discovery, 'strictLiquidity')) repaired = true;
  const championStrategy = normalizePersistedStrategy(raw.champion?.strategy);
  if (!championStrategy) repaired = true;
  const champion = championStrategy
    ? { version: strategyFingerprint(championStrategy), strategy: championStrategy, activatedAt: finite(raw.champion?.activatedAt) ?? now }
    : base.champion;
  const previousStrategy = normalizePersistedStrategy(raw.previousChampion?.strategy);
  if (raw.previousChampion && !previousStrategy) repaired = true;
  const previousChampion = previousStrategy
    ? { version: strategyFingerprint(previousStrategy), strategy: previousStrategy, activatedAt: finite(raw.previousChampion?.activatedAt) ?? now }
    : null;
  const challengerStrategy = normalizePersistedStrategy(raw.challenger?.strategy);
  const challengerMutation = challengerStrategy && candidateMutations(champion.strategy)
    .find(row => strategyFingerprint(row.strategy) === strategyFingerprint(challengerStrategy));
  if (raw.challenger && !challengerMutation) repaired = true;
  const history = Array.isArray(raw.history) ? raw.history.slice(-1_000) : base.history;
  if (repaired) history.push({ at: now, type: 'STATE_REPAIRED', strategyVersion: champion.version, reason: 'invalid_or_legacy_state' });
  return {
    version: FACTOR_LAB_VERSION,
    autoPromotionEnabled: raw.autoPromotionEnabled !== false,
    champion,
    previousChampion,
    challenger: challengerMutation ? {
      version: strategyFingerprint(challengerMutation.strategy), strategy: challengerMutation.strategy,
      baselineVersion: champion.version, createdAt: finite(raw.challenger?.createdAt) ?? now,
      changedPaths: challengerMutation.changedPaths, direction: challengerMutation.direction
    } : null,
    trades: Array.isArray(raw.trades) ? raw.trades.filter(row => row && typeof row === 'object').slice(-MAX_TRADES) : [],
    aggregates: Array.isArray(raw.aggregates) ? raw.aggregates.slice(-1_000) : [],
    history,
    lastPromotionAt: finite(raw.lastPromotionAt) ?? 0,
    disabledReason: typeof raw.disabledReason === 'string' ? raw.disabledReason.slice(0, 80) : ''
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

function replaySelection(trades, strategy, since) {
  return trades.filter(trade => trade.cohort === 'signal' && trade.signalAt >= since && strategyAccepts(trade, strategy));
}

export function strategyPerformance(trades, strategy, since = 0, now = Date.now()) {
  const rows = replaySelection(trades, strategy, since);
  const horizons = Object.fromEntries(MAIN_HORIZONS.map(key => {
    const eligible = rows.filter(row => {
      const start = finite(row.entry?.at) ?? finite(row.entry?.targetAt);
      return start !== null && now >= start + SHADOW_HORIZONS[key];
    });
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

function pairedExcess(trade, trades) {
  const control = trades.find(row => row.id === trade.matchedTradeId && row.cohort === 'control');
  if (!control) return null;
  const deltas = MAIN_HORIZONS.map(key => {
    const signal = trade.samples?.[key]?.conservativeReturn;
    const baseline = control.samples?.[key]?.conservativeReturn;
    return Number.isFinite(signal) && Number.isFinite(baseline) ? signal - baseline : null;
  });
  return deltas.every(Number.isFinite) ? MAIN_HORIZONS.reduce((sum, key, index) => sum + WEIGHTS[key] * deltas[index], 0) : null;
}

export function comparisonMetrics(trades, champion, challenger, since, experimentId, now) {
  const base = strategyPerformance(trades, champion, since, now);
  const next = strategyPerformance(trades, challenger, since, now);
  const observations = rows => rows.map(row => ({ value: pairedExcess(row, trades),
    stratum: `${row.chain || 'unknown'}:${Math.floor(Number(row.signalAt || 0) / DAY)}` })).filter(item => Number.isFinite(item.value));
  const basePairs = observations(base.rows), nextPairs = observations(next.rows);
  const confidence = comparisonBootstrap(basePairs, nextPairs, experimentId, 10_000);
  const matchedPairs = next.rows.filter(row => Number.isFinite(pairedExcess(row, trades))).length;
  return {
    completed15m: next.completed15m,
    matchedPairs,
    comparablePairs: confidence.comparable,
    spanMs: next.rows.length ? Math.max(...next.rows.map(row => row.signalAt)) - Math.min(...next.rows.map(row => row.signalAt)) : 0,
    coverage: Object.fromEntries(MAIN_HORIZONS.map(key => [key, next.horizons[key].coverage])),
    weightedMedianUplift: next.weightedMedian - base.weightedMedian,
    weightedHitRateUplift: next.weightedHitRate - base.weightedHitRate,
    bootstrapLower: confidence.lower,
    bootstrapStrata: confidence.strata,
    worstP10Regression: Math.max(...MAIN_HORIZONS.map(key =>
      Number(base.horizons[key].p10 ?? 0) - Number(next.horizons[key].p10 ?? 0)
    )),
    base,
    next
  };
}

function publicSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  return {
    targetAt: finite(sample.targetAt), at: finite(sample.at), price: finite(sample.price),
    observedReturn: finite(sample.observedReturn), conservativeReturn: finite(sample.conservativeReturn),
    netReturn: finite(sample.netReturn), grossReturn: finite(sample.grossReturn),
    fixedCostRate: finite(sample.fixedCostRate), dynamicCostRate: finite(sample.dynamicCostRate),
    missingKind: String(sample.missingKind || '').slice(0, 40),
    liquidityEstimated: sample.liquidityEstimated === true,
    source: String(sample.source || '').slice(0, 40)
  };
}

function publicTrade(trade) {
  const factors = trade.factors || {};
  return {
    id: String(trade.id || '').slice(0, 64), chain: String(trade.chain || '').slice(0, 32),
    address: String(trade.address || '').slice(0, 128), symbol: String(trade.symbol || '?').slice(0, 30),
    cohort: String(trade.cohort || '').slice(0, 24), exploration: trade.exploration === true,
    signalAt: finite(trade.signalAt), strategyVersion: String(trade.strategyVersion || '').slice(0, 64),
    initialDecision: String(trade.initialDecision || '').slice(0, 32), latestDecision: String(trade.latestDecision || '').slice(0, 32),
    chaseRisk: trade.chaseRisk === true, matchedTradeId: String(trade.matchedTradeId || '').slice(0, 64),
    factors: {
      marketCap: finite(factors.marketCap), liquidity: finite(factors.liquidity), ageSec: finite(factors.ageSec),
      discoveryScore: finite(factors.discoveryScore), holders: finite(factors.holders), volume1h: finite(factors.volume1h),
      priorityBand: typeof factors.priorityBand === 'boolean' ? factors.priorityBand : null,
      smartWallets: finite(factors.smartWallets), kolOnly: typeof factors.kolOnly === 'boolean' ? factors.kolOnly : null
    },
    entry: trade.entry?.price ? { targetAt: finite(trade.entry.targetAt), at: finite(trade.entry.at), price: finite(trade.entry.price),
      liquidity: finite(trade.entry.liquidity), source: String(trade.entry.source || '').slice(0, 40) }
      : { targetAt: finite(trade.entry?.targetAt), missingAt: finite(trade.entry?.missingAt), missingKind: String(trade.entry?.missingKind || '').slice(0, 40) },
    samples: Object.fromEntries(Object.keys(SHADOW_HORIZONS).map(key => [key, publicSample(trade.samples?.[key])]))
  };
}

function publicAggregate(aggregate) {
  const allowedFactors = new Set(['marketCap', 'liquidity', 'ageSec', 'discoveryScore', 'holders', 'volume1h', 'smartWallets', 'priorityBand', 'kolOnly']);
  return {
    at: finite(aggregate?.at), type: aggregate?.type === 'PRUNED' ? 'PRUNED' : 'ARCHIVE', count: finite(aggregate?.count),
    groups: (Array.isArray(aggregate?.groups) ? aggregate.groups : []).slice(0, 500).map(group => ({
      strategyVersion: String(group?.strategyVersion || '').slice(0, 64), chain: String(group?.chain || '').slice(0, 32),
      cohort: String(group?.cohort || '').slice(0, 24), horizon: Object.hasOwn(SHADOW_HORIZONS, group?.horizon) ? group.horizon : '',
      count: finite(group?.count), observedCount: finite(group?.observedCount), conservativeCount: finite(group?.conservativeCount),
      medianObserved: finite(group?.medianObserved), medianConservative: finite(group?.medianConservative),
      p10: finite(group?.p10), positiveRate: finite(group?.positiveRate),
      factorBuckets: Object.fromEntries(Object.entries(group?.factorBuckets || {}).filter(([factor]) => allowedFactors.has(factor)).map(([factor, buckets]) => [factor,
        Object.fromEntries(Object.entries(buckets || {}).slice(0, 32).map(([bucket, stats]) => [String(bucket).slice(0, 40), {
          count: finite(stats?.count), completed: finite(stats?.completed), medianConservative: finite(stats?.medianConservative)
        }]))]))
    }))
  };
}

function factorQualityRows(trades, horizon = 'm10') {
  const selectedHorizon = Object.hasOwn(SHADOW_HORIZONS, horizon) ? horizon : 'm10';
  const completed = trades.filter(trade => trade.cohort === 'signal' && Number.isFinite(trade.samples?.[selectedHorizon]?.conservativeReturn));
  const rows = [];
  const addRow = (factor, bucket, members) => {
    const returns = members.map(trade => trade.samples?.[selectedHorizon]?.conservativeReturn).filter(Number.isFinite);
    const matched = members.map(trade => {
      const control = trades.find(row => row.id === trade.matchedTradeId);
      if (!control) return null;
      const signalValue = trade.samples?.[selectedHorizon]?.conservativeReturn;
      const controlValue = control.samples?.[selectedHorizon]?.conservativeReturn;
      if (!Number.isFinite(signalValue) || !Number.isFinite(controlValue)) return null;
      return signalValue - controlValue;
    }).filter(Number.isFinite);
    rows.push({ factor, bucket, horizon: selectedHorizon, sampleCount: members.length, completed: returns.length,
      medianNetReturn: median(returns), hitRate: returns.length ? returns.filter(value => value > 0).length / returns.length : null,
      p10: percentile(returns, .10), matchedUplift: median(matched),
      chaseRate: members.length ? members.filter(row => row.chaseRisk).length / members.length : 0 });
  };
  for (const factor of ['marketCap', 'liquidity', 'ageSec', 'discoveryScore', 'holders', 'volume1h', 'smartWallets']) {
    const values = completed.map(row => finite(row.factors?.[factor])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) continue;
    const cuts = [percentile(values, .25), percentile(values, .50), percentile(values, .75)];
    for (let index = 0; index < 4; index++) {
      const members = completed.filter(row => {
        const value = finite(row.factors?.[factor]);
        if (!Number.isFinite(value)) return false;
        return index === 0 ? value <= cuts[0]
          : index === 1 ? value > cuts[0] && value <= cuts[1]
            : index === 2 ? value > cuts[1] && value <= cuts[2] : value > cuts[2];
      });
      addRow(factor, `Q${index + 1}`, members);
    }
  }
  for (const factor of ['priorityBand', 'kolOnly']) {
    for (const value of [true, false, null]) addRow(factor, value === null ? 'unknown' : String(value),
      completed.filter(row => (typeof row.factors?.[factor] === 'boolean' ? row.factors[factor] : null) === value));
  }
  return rows.filter(row => row.sampleCount > 0);
}

function factorBucket(value) {
  if (typeof value === 'boolean') return String(value);
  const number = finite(value);
  if (!Number.isFinite(number)) return 'unknown';
  if (number === 0) return '0';
  const power = Math.floor(Math.log10(Math.abs(number)));
  return `${10 ** power}-${10 ** (power + 1)}`;
}

function archiveTrades(trades, now) {
  const factorNames = ['marketCap', 'liquidity', 'ageSec', 'discoveryScore', 'holders', 'volume1h', 'smartWallets', 'priorityBand', 'kolOnly'];
  const groups = new Map();
  for (const trade of trades) {
    for (const [horizon, sample] of Object.entries(trade.samples || {})) {
      if (!Object.hasOwn(SHADOW_HORIZONS, horizon) || !sample) continue;
      const key = [trade.strategyVersion || '', trade.chain || '', trade.cohort || '', horizon].join('|');
      if (!groups.has(key)) groups.set(key, {
        strategyVersion: String(trade.strategyVersion || ''), chain: String(trade.chain || ''),
        cohort: String(trade.cohort || ''), horizon, count: 0, observed: [], conservative: [], factorBuckets: {}
      });
      const group = groups.get(key);
      group.count++;
      if (Number.isFinite(sample.observedReturn)) group.observed.push(sample.observedReturn);
      if (Number.isFinite(sample.conservativeReturn)) group.conservative.push(sample.conservativeReturn);
      for (const factor of factorNames) {
        const bucket = factorBucket(trade.factors?.[factor]);
        group.factorBuckets[factor] ||= {};
        group.factorBuckets[factor][bucket] ||= { count: 0, conservative: [] };
        const stats = group.factorBuckets[factor][bucket];
        stats.count++;
        if (Number.isFinite(sample.conservativeReturn)) stats.conservative.push(sample.conservativeReturn);
      }
    }
  }
  return {
    at: now, type: 'PRUNED', count: trades.length,
    groups: [...groups.values()].map(group => ({
      strategyVersion: group.strategyVersion, chain: group.chain, cohort: group.cohort, horizon: group.horizon,
      count: group.count, observedCount: group.observed.length, conservativeCount: group.conservative.length,
      medianObserved: median(group.observed), medianConservative: median(group.conservative), p10: percentile(group.conservative, .10),
      positiveRate: group.conservative.length ? group.conservative.filter(value => value > 0).length / group.conservative.length : null,
      factorBuckets: Object.fromEntries(Object.entries(group.factorBuckets).map(([factor, buckets]) => [factor,
        Object.fromEntries(Object.entries(buckets).map(([bucket, stats]) => [bucket, {
          count: stats.count, completed: stats.conservative.length, medianConservative: median(stats.conservative)
        }]))]))
    }))
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
    if (!decision.promote) {
      const readiness = new Set(['insufficient_signal_samples', 'insufficient_matched_pairs', 'insufficient_comparable_pairs', 'insufficient_time_span', 'coverage']);
      if (!decision.reasons.some(reason => readiness.has(reason))) {
        const rejected = this.state.challenger;
        this.state.challenger = null;
        this.state.history.push({ at: now, type: 'CHALLENGER_REJECTED', strategyVersion: rejected.version,
          baselineVersion: rejected.baselineVersion, changedPaths: rejected.changedPaths,
          reason: decision.reasons.join(',').slice(0, 160) });
        this.save();
        return { promoted: false, rejected: true, reasons: decision.reasons };
      }
      return { promoted: false, reasons: decision.reasons };
    }
    const challenger = this.state.challenger;
    this.state.previousChampion = this.state.champion;
    this.state.champion = { version: challenger.version, strategy: clone(challenger.strategy), activatedAt: now };
    this.state.challenger = null;
    this.state.lastPromotionAt = now;
    this.state.history.push({ at: now, type: 'STRATEGY_PROMOTED', strategyVersion: this.state.champion.version,
      previousVersion: this.state.previousChampion.version, metrics: {
        completed15m: metrics.completed15m, matchedPairs: metrics.matchedPairs, comparablePairs: metrics.comparablePairs,
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
    const currentVersion = this.state.champion.version;
    if (cohort === 'signal') {
      for (const control of this.state.trades.filter(row => row.cohort === 'control' && tokenKey(row.chain, row.address) === key && !row.contaminatedAt)) {
        control.contaminatedAt = now;
        const paired = this.state.trades.find(row => row.id === control.matchedTradeId);
        if (paired) delete paired.matchedTradeId;
        delete control.matchedTradeId;
      }
    }
    const duplicate = this.state.trades.find(trade => tokenKey(trade.chain, trade.address) === key
      && trade.cohort === cohort && trade.strategyVersion === currentVersion);
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
    const expired = this.state.trades.filter(trade => now - Number(trade.signalAt || 0) > RETENTION_MS);
    const fresh = this.state.trades.filter(trade => now - Number(trade.signalAt || 0) <= RETENTION_MS)
      .sort((a, b) => Number(a.signalAt || 0) - Number(b.signalAt || 0));
    const overflow = fresh.length > MAX_TRADES ? fresh.slice(0, fresh.length - MAX_TRADES) : [];
    const removed = [...expired, ...overflow];
    if (removed.length) this.state.aggregates.push(archiveTrades(removed, now));
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
        if (job.kind === 'entry' && (attempts >= 5 || now() - job.targetAt >= 30 * 60_000)) {
          job.trade.entry = { ...job.trade.entry, missingKind: 'entry_unavailable', missingAt: now() };
          delete job.trade.retries.entry;
        } else job.trade.retries[key] = {
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
    if (this.state.challenger) this.state.history.push({ at: now, type: 'CHALLENGER_REJECTED',
      strategyVersion: this.state.challenger.version, baselineVersion: this.state.challenger.baselineVersion,
      changedPaths: this.state.challenger.changedPaths, reason: 'manual_override' });
    this.state.previousChampion = this.state.champion;
    this.state.champion = { version: strategyFingerprint(strategy), strategy, activatedAt: now };
    this.state.challenger = null;
    this.state.history.push({ at: now, type: 'MANUAL_BASELINE', strategyVersion: this.state.champion.version });
    this.save();
  }

  summary(now = this.now()) {
    const signals = this.state.trades.filter(row => row.cohort === 'signal');
    const horizons = Object.fromEntries(Object.keys(SHADOW_HORIZONS).map(key => {
      const eligible = signals.filter(row => {
        const start = finite(row.entry?.at) ?? finite(row.entry?.targetAt);
        return start !== null && now >= start + SHADOW_HORIZONS[key];
      });
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
      rollbackAvailable: Boolean(this.state.previousChampion),
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

  query(parameters = {}) {
    const view = String(parameters.view || 'summary');
    if (!['summary', 'factors', 'trades', 'history'].includes(view)) throw Object.assign(new Error('invalid_factor_lab_view'), { statusCode: 400 });
    const limit = clamp(Number.parseInt(parameters.limit || '50', 10) || 50, 1, 100);
    const cursor = Math.max(0, Number.parseInt(parameters.cursor || '0', 10) || 0);
    if (view === 'summary') return { view, summary: this.summary() };
    let rows;
    if (view === 'factors') {
      const filtered = this.state.trades
        .filter(row => !parameters.chain || row.chain === parameters.chain)
        .filter(row => !parameters.strategyVersion || row.strategyVersion === parameters.strategyVersion);
      rows = factorQualityRows(filtered, parameters.horizon);
    }
    else if (view === 'history') rows = [...this.state.history].reverse().map(row => ({
      at: finite(row.at), type: String(row.type || '').slice(0, 48),
      strategyVersion: String(row.strategyVersion || '').slice(0, 64),
      previousVersion: String(row.previousVersion || '').slice(0, 64),
      baselineVersion: String(row.baselineVersion || '').slice(0, 64),
      changedPaths: Array.isArray(row.changedPaths) ? row.changedPaths.slice(0, 4).map(value => String(value).slice(0, 80)) : [],
      reason: String(row.reason || '').slice(0, 80)
    }));
    else {
      const horizon = Object.hasOwn(SHADOW_HORIZONS, parameters.horizon) ? parameters.horizon : 'm10';
      rows = [...this.state.trades].reverse()
        .filter(row => !parameters.chain || row.chain === parameters.chain)
        .filter(row => !parameters.cohort || row.cohort === parameters.cohort)
        .filter(row => !parameters.strategyVersion || row.strategyVersion === parameters.strategyVersion)
        .filter(row => {
          if (!parameters.result) return true;
          const value = row.samples?.[horizon]?.conservativeReturn;
          return parameters.result === 'profit' ? Number.isFinite(value) && value > 0
            : parameters.result === 'loss' ? Number.isFinite(value) && value <= 0
              : parameters.result === 'missing' ? !Number.isFinite(value) : false;
        }).map(publicTrade);
    }
    const page = rows.slice(cursor, cursor + limit);
    return { view, rows: page, nextCursor: cursor + page.length < rows.length ? String(cursor + page.length) : null, total: rows.length };
  }

  exportPublic() {
    return {
      version: FACTOR_LAB_VERSION,
      exportedAt: this.now(),
      summary: this.summary(),
      factors: factorQualityRows(this.state.trades),
      trades: this.state.trades.map(publicTrade),
      aggregates: this.state.aggregates.map(publicAggregate),
      history: this.query({ view: 'history', limit: 100 }).rows
    };
  }
}

export { MAIN_HORIZONS, WEIGHTS };
