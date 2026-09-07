// Audible playback for the beat-matcher's own captured buffer (ui/
// beatMatcher.ts): renders the captured sample itself at the transport's
// own play/pause/scrub/rewind/loop state and playbackSpeed, and — at each
// note's own onset (left edge) as playback crosses it — fires a
// synthesized metronome-style tick (audio feedback for where the note
// track's events actually fall). Both of those are reference/authoring aids
// only meaningful while the popup's actually open for you to compare them
// against — see isBeatMatcherPopupOpen below — so they're suppressed once
// it's closed. What's NOT suppressed, regardless of popup state: activating
// whatever's wired from the beat-matcher control's own porthole (its
// single, port-less event output — see ui/interaction.ts's
// wire-drag-from-porthole handling), releasing it again at the note's own
// end — once notes are placed, a closed beat-matcher behaves exactly like a
// closed sequencer popup (audio/sequencerPlayer.ts): silent itself, still
// driving whatever it's wired to. Same lookahead-scheduling idiom as
// ui/organelle.ts's own sequencer note dispatch (dispatchedUpTo, a
// schedule-ahead horizon, deferToCtxTime), just against this control's one
// port-less wire set instead of a per-channel one.
//
// Independent of ui/beatMatcher.ts's own state-mutation functions by
// design for its actual scheduling work — the polling loop below only ever
// *reads* BeatMatcherState and reconciles a local Web Audio voice against
// it, via the same small polling-loop idiom this app's other schedulers use
// (audio/transport.ts, audio/sequencerPlayer.ts, ui/organelle.ts), rather
// than hooking into every transport action directly. That keeps
// ui/beatMatcher.ts free of raw AudioNode lifecycle, same layering as
// audio/sequencerPlayer.ts vs. ui/sequencer.ts. The one exception is
// activateBeatMatcherControl below (an external event-wire *driving* this
// control's own play/pause, same as audio/sequencerPlayer.ts's own
// activateSequencerControl) — that's a control input, not a scheduling
// concern, so it calls straight into ui/beatMatcher.ts's toggle.

import { getAudioContext } from './context';
import { getMasterChain } from './master';
import { activateEventTarget, releaseEntity } from './graph';
import type { TriggerOverrides } from './graph';
import type { EntityGraph } from './entityGraph';
import { getEventWiresFrom } from '../ui/eventWiring';
import { recordSourcePulse } from '../ui/eventPulse';
import type { InteractionState } from '../ui/interaction';
import {
  beatMatcherStateFor,
  currentBeatMatcherPlaybackSeconds,
  flashBeatMatcherCursor,
  toggleBeatMatcherPlayback,
} from '../ui/beatMatcher';
import type { BeatMatcherNote, BeatMatcherState } from '../ui/beatMatcher';

const LOOKAHEAD_INTERVAL_MS = 25;

// Set once at startup (ui/main.ts, alongside ui/clockPulse.ts's own
// attachClockPulse) so a wired target's own pad can flash on a dispatched
// note, the same visible feedback ui/interaction.ts's fireEventWireTargets
// already gives a tap/clock-driven activation
// (state.triggerFlashes.set(...)) — this scheduler has no other way to
// reach the live InteractionState, since it isn't itself part of a pointer
// event handler the way that one is. Not threaded through
// registerBeatMatcherForPlayback/audio/graph.ts's buildFromEntityGraph
// instead, since that call site has no InteractionState to give it either,
// and a module-level attach (rather than per-registration) still covers
// every beat-matcher regardless of how many exist.
let interactionState: InteractionState | null = null;

// Same reasoning/lifecycle as interactionState just above, attached
// alongside it — the one live EntityGraph instance (ui/main.ts creates
// exactly one and mutates it in place, never rebuilds it, so a reference
// captured once at startup stays valid and current for the app's whole
// lifetime). Used only to read a feature entity's own `expanded` (ui/
// organelle.ts: whether its popup is currently open) — see
// isBeatMatcherPopupOpen below.
let entityGraph: EntityGraph | null = null;

export function attachBeatMatcherInteraction(state: InteractionState): void {
  interactionState = state;
}

export function attachBeatMatcherGraph(graph: EntityGraph): void {
  entityGraph = graph;
}

// False (not just "unknown") if the graph isn't attached yet or the feature
// entity is somehow gone — the safer default here is "treat as closed and
// stay silent" rather than accidentally leaving the reference sample/tick
// playing when nothing should be.
function isBeatMatcherPopupOpen(featureEntityId: string): boolean {
  return entityGraph?.get(featureEntityId)?.expanded === true;
}

interface Voice {
  source: AudioBufferSourceNode;
  buffer: AudioBuffer;
  // The (ctxTime, offset, speed) triple this voice was started against —
  // compared against the state's own current triple each tick to detect a
  // real transport change (play/pause/scrub/rewind/speed/loop-wrap) rather
  // than just continuing to play unchanged; none of those actions mutate
  // this in place except by producing a genuinely new anchor.
  anchorCtxTime: number;
  anchorOffset: number;
  anchorSpeed: number;
}

interface Registered {
  controlEntityId: string;
  featureEntityId: string;
  voice: Voice | null;
  // Everything at or before this point on the clip's own timeline has
  // already had its tick scheduled (or intentionally skipped over by a
  // backward jump — rewind/scrub/loop — detected in dispatchNoteEvents below).
  // Same "dispatchedUpTo" shape as ui/organelle.ts's own sequencer
  // scheduler.
  dispatchedUpTo: number;
}

const registered = new Map<string, Registered>(); // keyed by featureEntityId

// Called once per beat-matcher at graph-build time (audio/graph.ts's
// buildFromEntityGraph), same as audio/sequencerPlayer.ts's own
// registerSequencerForPlayback.
export function registerBeatMatcherForPlayback(controlEntityId: string, featureEntityId: string): void {
  registered.set(featureEntityId, { controlEntityId, featureEntityId, voice: null, dispatchedUpTo: 0 });
}

// The beat-matcher control's own event-wire target: wiring a tap/clock's
// (or anything else's) output onto its center play/pause button
// (ui/interaction.ts's eventWireHoverTarget detection, extended to
// recognize a 'beatMatcher' pad) toggles playback exactly like clicking
// that button would — same shape as audio/sequencerPlayer.ts's own
// activateSequencerControl, called from the same audio/graph.ts
// activateEventTarget dispatch point.
export function activateBeatMatcherControl(controlEntityId: string): boolean {
  for (const entry of registered.values()) {
    if (entry.controlEntityId === controlEntityId) {
      toggleBeatMatcherPlayback(entry.featureEntityId);
      return true;
    }
  }
  return false;
}

// --- Metronome-style tick ------------------------------------------------
// A short burst of filtered white noise with a fast exponential decay —
// the standard synthesized "click" recipe (no sample needed): cheap, fully
// tunable in code, and this is exactly the kind of short transient that's
// actually harder to get right from a real recording (loop points, level
// matching) than to synthesize directly.

const TICK_DURATION_SECONDS = 0.05; // comfortably covers the decay tail below
const TICK_DECAY_SECONDS = 0.02;
const TICK_FREQUENCY_HZ = 2600; // bright, percussive — not a musical pitch, just "click" character
const TICK_Q = 3;

// Cached and regenerated only if the context's own sample rate ever
// differs from a previously-built buffer's (shouldn't normally happen
// mid-session, but keeps this correct rather than assuming a fixed rate).
let tickNoiseBuffer: AudioBuffer | null = null;

function getTickNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!tickNoiseBuffer || tickNoiseBuffer.sampleRate !== ctx.sampleRate) {
    const length = Math.ceil(ctx.sampleRate * TICK_DURATION_SECONDS);
    tickNoiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = tickNoiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }
  return tickNoiseBuffer;
}

// `when` may already be at or slightly behind ctx.currentTime (this
// scheduler's own ~25ms poll latency behind exactly where a note's onset
// falls) — AudioBufferSourceNode.start()/AudioParam automation both treat
// a past `when` as "now" per spec, so no explicit clamp is needed the way
// startVoice's buffer offset below needs one.
function playBeatMatcherTick(when: number, velocity: number): void {
  const ctx = getAudioContext();
  const noise = ctx.createBufferSource();
  noise.buffer = getTickNoiseBuffer(ctx);

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = TICK_FREQUENCY_HZ;
  bandpass.Q.value = TICK_Q;

  const gain = ctx.createGain();
  // Scaled by the note's own velocity (ui/beatMatcher.ts's BeatMatcherNote)
  // — floored well above 0 so exponentialRampToValueAtTime below always has
  // a nonzero value to ramp from, even at velocity 0.
  gain.gain.setValueAtTime(Math.max(0.0001, 0.9 * velocity), when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + TICK_DECAY_SECONDS);

  noise.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(getMasterChain());

  noise.start(when);
  noise.stop(when + TICK_DURATION_SECONDS);
  noise.addEventListener('ended', () => {
    noise.disconnect();
    bandpass.disconnect();
    gain.disconnect();
  });
}

// How far ahead (real seconds) to schedule ticks — same lookahead-scheduler
// constant shape as audio/sequencerPlayer.ts's own SCHEDULE_AHEAD_SEC.
const TICK_SCHEDULE_AHEAD_SEC = 0.1;

// Converts a note's own onset (clip-time seconds) into the ctx-time it
// actually lands at, given the transport's current anchor — the inverse of
// currentBeatMatcherPlaybackSeconds, same idea as
// ui/organelle.ts's own ctxTimeForSequencerTime.
function ctxTimeForClipSeconds(state: BeatMatcherState, seconds: number): number {
  const playStart = state.playStartCtxTime ?? getAudioContext().currentTime;
  return playStart + (seconds - state.pausedAtSeconds) / state.playbackSpeed;
}

// Defers a callback to fire once ctx.currentTime reaches targetCtxTime
// (immediately if that's already passed) — same technique
// audio/transport.ts's scheduleSoon and ui/organelle.ts's own
// deferToCtxTime both use, reimplemented locally here rather than shared
// since neither of those is exported and each is a trivial couple of
// lines. Used to flash the visual cursor (ui/beatMatcher.ts's
// flashBeatMatcherCursor) at the exact moment a tick scheduled ahead of
// time actually sounds, not the moment it was scheduled.
function deferToCtxTime(targetCtxTime: number, callback: () => void): void {
  const delayMs = Math.max(0, (targetCtxTime - getAudioContext().currentTime) * 1000);
  setTimeout(callback, delayMs);
}

// A4 (440Hz) is MIDI 69 — standard equal-temperament conversion, same
// formula as audio/sequencerPlayer.ts's own midiToHz, duplicated locally
// rather than shared per this file's own header on staying independent.
function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// A note's pitch/velocity/envelope, converted into audio/graph.ts's own
// units — same conversion as audio/sequencerPlayer.ts's own overridesForNote,
// duplicated locally per this file's own header.
function overridesForNote(note: BeatMatcherNote): TriggerOverrides {
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

function dispatchNoteEvents(entry: Registered, state: BeatMatcherState, isOpen: boolean): void {
  if (!state.playing || !state.capturedBuffer) {
    entry.dispatchedUpTo = state.pausedAtSeconds;
    return;
  }

  const playhead = currentBeatMatcherPlaybackSeconds(state);
  if (playhead < entry.dispatchedUpTo) {
    // Rewound, scrubbed backward, or just looped back to the start —
    // resume dispatching from here without re-firing whatever's already
    // passed.
    entry.dispatchedUpTo = playhead;
  }

  // A real SCHEDULE_AHEAD_SEC of wall-clock lookahead covers
  // TICK_SCHEDULE_AHEAD_SEC * playbackSpeed of the clip's own timeline —
  // slowed-down playback covers proportionally less clip-time per poll.
  const horizon = playhead + TICK_SCHEDULE_AHEAD_SEC * state.playbackSpeed;
  // This control's own port-less event wires (ui/interaction.ts's
  // wire-drag-from-porthole) — captured once per batch, same as
  // ui/organelle.ts's own dispatchNote captures its channel's wires once
  // per note.
  const wires = getEventWiresFrom(entry.controlEntityId);

  for (const note of state.notes) {
    if (note.onsetSeconds >= entry.dispatchedUpTo && note.onsetSeconds < horizon) {
      const onsetCtxTime = ctxTimeForClipSeconds(state, note.onsetSeconds);
      const overrides = overridesForNote(note);
      // With a custom envelope, this lands the release ramp's completion
      // exactly on the note's own drawn right edge — same reasoning as
      // audio/sequencerPlayer.ts's own dispatchNote. With no custom
      // envelope, it's just a plain gate-off at the note's own end.
      const releaseSeconds = note.envelope
        ? note.onsetSeconds + note.durationSeconds * (1 - note.envelope.release)
        : note.onsetSeconds + note.durationSeconds;
      const releaseCtxTime = ctxTimeForClipSeconds(state, releaseSeconds);

      // The tick is reference audio (see this file's own header) — only
      // worth sounding while the popup's actually open to compare it
      // against; the wire dispatch below is the real "acts as a sequencer"
      // output and fires regardless.
      if (isOpen) playBeatMatcherTick(onsetCtxTime, note.velocity);
      deferToCtxTime(onsetCtxTime, () => {
        flashBeatMatcherCursor(entry.featureEntityId);
        const firedAt = performance.now();
        for (const wire of wires) {
          activateEventTarget(wire.targetEntityId, overrides);
          // The wired target's own pad ring — see attachBeatMatcherInteraction's
          // own comment on why this needs a separately-attached reference.
          interactionState?.triggerFlashes.set(wire.targetEntityId, firedAt);
        }
        recordSourcePulse(entry.controlEntityId, firedAt); // ui/eventPulse.ts — animates any wire out of this control's own bump
      });
      deferToCtxTime(releaseCtxTime, () => {
        for (const wire of wires) releaseEntity(wire.targetEntityId, note.envelope ? overrides : undefined);
      });
    }
  }

  // The selection ruler's own current point (ui/beatMatcher.ts) — ticks the
  // same metronome click as a note's own onset, but plain (no wired-target
  // dispatch, no envelope/pitch/velocity: it's an audible marker for the
  // user's own ear, not a note), so auditioning a selection loop lets you
  // hear exactly where the point falls against the audio. Works whether or
  // not a selection region is currently bounding playback — the point is
  // its own independent marker. Entirely a reference/authoring aid (no wire
  // dispatch happens here at all), so skipped outright once the popup's
  // closed rather than just muting the tick.
  const point = state.currentPointSeconds;
  if (isOpen && point !== null && point >= entry.dispatchedUpTo && point < horizon) {
    const pointCtxTime = ctxTimeForClipSeconds(state, point);
    playBeatMatcherTick(pointCtxTime, 1);
    // Same cursor flash a note's own onset gets, deferred to land at the
    // exact ctx-time the tick itself sounds (it's scheduled ahead of time,
    // same as the note case) rather than the moment this poll ran.
    deferToCtxTime(pointCtxTime, () => flashBeatMatcherCursor(entry.featureEntityId));
  }

  entry.dispatchedUpTo = horizon;
}

function stopVoice(entry: Registered): void {
  if (!entry.voice) return;
  entry.voice.source.stop();
  entry.voice.source.disconnect();
  entry.voice = null;
}

// Starts a fresh voice anchored exactly the way
// ui/beatMatcher.ts's own currentBeatMatcherPlaybackSeconds computes the
// visual playhead (pausedAtSeconds + elapsed-ctx-time * playbackSpeed) —
// AudioBufferSourceNode.start(when, offset) with playbackRate = speed
// advances through the buffer the identical way, so once started this
// stays sample-accurately in sync with the cursor with no further
// per-tick correction needed, right up until the next real transport
// change actually moves the anchor.
function startVoice(entry: Registered, state: BeatMatcherState): void {
  if (!state.capturedBuffer || state.playStartCtxTime === null) return;
  const ctx = getAudioContext();
  // The anchor can already be slightly in the past by the time this
  // reconciles (a loop wrap's shifted anchor, or simply this poll's own
  // ~25ms latency behind the UI action that set it) — start "now" instead
  // and fast-forward the buffer offset by however much was missed, rather
  // than letting AudioBufferSourceNode.start() reject a past time. This is
  // exactly what keeps the audible position matching the visual cursor
  // (itself always computed fresh from the same anchor) rather than
  // accumulating a lag every time this happens.
  const when = Math.max(ctx.currentTime, state.playStartCtxTime);
  const offset = state.pausedAtSeconds + (when - state.playStartCtxTime) * state.playbackSpeed;
  if (offset < 0 || offset >= state.capturedBuffer.duration) return;

  const source = ctx.createBufferSource();
  source.buffer = state.capturedBuffer;
  source.playbackRate.value = state.playbackSpeed;
  source.connect(getMasterChain());
  source.start(when, offset);

  const voice: Voice = {
    source,
    buffer: state.capturedBuffer,
    anchorCtxTime: state.playStartCtxTime,
    anchorOffset: state.pausedAtSeconds,
    anchorSpeed: state.playbackSpeed,
  };
  entry.voice = voice;
  source.addEventListener('ended', () => {
    if (entry.voice === voice) entry.voice = null;
  });
}

function tick(): void {
  for (const entry of registered.values()) {
    const state = beatMatcherStateFor(entry.featureEntityId);
    const isOpen = isBeatMatcherPopupOpen(entry.featureEntityId);
    dispatchNoteEvents(entry, state, isOpen);

    // The reference-sample voice is the other half of this file's own
    // "authoring aid, not final output" split (see this file's own header)
    // — closing the popup stops it just like it stops the tick, leaving
    // dispatchNoteEvents' wire dispatch as the only thing still running.
    if (!state.playing || !state.capturedBuffer || !isOpen) {
      stopVoice(entry);
      continue;
    }

    const anchorChanged =
      !entry.voice ||
      entry.voice.buffer !== state.capturedBuffer ||
      entry.voice.anchorCtxTime !== state.playStartCtxTime ||
      entry.voice.anchorOffset !== state.pausedAtSeconds ||
      entry.voice.anchorSpeed !== state.playbackSpeed;

    if (anchorChanged) {
      stopVoice(entry);
      startVoice(entry, state);
    }
  }
}

let timerId: ReturnType<typeof setInterval> | null = null;

// Called alongside audio/transport.ts's own start()/stop() and
// audio/sequencerPlayer.ts's own start/stopSequencerScheduler (ui/main.ts's
// global "start/stop audio" toggle) — always running once audio is on,
// regardless of whether any beat-matcher is actually playing right now,
// same lifecycle as the sequencer's own scheduler.
export function startBeatMatcherPlaybackScheduler(): void {
  if (timerId !== null) return;
  timerId = setInterval(tick, LOOKAHEAD_INTERVAL_MS);
}

export function stopBeatMatcherPlaybackScheduler(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  for (const entry of registered.values()) stopVoice(entry);
}
