const POLICY_VERSION = 1;
const AMOUNT_MAX = 1_000_000_000;

const DEFAULT_POLICY = {
  version: POLICY_VERSION,
  discovery: {
    minMarketCap: 10_000,
    maxMarketCap: 150_000,
    priorityMinMarketCap: 20_000,
    priorityMaxMarketCap: 80_000,
    minLiquidity: 3_000,
    strictLiquidity: 8_000,
    minAgeMinutes: 5,
    maxAgeMinutes: 10_080
  },
  live: {
    minMarketCap: 10_000,
    maxMarketCap: 500_000,
    minLiquidity: 3_000,
    minAgeMinutes: 5
  },
  scan: {
    intervalSeconds: 120,
    maxDeepAuditsPerCycle: 6
  }
};

const SHAPE = {
  discovery: [
    'minMarketCap', 'maxMarketCap', 'priorityMinMarketCap', 'priorityMaxMarketCap',
    'minLiquidity', 'strictLiquidity', 'minAgeMinutes', 'maxAgeMinutes'
  ],
  live: ['minMarketCap', 'maxMarketCap', 'minLiquidity', 'minAgeMinutes'],
  scan: ['intervalSeconds', 'maxDeepAuditsPerCycle']
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (isObject(child) && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}

function integerField(fields, path, value, minimum, maximum) {
  if (!Number.isInteger(value)) fields[path] = 'integer_required';
  else if (value < minimum || value > maximum) fields[path] = 'out_of_range';
}

function objectShape(fields, name, value, keys) {
  if (!isObject(value)) {
    fields[name] = 'object_required';
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) fields[`${name}.${key}`] = 'unknown_field';
  for (const key of keys) if (!(key in value)) fields[`${name}.${key}`] = 'required';
  return true;
}

export function defaultPolicy() {
  return clone(DEFAULT_POLICY);
}

export function validatePolicy(value) {
  const fields = {};
  if (!isObject(value)) return { ok: false, fields: { policy: 'object_required' } };

  for (const key of Object.keys(value)) {
    if (!['version', ...Object.keys(SHAPE)].includes(key)) fields[key] = 'unknown_field';
  }
  if (!('version' in value)) fields.version = 'required';
  else if (value.version !== POLICY_VERSION) fields.version = 'unsupported_version';

  const discoveryOk = objectShape(fields, 'discovery', value.discovery, SHAPE.discovery);
  const liveOk = objectShape(fields, 'live', value.live, SHAPE.live);
  const scanOk = objectShape(fields, 'scan', value.scan, SHAPE.scan);

  if (discoveryOk) {
    for (const key of ['minMarketCap', 'maxMarketCap', 'priorityMinMarketCap', 'priorityMaxMarketCap', 'minLiquidity', 'strictLiquidity']) {
      integerField(fields, `discovery.${key}`, value.discovery[key], 0, AMOUNT_MAX);
    }
    integerField(fields, 'discovery.minAgeMinutes', value.discovery.minAgeMinutes, 1, 1_440);
    integerField(fields, 'discovery.maxAgeMinutes', value.discovery.maxAgeMinutes, 2, 43_200);
    if (!fields['discovery.minMarketCap'] && !fields['discovery.maxMarketCap']
      && value.discovery.maxMarketCap <= value.discovery.minMarketCap) {
      fields['discovery.maxMarketCap'] = 'must_exceed_min';
    }
    if (!fields['discovery.priorityMinMarketCap']
      && (value.discovery.priorityMinMarketCap < value.discovery.minMarketCap
        || value.discovery.priorityMinMarketCap > value.discovery.maxMarketCap)) {
      fields['discovery.priorityMinMarketCap'] = 'outside_discovery_range';
    }
    if (!fields['discovery.priorityMaxMarketCap']
      && (value.discovery.priorityMaxMarketCap < value.discovery.minMarketCap
        || value.discovery.priorityMaxMarketCap > value.discovery.maxMarketCap
        || value.discovery.priorityMaxMarketCap <= value.discovery.priorityMinMarketCap)) {
      fields['discovery.priorityMaxMarketCap'] = 'outside_discovery_range';
    }
    if (!fields['discovery.strictLiquidity'] && !fields['discovery.minLiquidity']
      && value.discovery.strictLiquidity < value.discovery.minLiquidity) {
      fields['discovery.strictLiquidity'] = 'below_min_liquidity';
    }
    if (!fields['discovery.minAgeMinutes'] && !fields['discovery.maxAgeMinutes']
      && value.discovery.maxAgeMinutes <= value.discovery.minAgeMinutes) {
      fields['discovery.maxAgeMinutes'] = 'must_exceed_min';
    }
  }

  if (liveOk) {
    for (const key of ['minMarketCap', 'maxMarketCap', 'minLiquidity']) {
      integerField(fields, `live.${key}`, value.live[key], 0, AMOUNT_MAX);
    }
    integerField(fields, 'live.minAgeMinutes', value.live.minAgeMinutes, 1, 1_440);
    if (!fields['live.minMarketCap'] && !fields['live.maxMarketCap']
      && value.live.maxMarketCap <= value.live.minMarketCap) {
      fields['live.maxMarketCap'] = 'must_exceed_min';
    }
  }

  if (scanOk) {
    integerField(fields, 'scan.intervalSeconds', value.scan.intervalSeconds, 30, 1_800);
    integerField(fields, 'scan.maxDeepAuditsPerCycle', value.scan.maxDeepAuditsPerCycle, 1, 12);
  }

  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, policy: deepFreeze(clone(value)) };
}

export function requirePolicy(value) {
  const result = validatePolicy(value);
  if (result.ok) return result.policy;
  const error = new Error('Invalid screening policy');
  error.code = 'INVALID_POLICY';
  error.statusCode = 400;
  error.fields = result.fields;
  throw error;
}

export function runtimePolicy(policy) {
  const value = requirePolicy(policy);
  return Object.freeze({
    discoveryMinMarketCap: value.discovery.minMarketCap,
    discoveryMaxMarketCap: value.discovery.maxMarketCap,
    priorityMinMarketCap: value.discovery.priorityMinMarketCap,
    priorityMaxMarketCap: value.discovery.priorityMaxMarketCap,
    minLiquidity: value.discovery.minLiquidity,
    strictLiquidity: value.discovery.strictLiquidity,
    minAgeSec: value.discovery.minAgeMinutes * 60,
    maxAgeSec: value.discovery.maxAgeMinutes * 60,
    scanIntervalMs: value.scan.intervalSeconds * 1_000,
    maxDeepAuditsPerCycle: value.scan.maxDeepAuditsPerCycle
  });
}
