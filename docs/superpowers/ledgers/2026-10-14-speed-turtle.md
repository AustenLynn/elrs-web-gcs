# SDD ledger — plan: docs/superpowers/plans/2026-10-14-speed-turtle.md
Spec: docs/superpowers/specs/2026-10-14-speed-turtle-design.md
Pre-flight:
- T1→T2: rc_outputs_t.speed/turtle, stick_cmd_t fields — T2 consumes exactly what T1 produces; ok
- T1→T3: 19-byte CONTROL layout and golden bytes — identical in both tasks; ok
- T4→T5: Switches(setSpeed,toggleTurtle,turtleOff,keyDown,wire), controlMessage(…,sw), reportsTurtle — T5 uses these names; ok
Task 1: Ruling: test_safety.c's positional LOW = {0,0,0,0,0} broke the build (missing-field-initializers -Werror) once stick_cmd_t grew — changed to { 0 } — cost if wrong: none, same zero value
Task 1: complete (commits 8951251..949302a, tests: make -s -C core test integration → OK)
Task 2: complete (commits 949302a..027efbf, tests: make -s -C core test integration → OK)
Task 3: Ruling: 'core client connects, decodes, sends' (ipc.test.js) compares a sent CONTROL with CONTROL_GOLDEN; the plan did not list it — its call now sends speed 2, turtle 1 like the golden bytes — cost if wrong: none (test-only)
Task 3: complete (commits 027efbf..62bce29, tests: npm --prefix gateway test → # duration_ms 11074.427047)
Task 4: complete (commits 62bce29..39e1dd4, tests: npm --prefix gateway test → # duration_ms 11694.695666)
Task 5: Ruling: the plan's e2e selector '[data-speed=\\"0\\"]' was mis-escaped (broke the JS string) — used \" like the file's other selectors — cost if wrong: none (test-only)
Task 5: Ruling: CSS uses var(--warn) without the plan's fallback colour — --warn exists in :root (#ffb84d) — cost if wrong: none
Task 5: Ruling: the Prueba side panel overflowed at 1100x640 (40 px down, clipped sideways) once 4/5/6 and T joined its key list — added a short-screen block (smaller gaps) and full-width rows for the two long entries (li.wide) — cost if wrong: a slightly denser Prueba panel on 640-760 px tall computer screens
Task 5: complete (commits 39e1dd4..b22f928, tests: npm --prefix gateway run e2e → # duration_ms 215475.368652)
Task 6: Ruling: the turtle section went in as aquila20.md §4 before 'Not yet known' (now §5), and the one in-file reference to it was updated — cost if wrong: none
Task 6: complete (commits b22f928..6ea9844, tests: npm --prefix gateway test → # duration_ms 11414.409881)
Final review: fresh reviewer (opus); 0 Critical, 0 Important, 6 Minor; verdict ready to merge
Final: Ruling: re-graded Minor 1 (CH8 stays high when the pilot/gateway is lost while DISARMED) to Important — the plan's Review Focus 3 says CH8 must drop when the pilot loses control and the core, not the page, must enforce it — cost if wrong: one small extra fix
Final: fixed CH8 kept high after losing the pilot/gateway while disarmed — test_losing_the_pilot_or_gateway_drops_turtle_even_disarmed RED→GREEN, suites: core 110 + 33, gateway 153, relay 11, analysis 26, e2e 6
Final: minor (deferred): validation reserves ch_speed/ch_turtle wherever they point, not physical CH7/CH8 (spec says "reserves CH7 and CH8"); a deliberate misconfig (ch_speed=9, ch_mode=7) passes
Final: minor (deferred): an old core with a new gateway rejects the 19-byte CONTROL and reconnect-loops (fail-closed); restart order not documented — install.sh already says to restart all three services
Final: minor (deferred): Turtle can be toggled on during FAILSAFE (masked on the wire) and goes out right after the ack; visible on the button
Final: minor (deferred): stale "CH7 sensitivity kept at S" comments/tests: deploy/crsf-core.conf:26, test_chmap.c:43-57, test_core.py failsafe_on (requires CH7 low), pilot.e2e.js, HANDOFF §6 open item
Final: minor (deferred): local m4-pilot-checklist.md rows 2 and 6 still expect "Normal" etc. instead of "Normal · Slow"
