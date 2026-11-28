'use strict';
// Hermes 接入（2026-11-28）真实界面端到端：隔离 Hub + 全新数据目录 + 空的用户目录，鼠标键盘操作。
//   第 1 段「全新用户」：启动中心点 Hermes → 就地看到「还没有 Hermes」和「一键安装 Hermes」→ 点安装（从本机组件源下载真实组件包，签名、sha256 照常核对）→ 提示变成已就绪。
//   第 2 段「对话」：设置里的自有接口指向本机模拟模型 → 新建 → 发消息（要求调终端工具）→ 卡片里出现工具调用和回答
//            → 关掉 Hub 重开 → 休眠会话历史读得出 → 恢复 → 继续对话，回答记得上一轮。
// 用法：HUB_E2E_HERMES_COMPONENTS=<build-cli-components 的 --out 目录> node tests/e2e-hermes-cdp.js
//   截图与报告写到 HUB_E2E_ARTIFACT_DIR（默认系统临时目录 hermes-e2e-shots）。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), 'hermes-e2e-shots'));
const componentsOut = process.env.HUB_E2E_HERMES_COMPONENTS ? path.resolve(process.env.HUB_E2E_HERMES_COMPONENTS) : '';
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const report = { checks: [], shots: [], mockRequests: 0 };

// 本机模拟模型：要求运行 echo 就发 terminal 工具调用，拿到工具结果后复述；问上一条命令就答出来；其余答「收到」。
function startMockModel() {
  const text = m => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : '';
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      if (/\/models/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); }
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      // 钥匙不对就回 401（和公司反代一样），钥匙没传到时测试会失败。
      if (req.headers.authorization !== 'Bearer mock-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'mock: bad key' } })); }
      report.mockRequests++;
      const msgs = body.messages || []; const last = msgs.at(-1) || {};
      let message;
      if (last.role === 'tool') message = { role: 'assistant', content: '命令输出是：' + text(last).slice(0, 200) };
      else if (/上一条/.test(text(last))) message = { role: 'assistant', content: (msgs.map(text).join('\n').match(/echo [\w-]+/) || ['不记得'])[0] };
      else { const m = text(last).match(/echo ([\w-]+)/); message = m ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'echo ' + m[1] }) } }] } : { role: 'assistant', content: '收到' }; }
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      const EOL2 = '\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model };
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: message.tool_calls ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: message.content }, finish_reason: null }] }) + EOL2);
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + EOL2);
      res.end('data: [DONE]' + EOL2);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
// 本机组件源：把 build-cli-components 的输出目录原样当成 /hub-update/components/ 提供。
function startComponentServer() {
  const root = path.join(componentsOut, 'components');
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/hub-update\/components\//, '');
    const file = path.join(root, ...rel.split('/'));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const base = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'hm-e2e-'));
const home = path.join(base, 'home'), data = path.join(base, 'data'), project = path.join(base, 'project');
for (const dir of [home, data, project, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
let componentPort = 0;
function env() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  return { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(base, 'workspaces'),
    [pathKey]: [path.dirname(process.execPath), system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    // 组件从本机测试源下（替代内源）；更新源指到不存在的地址，免得测试去碰真实下载源。
    AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'none', name: '测试不更新', manifest: 'http://127.0.0.1:9/latest.json', files: 'http://127.0.0.1:9/v{version}/' }]),
    AI_HUB_CLI_COMPONENTS_SOURCES: JSON.stringify([{ id: 'local', name: '本机测试源', manifest: `http://127.0.0.1:${componentPort}/hub-update/components/components.json` }]),
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '' };
}
function writeHubConfig(port) {
  // 公司版「DSH 自有接口」：Hermes 和 opencode 一样复用这条线路（core/opencode-cli-profile.js availableRoutes）。
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { companyApi: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-key', model: 'mock-model' } } }, null, 2));
}

async function open(label) {
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: env() });
  const cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  const shot = async name => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from((image.result || image).data, 'base64'));
    report.shots.push(file);
  };
  const until = async (expr, what, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await cdp.eval(expr)) return; } catch {} await sleep(250); }
    try { await shot('timeout-' + label); } catch {}
    throw new Error(`等待超时（${label}）：` + what);
  };
  const click = async selector => {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  await until('!!window.WorkspaceController || !!document.querySelector("#home-create-session")', '主界面就绪', 90000);
  if (await cdp.eval('!!document.querySelector("#first-run-prep .fr-go")').catch(() => false)) await cdp.eval('document.querySelector("#first-run-prep .fr-go").click()');
  return { hub, cdp, until, click, shot };
}
async function openLaunchCenterOnHermes(s) {
  for (let i = 0; i < 6; i++) {
    await s.click('#home-create-session');
    try { await s.until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', '启动中心', i < 5 ? 5000 : 30000); break; }
    catch (error) { if (i === 5) throw error; }
  }
  await s.click('.new-session-option[data-kind="hermes"]');
  await s.until('!document.getElementById("new-session-hermes-note").hidden && !/正在检查/.test(document.getElementById("new-session-hermes-note-text").textContent)', 'Hermes 状态说明');
}
const connected = id => `sessions.get(${JSON.stringify(id)})?.nativeRuntime?.connection === 'connected'`;
async function sendPrompt(s, id, text) {
  const composer = `.floating-input-bar[data-session-id="${id}"]`;
  await s.until(`document.querySelector(${JSON.stringify(composer + ' .floating-input-box')})`, '输入框');
  await s.until(connected(id), 'Hermes 连上', 180000);
  await s.click(composer + ' .floating-input-box');
  await s.cdp.send('Input.insertText', { text });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const turnsJs = id => `ipcRenderer.invoke('parse-session-transcript', { hubSessionId: ${JSON.stringify(id)}, kind: 'hermes', opts: { limit: 50 } })`
  + `.then(r => JSON.stringify((r.turns || []).map(t => [t.role, t.text, (t.tools || []).length])))`;

async function freshUser() {
  const s = await open('hm-fresh');
  try {
    await openLaunchCenterOnHermes(s);
    const before = await s.cdp.eval('document.getElementById("new-session-hermes-note-text").textContent');
    assert.match(before, /还没有 Hermes/);
    assert.equal(await s.cdp.eval('document.getElementById("new-session-hermes-install").hidden'), false, '就地给一键安装按钮');
    await s.shot('01-fresh-not-installed');
    report.checks.push('全新用户点 Hermes：就地显示「还没有 Hermes」和「一键安装 Hermes」：' + before);
    const t0 = Date.now();
    await s.click('#new-session-hermes-install');
    await s.until('/正在安装/.test(document.getElementById("new-session-hermes-note-text").textContent)', '安装中提示', 10000);
    await s.until('/已就绪/.test(document.getElementById("new-session-hermes-note-text").textContent) || /Hermes/.test(document.getElementById("new-session-error")?.innerText || "")', '安装结束', 900000);
    const after = await s.cdp.eval('document.getElementById("new-session-hermes-note-text").textContent');
    await s.shot('02-fresh-installed');
    assert.match(after, /已就绪/, '安装后就绪：' + after + ' / ' + await s.cdp.eval('document.getElementById("new-session-error")?.innerText || ""'));
    report.checks.push(`一键安装 Hermes 用时 ${Math.round((Date.now() - t0) / 1000)} 秒（本机组件源，含签名和 sha256 核对），装后提示：${after}`);
  } finally { await gracefulQuit(s.hub); }
}

async function conversation() {
  const mock = await startMockModel();
  writeHubConfig(mock.address().port);
  report.checks.push('对话段用本机模拟模型（设置里的自有接口指向它），不是真实大模型');
  let s = await open('hm-chat-1');
  let id;
  try {
    await openLaunchCenterOnHermes(s);
    const note = await s.cdp.eval('(t => t.textContent + " " + (t.querySelector(".field-hint-icon")?.getAttribute("aria-label") || ""))(document.getElementById("new-session-hermes-note-text"))');
    report.checks.push('启动中心说明：' + note.replace(/\s+/g, ' '));
    await s.shot('03-launch-center');
    const before = JSON.stringify(await s.cdp.eval('[...sessions.keys()]'));
    const t0 = Date.now();
    await s.click('#new-session-submit');
    await s.until(`[...sessions.values()].some(x => x.kind === "hermes" && !${before}.includes(x.id))`, 'Hermes 会话建好', 30000);
    id = await s.cdp.eval(`[...sessions.values()].find(x => x.kind === "hermes" && !${before}.includes(x.id)).id`);
    await s.until(`${connected(id)} && !!sessions.get(${JSON.stringify(id)})?.acpSid`, 'Hermes 连上并有会话身份', 180000);
    report.checks.push(`新建会话到可发送用时 ${Math.round((Date.now() - t0) / 1000)} 秒（首次启动要编译 Python 字节码）`);
    await sendPrompt(s, id, '请用终端工具运行命令 `echo hermes-ui-ok`，然后告诉我输出。');
    await s.until(`(${turnsJs(id)}).then(t => JSON.parse(t).some(x => x[0] === 'assistant' && /hermes-ui-ok/.test(x[1])))`, '第一轮回答', 180000);
    await sleep(1500);
    const turns1 = JSON.parse(await s.cdp.eval(turnsJs(id)));
    const meta = await s.cdp.eval(`JSON.stringify((({acpSid, runtimeBackend, currentModel, nativeRuntime}) => ({acpSid, runtimeBackend, currentModel, state: nativeRuntime?.state}))(sessions.get(${JSON.stringify(id)})))`);
    const cardText = await s.cdp.eval(`(document.querySelector('.card-view-pane[data-session-id="${id}"], .card-view') || document.body).innerText.slice(-600)`);
    await s.shot('04-turn1');
    assert.ok(/hermes-ui-ok/.test(cardText), '卡片界面显示回答：' + cardText.slice(-200));
    report.checks.push('第一轮：调终端工具并回答，卡片里看得到；会话信息 ' + meta + '；记录 ' + JSON.stringify(turns1).slice(0, 300));
  } finally { await gracefulQuit(s.hub); }

  s = await open('hm-chat-2');
  try {
    const q = JSON.stringify(id);
    await s.until(`sessions.has(${q})`, '重开后会话还在', 30000);
    const dormant = JSON.parse(await s.cdp.eval(turnsJs(id)));
    assert.ok(dormant.some(t => t[0] === 'assistant' && /hermes-ui-ok/.test(t[1])), '休眠会话历史：' + JSON.stringify(dormant));
    report.checks.push('关掉 Hub 重开：休眠状态下历史读得出 ' + JSON.stringify(dormant).slice(0, 200));
    await s.click(`.session-item[data-session-id="${id}"]`);
    await s.until(`sessions.get(${q})?.status !== 'dormant' || document.body.innerText.includes('会话恢复失败')`, '恢复', 90000);
    assert.equal(await s.cdp.eval(`document.body.innerText.includes('会话恢复失败')`), false);
    await sendPrompt(s, id, '我上一条让你运行的命令是什么？只回答命令本身。');
    await s.until(`(${turnsJs(id)}).then(t => JSON.parse(t).some(x => x[0] === 'assistant' && /^\\s*echo hermes-ui-ok\\s*$/.test(x[1])))`, '恢复后回答', 180000);
    report.checks.push('恢复后继续对话：会话身份 ' + await s.cdp.eval(`sessions.get(${q})?.acpSid`) + '，回答记得上一轮的命令（模拟模型按上下文作答）');
    await sleep(1500);
    await s.shot('05-resumed');
  } finally { await gracefulQuit(s.hub); mock.close(); }
}

(async () => {
  if (!componentsOut) throw new Error('请用 HUB_E2E_HERMES_COMPONENTS 指向组件输出目录');
  const comp = await startComponentServer();
  componentPort = comp.address().port;
  try {
    const only = process.env.HUB_E2E_HERMES_ONLY || '';
    if (only !== 'chat') await freshUser();
    if (only !== 'fresh') await conversation();
  } finally { comp.close(); }
  report.passed = true;
})().then(() => {
  fs.writeFileSync(path.join(out, 'hermes-e2e-report.json'), JSON.stringify(report, null, 2));
  console.log('PASS\n' + report.checks.join('\n') + '\n截图：' + out); process.exit(0);
}, error => {
  report.error = String(error && error.stack || error);
  fs.writeFileSync(path.join(out, 'hermes-e2e-report.json'), JSON.stringify(report, null, 2));
  console.error('FAIL', error, '\n' + report.checks.join('\n')); process.exit(1);
});
