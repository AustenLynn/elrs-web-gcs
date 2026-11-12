# Bilingual Flight Announcer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bilingual dashboard and a small prerecorded flight announcer.
**Architecture:** Browser-owned language catalog and persisted preferences; a separate event-driven audio controller consumes confirmed telemetry. ElevenLabs generates a fixed bilingual asset pack through a local script, never in the flight/control path.
**Tech Stack:** Existing browser ES modules, Node built-in tests, existing browser E2E harness; no new runtime dependencies.
**Spec:** docs/superpowers/specs/2026-11-12-bilingual-flight-announcer-design.md

## Global Constraints
- One language selector controls interface text and announcements. Remember the selection on that browser/device.
- On first visit choose Spanish for a Spanish device language, English for English or unsupported languages.
- Spoken command recognition continues accepting both languages independently.
- No changes to core/CRSF, arming, safety transitions, voice-command interpretation or existing API secrets.
- Audio failure never delays controls or safety processing.
- Any ElevenLabs key stays server-side or in the local generation environment, never browser JavaScript or Git.
- Generate assets only after checking permitted asset use; do not fabricate or silently substitute another TTS provider.

## Review Focus
- Storage unavailable/corrupt: usable device-language default, no boot exception (Task1).
- Live language switching: active controls/session remain intact, current messages translate without cancelling speech recognition (Task1/3).
- Repeated/flapping/reconnected telemetry: bounded announcements and silent initialization, no false recovered-ready claim (Task2/3).
- Rejected playback and recording overlap: no unhandled rejection, stale announcement or lost manual controls (Task2/3).
- Bilingual longer labels and selector: mobile control geometry preserved and admin accessibility translated (Task3).

### Task 1: Interface localization
**Files:** Create `web/js/i18n.js`, `web/test/i18n.test.js`; modify `web/index.html`, `web/admin.html`, `web/watch.html`, `web/js/app.js`, `web/js/view.js`, `web/js/protocol.js`, `web/js/admin.js`, `web/js/adminview.js`, `web/js/watch.js`, `web/js/whep.js`, related visible UI helpers and `web/css/app.css` only as needed.
**Interfaces:** `getLanguage(): 'es'|'en'`, `setLanguage(language): void`, `onLanguageChange(callback): unsubscribe`, `t(key, vars={}): string`, `initLanguageUI(document): void`. Language storage key `gcs.language`. Text catalogs keyed explicitly, no mutation observer or automatic replacement of user-generated content. Keep helper test defaults deterministic by allowing explicit language or keeping import initialization safe outside browser; existing Spanish helper tests can explicitly set Spanish.
- [ ] Write failing localization tests for Spanish/English/device fallback, invalid or throwing storage and interpolation; execute `node --test web/test/i18n.test.js` and save RED.
- [ ] Implement catalog/preferences and accessible language controls for pilot/observer/admin/watch. Translate static/dynamic labels, errors, recovery instructions, titles and aria labels; preserve usernames/transcripts/protocol values. Language switch rerenders current display without taking/releasing control or reloading.
- [ ] Test live preference change and safe formatting including usernames containing markup; run focused helper tests and full `npm --prefix gateway test` once. Do not run physical-aircraft actions or heavy E2E concurrently.
- [ ] Commit only this task's files and report commands/RED/GREEN and any uncovered strings.

### Task 2: Announcer engine and asset generation workflow
**Files:** Create `web/js/announcer.js`, `web/test/announcer.test.js`, `scripts/generate-announcements.mjs`, `scripts/test/generate-announcements.test.mjs`, `docs/setup/announcements.md`, `web/audio/announcements/manifest.json`.
**Interfaces:** `FlightAnnouncer({audioFactory, now, onState, storage})`, methods `setLanguage('es'|'en')`, `enable(): Promise<boolean>` (called on user gesture), `mute(): void`, `setRecording(boolean)`, `update({connected, coreFresh, state, reason, radio}): void` (`radio: 'up'|'down'|'unknown'`), `reset(): void`; callbacks `{enabled, blocked, error}`. Clip URLs `/audio/announcements/{es|en}/{armed|disarmed|signal_lost|signal_restored|failsafe}.mp3`. Storage `gcs.announcements`, opt-in initially. State/link input is confirmed UI telemetry, never commands.
- [ ] Write tests and establish RED for silent initial/reconnect, confirmed transitions, loss+rf_lost failsafe coalescing, urgent preemption, repeats and flapping, mute/language/recording clearing stale playback, rejected play and storage failure.
- [ ] Implement audio controller outside control path. Bound deduplication with 3s per-event cooldown; no queued stale replay. Unknown/stale core resets state baseline; unknown radio does not assert signal restored. While muted/recording update baselines but discard events.
- [ ] Build generator with explicit `--generate`, voice ID/model/language inputs, environment `ELEVENLABS_API_KEY`; default dry-run lists ten fixed phrases without network. Check existing assets to avoid repeat charges. No embedded key values/logging; configurable documented voice/model selection. Verify current official API and output reuse terms; generation remains pending if credentials or voice selection unavailable. Unit-test generator request shape/output validation with fake HTTP only.
- [ ] Execute focused tests, syntax/diff checks, commit and report. Do not edit app/index/CSS owned by Task1; no real generation/provider call or service action without controller coordination.

### Task 3: Dashboard integration and browser validation
**Files:** Modify `web/js/app.js`, `web/index.html`, `web/css/app.css`; create `gateway/e2e/announcer.e2e.js`; refine `docs/setup/announcements.md`.
**Interfaces:** Consume Task1 localization and Task2 engine exactly. Use existing `segments()` confirmed radio classification (`ok/warn`→up, `down`→down only with valid RF evidence), fresh core status and actual state. Reset on WS disconnect; recording state from VoiceController/capture lifecycle. Add localized opt-in/mute button and blocked/asset-unavailable feedback. Keep critical controls visible at supported mobile sizes.
- [ ] Write browser regressions with fake telemetry/audio for language switching and persistence, dynamic readiness/error text, no pilot/session/control change on settings, announcer enable/mute, capture suppression, silent initial/reconnect and no playback without actual event.
- [ ] Wire announcer to status/render cadence without throwing into control processing; language changes stop old-language audio. Add compact accessible announcement control without reducing existing stick geometry.
- [ ] Coordinate actual ElevenLabs asset generation only if credentials and voice are available, otherwise leave generation clearly pending and announcer honestly unavailable (no success claims from dummy audio). Never require API for normal playback.
- [ ] After read-only DISARMED preflight, run full gateway tests and focused browser suite serially; read outputs and commit. Review full branch. Merge locally and deploy only under existing authorization and disarmed checks; never push or restart core for this static feature.
