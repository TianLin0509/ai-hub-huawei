'use strict';
const path = require('path');
// Only main-process callers can supply this capability; IPC cannot serialize Symbols.
const AUTH_TERMINAL = Symbol('account-login-terminal');
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
function terminalOptions(command, args, env, row) {
  const label = row.name || row.id;
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    'Write-Host ' + quote(label + ' · 授权'),
    'Write-Host ' + quote('请按官方提示在浏览器登录，并回到此终端完成验证。Hub 会自动检查结果。'),
    '& ' + [command, ...args].map(quote).join(' '),
    'Write-Host ' + quote('授权命令已结束。请返回账号页查看确认结果；若未完成，可关闭此会话后重新授权。'),
  ].join('; ');
  return { title: label + ' · 授权', cwd: env.USERPROFILE || env.HOME || path.dirname(row.home),
    [AUTH_TERMINAL]: { env, args: ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] } };
}
function createAccountLoginTerminal({ sessionManager, registerSession, send }) {
  const sessions = new Map();
  function resume(row) {
    const entry = sessions.get(row.id);
    if (!entry || entry.home !== row.home) return null;
    const session = sessionManager.getSession(entry.id);
    if (!session || session.status === 'exited') { sessions.delete(row.id); return null; }
    return { sessionId: session.id, message: '请在 Hub 内的「' + session.title + '」PowerShell 中继续授权。' };
  }
  const terminal = async (command, args, env, row) => {
    const existing = resume(row); if (existing) return existing;
    const session = sessionManager.createSession('powershell', terminalOptions(command, args, env, row));
    sessions.set(row.id, { id: session.id, home: row.home });
    registerSession(session);
    send('session-created', { session });
    return { sessionId: session.id, message: '已打开 Hub 内的「' + session.title + '」PowerShell，请按提示完成授权。' };
  };
  terminal.resume = resume;
  terminal.complete = row => sessions.delete(row.id);
  return terminal;
}
module.exports = { AUTH_TERMINAL, terminalOptions, createAccountLoginTerminal };
