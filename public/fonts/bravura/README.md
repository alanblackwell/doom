# Bravura (SMuFL music font)

`Bravura.woff2` is Steinberg's reference SMuFL font, used by `ui/melody.ts`
to draw clefs, noteheads, rests, accidentals, and flags as real font glyphs
instead of hand-drawn canvas paths. Licensed under the SIL Open Font License
1.1 — see `OFL.txt`, which must stay alongside the font per that license.

`Bravura.json` is the font's own published metadata (glyph bounding boxes,
stem-attachment anchor points, engraving defaults, all in "staff space"
units — SMuFL's own unit, where 1.0 = the gap between two adjacent staff
lines). It's kept here for reference and any future glyph additions, but
`ui/bravuraGlyphs.ts` doesn't parse this 1.2MB file at runtime — it hand-
extracts just the handful of values the melody organelle actually uses
(codepoints, a couple of stem anchors, a few glyph widths) as plain
TypeScript constants, checked against this file when they were added.

Source: https://github.com/steinbergmedia/bravura (`redist/woff/Bravura.woff2`,
`redist/Bravura.json`, `redist/OFL.txt`).
