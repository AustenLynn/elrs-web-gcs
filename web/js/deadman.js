// Dead-man rule: the pilot must deliberately take control, and loses it whenever the page
// is not in front of them (tab hidden, window not focused, connection lost). A page that
// is not engaged sends nothing, so crsf-core fails safe 300 ms later (FMEA #4).
export class Deadman {
  constructor() {
    this.engaged = false;
    this.reason = 'not_engaged';
  }

  engage() {
    this.engaged = true;
    this.reason = null;
  }

  disengage(reason) {
    if (!this.engaged) return;
    this.engaged = false;
    this.reason = reason;
  }

  /** Re-checked before every control message. Disengaging is sticky until engage(). */
  canSend({ visible, focused, wsOpen }) {
    if (!visible) this.disengage('hidden');
    else if (!focused) this.disengage('blur');
    else if (!wsOpen) this.disengage('disconnected');
    return this.engaged;
  }
}

export const DEADMAN_TEXT = {
  not_engaged: 'Pulsa «Tomar control» para pilotar',
  hidden: 'Control perdido: la página dejó de estar visible',
  blur: 'Control perdido: la ventana perdió el foco',
  disconnected: 'Control perdido: se cortó la conexión',
};
