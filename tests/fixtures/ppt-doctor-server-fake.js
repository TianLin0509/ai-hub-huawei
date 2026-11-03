'use strict';
// A file queue fixture. The production Doctor's OS-lock tests live in its repo.
require('../../core/fs-rename-retry').install();
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const trace = value => fs.appendFileSync(process.env.PPT_DOCTOR_FIXTURE_TRACE, JSON.stringify({ ...value, pid: process.pid }) + '\n');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, file); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const readOnly = new Set(['status', 'catalog', 'search', 'read', 'report']);
const response = request => ({ apiVersion: 1, doctorVersion: '9.9.fixture', action: request.action, requestId: request.requestId, ok: true, echo: request.echo, serverPid: process.pid });

async function main() {
  const mode = arg('--hub'); trace({ phase: 'launch', mode });
  if (mode !== 'serve') {
    const request = read(arg('--in')); trace({ phase: 'single-start', action: mode });
    while (request.releaseFile && !fs.existsSync(request.releaseFile)) await delay(20);
    await delay(request.delayMs || 0);
    write(arg('--out'), response({ ...request, action: mode })); return;
  }
  if (process.env.PPT_DOCTOR_FIXTURE_START_FAIL === '1') process.exit(4);
  const spool = arg('--spool'), lock = path.join(spool, 'fixture.lock');
  try {
    if (fs.existsSync(lock)) {
      const old = read(lock); let active = true;
      try { process.kill(old.pid, 0); } catch { active = false; }
      if (active) return;
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  const info = { apiVersion: 1, doctorVersion: '9.9.fixture', pid: process.pid, instanceId: randomUUID().replace(/-/g, ''), startedAt: new Date().toISOString(), state: 'ready', idleTimeoutSec: 600 };
  const heartbeat = () => write(path.join(spool, 'server.json'), { ...info, heartbeatAt: new Date().toISOString() });
  const timer = setInterval(heartbeat, 80); heartbeat();
  try {
    for (const name of fs.readdirSync(path.join(spool, 'working')).filter(name => /^[a-f\d]{32}\.json$/.test(name))) {
      const request = read(path.join(spool, 'working', name));
      write(path.join(spool, 'responses', name), { ...response(request), ok: false, code: 'REQUEST_INTERRUPTED', error: { code: 'REQUEST_INTERRUPTED', message: '任务被中断，请检查输出后重试' }, retryable: readOnly.has(request.action), resultMayBePartial: !readOnly.has(request.action) });
      fs.unlinkSync(path.join(spool, 'working', name));
    }
    while (true) {
      const stop = path.join(spool, 'stop.json');
      if (fs.existsSync(stop) && read(stop).instanceId === info.instanceId) break;
      const next = fs.readdirSync(path.join(spool, 'requests')).filter(name => /^[a-f\d]{32}\.json$/.test(name)).sort()[0];
      if (!next) { await delay(20); continue; }
      const working = path.join(spool, 'working', next); fs.renameSync(path.join(spool, 'requests', next), working);
      const request = read(working); trace({ phase: 'claimed', action: request.action, requestId: request.requestId, echo: request.echo });
      info.state = 'busy'; heartbeat();
      if (request.fixture === 'crash-once' && !fs.existsSync(path.join(spool, 'crashed'))) { fs.writeFileSync(path.join(spool, 'crashed'), '1'); process.exit(4); }
      const progress = { ...response(request), state: 'running', stage: 'fixture', message: '正在处理', done: 1, total: 2 };
      if (request.fixture === 'wrong-progress') progress.action = 'report';
      write(path.join(spool, 'progress', next), progress);
      await delay(request.delayMs || 30);
      const result = response(request);
      if (request.fixture === 'wrong-id') result.requestId = 'another-request';
      if (request.fixture === 'always-interrupted') Object.assign(result, { ok: false, code: 'REQUEST_INTERRUPTED', error: { message: '连续中断' }, retryable: true });
      write(path.join(spool, 'responses', next), result); fs.unlinkSync(working); info.state = 'ready'; heartbeat();
    }
    info.state = 'stopping'; heartbeat(); trace({ phase: 'stopped', instanceId: info.instanceId });
  } finally { clearInterval(timer); fs.unlinkSync(lock); }
}
main().catch(error => { trace({ phase: 'error', error: error.message }); process.exitCode = 4; });
