# SDD ledger — plan: docs/superpowers/plans/2026-11-11-flight-mode-freshness-fix.md

Branch fix/voice-flight-mode-freshness, original main4d81ef6, task base8a9e311.
Task1 pending.

## Preflight
|Task pair|Contract|Finding|
|---|---|---|
|1 self|Real-mode packets drive unchanged IPC shape and existing freshness gates|Consistent; logging remains change-only, no artificial cache heartbeat|

Observed runtime: execution enabled; DISARMED; actual mode cached S-NORMAL.35status messages/3.5s but one mode message; later10link messages/2.2s with upLq100 and one cached mode message. Strong source-code proof: rtloop strcmp suppresses identical mode publications, incompatible with500ms gate.
Ruling: Repair source telemetry publishing on actual received frames rather than loosen safety freshness threshold — intended approved contract preserved — cost: IPC may emit mode at status cadence while radio reports repeat.
Ruling: Add minimal readable not_ready prerequisites while fixing observed error — raw code is not useful to operator — cost: message lists gates rather than introducing detailed backend reason schema.
No hardware/action/API command sent. Deployment needs sudo for installed core and safe disarmed restart; user has authorized troubleshooting/fix, but password must not be requested in chat.

Task 1 implementation: Added actual fake-serial IPC receive-history regression, observed RED (1 failure, expected missing identical reports); focused GREEN (1 pass). Production fix publishes actual decoded mode after change-only cache/log handling. No gateway or browser readiness gates changed. Added minimal Spanish not_ready prerequisites and source freshness documentation.
Task 1 RED browser: provider-error fixture failed for missing readable prerequisites; real-core gateway case failed waiting for repeated identical actual mode IPC after successful manual fake-aircraft arm (2 failures). Initial synthetic-pointer fixture failed before arm, corrected to actual BiDi mouse hold and reran; not counted as expected regression proof.
Task 1 tests: core unit suite exit 0, 141 PASS in 13 binaries (UBSan). Full core integration running; heavy checks serialized. Temperatures observed approximately 40–44 C.
Task 1 verification: focused core GREEN 1/1; core unit 141/141 in 13 UBSan binaries; core integration 42/42; gateway 330/330; voice browser 4/4; all exit 0. Real-core gateway diagnostic: 14 mode messages/1413ms; stopped source unchanged count with 6 further status and 6 link reports; readiness expires while fake core remains manually ARMED.
Final review: self-review per controller instruction (no subagents); full scoped diff and invariants checked; no material findings or deferred minors. Strengthened literal single-log-mode assertion, final focused run 1/1 exit 0. git diff --check exit 0. No source changes after full green suites.
Task 1: complete; report task-1-report.md contains commands, RED/GREEN, logs, source contract, limits. Controller owns independent review/integration/deployment. Preserve this workspace for controller review; no deployment or privileged action performed.
Task 1 commit: 8eaa8e3 (base 8a9e311), fix(core): refresh flight mode on actual repeated telemetry.

Task1 complete: implementation8eaa8e3; independent review PASS, no findings. Tests core141/integration42, gateway330, voicebrowser4; all exit0. Runtime deployment not yet done.

## Independent review

# Independent review — 4d81ef6..8eaa8e3

Reviewed the complete eight-file branch diff, task brief, global context and implementation report. Focused source checks followed the named risks through CRSF deframing/decoding, the receive callback, mailbox, IPC, gateway readiness and browser receive timestamps. Source, index and HEAD were not changed; no suites, services, APIs or hardware were run. This file is the requested review artifact.

## Strengths

- `core/src/rtloop.c:92-102` implements the intended minimal repair: every received decoded mode reaches the mailbox, while cached-value replacement and `EV_FLIGHT_MODE` stay under the value-change condition. Betaflight safety parsing still runs before that condition; Aquila20 text still cannot establish arming.
- The source path is real: serial bytes enter the CRC-checking deframer before this callback; `crsf_telem.c` bounds and terminates the decoded mode string. The mailbox copies the string under its existing mutex and marks the existing dirty bit. IPC consumes/clears that bit and sends mode only when dirty during normal operation. Repeated unchanged source reports can therefore produce repeated IPC, while continuing status/link activity alone cannot create new mode dirty bits. Existing mailbox coalescing, IPC shape and status cadence are preserved.
- `core/tests/integration/test_core.py:503-524` tests actual CRC-valid FakeTx serial input into the compiled core and counts received IPC messages across more than one second. Its stopped-source half leaves status/link alive, allows transit to settle, checks unchanged mode count and age above 500 ms, and asserts exactly one change log containing `S-NORMAL`.
- `gateway/e2e/voice.e2e.js:386-412` extends an existing real-core gateway fixture. It first proves fresh Normal reports do not bypass disarmed state, uses the existing manual arm hold against a fake aircraft, proves readiness after more than 1.1 seconds of unchanged reports, then proves expiry while the fake core remains armed and status/link continue. It does not substitute a direct mailbox write or fabricated gateway heartbeat for source liveness.
- `web/js/app.js:85-86` is a text-only translation of `not_ready`. The existing browser fixture checks all three Spanish prerequisites and stable controls. Gateway/browser 500 ms checks, mode predicates, ownership/engagement logic, live/dry-run selection, throttle and control scheduling remain unchanged in the branch.

## Issues

### Critical

None found.

### Important

None found.

### Minor

None found requiring a change in this task.

## Verification evidence assessed

Read saved command output rather than relying only on the report: the focused core RED fails at the repeated-report assertion; final focused GREEN passes 1/1. `core-unit.log` contains 141 PASS lines and UBSan compile flags; core integration finishes 42/42, gateway finishes 330/330, and the voice browser file finishes 4/4. Browser RED independently fails at readable prerequisites and identical real-core reports. Browser GREEN records 14 actual mode IPC reports over 1413 ms, followed by an unchanged mode count during six additional status and link reports. The earlier pointer-capture fixture failure is correctly excluded as regression RED evidence. No tests were rerun during review.

## Recommendations

Preserve the existing 500 ms thresholds. During the separately authorized deployment check, measure actual hardware mode-report cadence and gaps; fake serial at approximately 100 ms establishes the software contract, not physical-radio cadence or availability. Merge approval here does not authorize service restart, serial takeover or live voice operation.

## Declined to judge / remaining limitations

- Physical aircraft/report cadence, microphone/provider recognition, calibration and actual maneuver behavior: no hardware or live API was exercised; these require the separate operational validation already described by the plan.
- Enabled-mode end-to-end HTTP execution: this fixture preserves its dry-run upload test and directly exercises the production readiness predicate using real-core telemetry. It does not establish physical or enabled-mode execution behavior, which this scoped freshness repair does not modify.
- Existing newcomer telemetry snapshots (`core/src/ipcserver.c:134,145`) and the broader receive-time freshness model: connection catch-up can send cached telemetry once, while the reviewed steady-connection path sends dirty updates only. This branch preserves the existing schema and reconnect behavior; it does not provide source sample timestamps or a reconnect-age guarantee. The stopped-source regression establishes expiry on the ongoing connection, not all reconnect scenarios.
- Worst-case real-time latency/load: the added existing mailbox call per actual mode frame is required by this repair, but the saved functional/UBSan tests do not certify hardware scheduling performance.

## Assessment

**Task specification: PASS.** All planned source behavior and scoped diagnostic changes are present, with source-driven positive/negative regression evidence and no threshold relaxation.

**Code quality: PASS.** The production repair is small, bounded and consistent with the other telemetry receive cases; test-only counters/history stay in the integration helper. No material correctness, safety-parsing or maintenance issue was found.

**Ready to merge: Yes.** The branch restores actual-report freshness without changing arming or readiness rules. Hardware cadence and privileged installation remain separate operational work; this review does not claim deployment or flight readiness.
