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
   suggestions and a selection ruler for auditioning a specific point. Once
   its popup is closed, it behaves like a closed sequencer: silent itself,
   still dispatching notes to whatever it's wired to. Now feature-complete:

   - **Candidate walk:** Tab/Shift-Tab step through the top-ranked
     onset-similarity matches in TIME order (not rank order, which made
     consecutive presses jump around the clip) with wraparound at both
     ends. The set of candidates is fixed for the walk — it only changes
     when the user defines a new reference (a placed note, or a
     click/drag/nudge of the current point) — never as a side effect of
     Tab itself.
   - **Audition region:** the selection window recomputes on every Tab
     step to tightly bracket the manual anchor and the current candidate,
     using the user's own last manually-chosen margins on each side — so
     it shrinks as well as grows, rather than only ever creeping outward.
     The view scrolls (never rezooms) to keep both points on screen.
   - **Two markers, not one:** the manually-clicked point and the
     Tab-walked candidate both stay visible as their own dashed lines
     (same weight/style, so neither reads as "disappearing"), and both are
     valid note-drag snap targets.
   - **Start/end markers:** a draggable start marker (`state.startSeconds`,
     defaulting to 0) alongside the existing end marker
     (`state.endSeconds`), bounding where playback/loop-at-end begins and
     ends. Each has its own loop/stop toggle, but both toggles read/write
     the single shared `state.loopAtEnd` — clicking either flips both. The
     scrollable region extends a little past both ends of the clip so
     each marker's handle stays reachable when parked at its default
     position right at the boundary.

5. **Event connection line animation** (`ui/eventPulse.ts`). Each event
   wire glows along its whole curve in sync with its source's actual
   firing rate (adaptively tracked, not fixed), decaying toward a dim
   floor between pulses rather than sitting fully dark.

6. **Grind** (`audio/grindPlayer.ts`, `ui/grindTuner.ts`) — doom/industrial
   palette item 1. NOT the bowed-string-driven-into-chaos approach
   originally planned below: an early attempt reusing `bow`'s own WASM
   voice past its stated-unplayable range just settled into a steady tone
   instead of true chaos. Built instead as a granular noise texture — a
   dense, randomized stream of short bandpass-filtered noise grains,
   chaotic by construction — entirely native Web Audio, no WASM.

7. **By-ear tuning organelle pattern** (`ui/tuningOrganelle.ts`, a shared
   factory; `ui/grindTuner.ts`/`ui/bassTuner.ts`/`ui/metalTuner.ts` are thin
   per-voice configs). A porthole/popup on a source itself, listing every
   constant its algorithm uses — including ones previously hardcoded in
   `dsp/rust/src/lib.rs` with no live control at all — as a slider with a
   hover tooltip explaining what it does, a checkbox marking whether it
   should also become a permanent control-dot, and draggable min/max
   carets. A Copy button turns the current tuning into ready-to-paste
   source text for the (up to three) files that need it. Reuse this
   pattern rather than rebuilding it for any future voice worth tuning by
   ear this way.

8. **Growl filter** (`audio/graph.ts`'s `growl` case) — doom/industrial
   palette item 9 below, brought forward: a resonant bandpass in a genuine
   positive-feedback loop, native Web Audio (`BiquadFilterNode` +
   `WaveShaperNode` soft-clip + a 1ms `DelayNode` to break the cycle,
   mirroring `flanger`'s own feedback-loop wiring). A port of the exact
   feedback/soft-clip mechanism `metal`'s WASM voice already used
   (`pluck_render`'s feedback branch) — `metal` itself turned out not to
   work as an instrument (the squeal dominates regardless of tuning; no
   discernible pitch or gesture once feedback engages, "a realistic amp
   feedback sound" that isn't playable as one), so the mechanism was
   pulled out as a routable pedal instead: drag any source into it. Unlike
   the original TODO wording below, there's no built-in cutoff automation
   — `frequency` is a plain control-dot, wireable from a knob/clock the
   same as any other if a sweep is wanted.

9. **Grain sampler** (`audio/grainPlayer.ts`, `ui/grainSampler.ts`) — a
   second granular voice alongside `grind`, but drawing its grains from a
   real captured sample instead of generated noise, so its character comes
   from whatever recording it's fed rather than filter/timing chaos. Same
   porthole/popup mechanism as every other organelle, but its capture
   mechanism (drag a Source/live-input onto the open popup; sound-triggered
   auto start/stop; `audio/nodeCapture.ts`/`ui/spectrogram.ts` reused
   unmodified) is a direct, trimmed-down port of `ui/beatMatcher.ts`'s own —
   no note track, no selection ruler, no transport, no onset suggestions;
   just the finished capture's spectrogram as a surface to click small
   circle POINT markers onto. Free-running once at least one point exists:
   each grain independently picks one point at random (uniformly — no
   per-point weighting) and reads a short, randomized-length window of the
   captured buffer starting there. `level`/`density`/`grainLength` are
   control-dots (`ui/controlSpecs.ts`'s `grain` entry); every other constant
   (position/pitch jitter, envelope fade, the density-to-interval mapping)
   is tuned in `audio/grainPlayer.ts`'s own `GRAIN_TUNING` only — no by-ear
   tuning organelle built for this voice yet, unlike grind/bass/metal (a
   natural follow-up, reusing `ui/tuningOrganelle.ts`). A point's vertical
   position is currently cosmetic only (every point reads the full-band
   capture regardless of where it was clicked); a later per-point
   bandpass-by-height idea was discussed but deliberately deferred.

## Next: a doom/industrial/drone sound palette

The current source/filter selection (`bow`, `pluck`, `bass`, `kick`,
`overdrive`, `fuzz`, `reverb`, `chorus`, `flanger` — see `audio/graph.ts`)
leans clean/melodic: physically-modeled strings and simple sweeps. None of
it is gritty, grinding, or earthquake-scale. Target character: machinery
meeting nature (a chainsaw in a dungeon), ominous power (a volcano the
moment before it erupts), scale (Godzilla dropping a boulder on an
airport), catastrophe (a nuclear plant hit by a tsunami). New sources and
filters to add, roughly in order:

1. **Rumble** — extend `bass`'s twin-detuned-saw approach (`dsp/rust`) an
   octave or two lower into sub-audio range, plus a slow 1–4Hz
   infrasonic AM or filter-cutoff wobble — earthquake/volcano-tension
   drone, the low end everything else in a scene sits on top of.

2. **Impact/boulder** — reuses `kick`'s trigger pipeline
   (`audio/graph.ts`'s `case 'kick'`) but replaces the single
   pitch-sweeping sine with a small bank of inharmonic resonant bandpass
   filters excited by one impulse (modal synthesis) — a rock/boulder
   doesn't ring like a drum head, it rings like several detuned masses at
   once. This is the "Godzilla drops a boulder on an airport" hit.

3. **Clang/gong** — standalone inharmonic modal voice: 4-6 partials at
   non-integer frequency ratios, each with its own decay — dungeon bell,
   warning klaxon, distant structure groaning under load.

4. **Drone/servo** — pulse oscillator(s) with slow PWM plus ring
   modulation between two closely-tuned low oscillators, for a
   distinctly mechanical beating/grinding texture, as a machine-not-organism
   counterpart to `bow`/`pluck`.

5. **Bitcrusher** (filter) — sample-rate/bit-depth reduction. Small
   JS-only `AudioWorkletProcessor` (no WASM needed, simpler than
   `noise-processor.js`) — cheap harsh digital grit layer on any source.

6. **Ring modulator** (filter) — an audio-rate carrier oscillator driving
   a `GainNode`'s `.gain`, the same audio-rate-modulation trick
   `chorus`/`flanger` already use for their LFO (see around
   `audio/graph.ts:1062`), just at audio rate instead of sub-audio —
   robotic/possessed/metallic tone.

7. **Resonator bank** (filter) — parallel *fixed* (not swept, unlike
   flanger's comb) `BiquadFilterNode` bandpasses tuned to inharmonic
   ratios — routes plain noise or `bass` into a gong/metal-clang timbre.
   Distinct from the now-built growl filter (multiple fixed peaks at once,
   rather than one swept/fed-back resonance).

8. **Sub-octave** (filter) — zero-crossing pitch divider adding an
   octave-down copy underneath any existing source's signal — the
   cheapest way to make an already-built instrument (`pluck`, `bow`,
   `bass`) read as earthquake-heavy without a new voice.

9. **Pumping compressor** (filter) — `DynamicsCompressorNode` at an
   extreme ratio, gated by the clock/sequencer's own trigger rate — a
   "machinery breathing" / tidal-surge pulse to put under a sustained
   drone.

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
