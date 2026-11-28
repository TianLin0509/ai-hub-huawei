'use strict';
// 只给隔离测试实例用（core/data-dir.js isIsolatedHub）：两个 Hub 在同一台电脑上，用本地文件夹假装各自的共享，
// 走一遍真实界面的「邀请 → 加入 → 分享 → 来信」。正式实例不读这些环境变量。
// AI_HUB_CREW_FAKE_NET = JSON 文件路径：{ "self": "10.1.1.1", "net": { "10.1.1.1": { "name": "S_A", "path": "..." }, ... } }
const fs = require('node:fs');
const path = require('node:path');

function fakeNet(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const net = cfg.net || {}, self = net[cfg.self];
  return {
    ip: cfg.self,
    shareTools: {
      listShares: async () => (self ? [{ name: self.name, path: self.path }] : []),
      pickShare: shares => shares[0] || null,
      createShare: async () => { throw new Error('测试环境不建共享'); },
      boxDir: s => path.join(s.path, 'ai-hub-community'),
      peerBoxDir: (ip, share) => { const n = net[ip]; return n && n.name === share ? path.join(n.path, 'ai-hub-community') : path.join(path.dirname(file), 'unreachable', ip); },
      // 测试网里其他「电脑」都视为正连着本机的共享。
      inboundSmbPeers: async () => Object.keys(net).filter(ip => ip !== cfg.self),
      powershell: async script => { const m = String(script).match(/net view \\+([\d.]+)/); const n = m && net[m[1]]; return n ? `${n.name}   Disk\r\n` : ''; },
    },
  };
}

module.exports = { fakeNet };
