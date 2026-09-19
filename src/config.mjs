import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPolicy, runtimePolicy } from './policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export const config = Object.freeze({
  ...runtimePolicy(defaultPolicy()),
  chain: 'robinhood',
  supportedChains: Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']),
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  auditCycleBudgetMs: 80_000,
  outcomeReadsPerCycle: 4,
  factorLabReadsPerCycle: 4,
  xReviewMode: 'manual',
  maxRugRatio: 0.20,
  maxTop10Rate: 0.30,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.20,
  maxLinkedHoldRate: 0.10,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTaxAsymmetry: 0.02,
  minLpLockedRate: 0.80,
  minOrdinaryWallets: 8,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  queueRetentionMs: 24 * 60 * 60_000,
  candidateRetentionMs: 2 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
  stateDir: path.join(ROOT, 'state'),
  publicDir: path.join(ROOT, 'public')
});
