import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {run} = await import('../generate-announcements.mjs').catch(()=>({}));
function mp3(){const frame=Buffer.alloc(417);frame.set([0xff,0xfb,0x90,0x64]);return Buffer.concat([frame,frame]);}
function response(bytes=mp3(),type='audio/mpeg',status=200){return new Response(bytes,{status,headers:{'content-type':type}});}
async function setup(t){assert.equal(typeof run,'function','generator implementation is required');const dir=await mkdtemp(join(tmpdir(),'gcs-announcements-'));t.after(()=>rm(dir,{recursive:true,force:true}));const lines=[];return {dir,lines,options:{outputRoot:dir,env:{ELEVENLABS_API_KEY:'test-private-key'},log:line=>lines.push(line)}};}
const args=['--generate','--voice-id','stock-voice','--model-id','eleven_flash_v2_5'];

test('default dry-run lists ten fixed bilingual phrases without network or writes',async t=>{
  const s=await setup(t);await run({...s.options,argv:[],fetchImpl:()=>assert.fail('dry-run must not call provider')});
  assert.deepEqual(await readdir(s.dir),[]);const output=s.lines.join('\n');
  for(const phrase of ['Dron armado','Dron desarmado','Señal perdida','Señal recuperada','Failsafe activado','Drone armed','Drone disarmed','Signal lost','Signal restored','Failsafe activated'])assert.ok(output.includes(phrase));
  assert.equal(s.lines.filter(x=>x.includes('.mp3')).length,10);assert.equal(output.includes('test-private-key'),false);
});
test('paid generation requires explicit key, voice and model before any network request',async t=>{
  const s=await setup(t);for(const [argv,env,code] of [[args,{},'missing_api_key'],[['--generate'],s.options.env,'missing_voice_id'],[['--generate','--voice-id','stock'],s.options.env,'missing_model_id']])await assert.rejects(run({...s.options,argv,env,fetchImpl:()=>assert.fail('invalid config must not call provider')}),new RegExp(code));
});
test('invalid language and unrecognized options fail without calls',async t=>{const s=await setup(t);for(const argv of [['--language','fr'],['--unknown'],['--voice-id']])await assert.rejects(run({...s.options,argv,fetchImpl:()=>assert.fail('bad arguments must not call provider')}),/invalid_argument/);});
test('explicit generation sends official language/model request and writes validated assets plus honest partial manifest',async t=>{
  const s=await setup(t);const calls=[];
  await run({...s.options,argv:[...args,'--language','es'],fetchImpl:async(url,options)=>{calls.push({url,options});return response();}});
  assert.equal(calls.length,5);
  assert.equal(calls[0].url,'https://api.elevenlabs.io/v1/text-to-speech/stock-voice?output_format=mp3_44100_128');
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.headers['xi-api-key'],'test-private-key');assert.equal(calls[0].options.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body),{text:'Dron armado',model_id:'eleven_flash_v2_5',language_code:'es'});
  assert.deepEqual(await readFile(join(s.dir,'es','armed.mp3')),mp3());
  const manifest=JSON.parse(await readFile(join(s.dir,'manifest.json'),'utf8'));assert.equal(manifest.available,false);assert.equal(manifest.clips.length,10);assert.equal(manifest.clips.filter(c=>c.available).length,5);assert.equal(manifest.clips.find(c=>c.language==='es'&&c.event==='armed').path,'/audio/announcements/es/armed.mp3');
  assert.equal(JSON.stringify(manifest).includes('test-private-key'),false);assert.equal(s.lines.join('\n').includes('test-private-key'),false);
});
test('existing validated files are reused without repeat charges and complete manifest becomes available',async t=>{
  const s=await setup(t);let calls=0;const options={...s.options,argv:args,fetchImpl:async()=>{calls++;return response();}};await run(options);assert.equal(calls,10);await run(options);assert.equal(calls,10);
  const manifest=JSON.parse(await readFile(join(s.dir,'manifest.json'),'utf8'));assert.equal(manifest.available,true);
});
test('corrupt existing files fail before charges and are preserved for inspection',async t=>{
  const s=await setup(t);await mkdir(join(s.dir,'es'));await writeFile(join(s.dir,'es','armed.mp3'),'not mp3');await assert.rejects(run({...s.options,argv:args,fetchImpl:()=>assert.fail('must not charge over corrupt existing file')}),/invalid_existing_audio/);assert.equal(await readFile(join(s.dir,'es','armed.mp3'),'utf8'),'not mp3');
});
for(const [label,reply] of [['provider rejection',()=>response('secret upstream body','application/json',429)],['JSON success',()=>response('{"secret":"key"}','application/json')],['empty MP3',()=>response(Buffer.alloc(0))],['truncated MP3',()=>response(mp3().subarray(0,100))],['fake ID3',()=>response(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(900)]))],['truncated tail after complete frames',()=>response(Buffer.concat([mp3(),mp3().subarray(0,100)]))]])test(`${label} cannot become a committed clip`,async t=>{
  const s=await setup(t);await assert.rejects(run({...s.options,argv:[...args,'--language','es'],fetchImpl:async()=>reply()}),/provider_request_failed|invalid_audio/);assert.deepEqual(await readdir(join(s.dir,'es')).catch(()=>[]),[]);assert.equal(s.lines.join('\n').includes('secret'),false);
});
test('provider/network errors never expose credentials or upstream details',async t=>{const s=await setup(t);await assert.rejects(run({...s.options,argv:args,fetchImpl:async()=>{throw Error('test-private-key account detail');}}),error=>{assert.equal(error.message,'provider_request_failed');return true;});});
test('partial pack resumes from validated outputs without regenerating successful clips',async t=>{
  const s=await setup(t);let calls=0;await assert.rejects(run({...s.options,argv:[...args,'--language','es'],fetchImpl:async()=>++calls===2?response('private','application/json',500):response()}),/provider_request_failed/);
  let resumed=0;await run({...s.options,argv:[...args,'--language','es'],fetchImpl:async()=>{resumed++;return response();}});assert.equal(resumed,4);assert.deepEqual(await readFile(join(s.dir,'es','armed.mp3')),mp3());
});

test('multilingual_v2 omits unsupported language_code and retains the fixed language text',async t=>{
  const s=await setup(t);const bodies=[];await run({...s.options,argv:['--generate','--voice-id','stock-voice','--model-id','eleven_multilingual_v2','--language','es'],fetchImpl:async(_url,options)=>{bodies.push(JSON.parse(options.body));return response();}});
  assert.deepEqual(bodies[0],{text:'Dron armado',model_id:'eleven_multilingual_v2'});
});
