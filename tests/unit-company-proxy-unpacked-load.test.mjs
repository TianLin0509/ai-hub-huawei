// 安装版的本机反代从 resources/app.asar.unpacked/core/company-proxy/ 起，而 core/ 下其他模块留在 app.asar 里
// （package.json asarUnpack 只解 core/company-proxy/** 等少数文件）。2026-11-21 审查：gateway-provider.mjs 直接
// require('../api-gateway-errors.js') 在安装版会 MODULE_NOT_FOUND，公司模型和网关会话全断。
// 这里按审查者的复现办法搭一个「解包目录 + asar 目录」的假安装版（普通 Node 里 app.asar 就是个目录名），从解包目录加载 server.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('安装版布局：从 app.asar.unpacked 加载 server.mjs，core 里留在 asar 内的模块也找得到', async t => {
  const resources = await mkdtemp(join(tmpdir(), 'proxy-unpacked-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const unpacked = join(resources, 'app.asar.unpacked', 'core');
  const asar = join(resources, 'app.asar', 'core');
  fs.cpSync(join(ROOT, 'core', 'company-proxy'), join(unpacked, 'company-proxy'), { recursive: true });
  fs.mkdirSync(asar, { recursive: true });
  for (const name of fs.readdirSync(join(ROOT, 'core'))) if (name.endsWith('.js')) fs.copyFileSync(join(ROOT, 'core', name), join(asar, name));
  assert.equal(fs.existsSync(join(unpacked, 'api-gateway-errors.js')), false, '解包目录旁边确实没有 api-gateway-errors.js');
  assert.equal(fs.existsSync(join(unpacked, 'port-fallback.js')), false, '共享模块入口仍在 asar 中');
  assert.equal(fs.existsSync(join(unpacked, 'company-proxy', 'port-fallback.cjs')), true, '独立反代需要的绑定实现随反代解包');

  const server = await import(pathToFileURL(join(unpacked, 'company-proxy', 'server.mjs')).href);
  assert.equal(typeof server.main, 'function', 'server.mjs 能加载');
  const gateway = await import(pathToFileURL(join(unpacked, 'company-proxy', 'gateway-provider.mjs')).href);
  const e = gateway.explainGatewayError(401, '{"error":{"message":"Invalid token"}}');
  assert.equal(e.status, 401, '从 asar 内加载的报错口径可用');
  assert.match(e.message, /key 无效/);
});
