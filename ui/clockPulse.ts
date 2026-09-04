// Beat-flash state for the clock entity's wire-output bump (see
// ui/render.ts's drawClock) — the on-canvas replacement for the old
// DOM-based metronome dot. Owns no DOM, no canvas drawing itself: just
// records precisely when each beat actually lands, for drawClock to read
// back as a fade-out glow. Also fires anything wired from the clock's own
// bump on every beat — the clock is an event source too (see
// ui/interaction.ts's unified pad-drop-target handling), just one that
// fires on a recurring schedule instead of a one-off tap/keypress.

import { getAudioContext } from '../audio/context';
import { onTick, SUBDIVISIONS_PER_BEAT } from '../audio/transport';
import { fireEventWireTargets } from './interaction';
import type { InteractionState } from './interaction';
import { recordSourcePulse } from './eventPulse';

export const FLASH_DURATION_MS = 150;

let lastBeatFlashAt = -Infinity;

function recordBeatFlash(): void {
  lastBeatFlashAt = performance.now();
}

// 1 right as a beat lands, fading linearly to 0 over FLASH_DURATION_MS —
// read each frame against the same rAF `now` ui/render.ts already threads
// through (performance.now()'s time base, like ui/interaction.ts's existing
// trigger-pad flash).
export function getBeatFlashGlow(now: number): number {
  const elapsed = now - lastBeatFlashAt;
  if (elapsed < 0 || elapsed > FLASH_DURATION_MS) return 0;
  return 1 - elapsed / FLASH_DURATION_MS;
}

export function attachClockPulse(entityId: string, state: InteractionState): void {
  onTick((tick, time) => {
    if (tick % SUBDIVISIONS_PER_BEAT !== 0) return; // downbeat only

    // Ticks are scheduled up to the scheduler's lookahead window into the
    // future, so acting synchronously here would make everything below
    // visibly anticipate the beat. Defer until AudioContext time actually
    // reaches `time` instead — see audio/transport.ts's SCHEDULE_AHEAD_SEC.
    const ctx = getAudioContext();
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      recordBeatFlash();
      recordSourcePulse(entityId, performance.now()); // ui/eventPulse.ts — animates any wire out of the clock's own bump
      fireEventWireTargets(entityId, state);
    }, delayMs);
  });
}
