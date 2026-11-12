import { t, CATALOGS } from './i18n.js';

export const voiceError = code => t(Object.hasOwn(CATALOGS.en, `voice.error.${code}`) ? `voice.error.${code}` : 'voice.error.request_failed');

/** Display only: recognition, protocol choices and transcripts are never changed. */
export function voiceFeedback(state, {owner = null, previousPhase = 'idle', config = null} = {}) {
  const messages = {idle:t('ready'),recording:owner === 'button' ? t('listening.tap.send') : t('listening.release.v.to.send'),processing:t('interpreting'),ready:t('interpreted'),executing:t('timed.movement')};

  const readinessMessages = {
    core_stale:[t('no.recent.status'),t('wait.for.a.recent.controller.status')],
    pilot_mismatch:[t('no.pilot.control'),t('this.session.must.be.the.active.pilot')],
    unsafe_state:[t('recover.control'),t('follow.the.existing.manual.recovery.procedure.until.disarmed.then.confirm.normal.and.')],
    not_armed:[t('arm.manually'),t('live.voice.requires.manual.arming.with.the.existing.controls')],
    not_normal:[t('select.normal'),t('select.normal.mode.and.wait.for.confirmation')],
    turtle_active:[t('turn.off.turtle'),t('turn.off.turtle.before.using.live.voice')],
    link_stale:[t('no.recent.rf'),t('wait.for.recent.rf.telemetry.and.a.new.normal.mode.confirmation')],
    link_lost:[t('no.rf.link'),t('restore.the.rf.link.and.confirm.normal.mode.again')],
    normal_unconfirmed:[t('confirm.normal'),t('a.new.normal.mode.confirmation.is.required.use.manual.mode.controls.while.disarmed')],
  };
  const readiness = readinessMessages[state.reason] ?? [t('voice.not.ready'),t('conditions.for.live.voice.are.not.met')];
  const error = state.error === 'not_ready' ? readiness[0] : state.error === 'interrupted' ? t('repeat.the.command') : state.error ? voiceError(state.error) : null;
  const title = state.error === 'not_ready' ? readiness[1] : (error ?? '');
  const text = error ? t('no.action.error', { error }) : state.dryRun ? t('simulation.no.movement') : state.phase === 'idle' && previousPhase === 'executing' ? t('movement.finished') : messages[state.phase];
  const transcript = state.transcript ?? '';
  const choice = state.choice ?? 'none';
  const directions = {forward:t('forward'),backward:t('backward'),left:t('left'),right:t('right'),turn_left:t('turn.left'),turn_right:t('turn.right')};
  const tier = choice.endsWith('_medium') ? 'medium' : 'short';
  const direction = choice.replace(/_(short|medium)$/, '');
  const action = choice === 'none' ? t('no.action') : `${choice === 'repeat_short' ? t('repeat') : directions[direction]} · ${tier === 'medium' ? t('medium') : t('short')} · ${config?.[`${tier}Ms`] ?? '—'} ms`;
  return {phase: state.phase, title, text, transcript, action};
}
