'use strict';
// Hub 设置 ·「新建会话默认工作目录」（2026-11-19，管家 r38d 方案 A）：
// 设置能改新会话的工作根；环境变量 AI_HUB_WORKSPACE_ROOT 仍优先；留空回到原来的默认。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.AI_HUB_WORKSPACE_ROOT;
const storageRoots = require('../core/storage-roots.js');
const { WorkspaceService } = require('../core/workspace-service.js');
const { buildConfigJsonUpdate, validateDefaultWorkspaceRoot, workspaceRootForm } = require('../main/ipc/config-handlers.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok ${name}`); }
  finally { storageRoots.setConfiguredWorkspaceRoot(''); delete process.env.AI_HUB_WORKSPACE_ROOT; }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-default-root-'));
function service() {
  return new WorkspaceService({ getHubDataDir: () => path.join(tmp, 'data'), isIsolatedHub: () => false, os: { homedir: () => path.join(tmp, 'home') } });
}

test('没设置时行为不变：~/Workspaces，平铺', () => {
  const s = service();
  assert.strictEqual(s.getWorkspaceRoot(), path.join(tmp, 'home', 'Workspaces'));
  assert.strictEqual(s.isFlatWorkRoot(), true);
  assert.strictEqual(storageRoots.workspaceRootSource(), null);
  assert.strictEqual(storageRoots.workspaceRoot({ fallback: 'C:/Work' }), path.resolve('C:/Work'));
});

test('设置了默认工作目录（新建的空目录）：新会话工作根换成它，保存时补标记，直接平铺', () => {
  const chosen = path.join(tmp, 'my work');
  const checked = validateDefaultWorkspaceRoot(chosen);
  assert.strictEqual(checked.ok, true);
  assert.strictEqual(checked.flat, true);
  assert.ok(fs.existsSync(path.join(chosen, '.aiwork-root')), '新建的目录自动放 .aiwork-root');
  storageRoots.setConfiguredWorkspaceRoot(chosen);
  const s = service();
  assert.strictEqual(s.getWorkspaceRoot(), chosen);
  assert.strictEqual(s.isFlatWorkRoot(), true);
  assert.strictEqual(storageRoots.workspaceRootSource(), 'config');
  assert.strictEqual(storageRoots.sessionWorkspaceRoot({ env: {}, fallback: 'C:/Work' }), path.resolve('C:/Work'), '测试传入的 env 不受设置影响');
});

test('设置了默认目录，手机信任根、手机分享落盘、拍图助理的后备根都不变', () => {
  const dataDir = path.join(tmp, 'data');
  const trustedBefore = storageRoots.trustedFileRoots({ dataDir });
  const inboxBefore = storageRoots.workspaceRoot({ fallback: 'C:/Work' });
  const photoBefore = storageRoots.workspaceRoot({ fallback: 'D:/AIWork' });
  storageRoots.setConfiguredWorkspaceRoot(path.join(tmp, 'my work'));
  assert.deepStrictEqual(storageRoots.trustedFileRoots({ dataDir }), trustedBefore);
  assert.ok(!storageRoots.trustedFileRoots({ dataDir }).some(r => storageRoots.pathKey(r) === storageRoots.pathKey(path.join(tmp, 'my work'))), '设置的目录不进手机信任根');
  assert.strictEqual(storageRoots.workspaceRoot({ fallback: 'C:/Work' }), inboxBefore);
  assert.strictEqual(storageRoots.workspaceRoot({ fallback: 'D:/AIWork' }), photoBefore);
  assert.strictEqual(inboxBefore, path.resolve('C:/Work'));
});

test('盘符根、用户主目录本身、Hub 程序目录与数据目录被拒', () => {
  const home = path.join(tmp, 'home');
  const hubData = path.join(tmp, 'hubdata');
  const opts = { home, protectedDirs: [hubData] };
  for (const bad of ['C:\\', 'D:\\', 'D:/', home, home + path.sep, hubData, path.join(hubData, 'sub')]) {
    assert.ok(storageRoots.defaultRootRejectReason(bad, opts), `应拒绝 ${bad}`);
    assert.strictEqual(validateDefaultWorkspaceRoot(bad, opts).ok, false, `保存时应拒绝 ${bad}`);
  }
  assert.strictEqual(storageRoots.defaultRootRejectReason(path.join(home, 'Work'), opts), '');
  assert.strictEqual(storageRoots.defaultRootRejectReason('D:\\Work', opts), '');
  // 默认保护清单里有 Hub 程序目录（本仓库）
  assert.strictEqual(validateDefaultWorkspaceRoot(path.join(__dirname, '..')).ok, false);
  assert.strictEqual(validateDefaultWorkspaceRoot(require('os').homedir()).ok, false);
});

test('已有内容又没标记的目录（可能是组织根）：仍过组织根守卫，新会话落 _scratch', () => {
  const org = path.join(tmp, 'Workspace');
  fs.mkdirSync(path.join(org, 'AI'), { recursive: true });
  const checked = validateDefaultWorkspaceRoot(org);
  assert.strictEqual(checked.ok, true);
  assert.strictEqual(checked.flat, false);
  assert.ok(!fs.existsSync(path.join(org, '.aiwork-root')), '已有内容的目录不自动补标记');
  storageRoots.setConfiguredWorkspaceRoot(org);
  const s = service();
  assert.strictEqual(s.isFlatWorkRoot(), false);
  assert.ok(s.workspaceRejectReason(org), '组织根本身不能直接当工作目录');
});

test('启动时重新校验：目录不存在或是盘根就当没设，并给出理由', () => {
  const { startupDefaultWorkspaceRoot } = require('../main/ipc/config-handlers.js');
  assert.strictEqual(startupDefaultWorkspaceRoot(path.join(tmp, 'deleted')), null);
  assert.strictEqual(storageRoots.workspaceRootSource(), null);
  assert.match(storageRoots.configuredWorkspaceRootError(), /已不存在/);
  assert.match(workspaceRootForm({}).workspaceRootInvalid, /已不存在/);
  assert.strictEqual(startupDefaultWorkspaceRoot('C:\\'), null);
  assert.match(storageRoots.configuredWorkspaceRootError(), /盘的根目录/);
  const ok = path.join(tmp, 'alive'); fs.mkdirSync(ok);
  assert.strictEqual(startupDefaultWorkspaceRoot(ok), ok);
  assert.strictEqual(storageRoots.configuredWorkspaceRootError(), '');
  assert.strictEqual(service().getWorkspaceRoot(), ok);
});

test('环境变量仍优先于设置', () => {
  storageRoots.setConfiguredWorkspaceRoot(path.join(tmp, 'ui'));
  process.env.AI_HUB_WORKSPACE_ROOT = path.join(tmp, 'env');
  assert.strictEqual(service().getWorkspaceRoot(), path.join(tmp, 'env'));
  assert.strictEqual(storageRoots.workspaceRootSource(), 'env');
  const form = workspaceRootForm({ defaultWorkspaceRoot: path.join(tmp, 'ui') });
  assert.strictEqual(form.workspaceRootEnv, path.join(tmp, 'env'));
});

test('校验：相对路径拒绝、不存在的目录自动建、留空表示恢复默认', () => {
  assert.strictEqual(validateDefaultWorkspaceRoot('').ok, true);
  assert.strictEqual(validateDefaultWorkspaceRoot('').value, '');
  assert.strictEqual(validateDefaultWorkspaceRoot('work').ok, false);
  const fresh = path.join(tmp, 'new', 'dir');
  const r = validateDefaultWorkspaceRoot(fresh);
  assert.strictEqual(r.ok, true);
  assert.ok(fs.statSync(fresh).isDirectory());
  const file = path.join(tmp, 'a-file.txt'); fs.writeFileSync(file, 'x');
  assert.strictEqual(validateDefaultWorkspaceRoot(file).ok, false);
});

test('保存：写进 workspace.default_root，留空删除该键，其他字段不动；没提交该字段时不碰', () => {
  const existing = { workspace: { other: 1 }, ui: { card_font_size: 17 } };
  const set = buildConfigJsonUpdate(existing, { defaultWorkspaceRoot: 'D:/Work' });
  assert.deepStrictEqual(set.workspace, { other: 1, default_root: 'D:/Work' });
  assert.strictEqual(set.ui.card_font_size, 17);
  const cleared = buildConfigJsonUpdate({ workspace: { default_root: 'D:/Work' } }, { defaultWorkspaceRoot: '' });
  assert.deepStrictEqual(cleared.workspace, {});
  const untouched = buildConfigJsonUpdate({ workspace: { default_root: 'D:/Work' } }, { cardFontSize: 15 });
  assert.deepStrictEqual(untouched.workspace, { default_root: 'D:/Work' }, '没提交该字段时原值保留');
});

console.log(`unit-default-workspace-root: ${passed} passed`);
