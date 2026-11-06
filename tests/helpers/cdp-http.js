'use strict';

// A socket inactivity timeout is not an overall response deadline: a partial
// body can keep it alive forever. Share this bound across discovery and close.
function requestCdpHttp(http, url, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new RangeError('CDP HTTP timeout must be a positive integer');
  }
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy(); request?.destroy();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`CDP HTTP request timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      request = http.get(url, res => {
        // A response already queued by the transport may arrive after timeout.
        // Do not attach body consumers or keep that response open.
        if (settled) { res.on('error', () => {}); res.destroy(); return; }
        response = res;
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('CDP HTTP response aborted')));
        res.on('close', () => { if (!settled) finish(new Error('CDP HTTP response closed before end')); });
        let body = '';
        res.setEncoding?.('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => finish(null, { statusCode: res.statusCode, body }));
      });
      request.on('error', error => finish(error));
    } catch (error) { finish(error); }
  });
}

module.exports = { requestCdpHttp };
