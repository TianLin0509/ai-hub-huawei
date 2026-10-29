'use strict';
// 网页圆桌 MCP → Hub「AI 网页」（2026-10-28 用户拍板：MCP 改用 AI 网页的登录，在 Hub 里登录一次处处可用）。
// MCP 进程找到持有网页登录的那个 Hub（web-sessions-owner.json；没有持有者就找最近启动的 Hub），
// 经它的本机接口提问；填字、发送、读回答都由 Hub 的 lite 网页脚本完成（main/web-page-agent.js）。
const fs = require('fs');
const http = require('http');
const path = require('path');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function target(dataDir) {
  const dir = path.join(dataDir, 'control');
  let entries = [];
  try { entries = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => readJson(path.join(dir, f))).filter(c => c && Number.isInteger(c.pid) && c.hookPort && c.token && alive(c.pid)); } catch { return null; }
  if (!entries.length) return null;
  const owner = readJson(path.join(dataDir, 'web-sessions-owner.json'));
  return entries.find(c => c.pid === owner?.pid) || entries.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
}

function post(dataDir, route, body, { timeoutMs = 20000 } = {}) {
  const hub = target(dataDir);
  if (!hub) return Promise.reject(Object.assign(new Error('没有找到正在运行的 AI Hub。网页圆桌用的是 Hub「AI 网页」里的登录，请先打开 Hub。'), { code: 'HUB_NOT_RUNNING' }));
  const data = JSON.stringify({ ...body, token: hub.token });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: hub.hookPort, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: timeoutMs }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let value = {};
        try { value = JSON.parse(text || '{}'); } catch {}
        if (res.statusCode === 200) resolve(value);
        else reject(Object.assign(new Error(value.error || `Hub 接口返回 ${res.statusCode}`), { code: value.code || (res.statusCode === 404 ? 'HUB_TOO_OLD' : 'HUB_ERROR'), status: res.statusCode }));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Hub 接口超时')));
    req.on('error', reject);
    req.end(data);
  });
}

const available = dataDir => !!target(dataDir);
const ask = (dataDir, { provider, prompt, url, member }) => post(dataDir, '/api/web-ask', { provider, prompt, url, member });
const status = (dataDir, id) => post(dataDir, '/api/web-ask-status', { id });
const collect = (dataDir, id, force = false) => post(dataDir, '/api/web-ask-collect', { id, force }, { timeoutMs: 120000 });

module.exports = { target, available, ask, status, collect, post };
