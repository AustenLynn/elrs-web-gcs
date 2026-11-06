// Opt-in sent-command manifest. No network/file work in the command path.
export class ControlTrace {
  constructor(capacity = 60000) {
    this.capacity = capacity;
    this.commands = [];
    this.sent = 0;
    this.overflow = false;
    this.stopped = false;
    this.started = new Date().toISOString();
  }

  add(session, msg) {
    if (this.stopped) return;
    this.sent++;
    if (this.commands.length >= this.capacity) { this.overflow = true; return; }
    this.commands.push({ session, seq: msg.seq, ts: msg.ts });
  }

  export() {
    return { version: 1, endpoint: 'serial-submission', started: this.started,
      sent: this.sent, overflow: this.overflow, commands: this.commands.map((r) => ({ ...r })) };
  }

  stop() { this.stopped = true; return this.export(); }

  download() {
    const blob = new Blob([JSON.stringify(this.stop())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `control-sent-${this.started.replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
