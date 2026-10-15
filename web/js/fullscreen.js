// Full screen on phones. Android browsers let the page go full screen ("Tomar control" asks
// for it). iPhone Safari does not let a web page go full screen at all; there the pilot page
// is added to the home screen instead (manifest.webmanifest + the apple-* tags in index.html)
// and then opens without the browser's bars.

/** What to tell the pilot, or null: only where full screen is impossible and the page is not
 *  already running as the home-screen app. */
export function fullscreenTip({ canFullscreen, standalone }) {
  if (canFullscreen || standalone) return null;
  return 'Pantalla completa en iPhone: Compartir → «Añadir a pantalla de inicio» y abre la página desde ese icono';
}
