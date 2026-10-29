'use strict';

// CLI hook 报上来的工作目录、记录目录，与 Hub 会话目录比对时用。
// 同一个目录在 Windows 上可能有两种写法：8.3 短名（C:\Users\X0012~1\...，用户名超过 8 个字符时
// 系统临时目录常是这种写法）和长名。path.resolve 不展开短名，所以逐字比较会把会话本人当成外来者。
// 这里先逐字比，对不上再用真实路径（会展开短名、跟随目录链接）比；目录不存在时只按原写法比。
const fs = require('fs');
const path = require('path');
const { projectSlug } = require('./claude-transcript-locator');

function realDir(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function dirForms(p) {
  const resolved = path.resolve(String(p || ''));
  const real = realDir(resolved);
  return real && real.toLowerCase() !== resolved.toLowerCase() ? [resolved, real] : [resolved];
}

function sameWorkDir(a, b) {
  if (!a || !b) return false;
  const left = dirForms(a).map((p) => p.toLowerCase());
  return dirForms(b).some((p) => left.includes(p.toLowerCase()));
}

// 记录文件放在 <配置目录>/projects/<工作目录 slug>/ 下；slug 可能按短名或长名生成。
// 中文等非 ASCII 字符：Claude Code 换成「-」，公司 CodeAgent 原样保留（2026-10-29 同事自检：
// D:\CodeAgent\工作区 的记录在 D--CodeAgent-工作区，Hub 算出来是 D--CodeAgent----，认领一直对不上，
// 回答写好了、Stop 也报了，卡片还是空白）。比对前把记录目录名里的非 ASCII 字母数字也换成「-」，两种写法都认；
// 工作目录本身由 sameWorkDir 逐字核对，不会因此把别的目录当成本人。
function transcriptBucketMatches(transcriptPath, cwd) {
  if (!transcriptPath || !cwd) return false;
  const bucket = path.basename(path.dirname(String(transcriptPath))).toLowerCase();
  const asciiBucket = bucket.replace(/[^a-z0-9]/g, '-');
  return dirForms(cwd).some((p) => {
    const slug = projectSlug(p).toLowerCase();
    return slug === bucket || slug === asciiBucket;
  });
}

module.exports = { sameWorkDir, transcriptBucketMatches };
