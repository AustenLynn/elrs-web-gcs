// Messages exchanged with the gateway (see gateway/src/hub.js) and their Spanish UI texts.
export const RATE_HZ = 50;

export const helloMessage = (role) => ({ t: 'hello', role });

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
};

export const REFUSAL_TEXT = {
  throttle_high: 'Baja el acelerador por completo',
  link_stale: 'Toma el control primero (no llegan comandos)',
  not_disarmed: 'Ya está armado o en failsafe',
  not_in_failsafe: 'No hay failsafe que limpiar',
  fc_still_armed: 'El dron sigue armado: espera a que aterrice y se desarme',
  wrong_session: 'Tu sesión de piloto venció: recarga la página',
};
