// Audible playback for the beat-matcher's own captured buffer (ui/
// beatMatcher.ts) — for now, just renders the captured sample itself at the
// transport's own play/pause/scrub/rewind/loop state and playbackSpeed;
// dispatching the note track's own events to wired targets is a later pass
// (parallel to audio/sequencerPlayer.ts's own note dispatch, once this
// track has somewhere to dispatch to).
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
import { beatMatcherStateFor } from '../ui/beatMatcher';
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
}

const registered = new Map<string, Registered>();

// Called once per beat-matcher at graph-build time (audio/graph.ts's
// buildFromEntityGraph), same as audio/sequencerPlayer.ts's own
// registerSequencerForPlayback.
export function registerBeatMatcherForPlayback(featureEntityId: string): void {
  registered.set(featureEntityId, { featureEntityId, voice: null });
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
