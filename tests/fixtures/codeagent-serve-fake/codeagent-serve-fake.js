'use strict';
// 假 CodeAgent serve（tests/unit-codeagent-serve.test.js）：照公司 1.2615.02.03 真机实测（Q-1030-02/03）的行为——
// 只认 serve --host --port --token --config-dir；接口要 Bearer token（不带 401）；没有关闭接口，只能结束进程。
// 启动时再起一个子进程（模拟 MCP 子进程），用来验证结束的是整棵进程树。
// 环境变量：SERVE_FAKE_LOG=<文件> 记下启动参数和子进程 pid；SERVE_FAKE_MODE=never-ready | exit；
// SERVE_FAKE_PROVIDERS=<json 文件> 作为 /api/v2/config/providers 的返回；SERVE_FAKE_QUOTA_DIR=<目录> 下 <模型>.json 作为配额返回。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
if (argv[0] !== 'serve') { console.error('only serve'); process.exit(2); }
const opts = {};
for (let i = 1; i < argv.length; i += 2) {
  if (!['--host', '--port', '--token', '--config-dir'].includes(argv[i])) { console.error(`Unknown serve option: ${argv[i]}`); process.exit(2); }
  opts[argv[i].slice(2)] = argv[i + 1];
}
if (process.env.SERVE_FAKE_MODE === 'exit') process.exit(3);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
if (process.env.SERVE_FAKE_LOG) fs.appendFileSync(process.env.SERVE_FAKE_LOG, JSON.stringify({ pid: process.pid, child: child.pid, opts, env: { CODEAGENT3_CONFIG_DIR: process.env.CODEAGENT3_CONFIG_DIR || null } }) + '\n');
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  if (process.env.SERVE_FAKE_MODE === 'never-ready') return send(res, 503, { error: 'starting' });
  if (req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 401, { error: { code: 'auth.invalid_request', message: 'Missing authentication token' } });
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1/global/health') return send(res, 200, { healthy: true, version: '1.2615.02.03' });
  if (url.pathname === '/api/v2/config/providers') {
    const file = process.env.SERVE_FAKE_PROVIDERS;
    return send(res, 200, file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : { providers: [] });
  }
  const quota = url.pathname.match(/^\/api\/v2\/model\/([^/]+)\/quota$/);
  if (quota) {
    const file = process.env.SERVE_FAKE_QUOTA_DIR && path.join(process.env.SERVE_FAKE_QUOTA_DIR, `${decodeURIComponent(quota[1])}.json`);
    return send(res, 200, file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'null');
  }
  return send(res, 404, { error: 'not found' });
});
server.listen(Number(opts.port), opts.host || '127.0.0.1');
