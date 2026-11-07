'use strict';

// 双击即会运行代码的文件类型：从预览/卡片里的链接打开前必须先让用户确认。
const EXECUTABLE_EXTS = new Set([
  '.exe', '.com', '.scr', '.pif', '.msi', '.msp', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.lnk', '.hta', '.cpl', '.reg', '.jar', '.appx', '.msix', '.application',
]);

function isExecutablePath(filePath) {
  const text = String(filePath || '').trim().replace(/[\s.]+$/, '');
  const base = text.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && EXECUTABLE_EXTS.has(base.slice(dot).toLowerCase());
}

// 链接来自 AI 回答或文件内容：可执行类文件先确认，不直接运行。不是可执行文件或用户确认了才返回 true。
async function confirmIfExecutable(filePath, confirm = (...args) => require('./ui-feedback').confirmHubAction(...args)) {
  if (!isExecutablePath(filePath)) return true;
  return !!(await confirm(`将用系统默认方式运行这个文件：\n${filePath}\n\n确认来源可信后再继续。`, { title: '运行这个文件？', acceptLabel: '运行', danger: true }));
}

module.exports = { isExecutablePath, confirmIfExecutable, EXECUTABLE_EXTS };
