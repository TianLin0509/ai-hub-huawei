'use strict';
// pi 接入（r39）真实界面端到端：隔离 Hub + 全新数据目录 + 空的用户目录，鼠标键盘操作。
//   第 1 段「全新用户、什么都没配」：启动中心点 pi → 就地看到「没有找到 pi」和「一键安装 pi」→ 点安装（真实安装）
//            → 提示变成已就绪、没有 Hub 钥匙时说明用 pi 自己的登录 → 新建会话，pi 终端起得来、输入框连上。
//   第 2 段「真实对话」（需要环境变量 DEEPSEEK_API_KEY，低档模型 deepseek-flash）：新建 → 对话 → 关掉 Hub 重开
//            → 休眠会话的历史读得出 → 恢复 → 继续对话，回答记得上一轮。
// 用法：node tests/e2e-pi-cdp.js   截图与报告写到 HUB_E2E_ARTIFACT_DIR（默认系统临时目录 pi-e2e-shots）。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || path.join(os.tmpdir(), 'pi-e2e-shots'));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const deepseekKey = process.env.DEEPSEEK_API_KEY || '';
// HUB_E2E_PI_MOCK=1：不用真实钥匙，起一个本机 OpenAI 兼容的模拟模型，写进 pi 自己的配置（models.json / settings.json），
// 走「没有 Hub 钥匙、用 pi 自己的配置」这条线路；回答规则：上文出现过「一号」就答「一号」，否则答「收到」。
const useMock = process.env.HUB_E2E_PI_MOCK === '1';
function startMockModel() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let request = {}; try { request = JSON.parse(body); } catch {}
      const userTexts = (request.messages || []).filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.text || '').join(''));
      const reply = userTexts.some(t => t.includes('一号')) ? '一号' : '收到';
      report.mockRequests = (report.mockRequests || 0) + 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const EOL2 = String.fromCharCode(10, 10);
      const chunk = delta => res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-1',
        choices: [{ index: 0, delta, finish_reason: null }] }) + EOL2);
      chunk({ role: 'assistant', content: '' }); chunk({ content: reply });
      res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }) + EOL2);
      res.end('data: [DONE]' + EOL2);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function writePiOwnConfig(port) {
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions',
    apiKey: 'mock', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }, null, 2));
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1' }, null, 2));
}
const report = { checks: [], shots: [] };

const base = fs.mkdtempSync(path.join(process.env.HUB_E2E_TMP || os.tmpdir(), 'pi-e2e-'));
const home = path.join(base, 'home'), data = path.join(base, 'data'), project = path.join(base, 'project');
for (const dir of [home, data, project, out, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
// 隔离 Hub 不许经环境变量带 DeepSeek Key（launcher 的安全约束）：真实对话段按用户在设置里填 Key 的路径，写进隔离数据目录的 config.json。
function setDeepseekKey() {
  const file = path.join(data, 'config.json');
  let config = {}; try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config.providers = { ...(config.providers || {}), deepseek: { ...(config.providers?.deepseek || {}), api_key: deepseekKey } };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
function env() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  return { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_HUB_HOME_DIR: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', AI_HUB_WORKSPACE_ROOT: path.join(base, 'workspaces'),
    [pathKey]: [path.dirname(process.execPath), system, path.join(system, 'WindowsPowerShell', 'v1.0')].join(';'),
    // 用户自己的 npm 源配置（真实用户的 .npmrc 里一般有；隔离用户目录里没有，这里按环境变量给）。
    NPM_CONFIG_REGISTRY: process.env.HUB_E2E_NPM_REGISTRY || 'https://registry.npmmirror.com',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AI_HUB_TOKEN_PLAN_KEY: '' };
}

async function open(label, withKey) {
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: env(withKey) });
  const cdp = await connectFirstPage(hub, target => /renderer[\\/]index\.html/.test(target.url));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  const until = async (expr, what, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await cdp.eval(expr)) return; } catch {} await sleep(200); }
    try { const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `timeout-${label}.png`), Buffer.from((image.result || image).data, 'base64')); } catch {}
    throw new Error(`等待超时（${label}）：` + what);
  };
  const click = async selector => {
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const shot = async name => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, Buffer.from((image.result || image).data, 'base64'));
    report.shots.push(file);
  };
  await until('!!window.WorkspaceController || !!document.querySelector("#home-create-session")', '主界面就绪', 90000);
  // 首次启动准备页（如有）先进入主界面。
  if (await cdp.eval('!!document.querySelector("#first-run-prep .fr-go")').catch(() => false)) await cdp.eval('document.querySelector("#first-run-prep .fr-go").click()');
  return { hub, cdp, until, click, shot };
}
async function openLaunchCenterOnPi(s) {
  // 主界面刚画出来时按钮的点击处理可能还没接上：没打开就再点一次。
  for (let i = 0; i < 6; i++) {
    await s.click('#home-create-session');
    try { await s.until('document.querySelector("#new-session-submit")?.getBoundingClientRect().width > 0', '启动中心', i < 5 ? 5000 : 30000); break; }
    catch (error) { if (i === 5) throw error; }
  }
  await s.click('.new-session-option[data-kind="pi"]');
  await s.until('!document.getElementById("new-session-pi-note").hidden && !/正在检查/.test(document.getElementById("new-session-pi-note-text").textContent)', 'pi 状态说明');
}
async function sendPrompt(s, id, text) {
  const composer = `.floating-input-bar[data-session-id="${id}"]`;
  await s.until(`document.querySelector(${JSON.stringify(composer + ' .floating-input-box')})`, '输入框');
  await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.connection === 'connected'`, 'pi 终端连上', 90000);
  await s.click(composer + ' .floating-input-box');
  await s.cdp.send('Input.insertText', { text });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const turnsJs = id => `ipcRenderer.invoke('parse-session-transcript', { hubSessionId: ${JSON.stringify(id)}, kind: 'pi', opts: { limit: 50 } })`
  + `.then(r => JSON.stringify((r.turns || []).map(t => [t.role, t.text])))`;

async function freshUser() {
  const s = await open('pi-fresh', false);
  try {
    await openLaunchCenterOnPi(s);
    const before = await s.cdp.eval('document.getElementById("new-session-pi-note-text").textContent');
    assert.match(before, /还没有 pi/);
    assert.equal(await s.cdp.eval('document.getElementById("new-session-pi-install").hidden'), false, '就地给一键安装按钮');
    await s.shot('01-fresh-pi-not-installed');
    report.checks.push('全新用户点 pi：就地显示「没有找到 pi」和「一键安装 pi」按钮：' + before);
    const t0 = Date.now();
    await s.click('#new-session-pi-install');
    await s.until('/正在安装/.test(document.getElementById("new-session-pi-note-text").textContent)', '安装中提示', 10000);
    await s.shot('02-fresh-pi-installing');
    await s.until('/已就绪/.test(document.getElementById("new-session-pi-note-text").textContent) || !!document.getElementById("new-session-error")?.innerText.includes("pi")', '安装结束', 600000);
    const after = await s.cdp.eval('document.getElementById("new-session-pi-note-text").textContent');
    assert.match(after, /已就绪/, '安装后就绪：' + after + ' / ' + await s.cdp.eval('document.getElementById("new-session-error")?.innerText || ""'));
    assert.match(after, /自己的配置或登录/);
    await s.shot('03-fresh-pi-installed');
    report.checks.push(`一键安装 pi 用时 ${Math.round((Date.now() - t0) / 1000)} 秒，装后提示：${after}`);
    await s.click('#new-session-submit');
    await s.until('[...sessions.values()].some(x => x.kind === "pi")', 'pi 会话建好', 30000);
    const id = await s.cdp.eval('[...sessions.values()].find(x => x.kind === "pi").id');
    await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.connection === 'connected'`, 'pi 终端连上（无钥匙）', 90000);
    await sleep(1500);
    await s.shot('04-fresh-pi-session-no-key');
    report.checks.push('没有任何钥匙也能新建 pi 会话：终端起来、Hub 输入框连上（模型由 pi 自己的登录决定）');
  } finally { await gracefulQuit(s.hub); }
}

async function realConversation() {
  let mock = null;
  if (useMock) { mock = await startMockModel(); writePiOwnConfig(mock.address().port); report.checks.push('对话段用本机模拟模型（pi 自己的 models.json），不是真实大模型'); }
  else if (!deepseekKey) { report.checks.push('跳过真实对话：环境里没有 DEEPSEEK_API_KEY'); return; }
  else setDeepseekKey();
  let s = await open('pi-real-1', true);
  let id;
  try {
    await openLaunchCenterOnPi(s);
    // 线路说明在状态句末的 ⓘ 悬停卡里（2026-11-22 说明不喧宾夺主），连同短句一起读。
    const note = await s.cdp.eval('(t => t.textContent + " " + (t.querySelector(".field-hint-icon")?.getAttribute("aria-label") || ""))(document.getElementById("new-session-pi-note-text"))');
    assert.match(note, useMock ? /自己的配置或登录/ : /DeepSeek API/, '线路说明：' + note);
    const models = await s.cdp.eval('[...document.querySelectorAll("#new-session-model-cards [data-model-id], #new-session-model-cards button")].map(b => b.dataset.modelId || b.textContent.trim())');
    report.checks.push((useMock ? '模拟模型、无 Hub 钥匙时' : '有 DeepSeek Key 时') + '线路说明：' + note + '；模型选项：' + JSON.stringify(models));
    await s.shot('05-real-launch-center');
    const before = JSON.stringify(await s.cdp.eval('[...sessions.keys()]'));
    await s.click('#new-session-submit');
    await s.until(`[...sessions.values()].some(x => x.kind === "pi" && !${before}.includes(x.id))`, 'pi 会话建好', 30000);
    id = await s.cdp.eval(`[...sessions.values()].find(x => x.kind === "pi" && !${before}.includes(x.id)).id`);
    await sendPrompt(s, id, '只回复两个字：一号');
    await s.until(`(${turnsJs(id)}).then(t => JSON.parse(t).some(x => x[0] === 'assistant' && /一号/.test(x[1])))`, '第一轮回答', 120000);
    await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.state === 'completed'`, '第一轮完成', 30000);
    const meta = await s.cdp.eval(`JSON.stringify((({acpSid, transcriptPath, currentModel}) => ({acpSid, transcriptPath, currentModel}))(sessions.get(${JSON.stringify(id)})))`);
    report.checks.push('第一轮：发送、回答、完成状态都对；会话身份 ' + meta);
    // 发出的那条只显示一张用户卡：输入框的临时卡要被 pi 记下的那条认领（按发送回执对上）。
    await sleep(1500);
    const userCards = await s.cdp.eval(`JSON.stringify([...document.querySelectorAll('.turn-card.user')].filter(c => c.dataset.sessionId === ${JSON.stringify(id)} || !c.dataset.sessionId).map(c => ({ optimistic: c.dataset.optimistic, receipt: c.dataset.clientSubmissionId || c.dataset.submissionId || '', text: c.innerText.slice(-30) })))`);
    const turnIds = await s.cdp.eval(`ipcRenderer.invoke('parse-session-transcript', { hubSessionId: ${JSON.stringify(id)}, kind: 'pi', opts: { limit: 50 } }).then(r => JSON.stringify((r.turns || []).filter(t => t.role === 'user').map(t => ({ id: t.id, receipt: t.clientSubmissionId }))))`);
    report.userCardsTurn1 = { userCards: JSON.parse(userCards), turnIds: JSON.parse(turnIds) };
    assert.equal(JSON.parse(userCards).length, 1, '第一轮只有一张用户卡：' + userCards + ' / ' + turnIds);
    await sleep(800);
    await s.shot('06-real-turn1');
  } finally { await gracefulQuit(s.hub); }

  s = await open('pi-real-2', true);
  try {
    const q = JSON.stringify(id);
    await s.until(`sessions.has(${q})`, '重开后会话还在', 30000);
    const dormantTurns = JSON.parse(await s.cdp.eval(turnsJs(id)));
    assert.ok(dormantTurns.some(t => t[0] === 'assistant' && /一号/.test(t[1])), '休眠会话历史：' + JSON.stringify(dormantTurns));
    report.checks.push('关掉 Hub 重开：休眠状态下历史从 pi 会话文件读出 ' + JSON.stringify(dormantTurns));
    await s.click(`.session-item[data-session-id="${id}"]`);
    await s.until(`sessions.get(${q})?.status !== 'dormant' || document.body.innerText.includes('会话恢复失败')`, '恢复', 60000);
    assert.equal(await s.cdp.eval(`document.body.innerText.includes('会话恢复失败')`), false);
    await sendPrompt(s, id, '我上一条让你回复的两个字是什么？只回那两个字');
    await s.until(`(${turnsJs(id)}).then(t => JSON.parse(t).filter(x => x[0] === 'assistant' && /一号/.test(x[1])).length >= 2)`, '恢复后第二轮回答', 120000);
    const turns = JSON.parse(await s.cdp.eval(turnsJs(id)));
    report.checks.push('恢复后继续对话：回答记得上一轮 ' + JSON.stringify(turns));
    await sleep(1500);
    const cards = await s.cdp.eval(`[...document.querySelectorAll('.turn-card.user')].filter(c => c.dataset.sessionId === ${q} || !c.dataset.sessionId).length`);
    assert.equal(cards, 2, '恢复后两轮各一张用户卡');
    await sleep(800);
    await s.shot('07-real-resumed-turn2');
  } finally { await gracefulQuit(s.hub); mock?.close(); }
}

// 第 3 段（r39 返工 P1）：会话选的是 Token Plan 模型，之后套餐 Key 没了 → 点开会话不换线路，失败页就地给补 Key 输入框
// → 填好点「保存并继续」→ 会话按原来的 Token Plan 模型唤醒。用假 Key，不发对话，不花 token。
function editConfig(fn) {
  const file = path.join(data, 'config.json');
  let config = {}; try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  fn(config);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
async function missingPlanKey() {
  editConfig(c => { c.acp = { ...(c.acp || {}), apiKey: 'fake-plan-key-1' }; });
  let s = await open('pi-key-1', false);
  let id, model;
  try {
    await openLaunchCenterOnPi(s);
    // 线路说明在状态句末的 ⓘ 悬停卡里（2026-11-22 说明不喧宾夺主），连同短句一起读。
    const note = await s.cdp.eval('(t => t.textContent + " " + (t.querySelector(".field-hint-icon")?.getAttribute("aria-label") || ""))(document.getElementById("new-session-pi-note-text"))');
    assert.match(note, /Token Plan/, '只有套餐 Key 时线路是 Token Plan：' + note);
    const before = JSON.stringify(await s.cdp.eval('[...sessions.keys()]'));
    await s.click('#new-session-submit');
    await s.until(`[...sessions.values()].some(x => x.kind === "pi" && !${before}.includes(x.id))`, 'pi 会话建好', 30000);
    id = await s.cdp.eval(`[...sessions.values()].find(x => x.kind === "pi" && !${before}.includes(x.id)).id`);
    await s.until(`sessions.get(${JSON.stringify(id)})?.cliRuntime?.connection === 'connected' && !!sessions.get(${JSON.stringify(id)})?.acpSid`, 'pi 终端连上并有会话身份', 90000);
    model = await s.cdp.eval(`(s => (s.currentModel && s.currentModel.id) || s.model || '')(sessions.get(${JSON.stringify(id)}))`);
    assert.match(String(model), /^hub-tokenplan\//, '会话模型是套餐模型：' + model);
    report.checks.push('返工 P1：只有套餐 Key 时建 pi 会话，模型 ' + model);
  } finally { await gracefulQuit(s.hub); }

  editConfig(c => { if (c.acp) delete c.acp.apiKey; });
  s = await open('pi-key-2', false);
  try {
    const q = JSON.stringify(id);
    await s.until(`sessions.has(${q})`, '重开后会话还在', 30000);
    await s.click(`.session-item[data-session-id="${id}"]`);
    await s.until('!!document.querySelector(".pi-route-key-fix input")', '失败页就地出现补 Key 输入框', 60000);
    const text = await s.cdp.eval('document.querySelector(".session-resume-pending").innerText');
    assert.match(text, /Token Plan/);
    assert.match(text, /没有改用别的线路/);
    assert.equal(await s.cdp.eval(`sessions.get(${q})?.status`), 'dormant', '没有偷偷换成别的线路启动');
    await sleep(500);
    await s.shot('08-rework-missing-plan-key');
    report.checks.push('返工 P1：套餐 Key 没了，点开会话不换线路，失败页写明原因并就地给补 Key：' + text.replace(/\s+/g, ' ').slice(0, 200));
    await s.click('.pi-route-key-fix input');
    await s.cdp.send('Input.insertText', { text: 'fake-plan-key-2' });
    await s.click('.pi-route-key-fix-save');
    await s.until(`sessions.get(${q})?.status !== 'dormant' && sessions.get(${q})?.cliRuntime?.connection === 'connected'`, '保存后会话唤醒', 90000);
    const after = await s.cdp.eval(`(s => (s.currentModel && s.currentModel.id) || s.model || '')(sessions.get(${q}))`);
    assert.equal(after, model, '唤醒后仍是原来的套餐模型');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(saved.acp?.apiKey, 'fake-plan-key-2', 'Key 存到和设置页同一字段');
    await sleep(1500);
    await s.shot('09-rework-key-saved-resumed');
    report.checks.push('返工 P1：填 Key 点「保存并继续」，会话按原模型唤醒 ' + after + '，Key 存进设置 acp.apiKey');
  } finally {
    await gracefulQuit(s.hub);
    // 后面的对话段要求「没有 Hub 钥匙」，把假 Key 撤掉。
    editConfig(c => { if (c.acp) delete c.acp.apiKey; });
  }
}

(async () => {
  const only = process.env.HUB_E2E_PI_ONLY || '';
  if (only !== 'real' && only !== 'key') await freshUser();
  if (only !== 'real' && only !== 'fresh') await missingPlanKey();
  if (only !== 'fresh' && only !== 'key') await realConversation();
  report.passed = true;
})().then(() => {
  fs.writeFileSync(path.join(out, 'pi-e2e-report.json'), JSON.stringify(report, null, 2));
  console.log('PASS\n' + report.checks.join('\n') + '\n截图：' + out); process.exit(0);
}, error => {
  report.error = String(error && error.stack || error);
  fs.writeFileSync(path.join(out, 'pi-e2e-report.json'), JSON.stringify(report, null, 2));
  console.error('FAIL', error, '\n' + report.checks.join('\n')); process.exit(1);
});
