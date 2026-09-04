// A minimal music-theory reference for the melody organelle (ui/melody.ts):
// which accidentals actually make sense on a given written diatonic staff
// step, for the currently active key/mode. Deliberately its own tiny module
// — "we'll discuss modes later" (TODO.md's melody organelle spec) should
// only ever mean swapping the interval pattern below, never touching
// ui/melody.ts's drag-quantization code that consults it.
//
// The core fact this encodes: a diatonic scale's seven steps are NOT evenly
// spaced in semitones — most neighboring pairs are a whole tone apart, but
// two pairs are only a natural semitone apart (E-F and B-C in a major
// scale). Sharping a note that's already a semitone below its neighbor (E,
// B) lands exactly ON that neighbor (E# is enharmonically just F) — not a
// new, distinct pitch — so offering a sharp there is nonsensical, and the
// same goes for flattening a note a semitone above ITS neighbor (F, C: Fb
// is just E). Every other step's sharp/flat is a genuine new chromatic
// pitch and is fine to offer.

// Semitone interval from each natural scale degree to the next one,
// starting at C (index 0=C, 1=D, 2=E, 3=F, 4=G, 5=A, 6=B) — major/Ionian's
// whole-whole-half-whole-whole-whole-half pattern. This is the one piece
// that would change for a different mode or a key signature with its own
// altered degrees; everything below is written generically against it.
const MAJOR_STEP_INTERVALS = [2, 2, 1, 2, 2, 2, 1];

function letterIndex(diatonicStep: number): number {
  return ((diatonicStep % 7) + 7) % 7;
}

// True if sharping `diatonicStep` produces a pitch distinct from its own
// next natural neighbor (i.e. the interval up to that neighbor is more than
// a semitone).
export function sharpMakesSense(diatonicStep: number): boolean {
  return MAJOR_STEP_INTERVALS[letterIndex(diatonicStep)] > 1;
}

// True if flattening `diatonicStep` produces a pitch distinct from its own
// previous natural neighbor.
export function flatMakesSense(diatonicStep: number): boolean {
  return MAJOR_STEP_INTERVALS[letterIndex(diatonicStep - 1)] > 1;
}
