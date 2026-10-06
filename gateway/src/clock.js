// Estimates the offset between a browser's clock (performance.now()) and ours, so we can
// tell how old a control command is when it arrives (FMEA #3: never apply stale commands).
//
// We send {s0}; the browser answers with its own time c1; we receive at s2.
// Assuming equal delay both ways: offset = c1 - (s0 + s2) / 2, error <= RTT / 2.
// The sample with the smallest RTT in the recent window is the most trustworthy.
export class ClockSync {
  constructor(window = 8) {
    this.window = window;
    this.samples = [];
  }

  add(s0, c1, s2) {
    const rtt = s2 - s0;
    if (!(rtt >= 0)) return; // reply to a ping we never sent, or a clock glitch
    this.samples.push({ rtt, offset: c1 - (s0 + s2) / 2 });
    if (this.samples.length > this.window) this.samples.shift();
  }

  get ready() {
    return this.samples.length > 0;
  }

  #best() {
    return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  }

  get rtt() {
    return this.#best().rtt;
  }

  get offset() {
    return this.#best().offset;
  }

  /** Age in ms, on our clock, of a command the browser stamped with `ts`. */
  age(ts, now) {
    return now - (ts - this.offset);
  }
}
