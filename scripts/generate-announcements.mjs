#!/usr/bin/env node
import {readFile, writeFile, mkdir, rename, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OUTPUT_FORMAT = 'mp3_44100_128';
const MAX_BYTES = 5 * 1024 * 1024;
const PHRASES = {
  es: {armed:'Dron armado', disarmed:'Dron desarmado', signal_lost:'Señal perdida', signal_restored:'Señal recuperada', failsafe:'Failsafe activado'},
  en: {armed:'Drone armed', disarmed:'Drone disarmed', signal_lost:'Signal lost', signal_restored:'Signal restored', failsafe:'Failsafe activated'},
};
const CLIPS = Object.entries(PHRASES).flatMap(([language, events]) => Object.entries(events).map(([event, text]) => ({language, event, text, path:`/audio/announcements/${language}/${event}.mp3`})));
const DEFAULT_OUTPUT = fileURLToPath(new URL('../web/audio/announcements/', import.meta.url));

function parse(argv) {
  const options = {generate:false, language:'all'};
  const fields = {'--voice-id':'voice', '--model-id':'model', '--language':'language', '--output-dir':'output'};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--generate') { options.generate = true; continue; }
    const field = fields[argv[i]], value = argv[++i];
    if (!field || !value || value.startsWith('--')) throw Error('invalid_argument');
    options[field] = value;
  }
  if (!['es','en','all'].includes(options.language)) throw Error('invalid_argument');
  if (options.voice && !/^[a-zA-Z0-9_-]{1,128}$/.test(options.voice)) throw Error('invalid_argument');
  if (options.model && !/^[a-zA-Z0-9_-]{1,128}$/.test(options.model)) throw Error('invalid_argument');
  return options;
}

// Validate the requested MPEG-1 Layer III / 44.1 kHz format structurally.
// Two consecutive complete frames avoid accepting JSON, ID3-only or truncated data.
// Listening and decoding remain part of the separate asset review.
function validAudio(bytes) {
  if (bytes.length > MAX_BYTES || bytes.length < 8) return false;
  let offset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6,10).some(b => b & 0x80)) return false;
    offset = 10 + bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9];
    if (bytes[5] & 0x10) offset += 10;
  }
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes.length - offset === 128 && bytes.toString('ascii', offset, offset + 3) === 'TAG') { offset += 128; break; }
    const [a,b,c] = bytes.subarray(offset,offset+3);
    // MPEG-1, Layer III, 128 kbps, 44.1 kHz; padding may vary by frame.
    if (a !== 0xff || (b & 0xfe) !== 0xfa || (c & 0xfc) !== 0x90) return false;
    const length = 417 + ((c >> 1) & 1);
    if (offset + length > bytes.length) return false;
    offset += length;
    frames++;
  }
  return frames >= 2 && offset === bytes.length;
}
async function existsValid(path) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!validAudio(bytes)) throw Error('invalid_existing_audio');
  return true;
}
async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), {recursive:true});
  const temporary = `${path}.${process.pid}.tmp`;
  try { await writeFile(temporary, bytes, {flag:'wx'}); await rename(temporary,path); }
  finally { await rm(temporary,{force:true}); }
}
async function manifestFor(root) {
  const clips = [];
  for (const clip of CLIPS) clips.push({...clip, available:await existsValid(join(root,clip.language,`${clip.event}.mp3`))});
  return {version:1, provider:'elevenlabs', outputFormat:OUTPUT_FORMAT, available:clips.every(clip=>clip.available), clips};
}

export async function run({argv = [], env = process.env, fetchImpl = (...args) => globalThis.fetch(...args), outputRoot, log = line => console.log(line)} = {}) {
  const options = parse(argv);
  const root = outputRoot ?? (options.output ? resolve(options.output) : DEFAULT_OUTPUT);
  const selected = CLIPS.filter(clip => options.language === 'all' || clip.language === options.language);
  if (!options.generate) {
    log('Dry run: no provider requests or file writes. Select a voice/model and pass --generate to create missing clips.');
    for (const clip of selected) {
      const present = await existsValid(join(root,clip.language,`${clip.event}.mp3`));
      log(`${present ? 'reuse' : 'pending'} ${clip.path}: ${clip.text}`);
    }
    return;
  }
  if (!options.voice) throw Error('missing_voice_id');
  if (!options.model) throw Error('missing_model_id');
  if (!env.ELEVENLABS_API_KEY) throw Error('missing_api_key');
  // Validate ALL existing files before the first potentially billable request.
  await manifestFor(root);
  for (const clip of selected) {
    const path = join(root,clip.language,`${clip.event}.mp3`);
    if (await existsValid(path)) { log(`reuse ${clip.path}`); continue; }
    let response;
    try {
      response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voice)}?output_format=${OUTPUT_FORMAT}`, {
        method:'POST',
        headers:{'xi-api-key':env.ELEVENLABS_API_KEY, 'Content-Type':'application/json', Accept:'audio/mpeg'},
        body:JSON.stringify({text:clip.text, model_id:options.model, ...(options.model === 'eleven_multilingual_v2' ? {} : {language_code:clip.language})}),
        signal:AbortSignal.timeout(30000),
      });
    } catch { throw Error('provider_request_failed'); }
    if (!response.ok) throw Error('provider_request_failed');
    if (!/^audio\/(mpeg|mp3)(;|$)/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > MAX_BYTES) throw Error('invalid_audio');
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw Error('provider_request_failed'); }
    if (!validAudio(bytes)) throw Error('invalid_audio');
    await atomicWrite(path,bytes);
    log(`created ${clip.path}`);
  }
  const manifest = await manifestFor(root);
  await atomicWrite(join(root,'manifest.json'), `${JSON.stringify(manifest,null,2)}\n`);
  log(manifest.available ? 'Complete asset pack generated; listen and review permitted use before committing.' : 'Partial asset pack: other language clips remain pending.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({argv:process.argv.slice(2)}).catch(error => {
    // Do not print provider bodies, network errors, request headers or credentials.
    const safe = new Set(['invalid_argument','missing_voice_id','missing_model_id','missing_api_key','invalid_existing_audio','provider_request_failed','invalid_audio']);
    console.error(`Announcement generation failed: ${safe.has(error.message) ? error.message : 'local_file_error'}`);
    process.exitCode = 1;
  });
}
