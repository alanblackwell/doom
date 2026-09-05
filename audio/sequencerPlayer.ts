// Drives the sequencer's own notes (ui/sequencer.ts) into wired event
// targets (ui/eventWiring.ts) — the free-running counterpart to
// audio/melodyPlayer.ts's pulse-driven melody playback. A melody only ever
// advances when an external pulse tells it to; a sequencer's timeline runs
// on its own once started (TODO.md's spec: real-time seconds, independent
// of tempo), so there's no external pulse to react to — this owns a small
// dedicated lookahead scheduler instead, parallel to audio/transport.ts's
// own (but NOT sharing its BPM-quantized tick grid, which wouldn't fit a
// tempo-independent timeline).

import { getAudioContext } from './context';
import { activateEventTarget, releaseEntity } from './graph';
import type { TriggerOverrides } from './graph';
import { getEventWiresFrom } from '../ui/eventWiring';
import { recordSourcePulse } from '../ui/eventPulse';
import { advancePastTrackEnd, currentPlaybackSeconds, flashChannelConnector, sequencerStateFor } from '../ui/sequencer';
import type { SequencerNote, SequencerState } from '../ui/sequencer';

// Same shape as audio/transport.ts's own lookahead scheduler (see its
// header comment): a cheap JS timer wakes often and schedules anything
// landing within the next SCHEDULE_AHEAD_SEC of ctx.currentTime, so actual
// timing rides on the audio clock rather than JS timer jitter. Kept
// separate from transport.ts's own constants/timer rather than sharing
// them — that one ticks a BPM-quantized 16th-note grid; this one dispatches
// notes at arbitrary real-time onsets with no such grid.
const LOOKAHEAD_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.1;

interface RegisteredSequencer {
  controlEntityId: string;
  featureEntityId: string;
  // Everything at or before this point on the sequencer's own timeline has
  // already been scheduled (or intentionally skipped over by a backward
  // jump — rewind/scrub/loop — detected in tick() below).
  dispatchedUpTo: number;
}

const registered = new Map<string, RegisteredSequencer>(); // keyed by featureEntityId

// Called once per sequencer at graph-build time (audio/graph.ts's
// buildFromEntityGraph) — there's no dynamic sequencer creation today, but
// this scales to more than one without any extra wiring.
export function registerSequencerForPlayback(controlEntityId: string, featureEntityId: string): void {
  registered.set(featureEntityId, {
    controlEntityId,
    featureEntityId,
    dispatchedUpTo: currentPlaybackSeconds(sequencerStateFor(featureEntityId)),
  });
}

// A4 (440Hz) is MIDI 69 — standard equal-temperament conversion. Written
// fresh rather than reusing audio/melodyPlayer.ts's own private
// hzFromSemitoneFromMiddleC, which is keyed to a different (non-MIDI,
// middle-C-relative) reference frame.
function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// A note's pitch/velocity/envelope, converted into audio/graph.ts's own
// units — MIDI pitch to Hz, and the envelope's duration-relative fractions
// (ui/sequencer.ts's own NoteEnvelope shape) to the absolute seconds every
// trigger/release closure there expects. velocity is never optional on a
// SequencerNote, so it's always included; pitch/envelope are included only
// when the note actually specifies them, so a target that doesn't use a
// given field simply never sees it.
function overridesForNote(note: SequencerNote): TriggerOverrides {
  const overrides: TriggerOverrides = { velocity: note.velocity };
  if (note.pitch !== null) overrides.pitchHz = midiToHz(note.pitch);
  if (note.envelope) {
    overrides.envelope = {
      attack: note.envelope.attack * note.durationSeconds,
      decay: note.envelope.decay * note.durationSeconds,
      sustain: note.envelope.sustain,
      release: note.envelope.release * note.durationSeconds,
    };
  }
  return overrides;
}

// Converts a position on the sequencer's own timeline into the
// AudioContext time it will actually land at, given playback's current
// start reference — the inverse of ui/sequencer.ts's own
// currentPlaybackSeconds. Only ever called while state.playing (see
// tick() below), so playStartCtxTime is always set (ui/sequencer.ts's
// startSequencer/rewindSequencer/scrubSequencer all set it together with
// playing — see their own comments); the fallback here is just a type-level
// safety net, never actually exercised.
function ctxTimeForSequencerTime(state: SequencerState, seconds: number): number {
  const playStart = state.playStartCtxTime ?? getAudioContext().currentTime;
  return playStart + (seconds - state.pausedAtSeconds);
}

// Defers callback to fire once ctx.currentTime reaches targetCtxTime
// (immediately, if that moment has already passed) — the same "defer via
// setTimeout to a precomputed AudioContext time" technique
// audio/transport.ts's scheduleSoon and ui/clockPulse.ts's beat flash both
// use, just parameterized on an arbitrary target instead of a fixed
// lookahead offset: this scheduler's own tick() already IS the lookahead,
// so a note's target time is whatever a given tick computed it to be,
// rather than always "SCHEDULE_AHEAD_SEC from right now."
function deferToCtxTime(targetCtxTime: number, callback: () => void): void {
  const delayMs = Math.max(0, (targetCtxTime - getAudioContext().currentTime) * 1000);
  setTimeout(callback, delayMs);
}

function dispatchNote(
  controlEntityId: string,
  featureEntityId: string,
  channelIndex: number,
  note: SequencerNote,
  state: SequencerState
): void {
  const overrides = overridesForNote(note);
  const wires = getEventWiresFrom(controlEntityId, channelIndex);

  deferToCtxTime(ctxTimeForSequencerTime(state, note.onsetSeconds), () => {
    for (const wire of wires) activateEventTarget(wire.targetEntityId, overrides);
    recordSourcePulse(controlEntityId, performance.now(), channelIndex);
    flashChannelConnector(featureEntityId, channelIndex);
  });

  // A note's own note-off. When it carries a custom envelope shape, this
  // lands the release ramp's completion exactly on the note's own drawn
  // right edge (ui/sequencer.ts's noteEnvelopePoints: the ramp begins at
  // duration*(1-release) and finishes at duration, not the other way
  // round) — reusing the SAME overrides object captured above, so an
  // unrelated re-trigger of the shared voice in between can't retroactively
  // change this note's own release shape. With no custom envelope, this is
  // just a plain gate-off at the note's own end, letting the target's own
  // attached envelope (if any) use its own default release — "plays with
  // whatever settings it has" applies to the release phase too, not just
  // attack/decay/sustain.
  const releaseSeconds = note.envelope
    ? note.onsetSeconds + note.durationSeconds * (1 - note.envelope.release)
    : note.onsetSeconds + note.durationSeconds;
  deferToCtxTime(ctxTimeForSequencerTime(state, releaseSeconds), () => {
    for (const wire of wires) releaseEntity(wire.targetEntityId, note.envelope ? overrides : undefined);
  });
}

function tick(): void {
  for (const entry of registered.values()) {
    const state = sequencerStateFor(entry.featureEntityId);

    // advancePastTrackEnd normally only ran from the render-gated
    // updateSequencerPlayback (only invoked while the editor popup is
    // open) — pulled out to ui/sequencer.ts's own export so it (and
    // therefore looping/stopping at the track's end) keeps working while
    // this scheduler is the only thing still watching a closed popup's
    // playback.
    advancePastTrackEnd(state);

    if (!state.playing) {
      // Keep the cursor pinned to wherever playback is currently parked,
      // so resuming later doesn't replay everything that happened while
      // stopped, and scrubbing backward while stopped doesn't leave a
      // stale forward cursor behind.
      entry.dispatchedUpTo = currentPlaybackSeconds(state);
      continue;
    }

    const playhead = currentPlaybackSeconds(state);
    if (playhead < entry.dispatchedUpTo) {
      // Rewound, scrubbed backward, or just looped back to the start —
      // resume dispatching from here without re-firing whatever's already
      // passed.
      entry.dispatchedUpTo = playhead;
    }

    const horizon = playhead + SCHEDULE_AHEAD_SEC;
    for (let channelIndex = 0; channelIndex < state.channels.length; channelIndex++) {
      for (const note of state.channels[channelIndex].notes) {
        if (note.onsetSeconds >= entry.dispatchedUpTo && note.onsetSeconds < horizon) {
          dispatchNote(entry.controlEntityId, entry.featureEntityId, channelIndex, note, state);
        }
      }
    }
    entry.dispatchedUpTo = horizon;
  }
}

let timerId: ReturnType<typeof setInterval> | null = null;

// Called alongside audio/transport.ts's own start()/stop() (ui/main.ts's
// global "start/stop audio" toggle) — always running once audio is on,
// regardless of whether any sequencer is actually playing right now, same
// lifecycle as the master clock.
export function startSequencerScheduler(): void {
  if (timerId !== null) return;
  timerId = setInterval(tick, LOOKAHEAD_INTERVAL_MS);
}

export function stopSequencerScheduler(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}
