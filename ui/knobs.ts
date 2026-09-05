// Geometry for Control-type entities (currently just 'knob') — the circular
// body, its rotating value indicator, and the separate "drag start point"
// handle a wire is dragged from. Parallel to pads.ts/controlSpecs.ts:
// dot-based parameter control reuses the existing control-dot mechanism
// entirely (a knob's own value is just another control spec, see
// controlSpecs.ts's 'knob' entry) — this module only owns what's genuinely
// new: the knob's own circular shape and its wire-output handle.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { effectiveBounds } from './layout';
import type { DragContext, Point, Rect } from './layout';

export function knobRadius(bounds: Rect): number {
  return Math.min(bounds.width, bounds.height) / 2;
}

// -135°..+135° sweep (0 = straight up), the standard analog-knob
// convention — min at lower-left, max at lower-right, through top-center.
export function knobIndicatorAngle(value01: number): number {
  const clamped = Math.min(1, Math.max(0, value01));
  return ((-135 + clamped * 270) * Math.PI) / 180;
}

// Radius of the little bump the wire-output handle is drawn as, protruding
// out of the knob's body — see drawKnob in render.ts.
export const WIRE_BUMP_RADIUS = 6;

// Center of the output bump, on the knob's right-hand edge — mostly outside
// the body's own circle (only OVERLAP back in, so it visually joins the
// body rather than floating free of it).
const WIRE_BUMP_OVERLAP = 2;
export function wireHandlePosition(bounds: Rect): Point {
  const radius = knobRadius(bounds);
  return {
    x: bounds.x + radius + WIRE_BUMP_RADIUS - WIRE_BUMP_OVERLAP,
    y: bounds.y,
  };
}

// The knob's own value dot/slider (see controlSpecs.ts's 'knob' entry) sits
// at the body's center — where the rotating indicator pivots from — rather
// than the generic per-kind dot column's corner position, which a knob has
// no room for at this size.
export function knobValueDotPosition(bounds: Rect): Point {
  return { x: bounds.x, y: bounds.y };
}

const HANDLE_HIT_RADIUS = 10; // generous click target — bigger than the bump actually drawn

export function hitTestWireHandle(
  graph: EntityGraph,
  point: Point,
  drag?: DragContext
): { entityId: string } | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'control') continue;
    // The sequencer (ui/sequencer.ts) is a control entity too, but has no
    // single shared output bump the way knob/clock/tap do — Phase 1 draws
    // no bump for it at all (see ui/sequencer.ts's drawSequencerBody), and
    // its eventual per-channel ports (TODO.md's Phase 3) will be their own
    // dedicated multi-port hit-test, not this one-bump-per-entity path.
    // Without this, wireHandlePosition would still return an invisible,
    // clickable phantom handle near its edge.
    if (entity.kind === 'sequencer') continue;
    const bounds = effectiveBounds(graph, entity, drag);
    const handle = wireHandlePosition(bounds);
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= HANDLE_HIT_RADIUS) {
      return { entityId: entity.id };
    }
  }
  return null;
}

export function isControlEntity(entity: Entity): boolean {
  return entity.type === 'control';
}

// Circular hit-test against a control entity's actual drawn body (the
// inscribed circle of `bounds`) — used for the tap entity's click-to-fire,
// where the whole body is the button rather than a smaller inset pad
// (contrast ui/pads.ts's TRIGGERED_KINDS pad, which is deliberately smaller
// than its box).
export function withinControlBody(bounds: Rect, point: Point): boolean {
  return Math.hypot(point.x - bounds.x, point.y - bounds.y) <= knobRadius(bounds);
}
