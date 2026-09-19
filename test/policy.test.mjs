import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RadarControls } from '../src/local-store.mjs';

async function policyModule() {
  try {
    return await import('../src/policy.mjs');
  } catch {
    return {};
  }
}

test('default policy preserves the 0.1.6 discovery, live and scan behavior', async () => {
  const { defaultPolicy } = await policyModule();
  assert.equal(typeof defaultPolicy, 'function');
  assert.deepEqual(defaultPolicy(), {
    version: 1,
    discovery: {
      minMarketCap: 10000,
      maxMarketCap: 150000,
      priorityMinMarketCap: 20000,
      priorityMaxMarketCap: 80000,
      minLiquidity: 3000,
      strictLiquidity: 8000,
      minAgeMinutes: 5,
      maxAgeMinutes: 10080
    },
    live: {
      minMarketCap: 10000,
      maxMarketCap: 500000,
      minLiquidity: 3000,
      minAgeMinutes: 5
    },
    scan: {
      intervalSeconds: 120,
      maxDeepAuditsPerCycle: 6
    }
  });
});

test('policy validation rejects unknown, non-integer, out-of-range and inconsistent fields', async () => {
  const { defaultPolicy, validatePolicy } = await policyModule();
  assert.equal(typeof validatePolicy, 'function');
  const base = defaultPolicy();
  const invalid = {
    ...base,
    extra: true,
    discovery: {
      ...base.discovery,
      maxMarketCap: base.discovery.minMarketCap,
      priorityMinMarketCap: 9999,
      strictLiquidity: 2999
    },
    live: { ...base.live, minAgeMinutes: 0 },
    scan: { ...base.scan, intervalSeconds: 29.5, maxDeepAuditsPerCycle: 13 }
  };
  assert.deepEqual(validatePolicy(invalid), {
    ok: false,
    fields: {
      extra: 'unknown_field',
      'discovery.maxMarketCap': 'must_exceed_min',
      'discovery.priorityMinMarketCap': 'outside_discovery_range',
      'discovery.priorityMaxMarketCap': 'outside_discovery_range',
      'discovery.strictLiquidity': 'below_min_liquidity',
      'live.minAgeMinutes': 'out_of_range',
      'scan.intervalSeconds': 'integer_required',
      'scan.maxDeepAuditsPerCycle': 'out_of_range'
    }
  });
});

test('all numeric policy fields enforce integer bounds and nested unknown fields are rejected', async () => {
  const { defaultPolicy, validatePolicy } = await policyModule();
  const amounts = [
    ['discovery','minMarketCap'], ['discovery','maxMarketCap'], ['discovery','priorityMinMarketCap'],
    ['discovery','priorityMaxMarketCap'], ['discovery','minLiquidity'], ['discovery','strictLiquidity'],
    ['live','minMarketCap'], ['live','maxMarketCap'], ['live','minLiquidity']
  ];
  for (const [group, key] of amounts) {
    for (const invalid of [-1, 1_000_000_001, 1.5, Infinity]) {
      const policy = defaultPolicy(); policy[group][key] = invalid;
      assert.ok(validatePolicy(policy).fields[`${group}.${key}`], `${group}.${key} should reject ${invalid}`);
    }
  }
  for (const [path, invalid] of [
    [['discovery','minAgeMinutes'],0], [['discovery','minAgeMinutes'],1441],
    [['discovery','maxAgeMinutes'],43201], [['live','minAgeMinutes'],0], [['live','minAgeMinutes'],1441],
    [['scan','intervalSeconds'],29], [['scan','intervalSeconds'],1801],
    [['scan','maxDeepAuditsPerCycle'],0], [['scan','maxDeepAuditsPerCycle'],13]
  ]) {
    const policy=defaultPolicy(); policy[path[0]][path[1]]=invalid;
    assert.ok(validatePolicy(policy).fields[path.join('.')]);
  }
  const unknown=defaultPolicy(); unknown.live.extra=1;
  assert.equal(validatePolicy(unknown).fields['live.extra'],'unknown_field');
});

test('all cross-field policy constraints are enforced', async () => {
  const { defaultPolicy, validatePolicy } = await policyModule();
  const cases = [
    [policy => { policy.discovery.maxMarketCap=policy.discovery.minMarketCap; }, 'discovery.maxMarketCap'],
    [policy => { policy.discovery.priorityMinMarketCap=90000; policy.discovery.priorityMaxMarketCap=80000; }, 'discovery.priorityMaxMarketCap'],
    [policy => { policy.discovery.priorityMinMarketCap=9999; }, 'discovery.priorityMinMarketCap'],
    [policy => { policy.discovery.priorityMaxMarketCap=150001; }, 'discovery.priorityMaxMarketCap'],
    [policy => { policy.discovery.strictLiquidity=2999; }, 'discovery.strictLiquidity'],
    [policy => { policy.discovery.maxAgeMinutes=policy.discovery.minAgeMinutes; }, 'discovery.maxAgeMinutes'],
    [policy => { policy.live.maxMarketCap=policy.live.minMarketCap; }, 'live.maxMarketCap']
  ];
  for (const [mutate,path] of cases) { const policy=defaultPolicy(); mutate(policy); assert.ok(validatePolicy(policy).fields[path], path); }
});

test('validated policy is cloned and converted to one immutable runtime snapshot', async () => {
  const { defaultPolicy, requirePolicy, runtimePolicy } = await policyModule();
  assert.equal(typeof requirePolicy, 'function');
  assert.equal(typeof runtimePolicy, 'function');
  const input = defaultPolicy();
  input.discovery.maxMarketCap = 250000;
  input.scan.intervalSeconds = 45;
  const validated = requirePolicy(input);
  input.discovery.maxMarketCap = 1;
  assert.equal(validated.discovery.maxMarketCap, 250000);
  assert.equal(Object.isFrozen(validated), true);
  assert.deepEqual(runtimePolicy(validated), {
    discoveryMinMarketCap: 10000,
    discoveryMaxMarketCap: 250000,
    priorityMinMarketCap: 20000,
    priorityMaxMarketCap: 80000,
    minLiquidity: 3000,
    strictLiquidity: 8000,
    minAgeSec: 300,
    maxAgeSec: 604800,
    scanIntervalMs: 45000,
    maxDeepAuditsPerCycle: 6
  });
});

test('legacy preferences migrate to defaults without changing chains or annotations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const annotations = { 'bsc:0x1111111111111111111111111111111111111111': { favorite: true } };
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ enabledChains: ['bsc'], annotations }));
  const controls = new RadarControls(dir, ['sol', 'bsc'], 'sol');
  const { defaultPolicy } = await policyModule();
  assert.deepEqual(controls.policy(), defaultPolicy());
  assert.deepEqual(controls.value.enabledChains, ['bsc']);
  assert.deepEqual(controls.value.annotations, annotations);
});

test('policy saves atomically, survives reload, rejects invalid replacement and resets', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { defaultPolicy } = await policyModule();
  const controls = new RadarControls(dir, ['sol', 'bsc'], 'sol');
  const custom = defaultPolicy();
  custom.scan.intervalSeconds = 45;
  custom.live.minLiquidity = 9876;
  assert.equal(controls.setPolicy(custom).policy.scan.intervalSeconds, 45);
  custom.scan.intervalSeconds = 900;
  const reloaded = new RadarControls(dir, ['sol', 'bsc'], 'sol');
  assert.equal(reloaded.policy().scan.intervalSeconds, 45);
  assert.throws(() => reloaded.setPolicy({ ...reloaded.policy(), extra: true }), { code: 'INVALID_POLICY' });
  assert.equal(reloaded.policy().scan.intervalSeconds, 45);
  assert.deepEqual(reloaded.resetPolicy().policy, defaultPolicy());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8')).policy.scan.intervalSeconds, 120);
  assert.ok(fs.existsSync(path.join(dir, 'preferences.json.bak')));
});
