# Frozen goals — approved 2026-11-07, not to be changed

Test conditions for every final run: props off, hotspot IoT-05 on **5 GHz (ch 36)**, video on 2 viewers
(laptop + phone), each control run ≥ 5 min armed. "Upper bound" = latency plus clock-sync uncertainty.
Pass/fail for percentages uses the Wilson 95 % one-sided lower bound (z = 1.645), not the raw percentage.

| Goal | Target | Bench evidence (worst run in the target condition) | Margin |
|---|---|---|---|
| **G1** control latency, local | ≥ 90 % of commands sent while armed ≤ 50 ms (upper bound) | 5 GHz + video: 99.63 % (lower 99.52 %). Worst ever with video (2.4 GHz): lower 92.16 % | +9.5 pts (5 GHz), +2.2 pts even on 2.4 GHz |
| **G1b** control tail, local | p99 of delivered commands ≤ 50 ms | 10.9 ms (5 GHz); worst 28.4 ms | ≥ 21 ms |
| **G1t** control latency, tunnel | ≥ 90 % of commands sent while armed ≤ 100 ms (upper bound) | ≈ 96 % (tunnel, no video); p99 delivered 49.6 ms | ≈ +6 pts (video over tunnel not yet measured) |
| **G2** command timing (C1) | p99 frame jitter ≤ 250 µs, max ≤ 1 ms, missed ≤ 0.01 %, from 1 s after start | 5 runs: p99 47–52 µs, max ≤ 289 µs, 0 missed | ≈ 5× (p99), 3.5× (max) |
| **G3** video latency (C2), local | ≥ 90 % of samples ≤ 1000 ms glass-to-glass; **≥ 50 samples, ≤ 1 over** | n = 23: mean 704 ms, max 808 ms, mean + 3 SD 935 ms | ≈ 190 ms on the max |
| **G3t** video latency (C2), page via tunnel | ≥ 90 % of samples ≤ 1200 ms; ≥ 50 samples, ≤ 1 over | n = 21: mean 865 ms, max 959 ms, mean + 3 SD 1040 ms | ≈ 240 ms on the max |
| **G4** video quality (C4) | 2 viewers, ≥ 5 min, ≥ 25 fps, ≤ 5 % frozen, no reconnection | 5 GHz: 30 fps both, 0.2 s frozen, 0 reconnections | 5 fps, ≈ 4.9 pts |

Notes
- G3t: WebRTC media still goes straight to the Pi (no TURN server), so a viewer on mobile data may get no
  video. G3t applies to a viewer on the same network who loads the page through the tunnel.
- G3 was measured with the air unit in Standby (disarmed). Record the same condition in the final test.
- 2.4 GHz failed G4 once (phone froze ≈ 33 s of 300 s), so the 5 GHz hotspot is a required condition.
- Sample size: with 50 samples and at most 1 over the limit, the Wilson lower bound is 91.5 % (passes 90 %).
- Raw C2 readings: `~/ProyectoTerminal/results/c2-video-latency-20261107/` (c2-local.csv, c2-tunnel.csv, readings.py, stats.py). Results page: `tools/analysis/results_page.html` built with `build_results_page.py`.
