// Slider/drag interaction geometry built on top of controlSpecs.ts's dot
// layout — hover reveals a label and a vertical slider positioned so the
// point representing the current value sits exactly where the dot was, so
// the cursor is already on the thumb, ready to drag. Deliberately minimal
// by default: this should read as a couple of quiet indicator dots, not a
// rack of visible knobs/faders.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { PROCESSOR_KINDS } from '../audio/graph';
import { effectiveBounds } from './layout';
import type { DragContext, Point } from './layout';
import { controlsFor, dotPosition, CONTROL_HIT_RADIUS, CONTROL_TRACK_LENGTH } from './controlSpecs';
import type { ControlSpec } from './controlSpecs';
import { isControlEntity, knobValueDotPosition } from './knobs';

// A knob's own dot sits at its body's center (see knobs.ts), not at
// controlSpecs.ts's generic per-kind column position — every other kind
// keeps the plain column layout.
export function dotPositionFor(entity: Entity, bounds: Point & { width: number; height: number }, index: number): Point {
  return isControlEntity(entity) ? knobValueDotPosition(bounds) : dotPosition(bounds, index);
}

export type { ControlSpec } from './controlSpecs';
export {
  controlsFor,
  dotPosition,
  CONTROL_DOT_OUTER_RADIUS,
  CONTROL_DOT_RADIUS,
  CONTROL_DOT_DROP_RADIUS,
  CONTROL_HIT_RADIUS,
  CONTROL_TRACK_LENGTH,
} from './controlSpecs';

export function valueFraction(spec: ControlSpec, value: number): number {
  return Math.min(1, Math.max(0, (value - spec.min) / (spec.max - spec.min)));
}

// Track geometry (fixed length, positioned so it grows and shrinks around
// the dot) such that the point representing `value` lands exactly at `dot`.
// Track runs bottom (min) to top (max) — standard vertical-fader convention.
export interface Track {
  x: number;
  top: number;
  bottom: number;
}

export function trackGeometry(dot: Point, spec: ControlSpec, value: number): Track {
  const fraction = valueFraction(spec, value);
  const bottom = dot.y + fraction * CONTROL_TRACK_LENGTH;
  return { x: dot.x, top: bottom - CONTROL_TRACK_LENGTH, bottom };
}

// A value-independent track anchor, unlike trackGeometry above (whose whole
// point is to land the CURRENT value exactly at the dot, so a hovering
// cursor is already on the thumb, ready to drag). Used wherever a slider is
// being driven externally rather than by the pointer at this dot — e.g. a
// wired control mirroring its live-changing source — so the track/scale
// stays fixed in place and only the thumb moves within it, the same as a
// real drag's fixed track does.
export function restTrackGeometry(dot: Point): Track {
  return { x: dot.x, top: dot.y - CONTROL_TRACK_LENGTH / 2, bottom: dot.y + CONTROL_TRACK_LENGTH / 2 };
}

// Inverse of trackGeometry's mapping, against a FIXED track captured once at
// drag-start (not recomputed from the live value mid-drag, which would be
// circular) — given where the pointer is now, what value does that mean.
export function valueFromTrackPosition(track: Track, spec: ControlSpec, pointerY: number): number {
  const fraction = Math.min(1, Math.max(0, (track.bottom - pointerY) / (track.bottom - track.top)));
  return spec.min + fraction * (spec.max - spec.min);
}

export interface ControlHit {
  entityId: string;
  spec: ControlSpec;
  dot: Point;
}

// Nearest dot (within CONTROL_HIT_RADIUS) under `point`, across every
// entity that has any control specs. `drag` (optional) keeps this
// consistent with whatever live drag-preview bounds are currently showing
// (see layout.ts's DragContext) — a control dot should hover/hit-test at
// wherever its box is actually drawn right now, expanded or not.
export function hitTestControl(
  graph: EntityGraph,
  point: Point,
  drag?: DragContext
): ControlHit | null {
  for (const entity of graph.all()) {
    if (entity.docked) continue; // no dots while parked in the dock — see ui/dock.ts
    const specs = controlsFor(entity.kind);
    if (specs.length === 0) continue;
    // Matches render.ts's drawControls: an empty filter's dots aren't
    // drawn, so they shouldn't be hit-testable either — no invisible
    // targets to stumble onto.
    if (PROCESSOR_KINDS.has(entity.kind) && graph.childrenOf(entity.id).length === 0) continue;

    const bounds = effectiveBounds(graph, entity, drag);
    for (let i = 0; i < specs.length; i++) {
      const dot = dotPositionFor(entity, bounds, i);
      if (Math.hypot(point.x - dot.x, point.y - dot.y) <= CONTROL_HIT_RADIUS) {
        return { entityId: entity.id, spec: specs[i], dot };
      }
    }
  }
  return null;
}

// Where a specific (entityId, param) dot is right now — used to draw a wire
// running into it (ui/wiring.ts) without the caller needing to know its
// index in that entity's control list.
export function controlDotAbsolutePosition(
  graph: EntityGraph,
  entityId: string,
  param: string,
  drag?: DragContext
): Point | null {
  const entity = graph.get(entityId);
  if (!entity) return null;
  const specs = controlsFor(entity.kind);
  const index = specs.findIndex((s) => s.param === param);
  if (index === -1) return null;
  return dotPositionFor(entity, effectiveBounds(graph, entity, drag), index);
}
