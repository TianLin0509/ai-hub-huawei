'use strict';
// 蒸馏自己 ·「我的画像」真实界面检查（2026-11-28）：隔离 Hub + 假 welink-cli + 合成消息，不登录、不碰真实 WeLink。
// 主进程的 self-distill:* 接口由 m1 并行开发；联调前这里在界面进程里用假实现顶上（只拦 self-distill:*，其余照常走主进程），
// 截图：空状态（档案没建好）→ 蒸馏进度 → 假画像三栏 → 翻页 → 逐条改 → 全部删除确认。每张都核对 1440×900 下无纵向滚动、栏内不被裁。
//   node tests/e2e-self-distill-page-cdp.js <截图目录>
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const D = require('../core/company-assistant/data');
const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'artifacts/self-distill-page-cdp');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const ME = 'user001', h16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function seed(dataDir, now) {
  const snap = { at: now - 120000, day: D.dayKey(now), login: { ok: true, uid: ME }, conversations: [{ id: 'g001', name: '工具用户群', group: true }], messages: { g001: [] }, meetings: [], calendar: [], mails: [], errors: [] };
  const dir = path.join(dataDir, 'company-assistant'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `raw-${snap.day}.json`), JSON.stringify(snap));
  const root = path.join(dataDir, 'avatar', h16(ME)); fs.mkdirSync(root, { recursive: true });
  const base = { enabled: true, action: 'draft', atOnly: false, only: [], skip: [], persona: '', notes: '', authorities: [], sources: [], backend: { account: 'auto', model: '', effort: '' }, hideModel: true, createdAt: now };
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ version: 1, paused: false, avatars: [{ ...base, id: 'vdr', tpl: 'draft', name: '帮我起草回复', kind: 'all', atOnly: true, targets: [], prefix: '我的数字分身' }] }));
}

// 假画像：数字是合成的，文字不含真实人名和项目代号。
const FAKE = {
  v: 1, createdAt: 1, updatedAt: 1,
  source: { kind: 'archive', msgs: 1520, kept: 1240, dropped: { sensitive: 31, long: 6 }, days: 30 },
  backend: { kind: 'codeagent', model: '' },
  speak: {
    stats: { median: 8, p90: 21, periodRate: 0.12, emojiRate: 0.05, burstRate: 0.31, enMixRate: 0.22 },
    catchphrases: ['我看下', '行', '好嘞', '先这样', '没问题', 'OK', '收到', '辛苦', '稍等', '明白', '对', '可以'].map((text, i) => ({ id: 'c' + i, text, n: 80 - i * 6, locked: i === 1 })),
    tone: ['先给判断再说理由', '对组员直接给下一步', '不确定时先追问口径', '很少用客套话', '数字和结论放前面', '长消息拆成几条连发'].map((text, i) => ({ id: 't' + i, text, basis: i < 3 ? '模型归纳' : '统计：1240 条里 62% 不超过 8 字', locked: false })),
    examples: [['chat', '今天这锅先放放，明早再看'], ['fact', '这个看第二版口径，别用旧表'], ['decline', '这周排满了，下周一再约'], ['chase', '进展咋样了，卡哪了说一声'], ['chat', '辛苦，早点休息'], ['fact', '结论先给：能用，细节晚点补'], ['chase', '明天中午前给我个初版'], ['decline', '这个我不太熟，问下负责的同学'], ['chat', '可以，就这么定']].map(([cat, text], i) => ({ id: 'e' + i, cat, text, locked: false })),
  },
  habits: { hours: [26, 18, 6, 1, 0, 0, 0, 1, 4, 12, 15, 14, 6, 9, 16, 17, 15, 12, 5, 8, 14, 22, 33, 35], activeFrom: 21, activeTo: 2, replyMedianMin: 4, dailyMsgs: 45,
    style: { conclusion: 48, ask: 27, decline: 9, forward: 16 }, topics: ['仿真', 'PPT', 'AI', '调度', '3GPP', '波束', 'RRM'].map((text, i) => ({ id: 'p' + i, text, n: 90 - i * 10, locked: false })) },
  tags: [{ id: 'g1', text: '话少直给', on: true }, { id: 'g2', text: '夜猫子', on: false }, { id: 'g3', text: '结论先行', on: false }],
  apply: { assistant: true, avatar: false, pet: true, community: false, ppt: false },
};

// 在界面进程里装假 self-distill:*：status/run/save/apply/delete，run 会按步骤推进度事件，最后写入假画像。
const installFake = archiveReady => `(()=>{
  const { ipcRenderer } = require('electron');
  if (!ipcRenderer.__sdOrig) ipcRenderer.__sdOrig = ipcRenderer.invoke.bind(ipcRenderer);
  const FAKE = ${JSON.stringify(FAKE)};
  const S = window.__sdFake = { portrait: null, archiveReady: ${archiveReady}, hold: false };
  const emit = ev => (ipcRenderer.listeners('self-distill:progress') || []).forEach(fn => fn({}, ev));
  ipcRenderer.invoke = async (name, p) => {
    if (!String(name).startsWith('self-distill:')) return ipcRenderer.__sdOrig(name, p);
    if (name === 'self-distill:status') return { ok: true, enabled: !!S.portrait, portrait: S.portrait, archiveReady: S.archiveReady, backendLabel: 'CodeAgent · 助理模型与供应商', running: false };
    if (name === 'self-distill:run') {
      const steps = [['collect', '取到最近 36 小时本人消息 186 条', 186], ['scrub', '去掉人名、工号、链接，丢掉 7 条敏感消息', 179], ['stats', '统计长短、口头禅和作息'], ['model', '让 CodeAgent 归纳口吻、仿写例句（约 30 秒）']];
      steps.forEach(([step, text, n], i) => setTimeout(() => emit({ step, text, n }), 150 * (i + 1)));
      if (!S.hold) setTimeout(() => { S.portrait = JSON.parse(JSON.stringify(FAKE)); emit({ step: 'done', text: '画像已更新' }); }, 900);
      return { ok: true, started: true };
    }
    if (name === 'self-distill:save') { for (const [k, v] of Object.entries(p.patch)) S.portrait[k] = Array.isArray(v) ? v : { ...S.portrait[k], ...v }; return { ok: true, portrait: S.portrait }; }
    if (name === 'self-distill:apply') { S.portrait.apply = { ...S.portrait.apply, [p.target]: p.on }; return { ok: true, apply: S.portrait.apply }; }
    if (name === 'self-distill:delete') { S.portrait = null; return { ok: true }; }
    return { ok: false, error: 'unknown' };
  };
  return true;
})()`;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-self-distill-')), dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'optional-features.json'), JSON.stringify({ assistant: true, forum: false }));
  seed(dataDir, Date.now());
  const result = { passed: false, testRoot: root, checks: [], shots: [], fixture: '隔离 Hub，假 welink-cli，合成消息；self-distill:* 为界面进程里的假实现' };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: repo, cwd: repo, dataDir, port: await freePort(), windowMode: 'hidden', label: 'self-distill', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.join(repo, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'),
      AI_HUB_CODEAGENT_CONFIG_DIR: path.join(root, 'personal'), AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan'),
      CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude'), CODEX_HOME: path.join(root, 'unused-codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(repo, 'tests/fixtures/welink-cli-standin.js'), WELINK_STANDIN_LOG: path.join(root, 'welink.jsonl'), WELINK_STANDIN_ANY_GROUP: '1',
      CLAUDE_HUB_EGRESS_FIXTURE: JSON.stringify({ domestic: { ok: false, error: 'offline test' }, foreign: { ok: false, error: 'offline test' } }),
    } });
    c = await connectFirstPage(hub);
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await c.eval(expr)) return; await _waitMs(100); } throw Error('Timeout: ' + expr); };
    const click = async selector => {
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      const point = await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, `20261128-蒸馏自己-${name}.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
    // 一屏：页面、内容区不出纵向滚动；三栏卡片里的内容不被裁掉（卡片 overflow:hidden，溢出会悄悄看不见）。
    const oneScreen = async name => {
      const m = await c.eval(`(()=>{const p=document.getElementById('avatar-page'),s=p.querySelector('[data-self-portrait]'),k=s.querySelector('.avx-body');
        const cols=[...s.querySelectorAll('.sd-col')].map(e=>({col:e.dataset.col,clip:e.scrollHeight-e.clientHeight}));
        return{over:k.scrollHeight-k.clientHeight,root:p.scrollHeight-p.clientHeight,doc:document.documentElement.scrollHeight-innerHeight,wide:s.scrollWidth-s.clientWidth,cols}})()`);
      assert.ok(m.over <= 1 && m.root <= 1 && m.doc <= 1 && m.wide <= 1, `${name} 出现滚动：${JSON.stringify(m)}`);
      for (const col of m.cols) assert.ok(col.clip <= 1, `${name} 的「${col.col}」栏内容被裁 ${col.clip}px`);
      return m;
    };
    await until(`(()=>{const b=document.getElementById('btn-avatar');return !!b&&!b.hidden&&getComputedStyle(b).display!=='none'})()`);
    assert.equal(await c.eval(installFake(false)), true);
    await click('#btn-avatar');
    await until(`!document.getElementById('avatar-page')?.hidden && !!document.querySelector('#avatar-page [data-av="self-open"]')`);
    await until(`document.querySelectorAll('#avatar-page .avx-row').length>=3`);
    await click('#avatar-page .avx-head [data-av="self-open"]');
    await until(`!!document.querySelector('[data-self-portrait]') && (document.querySelector('[data-self-portrait]').textContent||'').includes('36 小时')`);
    await _waitMs(200); await shot('1-空状态-档案没建好'); result.empty = await oneScreen('空状态');
    result.checks.push('顶栏「蒸馏自己」进「我的画像」；档案没建好时就地提示 36 小时初版并给「一键继续」');

    await c.eval(`window.__sdFake.hold = true`);
    await click('[data-self-portrait] [data-av="sd-run"]');
    await until(`(document.querySelector('.sd-prog')?.textContent||'').includes('归纳口吻')`);
    await shot('2-蒸馏进度'); result.checks.push('蒸馏进度逐步用人话显示：取材 186 条 → 去敏 → 统计 → 模型提炼');
    await c.eval(`(()=>{const S=window.__sdFake;S.hold=false;S.archiveReady=true;S.portrait=${JSON.stringify(FAKE)};require('electron').ipcRenderer.listeners('self-distill:progress').forEach(fn=>fn({}, {step:'done',text:'画像已更新'}));})()`);
    await until(`document.querySelectorAll('.sd-col').length===3`);
    await _waitMs(300); await shot('3-假画像三栏'); result.portrait = await oneScreen('假画像三栏');
    result.checks.push('三栏（说话 / 习性 / 应用到）一屏放下，五个开关各带一句说明');

    await click('[data-self-portrait] [data-av="sd-page"][data-sec="examples"][data-d="1"]');
    await until(`(document.querySelector('[data-col="speak"]')?.textContent||'').includes('2 / 3')`);
    await click('[data-self-portrait] [data-av="sd-edit"][data-sec="tone"]');
    await until(`!!document.querySelector('[data-sd-edit="tone"]')`);
    await _waitMs(150); await shot('4-翻页与逐条改'); await oneScreen('翻页与逐条改');
    await click('[data-self-portrait] [data-av="sd-cancel"]');
    await c.eval(`document.querySelector('[data-chg="sd-apply"][data-k="community"]').click()`);
    await until(`window.__sdFake.portrait.apply.community===true`);
    result.checks.push('例句翻页、逐条改在原位出输入框；勾「社区」写入应用开关');

    await click('[data-self-portrait] [data-av="sd-delete"]');
    await until(`(document.querySelector('#avatar-page .avx-md')?.textContent||'').includes('删除全部画像')`);
    await shot('5-全部删除确认');
    await click('#avatar-page [data-av="confirm-yes"]');
    await until(`window.__sdFake.portrait===null && !document.querySelector('.sd-grid')`);
    result.checks.push('全部删除二次确认后回到空状态');
    result.passed = true;
  } catch (e) {
    result.error = e.stack || String(e);
    try { if (c) { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261128-蒸馏自己-失败现场.png'), Buffer.from(s.data, 'base64')); } } catch { /* 截不到就算了 */ }
  } finally {
    if (hub) result.teardown = await gracefulQuit(hub);
    if (c) await c.close().catch(() => {});
    fs.writeFileSync(path.join(out, '20261128-蒸馏自己-e2e结果.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, error: result.error ? String(result.error).split('\n')[0] : undefined, shots: result.shots }, null, 1));
    process.exitCode = result.passed ? 0 : 1;
  }
})();
