# SDD ledger — plan: docs/superpowers/plans/2026-11-10-voice-commands.md

Branch: feat/voice-commands
Base: 9cf8c0e
Workspace: /home/maikuser/ProyectoTerminal/elrs-web-gcs/.local/worktrees/voice-commands
Tasks: 1–6 software complete and task-reviewed; final whole-branch review completed at 9665e54; named I1/M1/M2 fixed in final wave 1b1b75e; live API/microphone/aircraft validation deferred.

## Preflight scan
| Tasks | Shared contract / self-consistency | Finding |
|---|---|---|
| 1 | scheduler tests vs implementation | expiry returns manual axes; execution requires neutral base; consistent |
| 2 | provider tests vs implementation | schema confirmation required before HTTP implementation |
| 3 | auth routes vs config/hub | capability must precede use; consistent |
| 4 | capture/controller | apply must gate execution on current tick context, not stale async callback |
| 5 | app/E2E | browser harness needs prerequisites; inspect before running |
| 6 | docs/deploy/evidence | real hardware unavailable: defer honestly |
| 1,2 | finite choice catalog | one shared enum import avoids duplicate catalog |
| 1,3 | preset validation/config | consistent numeric caps |
| 1,4 | scheduler/controller | consistent start/apply/cancel; repeat local |
| 1,5 | manual overlay | idle pass-through, neutral base at start |
| 2,3 | recognize result | transcript/choice/timing match |
| 2,6 | live fixtures | key optional; don't claim live evaluation without key |
| 3,4 | HTTP envelope/config/capability | consistent; no request audio on WebSocket |
| 3,5 | promotion event | cache voice_ready before config resolves |
| 3,6 | config and service | optional key must not break manual control |
| 4,5 | press/release/apply/context | consistent; invalidate on manual intent |
| 4,6 | trace callbacks | optional measurements omit transcript/secrets |
| 5,6 | app traces and setup | consistent |

Ruling: Use native worktree fallback in ignored .local/worktrees/voice-commands after managed tool failed because task cwd is not a Git repository — preserves current checkout — cost: workspace attachment is manual.
Ruling: Approved plan authorizes implementation now despite its historical planning-only sentence — user selected subagent execution — cost: none.
Ruling: Current DEVELOPMENT-PROCESS feature branch rules and approved plan supersede stale CLAUDE/HANDOFF main-commit instructions; do not add false Claude authorship/session trailers — cost: older workflow examples differ.
Ruling: Run all repository software suites once at completion per local rules; run focused and gateway/web suites per task — cost: extra final validation time.
Ruling: No live API credential available through a dedicated key tool; do not search unrelated credential stores. Adapter tests use injected fake HTTP. Live evaluation and hardware calibration deferred if no operator/key available — cost: runtime model quality remains unverified.

Baseline: gateway/web 243/243 pass; relay 11/11 pass. Logs /tmp/voice-baseline-{gateway,relay}.log. Task 1 dispatched to /root/voice_task1; BASE a248729.
Task 1 implementation fe980ce; RED missing module; focused 7/7, web 125/125, gateway 250/250. Reviewer /root/voice_review1 pending.
Task 1: complete (commits a248729..fe980ce, review clean). Cross-task checks belong to Tasks 4/5; hardware evidence to Task 6.
Task 2: dispatch BASE fe980ce.
Task 2 implementation 7500986; focused 20/20 gateway 270/270. TDD deviation: evaluation helper initially implemented before test; documented mutation check verifies regression sensitivity, not strict original TDD. No live accuracy claims. Reviewer /root/voice_review2 pending.
Task 2: complete (commits fe980ce..7500986, review clean).
Task 2: minor (deferred): expand missing-field and finite out-of-range probability output tests; final reviewer to triage.
Task 3: dispatch BASE 7500986.
Task 3 implementation f8aae58; focused 97/97, gateway 303/303; reviewer /root/voice_review3 pending.
Ruling: Keep one global voice pipeline locked until an abort-ignoring provider settles — avoids accidental parallel provider execution — cost: a broken provider can disable voice until restart while manual ctl remains usable.
Ruling: Voice Origin trusts socket scheme/Host only; existing tunnel uses TLS upstream — avoids trusting spoofable forwarded headers — cost: plain-HTTP upstream TLS-terminating proxies unsupported in first version.
Task 3: complete (commits 7500986..f8aae58, review clean).
Task 3: minor (deferred): dense route formatting; isolated coverage for response-close cancellation and post-completion rate limiting. Final reviewer to triage.
Task 4: dispatch BASE f8aae58.
Ruling: Task 4 may add tested VoiceManeuver.configure(presets) to apply server settings without mutating private state — preserves injected scheduler ownership and validates before reset — cost: Task 1 interface expands by one method.
Task 4 implementation 03fe98d; combined focused 24/24, gateway 320/320; reviewer /root/voice_review4 pending. Public context/limits schemas in task-4-report.md required for Task5.
Task 4 review Important: stale recorder onerror can cancel newer capture; fix round1 dispatched to original implementer.
Task 4: minor (deferred): response at lifetime boundary reports invalid_result instead of stale_result; no movement occurs; final reviewer to triage.
Task 4: fix round 1/5 (1 addressed, 0 open — stale recorder error/timeout; commits 03fe98d..929fe50).
Task 4: complete (commits f8aae58..929fe50, review clean; one deferred minor).
Task 5: dispatch BASE 929fe50.
Ruling: Task 5 may correct controller default native fetch receiver, reproduced by real Firefox/gateway E2E and focused RED regression — actual browser Window binding differs from mocks — cost: Task 4 file changed during integration; review includes it.
Task 5 implementation 28a76ba: gateway323/323; voiceE2E2/2; fullE2E11/12 with existing pilot invalid_timing=2; single focused diagnostic1/1 no source changes, cause unproven. Original artifacts auto-deleted; diagnostic preserved /tmp/voice-task5-pilot-diagnostic. Do not claim full E2E green. Reviewer /root/voice_review5 pending.
Task 5: fix round 1/5 (1 addressed, 0 open — full E2E evidence; HEAD unchanged28a76ba, full diagnostic12/12,0skip).
Task 5: complete (commits 929fe50..28a76ba, review clean).
Task 5: minor (deferred): explicit browser stale actual mode telemetry test missing; implementation guard present.
Task 6: dispatch BASE28a76ba.
Task 6 implementation9665e54; gateway327/327; voiceE2E2/2+trace1/1; C unit141/integration41; relay11; analysis57; all exit0. Reviewer /root/voice_review6 pending.
Ruling: After optional trace-only changes use focused voice E2E plus full gateway and retain prior full browser12/12 evidence — avoids repeating unrelated8minute suite — cost: entire browser suite was not rerun on trace-only changes; targeted path is covered.
Hardware/live API steps deferred with actionable docs; software is implemented, real-world behavior not claimed.
Task 6: complete software (commits28a76ba..9665e54, review clean); real audio/API/hardware steps deferred.
Task6 minor (pre-existing,deferred): Python negative-test expected diagnostics printed in passing output.
All six software tasks reviewed. Final whole-branch review pending.

Resume: HEAD9665e54 clean; original final reviewer hit usage limit before writing report; no completed final verdict.
Ruling: Use available gpt-6.1-sol high for replacement whole-branch review after gpt-6-astra usage limit — finishes review without waiting for quota reset — cost: replacement review uses a different model.
Replacement final reviewer /root/voice_final_review_resume dispatched with complete branch package.
Final whole-branch review complete: With fixes. ImportantI1 enabled voice panel degrades touch stick geometry; MinorM1 capture self-error/timeout does not update controller; MinorM2 stale response shown invalid. No confirmed Critical auth/control defect.
One final fix wave dispatched /root/voice_final_fixes, BASE9665e54, coversI1+M1+M2 and targeted tests. Optional prior coverage/formatting notes remain nonblocking.


## Final review fix wave — 1b1b75e

I1 compact/stable voice-enabled touch layout and generic content-driven geometry guard fixed; M1 composed capture/controller recovery and M2 freshness feedback fixed. Explicit browser stale actual-mode telemetry coverage added. Gateway/web 330/330; focused capture/controller 23/23; changed voice/layout browser files 6/6; syntax/diff checks passed. Heavy suites serialized; no full-browser/core/relay/Python repeats, live APIs, hardware, service changes, pushes or deployment. All remaining optional/nonblocking final-review notes retained with disposition in `final-fix-report.md`; preserved exact RED/GREEN output under `final-fix-evidence/`.

Final fix wave complete: commit1b1b75e parent9665e54; gateway330/330, voice/layout6/6, capture/controller23/23.
Final scoped re-review: I1/M1/M2 ADDRESSED; no new breakage; merge readiness YES.
Software implementation complete on feat/voice-commands; deployment/push/merge not performed. Live microphone, billed API evaluation, props-off signs/calibration and supervised flight remain deferred.

## Final review disposition

# Final fix-wave re-review

**Range:** `9665e54..1b1b75e` (HEAD `1b1b75e`, parent `9665e54`).

This is a scoped re-review of I1/M1/M2 in `final-review.md` and changes introduced by the single fix wave. I read `final-fix-report.md`, the packaged fix diff and the changed code/tests. I did not restart the whole-branch review or rerun suites. Source, index, HEAD and branch state were not changed; this requested ignored report is the only checkout write in this turn.

## Finding verdicts

| Finding | Verdict | Evidence and reasoning |
|---|---|---|
| **I1 — touch pads shrink or move as voice feedback wraps** | **ADDRESSED** | `web/css/app.css:285` gives the strip a fixed 34 px footprint, prevents button wrapping, and places bounded feedback in two fixed-height rows. The short-screen touch padding adjustment preserves cockpit room. The enabled touch regression retains the original minimum **100 px** requirement, tests both pads at **640/740/800/1024 × 360**, and checks stable rectangles through recording/processing, short and 1000-character transcripts, execution/completion, errors and cancellation. Reported measured pads are **101.9/101.9/104.8/172.3 px**, with the strip consistently 34 px. Real BiDi multitouch verifies held manual output remains unchanged when PTT is attempted and the same stick position is revisited. |
| **I1 — content-driven geometry bypasses the existing safety guard** | **ADDRESSED** | `web/js/app.js:298` checks layout before command composition/sending on every control tick. Shared `checkPadLayout()` at line 693 uses the existing `padsMoved`/`layoutAction` rule, retaining its 4 px tolerance and 1500 ms settling behavior. Window handlers use the same function. The new test deliberately changes footer height without a window event and requires disengagement. The documented independent RED with only the tick guard removed demonstrates this assertion is sensitive to the intended behavior. |
| **M1 — capture errors/timeouts leave controller/UI recording and busy** | **ADDRESSED** | `web/js/voicecapture.js:36` emits fixed `capture_failed`/`recording_timeout` errors only for the current recorder generation. `web/js/voicecontroller.js:13` observes capture state, invalidates work and emits idle/error. Cancellation is safe from recursive notification: capture clears its current state before notifying, so the controller's follow-up cancel has no active capture to notify again. Composed tests use the real capture/controller/maneuver classes and establish stopped tracks, idle/not busy, no upload, immediate next press, and old callbacks sparing that new press. Browser coverage verifies the actual app error feedback. |
| **M2 — freshness-boundary response says invalid_result** | **ADDRESSED** | `web/js/voicecontroller.js:65` checks response age separately and emits `stale_result`. Tests cover valid replies at 6000 and 6001 ms and verify no maneuver starts. Envelope validation remains independent. |

The previously nonblocking stale actual-mode browser coverage gap is also addressed: the lifecycle scenario continues fresh status and manual ticks while suppressing mode telemetry for more than 500 ms, submits a valid command, and requires neutral maneuver axes and idle state.

## New breakage in the fix diff

**None found.** The fixed footprint preserves plain-text transcript/action/error DOM content while bounding visual overflow. The generic layout guard runs before the existing dead-man/output decision, and it applies the established rule rather than creating another movement policy. Capture recovery retains the previous generation/identity protection. Gateway authorization/provider runtime and numeric maneuver bounds are unchanged by this wave.

The optional provider malformed-probability tests, route formatting, isolated response-close test and post-completion rate-limit test remain nonblocking follow-up items under the original review rulings. No newly established defect warrants reopening them.

## Validation evidence

Inspected the saved log summaries in `final-fix-evidence/`:

- `browser-final.log`: **6 passed, 0 failed/skipped**, changed voice/layout browser paths, 244721.75855 ms.
- `gateway-final.log`: **330 passed, 0 failed/skipped**, gateway plus web unit suite, 23695.635539 ms.
- `unit-green.log`: **23 passed, 0 failed/skipped**, focused capture/controller composition and lifecycle checks.

The fix report also records changed-JavaScript syntax checks and `git diff --check` passing. Tracked `git status --short` is empty and HEAD/parent match the stated range. No additional test execution was needed for this re-review.

## Declined to judge / remaining limits

- Real PC/Android microphone permissions, emitted codecs and ASR/classification quality still require the explicitly deferred device/live API campaigns; substituted media/provider tests do not certify them.
- Aircraft movement signs, physical response and props-off/supervised flight calibration remain deferred operator work. Software bounds and fixed geometry are not hardware or flight certification.
- Historical full-browser/core/relay/Python evidence is preserved from the original review; this wave establishes changed voice/layout and gateway/web results only. The original earlier pilot timing failure's precise cause remains unproven.
- Unchanged files and unrelated optional coverage/readability follow-ups were not re-reviewed as new scope. No billed API, microphone, TX/aircraft, deployment, push or merge was performed.

## Assessment

**Ready to merge? Yes.**

All original final-review findings are addressed, and no new issue was found in the scoped fix diff. Merge readiness concerns the implemented software; the feature remains disabled by default and real-device/API/aircraft validation remains required before a live demonstration.
