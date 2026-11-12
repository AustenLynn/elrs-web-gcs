import { t, onLanguageChange, initLanguageUI } from './i18n.js';
// Admin screen: list pilots, add, change password, remove. The list reloads every 2 s so the
// "flying" flag stays current.
import { rowActions } from './adminview.js';

const $ = (id) => document.getElementById(id);
let me = null;

const ERRORS = {
  bad_name: 'invalid.name.2.to.20.characters.a.z.0.9.or',
  bad_password: 'password.must.contain.at.least.8.characters',
  exists: 'pilot.already.exists', unknown: 'pilot.does.not.exist',
  flying: 'flying.cannot.be.removed', self: 'you.cannot.remove.your.own.account',
};
let users = [];
let message = () => '';
function renderUsers() { $('users').replaceChildren(...users.map(row)); }
initLanguageUI(document);
onLanguageChange(() => { renderUsers(); $('msg').textContent = message(); });

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
  if (!res.ok) throw Object.assign(new Error('admin_error'), {key: ERRORS[data.error] ?? 'server.error'});
  return data;
}

function say(text) {
  message = typeof text === 'function' ? text : () => text;
  $('msg').textContent = message();
}

async function act(fn) {
  try {
    await fn();
    say('');
  } catch (err) {
    say(() => t(err.key ?? 'server.error'));
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
  pass.textContent = t('change.password');
  pass.onclick = () => {
    const password = prompt(t('new.password.for.name', { name: user.name }));
    if (password) act(() => call('POST', `/admin/users/${encodeURIComponent(user.name)}/password`, { password }));
  };
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'warn';
  del.textContent = t('remove');
  del.disabled = !canRemove;
  if (reason) del.title = reason;
  del.onclick = () => {
    if (confirm(t('remove.name', { name: user.name }))) act(() => call('DELETE', `/admin/users/${encodeURIComponent(user.name)}`));
  };
  li.append(name, note, pass, del);
  return li;
}

async function refresh() {
  try {
    users = await call('GET', '/admin/users');
    renderUsers();
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
