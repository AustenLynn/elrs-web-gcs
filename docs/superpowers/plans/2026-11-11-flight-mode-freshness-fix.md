# Flight Mode Freshness Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Keep voice's existing500ms readiness gate usable when actual radio mode reports remain unchanged, without inventing telemetry or changing safety rules.

**Architecture:** The core currently de-duplicates flight-mode IPC publishing together with change logging. Publish to the existing mailbox on every valid received flight-mode frame; retain change-only EV_FLIGHT_MODE logging. Gateway/browser continue checking actual received-mode freshness exactly as before.

**Tech Stack:** Existing C real-time core, Python fake-serial integration harness, Node/browser tests; no new dependency or protocol.

**Spec:** Existing approved docs/superpowers/specs/2026-11-10-voice-commands-design.md requires fresh actual Normal telemetry; this restores its intended contract.

## Global Constraints

- No changes to arming, output/control loop timing, throttle, flight modes, stale-mode500ms limits, IPC format, or dry-run/live settings.
- Publish only upon actual valid incoming flight-mode frames. Never replay cache on a timer to pretend freshness.
- Preserve change-only flight-mode event logs; identical repeated telemetry must not flood event logs.
- Missing/stopped mode reports must still make voice ineligible after the existing freshness threshold.
- No physical aircraft commands, serial-port takeover, live API, credentials or service restarts by implementer.

## Root-cause evidence

Runtime is voice enabled and core DISARMED (first expected blocker).35status messages over3.5s but only one cached S-NORMAL mode update. core/src/rtloop.c puts mode into mailbox only inside strcmp-change branch; gateway/src/hub.js voiceLiveReady requires flightModeAt<=500ms. Thus steady actual mode frames cannot keep readiness fresh even if repeatedly received.

## Review Focus

- Identical valid mode frames must reach IPC repeatedly beyond500ms, Task1.
- Change logging must stay sparse, Task1.
- Stopped mode frames must not create synthetic fresh telemetry, Task1.
- Arming and Normal-mode prerequisites must remain active, Task1.
- Fake-serial tests must exercise real core receive path rather than directly writing mailbox, Task1.

### Task 1: Restore actual-frame flight-mode publishing and readiness diagnostics

**Files:** Modify core/src/rtloop.c; add regressions in core/tests/integration/test_core.py and minimal counters/history in core/tests/integration/core_client.py if needed; extend existing gateway voice integration/browser case only as needed to prove actual source liveness; update docs/setup/voice.md. A minimal user-facing translation of not_ready in web/js/app.js and matching browser assertion is allowed, without new readiness schema or changed gates.

**Interfaces:** Existing mailbox_put_flight_mode, IPC_FLIGHT_MODE and gateway/browser timestamps remain unchanged. New test-only receive counts/times belong only in integration helper.

- [ ] Write failing actual fake-serial regression: keep emitting identical mode for>1s, require multiple distinct received IPC mode updates spread beyond500ms; verify only one matching flight-mode change log. Stop actual source reports, drain in-flight messages and assert no further mode updates after a bounded settling period. Keep status/link traffic alive to distinguish missing source from dead connection. Use received-time/counter assertions with appropriate bounded waits, no fake heartbeat.
- [ ] Run focused regression via existing core integration harness; observe expected RED with current production core.
- [ ] Move mailbox publishing outside the value-change condition in the received valid CRSF mode handler. Keep cached value update and EV_FLIGHT_MODE push inside the change condition; preserve profile-specific safety parsing. No periodic publish or other telemetry changes.
- [ ] Run focused regression GREEN. Add/extend real-core gateway test if needed to prove its readiness gate stays eligible after>500ms of unchanged actual reports and rejects after reports stop, with fake aircraft only. Preserve existing stale-mode tests.
- [ ] For raw not_ready feedback, show a concise Spanish instruction that live voice requires manual arming, Normal mode and fresh telemetry; no automatic arming or relaxed gate. Keep changes minimal and test with the existing browser provider-error fixture; update docs on prerequisites/root cause.
- [ ] Run make -C core test and make -C core integration once after focused GREEN. Run npm --prefix gateway test and voice-only browser file if browser feedback changed. Serialize heavy suites; check temperature. No unrelated8min full browser/Python/relay reruns without concrete need.
- [ ] Self-review/diff check, commit. Detailed report with RED/GREEN counts/exits/source contract and deployment limits. Controller reviews, merges, and prepares privileged installation only after disarmed check. Root-owned runtime core requires operator sudo; do not bypass permissions or auto-arm.
