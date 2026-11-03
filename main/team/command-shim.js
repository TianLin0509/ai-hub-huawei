'use strict';
// 组队命令的固定入口 <Hub 数据目录>/team/hub-team.cmd：用 Hub 自己的程序当 Node 跑 scripts/hub-team.js
// （安装版脚本在 app.asar 里、机器上也不一定装了 Node，同编排员工具的做法）。内容不变就不重写。
const fs = require('node:fs');
const path = require('node:path');

function commandBody({ nodeExecutable, runAsNode, script }, platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nsetlocal\r\n${runAsNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}"${nodeExecutable}" "${script}" %*\r\nexit /b %errorlevel%\r\n`;
  }
  const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh\n${runAsNode ? 'export ELECTRON_RUN_AS_NODE=1\n' : ''}exec ${q(nodeExecutable)} ${q(script)} "$@"\n`;
}

function writeTeamCommand(file, options) {
  const body = commandBody(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return file;
  fs.writeFileSync(file, body, { mode: 0o700 });
  return file;
}

module.exports = { commandBody, writeTeamCommand };
