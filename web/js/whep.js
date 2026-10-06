// Minimal WHEP player: receive-only WebRTC video from MediaMTX, signalled through the
// gateway at /video/whep. Non-trickle: the offer is sent once ICE gathering finishes.
function iceGatheringComplete(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export async function startWhep(video, url = '/video/whep') {
  const pc = new RTCPeerConnection();
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (ev) => {
    video.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
  };
  await pc.setLocalDescription(await pc.createOffer());
  await iceGatheringComplete(pc, 2000);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
  if (res.status !== 201) {
    pc.close();
    throw new Error(`video server answered ${res.status}`);
  }
  const location = res.headers.get('Location');
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  return {
    pc,
    async stop() {
      pc.close();
      if (location) await fetch(location, { method: 'DELETE' }).catch(() => {});
    },
  };
}

/** Keeps video playing: restarts the player 2 s after it fails or closes. */
export function keepPlaying(video, { url = '/video/whep', onState = () => {} } = {}) {
  let player = null;
  let timer = null;
  let stopped = false;
  const retry = () => {
    if (timer || stopped) return;
    player?.stop();
    player = null;
    timer = setTimeout(() => { timer = null; start(); }, 2000);
  };
  const start = async () => {
    if (stopped) return;
    onState('connecting');
    try {
      player = await startWhep(video, url);
      player.pc.addEventListener('connectionstatechange', () => {
        const s = player?.pc.connectionState;
        onState(s);
        if (s === 'failed' || s === 'closed') retry();
      });
    } catch {
      onState('error');
      retry();
    }
  };
  start();
  return {
    get pc() { return player?.pc ?? null; },
    stop() {
      stopped = true;
      clearTimeout(timer);
      player?.stop();
    },
  };
}
