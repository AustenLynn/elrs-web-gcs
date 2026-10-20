// Sign-in: in-memory sessions behind an HttpOnly cookie, a login rate limit, and the /login,
// /logout and /me routes.
import { randomBytes } from 'node:crypto';

const COOKIE = 'gcs_session';
const MAX_BODY = 4096;

export class Sessions {
  #byToken = new Map();   // token -> { user: {name, admin}, expires }
  #ttlMs;
  #now;

  constructor({ ttlMs = 43_200_000, now = Date.now } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  create(user) {
    const token = randomBytes(32).toString('hex');
    this.#byToken.set(token, { user: { name: user.name, admin: user.admin }, expires: this.#now() + this.#ttlMs });
    return token;
  }

  get(token) {
    const s = typeof token === 'string' ? this.#byToken.get(token) : undefined;
    if (!s) return null;
    if (this.#now() >= s.expires) {
      this.#byToken.delete(token);
      return null;
    }
    return { ...s.user };
  }

  endUser(name) {
    for (const [token, s] of this.#byToken) if (s.user.name === name) this.#byToken.delete(token);
  }

  delete(token) {
    this.#byToken.delete(token);
  }
}

export class LoginLimiter {
  #fails = new Map();   // "n:<name>" or "a:<addr>" -> timestamps of recent failures
  #max;
  #windowMs;
  #now;

  constructor({ max = 5, windowMs = 60_000, now = Date.now } = {}) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #recent(key) {
    const t = this.#now();
    const list = (this.#fails.get(key) ?? []).filter((x) => t - x < this.#windowMs);
    if (list.length) this.#fails.set(key, list);
    else this.#fails.delete(key);
    return list;
  }

  blocked(name, addr) {
    return this.#recent(`n:${name}`).length >= this.#max || this.#recent(`a:${addr}`).length >= this.#max;
  }

  fail(name, addr) {
    const t = this.#now();
    for (const key of [`n:${name}`, `a:${addr}`]) this.#fails.set(key, [...this.#recent(key), t]);
  }

  ok(name, addr) {
    this.#fails.delete(`n:${name}`);
    this.#fails.delete(`a:${addr}`);
  }
}

/** The sign-in token from the Cookie header, or null. */
export function cookieToken(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim() || null;
  }
  return null;
}

function sessionCookie(value, maxAge, secure) {
  return `${COOKIE}=${value}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

/** JSON body up to MAX_BODY bytes; sends the error response and returns undefined when refused. */
async function readJson(req, res) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    send(res, 415, { error: 'content type must be application/json' });
    req.resume();
    return undefined;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(res, 413, { error: 'body too large' }, { Connection: 'close' });
        req.destroy();
        return undefined;
      }
      chunks.push(chunk);
    }
  } catch {
    return undefined;   // the client aborted mid-body: nobody is left to answer
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body !== null && typeof body === 'object') return body;
  } catch { /* falls through */ }
  send(res, 400, { error: 'invalid JSON' });
  return undefined;
}

/** Returns async (req, res) => true when it answered the request. */
export function authRoutes({ users, sessions, limiter, secure, hub }) {   // hub: used by the admin routes (later)
  return async (req, res) => {
    const route = pathOf(req.url);
    if (route !== '/login' && route !== '/logout' && route !== '/me') return false;
    if (route === '/me') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' }), true;
      const user = sessions.get(cookieToken(req));
      if (user) send(res, 200, user);
      else send(res, 401, { noUsers: users.size === 0 });
      return true;
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' }), true;
    if (route === '/logout') {
      sessions.delete(cookieToken(req));
      res.writeHead(204, { 'Set-Cookie': sessionCookie('', 0, secure) });
      res.end();
      return true;
    }
    const body = await readJson(req, res);
    if (!body) return true;
    const { name, password } = body;
    if (typeof name !== 'string' || typeof password !== 'string') return send(res, 400, { error: 'name and password are required' }), true;
    const key = name.slice(0, 64);
    const addr = clientAddress(req);
    if (limiter.blocked(key, addr)) return send(res, 429, { error: 'too many attempts' }, { 'Retry-After': '60' }), true;
    // Count the attempt before the slow hash, so parallel requests cannot all pass blocked().
    limiter.fail(key, addr);
    const user = await users.verify(name, password);
    if (!user) return send(res, 401, { error: 'wrong name or password' }), true;
    limiter.ok(key, addr);
    send(res, 200, user, { 'Set-Cookie': sessionCookie(sessions.create(user), 43200, secure) });
    return true;
  };
}

const LOOPBACK = /^(::1|(::ffff:)?127\.\d+\.\d+\.\d+)$/;

/** Behind the Cloudflare tunnel every request arrives from loopback: trust CF-Connecting-IP only then. */
function clientAddress(req) {
  const addr = req.socket.remoteAddress ?? '';
  const forwarded = req.headers['cf-connecting-ip'];
  return LOOPBACK.test(addr) && typeof forwarded === 'string' && forwarded ? forwarded.slice(0, 64) : addr;
}

function pathOf(url) {
  try {
    return new URL(url, 'http://local').pathname;
  } catch {
    return null;
  }
}
