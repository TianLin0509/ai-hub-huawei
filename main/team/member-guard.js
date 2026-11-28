'use strict';

// 成员（组队招进来的 CodeAgent 会话）调用写类、命令类工具前，本次启动 --settings 叠加文件里的同步 PreToolUse hook
// （scripts/hub-workspace-guard.ps1 的 member 段，和「只允许改工作目录内的文件」共用同一个入口，core/workspace-guard.js）
// 把工具名和参数发到 /api/member-guard；Hub 按 core/member-guard-rules.js 判定。
// 负责人放行：hub-team pass --to <成员编号>，放行该成员最近被拦的那一条，30 分钟内原样重试一次有效。
// 任何异常一律放行：误拦一次的代价大于漏拦（误报当场放宽）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { classify } = require('../../core/member-guard-rules');

const PASS_TTL_MS = 30 * 60 * 1000;
const NOTIFY_DEDUP_MS = 10 * 60 * 1000;

function gitBranch(dir) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, timeout: 3000 },
      (error, stdout) => resolve(error ? null : String(stdout || '').trim() || null));
  });
}
async function dirBirth(dir) {
  try { const st = await fs.promises.stat(dir); return st.birthtimeMs || st.ctimeMs || 0; }
  catch (error) { return error && error.code === 'ENOENT' ? null : 0; }
}
const uniq = list => [...new Set(list.filter(Boolean).map(p => path.resolve(p)))];

// 成员入队后自己新建的任务目录（worktree、产物目录）能删：工作根取新建会话的默认根与工作文件根。
function defaultWorkRoots() {
  const out = [];
  try { out.push(require('../../core/storage-roots').sessionWorkspaceRoot({ fallback: null })); } catch {}
  try { out.push(require('../../core/work-file-root').current()); } catch {}
  return out.filter(Boolean);
}

function createMemberGuard({ getTeamService, getSession, hubDataDir, isolated = false, logger = console, getConfig = () => ({}),
  now = () => Date.now(), branchOf = gitBranch, birthOf = dirBirth, env = process.env, workRoots = defaultWorkRoots } = {}) {
  const lastBlocked = new Map(); // sid -> { fingerprint, category, label, reason, command, at }
  const passes = new Map();      // sid -> { fingerprint, until }
  const notified = new Map();    // sid + fingerprint -> at
  const home = os.homedir();
  const tempRoots = uniq([env.TEMP, env.TMP, os.tmpdir()]);
  // 生产数据目录始终保护；隔离 Hub 里另外保护它自己的数据目录（实测用）。
  const dataDirs = uniq([path.join(home, '.ai-hub-community'), hubDataDir]);
  const protectedPids = isolated ? new Set() : new Set([process.pid]);
  const logFile = hubDataDir ? path.join(hubDataDir, 'logs', 'member-guard.jsonl') : null;

  function log(entry) {
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // 只留最近约 1 MB：超了就把旧文件改名覆盖一份。
      try { if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch {}
      fs.appendFileSync(logFile, JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n', 'utf8');
    } catch { /* 只是留痕 */ }
  }
  function fingerprintOf(toolName, toolInput) {
    const t = toolInput && typeof toolInput === 'object' ? toolInput : {};
    return `${toolName}\n${String(t.command || t.file_path || t.notebook_path || '').trim()}`;
  }
  function protectedBranches() {
    try { const list = getConfig()?.teamMemberGuard?.protectedBranches; return Array.isArray(list) ? list : null; } catch { return null; }
  }

  async function check({ sessionId, toolName, toolInput, cwd } = {}) {
    try {
      const service = getTeamService && getTeamService();
      const found = service?.teamOfMember?.(sessionId);
      if (!found || !found.member) return { decision: 'allow' };
      const { team, member } = found;
      const session = getSession?.(sessionId);
      const sessionCwd = session?.info?.cwd || session?.cwd || '';
      const hit = await classify({ toolName, toolInput }, {
        cwd: cwd || sessionCwd, access: member.access === 'read' ? 'read' : 'write', env,
        allowRoots: uniq([sessionCwd, cwd, member.cwd, member.worktree?.path, ...tempRoots]), tempRoots,
        workRoots: uniq(typeof workRoots === 'function' ? workRoots() : workRoots || []), joinedAt: Number(member.joinedAt) || 0,
        hubDataDir: dataDirs, hubProgramDir: [], protectedPids, protectedBranches: protectedBranches(), branchOf, dirBirth: birthOf,
      });
      if (!hit) return { decision: 'allow' };
      const fingerprint = fingerprintOf(toolName, toolInput);
      const pass = passes.get(sessionId);
      if (pass && pass.fingerprint === fingerprint && pass.until >= now()) {
        passes.delete(sessionId);
        log({ event: 'passed', member: member.memberId, sid: sessionId, category: hit.category, command: hit.command });
        return { decision: 'allow', passed: true };
      }
      lastBlocked.set(sessionId, { fingerprint, ...hit, at: now() });
      log({ event: 'blocked', member: member.memberId, sid: sessionId, category: hit.category, reason: hit.reason, command: hit.command });
      if (hit.category === 'read') {
        return { decision: 'deny', reason: `已拦截：你是只读成员（审查类任务），不能写文件——${hit.reason}。请只读代码、跑只读检查，把结论写进回执；确需写文件先向负责人说明。` };
      }
      const key = sessionId + '\n' + fingerprint;
      if (!(notified.get(key) > now() - NOTIFY_DEDUP_MS)) {
        notified.set(key, now());
        try {
          service.notifyLead?.(team.leadSid, `【权限拦截】${member.memberId}（${member.title || member.role || ''}）的命令被拦下：${hit.label}。\n原因：${hit.reason}\n命令：${hit.command}\n` +
            `能定就自己定：放行这一条用 \`hub-team pass --to ${member.memberId}\`（30 分钟内原样重试一次有效）；不可逆或对外的事先问用户。`, { wake: true });
        } catch (error) { logger.warn?.('[member-guard] 通知负责人失败', error.message); }
      }
      return { decision: 'deny', reason: `已拦截，已报告负责人：${hit.label}——${hit.reason}。不要换别的命令或通道绕过；等负责人放行后原样重试这一条，或改用不触碰这条边界的做法。` };
    } catch (error) {
      logger.warn?.('[member-guard] 判定出错，放行', error && error.message);
      return { decision: 'allow', error: String(error && error.message || error) };
    }
  }

  // 负责人放行某成员最近被拦的一条（一次性、30 分钟内有效）。
  function pass(callerSid, args = {}) {
    const service = getTeamService && getTeamService();
    const team = service?.teamOfLead?.(callerSid);
    if (!team) throw Error('只有负责人能放行被拦的命令');
    const memberId = String(args.to || args.memberId || '').trim();
    const member = (team.members || []).find(m => m.memberId === memberId && m.sid);
    if (!member) throw Error('用法：pass --to <成员编号>（如 m3）');
    const last = lastBlocked.get(member.sid);
    if (!last) throw Error(`${memberId} 最近没有被拦的命令`);
    passes.set(member.sid, { fingerprint: last.fingerprint, until: now() + PASS_TTL_MS });
    log({ event: 'pass-granted', member: memberId, sid: member.sid, by: callerSid, command: last.command });
    try {
      service.notifyMember?.(callerSid, memberId, `负责人放行了你刚才被拦的命令（${last.label}）：30 分钟内原样重试这一条一次有效。\n${last.command}`);
    } catch (error) { logger.warn?.('[member-guard] 通知成员失败', error && error.message); }
    return { ok: true, memberId, command: last.command, validMinutes: PASS_TTL_MS / 60000 };
  }

  return { check, pass, _state: { lastBlocked, passes } };
}

// 会话是否按组队成员启动（决定叠加文件里要不要挂成员守卫）：新建时 opts.memberGuard，恢复、重拉时按名册。
function memberLaunchInfo(service, sid) {
  try { const found = service?.teamOfMember?.(sid); return found ? { access: found.member.access === 'read' ? 'read' : 'write' } : null; }
  catch { return null; }
}

// 载荷 → check() 的入参：只取判定要用的字段（写文件的正文不要）。
function requestFromPayload(sessionId, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const toolInput = {};
  for (const k of ['command', 'file_path', 'notebook_path', 'path']) if (typeof ti[k] === 'string' && ti[k]) toolInput[k] = ti[k].slice(0, 8000);
  return { sessionId: String(sessionId || ''), toolName: String(p.tool_name || '').slice(0, 80), cwd: String(p.cwd || '').slice(0, 1000), toolInput };
}

// /api/member-guard：hook 脚本（scripts/hub-workspace-guard.ps1 member 段）原样转发 CLI 的 PreToolUse 载荷，
// 会话号与令牌放在请求头（同 /api/hook-raw）。令牌不对 403；其余任何问题都回 allow。
function handleHttp(req, res, { hookToken, getGuard }) {
  const reply = (code, body) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); } catch {} };
  if (!hookToken || String(req.headers['x-hub-token'] || '') !== hookToken) { req.resume(); reply(403, {}); return; }
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => { if (tooBig) return; size += c.length; if (size > 8 * 1024 * 1024) { tooBig = true; return; } chunks.push(c); });
  req.on('error', () => reply(200, { decision: 'allow' }));
  req.on('end', async () => {
    let verdict = { decision: 'allow' };
    try {
      const guard = getGuard && getGuard();
      if (guard && !tooBig) {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '') || '{}');
        verdict = await guard.check(requestFromPayload(req.headers['x-hub-session'], payload));
      }
    } catch (error) { console.warn('[member-guard] 判定失败，放行:', error && error.message); verdict = { decision: 'allow' }; }
    reply(200, verdict);
  });
}

module.exports = { createMemberGuard, memberLaunchInfo, requestFromPayload, handleHttp, PASS_TTL_MS };
