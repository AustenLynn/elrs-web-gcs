const CODECS = ['audio/webm;codecs=opus', 'audio/mp4'];
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

export class VoiceCapture {
  constructor({mediaDevices = navigator.mediaDevices, MediaRecorderClass = globalThis.MediaRecorder, now = () => performance.now(), onState = () => {}} = {}) {
    Object.assign(this, {mediaDevices, MediaRecorderClass, now, onState});
    this.generation = 0;
    this.current = null;
  }
  codec() {
    const mime = CODECS.find(type => this.MediaRecorderClass?.isTypeSupported(type));
    if (!mime) throw new Error('unsupported_codec');
    return mime;
  }
  async prepare() {
    this.codec();
    const stream = await this.mediaDevices.getUserMedia({audio:true});
    stopTracks(stream);
  }
  async press() {
    if (this.current) return;
    const mime = this.codec();
    const state = {generation:++this.generation, chunks:[], size:0, mime};
    this.current = state;
    try {
      const stream = await this.mediaDevices.getUserMedia({audio:true});
      if (this.current !== state || state.generation !== this.generation) { stopTracks(stream); return; }
      state.stream = stream;
      state.recorder = new this.MediaRecorderClass(stream, {mimeType:mime});
      state.recorder.ondataavailable = ({data}) => {
        if (this.current !== state || state.generation !== this.generation) return;
        state.size += data.size;
        if (state.size > 524288) { state.invalid = true; state.chunks = []; }
        else if (!state.invalid) state.chunks.push(data);
      };
      const cancelCurrent = error => {
        if (this.current === state && state.generation === this.generation) this.cancel(error);
      };
      state.recorder.onerror = () => cancelCurrent('capture_failed');
      state.startedAt = this.now();
      state.recorder.start();
      state.timer = setTimeout(() => cancelCurrent('recording_timeout'), 5000);
      this.onState({phase:'recording', error:null});
    } catch (error) {
      if (this.current === state) this.cancel();
      throw error;
    }
  }
  async release() {
    const state = this.current;
    if (!state) return null;
    if (!state.recorder) { this.cancel(); return null; }
    clearTimeout(state.timer);
    const elapsed = this.now() - state.startedAt;
    return new Promise(resolve => {
      state.resolve = resolve;
      state.recorder.onstop = () => {
        stopTracks(state.stream);
        if (this.current !== state || this.generation !== state.generation) { state.chunks=[]; resolve(null); return; }
        const result = !state.invalid && elapsed < 5000 && state.size > 0
          ? {audio:new Blob(state.chunks, {type:state.mime}), mime:state.mime} : null;
        state.chunks=[];
        this.current=null;
        resolve(result);
      };
      try {
        state.recorder.stop();
      } catch {
        state.chunks = [];
        if (this.current === state) this.current = null;
        resolve(null);
      } finally {
        stopTracks(state.stream);
        state.stream = null;
      }
    });
  }
  cancel(error = null) {
    const state=this.current;
    this.current=null;
    ++this.generation;
    if (!state) return;
    clearTimeout(state.timer);
    state.chunks=[];
    try {
      if (state.recorder?.state !== 'inactive') state.recorder?.stop();
    } catch {
      // A failed recorder still requires microphone cleanup and invalidation.
    }
    stopTracks(state.stream);
    state.stream=null;
    state.resolve?.(null);
    this.onState({phase:'idle',error});
  }
  dispose() { this.cancel(); }
}
