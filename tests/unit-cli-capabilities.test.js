'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const caps = require('../core/cli-capabilities');
const probes = require('../core/codeagent-capabilities');
const help = version => fs.readFileSync(path.join(__dirname, 'fixtures', 'cli-help', `claude-${version}.txt`), 'utf8');

for (const [version, expected] of [['2.1.50', 'high'], ['2.1.269', 'max']]) {
  test(`Claude ${version} 的帮助枚举决定最高思考档 ${expected}`, () => {
    assert.equal(caps.selectEffort('max', help(version)), expected);
    assert.equal(caps.selectEffort('low', help(version)), 'low');
    const fileArgs = ['--system-prompt-file','scene.txt','--append-system-prompt-file','rules.txt'];
    assert.deepEqual(probes.filterArgs(fileArgs, help(version)).args, fileArgs, '文件形式的隐藏系统提示参数按帮助中的同族别名保留');
  });
}
test('Commander choices 和换行也识别；无枚举、无帮助保留档位，无 effort 不传', () => {
  assert.deepEqual(caps.optionValues('--effort <level>  Effort (choices: "low",\n    "medium", "high")\n --model <id>', '--effort'), ['low', 'medium', 'high']);
  assert.equal(caps.selectEffort('max', '--effort <level>'), 'max');
  assert.equal(caps.selectEffort('max', ''), 'max');
  assert.equal(caps.selectEffort('max', '--model <id>'), null);
});

test('effort 只能从请求档往下降，无可用低档则省略；尾部缺值不产生 undefined', async t => {
  const higherOnly = '--effort <level> (choices: "high", "max")';
  assert.equal(caps.selectEffort('medium', higherOnly), null);
  assert.equal(caps.selectEffort('high', '--effort <level> (choices: "low", "max")'), 'low');
  probes._helpCache.clear();
  t.after(() => probes._helpCache.clear());
  await caps.prepareForKind('claude', { platform: 'linux', exec: (file, args, options, callback) => {
    setImmediate(() => callback(null, args.at(-1) === '--help' ? higherOnly + '\n--model <id>' : '2.1.50'));
    return { on() {} };
  } });
  assert.deepEqual(caps.filterArgs('claude', ['--effort', 'medium', '--model', 'opus']).args, ['--model', 'opus']);
  assert.deepEqual(caps.filterArgs('claude', ['--effort']).args, []);
  assert.deepEqual(caps.filterArgs('claude', ['--effort', '--model', 'opus']).args, ['--model', 'opus']);
});

test('tested range uses semver prerelease ordering and preserves version suffixes', async t => {
  probes._helpCache.clear();
  t.after(() => probes._helpCache.clear());
  for (const [version, tested] of [['0.159.0-rc.1', false], ['0.169.0+build.2', true], ['0.169.1-rc.1', false]]) {
    const command = 'test-codex-' + version;
    await probes.prepare(command, { platform: 'linux', exec: (file, args, options, callback) => {
      setImmediate(() => callback(null, args.at(-1) === '--help' ? '--model <id>' : version));
      return { on() {} };
    } });
    assert.equal(caps.snapshot('codex', { command }).version, version);
    assert.equal(caps.snapshot('codex', { command }).tested, tested);
  }
});
test('Claude/Codex/DSH 共用后台能力表和隐藏探测；未知版本不阻断', async t => {
  const calls = [];
  const exec = (file, args, options, callback) => {
    calls.push({file, args, options});
    setImmediate(() => callback(null, args.at(-1).endsWith('--help') ? help('2.1.50') : '2.1.50'));
    return { on() {} };
  };
  probes._helpCache.clear();
  t.after(() => probes._helpCache.clear());
  for (const kind of ['claude', 'codex']) await caps.prepareForKind(kind, {exec, platform:'linux'});
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.options.windowsHide === true));
  assert.deepEqual(caps.snapshot('claude').values['--effort'], ['low', 'medium', 'high']);
  assert.equal(caps.snapshot('claude').version, '2.1.50');
  assert.equal(caps.snapshot('claude').tested, true);
  assert.equal(caps.snapshot('codex', {platform:'linux'}).tested, false);
  assert.match(caps.snapshot('codex', {platform:'linux'}).compatibilityNotice, /未经测试/);
  assert.equal(caps.snapshot('deepseek-acp').tested, null);
  assert.deepEqual(caps.filterArgs('claude', ['--model', 'opus', '--effort', 'max', '--disable-update']).args, ['--model', 'opus', '--effort', 'high']);
  assert.match(caps.effortNotice('max'), /最高档 high/);
  assert.equal(caps.commandForKind('deepseek-claude-resume'), 'claude');
});
test('程序替换后旧版本和帮助均失效', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-caps-'));
  const command = path.join(dir, 'codex.cmd');
  fs.writeFileSync(command, 'old');
  t.after(() => { probes._helpCache.clear(); fs.rmSync(dir, {recursive:true, force:true}); });
  await probes.prepare(command, {platform:'linux', exec: (file,args,options,callback) => {
    setImmediate(() => callback(null, args[0] === '--version' ? '0.159.0' : '--model <id>'));
    return {on(){}};
  }});
  assert.equal(caps.snapshot('codex', {command}).tested, true);
  fs.writeFileSync(command, 'replaced executable');
  assert.equal(caps.snapshot('codex', {command}).tested, null);
  assert.equal(caps.snapshot('codex', {command}).version, '');
});
test('PATH 旧版与实际选中新版并存时，Codex 按选中的程序探测和判定', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-selected-caps-'));
  const oldDir = path.join(dir,'old'), newDir = path.join(dir,'new');
  fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
  const oldCli = path.join(oldDir,'codex.exe'), newCli = path.join(newDir,'codex.exe');
  fs.writeFileSync(oldCli,'old'); fs.writeFileSync(newCli,'new-binary');
  const env = {PATH:oldDir, CODEX_INSTALL_DIR:newDir};
  t.after(() => { probes._helpCache.clear(); fs.rmSync(dir,{recursive:true,force:true}); });
  const exec = (file,args,options,callback) => {
    const invocation = args.join(' ');
    assert.ok(invocation.includes(newCli), '不应探测 PATH 上的旧版');
    setImmediate(() => callback(null, invocation.endsWith('--version') ? '0.170.0' : '--model <model>'));
    return {on(){}};
  };
  await caps.prepareForKind('codex',{env,platform:'win32',exec});
  assert.equal(caps.commandForKind('codex',{env,platform:'win32'}),newCli);
  assert.equal(caps.snapshot('codex',{env,platform:'win32'}).version,'0.170.0');
  assert.equal(caps.snapshot('codex',{env,platform:'win32'}).tested,false);
  assert.equal(probes._helpCache.has('codex'),false);
});
test('DSH 按实际 Node+entryPath 探测，Node 升级立即使旧帮助失效', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dsh-selected-caps-'));
  const modules = path.join(dir,'node_modules'), packageRoot = path.join(modules,'@deepseek-ai','dsh');
  fs.mkdirSync(packageRoot,{recursive:true});
  const entryPath=path.join(packageRoot,'bin.js'), nodePath=path.join(dir,'node.exe');
  fs.writeFileSync(entryPath,'entry'); fs.writeFileSync(nodePath,'node');
  fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({version:'1.2.3'}));
  t.mock.method(require('../core/hub-config'),'getConfig',()=>({acp:{nodePath}}));
  t.mock.method(require('../core/dsh-cli-profile'),'resolveDshCliRuntime',()=>({modules,entryPath,root:dir}));
  t.after(()=>{probes._helpCache.clear();fs.rmSync(dir,{recursive:true,force:true});});
  const calls=[];
  let displayedVersion='1.2.3';
  const exec=(file,args,options,callback)=>{
    calls.push({file,args,options});
    assert.equal(file,nodePath); assert.equal(args[0],entryPath); assert.equal(options.windowsHide,true);
    setImmediate(()=>callback(null,args.at(-1)==='--version'?displayedVersion:'--mode <mode> (choices: "safe", "native")'));
    return {on(){}};
  };
  await caps.prepareForKind('deepseek-acp',{exec,platform:'win32'});
  assert.equal(calls.length,2);
  assert.deepEqual(caps.snapshot('deepseek-acp').values['--mode'],['safe','native']);
  assert.equal(caps.snapshot('deepseek-acp').command,entryPath);
  assert.equal(caps.snapshot('deepseek-acp').version,'1.2.3');
  fs.writeFileSync(nodePath,'upgraded node executable');
  assert.deepEqual(caps.snapshot('deepseek-acp').flags,[]);
  await caps.prepareForKind('deepseek-acp',{exec,platform:'win32'});
  assert.equal(calls.length,4);
  displayedVersion='1.2.33';
  fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({version:displayedVersion}));
  assert.deepEqual(caps.snapshot('deepseek-acp').flags,[],'只更新 package.json 也不能用旧帮助');
  assert.equal(caps.snapshot('deepseek-acp').version,displayedVersion);
  await caps.prepareForKind('deepseek-acp',{exec,platform:'win32'});
  assert.equal(calls.length,6);
  assert.equal(caps.snapshot('deepseek-acp').version,displayedVersion);
});

for (const [version, expected] of [['2.1.50', 'high'], ['2.1.269', 'max']]) {
  test(`Claude ${version} 首次 PTY、恢复和原地重启命令一致使用 ${expected}`, t => {
    const Module = require('node:module'), load = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'node-pty') return {spawn() {throw new Error('No real CLI in capability unit tests');}};
      return load.call(this, id, ...args);
    };
    let _private, SessionManager;
    try { ({_private, SessionManager} = require('../core/session-manager')); }
    finally { Module._load = load; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-launch-caps-'));
    const before = process.env.CLAUDE_HUB_DATA_DIR, oldEffort = process.env.CLAUDE_HUB_NO_EFFORT_MAX;
    process.env.CLAUDE_HUB_DATA_DIR = root;
    delete process.env.CLAUDE_HUB_NO_EFFORT_MAX;
    const hubConfig = require('../core/hub-config');
    hubConfig.clearConfigCache();
    let currentHelp = help(version);
    t.mock.method(probes, 'readHelp', command => command === 'claude' ? currentHelp : '');
    t.after(() => {
      if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
      if (oldEffort === undefined) delete process.env.CLAUDE_HUB_NO_EFFORT_MAX; else process.env.CLAUDE_HUB_NO_EFFORT_MAX = oldEffort;
      hubConfig.clearConfigCache();
      fs.rmSync(root, {recursive:true, force:true});
    });
    const env = {USERPROFILE:root, HOME:root};
    for (const kind of ['claude', 'claude-resume']) {
      const launch = _private.buildClaudePtyLaunch('launch', kind, {model:'claude-opus-4-8', effort:'max', fastMode:false, mcpProfile:'full'}, root, env, {});
      assert.match(launch.cmd, new RegExp('--effort ' + expected + '\\b'));
      assert.match(launch.cmd, /--model claude-opus-4-8/);
    }
    const manager = Object.create(SessionManager.prototype), commands = [], notices = [];
    manager.sessions = new Map([['relaunch', {info:{id:'relaunch', kind:'claude', currentModel:{id:'claude-opus-4-8'}, effort:'max', fastMode:false, mcpProfile:'full', cwd:root},
      pty:{options:{env}, write:cmd=>commands.push(cmd)}}]]);
    manager.hubRulesSystemPrompt = () => null;
    manager.emit = (event, payload) => { if (event === 'session-notice') notices.push(payload); };
    assert.equal(manager.relaunchCli('relaunch'), true);
    assert.match(commands[0], new RegExp('--effort ' + expected + '\\b'));
    assert.equal(notices.some(notice => /最高档 high/.test(notice.message)), expected === 'high');
    currentHelp = '--model <model>\n --effort <level> (low, medium, high, max)';
    const limited = _private.buildClaudePtyLaunch('limited', 'claude', {model:'claude-opus-4-8', effort:'max', fastMode:false, mcpProfile:'none'}, root, env, {});
    assert.doesNotMatch(limited.cmd, /--(?:settings|add-dir|permission-mode|mcp-config|strict-mcp-config)\b/);
    manager.sessions.get('relaunch').info.mcpProfile = 'none';
    manager.relaunchCli('relaunch');
    assert.doesNotMatch(commands.at(-1), /--(?:settings|add-dir|permission-mode|mcp-config|strict-mcp-config)\b/);
  });
}
