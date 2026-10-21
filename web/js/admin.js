// Admin screen: list pilots, add, change password, remove. The list reloads every 2 s so the
// "flying" flag stays current.
import { FLYING_TEXT, rowActions } from './adminview.js';

const $ = (id) => document.getElementById(id);
let me = null;

const ERRORS = {
  bad_name: 'Nombre no válido: 2 a 20 caracteres a-z, 0-9, _ o -',
  bad_password: 'La contraseña necesita al menos 8 caracteres',
  exists: 'Ese piloto ya existe',
  unknown: 'Ese piloto no existe',
  flying: FLYING_TEXT,
  self: 'No puedes quitar tu propia cuenta',
};

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 403) {   // the session ended
    location.href = '/';
    throw new Error('forbidden');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) throw new Error(ERRORS[data.error] ?? 'Error del servidor');
  return data;
}

function say(text) {
  $('msg').textContent = text;
}

async function act(fn) {
  try {
    await fn();
    say('');
  } catch (err) {
    say(err.message);
  }
  await refresh();
}

function row(user) {
  const { canRemove, reason } = rowActions(user, me);
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'user-name';
  name.textContent = user.admin ? `${user.name} (admin)` : user.name;
  const note = document.createElement('span');
  note.className = 'user-note';
  note.textContent = reason ?? '';
  const pass = document.createElement('button');
  pass.type = 'button';
  pass.textContent = 'Cambiar contraseña';
  pass.onclick = () => {
    const password = prompt(`Nueva contraseña para ${user.name}`);
    if (password) act(() => call('POST', `/admin/users/${encodeURIComponent(user.name)}/password`, { password }));
  };
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'warn';
  del.textContent = 'Quitar';
  del.disabled = !canRemove;
  if (reason) del.title = reason;
  del.onclick = () => {
    if (confirm(`¿Quitar a ${user.name}?`)) act(() => call('DELETE', `/admin/users/${encodeURIComponent(user.name)}`));
  };
  li.append(name, note, pass, del);
  return li;
}

async function refresh() {
  try {
    const list = await call('GET', '/admin/users');
    $('users').replaceChildren(...list.map(row));
  } catch { /* keeps the last list; the next tick retries */ }
}

$('add').onsubmit = (ev) => {
  ev.preventDefault();
  act(async () => {
    await call('POST', '/admin/users', { name: $('new-name').value, password: $('new-pass').value, admin: $('new-admin').checked });
    $('add').reset();
  });
};

$('logout').onclick = async () => {
  await fetch('/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
};

const res = await fetch('/me');
if (!res.ok) location.href = '/';
else {
  me = (await res.json()).name;
  await refresh();
  setInterval(refresh, 2000);
}
