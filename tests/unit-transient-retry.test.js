'use strict';
// 偶发错误自动重试一次（5.5.24，core/transient-retry.js）及三处接入点：一键更新/组件目录的清单读取、PPT Doctor 清单、公司模型反代就绪探测。
const test = require('node:test'), assert = require('node:assert/strict');
const { isTransient, retryOnce, pickDelay } = require('../core/transient-retry');

const err = (props, message = 'x') => Object.assign(new Error(message), props);
const fast = { wait: async () => {}, random: () => 0 };

test('偶发错误识别：连接类错误码、文件占用、429/502/503/504、Electron 网络栈报错、fetch 的 cause', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EBUSY', 'EPERM']) assert.equal(isTransient(err({ code })), true, code);
  for (const status of [429, 502, 503, 504]) assert.equal(isTransient(err({ status })), true, String(status));
  assert.equal(isTransient(new Error('服务器返回 HTTP 503')), true);
  assert.equal(isTransient(new Error('net::ERR_CONNECTION_RESET')), true);
  assert.equal(isTransient(Object.assign(new TypeError('fetch failed'), { cause: err({ code: 'ECONNREFUSED' }) })), true);
  assert.equal(isTransient(err({ name: 'TimeoutError' })), true);
  assert.equal(isTransient(err({ code: 'WELINK_STATUS_UNKNOWN' })), true);
});

test('非偶发错误不重试：404、401、403、参数错、找不到程序、用户取消', () => {
  for (const status of [400, 401, 403, 404]) assert.equal(isTransient(err({ status })), false, String(status));
  assert.equal(isTransient(new Error('源上还没有版本清单（HTTP 404）')), false);
  assert.equal(isTransient(err({ code: 'ENOENT' })), false);
  assert.equal(isTransient(err({ code: 'DOCTOR_NOT_FOUND' })), false);
  assert.equal(isTransient(new Error('参数不对')), false);
  assert.equal(isTransient(err({ name: 'AbortError' })), false);
  assert.equal(isTransient(Object.assign(new TypeError('fetch failed'), { cause: err({ name: 'AbortError' }) })), false);
  assert.equal(isTransient(null), false);
});

test('偶发错误重试一次后成功', async () => {
  let calls = 0, waited = null;
  const value = await retryOnce(async attempt => { calls++; if (attempt === 1) throw err({ code: 'ECONNRESET' }); return 'ok'; },
    { wait: async ms => { waited = ms; }, random: () => 0.5 });
  assert.equal(value, 'ok'); assert.equal(calls, 2);
  assert.ok(waited >= 800 && waited <= 2000, '等待在 0.8–2 秒之间：' + waited);
});

test('两次都失败：抛出第二次的原错误（不包装），只试两次', async () => {
  let calls = 0;
  const second = err({ status: 503 }, 'HTTP 503 again');
  await assert.rejects(retryOnce(async () => { calls++; throw calls === 1 ? err({ status: 502 }) : second; }, fast), e => e === second && e.retried === true);
  assert.equal(calls, 2);
});

test('非偶发错误立即抛出，不等待、不重试', async () => {
  let calls = 0, waited = false;
  const notFound = err({ status: 404 });
  await assert.rejects(retryOnce(async () => { calls++; throw notFound; }, { wait: async () => { waited = true; } }), e => e === notFound);
  assert.equal(calls, 1); assert.equal(waited, false);
});

test('总耗时上限：第一次已用掉大半期限时不再重试；真实等待也落在上限内', async () => {
  let t = 0, calls = 0;
  await assert.rejects(retryOnce(async () => { calls++; t += 4000; throw err({ code: 'ETIMEDOUT' }); }, { budgetMs: 5000, now: () => t, ...fast, random: () => 1 }));
  assert.equal(calls, 1, '4 秒 + 等 2 秒 > 5 秒上限，不重试');

  const started = Date.now();
  let n = 0;
  const value = await retryOnce(async () => { if (n++ === 0) throw err({ code: 'EBUSY' }); return n; }, { minDelayMs: 30, maxDelayMs: 40, budgetMs: 1000 });
  assert.equal(value, 2);
  assert.ok(Date.now() - started < 1000);
});

test('等待期间被取消：不再发第二次', async () => {
  const ac = new AbortController();
  let calls = 0;
  const first = err({ code: 'ECONNRESET' });
  const p = retryOnce(async () => { calls++; throw first; }, { signal: ac.signal, minDelayMs: 200, maxDelayMs: 200 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, e => e === first);
  assert.equal(calls, 1);
  assert.equal(pickDelay(800, 2000, () => 0), 800);
  assert.equal(pickDelay(800, 2000, () => 1), 2000);
});

// ---------- 接入点 ----------

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => (k === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify(body), body: { cancel: async () => {} } });

test('一键更新/组件目录的清单读取：503 自动再取一次成功；404 不重试', async () => {
  const { checkManifests } = require('../core/app-update/downloader');
  const calls = {};
  const fetchImpl = async url => {
    calls[url] = (calls[url] || 0) + 1;
    if (url.includes('flaky')) return calls[url] === 1 ? jsonResponse({}, 503) : jsonResponse({ version: '9.9.9' });
    return jsonResponse({}, 404);
  };
  const results = await checkManifests({ sources: [{ id: 'a', name: 'A', manifest: 'https://flaky/latest.json' }, { id: 'b', name: 'B', manifest: 'https://gone/latest.json' }],
    fetchImpl, validate: m => m, retry: { minDelayMs: 5, maxDelayMs: 5 } });
  assert.equal(results[0].ok, true); assert.equal(results[0].manifest.version, '9.9.9');
  assert.equal(calls['https://flaky/latest.json'], 2);
  assert.equal(results[1].ok, false); assert.match(results[1].reason, /404/);
  assert.equal(calls['https://gone/latest.json'], 1);
});

test('PPT Doctor 清单：连接被重置时换下一个镜像再取（主干的多镜像轮换兜住偶发错误）；打开下载页只调用一次', async () => {
  const { downloadDoctor } = require('../core/company-assistant/ppt-doctor-download');
  let gets = 0; const opened = [];
  const r = await downloadDoctor('mirror', {
    pptRetry: { minDelayMs: 5, maxDelayMs: 5 },
    pptOpenExternal: async url => opened.push(url),
    pptDownloadFetch: async (url, options) => {
      if (options.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'application/zip' } };
      gets++;
      if (gets === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return jsonResponse({ version: '2.0.6' });
    },
  });
  assert.equal(gets, 2); assert.equal(opened.length, 1); assert.equal(r.ok, true);
});

test('公司模型反代就绪探测：本机端口一时连不上时再读一次状态；并发读状态只跑一次', async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const svc = new CompanyProxyService({ dataDir: require('node:os').tmpdir(), isEnabled: () => true, logger: { warn() {} } });
  svc.child = { pid: 1 };
  svc.retryOptions = { minDelayMs: 5, maxDelayMs: 5 };
  let n = 0;
  svc.request = async () => { n++; if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); return { ready: true, router: { events: [] } }; };
  await Promise.all([svc.poll(), svc.poll()]);
  assert.equal(n, 2);
  assert.equal(svc.state, 'running');
});
