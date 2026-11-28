'use strict';
// 社区榜单·内源只读黑板（2026-11-28）：序列化/解析、by_id 匿名读取、绿区隔离回退、黄区定时发布、界面只读展示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ob = require('../core/community/openx-board');
const C = require('../core/community/client');
const { createCommunityService } = require('../main/community-service');
const { createBoardPublisher, buildPublishScript } = require('../main/community-board-publisher');
const { createOpenxBoardReader, buildBoardReadScript } = require('../main/openx-login-board');
const { createReceiverAddress } = require('../core/feedback-receiver-address');
const { viewModel, pageHtml } = require('../renderer/community-page');
const mock = require('./fixtures/community-board-mock');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-blackboard-'));
const WED = Date.UTC(2026, 10, 25, 2, 0, 0);

test('openx-board：序列化剥离 me/daily/host，解析校验版本名与标记', () => {
  const hostBoard = {
    ...mock.hostBoard(),
    me: { nick: '不应泄露', ranks: { level: 1 } },
    diag: { day: '2026-11-28', counts: { 'x:y': 1 } },
  };
  const desc = ob.serializeBoard(hostBoard);
  assert.ok(desc.startsWith(ob.BOARD_HEAD + '\n' + ob.BOARD_MARK + '\n'));
  assert.ok(!desc.includes('不应泄露'));
  assert.ok(!desc.includes('pulsesToday'));
  assert.ok(!desc.includes('"daily"'));
  const parsed = ob.parseBoardDescription(desc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.board.online, hostBoard.online);
  assert.equal(parsed.board.me, null);
  assert.equal(parsed.board.boards.level[0].me, false);

  // 时间戳不同但榜单内容相同时签名一致
  const sig1 = ob.boardSignature(hostBoard);
  const sig2 = ob.boardSignature({ ...hostBoard, at: hostBoard.at + 60000 });
  assert.equal(sig1, sig2);
  assert.notEqual(sig1, ob.boardSignature({ ...hostBoard, online: hostBoard.online + 1 }));

  assert.equal(ob.parseBoardDescription('没有标记').ok, false);
  assert.equal(ob.parseBoardDescription(`${ob.BOARD_MARK}\n{"v":2}`).ok, false);
});

test('readBlackboard：校验 release 版本名必须是 community-board，防止读错版本', async () => {
  const desc = ob.serializeBoard(mock.board());
  const okRes = await ob.readBlackboard({
    releaseId: 12900,
    config: { api: 'https://openx.example.invalid/openxApi/project/version/release/query/', boardReleaseId: 0 },
    fetchImpl: async url => {
      assert.ok(url.endsWith('by_id?id=12900'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data: { id: 12900, version: 'community-board', description: desc } }) };
    },
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.board.online, mock.board().online);

  const wrongVer = await ob.readBlackboard({
    releaseId: 12787,
    config: { api: 'https://openx.example.invalid/openxApi/project/version/release/query/' },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data: { id: 12787, version: 'hub-index', description: desc } }) }),
  });
  assert.equal(wrongVer.ok, false);
  assert.match(wrongVer.error, /名称不匹配/);
});

test('feedback-receiver-address：解析并缓存 boardReleaseId', async () => {
  const dir = tmp();
  const ra = createReceiverAddress({
    dataDir: dir,
    config: { api: 'https://openx.example.invalid/openxApi/', projectId: 7938, indexReleaseId: 12787, fileSite: 'https://openx.example.invalid/', boardReleaseId: 0 },
    fetchImpl: async url => {
      if (url.includes('by_id?id=12787')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data: { version: 'hub-index', description: '#hub-index v1\n9001 feedback-receiver 2026-11-28T10:00:00+08:00' } }) };
      }
      if (url.includes('by_id?id=9001')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data: { version: 'feedback-receiver', binaryPackages: [{ originalFileName: 'feedback-receiver.json', url: 'https://openx.example.invalid/files/fr.json' }] } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ urls: ['http://10.0.0.1:18767'], boardReleaseId: 12999 }) };
    },
  });
  const res = await ra.resolve();
  assert.deepEqual(res.urls, ['http://10.0.0.1:18767']);
  assert.equal(res.boardReleaseId, 12999);
  assert.equal(ra.readCache().boardReleaseId, 12999);
});

test('发送端：收件机网络隔离（绿区）时自动回退读内源黑板，点亮底栏并落盘缓存', async () => {
  let t = WED;
  const dir = tmp();
  const cacheFile = path.join(dir, 'community', 'board-cache.json');
  const summaries = [];
  const sample = { ...mock.board(), at: t - 5 * 60 * 1000 };
  const client = C.createCommunityClient({
    now: () => t,
    cacheFile,
    receiverAddress: { resolve: async () => ({ urls: ['http://100.100.97.8:18767'], boardReleaseId: 12999 }) },
    buildPayload: () => ({ v: 1, iid: 'a'.repeat(32) }),
    fetchImpl: async () => { throw Object.assign(new Error('timeout'), { cause: { code: 'ETIMEDOUT' } }); },
    readBlackboard: async ({ boardReleaseId }) => {
      assert.equal(boardReleaseId, 12999);
      return { ok: true, board: { ...sample, me: null } };
    },
    onSummary: s => summaries.push(s),
  });

  // 1) pulse() 在绿区失败后自动拉取黑板，点亮底栏在线数
  const pr = await client.pulse();
  assert.equal(pr.sent, false);
  assert.equal(pr.state, 'ok');
  assert.equal(pr.isolated, true);
  assert.equal(pr.boardReadOnly, true);
  assert.equal(client.getOnline().state, 'ok');
  assert.equal(client.getOnline().online, sample.online);
  assert.equal(summaries.at(-1).online, sample.online);

  // 2) getBoard() 在绿区直接拿到只读榜单并带 boardReadOnly 标记
  const b = await client.getBoard({ force: true });
  assert.equal(b.state, 'ok');
  assert.equal(b.boardReadOnly, true);
  assert.equal(b.isolated, true);
  assert.equal(b.boards.level.length, sample.boards.level.length);
  assert.match(b.note, /只读/);

  // 3) 界面渲染：显示榜单与只读说明，不显示「第一次同步后显示」
  const html = pageHtml(viewModel(b, 'level'));
  assert.match(html, /已从公司内源同步全员榜单/);
  assert.match(html, /只读模式/);
  assert.ok(!html.includes('第一次同步后显示'));
  assert.match(html, /cmy-podium/);
});

test('黄区黑板发布器：非收件机跳过；无变化不重开 Edge；有变化才发布并校验脚本含版本名护栏', async () => {
  let t = WED, isHost = false, paused = false, online = 10;
  const edgeCalls = [];
  const pub = createBoardPublisher({
    now: () => t,
    host: {
      isHost: () => isHost,
      store: {
        readSettings: () => ({ paused }),
        board: () => ({ ...mock.board(), at: t, online }),
      },
    },
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:18767'], boardReleaseId: 12999 }) },
    findEdgeFn: () => 'msedge.exe',
    runInEdge: async opts => { edgeCalls.push(opts); return { ok: true, value: { ok: true, verified: true } }; },
  });

  assert.equal((await pub.publishOnce()).skipped, true);
  isHost = true; paused = true;
  assert.equal((await pub.publishOnce()).skipped, true);
  paused = false;

  const r1 = await pub.publishOnce();
  assert.equal(r1.ok, true);
  assert.equal(edgeCalls.length, 1);
  assert.ok(edgeCalls[0].script.includes('"expectedVersion":"community-board"'));

  // 10 分钟后只有 at 变了，数据没变 → 不起 Edge
  t += 10 * 60 * 1000;
  const r2 = await pub.publishOnce();
  assert.equal(r2.skipped, true);
  assert.equal(edgeCalls.length, 1);

  // 在线人数变了 → 触发更新
  online = 11;
  const r3 = await pub.publishOnce();
  assert.equal(r3.ok, true);
  assert.equal(edgeCalls.length, 2);
  const script = buildPublishScript({ boardReleaseId: 12999, projectId: 7938, description: 'x' });
  assert.ok(!script.includes("credentials: 'omit'"), '发布回读校验必须带登录态，避免 401');

  // 在 VM 中真实执行发布脚本：匿名 401，带 Bearer token 写入并认证回读通过
  const vm = require('node:vm');
  let storedDesc = 'old', editCount = 0;
  const ctx = {
    localStorage: { getItem: k => (k === 'token' ? 'tok123' : null) },
    sessionStorage: { getItem: () => null },
    fetch: async (url, init = {}) => {
      const hasAuth = init.headers && init.headers.Authorization === 'Bearer tok123';
      if (url.includes('by_id')) {
        if (!hasAuth) return { ok: true, status: 200, json: async () => ({ code: 401, message: '未登陆' }) };
        return { ok: true, status: 200, json: async () => ({ code: '0', data: { id: 12887, version: 'community-board', description: storedDesc, binaryPackages: [{ originalFileName: 'r.txt', url: 'https://openx.example.invalid/r.txt', file: {} }] } }) };
      }
      if (url.includes('release/edit')) {
        assert.ok(hasAuth);
        const body = JSON.parse(init.body);
        assert.equal('file' in body.binaryPackages[0], false);
        storedDesc = body.description;
        editCount += 1;
        return { ok: true, status: 200, json: async () => ({ code: '0' }) };
      }
      throw new Error('unexpected url: ' + url);
    },
  };
  const vmRes = await vm.runInNewContext(`(async () => { return ${script}; })()`, ctx);
  assert.equal(editCount, 1);
  assert.equal(storedDesc, 'x');
  assert.equal(vmRes.ok, true);
  assert.equal(vmRes.verified, true);
});

test('全新绿区客户端集成：无旧地址缓存、by_id 全部 401 时仍走通 Edge 黑板读取', async () => {
  const dir = tmp();
  const sample = { ...mock.board(), at: WED };
  const desc = ob.serializeBoard(sample);
  let loginCalls = 0;
  const fetch401 = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ code: 401, message: '登陆状态过期或未登陆' }),
  });
  const ra = createReceiverAddress({
    dataDir: dir,
    config: { api: 'https://openx.example.invalid/openxApi/project/version/release/query/', projectId: 7938, indexReleaseId: 12787, boardReleaseId: 12887, fileSite: 'https://openx.example.invalid/' },
    fetchImpl: fetch401,
  });
  const client = C.createCommunityClient({
    now: () => WED,
    cacheFile: path.join(dir, 'community', 'board-cache.json'),
    receiverAddress: ra,
    buildPayload: () => ({ v: 1, iid: 'a'.repeat(32) }),
    fetchImpl: fetch401,
    readBlackboard: ({ boardReleaseId, signal }) => ob.readBlackboard({
      releaseId: boardReleaseId,
      config: { api: 'https://openx.example.invalid/openxApi/project/version/release/query/', boardReleaseId: 12887 },
      fetchImpl: fetch401,
      signal,
      readViaLogin: async ({ releaseId }) => {
        loginCalls += 1;
        assert.equal(releaseId, 12887);
        return { ok: true, description: desc };
      },
    }),
  });

  const pr = await client.pulse();
  assert.equal(pr.state, 'ok');
  assert.equal(pr.boardReadOnly, true);
  const br = await client.getBoard({ force: true });
  assert.equal(br.state, 'ok');
  assert.equal(br.boardReadOnly, true);
  assert.equal(br.online, sample.online);
  assert.ok(loginCalls >= 1);
});

test('暂停收集联动中止在途黑板发布，且等待期间暂停不再写入状态', async () => {
  let paused = false, aborted = false, releaseEdge;
  const pub = createBoardPublisher({
    host: { isHost: () => true, store: { readSettings: () => ({ paused }), board: () => ({ ...mock.board(), at: WED }) } },
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:18767'], boardReleaseId: 12887 }) },
    findEdgeFn: () => 'msedge.exe',
    runInEdge: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      releaseEdge = resolve;
    }),
  });
  const svc = createCommunityService({
    dataDir: tmp(), edition: 'member', version: '5.6.143',
    profileController: null, isEnabled: () => true, setEnabledFlag: async () => {},
    getHost: () => ({ isHost: () => true, store: { readSettings: () => ({ paused }), setPaused: v => { paused = v; return { paused }; }, board: () => mock.board() } }),
    onHostPaused: p => { if (p) pub.abortActive(); },
  });
  const p = pub.publishOnce();
  await new Promise(r => setTimeout(r, 10));
  await svc.handlers['set-host-paused']({ paused: true });
  assert.equal(aborted, true, '暂停收集应立即中止在途黑板发布');
  releaseEdge({ ok: true, value: { ok: true } });
  const r = await p;
  assert.equal(r.skipped, true);
  assert.equal(pub.status().ok, false);
});

test('company-edge-capture：等待 PAGE_STATE 时 abort 立即关闭浏览器，不再执行写入脚本', async t => {
  const http = require('node:http');
  const ehPath = require.resolve('../main/company-edge-browser');
  const edgeHeadlessPath = require.resolve('../main/edge-headless');
  const capPath = require.resolve('../main/company-edge-capture');
  const origWs = globalThis.WebSocket;
  const origCache = { eh: require.cache[edgeHeadlessPath], cap: require.cache[capPath] };
  let evaluatedWrite = false, edgeClosed = false;

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/mock' }]));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  let releasePageState;
  globalThis.WebSocket = class FakeWs {
    constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.method === 'Page.enable' || m.method === 'Page.navigate') {
        setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ id: m.id, result: {} }) }), 0);
      } else if (m.method === 'Runtime.evaluate' && m.params.expression.includes('errorPage')) {
        releasePageState = () => this.onmessage && this.onmessage({
          data: JSON.stringify({ id: m.id, result: { result: { value: { host: 'openx.example.invalid', href: 'https://openx.example.invalid/demo-project/download', ready: 'complete' } } } }),
        });
      } else if (m.method === 'Runtime.evaluate') {
        evaluatedWrite = true;
      }
    }
    close() { if (this.onclose) this.onclose(); }
  };
  delete require.cache[capPath];
  require.cache[edgeHeadlessPath] = {
    id: edgeHeadlessPath, filename: edgeHeadlessPath, loaded: true,
    exports: {
      findEdge: () => 'msedge.exe',
      launchHeadlessEdge: async () => ({
        port, closed: false,
        closeSync() { edgeClosed = true; this.closed = true; },
        async close() { edgeClosed = true; this.closed = true; },
      }),
    },
  };
  t.after(() => {
    globalThis.WebSocket = origWs;
    if (origCache.eh) require.cache[edgeHeadlessPath] = origCache.eh; else delete require.cache[edgeHeadlessPath];
    if (origCache.cap) require.cache[capPath] = origCache.cap; else delete require.cache[capPath];
    srv.close();
  });

  const { runInEdge } = require('../main/company-edge-capture');
  const ctl = new AbortController();
  const p = runInEdge({
    url: 'https://openx.example.invalid/demo-project/download',
    readyUrl: /^https:\/\/openx.example.invalid\//,
    script: '(() => "WRITE_CALLED")()',
    signal: ctl.signal,
    pollMs: 5,
    timeoutMs: 5000,
    env: { LOCALAPPDATA: tmp() },
  });
  while (!releasePageState) await new Promise(r => setTimeout(r, 5));
  ctl.abort();
  releasePageState();
  const res = await p;
  assert.equal(edgeClosed, true);
  assert.equal(evaluatedWrite, false, 'abort 后绝不能再执行写脚本');
  assert.equal(res.ok, false);
});

test('审查 P2：过期或刷新失败的只读缓存优先显示失联/过期文案，不再显示「已从公司内源同步」', () => {
  const vm = viewModel({ ...mock.board(), me: null, state: 'ok', boardReadOnly: true, isolated: true, stale: true, note: C.STATE_TEXT.isolated }, 'level');
  const html = pageHtml(vm);
  assert.ok(!html.includes('已从公司内源同步全员榜单'));
  assert.match(html, /显示的是上次取到的数据/);
  assert.match(html, /只读模式/);
});

test('readBlackboard：by_id 返回 401 时走 readViaLogin（Edge 登录读取）', async () => {
  const desc = ob.serializeBoard(mock.board());
  let loginCalled = 0;
  const res = await ob.readBlackboard({
    releaseId: 12887,
    config: { api: 'https://openx.example.invalid/openxApi/project/version/release/query/', boardReleaseId: 12887 },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 401, message: '未登陆' }) }),
    readViaLogin: async ({ releaseId }) => {
      loginCalled += 1;
      assert.equal(releaseId, 12887);
      return { ok: true, description: desc };
    },
  });
  assert.equal(loginCalled, 1);
  assert.equal(res.ok, true);
  assert.equal(res.board.online, mock.board().online);
  assert.ok(buildBoardReadScript({ apiPath: '/openxApi/project/version/release/query/', releaseId: 12887 }).includes('"expectedVersion":"community-board"'));
});

test('openx-login-board：复用并发请求，失败后进入冷却期不再重复起 Edge', async () => {
  let t = WED, edgeCalls = 0;
  const reader = createOpenxBoardReader({
    env: { AI_HUB_OPENX_LOGIN_BOARD: '1' },
    now: () => t,
    findEdgeFn: () => 'msedge.exe',
    runInEdge: async () => { edgeCalls += 1; return { ok: false, error: '未登录' }; },
  });
  const [a, b] = await Promise.all([reader({ releaseId: 12887 }), reader({ releaseId: 12887 })]);
  assert.equal(edgeCalls, 1);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  // 冷却期内不再起 Edge
  const c = await reader({ releaseId: 12887 });
  assert.equal(c.ok, false);
  assert.equal(edgeCalls, 1);
});

test('审查 P1：发布器在等待期间暂停或 stop() 时不启动 Edge，并中止在途 Edge 且并发互斥', async () => {
  let t = WED, paused = false, edgeCalls = 0, abortedInEdge = false;
  let releaseAddr;
  const pub1 = createBoardPublisher({
    now: () => t,
    host: { isHost: () => true, store: { readSettings: () => ({ paused }), board: () => ({ ...mock.board(), at: t }) } },
    receiverAddress: { resolve: () => new Promise(r => { releaseAddr = r; }) },
    findEdgeFn: () => 'msedge.exe',
    runInEdge: async () => { edgeCalls += 1; return { ok: true, value: { ok: true } }; },
  });
  const p = pub1.publishOnce();
  paused = true;
  pub1.stop();
  releaseAddr({ urls: ['http://10.0.0.1:18767'], boardReleaseId: 12887 });
  const r = await p;
  assert.equal(r.skipped, true);
  assert.equal(edgeCalls, 0);

  // stop() 中止正在跑的 runInEdge，且并发 publishOnce 复用同一任务
  let releaseEdge;
  const pub2 = createBoardPublisher({
    now: () => t,
    host: { isHost: () => true, store: { readSettings: () => ({ paused: false }), board: () => ({ ...mock.board(), at: t }) } },
    receiverAddress: { resolve: async () => ({ urls: ['http://10.0.0.1:18767'], boardReleaseId: 12887 }) },
    findEdgeFn: () => 'msedge.exe',
    runInEdge: ({ signal }) => new Promise(resolve => {
      edgeCalls += 1;
      signal.addEventListener('abort', () => { abortedInEdge = true; resolve({ ok: false, error: '已取消' }); }, { once: true });
      releaseEdge = resolve;
    }),
  });
  const p1 = pub2.publishOnce();
  const p2 = pub2.publishOnce();
  assert.equal(p1, p2);
  await new Promise(r2 => setTimeout(r2, 10));
  assert.equal(edgeCalls, 1);
  pub2.stop();
  assert.equal(abortedInEdge, true);
  if (releaseEdge) releaseEdge({ ok: false });
  await p1;
});

test('审查 P1：客户端关闭开关/stop/brake 时中止黑板请求且绝不回写 ok 状态', async () => {
  let enabled = true, aborted = false, resolveBb;
  const summaries = [];
  const client = C.createCommunityClient({
    isEnabled: () => enabled,
    receiverAddress: { resolve: async () => ({ urls: ['http://100.100.97.8:18767'], boardReleaseId: 12887 }) },
    buildPayload: () => ({ v: 1, iid: 'a'.repeat(32) }),
    fetchImpl: async () => { throw Object.assign(new Error('timeout'), { cause: { code: 'ETIMEDOUT' } }); },
    readBlackboard: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      resolveBb = resolve;
    }),
    onSummary: s => summaries.push(s),
  });
  const p = client.pulse();
  await new Promise(r => setTimeout(r, 20));
  enabled = false;
  client.setEnabled(false);
  assert.equal(aborted, true, '关开关应立即中止黑板请求');
  resolveBb({ ok: true, board: { ...mock.board(), online: 99 } });
  const res = await p;
  assert.equal(res.state, 'disabled');
  assert.equal(summaries.at(-1).state, 'disabled', '黑板延迟返回不能覆盖 disabled 状态');
});
