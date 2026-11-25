'use strict';
// 开场动画（2026-11-22）：内置清单与资源包目录一致、播放频率与「每天第一次」、选中被删时退回群星、下载走内源版本名并校验装上。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createBootSplashStore, validateCatalog, validatePack, DEFAULT_ID, FALLBACK_ID } = require('../core/boot-splash');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'renderer', 'assets', 'boot-splash');
const PACKS = path.join(ROOT, 'tools', 'boot-splash-packs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boot-splash-'));

test('内置清单：75 套都有缩略图，内置 5 套有原图（含 Claude 原作 lite 视频），其余图片包都在资源包目录里且字节数与哈希一致；原作视频带署名', () => {
  const index = JSON.parse(fs.readFileSync(path.join(ASSETS, 'index.json'), 'utf8')).items;
  assert.strictEqual(index.length, 75);
  assert.deepStrictEqual(index.filter(i => i.recommend).map(i => i.id).sort(), ['claude-draw', 'claude-omni', 'claude-orig', 'codex-draw', 'codex-omni', 'codex-orig', 'deepseek-dive', 'deepseek-draw', 'deepseek-omni', 'deepseek-omni', 'gemini-orig'].filter((x, i, a) => a.indexOf(x) === i), '作者推荐：原作、召唤师抽卡、3 秒有声开场、深海');
  for (const who of ['claude', 'codex']) assert.strictEqual(index.find(i => i.who === who).id, who + '-orig', who + ' 的原作排在该家第一个');
  for (const it of index.filter(i => i.id.endsWith('-draw'))) assert.strictEqual(it.clip.brand, false, it.id + ' 成片自带 AI HUB 角标，播放时不再叠');
  for (const it of index.filter(i => i.id.endsWith('-orig'))) assert.ok(/CC BY-NC-ND 4\.0/.test(it.credit) && /^https:\/\/github\.com\//.test(it.creditUrl), it.id + ' 原作要署名');
  const bundled = index.filter(i => i.bundled).map(i => i.id).sort();
  assert.deepStrictEqual(bundled, ['claude-18', 'codex-18', 'deepseek-18', DEFAULT_ID, FALLBACK_ID].sort());
  for (const it of index) assert.ok(fs.existsSync(path.join(ASSETS, 'thumbs', it.id + '.webp')), it.id + ' 缺缩略图');
  for (const it of index.filter(i => i.bundled)) assert.ok(fs.existsSync(path.join(ASSETS, it.id + (it.anim === 'video' ? '.mp4' : '.webp'))), it.id + ' 缺原图');
  const lite = fs.statSync(path.join(ASSETS, DEFAULT_ID + '.mp4')).size;
  assert.ok(lite < 5 * 1024 * 1024, '内置的 Claude 原作 lite 要小于 5 MB，实际 ' + lite);
  const catalog = validateCatalog(JSON.parse(fs.readFileSync(path.join(PACKS, 'catalog.json'), 'utf8')));
  assert.deepStrictEqual(catalog.packs.map(p => p.id).sort(), index.filter(i => !i.bundled).map(i => i.id).sort());
  for (const p of catalog.packs.filter(x => x.anim === 'video')) assert.ok(p.bytes < 5 * 1024 * 1024, p.id + ' 视频包要小于 5 MB（lite）');
  // 下载用的视频包不进代码仓库，由发布脚本从仓库外单独上传，这里只核对图片包。
  for (const p of catalog.packs.filter(x => x.anim !== 'video')) {
    const raw = fs.readFileSync(path.join(PACKS, p.file));
    assert.strictEqual(raw.length, p.bytes, p.file);
    assert.strictEqual(crypto.createHash('sha256').update(raw).digest('hex'), p.sha256, p.file);
    const pack = validatePack(JSON.parse(raw.toString('utf8')));
    assert.strictEqual(pack.id, p.id);
  }
});

test('默认每天第一次启动播 Claude 原作（内置视频）；同一天第二次不播；改成每次启动就每次都播；关闭就不播', () => {
  let clock = new Date(2026, 10, 22, 9).getTime();
  const store = createBootSplashStore({ dataDir: tmp(), now: () => clock });
  const first = store.startup();
  assert.strictEqual(first.id, DEFAULT_ID);
  assert.strictEqual(first.anim, 'video');
  assert.ok(first.src.startsWith('file:') && first.src.endsWith('claude-orig.mp4'), '内置视频按本地文件播放');
  assert.ok(first.showHint && first.firstHint, '第一次要提示可以更换');
  assert.strictEqual(store.startup(), null, '同一天第二次启动不播');
  clock = new Date(2026, 10, 23, 8).getTime();
  assert.ok(store.startup(), '第二天第一次又播');
  store.savePreferences({ frequency: 'always', hintSeen: true });
  const again = store.startup();
  assert.ok(again && !again.firstHint, '每次启动都播，提示过就不再弹大提示');
  store.savePreferences({ frequency: 'off' });
  assert.strictEqual(store.startup(), null);
});

test('选内置的 Codex 18 号；没下载的不能选；选中的包被删后退回默认群星', () => {
  const dataDir = tmp();
  const store = createBootSplashStore({ dataDir, now: () => Date.now() });
  store.savePreferences({ selected: 'codex-18', frequency: 'always' });
  assert.strictEqual(store.startup().id, 'codex-18');
  assert.throws(() => store.savePreferences({ selected: 'claude-01' }), /还没下载/);
  const raw = JSON.parse(fs.readFileSync(path.join(PACKS, 'claude-01-1.0.0.json'), 'utf8'));
  store.install(raw);
  store.savePreferences({ selected: 'claude-01' });
  const spec = store.startup();
  assert.strictEqual(spec.id, 'claude-01');
  assert.ok(spec.src.startsWith('file:'), '下载的图从数据目录读');
  fs.rmSync(path.join(store.root, 'packs', 'claude-01'), { recursive: true, force: true });
  assert.strictEqual(store.startup().id, DEFAULT_ID);
});

test('旧版写进偏好的默认群星改跟新默认 Claude；亲手选过的群星保留；Gemini 目录条目能通过校验', () => {
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'boot-splash'), { recursive: true });
  const prefs = path.join(dataDir, 'boot-splash', 'preferences.json');
  fs.writeFileSync(prefs, JSON.stringify({ selected: FALLBACK_ID, frequency: 'always', lastPlayedDay: '2026-11-20', hintSeen: true }));
  const store = createBootSplashStore({ dataDir });
  assert.strictEqual(store.startup().id, DEFAULT_ID, '旧版顺手写下的群星不算用户选择');
  store.savePreferences({ selected: FALLBACK_ID });
  assert.strictEqual(store.startup().id, FALLBACK_ID, '用户亲手选的群星要保留');
  const cat = validateCatalog(JSON.parse(fs.readFileSync(path.join(PACKS, 'catalog.json'), 'utf8')));
  assert.ok(cat.packs.some(p => p.id === 'gemini-orig' && p.who === 'gemini'));
});

test('坏包不装：图片不是 webp、角色或动画不认识都整包拒收', () => {
  const good = JSON.parse(fs.readFileSync(path.join(PACKS, 'deepseek-05-1.0.0.json'), 'utf8'));
  assert.throws(() => validatePack({ ...good, image: 'data:image/png;base64,iVBORw0KGgo=' }), /图片/);
  assert.throws(() => validatePack({ ...good, who: 'gpt' }), /角色/);
  assert.throws(() => validatePack({ ...good, anim: 'explode' }), /动画/);
  assert.throws(() => validatePack({ ...good, id: '../evil' }), /标识/);
});

test('原作视频包：按目录核对后原样装上，界面拿到的是 mp4 地址', async () => {
  const dataDir = tmp();
  const body = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4000, 7)]);
  const entry = { id: 'gemini-orig', version: '3.0.0', file: 'gemini-orig-3.0.0.mp4', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), name: 'Gemini · 原作·星夜双剑', who: 'gemini', anim: 'video', weather: 'stars' };
  const catalog = { schema: 1, version: '3.0.0', packs: [entry] };
  const fetchImpl = async url => {
    const buf = url.endsWith('catalog.json') ? Buffer.from(JSON.stringify(catalog)) : url.endsWith(entry.file) ? body : null;
    if (!buf) return new Response('nope', { status: 404 });
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
  };
  const store = createBootSplashStore({ dataDir, fetchImpl, sources: [{ id: 'local', name: '本机', manifest: 'http://127.0.0.1:9/bs/catalog.json', files: 'http://127.0.0.1:9/bs/' }] });
  const snap = await store.download('gemini-orig');
  assert.strictEqual(snap.state.phase, 'installed', JSON.stringify(snap.state));
  const item = snap.items.find(i => i.id === 'gemini-orig');
  assert.ok(item.installed && /intro\.mp4/.test(item.src) && item.anim === 'video');
  assert.deepStrictEqual(fs.readFileSync(path.join(store.root, 'packs', 'gemini-orig', 'intro.mp4')), body, '原样保存，不改一个字节');
  assert.throws(() => validateCatalog({ ...catalog, packs: [{ ...entry, file: 'gemini-orig-3.0.0.json' }] }), /无效/);
});

test('下载：内源版本名 boot-splash-<版本>，按目录核对后装上，界面能直接播', async () => {
  const dataDir = tmp();
  const file = 'codex-11-1.0.0.json';
  const body = fs.readFileSync(path.join(PACKS, file));
  const catalog = { schema: 1, version: '1.0.0', packs: JSON.parse(fs.readFileSync(path.join(PACKS, 'catalog.json'), 'utf8')).packs.filter(p => p.file === file) };
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    const buf = url.endsWith('catalog.json') ? Buffer.from(JSON.stringify(catalog)) : url.endsWith(file) ? body : null;
    if (!buf) return new Response('nope', { status: 404 });
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
  };
  const store = createBootSplashStore({ dataDir, fetchImpl, sources: [{ id: 'local', name: '本机', manifest: 'http://127.0.0.1:9/bs/catalog.json', files: 'http://127.0.0.1:9/bs/' }] });
  const snap = await store.download('codex-11');
  assert.strictEqual(snap.state.phase, 'installed', JSON.stringify(snap.state));
  const item = snap.items.find(i => i.id === 'codex-11');
  assert.ok(item.installed && item.src, '下载后可以播');
  assert.ok(seen.some(u => u.endsWith(file)));
});

test('只走内源：客户端不内置阿里云、GitHub 地址；内源开着时检查目录读随包快照、不联网（HUB-H 铁律 11-25）', async () => {
  const { SOURCES } = require('../core/boot-splash');
  assert.deepStrictEqual([...SOURCES], [], '默认下载源只剩内源，代码里不写外网地址');
  // 内源地址来自 openx-config，本文件不应出现任何网址
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'core', 'boot-splash.js'), 'utf8'), /https?:\/\//);
  const fetched = [];
  const store = createBootSplashStore({ dataDir: tmp(), env: { AI_HUB_OPENX: '1' }, fetchImpl: async url => { fetched.push(url); throw new Error('不该联网'); } });
  const snap = await store.check();
  assert.notStrictEqual(snap.state.phase, 'error', JSON.stringify(snap.state));
  assert.deepStrictEqual(fetched, []);
});
