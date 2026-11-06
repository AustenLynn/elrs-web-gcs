# Local software measurement campaigns

These are bench measurements, with propellers removed. Do not change the timeout, hold,
landing or channel configuration to improve a result. The deployed bench throttle/landing
settings are not validated flight values. A simulated-transmitter test verifies the measurement
software, not the three project acceptance criteria on the real system.

## Deploy instrumentation

Disarm and clear any failsafe first. From the Pi terminal:

```bash
cd ~/ProyectoTerminal/elrs-web-gcs
sudo bash deploy/measure-control.sh
```

This backs up the current installation and configuration under `/var/backups/gcs-measure-<UTC>`,
deploys the matching core, gateway and browser files, and enables opt-in tracing plus the
per-frame CSV. It preserves failsafe settings and accounts. It refuses to deploy unless the
read-only status socket reports DISARMED. Each run uses fresh log files, whose paths it prints.
The video service and Cloudflare connector do not need restarting.

Use direct `https://<Pi-LAN-IP>:8443/` URLs for all acceptance runs, not the Cloudflare URL.
The gateway labels routing from its connection headers; record the actual network topology
as well. Two tabs alone do not demonstrate two independent client devices.

## Control: three segments, at least 10,000 commands

Open the pilot page at `https://<Pi-LAN-IP>:8443/?measure`. Sign in, take control and, with
propellers removed, arm using the normal deliberate gesture. Keep the page in focus and
engaged for at least 220 seconds (50 commands/s; allow extra time for initial disarmed samples),
or use the same 10-minute bench session as the frame test. Do not close/reload the page: the
sent manifest lives in that page's memory. Commands emitted while disarmed still count in
the denominator and are reported as not submitted as active outputs.

After disarming, open that page's developer console and run:

```js
controlLatency.download()
```

This stops recording and downloads `control-sent-<UTC>.json`. Controls remain governed by the
existing deadman and safety rules. Recording is limited to 60,000 sent commands (20 minutes at
50 Hz); exceeding the limit marks the entire capture unusable. Reopening `?measure` starts a
fresh manifest. Transfer the downloaded file to the Pi, keeping its name. Wait two seconds
for logs to flush, then copy the printed core/gateway files into a results folder before
disabling instrumentation. Preserve the originals.

```bash
python3 tools/analysis/control_latency_report.py \
  control-sent.json gateway.jsonl core.jsonl \
  --json control-report.json --csv control-commands.csv
```

The report gives p50/p90/p99/max in milliseconds for:

| Segment | Boundaries |
|---|---|
| Network | Browser command timestamp just before WebSocket submission → gateway handler entry |
| Gateway | Gateway handler entry → submission toward the core socket |
| Core delivery | Core socket submission → successful full serial write, including local socket transit and mailbox scheduling |
| Total | Sum of the three segments for that same command |

The core also records IPC receipt to audit correlation. Only a complete 26-byte write while
the command's outputs remain active counts as serial submission. Repeated frames for one
command count once. A command replaced in a burst, suppressed by safety/disarming, lost in a
queue or absent from the trace cannot count as a successful delivery; missing receipts and
missing submissions are reported separately. The report cannot distinguish every cause of
a missing submission, so it does not label all such commands as definite network losses.

Node `process.hrtime.bigint()` and C `CLOCK_MONOTONIC` share the host clock on this Linux Pi;
an integration test checks that ordering. Browser `performance.now()` has a separate origin.
Existing clock exchanges estimate its offset. Each gateway trace records the corresponding
RTT/2 uncertainty and sample age; samples 20 seconds old or older are excluded. RTT/2 is an
uncertainty estimate for the clock exchange, not a measured one-way network delay or a
guaranteed bound on future clock drift. Use short captures and inspect the uncertainty column.

Acceptance uses all sent commands as denominator, at least 10,000 commands, local routing,
and at least 90% with `estimated total + clock uncertainty <= 50 ms`. It also shows the
estimated-only percentage. Duplicate keys, mismatched browser timestamps and overflow prevent
a pass. Unknown/missing/non-finite timing never becomes a zero-delay sample. Trace queue/disk
drops can only reduce successful matches. A PASS is specifically for the **software serial
submission endpoint and stated clock assumptions**, not measured reception in the radio.

## CRSF: 10-minute frame timing

Keep the instrumented core running for at least 600 seconds after the initial connection
has settled. Save the fresh `timing.csv` and core events, and record start/end read-only
`crsf-ctl status` output. The core does not need to be armed to generate CRSF frames.

```bash
crsf-ctl status
python3 tools/analysis/timing_report.py timing.csv --hist timing-histogram.csv
```

Verify duration >= 600 s, rate approximately 250 Hz, zero missed slots, zero ticks not sent,
and no increase in TX error counters. The existing timing tool also applies its separate
jitter limits, which are stricter/different than merely counting frame slots. A passing short
trace does not satisfy the ten-minute requirement. Record all failures; do not cherry-pick a
quiet interval after seeing results. The code generates 16 channels, checked by the core tests.
RX CRC error counters concern incoming telemetry and do not prove outgoing CRC correctness.
Without receiver-side capture/acknowledgment this campaign establishes software timing and
submission, not absence of physical wire corruption.

## Video: two local clients, five minutes together

On two different LAN clients open `https://<Pi-LAN-IP>:8443/watch.html`. Once both show video,
start the recorder on each within ten seconds and save each client's CSV using **Descargar CSV**.
Keep both pages visible. Because the first stats sample can occur up to one second after
pressing Record, the updated recorder collects 310 seconds between its first and last
samples, allowing a ten-second start offset for a full five-minute overlap. Preserve absolute start times, client
IDs/browser versions and the MediaMTX journal to establish a five-minute overlap.

For each CSV verify decoded-frame delta / elapsed seconds >= 25 fps, received resolution
1280x720 throughout, freeze counter delta zero, no reconnections and no missing samples.
The updated browser summary enforces received 720p, at least 25 decoded fps on average,
300 elapsed seconds, no freezes/reconnections/gaps and (more strictly) no dropped frames.
The CSV includes `wallMs` for matching the client windows; synchronize client system clocks
and corroborate overlap with the server journal. Start the recordings together and ensure
their overlap, not only each individual duration, reaches 300 seconds. If their start times
differ by more than the margin, repeat the capture; do not claim five minutes
of overlap from two offset five-minute windows. Server configuration of 720p/30 fps alone
cannot establish client performance.

## Finish

Instrumentation adds disk/CPU load and can fill storage (frame timing roughly 80 MB/hour).
After saving the campaign files, disarm, stop gateway/core, set `control_trace = false` and
`timing_log =` in `/etc/gcs/crsf-core.conf`, and `"controlTrace": false` in
`/etc/gcs/gateway.json`; then start both services. Keep the fresh event-log paths for historical
evidence or restore only the logging fields from the backup. Keep failsafe configuration
unchanged. Reload the pilot page without `?measure`.
