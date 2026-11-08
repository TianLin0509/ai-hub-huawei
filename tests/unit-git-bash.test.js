'use strict';
// Git Bash 查找与一键安装 Git for Windows（2026-11-07）：先全局找本机已有的 Git，找到就不重复装；
// 组件包里的硬链接；Hub 装的或别处找到的 Git 经 CLAUDE_CODE_GIT_BASH_PATH 交给 Claude 会话。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gitBash = require('../core/git-bash');
const tar = require('../core/cli-tools/tar');
const registry = require('../core/cli-tools/registry');
const { createCliInstaller } = require('../core/cli-tools/installer');

function tempDir(t, prefix = 'git-bash-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(file, data = 'x') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }
// 一个「完整」的 Git 目录：bin/bash.exe + usr/bin/{bash,ls,grep}.exe + cmd/git.exe。
function fakeGit(root, { full = true } = {}) {
  put(path.join(root, 'bin', 'bash.exe'));
  put(path.join(root, 'usr', 'bin', 'bash.exe'));
  put(path.join(root, 'cmd', 'git.exe'));
  if (full) { put(path.join(root, 'usr', 'bin', 'ls.exe')); put(path.join(root, 'usr', 'bin', 'grep.exe')); }
  return path.join(root, 'bin', 'bash.exe');
}
// 测试用环境：只指向临时目录，不让本机真实的 Program Files\Git 混进来。
function env(t, extra = {}) {
  const base = tempDir(t, 'git-env-');
  return { SystemRoot: path.join(base, 'Windows'), ProgramFiles: path.join(base, 'pf'), LOCALAPPDATA: path.join(base, 'lad'),
    USERPROFILE: path.join(base, 'home'), PATH: '', AI_HUB_CLI_TOOLS_DIR: path.join(base, 'tools'), ...extra, _base: base };
}
const noPs = async () => '';

test('quick: Program Files\\Git, user Programs\\Git, PATH git.exe; incomplete bash and the WSL bash are ignored', t => {
  gitBash.resetForTests();
  const e = env(t);
  assert.equal(gitBash.locateGitBash(e), null);
  // MinGit 一类精简版（没有 ls / grep）不算。
  fakeGit(path.join(e.ProgramFiles, 'Git'), { full: false });
  gitBash.invalidate();
  assert.equal(gitBash.locateGitBash(e), null);
  const pf = fakeGit(path.join(e.ProgramFiles, 'Git'));
  assert.equal(gitBash.locateGitBash(e), null, 'answers are reused for 3 seconds');
  gitBash.invalidate();
  assert.deepEqual(gitBash.locateGitBash(e), { bash: pf, source: 'user' });

  const e2 = env(t);
  const local = fakeGit(path.join(e2.LOCALAPPDATA, 'Programs', 'Git'));
  assert.equal(gitBash.findGitBash(e2), local);

  const e3 = env(t);
  const elsewhere = path.join(e3._base, 'D', 'tools', 'PortableGit');
  const bash = fakeGit(elsewhere);
  e3.PATH = path.join(elsewhere, 'cmd');
  assert.equal(gitBash.findGitBash(e3), bash, 'git.exe in <root>/cmd leads to <root>/bin/bash.exe');

  const e4 = env(t);
  put(path.join(e4.SystemRoot, 'System32', 'bash.exe'));
  put(path.join(e4.SystemRoot, 'usr', 'bin', 'ls.exe')); put(path.join(e4.SystemRoot, 'usr', 'bin', 'grep.exe'));
  e4.PATH = path.join(e4.SystemRoot, 'System32');
  assert.equal(gitBash.findGitBash(e4), null, 'System32\\bash.exe is WSL, not Git Bash');

  const e5 = env(t, {});
  e5.CLAUDE_CODE_GIT_BASH_PATH = put(path.join(e5._base, 'custom', 'bash.exe'));
  assert.deepEqual(gitBash.locateGitBash(e5), { bash: e5.CLAUDE_CODE_GIT_BASH_PATH, source: 'env' }, 'the user\'s own setting is trusted as is');
});

test('deep: registry InstallPath, Visual Studio\'s bundled Git and git folders on local drives; result is remembered', async t => {
  gitBash.resetForTests();
  const e = env(t);
  const reg = path.join(e._base, 'odd', 'place', 'Git');
  const regBash = fakeGit(reg);
  let calls = 0;
  const runPs = async () => { calls++; return `D C:\\\r\nR ${reg}\r\n`; };
  const hit = await gitBash.searchGitBash(e, { force: true, runPs, drives: [] });
  assert.deepEqual(hit, { bash: regBash, source: 'user', deep: true });
  assert.equal(calls, 1);
  assert.deepEqual(gitBash.locateGitBash(e), { bash: regBash, source: 'user', deep: true }, 'quick lookups reuse the deep result');
  await gitBash.searchGitBash(e, { runPs });
  assert.equal(calls, 1, 'no second PowerShell within a minute unless forced');

  gitBash.resetForTests();
  const e2 = env(t);
  const vs = path.join(e2.ProgramFiles, 'Microsoft Visual Studio', '2022', 'Professional', 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'TeamFoundation', 'Team Explorer', 'Git');
  const vsBash = fakeGit(vs);
  assert.equal(gitBash.findGitBash(e2), null);
  assert.equal((await gitBash.searchGitBash(e2, { force: true, runPs: noPs, drives: [] })).bash, vsBash);

  gitBash.resetForTests();
  const e3 = env(t);
  assert.equal(await gitBash.searchGitBash(e3, { force: true, runPs: noPs, drives: [] }), null);
  gitBash.resetForTests();
});

test('tar: hard links are packed once and come back as files with the same content', async t => {
  const dir = tempDir(t);
  const out = path.join(dir, 'p.tgz');
  const long = 'ucrt64/libexec/git-core/' + 'x'.repeat(90) + '/git-remote-https.exe';
  await tar.packTgz([{ name: 'ucrt64/bin/git.exe', data: Buffer.alloc(5000, 7) },
    { name: 'ucrt64/libexec/git-core/git-add.exe', link: 'ucrt64/bin/git.exe' },
    { name: long, link: 'ucrt64/bin/git.exe' }], out);
  assert.ok(fs.statSync(out).size < 1500, 'the linked copies add no data');
  const dest = path.join(dir, 'x');
  const r = await tar.extractTgz(out, dest);
  assert.equal(r.files, 3);
  for (const rel of ['ucrt64/bin/git.exe', 'ucrt64/libexec/git-core/git-add.exe', long]) assert.deepEqual(fs.readFileSync(path.join(dest, ...rel.split('/'))), Buffer.alloc(5000, 7), rel);
  await assert.rejects(tar.packTgz([{ name: 'a', link: 'missing' }], path.join(dir, 'bad.tgz')), /硬链接指向的文件不在打包条目里/);
  // strip 前缀同样作用在链接目标上。
  const out2 = path.join(dir, 'p2.tgz');
  await tar.packTgz([{ name: 'pkg/a.exe', data: 'A' }, { name: 'pkg/b.exe', link: 'pkg/a.exe' }], out2);
  const dest2 = path.join(dir, 'y');
  await tar.extractTgz(out2, dest2, { strip: 'pkg' });
  assert.equal(fs.readFileSync(path.join(dest2, 'b.exe'), 'utf8'), 'A');
});

test('install git: an existing Git found anywhere is used instead of downloading', { skip: process.platform !== 'win32' }, async t => {
  gitBash.resetForTests();
  const e = env(t);
  const bash = fakeGit(path.join(e._base, 'E', 'PortableGit'));
  const states = [];
  let fetched = 0;
  const installer = createCliInstaller({ sources: [{ id: 'a', name: 'a', manifest: 'http://127.0.0.1:9/hub-update/components/components.json' }],
    fetchImpl: async () => { fetched++; throw new Error('should not download'); }, env: e, onState: s => states.push(s), logger: { warn() {} } });
  assert.equal(installer.snapshot().git, null);
  // 深度查找经 PowerShell：这里替换成直接报这个目录（等同注册表 InstallPath）。
  const real = gitBash.searchGitBash;
  gitBash.searchGitBash = (en, o = {}) => real(en, { ...o, runPs: async () => `R ${path.join(e._base, 'E', 'PortableGit')}`, drives: [] });
  t.after(() => { gitBash.searchGitBash = real; gitBash.resetForTests(); });
  const s = await installer.install('git');
  assert.equal(s.tools.git.phase, 'done');
  assert.equal(s.tools.git.found, bash);
  assert.equal(fetched, 0);
  assert.ok(states.some(st => st.busy === 'git' && st.tools.git.phase === 'checking'), 'the search shows「正在全局查找」and blocks other installs');
  assert.equal(s.busy, null);
  assert.equal(s.git.bash, bash);
});

test('session env: Hub-installed Git goes into CLAUDE_CODE_GIT_BASH_PATH and PATH; a user setting is left alone', { skip: process.platform !== 'win32' }, t => {
  gitBash.resetForTests();
  const e = env(t);
  const root = e.AI_HUB_CLI_TOOLS_DIR;
  const bash = fakeGit(path.join(root, 'git', '2.56.0+windows.4'));
  registry.writeInstalled(root, { tools: { git: { version: '2.56.0+windows.4', dir: 'git/2.56.0+windows.4', bin: 'cmd/git.exe', pathDirs: ['cmd'] } } });
  assert.deepEqual(gitBash.locateGitBash(e), { bash, source: 'hub' });
  const sessionEnv = { ...e };
  registry.applySessionPath(sessionEnv, { platform: 'win32' });
  assert.equal(sessionEnv.CLAUDE_CODE_GIT_BASH_PATH, bash);
  assert.ok(sessionEnv.PATH.startsWith(path.join(root, 'git', '2.56.0+windows.4', 'cmd')));

  const own = { ...e, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\mine\\bash.exe' };
  registry.applySessionPath(own, { platform: 'win32' });
  assert.equal(own.CLAUDE_CODE_GIT_BASH_PATH, 'D:\\mine\\bash.exe');

  // 用户自己装的（这里放在 LOCALAPPDATA\Programs\Git，Claude 自己不一定找得到）：同样告诉它。
  const e2 = env(t);
  const userBash = fakeGit(path.join(e2.LOCALAPPDATA, 'Programs', 'Git'));
  const s2 = { ...e2 };
  registry.applySessionPath(s2, { platform: 'win32' });
  assert.equal(s2.CLAUDE_CODE_GIT_BASH_PATH, userBash);
  assert.ok(!String(s2.PATH).includes('Programs'), 'a user-installed Git is not added to PATH');
});

test('wording: Git Bash is recommended, not required (Claude Code falls back to PowerShell)', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8');
  for (const f of ['core/cli-tools/installer.js', 'core/community-setup.js', 'core/env-check.js']) assert.match(src(f), /改用 PowerShell/, f);
  assert.doesNotMatch(src('core/cli-tools/installer.js'), /还需要 Git for Windows（Git Bash）才能执行工具/);
  assert.doesNotMatch(src('renderer/company-api-settings.js'), /Windows 同时需要 Git for Windows/);
  assert.match(src('renderer/env-check.js'), /act === 'git-install'/);
  assert.match(src('main/cli-tools-ipc.js'), /refreshGit/);
});
