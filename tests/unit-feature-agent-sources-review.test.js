'use strict';
// 11-27 后台功能来源统一的 Antigravity 审查（job 20261127-013837-d469f6）：4 个 P1 + 3 个 P2 的回归。
// 共同场景：没有 CodeAgent、只配了自有 API 的用户，功能走 Claude Code · 自有接口。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-src-review-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const ownChoice = { choice: null, selected: { kind: 'claude', source: 'own', model: 'own-model' }, warning: '', auto: true };

test('P1-1 分身自检：走 Claude Code · 自有接口时不要求本机有 CodeAgent；点回 CodeAgent 账号卡存明确的 CodeAgent', t => {
  const { FleetService } = require('../core/avatar/fleet');
  const service = new FleetService({ dataDir: temp(t), getAssistant: () => null, now: () => Date.now(), noTimer: true });
  const rows = [{ id: 'auto', usable: true, models: [] }, { id: 'api-gateway', gateway: true, usable: false, selected: false, configured: false }];
  const agent = service.preflight('', { rows, codeagentAvailable: false, featureChoice: ownChoice }).agent;
  assert.equal(agent.ok, true); assert.equal(agent.source, 'claude'); assert.match(agent.label, /Claude Code · 自有接口 · own-model/);
  assert.equal(service.preflight('', { rows, codeagentAvailable: false, featureChoice: { choice: null, selected: null } }).agent.ok, false, '真没线路仍报不可用');
  const { accountSwitchChoice } = require('../renderer/avatar-page');
  assert.deepEqual(accountSwitchChoice(rows, ownChoice), { kind: 'codeagent', model: '' });
  assert.equal(accountSwitchChoice(rows, { choice: null, selected: null }), null);
});

test('P1-2 助理页作答线路：Claude Code · 自有接口也算能答，不再提示「没找到 CodeAgent」', t => {
  const choice = require('../core/feature-agent-choice');
  t.mock.method(choice, 'resolve', () => ownChoice);
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const fake = { now: () => 1, deps: { dataDir: temp(t) } };
  const route = CompanyAssistant.prototype.answerRoute.call(fake);
  assert.deepEqual(route, { kind: 'claude', source: 'own', label: 'Claude Code · 自有接口', model: 'own-model', auto: true });
  const { composerState } = require('../renderer/company-assistant-connection');
  assert.notEqual(composerState({ answerRoute: route }, { codeagentInstalled: false }).tone, 'bad');
});

test('P1-3 DSH 一键安装 / npm 全局装（没写 entryPath）也算本机有 DSH', t => {
  const dir = temp(t);
  t.mock.method(require('../core/hub-config'), 'getConfig', () => ({ acp: { providers: {} } }));
  t.mock.method(require('../core/hub-config'), 'readConfigJsonForUpdate', () => ({}));
  t.mock.method(require('../core/dsh-cli-profile'), 'resolveDshCliRuntime', () => ({ entryPath: __filename }));
  const fake = { backend: 'local', companyModels: [], own: { backend: 'api', model: 'own-dsh' }, gatewayModels: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' }] };
  t.mock.method(require('../core/company-api-config'), 'settings', () => ({ claude: fake, codex: fake, 'deepseek-acp': fake }));
  const rows = require('../core/feature-agent-choice').catalog(dir, { env: { USERPROFILE: dir, CODEX_HOME: dir, CLAUDE_HUB_HOME_DIR: dir }, findCommand: () => '' });
  const dsh = rows.find(r => r.kind === 'deepseek-acp');
  assert.notEqual(dsh.reason, '本机没有 DSH'); assert.equal(dsh.available, true);
});

test('P1-4 会议快速问答：会议走 Claude Code · 自有接口时独立连这条线（专用账号目录 + --settings 覆盖层），不靠理解会话', t => {
  const dir = temp(t), work = path.join(dir, 'm'); fs.mkdirSync(work);
  t.mock.method(require('../core/company-api-config'), 'ownConnection', () => ({ baseURL: 'https://own.example/anthropic', apiKey: 'sk-own-0123456789', model: 'own-model' }));
  const { freshTarget } = require('../main/ask-aside/fresh-target');
  const r = freshTarget({ session: { kind: 'codeagent', cwd: work }, selection: 'claude|own-model', cwd: work, hubDataDir: dir, baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'personal' },
    featureChoice: { kind: 'claude', source: 'own', model: 'own-model' }, findCommand: () => 'claude.exe' });
  assert.equal(r.engine, 'claude'); assert.equal(r.model, 'own-model');
  assert.equal(r.config.configDir, path.join(dir, 'meeting-question-claude'));
  assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://own.example/anthropic'); assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(r.config.settingsEnv.ANTHROPIC_BASE_URL, 'https://own.example/anthropic');
});

test('P2-6 功能固定线路的 Claude Code 会话遇到 405 不出 CodeAgent 供应商修复卡', () => {
  const { describe } = require('../core/company-assistant/turn-api-error');
  assert.notEqual(describe('API Error: 405 Method Not Allowed', { apiGatewayRoute: true }).routeRejected, true);
  assert.equal(describe('API Error: 405 Method Not Allowed', {}).routeRejected, true, 'CodeAgent 会话照旧');
});
