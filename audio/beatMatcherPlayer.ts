// Audible playback for the beat-matcher's own captured buffer (ui/
// beatMatcher.ts): renders the captured sample itself at the transport's
// own play/pause/scrub/rewind/loop state and playbackSpeed, and fires a
// synthesized metronome-style tick precisely at each note's own onset
// (left edge) as playback crosses it — audio feedback for where the
// note track's events actually fall, same lookahead-scheduling idiom as
// audio/sequencerPlayer.ts's own note dispatch, just a built-in click
// rather than dispatching to a wired target (this track has nothing to
// wire to yet).
//
// Independent of ui/beatMatcher.ts's own state-mutation functions by
// design — this only ever *reads* BeatMatcherState and reconciles a local
// Web Audio voice against it, via the same small polling-loop idiom this
// app's other schedulers use (audio/transport.ts, audio/sequencerPlayer.ts,
// ui/organelle.ts), rather than hooking into every transport action
// directly. That keeps ui/beatMatcher.ts free of raw AudioNode lifecycle,
// same layering as audio/sequencerPlayer.ts vs. ui/sequencer.ts.

import { getAudioContext } from './context';
import { getMasterChain } from './master';
import { beatMatcherStateFor, currentBeatMatcherPlaybackSeconds } from '../ui/beatMatcher';
import type { BeatMatcherState } from '../ui/beatMatcher';

const LOOKAHEAD_INTERVAL_MS = 25;

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
  featureEntityId: string;
  voice: Voice | null;
  // Everything at or before this point on the clip's own timeline has
  // already had its tick scheduled (or intentionally skipped over by a
  // backward jump — rewind/scrub/loop — detected in dispatchTicks below).
  // Same "dispatchedUpTo" shape as ui/organelle.ts's own sequencer
  // scheduler.
  dispatchedUpTo: number;
}

const registered = new Map<string, Registered>();

// Called once per beat-matcher at graph-build time (audio/graph.ts's
// buildFromEntityGraph), same as audio/sequencerPlayer.ts's own
// registerSequencerForPlayback.
export function registerBeatMatcherForPlayback(featureEntityId: string): void {
  registered.set(featureEntityId, { featureEntityId, voice: null, dispatchedUpTo: 0 });
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
function playBeatMatcherTick(when: number): void {
  const ctx = getAudioContext();
  const noise = ctx.createBufferSource();
  noise.buffer = getTickNoiseBuffer(ctx);

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = TICK_FREQUENCY_HZ;
  bandpass.Q.value = TICK_Q;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.9, when);
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

function dispatchTicks(entry: Registered, state: BeatMatcherState): void {
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
  for (const note of state.notes) {
    if (note.onsetSeconds >= entry.dispatchedUpTo && note.onsetSeconds < horizon) {
      playBeatMatcherTick(ctxTimeForClipSeconds(state, note.onsetSeconds));
    }
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
    dispatchTicks(entry, state);

    if (!state.playing || !state.capturedBuffer) {
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
