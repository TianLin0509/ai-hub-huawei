#!/usr/bin/env node
'use strict';
// Hermes 真实运行验收（2026-11-28）：走 Hub 自己的启动参数（core/hermes-cli-profile.js）和卡片会话（core/acp-session.js），
// 起真实的 Hermes ACP 服务，跑「要求调终端工具 → 关掉进程 → 恢复同一会话追问」，结果写成一份小摘要 JSON。
//
//   node tests/e2e-hermes-acp-real.js --python <Hermes 组件里的 python.exe> --out <摘要.json>                 本机模拟模型
//   node tests/e2e-hermes-acp-real.js --python <python.exe> --hub-config <Hub 数据目录> --out <摘要.json>   用这台电脑 Hub 的真实线路（公司模型等）
//   自有接口（如公司 API 网关）：--own-base <地址/v1> --own-key-file <钥匙文件> --own-model <模型>（钥匙只在本机读，不进摘要）
//   可选：--model <线路名/模型>  --permission bypassPermissions|acceptEdits|default  --work <工作目录>
// 不改 Hub 的数据：会话目录、历史都放进临时目录；读 Hub 配置只为拿线路（钥匙不写进摘要）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const out = arg('out');
const python = arg('python');
const hubDir = arg('hub-config');
const t0 = Date.now();
const log = [];
const note = (...a) => { const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.join(' '); log.push(line); console.log(line); };

// 本机模拟模型：要求运行 echo 就发 terminal 工具调用，拿到工具结果后复述；问上一条命令就答出来。
function startMock() {
  const text = m => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : '';
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => raw += d); req.on('end', () => {
      if (/\/models/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] })); }
      // 钥匙不对就回 401（和公司反代一样），钥匙没传到时测试会失败。
      if (req.headers.authorization !== 'Bearer mock-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'mock: bad key ' + String(req.headers.authorization).slice(0, 20) } })); }
      const body = JSON.parse(raw || '{}'); const msgs = body.messages || []; const last = msgs.at(-1) || {};
      let message;
      if (last.role === 'tool') message = { role: 'assistant', content: '命令输出是：' + text(last).slice(0, 200) };
      else if (/上一条/.test(text(last))) message = { role: 'assistant', content: (msgs.map(text).join('\n').match(/echo [\w-]+/) || ['不记得'])[0] };
      else { const m = text(last).match(/echo ([\w-]+)/); message = m ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'echo ' + m[1] }) } }] } : { role: 'assistant', content: '模拟回复' }; }
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model };
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: message.tool_calls ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: message.content }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cardsSummary(session) {
  const cards = session.readTranscript({});
  return cards.map(c => ({ role: c.role || c.type, text: String(c.text || c.content || '').slice(0, 300), tools: (c.tools || []).map(t => ({ title: String(t.title || t.input?.title || '').slice(0, 120), status: t.status })) }));
}

async function runTurn(session, text, timeoutMs) {
  const t = Date.now();
  const ack = await session.send(text, {});
  await session.idle(timeoutMs);
  const turns = [...session.history.values()];
  const turn = turns.at(-1) || {};
  const items = turn.items || [];
  const reply = items.filter(i => i.type === 'agentMessage').map(i => i.text || '').join('');
  const tools = items.filter(i => /tool|command/i.test(i.type)).map(i => ({ type: i.type, title: String(i.title || i.command || i.input?.title || '').slice(0, 160), status: i.status }));
  note('回合', turn.status, '用时', ((Date.now() - t) / 1000).toFixed(1) + 's', '工具', tools.length, '回复', JSON.stringify(reply.slice(0, 200)));
  return { status: turn.status, error: turn.error || null, reply, tools, ack: ack && { ok: ack.ok, sendStatus: ack.sendStatus }, seconds: (Date.now() - t) / 1000, itemTypes: items.map(i => i.type) };
}

(async () => {
  const summary = { ok: false, host: os.hostname(), node: process.version, steps: {} };
  const work = path.resolve(arg('work', fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-work-'))));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-e2e-data-'));
  let mock = null, session = null;
  try {
    if (!python) throw new Error('缺 --python');
    let config = {}, routeDataDir = data;
    if (hubDir) {
      // 用这台电脑 Hub 的真实设置（含公司版的公司模型接入）；--upstream gateway|codeagent 指定公司反代用哪个上游。
      process.env.CLAUDE_HUB_DATA_DIR = path.resolve(hubDir);
      config = { ...require('../core/hub-config').getConfig() };
      const upstream = arg('upstream');
      if (upstream) Object.assign(config, { companyCli: true, dshBackend: 'proxy', dshUpstream: upstream === 'gateway' ? 'gateway' : '' });
      routeDataDir = path.resolve(hubDir);
    }
    // 自有接口（OpenAI 兼容，如公司 API 网关）：--own-base <地址> --own-key-file <文件，内容为 Key 或 "Authorization: Bearer Key"> --own-model <模型>。
    if (arg('own-base')) {
      const key = fs.readFileSync(arg('own-key-file'), 'utf8').trim().replace(/^Authorization:\s*Bearer\s+/i, '');
      Object.assign(config, { companyCli: true, dshBackend: 'api', dshUpstream: '', dshApiBaseUrl: arg('own-base'), dshApiKey: key, dshApiModel: arg('own-model') });
    }
    if (!hubDir && !arg('own-base')) {
      mock = await startMock();
      config = { companyCli: true, dshBackend: 'api', dshApiBaseUrl: `http://127.0.0.1:${mock.address().port}/v1`, dshApiKey: 'mock-key', dshApiModel: 'mock-model' };
    }
    const env = { ...process.env, AI_HUB_HERMES_PYTHON: path.resolve(python) };
    const profile = require('../core/hermes-cli-profile');
    const routes = profile.availableRoutes(config, env, { dataDir: routeDataDir, sessionId: 'hermes-e2e' });
    summary.routes = routes.map(r => ({ id: r.id, gateway: !!r.gateway, models: r.models.slice(0, 8), defaultModel: r.defaultModel }));
    note('可用线路', JSON.stringify(summary.routes));
    const build = extra => {
      const o = profile.buildHermesOptions('hermes', { id: 'hermes-e2e-1', cwd: work, model: arg('model'), permissionMode: arg('permission', 'bypassPermissions'), ...extra }, config, routeDataDir, env);
      // 会话目录、历史放临时目录，不碰 Hub 自己的数据。
      return { ...o, storeDir: path.join(data, 'acp-history') };
    };
    let options = build({});
    summary.launch = { model: options.hubModel, hermesModel: options.model, profileId: options.profileId, sessionModeId: options.sessionModeId, permissionPolicy: options.permissionPolicy,
      python: options.launch.command, gitBash: options.launch.env.HERMES_GIT_BASH_PATH || null, home: options.home };
    note('启动', JSON.stringify(summary.launch));
    const { AcpSession } = require('../core/acp-session');
    session = new AcpSession(options);
    session.on('error', e => note('会话错误', e?.message || e));
    session.on('action-error', e => note('会话提示', e?.message || e));
    let t = Date.now();
    await session.start();
    summary.steps.start = { seconds: (Date.now() - t) / 1000, threadId: session.threadId, currentModel: session.currentModel, mode: session.modes?.currentModeId };
    note('已连接', JSON.stringify(summary.steps.start));
    const prompt1 = arg('prompt', '请用终端工具运行命令 `echo hermes-hub-ok`，然后用一句中文告诉我命令输出了什么。');
    summary.steps.turn1 = await runTurn(session, prompt1, Number(arg('timeout', '300000')));
    const sid = session.threadId;
    session.kill(); session = null;
    note('已关闭，恢复同一会话', sid);
    options = build({ acpSid: sid });
    session = new AcpSession(options);
    session.on('error', e => note('会话错误', e?.message || e));
    t = Date.now();
    await session.start();
    summary.steps.resume = { seconds: (Date.now() - t) / 1000, threadId: session.threadId, same: session.threadId === sid };
    summary.steps.turn2 = await runTurn(session, '我上一条让你运行的命令是什么？只回答命令本身。', Number(arg('timeout', '300000')));
    const t1 = summary.steps.turn1, t2 = summary.steps.turn2;
    summary.checks = {
      turn1Completed: t1.status === 'completed',
      toolCalled: t1.tools.length > 0,
      outputSeen: /hermes-hub-ok/.test(t1.reply + JSON.stringify(t1.tools)),
      resumedSameSession: summary.steps.resume.same,
      turn2Completed: t2.status === 'completed',
      rememberedCommand: /echo\s+hermes-hub-ok/.test(t2.reply),
    };
    summary.ok = Object.values(summary.checks).every(Boolean);
  } catch (error) {
    summary.error = String(error && error.stack || error).slice(0, 2000); note('失败', error.message);
  } finally {
    try { session?.kill(); } catch (_) {}
    mock?.close();
    summary.totalSeconds = (Date.now() - t0) / 1000;
    summary.log = log;
    if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 1));
    console.log('RESULT ' + (summary.ok ? 'PASS' : 'FAIL'));
    setTimeout(() => process.exit(summary.ok ? 0 : 1), 500);
  }
})();
