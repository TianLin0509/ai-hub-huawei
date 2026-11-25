'use strict';
// 内源无感下载记录器单测（2026-11-25）：
// 覆盖：检查更新永不触发记录；大版本与小版本/静默更新均触发；版本去重；秒点立即重启后启动补记；
// 后台失败静默降级不影响 phase=ready；开关关闭停止记录；手动下载完整包也后台补记并进诊断；
// 浏览器定位脚本语法有效且能按 packageTag / 文件名 / 兜底匹配。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: {} });
const openxConfig = require('../core/app-update/openx-config.js');
const openxSource = require('../core/app-update/openx-source.js');
const signing = require('../core/app-update/manifest-signing.js');
const { packPayload } = require('../core/app-update/payload.js');
const { createAppUpdateController, registerAppUpdateIpc } = require('../main/app-update-controller.js');
const { registerDownloadSourceIpc } = require('../main/download-source-ipc.js');
const {
  createOpenxDownloadRecorder,
  buildLocateScript,
  sanitizeApiPath,
  isDownloadLikeUrl,
  RECORD_FILE,
} = require('../main/openx-download-recorder.js');

const API = openxSource.DEFAULT_API;
const SITE = new URL(openxConfig.fileSite).hostname;
const FILE_HOST = `https://file.${SITE}/openx-file/`;
const ENV = { AI_HUB_OPENX: '1' };
const KEYS = crypto.generateKeyPairSync('ed25519');
const PUB = KEYS.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const jsonResp = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const settle = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 15));
  }
  return false;
};

function makeFixture({ currentVersion = '5.6.106', targetVersion = '5.6.107', projectName = 'Demo-Hub-Project', releaseVersion, packageTag } = {}) {
  const res = tmp('oxrec-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(2048));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'icon.ico'), 'icon');
  const gzPath = path.join(tmp('oxrec-gz-'), 'pkg.gz');
  packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath);
  const file = `DemoHub-${targetVersion}-update.gz`;
  const instFile = `DemoHub-Setup-${targetVersion}.exe`;
  const m = {
    schema: 1,
    product: 'DemoHub',
    version: targetVersion,
    notes: ['note-1'],
    runtime: { electron: '41.2.0', native: {} },
    incremental: { file, bytes: gz.length, sha256: sha(gz) },
    installer: { file: instFile, bytes: 4096, sha256: sha(Buffer.alloc(4096)) },
  };
  const rawManifest = JSON.stringify(m, null, 2) + '\n';
  const relVer = releaseVersion || `v${targetVersion}`;
  const tag = packageTag || `${file}（Hub 自动更新用的完整更新包）`;
  const fetchImpl = async u => {
    u = String(u);
    if (u.startsWith(API + 'by_project_id')) {
      return jsonResp({ code: '0', data: { name: projectName, records: [{ id: 12536, version: relVer, releaseTime: '2026-11-25 16:00:00' }] } });
    }
    if (u.startsWith(API + 'by_id')) {
      return jsonResp({
        code: '0',
        data: {
          binaryPackages: [
            { id: 101, originalFileName: 'latest.json', tag: 'latest.json', url: FILE_HOST + 'latest.json' },
            { id: 102, originalFileName: 'latest.json.sig', tag: 'latest.json.sig', url: FILE_HOST + 'latest.json.sig' },
            { id: 103, originalFileName: file, tag, url: FILE_HOST + file },
            { id: 104, originalFileName: instFile, tag: '安装版（推荐）：双击安装，也可直接覆盖安装旧版', url: FILE_HOST + instFile },
          ],
        },
      });
    }
    if (u === FILE_HOST + 'latest.json') return new Response(rawManifest, { status: 200 });
    if (u === FILE_HOST + 'latest.json.sig') return new Response(signing.signManifest(rawManifest, PEM), { status: 200 });
    if (u === FILE_HOST + file) return new Response(gz, { status: 200, headers: { 'content-length': String(gz.length) } });
    return new Response('not found', { status: 404 });
  };
  return { res, dataDir: tmp('oxrec-data-'), fetchImpl, currentVersion, targetVersion, file, instFile, tag, projectName, relVer };
}

test.beforeEach(() => openxSource._reset());

test('openx-source：从 by_project_id 动态读取项目名并透传 packageId / packageTag', async () => {
  const fx = makeFixture();
  const hit = await openxSource.find({ file: fx.file, version: fx.targetVersion, fetchImpl: fx.fetchImpl, env: ENV });
  assert.ok(hit);
  assert.equal(hit.releaseId, 12536);
  assert.equal(hit.releaseVersion, fx.relVer);
  assert.equal(hit.packageId, 103);
  assert.equal(hit.packageTag, fx.tag);
  assert.equal(hit.projectName, fx.projectName);
  assert.equal(openxSource.projectName(), fx.projectName);
  assert.equal(openxSource.downloadPageUrl(), `https://${SITE}/${fx.projectName}/download`);
});

test('检查更新永不触发内源下载记录；真正下载大版本（5.7.0）才触发并推送感谢状态', async () => {
  const fx = makeFixture({ currentVersion: '5.6.106', targetVersion: '5.7.0' });
  const calls = [];
  const sent = [];
  const recorder = createOpenxDownloadRecorder({
    dataDir: fx.dataDir,
    env: ENV,
    fetchImpl: fx.fetchImpl,
    logger: { info() {}, warn() {} },
    runSession: async target => {
      calls.push(target);
      return { ok: true, method: 'dom-click', tookMs: 120, apiPaths: ['/openxApi/project/version/release/download'] };
    },
  });
  const c = createAppUpdateController({
    app: { quit() {} },
    config: { sources: [] },
    dataDir: fx.dataDir,
    currentVersion: fx.currentVersion,
    fetchImpl: fx.fetchImpl,
    isPackaged: true,
    resourcesPath: fx.res,
    manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: fx.res },
    logger: { info() {}, warn() {} },
    sendToRenderer: (_ch, s) => sent.push(s),
    openxRecorder: recorder,
  });

  await c.check({ silent: false, quietAllowed: false });
  assert.equal(c.getState().phase, 'available');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(calls.length, 0, '检查更新绝不能触发下载记录');

  await c.download();
  assert.equal(c.getState().phase, 'ready');
  assert.equal(await settle(() => c.getState().openxRecord?.status === 'recorded'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].version, '5.7.0');
  assert.equal(calls[0].packageId, 103);
  assert.equal(calls[0].packageTag, fx.tag);
  assert.equal(calls[0].pageUrl, `https://${SITE}/${fx.projectName}/download`);
  assert.equal(calls[0].kind, 'manual-update');
  assert.ok(sent.some(s => s.openxRecord && s.openxRecord.status === 'recorded' && s.openxRecord.version === '5.7.0'));
  const diag = c.openxRecordDiagnostics();
  assert.equal(diag.stats.attempted, 1);
  assert.equal(diag.stats.succeeded, 1);
  assert.equal(diag.stats.failed, 0);
  c.dispose();
});

test('小版本静默更新（5.6.106 → 5.6.107）同样计入内源下载，同版本不重复计数', async () => {
  const fx = makeFixture({ currentVersion: '5.6.106', targetVersion: '5.6.107' });
  const calls = [];
  const recorder = createOpenxDownloadRecorder({
    dataDir: fx.dataDir,
    env: ENV,
    fetchImpl: fx.fetchImpl,
    logger: { info() {}, warn() {} },
    runSession: async target => {
      calls.push(target);
      return { ok: true, method: 'dom-click', tookMs: 90 };
    },
  });
  const c = createAppUpdateController({
    app: { quit() {} },
    config: { sources: [] },
    dataDir: fx.dataDir,
    currentVersion: fx.currentVersion,
    fetchImpl: fx.fetchImpl,
    isPackaged: true,
    resourcesPath: fx.res,
    manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: fx.res },
    logger: { info() {}, warn() {} },
    openxRecorder: recorder,
  });

  await c.check({ silent: true, quietAllowed: true });
  assert.equal(await settle(() => c.getState().phase === 'ready'), true);
  assert.equal(c.getState().quiet, true);
  assert.equal(await settle(() => c.getState().openxRecord?.status === 'recorded'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].version, '5.6.107');
  assert.equal(calls[0].kind, 'quiet-update');

  // 同一版本再次调用 record：命中去重缓存，不再拉起无头浏览器。
  const dup = await recorder.record({ version: '5.6.107', file: fx.file });
  assert.equal(dup.status, 'recorded');
  assert.equal(dup.cached, true);
  assert.equal(calls.length, 1);
  c.dispose();
});

test('秒点立即重启中断后台记录：pending 落盘，新版启动后延迟补记成功', async () => {
  const dataDir = tmp('oxrec-resume-');
  let started = false;
  let releaseFirst;
  const firstRun = createOpenxDownloadRecorder({
    dataDir,
    env: ENV,
    logger: { info() {}, warn() {} },
    runSession: () => new Promise(resolve => {
      started = true;
      releaseFirst = () => resolve({ ok: false, transient: true, reason: '已取消' });
    }),
  });
  const p1 = firstRun.record({
    version: '5.6.108',
    releaseVersion: 'v5.6.108',
    packageTag: 'DemoHub-5.6.108-update-delta.gz（增量小包）',
    file: 'DemoHub-5.6.108-update-delta.gz',
    pageUrl: `https://${SITE}/Demo-Hub-Project/download`,
  });
  assert.equal(await settle(() => started), true);
  // 模拟用户立刻点「立即重启」：旧进程 dispose 中断在途会话后，即使会话收尾返回取消，也绝不能抹掉磁盘上的 pending。
  firstRun.dispose();
  releaseFirst();
  await p1;
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-update', RECORD_FILE), 'utf8'));
  assert.equal(onDisk.pending.version, '5.6.108', '退出中断后 pending 必须保留在磁盘供新版补记');
  assert.equal(onDisk.stats.failed, 0, '退出中断不计入失败');

  // 新版本启动：resumePending 补记成功并清理 pending。
  const resumedCalls = [];
  const secondRun = createOpenxDownloadRecorder({
    dataDir,
    env: ENV,
    logger: { info() {}, warn() {} },
    resumeDelayMs: 20,
    runSession: async target => {
      resumedCalls.push(target);
      return { ok: true, method: 'dom-click', tookMs: 55 };
    },
  });
  const res = await secondRun.resumePending({ delayMs: 20 });
  assert.equal(res.status, 'recorded');
  assert.equal(resumedCalls.length, 1);
  assert.equal(resumedCalls[0].version, '5.6.108');
  assert.equal(secondRun.diagnostics().pending, null);
  assert.equal(secondRun.isRecorded('5.6.108'), true);
  secondRun.dispose();
});

test('后台无头记录失败（未登录 / Edge 缺失 / 超时）：静默降级，不报错也不影响 phase=ready', async () => {
  const fx = makeFixture({ currentVersion: '5.6.106', targetVersion: '5.6.109' });
  const recorder = createOpenxDownloadRecorder({
    dataDir: fx.dataDir,
    env: ENV,
    fetchImpl: fx.fetchImpl,
    logger: { info() {}, warn() {} },
    runSession: async () => ({ ok: false, needsLogin: true, transient: true, reason: '需要登录' }),
  });
  const c = createAppUpdateController({
    app: { quit() {} },
    config: { sources: [] },
    dataDir: fx.dataDir,
    currentVersion: fx.currentVersion,
    fetchImpl: fx.fetchImpl,
    isPackaged: true,
    resourcesPath: fx.res,
    manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: fx.res },
    logger: { info() {}, warn() {} },
    openxRecorder: recorder,
  });

  await c.check({ silent: false, quietAllowed: false });
  await c.download();
  assert.equal(c.getState().phase, 'ready');
  assert.equal(c.getState().error, null);
  assert.equal(await settle(() => c.getState().openxRecord?.status === 'failed'), true);
  assert.equal(c.getState().phase, 'ready', '记录失败绝不改变更新就绪状态');
  assert.equal(c.getState().error, null, '记录失败绝不向用户报错');
  const diag = c.openxRecordDiagnostics();
  assert.equal(diag.stats.attempted, 1);
  assert.equal(diag.stats.succeeded, 0);
  assert.equal(diag.stats.failed, 1);
  assert.equal(diag.stats.lastReason, '需要登录');
  assert.equal(diag.pending.attempts, 1, '临时失败保留一次补记机会');
  c.dispose();
});

test('用户关闭开关后停止记录，且 IPC 通道已注册', async () => {
  const fx = makeFixture({ currentVersion: '5.6.106', targetVersion: '5.6.110' });
  let count = 0;
  const recorder = createOpenxDownloadRecorder({
    dataDir: fx.dataDir,
    env: ENV,
    fetchImpl: fx.fetchImpl,
    logger: { info() {}, warn() {} },
    runSession: async () => { count += 1; return { ok: true }; },
  });
  const c = createAppUpdateController({
    app: { quit() {} },
    config: { sources: [] },
    dataDir: fx.dataDir,
    currentVersion: fx.currentVersion,
    fetchImpl: fx.fetchImpl,
    isPackaged: true,
    resourcesPath: fx.res,
    manifestPublicKey: PUB,
    env: { ...ENV, AI_HUB_UPDATE_RESOURCES: fx.res },
    logger: { info() {}, warn() {} },
    openxRecorder: recorder,
  });
  const handles = [];
  registerAppUpdateIpc({ handle: name => handles.push(name) }, c);
  assert.ok(handles.includes('app-update:set-openx-record'));
  assert.ok(handles.includes('app-update:record-manual'));
  assert.ok(handles.includes('app-update:openx-record-diagnostics'));

  c.setOpenxRecordEnabled(false);
  assert.equal(c.getState().openxRecordEnabled, false);
  await c.check({ silent: false, quietAllowed: false });
  await c.download();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(count, 0, '关闭开关后不再拉起记录');
  c.dispose();
});

test('download-source-ipc 诊断信息包含脱敏后的内源下载记录统计', async () => {
  const dataDir = tmp('oxrec-diag-');
  const recorder = createOpenxDownloadRecorder({
    dataDir,
    env: ENV,
    logger: { info() {}, warn() {} },
    runSession: async () => ({ ok: true, tookMs: 100 }),
  });
  await recorder.record({ version: '5.6.107', file: 'a.gz', pageUrl: `https://${SITE}/Demo/download` });
  const ipc = registerDownloadSourceIpc({ handle() {} }, { env: ENV, openxRecorder: recorder });
  const text = await ipc.diagnostics('app-update');
  assert.match(text, /内源下载记录：已开启 · 成功 1\/1 · 最近 v5\.6\.107 已计入/);
  assert.doesNotMatch(text, /token|cookie|password/i);
  recorder.dispose();
});

test('工具函数与定位脚本：语法合法、路径脱敏、下载链接识别准确', () => {
  const script = buildLocateScript({
    releaseVersion: 'v5.6.104 完整安装包',
    version: '5.6.104',
    packageTag: '安装版（推荐）：双击安装，也可直接覆盖安装旧版',
    file: 'DemoHub-Setup-5.6.104.exe',
  });
  assert.doesNotThrow(() => new vm.Script(script), '注入页面的定位脚本必须无语法错误');
  assert.equal(sanitizeApiPath(`https://${SITE}/openxApi/project/version/12536/download?token=secret`), '/openxApi/project/version/:id/download');
  assert.equal(sanitizeApiPath('https://example.invalid/other'), '');
  assert.equal(isDownloadLikeUrl(`https://file.${SITE}/openx-file/a.gz`, 'a.gz'), true);
  assert.equal(isDownloadLikeUrl(`https://${SITE}/openxApi/visitOpenXRecord/saveRecord?visitUrl=x`, 'a.gz'), false);
  assert.equal(isDownloadLikeUrl(`https://${SITE}/openxApi/project/version/downloadRecord`, 'a.gz'), true);
});

test('界面渲染源码守卫：仅 recorded 显示感谢文案，失败静默，不破坏原有完整安装包直链逻辑', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app-update.js'), 'utf8');
  assert.match(src, /rec && rec\.status === 'recorded'/);
  assert.match(src, /data-au-openx-recorded/);
  assert.match(src, /data-au="openx-record"/);
  assert.match(src, /app-update:set-openx-record/);
});

test('组件推广：downloadWithFallback 校验通过后触发组件记账钩子，校验失败或钩子抛错绝不影响下载', async () => {
  const { downloadWithFallback, onOpenxDownloadSuccess } = require('../core/app-update/downloader.js');
  const body = Buffer.from('component-pack-bytes-ok');
  const expectOk = { file: 'pet-pack-1.0.0.zip', bytes: body.length, sha256: sha(body) };
  const fetchImpl = async u => {
    u = String(u);
    if (u.startsWith(API + 'by_project_id')) {
      return jsonResp({ code: '0', data: { name: 'Demo-Hub-Project', records: [{ id: 88, version: 'pet-role-1.0.0', releaseTime: '2026-11-25 12:00:00' }] } });
    }
    if (u.startsWith(API + 'by_id')) {
      return jsonResp({ code: '0', data: { binaryPackages: [{ id: 881, originalFileName: expectOk.file, tag: '桌宠包 1.0.0', url: FILE_HOST + expectOk.file }] } });
    }
    if (u === FILE_HOST + expectOk.file) return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    return new Response('nope', { status: 404 });
  };
  const seen = [];
  const off1 = onOpenxDownloadSuccess(evt => { seen.push(evt); });
  const off2 = onOpenxDownloadSuccess(() => { throw new Error('listener boom'); });
  try {
    // 1. 哈希校验失败绝不触发钩子
    const bad = await downloadWithFallback({
      sources: [],
      version: '1.0.0',
      expect: { ...expectOk, sha256: '0'.repeat(64) },
      dest: path.join(tmp('oxcomp-bad-'), expectOk.file),
      fetchImpl,
      openx: { env: ENV, release: 'pet-role-1.0.0' },
    });
    assert.equal(bad.ok, false);
    assert.equal(seen.length, 0);

    // 2. 下载校验通过触发钩子，且另一监听抛错不影响返回 ok=true
    const ok = await downloadWithFallback({
      sources: [],
      version: '1.0.0',
      expect: expectOk,
      dest: path.join(tmp('oxcomp-ok-'), expectOk.file),
      fetchImpl,
      openx: { env: ENV, release: 'pet-role-1.0.0' },
    });
    assert.equal(ok.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].releaseVersion, 'pet-role-1.0.0');
    assert.equal(seen[0].packageTag, '桌宠包 1.0.0');
    assert.equal(seen[0].projectName, 'Demo-Hub-Project');

    // 3. skipRecordHook=true（Hub 自身更新已单独记账）不重复触发组件钩子
    const skipped = await downloadWithFallback({
      sources: [],
      version: '1.0.0',
      expect: expectOk,
      dest: path.join(tmp('oxcomp-skip-'), expectOk.file),
      fetchImpl,
      openx: { env: ENV, release: 'pet-role-1.0.0', skipRecordHook: true },
    });
    assert.equal(skipped.ok, true);
    assert.equal(seen.length, 1);
  } finally {
    off1();
    off2();
  }
});

test('组件去重与多条待补记队列：同版本号不同组件互不冲突，同组件多文件去重，退出中断后两条都补记', async () => {
  const dataDir = tmp('oxcomp-queue-');
  const seen = [];
  const rec = createOpenxDownloadRecorder({
    dataDir,
    env: ENV,
    logger: { info() {}, warn() {} },
    runSession: async target => {
      seen.push(target.releaseVersion);
      return { ok: true, method: 'dom-click', tookMs: 40, apiRequests: ['POST /openxApi/project/version/download'] };
    },
  });
  const pageUrl = `https://${SITE}/Demo-Hub-Project/download`;
  // 两个组件都是 1.0.0：各自计一次
  await rec.record({ kind: 'component', version: '1.0.0', releaseVersion: 'meeting-asr-1.0.0', file: 'asr-part1.bin', pageUrl });
  await rec.record({ kind: 'component', version: '1.0.0', releaseVersion: 'meeting-asr-1.0.0', file: 'asr-part2.bin', pageUrl });
  await rec.record({ kind: 'component', version: '1.0.0', releaseVersion: 'boot-splash-1.0.0', file: 'splash.zip', pageUrl });
  assert.deepEqual(seen, ['meeting-asr-1.0.0', 'boot-splash-1.0.0'], '同组件多文件去重、不同组件同版本号互不覆盖');
  assert.deepEqual(rec.diagnostics().stats.lastApiRequests, ['POST /openxApi/project/version/download']);
  rec.dispose();

  // 两条组件连下中途退出：两条都进 pendingQueue，重启后全部补记成功
  let releaseHang;
  const blocked = createOpenxDownloadRecorder({
    dataDir,
    env: ENV,
    logger: { info() {}, warn() {} },
    runSession: () => new Promise(r => { releaseHang = () => r({ ok: false, transient: true, reason: '已取消' }); }),
  });
  const p1 = blocked.record({ kind: 'component', version: '1.2.3', releaseVersion: 'cli-dsh-1.2.3', file: 'dsh.zip', pageUrl });
  const p2 = blocked.record({ kind: 'component', version: '22.0.0', releaseVersion: 'cli-node-22.0.0', file: 'node.zip', pageUrl });
  await new Promise(r => setTimeout(r, 30));
  blocked.dispose();
  releaseHang?.();
  await Promise.all([p1, p2]);

  const resumed = [];
  const next = createOpenxDownloadRecorder({
    dataDir,
    env: ENV,
    logger: { info() {}, warn() {} },
    resumeDelayMs: 15,
    runSession: async target => { resumed.push(target.releaseVersion); return { ok: true, tookMs: 30 }; },
  });
  assert.equal(next.diagnostics().pendingCount, 2);
  await next.resumePending({ delayMs: 15 });
  assert.deepEqual(resumed, ['cli-dsh-1.2.3', 'cli-node-22.0.0']);
  assert.equal(next.diagnostics().pendingCount, 0);
  next.dispose();
});

test('PPT 团队素材包（teamPackFromOpenx）校验通过后触发组件记账钩子', async () => {
  const { onOpenxDownloadSuccess } = require('../core/app-update/downloader.js');
  const { teamPackFromOpenx } = require('../core/company-assistant/ppt-materials.js');
  const buf = Buffer.from('ppt-materials-zip-bytes');
  const manifest = { version: '2.3.0', archive: { size: buf.length, hash: sha(buf) } };
  const file = 'pptutor-materials-2.3.0.zip';
  const fetchImpl = async u => {
    u = String(u);
    if (u.startsWith(API + 'by_project_id')) {
      return jsonResp({ code: '0', data: { name: 'Demo-Hub-Project', records: [{ id: 99, version: 'ppt-materials-2.3.0', releaseTime: '2026-11-25 12:00:00' }] } });
    }
    if (u.startsWith(API + 'by_id')) {
      return jsonResp({ code: '0', data: { binaryPackages: [{ id: 991, originalFileName: file, tag: '素材包 2.3.0', url: FILE_HOST + file }] } });
    }
    if (u === FILE_HOST + file) return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
    return new Response('nope', { status: 404 });
  };
  const seen = [];
  const off = onOpenxDownloadSuccess(evt => seen.push(evt));
  try {
    const out = await teamPackFromOpenx(fetchImpl, manifest, { env: ENV });
    assert.ok(Buffer.isBuffer(out));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].releaseVersion, 'ppt-materials-2.3.0');
    assert.equal(seen[0].file, file);
  } finally {
    off();
  }
});
