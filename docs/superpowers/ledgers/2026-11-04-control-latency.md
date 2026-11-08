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

## 2026-11-05: tunnel comparison and statistics

- Tunnel run 21:36-21:43 local (measure-20261106T033547Z), same laptop through the Cloudflare URL:
  19,559 sent, 18,001 complete, all `tunnel`. Total p50 33.17 ms, p99 49.61, max 177.36.
  Within 50 ms: estimate 91.19 %, with clock uncertainty 0.00 % (RTT/2 about 30 ms through the
  tunnel). NOT VALIDATED by design (routing). 1,519 replaced in the same frame, 39 stale.
- `tools/analysis/latency_stats.py` (standard library only): Minitab-style summary, Anderson-
  Darling, Ppk normal / percentile (ISO) / lognormal (ISO), observed and expected PPM, Xbar-R
  (subgroups of 25), Wilson interval, Mann-Whitney, two-proportion z. 16 tests written first.
- Ruling: quote the percentile (ISO) Ppk and the observed PPM. The data fails normality (A2 1311
  local, 2211 tunnel) and the lognormal fit also fails, so the normal Ppk (4.36 local) overstates
  capability. Local total: Ppk percentile 1.85, 696 PPM over 50 ms. Tunnel: 0.20, 9,166 PPM.
- Ruling: Anderson-Darling p is 0 for adjusted A2 >= 10; the D'Agostino quadratic turns back up
  past A2 = 153 and first reported p = 1.000 for A2 = 1311 (caught on the real data; a test now pins it).
- Local vs tunnel: median +28.62 ms, Mann-Whitney z -165.5 (p < 0.005), within-limit
  two-proportion z 16.8 (p < 0.005). Xbar-R: 195 / 174 subgroup points out of control (Wi-Fi bursts).
- `tools/analysis/build_results_page.py` + `results_page.html` render the replay and charts from the
  stats JSON. Output: `~/ProyectoTerminal/results/control-latency-results.html`.

## 2026-11-06 — video runs and goal evidence

- Video run 1 (measure-20261106T184918Z): 93.48 % of all sent within 50 ms with uncertainty (pass); p99 26.1 ms; browser sent at 41.7 Hz under video decode load.
- Video run 2 (measure-20261106T214018Z): 82.31 % of all sent (fail). Delivered commands: 99.47 % within 50 ms, p99 28.2 ms. The loss is the denominator: a 306 ms Wi-Fi stall at 21:44:09 tripped the 300 ms command timeout (LANDING, then FAILSAFE, operator re-armed), and 6.9 % of armed commands were replaced in the same 4 ms frame because Wi-Fi delivered them in bursts.
- Same commands with "sent while armed" as the denominator: 98.35 / 96.25 / 92.61 % for no-video / video 1 / video 2.
- C1 from 1 s after start, test window +-30 s: p99 48-52 us, max <= 290 us, 0 missed slots in all four runs.
- Suspected cause of the bursts: the Pi hotspot (wlan1, RTL8822BU, IoT-05) runs on 2.4 GHz channel 1, beside the 1 W ELRS TX on 2.4 GHz. Proposed fix: move the AP to 5 GHz channel 36-48 (no DFS in MX). Not applied.
- latency_stats.py now compares every run with the first (`comparisons`); the results page takes any number of runs and an optional goal-evidence JSON.

## 2026-11-06 — hotspot on 5 GHz (measure-20261106T222546Z)

- IoT-05 (AP-IoT, wlan1) moved from 2.4 GHz channel 1 to 5 GHz channel 36, 20 MHz (operator ran ~/ap-5ghz.sh via systemd-run; revert = band bg, channel 1).
- Same procedure, video on laptop + phone: sent while armed 99.63 % within 50 ms (was 92.61 % on 2.4 GHz); p99 delivered 10.9 ms (was 28.4); replaced while armed 0.12 % (was 6.87 %). Median equals the no-video run (Mann-Whitney p 0.34).
- C4: both viewers 30.0 fps, 0 dropped, laptop 0.2 s frozen, phone 0; jitter buffer 24 / 33 ms (was 102 / 171); overlap 309.7 s.
- Still two command timeouts (22:29:41, 22:31:04): browser pause 143 ms plus ~270 ms network in the first, commands steadily ~220 ms old in the second (TCP queue behind a lost frame). All-sent 89.16 % and whole-session 92.77 % are lowered by these and by ~110 s of pre-arm sending.
- C1 test window: p99 47 us, max 215 us, 0 missed.

## 2026-11-07 — C2 video latency and frozen goals

- C2 glass to glass (drone camera films clock.html on the laptop; watch.html on the same screen), disarmed, air unit in standby, ELRS TX off (not needed for video). Local: n 23, mean 704 ms (95 % CI 671-737), SD 77, max 808. Page via tunnel: n 21, mean 865, SD 59, max 959. Tunnel adds 140 ms at the median (Mann-Whitney p < 0.001).
- Ruling: the video digits are motion-blurred past the tenths, so each video time is the tenth + 0.05 s (reading error +-50 ms, uniform, unbiased).
- Ruling: G3 cannot be 300 ms; the chain (air unit, goggles, HDMI capture, H.264 encode, WebRTC, browser) costs ~0.7 s. Set at 1000 ms local, 1200 ms via tunnel.
- Ruling: every percentage goal uses the Wilson 95 % one-sided lower bound (z 1.645). With 23 samples even 23/23 gives 89.5 %, so the final C2 takes 50 samples and allows 1 over (91.5 %).
- Tunnel control (no video) with a 100 ms limit: 96.44 % of commands sent while armed (lower 96.21 %), basis of G1t.
- Goals approved by the operator on 2026-11-07 and frozen: `docs/goals/2026-11-07-frozen-goals.md`. Final runs on 5 GHz with two viewers.
- Results page now opens with the frozen goals table, has a C2 replay (clock pair per screenshot, strip plot against the limits) and a 2.4 GHz vs 5 GHz dumbbell chart and table.
- Control + C4 through the tunnel was not run: no battery for the TX module that day.
- e2e: one failure on the first run, 10/10 on the rerun (gcs-video live on the same Pi).

## 2026-11-07 — three presentation goals (replace the eight-goal list)

- Ruling: the operator reduced the goals to three for the presentation and froze them; the presentation shows the bench results already measured, with no new test afterwards.
- Goal 1, commands (C1): p99 <= 250 us, max <= 1 ms, missed <= 0.01 %. All 5 runs: p99 52 us worst, max 289 us, 0 missed of 500,172 frames.
- Goal 2, control latency through the Cloudflare tunnel: >= 90 % of commands sent while armed <= 150 ms with clock uncertainty. Tunnel run: 96.74 % of 18,582 (Wilson one-sided lower 96.5 %). Ruling: 150 ms because losses are replaced commands (3.13 %), not slow ones (100 ms 96.44 %, 200 ms 96.86 %), and it stays under the 200 ms stale filter. Measured without video viewers.
- Goal 3, video latency (C2): >= 90 % <= 999 ms. Both sessions pooled: 44/44, mean 781 ms, SD 106, max 959 ms, Wilson lower 94.2 %. Ruling: pooled because neither session alone can prove 90 % (23/23 gives 89.5 %).
- Ruling: video was never relayed. In both C2 sessions the WebRTC media crossed the local Wi-Fi; the tunnel carries only HTTP/WebSocket and there is no STUN/TURN. Viewers on other networks get no video (the Pi has a global IPv6, so some IPv6 networks might, unverified). /video/whep has no sign-in. A TURN relay with sign-in is the next step.
- Former G1, G1b, G4, G4b stay as supporting results (S1-S4). Former G1t (100 ms), G3 (1000 ms) and G3t (1200 ms) are withdrawn.
