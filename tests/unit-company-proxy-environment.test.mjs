import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resolveUpstreamProfile } from '../core/company-proxy/upstream-profile.mjs';
import { poolAccounts } from '../core/company-proxy/server.mjs';

const require = createRequire(import.meta.url);
const proxy = require('../core/company-model-proxy');
const { CompanyProxyService } = require('../main/company-proxy-service');
const { registryPathDirs } = require('../core/tool-discovery/npm-global-dirs');
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('个人凭证跟随自定义配置目录，显式凭证配置优先，号池继续跟随 Hub 数据目录', async t => {
  const root = temp(t), custom = path.join(root, '中文配置');
  const dir = proxy.proxyDir(root), config = path.join(dir, 'upstream.json');
  fs.mkdirSync(dir);
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, '.credentials.json'), '{}');
  const user = { codeagentDir: root, codeagentVersion: '9.1.2', zone: 'yellow' };
  fs.writeFileSync(config, JSON.stringify(user));
  const options = { dataDir: root, env: { USERPROFILE: root, CODEAGENT3_CONFIG_DIR: custom },
    packageFinder: async () => '', zoneDetector: async () => null };
  const profile = await resolveUpstreamProfile(options);
  assert.equal(profile.personalCredential, path.join(custom, '.credentials.json'));
  assert.equal(profile.sources.personalCredential, 'env:CODEAGENT3_CONFIG_DIR');
  assert.equal(profile.diagnostics.personalCredentialFile, true);
  const normal = await resolveUpstreamProfile({ ...options, env: { USERPROFILE: root } });
  assert.equal(normal.personalCredential, path.join(root, '.cac', '.credentials.json'));
  fs.writeFileSync(config, JSON.stringify({ ...user, personalCredential: path.join(root, 'override.json') }));
  const explicit = await resolveUpstreamProfile(options);
  assert.equal(explicit.personalCredential, path.join(root, 'override.json'));
  fs.mkdirSync(path.join(root, 'codeagent-pool'));
  fs.writeFileSync(path.join(root, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'abc123' }] }));
  const accounts = poolAccounts(root, Date.now(), profile.personalCredential);
  assert.equal(accounts[0].credentialFile, path.join(root, 'codeagent-pool', 'accounts', 'abc123', '.credentials.json'));
  assert.equal(accounts.at(-1).credentialFile, profile.personalCredential);
});

test('隐藏反代子进程原样继承用户设置的 CodeAgent 配置目录', async t => {
  const root = temp(t), custom = path.join(root, '个人目录');
  const file = require.resolve('../main/company-proxy-service');
  const localRequire = createRequire(file), calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null });
  const context = { module: { exports: {} }, __dirname: path.dirname(file), process, console,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController, fetch,
    require: name => name === 'node:child_process' ? { spawn: (...args) => { calls.push(args); return child; } }
      : name === '../core/codeagent-config' ? { codeagentInstallDir: () => '' }
        : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const service = new context.module.exports.CompanyProxyService({ dataDir: root, mock: true });
  service.waitForState = async () => ({ pid: child.pid, port: 12345 });
  service.poll = async () => {};
  t.after(() => clearInterval(service.timer));
  const before = process.env.CODEAGENT3_CONFIG_DIR; process.env.CODEAGENT3_CONFIG_DIR = custom;
  t.after(() => { if (before === undefined) delete process.env.CODEAGENT3_CONFIG_DIR; else process.env.CODEAGENT3_CONFIG_DIR = before; });
  await service.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].env.CODEAGENT3_CONFIG_DIR, custom);
  assert.equal(calls[0][2].windowsHide, true);
});

test('同目录两个反代：停止各自的进程，保留仍指向另一实例的状态文件', { timeout: 60000 }, async t => {
  const root = temp(t);
  proxy.ensureEndpoint(root, { preferredPort: 0 });
  const create = () => new CompanyProxyService({ dataDir: root, mock: true, logger: { warn() {} } });
  const a = create(), b = create();
  t.after(async () => { await a.stop(); await b.stop(); });
  const first = await a.start(), second = await b.start();
  assert.notEqual(first.pid, second.pid);
  assert.notEqual(first.port, second.port);
  assert.equal(a.status().port, first.port);
  assert.equal(proxy.readEndpoint(root).port, second.port);
  const stateFile = path.join(proxy.proxyDir(root), 'proxy-state.json');
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).pid, second.pid);
  await a.stop();
  assert.equal(a.child, null);
  assert.equal((await b.request('/admin/status')).ready, true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).pid, second.pid);
  await b.stop();
  assert.equal(fs.existsSync(stateFile), false);
  const otherDir = path.join(root, 'other-data');
  assert.notEqual(proxy.endpointFile(root), proxy.endpointFile(otherDir));
  assert.notEqual(proxy.proxyDir(root), proxy.proxyDir(otherDir));
});

test('注册表 PATH 复用 Unicode/base64 读取，中文目录、展开、去重和读取失败', async () => {
  const calls = [], u = '"D:\\中文工具\\bin";%LOCALAPPDATA%\\npm', m = 'D:\\中文工具\\bin;C:\\系统工具';
  const dirs = await registryPathDirs({ platform: 'win32', env: { LocalAppData: 'C:\\用户目录' },
    execFileImpl: (file, args, options, cb) => {
      calls.push([file, args, options]);
      cb(null, Buffer.from(JSON.stringify({ u, m }), 'utf8').toString('base64'));
    } });
  assert.deepEqual(dirs, ['D:\\中文工具\\bin', 'C:\\用户目录\\npm', 'C:\\系统工具']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1].at(-1), /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(calls[0][1].at(-1), /ToBase64String/);
  assert.equal(calls[0][2].windowsHide, true);
  assert.ok(calls[0][2].timeout > 0);
  assert.deepEqual(await registryPathDirs({ platform: 'win32', execFileImpl: (_f, _a, _o, cb) => cb(new Error('unavailable')) }), []);
  assert.deepEqual(await registryPathDirs({ platform: 'win32', execFileImpl: (_f, _a, _o, cb) => cb(null, 'invalid') }), []);
  assert.deepEqual(await registryPathDirs({ platform: 'linux', execFileImpl: () => assert.fail('must not run') }), []);
});
