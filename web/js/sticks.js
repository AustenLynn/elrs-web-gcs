// Virtual sticks. StickModel is pure (tested in Node); bindStick() wires it to the page.
// Axis values are -1..1 with screen coordinates (y grows downwards). Square gimbal.
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export class StickModel {
  constructor({ springX = true, springY = true, initial = { x: 0, y: 0 } } = {}) {
    this.springX = springX;
    this.springY = springY;
    this.x = initial.x;
    this.y = initial.y;
    this.owner = null;      // pointerId of the finger that holds this stick
    this.anchor = null;     // held (non-sprung) axes: where the drag started
  }

  get active() {
    return this.owner !== null;
  }

  /** A finger touches the pad at offset (px, py) from its centre; r = pad radius. Only the
   *  first finger owns the stick. Sprung axes go to the finger; a held axis (throttle) does
   *  not move until the finger drags, so re-gripping never jumps it. */
  grab(id, px, py, r) {
    if (this.owner !== null) return false;
    this.owner = id;
    this.anchor = { px, py, x: this.x, y: this.y };
    this.#follow(px, py, r);
    return true;
  }

  move(id, px, py, r) {
    if (id === this.owner) this.#follow(px, py, r);
  }

  /** Only the owning finger lifting releases: sprung axes return to centre. */
  release(id) {
    if (id !== this.owner) return;
    this.owner = null;
    this.anchor = null;
    if (this.springX) this.x = 0;
    if (this.springY) this.y = 0;
  }

  #follow(px, py, r) {
    const a = this.anchor;
    this.x = clamp1(this.springX ? px / r : a.x + (px - a.px) / r);
    this.y = clamp1(this.springY ? py / r : a.y + (py - a.py) / r);
  }
}

/** True when a stick pad moved or resized by more than tolPx since `before` (browser bars
 *  returning, rotation): the stick values under the fingers would jump. */
export function padsMoved(before, after, tolPx = 4) {
  return before.some((b, i) => {
    const a = after[i];
    return !a || Math.abs(a.left - b.left) > tolPx || Math.abs(a.top - b.top) > tolPx ||
      Math.abs(a.width - b.width) > tolPx || Math.abs(a.height - b.height) > tolPx;
  });
}

/** "Mode 2": left stick = throttle (vertical) + yaw, right stick = pitch + roll. */
export function sticksToCommand(left, right, mode) {
  return {
    roll: Math.round(right.x * 1000) || 0,
    pitch: Math.round(-right.y * 1000) || 0,   // stick up = nose down/forward = higher value
    yaw: Math.round(left.x * 1000) || 0,
    throttle: Math.round(((1 - left.y) / 2) * 1000),
    mode,
  };
}

export function bindStick(pad, model) {
  const knob = pad.querySelector('.knob');
  const draw = () => {
    knob.style.setProperty('--x', model.x);
    knob.style.setProperty('--y', model.y);
  };
  const offset = (ev) => {
    const box = pad.getBoundingClientRect();
    const r = Math.min(box.width, box.height) / 2;
    return [ev.clientX - (box.left + box.width / 2), ev.clientY - (box.top + box.height / 2), r];
  };
  pad.addEventListener('pointerdown', (ev) => {
    if (!model.grab(ev.pointerId, ...offset(ev))) return;   // a second finger is ignored
    pad.setPointerCapture(ev.pointerId);
    draw();
  });
  pad.addEventListener('pointermove', (ev) => {
    model.move(ev.pointerId, ...offset(ev));
    draw();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    pad.addEventListener(type, (ev) => {
      model.release(ev.pointerId);
      draw();
    });
  }
  draw();
}
