'use strict';
// 「WeLink (Beta)」公共黑板页的纯函数单测：viewModel / pageHtml 在各状态下的渲染、流水筛选分页、退出二次确认、转义与配色约束。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../renderer/welink-blackboard-page');
const fx = require('./fixtures/welink-blackboard-snapshots');

const NOW = fx.NOW;
const render = (snap, ui = {}) => { const vm = P.viewModel(snap, { now: NOW, ...ui }); return { vm, html: P.pageHtml(vm) }; };

test('在线正常：无自救条、状态一句写一切正常与上次同步、四格与 7 个调用方', () => {
  const { vm, html } = render(fx.online());
  assert.equal(vm.health, 'healthy');
  assert.equal(vm.dot, '');
  assert.equal(vm.advice, null);
  assert.match(vm.headline, /^一切正常 · 上次同步 \d\d:\d\d$/);
  assert.equal(vm.metrics.auth.value, '已登录');
  assert.equal(vm.metrics.cli.value, 'v1.0.20');
  assert.equal(vm.metrics.limit.value, '空闲');
  assert.equal(vm.metrics.calls.calls, 41);
  assert.equal(vm.callers.length, 7);
  assert.deepEqual(vm.callers.map(c => c.id), ['assistant', 'avatar', 'phone', 'feedback', 'join', 'welink-ro', 'external']);
  assert.equal(vm.callers.find(c => c.top).id, 'avatar');
  assert.doesNotMatch(html, /wbb-advice/);
  assert.match(html, /WeLink 公共黑板<span class="wbb-beta">Beta<\/span>/);
  assert.equal((html.match(/class="wbb-caller[ "]/g) || []).length, 7);
  assert.equal((html.match(/class="wbb-metric"/g) || []).length, 4);
});

test('CLI 未安装：红色自救条、主按钮一键安装、次按钮重新扫描，四格显示未安装', () => {
  const { vm, html } = render(fx.cliMissing());
  assert.equal(vm.health, 'error');
  assert.equal(vm.dot, 'err');
  assert.equal(vm.advice.kind, 'cli_missing');
  assert.equal(vm.advice.tone, 'err');
  assert.equal(vm.advice.primary.id, 'install-cli');
  assert.equal(vm.advice.primary.label, '一键安装');
  assert.equal(vm.advice.secondary.id, 'find-cli');
  assert.equal(vm.metrics.cli.value, '未安装');
  assert.match(html, /data-wbb="act:install-cli">一键安装</);
  assert.match(html, /class="wbb-advice err"/);
});

test('CLI 旧版：橙色提示、旧版标与一键升级链接', () => {
  const { vm, html } = render(fx.cliOutdated());
  assert.equal(vm.dot, 'warn');
  assert.equal(vm.advice.kind, 'cli_outdated');
  assert.equal(vm.advice.primary.label, '一键升级');
  assert.ok(vm.metrics.cli.outdated);
  assert.match(html, /wbb-chip warn">旧版</);
  assert.match(html, /class="wbb-link" data-wbb="act:upgrade-cli"/);
  assert.match(html, /建议 ≥ v1\.0\.20/);
});

test('代理 407：显示代理提示和重试安装', () => {
  const { vm, html } = render(fx.proxy407());
  assert.equal(vm.advice.kind, 'proxy_auth');
  assert.equal(vm.advice.primary.label, '重试安装');
  assert.match(vm.advice.proxyHint, /代理/);
  assert.match(html, /wbb-hint/);
  assert.match(html, /407/);
});

test('安装进行中：自救条换成进度一行，所有动作按钮禁用', () => {
  const { vm, html } = render(fx.installing());
  assert.ok(vm.installing);
  assert.match(html, /wbb-spin/);
  assert.match(html, /data-wbb="act:start-login" disabled/);
});

test('429 冷却：按 until 绝对时间倒数、主按钮重新检测、次按钮需确认才解除冷却', () => {
  const { vm, html } = render(fx.rateLimited());
  assert.equal(vm.cooldownLeft, 22);
  assert.equal(vm.headline, '限流冷静中 · 剩余 22 秒');
  assert.equal(vm.advice.kind, 'rate_limited');
  assert.equal(vm.advice.primary.id, 'refresh');
  assert.equal(vm.advice.secondary.id, 'clear-cooldown');
  assert.equal(vm.metrics.limit.value, '冷却 22 秒');
  assert.equal(vm.metrics.auth.value, '已登录'); // 限流只放在「限流与锁」一格，登录格照常显示登录状态
  assert.match(html, /data-slot="cd">剩余 22 秒</);
  // 10 秒后本地再算：12 秒
  assert.equal(P.viewModel(fx.rateLimited(), { now: NOW + 10000 }).cooldownLeft, 12);
  // 数完了：限流条消失（不等主进程推送也不再显示）
  const done = P.viewModel(fx.rateLimited(), { now: NOW + 30000 });
  assert.equal(done.cooldownLeft, 0);
  assert.equal(done.advice, null);
  // 只有剩余秒数没有 until：按收到快照后过去的时间扣减
  const s = fx.rateLimited(); s.cooldown.until = 0; s.cooldownRemainingSec = 15;
  assert.equal(P.cooldownLeft(s, NOW + 5000, NOW), 10);
});

test('需扫码：橙色提示带红区一行；登录流程开始后就地展开二维码（只当图片）', () => {
  const a = render(fx.needsScan());
  assert.equal(a.vm.advice.kind, 'needs_scan');
  assert.equal(a.vm.advice.primary.id, 'start-login');
  assert.match(a.html, new RegExp(P.RED_ZONE_NOTE));
  const b = render(fx.scanning());
  assert.ok(b.vm.login);
  assert.match(b.vm.login.qr, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(b.vm.login.status, '等待扫码'); // 主进程的英文状态词换成人话
  assert.match(b.html, /<img src="data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.doesNotMatch(b.html, /<svg[^>]*><rect width="21"/); // 主进程的 SVG 不直接进 DOM
  assert.match(b.html, new RegExp(P.RED_ZONE_NOTE));
  assert.equal((b.html.match(new RegExp(P.RED_ZONE_NOTE, 'g')) || []).length, 1); // 展开二维码后红区提示只出现一次
});

test('advice 缺省时按 auth.state 补齐（桌面端未开 → 重新检测）；未知 kind 也给重新检测', () => {
  const s = fx.online(); s.auth.state = 'desktop_unavailable'; s.auth.desktopOnline = false; delete s.health;
  const vm = P.viewModel(s, { now: NOW });
  assert.equal(vm.advice.kind, 'desktop_unavailable');
  assert.equal(vm.advice.primary.id, 'refresh');
  assert.equal(vm.health, 'warning');
  const t = fx.online(); t.advice = { kind: 'something_new', title: '新情况', primaryAction: { action: 'retry', label: '再试一次' } };
  const v2 = P.viewModel(t, { now: NOW });
  assert.equal(v2.advice.title, '新情况');
  assert.deepEqual(v2.advice.primary, { id: 'refresh', label: '再试一次' });
});

test('流水：每页 8 条、筛选计数、分页越界收回、空态文字', () => {
  const s = fx.withEvents(20);
  const p1 = P.viewModel(s, { now: NOW, tab: 'events' });
  assert.equal(p1.events.rows.length, P.PAGE_SIZE);
  assert.equal(p1.events.pages, 3);
  assert.equal(p1.events.counts.all, 20);
  assert.equal(p1.events.counts.ok + p1.events.counts.rate_limited + p1.events.counts.failed, 20);
  const p3 = P.viewModel(s, { now: NOW, tab: 'events', page: 99 });
  assert.equal(p3.events.page, 3);
  assert.equal(p3.events.rows.length, 4);
  const lim = P.viewModel(s, { now: NOW, tab: 'events', filter: 'rate_limited' });
  assert.ok(lim.events.rows.every(r => r.status === '限流'));
  const failed = P.viewModel(s, { now: NOW, tab: 'events', filter: 'failed' });
  assert.ok(failed.events.rows.every(r => r.status === '失败' || r.status === '登录失效'));
  const html = P.pageHtml(p1);
  assert.match(html, /第 1\/3 页/);
  assert.match(html, /data-wbb="page-prev" disabled/);
  assert.match(html, /仅记录本机脱敏操作，不含聊天正文/);
  assert.equal((html.match(/<tr>/g) || []).length, 1 + P.PAGE_SIZE);
  const empty = P.pageHtml(P.viewModel(fx.online(), { now: NOW, tab: 'events' }));
  assert.match(empty, /还没有调用记录/);
  assert.match(empty, /data-wbb="act-clear-events" disabled/);
  assert.match(P.pageHtml(P.viewModel(fx.withEvents(3, 'ok'), { now: NOW, tab: 'events', filter: 'failed' })), /这一类暂时没有记录/);
});

test('策略页：默认热点优先选中、路径与复制按钮、B2 预告；退出确认框文字与门槛', () => {
  const vm = P.viewModel(fx.online(), { now: NOW, tab: 'policy' });
  assert.equal(vm.policy.mode, 'hotspot_first');
  let html = P.pageHtml(vm);
  assert.match(html, /data-wbb-policy="hotspot_first" role="radio" aria-checked="true"/);
  assert.match(html, /data-wbb-policy="conservative_30s" role="radio" aria-checked="false"/);
  assert.match(html, /welink-blackboard\.json/);
  assert.match(html, /data-wbb="copy-path"/);
  assert.match(html, /敬请期待/);
  assert.match(html, /data-wbb="logout-ask"/);
  assert.doesNotMatch(html, /wbb-dialog/); // 没点之前不出确认框
  html = P.pageHtml(P.viewModel(fx.online(), { now: NOW, tab: 'policy', confirmLogout: true }));
  assert.match(html, /role="alertdialog"/);
  assert.ok(html.includes(P.LOGOUT_CONFIRM));
  assert.match(P.LOGOUT_CONFIRM, /暂停读写 WeLink[\s\S]*邮件和日历/);
  assert.match(html, /data-wbb="logout-confirm"/);
  // 限流冷却确认框门槛（UX P0-1）
  const coolHtml = P.pageHtml(P.viewModel(fx.rateLimited(), { now: NOW, confirmCooldown: true }));
  assert.match(coolHtml, /role="alertdialog"[\s\S]*data-wbb="cooldown-confirm"/);
  assert.ok(coolHtml.includes(P.COOLDOWN_CONFIRM));
  // 已退出登录时退出按钮禁用
  const out = fx.needsScan(); out.auth.state = 'signed_out';
  assert.match(P.pageHtml(P.viewModel(out, { now: NOW, tab: 'policy' })), /data-wbb="logout-ask" disabled/);
});

test('C01/C02/P1 回归：支持 base64 SVG 二维码、在线主动扫码独立展示、收起与顶栏按钮克制', () => {
  const s = fx.online();
  const b64 = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64');
  s.loginFlow = { active: true, qrSvg: b64, status: 'waiting', message: '等待扫码' };
  const vmOnline = P.viewModel(s, { now: NOW });
  assert.equal(vmOnline.health, 'healthy');
  assert.equal(vmOnline.isOnline, true);
  assert.equal(vmOnline.login.qr, b64);
  const html = P.pageHtml(vmOnline);
  assert.match(html, /class="wbb-login"[\s\S]*<img src="data:image\/svg\+xml;base64,/);
  assert.match(html, /data-wbb="login-dismiss"/);
  // 在线态顶栏不常驻扫码登录，卡片内提供换号扫码
  assert.doesNotMatch(html, /class="wbb-actions"[\s\S]*扫码登录/);
  assert.match(html, /class="wbb-metric"[\s\S]*换号扫码/);
  // 点收起后隐藏二维码区
  assert.doesNotMatch(P.pageHtml(P.viewModel(s, { now: NOW, hideLogin: true })), /class="wbb-login"/);
});

test('出错只在出错位置给一行字和重试按钮', () => {
  const html = P.pageHtml(P.viewModel(fx.online(), { now: NOW, tab: 'policy', err: { where: 'policy', text: '保存没成功', retry: null } }));
  assert.equal((html.match(/wbb-errline/g) || []).length, 1);
  assert.match(html, /保存没成功/);
  const h2 = P.pageHtml(P.viewModel(fx.cliMissing(), { now: NOW, err: { where: 'advice', text: '下载失败', retry: 'act:install-cli' } }));
  assert.match(h2, /wbb-errline[\s\S]*data-wbb="act:install-cli">重试</);
});

test('读不到快照：页内一行字加重试，不抛错', () => {
  const vm = P.viewModel(null, { loadError: '当前版本还没接上公共黑板服务' });
  assert.equal(vm.available, false);
  const html = P.pageHtml(vm);
  assert.match(html, /当前版本还没接上公共黑板服务/);
  assert.match(html, /data-wbb="act:refresh"/);
  assert.doesNotMatch(html, /role="tablist"/);
});

test('防 XSS：调用方名、命令、摘要、账号、原因、路径都转义；恶意二维码 URL 不进页面', () => {
  const s = fx.withEvents(1);
  const bad = '<img src=x onerror=alert(1)>"\'';
  s.events[0].callerLabel = bad; s.events[0].command = bad; s.events[0].summary = bad;
  s.callers.external.label = bad; s.auth.accountLabel = bad; s.auth.reason = bad; s.paths.blackboardFile = bad; s.headline = bad;
  s.loginFlow = { active: true, url: 'javascript:alert(1)', qrSvg: '<script>alert(1)</script>' };
  for (const tab of ['overview', 'events', 'policy']) {
    const html = P.pageHtml(P.viewModel(s, { now: NOW, tab }));
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /javascript:/);
  }
});

test('左栏圆点：正常不显示、警告橙、报错红、冷却中橙', () => {
  assert.equal(P.dotOf({ health: 'healthy' }), '');
  assert.equal(P.dotOf({ health: 'warning' }), 'warn');
  assert.equal(P.dotOf({ health: 'error' }), 'err');
  assert.equal(P.dotOf({ health: 'healthy', cooldownRemainingSec: 5 }), 'warn');
  assert.equal(P.dotOf(null), '');
});

test('样式只用 --hw-* 变量：不写颜色值、不写主题分支，不泄漏全局类', () => {
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/welink-blackboard-page.css'), 'utf8').replace(/url\("data:[^"]*"\)/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\brgba?\(|\bhsla?\(/);
  assert.doesNotMatch(css, /\[data-theme/);
  assert.doesNotMatch(css, /gradient\(/);
  // 每条规则的选择器都限定在本页或左栏入口里
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '').replace(/@media[^{]+\{/g, '').match(/(^|\})\s*([^{}@]+)\{/g) || [];
  for (const raw of selectors) {
    for (const sel of raw.replace(/^\}?\s*/, '').replace(/\{$/, '').split(',')) {
      const s = sel.trim(); if (!s) continue;
      assert.match(s, /wbb-|welink-blackboard/, '选择器没限定在本页：' + s);
    }
  }
});

test('页面文字不含个人称呼与内部字样', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/welink-blackboard-page.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'fixtures/welink-blackboard-snapshots.js'), 'utf8');
  for (const word of ['\u7530\u54e5', '\u7279\u6218\u961f', '\u516c\u53f8-\u5bb6\u91cc', '\u5bb6\u91cc']) assert.ok(!src.includes(word), '出现了：' + word);
});

// 英文界面：把各状态、各页签渲染出来，逐个取界面文字（跳过 data-i18n-skip 子树），都要能在英文词典里翻到。
test('英文词典覆盖本页全部界面文字（含悬停提示与无障碍标签）', () => {
  const i18n = require('../core/i18n');
  const CJK = /[㐀-鿿]/, VOID = new Set(['img', 'input', 'br', 'col', 'hr']);
  const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const texts = new Set();
  const collect = html => {
    const stack = []; let skip = 0; const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g; let m;
    while ((m = re.exec(html))) {
      if (m[3] !== undefined) { const t = dec(m[3]).trim(); if (t && CJK.test(t) && !skip) texts.add(t); continue; }
      if (m[0][1] === '/') { if (stack.pop()) skip--; continue; }
      const own = /data-i18n-skip/.test(m[2]);
      for (const a of ['title', 'aria-label', 'alt']) { const am = new RegExp(' ' + a + '="([^"]*)"').exec(m[2]); if (am && CJK.test(am[1]) && !skip && !own) texts.add(dec(am[1])); }
      if (!VOID.has(m[1].toLowerCase())) { stack.push(own); if (own) skip++; }
    }
  };
  const snaps = [fx.online(), fx.cliMissing(), fx.cliOutdated(), fx.proxy407(), fx.installing(), fx.rateLimited(), fx.needsScan(), fx.scanning(), fx.withEvents(20)];
  for (const k of ['signed_out', 'desktop_unavailable', 'account_mismatch', 'network_error', 'unknown']) { const s = fx.online(); s.auth.state = k; delete s.health; s.headline = ''; snaps.push(s); }
  const noPath = fx.online(); noPath.paths = {}; snaps.push(noPath);
  for (const s of snaps) for (const tab of ['overview', 'events', 'policy']) for (const filter of ['all', 'failed']) for (const extra of [{}, { confirmLogout: true }, { confirmCooldown: true }, { copied: true, busy: 'refresh' }]) {
    collect(P.pageHtml(P.viewModel(s, { now: NOW, tab, filter, feedback: true, ...extra })));
  }
  collect(P.pageHtml(P.viewModel(null, { loadError: '当前版本还没接上公共黑板服务' })));
  collect(P.pageHtml(P.viewModel(null, { loading: true })));
  i18n.setLanguage('en');
  try {
    i18n.loadDictionaries();
    const missing = [...texts].filter(t => CJK.test(i18n.translate(t)));
    assert.deepEqual(missing, [], '英文词典漏翻：' + missing.join(' | '));
    assert.ok(texts.size > 100, '取到的界面文字太少：' + texts.size);
  } finally { i18n.setLanguage('zh-CN'); }
});

// 主进程会直接显示给用户的固定文字（后端清单 20261126-core-m3-i18n.md）：英文模式下都要能翻到。
test('英文词典覆盖主进程固定文字', () => {
  const i18n = require('../core/i18n');
  const list = ['公司助理', '数字分身', '手机对话', '一键反馈', '一键入群', '会话只读工具', '其他外部组件',
    '登录已失效，请重新扫码', '请打开并登录本机 WeLink 桌面端', '桌面端与命令行账号不一致，请重新登录', '未找到 WeLink 命令行工具', '命令行版本低于推荐版本，请升级', '服务端限流，稍后再试', '暂时无法连接 WeLink，请检查公司网络', '已退出登录，自动续期已停止', '尚未确认登录状态',
    '正常完成', '服务端限流，已共享冷却', '需要检查登录状态', '调用未完成',
    '安装 WeLink 命令行工具', '升级 WeLink 命令行工具', '正在等待 WeLink 限流冷却', 'WeLink 运行正常', '无摄像头环境可在 WeLink 桌面端完成身份确认；如需扫码，请使用符合办公要求的扫码方式。', '红区无摄像头暂不支持扫码，请先在蓝区电脑完成登录或联系团队了解免扫码进展',
    '公司代理要求认证（407）。请完成公司代理认证后重试安装。', '公司代理或软件源响应超时（504）。请检查公司网络后重试。', '无法连接公司代理。请检查代理地址与公司网络后重试。',
    'WeLink 正在处理其他请求，请稍后重试', '操作已取消', '请选择热点优先或保守 30 秒策略',
    '等待完成身份确认', 'WeLink 服务尚未就绪，请稍后重试', '状态未保存：无法写入本机数据目录，请检查目录权限后重试', '安装未完成，请检查公司网络后重试', '请先确认退出 WeLink 登录', 'WeLink 尚未确认退出，请稍后重试', '已退出登录，本机状态暂未写入，请刷新重试', '这个版本未启用 WeLink 工作台', '请选择有效策略', '操作未完成：', '操作未完成：请选择有效策略', 'WeLink 限流，请稍后再试', '请检查公司网络与 WeLink 状态后重试',
    '已退出 WeLink 登录，请手动登录后继续'];
  i18n.setLanguage('en');
  try {
    i18n.loadDictionaries();
    const missing = list.filter(t => /[㐀-鿿]/.test(i18n.translate(t)));
    assert.deepEqual(missing, [], '漏翻：' + missing.join(' | '));
  } finally { i18n.setLanguage('zh-CN'); }
});

test('P2-6：其他 *-page-open 打开时黑板页自动收起，且 renderer.js 全部收起入口覆盖 __welinkBlackboardHide', () => {
  const pageSrc = fs.readFileSync(path.join(__dirname, '../renderer/welink-blackboard-page.js'), 'utf8');
  assert.match(pageSrc, /MutationObserver[\s\S]*welink-blackboard-page-open[\s\S]*-page-open\$\/\.test/);
  const rendererSrc = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const lines = rendererSrc.split(/\r?\n/);
  const missing = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('__weclawHide?.()') && !lines[i].includes('__welinkBlackboardHide') && !(lines[i + 1] || '').includes('__welinkBlackboardHide')) {
      missing.push(i + 1);
    }
  }
  assert.deepEqual(missing, [], 'renderer.js 仍有遗漏 __welinkBlackboardHide 的行：' + missing.join(', '));
});
