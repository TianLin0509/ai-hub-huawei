'use strict';
// 统一错误卡、已知问题表、报错翻译、「问问 Agent」的回退与防连点、一键反馈预填（5.5.24）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const card = require('../renderer/hub-error-card');
const { humanizeError } = require('../core/error-humanize');
const { matchKnownIssue, KNOWN_ISSUES } = require('../core/known-issues');
const { isErrorNotice } = require('../renderer/ui-feedback');

const ENV = { feedback: true, ask: { ok: true } };

test('错误卡：标题、原因、步骤、主按钮、技术详情和两个求助按钮都在', () => {
  const html = card.html({ area: 'session-create', title: '创建失败', cause: '工作目录不存在', steps: ['换一个目录', '再试一次'],
    actions: [{ label: '重新选择目录', act: 'pick' }], details: 'ENOENT: no such file' }, ENV);
  assert.match(html, /class="hub-err-card"/);
  assert.match(html, /data-hub-err-area="session-create"/);
  assert.match(html, /<div class="hub-err-title">创建失败<\/div>/);
  assert.match(html, /<li>换一个目录<\/li><li>再试一次<\/li>/);
  assert.match(html, /data-hub-err-act="pick"/);
  assert.match(html, /data-hub-err-assist="ask"[^>]*>问问 Agent</);
  assert.match(html, /data-hub-err-assist="feedback"[^>]*>一键反馈</);
  assert.match(html, /<summary>技术详情<\/summary>/);
  assert.match(html, /data-hub-err-copy/);
});

test('错误卡：所有用户内容都转义，属性里也不能逃出引号', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const html = card.html({ area: 'x"><b', title: evil, cause: evil, steps: [evil], actions: [{ label: evil, act: 'a"b' }], details: evil }, ENV);
  assert.ok(!html.includes('<img'), html);
  assert.ok(!/data-hub-err-area="x"/.test(html));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
  assert.ok(html.includes('data-hub-err-act="a&quot;b"'));
});

test('错误卡：没有反馈入口时不出「一键反馈」；没有可用 Agent 时「问问 Agent」置灰并说明原因', () => {
  const html = card.html({ title: '出错了' }, { feedback: false, ask: { ok: false, reason: '没有找到可用的 Agent' } });
  assert.ok(!html.includes('data-hub-err-assist="feedback"'));
  assert.match(html, /data-hub-err-assist="ask" disabled title="没有找到可用的 Agent"/);
});

test('错误卡：原因和步骤缺省时用报错翻译补；showDetails=false 不重复显示原文但仍带给求助按钮', () => {
  const html = card.html({ title: '启动失败', details: 'spawn codeagent ENOENT', showDetails: false }, ENV);
  assert.match(html, /hub-err-cause">要运行的程序没装/);
  assert.match(html, /<ol class="hub-err-steps">/);
  assert.ok(!html.includes('<summary>技术详情'));
  assert.match(html, /data-hub-err-details="spawn codeagent ENOENT"/);
});

test('assistHtml：只有求助按钮，外层带上下文供点击时取用', () => {
  const html = card.assistHtml({ area: 'app-update', title: '更新没完成', details: 'x' }, ENV);
  assert.match(html, /^<span class="hub-err-assist-host" data-hub-err-area="app-update" data-hub-err-title="更新没完成" data-hub-err-details="x">/);
  assert.match(html, /问问 Agent/);
});

test('报错翻译表：常见错误码都能翻成人话', () => {
  const kind = raw => humanizeError(raw)?.kind || null;
  assert.equal(kind('spawn welink-cli ENOENT'), 'not-found');
  assert.equal(kind("'codeagent' is not recognized as an internal or external command"), 'not-found');
  assert.equal(kind('EACCES: permission denied, open C:\\x'), 'permission');
  assert.equal(kind('EPERM: operation not permitted, rename'), 'permission');
  assert.equal(kind('EBUSY: resource busy or locked'), 'permission');
  assert.equal(kind('connect ETIMEDOUT 10.0.0.1:443'), 'network');
  assert.equal(kind('read ECONNRESET'), 'network');
  assert.equal(kind('connect ECONNREFUSED 127.0.0.1:8080'), 'network');
  assert.equal(kind('getaddrinfo ENOTFOUND example.com'), 'network');
  assert.equal(kind('Request failed with status 401 Unauthorized'), 'auth');
  assert.equal(kind('HTTP 403 Forbidden'), 'forbidden');
  assert.equal(kind('429 Too Many Requests'), 'rate-limit');
  assert.equal(kind('502 Bad Gateway'), 'server');
  assert.equal(kind('ENOSPC: no space left on device, write'), 'disk-full');
  assert.equal(kind('listen EADDRINUSE: address already in use :::3456'), 'port-in-use');
  assert.equal(kind('完全看不懂的错误'), null);
  assert.equal(kind(''), null);
  assert.equal(kind(null), null);
  for (const raw of ['ENOENT', 'EACCES', 'ETIMEDOUT', '401', '403', '429', '500', 'ENOSPC', 'EADDRINUSE']) {
    const info = humanizeError(raw);
    assert.ok(info.title && info.cause && info.steps.length >= 1, raw);
  }
});

test('已知问题表：代码里的真实文案能命中对应条目', () => {
  const id = (area, details) => matchKnownIssue({ area, details })?.id || null;
  assert.equal(id('welink', 'WeLink 登录已过期，Hub 正在自动续期；续上后再问一次即可'), 'welink-login-expired');
  assert.equal(id('welink', 'WeLink 没登录或登录过期：点上方「扫码登录」，登录后会自动生成。'), 'welink-login-expired');
  assert.equal(id('session-create', '未找到 CodeAgent CLI。请从首页「安装说明」安装 codeagent，装好后点「重新检测」'), 'codeagent-missing');
  assert.equal(id('codeagent', 'CodeAgent 版本较旧，卡片视图可能显示不出回答'), 'codeagent-outdated');
  assert.equal(id('session-create', '未找到 Claude Code CLI。请从首页「安装说明」安装 claude'), 'cli-missing');
  assert.equal(id('session-create', '公司模型反代还没准备好，请稍等几秒再新建会话'), 'company-proxy-not-ready');
  assert.equal(id('company-proxy', '公司模型反代反复退出，已停止自动重启。'), 'company-proxy-failed');
  assert.equal(id('app-update', '文件校验不一致（内容在传输中被改动或源上的文件不对）'), 'update-corrupt');
  assert.equal(id('app-update', '收到的是网页（12 KB）而不是版本清单，可能被公司代理拦截'), 'update-blocked');
  assert.equal(id('app-update', '证书校验失败（可能被公司代理拦截了加密连接）'), 'cert-intercepted');
  assert.equal(id('hub-alert', '共享端口已被其他程序占用；关闭共享后换一个端口'), 'port-in-use');
  assert.equal(id('model-service', 'API Error token消耗过快， 已达到4亿上限'), 'codeagent-quota');
  assert.equal(id('session-create', '所选账号当前不可用，请到「账号」页登录或恢复使用后再试'), 'account-unavailable');
  assert.ok(KNOWN_ISSUES.length >= 8 && KNOWN_ISSUES.length <= 14);
});

test('已知问题表：功能区不符不套用；端口号能从报错里取出来；认不出返回 null', () => {
  assert.equal(matchKnownIssue({ area: 'app-update', details: 'WeLink 登录已过期' }), null);
  const port = matchKnownIssue({ area: 'company-proxy', details: 'listen EADDRINUSE: address already in use 127.0.0.1:3456' });
  assert.equal(port.id, 'port-in-use');
  assert.match(port.title, /端口 3456/);
  assert.match(port.fix, /Get-NetTCPConnection -LocalPort 3456/);
  assert.equal(matchKnownIssue({ area: 'hub-alert', details: '一切正常' }), null);
  for (const issue of KNOWN_ISSUES) assert.ok(!issue.action || /^known:/.test(issue.action.act), issue.id);
});

test('错误卡命中已知问题：标题下给「已知解法」，一键动作排第一个当主按钮，求助按钮照样在', () => {
  const html = card.html({ area: 'app-update', title: '一键更新没有完成', details: '文件校验不一致（内容在传输中被改动或源上的文件不对）',
    actions: [{ label: '关闭', act: 'close' }] }, ENV);
  assert.match(html, /data-known-issue="update-corrupt"/);
  assert.ok(html.indexOf('hub-err-known') > html.indexOf('hub-err-title'));
  assert.match(html, /<span class="hub-err-known-tag">已知解法<\/span>/);
  assert.match(html, /<div class="hub-err-actions"><button type="button" class="hub-err-btn primary" data-hub-err-act="known:update-redownload">重新下载<\/button><button type="button" class="hub-err-btn" data-hub-err-act="close">/);
  assert.match(html, /问问 Agent/);
  assert.match(card.knownHtml({ area: 'welink', details: 'WeLink 登录已过期' }), /data-hub-err-act="known:welink-login">扫码登录</);
  assert.equal(card.knownHtml({ area: 'welink', details: '没见过的错' }), '');
});

function fakeDeps({ installed = ['codeagent', 'claude', 'codex'], failKinds = [], clock } = {}) {
  const calls = { create: [], send: [], select: [], notify: [], closed: 0, setup: 0, saved: [] };
  let n = 0;
  const deps = {
    now: () => clock.t,
    info: { productName: 'AI HUB', version: '5.5.24', platform: 'win32 10.0', appDir: 'C:\\Hub', manual: 'C:\\Hub\\docs\\TROUBLESHOOT-AGENT.md', files: [['日志目录', 'C:\\data\\logs']] },
    invoke: async (channel, payload) => {
      if (channel === 'community:setup') { calls.setup++; return { providers: ['codeagent', 'claude', 'codex', 'gemini'].map(id => ({ id, installed: installed.includes(id) })) }; }
      if (channel === 'session:send-prompt') { calls.send.push(payload); return { ok: true }; }
      throw new Error('unexpected ' + channel);
    },
    createSession: async (kind, options) => {
      calls.create.push({ kind, options });
      if (failKinds.includes(kind)) throw new Error(kind + ' 起不来');
      return { id: 's' + (++n), kind };
    },
    selectSession: id => calls.select.push(id),
    closeOverlays: () => { calls.closed++; },
    notify: (message, level) => calls.notify.push([message, level]),
    workDir: () => 'D:/hub-data/troubleshoot/t1',
    saveContext: (cwd, data) => calls.saved.push({ cwd, data }),
  };
  return { deps, calls };
}

test('问问 Agent：默认开 CodeAgent 会话，标题「排查：…」，首句带现象、功能区、原始报错和本机路径', async () => {
  const clock = { t: 1000 };
  const { deps, calls } = fakeDeps({ clock });
  const assist = card.createHubAssist(deps);
  const r = await assist.askAgent({ area: 'session-create', title: '创建失败', symptom: '点创建没反应', details: 'spawn x ENOENT' });
  assert.deepEqual([r.ok, r.kind, r.sessionId], [true, 'codeagent', 's1']);
  assert.equal(calls.create[0].options.opts.title, '排查：创建失败');
  assert.equal(calls.create[0].options.opts.userRenamed, true);
  // 排查会话开在专属空目录，不和其他会话共用记录目录（11-08 实测串显示）
  assert.equal(calls.create[0].options.cwd, 'D:/hub-data/troubleshoot/t1');
  assert.deepEqual(calls.select, ['s1']);
  assert.equal(calls.closed, 1);
  const { text, waitForCliReady, sessionId } = calls.send[0];
  assert.equal(sessionId, 's1');
  assert.equal(waitForCliReady, true);
  for (const part of ['点创建没反应', '新建会话', 'spawn x ENOENT', 'v5.5.24', 'C:\\data\\logs', '先只读排查', '等我同意后再动手']) assert.ok(text.includes(part), part);
  // 5.5.31 任务书：角色与目标、先读手册、2 分钟先给判断、问复现、10 分钟收敛、全程中文、结尾固定结论块
  for (const part of ['排查助手', '能安全修好就修', '给 AI HUB 维护人的排查报告', '先读它：C:\\Hub\\docs\\TROUBLESHOOT-AGENT.md',
    '2 分钟内先用中文给我初步判断', '最可能的 1–3 个原因', '先问我是怎么出现的', '10 分钟左右', '全程用中文回复我', '不删除我的数据']) assert.ok(text.includes(part), part);
  assert.ok(text.endsWith(card.CONCLUSION_FORMAT.join('\n')), '结论块格式放在最后');
  for (const field of ['状态：已解决 / 未解决 / 需要用户操作', '原因：', '证据：（日志文件 + 时间 + 关键行摘要）', '已做的修改：', '建议用户做的：', '给维护人的说明：（未解决时写复现步骤']) assert.ok(text.includes(field), field);
  assert.equal(card.CONCLUSION_FORMAT[0], '【排查结论】');
  assert.equal(card.CONCLUSION_FORMAT.at(-1), '【排查结论完】');
  // 原始报错存进排查目录，事后「把排查结果反馈给维护人」取用
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0].cwd, 'D:/hub-data/troubleshoot/t1');
  assert.deepEqual([calls.saved[0].data.sessionId, calls.saved[0].data.kind], ['s1', 'codeagent']);
  assert.deepEqual(calls.saved[0].data.ctx, { area: 'session-create', areaLabel: '新建会话', title: '创建失败', symptom: '点创建没反应', details: 'spawn x ENOENT' });
});

test('首句：找不到排查手册时不提手册，其余照常', () => {
  const text = card.buildPrompt({ area: 'welink', title: 'X' }, { version: '1', files: [] });
  assert.ok(!text.includes('排查手册'));
  assert.match(text, /【排查结论】/);
});

test('排查手册路径：源码运行看 docs/；打包后先 app.asar.unpacked/docs，再 resources/guides/docs；都没有返回 null', () => {
  const path = require('node:path');
  const has = set => file => set.has(file);
  const res = path.join('C:', 'Hub', 'resources');
  const asar = path.join(res, 'app.asar');
  const unpacked = path.join(res, 'app.asar.unpacked', 'docs', 'TROUBLESHOOT-AGENT.md');
  const guides = path.join(res, 'guides', 'docs', 'TROUBLESHOOT-AGENT.md');
  assert.equal(card.troubleshootManualPath({ appDir: asar, resourcesPath: res, exists: has(new Set([unpacked, guides])) }), unpacked);
  assert.equal(card.troubleshootManualPath({ appDir: asar, resourcesPath: res, exists: has(new Set([guides])) }), guides);
  assert.equal(card.troubleshootManualPath({ appDir: asar, resourcesPath: res, exists: () => false }), null);
  const src = path.join('D:', 'src', 'hub');
  assert.equal(card.troubleshootManualPath({ appDir: src, exists: has(new Set([path.join(src, 'docs', 'TROUBLESHOOT-AGENT.md')])) }), path.join(src, 'docs', 'TROUBLESHOOT-AGENT.md'));
  // 仓库里真有这份手册，并且打包配置会把它解包成普通文件（一键更新的增量包只带 app.asar 和 app.asar.unpacked）
  assert.ok(card.troubleshootManualPath(), '源码目录下应能找到 docs/TROUBLESHOOT-AGENT.md');
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('docs/TROUBLESHOOT-AGENT.md'));
  assert.ok(pkg.build.asarUnpack.includes('docs/TROUBLESHOOT-AGENT.md'));
});

test('问问 Agent：CodeAgent 起不来时退到 Claude Code；报错就是 CodeAgent 时先找别的', async () => {
  const clock = { t: 0 };
  let { deps, calls } = fakeDeps({ failKinds: ['codeagent'], clock });
  let r = await card.createHubAssist(deps).askAgent({ area: 'welink', title: 'A' });
  assert.equal(r.kind, 'claude');
  assert.deepEqual(calls.create.map(c => c.kind), ['codeagent', 'claude']);
  ({ deps, calls } = fakeDeps({ clock }));
  r = await card.createHubAssist(deps).askAgent({ area: 'codeagent', title: 'B' });
  assert.equal(r.kind, 'claude');
  ({ deps, calls } = fakeDeps({ installed: ['codeagent', 'codex'], clock }));
  r = await card.createHubAssist(deps).askAgent({ area: 'model-service', title: 'C', sessionKind: 'codeagent' });
  assert.equal(r.kind, 'codex');
});

test('问问 Agent：一个 Agent 都没有时不开会话，返回原因；缓存的可用性让按钮置灰', async () => {
  const clock = { t: 0 };
  const { deps, calls } = fakeDeps({ installed: ['gemini'], clock });
  const assist = card.createHubAssist(deps);
  const r = await assist.askAgent({ area: 'welink', title: 'X' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有找到 CodeAgent、Claude Code 或 Codex/);
  assert.equal(calls.create.length, 0);
  assert.equal(assist.cachedAvailability().ok, false);
  assert.match(card.html({ title: 'x' }, { feedback: false, ask: assist.cachedAvailability() }), /data-hub-err-assist="ask" disabled/);
});

test('问问 Agent：同一个错误 30 秒内连点只开一个会话，之后直接切过去；过了 30 秒再点才新开', async () => {
  const clock = { t: 0 };
  const { deps, calls } = fakeDeps({ clock });
  const assist = card.createHubAssist(deps);
  const ctx = { area: 'app-update', title: '更新失败', details: 'E1' };
  const [a, b] = await Promise.all([assist.askAgent(ctx), assist.askAgent(ctx)]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(calls.create.length, 1);
  clock.t = 20000;
  const c = await assist.askAgent(ctx);
  assert.deepEqual([c.reused, c.sessionId], [true, 's1']);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.select, ['s1', 's1']);
  await assist.askAgent({ ...ctx, details: 'E2' });
  assert.equal(calls.create.length, 2, '不同的错误不算重复');
  clock.t = 60000;
  await assist.askAgent(ctx);
  assert.equal(calls.create.length, 3);
});

test('一键反馈：预填功能区、现象和原始报错；没有反馈入口时不打开', () => {
  let received = null;
  const assist = card.createHubAssist({ invoke: async () => ({}), createSession: async () => null, openFeedback: () => prefill => { received = prefill; } });
  assert.equal(assist.feedback({ area: 'welink', title: 'WeLink 工具查找未完成', symptom: '找不到 welink-cli', details: 'spawn welink-cli ENOENT' }).ok, true);
  for (const part of ['WeLink 助理', '找不到 welink-cli', 'WeLink 工具查找未完成', 'spawn welink-cli ENOENT']) assert.ok(received.description.includes(part), part);
  const none = card.createHubAssist({ invoke: async () => ({}), createSession: async () => null, openFeedback: () => null });
  assert.equal(none.feedback({ title: 'x' }).ok, false);
});

test('错误弹窗：只有失败、报错类才挂求助按钮', () => {
  assert.equal(isErrorNotice('会话恢复失败：ENOENT', {}, {}), true);
  assert.equal(isErrorNotice('已保存', { detail: 'stack' }, {}), true);
  assert.equal(isErrorNotice('请先选择一个目录', {}, {}), false);
  assert.equal(isErrorNotice('原 Hub 仍持有写入权，失败', {}, { icon: 'lock' }), false);
  assert.equal(isErrorNotice('失败', { assist: false }, {}), false);
});
