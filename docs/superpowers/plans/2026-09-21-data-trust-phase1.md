# Continuous Optimization Phase 1: Data Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trustworthy research-data foundation for later filter, entry, exit, and bankroll optimization by collecting complete price paths, creating late-arriving matched controls, exposing explicit data-quality gates, and keeping automatic candidate generation paused.

**Architecture:** Keep `factor-lab.json` as the versioned experiment index and add a focused per-trade path store under `state/factor-paths/`. Incrementally normalize closed 1-minute candles into path files, derive MAE/MFE and coverage summaries, reconcile controls in both arrival orders, and expose one data-quality decision object through the existing status API and dashboard. Phase 1 records evidence and blocks promotion; it does not change safety gates, exit parameters, bankroll sizing, or the current champion.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in filesystem/crypto APIs, existing atomic JSON helpers, existing HTML/CSS/vanilla JavaScript dashboard; no new production dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-continuous-optimization-design.md`

## Global Constraints

- Work in an isolated Git worktree and feature branch; do not edit the running `main` tree during implementation.
- Preserve all existing `factor-lab.json` positions, reference samples, reports, strategy history, portfolio epoch, and 661 historical fixed-horizon samples.
- Do not copy, print, export, or request GMGN API keys, signing private keys, raw upstream responses, or wallet secrets.
- Keep contract permission, tax, LP, concentration, insider, bot, linked-wallet, honeypot, and related safety hard gates fixed and non-configurable.
- Fixed round-trip cost remains 5% split 2.5% entry and 2.5% exit; low-liquidity dynamic impact remains additional and capped at 25% per side.
- The account remains simulation-only with 1,000 USDC initial capital, 50 USDC standard stake, and five funded/reserved slots.
- Phase 1 must force candidate generation and automatic promotion into collect-only mode even if the user's `autoPromotionEnabled` preference is true.
- Existing 20-completed-sample stage reports remain observational; no 100-sample optimization candidate is created in Phase 1.
- Do not change or restart the original 3791 installation; deployment targets only the independent 43892 instance after full verification.
- Use TDD for every task: observe the new test fail, implement the minimum behavior, rerun the focused test, then commit.

## Review Focus

- A control arriving after its signal must still form one deterministic, no-replacement pair; Task 3 adds both arrival-order tests.
- Unordered, duplicate, gapped, malformed, or future 1-minute candles must not inflate path coverage or alter MAE/MFE; Task 1 pins every case.
- A crash during path persistence must recover the last valid `.bak` without fabricating candles; Task 2 tests corrupted-primary recovery.
- Rate limits, timeouts, no-data responses, and confirmed untradeable outcomes must remain distinct in data-quality reasons; Tasks 4 and 5 test each class.
- Migrating live V2 state must preserve every historical row and sample while marking path history unavailable rather than complete; Task 7 performs fixture and live-copy rehearsals.

## Scope Boundaries

- This plan delivers only the evidence and data-quality foundation. It does not generate a 100-sample diagnosis, create or promote challengers, replay alternative exits, or change bankroll sizing.
- Filter tuning, entry/exit experiments, and the 5%/10%/15% drawdown controller each require a later implementation plan built on the Phase 1 path and quality interfaces.
- Completing Phase 1 means the system can state exactly what evidence is missing and collect it safely; it does not mean any factor or strategy has been proven profitable.

---

### Task 1: Deterministic 1-Minute Path Analytics

**Files:**
- Create: `src/factor-path.mjs`
- Create: `test/factor-path.test.mjs`

**Interfaces:**
- Consumes: normalized GMGN candles shaped as `{ openAt, closeAt, open, high, low, close, source }`.
- Produces: `normalizePathCandles(candles, { now })`, `appendPathCandles(path, candles, context)`, and `summarizePath(path, context)`.
- Path shape: `{ version: 1, bars: Array<PathBar>, firstAt, lastAt, invalidBars, duplicateBars }`.
- Summary shape: `{ observedBars, expectedBars, missingBars, coverage, continuous, mfeRate, mfeAt, maeRate, maeAt, maxDrawdownRate, lastCloseAt }`.

- [ ] **Step 1: Write failing normalization and metric tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPathCandles, normalizePathCandles, summarizePath
} from '../src/factor-path.mjs';

test('path normalization rejects future and malformed bars and deduplicates by openAt', () => {
  const bars = normalizePathCandles([
    { openAt: 120_000, closeAt: 180_000, open: 1, high: 1.4, low: .9, close: 1.2 },
    { openAt: 60_000, closeAt: 120_000, open: 1, high: 1.1, low: .8, close: 1 },
    { openAt: 120_000, closeAt: 180_000, open: 1, high: 1.4, low: .9, close: 1.2 },
    { openAt: 180_000, closeAt: 240_000, open: 1, high: .7, low: .9, close: 1 },
    { openAt: 240_000, closeAt: 300_000, open: 1, high: 1, low: 1, close: 1 }
  ], { now: 240_000 });
  assert.deepEqual(bars.map(row => row.openAt), [60_000, 120_000]);
});

test('path summary reports gaps and derives MAE MFE and drawdown from entry price', () => {
  const path = appendPathCandles(null, [
    { openAt: 60_000, closeAt: 120_000, open: 1, high: 1.5, low: .8, close: 1.4 },
    { openAt: 180_000, closeAt: 240_000, open: 1.4, high: 2, low: .7, close: .9 }
  ], { now: 240_000 });
  const result = summarizePath(path, { entryAt: 60_000, entryPrice: 1, throughAt: 240_000 });
  assert.deepEqual(
    { observed: result.observedBars, expected: result.expectedBars, missing: result.missingBars },
    { observed: 2, expected: 3, missing: 1 }
  );
  assert.equal(result.coverage, 2 / 3);
  assert.equal(result.continuous, false);
  assert.equal(result.mfeRate, 1);
  assert.equal(result.maeRate, -.3);
  assert.equal(result.maxDrawdownRate, -.65);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-path.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/factor-path.mjs`.

- [ ] **Step 3: Implement the minimal path module**

```js
export const FACTOR_PATH_VERSION = 1;
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizePathCandles(candles, { now = Date.now() } = {}) {
  const unique = new Map();
  for (const row of Array.isArray(candles) ? candles : []) {
    const values = ['open', 'high', 'low', 'close'].map(key => finite(row?.[key]));
    const openAt = finite(row?.openAt);
    const closeAt = finite(row?.closeAt);
    if (openAt === null || closeAt !== openAt + 60_000 || closeAt > now
      || values.some(value => !(value > 0))
      || values[1] < Math.max(values[0], values[3])
      || values[2] > Math.min(values[0], values[3])) continue;
    unique.set(openAt, {
      openAt, closeAt, open: values[0], high: values[1], low: values[2], close: values[3],
      source: String(row?.source || 'GMGN_1M_OHLC').slice(0, 32)
    });
  }
  return [...unique.values()].sort((a, b) => a.openAt - b.openAt);
}
```

Implement `appendPathCandles` as an immutable merge keyed by `openAt`. Implement `summarizePath` using minute boundaries from `entryAt` through `throughAt`; calculate MFE from candle highs, MAE from candle lows, and maximum peak-to-later-low drawdown without using candles after `throughAt`.

- [ ] **Step 4: Add edge-case tests**

Add tests proving:

- appending the same bars twice is idempotent;
- a candle before `entryAt` cannot affect MAE/MFE;
- a candle after `throughAt` cannot affect the summary;
- empty paths return zero coverage and null return metrics;
- no input object or candle array is mutated.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Task 1 command. Expected: all `factor-path.test.mjs` tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/factor-path.mjs test/factor-path.test.mjs
git commit -m "feat: add deterministic factor path analytics"
```

### Task 2: Atomic Per-Trade Path Store

**Files:**
- Create: `src/factor-path-store.mjs`
- Create: `test/factor-path-store.test.mjs`

**Interfaces:**
- Consumes: Task 1 path objects.
- Produces: class `FactorPathStore` with constructor `new FactorPathStore(stateDir)`.
- Methods:
  - `read(tradeId): PathState | null`
  - `append(tradeId, candles, context): { path, summary }`
  - `summary(tradeId, context): PathSummary | null`
  - `prune({ keepIds, removeIds, cutoffAt }): { removed, preserved }`
- Files live at `<stateDir>/factor-paths/<safeTradeId>.json`; IDs are restricted to `[a-f0-9]{1,64}`.

- [ ] **Step 1: Write failing persistence, recovery, and ID-validation tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactorPathStore } from '../src/factor-path-store.mjs';

test('path store persists an allowlisted path and recovers a corrupt primary from backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-path-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bar = openAt => ({
    openAt, closeAt: openAt + 60_000, open: 1, high: 1.2, low: .8, close: 1.1
  });
  const store = new FactorPathStore(dir);
  store.append('a'.repeat(32), [bar(60_000)], { now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000 });
  store.append('a'.repeat(32), [bar(120_000)], { now: 180_000, entryAt: 60_000, entryPrice: 1, throughAt: 180_000 });
  fs.writeFileSync(path.join(dir, 'factor-paths', `${'a'.repeat(32)}.json`), '{broken');
  const recovered = store.read('a'.repeat(32));
  assert.equal(recovered.bars.length, 1);
  assert.doesNotMatch(JSON.stringify(recovered), /raw|apiKey|privateKey/);
});

test('path store rejects traversal and never removes a kept or recent path', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-path-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bar = openAt => ({
    openAt, closeAt: openAt + 60_000, open: 1, high: 1.2, low: .8, close: 1.1
  });
  const store = new FactorPathStore(dir);
  assert.throws(() => store.read('../factor-lab'), /invalid_trade_id/);
  const kept = 'b'.repeat(32), recent = 'c'.repeat(32);
  const stale = 'd'.repeat(32), overflow = 'e'.repeat(32);
  store.append(kept, [bar(60_000)], { now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000 });
  store.append(recent, [bar(120_000)], { now: 180_000, entryAt: 120_000, entryPrice: 1, throughAt: 180_000 });
  store.append(stale, [bar(60_000)], { now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000 });
  store.append(overflow, [bar(120_000)], { now: 180_000, entryAt: 120_000, entryPrice: 1, throughAt: 180_000 });
  const result = store.prune({
    keepIds: new Set([kept]), removeIds: new Set([overflow]), cutoffAt: 150_000
  });
  assert.deepEqual(result, { removed: 2, preserved: 2 });
  assert.equal(store.read(stale), null);
  assert.equal(store.read(overflow), null);
  assert.ok(store.read(kept));
  assert.ok(store.read(recent));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-path-store.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the path store using existing persistence helpers**

Import `atomicJson` and `readJsonWithBackup` from `src/local-store.mjs`. Persist only the normalized Task 1 schema. Set the path directory to user-only permissions where supported, matching the existing state-file behavior. Never persist upstream response objects.

- [ ] **Step 4: Implement bounded pruning**

`prune` must resolve every candidate path under the exact `factor-paths` directory and skip IDs in `keepIds`. Remove a file only when its ID is explicitly in `removeIds` or its stored `lastAt` is older than `cutoffAt`. Ignore invalid IDs, never follow links outside the path directory, and return counts rather than filenames.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 2 command. Expected: all path-store tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/factor-path-store.mjs test/factor-path-store.test.mjs
git commit -m "feat: persist factor paths atomically"
```

### Task 3: Bidirectional No-Replacement Control Matching

**Files:**
- Modify: `src/factor-lab.mjs:383-406,1047-1111`
- Modify: `test/factor-lab.test.mjs`

**Interfaces:**
- Reuses: existing `matchDistance(signal, control)`.
- Produces: exported `reconcileControlMatches(trades): Array<{ signalId, controlId, distance }>`.
- Matching order: eligible pairs sorted by distance, then signal time, signal ID, control time, control ID; each signal and control may appear once.

- [ ] **Step 1: Write failing arrival-order and no-replacement tests**

Extend the existing `factor-lab.mjs` test import with `reconcileControlMatches`, then add:

```js
const strategy = defaultSoftStrategy(policy);

test('control matching works when the control arrives after the signal', () => {
  const signal = createShadowTrade(candidate(), { cohort: 'signal', signalAt: 100_000, policy, strategy });
  const control = createShadowTrade(candidate({ address: '0x2', marketCap: 42_000 }), {
    cohort: 'control', signalAt: 105_000, policy, strategy
  });
  const pairs = reconcileControlMatches([signal, control]);
  assert.deepEqual(pairs.map(row => [row.signalId, row.controlId]), [[signal.id, control.id]]);
  assert.equal(signal.matchedTradeId, control.id);
  assert.equal(control.matchedTradeId, signal.id);
});

test('matching is deterministic and never reuses a control', () => {
  const build = () => {
    const near = createShadowTrade(candidate({ address: 'near', marketCap: 41_000 }), {
      cohort: 'signal', signalAt: 100_000, policy, strategy
    });
    const far = createShadowTrade(candidate({ address: 'far', marketCap: 60_000 }), {
      cohort: 'signal', signalAt: 100_000, policy, strategy
    });
    const control = createShadowTrade(candidate({ address: 'control', marketCap: 42_000 }), {
      cohort: 'control', signalAt: 105_000, policy, strategy
    });
    return { near, far, control };
  };
  const first = build();
  const firstPairs = reconcileControlMatches([first.far, first.control, first.near]);
  assert.deepEqual(firstPairs.map(row => [row.signalId, row.controlId]), [[first.near.id, first.control.id]]);
  assert.equal(first.far.matchedTradeId, undefined);

  const second = build();
  const secondPairs = reconcileControlMatches([second.near, second.control, second.far]);
  assert.deepEqual(secondPairs.map(row => [row.signalId, row.controlId]), [[second.near.id, second.control.id]]);
  assert.equal(second.far.matchedTradeId, undefined);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-lab.test.mjs
```

Expected: FAIL because `reconcileControlMatches` is not exported.

- [ ] **Step 3: Implement deterministic reconciliation**

Build all finite-distance unmatched signal-control edges, sort with the documented tie breakers, and greedily assign unused IDs. Ignore contaminated controls. Do not rematch an existing valid pair.

- [ ] **Step 4: Invoke reconciliation after either cohort arrives**

In `recordCandidate`, call `reconcileControlMatches(this.state.trades)` after pushing any signal or control. After a control is contaminated and its old pair is cleared, run reconciliation again so the signal may receive another eligible unused control.

- [ ] **Step 5: Add contamination and restart tests**

Persist and reload a matched state, then prove:

- the same pair remains stable after restart;
- a contaminated control is removed from the pair;
- a replacement control is selected once;
- no control is paired with two signals.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Task 3 command. Expected: all factor-lab tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/factor-lab.mjs test/factor-lab.test.mjs
git commit -m "fix: reconcile late factor controls"
```

### Task 4: Research-Path Collection and Fixed-Horizon Reuse

**Files:**
- Modify: `src/factor-lab.mjs:920-945,1131-1267`
- Modify: `src/main.mjs:25-38`
- Modify: `test/factor-lab-v2-state.test.mjs`
- Modify: `test/factor-lab-scanner.test.mjs`

**Interfaces:**
- Consumes: `FactorPathStore` from Task 2 and `gmgn.candlesBetween(address, fromAt, toAt, chain, now)`.
- Constructor becomes `new FactorLab(stateDir, { policy, now, pathStore } = {})`; production defaults to `new FactorPathStore(stateDir)`.
- Each trade receives only bounded metadata:
  `path: { schemaVersion, firstAt, lastAt, observedBars, expectedBars, missingBars, coverage, continuous, mfeRate, mfeAt, maeRate, maeAt, maxDrawdownRate, lastFailureCode, nextAt }`.
- Full bars remain in the path store and are never returned by status/export.

- [ ] **Step 1: Write a failing unfunded-signal path test**

```js
test('one path read fills multiple horizons for an unfunded research signal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-research-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1;
  const lab = new FactorLab(dir, { policy: defaultPolicy(), now: () => now });
  const trade = lab.recordCandidate(row(), { now: 1 });
  trade.portfolioStatus = 'SKIPPED_CAPACITY';
  trade.portfolioStakeUsdc = 0;
  trade.entry = { targetAt: 60_000, at: 60_000, price: 1, liquidity: 10_000 };
  now = 1_000_000;
  const gmgn = {
    disabled: false,
    nextAllowedAt: 0,
    async candlesBetween() {
      return [
        { openAt: 300_000, closeAt: 360_000, open: 1, high: 1.2, low: .9, close: 1.1 },
        { openAt: 600_000, closeAt: 660_000, open: 1.1, high: 1.3, low: 1, close: 1.2 },
        { openAt: 900_000, closeAt: 960_000, open: 1.2, high: 1.2, low: .8, close: .9 }
      ];
    }
  };
  await lab.collect(gmgn, { limit: 1, now: () => now });
  assert.equal(trade.samples.m5.price, 1.1);
  assert.equal(trade.samples.m10.price, 1.2);
  assert.equal(trade.samples.m15.price, .9);
  assert.equal(trade.path.observedBars, 3);
  assert.equal(trade.allocatedUsdc, undefined);
});
```

- [ ] **Step 2: Run the focused state/scanner tests and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-lab-v2-state.test.mjs test\factor-lab-scanner.test.mjs
```

Expected: FAIL because unfunded signals currently use point reads and have no path summary.

- [ ] **Step 3: Inject the path store and define research path eligibility**

Eligible rows:

- every non-legacy experiment signal with a valid entry until `min(entryAt + 24h, closedAt if funded and closed)`;
- matched controls until the same horizon as their paired signal;
- open funded positions first;
- then pending entries;
- then incomplete experiment signals;
- then matched controls;
- hard-reject observations remain fixed-horizon only in Phase 1.

- [ ] **Step 4: Replace eligible point reads with one path read**

For each selected row:

1. read from `path.lastAt || entry.at` through `min(now, targetEndAt)`;
2. append normalized candles to the path store;
3. update bounded path metadata;
4. use candle closes to fill every due fixed horizon without future backfill;
5. run account exit detection only for funded `OPEN` or `RUNNER` positions;
6. preserve one read slot for due entries when `limit > 1`.

- [ ] **Step 5: Record explicit collection failures**

Map failures to allowlisted codes:

- `RATE_LIMITED`
- `TIMEOUT`
- `NO_CANDLE`
- `UNTRADEABLE`
- `NO_LIQUIDITY`
- `READ_FAILED`

Increment attempts and set bounded retry time. Do not turn transient failures into -100%; only confirmed untradeable/no-liquidity outcomes use the conservative loss rule.

- [ ] **Step 6: Add fairness and failure tests**

Prove:

- funded open positions remain first;
- pending entries retain one read slot;
- research signals rotate by `lastPathAttemptAt`;
- a rate limit stops the cycle;
- a timeout remains missing;
- confirmed untradeable remains conservative -100%;
- duplicate bars do not advance coverage;
- no future candle fills an earlier horizon.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Task 4 command. Expected: all focused tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/factor-lab.mjs src/main.mjs test/factor-lab-v2-state.test.mjs test/factor-lab-scanner.test.mjs
git commit -m "feat: collect complete research price paths"
```

### Task 5: Data-Quality Gate and Collect-Only Automation

**Files:**
- Create: `src/factor-data-quality.mjs`
- Create: `test/factor-data-quality.test.mjs`
- Modify: `src/factor-lab.mjs:1009-1044,1337-1419`
- Modify: `test/factor-lab.test.mjs`

**Interfaces:**
- Produces `buildDataQualitySummary(trades, { now }): DataQualitySummary`.
- Summary shape:
  `{ phase: 'DATA_TRUST', collectOnly: true, canGenerateCandidate: false, canPromote: false, primaryBlocker, reasons, coverage, pathCoverage, matchedPairs, completed15m, targets }`.
- `targets` is fixed to `{ completed15m: 100, matchedPairs: 40, horizonCoverage: 0.8, pathCoverage: 0.8 }`.

- [ ] **Step 1: Write failing quality-gate tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataQualitySummary } from '../src/factor-data-quality.mjs';

test('quality gate names the strongest blocker and cannot be bypassed by user auto-promotion', () => {
  const trades = Array.from({ length: 22 }, (_, index) => ({
    id: String(index).padStart(32, '0'),
    cohort: 'signal',
    signalAt: index * 60_000,
    entry: { at: index * 60_000, price: 1 },
    samples: {
      m5: { conservativeReturn: .01 },
      m10: { conservativeReturn: .01 },
      m15: { conservativeReturn: .01 }
    },
    path: { observedBars: 15, expectedBars: 15, coverage: 1 }
  }));
  const quality = buildDataQualitySummary(trades, { now: 2_000_000 });
  assert.equal(quality.phase, 'DATA_TRUST');
  assert.equal(quality.collectOnly, true);
  assert.equal(quality.canGenerateCandidate, false);
  assert.equal(quality.primaryBlocker, 'MATCHED_PAIRS');
  assert.deepEqual(quality.targets, {
    completed15m: 100, matchedPairs: 40, horizonCoverage: .8, pathCoverage: .8
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-data-quality.test.mjs test\factor-lab.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic quality summaries**

Count only eligible signals for horizon coverage. Count path coverage from the same eligible set. Rank blockers in this order:

1. source/integrity failure;
2. zero or insufficient matched pairs;
3. path coverage;
4. fixed-horizon coverage;
5. completed 15-minute samples.

Return counts needed to reach every target; never return negative remaining values.

- [ ] **Step 4: Enforce collect-only mode**

At the start of `automationTick`, compute the Phase 1 quality summary and return:

```js
{
  action: 'collect_only',
  reason: quality.primaryBlocker,
  quality
}
```

Do not call `candidateMutations`, `startChallenger`, `evaluateChallenger`, or promotion code in Phase 1. Preserve existing champion, challenger history, user pause preference, and rollback data.

Add a `FactorLab` test that sets `state.autoPromotionEnabled = true`, supplies otherwise promotion-ready synthetic rows, invokes `automationTick`, and asserts `action === 'collect_only'` and that champion/challenger/history are unchanged.

- [ ] **Step 5: Expose the quality summary**

Add `optimization: quality` to `FactorLab.summary()`. Add tests proving malformed trades and missing path metadata lower coverage rather than throwing.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Task 5 command. Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/factor-data-quality.mjs src/factor-lab.mjs test/factor-data-quality.test.mjs test/factor-lab.test.mjs
git commit -m "feat: gate optimization on trustworthy data"
```

### Task 6: Sanitized API and Decision-First Dashboard

**Files:**
- Modify: `src/server.mjs:389-433`
- Modify: `public/index.html`
- Modify: `test/factor-lab-api.test.mjs`
- Modify: `test/ui.test.mjs`

**Interfaces:**
- `/api/status.factorLabSummary.optimization` exposes only allowlisted scalar counts, rates, reason codes, phase, and booleans.
- Dashboard IDs:
  - `optimizationState`
  - `optimizationProblem`
  - `optimizationNextAction`
  - `optimizationProgress`
  - `optimizationRiskState`

- [ ] **Step 1: Write failing API allowlist tests**

Add a synthetic summary containing safe quality fields plus `raw`, `privateKey`, and an unknown nested object. Assert the API returns the exact allowlisted optimization object and serialized output contains none of the forbidden strings.

- [ ] **Step 2: Write failing UI structure and wording tests**

```js
test('持续优化决策板先展示当前问题和下一动作且不常驻明细', () => {
  for (const id of [
    'optimizationState', 'optimizationProblem', 'optimizationNextAction',
    'optimizationProgress', 'optimizationRiskState'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /collectOnly/);
  assert.match(html, /匹配对照不足/);
  assert.match(html, /自动晋级暂停.*影子采集继续/);
});
```

- [ ] **Step 3: Run API/UI tests and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-lab-api.test.mjs test\ui.test.mjs
```

Expected: FAIL because the new fields and decision board do not exist.

- [ ] **Step 4: Add the server allowlist**

Map reason codes to stable public codes; do not expose internal errors, paths, raw bars, provider payloads, or credentials. Include `optimization` in `/api/status` and `/api/export` through the existing sanitized summary.

- [ ] **Step 5: Add the compact decision board**

Place it below service/chain status and above strategy result metrics. Display:

- `采集中` for `DATA_TRUST`;
- the strongest blocker;
- the next collection action;
- `完成15m / 100 · 匹配对 / 40 · 覆盖率 / 80%`;
- `固定仓位基线` as the Phase 1 account-risk state; do not claim that the 5%/10%/15% dynamic drawdown controller is active before its dedicated phase is implemented.

Put detailed quality metrics in a collapsed `<details>` section. Add six-language dictionary entries and preserve mobile table behavior.

- [ ] **Step 6: Run API/UI tests and verify GREEN**

Run the Task 6 command. Expected: all tests PASS and inline scripts parse.

- [ ] **Step 7: Commit**

```powershell
git add src/server.mjs public/index.html test/factor-lab-api.test.mjs test/ui.test.mjs
git commit -m "feat: show optimization data quality decisions"
```

### Task 7: V3 Migration, Retention, and Public Export

**Files:**
- Modify: `src/factor-lab.mjs:10,421-562,668-710,827-920,1465-1478`
- Modify: `test/factor-lab-v2-state.test.mjs`
- Modify: `test/factor-lab-api.test.mjs`
- Modify: `test/factor-lab-reports.test.mjs`

**Interfaces:**
- Increment `FACTOR_LAB_VERSION` from 2 to 3.
- V2 rows migrate without invented path bars.
- Migrated rows receive `path: { schemaVersion: 1, historicalUnavailable: true }` only when they have historical samples but no stored path.
- Public trades/positions expose bounded path summaries, never full bars.

- [ ] **Step 1: Write a failing V2 migration preservation test**

Extend the existing `factor-lab.mjs` test import with `defaultSoftStrategy` and `strategyFingerprint`, then add:

```js
test('V2 migration preserves every row and sample without inventing path coverage', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v3-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policy = defaultPolicy();
  const strategy = defaultSoftStrategy(policy);
  fs.writeFileSync(path.join(dir, 'factor-lab.json'), JSON.stringify({
    version: 2,
    autoPromotionEnabled: true,
    champion: {
      version: strategyFingerprint(strategy),
      strategy,
      activatedAt: 1
    },
    previousChampion: null,
    challenger: null,
    positions: [{
      id: 'a'.repeat(32), cohort: 'signal', chain: 'bsc', address: '0x1',
      signalAt: 1, samples: { m15: { conservativeReturn: .1 } }
    }],
    referenceSamples: [{
      id: 'b'.repeat(32), cohort: 'control', chain: 'bsc', address: '0x2',
      signalAt: 2, samples: { m15: { conservativeReturn: -.1 } }
    }],
    reports: [],
    aggregates: [],
    history: [],
    portfolioEpoch: {
      id: 'c'.repeat(24), startedAt: 1, costModelVersion: 3, fixedCostRate: .05
    },
    lastPromotionAt: 0,
    disabledReason: ''
  }));
  const lab = new FactorLab(dir, { policy, now: () => 1_000 });
  assert.equal(FACTOR_LAB_VERSION, 3);
  assert.equal(lab.state.trades.length, 2);
  assert.equal(lab.state.trades.reduce((n, row) => n + Object.keys(row.samples || {}).length, 0), 2);
  assert.ok(lab.state.trades.every(row => row.path.historicalUnavailable === true));
  assert.ok(lab.state.trades.every(row => row.path.coverage === undefined));
});
```

- [ ] **Step 2: Run migration/API/report tests and verify RED**

Run:

```powershell
& 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime\node.exe' --test test\factor-lab-v2-state.test.mjs test\factor-lab-api.test.mjs test\factor-lab-reports.test.mjs
```

Expected: FAIL because the persisted version is still 2 and path migration is absent.

- [ ] **Step 3: Implement V2-to-V3 migration**

Preserve positions, reference samples, reports, aggregates, strategy versions, portfolio epoch, history, links, samples, cashflows, and retries. Add one `STATE_MIGRATED` history record with `fromVersion: 2`, `toVersion: 3`, and counts. Do not reset profit, portfolio epoch, or candidate state.

- [ ] **Step 4: Integrate path retention**

When `FactorLab.prune` archives trades:

- preserve derived path summary fields in aggregates;
- collect removable path IDs in `this.pendingPathPruneIds`;
- call `atomicJson(this.file, persisted)` first inside `save()`;
- only after that write succeeds, call `pathStore.prune({ keepIds, removeIds: this.pendingPathPruneIds, cutoffAt })` and clear the pending IDs;
- keep files for open positions and retained rows;
- remove only expired/overflow path files older than 90 days;
- record only aggregate removal counts.

- [ ] **Step 5: Extend sanitized public views**

Expose `path` as:

```js
{
  schemaVersion, historicalUnavailable, firstAt, lastAt,
  observedBars, expectedBars, missingBars, coverage, continuous,
  mfeRate, mfeAt, maeRate, maeAt, maxDrawdownRate, lastFailureCode
}
```

Reject or omit all other keys. Export aggregates and reports with summary counts only.

- [ ] **Step 6: Add backup, retention, and leakage tests**

Prove:

- corrupt V3 primary recovers from `.bak`;
- migration is idempotent across restart;
- open paths survive retention;
- stale closed paths are pruned after the index is saved;
- exports contain no bars, credentials, raw upstream data, absolute paths, or provider errors.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Task 7 command. Expected: all tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/factor-lab.mjs test/factor-lab-v2-state.test.mjs test/factor-lab-api.test.mjs test/factor-lab-reports.test.mjs
git commit -m "feat: migrate factor lab to trusted path data"
```

### Task 8: Full Verification and 43892 Rollout

**Files:**
- Create: `scripts/testing/data-trust-smoke.mjs`
- Modify: `package.json`
- Test: all `test/*.test.mjs`

**Interfaces:**
- Adds npm script `smoke:data-trust` invoking the isolated smoke test.
- The smoke test creates a temporary state directory, injects a fake GMGN reader, restarts the lab from disk, and prints only aggregate assertions.

- [ ] **Step 1: Write the failing smoke script**

The script must:

1. create a temporary state directory;
2. create one signal before one eligible control;
3. collect an unordered path with one duplicate and one gap;
4. assert a late matched pair exists;
5. assert MAE/MFE and coverage survive restart;
6. assert `automationTick().action === 'collect_only'`;
7. assert public export contains no full bars or secret sentinel;
8. clean only its validated temporary directory in `finally`.

- [ ] **Step 2: Run the smoke script and verify RED**

Run:

```powershell
$runtimeDir = 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime'
$env:PATH = $runtimeDir + ';' + $env:PATH
& (Join-Path $runtimeDir 'npm.cmd') run smoke:data-trust
```

Expected: FAIL until the script is registered and all Phase 1 interfaces exist.

- [ ] **Step 3: Register and complete the isolated smoke**

Add:

```json
"smoke:data-trust": "node scripts/testing/data-trust-smoke.mjs"
```

Keep fixtures local and deterministic; do not make network requests.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```powershell
$runtimeDir = 'D:\99\Documents\MemeRadar-OpenSource-Windows-x64-0.1.6\MemeRadar-OpenSource-Windows\runtime'
$env:PATH = $runtimeDir + ';' + $env:PATH
& (Join-Path $runtimeDir 'npm.cmd') test
Get-ChildItem -Recurse -File -Filter '*.mjs' |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  ForEach-Object { & (Join-Path $runtimeDir 'node.exe') --check $_.FullName; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
& (Join-Path $runtimeDir 'npm.cmd') run doctor
& (Join-Path $runtimeDir 'npm.cmd') audit --omit=dev
& (Join-Path $runtimeDir 'npm.cmd') run smoke:data-trust
git diff --check
```

Expected: nonzero test count with zero failures, every syntax check exits 0, doctor reports ready, audit reports zero known vulnerabilities, smoke exits 0, and `git diff --check` is clean.

- [ ] **Step 5: Rehearse migration on a credential-free live-state copy**

Copy only:

- `D:\CodexProjects\meme-radar\state\factor-lab.json`
- its `.bak` if present.

Do not copy `gmgn-key.json`, signing keys, preferences, annotations, or raw provider responses. In a temporary directory instantiate the V3 `FactorLab`, then assert:

- row count before equals row count after;
- fixed-horizon sample count before equals count after;
- portfolio epoch and current P/L are unchanged;
- historical rows are marked unavailable, not complete;
- a second restart does not add another migration record.

- [ ] **Step 6: Commit the verification harness**

```powershell
git add package.json scripts/testing/data-trust-smoke.mjs
git commit -m "test: add data trust rollout smoke"
```

- [ ] **Step 7: Merge locally only after a final branch review**

Use a fast-forward merge into local `main`. Rerun `npm test` on merged `main`. Do not push or create a release unless separately authorized.

- [ ] **Step 8: Restart only the independent 43892 supervisor**

Before stopping anything:

- verify the 43892 listener and supervisor command lines point inside `D:\CodexProjects\meme-radar`;
- verify any lock PID is live or conclusively stale;
- back up only `state/factor-lab.json`;
- never stop or modify a process bound to 3791.

Start the supervisor with bundled Node, `RADAR_PORT=43892`, and `-WindowStyle Hidden`.

- [ ] **Step 9: Verify the live result**

Assert:

- `/health.ok === true`;
- scanner freshness updates after a successful cycle;
- `/api/status.factorLabSummary.optimization.phase === 'DATA_TRUST'`;
- `collectOnly === true` and `canPromote === false`;
- matched-pair count can increase when controls arrive after signals;
- page displays the blocker, next action, sample progress, and risk state;
- `/api/export` contains no full bars, credentials, private keys, raw upstream payloads, or absolute paths;
- the original 3791 directory and state are unchanged.
