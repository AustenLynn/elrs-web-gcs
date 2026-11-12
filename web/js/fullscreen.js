import { t } from './i18n.js';
// Full screen on phones. Android browsers let the page go full screen ("Tomar control" asks
// for it). iPhone Safari does not let a web page go full screen at all; there the pilot page
// is added to the home screen instead (manifest.webmanifest + the apple-* tags in index.html)
// and then opens without the browser's bars.

/** What to tell the pilot, or null: only where full screen is impossible and the page is not
 *  already running as the home-screen app. */
export function fullscreenTip({ canFullscreen, standalone }) {
  if (canFullscreen || standalone) return null;
  return t('full.screen.on.iphone.share.add.to.home.screen.then.open.the.page.from.that.icon');
}

/** «Tomar control» in order: full screen first (it needs the click's user gesture, so it is
 *  asked before any other await), then the dead-man, then afterEngage (the standby's `take`),
 *  then the wake lock. The take never waits for the wake lock. */
export async function takeControlSteps({ goFullscreen, engage, afterEngage, keepAwake }) {
  await goFullscreen();
  engage();
  afterEngage();
  await keepAwake();
}
