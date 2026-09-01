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

const HANDLE_INSET = 14; // mirrors controlSpecs.ts's DOT_INSET, for visual symmetry

// Bottom-left corner of the bounding box — mirrors dotPosition's bottom-right
// convention for a knob's own value dot, so the two anchors sit symmetrically
// rather than colliding.
export function wireHandlePosition(bounds: Rect): Point {
  return {
    x: bounds.x - bounds.width / 2 + HANDLE_INSET,
    y: bounds.y + bounds.height / 2 - HANDLE_INSET,
  };
}

const HANDLE_HIT_RADIUS = 10;

export function hitTestWireHandle(
  graph: EntityGraph,
  point: Point,
  drag?: DragContext
): { entityId: string } | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'control') continue;
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
