import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { preStreamMessage, upstreamHttpMessage, safeUpstreamDetail, midStreamMessage, errorFrameFor } from './failure-text.mjs';

// Copies a stream into the response without letting a source failure destroy the response (unlike pipeline):
// the caller still has to write the protocol's error frame after the headers.
// `owned` are the upstream streams behind `source` (.pipe() does not pass destroy back to them); they are
// destroyed too, which cancels the upstream body and frees its connection.
async function pump(source, res, signal, owned = []) {
  const { once } = await import('node:events');
  const all = [source, ...owned];
  const stop = () => { for (const s of all) if (!s.destroyed) s.destroy(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of source) {
      signal.throwIfAborted();
      if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      if (res.destroyed) throw signal.reason || new Error('Client disconnected');
    }
  } finally { signal.removeEventListener('abort', stop); for (const s of all) if (!s.destroyed) s.destroy(); }
  res.end();
}

// Watches an OpenAI chat-completions SSE stream as it passes through unchanged.
// complete(): a legal finish_reason was seen, then [DONE], and no error frame or unknown finish_reason.
// Clients such as DSH (pi-ai) close the connection as soon as they have read [DONE]; after complete()
// that is a normal end of the request, before it the request was really cut short.
const LEGAL_FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
const MAX_SSE_LINE = 16 * 1024 * 1024;
export function chatStreamTracker({ requireDone = true } = {}) {
  const decoder = new StringDecoder('utf8');
  const state = { finish: false, done: false, broken: false, doneLine: false };
  let line = '';
  const inspect = raw => {
    const text = raw.trim();
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (data === '[DONE]') { state.doneLine = true; if (state.finish) state.done = true; else state.broken = true; return; }
    if (state.done) { state.broken = true; return; }
    if (!data.includes('finish_reason') && !data.includes('"error"')) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event && typeof event === 'object' && event.error) { state.broken = true; return; }
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      const reason = choice?.finish_reason;
      if (reason === null || reason === undefined) continue;
      if (typeof reason === 'string' && LEGAL_FINISH.has(reason)) state.finish = true; else state.broken = true;
    }
  };
  const take = text => {
    let at;
    line += text;
    while ((at = line.indexOf('\n')) >= 0) { inspect(line.slice(0, at)); line = line.slice(at + 1); }
    if (line.length > MAX_SSE_LINE) { state.broken = true; line = ''; }
  };
  const stream = new Transform({
    transform(chunk, encoding, done) { take(decoder.write(chunk)); done(null, chunk); },
    flush(done) {
      take(decoder.end() + '\n');
      done(requireDone && !state.doneLine ? new Error('Upstream SSE ended before [DONE]') : null);
    },
  });
  return { stream, complete: () => state.finish && state.done && !state.broken };
}

// Our own error responses (made by the proxy, already in plain words) carry this header and pass unchanged.
export const OWN_RESPONSE_HEADER = 'x-company-proxy-own';

async function beforeAbort(operation, signal) {
  signal.throwIfAborted();
  let handler;
  const aborted = new Promise((_, reject) => {
    handler = () => reject(signal.reason);
    signal.addEventListener('abort', handler, { once: true });
  });
  const pending = Promise.resolve().then(operation).then(value => {
    if (signal.aborted) {
      if (value instanceof Response && value.body) {
        void value.body.cancel().catch(() => process.stderr.write('Local proxy late response cleanup failed\n'));
      }
      throw signal.reason;
    }
    return value;
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', handler); }
}

// Only the HTTP transport is implemented here. The real company adapter must
// implement this injected contract after its source has been inspected:
// provider.listModels({ signal }) -> array of exact available model IDs
// provider.complete(body, { signal }) -> standard fetch Response (SSE on success)
// It owns credentials, signature, upstream authentication and model access.
export function createProxy({ provider, accessKey, maxBodyBytes = 4 * 1024 * 1024,
  timeoutMs = 120000, onEvent = () => {}, protocolAdapters = {} }) {
  if (!provider?.complete || !provider?.listModels) throw new Error('Provider contract is required');
  if (typeof accessKey !== 'string' || accessKey.length < 16) throw new Error('Dedicated local key must have at least 16 characters');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('maxBodyBytes must be a positive safe integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('timeoutMs must be a supported positive integer');
  const notify = event => {
    try { Promise.resolve(onEvent(event)).catch(() => process.stderr.write('Local proxy event observer failed\n')); }
    catch { process.stderr.write('Local proxy event observer failed\n'); }
  };
  const expected = Buffer.from(`Bearer ${accessKey}`);
  const server = http.createServer(async (req, res) => {
    const aborter = new AbortController();
    // pumpStop also ends the copy when the client leaves after a complete answer, without aborting the upstream request.
    const pumpStop = new AbortController();
    aborter.signal.addEventListener('abort', () => pumpStop.abort(aborter.signal.reason), { once: true });
    let streamComplete = () => false, closedAfterDone = false;
    const clientGone = reason => {
      if (res.writableEnded || aborter.signal.aborted || closedAfterDone) return;
      if (streamComplete()) { closedAfterDone = true; pumpStop.abort(new Error('Client closed after [DONE]')); return; }
      aborter.abort(reason);
    };
    req.once('aborted', () => clientGone(new Error('Client request aborted')));
    res.once('close', () => clientGone(new Error('Client disconnected')));
    const sendJson = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    // { type: 'error', error } satisfies both Anthropic and OpenAI-style clients.
    const fail = (status, type, message) => sendJson(status, { type: 'error', error: { type, message } });
    let timedOut = false, streamPath = '';
    // After headers are out: one protocol-defined error frame, then the end of the stream (never a fake success).
    const failStream = message => {
      if (res.destroyed || res.writableEnded) return;
      try { res.end(errorFrameFor(streamPath, message)); } catch { res.destroy(); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      aborter.abort(new Error('Request deadline exceeded'));
      if (!res.headersSent && !res.destroyed) {
        res.shouldKeepAlive = false;
        res.once('finish', () => { if (!req.complete) req.destroy(); });
        fail(504, 'timeout_error', preStreamMessage(null, { timedOut: true }));
      } else if (!res.writableEnded && !res.destroyed) {
        if (streamPath) failStream(midStreamMessage(null, { timedOut: true })); else res.destroy();
      }
    }, timeoutMs);
    timer.unref();
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
      const actual = Buffer.from(authorization || (apiKey ? `Bearer ${apiKey}` : ''));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        fail(401, 'authentication_error', 'A valid local proxy key is required');
        return;
      }
      if (req.method === 'GET' && pathname === '/v1/models') {
        const models = await beforeAbort(() => provider.listModels({ signal: aborter.signal }), aborter.signal);
        if (!Array.isArray(models) || models.some(x => typeof x !== 'string' || !x)) throw new Error('Invalid model list');
        sendJson(200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'company' })) });
        return;
      }
      const protocolAdapter = Object.hasOwn(protocolAdapters, pathname) ? protocolAdapters[pathname] : null;
      if (req.method !== 'POST' || (pathname !== '/v1/chat/completions' && !protocolAdapter)) {
        fail(404, 'not_found', 'This endpoint has not been configured');
        return;
      }
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        fail(415, 'invalid_request_error', 'Content-Type must be application/json');
        return;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { fail(413, 'invalid_request_error', 'Request exceeds configured size limit'); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'invalid_request_error', 'Malformed JSON'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') {
        fail(400, 'invalid_request_error', 'A request object with model is required'); return;
      }
      if (body.stream !== true) { fail(501, 'unsupported_request', 'This transport prototype currently requires stream=true'); return; }
      const originalRequest = body;
      if (protocolAdapter) body = protocolAdapter.convertRequest(body);
      if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
        fail(400, 'invalid_request_error', 'Converted model and messages are required'); return;
      }
      let upstream = await beforeAbort(() => provider.complete(body, { signal: aborter.signal }), aborter.signal);
      if (!(upstream instanceof Response)) throw new Error('Provider did not return a fetch Response');
      if (!upstream.ok) {
        // Upstream HTTP error before any stream: plain words naming the status (and a short, scrubbed reason).
        // The proxy's own error responses (login needed, rate limited, not ready) are already plain words.
        if (upstream.headers.get(OWN_RESPONSE_HEADER)) {
          const own = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
          const retry = upstream.headers.get('retry-after'); if (retry) own['retry-after'] = retry;
          res.writeHead(upstream.status, own); res.end(Buffer.from(await upstream.arrayBuffer()));
          notify({ type: 'request_finished', status: upstream.status });
          return;
        }
        let detail = '';
        try { detail = safeUpstreamDetail((await upstream.text()).slice(0, 4096)); } catch { /* no detail */ }
        const retry = upstream.headers.get('retry-after');
        res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(retry ? { 'retry-after': retry } : {}) });
        res.end(JSON.stringify({ type: 'error', error: { type: upstream.status === 429 ? 'rate_limit_error' : upstream.status === 401 || upstream.status === 403 ? 'authentication_error' : 'api_error',
          message: upstreamHttpMessage(upstream.status, detail) } }));
        notify({ type: 'request_finished', status: upstream.status });
        return;
      }
      const type = upstream.headers.get('content-type') || 'application/octet-stream';
      if (upstream.ok && !type.toLowerCase().startsWith('text/event-stream')) {
        await upstream.body?.cancel();
        fail(502, 'upstream_protocol_error', 'Expected an SSE response from upstream'); return;
      }
      if (upstream.ok && !upstream.body) {
        fail(502, 'upstream_protocol_error', 'Upstream returned an empty SSE response'); return;
      }
      let passthrough = !protocolAdapter;
      if (protocolAdapter && upstream.ok) {
        const original = upstream;
        try {
          upstream = await beforeAbort(() => protocolAdapter.convertResponse(original, { signal: aborter.signal, request: originalRequest, upstreamRequest: body }), aborter.signal);
        } catch (error) {
          if (original.body && !original.body.locked) await original.body.cancel();
          throw error;
        }
        if (!(upstream instanceof Response)) throw new Error('Protocol adapter did not return a fetch Response');
        // An adapter that hands back the upstream response itself (DSH) is a chat-completions passthrough.
        passthrough = upstream === original && pathname === '/v1/chat/completions';
      }
      const headers = { 'content-type': upstream.headers.get('content-type') || type, 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
      for (const name of ['retry-after', 'x-request-id']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
      if ((headers['content-type'] || '').toLowerCase().startsWith('text/event-stream')) streamPath = pathname;
      if (upstream.body && upstream.ok && passthrough) {
        const tracker = chatStreamTracker();
        streamComplete = tracker.complete;
        const source = Readable.fromWeb(upstream.body);
        source.once('error', error => tracker.stream.destroy(error)); // .pipe() does not forward source errors
        await pump(source.pipe(tracker.stream), res, pumpStop.signal, [source]);
      }
      else if (upstream.body) await pump(Readable.fromWeb(upstream.body), res, pumpStop.signal);
      else res.end();
      notify({ type: 'request_finished', status: upstream.status, ...(closedAfterDone ? { clientClosedAfterDone: true } : {}) });
    } catch (error) {
      if (closedAfterDone && !aborter.signal.aborted) {
        // The answer was complete (legal finish + [DONE]) and the client simply stopped reading: a normal end.
        notify({ type: 'request_finished', status: 200, clientClosedAfterDone: true });
        if (!res.destroyed) res.destroy();
        return;
      }
      // Do not expose raw upstream exceptions, headers, prompts or credentials.
      notify({ type: aborter.signal.aborted ? 'request_aborted' : 'request_failed' });
      if (!res.headersSent && !res.destroyed) {
        if (error.code === 'unsupported_protocol' && error.status >= 400 && error.status < 500) fail(error.status, error.code, error.message);
        else if (aborter.signal.aborted && !timedOut) fail(499, 'client_closed', 'The client closed the request');
        else fail(timedOut ? 504 : 502, 'upstream_error', preStreamMessage(error, { timedOut }));
      }
      else if (!res.destroyed && !res.writableEnded) {
        // No synthetic success/[DONE] and no automatic replay; a client that is still there gets the reason.
        if (streamPath && !aborter.signal.aborted) failStream(midStreamMessage(error));
        else res.destroy();
      }
    } finally { clearTimeout(timer); }
  });
  server.requestTimeout = timeoutMs;
  return {
    server,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() {
      server.closeIdleConnections();
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
