# Bilingual interface and flight announcer

## Intent and agreed behavior
Provide a small Spanish/English flight announcer and matching interface language. One language selector controls interface text and announcements. Remember the selection on that browser/device. On first visit choose Spanish for a Spanish device language, English for English or unsupported languages. Spoken command recognition continues accepting both languages independently.

## Approaches
The conversation considered prerecorded ElevenLabs clips for a fixed event vocabulary and dynamic cloud synthesis for telemetry summaries. The user selected the small flight-announcer approach. Generate five clips per language in advance and serve them with the app; routine playback requires no ElevenLabs request. Dynamic speech and a conversational copilot are deferred.

## Interface
Translate user-facing pilot/dashboard and observer text, including login, controls, telemetry, readiness/recovery messages, tooltips and accessibility labels. Apply the same language preference to the admin interface. Keep protocol identifiers, credentials and transmitted control values unchanged. Set the document language appropriately. Switching language must not reload the page, reset controls, take pilot ownership or change flight state. Keep mobile sticks and existing control buttons usable.

## Announcements
Use five event types: armed, disarmed, radio signal lost, radio signal restored, and failsafe entered. Suggested wording:

| Event | Spanish | English |
|---|---|---|
| Armed | Dron armado | Drone armed |
| Disarmed | Dron desarmado | Drone disarmed |
| Radio lost | Señal perdida | Signal lost |
| Radio restored | Señal recuperada | Signal restored |
| Failsafe | Failsafe activado | Failsafe activated |

Announcements describe the corresponding confirmed core/link state, not a requested button action or unverified physical flight outcome. Radio restoration never announces failsafe clearance. Seed initial/reconnected state silently; announce only subsequent valid transitions. Deduplicate telemetry repeats and suppress repeated/flapping alerts. Urgent loss/failsafe announcements preempt routine speech; coalesce a simultaneous RF-loss/failsafe event into the specific signal-loss announcement. Discard stale queued speech.

Provide an independent, remembered voice-announcements mute setting. Require a user gesture to enable/unlock browser audio; if blocked, leave controls functional and show concise localized feedback. Pause/discard speech while microphone capture is active; do not replay obsolete messages afterward. Language changes stop old-language playback and do not replay current state. Audio failure never delays controls or safety processing.

## Constraints and builder choices
No changes to core/CRSF, arming, safety transitions, voice-command interpretation or existing API secrets. Audio plays on the dashboard device. Generate assets through a separate setup workflow; any ElevenLabs key stays server-side or in the local generation environment, never browser JavaScript or Git. Commit generated audio only after checking permitted asset use. Prefer a consistent calm stock voice with clear Spanish and English; exact voice and generation model remain choices to audition before paid generation. No stronger local hardware is proposed.

## Validation and limits
Verify language fallback/persistence and translated static/dynamic/accessibility text; event deduplication/priority, silent startup/reconnect, mute, language switching and microphone interaction. Exercise mobile layout and blocked/failed audio behavior. Use fake telemetry and audio fixtures; never arm or send aircraft commands for these checks. Actual voice quality, mobile audio unlock and speaker audibility require listening/device checks. Implementation and generation follow design approval.
