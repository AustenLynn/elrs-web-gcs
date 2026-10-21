# Status: all tasks done and reviewed, 2026-10-20 (not merged, not deployed)

Branch `feat/pilot-auth-handover`. Tasks 1–9 done; whole-branch review done (fresh reviewer),
its Critical and Important findings fixed. The Pi still runs `main` from /opt/gcs.

**Still owed before deployment:**
- Run all suites on the Pi (this session ran them on an x86 WSL box: C unit 125, integration 36,
  relay 11, gateway+web 212, analysis 26, e2e 8 + video skipped).
- Create the first admin on the Pi
  (`sudo -u gcs node /opt/gcs/gateway/src/users-cli.js /var/lib/gcs/users.json add <name> --admin`);
  without `auth.usersFile` in `/etc/gcs/gateway.json` the new gateway refuses to start.
- Bench: `docs/procedures/m4-pilot-checklist.md` steps 15–17, propellers off.

---

# SDD ledger — plan: docs/superpowers/plans/2026-10-20-pilot-auth-handover.md

Spec: docs/superpowers/specs/2026-10-20-pilot-auth-handover-design.md
Branch: feat/pilot-auth-handover (from main 1eb2326). Work happens on the branch in the main checkout (no worktree): the live system runs from /opt/gcs, not from the repo.
Ruling: branch in place instead of a worktree — the services run from /opt and only change on install.sh — cost if wrong: a stray edit lands in the main checkout's working tree, visible in git status.
Ruling: `.superpowers/` added to .git/info/exclude (local only) — it was untracked, and `git add -A` would commit it — cost if wrong: none for the repo; the team's clones don't get the exclude.

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 → T2 | T1 changes `safety_disarm(s, session)`, `safety_pilot_lost(s, session, now)`; T2 updates callers | rtloop.c calls both (lines 49, 51). `make -C core test` does not build rtloop, but `make all` would break between T1 and T2. **Ruling below.** |
| T2 → T3 | IPC 0x08, event kind 3 (detail = fs_reason_t, session = new) | consistent |
| T3 → T5 | `core.standby()`, `{what:'handover', reason, session}` | consistent |
| T4 → T5 | `hub.attach(client, {user, relay})`; `login()` helper in server.test.js | consistent; T5 updates join() default and server e2e test |
| T4 → T6 | `UserStore`, `Sessions`, `authRoutes` | consistent; T6 adds admin routes to auth.js |
| T5 → T6 | `hub.activePilotName()`, `hub.dropUser(name)` | consistent after the plan's reorder (queue is T5, admin T6) |
| T5 → T7 | welcome roles queued/pilot+takeover/lost, `ready`, status pilotName/standbyName | consistent |
| T7 | `seedInputs` lives in `inputmode.js`, but the Files list omits `web/js/inputmode.js` and `web/test/inputmode.test.js` | **Ruling below.** |
| T4, T7, T8 | relay clients attach `{relay:true}`; relay-path tests | consistent |
| T8 | e2e count 6 → 7 | consistent |
| T1 self | tests vs code | consistent (throttle_arm_max 50; cmd after arm at 400 is fine) |
| T2 self | expected 36 integration tests (33 + 3) | consistent |
| T4 self | config now requires `auth.usersFile`; existing server tests must create a users file | covered by the task's setup-helper step |
| T5 self | server.test end-to-end pilot test needs login | covered (Files line) |
| T6 self | consumes T5 hub API, uses a fake hub in tests | consistent |
| T9 self | docs only + suite run | consistent |

Ruling: Task 1 also updates the two rtloop.c call sites mechanically (`safety_disarm(s, c->session)`, `safety_pilot_lost(s, c->session, l->now_ns)`) so the tree builds after every task; Task 2 adds the rest of the plumbing — cost if wrong: Task 2's diff is slightly smaller than the plan says.
Ruling: Task 7 may modify `web/js/inputmode.js` and `web/test/inputmode.test.js` (where the plan puts `seedInputs`) — cost if wrong: none.

## Progress
BASE Task 1: 1eb2326; implementer a67c2e65922e3b0a3 (opus)
Task 1: implementer DONE_WITH_CONCERNS at 99f0f61.
Ruling: arm and ack are refused (REFUSE_LINK_STALE) while handover_pending — after a handover the 300 ms timer is "fresh" without the new pilot having sent anything, so an arm/ack would be judged on the old pilot's throttle — cost if wrong: a new pilot must send one command before arming (20 ms at 50 Hz), invisible in practice.
Ruling: safety_session_start and safety_gateway_lost also clear the pending handover report (handover_to = 0) — a report must never outlive the session change that made it moot — cost if wrong: none.
Ruling: silent ignore (no EV_REFUSED) of DISARM/FAILSAFE from a non-active session, and turtle unchanged by a disarmed handover, stand as written — spec §4.5 "nothing else changes" / plan Task 2 maps refusals only for arm/ack — cost if wrong: a later refusal event to add.
Task 1: review approved (spec ✅, quality approved). 3 cannot-verify items resolved below.
Ruling: (review ⚠️a) safety_set_standby is accepted while handover_pending (stored, not used): try_handover's own pending guard already prevents chaining, so the gateway never has to re-send STANDBY after a handover. Done in Task 2, with test_no_chained_handover adjusted (standby stored, pilot_lost(9) during pending still FAILSAFE) — spec §4.5's intent is "no chained handovers", not the mechanism — cost if wrong: none for safety; one assertion changed.
Ruling: (minor 1) folded into the same Task 2 change: STANDBY 0 always clears; only a non-zero standby equal to the active session is ignored.
Ruling: (minor 2) folded into Task 2: handover_pending is cleared wherever session becomes 0 (pilot_lost fail-safe path).
Ruling: (review ⚠️b) Task 5: the hub sends STANDBY only after SESSION for the active pilot (session_start clears the standby).
Ruling: (review ⚠️c) Task 2: EV_STATE and EV_HANDOVER carry the session that is active after the command/tick (the new session after a handover).
Task 1: minor (deferred): no test for disarm/manual_failsafe with session 0; no test for an old-session DISARM inside the pending window.
Task 1: complete (commits 1eb2326..884e357, review clean)
BASE Task 2: 884e357; implementer ac4ca9456190bf9f3 (sonnet)
Task 2: implementer DONE_WITH_CONCERNS at c00b7dc; controller amended only the commit trailer (Sonnet → Opus 5.5, per the project's attribution line) → new head below.
Ruling: (T2 concern 1) the gateway never sends SESSION for a standby the core promoted — the promoted session is already active in the core; a SESSION would fail safe (session_changed). Carried into Task 5 — cost if wrong: none; a core no-op for SESSION==active is not added.
Ruling: (T2 concern 2) integration tests arm at throttle 0 and then raise it to 300 (throttle_arm_max is 50) — the brief's "arm with throttle 300" was a plan slip — cost if wrong: none.
Task 2 head after amend: 9175f84
Task 2: review approved (spec ✅, quality approved). ⚠️ SESSION-for-promoted-standby already ruled (Task 5 constraint).
Task 2: minor (deferred): core_client.py uses magic number 3 for the handover event kind; EV_HANDOVER inserted before EV_STICKS shifts EV_STICKS's value (no numeric dependence found).
Task 2: complete (commits 884e357..9175f84, review clean)
BASE Task 3: 9175f84
Task 3: review approved. ⚠️ hub onCoreEvent wiring for handover → Task 5 (it consumes handover events there).
Task 3: minor (deferred): no test for an unknown handover reason byte or an unknown event kind; EVENT_KINDS placement in ipc.js.
Task 3: complete (commits 9175f84..5d7bec6, review clean)
Ruling: from Task 4 until Task 8, the browser e2e suite may fail to start (the gateway config now requires auth.usersFile, and e2e has no login yet); Task 8 restores it — the plan orders e2e last — cost if wrong: e2e is red for Tasks 4–7, none of which runs it.
BASE Task 4: 5d7bec6
Task 4: implementer DONE_WITH_CONCERNS at a085f8b.
Ruling: users-cli changes made while the gateway runs take effect only after a gateway restart (UserStore is in memory) — the CLI is for the first admin; day-to-day changes go through /admin (Task 6), which uses the live store. Task 9 documents "restart gcs-gateway after using users-cli" — cost if wrong: a removed user keeps signing in until restart when removed by CLI.
Task 4: review needs fixes — Critical: aborted /login body crashes the gateway; Important: parallel logins bypass the limit; per-address limit is global behind cloudflared; spec ❌ ok(name) vs ok(name, addr).
Ruling: (review ⚠️ lost update) UserStore re-reads users.json inside its write queue before applying each mutation, so a CLI change made while the gateway runs is never reverted by a later /admin write — fixed in Task 4's fix round since Task 6 builds on it — cost if wrong: one extra small file read per admin change.
Ruling: behind cloudflared, the limiter keys the address on CF-Connecting-IP only when the socket address is loopback — the tunnel connects from localhost — cost if wrong: a local process could spoof the header (it already runs on the Pi).
Task 4: minor (deferred): 413 response may be cut by req.destroy (reject on Content-Length first); expired tokens never swept; no fsync before rename / stale tmp file mode; CLI asks passwords before validating the name; CLI run as root creates a root-owned users.json the gateway cannot read.
Task 4: fix round 1/5 (5 addressed, 0 open — abort crash, concurrent limit, tunnel IP, ok(name,addr), lost update; commits a085f8b..6986f9f)
Task 4: minor (deferred): a valid login on the same address resets the address counter (brief-mandated); server.js does not await files(req,res); a CLI edit reaches a running gateway only after a restart or the next gateway write; no dedicated test for the server.js try/catch.
Task 4: complete (commits 5d7bec6..6986f9f, review clean)
BASE Task 5: 6986f9f
Task 5: implementer DONE_WITH_CONCERNS at 110eaff.
Ruling: after the active pilot's socket closes the hub always waits for the core (handover event, or a status with session 0) before seating the next pilot, even with no standby sent — one rule, and the core stays the authority on who is active — cost if wrong: the next pilot is seated up to 100 ms later.
Ruling: relayClient.js's out-of-date header comment is updated in Task 9 (docs) — cost if wrong: none.
Task 5: review approved. ⚠️ old pilot's late ctl rejected by the core by session — confirmed in safety.c (Task 1 tests).
Task 5: minor (deferred): onCoreUp while awaiting core seats the head without #changed() (queue positions/pilotName stale until next change); lastControl not cleared on #seatHead; lastControl records forwarded (not core-applied) commands — can differ by one round trip in the cmd_timeout window; defensive branch can re-seat a just-lost old pilot when it's the only one queued (core is latched FAILSAFE then); STANDBY may be sent while awaiting core (harmless, add comment); detach splice lacks a -1 guard; no tests for onCoreUp-while-awaiting or dropUser-of-standby-while-awaiting.
Task 5: complete (commits 6986f9f..110eaff, review clean)
BASE Task 6: 110eaff
Task 6: review approved. ⚠️ dropUser withdraws the standby + STANDBY: confirmed by Task 5's hub test "dropUser closes a queued user's sockets and updates STANDBY".
Task 6: minor (deferred): admin add accepts non-string name/password (creates user "undefined"); remove race if a user is promoted between the flying check and the remove await; /admin.html reachable without admin (markup only, API protected); admin page has no message on an Origin 403; password change does not end the target's sessions.
Task 6: complete (commits 110eaff..8a820fa, review clean)
BASE Task 7: 8a820fa
Task 7: implementer DONE_WITH_CONCERNS at 9836934.
Ruling: shouldReclaimPilotSeat fires only on reason 'pilot_present' (not login_required) — otherwise every spectator reconnects every second — cost if wrong: none.
Ruling: a ready standby seated on a free seat (plain welcome pilot, no takeover) keeps its engaged dead-man and sends at once — «Listo» already ran takeControl, and a free seat means the core is at session 0 (not armed), so arming still needs the explicit hold — cost if wrong: the pilot skips one «Tomar control» press.
Ruling: keyboard takeover seeds only the throttle; roll/pitch/yaw start centred because the keyboard model springs back when no key is held — cost if wrong: a held roll/pitch is centred on takeover with the keyboard (touch and step seed all axes).
Task 7: review needs fixes — Important: ready:false sent only from the 50 Hz tick (throttled in hidden tabs); lost:true text never clears.
Task 7: ⚠️ first command after promotion carries th — no unit test; covered by Task 8's handover e2e (throttle channel must not drop) — carry into Task 8's dispatch.
Task 7: minor (deferred): «TIENES EL CONTROL» shown even if the dead-man isn't engaged; seeded sprung axes stay at the old value until the finger lifts (brief-mandated); stick input stays live on a queued page (plain promotion would send an unseen throttle; arming still refused above 5 %); deadman test pins nothing new; implementer-written copy (En la cola: puesto n, login errors, DEADMAN_TEXT.lost) unconfirmed; step/key panels unhidden (invisible) while queued; redundant setReady(true).
Task 7: fix round 1/5 (2 addressed, 0 open — ready:false on every disengage; lost text shown once; commits 9836934..5c8ba1e)
Task 7: minor (deferred): lostPending survives a socket close (stale lost toast after reconnect).
Task 7: complete (commits 8a820fa..5c8ba1e, review clean)
BASE Task 8: 5c8ba1e
Task 8: stopped by the user mid-task; uncommitted work committed as WIP (untested).
Task 8: resumed 2026-10-20 inline (superpowers:executing-plans) on the WSL dev box, not the Pi: build-essential, firefox-esr 140 (linked as ~/.local/bin/firefox) and Node 24.19 installed for it. Core 36 integration / gateway+web 209 / relay 11 green there before any change.
Ruling: Task 8 counts 8 e2e tests (7 pass + video skipped), not the plan's 7 — the plan's Step 2.3 "a second run" (Esc) is its own test next to the closed-page one, so a failure names which path broke — cost if wrong: none.
Ruling: the WIP commit 472bda6 already holds all of Task 8's code and is on origin, so it is not reworded (no force push) and no empty Task 8 commit is made; the ledger records the task — cost if wrong: the branch history shows a "WIP" subject for green code.
Ruling: the e2e suite ran on an x86 WSL box (no vcgencmd, no MediaMTX: video e2e skipped) — the Pi run of all suites is still owed before deployment — cost if wrong: a Pi-only timing failure (300 ms window under load) is found later, on the bench.
Task 8: mutation check — with luis's «Listo» removed, `closing the pilot page…` fails on "timed out waiting for luis shows TIENES EL CONTROL" (the test can fail for the right reason); file restored.
Task 8: complete (commits 5c8ba1e..472bda6, tests: npm --prefix gateway run e2e → ℹ duration_ms 52740.048812)
BASE Task 9: 472bda6
Ruling: Task 9 also updates M4 checklist step 10 (a second device not signed in is a spectator, no "Ya hay un piloto" toast) and adds a sign-in note before step 3 — the old text no longer matches the page — cost if wrong: none.
Ruling: HANDOFF §5 records the counts from the WSL run (C unit 125, integration 36, relay 11, gateway+web 209, analysis 26, e2e 8 with video skipped) and how that box was set up — the Pi was not used this session — cost if wrong: Pi counts differ only by the video test.
Task 9: complete (commits 472bda6..3c9d3e6, tests: npm --prefix gateway test → ℹ duration_ms 5582.341043)
Final review: fresh reviewer subagent (opus), package review-0222e56..3c9d3e6.diff. Verdict: ready with fixes; flight-safety part sound, all five Review Focus items OK.
Final: fixed (Critical) admin screen 403 on every GET in a real browser (no Origin on same-origin GET) — auth.test "a browser reads the admin list without an Origin header" RED→GREEN, plus admin.e2e.js (new) RED "timed out waiting for the pilot list" → GREEN; suite 212/212, e2e 8 pass + video skipped
Ruling: admin GET/HEAD with no Origin header is accepted on the admin cookie alone; a present Origin must still equal Host, and POST/DELETE always need it — browsers omit Origin on same-origin GETs, and a cross-site GET carries no SameSite=Strict cookie and cannot read the reply (no CORS) — cost if wrong: an old browser without SameSite support could be made to send a GET whose reply it cannot read (no state change).
Final: fixed (Important) queued page at position 1 claimed to be the standby while not ready — hub.test "only the standby page is told it is the standby…" and view.test queue text RED→GREEN; suite 212/212
Ruling: the hub marks the standby's queued welcome with standby:true (omitted otherwise) and re-sends a queued welcome when that flag changes; a not-ready position 1 shows "En la cola: puesto 1" — the page cannot know the hub's standby choice — cost if wrong: one extra welcome per ready change.
Final: fixed (Important, raised from Task 6 minor) password change kept the pilot's existing cookies — auth.test "changing a password ends that pilot's sign-ins" RED→GREEN; suite 212/212
Ruling: a password change ends all of that pilot's cookies, the admin's own included when changing their own password (they sign in again) — a leaked password must stop working at once — cost if wrong: an admin changing their own password is sent back to sign in.
Final: minor (deferred): handover evidence-log entry always shows command age 0 (rtloop.c report_handover reads age after try_handover reset it).
Final: minor (deferred): 5 wrong passwords a minute from anywhere lock a named pilot out of signing in (per-username limit, as the spec asked).
Final: minor (deferred): removing a user in the ms window between the core's handover and the hub's event (awaitingCore) can remove the new pilot → failsafe.
Final: minor (deferred): login limiter keys for one-off usernames are never swept (slow, bounded growth).
Final: Ruling: (declined to judge) lastControl vs what is on the air in the cmd_timeout window — stays a deferred minor: only commands forwarded in a few ms, all < 200 ms old — cost if wrong: a small jump on takeover; seeding from lastStatus.channels would be exact.
Final: Ruling: (declined to judge) an overflow of the core's 256-entry event queue dropping EV_HANDOVER would leave the seat empty until restart — liveness only, the core still fails safe; not reproduced — cost if wrong: after such an overflow nobody can take the seat until a gateway restart.
Final: Ruling: (declined to judge) padsAtEngage taken while queued and compared after promotion on a resize could disengage the new pilot — unverified, depends on cockpit CSS; goes to the Pi bench (M4 steps 15) — cost if wrong: a promoted phone pilot rotating the phone loses control (fails safe).
Final: Ruling: (declined to judge) relay pilots with the room token only, the 300+300 ms budget, keyboard takeover centring, scrypt load on the Pi — spec open items or earlier rulings, unchanged — cost if wrong: as recorded in the spec and earlier rulings.
Final: Ruling: (declined to judge) Pi-only timing — every suite ran on the WSL box; the Pi run of all suites is owed before deployment — cost if wrong: a Pi-only failure found on the bench.
