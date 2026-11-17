'use strict';
// r27h：下载形象也带动作序列（打字、待机小动作）与裁切帧清单；包校验只收合法的裁切帧。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../core/hub-pet/role-packs');

// 最小合法 WebP（RIFF....WEBP 头 + VP8L 1×1），只用于校验链路，不渲染。
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const data = 'data:image/webp;base64,' + WEBP.toString('base64');
function pack(meta, extraFiles = {}) {
  const files = { 'idle.webp': data, 'typing.webp': data, 'happy.webp': data, 'sleep.webp': data, ...extraFiles };
  return { schema: 1, id: '05-rabbit', version: '1.1.0', name: '兔子', meta: { poses: ['idle', 'typing', 'happy', 'sleep'], ...meta }, files };
}
const seqFiles = { 'seq-typing.webp': data, 'seq-idle-life.webp': data };

test('带序列与裁切帧的下载包能通过校验，裁切帧去重后原样保留', () => {
  const p = R.validatePack(pack({ sequences: ['typing', 'idle-life'], clipped: { typing: [5, 6, 6, 24] } }, seqFiles));
  assert.deepEqual(p.meta.sequences, ['typing', 'idle-life']);
  assert.deepEqual(p.meta.clipped, { typing: [5, 6, 24] });
  assert.ok(p.buffers['seq-idle-life.webp']);
});

test('没有裁切帧清单的老包照常通过，clipped 为空对象', () => {
  const p = R.validatePack(pack({ sequences: [] }));
  assert.deepEqual(p.meta.clipped, {});
});

test('裁切帧清单不合法时整包拒收：越界帧号、非整数、指向包里没有的序列、不是对象', () => {
  for (const clipped of [{ typing: [25] }, { typing: [-1] }, { typing: [1.5] }, { typing: ['3'] }, { stretch: [1] }, [1, 2], 'x', { typing: 'all' }]) {
    assert.throws(() => R.validatePack(pack({ sequences: ['typing', 'idle-life'], clipped }, seqFiles)), /裁切帧/);
  }
});

test('声明了序列却没带对应序列图，整包拒收', () => {
  assert.throws(() => R.validatePack(pack({ sequences: ['typing', 'idle-life'] }, { 'seq-typing.webp': data })), /seq-idle-life/);
});

test('程序自带的小猫、企鹅清单在新校验下仍然有效', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../renderer/assets/hub-pet/manifest.json'), 'utf8'));
  for (const id of ['01-cat', '03-penguin']) {
    const m = R.validateMeta(manifest[id]);
    assert.deepEqual(m.sequences, ['typing', 'idle-life', 'dock-right', 'stretch']);
    assert.deepEqual(m.clipped, manifest[id].clipped);
  }
});

test('装好的下载包把序列和裁切帧交给桌宠窗口（meta 读回一致）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-frames-'));
  try {
    const store = R.createRolePackStore({ assetsDir: path.join(dir, 'assets'), dataDir: path.join(dir, 'data'), logger: { warn() {} } });
    store.install(pack({ sequences: ['typing', 'idle-life'], clipped: { typing: [5, 6] } }, seqFiles));
    const meta = store.meta('05-rabbit');
    assert.deepEqual(meta.sequences, ['typing', 'idle-life']);
    assert.deepEqual(meta.clipped, { typing: [5, 6] });
    assert.ok(fs.existsSync(path.join(store.root, '05-rabbit', 'seq-idle-life.webp')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
