'use strict';
// 负责人组队的命令行入口（2026-11-01）。在 Hub 会话里运行：身份、端口、令牌都从会话环境变量读，
// 不需要额外配置。用法：
//   hub-team status
//   hub-team accounts
//   accounts 返回号池 rows；用 account 指定账号，model 可选且须在该账号的 models 清单里。
//   省略 model 时沿用账号模型；不支持修改推理档位和速度。
//   hub-team propose --plan-file 计划.json        计划：{"goal":"…","members":[{"role":"…","task":"…","kind":"codeagent","account":"…","model":"…","cwd":"…","title":"…"}]}
//   hub-team send --to lead|m1 --message "…" [--no-wake] [--interrupt]
//   hub-team send --to m1 --message-file 消息.md
//   hub-team allow --a m1 --b m2 [--off] [--reason "…"]
//   hub-team restart --member m1
//   hub-team dismiss --member m1
const fs = require('node:fs');
const http = require('node:http');

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2), next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
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
      if (!opt.to || typeof message !== 'string') throw Error('用法：send --to lead|m1 --message "…"（或 --message-file 文件）[--no-wake] [--interrupt]');
      return { action, args: { to: String(opt.to), message, wake: !opt['no-wake'], interrupt: !!opt.interrupt } };
    }
    case 'allow': return { action, args: { memberA: String(opt.a || ''), memberB: String(opt.b || ''), allow: !opt.off, reason: opt.reason ? String(opt.reason) : '' } };
    case 'restart': case 'dismiss': return { action, args: { memberId: String(opt.member || '') } };
    default: throw Error('动作：status / accounts / propose / send / allow / restart / dismiss');
  }
}

function post(body, env = process.env) {
  const port = Number(env.CLAUDE_HUB_PORT), token = env.CLAUDE_HUB_TOKEN, sessionId = env.CLAUDE_HUB_SESSION_ID;
  if (!port || !token || !sessionId) return Promise.reject(Error('没找到 Hub 会话环境变量（CLAUDE_HUB_PORT / CLAUDE_HUB_TOKEN / CLAUDE_HUB_SESSION_ID）；这个命令只能在 Hub 里的会话中运行'));
  const teamToken = env.CLAUDE_HUB_TEAM_TOKEN;
  if (!teamToken) return Promise.reject(Error('当前会话启动于旧版 Hub，重启该会话后可用'));
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
