# SDD ledger — plan: docs/superpowers/plans/2026-11-11-confirmed-mode-readiness.md

Branch fix/voice-confirmed-mode-state, main baseline542245a, task BASE0656eaf. Task1 pending.

Evidence: installed binary hashes equal verified actual-frame fix, restarted core. While ARMED+Normal+RF100,93status/42link updates in10s but only cached S-NORMAL mode once. Existing heartbeat requirement incompatible with actual sparse mode reports. User authorized continue, then manually left DISARMED; crsf-ctl verified DISARMED before dispatch.

## Preflight
|Pair|Contract|Finding|
|---|---|---|
|1 self|Stateful mode confirmation+fresh RF/core and authoritative status.voice|Consistent; replaces stale-mode-only tests deliberately, preserves lost/stale RF and status negatives|

Ruling: Treat last-confirmed Normal as event state instead of500ms heartbeat, but require fresh (<500ms) positive RF and core status, invalidate on interruptions/mode changes and demand new confirmation after invalidation — matches observed hardware semantics without inventing frames — cost: after RF loss operator may need manual mode confirmation while disarmed.
Ruling: Use one gateway readiness result for both HTTP checks and browser status; browser still enforces all local current-tick conditions — avoids divergent stale-mode rules — cost: upgraded browser fails closed with an old gateway until deployment/reload.
Ruling: Publish initial core snapshot as last-known state subject to fresh live status/RF, never claim a recent physical mode packet — existing IPC has no provenance/age field — cost: physical mode validity relies on event-stream state plus commanded Normal and fresh link rather than an arbitrary age.
Ruling: Preserve prior actual-frame C fix; no C/protocol changes here — repeated reports still forwarded when they exist — cost: existing reviewed core remains prerequisite.
Task1 implementer pending. No runtime/service/aircraft/API actions authorized to worker; heavy tests gate on actual DISARMED.
Ruling: Extend fixed reason catalog with unsafe_state for FAILSAFE/HOLD/LANDING/unknown; not_armed reserved for DISARMED — generic arm prompt was misleading where core refuses arming — cost: one additive fixed reason handled by UI/controller tests; no safety transition change.
Initial gateway380/380 pass; browser tests in progress; implementer notified exact extension.
Ruling: Keep idle not_ready feedback synchronized with authoritative readiness status, including same-value Normal reconfirmation; never overwrite active voice phases/provider errors — fixes stale labels after recovery seen in user troubleshooting — cost: minimal UI state tracking and browser regression, no readiness-policy change.
Initial browser run3/4; real-core outage correctly triggered RF failsafe. Fixture follows actual manual fake recovery, not relaxed core timeout.
Resume: original implementer unavailable; source still uncommitted, saved gateway380 pass and browser recovery failure preserved. Fresh worker /root/confirmed_mode_finish resumes remaining fixture/UI work without replaying completed tasks.
Ruling: Preserve confirmed aircraft Normal across harmless pilot-session change and manual disarm/rearm when live RF/core and target unchanged — physical mode state is independent from actor identity; auth/capability/session checks remain mandatory — cost: confirmation no longer reset by these harmless transitions, only specified physical/unsafe interruptions. Fixes initial cached-mode-before-login usability with sparse hardware reports.
Implementation be91e7f: gateway391/391, browser5/5, focused59/59 pass; independent Astra review found ImportantR1: RF loss+RF recovery+same-string Normal before held provider resolves returns200 and executes old utterance. No runtime/deploy done.
Ruling: Bind live capture/request to persistent flight invalidation epoch, advertised as additive status metadata and sent with live requests; validate before provider and after completion, cancel browser work across observed epoch changes — readiness recovery only authorizes a new utterance, never revives old work — cost: upgraded live client/server must deploy together and reload; old/missing epoch fails closed. No CRSF/core IPC, safety transition or dry-run dependency change.
Task1 fix round1 dispatched to existing implementer; BASEbe91e7f.

Task1 round1 complete: commit2877102; focused161/161, gateway/web406/406, voice browser5/5, no failures/skips. Independent scoped rereview R1 ADDRESSED; 15/15 regressions independently passed, no new findings. Controller reran full gateway/web406/406 exit0; reviewed saved browser5/5 output. Source diff check clean.
Integration approved under existing local-main merge instruction. No push. Deployment remains pending privileged gateway-only restart; current aircraft DISARMED/serial DOWN. Prepared checksum-pinned helper .local/install-confirmed-mode-fix.py with backup/rollback; sudo requires user password. No secrets/config/C/core restart or real voice commands changed/sent. Old clients must reload after gateway/browser deployment.

# Independent review: confirmed-mode readiness

Reviewed baseline `542245a` through `be91e7f`, including all 15 changed files and the packaged diff in several passes. Read the task brief, global context, progress rulings, full task report and design specification. Review was read-only except this requested artifact; no source/index/HEAD changes, additional reviewers, services, hardware or live API calls.

## Strengths

- `gateway/src/voiceflight.js:15`: Gap checks precede replacing receipt timestamps, so a new status/RF packet cannot conceal a 500 ms interruption. Nonfinite/backward time, invalid LQ and exact deadline boundaries fail closed. Confirmation persists across sparse mode reports without synthesizing mode receipts.
- `gateway/src/hub.js:366`: Accepted mode/Turtle intent reaches the tracker before forwarding, closing the between-status target-change window. Actor authorization remains independent; private capabilities still rotate/invalidate through the existing lifecycle. `#hello` only replays cached telemetry to clients, never to the tracker.
- `gateway/src/voice.js:73` and `gateway/src/hub.js:394`: HTTP admission/result checks and public status use one readiness policy. The browser requires strict boolean readiness and retains current engagement, manual-input, desired-mode and status-age checks (`web/js/voicecontroller.js:94`).
- `web/js/voicecontroller.js:82` and `web/js/app.js:301`: Preserving an idle prerequisite label does not bypass cancellation: generation, abort, capture, pending maneuver and repeat cleanup still execute. Fixed Spanish reason labels have full titles and a bounded fallback (`web/js/app.js:84`).
- Tests cover sparse confirmation, RF-only recovery rejection, unsafe states, rapid target changes, cached replay, legacy browser flags, actor/session boundaries and real-core fake-radio execution. The report preserves unsuccessful fixture attempts and distinguishes measured software behavior from physical validation.

## Issues

### Critical

None identified.

### Important — R1: An interrupted in-flight utterance can execute after reconfirmation

**Locations:** `gateway/src/voice.js:99`, `gateway/src/voiceflight.js:15`, `web/js/voicecontroller.js:97`; related `web/js/voicecontroller.js:24` and `web/js/app.js:201`.

The route checks only the current readiness at admission and completion. It does not record whether this request crossed a confirmation invalidation. Browser processing survives `voiceReady=false`: the tick cancels processing only on `baseSafe` loss, and readiness is checked only once a result is pending or a maneuver is executing. A subsequent identical Normal report does not trigger the app's mode-value-change cancellation.

Consequently, an utterance submitted before RF loss can start motion after recovery without another utterance. This is an interruption-history issue, not a disagreement with the approved policy that a new physical Normal report can restore current readiness.

**Focused reproduction performed against the real hub, HTTP route and browser controller classes, with fake in-memory transport/provider and clock, no files or services:**

1. At t=1000, establish ARMED/session 42, Normal targets, positive RF and actual `S-NORMAL`; submit an utterance and hold its provider promise.
2. At t=1100, deliver LQ 0 and fresh ARMED status, pass the false readiness into `onReadiness` and a control tick. Observed `{ready:false,reason:"link_lost"}` with browser phase still `processing`.
3. At t=1200, deliver positive RF, fresh status and a new identical `S-NORMAL`; complete the original provider promise.
4. Observed HTTP **200**, `{ready:true,reason:"ready"}`, and browser output `{roll:0,pitch:50,yaw:0,throttle:0}`, with **one maneuver start**.

The short interruption does not require a core state change, session change, pilot input or a non-Normal mode string, so the existing independent cancellation hooks need not fire. The task explicitly requires “loss during provider work rejects without execution” and “RF loss/staleness cancels/rejects.” Existing tests stop at RF loss or RF-only recovery; they do not cover recovery plus reconfirmation before the original provider finishes.

**Suggested fix:** retain an invalidation generation (or equivalent request invalidation signal) in gateway state and bind live requests to it, rejecting a completion that crossed an interruption even if current state has recovered. Keep readiness restoration for new requests. Separately cancel/discard live pending browser work when its observed safety context is interrupted; preserve the approved idle-only feedback behavior and disarmed/dry-run UX. Add a held-provider regression with loss, positive RF and same-string Normal recovery, proving zero starts for the old request and successful admission for a new request. Cover a brief loss/recovery between status publications on the server as well, because browser-only cancellation cannot observe every gateway event.

### Minor

None raised.

## Spec compliance and approved choices

The principal sparse-mode implementation follows the approved contract. Fresh RF and core status are still mandatory; all freshness comparisons are strictly less than 500 ms. Physical confirmation is separate from pilot identity, manual arming, target state and cached display telemetry. Status publication is additive and contains no capability or key. Core/protocol/C safety logic is unchanged.

The initial core snapshot's lack of physical receipt provenance is an explicitly accepted policy limitation, not an implementation defect. Likewise, preserving physical confirmation across benign session creation and manual disarm/rearm, adding `unsafe_state`, and preserving only idle readiness feedback through failsafe resets follow the recorded controller rulings. None of those choices requires pending requests to survive an RF interruption; R1 concerns request validity across that interruption.

## Validation and limits

- Inspected saved final TAP evidence: gateway/web **391/391**, voice browser **5/5**, zero failures/skips. Those runs were performed by the implementer, not rerun during this review.
- Independently ran the focused R1 reproduction described above; it exited 0 and demonstrated the unexpected successful result/movement. This establishes cross-component software behavior, not a physical aircraft action.
- Independently ran `git diff --check 542245a..be91e7f`; no whitespace errors. Checkout status was clean before writing this ignored review artifact.
- No broad suites were rerun. Historical RED logs and fixture failures remain historical evidence; their exact original shell outcomes are not independently certified by this review. The report's stated inherited limitations remain applicable.

## Declined to judge

- Real radio cadence, aircraft response and the physical validity of last-known Normal after reconnection: outside this fake-input software review; hardware is offline and the snapshot policy is explicitly approved.
- Real microphone permission/capture/codec behavior and provider recognition quality, availability or billing: substituted media/provider only, and live calls are prohibited.
- Rebuilding/retesting C, unrelated browser paths, relay and deployment/service behavior: unchanged by this branch and explicitly excluded from the review's validation scope; prior reviewed core remains a prerequisite.
- Retrospective exact causes of inherited fixture failures that were not proven in their saved diagnostics: the implementer clearly records the uncertainty; this review does not convert those attempts into passing evidence.
- Broader threat-model or maneuver-calibration redesign: this change preserves the existing authenticated bounded-command architecture; no new audit or physical safety certification was requested.

## Assessment

**Ready to merge? With fixes.** Resolve R1 before merge or deployment. The confirmed-state policy and most wiring are sound, but current-state recovery can revive a pre-interruption utterance; passing suites do not cover this demonstrated race.

# Scoped R1 rereview

**Range:** `be91e7f..2877102`. Read the complete packaged fix diff and the R1 appendix in `task-1-report.md`. This review is limited to R1 and regressions introduced by its fix; it does not restart the earlier whole-branch review.

## Finding disposition

**R1 — ADDRESSED.** An admitted live utterance can no longer survive the demonstrated RF loss → RF recovery → identical Normal reconfirmation during recognition.

- `gateway/src/voiceflight.js:11`: Reset advances the epoch; a new confirmation invalidation advances it without resetting it on reconfirmation. Repeated invalid reports do not churn the epoch. Healthy reports and the approved benign state/session transitions retain their earlier behavior.
- `gateway/src/voice.js:60`: The route validates the capture-bound epoch at admission, after upload and after provider completion. Readiness is evaluated before comparing the epoch, so freshness checks that discover a gap invalidate the same request. A fully recovered interruption still produces `interrupted`; a currently unsafe state retains its accurate `not_ready` reason. The checks do not depend on a false-ready status reaching the browser.
- `web/js/voicecontroller.js:59`: Live capture binds the epoch at press, preventing an old recording from adopting the recovered epoch during submission. `onReadiness` and the control tick invalidate active work on epoch mismatch or loss of its previously valid safety context (`:25`, `:113`). Existing cancellation increments generation, aborts where possible, and clears pending/active/repeat state; late results cannot restart work.
- `gateway/src/hub.js:395` and `web/js/app.js:330`: The public status carries the same current epoch used by server checks, and the app passes it into each control tick. The value adds no capability or credential exposure.

Dry-run requests remain exempt from live epoch/RF/arming requirements. A disarmed live attempt can still obtain prerequisite feedback. Healthy live work and new utterances after recovery remain possible. The documented requirement for the new header makes old live clients fail closed, consistent with the controller-approved compatibility choice.

## Validation

Independently ran:

```sh
node --test --test-name-pattern='R1|epoch|hidden RF bounce|hidden recovered|binds its press' gateway/test/voice.test.js gateway/test/voiceflight.test.js gateway/test/hub.test.js web/test/voicecontroller.test.js
```

**15/15 passed, exit 0**, including the original combined real hub/route/controller held-provider scenario; server-only hidden loss/reconfirmation; interruption during upload; stale or invalid press epochs; all four active browser phases; ignored late results; and successful new requests after recovery. Inspected the tests' assertions rather than relying only on their names or the task report.

`git diff --check be91e7f..2877102` passed. Checkout status was clean before this ignored report was written. The implementer's reported final 406/406 gateway/web and 5/5 browser results were not rerun here. No source, index, HEAD, services, API or hardware changes were made.

## New issues introduced by the fix

None identified. No Critical, Important or Minor findings in this scoped rereview.

## Declined to judge

- Unchanged whole-branch behavior: already covered by the prior review and expressly excluded from this rereview.
- Physical RF/aircraft behavior, real microphone/provider quality, deployment and C safety validation: unchanged scope limitations; only fake-input software checks were run.
- Broad suite reproducibility: the requested scope forbids rerunning those suites; their results remain implementer evidence.

## Assessment

**Ready to merge: Yes, with respect to R1 and this fix.** The prior blocking race is resolved, and no new regression was found in the scoped changes. Existing physical-validation and deployment limits from the original review remain in force.
