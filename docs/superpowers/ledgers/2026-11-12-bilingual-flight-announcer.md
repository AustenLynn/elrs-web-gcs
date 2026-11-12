# SDD ledger — plan: docs/superpowers/plans/2026-11-12-bilingual-flight-announcer.md

Branch feat/bilingual-announcer (worktree `.local/worktrees/bilingual-announcer`), base 5e2304d,
approved design aa959e7. Three tasks: 1 bilingual UI (i18n), 2 announcer engine, 3 pilot-page
integration. Tasks 1 and 2 ran concurrently on disjoint files. The working ledger lived in the
untracked `.superpowers/sdd/2026-11-12-bilingual-flight-announcer/progress.md`; its `Ruling:`
lines are copied here verbatim.

## Preflight
| Task pair | Contract | Finding |
|---|---|---|
| 1 self | catalog and persisted language vs translated state text | Explicit catalogs preserve protocol/input data; deterministic tests need Spanish setup where defaults change |
| 2 self | confirmed transition engine vs opt-in prerecorded playback | No physical actions or provider dependency; unknown telemetry seeds/reset silently |
| 3 self | integration consumes both engines | Single UI hookup after both task gates; no shared file writes during tasks 1/2 |
| 1/2 | language 'es'/'en' | Task 2 accepts language through setter; no dependency on catalog until integration |
| 1/3 | t/getLanguage/onLanguageChange/initLanguageUI | Task 3 only adds announcer control after task 1 commit |
| 2/3 | FlightAnnouncer update/recording/enable/mute | Task 2 defines API; Task 3 feeds confirmed UI telemetry, not commands |

Baseline 406/406 (after linking the existing relay node_modules into the worktree; no
dependency changes). Physical preflight DISARMED, serial DOWN, before every e2e run.

## Rulings
Ruling: Implement tasks1/2 on disjoint files concurrently, review each before task3 — independent deliverables; same branch, exact-path commits only — cost: coordination required for full tests.
Ruling: First enable requires user gesture and opt-in; persisted preference cannot bypass browser autoplay restrictions — safe browser behavior — cost: returning users may need a tap.
Ruling: No ElevenLabs key in current environment; protected service env not readable without sudo. Asked user for path only; build generator/playback without substituting audio — cost: real clips may remain pending user setup.
Ruling: static gateway must serve .mp3 as audio/mpeg with existing nosniff header; Task3 includes gateway/src/static.js and gateway/test/server.test.js MIME regression — required for new audio assets — cost: gateway deployment/restart needed for new MIME map.
Ruling: Language change must not reset padsAtEngage or suppress existing layout safety. Use stable compact layout; if geometry truly moves under held input, existing safety still applies — prevents masking stick relocation — cost: on an unsupported/reflowing layout a language change may release controls for safety. Task1 worker notified before commit; Task3 tests geometry.
Ruling: Fix I1 by making the language select never hold flight keys hostage: exclude [data-language-select] from typing() so the global flight/safety keydown handler still runs (and preventDefault on keys it consumes so Space/arrows don't operate the select), plus blur the select after change. — safety keys must always work on a real-aircraft UI — cost if wrong: keyboard-only users can't change language with arrow keys (mouse/touch/Tab+Enter-picker still work).
Ruling: HOLD/LANDING announced as ARMED (app.js:629) stands — core keeps ARM high in both, so "armed" is literally true and the safe thing to tell a pilot; spec doesn't define HOLD clips and adding new clips needs new paid assets — cost if wrong: pilot hears "armed" on entering hold, which may be confusing; a dedicated hold clip can be added later.
Ruling: voice.e2e test5 failure is pre-existing flakiness also present on main (channel-vs-status race at :469 + orphaned Firefox content processes), not a branch regression; not fixed in this plan — evidence shows main failing identically — cost if wrong: a real branch-induced timing regression in recovery/re-arm (:485 failure seen once by controller, not reproduced in 11 runs) ships unnoticed.

## Tasks
- **Task 2 (announcer engine)**: 1909ed7; review Important I1 (volume=0 probe audible on iOS,
  ignored volume). Fix round 1/5 → 9ef47f5 (muted probe). Re-review clean. Complete 5e2304d..9ef47f5.
- **Task 1 (bilingual UI)**: 8c427ea; review Important I1 (focused language `<select>` swallowed
  keyboard disarm/failsafe/flight keys). Fix round 1/5 → cf1ba69 (select excluded from
  `typing()`, blur on change). Re-review clean. Complete 9ef47f5..cf1ba69.
- **Task 3 (integration)**: 2fcbec8 (`.mp3` → `audio/mpeg`), c9b63cc (announcer wiring);
  gateway 436/436, announcer e2e 4/4. Review Important I1 (reconnect settle window anchored at
  `onopen`, hub replays cached link telemetry on hello → spurious "signal lost"). Fix round 1/5 →
  bf412b9 (settle anchored at first welcome and first link report; delayed-replay e2e). Voice
  e2e test 5 shown failing identically on main (see ruling). Complete cf1ba69..bf412b9.
- **Final review** (5e2304d..bf412b9): With fixes. Important: F1 last-spoken announcement could
  contradict the confirmed state (routine drop while playing, per-event cooldown dropping the
  last step of a flap); F2 no HTTP Range/206 for static files (iOS media); F3 rulings only in the
  untracked ledger, generator tests in no suite, HANDOFF §5 not updated.

## Deferred minors
- Task 1: opaque line-number/truncated catalog keys (throttle.189, take.control.202…)
- Task 1: i18n.js ~608 lines; consider per-language catalog files
- Task 1: unknown voice error codes hide raw code (keep in title); EN ';' vs ':'
- Task 1: admin non-keyed errors (fetch TypeError) show generic "Server error" not err.message
- Task 1: watch.js regex-parses English videostats problem strings, untested coupling
- Task 1: fullscreen tip closure hardcodes {canFullscreen:false,standalone:false}
- Task 1: language selector markup duplicated in 3 HTML files, CSS inline in watch.html
- Task 1: tautological user assertion in i18n.test.js
- Task 1: no unit tests for onLanguageChange wiring in app/admin/watch (announcer e2e covers the pilot page)
- Task 1: Space keyup preventDefault also applies to observers when the language select is focused
- Task 1: blur-on-change also fires on keyboard arrow selection (keyboard/screen-reader users lose focus)
- Task 1: in input modes that don't consume arrows, ArrowUp/Down on the focused select changes language once
- Task 3: page calls engine `fail()` outside the planned interface — name/document it
- Task 3: `announce()` default param `segments()` and `renderAnnouncer()` in the language listener outside try/catch
- Task 3: tap during recording gives no visible feedback
- Task 3: fixed 54 px portrait footer buttons hold ≤3 lines; longer future translations overflow visually
- Task 3: e2e harness kills only the parent Firefox, leaving content processes that load the Pi (pre-existing)
- Task 3: voice.e2e test 5 channels-vs-status race at :469 (pre-existing on main)
- Final: unknown radio resets the baseline, so up→unknown→down is a silent seed (a failsafe is still announced)
- Final: generator `validAudio` accepts only fixed 128 kbps / 44.1 kHz MPEG-1 frames; check one real provider sample
- Resolved in the final fix wave: probe leaving `muted=true` (already fixed in Task 2), stale
  "clips missing" error after a language switch, missing `page.errors` assertion, stalled clip
  keeping `playing` set, throwing language listener skipping the others.

Final fix wave: <filled by controller>
