// Loads the Bravura SMuFL font (public/fonts/bravura/, see
// ui/bravuraGlyphs.ts) via the FontFace API so ui/melody.ts's canvas
// fillText calls can use it. A plain <link>/@font-face wouldn't help here —
// canvas doesn't wait for a not-yet-loaded web font the way text-in-the-DOM
// does, and these glyphs live in the Private Use Area (no fallback font has
// anything sensible to show for them meanwhile), so drawing is gated on
// isBravuraReady() rather than risking a flash of tofu boxes on startup.

import { BRAVURA_FONT_FAMILY, BRAVURA_FONT_URL } from './bravuraGlyphs';

let ready = false;

export function isBravuraReady(): boolean {
  return ready;
}

export async function loadBravuraFont(): Promise<void> {
  const fontFace = new FontFace(BRAVURA_FONT_FAMILY, `url(${BRAVURA_FONT_URL})`);
  const loaded = await fontFace.load();
  document.fonts.add(loaded);
  ready = true;
}
