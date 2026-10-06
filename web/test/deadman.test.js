import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEADMAN_TEXT, Deadman } from '../js/deadman.js';

const ok = { visible: true, focused: true, wsOpen: true };

test('nothing is sent until the pilot takes control', () => {
  const d = new Deadman();
  assert.equal(d.canSend(ok), false);
  assert.equal(d.reason, 'not_engaged');
  d.engage();
  assert.equal(d.canSend(ok), true);
});

test('hiding the page, losing focus or the connection disengages, and it stays off', () => {
  for (const [bad, reason] of [[{ visible: false }, 'hidden'], [{ focused: false }, 'blur'], [{ wsOpen: false }, 'disconnected']]) {
    const d = new Deadman();
    d.engage();
    assert.equal(d.canSend({ ...ok, ...bad }), false);
    assert.equal(d.reason, reason);
    assert.equal(d.canSend(ok), false, 'must not re-engage by itself');
    d.engage();
    assert.equal(d.canSend(ok), true);
  }
});

test('a layout change under the fingers ends control and says why', () => {
  const d = new Deadman();
  d.engage();
  d.disengage('layout');
  assert.equal(d.canSend(ok), false);
  assert.match(DEADMAN_TEXT.layout, /pantalla/);
});
