export const FACTOR_PATH_VERSION = 1;

const MINUTE_MS = 60_000;
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function normalizeBar(row, now) {
  const openAt = finite(row?.openAt);
  const closeAt = finite(row?.closeAt);
  const open = finite(row?.open);
  const high = finite(row?.high);
  const low = finite(row?.low);
  const close = finite(row?.close);
  if (!Number.isInteger(openAt) || openAt < 0 || closeAt !== openAt + MINUTE_MS
    || closeAt > now || !(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)
    || high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  return {
    openAt,
    closeAt,
    open,
    high,
    low,
    close,
    source: String(row?.source || 'GMGN_1M_OHLC').slice(0, 32)
  };
}

function barKey(row) {
  return [row.openAt, row.closeAt, row.open, row.high, row.low, row.close, row.source].join('|');
}

function normalizeDetailed(candles, { now = Date.now() } = {}) {
  const groups = new Map();
  let invalidBars = 0;
  for (const row of Array.isArray(candles) ? candles : []) {
    const normalized = normalizeBar(row, finite(now) ?? Date.now());
    if (!normalized) {
      invalidBars++;
      continue;
    }
    const group = groups.get(normalized.openAt) || [];
    group.push(normalized);
    groups.set(normalized.openAt, group);
  }

  const bars = [];
  let duplicateBars = 0;
  for (const group of groups.values()) {
    const unique = new Map(group.map(row => [barKey(row), row]));
    duplicateBars += group.length - 1;
    if (unique.size > 1) {
      invalidBars += group.length;
      continue;
    }
    bars.push(group[0]);
  }
  bars.sort((a, b) => a.openAt - b.openAt);
  return { bars, invalidBars, duplicateBars };
}

export function normalizePathCandles(candles, options = {}) {
  return normalizeDetailed(candles, options).bars;
}

export function appendPathCandles(path, candles, { now = Date.now() } = {}) {
  const previous = normalizeDetailed(path?.bars, { now });
  const incoming = normalizeDetailed(candles, { now });
  const merged = new Map(previous.bars.map(row => [row.openAt, row]));
  let invalidBars = Number(path?.invalidBars || 0) + incoming.invalidBars;
  let duplicateBars = Number(path?.duplicateBars || 0) + incoming.duplicateBars;

  for (const row of incoming.bars) {
    const existing = merged.get(row.openAt);
    if (!existing) merged.set(row.openAt, row);
    else if (barKey(existing) === barKey(row)) duplicateBars++;
    else invalidBars++;
  }

  const bars = [...merged.values()].sort((a, b) => a.openAt - b.openAt);
  return {
    version: FACTOR_PATH_VERSION,
    bars,
    firstAt: bars.length ? bars[0].openAt : null,
    lastAt: bars.length ? bars.at(-1).closeAt : null,
    invalidBars,
    duplicateBars
  };
}

export function summarizePath(path, { entryAt, entryPrice, throughAt } = {}) {
  const start = finite(entryAt);
  const end = finite(throughAt);
  const price = finite(entryPrice);
  const validWindow = Number.isInteger(start) && Number.isInteger(end) && end >= start;
  const expectedBars = validWindow ? Math.max(0, Math.floor((end - start) / MINUTE_MS)) : 0;
  const bars = validWindow ? (Array.isArray(path?.bars) ? path.bars : [])
    .filter(row => row.openAt >= start && row.closeAt <= end
      && (row.openAt - start) % MINUTE_MS === 0)
    .sort((a, b) => a.openAt - b.openAt) : [];
  const observedBars = Math.min(expectedBars, bars.length);
  const missingBars = Math.max(0, expectedBars - observedBars);
  const coverage = expectedBars ? observedBars / expectedBars : 0;
  const continuous = expectedBars > 0 && observedBars === expectedBars
    && bars.every((row, index) => row.openAt === start + index * MINUTE_MS);

  let mfeRate = null;
  let mfeAt = null;
  let maeRate = null;
  let maeAt = null;
  let maxDrawdownRate = null;
  if (price > 0 && bars.length) {
    let peak = price;
    for (const row of bars) {
      const favorable = row.high / price - 1;
      if (mfeRate === null || favorable > mfeRate) {
        mfeRate = favorable;
        mfeAt = row.closeAt;
      }
      const adverse = row.low / price - 1;
      if (maeRate === null || adverse < maeRate) {
        maeRate = adverse;
        maeAt = row.closeAt;
      }
      peak = Math.max(peak, row.high);
      const drawdown = row.low / peak - 1;
      if (maxDrawdownRate === null || drawdown < maxDrawdownRate) maxDrawdownRate = drawdown;
    }
  }

  return {
    observedBars,
    expectedBars,
    missingBars,
    coverage,
    continuous,
    mfeRate,
    mfeAt,
    maeRate,
    maeAt,
    maxDrawdownRate,
    lastCloseAt: bars.length ? bars.at(-1).closeAt : null
  };
}
