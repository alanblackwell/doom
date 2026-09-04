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

   A `control`-type entity (canvas top-level, like knob/clock/tap — not
   nested inside a source), pairing an event-source role on the canvas
   with an authoring `feature` organelle (same porthole/popup invocation
   as the melody/envelope organelles) that opens a piano-roll-style editor
   for the sequence itself. Note: a `feature`'s `ownerId` is currently
   documented as a SOURCE's id only (`audio/entityGraph.ts`'s `Entity`
   comment) — hosting one on a control entity instead is a small
   architecture extension this needs.

   - **Channels:** 4 to start, each with its own output port at that
     channel's own far right — not one shared output the way the
     clock/tap have, so each channel can be wired to a different target
     independently. A drag handle below the last channel adds more as
     needed, open-ended rather than capped at some fixed maximum.
   - **Timeline:** left-to-right, a real-time (not bars/beats) grid —
     lines at 0.1s / 1s / 10s, with the finer spacings only fading in once
     zoomed in enough to read them rather than cluttering a zoomed-out
     view. Zoomable in/out for fine adjustment and audition.
   - **Playback line:** a vertical line that sweeps left to right in sync
     with actual playback, and is itself directly draggable to scrub/
     audition a position. Local start/stop and rewind buttons control it
     — separate from the app's own global start/stop audio control.
   - **Notes:** drag along a channel's own colored lane to lay down a
     note's onset (drag start) and duration (drag length) — a "paint a
     block" gesture, in the same spirit as the melody organelle's
     click-to-add but continuous rather than snapped to a fixed duration.
     Each note also carries pitch and velocity, annotated some way still
     to be decided (not spatial position — a channel lane's own vertical
     axis isn't pitch here) — its own interaction design needed once this
     gets built.

4. Beat matcher organelle for the sequencer.
5. Animation of the event connection line.
