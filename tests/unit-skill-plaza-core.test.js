'use strict';
// 技能广场 core：扫描、分档、归类、敏感标记、转换导入、回滚、移除、台账与安全边界。夹具全部自造。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../core/skill-plaza/rules');
const source = require('../core/skill-plaza/weclaw-source');
const installer = require('../core/skill-plaza/installer');
const { SkillPlazaService } = require('../core/skill-plaza/service');
const { registerSkillPlazaIpc } = require('../main/ipc/skill-plaza-handlers');

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-plaza-'));
  const home = path.join(base, 'home'), data = path.join(base, 'data');
  fs.mkdirSync(home, { recursive: true });
  for (const d of ['.claude', '.agents', '.cac']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const roots = source.weclawRoots(home);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const skill = (rootIndex, dir, { name, description, extra = '', body = '正文\n', files = {}, meta } = {}) => {
    const root = path.join(roots[rootIndex], dir);
    const head = ['---', name !== undefined ? `name: ${name}` : '', description !== undefined ? `description: ${description}` : '', extra, '---'].filter(Boolean).join('\n');
    write(path.join(root, 'SKILL.md'), `${head}\n${body}`);
    for (const [rel, text] of Object.entries(files)) write(path.join(root, rel), text);
    if (meta) write(path.join(roots[rootIndex], dir.split('/')[0], '_skillhub_meta.json'), JSON.stringify(meta));
    return root;
  };
  // locateInstall 默认桩成「没找到」：单测不真的起 PowerShell 查注册表
  const service = (o = {}) => new SkillPlazaService({ dataDir: data, homeDir: home, findInstall: () => 'C:/fake/WeClaw Desktop.exe', locateInstall: async () => ({ file: '' }), log: () => {}, ...o });
  return { base, home, data, roots, write, skill, service, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const byId = (list, id) => list.items.find(i => i.id === id);

test('名字规范、目标名与 SKILL.md 头解析', () => {
  assert.equal(rules.slug('My_Skill 名字'), 'my-skill');
  assert.equal(rules.slug('中文', 'Itimes_TimeSheet'), 'itimes-timesheet');
  assert.equal(rules.slug('', '', ''), 'skill');
  assert.equal(rules.targetName('abc'), 'weclaw-abc');
  assert.equal(rules.targetName('weclaw-onebox-word'), 'weclaw-onebox-word');
  assert.ok(rules.targetName('x'.repeat(80)).length <= 64);
  assert.match(rules.targetName('x'.repeat(80)), rules.TARGET_NAME_RE);
  const { fm, order, body } = rules.parseFrontmatter('\uFEFF---\nname: "a"\ndescription: >\n  第一行\n  第二行\nallowed-tools: Bash\n---\nbody');
  assert.deepEqual(fm, { name: 'a', description: '第一行 第二行', 'allowed-tools': 'Bash' });
  assert.deepEqual(order, ['name', 'description', 'allowed-tools']);
  assert.equal(body, 'body');
});

test('四档判定、归类与敏感标记', () => {
  const t = (names, texts) => rules.useTier({ names, deps: rules.detectDeps(texts) });
  assert.equal(t(['plain'], { 'SKILL.md': '整理会议纪要' }), 'ok');
  assert.equal(t(['a'], { 'SKILL.md': 'run welink-cli send' }), 'fix');
  assert.equal(t(['a'], { 'x.py': 'requests.post("http://127.0.0.1:3008/x")' }), 'fix');
  assert.equal(t(['a'], { 'SKILL.md': '```file\nC:/a.docx\n```' }), 'fix');
  assert.equal(t(['a'], { 'run.tool.js': 'x' , 'SKILL.md': 'see run.tool.js' }), 'delegate');
  assert.equal(t(['itimes-timesheet'], { 'SKILL.md': '纯文本' }), 'delegate');
  assert.equal(rules.classifyCategory('weclaw-onebox-ppt', '做幻灯片'), 'ppt');
  assert.equal(rules.classifyCategory('itimes-timesheet', '填工时'), 'intranet');
  assert.equal(rules.classifyCategory('meeting-notes', '会议纪要'), 'welink');
  assert.equal(rules.classifyCategory('docx-helper', 'Word 文档'), 'office');
  assert.equal(rules.classifyCategory('git-helper', '代码提交'), 'dev');
  assert.equal(rules.classifyCategory('random', '天气'), 'other');
  const corp = ['hua', 'wei'].join('') + '.com';  // 夹具拼出来，源码不出现明文域名
  assert.deepEqual(rules.detectSensitive({ a: `见 https://w3.${corp}/x` }), { intranet: true });
  assert.deepEqual(rules.detectSensitive({ a: '工号 a12345678' }), { 'staff-id': true });
  assert.deepEqual(rules.detectSensitive({ a: `mail zhang.san@${corp}` }), { email: true });
  assert.deepEqual(rules.detectSensitive({ a: 'mail x@example.com' }), {});
});

test('扫描：多套一层、同名优先级、enabled:false/internal 跳过、没有 SKILL.md 的跳过、缺/超长 description', async () => {
  const s = sandbox();
  try {
    s.skill(0, '04_工时填报/itimes-timesheet', { name: 'itimes-timesheet', description: '填工时' });
    s.skill(0, 'dup', { name: 'dup-skill', description: '来自第一个根' });
    s.skill(1, 'dup', { name: 'dup-skill', description: '来自第二个根' });
    s.skill(1, 'off', { name: 'off-skill', description: 'x', meta: { enabled: false } });
    s.skill(2, 'secret', { name: 'secret-skill', description: 'x', meta: { visibility: 'internal' } });
    fs.mkdirSync(path.join(s.roots[2], 'core', 'lib'), { recursive: true });
    s.skill(2, 'nodesc', { name: 'No Desc' });
    s.skill(2, 'long', { name: 'long-desc', description: '长'.repeat(1500) });
    const list = await s.service().list();
    const ids = list.items.map(i => i.id).sort();
    assert.deepEqual(ids, ['weclaw:dup-skill', 'weclaw:itimes-timesheet', 'weclaw:long-desc', 'weclaw:no-desc']);
    assert.equal(byId(list, 'weclaw:dup-skill').description, '来自第一个根');
    assert.equal(byId(list, 'weclaw:itimes-timesheet').use, 'delegate');
    assert.equal(list.sources.weclaw.present, true);
    assert.equal(list.sources.weclaw.count, 4);
    assert.equal(list.targets.length, 3);
    assert.ok(!('_internal' in byId(list, 'weclaw:dup-skill')), '主进程内部字段不送页面');
    const svc = s.service();
    const p1 = await svc.preview({ id: 'weclaw:no-desc' });
    assert.equal(p1.targetName, 'weclaw-no-desc');
    assert.match(p1.mapping.find(m => m.key === 'description').after, /待补/);
    const p2 = await svc.preview({ id: 'weclaw:long-desc' });
    assert.ok(p2.mapping.find(m => m.key === 'description').after.length <= 1024);
    assert.match(p2.mapping.find(m => m.key === 'description').note, /截断/);
    assert.ok(!p2.migrationNotes.some(n => /截断/.test(n)), '对照表里有的不在迁移说明里重复');
    const p3 = await svc.preview({ id: 'weclaw:itimes-timesheet' });
    assert.ok(p3.migrationNotes.some(n => /拍平/.test(n)));
  } finally { s.cleanup(); }
});

test('没装员工助手（主程序和技能目录都没有）时不出现员工助手来源', async () => {
  const s = sandbox();
  try {
    const list = await s.service({ findInstall: () => '' }).list();
    assert.equal(list.sources.weclaw.present, false);
    assert.equal(list.items.length, 0);
  } finally { s.cleanup(); }
});

test('主程序装在自选目录没认出来、技能目录在：照样列出员工助手的技能（2026-11-28 反馈）', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'a', { name: 'aa', description: 'x' });
    let located = 0;
    const list = await s.service({ findInstall: () => '', locateInstall: async () => { located++; return { file: '' }; } }).list({ refresh: true });
    assert.equal(located, 0, '技能目录在就不再等一次查登记');
    assert.equal(list.sources.weclaw.present, true);
    assert.ok(byId(list, 'weclaw:aa'));
    assert.equal(list.sources.weclaw.error, undefined);
    // 预览、导入也不再因为认不出主程序而拒绝
    const p = await s.service({ findInstall: () => '' }).preview({ id: 'weclaw:aa' });
    assert.equal(p.targetName, 'weclaw-aa');
  } finally { s.cleanup(); }
});

test('默认位置没有、逐级查到主程序但还没有技能目录：来源在、给一句下一步', async () => {
  const s = sandbox();
  try {
    let forced = null;
    const list = await s.service({ findInstall: () => '', locateInstall: async o => { forced = o.force; return { file: 'D:/Apps/UniAssistant/WeClaw Desktop.exe' }; } }).list({ refresh: true });
    assert.equal(forced, true, '点「重新扫描」时强制重查');
    assert.equal(list.sources.weclaw.present, true);
    assert.equal(list.sources.weclaw.count, 0);
    assert.match(list.sources.weclaw.reason, /登录一次/);
  } finally { s.cleanup(); }
});

test('员工助手 7.11 的场景目录（scenario/<编号>/skills）也扫，主目录有的不重复', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'a', { name: 'aa', description: 'x' });
    const scen = path.join(s.home, '.config', 'weclaw', 'scenario', '0123-abcd', 'skills');
    s.write(path.join(scen, 'a', 'SKILL.md'), ['---', 'name: aa', 'description: 场景里的同名', '---', '正文', ''].join('\n'));
    s.write(path.join(scen, 'b', 'SKILL.md'), ['---', 'name: bb', 'description: 只在场景里', '---', '正文', ''].join('\n'));
    const svc = s.service({ roots: null });
    const list = await svc.list();
    assert.ok(byId(list, 'weclaw:bb'));
    assert.equal(byId(list, 'weclaw:aa').description, 'x', '同名取主目录那份');
    // 同名副本在读文件清单与正文之前就跳过（场景多时不拖慢扫描）
    const dup = source.readSkill(3, scen, 'a', new Map([['weclaw:aa', {}]]));
    assert.deepEqual(dup, { duplicate: true, entryName: 'a' });
    assert.equal(source.readSkill(3, scen, 'b', new Map([['weclaw:aa', {}]])).id, 'weclaw:bb');
  } finally { s.cleanup(); }
});

test('一路失败不拖垮整个广场：员工助手扫描失败、本机已装超时、AgentCenter 报错，各自带原因，其余照常', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'a', { name: 'aa', description: 'x' });
    const localRows = [{ type: 'skill', name: 'mine', description: 'd', sources: [{ agent: 'claude', path: path.join(s.home, '.claude', 'skills', 'mine', 'SKILL.md') }] }];
    // ① 员工助手扫描失败：本机已装照常
    const svc1 = s.service({ catalog: async () => ({ rows: localRows }) });
    svc1.run = async () => { throw new Error('读取员工助手技能超时，请刷新重试'); };
    const l1 = await svc1.list();
    assert.equal(l1.sources.weclaw.present, true);
    assert.match(l1.sources.weclaw.error, /超时/);
    assert.ok(byId(l1, 'local:mine'), '本机已装照常显示');
    assert.equal(svc1.cache, null, '有一路失败不缓存，下次打开或点重试重新读');
    // ② 本机已装卡住：限时后报原因，员工助手照常
    const svc2 = s.service({ catalog: () => new Promise(() => {}), sourceTimeoutMs: 50 });
    const l2 = await svc2.list();
    assert.match(l2.sources.local.error, /没读完/);
    assert.ok(byId(l2, 'weclaw:aa'));
    // 页面上已显示的卡片照常能点：按编号找技能用这次结果，不再等一遍卡住那一路
    let localCalls = 0;
    const svc2b = s.service({ catalog: () => { localCalls++; return new Promise(() => {}); }, sourceTimeoutMs: 50 });
    await svc2b.list();
    assert.equal((await svc2b.find('weclaw:aa')).id, 'weclaw:aa');
    assert.equal(localCalls, 1, '找已显示的技能不重扫');
    svc2b.changed();
    assert.equal(svc2b.lastById, null, '导入或移除后不用旧结果');
    // ③ AgentCenter：list 抛错 / 卡住 / CodeAgent 在但清单读失败
    const svc3 = s.service({ market: { status: () => ({ available: true }), list: async () => { throw new Error('市场文件损坏'); } } });
    const l3 = await svc3.list();
    assert.equal(l3.sources.agentcenter.present, true);
    assert.equal(l3.sources.agentcenter.error, '市场文件损坏');
    assert.ok(byId(l3, 'weclaw:aa'));
    const svc4 = s.service({ market: { status: () => ({ available: true }), list: () => new Promise(() => {}) }, sourceTimeoutMs: 50 });
    assert.match((await svc4.list()).sources.agentcenter.error, /没读完/);
    const svc5 = s.service({ market: { status: () => ({ available: true }), list: async () => ({ available: true, rows: [], reason: '读不到市场清单' }) } });
    assert.equal((await svc5.list()).sources.agentcenter.error, '读不到市场清单');
    // ④ 三路都好：照常缓存
    const svc6 = s.service({ catalog: async () => ({ rows: localRows }) });
    await svc6.list();
    assert.ok(svc6.cache);
  } finally { s.cleanup(); }
});

test('导入：转换规则、多目标、台账，再导入覆盖自己的；fix 需确认、delegate 拒绝', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'plain', { name: 'Plain_Skill', description: '整理纪要', extra: 'allowed-tools: Bash\nlicense: MIT',
      files: { 'node_modules/x/i.js': 'x', '.git/HEAD': 'x', '.register.json': '{}', 'ref/a.md': '参考' }, meta: { s3ZipKey: 'secret/key', version: '1.2' } });
    s.skill(0, 'needfix', { name: 'needfix', description: '发 WeLink 消息', body: '运行 welink-cli send\n' });
    s.skill(0, 'browser', { name: 'browser', description: 'x', files: { 'scripts/a.tool.js': 'x' } });
    const svc = s.service();
    const r = await svc.import({ id: 'weclaw:plain-skill', targets: ['claude', 'agents', 'codeagent'] });
    assert.equal(r.installed.length, 3);
    const dir = path.join(s.home, '.claude', 'skills', 'weclaw-plain-skill');
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    assert.match(md, /^---\nname: weclaw-plain-skill\ndescription: "整理纪要"\nlicense: MIT\n---\n/);
    assert.ok(!/allowed-tools/.test(md));
    const origin = JSON.parse(fs.readFileSync(path.join(dir, '_origin.json'), 'utf8'));
    assert.equal(origin.from, 'weclaw-skill-plaza');
    assert.equal(origin.original_frontmatter['allowed-tools'], 'Bash');
    assert.ok(!('s3ZipKey' in origin.skillhub_meta));
    assert.ok(fs.existsSync(path.join(dir, 'ref', 'a.md')));
    for (const gone of ['node_modules', '.git', '.register.json', '_skillhub_meta.json', 'MIGRATION.md']) assert.ok(!fs.existsSync(path.join(dir, gone)), gone);
    assert.ok(!fs.readdirSync(path.join(s.home, '.claude', 'skills')).some(n => n.startsWith('.skill-plaza-')), '不留临时目录');
    const ledger = installer.readLedger(s.data);
    assert.equal(ledger['weclaw:plain-skill'].targets.length, 3);
    const list = await svc.list({ refresh: true });
    const item = byId(list, 'weclaw:plain-skill');
    assert.equal(item.use, 'installed');
    assert.deepEqual(item.installedIn.sort(), ['agents', 'claude', 'codeagent']);
    assert.equal(item.version, '1.2');
    // 再导入：自己装的可以替换
    const again = await svc.import({ id: 'weclaw:plain-skill', targets: ['claude'] });
    assert.equal(again.installed.length, 1);
    assert.equal(installer.readLedger(s.data)['weclaw:plain-skill'].targets.length, 3);

    await assert.rejects(svc.import({ id: 'weclaw:needfix', targets: ['claude'] }), /我知道要改写/);
    const fixed = await svc.import({ id: 'weclaw:needfix', targets: ['claude'], acknowledgeRewrite: true });
    assert.equal(fixed.installed.length, 1);
    assert.match(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'weclaw-needfix', 'MIGRATION.md'), 'utf8'), /welink-cli/);
    await assert.rejects(svc.import({ id: 'weclaw:browser', targets: ['claude'], acknowledgeRewrite: true }), /交员工助手执行/);
    await assert.rejects(svc.import({ id: 'weclaw:plain-skill', targets: [] }), /至少选一个/);
    await assert.rejects(svc.import({ id: 'weclaw:plain-skill', targets: ['nope'] }), /安装位置无效/);
  } finally { s.cleanup(); }
});

test('目标已存在且不是本模块装的：跳过不覆盖；目标软件没装：跳过', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'mine', description: 'x' });
    const foreign = path.join(s.home, '.claude', 'skills', 'weclaw-mine');
    s.write(path.join(foreign, 'SKILL.md'), '用户自己的');
    fs.rmSync(path.join(s.home, '.agents'), { recursive: true });
    const r = await s.service().import({ id: 'weclaw:mine', targets: ['claude', 'agents', 'codeagent'] });
    assert.deepEqual(r.installed.map(i => i.target), ['codeagent']);
    assert.deepEqual(r.skipped.map(i => i.target).sort(), ['agents', 'claude']);
    assert.equal(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8'), '用户自己的');
  } finally { s.cleanup(); }
});

test('任一目标失败就回滚本次已装的，并恢复被替换的旧版', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'rb', description: '第一版' });
    const svc = s.service();
    await svc.import({ id: 'weclaw:rb', targets: ['claude'] });
    s.skill(0, 'x', { name: 'rb', description: '第二版' });
    svc.testHooks = { beforeRename: id => { if (id === 'agents') throw new Error('模拟写盘失败'); } };
    await assert.rejects(svc.import({ id: 'weclaw:rb', targets: ['claude', 'codeagent', 'agents'] }), /已撤回/);
    const claudeMd = fs.readFileSync(path.join(s.home, '.claude', 'skills', 'weclaw-rb', 'SKILL.md'), 'utf8');
    assert.match(claudeMd, /第一版/);
    assert.ok(!fs.existsSync(path.join(s.home, '.cac', 'skills', 'weclaw-rb')));
    assert.ok(!fs.existsSync(path.join(s.home, '.agents', 'skills', 'weclaw-rb')));
    for (const d of [path.join(s.home, '.claude', 'skills'), path.join(s.home, '.cac', 'skills'), path.join(s.home, '.agents', 'skills')])
      if (fs.existsSync(d)) assert.ok(!fs.readdirSync(d).some(n => n.startsWith('.skill-plaza-')), d);
    assert.equal(installer.readLedger(s.data)['weclaw:rb'].targets.length, 1);
  } finally { s.cleanup(); }
});

test('移除只删台账登记且带本模块标记的目录；篡改的台账路径不删', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'rm', description: 'x' });
    const svc = s.service();
    await svc.import({ id: 'weclaw:rm', targets: ['claude', 'agents'] });
    // agents 那份被用户换成自己的（去掉标记）
    fs.rmSync(path.join(s.home, '.agents', 'skills', 'weclaw-rm', '_origin.json'));
    const victim = path.join(s.base, 'victim', 'weclaw-evil');
    s.write(path.join(victim, '_origin.json'), JSON.stringify({ from: 'weclaw-skill-plaza', id: 'weclaw:rm' }));
    const ledger = installer.readLedger(s.data);
    ledger['weclaw:rm'].targets.push({ target: 'claude', dir: victim });
    installer.writeLedger(s.data, ledger);
    const r = await svc.remove({ id: 'weclaw:rm' });
    assert.deepEqual(r.removed.map(x => x.target), ['claude']);
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'skills', 'weclaw-rm')));
    assert.ok(fs.existsSync(path.join(s.home, '.agents', 'skills', 'weclaw-rm', 'SKILL.md')), '没标记的不删');
    assert.ok(fs.existsSync(victim), '技能目录以外的不删');
    assert.equal(r.kept.length, 2);
    await assert.rejects(svc.remove({ id: 'local:abc' }), /只能移除/);
    await assert.rejects(svc.remove({ id: 'weclaw:none' }), /台账里没有/);
  } finally { s.cleanup(); }
});

test('路径穿越、符号链接/联接、超限都拒绝', async () => {
  const s = sandbox();
  try {
    const outside = path.join(s.base, 'outside');
    s.write(path.join(outside, 'SKILL.md'), '---\nname: linked\ndescription: x\n---\n');
    s.write(path.join(outside, 'secret.txt'), '机密');
    fs.mkdirSync(s.roots[0], { recursive: true });
    fs.symlinkSync(outside, path.join(s.roots[0], 'linked'), 'junction');
    const inner = s.skill(0, 'inner', { name: 'inner', description: 'x' });
    fs.symlinkSync(outside, path.join(inner, 'escape'), 'junction');
    const big = s.skill(1, 'big', { name: 'big', description: 'x' });
    for (let i = 0; i < source.LIMIT_FILES + 1; i++) fs.writeFileSync(path.join(big, `f${i}.bin`), '');
    const svc = s.service();
    const list = await svc.list();
    assert.ok(!byId(list, 'weclaw:linked'), '链接进来的技能目录不扫');
    const p = await svc.preview({ id: 'weclaw:inner' });
    assert.ok(p.migrationNotes.some(n => /链接/.test(n)));
    await svc.import({ id: 'weclaw:inner', targets: ['claude'] });
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'skills', 'weclaw-inner', 'escape')), '不跟随内部链接');
    await assert.rejects(svc.import({ id: 'weclaw:big', targets: ['claude'] }), /超过 2000 个文件/);
    await assert.rejects(svc.preview({ id: 'weclaw:../../outside' }), /找不到/);
    await assert.rejects(svc.import({ id: '../x', targets: ['claude'] }), /找不到/);
    // 安装目标本身是联接：不写入
    fs.rmSync(path.join(s.home, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(s.base, 'elsewhere'));
    fs.symlinkSync(path.join(s.base, 'elsewhere'), path.join(s.home, '.claude', 'skills'), 'junction');
    const r = await svc.import({ id: 'weclaw:inner', targets: ['claude'] });
    assert.equal(r.installed.length, 0);
    assert.match(r.skipped[0].reason, /链接/);
    assert.deepEqual(fs.readdirSync(path.join(s.base, 'elsewhere')), []);
  } finally { s.cleanup(); }
});

test('本机已装与 AgentCenter 两路拼进清单；导入走现有市场安装；委托写剪贴板并打开员工助手', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'd', { name: 'skill-todo-worker', description: '待办' });
    const calls = { clip: '', url: '', install: '' , manage: 0 };
    const svc = s.service({
      catalog: async () => ({ rows: [
        { type: 'skill', name: 'git-helper', description: '代码提交', sources: [{ agent: 'claude', scope: 'user', path: 'C:/h/.claude/skills/git-helper/SKILL.md' }, { agent: 'codex', scope: 'shared', path: 'C:/h/.agents/skills/git-helper/SKILL.md' }] },
        { type: 'skill', name: 'proj-only', sources: [{ agent: 'claude', scope: 'project:C:/p' }] },
        { type: 'mcp', name: 'm', sources: [{ agent: 'claude', scope: 'user' }] },
      ] }),
      market: { list: async () => ({ available: true, rows: [{ id: 'skill:ppt-maker', type: 'skill', name: 'ppt-maker', description: '做 PPT', installed: false, version: '2' }, { id: 'mcp:x', type: 'mcp', name: 'x' }] }),
        install: async id => { calls.install = id; return { installed: true, message: '已安装' }; } },
      writeClipboard: t => { calls.clip = t; }, openExternal: async u => { calls.url = u; }, openManage: () => { calls.manage++; },
    });
    const list = await svc.list();
    const local = byId(list, 'local:git-helper');
    assert.equal(local.use, 'installed');
    assert.deepEqual(local.installedIn.sort(), ['agents', 'claude']);
    assert.equal(local.category, 'dev');
    assert.ok(!byId(list, 'local:proj-only') && !byId(list, 'local:m'));
    const market = byId(list, 'agentcenter:skill:ppt-maker');
    assert.equal(market.category, 'ppt');
    assert.equal(market.marketId, 'skill:ppt-maker');
    assert.deepEqual(list.sources.agentcenter, { present: true, count: 1 });
    const r = await svc.import({ id: 'agentcenter:skill:ppt-maker', targets: ['codeagent'] });
    assert.equal(calls.install, 'skill:ppt-maker');
    assert.equal(r.installed[0].target, 'codeagent');
    await assert.rejects(svc.import({ id: 'local:git-helper', targets: ['claude'] }), /资源 → 工具/);
    const d = await svc.delegate({ id: 'weclaw:skill-todo-worker' });
    assert.equal(d.opened, true);
    assert.equal(calls.url, 'weclaw://home/chat');
    assert.equal(calls.clip, d.prompt);
    assert.match(d.prompt, /skill-todo-worker/);
    svc.openManage();
    assert.equal(calls.manage, 1);
  } finally { s.cleanup(); }
});

test('IPC：统一 {ok,data}/{ok:false,error} 返回', async () => {
  const handlers = {};
  registerSkillPlazaIpc({ handle: (ch, fn) => { handlers[ch] = fn; } }, () => ({
    list: async ({ refresh }) => ({ refresh }), preview: async () => { throw new Error('找不到这个技能'); },
    import: async a => a, remove: async a => a, delegate: async a => a, openManage: () => ({ opened: true }) }));
  assert.deepEqual(Object.keys(handlers).sort(), ['skill-plaza:delegate', 'skill-plaza:import', 'skill-plaza:list', 'skill-plaza:open-manage', 'skill-plaza:preview', 'skill-plaza:remove']);
  assert.deepEqual(await handlers['skill-plaza:list']({}, { refresh: true }), { ok: true, data: { refresh: true } });
  assert.deepEqual(await handlers['skill-plaza:preview']({}, { id: 'x' }), { ok: false, error: '找不到这个技能' });
  assert.deepEqual((await handlers['skill-plaza:import']({}, { id: 'a', targets: ['claude'], acknowledgeRewrite: 'yes' })).data, { id: 'a', targets: ['claude'], acknowledgeRewrite: false });
  assert.deepEqual(await handlers['skill-plaza:open-manage']({}, undefined), { ok: true, data: { opened: true } });
  const none = {}; registerSkillPlazaIpc({ handle: (ch, fn) => { none[ch] = fn; } }, () => null);
  assert.equal((await none['skill-plaza:list']({}, {})).ok, false);
});

// ---------------------------------------------------------------- 复审 r1 的 8 项回归（Codex 只读复审，2026-11-27）
const fsStub = over => ({ ...fs, ...over });
const errno = code => Object.assign(new Error(code), { code });

test('r1-1 台账写失败：连同落位一起回滚，旧版保留', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'lg', description: '第一版' });
    await s.service().import({ id: 'weclaw:lg', targets: ['claude'] });
    s.skill(0, 'x', { name: 'lg', description: '第二版' });
    const before = fs.readFileSync(installer.ledgerPath(s.data), 'utf8');
    const svc = s.service({ fs: fsStub({ writeFileSync: (f, ...a) => { if (String(f).includes('imports.json')) throw errno('ENOSPC'); return fs.writeFileSync(f, ...a); } }) });
    await assert.rejects(svc.import({ id: 'weclaw:lg', targets: ['claude', 'codeagent'] }), /已撤回[\s\S]*写导入台账失败/);
    assert.match(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'weclaw-lg', 'SKILL.md'), 'utf8'), /第一版/);
    assert.ok(!fs.existsSync(path.join(s.home, '.cac', 'skills', 'weclaw-lg')));
    assert.ok(!fs.readdirSync(path.join(s.home, '.claude', 'skills')).some(n => n.startsWith('.skill-plaza-')), '旧版备份已挪回');
    assert.equal(fs.readFileSync(installer.ledgerPath(s.data), 'utf8'), before);
  } finally { s.cleanup(); }
});

test('r1-2 不同技能规范成同名目录：一律跳过；有标记但台账没登记的也不替换', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'a', { name: 'foo', description: 'A' });
    s.skill(0, 'b', { name: 'weclaw-foo', description: 'B' });
    const svc = s.service();
    await svc.import({ id: 'weclaw:foo', targets: ['claude'] });
    const r = await svc.import({ id: 'weclaw:weclaw-foo', targets: ['claude'] });
    assert.equal(r.installed.length, 0);
    assert.match(r.skipped[0].reason, /另一个员工助手技能/);
    assert.match(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'weclaw-foo', 'SKILL.md'), 'utf8'), /"A"/);
    fs.rmSync(installer.ledgerPath(s.data));
    const r2 = await svc.import({ id: 'weclaw:foo', targets: ['claude'] });
    assert.equal(r2.installed.length, 0);
    assert.match(r2.skipped[0].reason, /台账里没有记录/);
  } finally { s.cleanup(); }
});

test('r1-3 移除：技能目录是联接时不删（不穿过联接删外部目录）', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'jn', description: 'x' });
    const svc = s.service();
    await svc.import({ id: 'weclaw:jn', targets: ['claude'] });
    const skills = path.join(s.home, '.claude', 'skills'), elsewhere = path.join(s.base, 'elsewhere-skills');
    fs.renameSync(skills, elsewhere);
    fs.symlinkSync(elsewhere, skills, 'junction');
    const r = await svc.remove({ id: 'weclaw:jn' });
    assert.equal(r.removed.length, 0);
    assert.match(r.reasons[0], /链接/);
    assert.ok(fs.existsSync(path.join(elsewhere, 'weclaw-jn', 'SKILL.md')), '联接指向的外部目录没被删');
    assert.ok(installer.readLedger(s.data)['weclaw:jn'], '没删成的留在台账');
  } finally { s.cleanup(); }
});

test('r1-4 复制前重核源路径：扫描后子目录换成联接、文件大小变了都停', async () => {
  const s = sandbox();
  try {
    const root = s.skill(0, 'x', { name: 'swap', description: 'x', files: { 'ref/a.md': '1234' } });
    const outside = path.join(s.base, 'outside-ref');
    s.write(path.join(outside, 'a.md'), '1234');
    const svc = s.service();
    const item = source.scanWeclaw(s.home, { roots: s.roots }).items.find(i => i.id === 'weclaw:swap');
    fs.rmSync(path.join(root, 'ref'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'ref'), 'junction');
    const target = svc.targets().find(t => t.id === 'claude');
    assert.throws(() => installer.install(item, installer.plan(item), [target]), /已撤回[\s\S]*链接/);
    assert.ok(!fs.existsSync(path.join(target.dir, 'weclaw-swap')));
    fs.rmSync(path.join(root, 'ref'));
    s.write(path.join(root, 'ref', 'a.md'), '12345678');
    assert.throws(() => installer.install(item, installer.plan(item), [target]), /变了/);
  } finally { s.cleanup(); }
});

test('r1-5 回滚删不掉时如实报告残留与备份位置', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'stuck', description: 'v1' });
    await s.service().import({ id: 'weclaw:stuck', targets: ['claude'] });
    const svc = s.service({ fs: fsStub({ rmSync: (p, o) => { if (path.basename(String(p)) === 'weclaw-stuck') throw errno('EBUSY'); return fs.rmSync(p, o); } }) });
    svc.testHooks = { beforeRename: id => { if (id === 'codeagent') throw new Error('模拟写盘失败'); } };
    const err = await svc.import({ id: 'weclaw:stuck', targets: ['claude', 'codeagent'] }).catch(e => e);
    assert.match(err.message, /撤回没有做完/);
    assert.ok(err.residue.some(r => r.path.endsWith('weclaw-stuck')));
    const backup = err.residue.find(r => /旧版备份/.test(r.what));
    assert.ok(backup && fs.existsSync(backup.path), '旧版备份保留并给出位置');
    assert.ok(err.message.includes(backup.path));
  } finally { s.cleanup(); }
});

test('r1-6 超 2 MB 的文件按文件名判依赖；正文没扫到的不判「直接用」', async () => {
  const s = sandbox();
  try {
    const big = 'x'.repeat(2 * 1024 * 1024 + 10);
    s.skill(0, 'b', { name: 'bigbrowser', description: 'x', files: { 'scripts/run.tool.js': big } });
    s.skill(0, 'n', { name: 'bignotes', description: 'x', files: { 'notes.md': big } });
    const svc = s.service();
    const list = await svc.list();
    assert.equal(byId(list, 'weclaw:bigbrowser').use, 'delegate');
    const notes = byId(list, 'weclaw:bignotes');
    assert.equal(notes.use, 'fix');
    assert.ok(notes.deps.some(d => d.key === 'unscanned' && d.files.includes('notes.md')));
    await assert.rejects(svc.import({ id: 'weclaw:bignotes', targets: ['claude'] }), /我知道要改写/);
    await svc.import({ id: 'weclaw:bignotes', targets: ['claude'], acknowledgeRewrite: true });
    assert.match(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'weclaw-bignotes', 'MIGRATION.md'), 'utf8'), /没有检查正文/);
  } finally { s.cleanup(); }
});

test('r1-7 台账损坏另存 .corrupt-<时间> 并报错，不当空台账覆盖；无权限单独报错', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'cr', description: 'x' });
    const file = installer.ledgerPath(s.data);
    s.write(file, '{ 坏了');
    const svc = s.service();
    assert.equal((await svc.list()).items.length, 1, '列表照常');
    await assert.rejects(svc.import({ id: 'weclaw:cr', targets: ['claude'] }), /已损坏[\s\S]*corrupt-/);
    const kept = fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('imports.json.corrupt-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ 坏了');
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'skills', 'weclaw-cr')), '台账坏了不落位');
    s.write(file, JSON.stringify({ 'weclaw:cr': { targets: 'bad' } }));
    await assert.rejects(svc.remove({ id: 'weclaw:cr' }), /已损坏/);
    s.write(file, '{}');
    const denied = s.service({ fs: fsStub({ readFileSync: (f, ...a) => { if (String(f) === file) throw errno('EACCES'); return fs.readFileSync(f, ...a); } }) });
    await assert.rejects(denied.import({ id: 'weclaw:cr', targets: ['claude'] }), /没有权限/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{}', '无权限时不动原文件');
  } finally { s.cleanup(); }
});

test('r1-8 文件数与字节上限按最终产物（含 _origin.json、MIGRATION.md）核算', async () => {
  const s = sandbox();
  try {
    const root = s.skill(0, 'x', { name: 'edge', description: 'x' });
    for (let i = 0; i < source.LIMIT_FILES - 1; i++) fs.writeFileSync(path.join(root, `f${i}.bin`), '');
    const p = await s.service().preview({ id: 'weclaw:edge' });
    assert.equal(p.fileCount, source.LIMIT_FILES + 1);
    assert.equal(p.tooLarge, true);
    await assert.rejects(s.service().import({ id: 'weclaw:edge', targets: ['claude'] }), /超过 2000 个文件/);
    fs.rmSync(path.join(root, 'f0.bin'));
    const ok = await s.service().import({ id: 'weclaw:edge', targets: ['claude'] });
    assert.equal(ok.installed.length, 1);
    assert.equal(fs.readdirSync(path.join(s.home, '.claude', 'skills', 'weclaw-edge')).length, source.LIMIT_FILES);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- 复审 r2（Codex 复审 + Antigravity 审查，2026-11-27）
const { OPS } = require('../core/skill-plaza/ops');

test('r2-agy3 扫描、预览、导入、移除都在 Worker 里跑，主线程不调用重活', async () => {
  const s = sandbox();
  const original = { ...OPS };
  let mainThreadCalls = 0;
  for (const k of Object.keys(OPS)) OPS[k] = (...a) => { mainThreadCalls++; return original[k](...a); };
  try {
    s.skill(0, 'x', { name: 'wk', description: 'x' });
    const svc = s.service();
    assert.equal(byId(await svc.list(), 'weclaw:wk').use, 'ok');
    assert.equal((await svc.preview({ id: 'weclaw:wk' })).targetName, 'weclaw-wk');
    assert.equal((await svc.import({ id: 'weclaw:wk', targets: ['claude'] })).installed.length, 1);
    assert.equal((await svc.remove({ id: 'weclaw:wk' })).removed.length, 1);
    assert.equal(mainThreadCalls, 0);
    await assert.rejects(svc.import({ id: 'weclaw:none', targets: ['claude'] }), /找不到这个技能/, 'Worker 里的报错原样带回');
  } finally { Object.assign(OPS, original); s.cleanup(); }
});

test('r2-agy5 导入/移除后清掉本机已装缓存并重扫，已删的技能不会以「本机·已装」冒出来', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'ghost', description: 'x' });
    let stale = null, invalidated = 0;
    const skills = path.join(s.home, '.claude', 'skills');
    const scanDisk = () => ({ rows: (fs.existsSync(skills) ? fs.readdirSync(skills) : []).filter(n => !n.startsWith('.'))
      .map(n => ({ type: 'skill', name: n, sources: [{ agent: 'claude', scope: 'user', path: path.join(skills, n, 'SKILL.md') }] })) });
    // 模拟能力目录的 30 秒缓存：refresh=false 时给上次的结果
    const catalog = async refresh => { if (refresh || !stale) stale = scanDisk(); return stale; };
    const svc = s.service({ catalog, invalidateCatalog: () => { invalidated++; stale = null; } });
    await svc.import({ id: 'weclaw:ghost', targets: ['claude'] });
    await svc.list();
    await svc.remove({ id: 'weclaw:ghost' });
    assert.equal(invalidated, 2);
    const list = await svc.list();
    assert.ok(!byId(list, 'local:weclaw-ghost'), '没有幽灵卡');
    assert.equal(byId(list, 'weclaw:ghost').use, 'ok');
  } finally { s.cleanup(); }
});

test('r2-agy6 对照表与迁移说明只用中文字段名，未映射的头字段也是中文说明', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'CN_Fields', extra: 'allowed-tools: Bash\nweird-key: 1', body: '运行 welink-cli\n' });
    const p = await s.service().preview({ id: 'weclaw:cn-fields' });
    const keys = ['name', 'description', 'license', 'allowed-tools', 'weird-key'];
    for (const m of p.mapping) {
      assert.ok(!/[A-Za-z]/.test(m.field), `字段名应为中文：${m.field}`);
      for (const k of keys) assert.ok(!String(m.note).includes(k), `说明里不出现英文键名 ${k}：${m.note}`);
    }
    assert.deepEqual(p.mapping.map(m => m.key), ['name', 'description', 'allowed-tools', 'weird-key']);
    assert.equal(p.mapping.find(m => m.key === 'weird-key').field, '其他设置');
    for (const n of p.migrationNotes) for (const k of ['name', 'description', 'allowed-tools', 'weird-key']) assert.ok(!n.includes(k + '：'), n);
  } finally { s.cleanup(); }
});

test('r2-s4 没有 CodeAgent：AgentCenter 那一路说清是缺 CodeAgent', async () => {
  const s = sandbox();
  try {
    const svc = s.service({ market: { status: () => ({ available: false }), list: async () => { throw new Error('不该调'); }, install: async () => { throw new Error('不该调'); } } });
    const list = await svc.list();
    assert.equal(list.sources.agentcenter.present, false);
    assert.match(list.sources.agentcenter.reason, /没装 CodeAgent/);
    await assert.rejects(svc.import({ id: 'agentcenter:skill:x', targets: ['codeagent'] }), /没装 CodeAgent/);
  } finally { s.cleanup(); }
});

test('r2-s5 台账与目录标记对不上：移除给出可读原因并保留目录，不报错', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'orph', description: 'x' });
    const svc = s.service();
    await svc.import({ id: 'weclaw:orph', targets: ['claude'] });
    fs.rmSync(installer.ledgerPath(s.data));
    const r = await svc.remove({ id: 'weclaw:orph' });
    assert.equal(r.removed.length, 0);
    assert.match(r.reasons[0], /台账里没有这个技能的记录[\s\S]*手动删除/);
    assert.equal(r.kept[0].target, 'claude');
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'weclaw-orph')));
    await assert.rejects(svc.remove({ id: 'weclaw:never' }), /本机也没找到/);
  } finally { s.cleanup(); }
});

test('r2-codex3/4 目标与源路径的任一上级是联接：导入跳过、移除不删、复制前拦下', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'anc', description: 'x' });
    // 目标侧：上级 .claude 换成联接
    await s.service().import({ id: 'weclaw:anc', targets: ['claude'] });
    const claude = path.join(s.home, '.claude'), moved = path.join(s.base, 'claude-elsewhere');
    fs.renameSync(claude, moved);
    fs.symlinkSync(moved, claude, 'junction');
    const r = await s.service().remove({ id: 'weclaw:anc' });
    assert.equal(r.removed.length, 0);
    assert.match(r.reasons[0], /链接/);
    assert.ok(fs.existsSync(path.join(moved, 'skills', 'weclaw-anc', 'SKILL.md')));
    const again = await s.service().import({ id: 'weclaw:anc', targets: ['claude'] });
    assert.equal(again.installed.length, 0);
    assert.match(again.skipped[0].reason, /链接/);
    // 更上级：整个 home 经联接访问
    const userDirJunction = path.join(s.base, 'userdir-junction');
    fs.symlinkSync(s.home, userDirJunction, 'junction');
    const viaLink = new SkillPlazaService({ dataDir: s.data, homeDir: userDirJunction, findInstall: () => 'x', log: () => {}, roots: s.roots });
    const r2 = await viaLink.import({ id: 'weclaw:anc', targets: ['agents', 'codeagent'] });
    assert.equal(r2.installed.length, 0);
    assert.ok(r2.skipped.every(k => /链接/.test(k.reason)));
    // 源侧：技能根所在的上级目录是联接
    const srcLink = path.join(s.base, 'src-link');
    fs.symlinkSync(path.dirname(s.roots[0]), srcLink, 'junction');
    const viaSrc = s.service({ roots: [path.join(srcLink, path.basename(s.roots[0]))] });
    await assert.rejects(viaSrc.import({ id: 'weclaw:anc', targets: ['agents'] }), /源技能目录的路径上出现了链接/);
    assert.ok(!fs.existsSync(path.join(s.home, '.agents', 'skills', 'weclaw-anc')));
  } finally { s.cleanup(); }
});

test('r2-codex7 损坏台账的备份名唯一，已有备份不被覆盖', async () => {
  const s = sandbox();
  try {
    const file = installer.ledgerPath(s.data);
    const dir = path.dirname(file);
    s.write(file, '坏1');
    assert.throws(() => installer.readLedger(s.data, { strict: true }), /已损坏/);
    s.write(file, '坏2');
    // 第一次挑的备份名「已存在」：换名再试，原有文件不动
    let first = true;
    const stub = fsStub({ copyFileSync: (a, b, m) => { if (first) { first = false; fs.writeFileSync(b, '别人的备份'); throw errno('EEXIST'); } return fs.copyFileSync(a, b, m); } });
    assert.throws(() => installer.readLedger(s.data, { strict: true, fs: stub }), /已损坏/);
    const kept = fs.readdirSync(dir).filter(n => n.includes('.corrupt-')).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).sort();
    assert.deepEqual(kept, ['别人的备份', '坏1', '坏2']);
    assert.ok(!fs.existsSync(file));
  } finally { s.cleanup(); }
});

test('r2-codexP1 临时目录创建失败（已存在）时绝不删那个目录', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'eex', description: 'x' });
    let squatted = '';
    const stub = fsStub({ mkdirSync: (p, o) => {
      if (path.basename(String(p)).startsWith('.skill-plaza-tmp-')) {
        fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'other.txt'), '别人的'); squatted = p; throw errno('EEXIST');
      }
      return fs.mkdirSync(p, o);
    } });
    await assert.rejects(s.service({ fs: stub }).import({ id: 'weclaw:eex', targets: ['claude'] }), /EEXIST/);
    assert.equal(fs.readFileSync(path.join(squatted, 'other.txt'), 'utf8'), '别人的');
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'skills', 'weclaw-eex')));
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- 复审 r3（Codex，2026-11-27）
test('r3-P1 并发导入按数据目录串行：多个服务实例同时导入，台账一条不丢', async () => {
  const s = sandbox();
  try {
    const names = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    for (const n of names) s.skill(0, n, { name: n, description: 'x' });
    const a = s.service(), b = s.service();
    const results = await Promise.all(names.map((n, i) => (i % 2 ? a : b).import({ id: 'weclaw:' + n, targets: ['claude', 'agents'] })));
    assert.ok(results.every(r => r.installed.length === 2));
    const ledger = installer.readLedger(s.data, { strict: true });
    assert.deepEqual(Object.keys(ledger).sort(), names.map(n => 'weclaw:' + n));
    await a.whenIdle();
  } finally { s.cleanup(); }
});

test('r3-P2 界面等待超时先回「仍在后台进行」；任务真正结束时照样清缓存并通知界面刷新', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'slow', description: 'x' });
    const events = [];
    let invalidated = 0;
    const svc = s.service({ writeUiWaitMs: 20, onChanged: e => events.push(e), invalidateCatalog: () => { invalidated++; } });
    await svc.list();
    const realRun = svc.run.bind(svc);
    svc.run = (op, ctx) => new Promise(resolve => setTimeout(resolve, 150)).then(() => realRun(op, ctx));
    const r = await svc.import({ id: 'weclaw:slow', targets: ['claude'] });
    assert.equal(r.pending, true);
    assert.match(r.message, /仍在后台进行/);
    assert.equal(events.length, 0, '超时时还没结束，不发完成事件');
    assert.ok(svc.cache, '还没结束时缓存未清');
    await svc.whenIdle();
    assert.deepEqual(events, [{ op: 'import', id: 'weclaw:slow', ok: true }]);
    assert.equal(invalidated, 1);
    assert.equal(svc.cache, null);
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'weclaw-slow', 'SKILL.md')));
    assert.equal(byId(await svc.list(), 'weclaw:slow').use, 'installed');
    // 失败的任务结束时也通知，带上原因
    const rm = svc.remove({ id: 'weclaw:none' });
    await assert.rejects(rm.then(x => { if (x.pending) return svc.whenIdle().then(() => { throw new Error(events.at(-1).error); }); return x; }), /本机也没找到/);
    assert.equal(events.at(-1).ok, false);
  } finally { s.cleanup(); }
});

test('r4-agy2 列表刷新期间有导入写完：丢弃这次结果、不回写缓存、不清脏标记，按新状态重扫', async () => {
  const s = sandbox();
  try {
    s.skill(0, 'x', { name: 'race', description: 'x' });
    let release, gate = new Promise(r => { release = r; });
    const calls = [];
    const catalog = async refresh => { calls.push(refresh); if (calls.length === 1) await gate; return { rows: [] }; };
    const svc = s.service({ catalog });
    const listing = svc.list();                       // 第一次刷新卡在「本机已装」那一路
    while (!calls.length) await new Promise(r => setTimeout(r, 5));
    const r = await svc.import({ id: 'weclaw:race', targets: ['claude'] });
    if (r.pending) await svc.whenIdle();
    const gen = svc.generation;
    release();
    const list = await listing;
    assert.equal(byId(list, 'weclaw:race').use, 'installed', '返回的是写完之后的状态');
    assert.equal(calls.length, 2);
    assert.equal(calls[1], true, '重扫时本机已装那一路强制刷新');
    assert.equal(svc.generation, gen);
    assert.equal(svc.localDirty, false, '新结果成功落缓存后才清脏标记');
    assert.equal(byId(await svc.list(), 'weclaw:race').use, 'installed', '缓存里存的是新结果');
    assert.equal(calls.length, 2, '第二次列表走缓存');
  } finally { s.cleanup(); }
});
