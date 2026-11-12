# Bilingual flight announcements

The dashboard plays five prerecorded MP3 clips in each language. Normal playback
uses local static files and makes no ElevenLabs request. Generation is separate
from the gateway, browser, control loop and aircraft. This checkout contains an
unavailable manifest with ten pending clips; no audio has been generated yet, so the
pilot page reports announcements as unavailable until an approved pack is committed.
The gateway serves `.mp3` as `audio/mpeg` (with `nosniff`); deploying that MIME map
needs a gateway restart, done only under the usual disarmed deployment checks.

## Generate locally

Use Node 20+ from the repository root. Preview the complete fixed vocabulary with
no credentials, network calls or file writes:

```sh
node scripts/generate-announcements.mjs
```

Choose a calm stock voice after auditioning Spanish and English. Set
`ELEVENLABS_API_KEY` in the local generation process environment using your usual
secret manager or an interactive shell prompt. It belongs only in that process,
never in browser JavaScript, a tracked `.env` file, a command argument or Git.
The script does not discover, read or modify any existing application secret.
No browser or running gateway needs this key.

Generation requires explicit voice/model selection and `--generate`:

```sh
node scripts/generate-announcements.mjs --generate \
  --voice-id YOUR_STOCK_VOICE_ID --model-id eleven_flash_v2_5
```

`--language es`, `--language en`, or `--language all` (default) selects the pack.
`--output-dir /absolute/output/directory` changes the destination from
`web/audio/announcements/`. Keep one invocation running at a time. Fixed phrases
and ordering are deterministic; provider speech synthesis itself is not guaranteed
to produce identical bytes each time.

The generator reuses validated existing clips, including files written before a
previous interrupted run. It does not retry paid requests or overwrite valid
clips. Corrupt existing audio aborts before a provider call; inspect and move it
aside explicitly before retrying. To change voices, use a separate output
folder, audition the complete pack, then replace the approved assets together.
Do not assume that changing `--voice-id` regenerates existing files.

## API and asset review

The [official create-speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
uses `POST /v1/text-to-speech/{voice_id}`, `xi-api-key`, JSON `text` and `model_id`,
and `output_format=mp3_44100_128`. The script supplies `language_code` (`es`/`en`)
for models such as `eleven_flash_v2_5`. For `eleven_multilingual_v2` it omits that
unsupported field; that model infers the language from the fixed phrase.
There is no implicit model or voice selection. API details checked 2026-11-12.

The [official TTS ownership FAQ](https://elevenlabs.io/docs/overview/capabilities/text-to-speech)
says users own generated output and commercial use requires a paid plan and
rights to the input content. Confirm the selected voice and account permit this
project's intended distribution before committing audio. No generated asset is
included here and no paid request has been made for this implementation.

Before committing generated assets, listen to all ten clips for language,
pronunciation, consistent volume, calm delivery and abrupt clipping. The script
checks response type, size and complete MPEG audio-frame headers; it cannot
verify audible speech or voice quality. Browser playback also checks actual
asset availability. File validation and the manifest are not proof of an
acceptable recording or a cleared usage license.

## Manifest and browser contract

`manifest.json` contains `version`, `provider`, `outputFormat`, overall
`available`, and ten `clips` with `language`, `event`, `text`, browser `path` and
individual `available`. Overall availability becomes true only when all ten
files exist and pass validation. A single-language run records a partial pack.
The checked-in manifest sets every availability flag to false. It contains no
placeholder audio or alternate speech provider. Integration can inspect the
selected language's five entries to explain missing assets before enabling.

`FlightAnnouncer` observes confirmed snapshots:

```js
announcer.update({connected, coreFresh, state, reason, radio});
```

`state` is `ARMED`, `DISARMED` or `FAILSAFE`; `reason` uses the unchanged core
identifier; `radio` is `up`, `down` or `unknown`. Disconnected/stale core resets
baselines and stops playback. Unknown state/radio resets its respective baseline.
Initial/reconnected snapshots are silent. Radio restoration describes only the
link and never asserts failsafe clearance. `reset()` discards playback and seeds
both baselines anew without changing the mute preference.

`enable()` must run directly in a user gesture. It silently probes the real
`armed.mp3` in the selected language on a reusable audio element with
`muted = true`, then pauses it before restoring `muted = false`. Silence does
not depend on JavaScript volume control, which some mobile browsers ignore.
Missing/invalid assets return false with `audio_unavailable`; browser policy
rejection returns false with `audio_blocked` and `blocked: true`. The callback
always receives `{enabled, blocked, error}`, with `error: null` on success.
Playback errors cannot block controls, and obsolete play-promise completions
cannot reenable or interrupt newer playback.

Announcements start disabled on every page load until the audio gesture.
`gcs.announcements` stores `true`/`false`; `preferred` exposes the remembered
choice without claiming audio has been unlocked. Corrupt or inaccessible storage
keeps the controller usable. `mute()` stops playback and remembers false.
`setLanguage('es'|'en')` stops the old clip without replaying the current state.
`setRecording(true)` discards speech while microphone capture is active; clearing
it never replays suppressed events. All snapshots still update silent baselines
while muted/recording. Each event has a 3-second cooldown; urgent loss/failsafe
preempts routine audio, and no event is queued for later playback.

## Pilot page integration

`web/js/app.js` owns one announcer. Beside the header state pill sits a compact
**Avisos / Alerts** button (`#btn-announce`, `aria-pressed`, `data-state` =
`off|on|blocked|unavailable`, details in its title and the `#announce-status` live region).
It has a fixed size no taller than its header row, and the portrait footer buttons have a
fixed height, so switching
language or alert state never moves the stick pads (`gateway/e2e/announcer.e2e.js` checks
this with a held stick at the supported phone sizes; the pad-layout safety is unchanged).
The button blurs after each tap and is not a flight key target: Space still disarms.

- **Tap**: on → `mute()`; off → `enable()` inside the tap. At load the page reads
  `manifest.json`; when the selected language's five clips are not all available it reports
  `audio_unavailable` (button "Sin audio / No audio", via the engine's `fail()`) without
  requesting any clip. Without a
  manifest it still probes, so a missing clip gives the same honest result.
- **Feed**: `update()` runs on every core status and every rendered frame (repeats are no-ops),
  inside `try/catch`, never in the 50 Hz control loop. `connected` is the WebSocket,
  `coreFresh` the core segment, `state` the core state with `HOLD`/`LANDING` counted as
  `ARMED` (the core keeps ARM high in both), `reason` the core reason.
- **Radio**: `up` when the drone segment is ok/warn. `down` only with evidence: the TX module
  is talking (TX segment ok) and link telemetry was received but stopped or reports no uplink,
  or the core is in FAILSAFE for `rf_lost`. Otherwise `unknown`. For 2.5 s after each
  connection the radio is `unknown`, because the gateway replays its last link telemetry to a
  new connection and that looks fresh for 2 s.
- **Reset**: the WebSocket closing calls `reset()`; the next statuses seed silently.
- **Microphone**: `setRecording()` follows the voice controller's `recording` phase.
- **Language**: a change calls `setLanguage()` (stops the old clip, no replay). If the new
  language has no clips while enabled, the announcer reports `audio_unavailable`.

## Validation

```sh
node --test web/test/announcer.test.js scripts/test/generate-announcements.test.mjs
node --check web/js/announcer.js
node --check scripts/generate-announcements.mjs
```

Browser checks (fake gateway socket, fake `Audio`, a test-only manifest; no core, no clips):

```sh
node --test --test-concurrency=1 gateway/e2e/announcer.e2e.js
```

Tests inject audio and fake HTTP responses and never send aircraft commands or
provider requests. Real voice selection, generated-pack listening, mobile audio
unlock, speaker audibility and recording overlap still need device checks after
approved assets exist.
