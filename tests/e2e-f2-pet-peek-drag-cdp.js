'use strict';
// r7 F2 回归：桌宠拖动——平时能不能拖；全屏躲边（只露个头）时能不能拖出来。隔离 Hub，窗口压在屏幕外，光标用注入位置。
const fs = require('fs'); const os = require('os'); const net = require('net'); const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const REPO = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-f2-pet-')); const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'hub-pet.json'), JSON.stringify({ enabled: true, introduced: true, role: '01-cat', mode: 'gentle', showGrowth: true, optInV: 1 }));
  const log = []; let hub;
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label: 'f2-pet', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0', CLAUDE_HUB_ATTENDANCE_TIMER: '0', HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(REPO, 'tests/fixtures/welink-cli-standin.js') } });
    const page = await connectFirstPage(hub, null, { waitMainMs: 40000 });
    const dbg = req => page.eval(`ipcRenderer.invoke('hub-pet:debug', ${JSON.stringify(req)})`);
    const until = async (fn, label, t = 20000) => { const end = Date.now() + t; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(200); } throw new Error('Timeout ' + label); };
    await until(() => dbg({ op: 'state' }), 'debug');
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    await dbg({ op: 'override', nowShift: noon.getTime() - Date.now(), idleSec: 0, running: 0, sessions: [], fullscreen: false, meeting: false, virtual: true });
    await sleep(1500);
    const pos = async () => { const s = await dbg({ op: 'state' }); return s.bounds; };
    async function drag(label) {
      const b0 = await pos();
      const c = { x: b0.x + 140, y: b0.y + b0.height - 120 };
      await dbg({ op: 'cursor', pos: c });
      await dbg({ op: 'press', target: 'pet' });
      for (let i = 1; i <= 10; i++) { await dbg({ op: 'cursor', pos: { x: c.x - i * 30, y: c.y - i * 20 } }); await sleep(40); }
      const mid = await pos();
      await dbg({ op: 'release' }); await sleep(1500);
      const b1 = await pos(); const s = await dbg({ op: 'state' });
      const moved = Math.round(Math.hypot(mid.x - b0.x, mid.y - b0.y));
      log.push(`${label}: 拖前 (${b0.x},${b0.y}) 拖动中 (${mid.x},${mid.y}) 松手后 (${b1.x},${b1.y}) 跟手位移 ${moved}px peeking=${s.lastSent?.peeking} dock=${s.dock}`);
      return { moved, peeking: s.lastSent?.peeking };
    }
    const normal = await drag('平时');
    await dbg({ op: 'override', fullscreen: true }); await sleep(1200);
    log.push('躲边后 peeking=' + (await dbg({ op: 'state' })).lastSent?.peeking);
    const peek = await drag('躲边时');
    await dbg({ op: 'override', fullscreen: false }); await sleep(1200);
    log.push('全屏结束后 peeking=' + (await dbg({ op: 'state' })).lastSent?.peeking);
    await dbg({ op: 'override', fullscreen: true }); await sleep(1200);
    const again = (await dbg({ op: 'state' })).lastSent?.peeking;
    log.push('再次全屏 peeking=' + again);
    if (!(normal.moved > 100 && peek.moved > 100 && peek.peeking === false && again === true)) { log.push('FAIL'); process.exitCode = 1; } else log.push('PASS');
    log.push(JSON.stringify({ normalMoved: normal.moved, peekMoved: peek.moved, peekAfterDrag: peek.peeking }));
  } catch (e) { log.push('ERROR ' + e.stack); }
  finally { if (hub) await gracefulQuit(hub).catch(() => {}); }
  console.log(log.join('\n'));
})();
