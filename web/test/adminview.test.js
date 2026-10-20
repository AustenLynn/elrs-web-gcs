import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowActions } from '../js/adminview.js';

const me = 'ana';

test('a flying pilot cannot be removed, and says why', () => {
  assert.deepEqual(rowActions({ name: 'luis', admin: false, flying: true }, me), { canRemove: false, reason: 'Está volando: no se puede quitar' });
});

test('you cannot remove yourself', () => {
  assert.deepEqual(rowActions({ name: 'ana', admin: true, flying: false }, me), { canRemove: false, reason: null });
});

test('an ordinary pilot can be removed', () => {
  assert.deepEqual(rowActions({ name: 'luis', admin: false, flying: false }, me), { canRemove: true, reason: null });
});
