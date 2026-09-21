import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJsonWithBackup } from './local-store.mjs';
import {
  FACTOR_PATH_VERSION, appendPathCandles, normalizePathCandles, summarizePath
} from './factor-path.mjs';

const TRADE_ID = /^[a-f0-9]{1,64}$/;

function requireTradeId(value) {
  const id = String(value || '');
  if (!TRADE_ID.test(id)) throw Object.assign(new Error('invalid_trade_id'), { code: 'INVALID_TRADE_ID' });
  return id;
}

function count(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizePersisted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bars = normalizePathCandles(value.bars, { now: Number.MAX_SAFE_INTEGER });
  return {
    version: FACTOR_PATH_VERSION,
    bars,
    firstAt: bars.length ? bars[0].openAt : null,
    lastAt: bars.length ? bars.at(-1).closeAt : null,
    invalidBars: count(value.invalidBars),
    duplicateBars: count(value.duplicateBars)
  };
}

export class FactorPathStore {
  constructor(stateDir) {
    this.dir = path.join(path.resolve(String(stateDir)), 'factor-paths');
  }

  file(tradeId) {
    return path.join(this.dir, `${requireTradeId(tradeId)}.json`);
  }

  read(tradeId) {
    const file = this.file(tradeId);
    const loaded = readJsonWithBackup(file, null).value;
    return normalizePersisted(loaded);
  }

  append(tradeId, candles, context = {}) {
    const file = this.file(tradeId);
    const pathState = appendPathCandles(this.read(tradeId), candles, context);
    atomicJson(file, pathState);
    try { fs.chmodSync(this.dir, 0o700); } catch {}
    return { path: pathState, summary: summarizePath(pathState, context) };
  }

  summary(tradeId, context = {}) {
    const pathState = this.read(tradeId);
    return pathState ? summarizePath(pathState, context) : null;
  }

  prune({ keepIds = new Set(), removeIds = new Set(), cutoffAt = 0 } = {}) {
    if (!fs.existsSync(this.dir)) return { removed: 0, preserved: 0 };
    const keep = new Set([...keepIds].map(requireTradeId));
    const remove = new Set([...removeIds].filter(value => TRADE_ID.test(String(value))).map(String));
    const cutoff = Number.isFinite(Number(cutoffAt)) ? Number(cutoffAt) : 0;
    let removed = 0;
    let preserved = 0;

    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!TRADE_ID.test(id)) continue;
      if (keep.has(id)) {
        preserved++;
        continue;
      }
      const pathState = this.read(id);
      const stale = pathState?.lastAt !== null && Number.isFinite(Number(pathState?.lastAt))
        && Number(pathState.lastAt) < cutoff;
      if (!remove.has(id) && !stale) {
        preserved++;
        continue;
      }
      for (const target of [this.file(id), `${this.file(id)}.bak`]) {
        try { fs.unlinkSync(target); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      removed++;
    }
    return { removed, preserved };
  }
}
