'use strict';
// 升级途中又点了图标（2026-11-13）：用户反馈点「立即重启」后等太久，以为失败又打开一次，结果打开的是旧版，
// 而且这个旧版占住了 app.asar，替换失败、回滚，升不上去。
// 产品允许多开（main-bootstrap.js 不用单实例锁），所以在最早的启动阶段看一眼：替换脚本还活着（它独占 helper.lock）
// 而且进度在 2 分钟内更新过，就留一个「用户又点了」的标记让进度小窗跳到最前面，然后本进程立即退出，不建窗口、不占文件。
// 任何一步读不出来都当作没在升级，照常启动——这里出错不能把 Hub 打不开。
const fs = require('fs');
const path = require('path');

const FRESH_MS = 120000;

function readProgress(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'progress.json'), 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

// helper.lock 被替换脚本以「不共享」方式打开；脚本结束（包括被结束）系统就会放开。
// 只认共享冲突（Windows 的 ERROR_SHARING_VIOLATION，Node 报 EBUSY）。没权限（EPERM/EACCES）说明不了有脚本在跑，
// 以前也当成「在升级」，残留进度又还新鲜时正常启动会被拦下退出（2026-11-13 审查返工）；现在放行。
function lockHeld(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); return false; }
  catch (error) { return !!error && error.code === 'EBUSY'; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}

function runningUpgrade(dataDir, { now = Date.now() } = {}) {
  if (!dataDir) return null;
  const root = path.join(dataDir, 'app-update');
  const progress = readProgress(root);
  if (!progress || !['running', 'failed'].includes(progress.state)) return null;
  const updated = Date.parse(progress.updatedAt || '');
  if (!Number.isFinite(updated) || now - updated > FRESH_MS || updated - now > FRESH_MS) return null;
  if (!lockHeld(path.join(root, 'helper.lock'))) return null;
  return progress;
}

// 返回 true 表示已交给进度小窗，调用方应立即退出。
function deferToRunningUpgrade({ dataDir, now = Date.now(), pid = process.pid } = {}) {
  try {
    const progress = runningUpgrade(dataDir, { now });
    if (!progress) return false;
    fs.writeFileSync(path.join(dataDir, 'app-update', 'focus-request.flag'), JSON.stringify({ at: new Date(now).toISOString(), pid }), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { runningUpgrade, deferToRunningUpgrade, lockHeld, FRESH_MS };
