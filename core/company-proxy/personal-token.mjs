import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT = `$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
  $cipher=[Console]::In.ReadToEnd()
  $bytes=[Convert]::FromBase64String($cipher)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $utf8=[Text.UTF8Encoding]::new($false,$true)
  [Console]::Out.Write($utf8.GetString($plain))
  exit 0
} catch { exit 1 }
`;
const DPAPI_HEADER = Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb','hex');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

function fail(code) {
  const error = new Error(code);
  error.name = 'PersonalAccessTokenError';
  error.code = code;
  return error;
}
function validCiphertext(value) {
  if (typeof value !== 'string' || value.length > MAX_FILE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value,'base64');
  return bytes.toString('base64') === value && bytes.subarray(0,DPAPI_HEADER.length).equals(DPAPI_HEADER);
}
function safeToken(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_TOKEN_BYTES && !/[\x00-\x20\x7f]/.test(value);
}

// Dependency injection is for local synthetic tests. Production uses the fixed Windows executable and static script.
export function createDpapiDecryptor({ spawnProcess = spawn } = {}) {
  return function decrypt(ciphertext, { signal, timeoutMs = 10000 } = {}) {
    if (!validCiphertext(ciphertext)) return Promise.reject(fail('ACCESS_TOKEN_CIPHERTEXT_INVALID'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) return Promise.reject(fail('ACCESS_TOKEN_TIMEOUT_INVALID'));
    if (signal?.aborted) return Promise.reject(fail('ACCESS_TOKEN_ABORTED'));
    return new Promise((resolve,reject) => {
      let child, timer, settled = false, output = [], outputBytes = 0;
      const clearOutput = () => { for (const buffer of output) buffer.fill(0); output = []; outputBytes = 0; };
      const detach = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); };
      const cleanup = () => {
        let failed = false;
        for (const pipe of [child?.stdin,child?.stdout,child?.stderr]) {
          try { pipe?.destroy(); } catch { failed = true; }
        }
        try { if (child?.kill() === false && child.exitCode === null) failed = true; }
        catch { failed = true; }
        return failed;
      };
      let rejection;
      const stop = code => {
        if (settled) return;
        settled = true; detach(); clearOutput();
        rejection = fail(code);
        if (cleanup()) rejection.cleanupFailed = true;
        reject(rejection);
      };
      const abort = () => stop('ACCESS_TOKEN_ABORTED');
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => stop('ACCESS_TOKEN_DECRYPT_TIMEOUT'),timeoutMs);
      try {
        child = spawnProcess(POWERSHELL,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',SCRIPT],{
          windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'],
        });
        child.on('error',() => stop('ACCESS_TOKEN_DECRYPT_FAILED'));
        child.stdin.on('error',() => stop('ACCESS_TOKEN_DECRYPT_FAILED'));
        child.stdout.on('error',() => stop('ACCESS_TOKEN_DECRYPT_FAILED'));
        child.stderr.on('error',() => stop('ACCESS_TOKEN_DECRYPT_FAILED'));
        // Never retain or expose raw stderr, including after cancellation.
        child.stderr.on('data',() => {});
        child.stdout.on('data',chunk => {
          if (settled) return;
          outputBytes += chunk.length;
          if (outputBytes > MAX_TOKEN_BYTES) { stop('ACCESS_TOKEN_DECRYPT_FAILED'); return; }
          output.push(Buffer.from(chunk));
        });
        child.on('close',code => {
          if (settled) return;
          if (code !== 0) { stop('ACCESS_TOKEN_DECRYPT_FAILED'); return; }
          let token;
          let joined;
          try { joined = Buffer.concat(output); token = new TextDecoder('utf-8',{fatal:true}).decode(joined); }
          catch { stop('ACCESS_TOKEN_DECRYPT_FAILED'); return; }
          finally { joined?.fill(0); }
          if (!safeToken(token)) { stop('ACCESS_TOKEN_DECRYPT_FAILED'); return; }
          settled = true; detach(); clearOutput(); resolve(token);
        });
        // Abort can occur inside an injected launcher before it returns.
        if (settled || signal?.aborted) {
          if (!settled) abort();
          else if (cleanup() && rejection) rejection.cleanupFailed = true;
          return;
        }
        child.stdin.end(ciphertext,'ascii');
      } catch { stop('ACCESS_TOKEN_DECRYPT_FAILED'); }
    });
  };
}

const decryptDefault = createDpapiDecryptor();
export function createPersonalAccessTokenReader({ decryptAccessToken = decryptDefault } = {}) {
  return async function readPersonalAccessToken({ credentialPath, expiryUnit, minValidityMs = 60000, timeoutMs = 10000, signal, nowMs = Date.now() } = {}) {
    const began = performance.now();
    // Windows local-drive syntax only: reject UNC and device namespaces before any filesystem access.
    if (typeof credentialPath !== 'string' || !/^[A-Za-z]:[\\/]/.test(credentialPath)
      || credentialPath.slice(2).includes(':')) throw fail('CREDENTIAL_PATH_REQUIRED');
    if (expiryUnit !== 'milliseconds' && expiryUnit !== 'seconds') throw fail('EXPIRY_UNIT_REQUIRED');
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(minValidityMs) || minValidityMs < 0) throw fail('EXPIRY_POLICY_INVALID');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw fail('ACCESS_TOKEN_TIMEOUT_INVALID');
    if (signal?.aborted) throw fail('ACCESS_TOKEN_ABORTED');
    let raw, parsed;
    try { raw = await readFile(credentialPath,{signal}); }
    catch { throw fail(signal?.aborted ? 'ACCESS_TOKEN_ABORTED' : 'CREDENTIAL_READ_FAILED'); }
    try {
      if (raw.length > MAX_FILE_BYTES) throw fail('CREDENTIAL_FORMAT_INVALID');
      parsed = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw).replace(/^\uFEFF/,''));
    } catch { throw fail('CREDENTIAL_FORMAT_INVALID'); }
    finally { raw.fill(0); }
    // Do not enumerate, copy, return, decrypt, or otherwise access refreshToken or alternate OAuth records.
    const personal = parsed?.devUCOAuth;
    if (!personal || typeof personal !== 'object' || Array.isArray(personal)) throw fail('PERSONAL_AUTH_TYPE_UNSUPPORTED');
    const expiresAt = personal.expiresAt;
    const ciphertext = personal.accessToken;
    parsed = undefined;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw fail('EXPIRY_VALUE_INVALID');
    const expiresAtMs = expiryUnit === 'seconds' ? expiresAt * 1000 : expiresAt;
    if (!Number.isSafeInteger(expiresAtMs)) throw fail('EXPIRY_VALUE_INVALID');
    const ensureValidExpiry = () => {
      if (expiresAtMs - (nowMs + performance.now() - began) <= minValidityMs) throw fail('ACCESS_TOKEN_EXPIRED_OR_NEAR_EXPIRY');
    };
    ensureValidExpiry();
    if (!validCiphertext(ciphertext)) throw fail('ACCESS_TOKEN_CIPHERTEXT_INVALID');
    if (signal?.aborted) throw fail('ACCESS_TOKEN_ABORTED');
    let token;
    try { token = await decryptAccessToken(ciphertext,{signal,timeoutMs}); }
    catch (error) {
      const safe = fail(signal?.aborted || error?.code === 'ACCESS_TOKEN_ABORTED' ? 'ACCESS_TOKEN_ABORTED'
        : error?.code === 'ACCESS_TOKEN_DECRYPT_TIMEOUT' ? 'ACCESS_TOKEN_DECRYPT_TIMEOUT' : 'ACCESS_TOKEN_DECRYPT_FAILED');
      if (error?.cleanupFailed === true) safe.cleanupFailed = true;
      throw safe;
    }
    if (signal?.aborted) throw fail('ACCESS_TOKEN_ABORTED');
    ensureValidExpiry();
    if (!safeToken(token)) throw fail('ACCESS_TOKEN_DECRYPT_FAILED');
    return token; // Internal provider handoff only. Never log or persist this return value.
  };
}
export const readPersonalAccessToken = createPersonalAccessTokenReader();
