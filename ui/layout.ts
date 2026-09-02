// Position resolution and hit-testing over the entity graph's visual layout.
// Kept separate from render.ts (which only needs to draw, given resolved
// positions) and interaction.ts (which only needs to know what's under the
// pointer) — both depend on this, this depends on neither.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { controlsFor, dotPosition, CONTROL_HIT_RADIUS } from './controlSpecs';

export interface Point {
  x: number;
  y: number;
}

// Center-based rect in absolute canvas coordinates — what an entity actually
// occupies on screen once container expansion (below) is taken into account.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Absolute (canvas) position of an entity, resolved by walking up the parent
// chain — nested entities store x/y relative to their parent (see
// audio/entityGraph.ts), so a container's own position has to be added in.
export function absolutePosition(graph: EntityGraph, entity: Entity): Point {
  if (!entity.parentId) return { x: entity.x, y: entity.y };
  const parent = graph.get(entity.parentId);
  if (!parent) return { x: entity.x, y: entity.y };
  const parentPos = absolutePosition(graph, parent);
  return { x: parentPos.x + entity.x, y: parentPos.y + entity.y };
}

// Padding kept between a contained child's edge and its container's drawn
// boundary — the "fully within the border" margin, not just touching it.
const CONTAINMENT_PADDING = 24;

// Live drag state for bounds computation, so containers can grow/shrink in
// real time as a drag is still in progress rather than only snapping on
// drop. Two independent effects, both driven from the same drag:
//   - excludeId: the dragged entity is skipped wherever it structurally
//     still sits (it hasn't actually been reparented yet) — its real
//     container shrinks back down immediately once a drag starts.
//   - preview: if set, `intoId`'s bounds additionally include the dragged
//     entity's live (cursor-following) position, as a preview of what
//     dropping it there right now would produce. Left unset while
//     hit-testing for what the hover target even is (see hitTest below) —
//     only used for the actual draw pass, once that's already decided, to
//     avoid the circularity of "would growing this box catch the pointer."
export interface DragContext {
  excludeId: string;
  preview: { intoId: string; liveAbsolute: Point; entity: Entity } | null;
}

// An entity's actual on-screen rect: its own intrinsic width/height, grown
// (never shrunk) to fully enclose every child's own effective rect and its
// own control column (see below), with padding. Recursive, so a grandparent's
// box automatically accounts for an already-expanded parent — and
// recomputed fresh from current positions every call, so a container's
// boundary is always correct for whatever's inside it right now rather than
// needing an explicit resize step.
export function effectiveBounds(graph: EntityGraph, entity: Entity, drag?: DragContext): Rect {
  const pos = absolutePosition(graph, entity);
  let left = pos.x - entity.width / 2;
  let right = pos.x + entity.width / 2;
  let top = pos.y - entity.height / 2;
  let bottom = pos.y + entity.height / 2;

  const grow = (b: Rect) => {
    left = Math.min(left, b.x - b.width / 2 - CONTAINMENT_PADDING);
    right = Math.max(right, b.x + b.width / 2 + CONTAINMENT_PADDING);
    top = Math.min(top, b.y - b.height / 2 - CONTAINMENT_PADDING);
    bottom = Math.max(bottom, b.y + b.height / 2 + CONTAINMENT_PADDING);
  };

  // Reserve the entity's own control column (see controlSpecs.ts) as part
  // of its permanent minimum footprint — unconditional, not just extra
  // padding around children. Two things this fixes: a control-heavy entity
  // is never smaller than what it needs to show every dot without one
  // poking past the box edge, even with zero children; and, combined with
  // the same padding every child gets, something dropped in still has to
  // grow the box past the reserved corner rather than being able to land
  // exactly on top of it.
  // Skipped for control-type entities (knobs): their one dot sits at the
  // body's own center (see knobs.ts's knobValueDotPosition), not a column
  // poking out past the edge, so there's nothing to reserve room for — and
  // reserving it anyway would inflate the knob's drawn size well past its
  // actual width/height.
  const specs = controlsFor(entity.kind);
  if (specs.length > 0 && entity.type !== 'control') {
    const baseRect = { x: pos.x, y: pos.y, width: entity.width, height: entity.height };
    const bottomDot = dotPosition(baseRect, 0);
    const topDot = dotPosition(baseRect, specs.length - 1);
    grow({
      x: bottomDot.x,
      y: (bottomDot.y + topDot.y) / 2,
      width: CONTROL_HIT_RADIUS * 2,
      height: bottomDot.y - topDot.y + CONTROL_HIT_RADIUS * 2,
    });
  }

  for (const child of graph.childrenOf(entity.id)) {
    if (drag && drag.excludeId === child.id) continue; // lifted out mid-drag — don't count its stale position
    grow(effectiveBounds(graph, child, drag));
  }

  if (drag?.preview && drag.preview.intoId === entity.id) {
    const dragged = drag.preview.entity;
    // The dragged entity's own subtree bounds (at its stored position),
    // translated to where it's actually hovering right now — reusing the
    // same rigid-translation trick as render.ts's dragged-subtree drawing,
    // so a dragged container-with-children previews its true size, not
    // just its own base box.
    const draggedOwnBounds = effectiveBounds(graph, dragged, drag);
    const draggedActualPos = absolutePosition(graph, dragged);
    const dx = drag.preview.liveAbsolute.x - draggedActualPos.x;
    const dy = drag.preview.liveAbsolute.y - draggedActualPos.y;
    grow({
      x: draggedOwnBounds.x + dx,
      y: draggedOwnBounds.y + dy,
      width: draggedOwnBounds.width,
      height: draggedOwnBounds.height,
    });
  }

  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

export function containsPoint(
  graph: EntityGraph,
  entity: Entity,
  point: Point,
  drag?: DragContext
): boolean {
  const bounds = effectiveBounds(graph, entity, drag);
  const left = bounds.x - bounds.width / 2;
  const top = bounds.y - bounds.height / 2;
  return (
    point.x >= left &&
    point.x <= left + bounds.width &&
    point.y >= top &&
    point.y <= top + bounds.height
  );
}

function collectDescendantIds(graph: EntityGraph, id: string, out: Set<string>): void {
  const entity = graph.get(id);
  if (!entity) return;
  for (const childId of entity.children) {
    out.add(childId);
    collectDescendantIds(graph, childId, out);
  }
}

export function descendantIds(graph: EntityGraph, id: string): Set<string> {
  const out = new Set<string>();
  collectDescendantIds(graph, id, out);
  return out;
}

// Depth-first, parent-before-children — matches render.ts's draw order
// (children drawn on top of their parent), so reversing this list gives
// topmost-first for hit-testing.
function flattenInDrawOrder(graph: EntityGraph, roots: Entity[], out: Entity[]): void {
  for (const entity of roots) {
    out.push(entity);
    flattenInDrawOrder(graph, graph.childrenOf(entity.id), out);
  }
}

// Topmost entity under `point`, excluding anything in `exclude` (used during
// drag to exclude the dragged entity and its own descendants — dropping a
// container into its own child would create a cycle). containsPoint uses
// effectiveBounds, which always grows to enclose children, so a contained
// entity's rect is always inside its container's — no separate "is this
// inside its parent" check is needed here. Pass `drag` (excludeId only, no
// preview — see DragContext) so a candidate's bounds reflect it having
// already shrunk if the dragged entity used to live inside it.
export function hitTest(
  graph: EntityGraph,
  point: Point,
  exclude: Set<string>,
  drag?: DragContext
): Entity | null {
  const order: Entity[] = [];
  flattenInDrawOrder(graph, graph.topLevel(), order);

  for (let i = order.length - 1; i >= 0; i--) {
    const entity = order[i];
    if (exclude.has(entity.id)) continue;
    if (containsPoint(graph, entity, point, drag)) return entity;
  }
  return null;
}

// Converts an absolute point into `parentId`'s local coordinate space (or
// leaves it absolute if parentId is null) — used when finalizing a drop.
export function toRelative(graph: EntityGraph, parentId: string | null, point: Point): Point {
  if (!parentId) return point;
  const parent = graph.get(parentId);
  if (!parent) return point;
  const parentPos = absolutePosition(graph, parent);
  return { x: point.x - parentPos.x, y: point.y - parentPos.y };
}
