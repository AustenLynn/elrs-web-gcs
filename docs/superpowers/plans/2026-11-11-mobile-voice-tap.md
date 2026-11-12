# Two-Tap Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** On-screen Hablar starts recording and a second tap on Enviar submits, while desktop V remains hold-to-talk.

**Architecture:** Reuse VoiceController press/release/cancel. Browser input ownership separates button and keyboard gestures and resets whenever controller state becomes idle. Keep the fixed voice strip and existing control tick unchanged.

**Tech Stack:** Plain browser JS, existing node:test and headless Firefox WebDriver BiDi tests, no new dependencies.

**Spec:** docs/superpowers/specs/2026-11-11-mobile-voice-tap-design.md (approved in conversation).

## Global Constraints

- Button: first completed activation starts, second submits; pointer release after the first tap does not upload.
- Hold-V remains unchanged. V release cannot submit a button recording; button activation cannot submit a V recording.
- Cancel/manual input/focus or session loss/timeout discard and reset the button. Timeout never auto-submits.
- One request at a time; no action on busy activations. Preserve current auth, freshness, manual takeover, dry-run and maximum recording limits.
- Preserve >=100px stable touch pads at supported short landscape sizes and the fixed34px voice strip.
- No provider/backend/core change, credentials, billed API or hardware operations. No new dependencies.

## Review Focus

- First pointer release and subsequent synthetic click must not double-submit: Task1.
- Canceled touch gesture must not act as a completed tap: Task1.
- Mixed V/button gestures must not submit another source's recording: Task1.
- Timeout/capture failure/manual cancellation must clear input ownership and reset label: Task1.
- Labels/pressed state must not resize the manual controls: Task1.

### Task 1: Implement and verify two-tap button with independent keyboard ownership

**Files:** Modify web/js/app.js, web/index.html, gateway/e2e/voice.e2e.js, docs/setup/voice.md and docs/procedures/voice-demo.md. A focused small input adapter and unit tests may be added only if needed to keep ownership coherent outside the already-large app; report exact exported interface if added.

**Interfaces:** Existing VoiceController.phase/busy, press(), release(), cancel() and onState callbacks remain authoritative. Button activation uses normal click semantics for touch/mouse/accessibility. Track gesture source button/key and ignore cross-source submission. Display Hablar idle, Enviar during button recording, recording/disabled state during V ownership and busy processing. Set aria-pressed for the recording state and update accessible labels/help. One physical activation must cause at most one transition.

- [ ] Add failing regression assertions before product edits using existing fake-media/provider browser fixture. Assert first completed touch tap remains recording with0uploads, second tap submits exactly1; extra busy taps cannot create another request. Include pointercancel before completion, Cancel reset, timeout/error reset without upload, held manual input, focus/session loss, and V/button cross-source isolation. Preserve original V tests. Actual touch actions must be exercised, not only programmatic .click().
- [ ] Run focused new browser test, confirm expected RED for old hold-button behavior; record command/output. Use existing lightweight unit fixture where a new ownership helper merits meaningful unit tests.
- [ ] Implement minimal event ownership and labels in app/HTML (or focused helper). Clear ownership on idle/cancel/generation changes. Remove hold-specific pointer capture/release submission from the on-screen button. Keep pointercancel safe through native completed-click semantics. Keep V repeat suppression and desktop press/release, and never release a recording belonging to the other input. Clear stale state before another recording can start.
- [ ] Adapt old browser assertions that equated canceled pointer capture with cancellation of a keyboard-owned recording to the new source contract. They must still prove genuine canceled button gestures do not submit and desktop V works. Update documented mobile vs desktop instructions.
- [ ] Run `node --test --test-concurrency=1 gateway/e2e/voice.e2e.js` (all voice cases including real gateway/fake serial and >=100px geometry), then `npm --prefix gateway test` once. Serialize heavy suites/check Pi temperature. Expect all pass, record actual counts/exit codes and any skips. Do not repeat unrelated eight-minute full browser/C suites for this browser-only change unless a new failure indicates a need.
- [ ] Self-review, `git diff --check`, commit focused change. Report exact RED/GREEN evidence, contracts/commit and limitations. Controller dispatches independent review; no worker subagents.

## Handoff

After review: merge the approved branch into main preserving existing untracked deploy files, install changed static web assets to /opt/gcs/web, compare installed source, verify local and current tunnel HTTP and unchanged dry-run mode. Do not restart services, change secrets or submit live API audio. User's prior merge/deployment choices remain in force for this follow-up change to the running demo.
