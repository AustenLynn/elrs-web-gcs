import { t, onLanguageChange } from './i18n.js';
// What the admin list may offer for a row (pure, so it can be tested).
export let FLYING_TEXT = t('flying.cannot.be.removed');
onLanguageChange(() => { FLYING_TEXT = t('flying.cannot.be.removed'); });

/** `me` is the signed-in user's name (or the {name} object from /me). */
export function rowActions(user, me) {
  const mine = typeof me === 'string' ? me : me?.name;
  if (user.flying) return { canRemove: false, reason: FLYING_TEXT };
  if (user.name === mine) return { canRemove: false, reason: null };
  return { canRemove: true, reason: null };
}
