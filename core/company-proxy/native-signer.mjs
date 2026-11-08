// Hub-owned binding for the installed CodeAgent native signer. No adapter archive,
// native binary, endpoint or credential is distributed with this module.
import { lstat, readFile, readdir, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DLL = 'libsnap_engine.dll', FFI = 'koffi.node';
const fail = code => Object.assign(new Error(code), { code });
async function plainFile(file, maxBytes = 128 * 1024 * 1024) {
  try { const s = await lstat(file); return s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= maxBytes ? s : null; }
  catch { return null; }
}
async function pair(dir) {
  try {
    const s = await lstat(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) return null;
    const dll = join(dir, DLL), ffi = join(dir, FFI), info = await plainFile(dll);
    return info && await plainFile(ffi) ? { dll, ffi, mtimeMs: info.mtimeMs } : null;
  } catch { return null; }
}

async function loadedPair(files, codeagentDir, tempDir) {
  if (!files || ![files.dll, files.ffi].every(p => typeof p === 'string' && isAbsolute(p))) return null;
  const dir = dirname(resolve(files.dll));
  if (basename(files.dll).toLowerCase() !== DLL || basename(files.ffi).toLowerCase() !== FFI ||
      dirname(resolve(files.ffi)).toLowerCase() !== dir.toLowerCase()) return null;
  // Accept only the current installation's known cache layout or this probe's
  // isolated TEMP. Paths are observed in the live CLI, never selected by mtime.
  const roots = [codeagentDir && join(codeagentDir, 'temp', 'codeagent'), tempDir].filter(Boolean);
  const root = roots.find(base => /^signer-x64-win32-[A-Za-z0-9._-]+$/.test(relative(resolve(base), dir)));
  if (!root) return null;
  const stop = codeagentDir && root === join(codeagentDir, 'temp', 'codeagent') ? resolve(codeagentDir) : resolve(root);
  for (let cursor = dir; ; cursor = dirname(cursor)) {
    try { const s = await lstat(cursor); if (!s.isDirectory() || s.isSymbolicLink()) return null; } catch { return null; }
    if (cursor.toLowerCase() === stop.toLowerCase()) break;
    if (dirname(cursor) === cursor) return null;
  }
  return pair(dir);
}

export async function findNativeRuntime({ codeagentDir, runtimeDir, tempDir } = {}) {
  for (const dir of [runtimeDir, codeagentDir && join(codeagentDir, 'bin')].filter(Boolean)) {
    const hit = await pair(dir); if (hit) return hit;
  }
  if (!tempDir) return null;
  try {
    const candidates = [];
    for (const entry of await readdir(tempDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^signer-x64-win32-[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      const hit = await pair(join(tempDir, entry.name)); if (hit) candidates.push(hit);
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
  } catch { return null; }
}

// Preserve the isolated CLI's pair, or the pair in that CLI's installation.
// Never select an unrelated runtime from the ambient TEMP directory.
// The probe's answers/logs remain temporary and are removed by native-stamp.mjs.
export async function retainNativeRuntime(tempDir, runtimeDir, { codeagentDir, loadRuntime } = {}) {
  if (await pair(runtimeDir)) return;
  let source = await findNativeRuntime({ tempDir }) || await findNativeRuntime({ codeagentDir });
  if (!source && typeof loadRuntime === 'function') source = await loadedPair(await loadRuntime(), codeagentDir, tempDir);
  if (!source) throw fail('SIGNER_NATIVE_FILES_MISSING');
  await mkdir(dirname(runtimeDir), { recursive: true });
  const staging = runtimeDir + '.part-' + randomUUID();
  await mkdir(staging);
  let backup = null;
  try {
    await copyFile(source.dll, join(staging, DLL));
    await copyFile(source.ffi, join(staging, FFI));
    // Recover an interrupted version cache as a whole pair. Never combine a stale
    // DLL with a newly extracted FFI module, and preserve the old directory.
    let existing;
    try { existing = await lstat(runtimeDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw fail('SIGNER_NATIVE_CACHE_INVALID');
      if (await pair(runtimeDir)) return;
      for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
        if (![DLL, FFI].includes(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw fail('SIGNER_NATIVE_CACHE_INVALID');
      }
      const candidate = runtimeDir + '.incomplete-' + randomUUID();
      try { await rename(runtimeDir, candidate); backup = candidate; }
      catch (e) { if (await pair(runtimeDir)) return; if (e.code !== 'ENOENT') throw e; }
    }
    try { await rename(staging, runtimeDir); }
    catch (e) {
      if (await pair(runtimeDir)) return; // Another initializer completed the same version.
      if (backup) {
        let absent = false;
        try { await lstat(runtimeDir); } catch (error) { absent = error.code === 'ENOENT'; }
        if (absent) await rename(backup, runtimeDir).catch(() => {});
      }
      throw e;
    }
  } finally {
    // This is this invocation's newly-created staging directory only.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export function createNativeSigner({ version, cacheDir, codeagentDir, runtimeDir,
  tempDir = process.env.TEMP || process.env.TMP, appId, telemetryUrl = '',
  loadLibrary = files => require(files.ffi).load(files.dll) } = {}) {
  let lib = null, sign = null, kernel = '', available = false, pending = null;
  const cleanup = () => {
    available = false; sign = null;
    try { lib?.unload(); } catch { /* process exit is the final native cleanup */ }
    lib = null;
  };
  async function initialize() {
    if (!/^\d+(?:\.\d+){1,5}$/.test(version || '') || !/^[A-Za-z0-9._-]{3,200}$/.test(appId || '')
        || typeof codeagentDir !== 'string' || !isAbsolute(codeagentDir) || typeof cacheDir !== 'string' || !isAbsolute(cacheDir)) throw fail('SIGNER_CONFIGURATION_INVALID');
    if (telemetryUrl) {
      let u; try { u = new URL(telemetryUrl); } catch { throw fail('SIGNER_CONFIGURATION_INVALID'); }
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw fail('SIGNER_CONFIGURATION_INVALID');
    }
    if (!await plainFile(join(codeagentDir, 'bin', 'codeagentcli.exe'), 512 * 1024 * 1024)) throw fail('SIGNER_CODEAGENT_MISSING');
    const file = join(cacheDir, 'codeagent-version-stamp');
    if (!await plainFile(file, 512)) throw fail('SIGNER_STAMP_INVALID');
    const lines = (await readFile(file, 'utf8')).trimEnd().split(/\r?\n/);
    if (lines.length !== 2 || lines[0] !== version || !/^\d{1,64}$/.test(lines[1])) throw fail('SIGNER_STAMP_INVALID');
    kernel = `${version}-win32-x64-${lines[1]}`;
    const files = await findNativeRuntime({ codeagentDir, runtimeDir, tempDir });
    if (!files) throw fail('SIGNER_NATIVE_FILES_MISSING');
    try {
      lib = loadLibrary(files);
      const create = lib.func('int snapengine_signer_create(const char *config)');
      sign = lib.func('int snapengine_signer_sign_request(const char *request, void *output)');
      const rc = create(JSON.stringify({ user_id: 'u', kernel_version: kernel, app_id: appId,
        plugin_path: '', plugin_version: '', telemetry_base_url: telemetryUrl }));
      if (rc !== 0) throw fail('SIGNER_NATIVE_CREATE_FAILED');
      available = true;
      return true;
    } catch (error) { cleanup(); throw fail(error.code === 'SIGNER_NATIVE_CREATE_FAILED' ? error.code : 'SIGNER_NATIVE_LOAD_FAILED'); }
  }
  return {
    init() {
      if (available) return Promise.resolve(true);
      if (!pending) pending = initialize().finally(() => { pending = null; });
      return pending;
    },
    isAvailable: () => available,
    codeagentVersion: () => version,
    kernelVersion: () => kernel,
    async signHash3(authToken, modelId = '') {
      if (!available || !sign) throw fail('SIGNER_UNAVAILABLE');
      if (typeof authToken !== 'string' || !authToken || authToken.length > 65536 || /[\r\n\0]/.test(authToken)
          || typeof modelId !== 'string' || modelId.length > 200) throw fail('SIGNER_REQUEST_INVALID');
      const timestamp = String(Date.now()), traceId = randomUUID().replaceAll('-', ''),
        spanId = randomUUID().replaceAll('-', '').slice(0, 16), traceUuid = randomUUID();
      const output = Buffer.alloc(65);
      try {
        const rc = sign(JSON.stringify({ auth_token: authToken, timestamp, trace_id: traceId, span_id: spanId, model_id: modelId }), output);
        if (rc !== 0) throw fail('SIGNER_NATIVE_SIGN_FAILED');
        const hash3 = output.subarray(0, 64).toString('latin1');
        if (!/^[a-fA-F0-9]{64}$/.test(hash3) || output[64] !== 0) throw fail('SIGNER_NATIVE_OUTPUT_INVALID');
        return { hash3, timestamp, spanId, traceId, traceUuid };
      } catch (error) {
        throw fail(['SIGNER_NATIVE_SIGN_FAILED', 'SIGNER_NATIVE_OUTPUT_INVALID'].includes(error.code) ? error.code : 'SIGNER_NATIVE_SIGN_FAILED');
      } finally { output.fill(0); }
    },
    cleanup,
  };
}
