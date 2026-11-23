'use strict';

// 共享绑定逻辑随公司反代一起解包，保证独立 Node 进程也能加载。

const RETRYABLE = new Set(['EACCES', 'EADDRINUSE', 'EPERM']);
const HOOK_PORT_CANDIDATES = Array.from({ length: 20 }, (_, i) => 3456 + i);

function fallbackMessage({ port, failures = [], fallback = false }) {
  if (!port) return '状态回报端口未能绑定，请查看启动日志';
  if (!fallback) return `状态回报端口 ${port} 正常`;
  const denied = failures.some(f => f.code === 'EACCES' || f.code === 'EPERM');
  // 绑定拒绝也可能来自权限策略，不能仅凭 EACCES 断言已查到系统保留表。
  return `${denied ? '端口段被系统保留或访问受限' : '原端口段已被占用'}，已改用 ${port}`;
}

// 保留原候选顺序；仅在可恢复的绑定错误后让系统分配，绝不先探测再释放端口。
async function bindPortWithFallback(bind, ports = HOOK_PORT_CANDIDATES) {
  const failures = [];
  const candidates = [...new Set(ports)];
  if (!candidates.includes(0)) candidates.push(0);
  for (const requestedPort of candidates) {
    try {
      const address = await bind(requestedPort);
      const result = { port: address.port, fallback: requestedPort === 0 && failures.length > 0, failures };
      return { ...result, message: fallbackMessage(result) };
    } catch (error) {
      failures.push({ port: requestedPort, code: error.code || 'UNKNOWN' });
      if (!RETRYABLE.has(error.code) || requestedPort === 0) {
        error.portFailures = failures;
        throw error;
      }
    }
  }
}

function listenWithPortFallback(server, { ports = HOOK_PORT_CANDIDATES, host = '127.0.0.1' } = {}) {
  return bindPortWithFallback(port => new Promise((resolve, reject) => {
    const cleanup = () => { server.off('error', onError); server.off('listening', onListening); };
    const onError = error => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen(port, host); } catch (error) { onError(error); }
  }), ports);
}

module.exports = { HOOK_PORT_CANDIDATES, bindPortWithFallback, listenWithPortFallback, fallbackMessage };
