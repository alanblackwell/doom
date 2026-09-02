// Shared geometry for the "sagging cable" wire curve drawn between a
// source's bump and a target's dot/pad (ui/render.ts's drawWireLine) — the
// single source of truth for both drawing it and hit-testing a right-click
// against it (ui/interaction.ts), so the invisible hit region always
// matches the visible curve exactly.

import type { EntityGraph } from '../audio/entityGraph';
import { effectiveBounds } from './layout';
import type { DragContext, Point } from './layout';
import { controlDotAbsolutePosition } from './controls';
import { wireHandlePosition } from './knobs';
import type { Wire } from './wiring';
import type { EventWire } from './eventWiring';

// Same curve shape drawWireLine draws: control point offset below the
// midpoint, proportional to the span but capped, so short wires don't sag
// disproportionately.
export function wireCurveControlPoint(from: Point, to: Point): Point {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2 + Math.min(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.15),
  };
}

export interface WireEndpoints {
  from: Point;
  to: Point;
}

// A value wire's endpoints right now — null if either entity, or the
// target's specific dot, no longer exists (entity deleted, kind changed).
// `drag` (optional) keeps this consistent with whatever live drag-preview
// bounds are currently showing (see layout.ts's DragContext), same as every
// other bounds-dependent lookup in the app — omitted entirely by
// interaction.ts's right-click hit-test, where nothing is ever mid-drag.
export function valueWireEndpoints(graph: EntityGraph, wire: Wire, drag?: DragContext): WireEndpoints | null {
  const source = graph.get(wire.sourceEntityId);
  const target = graph.get(wire.targetEntityId);
  if (!source || !target) return null;
  const to = controlDotAbsolutePosition(graph, wire.targetEntityId, wire.targetParam, drag);
  if (!to) return null;
  return { from: wireHandlePosition(effectiveBounds(graph, source, drag)), to };
}

// An event wire's endpoints — anchored to the target's own center (its
// whole pad is the drop target, not a specific dot; see ui/eventWiring.ts).
export function eventWireEndpoints(graph: EntityGraph, wire: EventWire, drag?: DragContext): WireEndpoints | null {
  const source = graph.get(wire.sourceEntityId);
  const target = graph.get(wire.targetEntityId);
  if (!source || !target) return null;
  const targetBounds = effectiveBounds(graph, target, drag);
  return {
    from: wireHandlePosition(effectiveBounds(graph, source, drag)),
    to: { x: targetBounds.x, y: targetBounds.y },
  };
}

// Generous invisible hit-band either side of the (thin, 2px-drawn) curve —
// right-clicking a wire shouldn't need pixel precision.
const WIRE_HIT_TOLERANCE = 10;

export function hitTestWireCurve(
  ctx: CanvasRenderingContext2D,
  { from, to }: WireEndpoints,
  point: Point
): boolean {
  const control = wireCurveControlPoint(from, to);
  const path = new Path2D();
  path.moveTo(from.x, from.y);
  path.quadraticCurveTo(control.x, control.y, to.x, to.y);

  ctx.save();
  ctx.lineWidth = WIRE_HIT_TOLERANCE;
  const hit = ctx.isPointInStroke(path, point.x, point.y);
  ctx.restore();
  return hit;
}
