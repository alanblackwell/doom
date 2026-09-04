# TODO — future substantial packages

Placeholders for larger features to elaborate on when we get to each one.

## Done

1. **Melody organelle** (`ui/melody.ts`, `ui/musicTheory.ts`). A `feature`
   organelle (porthole/popup, same invocation as the ADSR envelope
   organelle) showing a grand staff. Implemented per the original spec:
   independent +8ve/-8ve cycle buttons (off → 1 → 2 octaves) above the
   treble and below the bass clef; click a blank spot to add a crotchet;
   click an existing note/rest to halve its duration, right-click to
   double it; a rest icon and a barline icon, each inserting after the
   last item in sequence; notes/rests/barlines drag left/right to
   reposition (with hover-merge/reorder) and notes drag up/down to
   repitch, with a half-step drag adding a sharp/flat accidental; fixed to
   the key of C, no key signature yet.

2. **Sample capture** (`ui/sampler.ts`, `audio/samplerCapture.ts`,
   `audio/wavEncode.ts`). A sampler organelle: input device selection
   (including system/loopback via BlackHole — see `CLAUDE.md`/`SETUP.md`),
   record/stop, a waveform scope with draggable start/end trim markers
   (mouse-drag and keyboard nudge), a name field, and export as a
   WAV-encoded sample.

## Remaining

3. Sequencer.
4. Beat matcher organelle for the sequencer.
5. Animation of the event connection line.
