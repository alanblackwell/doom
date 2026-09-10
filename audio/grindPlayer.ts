// Granular noise engine for the 'grind' source voice (audio/graph.ts's
// 'grind' case) — TODO.md's "doom/industrial/drone sound palette" item 1.
//
// Not a physical model: an earlier attempt reused 'bow's own bowed-string
// WASM voice (dsp/rust/src/lib.rs) driven with a bowVelocity well outside
// the ~0.03-0.25 range that voice's own comments call "playable," on the
// theory that pushing it past that edge would produce chaotic scraping.
// It didn't — it just settled into a different steady tone, because a
// physical model's chaos (if any) is notoriously sensitive to its exact
// operating point, not something a static parameter guess reliably lands
// in. This is a different approach entirely: a dense, randomized stream of
// short noise grains, each through its own jittered bandpass filter — the
// same "many small irregular scrapes" structure a real grinding wheel or
// chainsaw actually has, chaotic BY CONSTRUCTION (every grain's timing,
// filter center, and playback rate is independently randomized) rather
// than emergent from a feedback loop that may or may not cooperate.
//
// Native Web Audio nodes only (AudioBufferSourceNode/BiquadFilterNode/
// GainNode) — no WASM/Rust needed for this one. Grains are scheduled
// precisely via AudioContext time (sample-accurate regardless of JS timer
// jitter), same lookahead-scheduler shape as audio/sequencerPlayer.ts's own
// note dispatch — see this file's own LOOKAHEAD_INTERVAL_MS.
//
// GRIND_TUNING below holds every constant this engine needs BY EAR, not by
// formula — there's no physical ground truth for "how long should a grain
// be," only what actually sounds right. ui/grindTuner.ts is the organelle
// popup (porthole on the 'grind' source itself) that turns these into live
// sliders: dragging one calls the same getControlSetter/entity.params path
// a wired control-dot drag would (see audio/graph.ts's 'grind' case, which
// registers a control setter for EVERY key here unconditionally, not just
// the ones with `exposed: true`) — so every constant here is tunable live
// by ear from day one, whether or not it also has a permanent control-dot.
// `exposed` only decides whether ui/controlSpecs.ts's static 'grind' entry
// (deliberately audio/*-independent — see that file's own header) should
// also carry a ControlSpec for it; there's no way to make that happen
// automatically without a source edit, which is exactly what the popup's
// own Copy button produces — see ui/grindTuner.ts's buildGrindTuningCopyText.

import { getAudioContext } from './context';

const LOOKAHEAD_INTERVAL_MS = 25; // matches audio/sequencerPlayer.ts's own tick rate
const SCHEDULE_AHEAD_SECONDS = 0.1; // how far into the future each tick schedules grains

export interface GrindTuningParam {
  value: number; // current factory default — what a fresh instance seeds from
  min: number;
  max: number;
  step: number; // UI drag/readout granularity only, not enforced on live control-wire input
  label: string; // shown in ui/grindTuner.ts's popup and as a ControlSpec label if exposed
  exposed: boolean; // whether ui/controlSpecs.ts's 'grind' entry currently also lists this as a control-dot (kept in sync by hand — see this file's own header)
  description: string; // shown as a hover tooltip over the label in ui/grindTuner.ts's popup — how this constant relates to scheduleGrain's own algorithm below, written to double as a source comment
}

// Order here is the popup's own row order (ui/grindTuner.ts iterates
// Object.keys) — grouped by what they shape (grain shape, then grain
// timing, then filter) rather than alphabetically, so related knobs sit
// together.

export const GRIND_TUNING: Record<string, GrindTuningParam> = {
  grainMinDuration: { value: 0.068, min: 0.005, max: 0.1, step: 0.001, label: 'grain min duration', exposed: false, description: "Shortest a grain's own randomized duration can be, in seconds — see scheduleGrain's randomBetween(grainMinDuration, grainMaxDuration)." },
  grainMaxDuration: { value: 0.165, min: 0.01, max: 0.2, step: 0.001, label: 'grain max duration', exposed: false, description: "Longest a grain can be, in seconds — shorter grains read as buzzier/grittier, longer ones as more individual scrapes." },
  grainFade: { value: 0.0044, min: 0.0005, max: 0.02, step: 0.0005, label: 'grain fade', exposed: false, description: "Fixed linear fade-in/out applied to every grain's own envelope regardless of its randomized duration, so no grain clicks at its own edges." },
  grainIntervalMax: { value: 0.097, min: 0.01, max: 0.3, step: 0.001, label: 'interval @ grind=0', exposed: false, description: "Gap between grains, in seconds, at grind=0 — the sparsest end of the density range grind lerps between (see the tick() loop below)." },
  grainIntervalMin: { value: 0.016, min: 0.001, max: 0.05, step: 0.001, label: 'interval @ grind=1', exposed: false, description: "Gap between grains, in seconds, at grind=1 — the densest, most continuous-roar end of that same range." },
  grainIntervalJitter: { value: 0.28, min: 0, max: 1, step: 0.01, label: 'interval jitter', exposed: false, description: "Random +/- variation on the grain interval, as a fraction of it — keeps even a fixed grind amount from locking into an audible periodic tick." },
  grainFilterQ: { value: 6.1, min: 0.5, max: 30, step: 0.1, label: 'filter Q', exposed: false, description: "Resonance (Q) of each grain's own bandpass filter — higher makes a grain read as a narrow pitched shriek around frequency, lower as broadband hiss." },
  filterJitter: { value: 0.26, min: 0, max: 1, step: 0.01, label: 'filter jitter', exposed: false, description: "How far a grain's own filter center wanders from frequency, as a fraction either way, scaled by grind too — more grind means more pitch chaos, not just more grains." },
};

export const GRIND_TUNING_KEYS = Object.keys(GRIND_TUNING);

function randomBetween(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

let sharedNoiseBuffer: AudioBuffer | null = null;

// One shared source buffer for every grind voice's grains — a few seconds
// of plain white noise, generated once and reused. Each grain reads a
// random offset out of it (see scheduleGrain below) rather than needing
// its own buffer — there's nothing voice-specific baked into the raw
// noise itself, only in how each grain's filter/rate/timing is chosen.
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (sharedNoiseBuffer) return sharedNoiseBuffer;
  const seconds = 4;
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  sharedNoiseBuffer = buffer;
  return buffer;
}

// `params` is this voice's own live per-instance state (GRIND_TUNING's keys
// plus frequency/grind) — see startGrindVoice below. Reads it fresh on
// every grain rather than closing over individual values, so a live tuning
// change (from the organelle popup or a wired control) always affects the
// very next grain.
function scheduleGrain(ctx: AudioContext, destination: AudioNode, when: number, params: Record<string, number>): void {
  const buffer = noiseBuffer(ctx);
  const duration = randomBetween(params.grainMinDuration, params.grainMaxDuration);
  const offset = Math.random() * Math.max(0, buffer.duration - duration);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // A little playback-rate jitter too — otherwise every grain reads the
  // same raw noise character at the same rate, which can read as a subtle
  // repeating texture despite the randomized start offset.
  source.playbackRate.value = randomBetween(0.85, 1.15);

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = params.grainFilterQ;
  const jitterFraction = params.filterJitter * params.grind;
  filter.frequency.value = Math.max(20, params.frequency * (1 + randomBetween(-jitterFraction, jitterFraction)));

  // A fixed-shape trapezoid envelope per grain — cheaper and simpler than an
  // AudioBufferSourceNode's own native fade would be to arrange, and every
  // grain needs exactly the same shape regardless of its randomized duration.
  const fade = params.grainFade;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(1, when + fade);
  env.gain.setValueAtTime(1, Math.max(when + fade, when + duration - fade));
  env.gain.linearRampToValueAtTime(0, when + duration);

  source.connect(filter);
  filter.connect(env);
  env.connect(destination);

  source.start(when, offset, duration);
  // No explicit cleanup — an AudioBufferSourceNode (and the filter/gain it
  // feeds) is garbage-collected once playback ends and nothing else
  // references it, same as every other one-shot burst in this codebase
  // (e.g. kick's per-trigger noise voice in audio/graph.ts).
}

export interface GrindVoiceControls {
  get: (key: string) => number;
  set: (key: string, value: number) => void;
  stop: () => void;
}

// Starts a continuous granular grind texture feeding into `destination`
// (the entity's own level gain — audio/graph.ts's 'grind' case connects
// this the same way bass/bow connect their oscillator/WASM node directly).
// `initialParams` seeds this instance's own live state — GRIND_TUNING's
// keys default from GRIND_TUNING[key].value, frequency/grind from their own
// explicit fallbacks — so every instance starts independent (dragging one
// grind entity's tuning organelle never affects another's), even though
// they all start from the same factory defaults.
//
// Runs for the lifetime of the app once started, same "nodes built once,
// never torn down" model every other CONTINUOUS_KINDS voice already uses
// (see audio/graph.ts's deactivateEntity comment — pausing/docking mutes
// via a gain node rather than stopping generation); stop() is exposed for
// symmetry/future use even though nothing calls it today.
export function startGrindVoice(destination: AudioNode, initialParams: Record<string, number>): GrindVoiceControls {
  const ctx = getAudioContext();
  const params: Record<string, number> = {};
  for (const key of GRIND_TUNING_KEYS) {
    params[key] = initialParams[key] ?? GRIND_TUNING[key].value;
  }
  params.frequency = initialParams.frequency ?? 320;
  params.grind = Math.max(0, Math.min(1, initialParams.grind ?? 0.5));

  let nextGrainTime = ctx.currentTime;

  function tick(): void {
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_SECONDS;
    while (nextGrainTime < horizon) {
      scheduleGrain(ctx, destination, nextGrainTime, params);
      const interval =
        params.grainIntervalMax - (params.grainIntervalMax - params.grainIntervalMin) * params.grind;
      const jitter = interval * params.grainIntervalJitter;
      nextGrainTime += Math.max(0.001, interval + randomBetween(-jitter, jitter));
    }
  }

  tick();
  const timerId = setInterval(tick, LOOKAHEAD_INTERVAL_MS);

  return {
    get: (key: string) => params[key],
    set: (key: string, value: number) => {
      params[key] = key === 'grind' ? Math.max(0, Math.min(1, value)) : value;
    },
    stop: () => clearInterval(timerId),
  };
}
