import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { defaultPolicy } from '../src/policy.mjs';
import { FactorLab } from '../src/factor-lab.mjs';
import { RadarControls } from '../src/local-store.mjs';
import { createServer } from '../src/server.mjs';

function dispatch(server, method, route, body, origin = true) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method; req.url = route; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { host: '127.0.0.1:3791', 'content-type': 'application/json', ...(origin ? { origin: 'http://127.0.0.1:3791' } : {}) };
    const result = { headers: {} };
    const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); },
      end(value) { result.body = JSON.parse(value); resolve(result); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

test('factor lab API paginates allowlisted views and protects control writes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controls = new RadarControls(dir, config.supportedChains, 'bsc');
  const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 1_000 });
  lab.state.trades.push({
    id: 'trade-1', chain: 'bsc', address: '0x0000000000000000000000000000000000000001', symbol: 'DOG',
    cohort: 'signal', signalAt: 100, strategyVersion: 'v1', chaseRisk: false,
    factors: { marketCap: 40_000, liquidity: 10_000, secret: 'do-not-leak' },
    entry: { at: 200, price: 1, targetAt: 200 }, samples: { m5: { netReturn: .1, conservativeReturn: .1, privateKey: 'do-not-leak' } },
    raw: 'do-not-leak'
  });
  lab.state.history.push({ at: 2, type: 'TEST', strategyVersion: 'v1', raw: 'do-not-leak' });
  lab.save();
  const state = { value: { activeChain: 'bsc', status: 'RUNNING', supportedChains: config.supportedChains, candidates: [], chainStates: {}, factorLabSummary: lab.summary() } };
  const server = createServer({ state, controls, factorLab: lab, settings: { ...config, stateDir: dir, publicDir: config.publicDir } });

  const trades = await dispatch(server, 'GET', '/api/factor-lab?view=trades&chain=bsc&limit=1');
  assert.equal(trades.status, 200);
  assert.equal(trades.body.rows.length, 1);
  assert.equal(trades.body.rows[0].samples.m5.netReturn, .1);
  assert.doesNotMatch(JSON.stringify(trades.body), /do-not-leak|privateKey|raw/);
  assert.equal((await dispatch(server, 'GET', '/api/factor-lab?view=unknown')).status, 400);

  assert.equal((await dispatch(server, 'POST', '/api/factor-lab-control', { autoPromotionEnabled: false })).status, 200);
  assert.equal(lab.state.autoPromotionEnabled, false);
  assert.equal((await dispatch(server, 'POST', '/api/factor-lab-control', { autoPromotionEnabled: true, extra: 1 })).status, 400);
  assert.equal((await dispatch(server, 'POST', '/api/factor-lab-control', { autoPromotionEnabled: true }, false)).status, 403);
  assert.equal((await dispatch(server, 'POST', '/api/factor-lab-rollback', {})).status, 409);
});

test('status/export include sanitized factor lab data and manual policy save creates a new baseline', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const controls = new RadarControls(dir, config.supportedChains, 'bsc');
  const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => 1_000 });
  const baseline = lab.state.champion.version;
  const state = { value: { activeChain: 'bsc', status: 'RUNNING', supportedChains: config.supportedChains, candidates: [], chainStates: {}, factorLabSummary: lab.summary() } };
  const server = createServer({ state, controls, factorLab: lab, settings: { ...config, stateDir: dir, publicDir: config.publicDir } });

  const status = await dispatch(server, 'GET', '/api/status');
  assert.equal(status.body.factorLabSummary.championVersion, baseline);
  const changed = defaultPolicy(); changed.discovery.minMarketCap = 11_000;
  const saved = await dispatch(server, 'POST', '/api/policy', { policy: changed });
  assert.equal(saved.status, 200);
  assert.notEqual(lab.state.champion.version, baseline);
  assert.equal(lab.state.history.at(-1).type, 'MANUAL_BASELINE');

  const exported = await dispatch(server, 'GET', '/api/export');
  assert.ok(exported.body.factorLab);
  assert.ok(Array.isArray(exported.body.factorLab.aggregates));
  assert.doesNotMatch(JSON.stringify(exported.body.factorLab), /api.?key|private.?key|secret|raw/i);
});
