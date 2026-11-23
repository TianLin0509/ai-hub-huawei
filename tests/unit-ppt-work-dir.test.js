'use strict';
// 真实临时目录覆盖优先级、切根、旧任务路径和 Doctor 队列，不操作生产数据。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const W = require('../core/company-assistant/ppt-work-dir');
const roots = require('../core/storage-roots'), files = require('../core/work-file-root');
const { PptLibrary } = require('../core/company-assistant/ppt-library');
const { PptDoctor } = require('../core/company-assistant/ppt-doctor');
const { CompanyAssistant } = require('../core/company-assistant/service');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-work-dir-'));
  const before = process.env.AI_HUB_WORKSPACE_ROOT;
  delete process.env.AI_HUB_WORKSPACE_ROOT; files.configure(''); roots.setConfiguredWorkspaceRoot('');
  t.after(() => {
    if (before === undefined) delete process.env.AI_HUB_WORKSPACE_ROOT; else process.env.AI_HUB_WORKSPACE_ROOT = before;
    files.configure(''); roots.setConfiguredWorkspaceRoot(''); fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'data'); fs.mkdirSync(dir);
  let settings = { ppt: {} };
  const a = { dir, now: Date.now, changed() {}, settings: () => settings, deps: { pptHubRoots: () => W.liveHubRoots() },
    ask: () => ({ id: 'chat' }), chat: () => [] };
  return { root, a, set: value => { settings = { ppt: value }; } };
}

test('解析优先级：PPT 单独设置 > 工作文件根 > 环境变量 > 默认会话工作根 > 原位置', t => {
  const f = fixture(t), chosen = path.join(f.root, 'chosen'), session = path.join(f.root, 'session');
  assert.deepEqual(W.resolveWorkDir(f.a), { path: f.a.dir, from: 'legacy' });
  roots.setConfiguredWorkspaceRoot(session);
  assert.equal(W.workDir(f.a), path.join(session, 'ppt'));
  process.env.AI_HUB_WORKSPACE_ROOT = path.join(f.root, 'env');
  assert.equal(W.workDir(f.a), path.join(f.root, 'env', 'ppt'));
  files.configure(chosen);
  assert.equal(W.workDir(f.a), path.join(chosen, 'ppt'));
  f.set({ workDir: path.join(f.root, 'separate') });
  assert.equal(W.resolveWorkDir(f.a).from, 'ppt');
  assert.equal(W.workDir(f.a), path.join(f.root, 'separate'));
  f.set({ workDir: '' });
  assert.equal(W.workDir(f.a), path.join(chosen, 'ppt'));
  assert.equal(W.resolveWorkDir(f.a, { env: {}, workFileRoot: '', workspaceRoot: null }).path, f.a.dir);
});

test('只解析不建目录；写入探针失败报可操作提示，不回退 C 盘；拒绝相对路径和程序目录', t => {
  const f = fixture(t), chosen = path.join(f.root, 'chosen'); f.set({ workDir: chosen });
  assert.equal(W.workDir(f.a), chosen); assert.equal(fs.existsSync(chosen), false);
  assert.throws(() => W.ensureWritable(chosen, { writeFileSync() { throw Object.assign(new Error('拒绝写入'), { code: 'EACCES' }); }, unlinkSync() {} }),
    error => error.code === 'PPT_WORK_DIR_UNWRITABLE' && error.message.includes(chosen) && error.message.includes('素材库设置'));
  assert.throws(() => W.validateWorkDir('relative', f.a), /完整路径/);
  assert.throws(() => W.validateWorkDir(path.resolve(__dirname, '..'), f.a), /程序或数据目录/);
  const file = path.join(f.root, 'file'); fs.writeFileSync(file, '保留');
  assert.throws(() => W.ensureWritable(file), /PPT 工作目录不可写/);
  assert.equal(fs.readFileSync(file, 'utf8'), '保留');
  assert.deepEqual(fs.readdirSync(chosen), []);
});

test('做页：切根后旧任务修改仍在原处，新任务、模板和运行缓存进新目录', t => {
  const f = fixture(t), lib = new PptLibrary(f.a, { pptPreviewShrink: null });
  const sk = lib.make.listSkeletons()[0];
  const old = lib.make.example(sk.id).job;
  const oldBytes = fs.readFileSync(old.path);
  const chosen = path.join(f.root, 'chosen'); f.set({ workDir: chosen });
  const fresh = lib.make.example(sk.id).job;
  assert.ok(fresh.path.startsWith(path.join(chosen, 'ppt-make')));
  assert.ok(lib.make.templatePack().job.path.startsWith(chosen));
  lib.make.apply(lib.make.job(old.id), sk.spec);
  assert.ok(lib.make.job(old.id).path.startsWith(f.a.dir));
  assert.deepEqual(fs.readFileSync(old.path), oldBytes);
  assert.ok(lib.runtime().startsWith(path.join(chosen, 'ppt-runtime')));
  assert.ok(W.previousWorkDirs(f.a).includes(chosen));
  assert.ok(fs.existsSync(old.path));
});

test('索引：新索引写新目录，原索引仍可查；进行中的更新不随设置转移', async t => {
  const f = fixture(t), lib = new PptLibrary(f.a);
  fs.mkdirSync(path.dirname(lib.ownedDb()), { recursive: true }); fs.writeFileSync(lib.ownedDb(), '旧索引');
  const chosen = path.join(f.root, 'chosen'); f.set({ workDir: chosen, roots: [f.root] });
  let release, request;
  lib.runPython = args => { request = args; return new Promise(resolve => { release = resolve; }); };
  lib.refresh = async () => lib.status();
  lib.startIndex();
  assert.equal(request.db, path.join(chosen, 'ppt-index', 'index.db'));
  f.set({ workDir: path.join(f.root, 'next'), roots: [f.root] });
  release({ complete: true }); await lib.indexJob;
  assert.ok(fs.existsSync(path.join(chosen, 'ppt-index-state.json')));
  assert.ok(lib.sources().some(s => s.db === path.join(f.a.dir, 'ppt-index', 'index.db')));
  assert.equal(fs.readFileSync(path.join(f.a.dir, 'ppt-index', 'index.db'), 'utf8'), '旧索引');
});

test('图转字：开始时固定输出目录，改设置后的装配沿用原任务目录', async t => {
  const f = fixture(t), seen = [], image = path.join(f.root, 'image.png'); fs.writeFileSync(image, 'synthetic');
  const doctor = { status: async () => ({}), async call(op, args) { seen.push({ op, args }); return op === 'imgtext-seed' ? { seedHash: 'h', seed: image } : { pptx: path.join(args.workdir, 'slide.pptx') }; } };
  const lib = new PptLibrary(f.a, { pptDoctor: doctor });
  lib.imgtext.ask = async id => lib.imgtext.snapshot(id);
  f.set({ workDir: path.join(f.root, 'one') });
  const job = await lib.imgtext.start(image);
  f.set({ workDir: path.join(f.root, 'two') });
  await lib.imgtext.build({ jobId: job.id, ops: {}, vision: 'unavailable' });
  assert.equal(seen[0].args.workdir, seen[1].args.workdir);
  assert.ok(seen[0].args.workdir.startsWith(path.join(f.root, 'one')));
});

test('Doctor 单次请求与常驻队列使用工作目录，程序路径不变，切根后不复用旧队列', async t => {
  const f = fixture(t), seen = [];
  f.set({ doctorExe: process.execPath, workDir: path.join(f.root, 'one') });
  const doctor = new PptDoctor(f.a, { pptDoctorTrustedExecutable: true,
    pptEnv: { ...process.env, PPT_DOCTOR_FIXTURE_TRACE: path.join(f.root, 'trace.jsonl') },
    pptDoctorArgs: [path.join(__dirname, 'fixtures/ppt-doctor-server-fake.js')],
    pptDoctorSpawn(exe, args, options) { seen.push({ exe, args, options }); return require('node:child_process').spawn(exe, args, options); } });
  t.after(() => doctor.close());
  await doctor.call('status', { echo: 'one' });
  assert.equal(seen[0].exe, process.execPath);
  assert.ok(seen[0].args[seen[0].args.indexOf('--in') + 1].startsWith(path.join(f.root, 'one')));
  assert.equal(seen[0].options.env.TEMP, path.join(f.root, 'one', 'ppt-temp'));
  assert.equal(seen[0].options.windowsHide, true);
  const marker = { exeSha256: 'a'.repeat(64) }, old = doctor.server.session(process.execPath, marker);
  f.set({ doctorExe: process.execPath, workDir: path.join(f.root, 'two') });
  const fresh = doctor.server.session(process.execPath, marker);
  assert.notEqual(fresh.spool, old.spool);
  assert.ok(old.spool.startsWith(path.join(f.root, 'one')));
  assert.ok(fresh.spool.startsWith(path.join(f.root, 'two')));
});

test('设置校验失败不保存；PPT 目录失败不阻断普通助理工作区', t => {
  const f = fixture(t), a = new CompanyAssistant({ dataDir: f.a.dir, noTools: true, noTimer: true, noPrewarm: true });
  const file = path.join(f.root, 'blocked'); fs.writeFileSync(file, '保留');
  assert.throws(() => a.setSettings({ ppt: { workDir: file } }), /不可写/);
  assert.equal(a.settings().ppt?.workDir, undefined);
  a.setSettings({ ppt: { workDir: path.join(f.root, 'chosen') } });
  assert.ok(a.pptWorkspace.startsWith(path.join(f.root, 'chosen')));
  fs.writeFileSync(a.file('settings.json'), JSON.stringify({ ppt: { workDir: file } }));
  assert.doesNotThrow(() => a.prepareWorkspace());
  assert.match(a.pptWorkDirError, /不可写/);
});

test('隔离：未注入 Hub 工作根时不读本机环境变量和 Hub 设置；显式数据目录优先于 Hub 工作根', t => {
  const f = fixture(t);
  process.env.AI_HUB_WORKSPACE_ROOT = path.join(f.root, 'real-env'); files.configure(path.join(f.root, 'real-files'));
  const bare = { dir: f.a.dir, settings: () => ({ ppt: {} }) };
  assert.deepEqual(W.resolveWorkDir(bare), { path: f.a.dir, from: 'legacy' });
  const a = new CompanyAssistant({ dataDir: path.join(f.root, 'hub'), noTools: true, noTimer: true, noPrewarm: true });
  assert.equal(a.pptWorkspace, path.join(a.dir, 'ppt-workspace'));
  const moved = { dir: path.join(f.root, 'moved'), defaultDir: f.a.dir, settings: () => ({ ppt: {} }), deps: { pptHubRoots: () => W.liveHubRoots() } };
  assert.deepEqual(W.resolveWorkDir(moved), { path: moved.dir, from: 'data-root' });
  assert.equal(W.resolveWorkDir({ ...moved, dir: f.a.dir }).path, path.join(f.root, 'real-files', 'ppt'));
});
