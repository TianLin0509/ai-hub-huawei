'use strict';
// 兼容渲染：有的电脑（2026-10-08 公司真机）用 GPU 渲染时 Hub 窗口全黑，进程却正常响应；
// 关闭 GPU 加速后正常。以下任一条件成立就在启动前关闭硬件加速：
//   - 环境变量 AI_HUB_DISABLE_GPU=1；
//   - 命令行带 --disable-gpu（例如快捷方式里加的）；
//   - Hub 数据目录里有 gpu-disabled.json（安装脚本 -DisableGpu 会写，删掉即恢复 GPU）。
// GPU 进程意外退出只记日志，不自动改设置：一次偶发的显卡问题不应把 Hub 永久切到软件渲染。
const fs = require('fs');
const path = require('path');

const MARKER = 'gpu-disabled.json';
const COMPAT_SWITCHES = ['disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'disable-gpu-sandbox'];

function markerPath(dataDir) {
  return path.join(dataDir, MARKER);
}

function shouldDisableGpu({ env = process.env, argv = process.argv, dataDir } = {}) {
  if (env.AI_HUB_DISABLE_GPU === '1') return 'env';
  if (argv.some(arg => arg === '--disable-gpu')) return 'argv';
  try { if (dataDir && fs.existsSync(markerPath(dataDir))) return 'marker'; } catch {}
  return null;
}

function applyGpuMode({ app, env = process.env, argv = process.argv, dataDir, logger = console } = {}) {
  const reason = shouldDisableGpu({ env, argv, dataDir });
  if (reason) {
    app.disableHardwareAcceleration();
    // 2026-11-16：只关硬件加速时 Chromium 仍会起一个软件渲染的 GPU 子进程；个别电脑上它初始化就崩
    // （退出码 0x80000003），连崩几次整个程序退出。兼容模式下连这个子进程也不起、它的沙箱也放开；
    // 只影响已经打开兼容模式的人，默认走显卡渲染的同事完全不变。不用 --no-sandbox（会放开所有子进程）。
    for (const sw of COMPAT_SWITCHES) if (!argv.includes('--' + sw)) app.commandLine.appendSwitch(sw);
    logger.log?.(`[gpu] hardware acceleration disabled (${reason})`);
  }
  app.on('child-process-gone', (_event, details) => {
    if (details && details.type === 'GPU') {
      logger.warn?.(`[gpu] GPU process gone: ${details.reason} (exit ${details.exitCode}). 窗口黑屏时可设置 AI_HUB_DISABLE_GPU=1 或在数据目录放 ${MARKER}`);
    }
  });
  return reason;
}

module.exports = { MARKER, COMPAT_SWITCHES, markerPath, shouldDisableGpu, applyGpuMode };
