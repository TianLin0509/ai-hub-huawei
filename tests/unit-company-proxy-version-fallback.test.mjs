// 5.5.43 只认纯数字版本，真机的 1.2615.02.02-01 被判成「无法核实 CodeAgent 版本」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliVersion, installedVersion, parseRegistryVersions, findCodeAgentDir } from '../core/company-proxy/upstream-profile.mjs';
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

test('CodeAgent 不在默认目录也能找到：PATH 里的 bin、注册表兜底，都没有才算没装', async () => {
  const only = target => dir => dir === target;
  assert.equal(await findCodeAgentDir({ env: { PATH: 'C:\\Windows;D:\\Tools\\CodeAgentCLI\\bin' }, exists: only('D:\\Tools\\CodeAgentCLI'), registry: async () => [] }), 'D:\\Tools\\CodeAgentCLI');
  assert.equal(await findCodeAgentDir({ env: {}, exists: only('E:\\CA'), registry: async () => ['C:\\nope', 'E:\\CA\\'] }), 'E:\\CA');
  let asked = 0;
  assert.equal(await findCodeAgentDir({ env: {}, exists: () => true, fallback: 'C:\\Default', registry: async () => { asked++; return []; } }), 'C:\\Default');
  assert.equal(asked, 0);
  assert.equal(await findCodeAgentDir({ env: {}, exists: () => false, registry: async () => [] }), '');
});
test('退出码非 0 但打印了版本，算读到', async () => {
  const run = async () => { throw Object.assign(new Error('exit 1'), { stdout: '1.2615.02.02-01 (codeAgentCLI)\n', stderr: '' }); };
  assert.equal(await installedVersion('C:/x', { registry: async () => '', run }), '1.2615.02.02-01');
});

test('findCodeAgentDir: the install dir Hub picked (AI_HUB_CODEAGENT_INSTALL_DIR) comes first, ahead of the default folder', async () => {
  const { resolve } = await import('node:path');
  const custom = resolve('/llm/CodeAgentCLI'), standard = resolve('/Program Files/CodeAgentCLI');
  const exists = dir => dir === custom || dir === standard;
  assert.equal(await findCodeAgentDir({ env: { AI_HUB_CODEAGENT_INSTALL_DIR: custom }, exists, fallback: standard, registry: async () => [] }), custom);
  // Not usable (no bin\codeagentcli.exe): the usual search order goes on.
  assert.equal(await findCodeAgentDir({ env: { AI_HUB_CODEAGENT_INSTALL_DIR: resolve('/gone') }, exists, fallback: standard, registry: async () => [] }), standard);
});
