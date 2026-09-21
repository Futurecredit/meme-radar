import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

test('所有内联脚本均可通过语法解析', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('所有显式像素字号均不小于14像素', () => {
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every(size => size >= 14));
});

test('看板明确区分累计、本轮和近30分钟口径', () => {
  assert.match(html, /<h1[^>]*>Meme雷达开源版<\/h1>/);
  assert.match(html, /class="mark">雷达<\/div>/);
  assert.match(html, /扫描轮次[\s\S]*累计/);
  assert.match(html, /发现代币[\s\S]*本轮/);
  assert.match(html, /深度审计[\s\S]*近30分钟/);
  assert.match(html, /链上候选\/待人工看X/);
  assert.doesNotMatch(html, /最终候选/);
});

test('人工复核仅保存本地标记且不包含交易入口', () => {
  assert.match(html, /robinhoodRadarManualMarksV1/);
  assert.match(html, /data-action="pass"/);
  assert.match(html, /data-action="ignore"/);
  assert.match(html, /复制合约/);
  assert.match(html, /官网无/);
  assert.match(html, /访问官网/);
  assert.match(html, /safeUrl\(row\.info && row\.info\.website\)/);
  assert.match(html, /officialXHandle/);
  assert.match(html, /normalizeXHandle/);
  assert.match(html, /reservedXPaths/);
  assert.match(html, /普通钱包代理数量未知/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /只扫描、不交易/);
});

test('前端X入口拒绝站内功能页并只生成单层用户名链接', () => {
  const start = html.indexOf('const reservedXPaths = new Set(');
  const end = html.indexOf('function officialXHandle', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.runInNewContext(html.slice(start, end) + '\nthis.normalize = normalizeXHandle;', context);
  assert.equal(context.normalize('https://x.com/search?q=test'), '');
  assert.equal(context.normalize('https://x.com/home'), '');
  assert.equal(context.normalize('x.com/real_handle'), 'real_handle');
  assert.equal(context.normalize('@real_handle'), 'real_handle');
  assert.equal(context.normalize('https://example.com/x.com/fake'), '');
  assert.equal('https://x.com/' + encodeURIComponent(context.normalize('x.com/real_handle')), 'https://x.com/real_handle');
});

test('六语切换持久化并支持阿拉伯语RTL', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar']) {
    assert.match(html, new RegExp('<option value="' + locale + '"'));
  }
  assert.match(html, /memeRadarLanguageV1/);
  assert.match(html, /document\.documentElement\.dir = currentLocale === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(html, /html\[dir="rtl"\]/);
  assert.match(html, /data-i18n="appTitle"/);
  assert.match(html, /data-i18n="screeningAuditTitle"/);
  assert.match(html, /t\(statusKeys\[data\.status\]/);
  assert.doesNotMatch(html, /GMGN多链候选雷达 · 只扫描、只筛选、永不下单/);
});

test('语言下拉使用地球图标和深色高对比选项', () => {
  assert.match(html, /class="language-icon" aria-hidden="true">🌐<\/span>/);
  assert.match(html, /class="visually-hidden" data-i18n="languageLabel">语言<\/span>/);
  assert.match(html, /\.language-select\s*\{[\s\S]*?color-scheme:\s*dark/);
  assert.match(html, /\.language-select option\s*\{[\s\S]*?background:\s*#0b151a;[\s\S]*?color:\s*#f2faf8/);
  assert.match(html, /\.language-select:focus-visible\s*\{[\s\S]*?outline:\s*1px solid #61cbd4/);
  assert.doesNotMatch(html, /\.language-select\s*\{[\s\S]*?background:\s*transparent/);
});

test('翻译词典完整覆盖静态挂点和动态文案键', () => {
  const dictionarySource = html.match(/const messages = (\{[\s\S]*?\r?\n    \});\r?\n\r?\n    let currentLocale/);
  assert.ok(dictionarySource, '应能提取翻译词典');
  const messages = vm.runInNewContext('(' + dictionarySource[1] + ')');
  for (const [key, values] of Object.entries(messages)) {
    assert.ok(Array.isArray(values), key + ' 应为数组');
    assert.equal(values.length, 6, key + ' 应包含六种语言');
    assert.ok(values.every(value => typeof value === 'string' && value.length > 0), key + ' 不应有空翻译');
  }
  const staticKeys = [...html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)].map(match => match[1]);
  const dynamicKeys = [...html.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  for (const key of new Set([...staticKeys, ...dynamicKeys])) assert.ok(messages[key], '缺少翻译键：' + key);
});

test('多链切换仅向本地后端提交白名单链标识', () => {
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']) {
    assert.match(html, new RegExp("id: '" + chain + "'"));
  }
  assert.match(html, /fetch\('\/api\/active-chain'/);
  assert.match(html, /JSON\.stringify\(\{ chain: chain \}\)/);
  assert.match(html, /renderChainSwitcher\(null\)/);
});

test('筛选规则按需在弹窗展示而不常驻占用首页', () => {
  assert.match(html, /id="screeningRulesButton"/);
  assert.match(html, /id="screeningRulesDialog"/);
  assert.match(html, /function renderScreeningRules\(/);
  assert.match(html, /data\.screeningRules/);
  const dialog = html.match(/<dialog id="screeningRulesDialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(dialog, /id="screeningRulesContent"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<dialog id="screeningRulesDialog"')), /严格筛选标准/);
});

test('GMGN密钥仅提交给同源接口且不会持久化或回显', () => {
  assert.match(html, /id="gmgnKeyInput"[^>]*type="password"[^>]*autocomplete="off"[^>]*spellcheck="false"[^>]*maxlength="256"/);
  assert.match(html, /id="gmgnKeyButton"[^>]*data-i18n-aria="gmgnApiSubmitAria"/);
  assert.match(html, /id="gmgnKeyStatus"[^>]*aria-live="polite"/);
  const start = html.indexOf('async function connectGmgnApi');
  const end = html.indexOf('async function refresh', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  assert.match(source, /fetch\('\/api\/gmgn-key'/);
  assert.match(source, /body: JSON\.stringify\(\{ apiKey: apiKey \}\)/);
  assert.match(source, /input\.value = ''/);
  assert.match(source, /t\('gmgnApiConnected'\)/);
  assert.match(source, /result\.verified !== true/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|readStorage|writeStorage/);
  assert.doesNotMatch(source, /console\.|innerHTML|textContent\s*=\s*result\./);
});

test('新用户无需Agent即可生成GMGN公钥且页面绝不请求私钥', () => {
  assert.match(html, /id="gmgnOnboardingButton"/);
  assert.match(html, /id="gmgnPublicKey"[^>]*readonly/);
  assert.match(html, /fetch\('\/api\/gmgn-onboarding'/);
  assert.match(html, /每次创建新的 GMGN API Key，都必须重新完成 Agent 公钥绑定/);
  assert.match(html, /JSON\.stringify\(\{ regenerate: regenerate === true \}\)/);
  assert.match(html, /只开启“允许读取”，务必关闭“允许交易”/);
  assert.doesNotMatch(html, /gmgn-private-key|privateKey\s*=/);
});

test('看板包含新鲜度、运行进度和动态降级支持', () => {
  assert.match(html, /最近扫描尝试/);
  assert.match(html, /最近成功扫描/);
  assert.match(html, /下轮扫描/);
  assert.match(html, /数据新鲜度/);
  assert.match(html, /scanInProgress/);
  assert.match(html, /WAIT_RECHECK/);
  assert.match(html, /HARD_REJECT/);
  assert.match(html, /筛选后表现验证/);
  assert.match(html, /30分钟结果/);
  assert.match(html, /2小时结果/);
  assert.match(html, /24小时结果/);
  assert.match(html, /未满50个只做观察，不用于调参/);
  assert.match(html, /prefers-reduced-motion/);
});

test('所有结果区使用紧凑语义表格而非即时榜卡片', () => {
  assert.match(html, /<table class="compact-table live-table">[\s\S]*?<tbody id="liveRows"/);
  assert.match(html, /<table class="compact-table outcome-table">[\s\S]*?id="outcomeTracked"/);
  assert.match(html, /<table class="compact-table audit-table">/);
  assert.doesNotMatch(html, /class="live-grid"|class="live-card/);
});

test('即时发现的每个币渲染为一行并保留审计和外链操作', () => {
  const start = html.indexOf('function liveTableRow');
  const end = html.indexOf('function renderLive', start);
  assert.ok(start >= 0 && end > start, '应提供独立的即时榜表格行渲染器');
  const context = {
    encodeURIComponent,
    escapeHtml: value => String(value ?? ''),
    t: (key, values) => values && values.seconds !== undefined ? key + ':' + values.seconds : key,
    formatMoney: value => '$' + value,
    formatCount: value => String(value),
    formatSignedPercent: value => String(value),
    formatDuration: value => String(value),
    actionLinks: () => '<div class="links">links</div>'
  };
  vm.runInNewContext(html.slice(start, end) + '\nthis.renderRow = liveTableRow;', context);
  const rendered = context.renderRow({
    address: '1234567890abcdef', symbol: 'DOG', name: 'Dog coin', marketCap: 12000,
    liquidity: 5000, volume1m: 900, buys1m: 8, sells1m: 3, smartMoney: 2,
    holders: 80, priceDelta: 0.12, deltaWindowMs: 15000, createdAt: 100, chain: 'sol'
  }, { now: 200000, isNew: true, reviewText: '待核验', canAudit: true, isQueued: false });
  assert.match(rendered, /^<tr class="new-sighting">/);
  assert.equal((rendered.match(/<td/g) || []).length, 10);
  assert.match(rendered, /data-live-audit="1234567890abcdef"/);
  assert.match(rendered, /class="links"/);
  assert.match(rendered, />liveNew</);
  assert.doesNotMatch(rendered, /<article|live-card/);
  const ordinary = context.renderRow({
    address: '1234567890abcdef', symbol: 'DOG', name: 'Dog coin', createdAt: 100, chain: 'sol'
  }, { now: 200000, isNew: false, reviewText: '待核验', canAudit: false, isQueued: false });
  assert.match(ordinary, />1m</);
});

test('即时榜表头不显示动态秒数占位符', () => {
  const dictionarySource = html.match(/const messages = (\{[\s\S]*?\r?\n    \});\r?\n\r?\n    let currentLocale/);
  assert.ok(dictionarySource);
  const messages = vm.runInNewContext('(' + dictionarySource[1] + ')');
  assert.match(html, /<th data-i18n="tokenColumn">代币<\/th>/);
  assert.match(html, /data-i18n="liveDeltaColumn"/);
  assert.ok(messages.liveDeltaColumn.every(value => !value.includes('{')));
});

test('表现收益刷新只切换色调并保留紧凑数值样式', () => {
  const start = html.indexOf('function renderOutcomes');
  const end = html.indexOf('function liveTableRow', start);
  const elements = new Proxy({}, { get: (target, key) => target[key] ||= { textContent: '', className: '', innerHTML: '' } });
  const context = {
    byId: id => elements[id],
    formatSignedPercent: value => String(value),
    formatCount: value => String(value),
    number: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    t: key => key,
    escapeHtml: value => String(value ?? ''),
    currentLocale: 'zh-CN'
  };
  vm.runInNewContext(html.slice(start, end) + '\nthis.renderOutcomesForTest = renderOutcomes;', context);
  context.renderOutcomesForTest({ outcomeSummary: { tracked: 1, averageReturn30m: 0.1, coverage: {} } });
  assert.match(elements.outcome30m.className, /\boutcome-value\b/);
  assert.match(elements.outcome30m.className, /\bgood\b/);
});

test('样本覆盖对照与深审操作也使用紧凑表格交互', () => {
  const outcomeStart = html.indexOf('function renderOutcomes');
  const outcomeEnd = html.indexOf('function liveTableRow', outcomeStart);
  const candidateStart = html.indexOf('function candidateRow');
  const candidateEnd = html.indexOf('function renderCandidates', candidateStart);
  assert.match(html.slice(outcomeStart, outcomeEnd), /class="compact-table coverage-table"/);
  assert.match(html.slice(candidateStart, candidateEnd), /class="action-menu"/);
  assert.match(html.slice(candidateStart, candidateEnd), /data-action="pass"/);
  assert.match(html.slice(candidateStart, candidateEnd), /data-action="copy"|actionLinks\(row\)/);
});

test('候选表明确展示GoPlus与DexScreener交叉验证', () => {
  assert.match(html, /GoPlus一票否决/);
  assert.match(html, /GoPlus未见致命项/);
  assert.match(html, /Dex复核/);
  assert.match(html, /多源数据冲突/);
});

test('折叠设置区提供策略载入、行内错误、保存与重置且不暴露安全硬门编辑', () => {
  assert.match(html, /id="policyFields"/);
  assert.match(html, /policyGroups[\s\S]*discovery[\s\S]*live[\s\S]*scan/);
  assert.match(html, /data-policy-path/);
  assert.match(html, /data-policy-error/);
  assert.match(html, /postLocal\('\/api\/policy', \{ policy: policyFromForm\(\) \}\)/);
  assert.match(html, /postLocal\('\/api\/policy-reset', \{\}\)/);
  assert.match(html, /policyFormDirty = true/);
  assert.doesNotMatch(html, /data-policy-path="[^\"]*(?:Tax|LpLocked|Top10|Insider|Bot|Linked)/i);
});

test('固定周期因子实验室使用紧凑表格并按需加载明细', () => {
  assert.match(html, /id="factorLabPanel"/);
  assert.match(html, /<table class="compact-table factor-period-table">/);
  assert.match(html, /id="factorLabPeriods"/);
  assert.match(html, /id="factorLabFactors"/);
  assert.match(html, /id="factorLabTrades"/);
  assert.match(html, /id="factorLabHistory"/);
  assert.match(html, /function renderFactorLabSummary\(/);
  assert.match(html, /function loadFactorLabViews\(/);
  assert.match(html, /\/api\/factor-lab\?view=factors/);
  assert.match(html, /\/api\/factor-lab-control/);
  assert.match(html, /\/api\/factor-lab-rollback/);
  const start = html.indexOf('id="factorLabPanel"');
  const end = html.indexOf('<article class="panel wide">', start + 30);
  assert.doesNotMatch(html.slice(start, end), /class="card/);
  assert.doesNotMatch(html.slice(start, end), /id="shadowLedgerPositions"/);
});

test('首页融合结果与运行状态、筛选漏斗与深审表格', () => {
  for (const marker of ['resultDashboard', 'formalCandidatesPanel', 'funnelPanel', 'livePanel', 'factorLabPanel', 'managePanel', 'runtimePanel']) {
    assert.match(html, new RegExp('id="' + marker + '"'));
  }
  const resultStart = html.indexOf('id="resultDashboard"');
  const resultEnd = html.indexOf('</section>', resultStart);
  assert.ok(html.indexOf('id="runtimePanel"', resultStart) < resultEnd);
  const auditStart = html.indexOf('id="formalCandidatesPanel"');
  const auditEnd = html.indexOf('</article>', auditStart);
  assert.ok(html.indexOf('id="funnelPanel"', auditStart) < auditEnd);
  assert.match(html, /#resultDashboard\s*{[^}]*order:\s*3/);
  assert.match(html, /#formalCandidatesPanel\s*{[^}]*order:\s*4/);
  assert.match(html, /#livePanel\s*{[^}]*order:\s*6/);
  assert.match(html, /#factorLabPanel\s*{[^}]*order:\s*7/);
  assert.match(html, /#managePanel\s*{[^}]*order:\s*8/);
});

test('顶部结果总览包含资金、固定周期、退出率和报告进度', () => {
  for (const id of [
    'labSignalCount', 'labAllocated', 'labOpenPositions', 'labUnrecovered',
    'labPrincipalRecovered', 'labRealizedNet', 'labM5', 'labM10', 'labM15',
    'labExitRates', 'labDataQuality', 'labReportProgress'
  ]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /function renderResultDashboard/);
  assert.match(html, /summary.capital/);
  assert.match(html, /summary.reportProgress/);
});

test('审计阶段标签可筛选全部深审状态且逐币可查看判定依据', () => {
  const start = html.indexOf('function renderCandidates');
  const end = html.indexOf('function activeChain', start);
  assert.doesNotMatch(html.slice(start, end), /backendDisposition\(row\) === 'chain'\s*&&/);
  assert.match(html, /id="funnelCounts"/);
  assert.match(html, /id="funnelReasons"/);
  assert.match(html, /function renderFunnel/);
  assert.match(html, /data-funnel-filter/);
  assert.match(html, /id="candidateWhyDialog"/);
  assert.match(html, /data-action="why"/);
  assert.match(html, /function openCandidateWhy\(/);
  const funnelStart = html.indexOf('function renderFunnel');
  const funnelEnd = html.indexOf('function ruleLimit', funnelStart);
  assert.doesNotMatch(html.slice(funnelStart, funnelEnd), /style=/);
  assert.match(html, /funnel-strip steps-/);
});

test('实验室分离真实仓位、未投入本金参考样本和阶段报告', () => {
  for (const id of ['shadowLedgerPositions', 'factorLabSamples', 'factorLabReports']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /view=positions/);
  assert.match(html, /view=samples/);
  assert.match(html, /view=reports/);
  assert.match(html, /未投入模拟本金/);
  assert.match(html, /待入场/);
  assert.match(html, /function renderShadowLedger\(/);
  assert.match(html, /Number\(row\.allocatedUsdc\) > 0/);
});

test('真实影子仓位常驻结果总览并展示全链买卖时间价格、现金流和研究入口', () => {
  const dashboardStart = html.indexOf('id="resultDashboard"');
  const dashboardEnd = html.indexOf('</section>', dashboardStart);
  const dashboard = html.slice(dashboardStart, dashboardEnd);
  assert.match(dashboard, /id="shadowLedgerPositions"/);
  assert.match(dashboard, /id="shadowLedgerSummary"/);
  assert.match(html, /\/api\/factor-lab\?view=positions&limit=100/);
  assert.doesNotMatch(html, /view=positions&limit=100&chain=/);
  assert.match(html, /function positionEntry\(/);
  assert.match(html, /function positionExitCashflows\(/);
  assert.match(html, /function renderShadowLedger\(/);
  assert.match(html, /PRINCIPAL_RECOVERY/);
  assert.match(html, /data-shadow-copy/);
  assert.match(html, /actionLinks\(\{ address: row\.address, chain: row\.chain, symbol: row\.symbol, gmgnUrl: row\.gmgnUrl, info: \{ website: row\.website, twitter: row\.twitter \} \}\)/);
});

test('有限本金账户区分本金、现金、占用、权益、累计成交额和容量跳过', () => {
  for (const id of ['portfolioInitial', 'portfolioEpoch', 'portfolioEquity', 'portfolioCash', 'portfolioDeployed', 'portfolioTurnover', 'portfolioSlots', 'portfolioSkipped']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /1000\s*USDC/);
  assert.match(html, /50U\/笔/);
  assert.match(html, /最多5仓/);
  assert.match(html, /data-i18n="portfolioInitialNote"/);
  assert.match(html, /data-i18n="portfolioDeployedNote"/);
  assert.match(html, /资金\/容量跳过/);
  assert.match(html, /portfolio\.availableCashUsdc/);
  assert.match(html, /portfolio\.skippedCount/);
  assert.match(html, /portfolio\.epochStartedAt/);
  assert.match(html, /固定成本5%.*低流动性.*动态滑点/);
  assert.match(html, /portfolio\.epochId/);
  assert.match(html, /row\.portfolioEpochId === currentEpochId/);
  assert.match(html, /历史账期/);
});

test('持续优化决策板先展示当前问题和下一动作且不常驻明细', () => {
  for (const id of [
    'optimizationState', 'optimizationProblem', 'optimizationNextAction',
    'optimizationProgress', 'optimizationRiskState'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /collectOnly/);
  assert.match(html, /匹配对照不足/);
  assert.match(html, /自动晋级暂停.*影子采集继续/);
  assert.match(html, /<details[^>]*id="optimizationDetails"/);
});
