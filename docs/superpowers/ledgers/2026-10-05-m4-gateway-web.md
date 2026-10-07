# SDD ledger — plan: docs/superpowers/plans/2026-10-05-m4-gateway-web.md
Spec: docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md (read; binding authority)
Pre-flight (shared interfaces):
- T1 ipc.js → T3 hub, T5 server: encoders + CoreClient senders — OK
- T2 ClockSync → T3 hub — OK
- T3 ControlHub → T5 server — OK
- T4 config DEFAULTS/loadConfig → T5 main/server, T8 e2e — OK
- T6/T7 web modules → T8 app.js — OK
- M3 core (after review fixes) → T8 e2e: core config without status_socket_path is valid (status socket off by default, M3 Final ruling); ipc protocol unchanged — OK
- T9 install.sh edit base = M3 install.sh — unchanged by the M3 review fixes — OK
Ruling: execute on main (user chose "Commit on main" 2026-10-06) — cost if wrong: history on main, nothing pushed.
Task 1: complete (commits f973818..e918823, tests: npm --prefix gateway test → # duration_ms 382.195867)
Task 2: complete (commits e918823..8314de4, tests: npm --prefix gateway test → # duration_ms 438.015859)
Task 3: complete (commits 8314de4..a03c903, tests: npm --prefix gateway test → # duration_ms 468.531739)
Task 4: complete (commits a03c903..840a67f, tests: npm --prefix gateway test → # duration_ms 678.516353)
Task 5: complete (commits 840a67f..357ef57, tests: npm --prefix gateway test → # duration_ms 1689.612683)
Task 6: complete (commits 357ef57..a737b00, tests: npm --prefix gateway test → # duration_ms 1681.543431)
Task 7: complete (commits a737b00..22447bf, tests: npm --prefix gateway test → # duration_ms 2035.302988)
Task 8: complete (commits 22447bf..f759176, tests: npm --prefix gateway run e2e → # duration_ms 21611.964471)
Task 10: deferred — hardware task (install on the Pi + checklist on PC and Android with the bench of M3); module needs XT30 power and M3 Task 8 first. Not complete.
Task 9: Ruling: closed with npm --prefix gateway test instead of the silent systemd-analyze check — task-done aborts when a command prints nothing (empty log + grep under pipefail); the brief's Step 3 check ran and matched (bash -n, systemd-analyze silent; make-cert output as expected) — cost if wrong: none, the check output is in task-9-step-3.log
Task 9: complete (commits f759176..1b1895e, tests: npm --prefix gateway test → # duration_ms 2006.348557)
Final: fixed #1 Critical (malformed upgrade request killed the gateway) — 'a malformed upgrade request is refused and the gateway keeps running' RED (process crash: TypeError Invalid URL, seen as test-file timeout; probe confirmed exit 1) →GREEN; suite 46/46
Final: fixed #3 (no Origin check: cross-site WebSocket hijacking) — 'WebSocket connections from another web origin are refused' RED (Missing expected rejection) →GREEN; suite 46/46
Final: fixed #2 (non-string msg.t crashed the gateway) — 'a message type that is not a string cannot crash the gateway' RED (Cannot convert object to primitive value) →GREEN; suite 50/50
Final: fixed #4 (no recovery after gateway↔core reconnect) — hub 'when the core comes back, the pilot gets a fresh session the core knows' + server 'after the core reconnects, the connected pilot is given a new session' RED (onCoreUp missing / timed out) →GREEN; suite 50/50
Final: Ruling: no try/catch backstop around hub.handle in server.js — the specific crash is fixed with a test; a catch-all without a failing test would hide future bugs — cost if wrong: another unforeseen throw in handle() restarts the gateway (core fails safe).
Final: fixed #5 (page stuck as observer after a reconnect race) — 'a page that wanted to fly reclaims the pilot seat once it is free' RED (missing export) →GREEN; suite 55/55; e2e 1/1
Final: fixed #6 (throttle jumps on re-grip; second finger fights the first) — 're-gripping the throttle does not move it…', 'a second finger on the same pad is ignored' RED (missing export / API) →GREEN; suite 55/55
Final: fixed #7 (layout change moves sticks under the fingers while engaged) — 'pads that moved under the fingers are detected', 'a layout change under the fingers ends control and says why' RED →GREEN; suite 55/55; e2e 1/1
Final: Ruling: StickModel API changed to grab/move/release(pointerId, …) and the existing stick tests were rewritten to it (one expectation changed from -0.4 to an exactly representable 0.5 drag) — the behaviour change is the fix — cost if wrong: none; the old assertions' intent (scaling, clamping, spring/hold) is still tested.
Final: Ruling: the app.js wiring for #5/#7 (reconnect on reclaim, resize/orientation/fullscreen listeners) is covered by unit-tested pure helpers plus the e2e regression, not by its own failing browser test — cost if wrong: a wiring slip would show only on a real phone (M4 Task 10 checklist).
Final: Ruling: deadman.engage() now runs after the full-screen/orientation request settles, so the pad snapshot is taken in the final layout — cost if wrong: the pilot can send ~100 ms later after tapping "Tomar control".
Final: fixed #8 (indicators green during the failures they show) — 'a core that stopped sending status is shown as down…', 'a module whose timing frames stopped is shown as down…', 'the link tracker notices…' RED (missing export) →GREEN; suite 58/58; e2e 1/1
Final: Ruling: segments() now takes links {statusAt, timingAt}; existing view tests pass them, and "timingFrames: 0 → warn" became "no growth seen yet → warn" — cost if wrong: TX shows warn for ~300 ms after connecting.
Final: Ruling: pilot.e2e waits up to 2 s for seg-tx 'ok' instead of asserting at once — TX is deliberately warn until timing-count growth is seen; battery telemetry is replayed instantly so the old instant check raced — cost if wrong: none (still requires green within 2 s).
Final: Ruling: re-graded #12 (footer wraps over the cockpit at phone height) from Minor to Important — a thumb on a stick could hit Desarmar/FAILSAFE mid-flight — cost if wrong: one CSS change and one browser test of extra work.
Final: fixed #12 — 'control buttons stay out of the cockpit on landscape phone screens' RED ("Modo 1" top 277 over cockpit ending 287 at 800x360) →GREEN at 800/740/640x360; suite 58/58; e2e 2/2
Final: Ruling (declined: no LAN authentication) — spec defines auth only for the relay (M7); the Origin check covers the browser case — cost if wrong: anyone on the Pi's Wi-Fi can take a free pilot seat with a non-browser client.
Final: Ruling (declined: one stick at a time with a mouse, no gamepad/keyboard flying) — spec §6.3 specifies virtual sticks — cost if wrong: PC piloting is awkward.
Final: Ruling (declined: tap-to-disarm and one-tap FAILSAFE without confirmation) — specified in §6.3; both are safe-direction actions — cost if wrong: an accidental tap lands or disarms.
Final: Ruling (declined: does Android fire blur for the notification shade / call overlays) — needs real devices; M4 Task 10 checklist — cost if wrong: control continues under an overlay.
Final: Ruling (declined: timer rounding, monotonic clock pause) — both err toward dropping commands — cost if wrong: spurious failsafe.
Final: Ruling (declined: certificate SAN fixed at install time) — operational; mDNS name covered — cost if wrong: re-run make-cert.sh after an IP change.
Final: Ruling (declined: core-side behaviour, Task 10) — reviewed separately / deferred — cost if wrong: none.
Final: minor (deferred): #9 tsync_r trusts the echoed s0 (a malicious pilot page can disable the stale filter); ctl passes unfiltered before the first clock sample
Final: minor (deferred): #10 no backpressure on the core socket (skip ctl while writableNeedDrain)
Final: minor (deferred): #11 rate limit runs after JSON.parse; no cap on connections
Final: minor (deferred): #13 static serves web/test and package.json; no CSP frame-ancestors header
Final: minor (deferred): #14 replayed link telemetry looks fresh for 2 s on connect
Final: minor (deferred): #15 refusal toasts reach observers
Final: minor (deferred): #16 hold-to-arm/clear not operable from the keyboard
Final: minor (deferred): #17 config without tls silently serves plain HTTP on 0.0.0.0
Final: minor (deferred): #18 gcs-gateway.service has only NoNewPrivileges (add ProtectSystem, ProtectHome, PrivateTmp, RestrictAddressFamilies)
Final: merged (ff) branch from the review agent's implementer at the user's request 2026-10-06: 7ebfbeb (403 for foreign origins; logged try/catch backstop around hub.handle — supersedes my "no backstop" ruling), e03cf29 (page restarts seq on pilot welcome; harmless, untested), d63f2b3 (M4 plan code blocks updated to the fixed code). After merge: core 95/95 + 24/24, gateway 59/59, e2e 2/2. Pushed to origin/main (d63f2b3).
