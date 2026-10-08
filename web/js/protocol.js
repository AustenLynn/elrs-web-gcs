// Messages exchanged with the gateway (see gateway/src/hub.js) and their Spanish UI texts.
export const RATE_HZ = 50;

export const helloMessage = (role) => ({ t: 'hello', role });

/** Where the page connects: the Pi's own gateway, or the internet relay when the page
 *  was opened with ?room=<name> (then a pilot token is needed). */
export function connectionTarget(loc, role, getToken) {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  const room = new URLSearchParams(loc.search).get('room');
  if (!room) return { url: `${scheme}://${loc.host}/ws`, hello: helloMessage(role), relay: false, room: null };
  return { url: `${scheme}://${loc.host}/relay`, hello: { t: 'hello', role, room, token: getToken(room) }, relay: true, room };
}

/** The page wanted to fly but got the observer seat (e.g. its new connection arrived
 *  while the old one still held the seat): ask again as soon as the seat is free. */
export const shouldReclaimPilotSeat = (wantRole, role, status) =>
  wantRole === 'pilot' && role === 'observer' && status?.pilot === false;

/** What the page does when its connection closes: relay close codes (spec 4.3) get their
 *  own message; a wrong token stops the retry loop instead of prompting forever. */
export function closeAction(code, room) {
  if (!room) return { retryMs: 1000, clearToken: false, text: null };
  switch (code) {
    case 4003: return { retryMs: null, clearToken: true, text: 'Clave de piloto incorrecta: recarga la página para intentarlo de nuevo' };
    case 4001: return { retryMs: 5000, clearToken: false, text: 'La Pi no está conectada al relay: reintentando' };
    case 4002: return { retryMs: 1000, clearToken: false, text: 'La Pi se reconectó al relay' };
    case 4004: return { retryMs: 5000, clearToken: false, text: 'La sala está llena (4 conexiones remotas)' };
    default: return { retryMs: 1000, clearToken: false, text: null };
  }
}

export const controlMessage = (seq, ts, cmd) => ({
  t: 'ctl', seq, ts, r: cmd.roll, p: cmd.pitch, y: cmd.yaw, th: cmd.throttle, m: cmd.mode,
});

export const tsyncReply = (msg, now) => ({ t: 'tsync_r', s0: msg.s0, c1: now });

export const STATE_TEXT = {
  DISARMED: 'DESARMADO',
  ARMED: 'ARMADO',
  FAILSAFE: 'FAILSAFE',
};

export const REASON_TEXT = {
  none: '',
  cmd_timeout: 'dejaron de llegar comandos del piloto',
  pilot_lost: 'el piloto se desconectó',
  gateway_lost: 'el gateway se reinició',
  session_changed: 'cambió el piloto',
  manual: 'activado por el piloto',
  rf_lost: 'el dron perdió el enlace de radio (se desarmó solo)',

};

export const REFUSAL_TEXT = {
  throttle_high: 'Baja el acelerador por completo',
  link_stale: 'Toma el control primero (no llegan comandos)',
  not_disarmed: 'Ya está armado o en failsafe',
  not_in_failsafe: 'No hay failsafe que limpiar',
  fc_still_armed: 'El dron sigue armado: espera a que aterrice y se desarme',
  wrong_session: 'Tu sesión de piloto venció: recarga la página',
};
