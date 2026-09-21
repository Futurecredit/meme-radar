import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactorPathStore } from '../src/factor-path-store.mjs';

const bar = openAt => ({
  openAt,
  closeAt: openAt + 60_000,
  open: 1,
  high: 1.2,
  low: .8,
  close: 1.1
});

test('path store persists an allowlisted path and recovers a corrupt primary from backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-path-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'a'.repeat(32);
  const store = new FactorPathStore(dir);
  store.append(id, [bar(60_000)], {
    now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000
  });
  store.append(id, [bar(120_000)], {
    now: 180_000, entryAt: 60_000, entryPrice: 1, throughAt: 180_000
  });
  fs.writeFileSync(path.join(dir, 'factor-paths', `${id}.json`), '{broken');
  const recovered = store.read(id);
  assert.equal(recovered.bars.length, 1);
  assert.equal(recovered.lastAt, 120_000);
  assert.doesNotMatch(JSON.stringify(recovered), /raw|apiKey|privateKey/);
});

test('path store rejects traversal and prunes only stale or explicit overflow paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-path-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FactorPathStore(dir);
  assert.throws(() => store.read('../factor-lab'), /invalid_trade_id/);
  const kept = 'b'.repeat(32), recent = 'c'.repeat(32);
  const stale = 'd'.repeat(32), overflow = 'e'.repeat(32);
  store.append(kept, [bar(60_000)], {
    now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000
  });
  store.append(recent, [bar(120_000)], {
    now: 180_000, entryAt: 120_000, entryPrice: 1, throughAt: 180_000
  });
  store.append(stale, [bar(60_000)], {
    now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000
  });
  store.append(overflow, [bar(120_000)], {
    now: 180_000, entryAt: 120_000, entryPrice: 1, throughAt: 180_000
  });
  const result = store.prune({
    keepIds: new Set([kept]), removeIds: new Set([overflow]), cutoffAt: 150_000
  });
  assert.deepEqual(result, { removed: 2, preserved: 2 });
  assert.equal(store.read(stale), null);
  assert.equal(store.read(overflow), null);
  assert.ok(store.read(kept));
  assert.ok(store.read(recent));
});

test('path store returns a bounded summary without exposing full bars', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-path-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FactorPathStore(dir);
  const id = 'f'.repeat(32);
  const result = store.append(id, [bar(60_000)], {
    now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000
  });
  assert.equal(result.path.bars.length, 1);
  assert.deepEqual(store.summary(id, {
    entryAt: 60_000, entryPrice: 1, throughAt: 120_000
  }), result.summary);
  assert.equal(Object.hasOwn(result.summary, 'bars'), false);
});

test('retention preserves a path whose last timestamp is unknown', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factor-path-unknown-time-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FactorPathStore(dir);
  const id = '1'.repeat(32);
  store.append(id, [], { now: 120_000, entryAt: 60_000, entryPrice: 1, throughAt: 120_000 });
  assert.deepEqual(store.prune({ cutoffAt: 150_000 }), { removed: 0, preserved: 1 });
  assert.ok(store.read(id));
});
