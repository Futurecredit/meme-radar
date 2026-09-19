import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { FactorLab, candidateMutations } from '../../src/factor-lab.mjs';
import { defaultPolicy } from '../../src/policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-radar-factor-smoke-'));
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;

function isolatedEnvironment() {
  const env = { ...process.env, RADAR_PORT: String(port) };
  for (const key of Object.keys(env)) if (key.startsWith('GMGN_')) delete env[key];
  return env;
}

async function start() {
  child = spawn(process.execPath, ['--use-env-proxy', path.join(temporary, 'src/main.mjs')], {
    cwd: temporary, env: isolatedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`isolated_start_failed:${diagnostics.slice(-500)}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error(`isolated_health_timeout:${diagnostics.slice(-500)}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  for (const item of ['src', 'public', 'package.json']) fs.cpSync(path.join(root, item), path.join(temporary, item), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'junction');

  const firstHealth = await start();
  assert.equal(firstHealth.ok, true);
  const firstStatus = await (await fetch(`${base}/api/status`)).json();
  assert.equal(firstStatus.factorLabSummary.enabled, true);
  await stop();

  const stateDir = path.join(temporary, 'state');
  const lab = new FactorLab(stateDir, { policy: defaultPolicy(), now: () => 10_000 });
  const original = lab.state.champion.version;
  lab.startChallenger(candidateMutations(lab.effectiveStrategy())[0].strategy, 11_000);
  assert.equal(lab.evaluateChallenger({
    completed15m: 80, matchedPairs: 40, spanMs: 24 * 60 * 60_000,
    coverage: { m5: .9, m10: .9, m15: .9 }, weightedMedianUplift: .02,
    weightedHitRateUplift: .04, bootstrapLower: .01, worstP10Regression: 0
  }, 12_000).promoted, true);
  assert.equal(lab.rollback(13_000).championVersion, original);

  const secondHealth = await start();
  assert.equal(secondHealth.ok, true);
  const recovered = await (await fetch(`${base}/api/status`)).json();
  assert.equal(recovered.factorLabSummary.championVersion, original);
  const history = await (await fetch(`${base}/api/factor-lab?view=history&limit=10`)).json();
  assert.ok(history.rows.some(row => row.type === 'STRATEGY_ROLLED_BACK'));
  console.log(`隔离烟雾测试通过：端口 ${port}，临时状态启动、重启恢复、健康检查、晋级与回滚均成功。`);
} finally {
  await stop();
  fs.rmSync(temporary, { recursive: true, force: true });
}
