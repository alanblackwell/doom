// Granular-sample-cloud engine for the 'grain' source voice (audio/graph.ts's
// 'grain' case) — a wholly different grain SOURCE from audio/grindPlayer.ts's
// own granular voice: grind's grains are cut from generated white noise
// (no material to choose from, only filter/timing chaos), where grain's own
// grains are cut from a real captured sample (ui/grainSampler.ts's popup —
// drag a source in, its captured audio's spectrogram is shown, click to drop
// point markers on it) — the character comes from THAT recording's own
// timbre at the point(s) picked, not from a filter shaping noise.
//
// Free-running: once at least one point exists (and a buffer's been
// captured), grains stream continuously at a rate set by `density`, each
// independently picking ONE of the current points at random (uniformly — no
// per-point weighting, an explicit scope decision so a point stays a plain
// position marker, nothing more) and reading a short window of the captured
// buffer starting there. No points, or no buffer yet: silence, same as
// grind's own "runs for the app's lifetime, nothing to schedule yet" idle
// state, not a fallback tone.
//
// Same lookahead-scheduler shape as audio/grindPlayer.ts (LOOKAHEAD_INTERVAL_MS/
// SCHEDULE_AHEAD_SECONDS, sample-accurate ctx-time scheduling) and the same
// GRAIN_TUNING-constants-vs-control-dot split: `level`/`density`/`grainLength`
// are audio/graph.ts's own control-dots (see ui/controlSpecs.ts's 'grain'
// entry), everything below is tuned by eye/ear in this file only for now —
// no by-ear tuning organelle (ui/tuningOrganelle.ts) built for this voice
// yet, unlike grind/bass/metal, since this task was scoped to the
// spectrogram+points editor and this engine only. A natural follow-up.

import { getAudioContext } from './context';

const LOOKAHEAD_INTERVAL_MS = 25; // matches audio/grindPlayer.ts's own tick rate
const SCHEDULE_AHEAD_SECONDS = 0.1;

// A single point placed on the popup's spectrogram (ui/grainSampler.ts).
// `y` is carried here (not just in the UI layer) so a live control-wire
// change to `density`/`grainLength` doesn't need to round-trip through the
// popup module to know what to render — but it is NOT read by scheduleGrain
// below: every point currently just marks a TIME offset into the captured
// buffer, full-band, regardless of where it was clicked vertically. A
// later per-point bandpass-by-height idea (see TODO.md) would read it.
export interface GrainPoint {
  id: string;
  timeSeconds: number;
  y: number; // 0 (top of the popup's spectrogram band) .. 1 (bottom) — cosmetic only, see above
}

export interface GrainTuningParam {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  description: string;
}

// Internal-only constants (no control-dot, no tuning organelle yet — see
// this file's own header) — tuned by ear against a handful of test
// captures, not derived from anything.
export const GRAIN_TUNING: Record<string, GrainTuningParam> = {
  positionJitterSeconds: {
    value: 0.015,
    min: 0,
    max: 0.1,
    step: 0.001,
    label: 'position jitter',
    description: "Random +/- offset (seconds) applied to a grain's own read position around whichever point it picked, so repeated grains from the same point don't read as an identical, looping fragment.",
  },
  pitchJitterFraction: {
    value: 0.04,
    min: 0,
    max: 0.3,
    step: 0.01,
    label: 'pitch jitter',
    description: "Random +/- playback-rate variation per grain, as a fraction of normal speed — keeps a dense cloud from all its grains reading as one exactly-repeating pitch.",
  },
  envelopeFadeFraction: {
    value: 0.25,
    min: 0.05,
    max: 0.5,
    step: 0.01,
    label: 'envelope fade',
    description: "Fraction of each grain's own (randomized-by-grainLength) duration spent fading in and fading back out, so no grain clicks at its own edges — same trapezoid-envelope idea as audio/grindPlayer.ts's own grainFade, just expressed as a fraction of a variable length rather than a fixed seconds value.",
  },
  intervalAtDensity0: {
    value: 0.12,
    min: 0.01,
    max: 0.4,
    step: 0.001,
    label: 'interval @ density=0',
    description: 'Gap between grains, in seconds, at density=0 — sparse, individually audible grains.',
  },
  intervalAtDensity1: {
    value: 0.008,
    min: 0.001,
    max: 0.1,
    step: 0.001,
    label: 'interval @ density=1',
    description: 'Gap between grains, in seconds, at density=1 — a dense, continuous cloud/texture.',
  },
  intervalJitterFraction: {
    value: 0.3,
    min: 0,
    max: 1,
    step: 0.01,
    label: 'interval jitter',
    description: 'Random +/- variation on the grain interval, as a fraction of it — keeps even a fixed density from locking into an audible periodic tick, same reasoning as grindIntervalJitter.',
  },
};

export const GRAIN_TUNING_KEYS = Object.keys(GRAIN_TUNING);

function randomBetween(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function pickRandomPoint(points: GrainPoint[]): GrainPoint {
  return points[Math.floor(Math.random() * points.length)];
}

// `params` is this voice's own live per-instance state (GRAIN_TUNING's keys
// plus density/grainLength) — read fresh on every grain rather than closed
// over, same reasoning as audio/grindPlayer.ts's own scheduleGrain.
function scheduleGrain(
  ctx: AudioContext,
  destination: AudioNode,
  when: number,
  buffer: AudioBuffer,
  points: GrainPoint[],
  params: Record<string, number>
): void {
  const point = pickRandomPoint(points);
  const duration = Math.max(0.005, params.grainLength);
  const jitter = randomBetween(-params.positionJitterSeconds, params.positionJitterSeconds);
  const offset = Math.max(0, Math.min(Math.max(0, buffer.duration - duration), point.timeSeconds + jitter));

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = randomBetween(1 - params.pitchJitterFraction, 1 + params.pitchJitterFraction);

  const fade = Math.max(0.001, duration * params.envelopeFadeFraction);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(1, when + fade);
  env.gain.setValueAtTime(1, Math.max(when + fade, when + duration - fade));
  env.gain.linearRampToValueAtTime(0, when + duration);

  source.connect(env);
  env.connect(destination);

  source.start(when, offset, duration);
  // No explicit cleanup — same "garbage-collected once playback ends and
  // nothing else references it" convention as every other one-shot burst in
  // this codebase (audio/grindPlayer.ts's own scheduleGrain included).
}

export interface GrainVoiceControls {
  get: (key: string) => number;
  set: (key: string, value: number) => void;
  // Called by ui/grainSampler.ts whenever a capture finishes (a fresh
  // buffer) or the popup closes/re-arms (null) — a brand-new buffer also
  // implicitly invalidates every existing point's own meaning (their
  // timeSeconds were only ever offsets into the PREVIOUS buffer), so the
  // popup always calls setPoints([]) alongside this rather than leaving
  // stale points pointing at a buffer that's no longer there.
  setBuffer: (buffer: AudioBuffer | null) => void;
  setPoints: (points: GrainPoint[]) => void;
  stop: () => void;
}

// Starts a continuous grain-cloud voice feeding into `destination` (the
// entity's own level gain, same wiring convention as audio/grindPlayer.ts's
// own startGrindVoice). Runs for the app's lifetime once started — same
// "nodes built once, never torn down; pause/dock mutes via a gain node"
// CONTINUOUS_KINDS model every other drone voice already uses (see
// audio/graph.ts's rebuildEntity, which calls stop() on a drag-out-of-dock
// rebuild before starting a fresh instance).
export function startGrainVoice(destination: AudioNode, initialParams: Record<string, number>): GrainVoiceControls {
  const ctx = getAudioContext();
  const params: Record<string, number> = {};
  for (const key of GRAIN_TUNING_KEYS) {
    params[key] = initialParams[key] ?? GRAIN_TUNING[key].value;
  }
  params.density = Math.max(0, Math.min(1, initialParams.density ?? 0.4));
  params.grainLength = initialParams.grainLength ?? 0.08;

  let buffer: AudioBuffer | null = null;
  let points: GrainPoint[] = [];
  let nextGrainTime = ctx.currentTime;

  function tick(): void {
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_SECONDS;
    // Nothing to draw grains from yet — advance the clock to the horizon
    // rather than leaving nextGrainTime stalled in the past, so a point
    // placed (or a buffer captured) moments from now starts producing
    // grains immediately instead of bursting through a backlog of
    // "missed" grain times accumulated while idle.
    if (!buffer || points.length === 0) {
      nextGrainTime = horizon;
      return;
    }
    while (nextGrainTime < horizon) {
      scheduleGrain(ctx, destination, nextGrainTime, buffer, points, params);
      const interval =
        params.intervalAtDensity0 - (params.intervalAtDensity0 - params.intervalAtDensity1) * params.density;
      const jitter = interval * params.intervalJitterFraction;
      nextGrainTime += Math.max(0.001, interval + randomBetween(-jitter, jitter));
    }
  }

  tick();
  const timerId = setInterval(tick, LOOKAHEAD_INTERVAL_MS);

  return {
    get: (key: string) => params[key],
    set: (key: string, value: number) => {
      params[key] = key === 'density' ? Math.max(0, Math.min(1, value)) : value;
    },
    setBuffer: (next: AudioBuffer | null) => {
      buffer = next;
    },
    setPoints: (next: GrainPoint[]) => {
      points = next;
    },
    stop: () => clearInterval(timerId),
  };
}
