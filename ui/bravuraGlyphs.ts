// Hand-picked constants describing the small subset of the Bravura SMuFL
// font (public/fonts/bravura/, see its own README) that ui/melody.ts
// actually draws: clefs, noteheads, rests, accidentals, and flags. Kept as
// plain TypeScript rather than loading/parsing the font's full ~1.2MB
// metadata JSON at runtime — these values were read from that file (and
// from the SMuFL spec's own glyphnames.json, which is where the Unicode
// codepoints are defined, not in a font's own metadata) once, by hand, and
// won't change unless Bravura itself is swapped for a different SMuFL font.
//
// Units: every size/position value below is in SMuFL's own "staff space"
// unit (1.0 = the gap between two adjacent staff lines = two of
// ui/melody.ts's own diatonic STEP_PX units), NOT pixels — ui/melody.ts
// converts via its own STAFF_SPACE_PX. Anchor Y values use SMuFL's
// up-positive convention (opposite of canvas's down-positive y) — flip the
// sign when converting to a canvas coordinate.

export const BRAVURA_FONT_FAMILY = 'Bravura';
export const BRAVURA_FONT_URL = '/fonts/bravura/Bravura.woff2';

// SMuFL codepoints (github.com/w3c/smufl, metadata/glyphnames.json) for the
// glyphs this app draws.
export const GLYPH = {
  gClef: '\u{E050}',
  fClef: '\u{E062}',
  noteheadDoubleWhole: '\u{E0A0}', // breve
  noteheadWhole: '\u{E0A2}', // semibreve
  noteheadHalf: '\u{E0A3}', // minim
  noteheadBlack: '\u{E0A4}', // crotchet and shorter
  restDoubleWhole: '\u{E4E2}',
  restWhole: '\u{E4E3}',
  restHalf: '\u{E4E4}',
  restQuarter: '\u{E4E5}',
  rest8th: '\u{E4E6}',
  rest16th: '\u{E4E7}',
  rest32nd: '\u{E4E8}',
  accidentalSharp: '\u{E262}',
  accidentalFlat: '\u{E260}',
  flag8thUp: '\u{E240}',
  flag8thDown: '\u{E241}',
  flag16thUp: '\u{E242}',
  flag16thDown: '\u{E243}',
  flag32ndUp: '\u{E244}',
  flag32ndDown: '\u{E245}',
} as const;

// engravingDefaults, from Bravura.json.
export const LEGER_LINE_EXTENSION_SP = 0.4; // beyond a notehead's own edge, on each side
export const STEM_THICKNESS_SP = 0.12;
export const LEGER_LINE_THICKNESS_SP = 0.16;

// glyphAdvanceWidths / glyphBBoxes, from Bravura.json — every one of these
// glyphs is designed with its origin at the LEFT edge, vertically CENTERED
// (its bounding box is symmetric about y=0), so drawing at
// (desiredCenterX - width/2, desiredCenterY) lands the glyph exactly where
// ui/melody.ts's own pos.x/pos.y (an item's visual center) already says it
// should go — no separate per-glyph vertical offset needed.
export const NOTEHEAD_WIDTH_SP = {
  noteheadDoubleWhole: 2.396,
  noteheadWhole: 1.688,
  noteheadHalf: 1.18,
  noteheadBlack: 1.18,
} as const;

export const ACCIDENTAL_WIDTH_SP = {
  sharp: 0.996,
  flat: 0.904,
} as const;

export const CLEF_WIDTH_SP = {
  gClef: 2.684,
  fClef: 2.736,
} as const;

export const REST_WIDTH_SP = {
  restDoubleWhole: 0.504,
  restWhole: 1.132,
  restHalf: 1.132,
  restQuarter: 1.08,
  rest8th: 1.0,
  rest16th: 1.28,
  rest32nd: 1.452,
} as const;

// glyphsWithAnchors.noteheadBlack / noteheadHalf, from Bravura.json —
// identical for both. Where a stem attaches, relative to the notehead's own
// origin (left edge, vertical center). SE = the right-side attachment point
// for a stem going up; NW = the left-side attachment point for a stem going
// down.
export const STEM_UP_SE: readonly [number, number] = [1.18, 0.168];
export const STEM_DOWN_NW: readonly [number, number] = [0.0, -0.168];

// glyphBBoxes.flag8thUp/flag8thDown/etc — every flag's origin sits AT the
// stem's own far tip (x=0 aligns with the stem's x; the glyph extends back
// toward the notehead from there), so drawing a flag at exactly the stem
// tip's (x, y) needs no further offset either.
