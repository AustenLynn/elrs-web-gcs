// The connection log: one JSON object per line with the time first. It records names, the
// path (local/tunnel/relay), times and durations; never IP addresses or passwords.
// A write error is reported once and never thrown: a full disk must not stop the gateway.
import { appendFileSync } from 'node:fs';

export function openConnLog(file) {
  let failed = false;
  return {
    write(obj) {
      const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
      if (file === null) {
        console.log(`gateway: ${line}`);
        return;
      }
      try {
        appendFileSync(file, `${line}\n`);
      } catch (err) {
        if (failed) return;
        failed = true;
        console.error(`gateway: cannot write the connection log ${file}: ${err.message}`);
      }
    },
    async close() {},
  };
}
