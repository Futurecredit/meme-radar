import { DISCOVERY_EXPLICIT_RISK_CAP, OBSERVATION_RULES, SELLABILITY_RULES } from './scoring.mjs';

const WEIGHT_KEYS = Object.freeze([
  'priorityBand', 'ordinaryBand', 'liquidityCap', 'liquidityDivisor',
  'volumeCap', 'volumeDivisor', 'holdersCap', 'holdersDivisor',
  'smartTwo', 'smartThree', 'kolPenalty'
]);

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const range = (minimum, maximum) => ({ minimum: number(minimum), maximum: number(maximum) });
const minimum = value => ({ minimum: number(value) });
const maximum = value => ({ maximum: number(value) });

export function screeningRuleManifest(policy = {}, settings = {}, strategy = {}) {
  const discovery = policy.discovery || {};
  const weights = Object.fromEntries(WEIGHT_KEYS.map(key => [key, number(strategy.weights?.[key])]));
  return {
    version: 1,
    discovery: {
      marketCapUsd: range(discovery.minMarketCap, discovery.maxMarketCap),
      priorityMarketCapUsd: range(discovery.priorityMinMarketCap, discovery.priorityMaxMarketCap),
      liquidityUsd: minimum(discovery.minLiquidity),
      ageMinutes: range(discovery.minAgeMinutes, discovery.maxAgeMinutes),
      explicitRiskCaps: {
        rugRatio: DISCOVERY_EXPLICIT_RISK_CAP,
        bundlerRate: DISCOVERY_EXPLICIT_RISK_CAP,
        insiderRate: DISCOVERY_EXPLICIT_RISK_CAP
      },
      rejectWashTrading: true,
      rejectHoneypotOnEvm: true
    },
    deep: {
      liquidityUsd: minimum(discovery.strictLiquidity),
      lpLockedRate: minimum(settings.minLpLockedRate),
      buyTaxRate: maximum(settings.maxBuyTax),
      sellTaxRate: maximum(settings.maxSellTax),
      taxAsymmetryRate: maximum(settings.maxTaxAsymmetry),
      rugRatio: maximum(settings.maxRugRatio),
      top10HoldRate: maximum(settings.maxTop10Rate),
      developerHoldRate: maximum(0.01),
      insiderRate: maximum(settings.maxInsiderRate),
      bundlerRate: maximum(settings.maxBundlerRate),
      sniperHoldRate: maximum(settings.maxSniperHoldRate),
      botHoldRate: maximum(settings.maxBotHoldRate),
      linkedHoldRate: maximum(settings.maxLinkedHoldRate),
      ordinaryWallets: minimum(settings.minOrdinaryWallets),
      requiresOpenSource: true,
      requiresAuthorityRenounced: true,
      rejectsWashTrading: true
    },
    observation: {
      closedMinuteBars: minimum(OBSERVATION_RULES.minimumClosedMinuteBars),
      stalenessMinutes: maximum(OBSERVATION_RULES.maximumStalenessMinutes),
      return5m: range(OBSERVATION_RULES.minimumReturn5m, OBSERVATION_RULES.maximumReturn5m),
      drawdown: maximum(OBSERVATION_RULES.maximumDrawdown),
      volumeConcentration: maximum(OBSERVATION_RULES.maximumVolumeConcentration),
      activeBars: minimum(OBSERVATION_RULES.minimumActiveBars)
    },
    sellability: {
      sells5m: minimum(SELLABILITY_RULES.minimumSells5m),
      sells24h: minimum(SELLABILITY_RULES.minimumSells24h),
      distinctRecentSellers: minimum(SELLABILITY_RULES.minimumDistinctRecentSellers)
    },
    ranking: { weights },
    automaticTuning: {
      mutable: ['marketCap', 'liquidity', 'age', 'priorityBand', 'volume', 'holders', 'smartMoney', 'kolPenalty'],
      immutable: ['contractSafety', 'tax', 'lp', 'walletConcentration', 'insider', 'bots', 'linkedWallets', 'exitPolicy'],
      maximumSingleChangeRate: 0.10
    }
  };
}
