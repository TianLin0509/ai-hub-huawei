'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const roots = require('../core/work-file-root');
const { WorkspaceService } = require('../core/workspace-service');
const { buildConfigJsonUpdate, workFileRootForm } = require('../main/ipc/config-handlers');
test.afterEach(() => roots.configure());
test('managed reports stay readable by phone HTML, images and podcast across root changes', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-trusted-work-files-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Podcast uses the real process environment; isolate it from developer overrides.
  for (const key of ['AI_HUB_WORKSPACE_ROOT', 'AI_HUB_LEGACY_WORKSPACE_ROOTS', 'AI_HUB_ARTIFACTS_ROOT']) {
    const saved = process.env[key];
    delete process.env[key];
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  const home = path.join(tmp, 'home'), dataDir = path.join(tmp, 'data');
  t.mock.method(os, 'homedir', () => home);
  const storage = require('../core/storage-roots');
  const { answerHtmlFiles } = require('../core/hub-phone/html-snapshot');
  const { answerImages } = require('../core/hub-phone/images');
  const { AssistantService } = require('../core/hub-assistant/service');
  const podcast = file => AssistantService.prototype.podcastSource.call({ deps: { dataDir } }, file);
  const trusted = () => storage.trustedFileRoots({ dataDir, env: {}, home });
  const probe = (dir, allowed) => {
    fs.mkdirSync(dir, { recursive: true });
    const html = path.join(dir, 'report.html'), png = path.join(dir, 'figure.png');
    fs.writeFileSync(html, '<p>Same report</p>');
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    assert.equal(answerHtmlFiles(`[report](${html})`, { roots: trusted() }).length, allowed ? 1 : 0, html);
    assert.equal(answerImages(`![figure](${png})`, { roots: trusted() }).length, allowed ? 1 : 0, png);
    if (allowed) assert.equal(podcast(html), html);
    else assert.throws(() => podcast(html));
  };
  const original = [
    path.join(dataDir, 'company-assistant', 'workspace'),
    path.join(dataDir, 'company-assistant', 'ppt-workspace'),
    path.join(dataDir, 'company-assistant', 'meeting-room'),
    path.join(dataDir, 'company-forum', 'workspace'),
    path.join(dataDir, 'help-ask', 'cwd'),
    path.join(dataDir, 'workspaces'),
    path.join(home, 'AI-Artifacts'),
  ];
  roots.configure();
  const defaults = trusted();
  for (const dir of original) probe(dir, true);
  probe(path.join(tmp, 'unmanaged'), false);
  const first = path.join(tmp, 'first'), second = path.join(tmp, 'second');
  const names = ['workspaces', 'group-workspaces', 'assistant-workspace', 'ppt-workspace',
    'meeting-room', 'forum-workspace', 'analysis-workspaces', 'help-workspace',
    'phone-inbox', 'photo-assistant', 'artifacts'];
  const check = managedRoots => {
    for (const dir of original) probe(dir, true);
    for (const root of managedRoots) {
      assert.ok(!trusted().includes(root));
      for (const name of names) probe(path.join(root, name, 'nested'), true);
      // Parent files, unknown children, prefix lookalikes and traversal stay outside the allowlist.
      for (const dir of [root, path.join(root, 'private'), path.join(root, 'assistant-workspace-extra'),
        path.join(root, 'assistant-workspace', '..', 'unmanaged')]) probe(dir, false);
    }
    assert.equal(new Set(trusted().map(storage.pathKey)).size, trusted().length);
  };
  roots.configure(first);
  check([first]);
  roots.configure(second, [first]);
  check([first, second]);
  roots.configure('', [first, second]);
  check([first, second]);
  roots.configure();
  assert.deepEqual(trusted(), defaults, 'unconfigured defaults do not acquire managed root permissions');
  for (const root of [first, second]) for (const name of names) probe(path.join(root, name), false);
});

test('升级未配置：所有自动目录逐字沿用旧路径', () => {
  roots.configureAtStartup('', [], { fsModule: { statSync() { assert.fail('未配置时不检查磁盘'); } } });
  for (const name of ['workspaces', 'assistant-workspace', 'ppt-workspace', 'meeting-room', 'forum-workspace', 'phone-inbox', 'photo-assistant', 'artifacts']) {
    const old = path.join(os.tmpdir(), 'old', name);
    assert.equal(roots.directory(name, old), old);
  }
  const s = new WorkspaceService({ os: { homedir: () => 'D:/test-home' }, isIsolatedHub: () => false });
  const before = s.getWorkspaceRoot(); roots.configure('', []);
  assert.equal(s.getWorkspaceRoot(), before);
});
test('启动时盘不在：回退默认、保留设置并把原因传到设置页，不重建根目录', () => {
  const chosen = path.resolve(os.tmpdir(), 'offline-drive', 'work-files');
  const previous = path.resolve(os.tmpdir(), 'previous-work-files');
  roots.configure(chosen);
  roots.configureAtStartup(chosen, [previous], { fsModule: {
    statSync() { throw Object.assign(new Error('drive missing'), { code: 'ENOENT' }); },
    mkdirSync() { assert.fail('启动不重建缺失目录'); },
    writeFileSync() { assert.fail('盘不在时不写文件'); },
  } });
  assert.equal(roots.current(), '');
  assert.equal(roots.directory('assistant-workspace', 'original-assistant'), 'original-assistant');
  assert.equal(roots.directory('forum-workspace', 'original-forum'), 'original-forum');
  assert.deepEqual(roots.previousDirectories('assistant-workspace', null), [path.join(previous, 'assistant-workspace')]);
  const form = workFileRootForm({ workFileRoot: chosen });
  assert.equal(form.workFileRoot, chosen, '保留用户设置，接回磁盘后仍可恢复');
  assert.equal(form.workFileRootActive, '');
  assert.match(form.workFileRootInvalid, /ENOENT/);
  assert.equal(form.workFileRootInvalid, roots.configuredRootError());
});
test('启动时只读根回退，恢复可写后重新启用并清除原因，探针不残留', t => {
  const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-startup-root-'));
  t.after(() => fs.rmSync(chosen, { recursive: true, force: true }));
  roots.configureAtStartup(chosen, [], { fsModule: { ...fs,
    writeFileSync() { throw Object.assign(new Error('read only'), { code: 'EACCES' }); },
    mkdirSync() { assert.fail('启动不创建目录'); },
  } });
  assert.equal(roots.current(), '');
  assert.match(roots.configuredRootError(), /EACCES/);
  const i18n = require('../core/i18n');
  const language = i18n.getLanguage();
  t.after(() => i18n.setLanguage(language));
  i18n.setLanguage('en');
  assert.doesNotMatch(i18n.translate(`工作文件根目录不可用，已恢复原默认位置：${roots.configuredRootError()}`), /[\u3400-\u9fff]/);
  roots.configureAtStartup(chosen);
  assert.equal(roots.current(), chosen);
  assert.equal(roots.configuredRootError(), '');
  assert.deepEqual(fs.readdirSync(chosen), []);
});
test('群聊成员目录：非隔离 Hub 保持主目录，根目录仅重定向隔离工作区', async t => {
  t.mock.method(require('../core/codeagent-capabilities'), 'prepareForKind', async () => {});
  const { createMeetingSubAdder } = require('../main/ipc/meeting-create-handlers');
  const chosen = path.resolve(os.tmpdir(), 'hub-group-root');
  const explicit = path.resolve(os.tmpdir(), 'explicit-project');
  for (const { root, isolated, cwd } of [
    { root: '', isolated: false }, { root: chosen, isolated: false },
    { root: '', isolated: true }, { root: chosen, isolated: true },
    { root: chosen, isolated: false, cwd: explicit }, { root: chosen, isolated: true, cwd: explicit },
  ]) {
    roots.configure(root);
    const meeting = { id: 'test-group', groupChat: true, subSessions: [] };
    const dedicated = require('../core/data-dir').getMeetingWorkspaceDir(meeting.id);
    const created = [];
    let dedicatedCalls = 0;
    const add = createMeetingSubAdder({
      fs: { mkdirSync: dir => created.push(dir) }, path, slotIds: [], scenes: {},
      getHookPort: () => 0, isCodexBaseKind: () => false, isIsolatedHub: () => isolated,
      getMeetingWorkspaceDir: () => { dedicatedCalls++; return dedicated; },
      meetingManager: { getMeeting: () => meeting,
        addSubSession: (_id, id) => { meeting.subSessions.push(id); return meeting; } },
      sessionManager: { createSession: (kind, opts) => ({ id: 'member', kind, ...opts }) },
      registerSessionForTap() {}, sendToRenderer() {},
    });
    const { session } = await add(meeting.id, 'codeagent', cwd ? { cwd } : {});
    assert.equal(session.cwd, cwd || (isolated ? dedicated : process.env.USERPROFILE || process.env.HOME || '.'));
    assert.equal(dedicatedCalls, isolated && !cwd ? 1 : 0);
    assert.deepEqual(created, cwd ? [] : [session.cwd]);
    if (root && isolated && !cwd) assert.equal(session.cwd, path.join(chosen, 'group-workspaces', meeting.id));
  }
});
test('设置后自动会话与各功能目录都落到新根，旧文件没有移动', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const old = path.join(tmp, 'old'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'keep.txt'), 'keep');
  const chosen = path.join(tmp, 'new'); roots.configure(chosen, [path.join(tmp, 'previous')]);
  for (const name of ['assistant-workspace', 'ppt-workspace', 'meeting-room', 'forum-workspace', 'phone-inbox', 'photo-assistant', 'artifacts']) {
    assert.equal(roots.directory(name, old), path.join(chosen, name));
    assert.deepEqual(roots.previousDirectories(name, old), [old, path.join(tmp, 'previous', name)]);
  }
  delete process.env.AI_HUB_WORKSPACE_ROOT;
  assert.equal(new WorkspaceService().getWorkspaceRoot(), path.join(chosen, 'workspaces'));
  assert.equal(fs.readFileSync(path.join(old, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(chosen), false, '解析路径不会建空目录或复制文件');
  roots.configure(path.join(tmp, 'next'), [chosen]);
  const s = new WorkspaceService();
  assert.equal(s.workspaceRootFor(path.join(chosen, 'workspaces', 'project')), path.join(chosen, 'workspaces'), '切换后的旧自动根无需手工标记，仍识别原路径');
});
test('保存根目录保留其他设置与旧根历史，未提交时不动', () => {
  const original = { workspace: { default_root: 'D:/sessions' }, work_files: { root: 'D:/old', history: [] } };
  const next = buildConfigJsonUpdate(original, { workFileRoot: 'D:/new' });
  assert.deepEqual(next.work_files, { root: 'D:/new', history: ['D:/old'] });
  assert.deepEqual(next.workspace, original.workspace);
  assert.deepEqual(buildConfigJsonUpdate(original, { cardFontSize: 15 }).work_files, original.work_files);
});
test('切根后手机仍能读旧分享，只信任指定的子目录', () => {
  const old = path.join(os.tmpdir(), 'previous-work-files'), now = path.join(os.tmpdir(), 'current-work-files');
  roots.configure(now, [old]);
  const trusted = require('../core/storage-roots').trustedFileRoots({ env: {}, dataDir: path.join(os.tmpdir(), 'hub-data') });
  for (const dir of ['phone-inbox', 'photo-assistant', 'artifacts']) assert.ok(trusted.includes(path.join(old, dir)));
  assert.ok(!trusted.includes(old)); assert.ok(!trusted.includes(now), '工作文件根本身不加入手机可读范围');
});
test('目标目录验证：真实写入探针、空间检查、相对路径和文件被拒', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-root-check-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const chosen = path.join(tmp, 'chosen'); assert.equal(roots.validate(chosen).ok, true);
  assert.deepEqual(fs.readdirSync(chosen), []);
  assert.equal(roots.validate('relative').ok, false);
  fs.writeFileSync(path.join(tmp, 'file'), 'x'); assert.equal(roots.validate(path.join(tmp, 'file')).ok, false);
  assert.equal(roots.validate(chosen, { fsModule: { ...fs, statfsSync: () => ({ bavail: 1n, bsize: 4096n }) } }).ok, false);
  assert.equal(roots.validate(chosen, { fsModule: { ...fs, writeFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }).ok, false);
  assert.equal(roots.validate('').value, '');
});
test('实际助理、PPT、会议室、论坛、群聊与产物入口接线；旧会议可原地读取', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-path-integration-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data'), old = path.join(dataDir, 'company-assistant'), chosen = path.join(tmp, 'chosen');
  const { randomUUID } = require('node:crypto'), id = randomUUID();
  const oldMeeting = path.join(old, 'workspace', 'meetings', id);
  fs.mkdirSync(oldMeeting, { recursive: true }); fs.writeFileSync(path.join(oldMeeting, 'meeting.json'), JSON.stringify({ id, title: '旧会议', state: 'ended', events: [], answers: [] }));
  const make = () => new (require('../core/company-assistant/service').CompanyAssistant)({ dataDir, noTools: true, noTimer: true, bus: { latest: () => [] }, welinkRun: async () => ({ code: 0, stdout: '{}' }), getSession: () => null, powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} }, pptHubRoots: () => require('../core/company-assistant/ppt-work-dir').liveHubRoots() });
  const a = make();
  assert.equal(a.workspace, path.join(old, 'workspace')); assert.equal(a.pptWorkspace, path.join(old, 'ppt-workspace'));
  assert.equal(a.rooms.home(), path.join(old, 'meeting-room'));
  roots.configure(chosen);
  const b = make();
  assert.equal(b.dir, old, '配置和状态不改位置');
  assert.equal(b.workspace, path.join(chosen, 'assistant-workspace'));
  assert.equal(b.pptWorkspace, path.join(chosen, 'ppt', 'ppt-workspace'));
  assert.equal(b.rooms.home(), path.join(chosen, 'meeting-room'));
  assert.equal(b.meetings.root, path.join(chosen, 'assistant-workspace', 'meetings'));
  assert.equal(b.meetings.load(id).title, '旧会议');
  assert.equal(b.meetings.dir(id), oldMeeting);
  const forum = new (require('../core/company-forum/service').CompanyForum)({ dataDir });
  assert.equal(forum.workspace, path.join(chosen, 'forum-workspace'));
  assert.equal(require('../core/data-dir').getMeetingWorkspaceDir('new-group'), path.join(chosen, 'group-workspaces', 'new-group'));
  assert.equal(require('../core/storage-roots').artifactsRoot({ env: {} }), path.join(chosen, 'artifacts'));
  assert.ok(fs.existsSync(path.join(oldMeeting, 'meeting.json')));
  const missing = path.join(tmp, 'offline-drive', 'work-files');
  roots.configureAtStartup(missing);
  const fallback = make();
  assert.equal(fallback.workspace, a.workspace, '失效根不阻断真实助理初始化');
  assert.equal(new (require('../core/company-forum/service').CompanyForum)({ dataDir }).workspace,
    path.join(dataDir, 'company-forum', 'workspace'), '失效根不阻断真实论坛初始化');
  assert.equal(fs.existsSync(missing), false);
  a.meetings.close(); b.meetings.close(); fallback.meetings.close();
});
test('手机分享实际落盘、新拍图会话使用新根，恢复的拍图会话仍保留 cwd', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-photo-root-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  roots.configure(tmp);
  const { PhoneChannel } = require('../core/hub-phone/channel');
  const file = PhoneChannel.prototype.saveAttachment.call({}, { name: 'example.txt', data: Buffer.from('shared').toString('base64') });
  assert.ok(file.startsWith(path.join(tmp, 'phone-inbox') + path.sep)); assert.equal(fs.readFileSync(file, 'utf8'), 'shared');
  let saved = { id: 'test-photo', kind: 'claude', state: 'reserved' };
  const a = { store: { get: () => saved, set: (_key, value) => { saved = value; } }, sessionMetadata: () => null,
    deps: { getSession: () => null, createSession: async (kind, opts) => ({ ...opts, kind }) } };
  const { PhotoAssistant } = require('../core/hub-assistant/photo-assistant');
  let result = await new PhotoAssistant(a).ensure();
  assert.ok(result.session.cwd.startsWith(path.join(tmp, 'photo-assistant') + path.sep));
  const old = saved.cwd; saved = { ...saved, state: 'reserved' }; roots.configure(path.join(tmp, 'another'));
  result = await new PhotoAssistant(a).ensure(); assert.equal(result.session.cwd, old, '已有拍图会话保留目录');
});
