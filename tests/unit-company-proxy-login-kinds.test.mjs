// 2026-11-10：同事用账号密码登录 CodeAgent（idaasOAuth），反代只认浏览器登录（devUCOAuth），整片报 401「需要重新登录」。
// 现在个人号和号池号两种登录都认；只读令牌和到期时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersonalAccessTokenReader } from '../core/company-proxy/personal-token.mjs';
import { createPoolAccessTokenReader } from '../core/company-proxy/pool-token.mjs';

const DPAPI = Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.from('x')]).toString('base64');
const decryptAccessToken = async c => (c === DPAPI ? 'plain-token' : (() => { throw Object.assign(new Error(), { code: 'X' }); })());
const later = Date.now() + 3600_000;

async function tempDir(t) { const d = await mkdtemp(join(tmpdir(), 'proxy-login-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }

test('个人号：浏览器登录和账号密码登录都能取到令牌', async t => {
  const dir = await tempDir(t);
  const read = createPersonalAccessTokenReader({ decryptAccessToken });
  const cases = {
    devuc: { devUCOAuth: { accessToken: DPAPI, expiresAt: later, refreshToken: 'r' } },
    idaas: { idaasOAuth: { xAuthToken: DPAPI, xAuthExpires: later, mtoken: 'm' } },
  };
  for (const [name, body] of Object.entries(cases)) {
    const file = join(dir, name + '.json');
    await writeFile(file, JSON.stringify(body));
    assert.equal(await read({ credentialPath: file, expiryUnit: 'milliseconds' }), 'plain-token', name);
  }
  const expired = join(dir, 'expired.json');
  await writeFile(expired, JSON.stringify({ idaasOAuth: { xAuthToken: DPAPI, xAuthExpires: Date.now() - 1000 } }));
  await assert.rejects(read({ credentialPath: expired, expiryUnit: 'milliseconds' }), { code: 'ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY' });
  const none = join(dir, 'none.json');
  await writeFile(none, JSON.stringify({ claudeAiOauth: {} }));
  await assert.rejects(read({ credentialPath: none, expiryUnit: 'milliseconds' }), { code: 'PERSONAL_AUTH_TYPE_UNSUPPORTED' });
});

test('号池号：浏览器登录的号也能用', async t => {
  const root = await tempDir(t);
  await writeFile(join(root, 'pool.json'), JSON.stringify({ accounts: [{ id: 'abc123' }, { id: 'def456' }] }));
  await mkdir(join(root, 'accounts', 'abc123'), { recursive: true });
  await mkdir(join(root, 'accounts', 'def456'), { recursive: true });
  await writeFile(join(root, 'accounts', 'abc123', '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: DPAPI, xAuthExpires: later } }));
  await writeFile(join(root, 'accounts', 'def456', '.credentials.json'), JSON.stringify({ devUCOAuth: { accessToken: DPAPI, expiresAt: later } }));
  const read = createPoolAccessTokenReader({ decryptAccessToken });
  assert.equal(await read({ poolRoot: root, accountId: 'abc123' }), 'plain-token');
  assert.equal(await read({ poolRoot: root, accountId: 'def456' }), 'plain-token');
});
