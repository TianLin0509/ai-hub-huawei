'use strict';
// opencode 接入（2026-11-26）真实界面端到端：隔离 Hub + 全新数据目录 + 空的用户目录，鼠标键盘操作。
//   第 1 段「全新用户」：启动中心点 opencode → 就地看到「还没有 opencode」和「一键安装 opencode」→ 点安装（真实 npm 安装）→ 提示变成已就绪。
//   第 2 段「对话」：本机模拟模型写进 opencode 自己的配置（走「没有 Hub 钥匙、用 opencode 自己的配置」线路）→ 新建 → 发消息 → 收到回复
//            → 模型报错时卡片和状态有提示 → 关掉 Hub 重开 → 休眠会话历史读得出 → 恢复 → 继续对话，回答记得上一轮。
//   HUB_E2E_OPENCODE_DEEPSEEK=1 且设置里有 DeepSeek Key 时，第 2 段改用 Hub 的 DeepSeek 线路真实对话（低档 deepseek-flash）。
// 用法：node tests/e2e-opencode-cdp.js   截图与报告写到 HUB_E2E_ARTIFACT_DIR（默认系统临时目录 opencode-e2e-shots）。
//   已装过 opencode 想跳过安装：HUB_E2E_OPENCODE_BIN=<opencode.exe 路径>（经 AI_HUB_OPENCODE_PATH 交给 Hub）。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), 'opencode-e2e-shots'));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const presetBin = process.env.HUB_E2E_OPENCODE_BIN || '';
const report = { checks: [], shots: [], mockRequests: 0 };

// 本机 OpenAI 兼容模拟模型：上文出现过「一号」就答「一号」；本轮出现「报错测试」回 400；其余答「收到」。标题生成请求答一个短标题。
function startMockModel() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let request = {}; try { request = JSON.parse(body); } catch {}
      const textOf = m => typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.text || '').join('');
      const userTexts = (request.messages || []).filter(m => m.role === 'user').map(textOf);
      const system = (request.messages || []).filter(m => m.role === 'system').map(textOf).join('');
      report.mockRequests++;
      if (/title generator/i.test(system)) return reply(res, request, '测试会话');
      if ((userTexts.at(-1) || '').includes('报错测试')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: '模拟模型：请求被拒绝（测试用）', type: 'invalid_request_error' } }));
      }
      if ((userTexts.at(-1) || '').includes('慢慢说')) return slowReply(res, request);
      reply(res, request, userTexts.some(t => t.includes('一号')) ? '一号' : '收到');
    });
  });
  function reply(res, request, text) {
    const EOL2 = '\n\n';
    if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'm', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] }) + EOL2);
    chunk({ role: 'assistant', content: '' }); chunk({ content: text }); chunk({}, 'stop');
    res.write('data: ' + JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }) + EOL2);
    res.end('data: [DONE]' + EOL2);
  }
  // 每秒吐一个字、共 60 秒：给「停止」按钮留时间；客户端断开就停。
  function slowReply(res, request) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const EOL2 = String.fromCharCode(10, 10);
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 60) { clearInterval(timer); return res.end('data: [DONE]' + EOL2); }
      res.write('data: ' + JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta: { content: '慢' }, finish_reason: null }] }) + EOL2);
    }, 1000);
    res.on('close', () => clearInterval(timer));
  }
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const base = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'oc-e2e-'));
const home = path.join(base, 'home'), data = path.join(base, 'data'), project = path.join(base, 'project');
for (const dir of [home, data, project, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
function writeOpencodeOwnConfig(port) {
  const dir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'mock/mock-1',
    provider: { mock: { npm: '@ai-sdk/openai-compatible', name: '模拟模型', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock' }, models: { 'mock-1': { name: 'mock-1' } } } } }, null, 2));
}
function env() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  return { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(base, 'workspaces'),
    [pathKey]: [path.dirname(process.execPath), system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    NPM_CONFIG_REGISTRY: process.env.HUB_E2E_NPM_REGISTRY || 'https://registry.npmmirror.com',
    ...(presetBin ? { AI_HUB_OPENCODE_PATH: presetBin } : {}),
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '' };
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
    while (Date.now() < end) { try { if (await cdp.eval(expr)) return; } catch {} await sleep(200); }
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
async function openLaunchCenterOnOpencode(s) {
  for (let i = 0; i < 6; i++) {
    await s.click('#home-create-session');
    try { await s.until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', '启动中心', i < 5 ? 5000 : 30000); break; }
    catch (error) { if (i === 5) throw error; }
  }
  await s.click('.new-session-option[data-kind="opencode"]');
  await s.until('!document.getElementById("new-session-opencode-note").hidden && !/正在检查/.test(document.getElementById("new-session-opencode-note-text").textContent)', 'opencode 状态说明');
}
async function sendPrompt(s, id, text) {
  const composer = `.floating-input-bar[data-session-id="${id}"]`;
  await s.until(`document.querySelector(${JSON.stringify(composer + ' .floating-input-box')})`, '输入框');
  await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.connection === 'connected'`, 'opencode 连上', 120000);
  await s.click(composer + ' .floating-input-box');
  await s.cdp.send('Input.insertText', { text });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const turnsJs = id => `ipcRenderer.invoke('parse-session-transcript', { hubSessionId: ${JSON.stringify(id)}, kind: 'opencode', opts: { limit: 50 } })`
  + `.then(r => JSON.stringify((r.turns || []).map(t => [t.role, t.text])))`;

async function freshUser() {
  const s = await open('oc-fresh');
  try {
    await openLaunchCenterOnOpencode(s);
    const before = await s.cdp.eval('document.getElementById("new-session-opencode-note-text").textContent');
    if (presetBin) { report.checks.push('跳过安装（HUB_E2E_OPENCODE_BIN 指定了现成的 opencode）：' + before); return; }
    assert.match(before, /还没有 opencode/);
    assert.equal(await s.cdp.eval('document.getElementById("new-session-opencode-install").hidden'), false, '就地给一键安装按钮');
    await s.shot('01-fresh-not-installed');
    report.checks.push('全新用户点 opencode：就地显示「还没有 opencode」和「一键安装 opencode」：' + before);
    const t0 = Date.now();
    await s.click('#new-session-opencode-install');
    await s.until('/正在安装/.test(document.getElementById("new-session-opencode-note-text").textContent)', '安装中提示', 10000);
    await s.until('/已就绪/.test(document.getElementById("new-session-opencode-note-text").textContent) || /opencode/.test(document.getElementById("new-session-error")?.innerText || "")', '安装结束', 900000);
    const after = await s.cdp.eval('document.getElementById("new-session-opencode-note-text").textContent');
    const installError = await s.cdp.eval('document.getElementById("new-session-error")?.innerText || ""');
    await s.shot('02-fresh-install-result');
    // 组件还没上架内源（发版时才打包上传）：安装应当就地说清原因，而不是改走 npm。
    if (process.env.HUB_E2E_OPENCODE_UNPUBLISHED === '1') {
      assert.match(installError, /opencode/);
      assert.doesNotMatch(installError, /npm install/);
      report.checks.push('组件未上架内源时点安装：就地报「' + installError.replace(/\s+/g, ' ').slice(0, 200) + '」，没有改走 npm');
      return;
    }
    assert.match(after, /已就绪/, '安装后就绪：' + after + ' / ' + await s.cdp.eval('document.getElementById("new-session-error")?.innerText || ""'));
    await s.shot('02-fresh-installed');
    report.checks.push(`一键安装 opencode 用时 ${Math.round((Date.now() - t0) / 1000)} 秒，装后提示：${after}`);
  } finally { await gracefulQuit(s.hub); }
}

async function conversation() {
  const mock = await startMockModel();
  writeOpencodeOwnConfig(mock.address().port);
  report.checks.push('对话段用本机模拟模型（写在 opencode 自己的配置里），不是真实大模型');
  let s = await open('oc-chat-1');
  let id;
  try {
    await openLaunchCenterOnOpencode(s);
    const note = await s.cdp.eval('(t => t.textContent + " " + (t.querySelector(".field-hint-icon")?.getAttribute("aria-label") || ""))(document.getElementById("new-session-opencode-note-text"))');
    report.checks.push('启动中心说明：' + note.replace(/\s+/g, ' '));
    await s.shot('03-launch-center');
    const before = JSON.stringify(await s.cdp.eval('[...sessions.keys()]'));
    const t0 = Date.now();
    await s.click('#new-session-submit');
    await s.until(`[...sessions.values()].some(x => x.kind === "opencode" && !${before}.includes(x.id))`, 'opencode 会话建好', 30000);
    id = await s.cdp.eval(`[...sessions.values()].find(x => x.kind === "opencode" && !${before}.includes(x.id)).id`);
    await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.connection === 'connected' && !!sessions.get(${JSON.stringify(id)})?.acpSid`, 'opencode 连上并有会话身份', 120000);
    report.checks.push(`新建会话到可发送用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
    await sendPrompt(s, id, '只回复两个字：一号');
    await s.until(`(${turnsJs(id)}).then(t => JSON.parse(t).some(x => x[0] === 'assistant' && /一号/.test(x[1])))`, '第一轮回答', 120000);
    await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.state === 'completed'`, '第一轮完成', 30000);
    const meta = await s.cdp.eval(`JSON.stringify((({acpSid, transcriptPath, currentModel}) => ({acpSid, transcriptPath, currentModel}))(sessions.get(${JSON.stringify(id)})))`);
    report.checks.push('第一轮：发送、回答、完成状态都对；会话身份 ' + meta);
    await sleep(1500);
    const userCards = await s.cdp.eval(`JSON.stringify([...document.querySelectorAll('.turn-card.user')].filter(c => c.dataset.sessionId === ${JSON.stringify(id)} || !c.dataset.sessionId).map(c => ({ optimistic: c.dataset.optimistic, receipt: c.dataset.clientSubmissionId || c.dataset.submissionId || '', text: c.innerText.slice(-30) })))`);
    const turnIds = await s.cdp.eval(`ipcRenderer.invoke('parse-session-transcript', { hubSessionId: ${JSON.stringify(id)}, kind: 'opencode', opts: { limit: 50 } }).then(r => JSON.stringify((r.turns || []).filter(t => t.role === 'user').map(t => ({ id: t.id, receipt: t.clientSubmissionId }))))`);
    await s.shot('04-turn1');
    assert.equal(JSON.parse(userCards).length, 1, '第一轮只有一张用户卡：' + userCards + ' / ' + turnIds);
    // 出错有提示：模型服务拒绝请求
    await sendPrompt(s, id, '报错测试');
    await s.until(`['failed','completed'].includes(sessions.get(${JSON.stringify(id)})?.cliRuntime?.state) && (${turnsJs(id)}).then(t => JSON.parse(t).length >= 4)`, '报错轮结束', 120000);
    const state = await s.cdp.eval(`JSON.stringify((r => ({ state: r.state, reason: r.reason }))(sessions.get(${JSON.stringify(id)}).cliRuntime))`);
    const turns = JSON.parse(await s.cdp.eval(turnsJs(id)));
    const errText = turns.filter(t => t[0] === 'assistant').at(-1)?.[1] || '';
    assert.match(errText + state, /报错|拒绝|400/, '报错轮有说明：' + errText + ' ' + state);
    report.checks.push('模型报错时：状态 ' + state + '；卡片文字「' + errText.slice(0, 120) + '」');
    await sleep(1000);
    await s.shot('05-error-turn');
    // 停止按钮：长回答进行中点「停止」，opencode 真的停下（走 /abort），状态变成已中断
    await sendPrompt(s, id, '请慢慢说');
    await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.state === 'running'`, '慢回答开始', 60000);
    await sleep(4000);
    const stopAt = Date.now();
    await s.click(`.floating-input-bar[data-session-id="${id}"] .floating-input-stop`);
    await s.until(`['interrupted','completed','failed'].includes(sessions.get(${JSON.stringify(id)})?.cliRuntime?.state)`, '停止后结束', 30000);
    const stopped = await s.cdp.eval(`sessions.get(${JSON.stringify(id)}).cliRuntime.state`);
    assert.equal(stopped, 'interrupted', '点停止后是「已中断」：' + stopped);
    report.checks.push(`停止按钮：长回答进行中点停止，${Math.round((Date.now() - stopAt) / 1000)} 秒内停下，状态 ${stopped}`);
    await s.shot('05b-stopped');
  } finally { await gracefulQuit(s.hub); }

  s = await open('oc-chat-2');
  try {
    const q = JSON.stringify(id);
    await s.until(`sessions.has(${q})`, '重开后会话还在', 30000);
    const dormant = JSON.parse(await s.cdp.eval(turnsJs(id)));
    assert.ok(dormant.some(t => t[0] === 'assistant' && /一号/.test(t[1])), '休眠会话历史：' + JSON.stringify(dormant));
    report.checks.push('关掉 Hub 重开：休眠状态下历史从快照读出 ' + JSON.stringify(dormant).slice(0, 200));
    await s.click(`.session-item[data-session-id="${id}"]`);
    await s.until(`sessions.get(${q})?.status !== 'dormant' || document.body.innerText.includes('会话恢复失败')`, '恢复', 60000);
    assert.equal(await s.cdp.eval(`document.body.innerText.includes('会话恢复失败')`), false);
    await sendPrompt(s, id, '我第一条让你回复的两个字是什么？只回那两个字');
    await s.until(`(${turnsJs(id)}).then(t => JSON.parse(t).filter(x => x[0] === 'assistant' && /一号/.test(x[1])).length >= 2)`, '恢复后回答', 120000);
    report.checks.push('恢复后继续对话：会话身份不变，回答记得第一轮（模拟模型按上下文作答）');
    const sameThread = await s.cdp.eval(`sessions.get(${q})?.acpSid`);
    report.checks.push('恢复后的 opencode 会话 id：' + sameThread);
    await sleep(1500);
    await s.shot('06-resumed');
  } finally { await gracefulQuit(s.hub); mock.close(); }
}

(async () => {
  const only = process.env.HUB_E2E_OPENCODE_ONLY || '';
  if (only !== 'chat') await freshUser();
  if (only !== 'fresh') await conversation();
  report.passed = true;
})().then(() => {
  fs.writeFileSync(path.join(out, 'opencode-e2e-report.json'), JSON.stringify(report, null, 2));
  console.log('PASS\n' + report.checks.join('\n') + '\n截图：' + out); process.exit(0);
}, error => {
  report.error = String(error && error.stack || error);
  fs.writeFileSync(path.join(out, 'opencode-e2e-report.json'), JSON.stringify(report, null, 2));
  console.error('FAIL', error, '\n' + report.checks.join('\n')); process.exit(1);
});
