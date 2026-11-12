# Confirmed Mode Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Remove the incorrect mode-heartbeat assumption while retaining live RF/core freshness, confirmed Normal state and all manual-control safeguards.

**Architecture:** Gateway owns a pure state tracker for mode confirmation, RF liveness and target invalidations. Its readiness is used consistently by HTTP and additive status.voice. Browser consumes authoritative readiness and retains local per-tick/manual checks. No CRSF/core IPC or C changes.

**Tech Stack:** Existing Node22/browser ES modules, node:test, current fake-core/serial Firefox harness. No dependency.

**Spec:** docs/superpowers/specs/2026-11-11-confirmed-mode-readiness-design.md

## Global Constraints

- Require status AND positive RF link telemetry each <500ms old; never synthesize telemetry or alter mode timestamps to fake freshness.
- Actual Normal confirmation persists across quiet mode reports only while RF/core remain live. RF/core loss, stale gap, requested/observed mode or Turtle transition, and entry to unsafe state invalidate it; RF recovery alone never reconfirms.
- Core snapshot represents last-known state at connection, not recent wire receipt. A browser-only cached telemetry replay cannot restore invalidated server confirmation.
- Keep manual arming, ARMED/session ownership, Normal target, Turtle off, neutral/held-input/focus/visibility/connection, request freshness, exactly-once and cancellation rules.
- Browser requires status.voice.ready===true plus local fresh current checks; missing readiness fails closed.
- Clear concise Spanish errors for one missing prerequisite, stable existing layout. Never auto-arm/cycle modes/clear failsafe.
- No core/protocol/C change, secret access, billed API/real-aircraft commands, service restart/deploy by worker.
- Before heavy suites check real core DISARMED; if not, pause heavy runs and tell controller. User confirmed disarmed and latest core snapshot DISARMED.

## Review Focus

- Mode reported only once but continuous RF/status must remain eligible beyond1s.
- Stop RF only while status continues: reject and invalidate; resume RF alone stays unconfirmed.
- Fast mode/Turtle requests can occur between status ticks: invalidate on accepted control intent, not just sampled output.
- Reconnect/hello cached replay and old-session results cannot restore authorization.
- UI, HTTP before/after recognition, and server status must use the same readiness result; unknown flags fail closed.

### Task 1: Implement and verify authoritative state-based readiness

**Files:** Create gateway/src/voiceflight.js and gateway/test/voiceflight.test.js; modify gateway/src/hub.js, gateway/src/voice.js, web/js/app.js and web/js/voicecontroller.js plus corresponding hub/route/controller/browser fixtures/tests; update docs/setup/voice.md and docs/procedures/voice-demo.md. Keep scope to this contract; no unrelated refactors.

**Interfaces:** `VoiceFlightState({now})` exposes onStatus(status), onLink(link), onMode(text), onControl({mode,turtle}), reset(), readiness(session)->{ready:boolean,reason:string}. Track actual mode separately from confirmation; initial invalidation/bad link clears confirmation. Reason catalog: ready, core_stale, pilot_mismatch, not_armed, not_normal, turtle_active, link_stale, link_lost, normal_unconfirmed. Finite times/nonnegative age; boundary >=500 rejects. `ControlHub.voiceReadiness(session)` uses tracker; existing voiceLiveReady delegates boolean. Status includes `voice:{ready,reason}` only when voice configured, for active pilot session; no capability/key included. Route keeps error not_ready but adds fixed reason at both checks. Controller propagates bounded reason for UI; app maps to short Spanish label and full accessible title, fallback for unknown. Browser mode context uses gateway ready flag plus requested Normal/Turtle-off and fresh status rather than a500ms mode receipt test.

- [ ] Write failing state tests first: one Normal report + RF/status every100ms for>1s stays ready; unchanged/quiet mode alone doesn't expire; status stale rejects; RF stale/0/invalid rejects and invalidates; recovery RF alone remains unconfirmed until new actual Normal; unknown/non-Normal mode rejects; core reset invalidates; requested mode/Turtle transitions invalidate even if outputs return to0 before a status tick; only new mode confirmation restores. Also ARMED/session/target/Turtle prerequisites remain mandatory. Test exact500ms boundary and backwards/nonfinite time rejection.
- [ ] Write failing integration/HTTP tests: pre/post readiness reason consistency; loss during provider work rejects without execution; legacy/missing browser readiness flag rejects; #hello cached replay doesn't call tracker. Adapt existing stale-mode-only tests to new sparse-mode contract, retaining stale RF/status negatives. Run focused RED before product edits.
- [ ] Implement tracker and wire all relevant events. Preserve last mode text for display but invalidate confirmation separately. Never refresh known mode from status or RF. Invalidate when control target changes before forwarding decisions can create a stale-known-mode window. Normal receipt after invalidation is required; initial Normal report and RF may arrive in either order, handled fail-closed where history is uncertain.
- [ ] Publish authoritative voice state on normal status messages and use same computation for HTTP admission/result checks. Handle old/absent/invalid readiness fields safely. Expose concise reason-specific Spanish error; no raw provider detail or long cut-off prerequisite list. Keep 34px strip and >=100px pads.
- [ ] Extend existing real core/gateway browser fixture: switch to injected live provider (no real API) where needed, manually arm fake aircraft, get one actual Normal report then stop mode reports while RF/status continue, wait>1s, submit voice and observe authorized result/control in fake core; RF loss/staleness cancels/rejects and RF-only recovery doesn't restore confirmation. New actual Normal report allows it again. Keep two-tap/holdV/manual takeover and real auth/header checks.
- [ ] After confirmed real DISARMED, run pure/focused GREEN, npm --prefix gateway test once and voice-only browser suite serialized (temperature check). Build existing core test prerequisite only if absent; no C suites or8minute unrelated whole-browser run because C source unchanged. Fix failures by root cause, report actual outcomes.
- [ ] Self-review/diff check, commit minimal changes. Full report includes RED/GREEN, pure transition table, exact tests/logs/exits, policy change and physical cadence limitations. Controller independent review/merge and prepares disarmed-only privileged gateway+web update; no worker deploy.
