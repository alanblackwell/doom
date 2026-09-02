// Pointer-driven drag/drop and selection over the entity graph's canvas
// layout. Mutates shared state that render.ts reads each animation frame —
// handlers themselves never draw; the existing rAF loop in main.ts picks up
// whatever state changed here, which is what keeps dragging smooth (no
// synchronous draw calls competing with the frame loop).

import type { Entity, EntityGraph } from '../audio/entityGraph';
import {
  reparentEntity as reparentAudio,
  getControlSetter,
  triggerEntity,
  PROCESSOR_KINDS,
  TRIGGERED_KINDS,
} from '../audio/graph';
import { absolutePosition, descendantIds, effectiveBounds, hitTest, toRelative } from './layout';
import type { DragContext, Point } from './layout';
import { controlsFor, hitTestControl, trackGeometry, valueFraction, valueFromTrackPosition } from './controls';
import type { ControlHit, ControlSpec, Track } from './controls';
import { isWithinPad } from './pads';
import { hitTestWireHandle, withinControlBody } from './knobs';
import { addWire, getAllWires, getWiresFrom, removeWireTo } from './wiring';
import {
  addEventWire,
  getAllEventWires,
  getEventWiresFrom,
  removeEventWire,
  removeEventWiresTo,
} from './eventWiring';
import { eventWireEndpoints, hitTestWireCurve, valueWireEndpoints } from './wireGeometry';
import { bindKey, getEntityForKey } from './tapBindings';
import { scheduleSoon } from '../audio/transport';

// Only sink+source ("pedal") kinds are valid containers — nesting one
// instrument inside another has no coherent audio meaning (what would that
// even route to?), so a drop onto a plain source is not a reparent: it's
// just two boxes ending up visually overlapping at wherever it was dropped.
function containerTarget(hit: Entity | null): Entity | null {
  return hit && PROCESSOR_KINDS.has(hit.kind) ? hit : null;
}

export interface InteractionState {
  selectedId: string | null;
  draggingId: string | null;
  dragPointer: Point | null; // live target center position while dragging
  hoverTargetId: string | null; // entity the drag would drop into, if released now
  settleAnim: { id: string; startedAt: number; durationMs: number } | null;

  // The tap entity the pointer is currently over (pure hover, nothing
  // pressed) — while set, a keydown binds that key to this entity instead
  // of firing whichever entity that key already fires. See attachKeyboard.
  hoveredTapId: string | null;

  // Which control dot the pointer is currently over (pure hover, nothing
  // pressed) — drives the slider reveal in render.ts.
  hoverControl: { entityId: string; param: string } | null;
  // Set while a slider thumb is actively being dragged. The track is
  // captured once at drag-start and kept fixed for its duration — see
  // controls.ts's trackGeometry/valueFromTrackPosition.
  draggingControl: { entityId: string; spec: ControlSpec; track: Track } | null;

  // entityId -> performance.now() at the moment its pad was last triggered,
  // for render.ts's flash-ring feedback. A Map rather than a single slot so
  // triggering two different pads close together doesn't clobber either
  // one's animation.
  triggerFlashes: Map<string, number>;

  // Set while dragging a new wire out from a knob's wire-start handle.
  wiringFrom: { entityId: string } | null;
  wireDragPoint: Point | null; // live rubber-band endpoint, following the pointer
  wireHoverTarget: ControlHit | null; // the control dot that would receive the wire if released now
  // The TRIGGERED_KINDS entity whose pad would receive the wire if released
  // now, when wiringFrom is an event source (see ui/eventWiring.ts) rather
  // than a value source — mutually exclusive with wireHoverTarget, which of
  // the two is ever used depends on the source's own kind.
  eventWireHoverTarget: string | null;
}

export function createInteractionState(): InteractionState {
  return {
    selectedId: null,
    draggingId: null,
    dragPointer: null,
    hoverTargetId: null,
    settleAnim: null,
    hoveredTapId: null,
    hoverControl: null,
    draggingControl: null,
    triggerFlashes: new Map(),
    wiringFrom: null,
    wireDragPoint: null,
    wireHoverTarget: null,
    eventWireHoverTarget: null,
  };
}

function applyControlValue(graph: EntityGraph, entityId: string, param: string, value: number): void {
  const entity = graph.get(entityId);
  if (!entity) return;
  entity.params[param] = value;
  getControlSetter(entityId, param)?.(value);

  // Fan this same value out to anything wired from this (entityId, param) —
  // a knob's own value dot changing is exactly what should drive its wires.
  // Reuses this exact function recursively for the target, so a wired
  // target's own control setter fires the same way a manual slider drag
  // would; nothing downstream needs to know the value came from a wire.
  // Safe from infinite recursion only because wire targets are restricted
  // to non-control entities (see the pointermove wiring-hover check below)
  // — a knob can never itself be a target, so this recurses at most once.
  for (const wire of getWiresFrom(entityId)) {
    if (wire.sourceParam !== param) continue;
    const sourceSpec = controlsFor(entity.kind).find((s) => s.param === param);
    const targetSpec = controlsFor(graph.get(wire.targetEntityId)?.kind ?? '').find(
      (s) => s.param === wire.targetParam
    );
    if (!sourceSpec || !targetSpec) continue;
    // Normalize against the SOURCE's own range first — value isn't always
    // already a 0-1 fraction (a knob's is, by construction, but e.g. a
    // clock's bpm is 20-300) — then remap that fraction onto the target's
    // range, same as wireOpacity's mapping in ui/render.ts.
    const mapped = targetSpec.min + valueFraction(sourceSpec, value) * (targetSpec.max - targetSpec.min);
    applyControlValue(graph, wire.targetEntityId, wire.targetParam, mapped);
  }
}

// Fires a tap entity's single event, scheduled through the transport for
// minimum jitter-free latency (audio/transport.ts's scheduleSoon) rather
// than stamping the flash/triggering immediately — everything below should
// visibly happen exactly when the event actually lands, not when the
// tap/keypress happened. Reuses the existing triggerFlashes map (already
// read by render.ts's drawPad/drawTap) rather than a parallel per-entity
// flash store, for both the tap's own bump and any instrument it fires.
function fireTap(entityId: string, state: InteractionState): void {
  scheduleSoon(() => {
    state.triggerFlashes.set(entityId, performance.now());
    fireEventWireTargets(entityId, state);
  });
}

// Fires every instrument wired from this event source's bump (right now,
// not scheduled — callers that need scheduling, like fireTap above and
// ui/clockPulse.ts's per-beat firing, already defer to the right moment
// via scheduleSoon before calling this). Exported so the clock's own
// recurring per-beat trigger can reuse the exact same firing path a tap's
// one-off click/keypress uses, rather than duplicating it.
export function fireEventWireTargets(entityId: string, state: InteractionState): void {
  for (const wire of getEventWiresFrom(entityId)) {
    triggerEntity(wire.targetEntityId);
    state.triggerFlashes.set(wire.targetEntityId, performance.now());
  }
}

const DRAG_START_THRESHOLD = 4; // px of movement before a press becomes a drag, vs. a click/select
// "A small amount of expansion is OK" — slack around a container's real
// bounds within which the dragged entity's centroid still counts as
// "inside" once already hovering. See the sticky-hover comment below.
const HOVER_EXIT_MARGIN = 32;

export function attachInteraction(
  canvas: HTMLCanvasElement,
  graph: EntityGraph,
  state: InteractionState
): void {
  // Only needed for the contextmenu handler's wire-curve hit-test
  // (ctx.isPointInStroke — see ui/wireGeometry.ts); getContext('2d') on an
  // already-2d canvas just returns the same context main.ts already has.
  const ctx2d = canvas.getContext('2d')!;

  let pressId: string | null = null;
  let pressStart: Point | null = null;
  let grabOffset: Point = { x: 0, y: 0 };

  function canvasPoint(e: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const point = canvasPoint(e);

    // A knob's wire-start handle takes priority over everything else — the
    // whole point of it being a separate small handle (not the knob's own
    // value dot, not its body) is that it always means "start a wire,"
    // never "adjust a value" or "reposition this."
    const wireHandleHit = hitTestWireHandle(graph, point);
    if (wireHandleHit) {
      canvas.setPointerCapture(e.pointerId);
      state.wiringFrom = { entityId: wireHandleHit.entityId };
      state.wireDragPoint = point;
      state.wireHoverTarget = null;
      return;
    }

    // Control dots take priority over the box itself — they sit at/near
    // the box's edge, so this must be checked before falling back to the
    // normal box hit-test below.
    const controlHit = hitTestControl(graph, point);
    if (controlHit) {
      canvas.setPointerCapture(e.pointerId);
      const entity = graph.get(controlHit.entityId);
      const currentValue = entity?.params[controlHit.spec.param] ?? controlHit.spec.min;
      state.draggingControl = {
        entityId: controlHit.entityId,
        spec: controlHit.spec,
        track: trackGeometry(controlHit.dot, controlHit.spec, currentValue),
      };
      return;
    }

    const hit = hitTest(graph, point, new Set());

    if (!hit) {
      state.selectedId = null;
      return;
    }

    // Trigger pads fire immediately on press, not release — a drum pad
    // reacts to touch, the way real percussion does. This doesn't replace
    // the normal select/drag handling below: pressing a pad both fires the
    // hit and can still become a drag if the pointer moves far enough, so
    // repositioning a triggered instrument from its own pad still works.
    if (TRIGGERED_KINDS.has(hit.kind) && isWithinPad(effectiveBounds(graph, hit), point)) {
      triggerEntity(hit.id);
      state.triggerFlashes.set(hit.id, performance.now());
    } else if (hit.kind === 'tap' && withinControlBody(effectiveBounds(graph, hit), point)) {
      // Same "fires on press, still draggable" reasoning as a trigger pad
      // above — a tap entity's whole body is its button (see
      // withinControlBody), not a smaller inset pad.
      fireTap(hit.id, state);
    }

    canvas.setPointerCapture(e.pointerId);
    pressId = hit.id;
    pressStart = point;
    state.selectedId = hit.id;

    const abs = absolutePosition(graph, hit);
    grabOffset = { x: point.x - abs.x, y: point.y - abs.y };
  });

  canvas.addEventListener('pointermove', (e) => {
    const point = canvasPoint(e);

    if (state.wiringFrom) {
      state.wireDragPoint = point;
      const source = graph.get(state.wiringFrom.entityId);

      // A TRIGGERED_KINDS instrument's whole pad circle (see ui/pads.ts) is
      // always a valid drop target from ANY control-type source's bump —
      // not just an event-only source like tap. Whether anything actually
      // fires through it depends on whether that source ever calls
      // fireEventWireTargets (tap on click/keypress, the clock on every
      // beat) — a knob dropped here would just sit inert, same as a tap
      // dropped on a value dot already silently does nothing. Checked
      // before dot-targeting since the pad is the bigger, more likely
      // target when both are near the pointer.
      const padHit = hitTest(graph, point, new Set());
      const validPadHit =
        source && padHit && padHit.id !== source.id && TRIGGERED_KINDS.has(padHit.kind) && isWithinPad(effectiveBounds(graph, padHit), point)
          ? padHit
          : null;

      if (validPadHit) {
        state.eventWireHoverTarget = validPadHit.id;
        state.wireHoverTarget = null;
        return;
      }
      state.eventWireHoverTarget = null;

      const hit = hitTestControl(graph, point);
      // A wire can't target its own source (self-connection is meaningless)
      // or any other control entity's dot — knobs are sources only for now,
      // never targets, which is also what keeps applyControlValue's
      // wire-fanout recursion from being able to cycle.
      if (hit && hit.entityId !== state.wiringFrom.entityId) {
        const targetEntity = graph.get(hit.entityId);
        state.wireHoverTarget = targetEntity && targetEntity.type !== 'control' ? hit : null;
      } else {
        state.wireHoverTarget = null;
      }
      return;
    }

    if (state.draggingControl) {
      const { entityId, spec, track } = state.draggingControl;
      applyControlValue(graph, entityId, spec.param, valueFromTrackPosition(track, spec, point.y));
      return;
    }

    if (!pressId || !pressStart) {
      // Nothing pressed — pure hover, just update which dot (if any) is lit up.
      const hit = hitTestControl(graph, point);
      state.hoverControl = hit ? { entityId: hit.entityId, param: hit.spec.param } : null;
      canvas.style.cursor = hit ? 'ns-resize' : '';

      // Separately, whether the pointer is over a tap entity's body at all
      // (not just its control dots — it has none) — attachKeyboard reads
      // this to decide whether the next keydown binds or fires.
      const bodyHit = hitTest(graph, point, new Set());
      state.hoveredTapId = bodyHit?.kind === 'tap' ? bodyHit.id : null;
      return;
    }

    if (!state.draggingId) {
      const dx = point.x - pressStart.x;
      const dy = point.y - pressStart.y;
      if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
      state.draggingId = pressId;
    }

    const entity = graph.get(pressId);
    if (!entity) return;

    const target = { x: point.x - grabOffset.x, y: point.y - grabOffset.y };
    state.dragPointer = target;

    // Control entities (knobs) never participate in containment — they're
    // never a valid drop target for anything else (already excluded via
    // containerTarget/PROCESSOR_KINDS), and dragging one around should
    // never be interpreted as trying to drop it INTO a pedal either. Per
    // ARCHITECTURE.md §3.2, a Control targets params by explicit reference
    // (the wire), never by nesting.
    if (entity.type === 'control') {
      state.hoverTargetId = null;
      return;
    }

    const exclude = descendantIds(graph, entity.id);
    exclude.add(entity.id);

    // Sticky hover, with an escape: once a container is the hover target,
    // keep it as long as the DRAGGED ENTITY'S OWN CENTROID stays within its
    // real (undragged) bounds plus a small fixed margin — not within the
    // container's live preview-grown bounds. Checking against the preview
    // bounds is circular here: they're grown specifically to include
    // wherever the dragged entity currently is, so "is the dragged entity
    // still inside" is trivially always true once triggered, no matter how
    // far it's dragged away — which was the bug (impossible to drag
    // something back out of a container). The margin is deliberately
    // small and fixed, not "however big the preview grew" — a little slack
    // so it doesn't flicker right at the exact edge, but the container
    // snaps back the moment the centroid actually leaves.
    let hoverTarget: Entity | null = null;
    if (state.hoverTargetId) {
      const current = graph.get(state.hoverTargetId);
      if (current) {
        const shrunk = effectiveBounds(graph, current, { excludeId: entity.id, preview: null });
        const withinX =
          target.x >= shrunk.x - shrunk.width / 2 - HOVER_EXIT_MARGIN &&
          target.x <= shrunk.x + shrunk.width / 2 + HOVER_EXIT_MARGIN;
        const withinY =
          target.y >= shrunk.y - shrunk.height / 2 - HOVER_EXIT_MARGIN &&
          target.y <= shrunk.y + shrunk.height / 2 + HOVER_EXIT_MARGIN;
        if (withinX && withinY) {
          hoverTarget = current;
        }
      }
    }

    if (!hoverTarget) {
      // excludeId only, no preview — a fresh candidate search intentionally
      // uses real (undragged) bounds: "would growing this box now catch the
      // pointer" is circular for a box not yet hovered. Tested against the
      // dragged entity's centroid too, for consistency with the sticky
      // check above (same notion of "is this dragged thing over that box").
      const dragCtx: DragContext = { excludeId: entity.id, preview: null };
      hoverTarget = containerTarget(hitTest(graph, target, exclude, dragCtx));
    }

    state.hoverTargetId = hoverTarget ? hoverTarget.id : null;
  });

  function endPress(e: PointerEvent): void {
    if (state.wiringFrom) {
      canvas.releasePointerCapture(e.pointerId);
      if (state.eventWireHoverTarget) {
        addEventWire(state.wiringFrom.entityId, state.eventWireHoverTarget);
      } else if (state.wireHoverTarget) {
        // Every control-type entity currently exposes exactly one control
        // spec (its own value/bpm/etc — see controlSpecs.ts) — that's the
        // param a wire dragged from its bump always carries, whatever it's
        // actually called for this particular kind (knob's 'value', clock's
        // 'bpm', ...).
        const source = graph.get(state.wiringFrom.entityId);
        const sourceSpec = source && controlsFor(source.kind)[0];
        if (source && sourceSpec) {
          addWire(source.id, sourceSpec.param, state.wireHoverTarget.entityId, state.wireHoverTarget.spec.param);
          // Apply immediately rather than waiting for the source to change
          // again — connecting a wire should show its effect right away.
          applyControlValue(graph, source.id, sourceSpec.param, source.params[sourceSpec.param] ?? sourceSpec.min);
        }
      }
      state.wiringFrom = null;
      state.wireDragPoint = null;
      state.wireHoverTarget = null;
      state.eventWireHoverTarget = null;
      return;
    }

    if (state.draggingControl) {
      canvas.releasePointerCapture(e.pointerId);
      state.draggingControl = null;
      return;
    }

    if (!pressId) return;
    canvas.releasePointerCapture(e.pointerId);

    if (state.draggingId === pressId) {
      finalizeDrop(graph, state, pressId);
    }

    pressId = null;
    pressStart = null;
    state.draggingId = null;
    state.dragPointer = null;
    state.hoverTargetId = null;
  }

  canvas.addEventListener('pointerup', endPress);
  canvas.addEventListener('pointercancel', endPress);

  // Right-click any wire's drawn line, anywhere along it, to delete
  // exactly that connection — checked first since it's the most direct
  // "delete this" gesture. Right-clicking an endpoint still works too
  // (below): a wired control dot disconnects it, and a drum's pad (which
  // has no single dot to pick) clears everything feeding it.
  canvas.addEventListener('contextmenu', (e) => {
    const point = canvasPoint(e);

    for (const wire of getAllWires()) {
      const endpoints = valueWireEndpoints(graph, wire);
      if (endpoints && hitTestWireCurve(ctx2d, endpoints, point)) {
        e.preventDefault();
        removeWireTo(wire.targetEntityId, wire.targetParam);
        return;
      }
    }
    for (const wire of getAllEventWires()) {
      const endpoints = eventWireEndpoints(graph, wire);
      if (endpoints && hitTestWireCurve(ctx2d, endpoints, point)) {
        e.preventDefault();
        removeEventWire(wire.sourceEntityId, wire.targetEntityId);
        return;
      }
    }

    const hit = hitTestControl(graph, point);
    if (hit) {
      e.preventDefault();
      removeWireTo(hit.entityId, hit.spec.param);
      return;
    }

    const bodyHit = hitTest(graph, point, new Set());
    if (bodyHit && TRIGGERED_KINDS.has(bodyHit.kind) && isWithinPad(effectiveBounds(graph, bodyHit), point)) {
      e.preventDefault();
      removeEventWiresTo(bodyHit.id);
    }
  });
}

// Global keydown handling for tap entities — on `window`, not the canvas,
// since a bound key should fire "from anywhere," not just while the canvas
// has focus. Two mutually exclusive behaviors depending on hover state:
// hovering a tap entity's body means "bind the next key I press to this
// entity" (rebinding always overwrites, see ui/tapBindings.ts); otherwise a
// keydown matching some entity's existing binding fires that entity's tap.
export function attachKeyboard(graph: EntityGraph, state: InteractionState): void {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't steal OS/browser shortcuts

    if (state.hoveredTapId) {
      const entity = graph.get(state.hoveredTapId);
      if (entity?.kind === 'tap') {
        bindKey(state.hoveredTapId, e.code);
        e.preventDefault();
      }
      return;
    }

    const entityId = getEntityForKey(e.code);
    if (entityId) {
      fireTap(entityId, state);
      e.preventDefault();
    }
  });
}

function finalizeDrop(graph: EntityGraph, state: InteractionState, entityId: string): void {
  const entity = graph.get(entityId);
  if (!entity || !state.dragPointer) return;

  // Trust hoverTargetId rather than re-deriving the drop target from
  // scratch here — it's already been maintained continuously (and stickily,
  // see pointermove above) throughout the drag, and is exactly what was
  // shown highlighted/grown on screen. Recomputing independently risked
  // disagreeing with what the user was looking at when they released.
  const newParentId = state.hoverTargetId;

  const relative = toRelative(graph, newParentId, state.dragPointer);
  entity.x = relative.x;
  entity.y = relative.y;

  if (entity.parentId !== newParentId) {
    graph.reparent(entityId, newParentId);
    reparentAudio(entityId, newParentId);
  }

  // Independent of whether reparenting happened — dropping one instrument
  // onto another (no containment involved, per the previous change) should
  // still bring the one you just placed to the front of the overlap.
  graph.bringToFront(entityId);

  state.settleAnim = { id: entityId, startedAt: performance.now(), durationMs: 220 };
}
