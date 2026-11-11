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

test('两种登录并存：优先有效记录，都有效或都过期时保持原顺序', async t => {
  const root = await tempDir(t), accountId = 'abc123';
  await mkdir(join(root, 'accounts', accountId), { recursive: true });
  await writeFile(join(root, 'pool.json'), JSON.stringify({ accounts: [{ id: accountId }] }));
  const personalFile = join(root, 'personal.json'), poolFile = join(root, 'accounts', accountId, '.credentials.json');
  const encrypted = name => Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.from(name)]).toString('base64');
  const devToken = encrypted('browser'), idaasToken = encrypted('password');
  const decrypt = async c => c === devToken ? 'browser-token' : c === idaasToken ? 'password-token' : assert.fail('unexpected ciphertext');
  const personal = createPersonalAccessTokenReader({ decryptAccessToken: decrypt });
  const pool = createPoolAccessTokenReader({ decryptAccessToken: decrypt });
  const nowMs = Date.now();
  for (const expiryUnit of ['milliseconds', 'seconds']) {
    for (const [devOffset, idaasOffset, wantPersonal, wantPool] of [
      [3600_000, 3600_000, 'browser-token', 'password-token'],
      [-1000, 3600_000, 'password-token', 'password-token'],
      [3600_000, -1000, 'browser-token', 'browser-token'],
      [30_000, 3600_000, 'password-token', 'password-token'],
      [3600_000, 30_000, 'browser-token', 'browser-token'],
      [60_000, 3600_000, 'password-token', 'password-token'],
      [3600_000, 120_000, 'browser-token', 'browser-token'],
      [90_000, 3600_000, 'browser-token', 'password-token'],
      [3600_000, 90_000, 'browser-token', 'browser-token'],
      [30_000, 30_000, null, null],
      [-1000, -1000, null, null],
    ]) {
      const body = { devUCOAuth: { accessToken: devToken, expiresAt: nowMs + devOffset },
        idaasOAuth: { xAuthToken: idaasToken, xAuthExpires: nowMs + idaasOffset } };
      await writeFile(poolFile, JSON.stringify(body));
      body.devUCOAuth.expiresAt = expiryUnit === 'seconds' ? Math.floor(body.devUCOAuth.expiresAt / 1000) : body.devUCOAuth.expiresAt;
      await writeFile(personalFile, JSON.stringify(body));
      const p = personal({ credentialPath: personalFile, expiryUnit, nowMs });
      if (wantPersonal) assert.equal(await p, wantPersonal);
      else await assert.rejects(p, { code: 'ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY' });
      const q = pool({ poolRoot: root, accountId, nowMs });
      if (wantPool) assert.equal(await q, wantPool);
      else await assert.rejects(q, { code: 'POOL_ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY' });
    }
  }
  await writeFile(personalFile, JSON.stringify({ devUCOAuth: { accessToken: devToken, expiresAt: 'invalid' },
    idaasOAuth: { xAuthToken: idaasToken, xAuthExpires: nowMs + 3600_000 } }));
  await assert.rejects(personal({ credentialPath: personalFile, expiryUnit: 'milliseconds', nowMs }), { code: 'EXPIRY_VALUE_INVALID' });
  await writeFile(poolFile, JSON.stringify({ devUCOAuth: { accessToken: devToken, expiresAt: nowMs + 3600_000 },
    idaasOAuth: { xAuthToken: idaasToken, xAuthExpires: 'invalid' } }));
  await assert.rejects(pool({ poolRoot: root, accountId, nowMs }), { code: 'POOL_EXPIRY_INVALID' });
});

test('单一登录仍拒绝临期令牌，并遵循调用方指定的最低有效期', async t => {
  const root = await tempDir(t), accountId = 'abc123', nowMs = Date.now();
  await mkdir(join(root, 'accounts', accountId), { recursive: true });
  await writeFile(join(root, 'pool.json'), JSON.stringify({ accounts: [{ id: accountId }] }));
  const personalFile = join(root, 'personal.json'), poolFile = join(root, 'accounts', accountId, '.credentials.json');
  const personal = createPersonalAccessTokenReader({ decryptAccessToken }), pool = createPoolAccessTokenReader({ decryptAccessToken });
  for (const body of [{ devUCOAuth: { accessToken: DPAPI, expiresAt: nowMs + 30000 } },
    { idaasOAuth: { xAuthToken: DPAPI, xAuthExpires: nowMs + 30000 } }]) {
    await writeFile(personalFile, JSON.stringify(body)); await writeFile(poolFile, JSON.stringify(body));
    await assert.rejects(personal({ credentialPath: personalFile, expiryUnit: 'milliseconds', nowMs }), { code: 'ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY' });
    await assert.rejects(pool({ poolRoot: root, accountId, nowMs }), { code: 'POOL_ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY' });
    assert.equal(await personal({ credentialPath: personalFile, expiryUnit: 'milliseconds', nowMs, minValidityMs: 10000 }), 'plain-token');
    assert.equal(await pool({ poolRoot: root, accountId, nowMs, minValidityMs: 10000 }), 'plain-token');
  }
});
