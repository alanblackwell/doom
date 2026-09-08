// Alternate resynthesis engine for the 'vocode' pedal (audio/graph.ts's
// createVocodeFilter, ui/vocodeTuner.ts's mode toggle) — time-domain
// granular/overlap-add pitch shifting, as a genuinely different DSP
// technique from audio/vocodePlayer.ts's own source-filter/vocoder model:
// instead of analyzing once and generating independently thereafter, this
// continuously reads overlapping windows of the LIVE input and plays each
// one back at an altered rate (AudioBufferSourceNode.playbackRate) so
// pitch changes while the source material stays real.
//
// No new AudioWorkletProcessor/WASM needed for this: a persistent
// AnalyserNode's own getFloatTimeDomainData already gives a "most recent N
// samples" live snapshot with zero postMessage overhead — the same
// mechanism ui/vocodeTuner.ts's own live histogram and audio/graph.ts's
// own analyzeAndApplyVocode one-shot snapshot already use. Reading the
// tail of that snapshot into a fresh small AudioBuffer and playing it
// through a plain AudioBufferSourceNode, on the same LOOKAHEAD_INTERVAL_MS/
// SCHEDULE_AHEAD_SECONDS lookahead-scheduler shape audio/grainPlayer.ts/
// audio/grindPlayer.ts already use, is high-level scheduling of native
// playback nodes — not raw per-sample DSP in a processor callback — so
// this is the same architectural shape as audio/grainPlayer.ts's own
// (already-native, no-WASM) grain engine, not a new exception to
// ARCHITECTURE.md §5.2's WASM-for-granular-synthesis guidance.
//
// Deliberately NOT true PSOLA or WSOLA: window length is chosen as a small
// integer multiple of the locked f0's own pitch period (see WINDOW_PERIODS
// below), which reduces — but doesn't eliminate — the comb-filtering/
// phasiness that comes from crossfading windows that aren't aligned to the
// source's own periodicity. If that's still audible, WSOLA (a small
// per-grain correlation search for the best-aligned splice point, needing
// no known f0 at all) is the natural next step, offered as a further mode
// the same way this one was.

import { getAudioContext } from './context';

const LOOKAHEAD_INTERVAL_MS = 25; // same tick rate as audio/grainPlayer.ts/audio/grindPlayer.ts
const SCHEDULE_AHEAD_SECONDS = 0.1;
const ANALYSER_FFT_SIZE = 16384; // ~372ms of headroom at 44.1kHz — comfortably past the longest plausible window below

const WINDOW_PERIODS = 6; // window length target, in multiples of the locked pitch period — the phase-alignment heuristic, see this file's own header
const MIN_WINDOW_SECONDS = 0.02;
const MAX_WINDOW_SECONDS = 0.25;
const MIN_F0_HZ = 20; // floor for 1/f0 so a bogus near-zero f0 can't blow the window length up
const OVERLAP_FRACTION = 0.5;
const MIN_HOP_SECONDS = 0.005; // caps worst-case grain-trigger rate at extreme pitch ratios
const MIN_RATE = 0.25; // two octaves down
const MAX_RATE = 4; // two octaves up
const ENVELOPE_FADE_FRACTION = 0.25; // same fraction-of-grain-length trapezoid shape as audio/grainPlayer.ts's own envelopeFadeFraction

export interface VocodeGranularVoiceControls {
  setF0: (hz: number) => void;
  setTargetPitch: (hz: number) => void;
  // Same envelope-gated-tail shape as audio/vocodePlayer.ts's own
  // VocodeVoiceControls.outputGate, so audio/graph.ts's createVocodeFilter
  // can wire the same envelope-follower signal into both engines and mix
  // between them identically regardless of which is currently selected.
  outputGate: GainNode;
  stop: () => void;
}

// Starts a continuous granular voice tapping `input` — same "nodes built
// once, never torn down; gain nodes handle mute/mode-select" shape as
// every other CONTINUOUS_KINDS-style voice. Runs its own lookahead
// scheduler regardless of whether this mode is currently selected (see
// audio/graph.ts's own mode-select gain stage) — simplest, avoids
// rebuilding the scheduler on every mode switch, at the cost of a little
// wasted CPU while inactive.
export function startVocodeGranularVoice(input: AudioNode): VocodeGranularVoiceControls {
  const ctx = getAudioContext();

  const analyser = ctx.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0; // grain content should read the raw live signal, not a temporally-smoothed version
  input.connect(analyser);
  const scratch = new Float32Array(analyser.fftSize);

  const outputGate = ctx.createGain();

  let f0 = 110;
  let targetPitch = 110;
  let nextGrainTime = ctx.currentTime;

  function scheduleGrain(when: number): number {
    const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, targetPitch / Math.max(1, f0)));
    const periodSeconds = 1 / Math.max(MIN_F0_HZ, f0);
    const windowSeconds = Math.min(MAX_WINDOW_SECONDS, Math.max(MIN_WINDOW_SECONDS, periodSeconds * WINDOW_PERIODS));
    const windowSamples = Math.max(64, Math.min(analyser.fftSize, Math.round(windowSeconds * ctx.sampleRate)));

    analyser.getFloatTimeDomainData(scratch);
    const grainBuffer = ctx.createBuffer(1, windowSamples, ctx.sampleRate);
    grainBuffer.copyToChannel(scratch.subarray(scratch.length - windowSamples), 0);

    const source = ctx.createBufferSource();
    source.buffer = grainBuffer;
    source.playbackRate.value = rate;

    // windowSeconds is the BUFFER's own (unresampled) duration; playbackRate
    // is what stretches/compresses it in output time — same relationship
    // audio/grainPlayer.ts's own scheduleGrain relies on.
    const outputDuration = windowSeconds / rate;
    const fade = Math.max(0.001, outputDuration * ENVELOPE_FADE_FRACTION);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(1, when + fade);
    env.gain.setValueAtTime(1, Math.max(when + fade, when + outputDuration - fade));
    env.gain.linearRampToValueAtTime(0, when + outputDuration);

    source.connect(env);
    env.connect(outputGate);
    source.start(when);
    // No explicit cleanup — same "garbage-collected once playback ends and
    // nothing else references it" convention as audio/grainPlayer.ts's own
    // scheduleGrain.

    // Read fresh from the live tap every grain (not a fixed buffer being
    // advanced through at a separate rate) — see this file's own header for
    // why this one formula alone guarantees gap-free overlapped coverage
    // regardless of rate, with no separate source-read-position to track.
    const hop = outputDuration * (1 - OVERLAP_FRACTION);
    return Math.max(MIN_HOP_SECONDS, hop);
  }

  function tick(): void {
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_SECONDS;
    while (nextGrainTime < horizon) {
      nextGrainTime += scheduleGrain(nextGrainTime);
    }
  }

  tick();
  const timerId = setInterval(tick, LOOKAHEAD_INTERVAL_MS);

  return {
    setF0: (hz: number) => {
      f0 = hz;
    },
    setTargetPitch: (hz: number) => {
      targetPitch = hz;
    },
    outputGate,
    stop: () => {
      clearInterval(timerId);
      input.disconnect(analyser);
      outputGate.disconnect();
    },
  };
}
