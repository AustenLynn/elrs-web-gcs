// "Press and hold" for dangerous buttons (arm, clear failsafe). HoldGesture is pure.
export class HoldGesture {
  constructor(durationMs, onComplete) {
    this.durationMs = durationMs;
    this.onComplete = onComplete;
    this.start = null;
    this.fired = false;
  }

  press(now) {
    this.start = now;
    this.fired = false;
  }

  release() {
    this.start = null;
  }

  /** Progress 0..1. Fires onComplete once when the hold reaches the full duration. */
  update(now) {
    if (this.start === null) return 0;
    const progress = Math.min(1, (now - this.start) / this.durationMs);
    if (progress >= 1 && !this.fired) {
      this.fired = true;
      this.onComplete();
    }
    return progress;
  }
}

export function bindHold(button, durationMs, onComplete) {
  const gesture = new HoldGesture(durationMs, onComplete);
  const frame = () => {
    const p = gesture.update(performance.now());
    button.style.setProperty('--progress', p);
    if (gesture.start !== null) requestAnimationFrame(frame);
  };
  button.addEventListener('pointerdown', (ev) => {
    button.setPointerCapture(ev.pointerId);
    gesture.press(performance.now());
    requestAnimationFrame(frame);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => {
      gesture.release();
      button.style.setProperty('--progress', 0);
    });
  }
  return gesture;
}
