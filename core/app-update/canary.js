'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const FILE = 'preview-updates.json';
const MAX_BYTES = 32 * 1024; // Leaves room for the encrypted transport envelope.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ADVISORY = new Set(['attendance-domain', 'attendance-page']);
function scheduleChecks(tick, { setTimeoutImpl = setTimeout, setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout, clearIntervalImpl = clearInterval } = {}) {
  const first = setTimeoutImpl(() => { void tick(); }, 30000); first.unref?.();
  const timer = setIntervalImpl(() => { void tick(); }, CHECK_INTERVAL_MS); timer.unref?.();
  return () => { clearTimeoutImpl(first); clearIntervalImpl(timer); };
}
function read(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')); } catch { return { enabled: false }; }
}
function write(dataDir, patch) {
  const next = { ...read(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, FILE), tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next) + '\n'); fs.renameSync(tmp, target);
  return next;
}
function previewSources(sources) {
  return sources.filter(s => /\/latest\.json(?:\?.*)?$/.test(s.manifest)).map(s => ({ ...s, id: s.id + '-preview', name: (s.name || s.id) + ' · 抢先版',
    manifest: s.manifest.replace(/\/latest\.json(?=\?|$)/, '/canary.json') }));
}
function makeReport(result, { machine, zone = '', releaseSha = '', now = Date.now } = {}) {
  const { sanitize } = require('../env-check');
  const clean = (s, n) => sanitize(String(s || '')).slice(0, n);
  const items = (result.items || []).slice(0, 80).map(i => ({ id: clean(i.id, 80), name: clean(i.name, 100),
    status: ['ok', 'warn', 'bad', 'off'].includes(i.status) ? i.status : 'bad',
    detail: clean(i.detail, 180), error: clean(i.raw || i.cause, 220),
    ...(i.fingerprint ? { fingerprint: clean(JSON.stringify(i.fingerprint), 300) } : {}) }));
  const report = { schema: 1, version: result.version, releaseSha, machine, zone: clean(zone, 16), at: now(),
    passed: items.length > 0 && items.every(i => ADVISORY.has(i.id) || i.status === 'ok' || i.status === 'off'), items };
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_BYTES) {
    const fit = (s, bytes) => { while (Buffer.byteLength(s) > bytes) s = s.slice(0, -1); return s; };
    report.truncated = true; report.passed = false;
    report.items = items.map(i => ({ id: fit(i.id, 80), name: fit(i.name, 60), status: i.status, detail: fit(i.detail, 60), error: fit(i.error, 80) }));
    if (Buffer.byteLength(JSON.stringify(report)) > MAX_BYTES) throw new Error('体检报告超过文本大小限制');
  }
  return report;
}
function createCanaryRunner({ dataDir, version, runCheck, sendReport, zone = () => '', now = Date.now }) {
  let running = null;
  async function run(releaseSha = '') {
    if (running) return running;
    const state = read(dataDir);
    if (!state.enabled) return null;
    const key = `${version}:${releaseSha}`;
    if (state.completed === key) return null;
    running = (async () => {
      const machine = state.machine || randomUUID();
      write(dataDir, { machine });
      let report = state.pending?.version === version && state.pending?.releaseSha === releaseSha ? state.pending : null;
      if (!report) {
        let result;
        try { result = await runCheck(); if (result.ok === false) throw new Error(result.error); }
        catch (e) { result = { version, items: [{ id: 'self-check', name: '后台体检', status: 'bad', detail: e.message }] }; }
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('体检版本号无效');
        const localDir = path.join(dataDir, 'preview-checks'); fs.mkdirSync(localDir, { recursive: true });
        const localFile = path.join(localDir, version + '.json'), localTmp = localFile + '.' + process.pid + '.tmp';
        fs.writeFileSync(localTmp, require('../env-check').sanitize(JSON.stringify(result, null, 2)) + '\n'); fs.renameSync(localTmp, localFile);
        report = makeReport({ ...result, version }, { machine, releaseSha, zone: await zone(), now });
        write(dataDir, { pending: report });
      }
      // The existing durable outbox owns retry after enqueue. Offline before pairing keeps pending locally.
      if (read(dataDir).enabled && await sendReport(report)) write(dataDir, { completed: key, pending: null });
      return report;
    })().finally(() => { running = null; });
    return running;
  }
  return { run };
}
module.exports = { FILE, MAX_BYTES, CHECK_INTERVAL_MS, scheduleChecks, read, write, previewSources, makeReport, createCanaryRunner };
