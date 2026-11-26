'use strict';
// R47 组队指路：Hub 启动 Agent 时写进系统提示的固定一段（core/team-guide.js）。
// R47 team guide: fixed section appended to the launch system prompt.
// 撤掉 session-manager hubRulesSystemPrompt 里追加指路的那几行，用例 1、3 就失败；撤掉成员判断，用例 2 就失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionManager } = require('../core/session-manager');
const { createHubRulesStore } = require('../core/hub-rules');
const guide = require('../core/team-guide');

function manager(t, { rulesOn = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r47-guide-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createHubRulesStore({ dataDir, env: {}, loadPersonal: () => null });
  store.setEnabled(rulesOn);
  const m = Object.create(SessionManager.prototype);
  m.memoryService = { hubRules: store };
  return m;
}
const read = r => fs.readFileSync(r.file, 'utf8');

test('用例 1：普通会话的系统提示里带组队指路，且排在通用规则之后', t => {
  const r = manager(t).hubRulesSystemPrompt({ kind: 'codeagent' });
  assert.ok(r && r.file);
  const text = read(r);
  assert.ok(text.includes(guide.TEAM_GUIDE));
  assert.ok(text.indexOf('通用规则') < text.indexOf('## 组队指路'));
  assert.match(r.label, /组队指路/);
  assert.ok(r.version, '通用规则版本照旧记着，随消息补送的判断不受影响');
});

test('用例 2：团队成员（Hub 招来的子会话）与自动分配任务会话不带指路', t => {
  const m = manager(t);
  const member = m.hubRulesSystemPrompt({ kind: 'codeagent', hubTeamMember: true });
  assert.ok(member, '通用规则照常带');
  assert.ok(!read(member).includes('## 组队指路'));
  const auto = m.hubRulesSystemPrompt({ kind: 'codeagent', purpose: 'company-assistant' });
  assert.ok(!read(auto).includes('## 组队指路'));
  assert.ok(read(auto).includes('自动分配任务会话的工作方式'));
});

test('用例 3：规则页整体关掉时，指路仍在；成员此时没有任何系统提示文件', t => {
  const m = manager(t, { rulesOn: false });
  const r = m.hubRulesSystemPrompt({ kind: 'codeagent' });
  assert.ok(r && r.file);
  assert.equal(r.version, undefined, '没有通用规则，随消息补送仍按原逻辑走');
  assert.ok(read(r).includes(guide.TEAM_GUIDE));
  assert.ok(!read(r).includes('通用规则'));
  assert.equal(m.hubRulesSystemPrompt({ kind: 'codeagent', hubTeamMember: true }), null);
});

test('用例 4：自带人设的会话（场景、写作）整体跳过，不带指路', t => {
  const m = manager(t);
  assert.equal(m.hubRulesSystemPrompt({ kind: 'codeagent', purpose: 'writing' }), null);
  assert.equal(m.hubRulesSystemPrompt({ kind: 'codeagent', purpose: 'scene-life' }), null);
});

test('用例 5：指路文字有中英两版，中文正文 300 字以内', () => {
  assert.match(guide.TEAM_GUIDE, /company-team/);
  assert.match(guide.TEAM_GUIDE, /hub-team/);
  assert.match(guide.TEAM_GUIDE, /When the user asks to form a team/);
  const zh = guide.TEAM_GUIDE.split('\n').filter(line => /[一-鿿]/.test(line)).join('');
  assert.ok([...zh].length <= 300, `中文 ${[...zh].length} 字`);
});

test('用例 6：团队成员标记随会话存盘，Hub 重启后恢复的成员仍不带指路', t => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r47-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // session-store 在加载时读数据目录，单独开进程避免影响同文件其他用例。
  const code = `const s=require(${JSON.stringify(path.resolve(__dirname, '../core/session-store'))});
    s.saveSessionFile('m-1',{kind:'codeagent',title:'成员',cwd:${JSON.stringify(root)},hubTeamMember:true,updatedAt:Date.now()});
    s.saveSessionFile('n-1',{kind:'codeagent',title:'普通',cwd:${JSON.stringify(root)},updatedAt:Date.now()});
    process.stdout.write(JSON.stringify([s.loadSessionFile('m-1').hubTeamMember,s.loadSessionFile('n-1').hubTeamMember===true]));`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, CLAUDE_HUB_DATA_DIR: root }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [true, false]);
});

test('用例 7：群聊成员（会议室里的会话）不带指路；新建与原地重拉同口径', t => {
  const m = manager(t);
  const groupMember = m.hubRulesSystemPrompt({ kind: 'codeagent', meetingId: 'meeting-1' });
  assert.ok(groupMember, '通用规则照常带');
  assert.ok(!read(groupMember).includes('## 组队指路'));
  assert.ok(read(m.hubRulesSystemPrompt({ kind: 'codeagent', meetingId: null })).includes('## 组队指路'));
  // 规则全关时，群聊成员没有任何系统提示文件
  const off = manager(t, { rulesOn: false });
  assert.equal(off.hubRulesSystemPrompt({ kind: 'codeagent', meetingId: 'meeting-1' }), null);
  assert.equal(guide.teamGuideFor({ meetingId: 'meeting-1' }), null);
});

test('用例 8：只给 CodeAgent（含恢复）带；Claude、DeepSeek-Claude 不带；原地重拉按会话记录同口径判断', t => {
  const m = manager(t);
  assert.ok(read(m.hubRulesSystemPrompt({ kind: 'codeagent-resume' })).includes('## 组队指路'));
  for (const kind of ['claude', 'claude-resume', 'deepseek-claude']) {
    const r = m.hubRulesSystemPrompt({ kind });
    assert.ok(r, kind + ' 通用规则照常带');
    assert.ok(!read(r).includes('## 组队指路'), kind);
  }
  // 创建路径：kind 作为第三个参数传入（session-manager createSession）
  assert.ok(read(m.hubRulesSystemPrompt({}, undefined, 'codeagent')).includes('## 组队指路'));
  const { SessionManager: SM } = require('../core/session-manager');
  assert.deepEqual(SM.teamGuideOpts({ kind: 'codeagent', hubTeamMember: true, meetingId: 'g1' }), { kind: 'codeagent', hubTeamMember: true, meetingId: 'g1' });
  assert.ok(!read(m.hubRulesSystemPrompt(SM.teamGuideOpts({ kind: 'codeagent', hubTeamMember: true }))).includes('## 组队指路'));
  assert.ok(read(m.hubRulesSystemPrompt(SM.teamGuideOpts({ kind: 'codeagent' }))).includes('## 组队指路'));
});
