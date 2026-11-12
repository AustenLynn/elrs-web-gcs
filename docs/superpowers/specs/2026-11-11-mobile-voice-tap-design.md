# Two-tap on-screen voice input

Status: approved in conversation: user selected the two-tap approach on 2026-11-11.

Intent: remove the need to hold the on-screen microphone button on mobile.

Approaches: two taps (selected) provide explicit recording boundaries without holding; automatic silence detection was considered and not selected because noise complicates endpoint detection.

Behavior: the first completed activation of Hablar starts recording; ordinary pointer release does not submit. The second activation of Enviar submits exactly once. Cancel, manual flight intent, focus/session loss, and the existing five-second timeout discard the recording and reset the label. No automatic submission on timeout. Desktop hold-V remains press/release input. Keep button and keyboard ownership separate so events from the other input cannot submit or take over a recording; simultaneous attempts are ignored until completion/cancellation. Ignore activations while processing/ready/executing. Display recording state and accessible pressed state. Keep usable stable manual-control geometry, all existing safety checks, upload limits and dry-run configuration.

Scope: browser event bindings, labels/accessibility, relevant browser tests and documentation. No API, gateway, core or provider behavior changes. No new dependencies. Voice stays dry-run. Implement on an isolated branch, review, then merge and publish only updated static web assets to the already authorized running demo. A backend/service restart is unnecessary for this static change. No billed API or physical aircraft testing.
