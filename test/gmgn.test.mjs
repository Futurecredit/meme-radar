import test from 'node:test';
import assert from 'node:assert/strict';
import { GmgnClient, discoveryRequestArgs, gmgnChildEnvironment, normalizeList, translateGmgnError } from '../src/gmgn.mjs';
import { defaultPolicy, runtimePolicy } from '../src/policy.mjs';

test('normalizes nested GMGN list shapes without guessing token fields', () => {
  assert.deepEqual(normalizeList({ data: { rank: [{ address: 'a' }] } }), [{ address: 'a' }]);
  assert.deepEqual(normalizeList({ data: { data: { completed: [{ address: 'b' }] } } }, ['completed']), [{ address: 'b' }]);
});

test('translates GMGN rate limit errors without leaking the raw command', () => {
  const error = translateGmgnError(new Error('Command failed: gmgn-cli token info --raw HTTP 429 RATE_LIMIT_EXCEEDED (~30s remaining)'));
  assert.equal(error.code, 'GMGN_RATE_LIMITED');
  assert.match(error.message, /请求频率超限/);
  assert.doesNotMatch(error.message, /Command failed|token info/);
  assert.equal(error.retryAfterMs, 30_000);
});

test('discovery uses the duration form accepted by both GMGN market commands', () => {
  const requests = discoveryRequestArgs('bsc');
  for (const args of Object.values(requests)) {
    const maxAgeIndex = args.indexOf('--max-created');
    assert.equal(args[maxAgeIndex + 1], '10080m');
    assert.equal(args.includes('7d'), false);
    assert.deepEqual(args.slice(args.indexOf('--chain'), args.indexOf('--chain') + 2), ['--chain', 'bsc']);
  }
});

test('discovery query consumes the immutable policy snapshot', () => {
  const policy = defaultPolicy();
  policy.discovery.minMarketCap = 12345;
  policy.discovery.maxMarketCap = 234567;
  policy.discovery.minLiquidity = 4567;
  policy.discovery.minAgeMinutes = 9;
  policy.discovery.maxAgeMinutes = 321;
  const requests = discoveryRequestArgs('bsc', runtimePolicy(policy));
  for (const args of Object.values(requests)) {
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('--min-marketcap'), '12345');
    assert.equal(value('--max-marketcap'), '234567');
    assert.equal(value('--min-liquidity'), '4567');
    assert.equal(value('--min-created'), '9m');
    assert.equal(value('--max-created'), '321m');
  }
});

test('GMGN child environment keeps network proxy settings without forwarding unrelated secrets', () => {
  const result = gmgnChildEnvironment({
    PATH: '/bin', HOME: '/tmp/example', HTTPS_PROXY: 'http://127.0.0.1:1234',
    no_proxy: '127.0.0.1', GMGN_PROFILE: 'readonly', UNRELATED_SECRET: 'must-not-forward'
  });
  assert.equal(result.HTTPS_PROXY, 'http://127.0.0.1:1234');
  assert.equal(result.no_proxy, '127.0.0.1');
  assert.equal(result.GMGN_PROFILE, undefined);
  assert.equal(result.UNRELATED_SECRET, undefined);
  assert.equal(gmgnChildEnvironment({ GMGN_DEBUG: '1', GMGN_PRIVATE_KEY: 'private', NODE_OPTIONS: '--inspect' }).GMGN_PRIVATE_KEY, undefined);
  assert.equal(gmgnChildEnvironment({ GMGN_DEBUG: '1' }).GMGN_DEBUG, undefined);
});

test('stored GMGN key is injected through the child environment and never command arguments', async () => {
  const key = `gmgn_${'b2'.repeat(16)}`;
  const result = gmgnChildEnvironment({ PATH: '/bin', GMGN_API_KEY: 'older-value' }, key);
  assert.equal(result.GMGN_API_KEY, key);
  assert.equal(gmgnChildEnvironment({ PATH: '/bin', GMGN_API_KEY: 'invalid value' }).GMGN_API_KEY, undefined);

  const client = new GmgnClient({ apiKeyProvider: () => key });
  assert.equal(client.childEnvironment().GMGN_API_KEY, key);
  assert.equal(await client.configured(), true);
  assert.doesNotMatch(JSON.stringify(discoveryRequestArgs('bsc')), /gmgn_[A-Za-z0-9_-]+/);
});
