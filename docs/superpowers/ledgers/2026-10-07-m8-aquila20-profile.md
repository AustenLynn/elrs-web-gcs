# SDD ledger — plan: docs/superpowers/plans/2026-10-07-m8-aquila20-profile.md
Spec: docs/superpowers/specs/2026-10-07-aquila20-profile-design.md (read; amends the main spec)
Pre-flight (shared interfaces):
- T1 fc_profile/FC_PROFILE_*/AQUILA20_SENSITIVITY_CH → T2 chmap, T3 rtloop: same names — OK
- T2 harness (PROFILE, failsafe_on, BetaflightTest) → T3 adds tests to it — T3's edit base is the T2 version of test_core.py — OK
- T4 formatFlightMode is self-contained; T5 docs reference T1–T4 names — OK
Note: the plan was replay-verified against a clean clone before execution.
Ruling: execute on main (user chose "Commit on main"; re-confirmed "run it natively" 2026-10-07) — cost if wrong: history on main, nothing pushed until asked.
Task 1: complete (commits a44b16a..19eddfa, tests: make -s -C core test integration → OK)
Task 2: complete (commits 19eddfa..df0ba27, tests: make -s -C core test integration → OK)
Task 3: complete (commits df0ba27..1a524bf, tests: make -s -C core test integration → OK)
Task 4: complete (commits 1a524bf..da85a5e, tests: npm --prefix gateway test → # duration_ms 9550.483149)
Task 5: complete (commits da85a5e..9cda64d, tests: make -s -C core test integration → OK)
Final review: fresh reviewer (opus), range a44b16a..9cda64d. Critical: none. Important: I1. Minor: M1–M7.
Final: Ruling: re-graded M4 (spec §3.2/§5.3/§7.1 not amended) and M5 (handoff stale/contradictory: D4 Betaflight, M3 Betaflight setup, "--no-fc only if…", counts) from Minor to Important — the M8 spec required those amendments (plan Task 5 missed them) and the contradiction would mislead the C3 campaign — cost if wrong: two doc edits of extra work.
Final: fixed I1 (core stays ARMED with ARM high after the drone silently disarmed on RF loss) — test_safety.c test_radio_link_loss_fails_safe_when_enabled + test_radio_link_check_is_off_by_default RED (missing API) →GREEN; integration test_radio_link_loss_disarms_and_says_so RED (no failsafe) →GREEN; gateway 'every failsafe reason … has a text' RED (no text for "rf_lost") →GREEN; suites: unit 100, integration 29/29, gateway 88/88, relay 11/11, analysis 26, e2e 3/3
Final: Ruling: rf_lost timeout is a fixed 1000 ms (AQUILA20_RF_TIMEOUT_MS), active only in aquila20, and arming without any recent link report fails safe ~1 s later instead of being refused — keeps the change inside the existing state machine; the pilot sees "el dron perdió el enlace de radio" — cost if wrong: a refusal would be friendlier than an arm-then-failsafe.
Final: Ruling: fake TX now sends link reports at LQ 100 by default (a bound drone); tests that need "no link" set link_lq = None — cost if wrong: none.
Final: fixed M4 — spec §3.2 rows (responses per profile, rf_lost), §5.3 (outputs per profile, ack interlock betaflight-only, rf_lost transition), §7.1 new FMEA rows (e)–(g) (doc fix; no test)
Final: fixed M5 — HANDOFF D4, M3 Task 8, M5 --no-fc lines and test counts (100/29/88) (doc fix; no test)
Final: Ruling (declined: does the Aquila20 disarm on CH5 low over a live link while spinning) — hardware; aquila20.md §3 step 3 checks it — cost if wrong: found at the bench, props off.
Final: Ruling (declined: re-arm in the air after failsafe; position-hold throttle semantics) — need the drone; added "refuses to arm when not level?" to aquila20.md §4 — cost if wrong: unknown flight behaviour, bench first.
Final: Ruling (declined: browser e2e not re-run by the reviewer) — I ran it after the fix pass: 3/3.
Final: minor (deferred): M1 aquila20 integration failsafe checks also match a plain disarm; tighten with status state FAILSAFE (one test passed a non-latching mutation)
Final: minor (deferred): M2 no integration test pins "ARM unchanged during failsafe" for betaflight
Final: minor (deferred): M3 stale comments in safety.c/safety.h ("ARM unchanged" reads as default behaviour)
Final: minor (deferred): M6 fc_profile not logged in the start event, stderr or crsf-ctl status; old configs silently become aquila20
Final: minor (deferred): M7 page hides the sensitivity prefix (S/M/F) of the mode text
