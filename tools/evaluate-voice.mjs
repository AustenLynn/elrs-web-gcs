#!/usr/bin/env node
// Text-classification evaluation only. This does not measure microphone/ASR accuracy.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createVoiceProvider, buildDecisionRequest } from '../gateway/src/voiceprovider.js';

export async function evaluateVoice({ fixtures, apiKey, fetchImpl = fetch, output = console.log }) {
  let mismatches = 0;
  for (const fixture of fixtures) {
    // Feed the labeled transcript through the same provider validation and Decisions builder.
    // The transcription stage is deliberately local; only Decisions incurs API usage.
    buildDecisionRequest(fixture.transcript);
    const provider = createVoiceProvider({ apiKey, fetchImpl: (url, options) => url.endsWith('/audio/transcriptions')
      ? Promise.resolve({ ok: true, json: async () => ({ text: fixture.transcript }) })
      : fetchImpl(url, options) });
    const result = await provider.recognize({ audio: new Uint8Array([0]), mime: 'audio/webm', signal: AbortSignal.timeout(5000) });
    const matches = result.choice === fixture.expected;
    if (!matches) mismatches++;
    output(JSON.stringify({ language: fixture.language, transcript: fixture.transcript, expected: fixture.expected, selected: result.choice, matches }));
  }
  return mismatches;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--live') || !process.env.OPENAI_API_KEY) {
    console.error('Opt-in text evaluation: OPENAI_API_KEY=... node tools/evaluate-voice.mjs --live (incurs Decisions API usage; transcription is simulated).');
    process.exitCode = 2;
  } else {
    try {
      const fixtures = JSON.parse(await readFile(new URL('../gateway/test/fixtures/voice-utterances.json', import.meta.url), 'utf8'));
      const mismatches = await evaluateVoice({ fixtures, apiKey: process.env.OPENAI_API_KEY });
      console.log(JSON.stringify({ total: fixtures.length, mismatches }));
      process.exitCode = mismatches ? 1 : 0;
    } catch {
      console.error('Evaluation failed; upstream details omitted.');
      process.exitCode = 1;
    }
  }
}
