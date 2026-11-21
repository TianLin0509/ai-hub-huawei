'use strict';
// 第二批 A 节（2026-11-19）：CLI 退出 / 消息未发送。
// ① PTY 启动用探测到的 Claude 绝对路径；PowerShell「找不到命令」接到已知问题 cli-missing 并给一键安装。
// ② pi 模型条目带 input。③ 签名初始化失败按账号问题分流。④ 两个 Hub 共用数据目录时新会话连自己的反代。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function loadSessionManager() {
  const Module = require('node:module'), load = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'node-pty') return { spawn() { throw new Error('No real CLI in unit tests'); } };
    return load.call(this, id, ...args);
  };
  try { return require('../core/session-manager'); } finally { Module._load = load; }
}

test('① PTY 启动：claude 只装在 ~\\.local\\bin、不在 PATH 上时，用绝对路径启动', t => {
  const { _private } = loadSessionManager();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exit-pty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude.exe'), '');
  const env = { USERPROFILE: root, HOME: root, PATH: '', AI_HUB_CLI_TOOLS_DIR: path.join(root, 'tools') };
  assert.equal(_private.claudePtyExecutable(env, 'win32'), path.join(bin, 'claude.exe'));
  assert.equal(_private.claudePtyExecutable(env, 'linux'), null, '非 Windows 不改');
  assert.equal(_private.claudePtyExecutable({ USERPROFILE: path.join(root, 'none'), PATH: '', AI_HUB_CLI_TOOLS_DIR: path.join(root, 'tools') }, 'win32'), null,
    '哪里都没有时返回空，调用方照旧用裸命令');
  if (process.platform === 'win32') {
    const before = process.env.CLAUDE_HUB_DATA_DIR;
    process.env.CLAUDE_HUB_DATA_DIR = root;
    t.after(() => { if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before; });
    const launch = _private.buildClaudePtyLaunch('abs', 'claude', { model: 'claude-opus-4-8', effort: 'max', fastMode: false, mcpProfile: 'none' }, root, env, {});
    assert.ok(launch.cmd.startsWith(` & '${path.join(bin, 'claude.exe')}' `), launch.cmd);
    assert.match(launch.cmd, /--session-id [0-9a-f-]{36}/);
  }
});

test('① 终端停在 PowerShell「找不到命令」上：认出缺哪个 CLI（中英文、折行、绝对路径）', () => {
  const { detectMissingCliCommand } = require('../core/host-shell-detector');
  const zh = [
    'PS D:\\work>  claude --session-id b7c2e331 --model GLM-5.2-WX',
    'claude : 无法将“claude”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。',
    '所在位置 行:1 字符: 2', '+  claude --session-id b7c2e331 --model GLM ...', '+  ~~~~~~',
    '    + CategoryInfo          : ObjectNotFound: (claude:String) [], CommandNotFoundException',
    '    + FullyQualifiedErrorId : CommandNotFoundException', '', 'PS D:\\work> ',
  ].join('\r\n');
  assert.equal(detectMissingCliCommand(zh), 'claude');
  const en = "codex : The term 'codex' is not recognized as the name of a cmdlet\r\n    + CategoryInfo          : ObjectNot\r\nFound: (codex:String) [], CommandNotFoundException\r\n    + FullyQualifiedErrorId : CommandNotFoundException\r\n\r\nPS C:\\Users\\x> ";
  assert.equal(detectMissingCliCommand(en), 'codex', 'ConPTY 折行也认');
  const abs = "    + CategoryInfo          : ObjectNotFound: (C:\\Users\\x\\.local\\bin\\claude.exe:String) [], CommandNotFoundException\r\n    + FullyQualifiedErrorId : CommandNotFoundException\r\nPS C:\\Users\\x> ";
  assert.equal(detectMissingCliCommand(abs), 'claude');
  assert.equal(detectMissingCliCommand(zh + 'dir\r\n    Directory: D:\\work\r\nPS D:\\work> '), null, '报错之后又跑了别的命令就不算');
  assert.equal(detectMissingCliCommand('PS D:\\work> '), null);
  assert.equal(detectMissingCliCommand("+ CategoryInfo : ObjectNotFound: (git:String) [], CommandNotFoundException\r\nPS D:\\w> "), null, '只认 Agent CLI');
});

test('① 已知问题 cli-missing：Hub 文案与 PowerShell 原文都命中，Claude/Codex 给一键安装', () => {
  const { matchKnownIssue } = require('../core/known-issues');
  const hub = matchKnownIssue({ area: 'toast', details: '消息未发送：未找到 Claude Code CLI：终端里「claude」无法识别，CLI 没有启动，消息未发送' });
  assert.equal(hub.id, 'cli-missing');
  assert.equal(hub.title, '这台电脑上没找到 Claude Code');
  assert.deepEqual(hub.action, { label: '一键安装 Claude Code', act: 'known:cli-install:claude' });
  assert.match(hub.fix, /重启/);
  for (const raw of ['claude : 无法将“claude”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。',
    "claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    '+ CategoryInfo          : ObjectNotFound: (claude:String) [], CommandNotFoundException']) {
    const m = matchKnownIssue({ details: raw });
    assert.equal(m && m.id, 'cli-missing', raw);
    assert.equal(m.action.act, 'known:cli-install:claude');
  }
  const codex = matchKnownIssue({ details: "The term 'codex' is not recognized as the name of a cmdlet" });
  assert.equal(codex.action.act, 'known:cli-install:codex');
  const kimi = matchKnownIssue({ details: '未找到 Kimi Code CLI。请从首页「安装说明」安装' });
  assert.equal(kimi.id, 'cli-missing');
  assert.equal(kimi.action, null, '没有一键安装的仍按原来的说明');
  assert.match(kimi.fix, /安装说明/);
  const { humanizeError } = require('../core/error-humanize');
  assert.equal(humanizeError('claude : 无法将“claude”项识别为 cmdlet').kind, 'not-found');
  assert.equal(humanizeError('ObjectNotFound: (claude:String) [], CommandNotFoundException').kind, 'not-found');
});

test('① 发送时 CLI 已退回 PowerShell 且缺程序：报「未找到 X CLI」而不是笼统的「已退出」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  assert.match(src, /detectMissingCliCommand\(sessionManager\.getSessionBuffer\(sid\)/);
  assert.match(src, /未找到 \$\{missingName\} CLI：终端里「\$\{missing\}」无法识别/);
  const card = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub-error-card.js'), 'utf8');
  assert.match(card, /known:cli-install:\(claude\|codex\)/);
  assert.match(card, /cli-tools:install', \{ id \}/);
});

test('② pi：Hub 注入的每个模型都带 input，pi 不再报 reading includes', () => {
  const pi = require('../core/pi-cli-profile');
  const routes = pi.availableRoutes({ acp: { apiKey: 'k' } }, {}, {});
  for (const route of routes) for (const model of (route.providerConfig?.models || [])) assert.deepEqual(model.input, ['text'], route.id + '/' + model.id);
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'pi-cli-profile.js'), 'utf8');
  assert.equal((src.match(/reasoning: true, input: \['text'\]/g) || []).length, 2, '公司模型与 Token Plan 两处都写');
});

test('③ 签名初始化：CodeAgent 起来几秒就以非 0 退出、没写日志 → 说成账号问题，主按钮个人账号重新登录', async () => {
  const { signerInitFailureMessage } = await import('../core/company-proxy/upstream-profile.mjs');
  const report = { cliStarted: true, stoppedBy: 'exit', elapsedMs: 10200, cliExitCode: 1, logExists: false };
  const text = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { version: '1.2615.02.02-03', detail: 'LOG_MISSING', report });
  assert.match(text, /CodeAgent 账号本身现在用不了/);
  assert.match(text, /个人账号重新登录/);
  assert.doesNotMatch(text, /点「重新启动模型通道」再试一次/);
  const { matchKnownIssue } = require('../core/known-issues');
  const m = matchKnownIssue({ area: 'session-create', details: '创建失败：' + text });
  assert.equal(m.id, 'codeagent-account-unusable');
  assert.equal(m.title, 'CodeAgent 账号现在用不了');
  assert.deepEqual(m.action, { label: '个人账号重新登录', act: 'known:codeagent-personal-login' });
  assert.deepEqual(m.more.map(a => a.act), ['known:proxy-restart']);
  // 旧版文案（5.6.47 用户贴的原文）也认。
  const old = '创建失败：公司模型暂时用不了：首次签名初始化没完成（CodeAgent 命令行跑完了，但没有留下签名信息：签名日志没有生成）。\n本次探测约 10.2 秒后 CodeAgent 就退出了（退出码 1），未生成签名日志。\n处理办法：…点「重新启动模型通道」再试一次。';
  assert.equal(matchKnownIssue({ area: 'session-create', details: old }).id, 'codeagent-account-unusable');
  // 超时、退出码 0、清理未确认这些别的原因仍归「反代没能启动」。
  const timeout = signerInitFailureMessage('SIGNER_INIT_TIMEOUT', { timeoutMs: 60000, report: { cliStarted: true, stoppedBy: 'timeout' } });
  assert.doesNotMatch(timeout, /账号本身/);
  assert.equal(matchKnownIssue({ area: 'session-create', details: timeout }).id, 'company-proxy-failed');
  const zero = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'LOG_MISSING', report: { ...report, cliExitCode: 0 } });
  assert.equal(matchKnownIssue({ area: 'session-create', details: zero }).id, 'company-proxy-failed');
  const cleanup = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'LOG_MISSING', report: { ...report, retrySuppressed: 'cleanup-unconfirmed' } });
  assert.notEqual(matchKnownIssue({ area: 'session-create', details: cleanup })?.id, 'codeagent-account-unusable');
});

test('④ 同一数据目录两个 Hub：本进程的反代在跑时，新会话用自己的端口，不信 endpoint.json 被别人改写的端口', t => {
  const proxy = require('../core/company-model-proxy');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exit-endpoint-'));
  t.after(() => { proxy.noteLiveEndpoint(dataDir, null); fs.rmSync(dataDir, { recursive: true, force: true }); });
  proxy.ensureEndpoint(dataDir, { preferredPort: 18765 });
  proxy.noteLiveEndpoint(dataDir, { port: 18765, key: JSON.parse(fs.readFileSync(proxy.endpointFile(dataDir), 'utf8')).key });
  // 后开的 Hub 因 18765 被占换端口并写进文件。
  const file = proxy.endpointFile(dataDir);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), port: 56926 }));
  const env = {};
  proxy.applyClaudeEnv(env, { dataDir, sessionId: 's1', model: 'x' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18765');
  // 本进程的反代停了：回到文件里的端口（那是另一个还活着的 Hub 的反代）。
  proxy.noteLiveEndpoint(dataDir, null);
  const env2 = {};
  proxy.applyClaudeEnv(env2, { dataDir, sessionId: 's2', model: 'x' });
  assert.equal(env2.ANTHROPIC_BASE_URL, 'http://127.0.0.1:56926');
  const service = fs.readFileSync(path.join(__dirname, '..', 'main', 'company-proxy-service.js'), 'utf8');
  assert.equal((service.match(/noteLiveEndpoint\(this\.dataDir, null\)/g) || []).length, 3, '启动前、意外退出、停止都清掉');
  assert.match(service, /setEndpointPort\(this\.dataDir, ready\.port\);[\s\S]{0,200}noteLiveEndpoint\(this\.dataDir, \{ port: ready\.port, key: endpoint\.key \}\)/);
});

test('④ Codex 复核 P2：两个 Hub 同时首次启动、文件里的 Key 是另一个生成的——本进程用自己的端口和 Key 成对', t => {
  const proxy = require('../core/company-model-proxy');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exit-endpoint-key-'));
  t.after(() => { proxy.noteLiveEndpoint(dataDir, null); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const mine = 'a'.repeat(48), theirs = 'b'.repeat(48);
  proxy.noteLiveEndpoint(dataDir, { port: 18765, key: mine });
  fs.mkdirSync(path.dirname(proxy.endpointFile(dataDir)), { recursive: true });
  fs.writeFileSync(proxy.endpointFile(dataDir), JSON.stringify({ port: 56926, key: theirs }));
  assert.deepEqual({ port: proxy.readEndpoint(dataDir).port, key: proxy.readEndpoint(dataDir).key }, { port: 18765, key: mine });
  const env = {};
  proxy.applyClaudeEnv(env, { dataDir, sessionId: 's1', model: 'x' });
  assert.ok(env.ANTHROPIC_AUTH_TOKEN.startsWith(mine + '.'), '会话 Key 用本进程反代的');
  fs.rmSync(proxy.endpointFile(dataDir));
  assert.equal(proxy.readEndpoint(dataDir).port, 18765, '文件没了也用本进程的');
  proxy.noteLiveEndpoint(dataDir, { port: 18765, key: 'short' });
  assert.equal(proxy.readEndpoint(dataDir), null, 'Key 不合规就不登记');
});
