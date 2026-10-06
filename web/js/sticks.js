// Virtual sticks. StickModel is pure (tested in Node); bindStick() wires it to the page.
// Axis values are -1..1 with screen coordinates (y grows downwards). Square gimbal.
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export class StickModel {
  constructor({ springX = true, springY = true, initial = { x: 0, y: 0 } } = {}) {
    this.springX = springX;
    this.springY = springY;
    this.x = initial.x;
    this.y = initial.y;
    this.active = false;
  }

  /** Pointer offset (px, py) from the pad centre; r = pad radius in the same units. */
  move(px, py, r) {
    this.x = clamp1(px / r);
    this.y = clamp1(py / r);
    this.active = true;
  }

  /** Finger lifted: sprung axes return to centre, the throttle axis stays where it is. */
  release() {
    if (this.springX) this.x = 0;
    if (this.springY) this.y = 0;
    this.active = false;
  }
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
  const update = (ev) => {
    const box = pad.getBoundingClientRect();
    const r = Math.min(box.width, box.height) / 2;
    model.move(ev.clientX - (box.left + box.width / 2), ev.clientY - (box.top + box.height / 2), r);
    draw();
  };
  pad.addEventListener('pointerdown', (ev) => {
    pad.setPointerCapture(ev.pointerId);
    update(ev);
  });
  pad.addEventListener('pointermove', (ev) => {
    if (pad.hasPointerCapture(ev.pointerId)) update(ev);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    pad.addEventListener(type, () => {
      model.release();
      draw();
    });
  }
  draw();
}
