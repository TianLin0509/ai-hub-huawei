'use strict';
// 在压缩包里直接双击运行（2026-11-20 一键反馈 v5.6.65）：免安装 zip 没解压，在 WinRAR 里双击 exe，
// 程序实际跑在 %TEMP%\Rar$EXa….rartemp 下。压缩软件随时会清掉这个临时目录，没被占用的文件先没：
// 那次 conpty.node（终端组件）被删，界面能开，会话恢复报「Failed to load native module: conpty.node」。
// 这里做两件事：启动时认出这种运行位置并提醒先解压；终端组件加载失败时把原始英文报错换成能照着做的话。

// 常见压缩软件「双击压缩包里的程序」时用的临时目录名。只看路径里的一段目录名，不猜别的。
const ARCHIVE_TEMP_DIRS = [
  { tool: 'WinRAR', re: /^Rar\$EX[^\\/]*$/i },
  { tool: '7-Zip', re: /^7zO[0-9A-F]{4,}$/i },
  { tool: 'Windows 资源管理器', re: /^Temp\d+_.+\.zip$/i },
  { tool: 'Bandizip', re: /^BNZ\.[^\\/]+$/i },
  { tool: '360 压缩', re: /^360zip\$Temp$/i },
  { tool: '好压', re: /^HZ\$D\.[^\\/]+$/i },
];

function detectArchiveTempRun(execPath) {
  const parts = String(execPath || '').split(/[\\/]+/).slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const hit = ARCHIVE_TEMP_DIRS.find(item => item.re.test(parts[i]));
    if (hit) return { tool: hit.tool, dir: parts.slice(0, i + 1).join('\\') };
  }
  return null;
}

const UNZIP_FIRST = '请先把整个压缩包解压到一个固定目录（例如 D:\\AIHub），再运行解压出来的 AI Hub Community.exe；以后也从那里打开。';

function archiveRunMessage(hit) {
  return `AI Hub 现在是直接在压缩包里运行的（${hit.tool} 的临时目录 ${hit.dir}）。压缩软件随时会删掉这个目录里的文件，`
    + `会话会起不来、升级也会丢。${UNZIP_FIRST}`;
}

// node-pty 的原生模块（conpty.node / pty.node）加载失败。其它错误原样返回 null，由调用方照常抛出。
function nativeLoadFailure(error) {
  const text = String(error && error.message || error || '');
  const m = /Failed to load native module:\s*([\w.-]+\.node)/i.exec(text);
  return m ? m[1] : null;
}

function nativeLoadMessage(error, { execPath = process.execPath } = {}) {
  const name = nativeLoadFailure(error);
  if (!name) return null;
  const hit = detectArchiveTempRun(execPath);
  if (hit) return `终端组件 ${name} 找不到，会话起不来。${archiveRunMessage(hit)}`;
  return `终端组件 ${name} 找不到或加载不了，会话起不来。程序文件不完整（常见原因：被安全软件隔离、升级时文件没换全），`
    + '请重新下载完整安装包覆盖安装；设置和会话记录会保留。';
}

// 启动时提醒一次（只在打包后的程序里）。用户选「仍然继续」就照常运行。
function warnIfRunningFromArchive({ app, dialog, execPath = process.execPath, isPackaged = app && app.isPackaged } = {}) {
  if (!isPackaged || process.platform !== 'win32') return null;
  const hit = detectArchiveTempRun(execPath);
  if (!hit || !app || !dialog) return hit;
  app.whenReady().then(async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning', title: 'AI Hub 需要先解压',
      message: '请先解压，再运行 AI Hub',
      detail: archiveRunMessage(hit),
      buttons: ['退出', '仍然继续（不推荐）'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response === 0) app.quit();
  }).catch(() => { /* 提醒失败不影响启动 */ });
  return hit;
}

module.exports = { detectArchiveTempRun, nativeLoadFailure, nativeLoadMessage, warnIfRunningFromArchive, archiveRunMessage };
