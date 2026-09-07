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

3. **Sequencer** (`ui/sequencer.ts`, `audio/sequencerPlayer.ts`).

   A `control`-type entity (canvas top-level, like knob/clock/tap — not
   nested inside a source), pairing an event-source role on the canvas
   with an authoring `feature` organelle (same porthole/popup invocation
   as the melody/envelope organelles) that opens a piano-roll-style editor
   for the sequence itself.

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
     Each note also carries pitch, velocity, and an ADSR envelope; can be
     dragged past/over another note in the same channel (resolved back to
     a free gap on release) and can be created by dragging in either
     direction.

4. **Beat matcher organelle** (`ui/beatMatcher.ts`,
   `ui/beatMatcherSuggestions.ts`, `audio/beatMatcherPlayer.ts`). A
   single-track `control`-type entity that captures a one-shot sample
   (sound-triggered, from any connected source or live input) and lets
   notes be laid down against its spectrogram — same paint/pitch/velocity/
   envelope/drag-over note editing as the sequencer, plus onset-similarity
   suggestions (Tab/Shift-Tab through the clip's own best-ranked matches to
   a confirmed reference point) and a selection ruler for auditioning a
   specific point. Once its popup is closed, it behaves like a closed
   sequencer: silent itself, still dispatching notes to whatever it's
   wired to.

5. **Event connection line animation** (`ui/eventPulse.ts`). Each event
   wire glows along its whole curve in sync with its source's actual
   firing rate (adaptively tracked, not fixed), decaying toward a dim
   floor between pulses rather than sitting fully dark.

## Maybe someday

Speculative — not committed work, and not clear it's ever actually needed.
Noted here so the idea isn't lost, not as a plan.

- Multiple sequencer/beat-matcher instances, chained the way multiple
  instrument instances would be — dragging a repeated copy out rather than
  there only ever being one fixed `sequencer-1`/`beat-matcher-1`. Nothing
  in the app has a duplicate/spawn mechanism for a whole entity today
  (sampler included), and `ui/docking.ts`'s `isDockable` still excludes
  every `control`-type entity outright — a control has no independent
  sound to park the way a source does. Both would need solving, and only
  worth it if a real need for more than one instance shows up.
