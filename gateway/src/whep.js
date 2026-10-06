// Forwards the browser's WHEP requests (WebRTC playback signalling) to MediaMTX, so the
// video uses the same origin and TLS certificate as the pilot page. Only the small SDP
// exchange goes through here; the video itself flows directly from MediaMTX over UDP.
//   POST   /video/whep          -> POST   <upstream>          (offer -> answer, 201 + Location)
//   PATCH  /video/whep/<id>     -> PATCH  <upstream>/<id>     (trickle ICE)
//   DELETE /video/whep/<id>     -> DELETE <upstream>/<id>     (end of playback)
const PREFIX = '/video/whep';
const MAX_BODY = 64 * 1024;
const PASS_HEADERS = ['content-type', 'etag', 'accept-patch', 'link'];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Returns a handler(req, res) -> true if it handled the request. It never throws: an
 *  exception here would take the whole gateway down and fail safe a flying aircraft. */
export function whepProxy(upstream) {
  const base = new URL(upstream);
  return async (req, res) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://local'));
    } catch {
      res.writeHead(400).end();                              // e.g. "GET //": not a URL
      return true;
    }
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    const id = pathname.slice(PREFIX.length);               // '' or '/<session id>'
    const allowed = id === '' ? ['POST'] : ['PATCH', 'DELETE'];
    if (!allowed.includes(req.method)) {
      res.writeHead(405, { Allow: allowed.join(', ') }).end();
      return true;
    }
    if (id !== '' && !/^\/[A-Za-z0-9-]{1,64}$/.test(id)) {
      res.writeHead(400).end();
      return true;
    }
    let body;
    try {
      body = await readBody(req, MAX_BODY);
    } catch {
      res.writeHead(413).end();
      return true;
    }
    // Everything from the video server is read and checked before we answer, so a server
    // that dies, hangs or sends garbage gives a clean 502 (5 s at most).
    let status;
    let headers;
    let answer;
    try {
      const up = await fetch(new URL(base.pathname + id, base), {
        method: req.method,
        headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
        body: body.length ? body : undefined,
        signal: AbortSignal.timeout(5000),
      });
      answer = Buffer.from(await up.arrayBuffer());
      status = up.status;
      headers = {};
      for (const h of PASS_HEADERS) {
        const v = up.headers.get(h);
        if (v) headers[h] = v;
      }
      const location = up.headers.get('location');
      if (location) {
        const path = new URL(location, base).pathname;
        if (path.startsWith(base.pathname)) headers.location = PREFIX + path.slice(base.pathname.length);
      }
    } catch {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('video server unavailable');
      return true;
    }
    res.writeHead(status, headers);
    res.end(answer);
    return true;
  };
}
