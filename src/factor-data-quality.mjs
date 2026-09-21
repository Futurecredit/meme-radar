const HORIZONS = Object.freeze({
  m5: 5 * 60_000,
  m10: 10 * 60_000,
  m15: 15 * 60_000
});

export const DATA_QUALITY_TARGETS = Object.freeze({
  completed15m: 100,
  matchedPairs: 40,
  horizonCoverage: 0.8,
  pathCoverage: 0.8
});

const ACTIVE_SOURCE_FAILURES = new Set(['RATE_LIMITED', 'TIMEOUT', 'READ_FAILED', 'NO_CANDLE']);
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const signalRows = trades => (Array.isArray(trades) ? trades : []).filter(row => row && typeof row === 'object'
  && row.cohort === 'signal' && row.legacyFixedHorizonOnly !== true
  && finite(row.entry?.at) !== null && finite(row.entry?.price) > 0);

function horizonCoverage(signals, key, now) {
  const duration = HORIZONS[key];
  const eligible = signals.filter(row => Number.isFinite(row.samples?.[key]?.conservativeReturn)
    || now >= Number(row.entry.at) + duration);
  const completed = eligible.filter(row => Number.isFinite(row.samples?.[key]?.conservativeReturn)).length;
  return {
    eligible: eligible.length,
    completed,
    missing: Math.max(0, eligible.length - completed),
    rate: eligible.length ? completed / eligible.length : 0
  };
}

function pathMetrics(signals, now) {
  const eligible = signals.filter(row => Number.isFinite(row.samples?.m15?.conservativeReturn)
    || now >= Number(row.entry.at) + HORIZONS.m15);
  let observedBars = 0;
  let expectedBars = 0;
  let integrityFailures = 0;
  let sourceFailures = 0;
  for (const row of eligible) {
    const path = row.path;
    const expected = finite(path?.expectedBars);
    const observed = finite(path?.observedBars);
    const validExpected = expected !== null && Number.isInteger(expected) && expected > 0;
    const validObserved = observed !== null && Number.isInteger(observed) && observed >= 0;
    const boundedExpected = validExpected ? expected : 15;
    expectedBars += boundedExpected;
    if (validObserved) observedBars += Math.min(observed, boundedExpected);
    if (path && (!validExpected || !validObserved || observed > boundedExpected)) integrityFailures += 1;
    if (ACTIVE_SOURCE_FAILURES.has(String(path?.lastFailureCode || '').toUpperCase())) sourceFailures += 1;
  }
  return {
    eligible: eligible.length,
    observedBars,
    expectedBars,
    coverage: expectedBars ? observedBars / expectedBars : 0,
    integrityFailures,
    sourceFailures
  };
}

function completedMatchedPairs(trades, signals) {
  const rows = Array.isArray(trades) ? trades : [];
  const byId = new Map(rows.filter(row => row && typeof row === 'object' && row.id).map(row => [row.id, row]));
  const controls = new Set();
  for (const signal of signals) {
    if (!Number.isFinite(signal.samples?.m15?.conservativeReturn) || !signal.matchedTradeId) continue;
    const control = byId.get(signal.matchedTradeId);
    if (control?.cohort !== 'control' || control.contaminatedAt || control.matchedTradeId !== signal.id
      || !Number.isFinite(control.samples?.m15?.conservativeReturn)) continue;
    controls.add(control.id);
  }
  return controls.size;
}

export function buildDataQualitySummary(trades, { now = Date.now() } = {}) {
  const timestamp = finite(now) ?? Date.now();
  const signals = signalRows(trades);
  const coverage = Object.fromEntries(Object.keys(HORIZONS).map(key => [key, horizonCoverage(signals, key, timestamp)]));
  const path = pathMetrics(signals, timestamp);
  const completed15m = coverage.m15.completed;
  const matchedPairs = completedMatchedPairs(trades, signals);
  const reasons = [];
  if (path.sourceFailures > 0 || path.integrityFailures > 0) reasons.push('SOURCE_INTEGRITY');
  if (matchedPairs < DATA_QUALITY_TARGETS.matchedPairs) reasons.push('MATCHED_PAIRS');
  if (path.coverage < DATA_QUALITY_TARGETS.pathCoverage) reasons.push('PATH_COVERAGE');
  if (Object.values(coverage).some(item => item.rate < DATA_QUALITY_TARGETS.horizonCoverage)) reasons.push('HORIZON_COVERAGE');
  if (completed15m < DATA_QUALITY_TARGETS.completed15m) reasons.push('COMPLETED_15M');
  return {
    phase: 'DATA_TRUST',
    collectOnly: true,
    canGenerateCandidate: false,
    canPromote: false,
    primaryBlocker: reasons[0] || 'DATA_READY',
    reasons,
    eligibleSignals: signals.length,
    completed15m,
    matchedPairs,
    coverage,
    pathCoverage: path.coverage,
    pathObservedBars: path.observedBars,
    pathExpectedBars: path.expectedBars,
    sourceFailures: path.sourceFailures,
    integrityFailures: path.integrityFailures,
    targets: { ...DATA_QUALITY_TARGETS },
    remaining: {
      completed15m: Math.max(0, DATA_QUALITY_TARGETS.completed15m - completed15m),
      matchedPairs: Math.max(0, DATA_QUALITY_TARGETS.matchedPairs - matchedPairs),
      pathCoverage: Math.max(0, DATA_QUALITY_TARGETS.pathCoverage - path.coverage),
      horizonCoverage: Math.max(0, ...Object.values(coverage)
        .map(item => DATA_QUALITY_TARGETS.horizonCoverage - item.rate))
    }
  };
}
