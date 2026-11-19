'use strict';
// 设置始终留在默认目录；只在服务构造前选择、复制数据，运行中不换路径。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MARKER = '.data-root-migration.json';
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
function canonical(dir) {
  if (fs.existsSync(dir)) return fs.realpathSync(dir);
  return path.join(canonical(path.dirname(dir)), path.basename(dir));
}
function validateDataRoot(value, defaultDir, sourceDir = defaultDir) {
  if (typeof value !== 'string') throw new Error('助理数据目录必须是字符串');
  const input = value.trim();
  if (!input) return '';
  if (!path.isAbsolute(input) || /[\r\n\0]/.test(input)) throw new Error('助理数据目录必须是绝对路径');
  const target = path.resolve(input), base = path.resolve(defaultDir);
  if (target === base) return '';
  const real = canonical(target);
  for (const dir of [base, sourceDir]) {
    const other = canonical(path.resolve(dir));
    if (real === other && dir === sourceDir && dir !== base) continue;
    if (inside(real, other) || inside(other, real)) throw new Error('助理数据目录不能与默认目录或当前目录互相包含');
  }
  fs.mkdirSync(target, { recursive: true });
  // 实际创建文件确认可写，不能只看权限位（Windows ACL 可能不同）。
  const probe = path.join(target, '.write-check-' + randomUUID());
  try { fs.writeFileSync(probe, '', { flag: 'wx' }); }
  catch (error) { throw new Error('助理数据目录不可写：' + error.message); }
  finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
  return target;
}
function readSettings(defaultDir) {
  try { return JSON.parse(fs.readFileSync(path.join(defaultDir, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function saveSettings(defaultDir, settings) {
  fs.mkdirSync(defaultDir, { recursive: true });
  const file = path.join(defaultDir, 'settings.json'), tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
function entries(dir) {
  try { return fs.readdirSync(dir).filter(n => n !== 'settings.json' && n !== MARKER && !/^settings\.json\..*\.tmp$/.test(n)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function copyDataTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('数据中含链接，不能自动迁移：' + source);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('目标数据中含链接，不能自动迁移：' + target);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copyDataTree(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) {
    // Electron 41.2 的 Node 24.14：cpSync 覆盖中文路径文件可能直接崩溃，catch 无法兜底。
    // 使用底层 copyFileSync 逐文件复制，保留中断重试时覆盖半份文件的语义。
    fs.copyFileSync(source, target);
  } else throw new Error('数据中含不支持的文件类型：' + source);
}
function prepareDataRoot(defaultDir) {
  let settings;
  try {
    settings = readSettings(defaultDir);
    const source = settings.dataRootActive || defaultDir;
    const target = validateDataRoot(settings.dataRoot || '', defaultDir, source) || defaultDir;
    let copied = false;
    if (path.resolve(source) !== path.resolve(target)) {
      const marker = path.join(target, MARKER);
      let pending = null;
      if (fs.existsSync(marker)) pending = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (pending && pending.source !== source) throw new Error('目标目录有尚未完成的其他迁移，请选择空文件夹');
      const sourceNames = entries(source), targetNames = entries(target);
      const hasData = targetNames.some(name => sourceNames.includes(name) || /^(?:workspace|ppt-workspace|archive|tools|diag|meeting-speech)$|\.jsonl?$/.test(name));
      if (pending || (!hasData && sourceNames.length)) {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ source }), 'utf8');
        // 标记留到整轮复制完成；失败后下次启动重试，不能把半份数据当成完整数据。
        for (const name of entries(source)) {
          copyDataTree(path.join(source, name), path.join(target, name));
        }
        copied = true;
      }
      if (copied && settings.cliPath && inside(path.join(source, 'tools', 'welink-cli'), path.resolve(settings.cliPath))) {
        settings.cliPath = path.join(target, path.relative(source, settings.cliPath));
      }
      // 换目录时记下离开的目录：目标已有数据时不会复制，旧目录里后来新建的会议要靠这份记录在会议页里找回（2026-11-19）。
      const history = Array.isArray(settings.dataRootHistory) ? settings.dataRootHistory.filter(d => typeof d === 'string') : [];
      settings.dataRootHistory = [...history.filter(d => path.resolve(d) !== path.resolve(source)), source].slice(-8);
      settings.dataRootActive = target;
      saveSettings(defaultDir, settings);
      if (copied) fs.unlinkSync(marker);
    }
    return { dir: target, error: '', copied };
  } catch (error) {
    return { dir: defaultDir, error: '助理数据目录启用失败，本次使用默认目录：' + error.message, copied: false };
  }
}
module.exports = { prepareDataRoot, validateDataRoot };
