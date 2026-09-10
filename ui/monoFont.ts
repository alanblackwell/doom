// Self-hosted Fira Code (public/fonts/fira-code/), loaded via the FontFace
// API purely so it's ready as early as possible. MONO_FONT_FAMILY already
// lists 'monospace' as a fallback, so canvas/DOM text renders correctly with
// the generic system font even if this load is slow or fails — unlike
// ui/bravuraFont.ts's Bravura, whose Private Use Area glyphs have no sane
// fallback and so must gate drawing on readiness.

export const MONO_FONT_FAMILY = '"Fira Code", monospace';

const FONT_FAMILY_NAME = 'Fira Code';
const FONT_URL = '/fonts/fira-code/FiraCode-Regular.woff2';

export async function loadMonoFont(): Promise<void> {
  const fontFace = new FontFace(FONT_FAMILY_NAME, `url(${FONT_URL})`);
  const loaded = await fontFace.load();
  document.fonts.add(loaded);
}
