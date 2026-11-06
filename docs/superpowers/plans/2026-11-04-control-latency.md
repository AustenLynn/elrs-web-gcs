# Software control latency implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Steps use checkboxes.

**Goal:** Produce an honest three-segment latency report for at least 10,000 local commands.
**Architecture:** Browser sent manifest + gateway timing events + core successful serial events,
joined offline. Opt-in tracing, no IPC wire-format changes or safety-rule changes.
**Tech Stack:** Existing browser JavaScript, Node, C and Python unittest.
**Spec:** ../specs/2026-11-04-control-latency-design.md

## Global constraints
No capture hardware. Serial submission endpoint. Local and tunnel results separate. Keep
missing commands in denominator. No file writes from RT loop. Preserve existing user changes.

## Review focus
- Clock offset uncertainty or expired sync must not produce a false pass.
- Partial serial writes and safety overrides must not look like delivery.
- Queue coalescing and log drops must not shrink the denominator.
- Session changes and duplicate keys must not pair unrelated commands.
- Recording saturation must invalidate capture, not discard early samples silently.

## Task 1: Correlated tracing
- [x] Add failing browser tests for bounded sent manifest and session correlation.
- [x] Add failing hub tests for enabled/disabled trace, stale and unsynchronised timestamps.
- [x] Add failing core integration test for trace receipts and active serial completions.
- [x] Implement browser capture helper (`?measure`), gateway opt-in events and core opt-in
  events with session/sequence and CLOCK_MONOTONIC timestamps. Keep logging after forwarding.
- [x] Run browser/gateway suite and core unit/integration suites.

## Task 2: Report and procedure
- [x] Add failing Python tests for segment arithmetic, missing commands, clock uncertainty,
  duplicate records, stale sync, tunnel routes and 10,000-command threshold.
- [x] Implement control_latency_report.py with JSON output and readable percentile table.
- [x] Document local capture, configurations, exports and three acceptance campaigns.
- [x] Run analysis suite and end-to-end synthetic browser/gateway/core measurement.
- [x] Review diff and prepare deployment without changing flight settings.

## Task 3: Match the existing video recorder to the requested criterion
- [x] Add failing tests for average fps <25, a non-720p sample and absolute CSV timestamps.
- [x] Enforce the thresholds and collect a full 300 seconds from the first sample.
- [x] Preserve legacy CSVs without wall timestamps; export wallMs from live recordings.
- [x] Run gateway/browser tests and the simulated video end-to-end test.
