'use strict';
// 放行心跳与共享点击额度（2026-11-08 用户：成员版每分钟探一次自家主机，被拦就自动连点放行；1 分钟 10 次、30 分钟 15 次）。
// 真实 Electron 窗口里的点击（真实鼠标 + DOM 补点）在 tests/e2e-net-gate-heartbeat.js 验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ClickBudget, GatePasser, pickGateFallback, gateClickScript } = require('../core/net-unblock');
const { GateHeartbeat, probeOwnPage } = require('../core/net-gate-heartbeat');

const clock = () => { const c = { t: 1_800_000_000_000 }; c.now = () => c.t; return c; };

test('点击额度：1 分钟最多 10 次、30 分钟最多 15 次，滚动恢复', () => {
  const c = clock();
  const b = new ClickBudget({ now: c.now });
  for (let i = 0; i < 10; i++) { assert.equal(b.check().ok, true); b.take(); c.t += 1000; }
  const full = b.check();
  assert.equal(full.ok, false);
  assert.ok(full.until - c.t <= 60000, '分钟额度满：1 分钟内恢复');
  c.t += 60000;
  for (let i = 0; i < 5; i++) { assert.equal(b.check().ok, true); b.take(); }
  const half = b.check();
  assert.equal(half.ok, false, '30 分钟内第 16 次不点');
  assert.ok(half.until - c.t > 25 * 60000, '要等最早那次点击滑出 30 分钟窗口');
  c.t = half.until;
  assert.equal(b.check().ok, true);
});

test('互斥：两个入口同时要放行只开一个窗口、只算一次，结果共用', async () => {
  const c = clock();
  const budget = new ClickBudget({ now: c.now });
  let opens = 0, release;
  const open = () => { opens += 1; return new Promise(r => { release = () => r({ clicked: true, text: '接受风险并访问' }); }); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mutex-'));
  const a = new GatePasser({ open, logDir: dir, now: c.now, budget, logName: 'a' });
  const b = new GatePasser({ open, logDir: dir, now: c.now, budget, logName: 'b' });
  const pa = a.attempt('https://own.example.cn/x'), pb = b.attempt('https://own.example.cn/y');
  await new Promise(r => setImmediate(r));
  release();
  assert.deepEqual(await Promise.all([pa, pb]), [true, true]);
  assert.equal(opens, 1);
  assert.equal(budget.used(60000), 1);
});

test('左边按钮兜底：文字没认出来时，取够大的、非取消类按钮里最靠左的', () => {
  const big = (text, x, extra = {}) => ({ text, x, y: 300, w: 160, h: 44, button: true, ...extra });
  assert.equal(pickGateFallback([big('Visit', 600), big('Learn more', 380)]), 1, '左边那个');
  assert.equal(pickGateFallback([big('返回', 200), big('Go', 420)]), 1, '不点返回');
  assert.equal(pickGateFallback([big('x', 100, { w: 10, h: 10 }), big('Go', 420)]), 1, '太小的不算');
  assert.equal(pickGateFallback([big('Go', 100, { button: false })]), -1, '不像按钮的链接不算');
  assert.equal(pickGateFallback([]), -1);
});

test('放行页脚本：两个不认识文字的蓝色大按钮，点左边那个；locate 模式只回位置不点', () => {
  const run = (labels, mode) => {
    const clicked = [];
    const els = labels.map(([text, x]) => ({ innerText: text, tagName: 'BUTTON', className: 'btn btn-primary', getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 180, height: 48, left: x, top: 320 }), click: () => clicked.push(text) }));
    const sandbox = { document: { title: 'HIS Proxy', querySelectorAll: () => els }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
    return { result: vm.runInNewContext(gateClickScript(['AI HUB 服务'], mode), sandbox), clicked };
  };
  const clickRun = run([['立即前往', 620], ['我要访问', 400]], 'click');
  assert.deepEqual(clickRun.clicked, ['我要访问']);
  assert.equal(clickRun.result.how, 'left');
  const locate = run([['立即前往', 620], ['我要访问', 400]], 'locate');
  assert.deepEqual(locate.clicked, []);
  assert.equal(locate.result.found, true);
  assert.equal(locate.result.rect.x, 490);
  const word = run([['返回', 100], ['接受风险并访问', 400]], 'click');
  assert.deepEqual(word.clicked, ['接受风险并访问']);
  assert.equal(word.result.how, 'word');
});

const res = (status, body, type = 'text/html') => ({ status, ok: status >= 200 && status < 300, type: 'basic', headers: { get: k => String(k).toLowerCase() === 'content-type' ? type : null }, text: async () => body });
const OWN = '<!DOCTYPE html><title>AI HUB 服务</title><p>AI HUB 服务正常。</p>';
const GATE = '<html><title>HIS Proxy Notification</title><button>接受风险并访问</button></html>';
const NF = '{"ok": false, "error": {"code": "not_found"}}';

test('探测：GET 拿到自家小页、POST 拿到 JSON 才算正常；跳转或别的网页算被拦；断网和 5xx 不算', async () => {
  const url = 'https://own.example.cn/hub-update/api/feedback';
  const fetcher = (get, post) => async (_u, init) => { const r = init.method === 'POST' ? post : get; if (r instanceof Error) throw r; return r; };
  assert.equal((await probeOwnPage(fetcher(res(200, OWN), res(404, NF, 'application/json')), url)).state, 'ok');
  const postGated = await probeOwnPage(fetcher(res(200, OWN), res(200, GATE)), url);
  assert.deepEqual([postGated.state, postGated.method], ['gate', 'POST'], 'GET 已放行、POST 仍被拦（2026-10-30 真机）');
  assert.equal((await probeOwnPage(fetcher(res(200, GATE), null), url)).state, 'gate');
  assert.equal((await probeOwnPage(fetcher(res(302, ''), null), url)).state, 'gate');
  assert.equal((await probeOwnPage(fetcher(new Error('Redirect was cancelled'), null), url)).state, 'gate');
  assert.equal((await probeOwnPage(fetcher(new Error('net::ERR_INTERNET_DISCONNECTED'), null), url)).state, 'offline');
  assert.equal((await probeOwnPage(fetcher(res(502, 'Bad Gateway', 'text/plain'), null), url)).state, 'offline');
});

function rigHeartbeat({ passAfterClicks = 3, enabled = () => true } = {}) {
  const c = clock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-hb-'));
  const s = { gated: true, clicks: 0, probes: 0, passed: 0, methods: [], times: [] };
  const passer = new GatePasser({ logDir: dir, logName: 'net-unblock', now: c.now,
    open: async (_u, opts) => { s.clicks += 1; s.times.push(c.t); s.methods.push(opts && opts.method); c.t += 3000; if (s.clicks >= passAfterClicks) s.gated = false; return { clicked: true, text: '接受风险并访问', method: 'trusted' }; } });
  const hb = new GateHeartbeat({ url: 'https://own.example.cn/hub-update/api/feedback', passer, now: c.now, settleMs: 4000, enabled,
    sleep: async ms => { c.t += ms; }, probe: async () => { s.probes += 1; return s.gated ? { state: 'gate', method: 'GET' } : { state: 'ok', method: 'POST' }; },
    onPassed: () => { s.passed += 1; } });
  return { c, s, hb, passer, dir };
}

test('心跳：没被拦什么都不做；被拦就连点（每点一次隔几秒再探），通了立即通知并清零', async () => {
  const quiet = rigHeartbeat();
  quiet.s.gated = false;
  await quiet.hb.tick();
  assert.deepEqual([quiet.s.clicks, quiet.s.passed], [0, 0]);

  const { s, hb, dir } = rigHeartbeat({ passAfterClicks: 3 });
  await hb.tick();
  assert.equal(s.clicks, 3, '按钮不灵敏：同一轮里连点到通为止');
  assert.equal(s.passed, 1);
  assert.equal(hb.status().gated, false);
  assert.deepEqual(s.methods, ['GET', 'GET', 'GET']);
  const log = fs.readFileSync(path.join(dir, 'net-unblock.log'), 'utf8').trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.deepEqual(log.map(x => x.result), ['clicked', 'clicked', 'clicked', 'passed']);
});

test('心跳：一直不通时一分钟内最多 10 次、30 分钟最多 15 次，之后只探不点；人手放行后照样报恢复', async () => {
  const { c, s, hb } = rigHeartbeat({ passAfterClicks: Infinity });
  await hb.tick();
  assert.ok(s.clicks <= 10 && s.clicks >= 5, `第一分钟点了 ${s.clicks} 次`);
  for (let i = 0; i < 40; i++) { c.t += 60000; await hb.tick(); }
  // 任意 1 分钟不超过 10 次、任意 30 分钟不超过 15 次；额度滑动恢复后会接着点。
  for (const t0 of s.times) {
    assert.ok(s.times.filter(t => t >= t0 && t < t0 + 60000).length <= 10);
    assert.ok(s.times.filter(t => t >= t0 && t < t0 + 30 * 60000).length <= 15);
  }
  assert.ok(s.times.some(t => t - s.times[0] >= 30 * 60000), '30 分钟后额度恢复，接着点');
  const at = s.clicks;
  c.t += 1000; await hb.tick();
  s.gated = false; // 用户自己在浏览器里点了放行
  c.t += 60000; await hb.tick();
  assert.equal(s.passed, 1);
  assert.ok(s.clicks <= at + 1);
});

test('心跳：「网络放行」改成手动后不再自动点', async () => {
  let on = false;
  const { s, hb } = rigHeartbeat({ enabled: () => on });
  await hb.tick();
  assert.equal(s.clicks, 0);
  on = true;
  await hb.tick();
  assert.ok(s.clicks > 0);
});

// 审查 2026-11-08 补的三条。
const runScript = (title, labels, ...args) => {
  const clicked = [];
  const els = labels.map(([text, x]) => ({ innerText: text, tagName: 'BUTTON', className: 'btn', getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 180, height: 48, left: x, top: 320 }), click: () => clicked.push(text) }));
  const sandbox = { document: { title, body: { innerText: '' }, querySelectorAll: () => els }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  return { result: vm.runInNewContext(gateClickScript(['AI HUB 服务'], ...args), sandbox), clicked };
};

test('左边兜底只在像拦截页的页面上用：普通页面（如登录页）文字认不出就一个都不点', () => {
  assert.deepEqual(runScript('请登录', [['登录', 100], ['注册', 400]], 'click').clicked, []);
  assert.deepEqual(runScript('HIS Proxy Notification', [['Visit', 100], ['More', 400]], 'click').clicked, ['Visit']);
});

test('补点：定位时那个位置的按钮文字变了（页面已跳走或改了）就不点', () => {
  const same = runScript('HIS Proxy', [['返回', 100], ['接受风险并访问', 400]], 'click', 1, '接受风险并访问');
  assert.deepEqual(same.clicked, ['接受风险并访问']);
  const changed = runScript('另一个页面', [['返回', 100], ['删除', 400]], 'click', 1, '接受风险并访问');
  assert.deepEqual(changed.clicked, []);
  assert.equal(changed.result.changed, true);
});

test('互斥：两台主机同时要放行不共用结果，排队各点各的；同一台同时要放行才共用', async () => {
  const c = clock();
  const budget = new ClickBudget({ now: c.now });
  const opened = [];
  const open = async url => { opened.push(new URL(url).host); await new Promise(r => setTimeout(r, 5)); return { clicked: !url.includes('dl.'), text: 'x' }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mutex2-'));
  const p = new GatePasser({ open, logDir: dir, now: c.now, budget });
  const [a, b, a2] = await Promise.all([p.attempt('https://me.example.cn/x'), p.attempt('https://dl.example.cn/x'), p.attempt('https://me.example.cn/y')]);
  assert.deepEqual(opened, ['me.example.cn', 'dl.example.cn']);
  assert.deepEqual([a, b, a2], [true, false, true]);
});
