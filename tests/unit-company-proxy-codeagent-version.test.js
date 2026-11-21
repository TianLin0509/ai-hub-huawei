'use strict';
// 「公司上游信息不全：模型接口地址、CodeAgent 版本、所在区域」（反馈 2026-11-14..20，≥3 人 / 6 次）：
// 1) 复现：CodeAgent 找到了但读不到版本、区域也还没识别时，旧提示一口气列三项，其实只有一件事要做（修 CodeAgent）；
//    区域在 CodeAgent 能读之后会自动识别或在设置里就地选。现在只说 CodeAgent。
// 2) 自动获取：注册表和 codeagentcli --version 都读不到时，用 Hub 建会话时对同一份安装读到的版本（AI_HUB_CODEAGENT_VERSION）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'upstream-profile.mjs')).href);
const INSTALL = 'C:\\Program Files\\CodeAgentCLI-test';

async function resolve({ env = {}, dir = INSTALL, zone = '' } = {}) {
  const { resolveUpstreamProfile } = await load();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-ca-version-'));
  try {
    return await resolveUpstreamProfile({ dataDir, env: { USERPROFILE: dataDir, TEMP: dataDir, ...env },
      dirFinder: async () => dir, versionReader: async () => '', packageFinder: async () => '', archiveReader: async () => '',
      zoneDetector: async () => ({ zone, source: zone ? 'test' : '', tried: ['test'] }) });
  } catch (error) { return error; } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('version unreadable and zone unknown: one plain problem (CodeAgent), not three', async () => {
  const error = await resolve();
  assert.equal(error.code, 'PROFILE_INCOMPLETE');
  assert.deepEqual(error.missing, ['codeagentVersion']);
  assert.match(error.message, /^公司模型暂时用不了：读不到 CodeAgent 版本/);
  assert.doesNotMatch(error.message, /所在区域|模型接口地址|上游信息不全/);
  assert.match(error.message, /重新启动模型通道/);
});

test('CodeAgent not found at all: says so', async () => {
  const error = await resolve({ dir: '' });
  assert.equal(error.code, 'PROFILE_INCOMPLETE');
  assert.deepEqual(error.missing, ['codeagentVersion']);
  assert.match(error.message, /^公司模型暂时用不了：这台电脑上没找到 CodeAgent/);
});

test('the version Hub read for the same install is used when the proxy cannot read it', async () => {
  const env = { AI_HUB_CODEAGENT_INSTALL_DIR: INSTALL + '\\bin', AI_HUB_CODEAGENT_VERSION: '1.2615.02.05' };
  // Zone still unknown: the next step is the zone question (Settings selector + identity probe), not "信息不全".
  const zoneError = await resolve({ env });
  assert.equal(zoneError.code, 'ZONE_UNKNOWN');
  assert.equal(zoneError.diagnostics.sources.codeagentVersion, 'hub');
  assert.equal(zoneError.diagnostics.codeagentVersion, '1.2615.02.05');
  // Zone known: the profile resolves.
  const profile = await resolve({ env, zone: 'yellow' });
  assert.ok(!(profile instanceof Error), String(profile?.message));
  assert.equal(profile.codeagentVersion, '1.2615.02.05');
  assert.equal(profile.sources.codeagentVersion, 'hub');
});

test('a version Hub read for a different install is not used', async () => {
  const error = await resolve({ env: { AI_HUB_CODEAGENT_INSTALL_DIR: 'D:\\Other\\CodeAgent', AI_HUB_CODEAGENT_VERSION: '1.2615.02.05' } });
  assert.equal(error.code, 'PROFILE_INCOMPLETE');
  assert.deepEqual(error.missing, ['codeagentVersion']);
});

test('model card names the CodeAgent problem instead of "公司上游信息不全"', () => {
  const cards = require('../renderer/launch-model-cards');
  assert.equal(cards.proxyBadge({ state: 'not-ready', code: 'PROFILE_INCOMPLETE', missing: ['codeagentVersion'], message: '公司模型暂时用不了：读不到 CodeAgent 版本' }).text, '读不到 CodeAgent 版本');
  assert.equal(cards.proxyBadge({ state: 'not-ready', code: 'PROFILE_INCOMPLETE', missing: ['codeagentVersion'], message: '公司模型暂时用不了：这台电脑上没找到 CodeAgent' }).text, '没找到 CodeAgent');
  assert.equal(cards.proxyBadge({ state: 'not-ready', code: 'PROFILE_INCOMPLETE', missing: ['chatUrl'], message: 'x' }).text, '公司上游信息不全');
});

test('proxy service passes the status "missing" list and Hub\'s CodeAgent version to the proxy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'company-proxy-service.js'), 'utf8');
  assert.match(src, /missing: Array\.isArray\(s\?\.missing\)/);
  assert.match(src, /env\.AI_HUB_CODEAGENT_VERSION = version/);
});
