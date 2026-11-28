'use strict';

const fs = require('fs');
const path = require('path');
const { execFile: execFileCallback } = require('child_process');
const { promisify } = require('util');

const { sharedOffMainExecFile } = require('./off-main-exec.js');

const execFileAsync = promisify(execFileCallback);

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function parseNvidiaCsv(stdout) {
  const first = String(stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!first) return null;
  const fields = first.split(',').map(value => value.trim());
  if (fields.length < 5) return null;
  const usedMiB = Number(fields[2]);
  const totalMiB = Number(fields[3]);
  return {
    name: fields[0] || 'NVIDIA GPU',
    usagePct: clampPercent(fields[1]),
    memoryUsedBytes: Number.isFinite(usedMiB) ? Math.round(usedMiB * 1024 * 1024) : null,
    memoryTotalBytes: Number.isFinite(totalMiB) ? Math.round(totalMiB * 1024 * 1024) : null,
    temperatureC: Number.isFinite(Number(fields[4])) ? Math.round(Number(fields[4])) : null,
    source: 'nvidia-smi',
  };
}

function localDiskRoot(cwd = process.cwd()) {
  const resolved = path.resolve(cwd || process.cwd());
  return path.parse(resolved).root || resolved;
}

// 没有 D 盘的电脑读不到就跳过，只显示 C 盘（和以前一样）。
function localDiskRoots(cwd = process.cwd(), platform = process.platform) {
  const current = localDiskRoot(cwd);
  if (platform !== 'win32') return [current];
  return [...new Set(['C:\\', 'D:\\', current.toUpperCase()])].sort();
}

function createSystemTelemetry(options = {}) {
  // nvidia-smi is started from a worker thread: creating the process blocks
  // the calling thread on Windows (see core/off-main-exec.js).
  const execFile = options.execFile || (options.offMain === false ? execFileAsync : sharedOffMainExecFile());
  const statfs = options.statfs || fs.promises.statfs.bind(fs.promises);
  const now = options.now || Date.now;
  const cwd = options.cwd || process.cwd;
  const platform = options.platform || process.platform;
  const diskTimeoutMs = Math.max(100, Number(options.diskTimeoutMs) || 3_000);
  // nvidia-smi is a separate process. A 10 s cache still feels live while
  // avoiding a process spawn on every 3 s renderer resource tick.
  const gpuTtlMs = Math.max(1_000, Number(options.gpuTtlMs) || 10_000);
  const gpuFailureTtlMs = 10 * 60_000;
  const diskTtlMs = Math.max(5_000, Number(options.diskTtlMs) || 60_000);
  let gpuCache = null;
  let diskCache = null;
  let gpuPending = null;
  let diskPending = null;

  async function sampleGpu(force = false) {
    const at = now();
    if (!force && gpuCache && at - gpuCache.sampledAt < (gpuCache.value ? gpuTtlMs : gpuFailureTtlMs)) return gpuCache.value;
    if (gpuPending) return gpuPending;
    gpuPending = (async () => {
      let value = null;
      try {
        const result = await execFile('nvidia-smi', [
          '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
          '--format=csv,noheader,nounits',
        ], { windowsHide: true, timeout: 2_500, maxBuffer: 128 * 1024 });
        value = parseNvidiaCsv(result && result.stdout);
      } catch {
        value = null;
      }
      gpuCache = { sampledAt: now(), value };
      return value;
    })().finally(() => { gpuPending = null; });
    return gpuPending;
  }

  async function sampleVolume(root) {
    let timer;
    try {
      // 读不到（光驱没盘、映射盘断开）或卡住的盘跳过，不能把底栏唯一一次在途采样一直占住。
      const stats = await Promise.race([
        statfs(root),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('statfs timeout')), diskTimeoutMs); timer.unref?.(); }),
      ]);
      const blockSize = Number(stats.bsize || stats.frsize || 0);
      const totalBytes = blockSize * Number(stats.blocks || 0);
      const freeBytes = blockSize * Number(stats.bavail ?? stats.bfree ?? 0);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      if (!(totalBytes > 0)) return null;
      return {
        root,
        totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
        freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
        usedBytes: Number.isFinite(usedBytes) ? usedBytes : null,
        usagePct: clampPercent(usedBytes / totalBytes * 100),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sampleDisk(force = false) {
    const at = now();
    if (!force && diskCache && at - diskCache.sampledAt < diskTtlMs) return diskCache.value;
    if (diskPending) return diskPending;
    diskPending = (async () => {
      let value = null;
      try {
        // 主盘（Hub 所在盘）的字段照旧放在顶层，老读者不变；volumes 是全部读得到的盘。
        const current = localDiskRoot(cwd());
        const volumes = (await Promise.all(localDiskRoots(cwd(), platform).map(sampleVolume))).filter(Boolean);
        const primary = volumes.find(volume => volume.root.toUpperCase() === current.toUpperCase()) || volumes[0];
        value = primary ? { ...primary, volumes } : null;
      } catch {
        value = null;
      }
      diskCache = { sampledAt: now(), value };
      return value;
    })().finally(() => { diskPending = null; });
    return diskPending;
  }

  async function sample(options = {}) {
    const force = options.force === true;
    const [gpu, disk] = await Promise.all([sampleGpu(force), sampleDisk(force)]);
    return { gpu, disk, telemetrySampledAt: now() };
  }

  return { sample, sampleGpu, sampleDisk };
}

module.exports = {
  clampPercent,
  createSystemTelemetry,
  localDiskRoot,
  localDiskRoots,
  parseNvidiaCsv,
};
