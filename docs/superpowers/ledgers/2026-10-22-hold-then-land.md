# Status: all tasks, the final whole-branch review and its fixes done, 2026-10-23 (not merged, not deployed)

Branch `feat/hold-then-land`. The user asked to stop, document and push during Task 9 (docs).
Task 9's partial docs were kept and HANDOFF was finished by the controller. The final whole-branch review
(most capable model) ran on 2026-10-23 after the user said continue; its findings were fixed and re-reviewed. The Pi still runs `main` from /opt/gcs.

Suites on the Pi 4, 2026-10-23: C unit 141, integration 40, relay 11, gateway+web 236, analysis 26,
browser e2e 10/10 (hold e2e 3 runs × 3, ≤ 48 °C, throttled 0x0).

**Still owed before deployment:** team approval and spec §8 (C3 reading, measured
`hold_throttle` and `land_ms`); the bench test `docs/procedures/hold-bench-test.md`. Installing with
`hold_ms = 0` removes the automatic handover (`docs/HANDOFF.md` §6).

---

# SDD ledger — plan: docs/superpowers/plans/2026-10-22-hold-then-land-failsafe.md
Branch: feat/hold-then-land (from docs/hold-then-land-plan f45332f, which is main a9ded5b + the plan). Spec: docs/superpowers/specs/2026-10-21-hold-then-land-failsafe-design.md (reachable).

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T4 | config_t hold_ms/hold_throttle/land_ms → rtloop_init safety_set_hold | consistent |
| T2→T3 | SAFETY_HOLD=3/LANDING=4, REFUSE_NOT_STANDBY/NOT_IN_HOLD → ipc_proto | consistent |
| T2→T4 | safety_take_report, hold_ev_t, safety_stage_left_ms → rtloop/evlog | consistent; BUT T2 removes safety_take_handover still used by rtloop.c; `make -C core test` builds only unit tests, so the daemon would stay broken until T4 |
| T3→T4 | IPC_TAKE/LAND, IPC_EVENT 4-9, STATUS 96 → ipcserver/rtloop/core_client.py | consistent |
| T3→T5 | STATUS golden bytes → gateway ipc.test.js | T3 prints the golden but doesn't store it anywhere T5 can read |
| T4 self | integration count "36 − 3 + 7 = 40" vs tests listed (5 in HoldTest + 1 hold-off class = 6) | arithmetic wrong: 39 |
| T5→T6 | hub `log` option → connlog | T5 test "late bursts over the tunnel are dropped as stale and logged" asserts gap/stale log lines that T6 implements |
| T5→T7 | event shapes, takeover welcome, welcome.standby → page | consistent |
| T7→T8 | #btn-ready removed (T7) vs handover.e2e.js uses it (deleted in T8) | e2e red between T7 and T8; acceptable, T8 replaces it |
| T6 self | config eventLog, LogsDirectory | consistent |
| T8 self | 9 − 2 + 3 = 10 e2e | consistent |
| T9 self | counts "integration 40" | follows T4 error |
| Global "run every suite per task" vs CLAUDE.md heat rule | browser e2e is heavy on the Pi | conflict |

Ruling: T2 keeps `make -C core` (the daemon) building: it makes the minimal edit in rtloop.c (drop report_handover / EV_HANDOVER pushes, or loop safety_take_report without IPC wiring); full wiring stays in T4 — every commit should build — cost if wrong: a little throwaway code in rtloop.c.
Ruling: T3 writes the 99-byte STATUS golden (hex, from the C encoder of sample_status) to <workspace>/status-golden.txt; T5 reads it — the plan's "print for Task 5" had no carrier — cost if wrong: none.
Ruling: integration count after T4 is 39, not 40; T9 writes the measured counts — plan arithmetic slip — cost if wrong: a wrong number in HANDOFF.
Ruling: the "late bursts over the tunnel … logged" hub test moves from T5 to T6 (T6 owns the gap/stale logging); T5 keeps a plain stale-drop assertion only if needed — tests belong with the code they pin — cost if wrong: none.
Ruling: per task, run every non-browser suite (C unit, integration when core touched, relay, gateway+web, analysis); the browser e2e suite runs in T8 only (full suite + 3 hold runs) — CLAUDE.md heat rule outranks the plan's "every suite" — cost if wrong: an e2e regression from T5–T7 found later, in T8.

## Tasks
Task 1: dispatched (BASE f45332f, implementer sonnet)
Ruling: commits carry only the Co-Authored-By trailer, not CLAUDE.md's Claude-Session line — the session's attribution rule lists only Co-Authored-By and every earlier commit/PR this month used only that — cost if wrong: trailers to amend before merge.
Task 1: minor (deferred): boundary values (hold_ms 10000, land_ms 1000/30000, hold_throttle 0/1000) not asserted valid
Task 1: minor (deferred): hold_throttle 1001 reports "is required…" instead of an out-of-range message (plan-mandated single check)
Task 1: complete (commits f45332f..f9b7510, review clean)
Task 2: dispatched (BASE f9b7510, implementer opus)
Ruling: a TAKE still pending when HOLD expires stays pending in LANDING (the taker's first command then makes ARMED) — the hub already seated the taker on `taken` (R1) and TAKE is allowed during LANDING anyway, so cancelling would strand a seated pilot — cost if wrong: one line in safety.c.
Ruling: a seat lost to pilot_lost is cleared on any exit from HOLD/LANDING (Desarmar, manual, rf), not only at the end of LANDING — the pilot is gone either way and the hub needs session 0 to seat the queue head — cost if wrong: small.
Ruling: rf_lost wins over cmd_timeout when both go stale in the same tick — radio loss is an instant path (spec §4.1) — cost if wrong: none (both end with motors stopped by the drone).
Task 2: minor (deferred): no test for TAKE pending across HOLD expiry then first command → ARMED; none for rf_lost beating cmd_timeout same tick; none for low-throttle skip via pilot_lost
Task 2: minor (deferred): Desarmar from HOLD leaves out.throttle at hold_throttle with ARM low (cleaner: zero it)
Task 2: minor (deferred): safety.h safety_control comment says "fresh and applied" — now "accepted"; test_no_resume_during_landing ignores safety_control's return; safety_take unused now (brief signature)
Task 2: minor (for Task 4): log_sticks treats only ARMED as armed — Task 4 must switch to in-flight
Task 2: complete (commits f9b7510..2761b60, review clean)
Task 3: dispatched (BASE 2761b60, implementer sonnet)
Ruling: Task 3's stopgap in ipcserver.c (EV_HANDOVER sent as IPC_EVENT_TAKEN) is accepted to keep the daemon building; Task 4 rewires events properly — cost if wrong: none, nothing emits EV_HANDOVER now
Task 3: minor (deferred): STATUS sample leaves pitch/yaw/turtle 0, so a pitch/yaw swap isn't caught by the round trip
Task 3: complete (commits 2761b60..7ff5a91, review clean)
Task 4: dispatched (BASE 7ff5a91, implementer opus)
Ruling: LAND→throttle-low integration check uses 0.15 s instead of the brief's 0.1 s — slack for the Pi's scheduling; the core reacts in one frame (4 ms) — cost if wrong: a slower LAND would pass unnoticed up to 150 ms
Task 4: minor (deferred): LANDING window only checked for "no ARM low", not every frame = landing(); take test window mostly predates pilot B (brief's 455 throttle); crsf-ctl labels unknown event kinds "land refused"; hold kind mapping has no range guard; stall test doesn't assert frames kept arriving
Task 4: complete (commits 7ff5a91..d7ed7e7, review clean)
Task 5: dispatched (BASE d7ed7e7, implementer sonnet)
Ruling: after taken, the old pilot's welcome is one message {role:'queued', lost:true, position, standby?} (standby:true when it is now the queue head) instead of the brief's literal example without standby — a second welcome would erase lost; Task 7's page must read both fields — cost if wrong: one hub test and page handling
Task 5: minor (deferred): take/land refusals go to the current queue head, not the session that asked (ev.session available)
Task 5: minor (deferred): queued page sending `ready` gets "observers cannot send commands" (test comment says unknown type); two tests loosened to calls.some
Task 5: complete (commits d7ed7e7..5e22851, review clean)
Task 6: dispatched (BASE 5e22851, implementer sonnet)
Ruling: the gateway's command gap counts arrivals of any well-formed command from the seated pilot, stale or not — a stale command still proves the link delivered something; the gap measures the network silence — cost if wrong: gaps hidden behind stale bursts (those show up as stale lines instead)
Task 6: review: 1 Important (sync appendFileSync on the command path, before core.control); ⚠️ items checked by controller: hello handled only when role null (hub.js:86), ctl only for the seated pilot (hub.js:110) — fine
Task 6: minor (deferred): no log rotation / stale-line rate limit; leave logged for sockets that never said hello (role null); server.js `cfg.eventLog ?? null` vs validateConfig rejecting undefined; Cf-Connecting-Ip spoofable on LAN (label, not proof)
Task 6: fix round 1 dispatched (resume implementer; FIX_BASE fa35b1d)
Task 6: fix round 1/5 (1 addressed, 0 open — sync log writer → createWriteStream with 64 KB drop cap, logs after forwarding; commits fa35b1d..3ab9bca)
Task 6: minor (deferred): connlog write() after close()'s end() but before finish isn't guarded (reports "write after end" once, no throw)
Task 6: complete (commits 5e22851..3ab9bca, review clean after 1 fix round)
Task 7: dispatched (BASE 3ab9bca, implementer sonnet)
Task 7: ⚠️ checked by controller: hub resends the queued welcome with standby when the head changes (hub.js:258-262) — fine
Task 7: minor (deferred): refused take leaves the queued page's dead-man engaged (no Esc release now); «Tomar el control» awaits wakeLock inside takeControl() before sending take (a slow wake lock delays the take during the countdown); deadman.test.js comment still says "ready standby"; DEADMAN_TEXT.released unused; tall banner if buttons wrap on short screens
Task 7: complete (commits 3ab9bca..d84b040, review clean)
Task 8: dispatched (BASE d84b040, implementer opus)
Task 8: BLOCKED — product bug: after the pilot's page closes, status.pilotName is null for the whole hold (hub.detach sets this.pilot=null; #statusMsg names this.pilot), so the banner reads "— perdió la conexión" instead of "ana perdió la conexión" (spec §4.5 copy). Esc path and nobody-chooses path pass; timings fine (hold ~2955 ms, landing ~1030 ms). hold.e2e.js written, uncommitted.
Ruling: the fix belongs to Task 5's code (hub status): during HOLD/LANDING with no seated pilot, status.pilotName is the name of the pilot who dropped out, kept until `taken` or until the state leaves HOLD/LANDING; dispatched as a Task 5 follow-up fix (resume the Task 5 implementer), reviewed, then Task 8 resumes — cost if wrong: one hub change.
Note: /tmp holds ~636 gcs-* folders left by the unit suites (gcs-auth, gcs-gw…), pre-existing, not e2e — check size; separate fix outside this plan.
Task 5: follow-up fix f1226cf (pilotName during HOLD/LANDING from lastPilot); it also committed Task 8's in-progress gateway/e2e/hold.e2e.js — accepted, Task 8 finishes and owns that file
Task 5: follow-up fix re-review: addressed, no new breakage (commit f1226cf). Task 8: resumed (implementer resumed with the fix)
Note: a background gateway unit run (node --test, ipc.test.js child) hung for 55 min with 0 CPU since 20:45; killed by controller; ipc.test.js then passed 15/15 runs with a 30 s timeout — not reproduced; flag to final review
Task 8: minor (deferred): invisible U+E00C Esc literal (use ''); hold-throttle sampled at banner time could lag a frame; no check that ARM stays low after landing; landAt = first throttle change (brittle to jitter); after() hooks inside test bodies
Task 8: complete (commits d84b040..4b0b848 incl. f1226cf, review clean; e2e 10/10, hold 3×3 at ≤48 °C, throttled 0x0)
Task 9: dispatched (BASE 4b0b848, implementer sonnet)
Task 9: stopped by the user's request mid-task ("stop, document and push"); its partial docs (specs, ARCHITECTURE, M4 checklist, hold-bench-test.md) kept; the controller finished HANDOFF and this ledger. The final whole-branch review was NOT run.
Final review: dispatched (opus) over a9ded5b..b4f6419 after the user said continue (2026-10-23)
Final review (opus): ready "with fixes": 0 Critical, 2 Important (1 s heartbeat cuts resume window to ~1–2 s; page promises rescue when hold_ms = 0), 6 Minor; deferred-minor triage: fix T2 disarm-throttle, T7 take-before-wakelock + refused-take dead-man, T2 pending-take-across-expiry test, T3 non-zero pitch/yaw sample; rest can stay deferred.
Ruling: STATUS byte 95 (reserved in R2) now carries hold_ds = hold_ms/100 (0 = off) — the gateway needs hold_ms for the heartbeat grace and the page needs "hold on/off" for honest copy; one byte avoids a new message — cost if wrong: a wire change in 3 places.
Ruling: with hold on, the seated pilot's socket survives missed pongs for hold_ms + 1 s; others keep the 1 s heartbeat — an early pilot_lost during a hold only destroys the resume (spec goal 3) — cost if wrong: a dead pilot socket lingers up to 11 s before its seat frees.
Ruling: Minor 2 (0 → hold_throttle step when a pending take completes in LANDING) is documented, not capped — it returns toward hover, never to a fall, and capping would make the first frame disagree with the taker's stick — cost if wrong: one throttle step on a rare race.
Ruling: the reviewer's trailer point is accepted from now on: new commits carry both Co-Authored-By and the Claude-Session line (the session URL is now known); earlier commits are not rewritten — cost if wrong: none.
Final fixes: dispatched (one fixer, opus, FIX_BASE b4f6419)
Final fixes: done (commits b4f6419..ed782e2): C unit 141, integration 40 ×2, relay 11, gateway+web 236 ×3 (no hang), analysis 26, hold e2e 3/3 at 41–47 °C.
Ruling: hold_ds rounds down (hold_ms not a multiple of 100 reports up to 99 ms short) — the 1 s heartbeat grace covers it — cost if wrong: none.
Ruling: the hold banner's buttons are also hidden when holdMs is 0 or unknown — no buttons for a rescue the core would refuse — cost if wrong: none.
Final fixes: scoped re-review dispatched (opus)
Final fixes: re-review all addressed, no new breakage. Final review complete.
