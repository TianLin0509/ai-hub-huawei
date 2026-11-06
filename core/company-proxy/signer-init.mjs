import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { win32 } from 'node:path';

const publicErrors = new WeakSet();
let active = null;
const failure = (code, scope) => {
  const spawnSummary = Object.freeze({
    registryAllowed: scope?.registryAllowed ?? 0,
    cliBlocked: scope?.cliBlocked ?? 0,
    otherBlocked: scope?.otherBlocked ?? 0,
    cliAllowed: scope?.cliAllowed ?? 0,
  });
  const error = Object.freeze(Object.assign(new Error(code), { code, spawnSummary }));
  publicErrors.add(error); return error;
};
const requireCondition = (condition, code) => { if (!condition) throw failure(code); };

function exactRegistryQuery(codeagentDir) {
  const target = codeagentDir.replaceAll('/', '\\').replaceAll("'", "''");
  // Q2 r14: vendor's name-based First 1 selected Desktop. Keep real registry
  // values, selecting exactly one installation matching the caller's CLI dir.
  return String.raw`$ErrorActionPreference='Stop';try{
$target='${target}'.Trim().Replace('/','\').TrimEnd([char[]]'\/');$cliCandidates=@();
foreach($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')){
  if(Test-Path -LiteralPath $root){foreach($key in Get-ChildItem -LiteralPath $root){
    $value=Get-ItemProperty -LiteralPath $key.PSPath;
    if($value.InstallLocation -is [string]){
      $location=$value.InstallLocation.Trim();
      if($location.Replace('/','\').TrimEnd([char[]]'\/') -eq $target){
        $cliCandidates+=@{installLocation=$location;displayVersion=$value.DisplayVersion};
      }
    }
  }}
}
if($cliCandidates.Count -ne 1 -or $cliCandidates[0].displayVersion -isnot [string] -or [string]::IsNullOrWhiteSpace($cliCandidates[0].displayVersion)){throw 'INVALID_SELECTION'};
$record=@{installLocation=$cliCandidates[0].installLocation;displayVersion=$cliCandidates[0].displayVersion.Trim()};
ConvertTo-Json -InputObject $record -Compress;exit 0
}catch{[Console]::Error.WriteLine('SIGNER_REGISTRY_QUERY_FAILED');exit 1}`;
}

function allowedRegistrySpawn(command, args, options) {
  if (typeof command !== 'string') return false;
  const executable = command.replaceAll('\\', '/').toLowerCase();
  return (executable === 'powershell.exe' || executable === 'c:/windows/system32/windowspowershell/v1.0/powershell.exe') &&
    Array.isArray(args) && args.length === 4 && args[0] === '-NoProfile' &&
    args[1] === '-NonInteractive' && args[2] === '-Command' &&
    typeof args[3] === 'string' && args[3].length > 0 && !args[3].includes('\0') &&
    options !== null && typeof options === 'object' && options.windowsHide === true &&
    (options.shell === undefined || options.shell === false);
}

// Variables of the proxy process that the CodeAgent CLI must not inherit.
const CLI_ENV_DROP = ['AI_HUB_COMPANY_PROXY_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

// First-time initialization only: exactly one run of <codeagentDir>\bin\codeagentcli.exe with plain string
// arguments. Whatever the signer passed, it runs hidden (windowsHide true), without a shell, not detached,
// and is killed by the init timeout. Nothing else becomes allowed.
function stampProbeSpawn(scope, command, args, options) {
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string' && !a.includes('\0'))) return null;
  const base = options !== null && typeof options === 'object' ? options : {};
  const env = { ...(base.env && typeof base.env === 'object' ? base.env : process.env) };
  for (const name of CLI_ENV_DROP) delete env[name];
  scope.cliAllowed++;
  let child;
  try { child = Reflect.apply(scope.delegate, childProcess, [command, [...args], { ...base, env, windowsHide: true, shell: false, detached: false }]); }
  catch { scope.cliFailed = true; throw failure('SIGNER_INIT_CLI_FAILED', scope); }
  scope.cliChild = child;
  child?.once?.('error', () => { scope.cliFailed = true; });
  return child;
}

// Only the SHA-verified signer's known spawn paths are in scope. This is not a
// sandbox for arbitrary modules/PowerShell scripts or DLL internals. CJS modules
// may retain this wrapper; consult the current scope so sequential init works.
function scopedSpawn(command, args, options) {
  const scope = active;
  if (!scope) throw failure('SIGNER_INIT_SCOPE_CLOSED');
  let allowed = false;
  try { allowed = allowedRegistrySpawn(command, args, options); } catch { allowed = false; }
  if (!allowed && scope.allowStampProbe && scope.cliAllowed === 0 && typeof command === 'string' &&
      command.replaceAll('\\', '/').toLowerCase() === scope.cliCommand) {
    const child = stampProbeSpawn(scope, command, args, options);
    if (child) return child;
  }
  if (!allowed) {
    scope.blocked = true;
    if (typeof command === 'string' && command.replaceAll('\\', '/').toLowerCase() === scope.cliCommand) scope.cliBlocked++;
    else scope.otherBlocked++;
    throw failure('SIGNER_INIT_SPAWN_BLOCKED', scope);
  }
  scope.registryAllowed++;
  try { return Reflect.apply(scope.delegate, childProcess, [command, [...args.slice(0, 3), scope.registryScript], options]); }
  catch {
    scope.spawnFailed = true;
    throw failure('SIGNER_INIT_REGISTRY_SPAWN_FAILED', scope);
  }
}

const withTimeout = (promise, ms, scope) => {
  if (!(ms > 0)) return promise;
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => {
      scope.timedOut = true;
      try { scope.cliChild?.kill?.(); } catch { /* already gone */ }
      reject(failure('SIGNER_INIT_TIMEOUT', scope));
    }, ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
};

/**
 * Dedicated probe process only; do not concurrently run other child-process work.
 * allowStampProbe: the cache is known to be missing or stale, so the signer's own first-time
 * initialization may run the CodeAgent CLI once (see stampProbeSpawn). timeoutMs bounds init + isAvailable.
 * onSummary receives the spawn counters once init is over (success or failure).
 * Caller verifies package SHA, registry version and real cache, then sets only
 * this process's signer auth-dir variable (named by the upstream profile) before calling. No environment/files are changed
 * here. testOnlySpawnDelegate is never enabled by the production caller.
 */
export async function initializeCacheOnlySigner(options = {}) {
  if (active) throw failure('SIGNER_INIT_BUSY');
  const scope = { blocked: false, spawnFailed: false, delegate: null,
    cliCommand: null, registryScript: null, registryAllowed: 0, cliBlocked: 0, otherBlocked: 0,
    allowStampProbe: options.allowStampProbe === true, cliAllowed: 0, cliFailed: false, cliChild: null, timedOut: false };
  active = scope;
  const originalSpawn = childProcess.spawn;
  let installed = false;
  try {
    const { loadSigner, codeagentDir, testOnly = false, testOnlySpawnDelegate, timeoutMs = 0 } = options;
    requireCondition(typeof loadSigner === 'function' && typeof codeagentDir === 'string' &&
      /^[A-Za-z]:[\\/]/.test(codeagentDir) && win32.isAbsolute(codeagentDir) && !codeagentDir.includes('\0'),
      'SIGNER_INIT_CONFIGURATION_INVALID');
    requireCondition(testOnlySpawnDelegate === undefined ||
      (testOnly === true && typeof testOnlySpawnDelegate === 'function'), 'SIGNER_INIT_CONFIGURATION_INVALID');
    scope.cliCommand = win32.join(codeagentDir, 'bin', 'codeagentcli.exe').replaceAll('\\', '/').toLowerCase();
    scope.registryScript = exactRegistryQuery(codeagentDir);
    scope.delegate = testOnlySpawnDelegate ?? originalSpawn;
    childProcess.spawn = scopedSpawn; installed = true; syncBuiltinESMExports();
    const signer = await loadSigner();
    requireCondition(signer && typeof signer.init === 'function' && typeof signer.isAvailable === 'function',
      'SIGNER_INIT_MODULE_INVALID');
    const initialized = await withTimeout(Promise.resolve(signer.init(codeagentDir)), timeoutMs, scope);
    if (scope.blocked) throw failure('SIGNER_INIT_SPAWN_BLOCKED', scope);
    if (scope.spawnFailed) throw failure('SIGNER_INIT_REGISTRY_SPAWN_FAILED', scope);
    requireCondition(initialized === true, 'SIGNER_INIT_REJECTED');
    const available = await withTimeout(Promise.resolve(signer.isAvailable()), timeoutMs, scope);
    if (scope.blocked) throw failure('SIGNER_INIT_SPAWN_BLOCKED', scope);
    if (scope.spawnFailed) throw failure('SIGNER_INIT_REGISTRY_SPAWN_FAILED', scope);
    requireCondition(available === true, 'SIGNER_INIT_UNAVAILABLE');
    return signer;
  } catch (error) {
    if (scope.timedOut) throw failure('SIGNER_INIT_TIMEOUT', scope);
    if (scope.blocked) throw failure('SIGNER_INIT_SPAWN_BLOCKED', scope);
    if (scope.spawnFailed) throw failure('SIGNER_INIT_REGISTRY_SPAWN_FAILED', scope);
    if (publicErrors.has(error)) throw failure(error.code, scope);
    throw failure('SIGNER_INIT_FAILED', scope);
  } finally {
    try {
      if (installed) { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
    } catch { throw failure('SIGNER_INIT_RESTORE_FAILED', scope); }
    finally {
      active = null;
      try { options.onSummary?.({ registryAllowed: scope.registryAllowed, cliAllowed: scope.cliAllowed, cliBlocked: scope.cliBlocked,
        otherBlocked: scope.otherBlocked, cliFailed: scope.cliFailed, timedOut: scope.timedOut }); } catch { /* report only */ }
    }
  }
}
