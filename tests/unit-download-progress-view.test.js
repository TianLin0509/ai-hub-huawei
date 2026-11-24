'use strict';
// r59：统一下载进度条（renderer/download-progress-view.js）+ 进度总线 + 各下载点把结构化进度传上来。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const view = require('../renderer/download-progress-view');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('进度条：百分比、已下/总量、速度、剩余时间、来源', () => {
  const html = view.html({ phase: 'downloading', received: 30 * 1048576, total: 120 * 1048576, speed: 6 * 1048576, etaSec: 15, sourceId: 'openx', sourceName: '公司内源' }, { title: '安装 Codex' });
  assert.match(html, /安装 Codex/);
  assert.match(html, /25%/);
  assert.match(html, /aria-valuenow="25"/);
  assert.match(html, /30\.0 MB \/ 120\.0 MB · 6\.0 MB\/s · 还要 15 秒/);
  assert.match(html, /data-kind="internal">来源 <b>公司内源<\/b>/);
  assert.doesNotMatch(html, /data-indeterminate/);
});

test('来源名翻成人话；内源没命中时标「备用」并写原因', () => {
  // R29：外部站点不写具体名字，只标「外部源」（只走内源后正常不会出现）。
  assert.deepEqual(view.sourceLabel('x', 'bucket.oss-cn-shanghai.aliyuncs.com'), { text: '外部源', kind: 'external' });
  assert.deepEqual(view.sourceLabel('github', 'github.com'), { text: '外部源', kind: 'external' });
  assert.equal(view.sourceLabel('aliyun-fast', '阿里云高速').text, '阿里云高速');
  assert.equal(view.sourceLabel('local', '本机已下好的文件').text, '本机已下好');
  const miss = view.html({ phase: 'downloading', received: 1, total: 2, sourceId: 'aliyun', sourceName: '阿里云', openxMiss: '内源上没有这个文件' });
  assert.match(miss, /data-kind="fallback">来源 <b>阿里云（备用）<\/b>/);
  assert.match(miss, /没走公司内源：内源上没有这个文件/);
  // 公开版不会出现内源字样：没有 openx 来源、没有 openxMiss 时只显示外部源。
  const pub = view.html({ phase: 'downloading', received: 1, total: 2, sourceId: 'github', sourceName: 'GitHub' });
  assert.doesNotMatch(pub, /内源/);
});

test('没有字节数的阶段：动态条 + 一句话；完成 100%；时间格式', () => {
  const v = view.html({ phase: 'extracting', message: '正在解压并校验联动组件…' });
  assert.match(v, /data-indeterminate/);
  assert.match(v, /正在解压并校验联动组件/);
  assert.match(view.html({ phase: 'connecting' }), /正在连接下载源/);
  assert.match(view.html({ phase: 'done', received: 5, total: 5, sourceId: 'openx' }), /100%/);
  assert.match(view.html({ phase: 'downloading', received: 0, total: 9 }), /测速中/);
  assert.doesNotMatch(view.html({ phase: 'downloading', received: 0, total: 9, etaSec: null }), /马上好/);
  assert.equal(view.fmtEta(null), '');
  const unknown = view.html({ phase: 'downloading', received: 2048, total: 0, speed: 1024 });
  assert.match(unknown, /data-indeterminate/);
  assert.match(unknown, /已下 2 KB · 1 KB\/s/);
  assert.equal(view.fmtEta(90), '还要 2 分钟');
  assert.equal(view.fmtEta(3700), '还要 1 小时 2 分');
  assert.equal(view.fmtBytes(1536), '2 KB');
});

test('进度总线：限流到 4 次/秒，阶段变化立即发', () => {
  const bus = require('../core/app-update/progress-bus');
  const got = [];
  const off = bus.on(p => got.push(p));
  bus.emit('t1', { phase: 'connecting' });
  for (let i = 1; i <= 20; i++) bus.emit('t1', { phase: 'downloading', received: i, total: 100 });
  bus.emit('t1', { phase: 'done' });
  off();
  assert.equal(got[0].phase, 'connecting');
  assert.ok(got.filter(p => p.phase === 'downloading').length <= 2, '同一阶段 250ms 内只发一次');
  assert.equal(got[got.length - 1].phase, 'done');
  assert.ok(got.every(p => p.point === 't1'));
});

test('下载器：内源没命中时，后续源的进度带 openxMiss', () => {
  const src = read('core/app-update/downloader.js');
  assert.match(src, /openxMiss: openxNote\.reason/);
});

test('团队素材包边下边报进度（原来一次读完，看不到进度）', async () => {
  const { teamPackArchive } = require('../core/company-assistant/ppt-materials');
  const crypto = require('node:crypto');
  const body = Buffer.alloc(300 * 1024, 7);
  const manifest = { archive: { hash: crypto.createHash('sha256').update(body).digest('hex'), size: body.length } };
  const seen = [];
  const got = await teamPackArchive(async () => new Response(body), manifest, ['https://dl.example.com/pptutor/materials/'], p => seen.push(p), '内源上没有这个文件');
  assert.equal(got.length, body.length);
  const last = seen[seen.length - 1];
  assert.equal(last.received, body.length);
  assert.equal(last.total, body.length);
  assert.equal(last.sourceName, 'dl.example.com');
  assert.equal(last.openxMiss, '内源上没有这个文件');
});

test('各下载点界面都用统一进度条', () => {
  for (const file of ['renderer/cli-install-view.js', 'renderer/env-check.js', 'renderer/company-ppt-page.js', 'renderer/company-ppt-materials.js',
    'renderer/company-meeting-page.js', 'renderer/company-rooms-page.js', 'renderer/appearance-controller.js', 'renderer/hub-pet/pet-settings-tab.js',
    'renderer/version-picker.js', 'renderer/app-update.js', 'renderer/workspace-controller.js', 'renderer/codeagent-setup.js', 'renderer/company-assistant-page.js',
    'renderer/community-welcome.js', 'renderer/first-run-prep.js', 'renderer/hub-error-card.js']) {
    assert.match(read(file), /download-progress-view/, file);
  }
  // 进度总线：素材包、会议转写包、CLI 安装都推；主进程转发给界面。
  assert.match(read('core/company-assistant/ppt-materials.js'), /bus\.emit\('ppt-materials'/);
  assert.match(read('core/company-assistant/meeting-asr.js'), /emit\('meeting-asr'/);
  assert.match(read('core/cli-tools/installer.js'), /emit\('cli:' \+ id/);
  assert.match(read('main/download-source-ipc.js'), /download-progress:update/);
});
