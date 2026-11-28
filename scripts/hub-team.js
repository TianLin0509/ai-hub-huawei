'use strict';
// 负责人组队的命令行入口（2026-11-01）。在 Hub 会话里运行：身份、端口、令牌都从会话环境变量读，
// 不需要额外配置。用法：
//   hub-team status
//   hub-team accounts
//   accounts 返回号池 rows、其他后端 backends 与混编配方 recommendedMix；CodeAgent 成员用 account 指定账号，其他后端写 kind、不写 account。
//   kind 可选 codeagent / claude / codex / deepseek-acp（DSH，也可写 dsh）。
//   省略 model 时沿用账号模型；不支持修改推理档位和速度。
//   hub-team propose --plan-file 计划.json        计划：{"goal":"…","members":[{"role":"…","task":"…","kind":"codeagent|claude|codex|deepseek-acp","account":"…","model":"…","cwd":"…","title":"…"}]}
//   hub-team send --to lead|m1 --message "…" [--wake|--no-wake] [--interrupt] [--deliver]
//   hub-team send --to m1 --message-file 消息.md
//   hub-team read --id 12（短号数字或 msg-xxx 长编号）读取完整原文；仅本队负责人和消息参与者可读
//   hub-team allow --a m1 --b m2 [--off] [--reason "…"]
//   hub-team restart --member m1
//   hub-team dismiss --member m1
const fs = require('node:fs');
const http = require('node:http');

function parse(argv) {
  const out = { _: [] };
  const flags = new Set(['wake', 'no-wake', 'interrupt', 'deliver', 'off']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (flags.has(key)) out[key] = true;
    else if (next === undefined) throw Error(`参数 --${key} 缺少值；多行正文请用 --message-file，计划用 --plan-file`);
    else { out[key] = next; i++; }
  }
  return out;
}
const readUtf8 = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

function buildRequest(argv) {
  const opt = parse(argv), action = opt._[0];
  switch (action) {
    case 'status': case 'accounts': return { action, args: {} };
    case 'propose': {
      if (!opt['plan-file']) throw Error('用法：propose --plan-file 计划.json');
      return { action, args: JSON.parse(readUtf8(opt['plan-file'])) };
    }
    case 'send': {
      const message = opt['message-file'] ? readUtf8(opt['message-file']) : opt.message;
      if (!opt.to || typeof message !== 'string') throw Error('用法：send --to lead|m1 --message "…"（或 --message-file 文件）[--wake|--no-wake] [--interrupt] [--deliver]');
      return { action, args: { to: String(opt.to), message, ...(opt.wake ? { wake: true } : opt['no-wake'] ? { wake: false } : {}), interrupt: !!opt.interrupt, ...(opt.deliver ? { deliver: true } : {}) } };
    }
    case 'read': {
      if (typeof opt.id !== 'string' || !opt.id.trim()) throw Error('用法：read --id <消息编号>');
      return { action, args: { messageId: opt.id } };
    }
    case 'allow': return { action, args: { memberA: String(opt.a || ''), memberB: String(opt.b || ''), allow: !opt.off, reason: opt.reason ? String(opt.reason) : '' } };
    case 'restart': case 'dismiss': return { action, args: { memberId: String(opt.member || '') } };
    default: throw Error('动作：status / accounts / propose / send / read / allow / restart / dismiss');
  }
}

function post(body, env = process.env) {
  // DSH 成员的终端会去掉名字带 TOKEN 的变量，Hub 另给了别名 CLAUDE_HUB_HOOK_AUTH / CLAUDE_HUB_TEAM_AUTH（core/acp-profiles.js）。
  const token = env.CLAUDE_HUB_TOKEN || env.CLAUDE_HUB_HOOK_AUTH, teamToken = env.CLAUDE_HUB_TEAM_TOKEN || env.CLAUDE_HUB_TEAM_AUTH;
  const port = Number(env.CLAUDE_HUB_PORT), sessionId = env.CLAUDE_HUB_SESSION_ID;
  const missing = [['CLAUDE_HUB_PORT', env.CLAUDE_HUB_PORT], ['CLAUDE_HUB_TOKEN', token], ['CLAUDE_HUB_SESSION_ID', sessionId], ['CLAUDE_HUB_TEAM_TOKEN', teamToken]]
    .filter(([, value]) => !value).map(([key]) => key);
  if (missing.length || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(Error(
    `组队身份不可用：${missing.length ? '缺少 ' + missing.join(' / ') : 'CLAUDE_HUB_PORT 不是有效端口'}。` +
    '请在 Hub 左侧栏新建或重新打开 CodeAgent PTY 会话后运行 status；Hub 招来的成员（CodeAgent、Claude Code、Codex、DSH）启动时自动带身份，CodeAgent-Lite（serve）与外部终端目前未接通此组队入口。' +
    '若旧会话只缺 CLAUDE_HUB_TEAM_TOKEN，请重开该会话以注入身份。不要复制、打印或手工补写其他会话的令牌，无需重启整个 Hub。'));
  const data = Buffer.from(JSON.stringify({ ...body, token, sessionId, teamToken }), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/team', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(deadline);
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        if (res.statusCode === 200) resolve(parsed.result);
        else reject(Error(parsed.error || `Hub 返回 ${res.statusCode}`));
      });
    });
    const deadline = setTimeout(() => {
      const error = Error('Hub 没在 30 秒内回应，结果未知：先用 status 核对，别直接重发');
      reject(error);
      req.destroy(error);
    }, 30000);
    req.on('error', error => { clearTimeout(deadline); reject(Error('连不上 Hub：' + error.message)); });
    req.end(data);
  });
}

async function main(argv) {
  const result = await post(buildRequest(argv));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { buildRequest, post, parse };
