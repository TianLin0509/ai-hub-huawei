'use strict';
// 会议本地转写：分片离线包安装（断点续传、校验、被代理拦截）、旧引擎兼容、发言人聚类、专业词库、停顿处切段。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { MeetingAsr, PACK } = require('../core/company-assistant/meeting-asr');
const speakers = require('../core/company-assistant/meeting-speakers');
const { MeetingGlossary, parse, parseHints } = require('../core/company-assistant/meeting-glossary');
const { cutHere } = require('../renderer/meeting-capture');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { compactEvents } = require('../core/company-assistant/meeting-context');

const sha = b => createHash('sha256').update(b).digest('hex');
function fakePack() {
  const files = { 'runtime.zip': Buffer.from('zip-bytes-zip-bytes'), 'model.int8.onnx': Buffer.from('model-model-model-model'), 'tokens.txt': Buffer.from('a\nb\n') };
  const served = {}, list = [];
  for (const [name, buf] of Object.entries(files)) {
    const parts = [];
    for (let i = 0, n = 0; i < buf.length; i += 8, n++) { const piece = buf.subarray(i, i + 8), file = `${name}.${String(n).padStart(3, '0')}`; served[file] = piece; parts.push({ file, size: piece.length, sha256: sha(piece) }); }
    list.push({ name, size: buf.length, sha256: sha(buf), ...(name === 'runtime.zip' ? { extract: 'python' } : {}), parts });
  }
  return { pack: { version: 'test-1', engine: 'sensevoice', files: list }, served };
}
function fetcher(served, { block = false, log = [] } = {}) {
  return async url => {
    const file = decodeURIComponent(url.split('/').pop()); log.push(file);
    const page = '<!doctype html><title>Proxy Notification</title>';
    if (block) return new Response(page, { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(page.length) } });
    const body = served[file]; if (!body) return new Response('nope', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } });
  };
}
// 假 Python：一启动就报「ready」；收到请求回一句话。
function fakeSpawn(calls = []) {
  return (exe, args) => {
    calls.push([exe, args]);
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough(); p.kill = () => p.emit('exit', 0);
    setImmediate(() => p.stdout.write(JSON.stringify({ event: 'ready' }) + '\n'));
    p.stdin.on('data', b => { for (const line of b.toString().split('\n').filter(Boolean)) { const r = JSON.parse(line); p.stdout.write(JSON.stringify({ id: r.id, segments: [{ start: 0, end: 1, text: '你好' }] }) + '\n'); } });
    return p;
  };
}
const until = async (f, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-speech-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('随程序发布的清单：分片都不超过 16 MB，拼合大小一致', () => {
  assert.equal(PACK.engine, 'sensevoice');
  for (const f of PACK.files) {
    assert.equal(f.parts.reduce((n, p) => n + p.size, 0), f.size, f.name);
    for (const p of f.parts) { assert.ok(p.size <= 16 * 1024 * 1024); assert.match(p.sha256, /^[a-f0-9]{64}$/); }
  }
  assert.ok(PACK.files.some(f => f.name === 'voiceprint.onnx'));
});

test('分片下载、拼合校验、试运行后就绪；第二次安装不再下载', async t => {
  const root = tmp(t), { pack, served } = fakePack(), log = [], calls = [];
  const asr = new MeetingAsr(root, { pack, sources: [{ id: 'a', name: '测试源', files: 'https://x.test/{version}/' }], fetchImpl: fetcher(served, { log }), spawnImpl: fakeSpawn(calls) });
  asr.unzip = async (zip, dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'python.exe'), fs.readFileSync(zip)); };
  assert.equal(asr.status().ready, false);
  asr.install(); await until(() => !asr.installing);
  const s = asr.status();
  assert.equal(s.error, ''); assert.equal(s.ready, true); assert.equal(s.engine, 'sensevoice');
  assert.equal(fs.readFileSync(path.join(asr.home, 'model', 'tokens.txt'), 'utf8'), 'a\nb\n');
  assert.ok(!fs.existsSync(path.join(root, 'download')), '装好后删掉下载的分片');
  assert.equal(log.length, Object.keys(served).length);
  assert.ok(calls.some(([exe, args]) => exe.endsWith('python.exe') && args.includes('-I')), '用组件自带的 Python 隔离启动');
  const segs = await asr.transcribe('x.wav', { voiceprint: true }); assert.equal(segs[0].text, '你好');
  asr.install(); assert.equal(asr.installing, null, '已就绪不再装'); assert.equal(log.length, Object.keys(served).length);
  asr.close();
});

test('断了再装：已下好的分片不重下；坏分片重下', async t => {
  const root = tmp(t), { pack, served } = fakePack(), log = [];
  const asr = new MeetingAsr(root, { pack, sources: [{ id: 'a', name: '测试源', files: 'https://x.test/{version}/' }], fetchImpl: fetcher(served, { log }), spawnImpl: fakeSpawn() });
  asr.unzip = async (zip, dir) => { fs.mkdirSync(dir, { recursive: true }); };
  fs.mkdirSync(asr.downloads, { recursive: true });
  fs.writeFileSync(path.join(asr.downloads, 'model.int8.onnx.000'), served['model.int8.onnx.000']);
  fs.writeFileSync(path.join(asr.downloads, 'model.int8.onnx.001'), Buffer.from('XXXXXXXX'));
  asr.install(); await until(() => !asr.installing);
  assert.equal(asr.status().ready, true);
  assert.ok(!log.includes('model.int8.onnx.000')); assert.ok(log.includes('model.int8.onnx.001'));
});

test('被公司代理拦成网页：报「放行下载服务器」，不算就绪', async t => {
  const root = tmp(t), { pack, served } = fakePack();
  const asr = new MeetingAsr(root, { pack, sources: [{ id: 'a', name: '测试源', files: 'https://x.test/{version}/' }], fetchImpl: fetcher(served, { block: true }), spawnImpl: fakeSpawn() });
  asr.install(); await until(() => !asr.installing);
  const s = asr.status();
  assert.equal(s.ready, false); assert.equal(s.blocked, true); assert.match(s.error, /放行下载服务器/);
});

test('旧引擎（Whisper）已装：照常可用，并提示升级', t => {
  const root = tmp(t); fs.writeFileSync(path.join(root, 'ready.json'), '{"version":1}');
  const s = new MeetingAsr(root).status();
  assert.equal(s.ready, true); assert.equal(s.engine, 'whisper'); assert.equal(s.upgrade, true);
});

test('发言人：同一路相近的声音归为一人，不同声音新开；短句跟上一句；改名生效', () => {
  const m = { events: [] }, a = Array.from({ length: 192 }, (_, i) => Math.sin(i)), b = Array.from({ length: 192 }, (_, i) => Math.cos(i * 3));
  const near = a.map((x, i) => x + (i % 7 === 0 ? 0.2 : 0));
  assert.equal(speakers.assign(m, 'system', a, 0), 1);
  assert.equal(speakers.assign(m, 'system', near, 3000), 1);
  assert.equal(speakers.assign(m, 'system', b, 6000), 2);
  assert.equal(speakers.assign(m, 'mic', a, 6000), 3, '麦克风另算');
  m.events.push({ kind: 'transcript', track: 'system', at: 9000, end: 10000, speaker: 2 });
  assert.equal(speakers.assign(m, 'system', null, 11000), 2);
  assert.equal(speakers.assign(m, 'system', null, 30000), null);
  m.summary = '## 行动项\n- [A1] 发言人2｜补测｜周三 [事件 5]\n- [A2] 发言人12｜复核｜未明确 [事件 6]';
  speakers.rename(m, 2, '  张工 ');
  assert.equal(m.summary, '## 行动项\n- [A1] 张工｜补测｜周三 [事件 5]\n- [A2] 发言人12｜复核｜未明确 [事件 6]', '纪要里的旧称呼一并换掉，发言人12 不受影响');
  assert.deepEqual(speakers.names(m), { 1: '发言人1', 2: '张工', 3: '发言人3' });
  assert.ok(!('centroid' in speakers.publicList(m)[0]));
  const rows = compactEvents([{ seq: 5, kind: 'transcript', at: 61000, track: 'system', speaker: 2, text: '周三给结论' }], speakers.names(m));
  assert.equal(rows, '[5] 01:01 张工 周三给结论');
});

test('专业词库：错词替换、长词优先、给伴侣的说明', t => {
  const g = parse('OLLA\n欧亚=OLLA\n欧亚拉 = 欧拉\n# 注释\n\nAI Hub');
  assert.deepEqual(g.terms, ['OLLA', '欧拉', 'AI Hub']);
  assert.equal(g.fixes[0].from, '欧亚拉');
  const dir = tmp(t), gl = new MeetingGlossary(dir);
  assert.match(gl.promptLine(), /CodeAgent/, '没保存过时用默认词');
  gl.save('欧亚=OLLA\n欧亚拉=欧拉');
  assert.equal(gl.apply('把欧亚的步长调小，欧亚拉不变'), '把OLLA的步长调小，欧拉不变');
  assert.match(gl.promptLine(), /OLLA、欧拉/);
  gl.save(''); assert.equal(gl.promptLine(), '');
  gl.save('CQ=CQI\nSI=SINR');
  assert.equal(gl.apply('CQ 上报和 CQI 不一致，SI 偏低，SIM 卡无关'), 'CQI 上报和 CQI 不一致，SINR 偏低，SIM 卡无关', '正确词含错词、英文词边界');
  assert.deepEqual(parseHints('- [D1] x\n词库建议：欧拉=OLLA；CQ = CQI；乱写；A=A；欧拉=OLLA\n本轮小结：y'), ['欧拉=OLLA', 'CQ=CQI']);
  assert.deepEqual(gl.newHints(['CQ=CQI', 'PI=PF']), ['PI=PF'], '词库里已有的不再建议');
});

test('停顿处切段：8 秒前不切，8 秒后遇到安静就切，最长 20 秒', () => {
  const loud = new Float32Array(4096).fill(0.2), quiet = new Float32Array(4096).fill(0.001);
  const feed = (n, buf) => { n.length += buf.length; return cutHere(n, buf, 16000); };
  let n = { length: 0 };
  for (let i = 0; i < 20; i++) assert.equal(feed(n, i % 3 ? loud : quiet), false, '不到 8 秒不切');
  n.length = 16000 * 8; assert.equal(feed(n, loud), false); assert.equal(feed(n, quiet), true);
  n = { length: 16000 * 20 - 4096 }; assert.equal(feed(n, loud), true, '20 秒强制切');
});

test('转写落盘：带发言人、按词库替换并保留原听写', async t => {
  const root = tmp(t);
  const companion = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, {
    meetingAsr: { status: () => ({ ready: true }), close() {}, transcribe: async (_f, o) => { assert.equal(o.voiceprint, true); return [
      { start: 0, end: 2, text: '把欧亚调小', voice: Array.from({ length: 192 }, (_, i) => Math.sin(i)) },
      { start: 2.2, end: 2.8, text: '对' }]; } } });
  companion.tools = { start: async () => {}, bind() {}, close() {} };
  t.after(() => companion.close());
  companion.glossary.save('欧亚=OLLA');
  const m = companion.create({ title: '发言人会议', audio: ['system'] }); clearInterval(companion.timer); companion.timer = null;
  const saved = companion.load(m.id); companion.event(saved, 'audio', { at: 1000, end: 4000, track: 'system', file: 'system-1.wav', asr: 'pending' }); companion.save(saved);
  await companion.transcribeOne();
  const lines = companion.load(m.id).events.filter(e => e.kind === 'transcript');
  assert.equal(lines[0].text, '把OLLA调小'); assert.equal(lines[0].heard, '把欧亚调小'); assert.equal(lines[0].speaker, 1);
  assert.equal(lines[1].speaker, 1, '紧跟的短句算同一人');
  companion.control(m.id, 'speaker-name', { id: 1, name: '李工' });
  assert.match(fs.readFileSync(companion.export(m.id), 'utf8'), /00:01 李工：把OLLA调小/);
});
