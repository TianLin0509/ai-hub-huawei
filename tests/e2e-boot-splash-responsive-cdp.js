'use strict';
// 真实隔离窗口：后台绘制、加载中跳过、缩放、解码迟到、视频、兼容渲染和截屏。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = process.env.HUB_E2E_ARTIFACT_DIR || path.resolve(__dirname, '../artifacts/20261123-r12-splash-responsive-root');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function run(software) {
  const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'splash-responsive-')), 'data');
  const hub = await launchIsolatedHub({ dataDir, port: await port(), windowMode: 'background', label: 'splash-responsive', extraArgs: ['--mute-audio', ...(software ? ['--disable-gpu'] : [])] });
  const cdp = await connectFirstPage(hub), measures = { software };
  const until = async expr => { const end = Date.now() + 20000; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(60); } throw new Error('等待超时：' + expr); };
  const play = () => cdp.eval(`void window.hubBootSplash.play({ id:'galaxy-constellation', anim:'galaxy', weather:'stars', who:'hub', src:'assets/boot-splash/galaxy-constellation.webp' })`);
  const esc = async () => { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  const click = async () => { await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 300, y: 300 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 300, y: 300 }); };
  try {
    await until('!!window.hubBootSplash');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const shape = () => cdp.eval(`require('electron').ipcRenderer.invoke('debug:window-shape')`);
    measures.window = await shape();
    assert.equal(measures.window.contentProtected, false, '主窗口未启用防截屏');
    await play(); await until('document.getElementById("boot-splash-layer")?.dataset.renderer === "worker"');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 3840, height: 2160, deviceScaleFactor: 2, mobile: false });
    await sleep(100);
    measures.geometry = await cdp.eval(`(() => { const e=document.getElementById('boot-splash-layer'), r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width,height:r.height,toolbarHit:!document.elementFromPoint(innerWidth-20,20)?.closest('.boot-splash-layer')}; })()`);
    assert.equal(measures.geometry.width, 3840); assert.equal(measures.geometry.height, 2116); assert.equal(measures.geometry.top, 44); assert.equal(measures.geometry.toolbarHit, true);
    assert.deepEqual((await shape()).overlay, measures.window.overlay, '播放中按钮保持主题色');
    // 后台线程在 4K / 200% 缩放下绘制时，主界面的计时器仍能持续响应。
    measures.heartbeat = await cdp.eval(`new Promise(resolve => { const gaps=[]; let last=performance.now(); const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},20);setTimeout(()=>{clearInterval(timer);resolve({samples:gaps.length,maxGap:Math.max(...gaps)});},600); })`);
    assert.ok(measures.heartbeat.samples >= 5 && measures.heartbeat.maxGap < 500, JSON.stringify(measures.heartbeat));
    await esc(); await until('!document.getElementById("boot-splash-layer")');
    assert.deepEqual((await shape()).overlay, measures.window.overlay, '跳过不改标题栏按钮颜色');
    // 故意把解码挂起，Esc 后迟到的完成结果也不能重新盖住界面。
    await cdp.eval(`window.__splashDecode=Image.prototype.decode; window.__splashGate=new Promise(r=>window.__splashRelease=r); Image.prototype.decode=async function(){window.__splashDecoding=true; await window.__splashGate; return window.__splashDecode.call(this);};`);
    await play(); await until('window.__splashDecoding === true');
    assert.equal(await cdp.eval('document.getElementById("boot-splash-layer")?.dataset.phase'), 'loading');
    await esc(); await until('!document.getElementById("boot-splash-layer")');
    await cdp.eval('Image.prototype.decode=window.__splashDecode; window.__splashRelease()');
    await sleep(200); assert.equal(await cdp.eval('!!document.getElementById("boot-splash-layer")'), false);
    // 连续重播只保留最后一轮；点击立即跳过，后台定时器不会再把它弹回来。
    await cdp.eval(`void window.hubBootSplash.play({anim:'galaxy',weather:'stars',who:'hub',src:'assets/boot-splash/galaxy-constellation.webp'});void window.hubBootSplash.play({anim:'soft',weather:'stars',who:'codex',src:'assets/boot-splash/codex-18.webp'});`);
    await until('document.getElementById("boot-splash-layer")?.dataset.renderer === "worker"');
    assert.equal(await cdp.eval('document.querySelectorAll("#boot-splash-layer").length'), 1);
    await click(); await until('!document.getElementById("boot-splash-layer")');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // 模拟 Worker 不可用：仅此失败环境显示静态图，仍然能跳过。
    await cdp.eval('window.__splashWorker=window.Worker; window.Worker=undefined'); await play();
    await until('document.getElementById("boot-splash-layer")?.dataset.renderer === "poster"');
    await esc(); await until('!document.getElementById("boot-splash-layer")'); await cdp.eval('window.Worker=window.__splashWorker');
    // 没有外部视频时现场生成短 WebM，视频分支始终实测，不依赖私有素材。
    const src = process.env.BOOT_SPLASH_TEST_VIDEO ? pathToFileURL(process.env.BOOT_SPLASH_TEST_VIDEO).href : await cdp.eval(`new Promise(resolve => {
      const cv=document.createElement('canvas');cv.width=320;cv.height=180;const ctx=cv.getContext('2d');
      const stream=cv.captureStream(10), chunks=[], recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      let frame=0;const timer=setInterval(()=>{ctx.fillStyle=frame++%2?'#3478f6':'#ffffff';ctx.fillRect(0,0,320,180);},80);
      recorder.ondataavailable=e=>chunks.push(e.data);
      recorder.onstop=()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop());window.__splashTestVideoBlob=new Blob(chunks,{type:'video/webm'});resolve(URL.createObjectURL(window.__splashTestVideoBlob));};
      recorder.start();setTimeout(()=>recorder.stop(),1200);
    })`);
    let playbackSrc = src;
    if (!process.env.BOOT_SPLASH_TEST_VIDEO) {
      const file = path.join(dataDir, '20261123-splash-merge-video-root.webm');
      await cdp.eval(`window.__splashTestVideoBlob.arrayBuffer().then(bytes=>require('fs').writeFileSync(${JSON.stringify(file)},Buffer.from(bytes)))`);
      playbackSrc = pathToFileURL(file).href;
    }
    try {
      await cdp.eval(`void window.hubBootSplash.play({anim:'video',who:'hub',src:${JSON.stringify(playbackSrc)}})`);
      await until('(document.querySelector("#boot-splash-layer video")?.currentTime || 0) > 0.3');
      assert.match(await cdp.eval('document.querySelector("#boot-splash-layer video").src'), /^blob:/, '本地视频保留主干的 Blob 兼容播放');
      assert.ok(await cdp.eval('document.getElementById("boot-splash-layer").getBoundingClientRect().top >= 44'));
      await click(); await until('!document.getElementById("boot-splash-layer")');
      await sleep(200); assert.equal(await cdp.eval('!!document.getElementById("boot-splash-layer")'), false, '视频清理不能触发错误后重新播放');
      await cdp.eval(`void window.hubBootSplash.play({anim:'video',who:'hub',src:${JSON.stringify(playbackSrc)}})`);
      await until('(document.querySelector("#boot-splash-layer video")?.currentTime || 0) > 0.2');
      await until('!document.getElementById("boot-splash-layer")');
      measures.video = 'passed';
    } finally { if (!process.env.BOOT_SPLASH_TEST_VIDEO) await cdp.eval(`URL.revokeObjectURL(${JSON.stringify(src)})`); }
    // 三种图片动画在真实后台线程里都能自然结束，截取播放中的画面核对。
    fs.mkdirSync(out, { recursive: true });
    for (const anim of ['soft', 'rush', 'galaxy']) {
      await cdp.eval(`void window.hubBootSplash.play({anim:${JSON.stringify(anim)},weather:'stars',who:'hub',src:'assets/boot-splash/galaxy-constellation.webp'})`);
      await until('document.getElementById("boot-splash-layer")?.dataset.renderer === "worker"');
      if (anim === 'galaxy') {
        await sleep(1600);
        assert.equal(await cdp.eval('document.getElementById("boot-splash-layer")?.dataset.renderer'), 'worker', '截图时确实正在播放');
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const png = Buffer.from(shot.data, 'base64');
        const { channels } = await require('sharp')(png).extract({ left: 80, top: 100, width: 100, height: 100 }).stats();
        assert.ok(channels.slice(0, 3).every(c => c.mean < 90), '动画截图包含深色背景，不能拿播完后的首页充数');
        fs.writeFileSync(path.join(out, `20261123-r12-playing-${software ? 'software' : 'default'}-root.png`), png);
      }
      await until('!document.getElementById("boot-splash-layer")');
    }
    measures.animations = ['soft', 'rush', 'galaxy'];
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.data, 'base64');
    const { channels } = await require('sharp')(png).stats();
    assert.ok(channels.some(c => c.max - c.min > 40), '窗口截屏含实际界面而非全黑');
    fs.writeFileSync(path.join(out, `20261123-r12-capture-${software ? 'software' : 'default'}-root.png`), png);
    assert.doesNotMatch(hub.log().join('\n'), /renderer-memory-at-hang|renderer-hang-stack|window-unresponsive/);
    measures.capture = 'passed'; return measures;
  } finally { await cdp.close().catch(() => {}); await gracefulQuit(hub); }
}
(async () => {
  const results = []; for (const software of [false, true]) results.push(await run(software));
  const report = JSON.stringify({ ok: true, results }, null, 2);
  fs.writeFileSync(path.join(out, '20261123-r12-measures-root.json'), report); console.log(report);
})().catch(e => { console.error(e); process.exitCode = 1; });
