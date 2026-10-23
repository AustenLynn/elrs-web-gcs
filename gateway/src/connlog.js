// The connection log: one JSON object per line with the time first. It records names, the
// path (local/tunnel/relay), times and durations; never IP addresses or passwords.
// Writes go through a stream so they never block the event loop (the command path logs
// during network stalls). Errors are reported once and never thrown: a full disk must not
// stop the gateway. Lines are dropped, not queued, once 64 KB are waiting.
import { createWriteStream } from 'node:fs';

const MAX_PENDING_BYTES = 64 * 1024;

export function openConnLog(file) {
  if (file === null) {
    return {
      write: (obj) => console.log(`gateway: ${JSON.stringify({ t: new Date().toISOString(), ...obj })}`),
      async close() {},
    };
  }
  let failed = false;
  let dropped = 0;
  const stream = createWriteStream(file, { flags: 'a' });
  stream.on('error', (err) => {
    if (failed) return;
    failed = true;
    console.error(`gateway: cannot write the connection log ${file}: ${err.message}`);
  });
  return {
    write(obj) {
      if (failed || stream.destroyed) return;
      if (stream.writableLength > MAX_PENDING_BYTES) {
        if (dropped++ === 0) console.error('gateway: connection log is falling behind, dropping lines');
        return;
      }
      stream.write(`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
    },
    close() {
      if (failed || stream.destroyed) return Promise.resolve();
      return new Promise((resolve) => {
        stream.once('finish', resolve);
        stream.once('close', resolve);
        stream.end();
      });
    },
  };
}
