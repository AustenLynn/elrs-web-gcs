# Control latency implementation ledger

- Scope: approved three software segments; no capture hardware, no radio-reception claim.
- Ruling: work in the current checkout and leave existing user changes untouched. Running
  services use /opt/gcs, so editing/building here does not deploy or change flight settings.
- Browser/hub tests were observed failing before instrumentation existed; core integration
  failed before support for control_trace. Analysis tests failed with missing report module.
- Added opt-in browser manifest, gateway timing and core IPC/serial events. Safety logic and
  IPC wire encoding unchanged. Full active serial writes count once; masked/replaced commands
  remain unsuccessful in the manifest denominator. Core files are written only by IPC thread.
- Initial checks: core unit suite passed; 241 gateway/web tests passed; 41 core integration
  tests passed; 35 initial analysis tests passed. Real headless Firefox -> gateway -> core ->
  simulated TX validated trace correlation and shared Pi monotonic clock ordering.
- Independent review found two P2 issues: gateway boundary before encoding; stale deployment
  disarmed check during backup. Added red regressions, moved timestamp immediately before
  socket.write, and stopped gateway/rechecked fresh status before stopping core. Deployment
  refuses core stop and restores gateway if not DISARMED. Reviewer confirmed both fixes.
- Gateway suite after review: 241 passed; analysis plus deployment guard: 37 passed.
- Full browser suite: 9 passed, one phone-layout timeout (120 seconds), zero assertion
  failures. Isolated layout rerun tracked separately; no unrelated layout code changed.
- Ruling: correct the pre-existing video recorder's measurement acceptance, within the
  original requested video campaign: reject mean fps <25 or non-720p; record a full 310 s
  from the first sample to allow 300 s overlap when clients start within 10 s; export wallMs.
  Two new tests failed then passed. Absolute client clocks still need synchronization and
  overlap corroboration; no false claim that two clients were measured automatically.
- Live deployment attempted only as privilege preflight: sudo -n true requires a password.
  No live configuration or services were changed. deploy/measure-control.sh is prepared for
  execution in the user's Pi terminal. Physical campaigns require user-operated bench clients.

- Final gateway/browser suite after video updates: 243 passed. Analysis/deployment: 37 passed.
  Simulated video playback e2e passed. The phone-layout case timed out both in the full suite
  and a layout-file-only retry; the original-code single-case baseline passed in 55 seconds.
  The matching updated-code single-case comparison also passed (40 seconds); the full-suite/layout-file timeout remains recorded rather than claimed green.
- Independent reviewer confirmed the video threshold/duration/CSV changes have no important
  findings. The deployment remains prepared but not executed because sudo requires a password.

## 2026-11-05: damaged logs and the first qualifying campaign

- The Pi restarted at 18:47 local (power cut or hard reset). Both measurement logs then held
  runs of NUL bytes between the old and the new lines, and the report stopped with "unusable input".
- Ruling: `read_jsonl` removes NUL bytes, skips a line of NUL bytes only or one that is still not a
  JSON object, and counts it; the report prints `Skipped damaged log lines` and stores
  `damaged_lines`. A skipped record can only turn a command into a failure, never a success, so
  damaged lines do not block a PASS. Cost if wrong: a capture with a damaged middle is judged on
  fewer matched records than it really had (only ever pessimistic). Three tests failed first
  (the report crashed), then passed; analysis suite 40.
- Campaign 2026-11-05 20:47-20:54 local (measure-20261106T024707Z), laptop on the local Wi-Fi,
  `https://192.168.100.65:8443/?measure`, props off, throttle 0 while armed: 19,558 commands sent,
  18,680 complete, all `local`. Total p50 4.55 ms, p90 7.57, p99 18.59, max 103.91.
  Within 50 ms 95.44 % including clock uncertainty (max 2.57 ms). **PASS.** Failures: 194
  before arming, 300 replaced by a newer command in the same 4 ms frame, 384 after `rf_lost`
  at 20:53:59 (the drone stopped answering; its battery is the likely cause, not logged), 14
  over 50 ms. Files: `~/ProyectoTerminal/results/control-latency-20261106T024707Z/` (outside the repo).
- Same session, C1 frame timing over 880 s: the whole file FAILS only on the first frame after
  the core started (6.2 ms late, counted as the one missed slot). From 1 s after start: 219,854
  frames at 250.0 Hz, p99 50.3 us, max 234.1 us, no missed slots, PASS. Ruling: the procedure's
  "after the initial connection has settled" allows excluding the first second; both results
  are reported. Pi at 41 C, not throttled.
- Known minor: `timing_report.py` crashes on the half-written last row of a timing log that the
  core is still writing; run it on a copy without that row, or after stopping the core.
- Suites before the commit: C unit all, integration 41, relay 11, gateway+web 243, analysis 40.
  Browser e2e not re-run (Pi heat rule; the phone-layout timeout above is still open).
