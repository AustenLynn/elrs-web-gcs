import { t } from './i18n.js';
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
  get not_engaged() { return t('press.take.control.to.fly'); },
  get hidden() { return t('control.lost.page.is.no.longer.visible'); },
  get blur() { return t('control.lost.window.lost.focus'); },
  get disconnected() { return t('control.lost.disconnected'); },
  get layout() { return t('control.lost.screen.size.or.orientation.changed'); },
  get input() { return t('input.mode.changed.press.take.control.again'); },
  get released() { return t('control.released.esc'); },
  get lost() { return t('control.lost.another.pilot.took.over.you.are.queued'); },
  get failsafe() { return t('failsafe.controls.reset.to.zero.press.take.control.to.start.again'); },
};
