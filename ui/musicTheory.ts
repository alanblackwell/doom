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

// Natural semitone distance from C for each of the 7 letter names — the
// cumulative sum of MAJOR_STEP_INTERVALS starting at C=0.
const SEMITONES_FROM_C = [0, 2, 4, 5, 7, 9, 11];

// Absolute semitone value of a written diatonic step's own NATURAL pitch
// (no accidental applied) — step 0 (middle C) is semitone 0, +12 per
// octave. Real (semitone) pitch distance isn't the same as diatonic-step
// distance, since a diatonic step is sometimes a whole tone and sometimes a
// semitone (MAJOR_STEP_INTERVALS) — this is what lets ui/melody.ts's
// letter-key note-entry shortcut compare two notes' actual closeness in
// pitch rather than their step-count difference.
export function semitoneFromStep(step: number): number {
  return 12 * Math.floor(step / 7) + SEMITONES_FROM_C[letterIndex(step)];
}

// The step for `letterIdx` (0=C, 1=D, ... 6=B) whose own NATURAL pitch is
// closest to `referenceSemitone` — always within 6 semitones either way,
// since a given letter's natural pitch recurs every 12 semitones (one
// octave). Used by the melody organelle's A-G letter-key shortcut
// (TODO.md's spec: "in the range 6 semitones lower to 6 semitones higher
// than the current note"). A tie (exactly 6 semitones either direction) is
// broken by Math.round's own behavior (round half toward +Infinity) —
// not meaningfully "wrong" either way since both candidates are equally
// close, just worth knowing it's deterministic rather than arbitrary.
export function nearestStepForLetter(letterIdx: number, referenceSemitone: number): number {
  const base = SEMITONES_FROM_C[letterIdx];
  const octave = Math.round((referenceSemitone - base) / 12);
  return 7 * octave + letterIdx;
}
