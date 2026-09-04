// Drives a CONTINUOUS_KINDS voice (audio/graph.ts) through a melody
// organelle's note sequence (ui/melody.ts) one pulse at a time, instead of
// it droning a single fixed pitch. A "pulse" is deliberately generic — the
// same activateEventTarget dispatch that reaches this module already
// serves both a direct pad click and a wired-in event (a clock's per-beat
// firing, or a tap), so this never needs to know or care which one
// produced it (see ARCHITECTURE.md §2's "Transport / Scheduler" layer —
// this is that layer's newest member, parallel to audio/transport.ts, not
// a replacement for it).
//
// The whole model: each pulse defines "one crotchet just happened," at
// whatever real-world duration elapsed since the PREVIOUS pulse (not a
// fixed tempo) — so a steady external clock naturally produces steady
// beats, and irregular hand-tapping naturally produces tempo that tracks
// the taps, both through the exact same code path. On each pulse, exactly
// one beat's worth of melody content is walked forward from wherever
// playback left off: a note/rest shorter than a beat finishes within this
// pulse and lets the next one start too (so several short notes can sound
// between two pulses, "as if from a conductor" — TODO.md's melody
// organelle spec); a note longer than a beat simply continues sounding,
// consuming part of its own duration this pulse and the rest on a later
// one. There is no free-running playback between pulses — if pulses stop
// arriving, whatever's currently sounding just holds until the next one.

import { getAudioContext } from './context';
import { getControlSetter, setEntityPaused } from './graph';
import { durationInWholeNotes, effectiveOctaveSteps, markItemPlaying, melodyStateFor } from '../ui/melody';
import type { MelodyItem, MelodyNoteItem } from '../ui/melody';
import { semitoneFromStep } from '../ui/musicTheory';

interface MelodyPlaybackState {
  lastPulseTime: number | null; // ctx.currentTime of the previous pulse — null until a 2nd pulse lets an interval be measured
  cursorIndex: number; // index into the melody's own items array (barlines included; skipped on arrival, see below)
  beatsIntoItem: number; // beats of the item AT cursorIndex already consumed — 0 means "not yet triggered"
  stopTimer: ReturnType<typeof setTimeout> | null; // pending "revert to pause" — see scheduleAutoStop
}

// Keyed by the OWNING source entity's id (e.g. 'bow-1'), not the melody
// feature entity's own id — there's one playback cursor per sounding
// voice, same as audio/graph.ts's own per-owner registries.
const playbackByOwner = new Map<string, MelodyPlaybackState>();

function freshState(): MelodyPlaybackState {
  return { lastPulseTime: null, cursorIndex: 0, beatsIntoItem: 0, stopTimer: null };
}

// With no rhythm input wired in, a pulse is a manual tap on the owner's own
// pad. Rather than droning on the last note forever once the user stops
// tapping, each pulse arms a "revert to pause" timeout set to the interval
// since the PREVIOUS pulse — the same interval this pulse just used as its
// own beat length — so playback holds the current note/rest exactly as long
// as it would have taken for another tap to arrive on the established
// tempo, then falls silent and waits. A steady wired clock re-arms this
// every beat well within that window, so it never actually fires as long as
// pulses keep arriving on time; the small grace factor absorbs ordinary
// scheduling jitter without meaningfully changing when a genuine stop is
// detected (a real gap is normally much larger than the tempo itself).
const AUTO_STOP_GRACE_FACTOR = 1.15;

function scheduleAutoStop(state: MelodyPlaybackState, ownerEntityId: string, beatSeconds: number): void {
  if (state.stopTimer !== null) clearTimeout(state.stopTimer);
  state.stopTimer = setTimeout(() => {
    state.stopTimer = null;
    // Next pulse re-establishes tempo from scratch, exactly like this
    // owner's very first-ever pulse — the gap during the pause shouldn't be
    // measured as though it were the new beat length.
    state.lastPulseTime = null;
    setEntityPaused(ownerEntityId, true);
  }, beatSeconds * AUTO_STOP_GRACE_FACTOR * 1000);
}

// A written diatonic step + accidental, as an absolute semitone offset
// from middle C (C4) — ui/musicTheory.ts's own reference point.
function noteSemitoneFromMiddleC(note: MelodyNoteItem, octaveSemitones: number): number {
  const accidentalOffset = note.accidental === 'sharp' ? 1 : note.accidental === 'flat' ? -1 : 0;
  return semitoneFromStep(note.step) + accidentalOffset + octaveSemitones;
}

// A4 (440Hz) is MIDI 69, 9 semitones above middle C (MIDI 60, our own
// semitone-0 reference) — standard equal-temperament conversion.
function hzFromSemitoneFromMiddleC(semitone: number): number {
  return 440 * 2 ** ((semitone - 9) / 12);
}

// Sets the owning voice's live frequency/gate for the start of `item` —
// snaps straight to the new pitch (no glide/portamento; confirmed
// acceptable for a drone voice at this stage) via the same
// getControlSetter path a manual frequency knob already uses, so this
// module never needs to know whether that's a native AudioParam or a
// worklet postMessage underneath. Also marks `item` as the melody's
// currently-playing one (ui/melody.ts's markItemPlaying) — a pure visual
// debug aid, so opening the popup while pulses arrive shows a glow land on
// whichever item this actually picked, independent of whether the voice
// itself is audibly correct.
function triggerItemStart(melodyEntityId: string, ownerEntityId: string, item: MelodyItem, octaveSemitones: number): void {
  markItemPlaying(melodyEntityId, item);
  if (item.kind === 'note') {
    const hz = hzFromSemitoneFromMiddleC(noteSemitoneFromMiddleC(item, octaveSemitones));
    getControlSetter(ownerEntityId, 'frequency')?.(hz);
    getControlSetter(ownerEntityId, 'melodyGate')?.(1);
  } else if (item.kind === 'rest') {
    getControlSetter(ownerEntityId, 'melodyGate')?.(0);
  }
  // A barline is never itself "triggered" — see pulseMelody's own loop,
  // which skips over one before this is ever called.
}

// Schedules triggerItemStart at `delaySeconds` from now — 0 (or negative,
// shouldn't happen but guarded anyway) fires synchronously; anything else
// defers via setTimeout, the same low-level pattern
// audio/transport.ts's scheduleSoon and ui/clockPulse.ts already use to
// land a callback close to a target AudioContext.currentTime. This is what
// lets more than one short note fire within a single pulse's budget.
function scheduleItemStart(
  melodyEntityId: string,
  ownerEntityId: string,
  item: MelodyItem,
  delaySeconds: number,
  octaveSemitones: number
): void {
  if (delaySeconds <= 0) {
    triggerItemStart(melodyEntityId, ownerEntityId, item, octaveSemitones);
  } else {
    setTimeout(() => triggerItemStart(melodyEntityId, ownerEntityId, item, octaveSemitones), delaySeconds * 1000);
  }
}

// Called once per pulse (audio/graph.ts's activateEventTarget) — advances
// `ownerEntityId`'s melody playback by exactly one beat's worth of content,
// where "one beat" is whatever real time elapsed since the previous pulse.
// Returns false without changing anything if the melody has no playable
// content (empty, or only barlines) — the caller then falls back to this
// entity's normal CONTINUOUS_KINDS pause-toggle behavior, so an
// as-yet-empty melody organelle changes nothing about how its owner sounds.
export function pulseMelody(melodyEntityId: string, ownerEntityId: string): boolean {
  const melody = melodyStateFor(melodyEntityId);
  if (!melody.items.some((item) => item.kind !== 'barline')) return false;

  const octaveSemitones = (melody.octaveUp - melody.octaveDown) * 12; // effectiveOctaveSteps is in diatonic-step units; a whole octave is always exactly 12 semitones, so this is simpler/more direct than converting through that
  void effectiveOctaveSteps; // (imported for parity with ui/melody.ts's own semitone-independent step-shift concept; octaveSemitones above is the audio-side equivalent computed directly)

  const state = playbackByOwner.get(ownerEntityId) ?? freshState();
  playbackByOwner.set(ownerEntityId, state);

  // Any pulse at all — including this one — means playback shouldn't revert
  // to pause on account of a timeout armed by an earlier pulse.
  if (state.stopTimer !== null) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }

  const now = getAudioContext().currentTime;

  if (state.lastPulseTime === null) {
    // First pulse ever for this voice: nothing to measure a beat length
    // from yet — just start sounding wherever the cursor already is.
    state.lastPulseTime = now;
    const item = melody.items[state.cursorIndex % melody.items.length];
    if (item.kind !== 'barline') scheduleItemStart(melodyEntityId, ownerEntityId, item, 0, octaveSemitones);
    return true;
  }

  const beatSeconds = now - state.lastPulseTime;
  state.lastPulseTime = now;
  scheduleAutoStop(state, ownerEntityId, beatSeconds);

  let remainingBeats = 1; // exactly one crotchet's worth of melody content per pulse
  let elapsedBeats = 0; // how far into this pulse's budget we've scheduled so far, for computing each new item's offset
  const EPSILON = 1e-9;

  while (remainingBeats > EPSILON) {
    state.cursorIndex %= melody.items.length;
    const item = melody.items[state.cursorIndex];

    if (item.kind === 'barline') {
      state.cursorIndex += 1;
      continue;
    }

    const itemBeats = durationInWholeNotes(item.durationIndex, item.kind === 'note' ? item.dots : 0) * 4;

    if (state.beatsIntoItem === 0) {
      scheduleItemStart(melodyEntityId, ownerEntityId, item, elapsedBeats * beatSeconds, octaveSemitones);
    }

    const remainingInItem = itemBeats - state.beatsIntoItem;
    if (remainingInItem <= remainingBeats + EPSILON) {
      // This item finishes within this pulse's budget — move on, possibly
      // starting another item before the budget runs out.
      elapsedBeats += remainingInItem;
      remainingBeats -= remainingInItem;
      state.cursorIndex += 1;
      state.beatsIntoItem = 0;
    } else {
      // This item outlasts this pulse (e.g. a minim spanning two beats) —
      // it just keeps sounding; nothing more to do until a later pulse.
      state.beatsIntoItem += remainingBeats;
      remainingBeats = 0;
    }
  }

  return true;
}
