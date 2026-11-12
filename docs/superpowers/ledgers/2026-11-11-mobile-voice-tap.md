# SDD ledger — plan: docs/superpowers/plans/2026-11-11-mobile-voice-tap.md

Branch fix/mobile-voice-tap, base ea69b34. Task1 pending.

## Preflight
| Task pair | Contract | Finding |
|---|---|---|
| 1 self | tests require two taps plus independent V; implementation uses ownership/click | consistent; old pointer-capture tests need revised source-specific meaning |

Ruling: User approval of the specific two-tap proposal is approval of this small design — no additional design confirmation needed — cost: any mistaken interpretation is reversible client-only work.
Ruling: Reuse existing isolated clean worktree on a new branch (main same ea69b34); native managed tool previously failed on nonrepo task cwd — cost: manually attached workspace remains.
Ruling: Prior local merge/deploy preferences apply to this follow-up fix of running demo; only static web assets will be installed after review, no service restart/secret/provider change — cost: users must reload to load new frontend.
Baseline: ea69b34 identical to main; gateway330/330 passed on main after merge in prior turn. Focused test-first will prove new behavior missing.
Task1 BASE40e9c86; implementer pending.
Task1 implemented edb045a; expected RED firsttapidle, focusedGREEN1/1, voiceE2E4/4, gateway330/330, no skips. Reviewer /root/two_tap_review pending.
Ruling: Scope manual selector to button[data-input] because body[data-input] caused every touch to cancel recording — browser event trace proved necessity — cost: future nonbutton mode controls must be explicitly included.

Task1 complete (commits40e9c86..edb045a), independent task/branch review PASS: no findings, merge-ready. Voice4/4, gateway330/330; no skips.

## Independent review

# Independent review — two-tap voice input

Reviewed range: `ea69b34..edb045ae0d393a7239810317757d8aae29b014a5`, including the approved spec/plan commit and all five implementation/test/operator-documentation changes. Reviewed the task brief, global context, task report, complete packaged diff, actual changed files, and directly related controller/capture, input initialization, keyboard safety and CSS context. No source, index, HEAD or branch state was changed; this report is the only review artifact written. No subagents or test reruns were used.

## Spec compliance

**Task/spec verdict: PASS.** The implementation satisfies the approved two-tap behavior and retains the existing controller contract and safety paths.

- `web/js/app.js:576` uses one native `click` handler. The first completed activation calls `voicePress('button')`; the next button-owned activation calls `release()`. There is no remaining button pointerdown start, pointerup submission or pointer capture handler. Controller `release()` changes phase to processing synchronously, so another click cannot release the same recording again.
- `web/js/app.js:111` rejects busy starts before assigning ownership. Button and keyboard starts assign distinct owners; V release at line 597 submits only a keyboard-owned recording. The button cannot submit a keyboard recording, including during the interval before the next render disables it. V repeat suppression remains in place.
- `web/js/app.js:82` clears ownership on every controller idle notification. Inspection of `VoiceController.configure`, `setSession`, `cancel`, capture failure handling, and capture timeout confirms that configuration/session changes, Cancel, manual takeover, focus/visibility loss, recorder failure and timeout use these reset paths. Timeout still discards and never invokes upload.
- `web/js/app.js:581` correctly narrows the manual-input selector to `button[data-input]`. `setInputMode` assigns `body.dataset.input`; the former ancestor match therefore classified every interaction as manual. The three input-mode controls in the current markup are buttons. Their cancellation remains covered, while ordinary voice taps no longer cancel before click handling. The existing initialization registers input-mode button listeners before assigning the body's dataset, so no new body click listener is introduced.
- `web/js/app.js:452` and `web/index.html:204` provide Hablar/Enviar, V recording/processing disabled states, recording pressed state and updated accessible labels/help. Native button activation remains available to click-producing accessibility clients. Existing global flight shortcuts retain their safety semantics.
- The branch changes no controller, capture, backend, provider, dependency or CSS behavior. Updated operator documentation distinguishes mobile taps from desktop hold-V and preserves five-second discard guidance and dry-run limitations.

## Strengths

- Ownership is small, private and derived from authoritative controller phases rather than duplicated asynchronous state. The synchronous phase guard also handles rapid activation safely.
- Browser regression coverage exercises real touch down/up actions, first-release zero uploads, exactly one second-tap request, busy taps, canceled first/second gestures, both ownership directions, interruption recovery, held manual input and timeout reset. Existing V/safety/gateway cases remain present.
- Geometry coverage now checks button-owned recording and processing at 640/740/800/1024 × 360, alongside transcript/error/held-stick states. CSS is unchanged; supplied measurements show pads of 101.9/101.9/104.8/172.3 px and a 34 px voice footer.
- The manual-selector correction is supported both by source analysis and the retained instrumented browser failure showing manual cancellation before voice pointerdown/click. It is a justified prerequisite for the approved behavior, not unexplained scope expansion.

## Issues

**Critical:** None found.

**Important:** None found.

**Minor:** None found.

## Verification evidence and limits

Inspected retained RED and GREEN logs: the first regression failed on “first completed touch remains recording” (idle instead of recording); focused GREEN passed 1/1. Inspected the complete voice log: 4/4 passed, zero failures/cancellations/skips. Inspected the gateway log totals: 330/330 passed, zero failures/cancellations/skips. The task report records exit 0 for both full commands and a clean precommit diff check. These are supplied execution artifacts, not tests rerun by this reviewer.

The canceled-touch case combines a dispatched `pointercancel` with an actual touch drag outside and release. It proves that incomplete/canceled button interactions in this browser fixture do not transition; it does not independently certify OS-generated cancellation behavior on every target mobile browser. Native completed-click semantics are the appropriate implementation boundary.

## Declined to judge

- Real microphone permission/codec behavior and recognition quality on physical PC/Android devices: fake microphone/MediaRecorder/provider fixtures are the stated verification scope; the operator procedure explicitly defers these campaigns.
- Billed API availability, model accuracy and live provider latency: no live audio/API campaign was authorized or performed for this browser input change.
- Aircraft movement, stopping/hovering performance and physical hardware safety: fake serial and dry-run evidence cannot certify hardware behavior.
- Deployment correctness, installed asset parity, current tunnel response and runtime dry-run configuration: deployment has not happened; these remain handoff checks after merge approval.
- Redesigning existing global flight shortcuts, including Space disarm taking priority over focused-button activation: this branch explicitly preserves existing flight controls and safety behavior; it does not change that policy.

## Quality and merge readiness

**Quality verdict: PASS. Ready to merge: Yes.** The small browser change integrates coherently with existing controller lifecycle, manual takeover and rendering. No blocking or nonblocking findings remain from this review. Merge approval does not certify live microphone/API/hardware behavior or replace the planned static deployment checks.
