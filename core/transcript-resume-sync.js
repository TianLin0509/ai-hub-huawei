'use strict';
// 续接前把「最新的那份对话记录」放到 CLI 会去读的位置（R57，2026-11-27）。
//
// CLI 的 `--resume <号>` 只读当前工作目录对应的记录目录（<配置目录>/projects/<转义的工作目录>/<号>.jsonl）。
// 工作目录回落、启动自愈改回原目录、归档搬家都会复制记录，同一个对话号于是在几个记录目录里各有一份、各自增长；
// 以前谁先被枚举到就用谁，用户会接到停在回落那天的旧上下文，甚至让旧副本盖掉今天的记录。
// 这里按最后修改时间取最新的一份；复制前核对对话号一致、最新那份不是空文件或明显截断，不满足就只记异常、不动文件；
// 被换下的那份改名备份（<号>.jsonl.r57bak，同名覆盖，不删）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEAD_BYTES = 64 * 1024;
// 最新那份比当前那份小这么多（不到一半）就当作截断，不覆盖。
const TRUNCATED_RATIO = 0.5;
const BACKUP_SUFFIX = '.r57bak';
const LOG_NAME = 'codeagent-resume.log';
const LOG_MAX_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const slugOf = cwd => path.resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-');
// 日志里不写路径（会带出用户名和项目名）：记录目录只写名字的短哈希。
const bucketTag = file => crypto.createHash('sha1').update(path.basename(path.dirname(file)).toLowerCase()).digest('hex').slice(0, 8);
const short = id => String(id || '').slice(0, 8);

function statFile(file) {
  try { const st = fs.statSync(file); return st.isFile() ? { file, mtimeMs: st.mtimeMs, size: st.size } : null; } catch { return null; }
}

// 同一配置目录下所有记录目录里的这个对话号。
function listCopies(sessionId, projectsDir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = statFile(path.join(projectsDir, entry.name, sessionId + '.jsonl'));
    if (info) out.push(info);
  }
  return out;
}

// 文件头里出现的对话号（去重、小写）。读不出任何对话号返回 null。
function headSessionIds(file) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(HEAD_BYTES); text = buf.slice(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return null; }
  const ids = new Set();
  for (const m of text.matchAll(/"session_?[iI]d"\s*:\s*"([^"]+)"/g)) ids.add(m[1].toLowerCase());
  return ids.size ? [...ids] : null;
}

function freshest(copies) {
  return copies.reduce((best, c) => (!best || c.mtimeMs > best.mtimeMs || (c.mtimeMs === best.mtimeMs && c.size > best.size) ? c : best), null);
}

// 能不能拿 source 去替换 target：对话号一致、非空、没有明显截断。返回不满足的原因，满足返回 ''。
function rejectReason(sessionId, source, target) {
  if (!source.size) return 'freshest-empty';
  // 分支、压缩可能让文件头里混进别的号，所以只要求两份都带着这个号；当前那份读不出号（如旧格式）时只看最新那份。
  const want = String(sessionId).toLowerCase();
  const ids = headSessionIds(source.file);
  if (!ids || !ids.includes(want)) return 'session-id-mismatch';
  const targetIds = target ? headSessionIds(target.file) : null;
  if (targetIds && !targetIds.includes(want)) return 'session-id-mismatch';
  if (target && target.size && source.size < target.size * TRUNCATED_RATIO) return 'freshest-truncated';
  return '';
}

// 把 source 原子地复制到 target；target 已存在时先改名备份。
// 备份固定一份 <号>.jsonl.r57bak（改名直接覆盖，不先删）；已有的备份比当前这份还大时不覆盖它，当前这份另存带时间的备份。
// 任一步失败：已改名的备份改回原名，临时文件删掉，原样抛出。
function replaceWith(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  let backup = null;
  try {
    fs.copyFileSync(source, tmp);
    const current = statFile(target);
    if (current) {
      const fixed = target + BACKUP_SUFFIX, old = statFile(fixed);
      backup = old && old.size > current.size ? `${fixed}-${Date.now()}` : fixed;
      fs.renameSync(target, backup);
    }
    fs.renameSync(tmp, target);
    return backup;
  } catch (error) {
    if (backup) { try { if (!fs.existsSync(target)) fs.renameSync(backup, target); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

// current 是否已经不比 best 旧：修改时间更晚，或同一时刻（复制会保留修改时间）且不更小。
function isUpToDate(current, best) {
  return !!current && (current.mtimeMs > best.mtimeMs || (current.mtimeMs === best.mtimeMs && current.size >= best.size));
}

const describe = (c, target) => c && { bucket: bucketTag(c.file), here: !!target && path.resolve(c.file).toLowerCase() === path.resolve(target).toLowerCase(),
  mtime: new Date(c.mtimeMs).toISOString(), size: c.size };

/**
 * 续接前同步：让 <projects>/<cwd 桶>/<号>.jsonl 是所有副本里最新的那份。
 * @returns {{action:'none'|'kept'|'synced'|'anomaly'|'error', reason?, target, chosen?, copies, backup?}}
 */
function syncFreshestForResume({ sessionId, cwd, configDir }) {
  if (!UUID.test(String(sessionId || '')) || !cwd || !configDir) return { action: 'none', reason: 'no-input', copies: [] };
  const projectsDir = path.join(configDir, 'projects');
  const target = path.join(projectsDir, slugOf(cwd), sessionId + '.jsonl');
  const copies = listCopies(sessionId, projectsDir);
  const current = copies.find(c => path.resolve(c.file).toLowerCase() === path.resolve(target).toLowerCase()) || null;
  const best = freshest(copies);
  const base = { target, copies: copies.map(c => describe(c, target)) };
  if (!best) return { ...base, action: 'none', reason: 'no-history' };
  if (best === current || isUpToDate(current, best)) return { ...base, action: 'kept', chosen: describe(current, target) };
  // 只有要盖掉已有的那份时才核对；当前位置没有记录时把最新那份复制过来，不会覆盖任何东西。
  const reason = current ? rejectReason(sessionId, best, current) : '';
  if (reason) return { ...base, action: 'anomaly', reason, chosen: describe(current || best, target) };
  try {
    const backup = replaceWith(best.file, target);
    return { ...base, action: 'synced', chosen: describe(best, target), from: bucketTag(best.file), backup: !!backup };
  } catch (error) {
    return { ...base, action: 'error', reason: error.code || error.message, chosen: describe(current || best, target) };
  }
}

// 诊断日志：一行一个 JSON。异常的行带「异常」二字，一键反馈「只留像报错的行」时也能留下。
function appendResumeLog(dataDir, event, fields = {}) {
  try {
    if (!dataDir) return;
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_NAME);
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1'); } catch {}
    // 精简版一键反馈只读 message/reason/event 等字段（core/hub-feedback-slim.js MSG_KEYS）：说明写进 message，并带上会话号和对话号。
    const { note, ...rest } = fields;
    const message = note ? `${note}（会话 ${rest.session || '-'}，对话号 ${rest.requested || rest.incoming || '-'}）` : undefined;
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...rest, ...(message ? { message } : {}) }) + '\n');
  } catch { /* 诊断失败不能挡住会话启动 */ }
}

const ANOMALY_NOTE = {
  'freshest-empty': '续接异常：最新的那份记录是空文件，没有替换',
  'session-id-mismatch': '续接异常：最新那份记录里的对话号对不上，没有替换',
  'freshest-truncated': '续接异常：最新那份记录比当前那份小很多，疑似截断，没有替换',
};
function logSync(dataDir, { hubSessionId, kind, sessionId, cwdFellBack, result }) {
  if (!result || result.action === 'none' && result.reason === 'no-input') return;
  const note = result.action === 'synced' ? '续接前换成了最新的那份记录（原来那份已改名备份）'
    : result.action === 'anomaly' ? ANOMALY_NOTE[result.reason] || '续接异常'
      : result.action === 'error' ? '续接异常：同步最新记录失败' : undefined;
  appendResumeLog(dataDir, 'resume-sync', { session: short(hubSessionId), ...(kind ? { kind } : {}), requested: short(sessionId), cwdFellBack: !!cwdFellBack,
    action: result.action, ...(result.reason ? { reason: result.reason } : {}), ...(result.chosen ? { chosen: result.chosen } : {}),
    copies: result.copies, ...(result.backup ? { backup: true } : {}), ...(note ? { note } : {}) });
}

module.exports = { syncFreshestForResume, appendResumeLog, logSync, listCopies, headSessionIds, freshest, rejectReason, replaceWith, isUpToDate,
  bucketTag, LOG_NAME, BACKUP_SUFFIX, TRUNCATED_RATIO };
