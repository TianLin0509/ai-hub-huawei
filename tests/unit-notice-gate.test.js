'use strict';
// 提示闸门（core/notice-gate.js）：自动恢复类 0 条、真失败类 1 条、同会话同原因只提示一次、被拦的进日志。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNoticeGate, classify } = require('../core/notice-gate');

function gate(t0 = 1000) {
  let now = t0;
  const logs = [];
  const g = createNoticeGate({ log: (event, detail) => logs.push({ event, ...detail }), now: () => now });
  return { g, logs, tick: ms => { now += ms; } };
}
const shownCount = (g, list) => list.filter(n => g.decide(n).show).length;

test('典型场景：网络抖动自动重连、工具失败后自动重试成功 → 0 条；额度用完、登录失效 → 各 1 条', () => {
  const { g, logs } = gate();
  const jitter = [
    { sessionId: 's1', level: 'warning', message: '连接断开，正在重连…' },
    { sessionId: 's1', level: 'warning', message: '公司模型换号：A 号限流，已自动换到 B 号继续' },
    { sessionId: 's1', level: 'info', message: '连接已恢复' },
  ];
  assert.equal(shownCount(g, jitter), 0);
  const toolRetry = [
    { sessionId: 's1', level: 'warning', message: '工具调用超时，第 1 次自动重试' },
    { sessionId: 's1', level: 'warning', message: '工具调用超时，第 2 次自动重试' },
  ];
  assert.equal(shownCount(g, toolRetry), 0);
  const quota = [
    { sessionId: 's1', level: 'error', persistent: true, message: '这个账号的额度用完了，换个模型或账号继续' },
    { sessionId: 's1', level: 'error', persistent: true, message: '这个账号的额度用完了，换个模型或账号继续' },
  ];
  assert.equal(shownCount(g, quota), 1, '同会话同原因只提示一次');
  const login = [
    { sessionId: 's2', level: 'warning', persistent: true, action: 'codeagent-login', message: 'CodeAgent 登录已过期，请重新登录' },
    { sessionId: 's2', level: 'warning', persistent: true, action: 'codeagent-login', message: 'CodeAgent 登录已过期，请重新登录' },
  ];
  assert.equal(shownCount(g, login), 1);
  assert.ok(logs.length >= 6 && logs.every(item => item.event === 'notice-muted'), '被拦下的都进日志');
});

test('显式 noticeKind 优先于文字；用户点的按钮失败每次都显示', () => {
  const { g } = gate();
  assert.equal(g.decide({ message: '保存失败', noticeKind: 'background' }).show, false);
  assert.equal(g.decide({ message: '起名失败', level: 'error', noticeKind: 'background' }).show, false);
  for (let i = 0; i < 3; i++) assert.equal(g.decide({ sessionId: 's', message: '继续失败：未确认', level: 'error', noticeKind: 'user-action' }).show, true);
});

test('文字归类：数据风险与真失败显示，自动恢复/探测/后台静默，未知 warning 静默、未知 error 显示', () => {
  assert.equal(classify({ message: '数据保存失败：EPERM' }), 'data-risk');
  assert.equal(classify({ message: '数据文件暂时被占用，稍后自动重试' }), 'auto');
  assert.equal(classify({ message: '数据文件占用已解除，保存已恢复' }), 'auto');
  assert.equal(classify({ message: '内存占用 92%，已自动休眠早已答完的 A，点会话即可唤醒' }), 'auto');
  assert.equal(classify({ message: '上下文太长，公司模型拒收' }), 'blocking');
  assert.equal(classify({ message: '某个说明', level: 'warning' }), 'info');
  assert.equal(classify({ message: '某个失败', level: 'error' }), 'blocking');
});

test('重复去重 30 分钟后放开；forget 后同一原因可再提示', () => {
  const { g, tick } = gate();
  const n = { sessionId: 's', level: 'error', message: '登录已失效' };
  assert.equal(g.decide(n).show, true);
  assert.equal(g.decide(n).show, false);
  g.forget('s');
  assert.equal(g.decide(n).show, true);
  tick(31 * 60 * 1000);
  assert.equal(g.decide(n).show, true);
  assert.equal(g.decide({ ...n, sessionId: 'other' }).show, true, '别的会话不受影响');
});

test('defer：宽限期内恢复就什么都不显示；没恢复才显示一行', async () => {
  const { g } = gate();
  let shown = 0;
  g.defer('k1', { sessionId: 's', level: 'warning', message: '连接断开，正在重连' }, () => { shown++; }, 20);
  assert.equal(g.resolve('k1'), true);
  g.defer('k2', { sessionId: 's', level: 'error', message: '连接断开且重连失败' }, () => { shown++; }, 20);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(shown, 1);
});

// 盘点表（20261124-提示盘点.md）里各发出点的真实文案：该静默的静默、该留的留。
test('盘点表文案回归：自动恢复/探测/后台/说明静默，真失败与数据风险显示', () => {
  const cases = [
    ['自动选择模型没成功。输入框已恢复，本条沿用当前模型发送。', 'warning', false],
    ['原模型 glm-5 不可用，已换成 deepseek-v4（启动时模型菜单未能选中）', 'warning', false],
    ['检测到 Claude 配置中的连接设置与 Hub 冲突，本次优先使用 Hub 的连接设置，原文件未修改。', 'warning', false],
    ['CLI 版本 2.3.1 未经测试，已用兼容方式启动', 'warning', false],
    ['AI 市场 MCP 开关设置读不了，按全部开启', 'warning', false],
    ['结束会话进程失败（x），可以稍后重试。', 'warning', false],
    ['没切到 X，先用 CodeAgent 当前模型继续，第一条消息已照常发出', 'warning', false],
    ['当前账号额度只剩约 8%：已找到 B 号，将先压缩再换号', 'info', false],
    ['实际模型已确认，但同步会话启动设置失败：x', 'warning', false],
    ['号池账号 A 的登录信息读不出来，已换号到 B', 'warning', false],
    ['Token Plan 本月额度已用完（北京时间 12-01 00:00 重置），本会话暂用 DeepSeek API · v4', 'warning', false],
    ['自动压缩 15 分钟没有完成，已放弃等待', 'warning', false],
    ['结构化通道多次中断，已自动改回终端方式', 'warning', false],
    ['会话记录最后一次保存失败(EPERM)，已先收为休眠；请检查磁盘空间', 'warning', true],
    ['没切到 X，第一条消息还没发出；请到终端按 Esc 或 /model 手动选', 'warning', true],
    ['X 不可用 本条消息未发送。暂无可用模型。', 'error', true],
    ['会话A：模型不可用，未创建会话', 'warning', true],
    ['数据保存失败：EACCES', 'error', true],
    ['你自己的 CodeAgent 登录读不出来，请登录', 'warning', true],
    ['Token Plan 本月额度已用完（重置时间未知）。本会话不改走 API，重置后再发即可。', 'warning', true],
    ['已切到 DeepSeek API，自动重发失败：x。请手动重发上一条。', 'warning', true],
    ['自动改回终端失败：x', 'error', true],
  ];
  for (const [message, level, show] of cases) {
    const { g } = gate();
    assert.equal(g.decide({ sessionId: 's', message, level }).show, show, message);
  }
});

test('额度用完：Hub 正在自动处理时说一行「X 点自动继续 / 自动换号」；换不了或没开自动换号时按真失败', () => {
  const { quotaAutoText, classifyError } = require('../renderer/turn-error-help');
  for (const text of ["You've hit your 5-hour limit · resets 3:10am (Asia/Shanghai)", "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", "You've hit your weekly limit · resets 9am"]) {
    assert.equal(classifyError(text)?.kind, 'quota', text);
  }
  const at = new Date(2026, 10, 24, 15, 10).getTime();
  assert.equal(quotaAutoText({ nativeRuntime: { quotaWait: { status: 'waiting', resetsAt: at } } }), '额度用完，15:10 自动继续');
  assert.equal(quotaAutoText({ nativeRuntime: { quotaWait: { status: 'stale' } } }), '');
  assert.equal(quotaAutoText({ claudeAutoSwitch: true }), '额度用完，正在自动换号继续');
  assert.equal(quotaAutoText({ claudeAutoSwitch: true, claudeSwitchStatus: { status: 'continued' } }), '额度用完，已自动换号继续');
  assert.equal(quotaAutoText({ claudeAutoSwitch: true, claudeSwitchStatus: { status: 'waiting' } }), '', '没有可用账号 = 真失败');
  assert.equal(quotaAutoText({ kind: 'claude' }), '', '没开自动换号 = 真失败');
});

test('状态行：自动换号进度与引擎自动重试不显示，换不了才显示', () => {
  const { switchStatusVisible } = require('../core/notice-gate');
  for (const status of ['checking', 'switching', 'switched', 'continued']) assert.equal(switchStatusVisible({ status, message: 'x' }), false, status);
  for (const status of ['waiting', 'attention', 'manual-failed', 'manual-switching']) assert.equal(switchStatusVisible({ status, message: 'x' }), true, status);
  const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status');
  const { buildComposerStatusModel } = require('../core/session-status-summary');
  for (const attempt of [1, 5, 10]) {
    const session = { id: 's', kind: 'claude', runtimeBackend: 'claude-stream-json', status: 'running',
      nativeRuntime: { state: 'running', connection: 'connected', startedAt: Date.now() - 5000, userMessageId: 'u', apiRetry: { status: 529, attempt, maxRetries: 10, userMessageId: 'u' } } };
    const model = buildComposerStatusModel(session, { runtime: deriveSessionRuntimeStatus(session, {}) });
    assert.doesNotMatch(model.text, /重试|繁忙/);
    assert.match(model.text, /正在工作 · 已等/);
    assert.match(model.retryNote, /自动重试第 \d+\/10 次/, '重试详情留给悬停');
  }
});

// ── Codex 审查（2026-11-24）8 项修正的回归 ──
const fs = require('node:fs');
const path = require('node:path');
const src = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('审查 1：个人 CodeAgent 登录失效显式 blocking、号池号已换号 auto；反代失败状态（读不到 CodeAgent 版本）显式 blocking', () => {
  const { NOTICE, noticeKindFor } = require('../main/company-proxy-service');
  const { g } = gate();
  const personal = { type: 'credential_failed', account: 'personal' };
  const pool = { type: 'credential_failed', account: 'pool1' };
  assert.equal(noticeKindFor(personal), 'blocking');
  assert.equal(noticeKindFor(pool), 'auto');
  assert.equal(g.decide({ sessionId: 's', level: 'warning', message: NOTICE.credential_failed(personal), noticeKind: noticeKindFor(personal) }).show, true);
  assert.equal(g.decide({ sessionId: 's', level: 'warning', message: NOTICE.credential_failed(pool), noticeKind: noticeKindFor(pool) }).show, false);
  for (const type of ['fallback_personal', 'rate_limited', 'proxy_draining']) assert.equal(noticeKindFor({ type }), 'auto');
  const main = src('main.js');
  assert.match(main, /noticeKind: require\('\.\/main\/company-proxy-service'\)\.noticeKindFor\(notice\)/);
  assert.match(main, /message: status\.message, level: 'error', noticeKind: 'blocking'/);
  assert.match(main, /message: status\.message, level: 'error', persistent: true, noticeKind: 'blocking'/);
  // 真实文案带「版本」，没显式标记时会被静默——显式 blocking 后照常显示。
  assert.equal(g.decide({ level: 'error', message: '读不到 CodeAgent 版本，请重新启动模型通道', noticeKind: 'blocking' }).show, true);
});

test('审查 2：改道重发、压缩后继续「未获确认」保留一行 blocking', () => {
  assert.match(src('main/token-plan-fallback-controller.js'), /自动重发未获确认[^\n]*'blocking'\);/);
  const sc = src('main/soft-compact-controller.js');
  assert.match(sc, /自动继续未获确认[^\n]*'warning', 'blocking'\);/);
  assert.match(sc, /自动继续发送失败[^\n]*'warning', 'blocking'\);/);
  assert.match(src('main.js'), /notify: \(sessionId, message, level, noticeKind\) => sendToRenderer\('session-notice', \{ sessionId, message, level, noticeKind \}\)/);
});

test('审查 2b：软压缩的 notify 真把 noticeKind 带出去', async () => {
  const { createSoftCompactController } = require('../main/soft-compact-controller');
  assert.equal(typeof createSoftCompactController, 'function');
  const body = src('main/soft-compact-controller.js');
  assert.match(body, /const notice = \(sessionId, message, level = 'info', noticeKind\) => \{\s*try \{ notify\?\.\(sessionId, message, level, noticeKind\); \} catch \{\}/);
});

test('审查 3：「只讨论不改」等权限模式没生效的提示显式 blocking（不被「版本」字样静默）', () => {
  const sm = src('core/session-manager.js');
  const hits = sm.match(/persistent: true, noticeKind: 'blocking',\s*message: codeAgentPermissionDroppedMessage\(/g) || [];
  assert.equal(hits.length, 2, '首次启动与重启两处');
  const { g } = gate();
  const text = '本机 CodeAgent 版本较旧，不认启动参数 --permission-mode，所选「只讨论不改」没有生效，会话按 CodeAgent 自己的设置运行。';
  assert.equal(g.decide({ level: 'warning', message: text }).show, false, '不带标记会被静默——所以必须显式标');
  assert.equal(g.decide({ level: 'warning', message: text, noticeKind: 'blocking' }).show, true);
});

test('审查 4：数据文件持续写不进去超过 60 秒升级为一行 data-risk，短暂占用只进日志', () => {
  const main = src('main.js');
  assert.match(main, /数据文件暂时被占用，稍后自动重试', level: 'warning', persistent: true, noticeKind: 'auto'/);
  assert.match(main, /Date\.now\(\) - retryStartedAt >= 60000/);
  assert.match(main, /数据文件持续写不进去[\s\S]{0,200}noticeKind: 'data-risk'/);
  const { g } = gate();
  assert.equal(g.decide({ level: 'error', persistent: true, noticeKind: 'data-risk', message: '数据文件持续写不进去（EACCES），最近的改动还没保存' }).show, true);
});

test('审查 5：共享端口被占用要用户换端口（blocking），网卡暂不可用才算自动恢复（auto）', () => {
  const { LanPoolService } = require('../main/lan-pool-service');
  assert.equal(typeof LanPoolService, 'function');
  assert.match(src('main/lan-pool-service.js'), /noticeKind: error\.code === 'EADDRNOTAVAIL' \? 'auto' : 'blocking'/);
});

test('审查 6：去重键保留错误码与资源身份，401/403/500 不互相吞；计数与时间变化仍算同一原因', () => {
  const { normalizeReason } = require('../core/notice-gate');
  const { g } = gate();
  const shown = ['API Error: 401', 'API Error: 403', 'API Error: 500', 'API Error: 500']
    .map(message => g.decide({ sessionId: 's', level: 'error', message }).show);
  assert.deepEqual(shown, [true, true, true, false]);
  assert.notEqual(normalizeReason('启动失败 ERR_SQLITE_ERROR'), normalizeReason('启动失败 CLAUDE_REFRESH_UNCONFIRMED'));
  assert.notEqual(normalizeReason('号池账号 A1 登录失效'), normalizeReason('号池账号 B2 登录失效'));
  assert.equal(normalizeReason('第 2 次重试失败，已等 12 秒'), normalizeReason('第 3 次重试失败，已等 40 秒'));
  assert.equal(normalizeReason('额度用完，15:10 自动继续'), normalizeReason('额度用完，16:20 自动继续'));
});

test('审查 7：闸门出错时照常显示（fail-open）', () => {
  const { g } = gate();
  const bad = { level: 'error', get message() { throw new Error('boom'); } };
  assert.deepEqual(g.decide(bad), { show: true, kind: 'blocking', why: 'gate-error' });
  const r = src('renderer/renderer.js');
  assert.match(r, /function noticeGateAllows\(notice\) \{\s*try \{ return noticeGate\.decide\(notice\)\.show !== false; \}\s*catch/);
  assert.doesNotMatch(r, /!noticeGate\.decide\(/, '渲染进程只经 noticeGateAllows 调闸门');
});

test('审查 8：静默日志超出每小时 300 行时按原因聚合计数并记最后时间', () => {
  const main = src('main.js');
  assert.match(main, /searchEventLog\('notice-muted-overflow', \{ reason: [^}]*count: v\.count, lastAt:/);
  assert.match(main, /if \(\+\+noticeMutedWindow\.count > 300\) \{[\s\S]{0,400}v\.count \+= 1; v\.lastAt = now;/);
  assert.match(main, /app\.once\('will-quit', \(\) => \{ try \{ flushNoticeMutedOverflow\(\); \}/);
});

test('窄复审：模型确认后切换失败、恢复会话阻塞/取消显式 blocking；软压缩跳过路径检查回执；静默溢出复用 normalizeReason', () => {
  assert.match(src('main/ipc/session-handlers.js'), /persistent: true, level: 'warning', noticeKind: 'blocking', message: failure\.message/);
  const smc = src('main/session-model-creation.js');
  assert.match(smc, /const notice = \(message, noticeKind\) => sendToRenderer\?\.\('session-notice', \{[^}]*noticeKind,/);
  assert.equal((smc.match(/notice\([^;]*, 'blocking'\);/g) || []).length, 3, '不能换模型、无可用模型、用户取消三处');
  const sc = src('main/soft-compact-controller.js');
  assert.match(sc, /const receipt = await sendToPty\(sessionId, SKIP_CONTINUE_PROMPT[\s\S]{0,400}不压缩也不换号，但自动继续未获确认[^\n]*'blocking'\);/);
  const main = src('main.js');
  assert.doesNotMatch(main, /replace\(\/d\+\/g/);
  assert.match(main, /require\('\.\/core\/notice-gate'\)\.normalizeReason\(d\.message\)/);
});

test('窄复审：session-model-creation 真把 blocking 带到 session-notice', async () => {
  const { createSessionWithModelPolicy } = require('../main/session-model-creation');
  const sent = [];
  const error = Object.assign(new Error('模型 x 不可用。'), { code: 'SESSION_MODEL_UNAVAILABLE', canChooseAlternative: false, model: 'x' });
  await assert.rejects(Promise.resolve().then(() => createSessionWithModelPolicy({
    kind: 'codeagent', opts: {}, create: () => { throw error; }, sendToRenderer: (ch, p) => sent.push([ch, p]),
    contextLabel: '新建会话', operation: 'create', canCreate: () => true, dataDir: '', getPolicy: () => 'auto', modelLabel: 'Claude',
  })));
  const notice = sent.find(([ch]) => ch === 'session-notice');
  assert.ok(notice, '发了提示');
  assert.equal(notice[1].noticeKind, 'blocking');
  const { g } = gate();
  assert.equal(g.decide(notice[1]).show, true);
});
