// 5.5.43 只认纯数字版本，真机的 1.2615.02.02-01 被判成「无法核实 CodeAgent 版本」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliVersion, installedVersion, parseRegistryVersions } from '../core/company-proxy/upstream-profile.mjs';
import { isSignerVersion, baseVersion } from '../core/company-proxy/version-format.mjs';

test('带构建后缀的真实版本可用，明显不是版本号的文本不算', () => {
  for (const v of ['1.2615.02.02-01', '1.2615.02.03', '9.1.2']) assert.equal(isSignerVersion(v), true, v);
  for (const v of ['', 'abc', '1', '1.2;rm', '1.2-']) assert.equal(isSignerVersion(v), false, v);
  assert.equal(baseVersion('1.2615.02.02-01'), '1.2615.02.02');
});
test('注册表和 --version 都保留完整版本', () => {
  assert.equal(parseRegistryVersions('"1.2615.02.02-01"'), '1.2615.02.02-01');
  assert.equal(parseCliVersion('1.2615.02.02-01 (codeAgentCLI)\n'), '1.2615.02.02-01');
  assert.equal(parseCliVersion('New version available: 1.2615.02.03. You can run update.\n1.2615.02.02-01 (codeAgentCLI)'), '1.2615.02.02-01');
  assert.equal(parseCliVersion('error'), '');
});
test('注册表读不到时问程序本身，读到了就不启动程序', async () => {
  let runs = 0;
  const run = async () => { runs++; return { stdout: '1.2615.02.02-01 (codeAgentCLI)\n', stderr: '' }; };
  assert.equal(await installedVersion('C:/x', { registry: async () => '', run }), '1.2615.02.02-01');
  assert.equal(runs, 1);
  assert.equal(await installedVersion('C:/x', { registry: async () => '1.2615.02.02-01', run }), '1.2615.02.02-01');
  assert.equal(runs, 1);
  assert.equal(await installedVersion('C:/x', { registry: async () => '', run: async () => { throw new Error('no exe'); } }), '');
});
