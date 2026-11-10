# Bilingual Voice Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate Spanish and English push-to-talk commands as bounded timed drone movements, executing after recognition without confirmation.

**Architecture:** An authenticated HTTP upload passes a bounded recording through transcription and Decisions. A pure browser scheduler overlays one maneuver on the existing manual command, while the existing 50 Hz WebSocket path and crsf-core retain control and safety responsibilities. Begin with dry-run output; enable actual maneuver output only through server configuration and calibrated presets.

**Tech Stack:** Node.js >=22, native fetch/FormData/Blob, existing ws, plain browser ES modules, MediaRecorder, node:test, existing browser E2E harness. No new production dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-voice-commands-design.md` (user approved in conversation, 2026-11-10).

## Global Constraints

- Push to talk; Spanish and English; execute after transcription and validation without separate confirmation.
- One command per utterance; no recording while processing/executing; no maneuver queue.
- Arming, throttle, altitude changes, flight mode changes, landing, turtle mode, and failsafe clearing remain manual.
- Normal flight mode only for the demo. Neutral is an input value, not proof of stopping or holding position.
- Manual input cancels pending recognition and active maneuvers before its command is applied.
- API credentials stay on the server. No audio is persisted by this application by default.
- Preserve existing 50 Hz output, pilot ownership, dead-man and core safety rules. No core or relay protocol changes.
- First version supports the gateway origin, including an existing HTTP tunnel to that origin; `?room=` relay voice is explicitly unavailable.
- Use an isolated feature branch at execution time; preserve the pre-existing untracked deploy files. No implementation or deployment is part of this planning task.

## Review Focus

- Permission resolving after a released/canceled press must never start recording: Task 4.
- A second tab signed in as the same user must not impersonate the active pilot: Task 3.
- Browser suspension or a delayed timer must not extend a maneuver on resume: Tasks 1 and 5.
- A held manual key at recognition completion must prevent voice execution even when the ramp has not advanced: Task 5.
- MediaRecorder codec/container differences must yield an explicit unsupported message rather than malformed uploads: Tasks 2 and 4.

## Fixed interfaces and planning decisions

These defaults are engineering choices, not measured aircraft performance.

- Direction enum: `forward|backward|left|right|turn_left|turn_right`. Tier: `short|medium`.
- Classification enum: twelve `<direction>_<tier>` strings plus `repeat_short|none`. Plain direction selects short. Meter requests, compound commands, negation, ambiguity, empty speech, and unsupported actions select none. Repeat context is resolved locally only after successful completion.
- `Command = {roll,pitch,yaw,throttle,mode}` uses existing per-mille values. Pitch forward is positive per existing keyboard convention; verify all signs props-off. Defaults: short 250 ms, medium 500 ms, strength 50 per mille; hard maxima: 1000 ms and 100 per mille. Presets do not assert travel distance.
- Configuration: `voice: null` disables feature. Enabled object: `{execution:'dry-run'|'enabled', shortMs:250, mediumMs:500, strength:50}`. Default to dry-run when enabling. Validate positive finite integers within hard caps, short <= medium; never raise these limits from model output. API key only in `OPENAI_API_KEY`.
- Recording limit 5 seconds, upload 512 KiB, upload deadline 6 seconds, processing deadline 5 seconds, browser result lifetime 6 seconds from release, status freshness 500 ms. Reject overlong recordings rather than submit a truncated command. Bound transcript to 1000 characters. These voice deadlines are distinct from the existing 200 ms control-packet age check.
- PTT: `KeyV` and held microphone button; `KeyC` and cancel button cancel voice only. Existing Esc/Space/failsafe controls keep their meanings. Ignore PTT shortcuts in inputs or with modifiers. Cancel pending voice on every deliberate manual flight/control input.
- Browser request headers: `X-Voice-Request` (UUID), `X-Voice-Session` (welcome session), `X-Voice-Capability` (random server token tied to that exact WebSocket client). Raw audio body with supported Content-Type, not base64 JSON.
- `GET /voice/config` returns nonsecret config and limits to signed-in users. `POST /voice/command` returns `{requestId,session,choice,transcript,timing:{transcriptionMs,decisionMs}}`. No numeric movement parameters are returned by the model. Error responses contain fixed codes, never provider raw bodies.
- Send an additive `voice_ready {session,capability}` event directly to an eligible local pilot after seat promotion; never broadcast or log the token. Server authorizes cookie username AND exact active client/session/capability at start and completion. Invalidate capability on detachment, loss, transfer, and fresh promotion. Keep canceled request IDs consumed for the life of that capability.
- During dry-run, allow requests while disarmed for recognition practice, but never arm or generate a maneuver overlay. Live execution requires armed Normal mode, active/engaged pilot, fresh status, connected/focused/visible page, neutral manual horizontal/yaw input, and no held manual flight controls.

## File map

- New `web/js/voicemaneuver.js`: pure finite catalog, presets, repeat context and deadline scheduler.
- New `web/js/voicecapture.js`: microphone permission, PTT recording and HTTP cancellation lifecycle.
- New `web/js/voicecontroller.js`: request identity/generation, UI-facing state, scheduler/capture coordination.
- New `gateway/src/voiceprovider.js`: bounded transcription and Decisions HTTP calls with injectable fetch.
- New `gateway/src/voice.js`: authenticated bounded HTTP routes.
- Modify `gateway/src/config.js`, `hub.js`, `server.js`: settings, per-client capability, route lifecycle and injected test provider.
- Modify `web/js/app.js`, `web/index.html`, `web/css/app.css`: minimal Spanish controls, feedback and manual cancellation hooks.
- Matching tests in `web/test/voice*.test.js`, `gateway/test/voice*.test.js`, existing config/hub/server tests; `gateway/e2e/voice.e2e.js`.
- Deployment/docs: `deploy/gcs-gateway.service`, `deploy/gateway.json`, README, architecture, setup and bench procedure below.

### Task 1: Pure bounded maneuver scheduler

**Files:** Create `web/js/voicemaneuver.js`, `web/test/voicemaneuver.test.js`.

**Interfaces:** Export `CHOICES`, `validatePresets(presets)`, and `VoiceManeuver`. Constructor `{presets,now}`; `start(choice)` returns boolean; `apply(manualCommand)` returns a fresh Command; `cancel({clearRepeat=true}={})`; `reset()`; getters `busy`, `lastCompletedDirection`. Inject monotonic now; expiry advances before output or new start.

- [ ] Write tests: `bounded_forward_preserves_throttle` asserts positive pitch <=50, unchanged throttle/mode and zero roll/yaw during a short forward maneuver, then neutral maneuver axes exactly at 250 ms; `late_tick_expires` jumps clock beyond 1000 ms and gets neutral axes; `repeat_only_after_completion` rejects repeat initially/canceled, allows it after completed movement; `no_queue_or_mutation` rejects a second start and preserves input object; `preset_caps` rejects NaN, negative and over-cap values. `idle_passes_manual` returns the ordinary manual values when idle. Implement these as node:test tests with strict assertions and fake time.
- [ ] Run `node --test web/test/voicemaneuver.test.js`; confirm failures from missing behavior.
- [ ] Implement the exact catalog and scheduler. Enforce caps independently of gateway settings, resolve repeat only locally, and update completion context only on natural expiry. Do not neutralize throttle on expiry/cancel.
- [ ] Repeat the focused command; expect all tests pass.
- [ ] Commit only the two files: `web: add bounded voice maneuver scheduler`.

### Task 2: OpenAI adapter and bilingual evaluation fixtures

**Files:** Create `gateway/src/voiceprovider.js`, `gateway/test/voiceprovider.test.js`, `gateway/test/fixtures/voice-utterances.json`, `tools/evaluate-voice.mjs`.

**Interfaces:** `createVoiceProvider({apiKey,fetchImpl=fetch,now})` returns `{recognize({audio,mime,signal}): Promise<{transcript,choice,timing}>}`. `audio` is Uint8Array. Export `buildDecisionRequest(transcript)` for offline contract checks. No retry or file persistence.

- [ ] Tests with fake fetch assert transcription receives matching filename/MIME and bilingual context, blank/overlong transcripts do not produce movement, Decisions receives exactly the fixed choice catalog, unknown/refusal/malformed/nonfinite outputs produce none or typed failure, upstream errors omit secrets, and caller abort stops both stages. Test WebM/Opus and MP4 containers explicitly.
- [ ] Run `node --test gateway/test/voiceprovider.test.js`; confirm RED.
- [ ] Implement native fetch to `/v1/audio/transcriptions` using `gpt-transcribe`, then `/v1/decisions` using `gpt-6-luna` with a single named choice question. Fetch current official schemas before coding; handle documented refusals and validate the selected enum. Use fixed server instructions identifying transcript as untrusted speech, with Spanish/English/mixed examples, none cases and qualitative tiers. Supply only transcript, not previous conversational instructions.
- [ ] Add labeled bilingual/mixed fixtures including negation, hypothetical speech, meters, multi-action, silence and prompt injection. The opt-in evaluation script imports the same builder/provider and reports expected vs selected choices with nonzero exit on mismatch. Mock tests verify serialization/validation; they do not claim model accuracy. Live evaluation requires a configured key and incurs API usage.
- [ ] Run the focused tests; expect PASS. Commit: `gateway: interpret bilingual voice commands with OpenAI`.

### Task 3: Gateway authorization and bounded upload

**Files:** Create `gateway/src/voice.js`, `gateway/test/voice.test.js`; modify config/hub/server and their tests.

**Interfaces:** `voiceRoutes({cfg,hub,sessions,provider,now}) -> async(req,res)=>boolean` plus `.close()` aborting all work. `ControlHub.authorizeVoice({user,session,capability}) -> client|null`; lifecycle emits direct `voice_ready`. `startGateway(cfg,{core,voiceProvider})` accepts injectable provider without changing existing callers.

- [ ] Write tests asserting 401 missing cookie, 403 foreign/missing Origin, 403 observer/queued/other-tab/wrong-capability, 409 invalidated session or duplicate/busy request, 413 streamed body exceeding cap, 415 unsupported MIME, 408 upload timeout, 504 processing deadline, and a successful bounded reply. Test ownership/cookie expiry changing during recognition, aborted upload freeing slots, provider failure not leaking token/key, and normal ctl processing while provider promise is unresolved. Disabled route must make no provider call.
- [ ] Run `node --test gateway/test/voice.test.js gateway/test/hub.test.js gateway/test/config.test.js gateway/test/server.test.js`; confirm RED for new cases.
- [ ] Implement config validation and routes before static fallback, requiring exact Origin scheme/host and no CORS. Normalize allowed MIME parameters and permit WebM/Opus and MP4 with matching filenames; reject other media. Enforce raw byte caps while streaming, finite header validation, per-client one-in-flight and one admitted request/second, bounded consumed-ID storage (128 requests per capability, then require new capability while idle), and one global provider pipeline. Recheck identity at response. In live mode require fresh armed Normal status; dry-run permits disarmed but still only the seated pilot. No audio frames through the 4096-byte WebSocket path.
- [ ] Wire capability issuance on pilot promotion (including takeover), invalidation and shutdown abort. Read existing actual status fields/flight-mode telemetry and assert them in tests; stale/unknown mode rejects live execution. Ensure secrets are absent from logs/config responses.
- [ ] Run focused tests; expect PASS. Commit: `gateway: authorize and bound voice requests`.

### Task 4: Push-to-talk capture and cancellable request lifecycle

**Files:** Create `web/js/voicecapture.js`, `voicecontroller.js`, and corresponding `web/test/*.test.js`.

**Interfaces:** `VoiceCapture({mediaDevices,MediaRecorderClass,now,onState})` exposes `prepare()`, `press()`, `release():Promise<{audio,mime}|null>`, `cancel()`, `dispose()`. `VoiceController({capture,maneuver,fetchImpl,now,onState})` exposes `configure(config)`, `setSession({session,capability})`, `press()`, `release()`, `cancel(reason,{clearRepeat=true}={})`, `reset()`, `apply(manual,context)`, getter `busy`. Context carries current role, engagement, visibility/focus/connection, armed/Normal status freshness and held manual-input state. Snapshot state carries transcript, choice, phase and fixed error codes.

- [ ] Tests use recorder/getUserMedia/fetch fakes: permission resolves after release -> zero recording/upload; canceled/hidden capture -> zero submission; overlong or oversized recording -> discard; unsupported codec -> explicit error; key repeat -> one capture; busy press -> ignored; request abort and late/duplicate result -> no start; HTTP error -> idle/error; result at >=6000 ms -> stale; dry-run -> feedback without start. Assert tracks are stopped after capture/cancellation and partial chunks cleared; prepare acquires permission before flight and releases tracks.
- [ ] Run `node --test web/test/voicecapture.test.js web/test/voicecontroller.test.js`; confirm RED.
- [ ] Implement codec selection with `isTypeSupported`, generation-based capture invalidation, raw binary upload and AbortController. Prefer audio/webm;codecs=opus, fallback audio/mp4; disable voice when neither is supported. release submits only if recording began for that still-current press. Never keep recording during processing/execution. Every asynchronous callback rechecks generation and session.
- [ ] Implement release -> processing -> immediate execution/dry-run with no confirmation. Browser result validation checks exact request/session IDs, enum membership, local lifetime and context; local scheduler is authoritative for repeats. Use performance.now for browser deadlines, not server wall time.
- [ ] Run focused tests; expect PASS. Commit: `web: add cancellable bilingual push to talk`.

### Task 5: Integrate voice overlay, feedback and manual takeover

**Files:** Modify `web/js/app.js`, `web/index.html`, `web/css/app.css`; create `gateway/e2e/voice.e2e.js`; extend `gateway/e2e/helpers.js` only for fake media/provider injection.

**Interfaces:** Reuse Task 4 controller; app calls `apply(baseCommand,context)` each existing 50 Hz tick, before `controlMessage`, never from an async recognition callback. Add `btn-voice-prepare`, `btn-voice-ptt`, `btn-voice-cancel`, `voice-state`, `voice-transcript`, `voice-action` DOM IDs. Add Spanish copy and visible dry-run badge.

- [ ] E2E tests with fake provider/media assert hold/release causes exactly one action without confirmation; disarmed dry-run never modifies ctl values; delayed provider cannot stop normal ctl; manual key/pointer input cancels before manual output; a held key with still-zero ramp prevents start; duration expires on clock jump; throttle survives completion/cancel; blur/disarm/failsafe/lost ownership/mode change clears pending execution and repeat history; relay page shows unsupported voice. Retain existing keyboard and pilot suites to catch shortcut and arming regressions.
- [ ] Run `node --test --test-concurrency=1 gateway/e2e/voice.e2e.js`; confirm RED with existing harness prerequisites installed.
- [ ] Add held V/microphone input handlers and local C/cancel handlers. Pointercancel/lost capture discards recording rather than submitting. Wire manual cancellation to physical intent, not sampled command differences (ramps and UI readouts are not user intent). Ignore PTT shortcuts while typing; do not replace existing flight handlers. Cancel on every disarm/failsafe/mode/speed/turtle/manual throttle action and on existing disengagement/reset paths. Apply overlay only after dead-man/current context checks and preserve lockedCommand in failsafe.
- [ ] Load config and voice_ready for gateway-origin pilot only. Acquire permission via explicit preflight button while disarmed. Render transcript with textContent, never HTML; feedback shows no-action/error, timed direction/tier, completion/cancel. Do not claim distance or hovering. Keep manual controls usable during all voice phases.
- [ ] Run `npm --prefix gateway test` and `npm --prefix gateway run e2e`; expect PASS, recording any environment-dependent skips explicitly. Commit: `web: integrate immediate timed voice maneuvers`.

### Task 6: Deployment setup, calibration and full verification

**Files:** Modify `deploy/gcs-gateway.service`, `deploy/gateway.json`, `README.md`, `docs/ARCHITECTURE.md`; create `docs/setup/voice.md`, `docs/procedures/voice-demo.md`; extend `gateway/test/deploy.test.js`.

**Interfaces:** Optional `EnvironmentFile=-/etc/gcs/openai.env` in service; local voice null by default. Document root-managed credential file outside repository. Opt-in browser timestamp trace via `?measure` exposes release, recognition stages, maneuver start/end/cancel, never audio, transcript, capability or key in persistent logs.

- [ ] Add failing deployment/config checks proving voice defaults disabled, missing credentials with voice enabled yields unavailable voice rather than crashing manual control, and public config contains no credentials. Run `node --test gateway/test/deploy.test.js gateway/test/config.test.js`; confirm RED.
- [ ] Implement service/config/docs and trace hooks in controller/app. Document microphone secure-context/certificate requirements, supported browsers/codecs, internet dependency, API setup, disabled/ dry-run/live configuration, bounds, local cancellation, and relay exclusion. Set up key only during an explicitly authorized implementation/live validation session, never in committed files.
- [ ] Run focused tests then `npm --prefix gateway test`, `npm --prefix relay test`, and `npm --prefix gateway run e2e`; no C source changes means C suites need not be rerun unless integration exposes a core issue. Run `git diff --check`. Expect passing checks; report skipped media/hardware checks accurately.
- [ ] Record a dry-run bilingual evaluation with real recordings on PC and Android; permission denial, network outage and provider latency must produce no movement. Run the opt-in live model fixture evaluation and retain aggregate results. A mocked test pass is not evidence of speech recognition quality.
- [ ] Follow existing props-off procedure to verify output signs, amplitude/duration caps, throttle preservation, manual cancellation and stale-result discard. Then supervised Normal-mode calibration in clear space, one short maneuver at a time. Record actual observed movement and tune within hard bounds; no precision claims. Hardware/live flight work is deferred if the operator or aircraft is unavailable; never mark it passed from software tests.
- [ ] Commit focused documentation/deployment changes: `docs: add voice demo setup and calibration procedure`. Review whole branch and prepare PR using repository process; do not merge or deploy implicitly.

## Sources checked during planning (2026-11-10)

- https://developers.openai.com/api/docs/guides/speech-to-text — current file transcription workflow and model; recheck before implementation.
- https://developers.openai.com/api/docs/guides/decisions — typed choice questions and response validation; recheck before implementation.

## Plan self-review

Design requirements map to Tasks 1–6: bounded controls/repeats (1), bilingual classification (2), authentication/limits (3), recording/cancellation/freshness (4), immediate application/manual takeover/UI (5), dry-run evidence/calibration/setup (6). Interface names and response envelopes are consistent across tasks. All five Review Focus cases have explicit owning tests. Hardware measurements and live API quality remain rollout evidence, not prerequisites silently satisfied by mocks.
