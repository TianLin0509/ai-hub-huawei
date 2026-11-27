'use strict';
// 输入框「/」选择框（Claude Code、Codex、DSH、pi）：触发规则、排序、插入写法与各家清单来源。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const picker = require('../renderer/composer-slash-picker');
const { catalogFor } = require('../core/composer-slash-catalog');
const { slashFamily } = require('../core/composer-slash-family');
const codeagent = require('../renderer/composer-codeagent-skills');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slash-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function skill(root, name, description = name + ' 的说明') {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(name)}\ndescription: ${description}\n---\nbody\n`);
}
function md(root, name, text) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); }
const inserts = (catalog, group) => catalog.items.filter(i => i.group === group).map(i => i.insert);

test('only the first word starting with / (or a lone 、) opens the picker; IME composition never does', () => {
  assert.deepEqual(picker.slashQuery('/', 1), { query: '', trigger: '/' });
  assert.deepEqual(picker.slashQuery('/Re', 3), { query: 're', trigger: '/' });
  assert.equal(picker.slashQuery('/review fix', 11), null, '光标已离开第一个词');
  assert.deepEqual(picker.slashQuery('/review fix', 4), { query: 'review', trigger: '/' });
  assert.equal(picker.slashQuery('看下 D:/AIWork', 12), null, '消息中间的 / 不唤起');
  assert.equal(picker.slashQuery('/', 1, { composing: true }), null);
  assert.equal(picker.slashQuery('/', null), null);
  assert.deepEqual(picker.slashQuery('、', 1), { query: '', trigger: '、' });
  assert.equal(picker.slashQuery('、好的', 3), null, '「、」后面接着打中文就不是命令');
  assert.equal(picker.slashQuery('好、', 2), null);
});

test('CodeAgent picker also accepts a lone 、 and keeps its old rules', () => {
  assert.equal(codeagent.slashQuery('、', 1), '');
  assert.equal(codeagent.slashQuery('、你好', 3), null);
  assert.equal(codeagent.slashQuery('、', 1, { composing: true }), null);
  assert.equal(codeagent.slashQuery('/ins', 4), 'ins');
});

test('choosing replaces only the typed token, keeps the rest, and turns 、 into the command', () => {
  assert.equal(picker.insertInto('/re', '/', '/review'), '/review ');
  assert.equal(picker.insertInto('/re 修一下登录', '/', '/review'), '/review 修一下登录');
  assert.equal(picker.insertInto('/', '/', '$progress-brief'), '$progress-brief ');
  assert.equal(picker.insertInto('、', '、', '/skill:pdf'), '/skill:pdf ');
});

test('ranking keeps command → skill → other, puts prefix hits first and recent skills on top', () => {
  const items = [
    { group: 'other', name: 'weekly', insert: '/weekly', description: '' },
    { group: 'skill', name: 'zeta', insert: '/zeta', description: '' },
    { group: 'skill', name: 'code-review', insert: '/code-review', description: '' },
    { group: 'command', name: 'resume', insert: '/resume', description: '' },
    { group: 'command', name: 'review', insert: '/review', description: '审查改动' },
    { group: 'skill', name: 'pdf', insert: '/skill:pdf', description: '读取 review 报告' },
  ];
  assert.deepEqual(picker.rankItems(items, '').map(i => i.name), ['resume', 'review', 'zeta', 'code-review', 'pdf', 'weekly']);
  assert.deepEqual(picker.rankItems(items, '', ['/skill:pdf', '/code-review']).map(i => i.name), ['resume', 'review', 'pdf', 'code-review', 'zeta', 'weekly']);
  assert.deepEqual(picker.rankItems(items, 'rev').map(i => i.name), ['review', 'code-review', 'pdf']);
  assert.deepEqual(picker.rankItems(items, 'review').map(i => i.name), ['review', 'code-review', 'pdf'], '说明命中排在名字命中后');
  assert.deepEqual(picker.rankItems(items, 'skill:p').map(i => i.name), ['pdf'], 'pi 的 /skill: 写法可直接搜');
});

test('ranking 500 skills stays well under one frame', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ group: 'skill', name: 'skill-' + i, insert: '/skill-' + i, description: '压力测试 ' + i }));
  const start = process.hrtime.bigint();
  for (const q of ['s', 'sk', 'ski', 'skil', 'skill', 'skill-', 'skill-4']) picker.rankItems(items, q);
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 / 7 < 16);
});

test('family: CodeAgent keeps its own picker; the four others are mapped; non-AI sessions get nothing', () => {
  assert.equal(slashFamily({ kind: 'codeagent' }), null);
  assert.equal(slashFamily({ kind: 'codeagent-resume' }), null);
  assert.equal(slashFamily({ kind: 'claude-resume' }), 'claude');
  assert.equal(slashFamily({ kind: 'codex' }), 'codex');
  assert.equal(slashFamily({ kind: 'deepseek' }), 'codex');
  assert.equal(slashFamily({ kind: 'deepseek-acp' }), 'dsh');
  assert.equal(slashFamily({ kind: 'pi-resume' }), 'pi');
  assert.equal(slashFamily({ kind: 'powershell' }), null);
  assert.equal(catalogFor({ kind: 'codeagent' }).ok, false);
});

test('Claude Code: account skills, project skills, enabled plugin skills/commands (plugin:name) and custom commands', t => {
  const dir = temp(t), config = path.join(dir, 'acct'), cwd = path.join(dir, 'proj'), plugin = path.join(dir, 'plugin-root');
  skill(path.join(config, 'skills'), 'progress-brief'); skill(path.join(config, 'skills'), 'market/deep-one');
  skill(path.join(cwd, '.claude', 'skills'), 'sim-helper');
  skill(path.join(plugin, 'skills'), 'review-pr'); md(path.join(plugin, 'commands'), 'commit.md', '---\ndescription: 提交\n---\n');
  skill(path.join(dir, 'disabled-plugin', 'skills'), 'hidden');
  md(config, 'settings.json', JSON.stringify({ enabledPlugins: { 'code-review@market': true, 'off@market': false } }));
  md(config, 'plugins/installed_plugins.json', JSON.stringify({ plugins: {
    'code-review@market': [{ scope: 'user', installPath: plugin }], 'off@market': [{ scope: 'user', installPath: path.join(dir, 'disabled-plugin') }] } }));
  md(path.join(config, 'commands'), 'weekly.md', '# 生成本周周报\n');
  md(path.join(config, 'commands'), 'team/sync.md', '---\ndescription: 同步\nargument-hint: <人名>\n---\n');
  md(path.join(cwd, '.claude', 'commands'), 'deploy-check.md', '发布前检查\n');
  const catalog = catalogFor({ kind: 'claude', cwd, claudeConfigDir: config }, { homeDir: path.join(dir, 'home') });
  assert.equal(catalog.label, 'Claude Code');
  assert.ok(inserts(catalog, 'command').includes('/compact'));
  assert.deepEqual(inserts(catalog, 'skill').sort(), ['/code-review:review-pr', '/deep-one', '/progress-brief', '/sim-helper']);
  assert.deepEqual(inserts(catalog, 'other').sort(), ['/code-review:commit', '/deploy-check', '/team:sync', '/weekly']);
  const weekly = catalog.items.find(i => i.insert === '/weekly');
  assert.equal(weekly.description, '生成本周周报');
  assert.equal(catalog.items.find(i => i.insert === '/team:sync').argumentHint, '<人名>');
  assert.equal(catalog.items.find(i => i.insert === '/sim-helper').source, '项目');
  assert.equal(catalog.items.find(i => i.insert === '/code-review:review-pr').source, '插件 · code-review');
});

test('Codex: terminal sessions mention skills as $name, Hub native sessions use /name; prompts only in the terminal', t => {
  const dir = temp(t), home = path.join(dir, 'home'), codexHome = path.join(dir, 'codex-acct'), cwd = path.join(dir, 'proj');
  skill(path.join(codexHome, 'skills'), 'own'); skill(path.join(codexHome, 'skills', '.system'), 'skill-creator');
  skill(path.join(home, '.agents', 'skills'), 'shared'); skill(path.join(cwd, '.agents', 'skills'), 'proj-skill');
  skill(path.join(home, '.codex', 'skills'), 'other-account-only');
  md(path.join(codexHome, 'prompts'), 'bugfix.md', '---\ndescription: 四步修 bug\n---\n');
  const session = { kind: 'codex', cwd, codexSessionsRoot: path.join(codexHome, 'sessions') };
  const pty = catalogFor({ ...session, agentRuntime: 'pty' }, { homeDir: home });
  assert.deepEqual(inserts(pty, 'skill').sort(), ['$own', '$proj-skill', '$shared', '$skill-creator']);
  assert.deepEqual(inserts(pty, 'other'), ['/prompts:bugfix']);
  assert.ok(pty.items.find(i => i.insert === '/model').terminal);
  const native = catalogFor({ ...session, runtimeBackend: 'codex-app-server' }, { homeDir: home });
  assert.deepEqual(inserts(native, 'skill').sort(), ['/own', '/proj-skill', '/shared', '/skill-creator']);
  assert.deepEqual(inserts(native, 'other'), []);
  assert.ok(inserts(native, 'command').includes('/goal'));
  assert.equal(native.items.find(i => i.insert === '/proj-skill').source, '项目');
});

test('DSH: terminal sessions list documented commands plus project and isolated-home skills; ACP lists runtime commands', t => {
  const dir = temp(t), dataDir = path.join(dir, 'data'), repo = path.join(dir, 'repo'), cwd = path.join(repo, 'sub');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  skill(path.join(repo, '.dsh', 'skills'), 'dsh-proj'); skill(path.join(repo, '.agents', 'skills'), 'agents-proj');
  const isolated = path.join(dataDir, 'acp', createHash('sha256').update('sess-1').digest('hex'), 'home');
  skill(path.join(isolated, '.dsh', 'skills'), 'dsh-user');
  skill(path.join(dir, 'real-home', '.agents', 'skills'), 'not-loaded-by-dsh');
  const pty = catalogFor({ kind: 'deepseek-acp', id: 'sess-1', cwd, agentRuntime: 'pty' }, { dataDir, homeDir: path.join(dir, 'real-home') });
  assert.ok(inserts(pty, 'command').includes('/btw'));
  assert.deepEqual(inserts(pty, 'skill').sort(), ['/agents-proj', '/dsh-proj', '/dsh-user']);
  const acp = catalogFor({ kind: 'deepseek-acp', id: 'sess-1', cwd, runtimeBackend: 'acp' }, { dataDir,
    acpCommands: [{ name: 'plan', description: 'Plan first', input: { hint: '任务' } }, { name: 'quota', description: 'dup' }] });
  assert.deepEqual(inserts(acp, 'command'), ['/model', '/quota', '/status', '/help', '/plan']);
  assert.equal(acp.items.find(i => i.insert === '/plan').argumentHint, '任务');
  assert.equal(acp.sourceNote, 'DSH 运行时上报');
});

test('pi: skills as /skill:name from agent dir, project .pi and .agents up to the repo root; prompt templates as /name', t => {
  const dir = temp(t), home = path.join(dir, 'home'), agentDir = path.join(dir, 'pi-agent'), repo = path.join(dir, 'repo'), cwd = path.join(repo, 'pkg');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  skill(path.join(agentDir, 'skills'), 'pdf-tools'); skill(path.join(cwd, '.pi', 'skills'), 'proj');
  skill(path.join(repo, '.agents', 'skills'), 'repo-agents'); skill(path.join(dir, '.agents', 'skills'), 'outside-repo');
  skill(path.join(home, '.agents', 'skills'), 'shared');
  md(path.join(agentDir, 'prompts'), 'review.md', '---\ndescription: 审 PR\n---\n');
  const catalog = catalogFor({ kind: 'pi', cwd }, { homeDir: home, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.deepEqual(inserts(catalog, 'skill').sort(), ['/skill:pdf-tools', '/skill:proj', '/skill:repo-agents', '/skill:shared']);
  assert.deepEqual(inserts(catalog, 'other'), ['/review']);
  assert.ok(!inserts(catalog, 'command').includes('/login'), 'Hub 管账号的命令不列');
});

test('unreadable or malformed entries are skipped without breaking the list', t => {
  const dir = temp(t), config = path.join(dir, 'acct');
  fs.mkdirSync(path.join(config, 'skills', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(config, 'skills', 'broken', 'SKILL.md'), 'no front matter');
  skill(path.join(config, 'skills'), 'bad name with space');
  md(config, 'settings.json', '{not json');
  const catalog = catalogFor({ kind: 'claude', claudeConfigDir: config }, { homeDir: dir });
  assert.equal(catalog.ok, true);
  assert.deepEqual(inserts(catalog, 'skill'), []);
  assert.ok(catalog.warnings.some(w => /settings\.json/.test(w)));
});

test('renderer key handler lets the slash picker consume keys before send', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const match = source.match(/inputBox\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n  \}\);/);
  let sends = 0, consumed = 0;
  const handle = vm.runInNewContext(`(e) => {${match[1]}\n}`, {
    codeagentSkills: null, slashPicker: { onKeyDown: e => { if (e.key === 'Enter' && e.open) { consumed += 1; return true; } return false; } },
    sendInput: () => { sends += 1; }, inputHistory: null, isNativeAgent: () => false, sessions: new Map(), sessionId: 's',
    focusAfterSend() {}, require: id => require(path.join(__dirname, '..', 'renderer', id)), localStorage: { getItem: () => null },
    // R52c 起回车先问终端选择菜单要不要（菜单没出现时不拦）；这里只测斜杠选择框的先后顺序。
    ptyAttention: { forwardKey: () => false }, contenteditableHasText: () => true, inputBox: {},
  });
  const ev = extra => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...extra });
  handle(ev({ open: true })); assert.equal(consumed, 1); assert.equal(sends, 0);
  handle(ev({ isComposing: true, open: true })); assert.equal(consumed, 1, '组字中的回车不给选择框'); assert.equal(sends, 0);
  handle(ev({})); assert.equal(sends, 1);
});

test('review fixes: user-invocable:false hidden, broken plugin records tolerated, project/local plugin switches, Codex runtime home and ancestors', t => {
  const dir = temp(t), config = path.join(dir, 'acct'), repo = path.join(dir, 'repo'), cwd = path.join(repo, 'sub'), plugin = path.join(dir, 'p'), plugin2 = path.join(dir, 'p2');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(config, 'skills', 'model-only'), { recursive: true });
  fs.writeFileSync(path.join(config, 'skills', 'model-only', 'SKILL.md'), '---\nname: model-only\ndescription: x\nuser-invocable: false\n---\n');
  skill(path.join(config, 'skills'), 'visible');
  skill(path.join(plugin, 'skills'), 'from-project'); skill(path.join(plugin2, 'skills'), 'locally-off');
  md(config, 'settings.json', JSON.stringify({ enabledPlugins: { 'proj@m': false, 'loc@m': true, 'broken@m': true } }));
  md(config, 'plugins/installed_plugins.json', JSON.stringify({ plugins: { 'proj@m': [null, { scope: 'project', installPath: plugin }], 'loc@m': [{ scope: 'user', installPath: plugin2 }], 'broken@m': [null] } }));
  md(path.join(cwd, '.claude'), 'settings.json', JSON.stringify({ enabledPlugins: { 'proj@m': true } }));
  md(path.join(cwd, '.claude'), 'settings.local.json', JSON.stringify({ enabledPlugins: { 'loc@m': false } }));
  const claude = catalogFor({ kind: 'claude', cwd, claudeConfigDir: config }, { homeDir: path.join(dir, 'h') });
  assert.deepEqual(inserts(claude, 'skill').sort(), ['/proj:from-project', '/visible']);

  const runtime = path.join(dir, 'codex-runtime'), history = path.join(dir, 'codex-history');
  skill(path.join(runtime, 'skills'), 'runtime-skill'); skill(path.join(history, 'skills'), 'history-skill');
  skill(path.join(repo, '.agents', 'skills'), 'repo-root'); skill(path.join(dir, '.agents', 'skills'), 'outside');
  const codex = catalogFor({ kind: 'codex', cwd, agentRuntime: 'pty', codexRuntimeHome: runtime, codexSessionsRoot: path.join(history, 'sessions') }, { homeDir: path.join(dir, 'h') });
  assert.deepEqual(inserts(codex, 'skill').sort(), ['$repo-root', '$runtime-skill']);
});
