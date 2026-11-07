'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const picker = require('../core/codeagent-model-picker');
const models = require('../core/codeagent-models');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const usage = require('../core/codeagent-usage-menu');
const IDS = ['GLM-5.2-Auto', 'GLM-5.2', 'DeepSeek-V4.1-Auto', 'DeepSeek-V4.1'];
const ALL_IDS = [...models.KNOWN.map(row => row.id), ...IDS];
const FOOTER = 'Navigate ↑ ↓ | Select enter | Back esc';
const commandsProbe = require('../core/codeagent-commands-probe');
const opentui = require('./fixtures/codeagent-commands-opentui.json');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-menu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function json(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); }
function config(dir, ids) { json(path.join(dir, '.cac.json'), { enterpriseModelOptionsCache: ids }); }

// Known command-row text, reconstructed as separate terminal lines. Layout and
// paging below are synthetic; the actual CLI paging behavior is not verified.
const COMMAND_ROWS = [
  '/model                 切换模型command', '/new (clear)             新建会话 command',
  '/sessions (continue, resume)    会话command', '/sdd:proposal         根据要求创建提案custom-command',
  '/developer-test-agent:generate-dt-files    指定文件列表生成单元测试，串行调度 developer-test-…custom-command',
  '/batch    Research and plan a large-scale change, then execute it in …skill',
];
function commandTerminal({ size = 2, count = 7, wrap = true, noFrames = false, glued = false, clearFails = false } = {}) {
  let clock = 0, revision = 1, cursor = 0, slash = false, top = 0;
  const writes = [], rows = Array.from({ length: count }, (_, i) => `/item-${i}    description ${i}command`);
  const lines = () => !slash ? ['private answer text', '❯ ', '? for shortcuts']
    : ['private answer text', '❯ /', ...rows.slice(top, top + size).map((row, i) => i + top === cursor ? '❯ ' + row : '  ' + row),
      ...(glued ? ['/bad textcommand/other textskill'] : []), '↑ ↓ to navigate'];
  const write = key => {
    writes.push(key);
    if (key === '/') { slash = true; revision++; }
    if (key === '\x15' && !clearFails) { slash = false; revision++; }
    if (key === '\x1b[B') {
      cursor = wrap ? (cursor + 1) % count : Math.min(cursor + 1, count - 1);
      if (cursor < top) top = cursor;
      if (cursor >= top + size) top = cursor - size + 1;
      if (!noFrames) revision++;
    }
  };
  return { writes, write, readFrame: async () => ({ lines: lines(), revision }), now: () => clock,
    sleep: async ms => { clock += ms; }, empty: () => !slash };
}

test('command row parsing preserves aliases, namespaces, types, languages and truncation; glued rows are rejected', () => {
  const parsed = COMMAND_ROWS.map(commandsProbe.parseCommandRow);
  assert.deepEqual(parsed.map(row => row.kind), ['command', 'command', 'command', 'custom-command', 'custom-command', 'skill']);
  assert.deepEqual(parsed[1].aliases, ['clear']); assert.deepEqual(parsed[2].aliases, ['continue', 'resume']);
  assert.equal(parsed[3].name, 'sdd:proposal'); assert.match(parsed[4].description, /…$/); assert.match(parsed[5].description, /Research/);
  assert.equal(commandsProbe.parseCommandRow('❯ ' + COMMAND_ROWS[0]).name, 'model');
  assert.equal(commandsProbe.parseCommandRow('/model 切换模型command/new 新建会话command'), null);
  for (const line of ['❯ /', '─'.repeat(30), '↑ ↓ to navigate', '/unknown incomplete']) assert.equal(commandsProbe.parseCommandRow(line), null);
});

test('captured opentui main column parses six commands without mixing in Stats or history', () => {
  const frame = commandsProbe.commandFrame({ lines: opentui.final, revision: 1 });
  assert.deepEqual(frame.commands.map(row => row.name), ['model', 'model-config', 'add-dir', 'cd', 'compact', 'new']);
  assert.deepEqual(frame.commands.map(row => row.description), ['切换模型', '模型配置管理', '追加工作目录', '切换工作目录', '压缩上下文', '新建会话']);
  assert.ok(frame.commands.every(row => row.kind === 'command')); assert.equal(frame.invalid, 0);
  assert.deepEqual(frame.commands.at(-1).aliases, ['clear']); assert.equal(frame.slashEntered, true);
  for (const row of ['/new(clear)    新建会话command', '/new (clear)    新建会话 command']) {
    assert.deepEqual(commandsProbe.parseCommandRow(row), { name: 'new', aliases: ['clear'], description: '新建会话', kind: 'command' });
  }
  assert.equal(commandsProbe.commandFrame({ lines: opentui.firstUnrecognized }).slashEntered, false);
  assert.equal(commandsProbe.commandFrame({ lines: opentui.beforeSlash }).commands.length, 0);
  for (const boundary of ['', ' ● upgrade command', ' ┃ /not-a-suggestion    historycommand']) {
    const screen = [...opentui.final]; screen.splice(screen.findIndex(line => /^ \/cd\s/.test(line)), 0, boundary);
    assert.deepEqual(commandsProbe.commandFrame({ lines: screen }).commands.map(row => row.name), ['cd', 'compact', 'new']);
  }
  const sidebar = opentui.final.map(line => line.includes('╭') || !/^ \//.test(line) ? line : line.slice(0, line.indexOf('command') + 7) + '     changed Stats command');
  assert.equal(commandsProbe.commandFrame({ lines: sidebar }).signature, frame.signature);
});

test('a screen without an input border keeps the legacy suggestion-region rules', () => {
  const frame = commandsProbe.commandFrame({ lines: ['❯ /', ...COMMAND_ROWS], revision: 1 });
  assert.deepEqual(frame.commands, COMMAND_ROWS.map(commandsProbe.parseCommandRow));
  assert.equal(frame.slashEntered, true);
});

test('opentui waits for slash and list paint, then traverses six-row pages despite changing sidebar frames', async () => {
  let clock = 0, revision = 1, cursor = 0, typed = false;
  const writes = [], start = opentui.final.findIndex(line => /^ \/model\s/.test(line)), border = opentui.final.findIndex(line => line.includes('╭'));
  const rows = [...opentui.final.slice(start, border).map(line => line.slice(0, line.indexOf('command') + 7)),
    ' /sdd:proposal   根据要求创建提案 custom-command', ' /git-ai   Install, update... skill'];
  const screen = (visible, side) => [...opentui.final.slice(0, start), ...visible.map(line => line + ' '.repeat(125) + side), ...opentui.final.slice(border)];
  const f = { now: () => clock, sleep: async ms => { clock += ms; },
    write: key => { writes.push(key); if (key === '/') typed = true; else if (key === '\x1b[B') cursor = Math.min(cursor + 1, rows.length - 1); },
    readFrame: async () => ({ revision: ++revision, lines: !typed || clock < 3500 ? opentui.firstUnrecognized
      : screen(clock < 4100 ? [] : rows.slice(Math.max(0, cursor - 5), Math.max(0, cursor - 5) + 6), 'Stats tick ' + revision) }) };
  f.write('/');
  const result = await commandsProbe.collectCommands(f);
  assert.equal(result.ok, true); assert.ok(clock >= 4100);
  assert.deepEqual(result.commands.map(row => row.name), ['model', 'model-config', 'add-dir', 'cd', 'compact', 'new', 'sdd:proposal', 'git-ai']);
  assert.deepEqual(result.commands.slice(-2).map(row => row.kind), ['custom-command', 'skill']);
  assert.ok(writes.filter(key => key === '\x1b[B').length > 6);
  assert.ok(result.commands.every(row => !row.description.includes('Stats')));
});

test('slash visibility has its own ten-second limit and visible empty lists wait a continuous 1.5 seconds', async () => {
  for (const visible of [false, true]) {
    let clock = 0;
    const screen = visible ? opentui.firstUnrecognized.map(line => /^ │ > Anything/.test(line) ? opentui.final.find(row => /^ │ > \//.test(row)) : line) : opentui.firstUnrecognized;
    const result = await commandsProbe.collectCommands({ now: () => clock, sleep: async ms => { clock += ms; },
      readFrame: async () => ({ lines: screen, revision: 1 }), write: () => assert.fail('empty lists must not navigate') });
    assert.equal(result.reason, visible ? 'unrecognized-list' : 'slash-not-visible');
    assert.equal(clock, visible ? commandsProbe.COMMAND_LIST_EMPTY_WAIT_MS : commandsProbe.COMMAND_SLASH_WAIT_MS);
  }
});

for (const [name, options] of [
  ['smaller than a screen', { size: 6, count: 3 }], ['exactly one screen', { size: 3, count: 3 }],
  ['multiple screens with wrap', {}], ['multiple screens without wrap', { wrap: false }],
]) test(`command traversal collects the whole list: ${name}`, async () => {
  const f = commandTerminal(options); f.write('/');
  const result = await commandsProbe.collectCommands(f);
  assert.equal(result.ok, true); assert.equal(result.commands.length, options.count || 7);
  assert.equal(new Set(result.commands.map(row => row.name)).size, result.commands.length);
  assert.ok(f.writes.slice(1).every(key => key === '\x1b[B'));
});

test('unconfirmed frames, item/page caps and malformed rows do not produce a complete command list', async () => {
  for (const [options, limits, reason] of [[{ noFrames: true }, {}, 'unconfirmed-navigation'],
    [{ count: 20 }, { maxScreens: 1 }, 'limit'], [{ count: 20 }, { maxItems: 3 }, 'limit'], [{ glued: true }, {}, 'invalid-rows']]) {
    const f = commandTerminal(options); f.write('/');
    const result = await commandsProbe.collectCommands({ ...f, ...limits });
    assert.equal(result.ok, false); assert.equal(result.reason, reason);
  }
});

test('command producer isolates accounts, skips unchanged versions, refreshes changed versions, and clears its editor', async t => {
  const dir = temp(t), file = path.join(dir, 'codeagent-pool', 'codeagent-commands.json');
  for (const accountKey of ['personal', 'abcdef12']) {
    const f = commandTerminal();
    assert.equal((await commandsProbe.probeCommands({ ...f, dataDir: dir, accountKey, version: '1.26.1' })).ok, true);
    assert.equal(f.writes[0], '/'); assert.equal(f.writes.at(-1), '\x15'); assert.equal(f.empty(), true);
    assert.ok(!f.writes.includes('\r'));
  }
  const original = JSON.parse(fs.readFileSync(file));
  const skipped = commandTerminal();
  assert.equal((await commandsProbe.probeCommands({ ...skipped, dataDir: dir, accountKey: 'personal', version: '1.26.1' })).skipped, true);
  assert.deepEqual(skipped.writes, []);
  const changed = commandTerminal({ count: 4 });
  await commandsProbe.probeCommands({ ...changed, dataDir: dir, accountKey: 'personal', version: '1.26.2' });
  const updated = JSON.parse(fs.readFileSync(file));
  assert.equal(updated.accounts.personal.version, '1.26.2'); assert.equal(updated.accounts.personal.commands.length, 4);
  assert.deepEqual(updated.accounts.abcdef12, original.accounts.abcdef12);
});

test('failed or uncleared command probe retains the old cache and logs the hidden probe screen', async t => {
  const dir = temp(t), file = path.join(dir, 'codeagent-pool/codeagent-commands.json');
  commandsProbe.writeCommandCache(dir, 'personal', '1.26.0', [commandsProbe.parseCommandRow(COMMAND_ROWS[0])]);
  const original = fs.readFileSync(file, 'utf8');
  for (const [index, options] of [{ noFrames: true }, { clearFails: true }, { glued: true }, { count: 0 }].entries()) {
    const f = commandTerminal(options);
    assert.equal((await commandsProbe.probeCommands({ ...f, dataDir: dir, accountKey: 'personal', version: `1.26.${index + 1}` })).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(f.writes.at(-1), '\x15');
  }
  const log = path.join(dir, 'logs/codeagent-commands-probe.log');
  const snapshots = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'screen');
  assert.ok(snapshots.length >= 4);
  assert.ok(snapshots.every(row => row.lineCount > 0 && row.lineCount <= 40));
  assert.ok(snapshots.some(row => row.lines.includes('private answer text'))); // Synthetic hidden PTY output, not a user's session.
  commandsProbe.commandDiagnostic(dir, 'test', Array.from({ length: 80 }, () => '/safe    descriptioncommand'), { maxBytes: 100 });
  assert.ok(fs.existsSync(log + '.1')); assert.equal(JSON.parse(fs.readFileSync(log)).lineCount, 60);
  const feedback = require('../core/hub-feedback').collectBundle({ logsDir: path.dirname(log) });
  assert.ok(feedback.items.some(row => row.name.includes('codeagent-commands-probe.log')));
});

test('unrecognized frames record only the first and final full screens before cleanup, stripped and bounded', async t => {
  const dir = temp(t); let clock = 0, slash = false;
  const writes = [], before = ['hidden startup output', '❯   ', '  ? for shortcuts  '];
  const after = [...Array.from({ length: 55 }, (_, i) => `  screen-${i}  `), '\x1b[31m  ' + 'x'.repeat(240) + '\x1b[0m', '❯ /  ', '', '   '];
  const result = await commandsProbe.probeCommands({ dataDir: dir, accountKey: 'personal', version: '1.26.1',
    readFrame: async () => ({ lines: slash ? after : before, revision: 1 }),
    write: key => { writes.push(key); slash = key !== '\x15'; }, sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(result.reason, 'unrecognized-list'); assert.deepEqual(writes, ['/', '\x15']);
  const rows = fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8').trim().split('\n').map(JSON.parse);
  const screens = rows.filter(row => row.event === 'screen');
  assert.deepEqual(screens.map(row => row.result), ['first-unrecognized', 'final']);
  assert.equal(screens[0].round, 1); assert.equal(screens[1].reason, 'unrecognized-list');
  assert.ok(rows.filter(row => row.event === 'frame' && row.result === 'unrecognized').length > 2);
  for (const row of screens) {
    assert.equal(row.lineCount, 40); assert.ok(row.lines.every(line => line.length <= 200 && line.trim()));
    assert.equal(row.lines[0], '  screen-17  '); assert.equal(row.lines.at(-1), '❯ /  ');
    assert.equal(row.lines.at(-2), '  ' + 'x'.repeat(198)); assert.doesNotMatch(row.lines.join('\n'), /\x1b/);
  }
  const input = rows.find(row => row.event === 'input-before-slash');
  assert.deepEqual(input.lines, before.slice(1)); assert.ok(input.lineCount <= 10);
  assert.ok(rows.indexOf(input) < rows.findIndex(row => row.event === 'slash-typed'));
  assert.equal(rows.find(row => row.event === 'slash-typed').key, '/');
  assert.equal(screens[1].downCount, 0); assert.equal(new Set(rows.map(row => row.requestId)).size, 1);
});

test('missing fresh navigation frames logs the final screen and actual down-key count', async t => {
  const dir = temp(t), f = commandTerminal({ noFrames: true });
  const result = await commandsProbe.probeCommands({ ...f, dataDir: dir, accountKey: 'personal', version: '1.26.1' });
  assert.equal(result.reason, 'unconfirmed-navigation');
  const rows = fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8').trim().split('\n').map(JSON.parse);
  const final = rows.filter(row => row.event === 'screen');
  assert.equal(final.length, 1); assert.equal(final[0].result, 'final'); assert.ok(final[0].lines.includes('❯ /'));
  assert.equal(final[0].downCount, f.writes.filter(key => key === '\x1b[B').length);
  assert.deepEqual(rows.filter(row => row.event === 'key').map(row => row.key), ['↓']);
});

test('before-slash diagnostics keep only the last ten editor lines and strip OSC and CSI escapes', t => {
  const dir = temp(t), trace = commandsProbe.createCommandTrace(dir, { accountKey: 'personal' });
  trace('input-before-slash', { state: 'empty', lines: ['hidden startup output', '❯ ',
    ...Array.from({ length: 12 }, (_, i) => '\x1b]0;hidden title\x07\x1b[32m  editor-' + i + '  \x1b[0m')] });
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8'));
  assert.equal(row.state, 'empty'); assert.equal(row.lineCount, 10);
  assert.equal(row.lines[0], '  editor-2  '); assert.equal(row.lines.at(-1), '  editor-11  ');
  assert.doesNotMatch(row.lines.join('\n'), /startup|hidden title|\x1b/);
});

test('the terminal mirror default remains identical while diagnostic reads retain right padding', async t => {
  const screen = require('../core/claude-trust-dialog').createTrustScreen({ cols: 30, rows: 4 });
  assert.ok(screen); t.after(() => screen.dispose());
  screen.write('\x1b[31m  probe text  \x1b[0m\r\n❯ ');
  const normal = await screen.lines(), raw = await screen.lines({ trimRight: false });
  assert.deepEqual(normal, ['  probe text  ', '❯ ', '', '']); // Existing xterm behavior preserves explicitly written spaces.
  assert.deepEqual(await screen.lines({ trimRight: true }), normal);
  assert.deepEqual(raw, ['  probe text'.padEnd(30), '❯'.padEnd(30), ' '.repeat(30), ' '.repeat(30)]);
});

test('hidden commands-only diagnostics retain raw spaces while its parser receives the original trimmed frame', async t => {
  const dir = temp(t); let slash = false, onData, onExit, rawReads = 0;
  const screen = { write() {}, dispose() {}, lines: async ({ trimRight = true } = {}) => {
    if (!trimRight) rawReads++;
    const lines = slash ? ['  probe output  ', '❯ /  ', '  unknown suggestions  '] : ['❯   ', '? for shortcuts  '];
    return trimRight ? lines.map(line => line.trimEnd()) : lines;
  } };
  const proc = { onData: fn => { onData = fn; return { dispose() {} }; }, onExit: fn => { onExit = fn; }, kill: () => onExit(),
    write: key => { slash = key !== '\x15'; onData('frame'); } };
  const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen },
    './codeagent-commands-probe': { ...commandsProbe, probeCommands: options => {
      assert.equal(options.force, true);
      return commandsProbe.probeCommands({ ...options, now: () => fixture.state.clock,
        readFrame: async () => {
          const frame = await options.readFrame(); assert.deepEqual(Array.from(frame.lines), Array.from(frame.diagnosticLines, line => line.trimEnd())); return frame;
        } });
    } } });
  const result = await fixture.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
    accountKey: 'personal', cliVersion: '1.26.1', commandsOnly: true, forceCommands: true, ptyModule: { spawn: () => proc } });
  assert.equal(result.commandsProbe.reason, 'unrecognized-list'); assert.ok(rawReads > 2);
  const screens = fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'screen');
  assert.equal(screens.length, 2); assert.ok(screens.every(row => row.lines.includes('  unknown suggestions  ')));
});

test('manual command retry bypasses both cooldown checks and retains per-account cooldown deadlines', async t => {
  const dir = temp(t); let clock = 1000, count = 0;
  const scheduler = commandsProbe.createCommandsProbeScheduler({ dataDir: dir, now: () => clock, getVersion: async () => '1.26.1',
    probe: (session, version, options) => {
      count++;
      const f = commandTerminal({ count: count === 1 ? 0 : 3 });
      return commandsProbe.probeCommands({ ...f, now: () => clock + f.now(), ...options, dataDir: dir,
        accountKey: session.codeagentPoolAccount || 'personal', version });
    } });
  assert.equal((await scheduler.request({})).reason, 'unrecognized-list');
  const deadline = scheduler.state({}).retryAt;
  assert.equal(deadline, clock + commandsProbe.COMMAND_PROBE_RETRY_MS);
  clock += 5 * 60000;
  assert.equal((await scheduler.request({})).reason, 'failure-cooldown'); assert.equal(count, 1);
  assert.equal(scheduler.state({}).retryAt, deadline);
  assert.equal(commandsProbe.createCommandsProbeScheduler({ dataDir: dir }).state({}).retryAt, deadline);
  assert.equal((await scheduler.request({}, { force: true })).ok, true); assert.equal(count, 2);
  assert.equal(scheduler.state({}).state, 'ready'); assert.equal(scheduler.state({}).retryAt, undefined);
});

test('an in-flight log never replaces a real failure with unfinished-request during cooldown', async t => {
  const dir = temp(t), failed = commandTerminal({ count: 0 });
  assert.equal((await commandsProbe.probeCommands({ ...failed, dataDir: dir, accountKey: 'personal', version: '1.26.1' })).reason, 'unrecognized-list');
  const trace = commandsProbe.createCommandTrace(dir, { accountKey: 'personal' });
  trace('requested'); trace('ready-wait', { result: 'ready' });
  assert.equal(commandsProbe.recoveredCommandState(dir, 'personal').reason, 'unrecognized-list');
  const scheduler = commandsProbe.createCommandsProbeScheduler({ dataDir: dir, now: failed.now,
    probe: () => assert.fail('cooling account must not start another hidden process') });
  assert.equal((await scheduler.request({ codeagentVersion: '1.26.1' })).reason, 'failure-cooldown');
  assert.equal(scheduler.state({}).reason, 'unrecognized-list');
  const rows = fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.some(row => row.reason === 'unfinished-request'), false);
});

test('version parsing skips upgrade notices and accepts only actual version lines', () => {
  const { parseCodeAgentVersion } = require('../core/codeagent-version-probe');
  assert.equal(parseCodeAgentVersion("New version available: 1.99.0. You can run the 'codeagent update' command to upgrade.\n\n1.26.15 (codeAgentCLI)"), '1.26.15');
  assert.equal(parseCodeAgentVersion('CodeAgent v1.26.15'), '1.26.15');
  assert.equal(parseCodeAgentVersion('New version available: 1.99.0'), '');
});

test('the actual hidden model probe reads commands in its same PTY without changing model usage', async t => {
  const dir = temp(t); let mode = 'ready', onData, onExit, starts = 0, downs = 0, versionCalls = 0;
  const writes = [], idle = ['❯ ', '? for shortcuts'];
  const screen = { write() {}, lines: async () => mode === 'model' ? menu() : mode === 'commands' ? ['❯ /', ...COMMAND_ROWS] : mode === 'commands-empty' ? ['❯ /'] : idle, dispose() {} };
  const proc = { onData: fn => { onData = fn; return { dispose() {} }; }, onExit: fn => { onExit = fn; }, kill: () => onExit(),
    write: key => { writes.push(key); if (key === '\r') mode = 'model'; if (key === '\x1b' || key === '\x15') mode = 'ready'; if (key === '/') mode = 'commands'; if (key === '\x1b[B') downs++; onData('output'); } };
  const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen },
    './codeagent-commands-probe': { ...commandsProbe, probeCommands: options => commandsProbe.probeCommands({ ...options, now: () => fixture.state.clock }) } });
  const options = { command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
    accountKey: 'personal', versionProbe: async () => { versionCalls++; return '1.26.15'; }, ptyModule: { spawn: () => { starts++; return proc; } } };
  const result = await fixture.api.probeModels(options);
  assert.equal(result.ok, true); assert.deepEqual(Array.from(result.models), IDS); assert.equal(result.usage.models.length, 4);
  assert.equal(starts, 1); assert.equal(versionCalls, 1); assert.equal(mode, 'ready'); assert.ok(downs > COMMAND_ROWS.length + 2);
  assert.deepEqual(writes.slice(0, 4), ['/model', '\r', '\x1b', '/']); assert.equal(writes.at(-1), '\x15');
  const entries = require('../core/codeagent-command-cache').readCommands(dir, {});
  assert.equal(entries.length, COMMAND_ROWS.length);
  writes.length = 0; mode = 'ready';
  assert.equal((await fixture.api.probeModels(options)).ok, true); assert.deepEqual(writes, ['/model', '\r', '\x1b']);
  mode = 'ready'; writes.length = 0;
  const failureProc = { ...proc, write: key => { writes.push(key); if (key === '\r') mode = 'model'; if (key === '/') mode = 'commands-empty'; if (key === '\x1b' || key === '\x15') mode = 'ready'; onData('output'); } };
  const failedCommands = await fixture.api.probeModels({ ...options, cliVersion: '1.26.16', ptyModule: { spawn: () => failureProc } });
  assert.equal(failedCommands.ok, true); assert.equal(failedCommands.usage.models.length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'codeagent-pool/codeagent-commands.json'))).accounts.personal.version, '1.26.15');
});

test('incomplete and unrecognized model menus still probe commands; commands-only skips model reading entirely', async t => {
  for (const model of ['partial', 'unrecognized', 'commands-only']) {
    const dir = temp(t); let mode = 'ready', onData, onExit, starts = 0;
    const writes = [], idle = ['❯ ', '? for shortcuts'];
    const screen = { write() {}, lines: async () => mode === 'commands' ? ['❯ /', ...COMMAND_ROWS]
      : mode === 'model' ? model === 'partial' ? menu().slice(0, 11) : ['not a menu'] : idle, dispose() {} };
    const proc = { onData: fn => { onData = fn; return { dispose() {} }; }, onExit: fn => { onExit = fn; }, kill: () => onExit(),
      write: key => { writes.push(key); if (key === '\r') mode = 'model'; if (key === '\x1b' || key === '\x15') mode = 'ready'; if (key === '/') mode = 'commands'; onData('output'); } };
    const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen },
      './codeagent-commands-probe': { ...commandsProbe, probeCommands: options => commandsProbe.probeCommands({ ...options, now: () => fixture.state.clock }) } });
    const result = await fixture.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
      accountKey: 'personal', cliVersion: '1.26.15', menuTimeoutMs: 1000, commandsOnly: model === 'commands-only', ptyModule: { spawn: () => { starts++; return proc; } } });
    assert.equal(result.ok, model === 'commands-only'); assert.equal(result.commandsProbe.ok, true); assert.equal(starts, 1); assert.equal(mode, 'ready');
    assert.equal(require('../core/codeagent-command-cache').readCommands(dir, {}).length, COMMAND_ROWS.length);
    assert.equal(writes.includes('/model'), model !== 'commands-only'); assert.equal(writes.at(-1), '\x15');
    if (model !== 'commands-only') { assert.equal(result.models, undefined); assert.ok(writes.indexOf('\x1b') < writes.indexOf('/')); }
    assert.match(fs.readFileSync(path.join(dir, 'logs', 'codeagent-model.log'), 'utf8'), /event=commands-probe result=read/);
  }
});

test('unavailable hidden probe writes command diagnostics without copying spawn error details', async t => {
  const dir = temp(t), screen = { dispose() {} };
  const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen } });
  const result = await fixture.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
    accountKey: 'personal', commandsOnly: true, ptyModule: { spawn: () => { throw new Error('private path'); } } });
  assert.equal(result.ok, false);
  for (const file of ['codeagent-commands-probe.log', 'codeagent-model.log']) {
    const raw = fs.readFileSync(path.join(dir, 'logs', file), 'utf8');
    assert.match(raw, /spawn-failed/); assert.doesNotMatch(raw, /private path/);
  }
});

test('normal probes and commands-only warm-up share failure cooldown without extending it on a skipped read', async t => {
  const dir = temp(t), accountKey = 'personal', version = '1.26.1';
  const failed = commandTerminal({ noFrames: true });
  assert.equal((await commandsProbe.probeCommands({ ...failed, dataDir: dir, accountKey, version })).ok, false);
  let clock = failed.now(), calls = 0;
  const scheduler = commandsProbe.createCommandsProbeScheduler({ dataDir: dir, now: () => clock, getVersion: async () => version,
    probe: async () => { calls++; return { ok: false, reason: 'not-ready' }; } });
  assert.equal((await scheduler.request({})).reason, 'failure-cooldown'); assert.equal(calls, 0);
  clock += commandsProbe.COMMAND_PROBE_RETRY_MS;
  await scheduler.request({}); assert.equal(calls, 1);
  const untouched = commandTerminal();
  assert.equal((await commandsProbe.probeCommands({ ...untouched, now: () => clock, dataDir: dir, accountKey, version })).reason, 'failure-cooldown');
  assert.deepEqual(untouched.writes, []);
  clock += commandsProbe.COMMAND_PROBE_RETRY_MS - 1;
  assert.equal((await scheduler.request({})).reason, 'failure-cooldown'); assert.equal(calls, 1);
  clock++;
  await scheduler.request({}); assert.equal(calls, 2);
});

function commandTimers() {
  let clock = 0, id = 0;
  const timers = new Map();
  return { now: () => clock, setTimer: (fn, ms) => { const key = ++id; timers.set(key, { at: clock + ms, fn }); return key; },
    clearTimer: key => timers.delete(key), advance(ms) {
      clock += ms;
      for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= clock && timers.has(key)) { timers.delete(key); timer.fn(); }
    }, timers };
}

test('command requests trace every stage with one ID and recover account state without private content', async t => {
  const dir = temp(t), f = commandTerminal();
  commandsProbe.commandStartup(dir, { hubVersion: '5.5.3', dataDirOverride: true });
  const scheduler = commandsProbe.createCommandsProbeScheduler({ dataDir: dir, now: f.now, getVersion: async () => '1.26.1',
    probe: (_session, version, { trace }) => commandsProbe.queueCommandsProbe(Promise.resolve(), async () => {
      trace('ready-wait', { result: 'ready', prompt: 'private prompt' });
      return commandsProbe.probeCommands({ ...f, dataDir: dir, accountKey: 'personal', version, trace });
    }, { trace }) });
  assert.equal(scheduler.state({}).state, 'idle');
  const running = scheduler.request({}); assert.equal(scheduler.state({}).state, 'reading');
  assert.equal((await running).ok, true); assert.equal(scheduler.state({}).state, 'ready');
  const raw = fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8'), rows = raw.trim().split('\n').map(JSON.parse);
  const events = rows.map(row => row.event).filter(Boolean);
  const ordered = ['requested', 'version-start', 'version-done', 'queued', 'probe-start', 'ready-wait', 'slash-typed', 'frame', 'cache-written'];
  let index = -1; for (const event of ordered) { index = events.indexOf(event, index + 1); assert.ok(index >= 0, event); }
  assert.match(rows[0].directoryHash, /^[0-9a-f]{12}$/); assert.equal(rows[0].hubVersion, '5.5.3'); assert.equal(rows[0].dataDirOverride, true);
  const request = rows.filter(row => row.accountKey === 'personal'); assert.equal(new Set(request.map(row => row.requestId)).size, 1);
  assert.ok(request.every(row => /^[0-9a-f]{8}$/.test(row.requestId) && Number.isFinite(Date.parse(row.at))));
  assert.doesNotMatch(raw, /private prompt|private answer|description 0/); assert.equal(raw.includes(dir), false);
  const restarted = commandsProbe.createCommandsProbeScheduler({ dataDir: dir });
  assert.equal(restarted.state({}).state, 'ready'); assert.equal(restarted.state({ codeagentPoolAccount: 'abcdef12' }).state, 'idle');
  assert.equal((await scheduler.request({})).reason, 'cache-current');
});

test('a queue timeout never starts its expired job and leaves later work able to proceed', async () => {
  const timers = commandTimers(), events = []; let release, calls = 0;
  const previous = new Promise(resolve => { release = resolve; });
  const waiting = commandsProbe.queueCommandsProbe(previous, async () => { calls++; }, { ...timers, pending: true, trace: (event, fields) => events.push({ event, ...fields }) });
  timers.advance(commandsProbe.COMMAND_QUEUE_WAIT_MS);
  assert.equal((await waiting).reason, 'queue-timeout'); assert.equal(calls, 0);
  release(); await new Promise(setImmediate); assert.equal(calls, 0);
  assert.equal((await commandsProbe.queueCommandsProbe(previous, async () => { calls++; return { ok: true }; }, timers)).ok, true);
  assert.equal(calls, 1); assert.deepEqual(events.map(row => row.event), ['queued', 'failed']); assert.equal(events[0].pending, true);
});

test('version timeout rejects even when the killed child never calls back and logs version-failed', async t => {
  const dir = temp(t), timers = commandTimers(); let killed = false, versionPromise;
  const fixture = menuVm('codeagent-version-probe.js', { 'node:child_process': { execFile: (command, args) => {
    if (command === 'taskkill.exe') { killed = true; assert.deepEqual(Array.from(args), ['/PID', '1234', '/T', '/F']); }
    return { pid: 1234, kill: () => { killed = true; } }; // Deliberately never invoke the execFile callback.
  } }, globals: { setTimeout: timers.setTimer, clearTimeout: timers.clearTimer } });
  const scheduler = commandsProbe.createCommandsProbeScheduler({ dataDir: dir, ...timers,
    getVersion: () => { versionPromise = fixture.api.codeagentVersion('synthetic'); return versionPromise; }, probe: () => assert.fail('no version, no PTY') });
  const request = scheduler.request({}); await Promise.resolve(); await Promise.resolve();
  const rejected = assert.rejects(versionPromise, /8 秒没返回/);
  timers.advance(8000); await rejected;
  assert.equal((await request).reason, 'version-timeout'); assert.equal(killed, true);
  const rows = fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.event === 'version-failed')); assert.ok(rows.some(row => row.event === 'failed' && row.reason === 'version-timeout'));
  assert.equal(scheduler.state({}).state, 'failed');
  assert.equal(commandsProbe.createCommandsProbeScheduler({ dataDir: dir }).state({}).reason, 'version-timeout');
});

test('ready failures finish with login, timeout or exit reasons and clean only the probe process', async t => {
  for (const mode of ['login', 'timeout', 'exit']) {
    const dir = temp(t); let exit, killed = 0;
    const screen = { write() {}, lines: async () => mode === 'login' ? ['Please run /login'] : ['starting'], dispose() {} };
    const proc = { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; if (mode === 'exit') fn(); }, write: () => assert.fail('no ready input'), kill: () => { killed++; exit(); } };
    const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen } });
    const result = await fixture.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
      accountKey: 'personal', cliVersion: '1.26.1', commandsOnly: true, readyTimeoutMs: 600, ptyModule: { spawn: () => proc } });
    assert.equal(result.commandsProbe.reason, { login: 'login-required', timeout: 'ready-timeout', exit: 'process-exited' }[mode]);
    assert.equal(killed, mode === 'exit' ? 0 : 1);
    assert.match(fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8'), /"event":"ready-wait"/);
  }
});

test('commands-only overall timeout interrupts stalled ready and frame reads without late writes or cache publication', async t => {
  for (const mode of ['ready', 'frame']) {
    const dir = temp(t), timers = commandTimers(); let exit, resolveRead, typed = false, killed = 0;
    const writes = [], screen = { write() {}, dispose() {}, lines: () => mode === 'ready' || typed ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve(['❯ ', '? for shortcuts']) };
    const proc = { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; }, write: key => { writes.push(key); if (key === '/') typed = true; }, kill: () => { killed++; exit(); } };
    const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen },
      globals: { setTimeout: timers.setTimer, clearTimeout: timers.clearTimer } });
    const request = fixture.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
      accountKey: 'personal', cliVersion: '1.26.1', commandsOnly: true, ptyModule: { spawn: () => proc } });
    for (let i = 0; i < 30 && !resolveRead; i++) await Promise.resolve();
    assert.ok(resolveRead); timers.advance(probe.COMMANDS_ONLY_TIMEOUT_MS);
    const result = await request; assert.equal(result.commandsProbe.reason, 'timeout'); assert.equal(killed, 1);
    const before = [...writes]; resolveRead(['❯ /', ...COMMAND_ROWS]); await new Promise(setImmediate);
    assert.deepEqual(writes, before); assert.equal(fs.existsSync(path.join(dir, 'codeagent-pool/codeagent-commands.json')), false);
    assert.match(fs.readFileSync(path.join(dir, 'logs/codeagent-commands-probe.log'), 'utf8'), /"reason":"timeout"/);
  }
});

test('the ordinary model watchdog releases a stalled hidden process before the next command job starts', async t => {
  for (const phase of ['startup', 'version']) {
    const dir = temp(t), timers = commandTimers(); let exit, killed = 0, commandStarted = 0, menuOpen = false, versionWaiting = false;
    const screen = { write() {}, lines: () => phase === 'startup' ? new Promise(() => {}) : Promise.resolve(menuOpen ? menu() : ['❯ ', '? for shortcuts']), dispose() {} };
    const proc = { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; },
      write: key => { assert.equal(phase, 'version'); if (key === '\r') menuOpen = true; if (key === '\x1b') menuOpen = false; }, kill: () => { killed++; exit(); } };
    const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen },
      globals: { setTimeout: timers.setTimer, clearTimeout: timers.clearTimer, Date: class extends Date { static now() { return timers.now(); } } } });
    const oldProbe = fixture.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
      accountKey: 'personal', versionProbe: () => { versionWaiting = true; return new Promise(() => {}); }, ptyModule: { spawn: () => proc } });
    if (phase === 'version') { for (let i = 0; i < 40 && !versionWaiting; i++) { await new Promise(setImmediate); timers.advance(500); } assert.equal(versionWaiting, true); }
    timers.advance(60000 - timers.now());
    const next = commandsProbe.queueCommandsProbe(oldProbe, async () => { commandStarted++; assert.equal(killed, 1); return { ok: true }; }, timers);
    assert.equal(commandStarted, 0); timers.advance(probe.MODEL_PROBE_TIMEOUT_MS - timers.now());
    const result = await oldProbe; assert.equal(result.ok, phase === 'version'); assert.equal(result.commandsProbe.reason, 'timeout');
    if (phase === 'version') { assert.deepEqual(Array.from(result.models), IDS); assert.equal(result.usage.models.length, 4); }
    assert.equal((await next).ok, true); assert.equal(commandStarted, 1);
  }
});

test('command warm-up is per-account/version, deduplicated, cache-aware and retries failures only after thirty minutes', async t => {
  const dir = temp(t); let clock = 0, version = '1.26.1', fail = false, calls = 0;
  const results = [];
  const scheduler = commandsProbe.createCommandsProbeScheduler({ dataDir: dir, now: () => clock, getVersion: async () => version,
    onResult: result => results.push(result), probe: async (session, value) => {
      calls++;
      if (fail) return { ok: false, reason: 'not-ready' };
      commandsProbe.writeCommandCache(dir, session.codeagentPoolAccount || 'personal', value, [commandsProbe.parseCommandRow(COMMAND_ROWS[0])]);
      return { ok: true };
    } });
  const first = scheduler.request({}); assert.equal(scheduler.request({}), first); await first; assert.equal(calls, 1);
  assert.equal((await scheduler.request({})).reason, 'cache-current'); assert.equal(calls, 1);
  version = '1.26.2'; fail = true; await scheduler.request({}); assert.equal(calls, 2);
  assert.equal((await scheduler.request({})).reason, 'failure-cooldown'); assert.equal(calls, 2);
  clock += commandsProbe.COMMAND_PROBE_RETRY_MS; await scheduler.request({}); assert.equal(calls, 3);
  version = '1.26.3'; fail = false; await scheduler.request({}); assert.equal(calls, 4);
  await scheduler.request({ codeagentPoolAccount: 'pool' }); assert.equal(calls, 5);
  assert.equal((await scheduler.request({ codeagentPoolAccount: 'pool' })).reason, 'cache-current');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'codeagent-pool', 'codeagent-commands.json'))).accounts.personal.version, '1.26.3');
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'codeagent-commands-probe.log'), 'utf8'), /not-ready/);
  assert.ok(results.some(row => row.reason === 'failure-cooldown'));
});

// Synthetic layouts, not captured colleague screens. Grouping/wrapping remains
// a hypothesis; only the title, headings, footer and three-row usage shape are known.
function menu({ cursor = 1, grouped = false, wrapped = false, blank = false, ids = IDS } = {}) {
  const lines = ['Select model', 'Credit用量', '月度: 1/400000,已用0.1%',
    '模型名称  Credit消耗系数  Token用量/配额  负载  模型描述', 'Built-in'];
  ids.forEach((id, index) => {
    if (grouped && index === 2) lines.push('', 'Other models');
    if (blank && index) lines.push('', '');
    lines.push(`${cursor === index + 1 ? '❯' : ' '} ${index + 1}. ${id}   0-1x   Day 1M/400M (0.25%)   ● 低负载   description`,
      'Hour 100K/200M (0.05%)', 'Min 1K/1M (0.1%)');
    if (wrapped && index === 1) lines.push('      another description line');
  });
  return [...lines, FOOTER];
}

for (const variant of [
  { name: 'single group' }, { name: 'two groups, first cursor', grouped: true },
  { name: 'two groups, last cursor', grouped: true, cursor: 4 },
  { name: 'wrapped description', wrapped: true }, { name: 'blank separators', blank: true },
]) test(`numbered menu reads all models across ${variant.name}`, () => {
  const lines = menu(variant), parsed = picker.parsePicker(lines);
  assert.deepEqual(parsed.rows.map(row => row.label), IDS);
  assert.equal(parsed.cursor, (variant.cursor || 1) - 1); assert.equal(parsed.complete, true);
  const tokens = usage.parseCodeAgentUsageMenu(lines).models;
  assert.deepEqual(tokens.map(row => row.name), IDS);
  assert.ok(tokens.every(row => row.day && row.hour && row.min));
});

test('table header alone bounds a menu; ordinary numbered answer text remains conservative', () => {
  const lines = menu().slice(1);
  assert.equal(picker.parsePicker(lines, { requireTitle: true }).complete, true);
  const body = ['An answer', '❯ 1. GLM-5.2', '2. DeepSeek-V4.1'];
  assert.equal(picker.parsePicker(body, { requireTitle: true }), null);
  assert.equal(picker.parsePicker(body).complete, false);
  assert.equal(picker.parsePicker(['❯ 1. GLM-5.2', '', '', '', '2. DeepSeek-V4.1']), null);
});

test('partial, scrolled, nonconsecutive and truncated-label lists cannot replace a complete snapshot', t => {
  const dir = temp(t);
  models.recordMenu(dir, IDS, { complete: true });
  const variants = [menu().slice(0, 11), menu({ ids: IDS.slice(0, 2) }).map(line => line.replace(/([12])\./, (_, n) => Number(n) + 2 + '.')),
    [...menu().slice(0, -1), '↓ 4 more models', FOOTER], menu().filter(line => !/ 3\./.test(line)),
    menu({ ids: ['GLM-5.2-Auto', 'DeepSeek-V4.1...'] })];
  for (const lines of variants) {
    const parsed = picker.parsePicker(lines);
    assert.ok(!parsed || !parsed.complete);
    assert.equal(models.recordMenu(dir, parsed?.rows.map(row => row.label) || [], { complete: !!parsed?.complete }), false);
    assert.deepEqual(models.readMenu(dir), IDS);
  }
  const log = fs.readFileSync(path.join(dir, 'logs', 'codeagent-model.log'), 'utf8');
  assert.match(log, /menu-cache-skipped/); assert.doesNotMatch(log, /description|Other models|Day |Hour |Min /);
});

test('account menu snapshots replace rather than accumulate and never import or delete the legacy global file', t => {
  const dir = temp(t), legacy = path.join(dir, 'codeagent-menu-models.json');
  json(legacy, { models: IDS.slice(0, 2) }); const before = fs.readFileSync(legacy, 'utf8');
  assert.deepEqual(models.readMenu(dir), []);
  models.recordMenu(dir, IDS, { key: 'personal', complete: true, now: 1000 });
  models.recordMenu(dir, ['Qwen-Example'], { key: 'abcdef12', complete: true, now: 2000 });
  assert.deepEqual(models.readMenu(dir, 'personal'), IDS); assert.deepEqual(models.readMenu(dir, 'abcdef12'), ['Qwen-Example']);
  models.recordMenu(dir, [IDS[2]], { key: 'personal', complete: true, now: 3000 });
  assert.deepEqual(models.readMenu(dir, 'personal'), [IDS[2]]); assert.deepEqual(models.readMenu(dir, 'abcdef12'), ['Qwen-Example']);
  assert.equal(models.readMenuEntry(dir).seenAt, 3000); assert.equal(fs.readFileSync(legacy, 'utf8'), before);
});

test('model options use reliable account catalogs and never fall back to known or configured candidates', t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'); config(cfg, IDS);
  json(path.join(dir, 'codeagent-menu-models.json'), { models: IDS.slice(0, 2) });
  assert.deepEqual(models.modelOptions(dir, { configDir: cfg }).map(row => row.id), []);
  models.recordMenu(dir, [...IDS.slice(0, 2), 'Qwen-Menu-Only'], { complete: true });
  models.recordMenu(dir, ['Kimi-Pool-Only'], { key: 'abcdef12', complete: true });
  const options = models.modelOptions(dir, { configDir: cfg, probedModels: IDS.slice(0, 2) });
  assert.deepEqual(options.map(row => row.id), [...IDS.slice(0, 2), 'Qwen-Menu-Only']);
  assert.ok(options.every(row => !row.description?.includes('未在 CodeAgent 菜单中确认')));
  assert.ok(!options.some(row => row.id === 'Kimi-Pool-Only'));
  const fallback = path.join(dir, 'fallback'); json(path.join(fallback, 'settings.json'), { model: 'GLM-5.2-WX', models: ['GLM-5.2-WX-Auto'] });
  assert.ok(!models.modelOptions(null, { configDir: fallback }).some(row => row.id === 'GLM-5.2-WX'), 'unlisted concrete Auto backends stay hidden');
});

test('permission guard and launch routing prefer reliable catalogs over incomplete configuration or old probe values', t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'); config(cfg, [IDS[0], IDS[2]]);
  const file = pool.personalModelsFile(dir);
  json(file, { models: [IDS[0]], defaultModel: IDS[0], at: new Date(1000).toISOString(), source: 'menu' });
  models.recordMenu(dir, ['Qwen-Menu-Only', IDS[0]], { key: 'personal', complete: true, now: 2000 });
  const known = pool.accountModels(cfg, fs, file);
  assert.deepEqual(known.models, ['Qwen-Menu-Only', IDS[0]]); assert.equal(known.probedAt, new Date(2000).toISOString());
  assert.equal(known.defaultModel, IDS[0]);
  const permitted = require('../core/codeagent-default-model-guard').permittedModels({}, cfg, { dataDir: dir });
  assert.deepEqual(permitted.models, known.models); assert.equal(permitted.authoritative, true);
  assert.equal(picker.modelAllowed(IDS[2], permitted.models), false); assert.equal(picker.modelAllowed('Unknown-Not-Listed', permitted.models), false);
  assert.deepEqual(require('../core/codeagent-model-route').personalModels({ dataDir: dir, personalDir: cfg }).models, known.models);
  const poolDir = pool.accountDir(dir, 'abcdef12'); config(poolDir, ['DeepSeek-Config-2']);
  json(path.join(poolDir, probe.MODELS_FILE), { models: ['DeepSeek-Probed-2'], at: new Date(3000).toISOString() });
  models.recordMenu(dir, ['DeepSeek-Menu-2'], { key: 'abcdef12', complete: true, now: 4000 });
  assert.deepEqual(pool.accountModels(poolDir).models, ['DeepSeek-Menu-2']);
  assert.ok(!pool.accountModels(poolDir).models.some(id => id.startsWith('GLM')));
  json(file, { models: [IDS[0]], at: new Date(5000).toISOString(), source: 'menu' });
  assert.equal(pool.accountModels(cfg, fs, file).probedAt, new Date(2000).toISOString());
});

function menuVm(filename, extra = {}, appended = '') {
  const file = path.join(__dirname, '..', 'core', filename), localRequire = createRequire(file), state = { clock: 1000 };
  const DateClock = class extends Date { static now() { return state.clock; } };
  const watchdogs = new Map(); let timerId = 0;
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, Date: DateClock,
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      if (ms >= probe.COMMANDS_ONLY_TIMEOUT_MS) { watchdogs.set(id, { at: state.clock + ms, fn }); return id; }
      state.clock += ms;
      for (const [key, timer] of watchdogs) if (timer.at <= state.clock) { watchdogs.delete(key); timer.fn(); }
      fn(); return id;
    }, clearTimeout: id => watchdogs.delete(id),
    require: name => name === './codeagent-usage-menu' ? { ...usage, readUsageMenu: (lines, options) => usage.readUsageMenu(lines,
      { ...options, now: () => state.clock, sleep: async ms => { state.clock += ms; } }) } : extra[name] || localRequire(name), ...extra.globals,
  });
  new vm.Script(fs.readFileSync(file, 'utf8') + appended, { filename: file }).runInContext(context);
  return { api: context.module.exports, state };
}

for (const parserVersion of [undefined, 1, models.MODEL_MENU_PARSER_VERSION + 1]) test(`stale account menus are ignored without changing the file and log once (${parserVersion ?? 'missing'})`, t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'); config(cfg, IDS);
  const file = path.join(dir, 'codeagent-account-menu-models.json');
  json(file, { schema: 2, accounts: { personal: { models: [IDS[0]], complete: true, parserVersion } } });
  const before = fs.readFileSync(file);
  assert.equal(models.readMenuEntry(dir), null); assert.deepEqual(models.readMenu(dir), []);
  assert.deepEqual(models.modelOptions(dir, { configDir: cfg }).map(row => row.id), []);
  assert.deepEqual(fs.readFileSync(file), before);
  const log = fs.readFileSync(path.join(dir, 'logs', 'codeagent-model.log'), 'utf8');
  assert.equal((log.match(/event=menu-cache-stale-ignored/g) || []).length, 1);
  assert.equal(models.recordMenu(dir, IDS, { complete: true }), true);
  assert.equal(models.readMenuEntry(dir).parserVersion, models.MODEL_MENU_PARSER_VERSION);
  assert.deepEqual(models.readMenu(dir), IDS);
});

test('a current account menu does not certify another account left in the old format', t => {
  const dir = temp(t), file = path.join(dir, 'codeagent-account-menu-models.json');
  const old = { models: [IDS[0]], complete: true, seenAt: 1000 };
  json(file, { schema: 2, accounts: { personal: old, abcdef12: old } });
  models.recordMenu(dir, IDS, { complete: true });
  assert.deepEqual(models.readMenu(dir), IDS); assert.equal(models.readMenuEntry(dir, 'abcdef12'), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts.abcdef12, old);
});

test('personal and pool probe files retain old model values but stamp new menu reads, leaving serve independent', t => {
  const dir = temp(t);
  for (const file of [pool.personalModelsFile(dir), path.join(pool.accountDir(dir, 'abcdef12'), probe.MODELS_FILE)]) {
    json(file, { models: [IDS[0]], at: new Date().toISOString() });
    assert.deepEqual(probe.readProbed(file).models, [IDS[0]]);
    assert.equal(probe.readProbed(file).source, 'menu'); assert.equal(probe.readProbed(file).parserVersion, undefined);
    probe.writeProbed(file, { models: IDS, menuComplete: true });
    assert.equal(probe.readProbed(file).parserVersion, models.MODEL_MENU_PARSER_VERSION);
    assert.deepEqual(probe.readProbed(file).models, IDS);
    probe.writeProbed(file, { models: IDS, source: 'serve' });
    assert.equal(probe.readProbed(file).source, 'serve'); assert.equal(probe.readProbed(file).parserVersion, undefined);
  }
});

function staleProbeIpc(t, { key = 'personal', source = 'menu', parserVersion, configured = IDS } = {}) {
  const dir = temp(t), personalDir = path.join(dir, 'personal');
  const cfg = key === 'personal' ? personalDir : pool.accountDir(dir, key);
  if (configured) config(cfg, configured);
  json(path.join(cfg, '.credentials.json'), { idaasOAuth: { accountId: 'synthetic-account', xAuthToken: 'fixture', expiresAt: Date.now() + 86400000 } });
  if (key !== 'personal') json(path.join(pool.poolRoot(dir), 'pool.json'), { accounts: [{ id: key }] });
  const file = key === 'personal' ? pool.personalModelsFile(dir) : path.join(cfg, probe.MODELS_FILE);
  json(file, { models: [IDS[0]], source, parserVersion, at: new Date().toISOString() });
  json(path.join(dir, 'codeagent-account-menu-models.json'), { schema: 2, accounts: { [key]: { models: [IDS[0]], complete: true } } });
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: personalDir, AI_HUB_CODEAGENT_SERVE: '0' };
  const previous = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]])); Object.assign(process.env, vars);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const handlers = new Map(), calls = [];
  let release, completed;
  const waiting = new Promise(resolve => { release = resolve; });
  const done = new Promise(resolve => { completed = resolve; });
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) },
    sendToRenderer: (name, payload) => { if (name === 'codeagent-pool:changed' && payload.auto) completed(payload); },
    codeagentProbeModels: options => { calls.push(options); return waiting; },
  });
  return { dir, cfg, file, key, handlers, calls, done, release,
    options: () => handlers.get('codeagent:models')(null, key === 'personal' ? { account: 'personal' } : { account: 'pool', poolAccount: key }).options };
}

for (const key of ['personal', 'abcdef12']) for (const parserVersion of [undefined, 0]) test(`old menu probes refresh in the background without restricting dropdowns (${key}, ${parserVersion ?? 'missing'})`, async t => {
  const fixture = staleProbeIpc(t, { key, parserVersion });
  const before = fs.readFileSync(fixture.file);
  assert.deepEqual(fixture.options().map(row => row.id), []);
  assert.ok(fixture.options().every(row => !row.description?.includes('未在 CodeAgent 菜单中确认')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].configDir, fixture.cfg);
  assert.deepEqual(fs.readFileSync(fixture.file), before, 'pending refresh leaves the old probe file untouched');
  fixture.release({ ok: true, models: IDS, menuComplete: true });
  assert.equal((await fixture.done).ok, true);
  assert.equal(probe.readProbed(fixture.file).parserVersion, models.MODEL_MENU_PARSER_VERSION);
  assert.deepEqual(models.readMenu(fixture.dir, key), IDS);
  const status = fixture.handlers.get('codeagent-pool:list')(null);
  const account = key === 'personal' ? status.personal : status.accounts.find(entry => entry.id === key);
  assert.equal(account.modelsParserVersion, models.MODEL_MENU_PARSER_VERSION);
  fixture.options(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
});

test('an unreliable old probe exposes no invented candidates while its replacement is pending', async t => {
  const fixture = staleProbeIpc(t, { configured: null });
  models.recordObserved(fixture.dir, 'DeepSeek-Observed');
  const ids = fixture.options().map(row => row.id);
  assert.deepEqual(ids, []);
  assert.equal(fixture.options().length, 0);
  await new Promise(resolve => setImmediate(resolve));
  fixture.release({ ok: true, models: IDS, menuComplete: true }); await fixture.done;
});

for (const key of ['personal', 'abcdef12']) test(`account-list refresh notices stale parser evidence without opening a model dropdown (${key})`, async t => {
  const fixture = staleProbeIpc(t, { key });
  fixture.handlers.get('codeagent-pool:list')(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].accountKey, key);
  fixture.release({ ok: true, models: IDS, menuComplete: true });
  assert.equal((await fixture.done).ok, true);
});

for (const key of ['personal', 'abcdef12']) for (const source of ['menu', 'serve']) test(`fresh probe evidence keeps its normal cooldown (${key}, ${source})`, async t => {
  const parserVersion = source === 'menu' ? models.MODEL_MENU_PARSER_VERSION : undefined;
  const fixture = staleProbeIpc(t, { key, source, parserVersion });
  const before = fs.readFileSync(fixture.file);
  assert.deepEqual(fixture.options().map(row => row.id), [IDS[0]]);
  fixture.handlers.get('codeagent-pool:list')(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 0); assert.deepEqual(fs.readFileSync(fixture.file), before);
});

for (const cursor of [1, 4]) test(`actual picker moves across groups by model number from cursor ${cursor}`, async t => {
  const dir = temp(t), writes = []; let closed = false, at = cursor;
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : menu({ grouped: true, cursor: at }), dispose() {} };
  const fixture = menuVm('codeagent-model-picker.js', { globals: { screen } }, '\nopenSessionScreen = async () => screen;');
  const target = cursor === 1 ? IDS[3] : IDS[0];
  const result = await fixture.api.pickModel({ manager: { writeToSession: (_id, key) => {
    writes.push(key); if (key === '\x1b[B') at++; if (key === '\x1b[A') at--;
    if (key === '\r' || key === '\x1b') closed = true;
  } },
    sid: 'synthetic', kind: 'codeagent', modelId: target, dataDir: dir });
  assert.equal(result.ok, true); assert.deepEqual(Array.from(result.menu), IDS);
  assert.deepEqual(writes, [...Array(3).fill(cursor === 1 ? '\x1b[B' : '\x1b[A'), '\r']);
});

test('picker records the later complete grouped frame after waiting for Day data', async t => {
  const dir = temp(t); let closed = false, fixture, cursor = 1;
  const early = menu({ ids: IDS.slice(0, 2) }).map(line => line.replace(/Day .*$/, ''));
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : fixture.state.clock < 1160 ? early : menu({ grouped: true, cursor }), dispose() {} };
  fixture = menuVm('codeagent-model-picker.js', { globals: { screen } }, '\nopenSessionScreen = async () => screen;');
  const result = await fixture.api.pickModel({ manager: { writeToSession: (_sid, key) => {
    if (key === '\x1b[B') cursor++; if (key === '\r' || key === '\x1b') closed = true;
  } },
    sid: 'synthetic', kind: 'codeagent', modelId: IDS[3], dataDir: dir });
  assert.equal(result.ok, true); assert.deepEqual(Array.from(result.menu), IDS);
});

test('new-session model option tooltips retain the unconfirmed description and update when it changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/workspace-controller.js'), 'utf8');
  const start = source.indexOf('    const wanted = nativeCodeagentOption + listed.map');
  const end = source.indexOf('\n    }', start) + 6;
  const select = { dataset: {}, innerHTML: '' }, listed = [{ id: IDS[2], label: IDS[2], description: '账号模型探测清单中有' }];
  const context = vm.createContext({ modelSelect: select, listed, selectedKind: 'codeagent', nativeCodeagentOption: '', usageAttrs: () => '', escapeHtml: String });
  vm.runInContext(`{${source.slice(start, end)}\n}`, context);
  assert.match(select.innerHTML, /title="账号模型探测清单中有"/);
  const before = select.dataset.builtFor; listed[0].description = 'CodeAgent 模型菜单里有';
  vm.runInContext(`{${source.slice(start, end)}\n}`, context);
  assert.notEqual(select.dataset.builtFor, before); assert.match(select.innerHTML, /title="CodeAgent 模型菜单里有"/);
});

test('a config-only model passes an old GLM-only permission snapshot, but a missing real option fails without changing the model', async t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'); config(cfg, [IDS[0], IDS[2]]);
  json(pool.personalModelsFile(dir), { models: [IDS[0]], at: new Date().toISOString() });
  const allowed = require('../core/codeagent-default-model-guard').permittedModels({}, cfg, { dataDir: dir }).models;
  for (const present of [true, false]) {
    let closed = false, currentModel = IDS[0], cursor = 1; const writes = [];
    const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : menu({ ids: present ? [IDS[0], IDS[2]] : [IDS[0]], cursor }), dispose() {} };
    const fixture = menuVm('codeagent-model-picker.js', { globals: { screen } }, '\nopenSessionScreen = async () => screen;');
    const result = await fixture.api.pickModel({ manager: { writeToSession: (_id, key) => {
      writes.push(key); if (key === '\r') { currentModel = IDS[2]; closed = true; } if (key === '\x1b') closed = true;
      if (key === '\x1b[B' && present) cursor++;
    } }, sid: 'synthetic', kind: 'codeagent', modelId: IDS[2], allowedModels: allowed, dataDir: dir });
    assert.equal(result.ok, present);
    if (present) assert.equal(currentModel, IDS[2]);
    else { assert.equal(result.message, `这个账号在 CodeAgent 模型菜单里选不了 ${IDS[2]}`); assert.match(result.technicalReason, /模型菜单里没有 DeepSeek/); assert.equal(currentModel, IDS[0]); assert.equal(result.inputReady, true); assert.deepEqual(writes, ['\x1b[B', '\x1b']); }
  }
});

test('probe shares grouped parsing and rejects partial screens without returning a writable model list', async t => {
  const dir = temp(t);
  for (const complete of [true, false]) {
    let opened = false, exit;
    const screen = { write() {}, lines: async () => opened ? (complete ? menu({ grouped: true, wrapped: true }) : menu().slice(0, 11)) : ['❯ ', '? for shortcuts'], dispose() {} };
    const proc = { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; }, write: key => { if (key === '\r') opened = true; }, kill: () => exit() };
    const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen } });
    const result = await fixture.api.probeModels({ command: 'synthetic-codeagent', configDirEnv: 'SYNTHETIC_CONFIG_DIR',
      configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir, ptyModule: { spawn: () => proc } });
    assert.equal(result.ok, complete);
    if (complete) { assert.deepEqual(Array.from(result.models), IDS); assert.equal(result.menuComplete, true); }
    else { assert.equal(result.models, undefined); assert.match(result.error, /未完整/); }
  }
});

test('actual model-list IPC merges config with the selected account cache and probe; usage refresh repairs the cache', async t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'); config(cfg, IDS);
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_SERVE: '0' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  json(pool.personalModelsFile(dir), { models: IDS.slice(0, 2), at: new Date().toISOString(), source: 'menu', parserVersion: models.MODEL_MENU_PARSER_VERSION });
  models.recordMenu(dir, IDS.slice(0, 2), { complete: true });
  const id = 'abcdef12', accountDir = pool.accountDir(dir, id); config(accountDir, ['DeepSeek-Config-2']);
  json(path.join(pool.poolRoot(dir), 'pool.json'), { accounts: [{ id }] });
  json(path.join(accountDir, '.credentials.json'), { idaasOAuth: { accountId: 'synthetic-account', xAuthToken: 'fixture', expiresAt: Date.now() + 86400000 } });
  json(path.join(accountDir, probe.MODELS_FILE), { models: ['DeepSeek-Config-2'], at: new Date().toISOString(), source: 'menu', parserVersion: models.MODEL_MENU_PARSER_VERSION });
  models.recordMenu(dir, ['DeepSeek-Config-2'], { key: id, complete: true });
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}), getSession: sid => ({ kind: 'codeagent', codeagentPoolAccount: sid === 'pool' ? id : null }) },
    sendToRenderer() {}, codeagentProbeModels: async () => ({ ok: true, models: IDS, menuComplete: true, usage: usage.parseCodeAgentUsageMenu(menu()) }),
  });
  const get = payload => handlers.get('codeagent:models')(null, payload).options;
  assert.deepEqual(get({ account: 'personal' }).map(row => row.id), IDS.slice(0, 2));
  assert.ok(get({ account: 'personal' }).every(row => !row.description?.includes('未在 CodeAgent 菜单中确认')));
  const poolIds = ['DeepSeek-Config-2'];
  assert.deepEqual(get({ account: 'pool', poolAccount: id }).map(row => row.id), poolIds);
  assert.deepEqual(handlers.get('codeagent:session-models')(null, { sessionId: 'pool' }).options.map(row => row.id), poolIds);
  assert.deepEqual(handlers.get('codeagent:session-models')(null, { sessionId: 'personal' }).options.map(row => row.id), IDS.slice(0, 2));
  assert.equal((await handlers.get('codeagent:usage-refresh')(null, { key: 'personal' })).ok, true);
  assert.deepEqual(models.readMenu(dir), IDS);
  assert.deepEqual(probe.readProbed(pool.personalModelsFile(dir)).models, IDS);
  assert.ok(get({ account: 'personal' }).every(row => !row.description?.includes('未在 CodeAgent 菜单中确认')));
  assert.deepEqual(models.readMenu(dir, id), ['DeepSeek-Config-2']);
});

for (const scenario of ['existing', 'concurrent', 'concurrent-after-write', 'absent']) test(`real switch-model IPC retains written settings after an absent menu target (${scenario} launch file)`, async t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'), sid = 'synthetic-switch'; config(cfg, [IDS[0], IDS[2]]);
  json(path.join(dir, 'codeagent-last-model.json'), { personal: { model: IDS[0], at: new Date().toISOString() } });
  json(pool.personalModelsFile(dir), { models: [IDS[0]], at: new Date().toISOString() });
  const file = path.join(dir, 'codeagent-launch', sid + '.json');
  const original = JSON.stringify({ model: IDS[0], preserve: true }, null, 2) + '\n';
  if (scenario !== 'absent') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original); }
  let closed = false, writes = 0;
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : menu({ ids: [IDS[0]] }), dispose() {} };
  const pickerFixture = menuVm('codeagent-model-picker.js', { globals: { screen } }, '\nopenSessionScreen = async () => screen;');
  const current = { id: sid, kind: 'codeagent', agentRuntime: 'pty', status: 'idle', codeagentConfigDir: cfg, currentModel: { id: IDS[0], displayName: IDS[0] } };
  const manager = { getSession: () => ({ ...current }), getAllSessions: () => [current], codeagentPoolActiveCounts: () => ({}),
    getSessionBufferSnapshot: async () => ({}),
    updateSessionMeta: (_sid, patch) => Object.assign(current, patch), writeToSession: (_sid, key) => {
      if (key === '\x1b') { closed = true; if (scenario === 'concurrent') json(file, { model: 'external-change' }); }
      assert.notEqual(key, '\r', 'missing target must never be selected');
    } };
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_SERVE: '0' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]])); Object.assign(process.env, vars);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const ipcFile = path.join(__dirname, '..', 'main/ipc/session-handlers.js'), localRequire = createRequire(ipcFile);
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, setImmediate,
    require: name => name === '../../core/codeagent-model-picker' ? pickerFixture.api : name === '../../core/session-manager' ? {
      _private: { codeagentLaunchModel: id => id, writeCodeAgentLaunchSettings: (_root, _sid, id) => {
        writes++; json(file, { model: id }); if (scenario === 'concurrent-after-write') json(file, { model: 'external-change' });
      } },
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(ipcFile, 'utf8'), context);
  const handlers = new Map();
  context.module.exports.registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, { sessionManager: manager, sendToRenderer() {} });
  const result = await handlers.get('codeagent:switch-model')(null, { sessionId: sid, modelId: IDS[2] });
  assert.equal(result.ok, scenario !== 'absent'); assert.equal(result.message, `这个账号在 CodeAgent 模型菜单里选不了 ${IDS[2]}`);
  assert.equal(current.currentModel.id, scenario === 'absent' ? IDS[0] : IDS[2]); assert.equal(closed, true);
  assert.equal(require('../core/codeagent-launch-model').lastModel(dir, 'personal'), IDS[0], 'settings-only changes this session, not future sessions');
  if (scenario !== 'absent') {
    assert.equal(result.mode, 'settings-only'); assert.equal(result.confirmed, false);
    assert.match(fs.readFileSync(path.join(dir, 'logs/codeagent-model.log'), 'utf8'), /event=switch-settings-only/);
    await pickerFixture.api.waitForPick(sid);
    await pickerFixture.api.beforePrompt(manager, sid);
  }
  if (scenario === 'existing') { assert.equal(writes, 1); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: IDS[2] }); }
  if (scenario === 'absent') { assert.equal(writes, 0); assert.equal(fs.existsSync(file), false); }
  if (scenario.startsWith('concurrent')) {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'external-change');
    const log = fs.readFileSync(path.join(dir, 'logs/codeagent-model.log'), 'utf8');
    assert.doesNotMatch(log, /event=model-switch-restore-skipped/);
    assert.doesNotMatch(log, /external-change/);
  }
});

const SCROLL_CAPTURE = fs.readFileSync(path.join(__dirname, 'fixtures/codeagent-model-picker-scroll.txt'), 'utf8').split(/\r?\n/);
const SCROLL_TARGET = 'deepseek-v4.1-flash-1017';
function scrollingPicker(t, { searchWorks = false, ids = ['GLM-5.2-WX-Auto', 'MiniMax-M2.7', 'GLM-5.2', SCROLL_TARGET],
  filterIds = [SCROLL_TARGET], wrap = false, paintDelay = 240, drift = false,
  clearFails = false, blankSearch = false, hideCursor = false, focusWorks = true, focusFirst = true, splitFocus = false, showScrollbar = true } = {}) {
  const dir = temp(t), writes = [], rowIndex = SCROLL_CAPTURE.findIndex(line => /❯\s+1\./.test(line));
  let cursor = 0, nextCursor = 0, paintAt = 0, query = '', closed = false, selected = null, fixture, filteredReads = 0, cursorShown = !hideCursor, cursorShownAt = Infinity, failedClearOnce = false;
  const viewIds = () => query && searchWorks ? filterIds : ids;
  const screen = { dispose() {}, lines: async () => {
    if (closed) return ['❯ ', '? for shortcuts'];
    if (fixture.state.clock >= paintAt) cursor = nextCursor;
    if (fixture.state.clock >= cursorShownAt) cursorShown = true;
    const visible = viewIds();
    const filtered = query && searchWorks;
    if (filtered) filteredReads++;
    const list = filtered ? visible : [visible[cursor]];
    const rows = list.map((id, index) => {
      const at = filtered ? index : cursor;
      const name = drift && filteredReads >= 3 ? 'GLM-5.2-WX-Auto' : id;
      return SCROLL_CAPTURE[rowIndex].replace(/❯\s+1\. GLM-5\.2-WX-Auto default ✓/, `${at === cursor && cursorShown ? '❯' : ' '}  ${at + 1}. ${name}`);
    });
    const lines = SCROLL_CAPTURE.map(line => line.includes('⌕') ? line.replace('Search…', query || (blankSearch ? '' : 'Search…')) : showScrollbar ? line : line.replace(/█/g, ''));
    lines.splice(rowIndex, 1, ...rows);
    return showScrollbar ? lines : lines.map(line => line.replace(/█/g, ''));
  } };
  const manager = { writeToSession: (_sid, key) => {
    writes.push([key, fixture.state.clock]);
    if (key === '\x1b') {
      if (query) {
        if (clearFails && !failedClearOnce) { failedClearOnce = true; return; }
        query = ''; cursor = 0; nextCursor = 0; paintAt = 0;
      } else closed = true;
      return;
    }
    if (key === '\r') { selected = viewIds()[cursor]; closed = true; return; }
    if (/^\x7f+$/.test(key)) { if (!clearFails) query = ''; cursor = 0; nextCursor = 0; paintAt = 0; return; }
    if (key === '\x1b[B' || key === '\x1b[A') {
      if (!cursorShown && focusWorks) {
        if (focusFirst) { cursorShown = true; return; }
        if (splitFocus) cursorShown = true;
        else cursorShownAt = fixture.state.clock + paintDelay;
      }
      const length = viewIds().length, delta = key === '\x1b[B' ? 1 : -1;
      nextCursor = wrap ? (cursor + delta + length) % length : Math.max(0, Math.min(length - 1, cursor + delta));
      paintAt = fixture.state.clock + paintDelay;
      return;
    }
    query = key; cursor = 0; nextCursor = 0; paintAt = 0;
  } };
  const sendToPty = async (_sid, text) => {
    assert.equal(text, '/model'); writes.push([text, fixture.state.clock]);
    closed = false; query = ''; cursor = 0; nextCursor = 0; paintAt = 0;
    return { ok: true, sendStatus: 'ok' };
  };
  fixture = menuVm('codeagent-model-picker.js', { globals: { screen } }, '\nopenSessionScreen = async () => screen;');
  return { dir, writes, manager, sendToPty, api: fixture.api, selected: () => selected,
    run: extra => fixture.api.pickModel({ manager, sid: 'scroll-session', kind: 'codeagent', modelId: SCROLL_TARGET, dataDir: dir, sendToPty, ...extra }) };
}

test('captured single-model viewport is incomplete because its scrollbar is visible', () => {
  const parsed = picker.parsePicker(SCROLL_CAPTURE);
  assert.equal(parsed.rows.length, 1); assert.equal(parsed.rows[0].label, 'GLM-5.2-WX-Auto');
  assert.equal(parsed.complete, false); assert.equal(parsed.incompleteReason, 'scroll-truncated');
  const counted = SCROLL_CAPTURE.map(line => line.replace(/█/g, ''));
  counted.splice(counted.findIndex(line => line.includes('Navigate')), 0, '4 models');
  assert.equal(picker.parsePicker(counted).complete, false);
});

test('one visible model can be searched without writing a partial full-list cache', async t => {
  const f = scrollingPicker(t, { searchWorks: true });
  models.recordMenu(f.dir, ['GLM-5.2-WX-Auto', SCROLL_TARGET], { complete: true });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.selected(), SCROLL_TARGET); assert.equal(result.menu, undefined);
  assert.deepEqual(f.writes.map(([key]) => key), [SCROLL_TARGET, '\r']);
  assert.deepEqual(models.readMenu(f.dir), ['GLM-5.2-WX-Auto', SCROLL_TARGET]);
  assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /event=switch-search.*result=found/);
});

test('filtered search moves to an exact row rather than accepting the highlighted partial match', async t => {
  const f = scrollingPicker(t, { searchWorks: true, filterIds: [SCROLL_TARGET + '-extra', SCROLL_TARGET] });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.selected(), SCROLL_TARGET);
  assert.deepEqual(f.writes.map(([key]) => key), [SCROLL_TARGET, '\x1b[B', '\r']);
});

test('an ineffective search is cleared before scrolling three delayed model frames to the target', async t => {
  const f = scrollingPicker(t), result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.selected(), SCROLL_TARGET);
  assert.deepEqual(f.writes.map(([key]) => key), [SCROLL_TARGET, '\x1b', ...Array(3).fill('\x1b[B'), '\r']);
  const arrows = f.writes.filter(([key]) => key === '\x1b[B');
  assert.ok(arrows.every(([, at], index) => !index || at - arrows[index - 1][1] >= 240));
  assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /event=switch-scroll.*steps=3.*result=found/);
});

for (const wrap of [false, true]) test(`a missing model is rejected after reaching the end or wrapping (${wrap})`, async t => {
  const f = scrollingPicker(t, { ids: ['GLM-5.2-WX-Auto', 'MiniMax-M2.7', 'GLM-5.2'], wrap }), result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.message, `这个账号在 CodeAgent 模型菜单里选不了 ${SCROLL_TARGET}`); assert.match(result.technicalReason, /模型菜单里没有/);
  assert.equal(f.selected(), null); assert.equal(f.writes.some(([key]) => key === '\r'), false);
  assert.equal(f.writes.filter(([key]) => key === '\x1b[B').length, 3);
});

test('a final cursor read refuses a drifted row instead of submitting the wrong model', async t => {
  const f = scrollingPicker(t, { searchWorks: true, drift: true }), result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.message, `这个账号在 CodeAgent 模型菜单里选不了 ${SCROLL_TARGET}`); assert.match(result.technicalReason, /未确认光标已移到/);
  assert.equal(f.selected(), null); assert.equal(f.writes.some(([key]) => key === '\r'), false);
});

const CLEARED_CAPTURE = fs.readFileSync(path.join(__dirname, 'fixtures/codeagent-model-picker-search-cleared.txt'), 'utf8').split(/\r?\n/);
test('the real focused empty search box has no inferred selection and Stats are cropped by display column', () => {
  assert.equal(picker.parsePicker(CLEARED_CAPTURE), null, 'no cursor means no confirmed selection');
  const parsed = picker.parsePicker(CLEARED_CAPTURE, { allowNoCursor: true });
  assert.equal(parsed.cursor, -1); assert.equal(parsed.rows[0].label, 'GLM-5.2-WX-Auto');
  assert.equal(parsed.complete, false); assert.equal(parsed.incompleteReason, 'scroll-truncated');
  const main = picker.modelMenuLines(CLEARED_CAPTURE);
  assert.doesNotMatch(main.join('\n'), /SESSION|VERSION|Update detected/);
  const read = usage.parseCodeAgentUsageMenu(main);
  assert.equal(read.models[0].name, 'GLM-5.2-WX-Auto');
  assert.equal(read.models[0].day.used, '54.56M'); assert.equal(read.models[0].hour.used, '824.44K');
  assert.equal(read.models[0].min.used, '225.02K');
});

test('nonempty search results never count as a complete account model snapshot', () => {
  const frame = menu(); frame.splice(1, 0, `⌕ ${SCROLL_TARGET}`);
  const parsed = picker.parsePicker(frame);
  assert.equal(parsed.complete, false); assert.equal(parsed.incompleteReason, 'filtered-menu');
});

for (const filtered of [false, true]) test(`background model evidence is read before navigation and rejects filtered screens (${filtered})`, async t => {
  const dir = temp(t), keys = []; let opened = false, exit;
  const frame = menu().map(line => line.replace('❯', ' '));
  if (filtered) frame.splice(1, 0, `⌕ ${SCROLL_TARGET}`);
  const screen = { write() {}, lines: async () => opened ? frame : ['❯ ', '? for shortcuts'], dispose() {} };
  const proc = { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; },
    write: key => { keys.push(key); if (key === '\r') opened = true; if (key === '\x1b') opened = false; }, kill: () => exit() };
  const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen } });
  const result = await fixture.api.probeModels({ command: 'synthetic-codeagent', configDirEnv: 'SYNTHETIC_CONFIG_DIR',
    configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir, ptyModule: { spawn: () => proc } });
  assert.equal(result.ok, !filtered);
  if (filtered) { assert.equal(result.menuComplete, undefined); assert.equal(result.models, undefined); }
  else { assert.equal(result.menuComplete, true); assert.deepEqual(Array.from(result.models), IDS); }
  assert.deepEqual(keys.slice(0, 2), ['/model', '\r']);
  assert.ok(keys.slice(2).every(key => key === '\x1b'), 'no search or navigation before collecting the snapshot');
});

test('a cleared search without a placeholder falls back to scrolling without reopening', async t => {
  const f = scrollingPicker(t, { blankSearch: true });
  const result = await f.run({ allowedModels: ['GLM-5.2-WX-Auto'] });
  assert.equal(result.ok, true); assert.equal(f.selected(), SCROLL_TARGET);
  assert.ok(!f.writes.some(([key]) => key === '/model'));
  assert.equal(f.writes.filter(([key]) => key === '\x1b[B').length, 3);
  const snapshot = fs.readFileSync(path.join(f.dir, 'logs/codeagent-model-picker-search.txt'), 'utf8');
  assert.match(snapshot, /switch-search/); assert.match(snapshot, new RegExp(SCROLL_TARGET));
});

test('failed search clearing exits, confirms empty input, reopens and scrolls without searching twice', async t => {
  const f = scrollingPicker(t, { clearFails: true });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.selected(), SCROLL_TARGET);
  assert.deepEqual(f.writes.map(([key]) => key), [SCROLL_TARGET, '\x1b', '\x1b', '\x1b', '/model', ...Array(3).fill('\x1b[B'), '\r']);
  const esc = f.writes.find(([key]) => key === '\x1b')[1], reopen = f.writes.find(([key]) => key === '/model')[1];
  assert.ok(reopen - esc >= 320, 'the ordinary input must settle before /model is sent');
});

for (const focusFirst of [true, false]) test(`a hidden cursor must become visible after Down before the target is selected (focusFirst=${focusFirst})`, async t => {
  const f = scrollingPicker(t, { hideCursor: true, blankSearch: true, focusFirst });
  assert.equal((await f.run()).ok, true); assert.equal(f.selected(), SCROLL_TARGET);
  assert.equal(f.writes.filter(([key]) => key === '\x1b[B').length, focusFirst ? 4 : 3);
});

test('an intermediate cursor-only frame settles through the delayed move before another Down is sent', async t => {
  const f = scrollingPicker(t, { hideCursor: true, blankSearch: true, focusFirst: false, splitFocus: true, paintDelay: 240 });
  assert.equal((await f.run()).ok, true); assert.equal(f.selected(), SCROLL_TARGET);
  const arrows = f.writes.filter(([key]) => key === '\x1b[B');
  assert.equal(arrows.length, 3);
  assert.ok(arrows[1][1] - arrows[0][1] >= 240 + 320, 'the marker-only frame must not trigger a second arrow');
});

test('a menu which never exposes a selected row is not submitted', async t => {
  const f = scrollingPicker(t, { hideCursor: true, focusWorks: false });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.message, `这个账号在 CodeAgent 模型菜单里选不了 ${SCROLL_TARGET}`);
  assert.match(result.technicalReason, /无法确认模型列表的选中项/);
  assert.equal(f.selected(), null); assert.ok(!f.writes.some(([key]) => key === '\r'));
});

test('a serve catalog is displayed exactly and is not expanded by config, observations or menu snapshots', t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'); config(cfg, ['Config-Only', 'GLM-5.2-WX-Auto']);
  models.recordObserved(dir, 'Observed-Only');
  probe.writeProbed(pool.personalModelsFile(dir), { models: ['Serve-Only', 'Probe-Only', 'Probe-Only-Auto'], source: 'serve' });
  const options = () => models.modelOptions(dir, { configDir: cfg });
  const before = options().map(row => row.id);
  assert.deepEqual(before, ['Serve-Only', 'Probe-Only-Auto']);
  models.recordMenu(dir, ['GLM-5.2-WX-Auto', 'Menu-Only'], { complete: true });
  assert.deepEqual(options().map(row => row.id), before);
  assert.ok(options().every(row => row.source === 'serve'));
  assert.ok(options().every(row => !/未确认|未在 CodeAgent 菜单/.test(row.description || '')));
});

for (const key of ['personal', 'abcdef12']) test(`v1 data alone remains unavailable until a reliable catalog is read (${key})`, async t => {
  const fixture = staleProbeIpc(t, { key, parserVersion: 1 });
  models.recordObserved(fixture.dir, 'DeepSeek-Observed');
  const all = fixture.options().map(row => row.id);
  assert.deepEqual(all, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
  fixture.release({ ok: false, error: 'synthetic-menu-unavailable' }); await fixture.done;
  assert.deepEqual(fixture.options().map(row => row.id), all);
});

for (const evidence of ['config', 'v1-menu', 'current-menu', 'serve']) test(`single-model launch shortcut requires reliable background evidence (${evidence})`, t => {
  const dir = temp(t), cfg = path.join(dir, 'personal'), file = pool.personalModelsFile(dir); config(cfg, [IDS[0]]);
  if (evidence !== 'config') json(file, { models: [IDS[0]], source: evidence === 'serve' ? 'serve' : 'menu',
    parserVersion: evidence === 'current-menu' ? models.MODEL_MENU_PARSER_VERSION : 1, at: new Date().toISOString() });
  const known = pool.accountModels(cfg, fs, file);
  const reliable = evidence === 'current-menu' || evidence === 'serve';
  assert.equal(known.probeReliable, reliable);
  const choice = require('../core/codeagent-launch-model').chooseLaunchModel({ models: known.models, authoritative: known.authoritative,
    singleModelReliable: known.probeReliable, first: picker.FIRST_MENU_MODEL });
  assert.equal(choice.open, !reliable);
  assert.equal(choice.reason, reliable ? 'single-model' : 'unknown-list');
});

function pickerSessionIpc(t, f) {
  const cfg = path.join(f.dir, 'personal'), sid = 'scroll-session'; config(cfg, ['GLM-5.2-WX-Auto', SCROLL_TARGET]);
  probe.writeProbed(pool.personalModelsFile(f.dir), { models: ['GLM-5.2-WX-Auto', SCROLL_TARGET] });
  models.recordMenu(f.dir, ['GLM-5.2-WX-Auto', SCROLL_TARGET], { complete: true });
  const vars = { CLAUDE_HUB_DATA_DIR: f.dir, AI_HUB_CODEAGENT_CONFIG_DIR: cfg, AI_HUB_CODEAGENT_SERVE: '0' };
  const previous = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]])); Object.assign(process.env, vars);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const session = { id: sid, kind: 'codeagent', status: 'idle', agentRuntime: 'pty', codeagentConfigDir: cfg };
  const manager = { ...f.manager, getSession: () => ({ ...session }), getAllSessions: () => [session], codeagentPoolActiveCounts: () => ({}),
    updateSessionMeta: (_sid, fields) => Object.assign(session, fields), on: (name, fn) => listeners.set(name, fn) };
  const handlers = new Map(), listeners = new Map(), notices = [];
  const file = path.join(__dirname, '..', 'main/ipc/session-handlers.js'), localRequire = createRequire(file);
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, setImmediate,
    require: name => name === '../../core/codeagent-model-picker' ? f.api : name === '../../core/group-chat-watcher' ? { sendToPty: f.sendToPty } : localRequire(name) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  context.module.exports.registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, { sessionManager: manager, sendToRenderer: (name, payload) => { if (name === 'session-notice') notices.push(payload); } });
  return { handlers, listeners, notices, session };
}

for (const reason of ['switch', 'launch']) for (const present of [true, false]) test(`session ${reason} never rewrites menu or permission files after failed search clearing (${present})`, async t => {
  const ids = ['GLM-5.2-WX-Auto', 'MiniMax-M2.7', 'GLM-5.2', ...(present ? [SCROLL_TARGET] : [])];
  const f = scrollingPicker(t, { clearFails: true, ids, showScrollbar: false }), ipc = pickerSessionIpc(t, f);
  const files = [pool.personalModelsFile(f.dir), path.join(f.dir, 'codeagent-account-menu-models.json')];
  const before = files.map(file => fs.readFileSync(file));
  if (reason === 'switch') assert.equal((await ipc.handlers.get('codeagent:switch-model')(null, { sessionId: 'scroll-session', modelId: SCROLL_TARGET })).ok, present);
  else {
    ipc.listeners.get('codeagent-model-pick')({ sessionId: 'scroll-session', modelId: SCROLL_TARGET, reason: 'launch' });
    if (present) assert.equal((await f.api.waitForPick('scroll-session')).ok, true);
    else {
      // 启动时具体模型没选上、但菜单已关、输入框能用：用 CLI 当前模型照常发首句，提示一句没切到（2026-11-08 公司实测会话空着）。
      const picked = await f.api.waitForPick('scroll-session');
      assert.equal(picked.ok, true); assert.equal(picked.fallback, 'cli-default-model');
      assert.match(ipc.notices[0].message, new RegExp(`没切到 ${SCROLL_TARGET}，先用 CodeAgent 当前模型继续`));
      assert.notEqual(ipc.notices[0].persistent, true);
      assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /event=pick .*fallback=send-with-cli-model/);
    }
  }
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  assert.equal(f.selected(), present ? SCROLL_TARGET : null);
  const log = fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8');
  assert.match(log, /event=switch-search.*result=clear-failed/);
  assert.doesNotMatch(log, /event=permission-list-sync|event=permission-list-stale/);
});

for (const reason of ['switch', 'launch']) test(`a successful ${reason} is accepted even when the saved permission list only contains GLM`, async t => {
  const f = scrollingPicker(t, { searchWorks: true }), ipc = pickerSessionIpc(t, f);
  config(path.join(f.dir, 'personal'), ['GLM-5.2-WX-Auto']);
  probe.writeProbed(pool.personalModelsFile(f.dir), { models: ['GLM-5.2-WX-Auto'] });
  models.recordMenu(f.dir, ['GLM-5.2-WX-Auto'], { complete: true });
  if (reason === 'switch') assert.equal((await ipc.handlers.get('codeagent:switch-model')(null, { sessionId: 'scroll-session', modelId: SCROLL_TARGET })).ok, true);
  else {
    ipc.listeners.get('codeagent-model-pick')({ sessionId: 'scroll-session', modelId: SCROLL_TARGET, reason: 'launch' });
    assert.equal((await f.api.waitForPick('scroll-session')).ok, true);
  }
  assert.equal(f.selected(), SCROLL_TARGET); assert.equal(ipc.session.currentModel.id, SCROLL_TARGET);
  assert.equal(f.writes.filter(([key]) => key === '\r').length, 1, 'no second selection may revert to GLM');
});

test('explicit non-Auto switches compare once, normalize case, and supersede the old target without changing Auto routing', () => {
  const session = { id: 'switch-verify', kind: 'codeagent', currentModel: { id: SCROLL_TARGET }, codeagentActualModel: 'DeepSeek-V4.1' };
  models.expectModelSwitch(session.id, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(models.observeModel(session, SCROLL_TARGET).mismatch, null);
  models.expectModelSwitch(session.id, 'DeepSeek-V4.1');
  models.expectModelSwitch(session.id, SCROLL_TARGET);
  assert.equal(models.observeModel(session, 'DeepSeek-V4.1', { at: 1 }), null, 'a previous answer cannot consume the new request');
  const mismatch = models.observeModel(session, 'DeepSeek-V4.1');
  assert.equal(mismatch.mismatch.requested, SCROLL_TARGET);
  assert.equal(models.mismatchNotice(mismatch.mismatch), '模型切换没有生效，实际仍是 DeepSeek-V4.1');
  assert.equal(models.observeModel(session, 'DeepSeek-V4.1'), null, 'pending explicit target is consumed once');
  session.currentModel.id = 'DeepSeek-V4.1-Auto';
  models.expectModelSwitch(session.id, session.currentModel.id);
  assert.equal(models.observeModel(session, 'DeepSeek-V4.1'), null, 'Auto still permits its own concrete model');
});

test('the real model observation path emits a mismatch notice and switch-mismatch log without retrying a switch', async () => {
  const file = path.join(__dirname, '..', 'main.js'), source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function observeCodeAgentModel('), end = source.indexOf('\n}\n', start) + 2;
  const session = { id: 'observe-switch', kind: 'codeagent', currentModel: { id: SCROLL_TARGET } }, events = [], logs = [], writer = {};
  models.expectModelSwitch(session.id, SCROLL_TARGET);
  const context = vm.createContext({ console, codeAgentModelObservations: new WeakMap(), getHubDataDir: () => 'synthetic',
    sessionManager: { sessions: new Map([[session.id, writer]]), getSession: () => session,
      updateSessionMeta: (_sid, patch) => Object.assign(session, patch) }, sessionStore: { markDirty() {} },
    sendToRenderer: (name, value) => events.push({ name, value }),
    require: name => { assert.equal(name, './core/codeagent-models'); return { ...models,
      appendModelLog: (_dir, fields) => logs.push(fields), recordObserved: () => false }; },
  });
  vm.runInContext(source.slice(start, end), context);
  await context.observeCodeAgentModel(session.id, { modelId: 'DeepSeek-V4.1' });
  assert.equal(events.find(event => event.name === 'session-notice').value.message, '模型切换没有生效，实际仍是 DeepSeek-V4.1');
  assert.equal(logs.find(row => row.event === 'switch-mismatch').actual, 'DeepSeek-V4.1');
});

test('settings-only gets a distinct model-picker success message', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/model-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf("renderModelPicker(menu, badgeEl, sessionId, { text: result.mode === 'settings-only'");
  const end = source.indexOf('await sleep(900)', start), states = [];
  const context = vm.createContext({ result: { mode: 'settings-only' }, menu: {}, badgeEl: {}, sessionId: 'test',
    renderModelPicker: (_menu, _badge, _sid, state) => states.push(state) });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(states[0].text, '已改这个会话的设置，下一条回答起生效（回答后核对实际模型）');
});

test('serve is enabled without an unlock record and can still be explicitly disabled', t => {
  const serve = require('../core/codeagent-serve'), dir = temp(t);
  assert.equal(serve.serveEnabled(dir, {}), true);
  assert.equal(serve.serveEnabled(dir, { AI_HUB_CODEAGENT_SERVE: '0' }), false);
  assert.equal(serve.serveEnabled(dir, { AI_HUB_CODEAGENT_SERVE: '1' }), true);
});

function catalogIpc(t, { key = 'personal', previous, serveRead, menuRead } = {}) {
  const dir = temp(t), personal = path.join(dir, 'personal'), cfg = key === 'personal' ? personal : pool.accountDir(dir, key);
  config(cfg, ['Config-Only', 'MiniMax-M2.7', ...IDS]);
  json(path.join(cfg, '.credentials.json'), { idaasOAuth: { accountId: key, xAuthToken: 'fixture', expiresAt: Date.now() + 86400000 } });
  if (key !== 'personal') json(path.join(pool.poolRoot(dir), 'pool.json'), { accounts: [{ id: key }] });
  const file = key === 'personal' ? pool.personalModelsFile(dir) : path.join(cfg, probe.MODELS_FILE);
  if (previous) json(file, previous);
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_SERVE: '1' };
  const old = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]])); Object.assign(process.env, vars);
  t.after(() => { for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const handlers = new Map(), calls = [], events = [];
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) },
    sendToRenderer: (name, value) => events.push({ name, value }),
    codeagentServeRead: async options => { calls.push(['serve', options]); return serveRead(options); },
    codeagentProbeModels: async options => { calls.push(['menu', options]); return menuRead(options); },
  });
  return { dir, cfg, file, calls, handlers, events,
    read: () => handlers.get('codeagent:models')(null, key === 'personal' ? { account: 'personal' } : { account: 'pool', poolAccount: key }),
    refresh: () => handlers.get('codeagent-pool:probe')(null, { id: key }) };
}

for (const key of ['personal', 'abcdef12']) test(`providers are the exact reliable catalog and quota source for ${key}`, async t => {
  const ids = ['GLM-5.2-WX-Auto', 'DeepSeek-V4.1-Flash-1017'];
  const f = catalogIpc(t, { key, serveRead: async () => ({ ok: true, models: ids, details: ids.map(id => ({ id, load: '低负载' })),
    quotas: Object.fromEntries(ids.map(id => [id, [{ type: 'TPD', used: 25, total: 100 }]])) }), menuRead: () => assert.fail('serve succeeded') });
  assert.deepEqual(f.read().options, []); assert.equal(f.read().catalog.state, 'loading');
  const result = await f.refresh(); assert.equal(result.ok, true);
  assert.deepEqual(f.read().options.map(row => row.id), ids);
  assert.ok(f.read().options.every(row => row.source === 'serve'));
  assert.equal(f.read().catalog.source, 'serve'); assert.equal(f.read().catalog.state, 'ready');
  assert.match(f.read().catalog.message, /更新于 \d{2}:\d{2}/);
  assert.deepEqual(f.calls.map(row => row[0]), ['serve']); assert.equal(f.calls[0][1].configDir, f.cfg);
  assert.equal(pool.accountModels(f.cfg, fs, f.file).probeReliable, true);
  const snapshot = usage.readUsage(f.dir)[key]; assert.equal(snapshot.models[1].day.pct, 25);
  assert.equal(snapshot.source, 'serve'); assert.equal(f.read().options.some(row => row.id === 'MiniMax-M2.7'), false);
});

test('a rejected serve read falls back to the complete screen catalog and quotas', async t => {
  const f = catalogIpc(t, { serveRead: async () => { throw new Error('synthetic serve unavailable'); },
    menuRead: async () => ({ ok: true, models: IDS, menuComplete: true, usage: usage.parseCodeAgentUsageMenu(menu()) }) });
  assert.equal((await f.refresh()).ok, true);
  assert.deepEqual(f.calls.map(row => row[0]), ['serve', 'menu']); assert.deepEqual(f.read().options.map(row => row.id), IDS);
  assert.equal(f.read().catalog.source, 'menu'); assert.equal(usage.readUsage(f.dir).personal.models.length, 4);
});

test('failure retains the last reliable catalog and timestamp; no catalog triggers once and manual retry recovers', async t => {
  for (const hasPrevious of [true, false]) {
    let succeeds = false;
    const previous = hasPrevious ? { models: IDS, source: 'serve', at: '2000-01-01T00:00:00.000Z' } : undefined;
    const f = catalogIpc(t, { previous, serveRead: async () => succeeds ? { ok: true, models: IDS } : { ok: false, error: 'serve unavailable' },
      menuRead: async () => ({ ok: false, error: 'menu-scroll-no-frame' }) });
    const before = hasPrevious && fs.readFileSync(f.file);
    const initial = f.read(); assert.equal(initial.catalog.state, 'loading');
    assert.deepEqual(initial.options.map(row => row.id), hasPrevious ? IDS : []);
    await new Promise(setImmediate);
    const failed = f.read(); assert.equal(failed.catalog.state, 'failed'); assert.match(failed.catalog.message, /本次读取失败：.*menu-scroll-no-frame/);
    if (hasPrevious) { assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(failed.catalog.at, previous.at); }
    else { assert.equal(fs.existsSync(f.file), false); assert.deepEqual(failed.options, []); }
    f.read(); f.read(); await new Promise(setImmediate); assert.equal(f.calls.length, 2, 'failed automatic attempt is not repeated');
    succeeds = true; assert.equal((await f.refresh()).ok, true);
    assert.deepEqual(f.read().options.map(row => row.id), IDS); assert.equal(f.read().catalog.state, 'ready'); assert.equal(f.read().catalog.error, '');
  }
});

function modelPages({ wrap = true, noFrames = false, start = 1, count = 4 } = {}) {
  let clock = 0, revision = 1, at = start;
  const ids = IDS.slice(0, count), writes = [];
  const lines = () => ['Select model', '⌕ Search…', 'Credit用量', '月度: 1/400000', '模型名称  Credit消耗系数  Token用量/配额',
    `❯ ${at}. ${ids[at - 1]}   0x   Day 1M/400M (0.25%)   ● 低负载█`, 'Hour 100K/200M (0.05%) ▐', 'Min 1K/1M (0.1%) ▒', FOOTER];
  return { writes, lines, now: () => clock, revision: () => revision, pause: async ms => { clock += ms; },
    write(key) { writes.push(key); if (key === '\x1b[A') at = Math.max(1, at - 1);
      else at = wrap ? at % ids.length + 1 : Math.min(ids.length, at + 1); if (!noFrames) revision++; },
    readLines: async () => lines() };
}

for (const wrap of [true, false]) test(`multi-screen menus collect all three Token windows by number (${wrap ? 'wrap' : 'two fresh unchanged frames'})`, async () => {
  const f = modelPages({ wrap, start: 3 });
  const result = await picker.collectModelMenu({ ...f, lines: f.lines() });
  assert.equal(result.ok, true); assert.equal(result.menuComplete, true); assert.deepEqual(result.models, IDS);
  assert.ok(result.usage.models.every(row => row.day && row.hour && row.min && row.load === '低负载'));
  assert.deepEqual(f.writes.slice(0, 2), ['\x1b[A', '\x1b[A']);
  assert.equal(f.writes.filter(key => key === '\x1b[B').length, wrap ? 4 : 5);
});

test('a missing navigation frame cannot certify a partial list or replace a reliable catalog', async t => {
  const dir = temp(t), f = modelPages({ noFrames: true }), file = pool.personalModelsFile(dir);
  probe.writeProbed(file, { models: IDS, source: 'serve' }); const before = fs.readFileSync(file);
  const result = await picker.collectModelMenu({ ...f, lines: f.lines() });
  assert.equal(result.ok, false); assert.equal(result.reason, 'menu-scroll-no-frame'); assert.equal(result.atNumber, 1);
  assert.equal(result.models, undefined); assert.deepEqual(fs.readFileSync(file), before);
});

test('the actual hidden probe uses a taller window, collects pages and leaves an empty input', async t => {
  const dir = temp(t), pages = modelPages(); let menuOpen = false, onData, onExit, spawnOptions;
  const screen = { write() {}, dispose() {}, lines: async () => menuOpen ? pages.lines() : ['❯ ', '? for shortcuts'] };
  const writes = [], proc = { onData: fn => { onData = fn; return { dispose() {} }; }, onExit: fn => { onExit = fn; }, kill: () => onExit(),
    write: key => { writes.push(key); if (key === '\r') menuOpen = true; if (key === '\x1b') menuOpen = false;
      if (key === '\x1b[B' || key === '\x1b[A') pages.write(key); onData('frame'); } };
  const f = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen } });
  const result = await f.api.probeModels({ command: 'fake', configDirEnv: 'FAKE_CONFIG', configDir: path.join(dir, 'cfg'), cwd: path.join(dir, 'cwd'), dataDir: dir,
    ptyModule: { spawn: (_command, _args, options) => { spawnOptions = options; return proc; } } });
  assert.equal(result.ok, true); assert.deepEqual(Array.from(result.models), IDS); assert.equal(result.usage.models.length, 4);
  assert.equal(spawnOptions.rows, 160); assert.equal(menuOpen, false); assert.equal(writes.at(-1), '\x1b');
  assert.match(fs.readFileSync(path.join(dir, 'logs/codeagent-model.log'), 'utf8'), /event=menu-scroll ok=true/);
});

test('captured filtered DeepSeek screen parses quotas without a cursor and never certifies a full catalog', () => {
  const lines = require('./fixtures/codeagent-model-search-result.json').lines;
  const parsed = picker.parsePicker(lines, { allowNoCursor: true });
  assert.equal(parsed.rows[0].label, 'DeepSeek-V4.1-Flash-1017'); assert.equal(parsed.cursor, -1);
  assert.equal(parsed.complete, false); assert.equal(parsed.incompleteReason, 'filtered-menu');
  const tokens = usage.parseCodeAgentUsageMenu(picker.modelMenuLines(lines)).models[0];
  assert.equal(tokens.name, 'DeepSeek-V4.1-Flash-1017'); assert.equal(tokens.factor, '0.05x'); assert.equal(tokens.load, '中负载');
  assert.deepEqual([tokens.day.total, tokens.hour.total, tokens.min.total], ['400M', '200M', '5M']);
  assert.deepEqual([tokens.day.pct, tokens.hour.pct, tokens.min.pct], [0, 0, 0]);
});

test('scrollbar block characters are removed from every parsed usage field', () => {
  const tokens = usage.parseCodeAgentUsageMenu(menu().map(line => line.replace('GLM-5.2-Auto', 'GLM-█5.2-Auto')
    .replace('低负载', '低█▐▌▀▄░▒▓负载').replace('400M', '400█M').replace('0-1x', '0-█1x'))).models[0];
  assert.equal(tokens.name, IDS[0]); assert.equal(tokens.load, '低负载'); assert.equal(tokens.factor, '0-1x'); assert.equal(tokens.day.total, '400M');
  assert.doesNotMatch(JSON.stringify(tokens), /[\u2580-\u259f]/);
});

for (const filtered of [true, false]) test(`Esc ${filtered ? 'clears search, then closes' : 'closes an empty search'} and confirms idle`, async () => {
  let clock = 0, query = filtered, open = true; const writes = [];
  const result = await picker.closeModelMenu({ now: () => clock, pause: async ms => { clock += ms; },
    readLines: async () => open ? ['Select model', query ? '⌕ DeepSeek' : '⌕ Search…', ...menu().slice(1)] : ['❯ ', '? for shortcuts'],
    write: key => { writes.push(key); if (query) query = false; else open = false; } });
  assert.equal(result.ok, true); assert.deepEqual(writes, Array(filtered ? 2 : 1).fill('\x1b')); assert.equal(open, false); assert.ok(clock >= 320);
});

test('the close deadline allows two one-second repaint delays and the stable-input barrier', async () => {
  let clock = 0, open = true, query = true, pending = null;
  const writes = [], result = await picker.closeModelMenu({ now: () => clock, pause: async ms => { clock += ms; }, readLines: async () => {
    clock += 40; if (pending && clock >= pending.at) { if (query) query = false; else open = false; pending = null; }
    return open ? ['Select model', query ? '⌕ DeepSeek' : '⌕ Search…', ...menu().slice(1)] : ['❯ ', '? for shortcuts'];
  }, write: key => { writes.push(key); pending = { at: clock + 1000 }; } });
  assert.equal(result.ok, true); assert.equal(writes.length, 2); assert.ok(clock < 3000); assert.ok(clock >= 2320);
});

test('settings-only next-answer verification records match and mismatch once without consuming old answers', () => {
  for (const actual of ['deepseek-v4.1-flash-1017', 'GLM-5.2-Auto']) {
    const s = { id: `settings-${actual}`, kind: 'codeagent', currentModel: { id: SCROLL_TARGET }, codeagentActualModel: actual };
    models.expectModelSwitch(s.id, SCROLL_TARGET, { settingsOnly: true });
    assert.equal(models.observeModel(s, actual, { at: 1 }), null);
    const result = models.observeModel(s, actual);
    assert.equal(result.settingsOnlyVerification.result, actual.startsWith('deepseek') ? 'match' : 'mismatch');
    assert.equal(models.observeModel(s, actual)?.settingsOnlyVerification, undefined);
  }
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(source, /event: 'switch-settings-only-verified'/);
});

test('empty CodeAgent catalogs render a visible loading/failure state and a working retry in the active picker', async () => {
  const elements = [], listeners = new Map(), calls = []; let ready = false;
  const document = { createElement() {
    const element = { children: [], dataset: {}, style: {}, className: '', handlers: {}, ownerDocument: document,
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, appendChild(child) { this.children.push(child); },
      getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, width: 200, height: 20 }) };
    element.classList = { add: name => { element.className += ' ' + name; } };
    Object.defineProperty(element, 'innerHTML', { get() { return this.markup; }, set(value) { this.markup = value; this.children = []; } });
    elements.push(element); return element;
  }, body: { children: [], appendChild(child) { this.children.push(child); } } };
  const session = { kind: 'codeagent', currentModel: { id: 'previous' } };
  const ui = require('../renderer/model-ui').createModelUiController({ document, terminalPanelEl: {}, sessions: new Map([['test', session]]),
    getActiveSessionId: () => 'test', escapeHtml: String, setTimeoutFn() {}, ipcRenderer: {
      on: (name, fn) => listeners.set(name, fn), invoke: async (name, payload) => {
        calls.push([name, payload]); if (name === 'codeagent-pool:probe') { ready = true; return { ok: true }; }
        return { options: ready ? [{ id: IDS[0], label: IDS[0], source: 'serve' }] : [], catalog: ready
          ? { state: 'ready', message: '更新于 12:30' } : { state: 'failed', error: 'offline', message: '本次读取失败：offline' } };
      } } });
  await ui.showModelPicker(document.createElement('span'), 'test');
  const menu = document.body.children[0];
  assert.ok(menu.children.some(child => child.textContent === '沿用 CLI 当前模型'));
  assert.ok(menu.children.some(child => child.textContent === '读取失败：offline'));
  assert.equal(menu.children.filter(child => child.dataset.modelId).length, 0);
  await menu.children.find(child => child.textContent === '重新读取').handlers.click();
  assert.deepEqual(calls.find(([name]) => name === 'codeagent-pool:probe')[1], { id: 'personal' });
  assert.deepEqual(menu.children.filter(child => child.dataset.modelId).map(child => child.dataset.modelId), [IDS[0]]);
  assert.ok(!menu.children.some(child => child.className === 'model-picker-note' || child.textContent === '重新读取'));
  ready = false; listeners.get('codeagent-pool:changed')(null, { id: 'personal', ok: false }); await new Promise(setImmediate);
  assert.ok(menu.children.some(child => child.textContent === '读取失败：offline'));
});

test('new-session CodeAgent without reliable models retains the default option, status and manual retry; other CLIs keep their lists', () => {
  const shared = require('../core/model-options'); assert.deepEqual(shared.MODEL_OPTIONS_BY_KIND.codeagent, []);
  assert.ok(shared.MODEL_OPTIONS_BY_KIND.claude.length); assert.ok(shared.MODEL_OPTIONS_BY_KIND.codex.length);
  const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-controller.js'), 'utf8').replace(/\r\n/g, '\n');
  const elements = new Map(), document = { createElement: () => ({ addEventListener() {} }), getElementById: id => elements.get(id) || null };
  for (const id of ['new-session-tuning', 'new-session-model', 'new-session-config-section', 'new-session-tuning-label', 'new-session-tuning-note']) {
    elements.set(id, { dataset: {}, hidden: true, appendChild(child) { (this.children ||= []).push(child); } });
  }
  const context = vm.createContext({ document, selectedKind: 'codeagent', showAccount: false, selectedModel: '', modelTouchedByUser: false,
    launchModelOptions: () => [], companyApiKind: () => false, resolveDefaultModel: () => '', defaultModelConfig: () => ({}),
    codeagentDefaultModel: '', codeagentUsesPool: () => false, codeagentManualPick: () => '', usageAttrs: () => '', escapeHtml: String,
    companyProvider: {}, paintModelCards: () => {} });
  const start = source.indexOf("    const label = document.getElementById('new-session-tuning-label');"), end = source.indexOf("    const effortLabel =", start);
  vm.runInContext(`(() => {${source.slice(start, end)}\n})()`, context);
  assert.equal(elements.get('new-session-tuning').hidden, false); assert.equal(elements.get('new-session-config-section').hidden, false);
  assert.equal(elements.get('new-session-model').innerHTML, '<option value="">沿用 CLI 当前模型</option>');
  const statusStart = source.indexOf("      if (selectedKind === 'codeagent') {\n        const status = document.createElement('span');");
  const statusEnd = source.indexOf('\n      }', statusStart) + 8;
  context.note = elements.get('new-session-tuning-note'); context.codeagentCatalog = { state: 'failed', message: '本次读取失败：offline' };
  vm.runInContext(source.slice(statusStart, statusEnd), context);
  assert.equal(context.note.hidden, false); assert.equal(context.note.children[0].textContent, '本次读取失败：offline');
  assert.equal(context.note.children[1].textContent, '重新读取'); assert.equal(context.note.children[1].disabled, false);
});

test('a switch reads the searched model quotas and writes session settings using serve spelling before menu selection', async t => {
  const f = scrollingPicker(t, { searchWorks: true, hideCursor: true }), ipc = pickerSessionIpc(t, f);
  const spelled = 'DeepSeek-V4.1-Flash-1017', file = path.join(f.dir, 'codeagent-launch/scroll-session.json');
  json(file, { model: 'GLM-5.2-WX-Auto' }); probe.writeProbed(pool.personalModelsFile(f.dir), { models: [spelled], source: 'serve' });
  const result = await ipc.handlers.get('codeagent:switch-model')(null, { sessionId: 'scroll-session', modelId: SCROLL_TARGET });
  assert.equal(result.ok, true); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, spelled);
  assert.equal(f.selected(), SCROLL_TARGET, 'settings do not skip the actual menu selection');
  const direct = scrollingPicker(t, { searchWorks: true }); const picked = await direct.run();
  const model = picked.usage.models.find(row => row.name.toLowerCase() === SCROLL_TARGET);
  assert.ok(model.day && model.hour && model.min); assert.doesNotMatch(model.load, /[\u2580-\u259f]/);
});

test('the actual answer observer logs settings-only match evidence even when model metadata did not change', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function observeCodeAgentModel('), end = source.indexOf('\n}\n', start) + 2;
  const session = { id: 'settings-only-answer', kind: 'codeagent', currentModel: { id: SCROLL_TARGET }, codeagentActualModel: SCROLL_TARGET }, logs = [];
  models.expectModelSwitch(session.id, SCROLL_TARGET, { settingsOnly: true });
  const context = vm.createContext({ console, codeAgentModelObservations: new WeakMap(), getHubDataDir: () => 'synthetic',
    sessionManager: { sessions: new Map([[session.id, {}]]), getSession: () => session, updateSessionMeta: () => assert.fail('no metadata changed') },
    sessionStore: { markDirty: () => assert.fail('no metadata changed') }, sendToRenderer() {},
    require: () => ({ ...models, appendModelLog: (_dir, fields) => logs.push(fields), recordObserved: () => false }) });
  vm.runInContext(source.slice(start, end), context);
  await context.observeCodeAgentModel(session.id, { modelId: SCROLL_TARGET });
  assert.equal(logs.find(row => row.event === 'switch-settings-only-verified').result, 'match');
});

test('CodeAgent menu headers are empty when ready, short while loading and actionable only on failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/model-ui.js'), 'utf8');
  const start = source.indexOf("    if (/^codeagent(?:-resume)?$/.test(kind)) {", source.indexOf('function renderModelPicker'));
  const end = source.indexOf('    if (options.length === 0)', start);
  for (const state of ['ready', 'loading', 'failed']) {
    const notes = [], buttons = [], context = vm.createContext({ kind: 'codeagent', options: [{ id: IDS[0] }],
      session: { _codeagentModelCatalog: { state, error: state === 'failed' ? 'offline' : '', message: '更新于 12:00 · 来源 serve' } },
      menu: { appendChild: button => buttons.push(button) }, menuNote: (_menu, text) => notes.push(text),
      document: { createElement: () => ({ addEventListener() {} }) } });
    vm.runInContext(source.slice(start, end), context);
    assert.deepEqual(notes, state === 'ready' ? [] : [state === 'loading' ? '正在读取…' : '读取失败：offline']);
    assert.deepEqual(buttons.map(button => button.textContent), state === 'failed' ? ['重新读取'] : []);
  }
});

test('only a fully traversed model table certifies Token completeness', async () => {
  const f = modelPages(), result = await picker.collectModelMenu({ ...f, lines: f.lines() });
  assert.equal(result.usage.modelsComplete, true);
  assert.equal(usage.parseCodeAgentUsageMenu(f.lines()).modelsComplete, undefined);
});

test('an old menu cache stays usable until a successful read replaces it', t => {
  const dir = temp(t), accountDir = pool.accountDir(dir, 'abcdef12');
  json(path.join(accountDir, 'settings.json'), { model: IDS[0] });
  const file = path.join(accountDir, probe.MODELS_FILE);
  json(file, { models: [IDS[0], IDS[2]], defaultModel: IDS[0], source: 'menu', at: new Date().toISOString() });
  const rowOf = known => ({ id: 'abcdef12', state: 'ready', models: known.models, modelsAuthoritative: known.authoritative, activeSessions: 0, lastAssignedAt: 0 });

  const stale = pool.accountModels(accountDir);
  assert.deepEqual(stale.models, [IDS[0], IDS[2]]);
  assert.equal(stale.authoritative, false);
  assert.equal(stale.probeReliable, false);
  assert.equal(pool.pickAccount([rowOf(stale)], { model: IDS[2] })?.id, 'abcdef12');
  assert.equal(pool.pickAccount([rowOf(stale)], { model: 'Not-In-The-Old-List' })?.id, 'abcdef12', 'an incomplete old list refuses nothing');
  const personal = { state: 'ready', avoid: null, models: stale.models, modelsAuthoritative: stale.authoritative };
  assert.deepEqual(pool.pickAutoChoice([], personal, { model: IDS[2] }), { personal: true });

  // A successful read is the only thing that narrows the list.
  json(file, { models: [IDS[0]], defaultModel: IDS[0], source: 'serve', at: new Date().toISOString() });
  const read = pool.accountModels(accountDir);
  assert.deepEqual(read.models, [IDS[0]]);
  assert.equal(read.authoritative, true);
  assert.equal(pool.pickAccount([rowOf(read)], { model: IDS[2] }), null);
  assert.equal(pool.pickAutoChoice([], { ...personal, models: read.models, modelsAuthoritative: read.authoritative }, { model: IDS[2] }), null);
});

// 2026-11-08 公司实测：菜单把 deepseek-v4.1-flash-1017 显示成截断名「DeepSeek-V4.1-Flash-1…」，选模型认不出、首句被退回。
const TRUNCATED = 'DeepSeek-V4.1-Flash-1…';
test('findTarget accepts a uniquely matching truncated label, rejects ambiguous ones, and ignores case for full names', () => {
  const rows = labels => ({ rows: labels.map((label, index) => ({ number: index + 1, label, text: label })) });
  assert.equal(picker.findTarget(rows(['GLM-5.2-WX-Auto', TRUNCATED, 'GLM-5.2']), SCROLL_TARGET), 1);
  assert.equal(picker.findTarget(rows(['GLM-5.2-WX-Auto', 'DeepSeek-V4.1-Flash-1...', 'GLM-5.2']), SCROLL_TARGET), 1);
  assert.equal(picker.findTarget(rows(['GLM-5.2-WX-Auto', TRUNCATED, 'DeepSeek-V4.1-Fla…']), SCROLL_TARGET), -1, 'two truncated candidates: do not guess');
  assert.equal(picker.findTarget(rows([TRUNCATED, 'DeepSeek-V4.1-Flash-1017']), SCROLL_TARGET), 1, 'the full name wins over a truncated one');
  assert.equal(picker.findTarget(rows(['GLM-5.2', 'DEEPSEEK-V4.1-FLASH-1017']), SCROLL_TARGET), 1);
  assert.equal(picker.findTarget(rows(['GLM-5.2', 'DeepSeek-V4.2-Flash…']), SCROLL_TARGET), -1, 'a different version is not a candidate');
  assert.equal(usage.truncatedNameMatches(TRUNCATED, SCROLL_TARGET), true);
  assert.equal(usage.truncatedNameMatches('DeepSeek-V4.1-Flash-1017', SCROLL_TARGET), false, 'only names ending in an ellipsis are truncated');
});

test('search selects a uniquely matching truncated row and a full name in different case', async t => {
  for (const shown of [TRUNCATED, 'DeepSeek-V4.1-Flash-1017']) {
    const f = scrollingPicker(t, { searchWorks: true, ids: ['GLM-5.2-WX-Auto', shown], filterIds: [shown] });
    const result = await f.run();
    assert.equal(result.ok, true, shown); assert.equal(f.selected(), shown);
    assert.deepEqual(f.writes.map(([key]) => key), [SCROLL_TARGET, '\r']);
  }
});

test('search does not pick when two truncated rows match the target', async t => {
  const f = scrollingPicker(t, { searchWorks: true, ids: ['GLM-5.2-WX-Auto', TRUNCATED, 'DeepSeek-V4.1-Flash-10…'], filterIds: [TRUNCATED, 'DeepSeek-V4.1-Flash-10…'] });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.selected(), null); assert.equal(f.writes.some(([key]) => key === '\r'), false);
  assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /event=switch-scroll.*result=ambiguous-truncated/);
});

for (const wrap of [false, true]) test(`scrolling finds a unique truncated row only after seeing the whole list, then steps back to it (wrap ${wrap})`, async t => {
  const f = scrollingPicker(t, { ids: ['GLM-5.2-WX-Auto', TRUNCATED, 'MiniMax-M2.7', 'GLM-5.2'], wrap });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(f.selected(), TRUNCATED);
  assert.ok(f.writes.some(([key]) => key === '\x1b[A'), 'went back up to the remembered row');
  assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /event=switch-scroll.*result=found-truncated/);
});

for (const wrap of [false, true]) test(`scrolling does not pick when two truncated rows match (wrap ${wrap})`, async t => {
  const f = scrollingPicker(t, { ids: ['GLM-5.2-WX-Auto', TRUNCATED, 'MiniMax-M2.7', 'DeepSeek-V4.1-Flash-10…'], wrap });
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.selected(), null); assert.equal(f.writes.some(([key]) => key === '\r'), false);
  assert.match(fs.readFileSync(path.join(f.dir, 'logs/codeagent-model.log'), 'utf8'), /result=ambiguous-truncated/);
});

for (const usable of [true, false]) test(`launch pick failure ${usable ? 'falls back to the CLI model and sends' : 'keeps the first message and shows a persistent notice'}`, async t => {
  const f = scrollingPicker(t);
  const stub = { ...f.api, pickModel: async () => ({ ok: false, inputReady: usable, inputUsable: usable,
    message: `这个账号在 CodeAgent 模型菜单里选不了 ${SCROLL_TARGET}`, technicalReason: '模型菜单里没有 synthetic' }) };
  const ipc = pickerSessionIpc(t, { ...f, api: stub });
  ipc.listeners.get('codeagent-model-pick')({ sessionId: 'scroll-session', modelId: SCROLL_TARGET, reason: 'launch' });
  if (usable) {
    const picked = await f.api.waitForPick('scroll-session');
    assert.equal(picked.ok, true); assert.equal(picked.fallback, 'cli-default-model');
    assert.match(ipc.notices[0].message, /没切到 .*先用 CodeAgent 当前模型继续.*模型菜单里没有 synthetic/);
    assert.notEqual(ipc.notices[0].persistent, true);
  } else {
    await assert.rejects(f.api.waitForPick('scroll-session'), /这个账号在 CodeAgent 模型菜单里选不了/);
    assert.equal(ipc.notices[0].persistent, true);
    assert.match(ipc.notices[0].message, /模型菜单里没有 synthetic.*第一条消息还没发出.*\/model/);
  }
});
