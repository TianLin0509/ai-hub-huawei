'use strict';
// 提示大清理（2026-11-24）改前改后对比：隔离 Hub、1440 宽、后台无窗口。典型场景按主进程真实会发的提示原样送进渲染进程，
// 数用户实际看到几条：常驻提示条、轻提示、会话里的报错行、输入框状态行（「会话已断开」「自动重试」、自动换号进度）。
// 用法：node tests/e2e-notice-cull-cdp.js            → 跑本工作树（改后）
//       HUB_E2E_ENTRY=<旧版仓库目录> node tests/e2e-notice-cull-cdp.js → 跑改前（同一脚本、同一组输入）
//       HUB_E2E_ARTIFACT_DIR 指定截图与 JSON 输出目录。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const REPO = path.resolve(__dirname, '..');
const ENTRY = path.resolve(process.env.HUB_E2E_ENTRY || REPO);
const LABEL = process.env.HUB_E2E_LABEL || (ENTRY === REPO ? 'after' : 'before');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const OUT = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(REPO, 'artifacts', 'notice-cull')); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const LIMIT = "You've hit your 5-hour limit · resets 3:10am (Asia/Shanghai)";
const retry = attempt => ({ state: 'running', connection: 'connected', userMessageId: 'u1', apiRetry: { status: 529, attempt, maxRetries: 10, userMessageId: 'u1' } });
// 每个场景：会话提示（main / core 的真实文案和字段）、PTY 画面行、Claude 引擎重试快照、自动换号进度、会话里最后一段报错，以及报错所属会话的状态。
const SCENARIOS = [
  { key: 'jitter', name: '网络抖动自动重连', expectAfter: 0, notices: [
      { level: 'info', persistent: false, noticeKind: 'auto', message: '共享主机连不上（ECONNRESET）。Hub 每 30 秒自动重连。' },
      { level: 'warning', persistent: true, noticeKind: 'auto', message: '公司模型：号池里暂时没有可用账号，这个会话已改用你的个人 CodeAgent 账号继续。' },
      { level: 'info', persistent: false, noticeKind: 'auto', message: '共享主机已恢复连接，号池可以正常使用。' },
    ],
    pty: ['■ stream disconnected before completion: error sending request for url; retrying 1/5 in 206ms…',
      '■ Reconnecting... 2/5\n  └ stream disconnected before completion: error sending request for url'] },
  { key: 'tool-retry', name: '工具调用失败后自动重试成功', expectAfter: 0, notices: [
      { level: 'warning', persistent: true, message: '结构化通道多次中断，已自动改回终端方式，会话可以继续用。' },
      { level: 'warning', persistent: true, message: '原模型 glm-5 不可用，已换成 deepseek-v4（原模型请求被拒绝，已从可用列表里自动换）' },
    ],
    retries: [retry(1), retry(2), retry(3)] },
  { key: 'quota-auto', name: '额度用完·已开自动换号（同会话撞墙 3 次）', expectAfter: 1,
    cardSession: { kind: 'claude', claudeAutoSwitch: true, claudeSwitchStatus: { status: 'switching', message: '正在切换到账号5，保留当前上下文…' } },
    switchStates: [{ status: 'checking', message: '额度已耗尽，正在确认其他账号的可用额度…' }, { status: 'switching', message: '正在切换到账号5，保留当前上下文…' }, { status: 'continued', message: '账号已切换，已提交继续；正在等待 Claude 响应' }],
    turnErrors: [LIMIT, LIMIT, LIMIT] },
  { key: 'quota', name: '额度用完·没开自动换号（同一窗口内又撞 2 次）', expectAfter: 1, cardSession: { kind: 'claude' }, turnErrors: [LIMIT, LIMIT, LIMIT] },
  { key: 'quota-plan', name: '额度用完·Token Plan（同一原因报两次）', expectAfter: 1, notices: [
      { level: 'warning', noticeKind: 'blocking', message: 'Token Plan 本月额度已用完（重置时间未知）。本会话不改走 API，重置后再发即可。' },
      { level: 'warning', noticeKind: 'blocking', message: 'Token Plan 本月额度已用完（重置时间未知）。本会话不改走 API，重置后再发即可。' },
    ] },
  { key: 'login', name: '登录失效（同一原因报两次）', expectAfter: 1, notices: [
      { level: 'warning', persistent: true, action: 'codeagent-login', message: '尚未登录或登录已过期，本条消息未发送。请点「登录」后重发。' },
      { level: 'warning', persistent: true, action: 'codeagent-login', message: '尚未登录或登录已过期，本条消息未发送。请点「登录」后重发。' },
    ] },
];

(async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notice-cull-')), DATA = path.join(ROOT, 'data');
  fs.mkdirSync(DATA, { recursive: true });
  let hub, c; const log = [], result = { label: LABEL, entry: ENTRY, scenarios: [] };
  const until = async (expr, label, t = 60000) => { const end = Date.now() + t; let last; while (Date.now() < end) { try { last = await c.eval(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(200); } throw new Error('Timeout ' + label + ' ' + JSON.stringify(last)); };
  const shot = async n => { await sleep(500); const img = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `20261124-notice-cull-${LABEL}-${n}.png`); fs.writeFileSync(f, Buffer.from(img.data, 'base64')); log.push('SHOT ' + f); return f; };
  const E = JSON.stringify(ENTRY.replace(/\\/g, '/'));
  try {
    hub = await launchIsolatedHub({ entryPath: ENTRY, cwd: ENTRY, dataDir: DATA, port: await freePort(), label: 'notice-cull-' + LABEL, windowMode: 'hidden',
      extraEnv: { AI_HUB_WORKSPACE_ROOT: '', CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && typeof showToast === 'function'`, 'renderer ready');
    await sleep(3000);
    // 记下场景期间每一次出现的提示节点；轻提示同一时间只有一个节点（改前同文重复时复用节点，计数是下限）。
    await c.eval(`(()=>{window.__seen=[];const pick=n=>n.nodeType===1&&(n.classList.contains('hub-sticky-notice')||n.id==='hub-err-toast'||n.id==='gc-fork-toast');
      new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes)if(pick(n))window.__seen.push({kind:n.id||'sticky',text:(n.textContent||'').trim().slice(0,120),h:Math.round(n.getBoundingClientRect().height)})}).observe(document.body,{childList:true,subtree:true});
      window.__e2eBasics={};const orig=window.__hubSessionBasics;window.__hubSessionBasics=id=>window.__e2eBasics[id]?(()=>{const s=window.__e2eBasics[id];let quotaAuto='';try{quotaAuto=require(${E}+'/renderer/turn-error-help.js').quotaAutoText?.(s)||''}catch{}return {kind:s.kind,cwd:'',quotaAuto}})():orig(id);return 1})()`);
    for (const sc of SCENARIOS) {
      await c.eval(`(()=>{window.__seen=[];for(const n of document.querySelectorAll('.hub-sticky-notice,#hub-err-toast,#gc-fork-toast,.e2e-turn-host'))n.remove();return 1})()`);
      const sessionId = 'e2e-' + sc.key;
      if (sc.cardSession) await c.eval(`window.__e2eBasics[${JSON.stringify(sessionId)}]=${JSON.stringify(sc.cardSession)};1`);
      for (const n of sc.notices || []) {
        await c.eval(`require('electron').ipcRenderer.emit('session-notice', {}, ${JSON.stringify({ sessionId, ...n })})`);
        await sleep(150);
      }
      // 状态行：PTY 行被判成断连 → 「会话已断开」。
      const disconnects = await c.eval(`(()=>{const d=require(${E}+'/core/stream-disconnect.js');return ${JSON.stringify(sc.pty || [])}.filter(t=>d.detectStreamDisconnect(t)).length})()`);
      // 状态行：原生 Claude 引擎重试，用真实状态行模型算出文字，看是否写「重试」。
      const retryLines = await c.eval(`(()=>{const {deriveSessionRuntimeStatus}=require(${E}+'/renderer/session-runtime-status.js'),{buildComposerStatusModel}=require(${E}+'/core/session-status-summary.js');
        return ${JSON.stringify(sc.retries || [])}.filter(nr=>{const s={id:'r',kind:'claude',runtimeBackend:'claude-stream-json',status:'running',nativeRuntime:{...nr,startedAt:Date.now()-5000}};
          return /重试/.test(buildComposerStatusModel(s,{runtime:deriveSessionRuntimeStatus(s,{})}).text)}).length})()`);
      // 状态行：自动换号的每一步进度是否写进状态行（改前一律写；改后按闸门）。
      const switchLines = await c.eval(`(()=>{let g=null;try{g=require(${E}+'/core/notice-gate.js').switchStatusVisible}catch{}return ${JSON.stringify(sc.switchStates || [])}.filter(s=>g?g(s):!!s.message).length})()`);
      // 会话里的报错：用真实 turn-error-help 增强；看得见的 = 有说明行，或原文没被收进「原始报错」折叠。
      const cards = await c.eval(`(()=>{const h=require(${E}+'/renderer/turn-error-help.js');const out=[];let i=0;
        for(const text of ${JSON.stringify(sc.turnErrors || [])}){const host=document.createElement('div');host.className='e2e-turn-host';
          Object.assign(host.style,{position:'fixed',left:'320px',bottom:(150+i*70)+'px',width:'760px',zIndex:99999,background:'var(--surface-1,#fff)',padding:'8px'});
          host.innerHTML='<div class="turn-card assistant" data-session-id=${JSON.stringify(sessionId)} data-turn-id="t'+(i++)+'"><div class="turn-body"><p></p></div></div>';host.querySelector('p').textContent=text;
          document.body.appendChild(host);h.enhanceCard(host.firstChild);const el=host.querySelector('.turn-error-help');const raw=host.querySelector('details.teh-raw');
          out.push({visible:!!el||!raw,h:el?Math.round(el.getBoundingClientRect().height):0,title:el?el.querySelector('.teh-title').textContent:(raw?'':text.slice(0,60))});}
        return out})()`);
      await sleep(600);
      const seen = await c.eval('window.__seen.slice()');
      const screenshot = await shot(sc.key);
      const cardCount = cards.filter(x => x.visible).length;
      const visible = seen.length + disconnects + retryLines + switchLines + cardCount;
      result.scenarios.push({ key: sc.key, name: sc.name, visible, notices: seen, disconnects, retryLines, switchLines, cards, screenshot, expectAfter: sc.expectAfter });
      log.push(`${LABEL} ${sc.name}: 显示 ${visible} 条（提示 ${seen.length}、状态行断开 ${disconnects}、状态行重试 ${retryLines}、换号进度 ${switchLines}、会话内报错 ${cardCount}）`);
    }
    // 保留下来的三种提示同屏的样子（小号、低调、不压输入框）：常驻条、错误轻提示、普通轻提示。
    await c.eval(`(()=>{for(const n of document.querySelectorAll('.e2e-turn-host'))n.remove();
      require('electron').ipcRenderer.emit('session-notice',{},{sessionId:'e2e-style',level:'warning',persistent:true,action:'codeagent-login',message:'尚未登录或登录已过期，本条消息未发送。请点「登录」后重发。'});
      showToast('消息未发送：CLI 已退出到系统终端，消息未发送；请先重启会话','error');showToast('已复制','warning');return 1})()`);
    const sizes = await c.eval(`(()=>{const r=s=>{const e=document.querySelector(s);if(!e||getComputedStyle(e).display==='none')return null;const b=e.getBoundingClientRect();return {w:Math.round(b.width),h:Math.round(b.height),x:Math.round(b.left),y:Math.round(b.top)}};
      return {sticky:r('.hub-sticky-notice'),errToast:r('#hub-err-toast'),toast:r('#gc-fork-toast')}})()`);
    result.styleSizes = sizes;
    log.push('样式尺寸 ' + JSON.stringify(sizes));
    await shot('styles');
    result.muted = await c.eval(`window.__hubNoticeGate ? window.__hubNoticeGate.recentMuted().length : null`);
    log.push('闸门拦下：' + result.muted);
    if (LABEL === 'after') for (const s of result.scenarios) if (s.visible !== s.expectAfter) { log.push(`FAIL ${s.name} 期望 ${s.expectAfter} 实际 ${s.visible}`); process.exitCode = 1; }
  } catch (e) { log.push('FAIL ' + (e.stack || e.message)); process.exitCode = 1; }
  finally {
    if (hub) await gracefulQuit(hub).catch(e => log.push('quit ' + e.message));
    fs.writeFileSync(path.join(OUT, `20261124-notice-cull-${LABEL}.json`), JSON.stringify(result, null, 2));
    console.log(log.join('\n'));
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
})();
