# Frozen goals — approved 2026-11-07, not to be changed

The presentation states three goals and shows the bench results already measured (2026-11-05 to
2026-11-07). There is no new test after the presentation. Every percentage passes on the
**Wilson 95 % one-sided lower bound** (z = 1.645), not on the raw rate. Props off in every run.

## The three goals

| # | Goal | Target | Bench result | Margin | Status |
|---|---|---|---|---|---|
| 1 | **Commands** (C1) | The 250 Hz CRSF stream from crsf-core: p99 frame lateness ≤ 250 µs, max ≤ 1 ms, missed slots ≤ 0.01 %, from 1 s after start | 5 runs (local, tunnel, and 3 with the pilot + 2 video viewers): p99 47–52 µs, max 289 µs, 0 missed | ≈ 4.9× (p99), 3.5× (max) | **Met** |
| 2 | **Control latency** | ≥ 90 % of the pilot's commands sent while armed reach the serial write ≤ 150 ms, clock uncertainty included, **pilot connected through the Cloudflare tunnel** | 96.74 % of 18,582 commands (Wilson lower 96.5 %); median 33 ms, p99 50 ms (63 / 79 ms with uncertainty) | +6.5 pts | **Met** |
| 3 | **Video latency** (C2) | ≥ 90 % of samples ≤ 999 ms glass to glass (camera to viewer's screen) | 44 / 44 samples ≤ 999 ms (Wilson lower 94.2 %); mean 781 ms (SD 106), max 959 ms | +4.2 pts, 40 ms on the max | **Met** |

### What each result does and does not cover (say it if asked)

- **Commands:** the core runs at real-time priority, apart from the gateway and the video service.
  Video viewers and the tunnel made no measurable difference.
- **Control latency:** the tunnel run was made from the lab (laptop → internet → Cloudflare Querétaro →
  tunnel → Pi), **without video viewers**. A pilot who is really far away adds their own internet
  delay. Losses are replaced commands (3.1 %), not slow ones: raising the limit to 200 ms only gives
  96.86 %. Locally, with the pilot + 2 viewers on 5 GHz, 99.6 % arrive within 50 ms.
- **Video latency:** two sessions, 23 samples local and 21 with the page served through the tunnel.
  In both, the video stream itself travelled over the local Wi-Fi: WebRTC media does not pass through
  the Cloudflare tunnel (no TURN relay). A viewer on another network does not get video today. A TURN relay
  (e.g. Cloudflare Realtime TURN) is the next step and was not validated.
  The sessions differ by 160 ms (704 vs 865 ms mean) for reasons not identified (air unit
  temperature, bitrate). Measured disarmed, air unit in standby. Each video time is read to the
  tenth of a second (±50 ms reading error, averages out).

## Supporting results (evidence, not headline goals)

| Item | Target | Result |
|---|---|---|
| Control, local, pilot + 2 viewers, 5 GHz | ≥ 90 % ≤ 50 ms | 99.63 % (lower 99.53 %) |
| Control tail, local | p99 delivered ≤ 50 ms | 10.9 ms (5 GHz); worst 28.4 ms (2.4 GHz) |
| Video frame rate (C4) | 2 viewers, ≥ 5 min, ≥ 25 fps | 30 fps both (5 GHz) |
| Video freezes (C4) | ≤ 5 % frozen, no reconnection | 0.06 % (5 GHz); 11.1 % on 2.4 GHz — why the hotspot is on 5 GHz |

Data: `~/ProyectoTerminal/results/` on the Pi (control-latency-*, c2-video-latency-20261107/,
goal-evidence.json, latency-stats-5runs.json). Page: `tools/analysis/results_page.html` built with
`build_results_page.py`. Artifact: https://claude.ai/artifact/29FbTo9q2QxSu1zqs4fNLn
