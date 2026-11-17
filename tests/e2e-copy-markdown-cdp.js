'use strict';
// 复制为 Markdown 的真实操作回归（2026-11-17 同事反馈：想把回答连公式一起粘进 Obsidian）。
// 隔离 Hub、合成一条带标题/列表/表格/代码/公式的回答、模拟 CodeAgent，无头；剪贴板写入在发出前截获，不碰系统剪贴板。
// 覆盖：默认（没打开）时复制按钮仍是纯文本；右键「复制为 Markdown」拿到选中部分的 Markdown（公式 $…$ / $$…$$）；
// 菜单里打开「Ctrl+C 和复制按钮都给 Markdown」后，Ctrl+C 部分选中和卡片复制按钮都给 Markdown。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-md-e2e-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), PERSONAL = path.join(ROOT, 'personal'), LOG = path.join(ROOT, 'fake.jsonl');
const OUT = process.env.HUB_E2E_ARTIFACT_DIR || path.join(ROOT, 'artifacts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function wait(fn, label, timeout = 60000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(100); } throw Error('Timeout ' + label + (last ? ': ' + last.message : '')); }
function ok(label, condition = true, detail = '') { assert(condition, label + (detail ? ' ' + detail : '')); console.log('PASS ' + label + (detail ? ' ' + detail : '')); }

const ANSWER = [
  '## 勾股定理',
  '',
  '直角三角形满足 $a^2+b^2=c^2$，其中 **c** 是斜边。',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '- 第一条：看 `x` 的值',
  '- 第二条：[文档](https://example.com/doc)',
  '',
  '1. 先算',
  '2. 再比',
  '',
  '| 名称 | 数值 |',
  '| --- | --- |',
  '| SINR | 12 dB |',
  '',
  '```python',
  'print("hi")',
  'value = """first',
  '',
  '',
  'last  """',
  '    ',
  'done = 1',
  '```',
].join('\n');
// 审查返工（2026-11-18）：代码块正文必须逐字保留——多个空行、行尾空格、只有缩进的空行。
const CODE_BODY = 'print("hi")\nvalue = """first\n\n\nlast  """\n    \ndone = 1';

function writeHistory(file, sessionId) {
  const rows = [];
  let parent = null;
  for (const [role, text] of [['user', '讲一下勾股定理'], ['assistant', ANSWER]]) {
    const id = crypto.randomUUID();
    rows.push(JSON.stringify({ type: role, sessionId, cwd: WORK, uuid: id, parentUuid: parent, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } }));
    parent = id;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.join('\n') + '\n');
}

async function run() {
  for (const dir of [DATA, WORK, PERSONAL, OUT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
  fs.writeFileSync(path.join(PERSONAL, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'fixture', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(PERSONAL, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  const hub = await launchIsolatedHub({ entryPath: REPO, cwd: REPO, dataDir: DATA, port: await freePort(), label: 'copy-md', windowMode: 'background', extraEnv: {
    AI_HUB_WORKSPACE_ROOT: WORK, AI_HUB_CODEAGENT_COMMAND: path.join(REPO, 'tests/fixtures/codeagent-pool-fake/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: PERSONAL, CODEAGENT_POOL_FAKE_LOG: LOG,
    AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(ROOT, 'scan'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CODEX_HOME: path.join(ROOT, 'codex'), HUB_SESSION_SEARCH_DISABLE_NATIVE: '1',
  } });
  const c = await connectFirstPage(hub, t => /renderer[\\/]index\.html/.test(t.url));
  const mouse = async (xy, button = 'left') => { for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...xy, button, clickCount: 1 }); };
  const center = selector => wait(() => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width)return null;return {x:r.left+r.width/2,y:r.top+r.height/2}})()`), selector);
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(image.data, 'base64')); };
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await wait(() => c.eval('document.readyState==="complete"&&typeof selectSession==="function"&&!!window.__codeagentAccountsOpen'), 'app ready');
    const invoke = (channel, payload) => c.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
    const created = await invoke('create-session', { kind: 'codeagent', opts: { cwd: WORK, title: 'copy md', codeagentAccount: 'personal' } });
    const session = await wait(async () => (await invoke('get-sessions')).find(s => s.id === created.id && s.ccSessionId), 'native identity');
    const native = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.hubSession === session.id && r.configDir);
    writeHistory(path.join(native.configDir, 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'), session.ccSessionId + '.jsonl'), session.ccSessionId);
    const sid = JSON.stringify(session.id);
    await c.eval(`selectSession(${sid})`);
    await wait(() => c.eval(`activeSessionId===${sid}&&currentView==='card'`), 'selected');
    await c.eval(`window._loadSessionHistoryToOverlay(${sid},{forceScrollBottom:true})`);
    const BODY = `[...document.querySelectorAll('#msg-overlay > .turn-card:not(.user) .turn-body')].at(-1)`;
    await wait(() => c.eval(`!!${BODY}&&${BODY}.querySelectorAll('.katex').length>=2`), 'formulas rendered', 30000);
    await c.eval(`(()=>{localStorage.removeItem('hub-copy-markdown');const ipc=require('electron').ipcRenderer,orig=ipc.invoke.bind(ipc);window.__clip=[];ipc.invoke=(n,...a)=>{if(n==='clipboard:write-text'){window.__clip.push(a[0]);return Promise.resolve({ok:true,attempts:1})}return orig(n,...a)};return 1})()`);

    // 1) 默认没打开：卡片复制按钮仍是看到的纯文本（老用户行为不变）。
    const plainExpected = await c.eval(`require('../renderer/visible-card-text').extractVisibleCardText(${BODY})`);
    const copyText = await c.eval(`require('../renderer/visible-card-text').copyableCardText(${BODY})`);
    ok('默认复制仍是纯文本', copyText === plainExpected && !copyText.includes('## ') && !copyText.includes('$'), JSON.stringify(copyText.slice(0, 60)));

    // 2) 选中「公式那一段 + 列表」，右键 → 菜单里有「复制为 Markdown」，点它。
    await c.eval(`(()=>{const b=${BODY};const p=[...b.querySelectorAll('p')].find(x=>x.querySelector('.katex'));const ul=b.querySelector('ul');const r=document.createRange();r.setStart(p.firstChild,0);r.setEndAfter(ul.lastElementChild);const s=getSelection();s.removeAllRanges();s.addRange(r);return 1})()`);
    const at = await c.eval(`(()=>{const r=${BODY}.querySelector('p').getBoundingClientRect();return {x:r.left+20,y:r.top+r.height/2}})()`);
    await mouse(at, 'right');
    await wait(() => c.eval(`document.getElementById('card-selection-context-menu').style.display==='block'`), 'context menu');
    await shot('20261118-r38d-copy-md-menu');
    const menu = await c.eval(`[...document.querySelectorAll('#card-selection-context-menu .context-menu-item')].filter(b=>!b.hidden).map(b=>b.textContent.trim())`);
    ok('右键菜单有「复制为 Markdown」和 Ctrl+C 开关', menu.includes('复制为 Markdown') && menu.some(t => /Ctrl\+C 和复制按钮都给 Markdown/.test(t)), JSON.stringify(menu));
    await mouse(await center('#card-selection-context-menu [data-action="copy-md"]'));
    const part = await wait(() => c.eval(`window.__clip.at(-1)`), 'md copied');
    fs.writeFileSync(path.join(OUT, '20261118-r38d-copy-md-part.md'), part);
    ok('选中部分得到 Markdown：行内公式 $…$、粗体、列表、链接', /直角三角形满足 \$a\^2\+b\^2=c\^2\$，其中 \*\*c\*\* 是斜边。/.test(part)
      && /\$\$\nE = mc\^2\n\$\$/.test(part) && /- 第一条：看 `x` 的值\n- 第二条：\[文档\]\(https:\/\/example\.com\/doc\)/.test(part), JSON.stringify(part));

    // 3) 菜单里打开开关，之后 Ctrl+C 部分选中也是 Markdown。
    await c.eval(`(()=>{const b=${BODY};const ol=b.querySelector('ol');const r=document.createRange();r.selectNodeContents(ol);const s=getSelection();s.removeAllRanges();s.addRange(r);return 1})()`);
    await mouse(await c.eval(`(()=>{${BODY}.querySelector('ol').scrollIntoView({block:'center'});const t=${BODY}.querySelector('ol li').firstChild;const rg=document.createRange();rg.setStart(t,0);rg.setEnd(t,1);const r=rg.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`), 'right');
    await wait(() => c.eval(`document.getElementById('card-selection-context-menu').style.display==='block'`), 'context menu 2');
    await mouse(await center('#card-selection-context-menu [data-action="toggle-md"]'));
    ok('开关已打开并记住', await c.eval(`localStorage.getItem('hub-copy-markdown')==='1'`));
    await c.eval(`(()=>{const b=${BODY};const ol=b.querySelector('ol');const r=document.createRange();r.selectNodeContents(ol);const s=getSelection();s.removeAllRanges();s.addRange(r);${BODY}.closest('.turn-card').focus?.();return 1})()`);
    const before = await c.eval('window.__clip.length');
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    const viaKey = await wait(() => c.eval(`window.__clip.length>${before}&&window.__clip.at(-1)`), 'ctrl+c copied');
    ok('Ctrl+C 选中有序列表得到 1. 2. 编号', /^1\. 先算\n2\. 再比$/.test(viaKey), JSON.stringify(viaKey));

    // 4) 卡片整段复制：标题、公式、表格、代码块都是 Markdown。
    const whole = await c.eval(`require('../renderer/visible-card-text').copyableCardText(${BODY})`);
    fs.writeFileSync(path.join(OUT, '20261118-r38d-copy-md-whole.md'), whole);
    ok('整卡复制为 Markdown', /^## 勾股定理/.test(whole) && whole.includes('$a^2+b^2=c^2$') && /\| 名称 \| 数值 \|\n\| --- \| --- \|\n\| SINR \| 12 dB \|/.test(whole) && whole.includes('```python\n' + CODE_BODY + '\n```'), JSON.stringify(whole));

    // 5) 审查返工：在一个元素内部拖选（整段粗体里的字），Ctrl+C 仍带格式。
    await c.eval(`(()=>{const t=${BODY}.querySelector('p strong').firstChild;const r=document.createRange();r.setStart(t,0);r.setEnd(t,t.length);const s=getSelection();s.removeAllRanges();s.addRange(r);return 1})()`);
    const b0 = await c.eval('window.__clip.length');
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    const inStrong = await wait(() => c.eval(`window.__clip.length>${b0}&&window.__clip.at(-1)`), 'ctrl+c in strong');
    ok('元素内部选中粗体：Ctrl+C 得到 **c**', inStrong === '**c**', JSON.stringify(inStrong));

    // 6) 审查返工：用合成片段逐项核对序列化（真实渲染进程里的同一模块，不碰剪贴板）。
    const cases = await c.eval(`(()=>{const md=require('../renderer/markdown-copy');const box=document.createElement('div');document.body.append(box);const out={};
      const sel=(sn,so,en,eo)=>{const r=document.createRange();r.setStart(sn,so);r.setEnd(en,eo);const s=getSelection();s.removeAllRanges();s.addRange(r);return md.selectionToMarkdown(window)};
      box.innerHTML='<pre><code class="language-python"></code></pre>';box.querySelector('code').textContent=${JSON.stringify(CODE_BODY + '\n')};out.code=md.elementToMarkdown(box);
      box.innerHTML='<ul><li>步骤<pre><code></code></pre></li></ul><blockquote><pre><code></code></pre></blockquote>';box.querySelectorAll('code').forEach(c=>c.textContent=${JSON.stringify('a\n\n\n  b  \n')});out.nested=md.elementToMarkdown(box);
      box.innerHTML='<p>前文 <strong>important words</strong> 后文</p>';let t=box.querySelector('strong').firstChild;out.strongAll=sel(t,0,t,t.length);out.strongPart=sel(t,2,t,9);
      box.innerHTML='<h2>标题<em>斜体</em>文字</h2>';out.heading=sel(box.querySelector('h2').firstChild,0,box.querySelector('h2').lastChild,2);
      box.innerHTML='<p>看 <a href="https://example.com/doc">文档链接</a></p>';t=box.querySelector('a').firstChild;out.link=sel(t,0,t,2);
      box.innerHTML='<p><strong>粗<em>粗斜体</em></strong></p>';t=box.querySelector('em').firstChild;out.nestedFmt=sel(t,0,t,2);
      box.innerHTML='<p>普通 <strong>加粗</strong> 尾巴</p>';out.cross=sel(box.querySelector('p').firstChild,1,box.querySelector('p').lastChild,2);
      box.innerHTML='<p><strong><span>important words</span></strong></p>';t=box.querySelector('span').firstChild;out.spanStrongAll=sel(t,0,t,t.length);out.spanStrongPart=sel(t,2,t,9);
      box.innerHTML='<p><a href="https://example.com/doc"><span>important words</span></a></p>';t=box.querySelector('span').firstChild;out.spanLinkAll=sel(t,0,t,t.length);out.spanLinkPart=sel(t,0,t,9);
      box.innerHTML='<p><a href="https://example.com/doc"><span class="x"><strong><mark><span>深层文字</span></mark></strong></span></a></p>';t=box.querySelector('mark span').firstChild;out.deepAll=sel(t,0,t,t.length);out.deepPart=sel(t,0,t,2);
      box.innerHTML='<p>前 <span>普通包装</span> 后</p>';t=box.querySelector('span').firstChild;out.plainSpan=sel(t,0,t,2);
      getSelection().removeAllRanges();box.remove();return out})()`);
    fs.writeFileSync(path.join(OUT, '20261118-r38d-copy-md-rework-cases.json'), JSON.stringify(cases, null, 2));
    ok('代码块逐字保留（三个换行、行尾空格、缩进空行）', cases.code === '```python\n' + CODE_BODY + '\n```', JSON.stringify(cases.code));
    ok('列表、引用里的代码块：去掉续行前缀后正文不变', cases.nested.includes('  ```\n  a\n\n\n    b  \n  ```') && cases.nested.includes('> ```\n> a\n>\n>\n>   b  \n> ```'), JSON.stringify(cases.nested));
    ok('粗体内部整段/部分选中保留 **', cases.strongAll === '**important words**' && cases.strongPart === '**portant**', JSON.stringify([cases.strongAll, cases.strongPart]));
    ok('标题内部选中保留 ##、链接文字内选中保留链接、嵌套格式全保留', cases.heading === '## 标题*斜体*文字' && cases.link === '[文档](https://example.com/doc)' && cases.nestedFmt === '***粗斜***', JSON.stringify([cases.heading, cases.link, cases.nestedFmt]));
    ok('二次返工：粗体、链接里隔着 span 时，整段/部分选中仍保留格式', cases.spanStrongAll === '**important words**' && cases.spanStrongPart === '**portant**' && cases.spanLinkAll === '[important words](https://example.com/doc)' && cases.spanLinkPart === '[important](https://example.com/doc)', JSON.stringify([cases.spanStrongAll, cases.spanStrongPart, cases.spanLinkAll, cases.spanLinkPart]));
    ok('二次返工：链接 > span > 粗体 > mark > span 多层包装，整段/部分都补回链接和粗体；普通 span 不凭空加格式', cases.deepAll === '[**深层文字**](https://example.com/doc)' && cases.deepPart === '[**深层**](https://example.com/doc)' && cases.plainSpan === '普通', JSON.stringify([cases.deepAll, cases.deepPart, cases.plainSpan]));
    ok('跨元素部分选中仍带粗体', cases.cross === '通 **加粗** 尾', JSON.stringify(cases.cross));
    await c.eval(`getSelection().removeAllRanges()`);
    await shot('20261118-r38d-copy-md-card');
    console.log('ARTIFACTS ' + OUT);
  } finally {
    try { await gracefulQuit(hub, { timeoutMs: 30000 }); } catch (error) { console.error('quit: ' + error.message); }
    try { fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
