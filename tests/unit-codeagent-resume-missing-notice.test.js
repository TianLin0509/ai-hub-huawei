'use strict';
// 请求恢复但找不到记录：启动结果要标出来，让会话管理器给用户发提示。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _private } = require('../core/session-manager');

test('resume with missing history is flagged, with history is not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-miss-'));
  process.env.CLAUDE_HUB_DATA_DIR = path.join(tmp, 'hub-data');
  fs.mkdirSync(process.env.CLAUDE_HUB_DATA_DIR, { recursive: true });
  const configDir = path.join(tmp, 'cac');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const config = { command: 'codeagent-probe-not-installed', configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const ID = '33333333-3333-4333-8333-333333333333';
  const warn = console.warn; console.warn = () => {};
  try {
    const launch = opts => _private.buildCodeAgentPtyLaunch('hub-1', 'codeagent', opts, tmp, { USERPROFILE: tmp, HOME: tmp }, config);
    const missing = launch({ resumeCCSessionId: ID });
    assert.strictEqual(missing.resumeHistoryMissing, true);
    assert.doesNotMatch(missing.cmd, /--resume/);
    assert.strictEqual(launch({}).resumeHistoryMissing, undefined);
    const dir = path.join(configDir, 'projects', 'some-bucket'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ID + '.jsonl'), '{}\n');
    const found = launch({ resumeCCSessionId: ID });
    assert.strictEqual(found.resumeHistoryMissing, undefined);
    assert.match(found.cmd, /--resume/);
  } finally { console.warn = warn; fs.rmSync(tmp, { recursive: true, force: true }); }
});
