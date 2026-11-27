'use strict';
// r54：识别组件过旧时，开工前拦下、原地一键更新、更新后自动续跑；装配时才报过旧也走同一条路。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { PptImgtext } = require('../core/company-assistant/ppt-imgtext');
const { createOcrComponentInstaller, validManifest, swapIn } = require('../core/company-assistant/ppt-ocr-component');
const { createPptHandlers } = require('../core/company-assistant/ppt-ipc');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// 假 Doctor：状态里的 ocr.assistAvailable 由 component 决定；装配时组件太旧就照真 Doctor 报 OCR_COMPONENT_TOO_OLD。
function conversion({ assist = false, statusOcr = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-r54-')), image = path.join(dir, 'slide.png'); fs.writeFileSync(image, 'image fixture');
  const component = { assist }, calls = [], asks = [];
  const a = { dir, now: Date.now, changed() {}, ask: prompt => { asks.push(prompt); return { id: 'chat-' + asks.length }; }, chat: () => [] };
  const doctor = {
    cached: 'stale',
    async status() { calls.push({ op: 'status' }); return { ok: true, state: 'ready', ...(statusOcr ? { ocr: { installed: true, version: component.assist ? '1.2.0' : '1.0.0', assistAvailable: component.assist } } : {}) }; },
    async call(op, req) {
      calls.push({ op, req }); fs.mkdirSync(req.workdir, { recursive: true });
      if (op === 'imgtext-seed') { const seed = path.join(req.workdir, 'seed.json'); fs.writeFileSync(seed, '{"elements":[]}'); return { ok: true, seed, seedHash: 'seed-hash', preview: image }; }
      if (!component.assist) throw Object.assign(new Error('增强转字需要更新识别组件'), { code: 'OCR_COMPONENT_TOO_OLD', resultMayBePartial: false });
      return { ok: true, pptx: path.join(req.workdir, 'editable.pptx'), preview: image, mode: 'agent', pixel_gate: { passed: true }, reviewItems: [] };
    },
  };
  let installs = 0, outcome = 'done';
  const listeners = new Set();
  const ocr = {
    snapshot: () => ({ phase: 'idle' }),
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async install() {
      installs++;
      for (const fn of listeners) fn({ phase: 'downloading', message: '正在下载识别组件 v1.2.0 40%', percent: 40 });
      if (outcome === 'done') component.assist = true;
      return outcome === 'done' ? { phase: 'done', version: '1.2.0', message: '识别组件已更新到 v1.2.0' } : { phase: 'error', error: '所有下载源都不可用' };
    },
  };
  const ppt = { a, doctor, ocr, deps: {}, execute: async () => ({ ok: true }) };
  const service = new PptImgtext(ppt); ppt.imgtext = service;
  return { service, ppt, calls, asks, image, component, ocr: { get installs() { return installs; }, fail() { outcome = 'error'; }, ok() { outcome = 'done'; } }, a, dir };
}
const ops = calls => calls.filter(c => c.op !== 'status').map(c => c.op);
const settle = job => job.updating || Promise.resolve();

test('识别组件过旧：点转可编辑时不识别、不叫 CodeAgent，原地给一键更新（约 82 MB）', async () => {
  const { service, calls, asks, image } = conversion();
  const job = await service.start(image);
  assert.equal(job.state, 'needs_component'); assert.equal(job.code, 'OCR_COMPONENT_TOO_OLD'); assert.equal(job.resume, 'seed');
  assert.match(job.step, /增强转字要先更新识别组件（约 82 MB，一键完成）/);
  assert.deepEqual(job.component, { installed: true, version: '1.0.0' });
  assert.deepEqual(ops(calls), [], '没有调用 imgtext-seed / imgtext-build'); assert.equal(asks.length, 0, '没有叫 CodeAgent');
});

test('一键更新成功后自动从识别开始续跑，不用重新选图；重复点只装一次', async () => {
  const { service, calls, asks, image, ocr, ppt } = conversion();
  const job = await service.start(image);
  const first = service.updateComponent(job.id);
  assert.equal(first.state, 'updating'); assert.equal(service.updateComponent(job.id).state, 'updating');
  await settle(service.jobs.get(job.id));
  assert.equal(ocr.installs, 1);
  assert.equal(ppt.doctor.cached, null, '更新后不沿用旧的 Doctor 状态缓存');
  const after = service.snapshot(job.id);
  assert.equal(after.state, 'waiting_agent'); assert.deepEqual(ops(calls), ['imgtext-seed']); assert.equal(asks.length, 1);
  assert.equal(after.image, image); assert.equal(after.lastBuild, undefined, '内部续跑参数不外露');
});

test('老 Doctor 不报 ocr 字段、或读不到状态时照原流程转换', async () => {
  const { service, calls, image } = conversion({ statusOcr: false });
  assert.equal((await service.start(image)).state, 'waiting_agent'); assert.deepEqual(ops(calls), ['imgtext-seed']);
  const broken = conversion(); broken.ppt.doctor.status = async () => { throw new Error('Doctor 未响应'); };
  assert.equal((await broken.service.start(broken.image)).state, 'waiting_agent');
});

test('装配时才报 OCR_COMPONENT_TOO_OLD：转成同一个更新态，CodeAgent 不被引导重试；更新后用原初稿与差异续跑装配', async () => {
  const { service, calls, asks, image, component } = conversion({ assist: true });
  const job = await service.start(image); assert.equal(job.state, 'waiting_agent');
  component.assist = false;   // 模拟：开工时 Doctor 报够用，装配时识别组件却是旧的
  const diff = { fix: { 1: 'SRS 信道估计' } };
  await assert.rejects(service.build({ jobId: job.id, vision: 'seen', ops: diff }), /Hub 会用这次的差异自动续跑装配，不需要重试/);
  const waiting = service.snapshot(job.id);
  assert.equal(waiting.state, 'needs_component'); assert.equal(waiting.resume, 'build'); assert.match(waiting.step, /一键更新后自动接着装配/); assert.equal(waiting.component, null, '不显示过时的版本号');
  assert.ok(waiting.seed, '保留已有初稿');
  // CodeAgent 再调 build 也只得到同一句说明，不会再走 Doctor。
  const before = ops(calls).length;
  await assert.rejects(service.build({ jobId: job.id, vision: 'seen', ops: diff }), /不需要重试/); assert.equal(ops(calls).length, before);
  await assert.rejects(service.retry(job.id), /本轮转字结束/, '页面的「让 CodeAgent 重试」在这个状态下不可用');
  service.updateComponent(job.id); await settle(service.jobs.get(job.id));
  const done = service.snapshot(job.id);
  assert.equal(done.state, 'done'); assert.equal(asks.length, 1, '续跑不重新叫 CodeAgent');
  const builds = calls.filter(c => c.op === 'imgtext-build');
  assert.deepEqual(builds.at(-1).req.ops, diff, '续跑用 CodeAgent 已提交的差异'); assert.equal(builds.at(-1).req.seedHash, 'seed-hash');
  assert.equal(ops(calls).filter(op => op === 'imgtext-seed').length, 1, '没有重新识别');
});

test('更新失败回到更新态并写明原因，可再点；更新后 Doctor 仍报旧（完整包自带旧组件）时引导升级 Doctor', async () => {
  const fail = conversion(); fail.ocr.fail();
  const job = await fail.service.start(fail.image);
  fail.service.updateComponent(job.id); await settle(fail.service.jobs.get(job.id));
  let s = fail.service.snapshot(job.id);
  assert.equal(s.state, 'needs_component'); assert.match(s.error, /没更新成功：所有下载源都不可用/);
  fail.ocr.ok(); fail.service.updateComponent(job.id); await settle(fail.service.jobs.get(job.id));
  assert.equal(fail.service.snapshot(job.id).state, 'waiting_agent');

  const bundled = conversion(); bundled.ppt.ocr.install = async () => ({ phase: 'done', version: '1.2.0' });   // 装好了，但 Doctor 仍报旧
  const j2 = await bundled.service.start(bundled.image);
  bundled.service.updateComponent(j2.id); await settle(bundled.service.jobs.get(j2.id));
  s = bundled.service.snapshot(j2.id);
  assert.equal(s.state, 'error'); assert.equal(s.needsDoctorUpgrade, true); assert.match(s.error, /一键升级 PPT Doctor/);
  assert.throws(() => bundled.service.updateComponent(j2.id), /不需要更新识别组件/);
});

test('IPC：页面的一键更新走 ppt-imgtext-update-component', async () => {
  const { service, ppt, image } = conversion();
  const handlers = createPptHandlers({ ppt });
  const job = await handlers['ppt-imgtext-start']({ imagePath: image });
  assert.equal(job.state, 'needs_component');
  assert.equal(handlers['ppt-imgtext-update-component']({ jobId: job.id }).state, 'updating');
  await settle(service.jobs.get(job.id));
});

// ---- 安装器：真实下载器 + 假下载源；解压用复制代替（PowerShell 解压另由 E2E 覆盖）。
function fakeRelease(files, { assistApiVersion = 1, version = '1.2.0' } = {}) {
  const archive = Buffer.from(JSON.stringify(files));   // 假“压缩包”：extract 按 JSON 还原文件
  const manifest = { version, assistApiVersion, archive: { name: 'component.zip', hash: sha(archive), size: archive.length },
    files: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, { hash: sha(Buffer.from(text)), size: text.length }])) };
  return { archive, manifest };
}
function fakeFetch(routes, seen = []) {
  return async url => {
    seen.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)) } });
  };
}
const fakeExtract = async (zip, dest) => { for (const [rel, text] of Object.entries(JSON.parse(fs.readFileSync(zip, 'utf8')))) { const f = path.join(dest, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
function installerFixture(release, { extraRoutes = {}, extract = fakeExtract } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-data-'));
  const old = path.join(data, 'ocr'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'component.json'), '{"version": "1.0.0"}'); fs.writeFileSync(path.join(old, 'pptdoctor-ocr.exe'), 'old');
  const A = 'https://a.example/ocr/', B = 'https://b.example/ocr/', seen = [];
  const routes = { [A + 'component.json']: JSON.stringify(release.manifest), [B + 'component.json']: JSON.stringify(release.manifest), [B + 'component.zip']: release.archive, ...extraRoutes };
  const states = [];
  const installer = createOcrComponentInstaller({ env: { PPTX_FINDER_DATA_DIR: data }, urls: [A, B], fetchImpl: fakeFetch(routes, seen), openx: false, extract, onState: s => states.push(s) });
  return { data, old, installer, seen, states, A, B };
}

test('安装器：清单 → 下载（坏源自动换下一个）→ 逐文件校验 → 换入，写出 Doctor 认的 component.json', async () => {
  const release = fakeRelease({ 'pptdoctor-ocr.exe': 'new exe', '_internal/model.onnx': 'model' });
  const { data, installer, seen, states, A, B } = installerFixture(release);
  const result = await installer.install();
  assert.equal(result.phase, 'done', result.error); assert.match(result.message, /v1\.2\.0/);
  const marker = JSON.parse(fs.readFileSync(path.join(data, 'ocr', 'component.json'), 'utf8'));
  assert.deepEqual(marker, { version: '1.2.0', assistApiVersion: 1, archive_hash: release.manifest.archive.hash });
  assert.equal(fs.readFileSync(path.join(data, 'ocr', 'pptdoctor-ocr.exe'), 'utf8'), 'new exe');
  assert.ok(seen.includes(A + 'component.zip') && seen.includes(B + 'component.zip'), 'A 源包 404 后换 B 源');
  assert.ok(states.some(s => s.phase === 'downloading') && states.some(s => s.phase === 'extracting'));
  assert.deepEqual(fs.readdirSync(data).sort(), ['ocr'], '临时目录和旧组件都已清理');
});

test('安装器：内容不对、多出文件、源上组件仍旧时整批拒绝，旧组件原样保留', async () => {
  const good = { 'pptdoctor-ocr.exe': 'new exe' };
  const cases = [
    ['文件校验失败', fakeExtract.bind(null), r => { r.manifest.files['pptdoctor-ocr.exe'].hash = sha(Buffer.from('other')); }],
    ['清单之外的文件', async (zip, dest) => { await fakeExtract(zip, dest); fs.writeFileSync(path.join(dest, 'evil.dll'), 'x'); }, () => {}],
  ];
  for (const [reason, extract, mutate] of cases) {
    const release = fakeRelease(good); mutate(release);
    const { old, installer } = installerFixture(release, { extract });
    const result = await installer.install();
    assert.equal(result.phase, 'error'); assert.match(result.error, new RegExp(reason));
    assert.equal(fs.readFileSync(path.join(old, 'pptdoctor-ocr.exe'), 'utf8'), 'old', reason + '：旧组件保留');
  }
  const stale = installerFixture(fakeRelease(good, { assistApiVersion: 0 }));
  const r = await stale.installer.install();
  assert.equal(r.phase, 'error'); assert.match(r.error, /还不支持增强转字/);
  assert.throws(() => validManifest({ version: '1.2.0', assistApiVersion: 1, archive: { name: '../x.zip', hash: 'a'.repeat(64), size: 1 }, files: { a: { hash: 'b'.repeat(64) } } }), /完整包校验值/);
  assert.throws(() => validManifest({ version: '1.2.0', assistApiVersion: 1, archive: { name: 'c.zip', hash: 'a'.repeat(64), size: 1 }, files: { '../a': { hash: 'b'.repeat(64) } } }), /非法路径/);
});

test('换入：旧组件被占用时等它空闲；一直占用就报人话且旧组件不动', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-swap-')), target = path.join(root, 'ocr'), staged = path.join(root, 'staged');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'v'), 'old'); fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'v'), 'new');
  const rename = fs.renameSync; let busy = 2, waits = 0;
  fs.renameSync = (from, to) => { if (from === target && busy-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return rename(from, to); };
  try {
    await swapIn(staged, target, { waitMs: 2000, stepMs: 10, onWait: () => waits++ });
    assert.equal(fs.readFileSync(path.join(target, 'v'), 'utf8'), 'new'); assert.equal(waits, 2);
    fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'v'), 'newer'); busy = Infinity;
    await assert.rejects(swapIn(staged, target, { waitMs: 50, stepMs: 10 }), /正被 PPT Doctor 占用/);
    assert.equal(fs.readFileSync(path.join(target, 'v'), 'utf8'), 'new');
  } finally { fs.renameSync = rename; }
});

// 负责人 11-19：识别组件一键更新必须内源优先（openx → 原下载源），首个请求就打到内源。
test('安装器只走内源：清单用程序自带快照，包从内源 ocr-<版本> 的 pptdoctor-ocr-<版本>.zip 取，不碰外网；内源没有时说原因、不回外网（R35）', async () => {
  const openxSource = require('../core/app-update/openx-source');
  const release = fakeRelease({ 'pptdoctor-ocr.exe': 'new exe' });
  // 内源附件地址按内源配置的站点拼（附件在它的子域名下），测试里不写死内网域名。
  const FILE = new URL('/openx-file/file/2026/11/19/ocr.zip', require('../core/app-update/openx-config').fileSite.replace('://', '://file.')).href;
  const run = async packages => {
    openxSource._reset({ indexId: 0 });   // 测列表路径：显式关掉版本索引（R55）
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-openx-')), A = 'https://a.example/ocr/', calls = [];
    const fetchImpl = async url => {
      calls.push(url);
      const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('by_project_id')) return json({ code: '0', data: { records: [{ id: 41, version: 'ocr-1.2.0', releaseTime: '2026-11-19 10:00:00' }] } });
      if (url.includes('by_id?id=41')) return json({ code: '0', data: { binaryPackages: packages } });
      const body = url === FILE ? release.archive : url === A + 'component.json' ? JSON.stringify(release.manifest) : url === A + 'component.zip' ? release.archive : undefined;
      if (body === undefined) return new Response('nf', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } });
    };
    const snapshotFile = path.join(data, 'snapshot.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(release.manifest));
    const installer = createOcrComponentInstaller({ env: { PPTX_FINDER_DATA_DIR: data, AI_HUB_OPENX: '1' }, urls: [A], snapshotFile, fetchImpl, extract: fakeExtract });
    const r = await installer.install();
    return { r, calls, A, data };
  };
  const hit = await run([{ originalFileName: 'pptdoctor-ocr-1.2.0.zip', url: FILE }]);
  assert.equal(hit.r.phase, 'done', hit.r.error); assert.equal(hit.r.source, '公司内源');
  assert.ok(hit.calls[0].startsWith(openxSource.DEFAULT_API) && hit.calls[0].includes('by_project_id'), '第一个请求打到内源');
  assert.ok(hit.calls.includes(FILE)); assert.ok(!hit.calls.includes(hit.A + 'component.zip'), '内源命中时不下载外网包');
  assert.equal(JSON.parse(fs.readFileSync(path.join(hit.data, 'ocr', 'component.json'), 'utf8')).assistApiVersion, 1);
  assert.ok(!hit.calls.includes(hit.A + 'component.json'), '清单用自带快照，不去外网读');
  const miss = await run([]);
  assert.notEqual(miss.r.phase, 'done'); assert.match(String(miss.r.error), /内源/);
  assert.ok(!miss.calls.some(u => u.startsWith(miss.A)), '内源没有时不回外网');
  openxSource._reset({ indexId: 0 });
});

test('页面点「先用 OCR 初稿装配」时才发现组件过旧：返回更新态快照而不是报错，更新后续跑这次空差异装配', async () => {
  const { service, image, component, a, calls } = conversion({ assist: true });
  a.ask = () => { throw new Error('未找到 CodeAgent CLI'); };
  const job = await service.start(image); assert.equal(job.state, 'error'); assert.ok(job.seed);
  component.assist = false;
  const r = await service.retry(job.id, true);
  assert.equal(r.state, 'needs_component'); assert.equal(r.resume, 'build');
  service.updateComponent(job.id); await settle(service.jobs.get(job.id));
  const done = service.snapshot(job.id);
  assert.equal(done.state, 'done'); assert.equal(done.vision, 'unavailable');
  assert.deepEqual(calls.filter(c => c.op === 'imgtext-build').at(-1).req.ops, {});
});
