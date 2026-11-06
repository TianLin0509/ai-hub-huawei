import { readPersonalAccessToken } from './personal-token.mjs';
import { createPersonalL1Provider } from './l1-provider.mjs';

// Upstream addresses, the identity answer's field names, the client id and the expected CodeAgent version are
// not compiled in: they come from the local upstream profile (read from the adapter, see upstream-profile.mjs).
const CHAT_PATH = '/api/v2/chat/completions';
const FIELD = /^[A-Za-z_$][\w$]{0,63}$/;
const OWN_ERRORS = new WeakSet();
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function failure(code, status) {
  const error = Object.freeze(Object.assign(new Error(code), { name: 'CompanyPersonalProviderError', code,
    ...(status === undefined ? {} : { status }) }));
  OWN_ERRORS.add(error); return error;
}
function requireFact(ok, code = 'COMPANY_PROVIDER_CONFIGURATION_INVALID') { if (!ok) throw failure(code); }
function requestOptions(options) {
  try { return options === undefined ? {} : { signal: options.signal }; }
  catch { throw failure('COMPANY_CALL_OPTIONS_INVALID'); }
}
const safeHeader = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
  /^[\x20-\x7e\x80-\xff]+$/.test(value) && value.trim() === value;

export function createCompanyPersonalProvider(options) {
  try { return wire(options); }
  catch (error) { throw OWN_ERRORS.has(error) ? error : failure('COMPANY_PROVIDER_CONFIGURATION_INVALID'); }
}

const kernelPattern = version => new RegExp('^' + version.replace(/\./g, '\\.') + '-win32-x64-\\d{1,64}$');
// path null: any path below the root.
const httpsUrl = (value, path) => {
  try { const url = new URL(value); return url.protocol === 'https:' && (path === null ? url.pathname.length > 1 : url.pathname === path) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
};
const REGION = /^[A-Za-z]$/;

function wire({ signer, readAccessToken = readPersonalAccessToken, fetchImpl = globalThis.fetch,
  identityUrl: configuredIdentityUrl, chatUrl: configuredChatUrl, appId, expectedVersion, credentialPath,
  onDiagnostic = event => process.stderr.write(event.code + '\n'), identityTimeoutMs = 10000,
  maxIdentityBytes = 128 * 1024, testOnlyLoopbackOrigin, experimentalNativeThinking = false, experimentalCodexControls = false,
  beforeGenerationDispatch, upstreamSessionId, identityAccountField, identityDeptField = '', testOnlyIdentityPath = '/identity', onIdentityRegion } = {}) {
  requireFact(typeof identityAccountField === 'string' && FIELD.test(identityAccountField) && typeof identityDeptField === 'string' &&
    (identityDeptField === '' || FIELD.test(identityDeptField)), 'COMPANY_IDENTITY_FIELDS_UNCONFIGURED');
  requireFact(onIdentityRegion === undefined || typeof onIdentityRegion === 'function');
  requireFact(object(signer) && typeof readAccessToken === 'function' && typeof fetchImpl === 'function' && typeof onDiagnostic === 'function');
  requireFact(beforeGenerationDispatch === undefined || typeof beforeGenerationDispatch === 'function');
  requireFact(typeof experimentalNativeThinking === 'boolean');
  requireFact(typeof experimentalCodexControls === 'boolean' && (!experimentalCodexControls || experimentalNativeThinking));
  requireFact(Number.isSafeInteger(identityTimeoutMs) && identityTimeoutMs > 0 && identityTimeoutMs <= 30000);
  requireFact(Number.isSafeInteger(maxIdentityBytes) && maxIdentityBytes > 0 && maxIdentityBytes <= 1024 * 1024);
  requireFact(typeof signer.isAvailable === 'function' && typeof signer.codeagentVersion === 'function' &&
    typeof signer.kernelVersion === 'function' && typeof signer.signHash3 === 'function');
  requireFact(signer.isAvailable() === true, 'COMPANY_SIGNER_UNAVAILABLE');
  requireFact(typeof expectedVersion === 'string' && /^\d+(?:\.\d+){1,5}$/.test(expectedVersion));
  requireFact(typeof appId === 'string' && appId.length > 0 && appId.length <= 200 && safeHeader(appId));
  const version = signer.codeagentVersion(), kernel = signer.kernelVersion(), sign = signer.signHash3.bind(signer);
  requireFact(version === expectedVersion, 'COMPANY_SIGNER_VERSION_UNVERIFIED');
  requireFact(typeof kernel === 'string' && kernelPattern(expectedVersion).test(kernel), 'COMPANY_KERNEL_UNVERIFIED');
  let identityUrl = configuredIdentityUrl, chatUrl = configuredChatUrl;
  if (testOnlyLoopbackOrigin !== undefined) {
    const url = new URL(testOnlyLoopbackOrigin);
    requireFact(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'COMPANY_TEST_ENDPOINT_INVALID');
    requireFact(typeof testOnlyIdentityPath === 'string' && /^\/[A-Za-z0-9_./-]{1,200}$/.test(testOnlyIdentityPath), 'COMPANY_TEST_ENDPOINT_INVALID');
    identityUrl = url.origin + testOnlyIdentityPath; chatUrl = url.origin + CHAT_PATH;
  } else {
    requireFact(httpsUrl(identityUrl, null) && httpsUrl(chatUrl, CHAT_PATH), 'COMPANY_ENDPOINT_UNCONFIGURED');
  }
  const state = { identityRequests: 0, identityStatus: null, generationRequests: 0,
    signatureCalls: 0, stage: 'ready', errorCode: null, diagnosticFailures: 0 };
  const observerFailed = () => {
    state.diagnosticFailures++;
    try { process.stderr.write('COMPANY_DIAGNOSTIC_OBSERVER_FAILED\n'); }
    catch { /* The fixed snapshot counter remains observable even if stderr fails. */ }
  };
  const notify = code => {
    try { Promise.resolve(onDiagnostic(Object.freeze({ code }))).catch(observerFailed); }
    catch { observerFailed(); }
  };
  const discard = operation => {
    // Cleanup must never extend the request deadline. Its eventual failure is still observable.
    let ended = false;
    const timer = setTimeout(() => { if (!ended) notify('COMPANY_IDENTITY_CLEANUP_TIMEOUT'); }, 100);
    Promise.resolve().then(operation).then(() => { ended = true; clearTimeout(timer); },
      () => { ended = true; clearTimeout(timer); notify('COMPANY_IDENTITY_CLEANUP_FAILED'); });
  };
  const identity = async (token, { signal } = {}) => {
    const controller = new AbortController();
    let timedOut = false, response, reader, timer;
    const chunks = [];
    const abort = () => controller.abort();
    const stage = (operation, late) => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(failure(timedOut ? 'COMPANY_IDENTITY_TIMEOUT' : 'COMPANY_IDENTITY_ABORTED')); return; }
      let settled = false;
      const cancelled = () => { if (!settled) { settled = true; reject(failure(timedOut ? 'COMPANY_IDENTITY_TIMEOUT' : 'COMPANY_IDENTITY_ABORTED')); } };
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw failure('COMPANY_IDENTITY_ABORTED');
        return operation();
      }).then(value => {
        controller.signal.removeEventListener('abort', cancelled);
        if (settled) { late?.(value); return; }
        settled = true; resolve(value);
      }, () => {
        controller.signal.removeEventListener('abort', cancelled);
        if (!settled) { settled = true; reject(failure('COMPANY_IDENTITY_REQUEST_FAILED')); }
      });
    });
    try {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { timedOut = true; abort(); }, identityTimeoutMs);
      state.stage = 'identity';
      response = await stage(() => {
        state.identityRequests++;
        return fetchImpl(identityUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token, Accept: 'application/json' },
          body: '{}', redirect: 'error', signal: controller.signal });
      }, value => {
        notify('COMPANY_IDENTITY_LATE_RESPONSE_DISCARDED'); discard(() => value?.body?.cancel());
      });
      requireFact(response instanceof Response, 'COMPANY_IDENTITY_HTTP_FAILED');
      const status = response.status;
      state.identityStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      requireFact(status === 200, 'COMPANY_IDENTITY_HTTP_FAILED');
      requireFact(response.body, 'COMPANY_IDENTITY_BODY_INVALID');
      reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const { value, done } = await stage(() => reader.read()); if (done) break;
        size += value.byteLength; requireFact(size <= maxIdentityBytes, 'COMPANY_IDENTITY_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      requireFact(!controller.signal.aborted, timedOut ? 'COMPANY_IDENTITY_TIMEOUT' : 'COMPANY_IDENTITY_ABORTED');
      let detail;
      const joined = Buffer.concat(chunks);
      try { detail = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
      catch { throw failure('COMPANY_IDENTITY_JSON_INVALID'); }
      finally { joined.fill(0); }
      const data = object(detail?.data) ? detail.data : {};
      const account = Object.hasOwn(data, identityAccountField) ? data[identityAccountField] : undefined;
      const deptPath = !identityDeptField || data[identityDeptField] === undefined ? '' : data[identityDeptField];
      requireFact(safeHeader(account) && (deptPath === '' || safeHeader(deptPath)), 'COMPANY_IDENTITY_FIELDS_INVALID');
      // The region letter (y/g/b) the company service reports for this user: only the letter is passed on.
      if (onIdentityRegion && typeof data.region === 'string' && REGION.test(data.region)) { try { onIdentityRegion(data.region.toLowerCase()); } catch { /* observer only */ } }
      return { account, deptPath }; // Original values remain on the company machine, in memory only.
    } catch (error) {
      const safe = controller.signal.aborted ? failure(timedOut ? 'COMPANY_IDENTITY_TIMEOUT' : 'COMPANY_IDENTITY_ABORTED') :
        OWN_ERRORS.has(error) ? error : failure('COMPANY_IDENTITY_REQUEST_FAILED');
      state.errorCode = safe.code;
      notify(safe.code); throw safe;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reader) discard(() => reader.cancel());
      else if (response) discard(() => response.body?.cancel());
      for (const chunk of chunks) chunk.fill(0);
    }
  };
  const provider = createPersonalL1Provider({
    readAccessToken: async ({ signal }) => {
      state.stage = 'credential';
      try { return await readAccessToken({ credentialPath, expiryUnit: 'milliseconds',
        minValidityMs: 120000, timeoutMs: 10000, signal }); }
      catch { state.errorCode = 'COMPANY_ACCESS_TOKEN_FAILED'; throw failure(state.errorCode); }
    },
    getIdentity: identity, signer: { codeagentVersion: version, kernelVersion: kernel,
      signHash3: async (token, model) => {
        state.stage = 'signature'; state.signatureCalls++;
        try {
          const result = await sign(token, model);
          if (result === null) state.errorCode = 'COMPANY_SIGNATURE_INVALID';
          return result;
        } catch { state.errorCode = 'COMPANY_SIGNATURE_FAILED'; throw failure(state.errorCode); }
      } },
    modelMap: { 'GLM-5.2-WX': 'GLM-5.2-WX', 'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash-1017' },
    endpoint: chatUrl, appId, sessionId: upstreamSessionId, experimentalNativeThinking, experimentalCodexControls,
    fetchImpl: async (url, options) => {
      // Trusted factory closure only. No request, token, identity or endpoint is exposed to it.
      // A granted dispatch remains sent/uncertain if cancellation follows the grant.
      if (beforeGenerationDispatch !== undefined) {
        state.stage = 'generation_dispatch';
        if (options.signal?.aborted) {
          state.errorCode = 'COMPANY_GENERATION_ABORTED'; throw failure(state.errorCode);
        }
        let granted;
        try { granted = beforeGenerationDispatch(); }
        catch { state.errorCode = 'COMPANY_DISPATCH_FAILED'; throw failure(state.errorCode); }
        if (granted !== true) {
          // Invalid asynchronous callbacks must not escape as unhandled rejections.
          // The call already fails visibly below; never await or accept their eventual value.
          if ((typeof granted === 'object' && granted !== null) || typeof granted === 'function') {
            Promise.resolve(granted).catch(() => notify('COMPANY_DISPATCH_ASYNC_REJECTED'));
          }
          state.errorCode = granted === false ? 'COMPANY_DISPATCH_DENIED' : 'COMPANY_DISPATCH_RESULT_INVALID';
          throw failure(state.errorCode);
        }
        if (options.signal?.aborted) {
          state.errorCode = 'COMPANY_GENERATION_ABORTED'; throw failure(state.errorCode);
        }
      }
      state.stage = 'generation'; state.generationRequests++;
      try {
        const response = await fetchImpl(url, options);
        if (!options.signal?.aborted) state.stage = 'generation_response';
        return response;
      } catch { state.errorCode = 'COMPANY_GENERATION_REQUEST_FAILED'; throw failure(state.errorCode); }
    },
    testOnlyAllowLoopback: testOnlyLoopbackOrigin !== undefined, onDiagnostic: event => notify(event.code),
  });
  return Object.freeze({
    async listModels(options) {
      try { return await provider.listModels(requestOptions(options)); }
      catch (error) {
        if (OWN_ERRORS.has(error)) throw error;
        let code;
        try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch { /* No external getter is evaluated. */ }
        if (code === 'L1_ABORTED') throw failure('L1_ABORTED', 499);
        throw failure('COMPANY_MODEL_LIST_FAILED');
      }
    },
    async complete(body, options) {
      state.stage = 'request'; state.errorCode = null; state.identityStatus = null;
      let callOptions;
      try { callOptions = requestOptions(options); }
      catch {
        state.errorCode = 'COMPANY_CALL_OPTIONS_INVALID';
        throw failure(state.errorCode);
      }
      try { return await provider.complete(body, callOptions); }
      catch (error) {
        if (!state.errorCode) state.errorCode = 'COMPANY_PROVIDER_FAILED';
        throw error; // Existing provider already returns only its branded fixed errors.
      }
    },
    getProbeState() { return Object.freeze({ ...state }); },
  });
}
