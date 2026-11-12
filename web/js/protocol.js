import { t } from './i18n.js';
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

/** The page wanted to fly but got the observer seat because a pilot was present: ask again
 *  as soon as the seat is free. A page that is not signed in (login_required) never does:
 *  it would get the same answer every second. Signed-in pages are queued by the gateway. */
export const shouldReclaimPilotSeat = (wantRole, welcome, status) =>
  wantRole === 'pilot' && welcome?.role === 'observer' && welcome.reason === 'pilot_present' && status?.pilot === false;

/** What the page does when its connection closes: relay close codes (spec 4.3) get their
 *  own message; a wrong token stops the retry loop instead of prompting forever. */
export function closeAction(code, room) {
  if (!room) return { retryMs: 1000, clearToken: false, text: null };
  switch (code) {
    case 4003: return { retryMs: null, clearToken: true, text: t('incorrect.pilot.key.reload.the.page.to.try.again') };
    case 4001: return { retryMs: 5000, clearToken: false, text: t('pi.is.not.connected.to.the.relay.retrying') };
    case 4002: return { retryMs: 1000, clearToken: false, text: t('pi.reconnected.to.the.relay') };
    case 4004: return { retryMs: 5000, clearToken: false, text: t('room.is.full.4.remote.connections') };
    default: return { retryMs: 1000, clearToken: false, text: null };
  }
}

export const controlMessage = (seq, ts, cmd, sw = { sp: 0, tu: 0 }) => ({
  t: 'ctl', seq, ts, r: cmd.roll, p: cmd.pitch, y: cmd.yaw, th: cmd.throttle, m: cmd.mode, sp: sw.sp, tu: sw.tu,
});

export const tsyncReply = (msg, now) => ({ t: 'tsync_r', s0: msg.s0, c1: now });

export const STATE_TEXT = {
  get DISARMED() { return t('disarmed'); },
  get ARMED() { return t('armed'); },
  FAILSAFE: 'FAILSAFE',
  get HOLD() { return t('hold.no.pilot'); },
  get LANDING() { return t('landing.21'); },
};

export const REASON_TEXT = {
  none: '',
  get cmd_timeout() { return t('pilot.commands.stopped.arriving'); },
  get pilot_lost() { return t('pilot.disconnected'); },
  get gateway_lost() { return t('gateway.restarted'); },
  get session_changed() { return t('pilot.changed'); },
  get manual() { return t('activated.by.pilot'); },
  get rf_lost() { return t('drone.lost.radio.link'); },

};

/** What the page does on a core event: a toast text and whether to let go of the sticks, or
 *  null. A refused take or land means the hold is over: the queued page drops the dead-man it
 *  engaged for the take. */
export function eventReaction(msg, session) {
  if (msg.what === 'resumed' && msg.session === session) return { text: t('connection.restored'), disengage: false };
  if ((msg.what === 'take' || msg.what === 'land') && msg.refused) {
    return { text: t('no.longer.possible.drone.is.no.longer.holding'), disengage: true };
  }
  if (msg.refused) return { text: REFUSAL_TEXT[msg.refused] ?? `${msg.what}: ${msg.refused}`, disengage: false };
  return null;
}

export const REFUSAL_TEXT = {
  get throttle_high() { return t('lower.throttle.completely'); },
  get link_stale() { return t('take.control.first.no.commands.arriving'); },
  get not_disarmed() { return t('already.armed.or.in.failsafe'); },
  get not_in_failsafe() { return t('no.failsafe.to.clear'); },
  get fc_still_armed() { return t('drone.still.armed.wait.for.it.to.land.and.disarm'); },
  get rf_down() { return t('no.radio.link.to.drone.power.it.on.and.wait.for.drone.to.turn.green'); },
  get wrong_session() { return t('pilot.session.expired.reload.the.page'); },
};
