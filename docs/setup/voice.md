# Gateway-origin bilingual voice demo

Voice is disabled in the shipped `deploy/gateway.json` (`"voice": null`). This is an experimental timed-input demo, with real microphone recognition and aircraft calibration still pending operator validation. Start with simulation and follow [the evaluation and calibration procedure](../procedures/voice-demo.md).

## Connection and microphone

Use the authenticated gateway pilot page over HTTPS with a certificate trusted by the PC/Android device. A certificate warning bypass alone may not make microphone access available; install the local CA correctly or use a trusted HTTPS origin. Plain HTTP on a LAN IP is not a microphone secure context. Localhost can be used for development. The page needs `navigator.mediaDevices.getUserMedia` and `MediaRecorder.isTypeSupported`.

The capture implementation chooses `audio/webm;codecs=opus`, otherwise `audio/mp4`; the gateway also accepts their supported normalized MIME forms. Desktop/Android browser support must be checked on the actual device: a browser name alone does not guarantee these codecs. Unsupported media or denied permission gives no maneuver. Automated Firefox tests use substituted media and do not certify actual microphone behavior. Keep the page visible and focused. Locking/suspending the phone cancels pending/executing work.

Voice works at the gateway origin, including the existing tunnel to that origin. `?room=` relay and observer pages cannot use voice. Do not route the audio endpoint through the relay. Local control remains on the existing WebSocket path; voice requires outgoing internet HTTPS from the gateway to `api.openai.com`.

## Server settings and credential

Node.js 22 or newer and the existing gateway dependencies are sufficient. In the deployed `/etc/gcs/gateway.json`, replace only the voice property for simulation:

```json
"voice": { "execution": "dry-run", "shortMs": 250, "mediumMs": 500, "strength": 50 }
```

An empty voice object also selects those simulation defaults. `"execution": "enabled"` permits real timed overlays only after recognition, provided all readiness checks pass. Only enable it after the props-off checks below. Set `"voice": null` to disable again. Configuration changes take effect at gateway startup; they are not hot-reloaded.

The systemd unit optionally reads `/etc/gcs/openai.env`. During an explicitly authorized operator setup session, an administrator must create this file outside the checkout, owned by root with mode `0600`, containing one assignment:

```text
OPENAI_API_KEY=<operator-provided API key>
```

Use an editor or credential manager that does not echo the key into shell history, logs, screenshots or chat. Do not put it in JSON, browser storage, URLs, service command arguments, repository files or version control. Systemd reads the root-managed file before starting the service as `gcs`; do not make the file world-readable. Install the updated unit and reload systemd only in an authorized deployment session, then restart the gateway when control is safely disarmed. A restart loses the pilot session and requires reconnecting and following the existing recovery/arming procedure. This guide does not itself authorize a service restart or deployment.

For a local development process, provide `OPENAI_API_KEY` through its environment using your credential tooling, then run `node gateway/src/main.js /path/to/gateway.json`. The key must permit the implementation's transcription and Decisions calls (`gpt-transcribe` at `/v1/audio/transcriptions`, then `gpt-6-luna` at `/v1/decisions`); account/model availability must be checked before evaluation. Requests incur API usage, including in simulation. Missing credentials preserve gateway startup and manual control; a submitted voice request reports `provider_unconfigured`. Public `/voice/config` contains only execution, presets and limits, never the key or pilot capability.

## Controls and bounds

While disarmed, choose **Micrófono** (prepare while disarmed) and grant permission. With the pilot engaged, tap **Hablar**, speak one short command, then tap **Enviar** to submit. Releasing the first tap keeps recording. On desktop, hold **V** and release to submit. Button and V recordings have separate ownership: the other input cannot submit them, and busy activations are ignored. **C**, the cancel button or deliberate manual control cancels locally immediately. V/C shortcuts ignore text inputs and modifiers. Cancel does not promise that already-started provider billing stops. No second confirmation is shown: enabled mode executes a validated result on the next existing control tick. Simulation shows the result and never overlays movement; practice while disarmed.

Examples: `adelante`, `move right a little`, `gira izquierda moderado`, `forward un poco`. Plain directions select short; qualitative medium requests select medium. `otra vez`/`repeat` repeats the last successfully completed direction at short duration. Cancellation clears that history. Arming, throttle/altitude, modes, landing, turtle and failsafe clearing stay manual. Negation, distances/meters, numeric durations, compound actions, hypothetical speech and ambiguity should produce no action; validate this empirically before any live demo.

Defaults are 250/500 ms and strength 50 per mille. Hard bounds are positive integer durations up to 1000 ms and strength up to 100 per mille, with short ≤ medium. They are engineering input bounds, not measured distances. Horizontal/yaw overlays preserve manual throttle. Normal mode plus fresh armed status and actual Normal telemetry, exact active pilot ownership, engagement, focus/visibility/connection and neutral horizontal/yaw controls with no held manual controls are required for live execution. Keep manual control ready throughout.

Recordings must be shorter than 5 s and ≤512 KiB; overlong speech is discarded rather than truncated. Recorder errors and the 5 s capture limit return immediately to idle with `capture_failed` or `recording_timeout`, so a new tap or V press can start; timeout never submits automatically. Upload deadline is 6 s, provider processing 5 s, result lifetime 6 s from release, and status freshness 500 ms. Late, canceled, stale or invalid results cannot start motion. These differ from the existing 200 ms control-packet-age limit. No command queue exists. Neutral input does not prove stopping, hovering or position hold.

## Optional timing trace

Add `?measure` (or `&measure`) before loading the page. `window.voiceLatency.snapshot()` returns at most 512 memory-only timing rows; `window.voiceLatency.clear()` clears them. Reload clears them too. Save manually only if required for a bench record. Without the query parameter, no voice trace is constructed or exposed.

Events are release, recognition_start, transcription, decision, recognition_end, maneuver_start, maneuver_end and cancel. `atMs` is browser monotonic time. Transcription/decision rows are recorded when a validated response arrives; `durationMs` is the server-reported duration, not a browser timestamp for the remote stage boundary. Recognition duration includes transport. Maneuver end records when the control loop first observes completion, not a measured aircraft stop. Cancel records a busy operation being invalidated. Rows contain no audio, transcript, request ID, session, capability or API key. They are never automatically persisted, logged or uploaded. Existing `controlLatency` measurements remain separate; neither measures RF or aircraft response.
