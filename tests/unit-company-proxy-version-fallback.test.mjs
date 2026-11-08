// 5.5.43 起内置适配要校验 CodeAgent 版本；只读卸载注册表时，免安装或登记两份的电脑一直报「无法核实 CodeAgent 版本」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { numericVersion, parseCliVersion, installedVersion } from '../core/company-proxy/upstream-profile.mjs';

test('版本号只取数字部分，构建后缀不算错', () => {
  assert.equal(numericVersion('1.2615.02.03'), '1.2615.02.03');
  assert.equal(numericVersion('1.2615.02.03-beta'), '1.2615.02.03');
  assert.equal(numericVersion('v1.2615.02.03'), '1.2615.02.03');
  assert.equal(numericVersion(''), '');
  assert.equal(numericVersion('abc'), '');
});
test('能从 --version 输出里读出版本，跳过升级提示', () => {
  assert.equal(parseCliVersion('1.2615.02.03 (CodeAgent)'), '1.2615.02.03');
  assert.equal(parseCliVersion('CodeAgent 版本提示\ncodeagent 1.2615.02.03\n'.replace('CodeAgent 版本提示', 'new version 1.9.9 available')), '1.2615.02.03');
  assert.equal(parseCliVersion('\x1b[32mversion: 1.2615.02.03-rc1\x1b[0m'), '1.2615.02.03');
  assert.equal(parseCliVersion('error'), '');
});
test('注册表读不到时问程序本身，读到了就不启动程序', async () => {
  let runs = 0;
  const run = async () => { runs++; return { stdout: '1.2615.02.03 (CodeAgent)\n', stderr: '' }; };
  assert.equal(await installedVersion('C:/x', { registry: async () => '', run }), '1.2615.02.03');
  assert.equal(runs, 1);
  assert.equal(await installedVersion('C:/x', { registry: async () => '1.2615.02.04-beta', run }), '1.2615.02.04');
  assert.equal(runs, 1);
  assert.equal(await installedVersion('C:/x', { registry: async () => '', run: async () => { throw new Error('no exe'); } }), '');
});
