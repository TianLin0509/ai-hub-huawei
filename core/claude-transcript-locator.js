'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECT_ROOT_DIRS = [
  '.claude',
  '.claude-deepseek',
];

function defaultHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

// 公司 Code Agent 的记录与 Claude 同格式，放在它自己的配置目录（默认 ~/.cac）的 projects/ 下。
// 配置无效时返回 null（只是少一个根，不影响 Claude 记录）。
function codeAgentProjectsRoot(homeDir = defaultHomeDir()) {
  try {
    const { configDir } = require('./codeagent-config').resolveCodeAgentConfig({ ...process.env, USERPROFILE: homeDir, HOME: homeDir });
    return path.join(configDir, 'projects');
  } catch { return null; }
}

function claudeProjectRoots(homeDir = defaultHomeDir()) {
  const roots = CLAUDE_PROJECT_ROOT_DIRS.map(dir => path.join(homeDir, dir, 'projects'));
  const cp = require('./claude-subscription-profiles');
  const ownHome = path.resolve(homeDir) === path.resolve(defaultHomeDir());
  const config = ownHome ? require('./hub-config').getConfig() : {};
  const env = ownHome ? process.env : {USERPROFILE:homeDir,HOME:homeDir};
  for (const p of cp.normalizeProfiles(config.claudeSubscriptionProfiles, homeDir)) {
    try {const dir=path.join(cp.resolveProfile(config,p.id,env,homeDir).home,'projects');if(!roots.includes(dir) && fs.existsSync(dir))roots.push(dir);}catch {}
  }
  const root = codeAgentProjectsRoot(homeDir);
  if (root && !roots.some(item => path.resolve(item).toLowerCase() === path.resolve(root).toLowerCase())) roots.push(root);
  return roots;
}

// 卡片刷新会反复按编号查找记录；命中只确认文件仍在，未命中最多缓存 3 秒。
// CodeAgent 各账号有独立目录，缓存必须区分根目录及其查找顺序。
const transcriptLookupCache = new Map();
const TRANSCRIPT_MISS_TTL_MS = 3000;
const lookupPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const lookupKey = (id, homeDir, roots) => JSON.stringify([lookupPath(homeDir), id, roots ? roots.map(lookupPath) : null]);
function rememberTranscript(key, entry) {
  if (!transcriptLookupCache.has(key) && transcriptLookupCache.size >= 2000) {
    transcriptLookupCache.delete(transcriptLookupCache.keys().next().value);
  }
  transcriptLookupCache.set(key, entry);
}

// 按根目录优先顺序，第一个有这个号的根目录里最后修改的那份（带 root 字段）；都没有返回 null。
function freshestInFirstRoot(ccSessionId, roots) {
  const sync = require('./transcript-resume-sync');
  for (const root of roots) {
    const best = sync.freshest(sync.listCopies(ccSessionId, root));
    if (best) return { ...best, root };
  }
  return null;
}

function findTranscriptByCCSessionId(ccSessionId, homeDir = defaultHomeDir(), projectsRoots = null) {
  if (!ccSessionId) return null;
  const key = lookupKey(ccSessionId, homeDir, projectsRoots);
  const cached = transcriptLookupCache.get(key);
  if (cached) {
    if (cached.path && fs.existsSync(cached.path)) return cached.path;
    if (!cached.path && Date.now() - cached.at < TRANSCRIPT_MISS_TTL_MS) return null;
    transcriptLookupCache.delete(key);
  }
  const roots = projectsRoots || claudeProjectRoots(homeDir);
  // R57：同一个号可能在同一配置目录的几个记录目录里各有一份（回落、归档都会复制），卡片和续接都要用最新的那份，
  // 不取枚举到的第一份。不同根目录是不同账号或 CLI，仍按给定的优先顺序：第一个有副本的根目录里取最新的。
  const best = freshestInFirstRoot(ccSessionId, roots);
  const found = best ? best.file : null;
  rememberTranscript(key, { path: found, at: Date.now(), roots: roots.map(lookupPath), home: lookupPath(homeDir), id: ccSessionId });
  return found;
}

// Claude CLI buckets transcripts by cwd: every non-alphanumeric char becomes '-'.
// `claude --resume <id>` only looks inside the bucket for the *current* cwd, so a
// workspace that moves on disk (scratch → 正式分类归档) leaves its transcript behind
// and the resume fails with "No conversation found with session ID".
function projectSlug(cwd) {
  return path.resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-');
}

// Copy each session's transcript into the bucket for `toCwd` so the post-archive
// `--resume` finds it. Best-effort: the archive itself already succeeded, so a
// failure here must degrade to "resumes without history", never abort the move.
// 续接前把最新副本放到当前目录以后，清掉这个号的查找缓存，下次查找重新按最新的一份算（R57）。
function forgetTranscriptLookup(ccSessionId) {
  for (const [key, entry] of transcriptLookupCache) if (entry.id === ccSessionId) transcriptLookupCache.delete(key);
}

function migrateTranscriptsForCwdChange(opts = {}) {
  const { toCwd, ccSessionIds = [] } = opts;
  // configDir：只在这个 CLI 配置目录里找（CodeAgent 账号各有自己的目录，默认根找不到）。
  const roots = opts.configDir ? [path.join(opts.configDir, 'projects')] : null;
  const homeDir = opts.homeDir || defaultHomeDir();
  const logger = opts.logger || console;
  const result = { copied: [], missing: [], errors: [] };
  if (!toCwd) return result;
  const slug = projectSlug(toCwd);

  for (const ccSessionId of ccSessionIds) {
    if (!ccSessionId) continue;
    try {
      // R57：同一个号可能在几个记录目录里各有一份（回落、自愈、归档都会复制）。按最后修改时间取最新的当源，
      // 不再取「枚举到的第一份」——那样会拿回落那天的旧副本盖掉今天的记录。
      const sync = require('./transcript-resume-sync');
      const searchRoots = roots || claudeProjectRoots(homeDir);
      const best = freshestInFirstRoot(ccSessionId, searchRoots);
      const copies = best ? sync.listCopies(ccSessionId, best.root) : [];
      const source = best ? best.file : null;
      if (!source) {
        result.missing.push(ccSessionId);
        continue;
      }
      // <homeDir>/<.claude|.claude-deepseek>/projects/<slug>/<sid>.jsonl —
      // keep the copy under the same root the CLI variant reads from.
      const projectsDir = path.dirname(path.dirname(source));
      const targetDir = path.join(projectsDir, slug);
      const target = path.join(targetDir, `${ccSessionId}.jsonl`);
      const current = copies.find(c => lookupPath(c.file) === lookupPath(target)) || null;
      if (path.resolve(source) === path.resolve(target) || sync.isUpToDate(current, best)) {
        result.copied.push(target);
        continue;
      }
      // 只有要盖掉已有的那份时才核对（对话号一致、非空、没截断）；目标不存在时复制不会覆盖任何东西。
      const rejected = current ? sync.rejectReason(ccSessionId, best, current) : '';
      if (rejected) {
        result.errors.push(`${ccSessionId}: ${rejected}`);
        continue;
      }
      sync.replaceWith(source, target);
      // 归档后旧副本仍存在；同步同账号的缓存，避免续写后卡片一直读取旧记录。
      for (const entry of transcriptLookupCache.values()) {
        if (entry.home !== lookupPath(homeDir) || entry.id !== ccSessionId) continue;
        if ((entry.path && lookupPath(entry.path) === lookupPath(source))
            || (!entry.path && entry.roots.includes(lookupPath(projectsDir)))) {
          entry.path = target;
          entry.at = Date.now();
        }
      }
      result.copied.push(target);
    } catch (error) {
      result.errors.push(`${ccSessionId}: ${error && error.message ? error.message : String(error)}`);
      logger.warn?.('[transcript] migrate failed:', error && error.message);
    }
  }
  return result;
}

function extractCwdFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf-8');
      const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

function healPersistedCwds(sessions, opts = {}) {
  const logger = opts.logger || console;
  const homeDir = opts.homeDir || defaultHomeDir();
  let fixed = 0;
  for (const s of sessions) {
    if (!s.ccSessionId) continue;
    // 已持久化的 transcriptPath 比按 sid 找到的“第一份副本”更具体；归档会把同一
    // jsonl 复制到新旧两个 bucket，目录枚举顺序不能当权威。
    const tp = (s.transcriptPath && fs.existsSync(s.transcriptPath))
      ? s.transcriptPath
      : findTranscriptByCCSessionId(s.ccSessionId, homeDir);
    if (!tp) continue;
    const realCwd = extractCwdFromTranscript(tp);
    if (!realCwd) continue;

    // transcript 迁移只复制 jsonl，不改写历史消息里的 cwd，所以候选值可能仍是已经
    // 删除的旧 scratch。把 Home “自愈”回另一个失效路径只是制造一次假修复。
    let targetIsDirectory = false;
    try { targetIsDirectory = fs.statSync(realCwd).isDirectory(); } catch {}
    if (!targetIsDirectory) {
      logger.warn?.(`[群聊] skip invalid transcript cwd for "${s.title}": ${realCwd}`);
      continue;
    }

    const key = value => {
      const resolved = path.resolve(String(value || ''));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (key(realCwd) === key(s.cwd)) continue;
    logger.log?.(`[群聊] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
    s.cwd = realCwd;
    delete s.cwdFellBackFrom;
    fixed++;
  }
  return fixed;
}

module.exports = {
  CLAUDE_PROJECT_ROOT_DIRS,
  claudeProjectRoots,
  codeAgentProjectsRoot,
  extractCwdFromTranscript,
  findTranscriptByCCSessionId,
  forgetTranscriptLookup,
  healPersistedCwds,
  migrateTranscriptsForCwdChange,
  projectSlug,
};
