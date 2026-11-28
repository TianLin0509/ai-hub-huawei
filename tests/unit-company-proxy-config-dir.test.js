'use strict';
// 反代用的个人账号目录要和 Hub 会话用的是同一个（2026-11-28 公司真机：隔离实例指定了 AI_HUB_CODEAGENT_CONFIG_DIR，
// 反代却按继承来的 CODEAGENT3_CONFIG_DIR / 默认 ~/.cac 读凭据，首次签名探测起的 CodeAgent serve 用了真实 ~/.cac）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('proxy profile takes the personal credential from CODEAGENT3_CONFIG_DIR', async () => {
  const { resolveUpstreamProfile } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'upstream-profile.mjs')).href);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-ca-dir-'));
  const configDir = path.join(dataDir, 'isolated-cac');
  try {
    const profile = await resolveUpstreamProfile({ dataDir, env: { USERPROFILE: dataDir, TEMP: dataDir, CODEAGENT3_CONFIG_DIR: configDir,
      AI_HUB_CODEAGENT_INSTALL_DIR: 'C:\\CA\\bin', AI_HUB_CODEAGENT_VERSION: '1.2615.02.05' },
    dirFinder: async () => 'C:\\CA', versionReader: async () => '', packageFinder: async () => '', archiveReader: async () => '',
    zoneDetector: async () => ({ zone: 'yellow', source: 'test', tried: ['test'] }) });
    assert.ok(!(profile instanceof Error), String(profile?.message));
    assert.equal(profile.personalCredential, path.join(configDir, '.credentials.json'));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('proxy service hands Hub\'s resolved personal config dir to the proxy child', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'company-proxy-service.js'), 'utf8');
  assert.match(src, /resolveCodeAgentConfig\(process\.env\)\.configDir; if \(dir\) env\.CODEAGENT3_CONFIG_DIR = dir;/);
  // 解析出来的目录和 Hub 会话一致：显式指定的优先于继承来的变量。
  const { resolveCodeAgentConfig } = require('../core/codeagent-config');
  const explicit = path.join(os.tmpdir(), 'hub-explicit-cac');
  const dir = resolveCodeAgentConfig({ USERPROFILE: os.tmpdir(), AI_HUB_CODEAGENT_CONFIG_DIR: explicit, CODEAGENT3_CONFIG_DIR: path.join(os.tmpdir(), 'inherited') }, {}).configDir;
  assert.equal(dir, path.resolve(explicit));
});
