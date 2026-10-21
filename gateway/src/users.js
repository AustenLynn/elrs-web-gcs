// Pilot accounts: a JSON file (mode 0600) with a scrypt hash per user, written atomically.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
const SALT_LEN = 16;
const NAME_RE = /^[a-z0-9_-]{2,20}$/;
const MIN_PASSWORD = 8;

function fail(code, msg) {
  return Object.assign(new Error(msg), { code });
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export class UserStore {
  #file;
  #users = new Map();   // name -> { admin, salt (hex), hash (hex) }
  #queue = Promise.resolve();   // serialises mutations so two writes never interleave

  constructor(file) {
    this.#file = file;
  }

  get size() {
    return this.#users.size;
  }

  async load() {
    this.#users = await this.#read();
  }

  async #read() {
    let raw;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return new Map();
      throw err;
    }
    return new Map(JSON.parse(raw).users.map((u) => [u.name, { admin: !!u.admin, salt: u.salt, hash: u.hash }]));
  }

  list() {
    return [...this.#users].map(([name, u]) => ({ name, admin: u.admin }));
  }

  async verify(name, password) {
    const u = typeof name === 'string' ? this.#users.get(name) : undefined;
    // Unknown user: still spend one scrypt so the answer time does not reveal the name.
    const salt = u ? Buffer.from(u.salt, 'hex') : Buffer.alloc(SALT_LEN);
    const key = await hashPassword(String(password), salt);
    if (!u) return null;
    const expected = Buffer.from(u.hash, 'hex');
    return key.length === expected.length && timingSafeEqual(key, expected) ? { name, admin: u.admin } : null;
  }

  add(name, password, admin = false) {
    return this.#mutate(async (users) => {
      if (!NAME_RE.test(name)) throw fail('bad_name', 'name must be 2-20 characters of a-z, 0-9, _ or -');
      checkPassword(password);
      if (users.has(name)) throw fail('exists', `user ${name} already exists`);
      users.set(name, { admin: !!admin, ...(await newSecret(password)) });
    });
  }

  setPassword(name, password) {
    return this.#mutate(async (users) => {
      const u = users.get(name);
      if (!u) throw fail('unknown', `no user ${name}`);
      checkPassword(password);
      users.set(name, { ...u, ...(await newSecret(password)) });
    });
  }

  remove(name) {
    return this.#mutate(async (users) => {
      if (!users.delete(name)) throw fail('unknown', `no user ${name}`);
    });
  }

  /** Re-reads the file (so a change made by the CLI meanwhile is kept), applies fn to that copy,
   *  saves it, and only then makes it the live set. */
  #mutate(fn) {
    const run = this.#queue.then(async () => {
      const next = await this.#read();
      await fn(next);
      await this.#save(next);
      this.#users = next;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #save(users) {
    const json = JSON.stringify({ users: [...users].map(([name, u]) => ({ name, ...u })) }, null, 2);
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.#file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw fail('bad_password', `password needs at least ${MIN_PASSWORD} characters`);
  }
}

async function newSecret(password) {
  const salt = randomBytes(SALT_LEN);
  return { salt: salt.toString('hex'), hash: (await hashPassword(password, salt)).toString('hex') };
}
