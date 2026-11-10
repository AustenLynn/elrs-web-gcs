# Bilingual voice maneuver demo

Status: user approved in conversation on 2026-11-10. Implementation plan: `../plans/2026-11-10-voice-commands.md`. Product implementation has not started.

## Intent and agreed behavior

Add a demonstration of spoken drone control to elrs-web-gcs. The goal is a visible response to natural commands, not precise navigation. Use existing hardware and timed stick inputs; no claim of measured displacement.

The user chose push to talk, Spanish and English, natural variations, and immediate execution without a separate confirmation. Releasing the button submits audio; execution begins only after transcription, classification, and local validation complete. This introduces network delay.

## Approaches

- Push to talk with transcription followed by Decisions classification: selected by the user. Explicit utterance boundaries make the demo easier to operate.
- Always listening: considered, not selected; adds accidental activation and background speech handling.
- Position feedback and vision guided movement: discussed and deferred in favor of timed movement for demonstration.

## Proposed scope and defaults

These are engineering proposals, not individually confirmed requirements.

- Forward, backward, left, right, turn left, turn right; short and medium duration presets. Directions are relative to the drone's current heading.
- English, Spanish, and mixed phrases map to the same finite catalog of direction/duration pairs. Plain direction uses short duration.
- “A little more” / “un poco más” repeats the last successfully completed direction using the short preset, in the same uninterrupted pilot session. No previous maneuver means no action. Reset this context on manual takeover, disarm, mode change, failsafe, or session loss.
- One command per utterance; compound, unsupported, negated, ambiguous, or non-command speech produces no action. Requests expressed in meters are rejected with a suggestion to use a qualitative command; do not silently promise a distance.
- Arming, throttle, altitude changes, flight mode changes, landing, turtle mode, and failsafe clearing remain manual. Vision and autonomous navigation are excluded.
- Normal flight mode only for the demo. Verify the actual aircraft's behavior during calibration.
- An explicit cancel button/key cancels pending recognition and active maneuvers. Spoken cancellation during processing or execution is excluded from this version because new recordings are disabled while busy. A cancel utterance submitted while idle maps to no movement.

## Architecture

Browser microphone -> authenticated gateway transcription endpoint -> OpenAI transcription -> OpenAI Decisions -> validated maneuver enum -> browser maneuver scheduler -> existing 50 Hz control messages -> gateway -> crsf-core.

Decisions accepts text/images/JSON rather than raw speech. Use transcription first and predefined choice answers for this fixed command catalog. API credentials stay on the server. Official reference: https://developers.openai.com/api/docs/guides/decisions . Select the transcription model and verify current request schemas during implementation planning.

The gateway binds each request to the authenticated active pilot/session, applies audio size/duration limits, timeouts, and one-in-flight limits, and validates the returned choice. Voice requests must not block normal WebSocket control or the core loop. Local and relay authentication must both be inspected before exposing endpoints; relay voice support can be deferred if its transport cannot carry authenticated audio requests without expansion.

The browser captures audio through a dedicated held button/key without reusing existing flight bindings. Permission prompts happen before flight. Button release submits; pointer cancellation, focus loss, or interrupted capture discards the recording. No audio capture is active otherwise. No audio is persisted by this application by default.

## Movement and manual takeover

Implement voice as a bounded overlay on an existing manual input mode rather than switching modes while armed. Manual controls still own throttle and flight mode. When idle, manual pitch/roll/yaw pass through. Accept a maneuver only when manual pitch/roll/yaw are neutral, the pilot is engaged, the aircraft is armed in Normal mode, and status is fresh.

An active maneuver owns one horizontal or yaw axis; other maneuver axes remain neutral. Fixed signed strengths and durations come from local configuration, never model-generated numbers. Use a monotonic deadline checked on each control tick. At expiry, remove the overlay and return maneuver axes to neutral while preserving manual throttle. Neutral is an input value, not proof of stopping or holding position.

Any deliberate manual flight input cancels pending requests and the overlay before applying manual input. Local cancel neutralizes maneuver axes while retaining manual throttle. Existing disarm/failsafe actions retain their existing semantics. Push to talk does not engage the dead-man, arm, change modes, or keep a hidden page in control.

## Request lifecycle

Idle -> recording -> processing -> executing -> idle, with cancellation/error paths from every stage. Only one recording/request/maneuver may be active. New captures while processing or executing are rejected visibly; there is no maneuver queue.

Attach a unique request ID, pilot-session identity, cancellation generation, and submission timestamp. The browser rechecks these and all movement preconditions immediately before execution. Manual input, disarm, focus/visibility loss, connection loss, pilot transfer, or mode changes invalidate pending work and reset repeat context. Late or duplicate results cannot execute. Abort network work where possible; cancellation validity must not depend on abort succeeding.

Use configurable recording, response freshness, amplitude, and duration caps. Establish actual values through props-off verification and supervised calibration, not assumptions about meters per second. On API failure, unclear output, or stale result: report no action and continue the ordinary manual control path. Do not retry an execution automatically.

## Interface and feedback

Show microphone availability, recording/processing/executing state, recognized transcript, selected qualitative maneuver, completion/cancellation, and errors. Keep the existing Spanish interface; accept both spoken languages. Display the selected action as it begins without a confirmation step. Clearly describe movements as timed rather than measured distances.

## Verification and rollout

1. Dry-run mode: actual audio/transcription/Decisions integration selects and displays a maneuver without affecting control output.
2. Automated checks: bilingual command cases, mixed speech, ambiguity/negation, repeat context, bounded output/deadlines, preserved throttle, manual takeover, stale and duplicate responses, session replacement, permission failures, API errors, and no change to existing dead-man/failsafe behavior.
3. Props-off bench test of actual command output and immediate manual takeover. Check microphone permissions do not unexpectedly lose control during flight; acquire them before arming.
4. Supervised calibration in a clear test area, with the existing project flight procedures. Tune each direction's strength/duration independently; record behavior rather than claiming metric accuracy.
5. Demo with opt-in event timestamps for recording release, transcription completion, decision completion, maneuver start/end/cancel. Measure latency and command success. Do not log API keys or raw audio.

## Remaining implementation decisions

Inspect gateway authentication and relay transport in detail; choose the transcription model, browser-compatible recording formats, bounded request sizes/timeouts, push-to-talk key, classification instructions, and conservative initial preset values. Existing Pi compute is the starting point; benchmark network/CPU impact alongside video before considering hardware upgrades. No new hardware purchase is required by this design.
