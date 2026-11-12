import { cookieToken } from './auth.js';
import { CHOICES } from '../../web/js/voicemaneuver.js';

export const VOICE_LIMITS = Object.freeze({ recordingMs:5000, uploadBytes:512*1024, uploadMs:6000, processingMs:5000, resultMs:6000, statusMs:500 });
const MIME = new Set(['audio/webm','audio/webm;codecs=opus','audio/mp4','audio/mp4;codecs=mp4a.40.2']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class RouteError extends Error { constructor(status, code, reason) { super(code); this.status=status; this.code=code; this.reason=reason; } }
const fail = (status, code, reason) => new RouteError(status, code, reason);
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store', ...([408,413].includes(status)?{Connection:'close'}:{}) });
  res.end(JSON.stringify(body));
}
function sameOrigin(req) {
  try {
    const expected = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    return typeof req.headers.origin === 'string' && new URL(req.headers.origin).origin === expected && req.headers.origin === expected;
  } catch { return false; }
}
function readAudio(req, signal) {
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    const clean=()=>{req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',aborted);signal.removeEventListener('abort',abort);clearTimeout(timer);};
    const done=(err,value)=>{clean();err?reject(err):resolve(value);};
    const data=chunk=>{size+=chunk.length;if(size>VOICE_LIMITS.uploadBytes){req.pause();done(fail(413,'audio_too_large'));}else chunks.push(chunk);};
    const end=()=>done(size?null:fail(400,'invalid_audio'),Buffer.concat(chunks));
    const aborted=()=>done(fail(409,'aborted'));
    const abort=()=>done(signal.reason ?? fail(409,'aborted'));
    const timer=setTimeout(()=>done(fail(408,'upload_timeout')),VOICE_LIMITS.uploadMs);
    req.on('data',data);req.on('end',end);req.on('aborted',aborted);req.on('error',aborted);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}

/** Raw authenticated audio only. No CORS, file storage, model numeric parameters or raw provider errors. */
export function voiceRoutes({cfg,hub,sessions,provider,now=()=>performance.now()}) {
  const states=new Map(), work=new Set();let pipeline=false,closed=false;
  const invalidator=c=>{for(const task of work)if(task.record===c)task.controller.abort(fail(409,'session_changed'));for(const [key,state]of states)if(state.record===c)states.delete(key);};
  hub.voiceInvalidators.add(invalidator);
  const route=async(req,res)=>{
    let path;try{path=new URL(req.url,'http://local').pathname;}catch{return false;}
    if(path!=='/voice/config'&&path!=='/voice/command')return false;
    // IncomingMessage can emit a transport error after abort cleanup has completed.
    // Keep a request-lifetime backstop; the upload listener still handles active errors.
    req.on('error', () => {});
    let task,state,timer,onDisconnect;
    try {
      const user=sessions.get(cookieToken(req));if(!user)throw fail(401,'unauthorized');
      if(!cfg.voice||closed)throw fail(404,'voice_disabled');
      if(path==='/voice/config'){
        if(req.method!=='GET')throw fail(405,'method_not_allowed');
        if(req.headers.origin!==undefined&&!sameOrigin(req))throw fail(403,'forbidden');
        const {execution='dry-run',shortMs=250,mediumMs=500,strength=50}=cfg.voice;
        send(res,200,{execution,shortMs,mediumMs,strength,limits:VOICE_LIMITS});return true;
      }
      if(req.method!=='POST')throw fail(405,'method_not_allowed');
      if(!sameOrigin(req))throw fail(403,'forbidden');
      const sessionText=req.headers['x-voice-session'],capability=req.headers['x-voice-capability'],requestId=req.headers['x-voice-request'];
      if(typeof sessionText!=='string'||!/^\d{1,10}$/.test(sessionText)||!Number.isInteger(Number(sessionText))||Number(sessionText)<1||Number(sessionText)>0xffffffff)throw fail(400,'invalid_session');
      const session=Number(sessionText);
      if(typeof requestId!=='string'||!UUID.test(requestId))throw fail(400,'invalid_request');
      if(typeof capability!=='string'||capability.length>128)throw fail(403,'forbidden');
      const client=hub.authorizeVoice({user,session,capability});
      if(!client){
        const pilot = hub.clients.get(hub.pilot);
        if(pilot?.voiceCapability===capability && pilot.session!==session)throw fail(409,'session_changed');
        throw fail(403,'forbidden');
      }
      const mime=typeof req.headers['content-type']==='string'?req.headers['content-type'].toLowerCase().replace(/\s/g,'').replace(/codecs="([^"]+)"/,'codecs=$1'):'';
      if(!MIME.has(mime))throw fail(415,'unsupported_audio');
      const length=req.headers['content-length'];
      if(length!==undefined&&(typeof length!=='string'||!/^\d{1,10}$/.test(length)))throw fail(400,'invalid_length');
      if(length!==undefined&&Number(length)>VOICE_LIMITS.uploadBytes)throw fail(413,'audio_too_large');
      if(cfg.voice.execution==='enabled'){const readiness=hub.voiceReadiness(session);if(!readiness.ready)throw fail(409,'not_ready',readiness.reason);}
      state=states.get(capability);
      if(!state){state={ids:new Set(),last:-Infinity,busy:false,record:hub.clients.get(client)};states.set(capability,state);}
      if(state.busy||state.ids.has(requestId)||now()-state.last<1000||pipeline)throw fail(409,'busy');
      if(state.ids.size>=128){hub.renewVoice(client);throw fail(409,'capability_exhausted');}
      state.ids.add(requestId);state.last=now();state.busy=true;
      task={client,record:state.record,controller:new AbortController()};work.add(task);
      onDisconnect=()=>task.controller.abort(fail(409,'aborted'));
      req.on('aborted',onDisconnect);
      // A response socket closing after upload also cancels provider work.
      res.on?.('close',onDisconnect);
      const audio=await readAudio(req,task.controller.signal);
      if(task.controller.signal.aborted)throw task.controller.signal.reason;
      if(pipeline)throw fail(409,'busy');
      if(!provider)throw fail(503,'provider_unconfigured');
      pipeline=true;
      const pending=Promise.resolve().then(()=>provider.recognize({audio,mime,signal:task.controller.signal}));
      pending.finally(()=>{pipeline=false;}).catch(()=>{});
      const canceled=new Promise((_,reject)=>{
        const abort=()=>reject(task.controller.signal.reason ?? fail(409,'aborted'));
        task.controller.signal.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>task.controller.abort(fail(504,'processing_timeout')),VOICE_LIMITS.processingMs);
        if(task.controller.signal.aborted)abort();
      });
      const result=await Promise.race([pending,canceled]);
      if(!sessions.get(cookieToken(req))||hub.authorizeVoice({user:sessions.get(cookieToken(req)),session,capability})!==client)throw fail(409,'session_changed');
      if(cfg.voice.execution==='enabled'){const readiness=hub.voiceReadiness(session);if(!readiness.ready)throw fail(409,'not_ready',readiness.reason);}
      if(!CHOICES.includes(result?.choice)||typeof result.transcript!=='string'||result.transcript.length>1000)throw fail(502,'provider_error');
      const timing={};for(const key of ['transcriptionMs','decisionMs']){const v=result.timing?.[key];timing[key]=Number.isFinite(v)&&v>=0?v:0;}
      send(res,200,{requestId,session,choice:result.choice,transcript:result.transcript,timing});
    }catch(err){
      const own=err instanceof RouteError;
      const status=own?err.status:(err?.code==='provider_unconfigured'?503:502);
      // Only errors created in this module are allowed to carry response codes.
      send(res,status,{error:own?err.code:status===503?'provider_unconfigured':'provider_error',...(own&&err.code==='not_ready'?{reason:err.reason}:{})});
    }finally{
      clearTimeout(timer);
      if(task){req.off('aborted',onDisconnect);res.off?.('close',onDisconnect);work.delete(task);state.busy=false;}
      // Drain rejected bodies without buffering or affecting the independent WebSocket path.
      if(!req.readableEnded)req.resume();
    }
    return true;
  };
  route.close=()=>{closed=true;hub.voiceInvalidators.delete(invalidator);for(const task of work)task.controller.abort(fail(409,'aborted'));states.clear();};
  return route;
}
