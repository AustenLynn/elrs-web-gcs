// Opt-in memory-only measurements. Never retain request identities, speech or media.
const EVENTS = new Set(['release','recognition_start','transcription','decision','recognition_end','maneuver_start','maneuver_end','cancel']);
export class VoiceTrace {
  #rows=[];
  #now;
  constructor({now=()=>performance.now()}={}) { this.#now=now; }
  record(event,{durationMs}={}) {
    if(!EVENTS.has(event))return;
    const atMs=this.#now();
    if(!Number.isFinite(atMs))return;
    const row={event,atMs};
    if(Number.isFinite(durationMs)&&durationMs>=0)row.durationMs=durationMs;
    if(this.#rows.length===512)this.#rows.shift();
    this.#rows.push(row);
  }
  snapshot() {return this.#rows.map(row=>({...row}));}
  clear() {this.#rows=[];}
}
