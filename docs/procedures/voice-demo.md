# Voice evaluation and calibration record

Status on 2026-11-10: software automation passed as recorded in the task reports; real PC/Android microphone recordings, billed model evaluation, props-off aircraft validation and supervised flight calibration are **DEFERRED**. No recognition-quality, distance, stopping or hovering claim follows from mocks. Complete [setup](../setup/voice.md) first. Record operator/date, commit, device/browser/version, codec, network, presets and observations for every campaign.

## 1. Simulation with real microphones

Keep propellers off and the aircraft disarmed; select `dry-run`. Use both a PC and Android device with a trusted secure origin. Prepare the microphone explicitly while disarmed, engage the pilot, then tap **Hablar** and tap **Enviar** after one utterance. Desktop **V** remains hold/release. Releasing the first tap must keep recording without uploading; the second completed tap submits once. Check that Cancel, manual input, focus/session loss and the five-second limit discard without submitting, and that V/button gestures cannot submit each other’s recordings. Record consented audio externally only if the operator intentionally chooses to retain it; the application does not save recordings. Keep recordings and transcripts out of repository logs. Use the labeled examples in `gateway/test/fixtures/voice-utterances.json`, plus real silence/noise, accents, mixed-language speech and repeats with/without history. Include all six directions, both tiers, negation, distance, numeric duration, compound and unsupported requests.

For each device/language/category record aggregate totals, expected/selected matches, false permitted movements and no-action outcomes, release-to-result latency (median/p95/max), and errors. Review every false permitted action before enabling output. A dry-run pass demonstrates recognition behavior only, never actual movement. Permission denial, unsupported codec, release before permission resolves, >5 s speech, network loss, slow/unresponsive provider, cancel/manual input during processing, blur/suspension, ownership transfer and a late response must all produce **no voice movement**. Confirm manual controls continue throughout. Do outage/delay tests on a controlled bench network/test provider, never by disrupting an in-flight network.

## 2. Optional billed classification fixture run

Only after explicit operator authorization for API use and credential setup, run from the checkout with `OPENAI_API_KEY` already provided by secure environment tooling:

```bash
node tools/evaluate-voice.mjs --live > /path/outside/repo/voice-text-evaluation.jsonl
```

This sends 23 labeled text fixtures to Decisions; transcription is simulated locally. It is **not** a real recording or ASR evaluation. Output includes fixture transcripts (public test phrases), expected/selected choices and a final `{total,mismatches}`. Retain the total/mismatches and language/category aggregates in the operator record; exit 0 means no mismatches, 1 means mismatch/error, 2 means missing opt-in/key. Never include credentials in the record. Actual microphone speech requires the separate browser campaign above. No billed run was performed during implementation.

## 3. Props-off output verification

Use the existing [M3 bench prerequisites](m3-bench-test.md), [Aquila setup](../setup/aquila20.md) and existing recovery procedures. **Remove propellers; attach the TX antenna before power; never feed its XT30 over 12 V.** Keep the aircraft restrained and clear. The historical M3 procedure stops the gateway for `crsf-ctl pilot`; do not run that second pilot concurrently with this gateway voice test. Use an approved read-only output/telemetry observation method for this campaign.

After successful simulation, deliberately select `enabled`, restart only in an authorized safe deployment session, and reconnect. Manually select Normal, engage and arm using existing controls. Begin with short duration and low strength. Check each direction separately against actual output channels: forward pitch positive by keyboard convention, backward negative; right roll positive, left negative; turn right yaw positive, turn left negative. Confirm signs against the actual aircraft configuration before any props-on work. Observe commanded channel values, not physical travel, with props off.

For every direction/tier record observed sign, amplitude and monotonic duration; verify duration ≤ configured preset/hard cap and strength ≤ configured/hard cap. Confirm throttle is unchanged by the overlay and arm/mode/turtle channels are unaffected. Hold a manual key (including a key before its ramp advances), move/hold a stick, press C/cancel, blur the page, disconnect, disarm, change mode, and transfer ownership in separate controlled trials. Confirm immediate local cancellation and discard of delayed recognition; restored focus/connectivity must not resume or queue a maneuver. Simulate page suspension past the deadline: no extended output on resume. Verify repeat only follows successful completion and is cleared by cancellation. Record failures and restore `voice:null` or `dry-run` before leaving the bench.

## 4. Supervised calibration flight

Only after the bench record is accepted by the operator/mentor, follow the site's existing flight rules, clear space, visual line of sight and a ready manual pilot. Props-on work belongs only to this separate supervised flight phase. In Normal mode, manually establish safe flight, then test one short maneuver at a time. Observe actual displacement, drift, overshoot and manual recovery. Start small; adjust only the bounded configuration between safe disarmed sessions. Throttle/altitude stay manual. Abort on misclassification, unexpected sign, delayed output or loss of control readiness.

Record actual observations with battery, payload, conditions and presets; do not infer meters from duration or claim precision/automatic stopping. Medium trials follow successful short trials. Finish by disarming and restoring simulation/disabled configuration. This phase is deferred until operator and aircraft are available.

| Campaign | State | Evidence required |
|---|---|---|
| Automated gateway/web/real-core fake-serial checks | Passed; see implementation reports | Commands, exits, counts; substituted media/provider identified |
| PC real microphone bilingual simulation | Deferred | Device/codec and labeled aggregate results |
| Android real microphone bilingual simulation | Deferred | Device/codec and labeled aggregate results |
| Live Decisions text fixture evaluation | Deferred | Explicit API authorization, aggregate total/mismatches |
| Props-off real output/cancellation calibration | Deferred | Observed signs/caps/throttle/cancellation |
| Supervised Normal-mode flight calibration | Deferred | Operator, site approval and observed movement |

## Software verification record (2026-11-10)

Task6 deployment/config/controller/trace focused checks passed22/22; missing-credential startup, public-config allowlist and continued manual WebSocket control passed. The focused voice browser suite passed2/2 with substituted microphone/provider and real-core fake serial integration. The additional `?measure` browser scenario passed1/1, verifying finite timing rows and no exposed trace without opt-in. None of these tests used live API credentials or certified real microphone recognition.

Before these optional trace/documentation changes, Task5 commit `28a76ba` passed the full browser suite12/12 with zero skips, including video. Preserved full-run pilot timing evidence had34 complete commands,45 not submitted and0 invalid timing/timestamp mismatches. An earlier full run had failed its pilot report with2 invalid timing rows; original worker artifacts were deleted by cleanup. A focused diagnostic and subsequent full run passed unchanged, but the original cause remains unproven. The subsequent pass does not establish an environmental root cause. Task6 uses focused browser verification for its changed path instead of repeating that eight-minute suite.


| Task6 command | Result (exit 0) |
|---|---|
| `npm --prefix gateway test` | 327 passed, 0 failed/skipped |
| `node --test --test-concurrency=1 gateway/e2e/voice.e2e.js` | 2 passed, 0 failed/skipped (before opt-in assertions) |
| `node --test --test-concurrency=1 --test-name-pattern='voice PTT' gateway/e2e/voice.e2e.js` | 1 passed, 0 failed/skipped (opt-in assertions) |
| `make -C core test` | 141 unit tests passed, UBSan |
| `make -C core integration` | 41 tests passed, fake serial only |
| `npm --prefix relay test` | 11 passed, 0 failed/skipped |
| `python3 -W error -m unittest discover -s tools/analysis -t tools/analysis` | 57 passed |
| `git diff --check` and changed-JavaScript syntax checks | Passed |

The first focused browser run began at43.3°C; the subsequent trace scenario began at44.3°C and passed. C unit compilation overlapped part of the first focused browser run inadvertently (observed49.1°C); both passed. Remaining suites were serialized. An initial trace browser assertion failed because the test helper returned nested WebDriver values; explicit JSON serialization corrected the test without changing production behavior. Live API/microphone/hardware campaigns remain deferred above.


The final review fix wave passed `npm --prefix gateway test` **330/330**, with 0 failures/skips, after focused capture/controller checks **23/23**. `node --test --test-concurrency=1 gateway/e2e/voice.e2e.js gateway/e2e/layout.e2e.js` passed **6/6**, with 0 failures/skips: existing phone layouts/fullscreen transitions, voice lifecycle including stale actual-mode telemetry, enabled touch feedback/multitouch, and real gateway upload with substituted media/provider and fake serial. The fixed 34 px voice strip preserved stable pads of 101.9/101.9/104.8/172.3 px at 640/740/800/1024 × 360 through short/long transcripts, execution/completion, errors and cancellation. Held-stick plus PTT preserved manual output; an intentional content-driven geometry change used the existing disengagement rule. Recorder failure/5 s timeout now returns the controller/UI to idle, and valid responses at the 6 s freshness boundary report `stale_result`.

This wave reran the changed voice/layout browser paths and the full gateway/web suite; the earlier full-browser/core/relay/Python results above remain historical. Heavy suites were serialized (Pi 42.8°C initially, 43.3°C before the final browser run, observed 51.6°C during layout, 47.2°C before gateway/web tests). Live microphone/API/aircraft work remains deferred.
