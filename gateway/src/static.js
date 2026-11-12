// Serves the web app's files. GET/HEAD only, single byte ranges, no directory listings, no escaping webRoot.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json',
};

export function staticHandler(root) {
  const base = path.resolve(root);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, `.${rel}`);
    if (!file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let data;
    try {
      data = await readFile(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };
    const range = byteRange(req.headers.range, data.length);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.length}`, 'Content-Length': 0 }).end();
      return;
    }
    if (range) {
      const [first, last] = range;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${first}-${last}/${data.length}`, 'Content-Length': last - first + 1 });
      res.end(req.method === 'HEAD' ? undefined : data.subarray(first, last + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  };
}

/** One `bytes=a-b`, `bytes=a-` or `bytes=-n` range (iOS media needs them): [first, last],
 *  'unsatisfiable', or null (no header, malformed, multi-range, other unit: serve it whole). */
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {                                   // suffix: the last n bytes
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'unsatisfiable' : [Math.max(0, size - n), size - 1];
  }
  const first = Number(m[1]);
  const last = m[2] === '' ? Infinity : Number(m[2]);
  if (last < first) return null;                       // invalid: ignored
  if (first >= size) return 'unsatisfiable';
  return [first, Math.min(last, size - 1)];
}
