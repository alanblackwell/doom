// Canvas position doubles as a stereo mixing surface: left/right placement
// sets pan, up/down sets volume — "drag it lower to turn it down." Pan is
// unconditionally derived from x — no override, no wire, nothing else ever
// sets it. Volume ('level') is more contested: three things can determine
// it, in priority order —
//   1. an incoming control wire (ui/wiring.ts) — always wins outright.
//   2. a direct manual drag of the level control dot — sticks (canvas
//      position is ignored) until the entity is dragged again.
//   3. canvas y position — the default, and what resumes the moment that
//      drag-again happens.
//
// Deliberately its own module: this is UI-layer POLICY (which of those
// three wins, and how position maps to a value at all) layered on top of
// audio/graph.ts's mechanism (setPan, and the existing per-kind 'level'
// control setter/getControlSetter) and ui/wiring.ts's existing data.

import type { EntityGraph } from '../audio/entityGraph';
import type { Point } from './layout';
import { controlsFor } from './controlSpecs';
import { getWireTo } from './wiring';
import { getControlSetter, setPan } from '../audio/graph';

// Entities whose 'level' is currently pinned to wherever the user last left
// the slider, rather than tracking canvas y — cleared the moment that
// entity is dragged again (see clearLevelOverride, called from
// ui/interaction.ts's drag-start).
const levelOverridden = new Set<string>();

export function markLevelOverridden(entityId: string): void {
  levelOverridden.add(entityId);
}

export function clearLevelOverride(entityId: string): void {
  levelOverridden.delete(entityId);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// The viewport (canvas's scroll container — see index.html/ui/dock.ts's own
// viewportEl) is the fixed reference frame for both axes below, not the
// (potentially much larger, scrollable) full canvas content — using content
// width/height would mean every existing entity's pan/level silently drifts
// whenever some unrelated entity far away grows the content bounds, and
// scrolling the viewport would shift them too. Anchored to canvas-content
// coordinate (0, 0) regardless of current scroll position, so only actually
// dragging an entity changes its own mix values. Exported so ui/render.ts's
// overlay (drawMixModificationOverlay) reads the exact same reference frame.
export function viewportSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const viewport = canvas.parentElement as HTMLElement;
  return { width: viewport.clientWidth, height: viewport.clientHeight };
}

// Shape of the position → modification curve: flat near the center (small
// movements there barely change anything), curving increasingly steeply
// toward the edges, reaching full effect at the edge itself. A plain odd
// power does exactly that — cubic is a reasonable, tunable default; raise
// this for an even flatter center / steeper edge rolloff.
const MIX_CURVE_EXPONENT = 3;

function nonlinearModifier(t: number): number {
  const clamped = clamp(t, -1, 1);
  return Math.sign(clamped) * Math.abs(clamped) ** MIX_CURVE_EXPONENT;
}

// pos normalized against span into -1 (at 0)..+1 (at span), then reshaped
// by the curve above — 0 at the center, ±1 exactly at (or past) either
// edge. Exported so ui/render.ts's overlay samples precisely the same
// function the real pan/level mapping below uses, rather than risking the
// visualization silently drifting out of sync with actual behavior.
export function positionModifier(pos: number, span: number): number {
  if (span <= 0) return 0;
  return nonlinearModifier((pos / span) * 2 - 1);
}

// -1 (hard left) at content-x 0 to +1 (hard right) at the viewport's width,
// flat/near-0 (centered) through the middle — see positionModifier.
function panFromX(x: number, viewportWidth: number): number {
  return positionModifier(x, viewportWidth);
}

// Top of the viewport is loudest, bottom is quietest, flat (the range's own
// midpoint — "no effect") through the middle. Mapped into the kind's own
// level range (controlsFor), not a fixed 0-1, since that range varies by
// kind (see controlSpecs.ts) — y is inverted first (top = +1) since
// positionModifier's own +1 end is naturally the high-pos/bottom edge.
function levelFromY(y: number, viewportHeight: number, min: number, max: number): number {
  const m = -positionModifier(y, viewportHeight);
  const mid = (min + max) / 2;
  return mid + m * ((max - min) / 2);
}

// Applies canvas position to an entity's pan (always) and 'level' (unless
// overridden by a wire or a manual slider drag — see the priority order
// above). Called continuously during a box drag, with the live cursor-
// following position (before it's committed to entity.x/y), and once more
// on drop — see ui/interaction.ts. Also called once by ui/sampleDrop.ts
// when a dropped file lands at its initial position, for the same "canvas
// position determines the mix" behavior a freshly-placed entity should get
// immediately rather than defaulting to center/whatever level.ts's fallback
// happens to be.
export function applyPositionToMix(
  graph: EntityGraph,
  canvas: HTMLCanvasElement,
  entityId: string,
  absolutePos: Point
): void {
  const entity = graph.get(entityId);
  // Pan/level only mean anything for a Source's own audio — a Control
  // (knob/clock/tap) or Feature has no AudioNode of its own to position.
  if (!entity || entity.type !== 'source') return;

  const { width, height } = viewportSize(canvas);

  setPan(entityId, panFromX(absolutePos.x, width));

  if (levelOverridden.has(entityId)) return;
  if (getWireTo(entityId, 'level')) return; // wire always wins, independent of override state

  const levelSpec = controlsFor(entity.kind).find((s) => s.param === 'level');
  if (!levelSpec) return; // this kind has no volume control at all (e.g. a bare mixer/group)

  const value = levelFromY(absolutePos.y, height, levelSpec.min, levelSpec.max);
  entity.params.level = value;
  getControlSetter(entityId, 'level')?.(value);
}
