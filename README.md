# elrs-web-gcs

Web ground control station for ExpressLRS drones. A pilot's browser (PC or Android)
flies the drone through a Raspberry Pi 4 and an ELRS TX module, with local video for
several viewers and an optional internet relay.
Proyecto Terminal de Ingeniería, Universidad Iberoamericana, Otoño 2026, Equipo 1.

```
browser ──HTTPS/WebSocket──▶ gateway (Node.js) ──Unix socket──▶ crsf-core (C, real-time)
                                                                    │ USB (CRSF)
                                                         BetaFPV ELRS TX ──RF──▶ ELRS RX + Betaflight
```

| Directory | Contents | Milestone |
|-----------|----------|-----------|
| `core/` | crsf-core daemon and the crsf-probe, crsf-param, crsf-ctl tools (C) | M1–M3 |
| `gateway/` | HTTPS + WebSocket gateway (Node.js) | M4, M6, M7 |
| `web/` | pilot page, video page (plain HTML/JS, no build step) | M4, M6, M7 |
| `tools/` | measurement tools for criteria C1–C4 and the relay | M5–M7 |
| `relay/` | internet relay (Node.js, experimental) | M7 |
| `deploy/` | configs, systemd units, install scripts | M3, M4, M6, M7 |
| `docs/` | design, plans, setup guides, test procedures | all |

Architecture overview: `docs/ARCHITECTURE.md`. How we work: `docs/DEVELOPMENT-PROCESS.md`.
Design: `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md`.
Plans, one per milestone: `docs/superpowers/plans/`.

## Tests

```bash
make -C core test                         # C unit tests (UBSan)
make -C core integration                  # C programs against a fake TX module on a pseudo-terminal
(cd gateway && npm ci && npm test)        # gateway and web unit + integration tests
                                          # (from M7 on, run `(cd relay && npm ci)` first)
(cd gateway && npm run e2e)               # headless Firefox -> gateway -> crsf-core -> fake module
python3 -m unittest discover -s tools/analysis -t tools/analysis
(cd relay && npm ci && npm test)
```

## Safety

**Propellers off** for every bench test. Arming needs the throttle at zero and a deliberate
press-and-hold. Losing the pilot, the gateway or the browser's focus for 300 ms triggers
failsafe, and only an explicit acknowledge clears it. Real flights follow the test-site
rules agreed with the mentor, with the pilot in visual line of sight (never BVLOS).
