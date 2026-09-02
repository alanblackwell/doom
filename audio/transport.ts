// Master clock (ARCHITECTURE.md §5.3): a lookahead scheduler that ticks at
// precise AudioContext.currentTime offsets, independent of JS timer jitter,
// so anything scheduled against it — currently the clock entity's
// beat-pulse glow (ui/clockPulse.ts) and the tap entity's single-shot
// events (ui/interaction.ts's fireTap) — gets sample-accurate timing rather
// than firing whenever its own event happens to arrive. Owns no audio
// nodes itself, matching
// audio/context.ts's plain-module-singleton style rather than a class.

import { getAudioContext } from './context';

// Fixed 16th-note tick grid for now. Beat-level pulse/fill pattern engines
// (ARCHITECTURE.md §5.3) are future work built on top of this clock, not
// part of it — this module only owns "when is the next tick," not what
// plays on it or which ticks matter musically.
export const SUBDIVISIONS_PER_BEAT = 4;

const DEFAULT_BPM = 80; // slow, genre-appropriate default; adjustable via the clock-1 entity's own control dot

// Classic lookahead-scheduler constants (Chris Wilson's "A Tale of Two
// Clocks"): a cheap JS timer wakes often (LOOKAHEAD_INTERVAL_MS) and each
// wake schedules any tick whose target time falls within the next
// SCHEDULE_AHEAD_SEC of ctx.currentTime — so actual event timing rides on
// the audio clock, not on JS timer jitter.
const LOOKAHEAD_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.1;

type TickListener = (tick: number, time: number) => void;

let bpm = DEFAULT_BPM;
let timerId: ReturnType<typeof setInterval> | null = null;
let nextTickTime = 0; // ctx.currentTime (seconds) the next unscheduled tick lands at
let tickNumber = 0;
const listeners = new Set<TickListener>();

export function setTempo(newBpm: number): void {
  bpm = Math.max(1, newBpm);
}

export function getTempo(): number {
  return bpm;
}

function secondsPerTick(): number {
  return 60 / bpm / SUBDIVISIONS_PER_BEAT;
}

function scheduler(): void {
  const ctx = getAudioContext();
  while (nextTickTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
    for (const listener of listeners) listener(tickNumber, nextTickTime);
    tickNumber += 1;
    nextTickTime += secondsPerTick();
  }
}

// Starts the clock fresh from tick 0 every time — no phase continuity
// across stop()/start() (e.g. an audio suspend/resume cycle). Acceptable
// for now; revisit if a later feature needs bar-position memory across a
// stop.
export function start(): void {
  if (timerId !== null) return;
  const ctx = getAudioContext();
  tickNumber = 0;
  nextTickTime = ctx.currentTime;
  scheduler(); // fire immediately so tick 0 doesn't wait a full lookahead interval
  timerId = setInterval(scheduler, LOOKAHEAD_INTERVAL_MS);
}

export function stop(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

export function isRunning(): boolean {
  return timerId !== null;
}

export function onTick(listener: TickListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Schedules a one-off callback for the earliest time the lookahead
// scheduler can still guarantee jitter-free precision (the same
// SCHEDULE_AHEAD_SEC window the recurring tick grid uses above), rather
// than a beat-grid position — for an ad-hoc event (e.g. a tap controller)
// that isn't quantized to the beat. The callback fires via setTimeout
// deferred to that AudioContext time, the same technique
// ui/clockPulse.ts uses for beat flashes, centralized here so future event
// sources (pitch/velocity) reuse it instead of re-deriving the
// defer-to-ctx.currentTime math themselves.
export function scheduleSoon(callback: (time: number) => void): void {
  const ctx = getAudioContext();
  const time = ctx.currentTime + SCHEDULE_AHEAD_SEC;
  setTimeout(() => callback(time), SCHEDULE_AHEAD_SEC * 1000);
}
