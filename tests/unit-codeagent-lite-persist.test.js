'use strict';
// CodeAgent-Lite 功能会话的全链持久化（2026-11-24 三审 P0-3）：
// 主进程公开形状 → 渲染层落盘行 → handlePersistSessions（主进程权威回填）→ 会话文件 → 恢复参数
// 全程保留 codeagentRunMode=serve、codeagentLiteFeature、featureAgent、featureAgentChoice；
// 恢复后仍走共享 serve，功能选型不被误判为已变。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-lite-persist-'));
process.env.CLAUDE_HUB_DATA_DIR = root;
process.env.AI_HUB_DATA_DIR = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const HUB = 'aaaaaaaa-1111-4111-8111-000000000001';
const choice = require('../core/feature-agent-choice');
const routes = require('../core/codeagent-assistant-route');
const runMode = require('../core/codeagent-run-mode');
const backends = [{ kind: 'codeagent', label: 'CodeAgent', available: true, models: [] },
  { kind: 'codeagent-lite', label: 'CodeAgent-Lite（省内存）', available: true, models: [] }];

test('全链：公开形状 → 落盘 → 恢复，Lite 功能会话仍走共享 serve 且选型不变', async () => {
  routes.setFeaturePreference(root, 'assistant', { kind: 'codeagent-lite', model: '' });
  const created = choice.session(root, 'assistant', 'codeagent', { id: HUB, purpose: 'company-assistant', autonomous: true }, { backends });
  assert.equal(created.opts.codeagentLiteFeature, true);
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });

  // 1. 主进程公开形状（session-manager _toPublic）
  const { SessionManager } = require('../core/session-manager');
  const info = { id: HUB, kind: 'codeagent', cwd, title: '助理', status: 'idle', purpose: 'company-assistant', runtimeBackend: 'acp',
    codeagentRunMode: 'serve', codeagentLiteFeature: true, featureAgent: 'assistant', featureAgentChoice: created.opts.featureAgentChoice,
    ccSessionId: 'bbbbbbbb-2222-4222-8222-000000000002', acpSid: 'bbbbbbbb-2222-4222-8222-000000000002' };
  const pub = SessionManager.prototype._toPublic.call(Object.create(SessionManager.prototype), info);
  assert.equal(pub.codeagentRunMode, 'serve');
  assert.equal(pub.codeagentLiteFeature, true);
  assert.equal(pub.featureAgent, 'assistant');
  assert.equal(pub.featureAgentChoice, created.opts.featureAgentChoice);
  const authoritative = pub;

  // 2. 渲染层落盘行：两处组装（正常持久化、休眠重建）都带上三项
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  for (const v of ['s', 'meta']) {
    assert.ok(renderer.includes(`...(${v}.codeagentLiteFeature === true ? { codeagentLiteFeature: true } : {}),`), v);
    assert.ok(renderer.includes(`...(${v}.featureAgent ? { featureAgent: ${v}.featureAgent, featureAgentChoice: ${v}.featureAgentChoice || '' } : {}),`), v);
  }

  // 3. 渲染层漏带时，主进程权威回填
  const persistence = require('../main/ipc/persistence-handlers');
  let saved = null, lastSessions = [];
  const list = [{ hubId: HUB, kind: 'codeagent', cwd, title: '助理', purpose: 'company-assistant', ccSessionId: info.ccSessionId }];
  persistence.handlePersistSessions(list, [], {
    sessionManager: { getSession: id => (id === HUB ? authoritative : undefined), _openOwners: () => ({ owner: () => null, editClosed: (_i, f) => f(), editSessions: (_i, f) => f() }) },
    getLiveSession: () => null,
    getLastPersistedSessions: () => lastSessions, setLastPersistedSessions: v => { lastSessions = v; },
    getLastPersistedSessionIds: () => new Set(), setLastPersistedSessionIds() {},
    getLastPersistedMeetingIds: () => new Set(), setLastPersistedMeetingIds() {},
    getImmersiveByMeeting: () => ({}), meetingManager: { getAllMeetings: () => [] }, meetingStore: {},
    sessionStore: { markDirty: (_id, value) => { saved = value; } }, stateStore: { save() {} },
  });
  assert.ok(saved, '落盘');
  assert.equal(saved.codeagentRunMode, 'serve');
  assert.equal(saved.codeagentLiteFeature, true);
  assert.equal(saved.featureAgent, 'assistant');
  assert.equal(saved.featureAgentChoice, created.opts.featureAgentChoice);

  // 4. 会话文件（session-store _buildSessionPayload）
  const store = require('../core/session-store');
  store.saveSessionFile(HUB, { ...saved, updatedAt: Date.now() });
  const loaded = store.loadSessionFile(HUB, { strict: true });
  assert.equal(loaded.codeagentRunMode, 'serve');
  assert.equal(loaded.codeagentLiteFeature, true);
  assert.equal(loaded.featureAgent, 'assistant');
  assert.equal(loaded.featureAgentChoice, created.opts.featureAgentChoice);
  assert.equal(choice.stale(root, 'assistant', loaded, { backends }), false);

  // 5. 恢复参数
  const calls = [];
  const manager = { sessions: new Map(), getSession: () => null, getAllSessions: () => [], getNativeSession: () => null,
    createSession(kind, opts) { calls.push({ kind, opts }); return { id: opts.id || HUB, kind, cwd: opts.cwd, status: 'idle' }; } };
  const resume = require('../main/ipc/resume-session-handlers').createResumeSessionHandler({
    fs, os, path, getHookPort: () => 0, getHubDataDir: () => root, sessionManager: manager,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: () => null, meetingManager: { getAllMeetings: () => [] }, registerSessionForTap() {}, sendToRenderer() {}, slotIds: [],
  });
  await resume({ hubId: HUB }, { skipLaunchAuth: true });
  const last = calls.at(-1);
  assert.ok(last, '恢复时建了会话');
  assert.equal(last.opts.codeagentRunMode, 'serve');
  assert.equal(last.opts.codeagentLiteFeature, true);
  assert.equal(last.opts.featureAgent, 'assistant');
  assert.equal(runMode.usesServeRuntime(last.kind, last.opts), true);
  assert.equal(choice.stale(root, 'assistant', last.opts, { backends }), false);
});

test('非 Lite 的 serve 后台会话：恢复不带 Lite 标记，后台功能用途照旧不走 serve', () => {
  const meta = require('../core/session-capabilities').buildSessionResumeMeta({ id: 'x', kind: 'codeagent', codeagentRunMode: 'serve', purpose: 'company-assistant' });
  assert.equal('codeagentLiteFeature' in meta, false);
  assert.equal(runMode.usesServeRuntime('codeagent-resume', { codeagentRunMode: 'serve', purpose: 'company-assistant', resumeCCSessionId: 'a' }), false);
});

test('助理选 Lite：先写好工作目录 .mcp.json（受控 Hub MCP），再建共享 serve 驱动', () => {
  const sm = require('../core/session-manager');
  const cwd = path.join(root, 'company-assistant', 'desk'); fs.mkdirSync(cwd, { recursive: true });
  const configDir = path.join(root, 'codeagent-personal'); fs.mkdirSync(configDir, { recursive: true });
  const mcpConfigFile = path.join(root, 'assistant-mcp.json');
  fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { 'hub-assistant-tools': { command: 'node', args: ['tools.js'] } } }));
  const opts = choice.session(root, 'assistant', 'codeagent', { id: 'lite-mcp', purpose: 'company-assistant', autonomous: true, mcpConfigFile }, { backends }).opts;
  assert.equal(runMode.usesServeRuntime('codeagent', opts), true);
  const capabilities = require('../core/codeagent-capabilities'), original = capabilities.readHelp;
  capabilities.readHelp = () => '--mcp-config --append-system-prompt-file --permission-mode --model';
  try { sm._private.buildCodeAgentPtyLaunch('lite-mcp', 'codeagent', opts, cwd, {}, { configDir, command: 'not-executed' }); }
  finally { capabilities.readHelp = original; }
  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
  assert.ok(written.mcpServers['hub-assistant-tools'], 'serve 原生读取的 <cwd>/.mcp.json 里有 Hub 受控工具');
  // 建会话时先算 PTY 启动（含上面写 .mcp.json），再建 serve 驱动。
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const built = src.indexOf('codeagentLaunch = buildCodeAgentPtyLaunch(id, kind, opts, spawnCwd');
  const driver = src.indexOf('? createCodeAgentServeDriver({ id, opts, cwd: spawnCwd');
  assert.ok(built > 0 && driver > built);
});
