# SDD ledger — plan: docs/superpowers/plans/2026-10-05-m5-validation.md
Spec: docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md (read; binding authority)
Pre-flight (shared interfaces):
- M3 crsf-core timing.csv header (deadline_ns,wake_ns,write_start_ns,write_end_ns,period_ns,shift_ns) → T1 timing_report — unchanged by the M3 review fixes — OK
- M3 events.jsonl (state/flight_mode events, t_ns, cmd_age_ms) → T2 failsafe_report — unchanged — OK
- T2 fault.py faults.jsonl (t_ns CLOCK_MONOTONIC, action) → T2 failsafe_report --faults — OK
- T1/T2 tools → T3/T4 campaigns — OK
Ruling: execute on main (user chose "Commit on main" 2026-10-06) — cost if wrong: history on main.
Task 2: Ruling: chmod +x timing_report.py, failsafe_report.py, fault.py (extra commit) — the procedures (Tasks 3–4) invoke them directly and the plan never set the executable bit — cost if wrong: none
Task 1: complete (commits d63f2b3..3bfe442, tests: python3 -W error -m unittest discover -s tools/analysis -t tools/analysis → OK)
Task 2: complete (commits 9f39b3c..3bfe442, tests: python3 -W error -m unittest discover -s tools/analysis -t tools/analysis → OK)
Task 3: deferred — C1 campaign needs the module on XT30 power, the drone and M3 Task 8 (real-time install). Not complete.
Task 4: deferred — C3 campaign needs the same bench. Not complete.
Final: fixed #1 Critical (unmatched faults vanished → false PASS) — test_a_fault_with_no_failsafe_fails_the_run RED (1 row) →GREEN; suite 23/23
Final: fixed #2 (SIGTERM/SIGHUP left the drop rule) — test_rule_is_removed_on_sigterm_and_sighup RED (process killed, exit 143) →GREEN; suite 23/23
Final: fixed #3 (PASS with ticks that sent nothing) — test_ticks_without_a_write_fail_the_run RED →GREEN
Final: fixed #4 (missed-slot divisor used the previous period) — test_missed_slots_use_the_period_the_scheduler_used RED (5≠1) →GREEN
Final: fixed #5 (cross-boot matches, no campaign scope, manual counted as PASS) — test_faults_from_another_boot_are_not_matched, test_since_limits_the_report_to_one_campaign, test_manual_failsafes_are_listed_but_not_judged, test_faults_record_wall_time_and_boot RED →GREEN
Final: fixed #6 (no FC confirmation still PASS; no per-reason summary or wall time) — test_without_fc_confirmation_the_result_is_core_only RED →GREEN
Final: Ruling: test_main_reads_files_and_skips_broken_lines now uses a cmd_timeout + !FS! pair instead of a manual failsafe — manual is no longer judged (fix #5) — cost if wrong: none.
Final: Ruling: when Tasks 3–4 run, the procedure docs from the plan must use the new options (C3 analysis with --since <campaign start, UTC>; --no-fc only if Betaflight telemetry lacks !FS!) — the plan text predates these fixes — cost if wrong: analysis mixes campaigns.
Final: Ruling (declined: C1 limits 250 µs / 1 ms) — plan says confirm with the mentor.
Final: Ruling (declined: real nft syntax under root, Betaflight !FS! string) — need root / hardware; checked in Task 4.
Final: minor (deferred): #7 truncated last timing.csv row raises TypeError instead of exit 2
Final: minor (deferred): #8 no minimum run length (a 2-frame log can PASS; duration is printed)
Final: minor (deferred): #9 +1 frame period "on the air" not included in the C3 budget check
Final: minor (deferred): #10 block_pilot logs after the rule is active (sub-ms low bias); kill_gateway logs even if systemctl fails
Final: minor (deferred): #11 non-object JSON lines or faults without action raise
