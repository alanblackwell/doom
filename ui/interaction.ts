// Pointer-driven drag/drop and selection over the entity graph's canvas
// layout. Mutates shared state that render.ts reads each animation frame —
// handlers themselves never draw; the existing rAF loop in main.ts picks up
// whatever state changed here, which is what keeps dragging smooth (no
// synchronous draw calls competing with the frame loop).

import type { Entity, EntityGraph } from '../audio/entityGraph';
import {
  reparentEntity as reparentAudio,
  activateEntity,
  activateEventTarget,
  getControlSetter,
  releaseEntity,
  triggerEntity,
  isEntityPlaying,
  stopEntity,
  CONTINUOUS_KINDS,
  PROCESSOR_KINDS,
  TRIGGERED_KINDS,
} from '../audio/graph';
import { absolutePosition, descendantIds, effectiveBounds, hitTest, toRelative } from './layout';
import type { DragContext, Point, Rect } from './layout';
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
import { recordSourcePulse } from './eventPulse';
import { scheduleSoon } from '../audio/transport';
import { isOverDock, hitTestDockIcon } from './dock';
import { isDockable, dockEntity } from './docking';
import { applyPositionToMix, clearLevelOverride, markLevelOverridden } from './stereoMix';
import { isTextureEditorActive } from './textureEditor';
import {
  envelopeValuesFromHandle,
  hitTestFeatureDot,
  hitTestPopup,
  hitTestPorthole,
  requiredTimeScaleFor,
  timeScaleFromDrag,
  DEFAULT_TIME_SCALE,
} from './organelle';
import type { HandleKind } from './organelle';
import {
  activeSelectedItem,
  addNoteAt,
  cycleDurationDown,
  cycleDurationUp,
  cycleOctaveDown,
  cycleOctaveUp,
  deleteSelectedItem,
  forcePlacement,
  hitTestMelodyPopup,
  insertBarlineAfterCurrent,
  insertBarlineAfterLast,
  insertFirstLetterNote,
  insertLetterNoteAfterSelection,
  insertRestAfterCurrent,
  insertRestAfterLast,
  melodyStateFor,
  mergeIntoTarget,
  nudgePitch,
  reorderDuringDrag,
  selectAdjacentItem,
  updateNotePitchDrag,
  updateScrollFromTrackX,
} from './melody';
import type { Accidental, MelodyItem, MelodyNoteItem } from './melody';
import {
  commitTrim,
  focusNameField,
  hasSelectedMarker,
  hitTestSamplerPopup,
  nudgeSelectedMarker,
  samplerStateFor,
  scopeLayoutFor,
  selectDevice,
  selectMarker,
  stopCapture,
  toggleDeviceList,
  toggleRecord,
  updateMarkerDrag,
} from './sampler';
import {
  applySequencerResize,
  hitTestSequencerPopup,
  rewindSequencer,
  scrubSequencer,
  secondsAtPopupX,
  sequencerResizeStart,
  sequencerStateFor,
  setTrackEnd,
  toggleLoopAtEnd,
  toggleSequencer,
  updateSequencerChannelScrollFromTrackY,
  updateSequencerScrollFromTrackX,
  zoomFromDrag,
} from './sequencer';
import type { SequencerResizeStart } from './sequencer';

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
  // True while the current drag's pointer is over the dock panel (ui/dock.ts)
  // and the dragged entity is dockable (ui/docking.ts) — mutually exclusive
  // with hoverTargetId, same "one drop-target cue at a time" reasoning.
  hoverDock: boolean;
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

  // Set while directly dragging one of an open envelope popup's handles
  // (ui/organelle.ts) — a genuinely different gesture from draggingControl
  // above (2D curve manipulation, not a single vertical slider), so it gets
  // its own slot rather than being shoehorned into that one.
  draggingHandle: { entityId: string; handle: HandleKind } | null;

  // Set while dragging the popup's time-axis zoom grip (ui/organelle.ts) —
  // rescales how many seconds the curve's fixed pixel width represents
  // rather than adjusting a param value, so it's tracked separately from
  // draggingHandle. Delta-based (see organelle.ts's timeScaleFromDrag), not
  // a direct pointer-to-value mapping like a normal slider, since there's
  // no fixed pixel position that inherently means "this many seconds."
  draggingTimeAxis: { entityId: string; startX: number; startTimeScale: number } | null;

  // The TRIGGERED_KINDS entity currently gated on by a held pad press (see
  // pointerdown below) — released (audio/graph.ts's releaseEntity) on
  // pointerup/pointercancel regardless of what else happened during the
  // press (a repositioning drag included). A no-op release for any
  // instrument with no envelope feature attached, so this is tracked
  // unconditionally for every TRIGGERED_KINDS press rather than needing to
  // first check whether one exists.
  gatedId: string | null;

  // A press begun on an existing melody-popup item (ui/melody.ts) — held
  // here rather than starting a drag immediately, same DRAG_START_THRESHOLD
  // idiom the top-level entity drag below uses: a release before crossing
  // the threshold is a plain click (cycles the item's duration down one
  // step), movement past it promotes to an actual reposition/repitch drag.
  // `axis` is decided once, from whichever of dx/dy is larger at the moment
  // the threshold is first crossed, and then frozen for the rest of the
  // drag — horizontal reorders the sequence (ui/melody.ts's
  // reorderDuringDrag), vertical repitches the note, and the two never mix
  // within one gesture, so a mostly-sideways drag can't also nudge the
  // pitch from incidental vertical jitter. startStep/startAccidental are
  // only meaningful for a 'note' item.
  melodyPress: {
    entityId: string;
    item: MelodyItem;
    startPointer: Point;
    currentPointer: Point; // live — kept in sync every pointermove, read by ui/render.ts for a horizontal drag's continuous visual (see MelodyDragOverride)
    startStep: number | null;
    startAccidental: Accidental; // already nullable — see ui/melody.ts's Accidental
    dragging: boolean;
    axis: 'x' | 'y' | null;
    // The same-pitch note (if any) currently frozen under the pointer
    // during a horizontal drag — see ui/melody.ts's reorderDuringDrag. Read
    // by ui/render.ts to snap the dragged note's own visual onto it, and by
    // endPress below to merge into it (or, failing that, fall back to a
    // normal placement) once the drag ends.
    mergeTarget: MelodyNoteItem | null;
  } | null;

  // The melody popup's own horizontal scrollbar (ui/melody.ts) currently
  // being dragged, if any — no press/threshold distinction needed here
  // unlike melodyPress, since there's nothing else a press on the track
  // could mean (see updateScrollFromTrackX's own "jump to the click,
  // continue tracking from there" behavior).
  melodyScrollDrag: { entityId: string } | null;

  // Set while directly dragging one of an open sampler popup's trim markers
  // (ui/sampler.ts) — live position updates happen continuously on move, but
  // the buffer only gets re-registered and re-auditioned once on release
  // (see endPress below), so a fast drag doesn't fire overlapping previews.
  draggingSamplerMarker: { entityId: string; ownerId: string; edge: 'start' | 'end' } | null;

  // The sequencer feature (ui/sequencer.ts) whose ruler is currently being
  // dragged to scrub the playhead, if any — same "jump to the click,
  // continue tracking from there" shape as melodyScrollDrag above, no
  // press/threshold distinction needed since there's nothing else a press
  // on the ruler could mean yet (Phase 1 — see TODO.md).
  scrubbingSequencerId: string | null;

  // The sequencer feature whose bottom-right handle is currently being
  // dragged to resize its frame (ui/sequencer.ts's applySequencerResize) —
  // startPointer/start are snapshotted once at drag-start so every
  // pointermove computes the new size from the total drag delta, same
  // "absolute displacement since the drag started" reasoning as e.g.
  // ui/textureEditor.ts's own resize drag.
  resizingSequencer: { entityId: string; startPointer: Point; start: SequencerResizeStart } | null;

  // The sequencer's own horizontal (timeline) or vertical (channel stack)
  // scrollbar currently being dragged, if either — same "jump to the
  // click, continue tracking from there" shape as melodyScrollDrag above.
  sequencerHScrollDrag: { entityId: string } | null;
  sequencerVScrollDrag: { entityId: string } | null;

  // The sequencer feature whose track-end marker band is currently being
  // dragged, if any — same "jump to the click, continue tracking" shape
  // as the scrub/scrollbar drags above (see ui/sequencer.ts's setTrackEnd).
  draggingSequencerEnd: string | null;
}

export function createInteractionState(): InteractionState {
  return {
    selectedId: null,
    draggingId: null,
    dragPointer: null,
    hoverTargetId: null,
    hoverDock: false,
    settleAnim: null,
    hoveredTapId: null,
    hoverControl: null,
    draggingControl: null,
    triggerFlashes: new Map(),
    wiringFrom: null,
    wireDragPoint: null,
    wireHoverTarget: null,
    eventWireHoverTarget: null,
    draggingHandle: null,
    draggingTimeAxis: null,
    gatedId: null,
    melodyPress: null,
    melodyScrollDrag: null,
    draggingSamplerMarker: null,
    scrubbingSequencerId: null,
    resizingSequencer: null,
    sequencerHScrollDrag: null,
    sequencerVScrollDrag: null,
    draggingSequencerEnd: null,
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
    const now = performance.now();
    state.triggerFlashes.set(entityId, now);
    recordSourcePulse(entityId, now); // ui/eventPulse.ts — animates any wire out of this tap's bump
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
    // Trigger (TRIGGERED_KINDS) or toggle play/pause (CONTINUOUS_KINDS),
    // whichever this particular target actually is — see
    // audio/graph.ts's own comment on activateEventTarget.
    activateEventTarget(wire.targetEntityId);
    state.triggerFlashes.set(wire.targetEntityId, performance.now());
  }
}

const DRAG_START_THRESHOLD = 4; // px of movement before a press becomes a drag, vs. a click/select
// "A small amount of expansion is OK" — slack around a container's real
// bounds within which the dragged entity still counts as "inside" once
// already hovering. See the sticky-hover comment below.
const HOVER_EXIT_MARGIN = 32;

// True if `p` falls within `bounds` (a center-based Rect), grown by
// `margin` on every side.
function withinBounds(p: Point, bounds: Rect, margin: number): boolean {
  return (
    p.x >= bounds.x - bounds.width / 2 - margin &&
    p.x <= bounds.x + bounds.width / 2 + margin &&
    p.y >= bounds.y - bounds.height / 2 - margin &&
    p.y <= bounds.y + bounds.height / 2 + margin
  );
}

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
    // The texture crop/target editor (ui/textureEditor.ts) is effectively
    // modal while open — it has its own independent pointer listeners on
    // this same canvas, so normal selection/drag/wiring must do nothing
    // at all rather than fight it for the same events.
    if (isTextureEditorActive()) return;

    // Secondary-button presses (a real right mouse button, or its trackpad
    // surrogates — Safari's two-finger tap included) fire pointerdown AND
    // pointerup in addition to 'contextmenu', with the same button value in
    // every browser tested (button === 2) — this module's own right-click
    // handling lives entirely in the separate 'contextmenu' listener below,
    // so nothing here should react to a non-primary press at all. Without
    // this guard, a right-click on a melody item was starting a normal
    // melodyPress (since hitTestMelodyPopup doesn't know or care which
    // button was used) that then released as an un-dragged "click" on
    // pointerup — cycling the item's duration DOWN one step immediately
    // after 'contextmenu' had just cycled it UP, silently cancelling the
    // double back to its original value. The same latent issue applied to
    // every other pointerdown-driven action below (selection, entity drag,
    // control drag, wiring, ...), just without anything as immediately
    // visible as this cancel-each-other-out pair to reveal it.
    if (e.button !== 0) return;

    const point = canvasPoint(e);

    // An open melody popup (ui/melody.ts) sits visually on top of everything
    // else too, same reasoning as the envelope popup right below — checked
    // first since it's a distinct feature kind with its own hit-testing
    // (organelle.ts's hitTestPopup only handles kind 'envelope').
    const melodyHit = hitTestMelodyPopup(graph, point);
    if (melodyHit) {
      const melody = melodyStateFor(melodyHit.entityId);
      switch (melodyHit.kind) {
        case 'close': {
          const feature = graph.get(melodyHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'octaveUp':
          cycleOctaveUp(melody);
          break;
        case 'octaveDown':
          cycleOctaveDown(melody);
          break;
        case 'restIcon':
          insertRestAfterLast(melodyHit.entityId, melody);
          break;
        case 'barlineIcon':
          insertBarlineAfterLast(melodyHit.entityId, melody);
          break;
        case 'addNote':
          addNoteAt(melodyHit.entityId, melody, melodyHit.index, melodyHit.step);
          break;
        case 'item':
          canvas.setPointerCapture(e.pointerId);
          state.melodyPress = {
            entityId: melodyHit.entityId,
            item: melodyHit.item,
            startPointer: point,
            currentPointer: point,
            startStep: melodyHit.item.kind === 'note' ? melodyHit.item.step : null,
            startAccidental: melodyHit.item.kind === 'note' ? melodyHit.item.accidental : null,
            dragging: false,
            axis: null,
            mergeTarget: null,
          };
          break;
        case 'scrollTrack':
          canvas.setPointerCapture(e.pointerId);
          updateScrollFromTrackX(graph, melodyHit.entityId, point.x); // jump to the click, then keep tracking on move
          state.melodyScrollDrag = { entityId: melodyHit.entityId };
          break;
        // 'background' is absorbed with no further action, same as the
        // envelope popup's own catch-all below.
      }
      return;
    }

    // An open sampler popup (ui/sampler.ts) sits visually on top of
    // everything else too, same reasoning as the melody popup above.
    const samplerHit = hitTestSamplerPopup(graph, point);
    if (samplerHit) {
      switch (samplerHit.kind) {
        case 'close': {
          const feature = graph.get(samplerHit.entityId);
          if (feature) feature.expanded = false;
          // Closing (not just docking) also releases the mic — leaving a
          // hot input running behind a collapsed panel isn't expected
          // background behavior; reopening re-requests the stream, which
          // doesn't re-prompt once the origin already has permission.
          stopCapture(samplerHit.entityId);
          break;
        }
        case 'deviceRow':
          toggleDeviceList(samplerHit.entityId);
          break;
        case 'deviceOption':
          selectDevice(samplerHit.entityId, samplerHit.deviceId);
          break;
        case 'record':
          toggleRecord(samplerHit.entityId, samplerHit.ownerId);
          break;
        case 'nameField':
          focusNameField(samplerHit.entityId);
          break;
        case 'marker':
          canvas.setPointerCapture(e.pointerId);
          selectMarker(samplerHit.entityId, samplerHit.ownerId, samplerHit.edge);
          state.draggingSamplerMarker = {
            entityId: samplerHit.entityId,
            ownerId: samplerHit.ownerId,
            edge: samplerHit.edge,
          };
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/envelope popups' own catch-all.
      }
      return;
    }

    // An open sequencer popup (ui/sequencer.ts) sits visually on top of
    // everything else too, same reasoning as the melody/sampler popups
    // above.
    const sequencerHit = hitTestSequencerPopup(graph, point);
    if (sequencerHit) {
      switch (sequencerHit.kind) {
        case 'close': {
          const feature = graph.get(sequencerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'play':
          toggleSequencer(sequencerStateFor(sequencerHit.entityId));
          break;
        case 'rewind':
          rewindSequencer(sequencerStateFor(sequencerHit.entityId));
          break;
        case 'scrub':
          canvas.setPointerCapture(e.pointerId);
          scrubSequencer(sequencerStateFor(sequencerHit.entityId), sequencerHit.seconds); // jump to the click, then keep tracking on move
          state.scrubbingSequencerId = sequencerHit.entityId;
          break;
        case 'axisHandle':
          canvas.setPointerCapture(e.pointerId);
          state.draggingTimeAxis = {
            entityId: sequencerHit.entityId,
            startX: point.x,
            startTimeScale: sequencerStateFor(sequencerHit.entityId).zoomSeconds,
          };
          break;
        case 'resize':
          canvas.setPointerCapture(e.pointerId);
          state.resizingSequencer = {
            entityId: sequencerHit.entityId,
            startPointer: point,
            start: sequencerResizeStart(sequencerStateFor(sequencerHit.entityId)),
          };
          break;
        case 'hScroll':
          canvas.setPointerCapture(e.pointerId);
          updateSequencerScrollFromTrackX(graph, sequencerHit.entityId, point.x); // jump to the click, then keep tracking on move
          state.sequencerHScrollDrag = { entityId: sequencerHit.entityId };
          break;
        case 'vScroll':
          canvas.setPointerCapture(e.pointerId);
          updateSequencerChannelScrollFromTrackY(graph, sequencerHit.entityId, point.y);
          state.sequencerVScrollDrag = { entityId: sequencerHit.entityId };
          break;
        case 'endMarkerToggle':
          toggleLoopAtEnd(sequencerStateFor(sequencerHit.entityId));
          break;
        case 'endMarkerDrag':
          canvas.setPointerCapture(e.pointerId);
          setTrackEnd(sequencerStateFor(sequencerHit.entityId), sequencerHit.seconds); // jump to the click, then keep tracking on move
          state.draggingSequencerEnd = sequencerHit.entityId;
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler/envelope popups' own catch-all.
      }
      return;
    }

    // An open envelope popup (ui/organelle.ts) sits visually on top of
    // everything else on the canvas, so its own hit-test goes first — a
    // click anywhere inside it (its background included) must never fall
    // through to whatever entity happens to be underneath.
    const popupHit = hitTestPopup(graph, point);
    if (popupHit) {
      if (popupHit.kind === 'close') {
        const feature = graph.get(popupHit.entityId);
        if (feature) feature.expanded = false;
      } else if (popupHit.kind === 'handle') {
        canvas.setPointerCapture(e.pointerId);
        state.draggingHandle = { entityId: popupHit.entityId, handle: popupHit.handle };
      } else if (popupHit.kind === 'axisHandle') {
        canvas.setPointerCapture(e.pointerId);
        const feature = graph.get(popupHit.entityId);
        state.draggingTimeAxis = {
          entityId: popupHit.entityId,
          startX: point.x,
          startTimeScale: feature?.params.timeScale ?? DEFAULT_TIME_SCALE,
        };
      }
      // 'dot' and 'background' are absorbed with no further action — a
      // dot's only job is receiving a wire dragged in from elsewhere (see
      // pointermove's wiringFrom branch below), not itself slider-draggable.
      return;
    }

    // A collapsed feature's porthole (ui/organelle.ts) — click to expand.
    // Only meaningful while collapsed; an open popup has its own close
    // button instead (handled above).
    const portholeHit = hitTestPorthole(graph, point);
    if (portholeHit) {
      portholeHit.expanded = true;
      return;
    }

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

    // A docked instrument's icon (ui/dock.ts) — checked before the normal
    // canvas hitTest below since the dock panel visually sits on top of
    // everything else. Pressing it can only ever lead to a drag (undocking,
    // see finalizeDrop) or a plain select; it has no pad/controls to fire.
    const dockHit = hitTestDockIcon(graph, canvas, point);
    if (dockHit) {
      canvas.setPointerCapture(e.pointerId);
      pressId = dockHit.id;
      pressStart = point;
      state.selectedId = dockHit.id;
      grabOffset = { x: 0, y: 0 }; // pointer becomes the entity's center the moment it's dragged out
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
      // A long-running 'sample' already playing: this press means "stop it"
      // rather than "retrigger" — the pad doubles as a pause button while
      // sound is coming out of it (see ui/render.ts's drawPad for the
      // matching play/pause icon swap). isEntityPlaying is always false for
      // the other TRIGGERED_KINDS (short one-shots), so they always hit the
      // normal trigger branch below.
      if (isEntityPlaying(hit.id)) {
        stopEntity(hit.id);
      } else {
        triggerEntity(hit.id);
        state.triggerFlashes.set(hit.id, performance.now());
        // Gate-on for a press-and-hold envelope (see endPress's matching
        // release) — a no-op release if this instrument has no envelope
        // feature attached, so tracked unconditionally.
        state.gatedId = hit.id;
      }
    } else if (CONTINUOUS_KINDS.has(hit.kind) && isWithinPad(effectiveBounds(graph, hit), point)) {
      // Same pad/button, same press-fires-immediately reasoning as above.
      // Routed through activateEventTarget (not toggleEntityPaused directly)
      // so a direct click and a wired-in pulse behave identically once this
      // entity has a melody organelle attached — see activateEventTarget's
      // own comment in audio/graph.ts. Falls back to the plain play/pause
      // toggle for an entity with no melody (or an empty one).
      activateEventTarget(hit.id);
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
    if (isTextureEditorActive()) return;

    const point = canvasPoint(e);

    if (state.draggingHandle) {
      const { entityId, handle } = state.draggingHandle;
      const feature = graph.get(entityId);
      const owner = feature?.ownerId ? graph.get(feature.ownerId) : undefined;
      if (feature && owner) {
        for (const update of envelopeValuesFromHandle(feature, owner, graph, handle, point)) {
          applyControlValue(graph, entityId, update.param, update.value);
        }
        // Dragging a handle past the currently visible edge shouldn't lose
        // it off-screen — grow (never shrink) the axis to keep the whole
        // envelope in view. Written directly, same reasoning as the
        // axisHandle branch below: timeScale is UI display state, not a
        // wireable param.
        const required = requiredTimeScaleFor(feature);
        if (required !== null) feature.params.timeScale = required;
      }
      return;
    }

    if (state.draggingTimeAxis) {
      const { entityId, startX, startTimeScale } = state.draggingTimeAxis;
      const feature = graph.get(entityId);
      if (feature?.kind === 'sequencer') {
        // ui/sequencer.ts keeps its own zoomSeconds in module state, not
        // entity.params — same reasoning as timeScale below, just a
        // different backing store.
        sequencerStateFor(entityId).zoomSeconds = zoomFromDrag(startTimeScale, point.x - startX);
      } else if (feature) {
        // Written directly rather than through applyControlValue — timeScale
        // is UI-only display state (how the popup renders), not one of
        // controlsFor('envelope')'s specs, so it's never wireable and has no
        // control-setter to dispatch to.
        feature.params.timeScale = timeScaleFromDrag(startTimeScale, point.x - startX);
      }
      return;
    }

    if (state.melodyScrollDrag) {
      updateScrollFromTrackX(graph, state.melodyScrollDrag.entityId, point.x);
      return;
    }

    if (state.scrubbingSequencerId) {
      // secondsAtPopupX tracks x only, independent of the ruler's own
      // tight vertical hit-zone (hitTestSequencerPopup's 'scrub' case) —
      // a scrub drag should keep tracking even once the pointer strays
      // off the ruler itself, same "drag doesn't need to stay exactly on
      // the control" leniency every other drag in this file already gets
      // via pointer capture.
      const seconds = secondsAtPopupX(graph, state.scrubbingSequencerId, point.x);
      if (seconds !== null) scrubSequencer(sequencerStateFor(state.scrubbingSequencerId), seconds);
      return;
    }

    if (state.resizingSequencer) {
      const { entityId, startPointer, start } = state.resizingSequencer;
      applySequencerResize(sequencerStateFor(entityId), start, point.x - startPointer.x, point.y - startPointer.y);
      return;
    }

    if (state.sequencerHScrollDrag) {
      updateSequencerScrollFromTrackX(graph, state.sequencerHScrollDrag.entityId, point.x);
      return;
    }

    if (state.sequencerVScrollDrag) {
      updateSequencerChannelScrollFromTrackY(graph, state.sequencerVScrollDrag.entityId, point.y);
      return;
    }

    if (state.draggingSequencerEnd) {
      // secondsAtPopupX (same helper the scrub drag above uses) tracks x
      // only, so this keeps working even once the pointer strays off the
      // marker band's own tight vertical bounds.
      const seconds = secondsAtPopupX(graph, state.draggingSequencerEnd, point.x);
      if (seconds !== null) setTrackEnd(sequencerStateFor(state.draggingSequencerEnd), seconds);
      return;
    }

    if (state.draggingSamplerMarker) {
      const { entityId, edge } = state.draggingSamplerMarker;
      const layout = scopeLayoutFor(graph, entityId);
      if (layout) updateMarkerDrag(entityId, edge, point, layout);
      return;
    }

    if (state.melodyPress) {
      const press = state.melodyPress;
      press.currentPointer = point;
      const dx = point.x - press.startPointer.x;
      const dy = point.y - press.startPointer.y;
      if (!press.dragging) {
        if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
        press.dragging = true;
        // Frozen for the rest of this drag — see melodyPress's own comment.
        press.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }

      if (press.axis === 'x') {
        press.mergeTarget = reorderDuringDrag(graph, press.entityId, press.item, point.x);
      } else if (press.item.kind === 'note' && press.startStep !== null) {
        updateNotePitchDrag(press.entityId, press.item, press.startStep, press.startAccidental, dy);
      }
      return;
    }

    if (state.wiringFrom) {
      state.wireDragPoint = point;
      const source = graph.get(state.wiringFrom.entityId);

      // A TRIGGERED_KINDS instrument's or CONTINUOUS_KINDS drone's whole pad
      // circle (see ui/pads.ts) is always a valid drop target from ANY
      // control-type source's bump — not just an event-only source like
      // tap. Whether anything actually fires through it depends on whether
      // that source ever calls fireEventWireTargets (tap on click/keypress,
      // the clock on every beat) — a knob dropped here would just sit
      // inert, same as a tap dropped on a value dot already silently does
      // nothing. Checked before dot-targeting since the pad is the bigger,
      // more likely target when both are near the pointer.
      const padHit = hitTest(graph, point, new Set());
      const validPadHit =
        source &&
        padHit &&
        padHit.id !== source.id &&
        (TRIGGERED_KINDS.has(padHit.kind) || CONTINUOUS_KINDS.has(padHit.kind)) &&
        isWithinPad(effectiveBounds(graph, padHit), point)
          ? padHit
          : null;

      if (validPadHit) {
        state.eventWireHoverTarget = validPadHit.id;
        state.wireHoverTarget = null;
        return;
      }
      state.eventWireHoverTarget = null;

      // hitTestFeatureDot covers an open envelope popup's connection dots
      // (ui/organelle.ts) — outside the generic per-kind column hitTestControl
      // otherwise handles, but the same ControlHit shape either way.
      const hit = hitTestControl(graph, point) ?? hitTestFeatureDot(graph, point);
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
      // A direct manual drag of the volume dot — sticks (canvas y stops
      // driving it) until this entity is dragged again on the canvas
      // itself (see stereoMix.ts's clearLevelOverride, called below at
      // drag-start).
      if (spec.param === 'level') markLevelOverridden(entityId);
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
      // Dragging the box again is what re-engages canvas-position-driven
      // volume after a manual slider override (see stereoMix.ts) — a no-op
      // for anything that was never overridden.
      clearLevelOverride(pressId);
    }

    const entity = graph.get(pressId);
    if (!entity) return;

    const target = { x: point.x - grabOffset.x, y: point.y - grabOffset.y };
    state.dragPointer = target;
    // Live "canvas space as a stereo mixing surface" feedback (ui/stereoMix.ts)
    // — pan/volume follow the box as it's dragged, not just once it's
    // dropped. No-op for a Control entity (knob/clock/tap — checked inside).
    applyPositionToMix(graph, canvas, entity.id, target);

    // Control entities (knobs) never participate in containment — they're
    // never a valid drop target for anything else (already excluded via
    // containerTarget/PROCESSOR_KINDS), and dragging one around should
    // never be interpreted as trying to drop it INTO a pedal either. Per
    // ARCHITECTURE.md §3.2, a Control targets params by explicit reference
    // (the wire), never by nesting.
    if (entity.type === 'control') {
      state.hoverTargetId = null;
      state.hoverDock = false; // controls never dock — see ui/docking.ts's isDockable
      return;
    }

    if (isDockable(entity) && isOverDock(canvas, target)) {
      state.hoverDock = true;
      state.hoverTargetId = null;
      return;
    }
    state.hoverDock = false;

    const exclude = descendantIds(graph, entity.id);
    exclude.add(entity.id);

    // Sticky hover, with an escape: once a container is the hover target,
    // keep it as long as EITHER the cursor itself OR the dragged entity's
    // own centroid stays within its real (undragged) bounds plus a small
    // fixed margin — not within the container's live preview-grown bounds.
    // Checking against the preview bounds is circular here: they're grown
    // specifically to include wherever the dragged entity currently is, so
    // "is the dragged entity still inside" is trivially always true once
    // triggered, no matter how far it's dragged away — which was the bug
    // (impossible to drag something back out of a container). The margin is
    // deliberately small and fixed, not "however big the preview grew" — a
    // little slack so it doesn't flicker right at the exact edge, but the
    // container snaps back once both the cursor and the centroid have left.
    let hoverTarget: Entity | null = null;
    if (state.hoverTargetId) {
      const current = graph.get(state.hoverTargetId);
      if (current) {
        const shrunk = effectiveBounds(graph, current, { excludeId: entity.id, preview: null });
        if (withinBounds(point, shrunk, HOVER_EXIT_MARGIN) || withinBounds(target, shrunk, HOVER_EXIT_MARGIN)) {
          hoverTarget = current;
        }
      }
    }

    if (!hoverTarget) {
      // excludeId only, no preview — a fresh candidate search intentionally
      // uses real (undragged) bounds: "would growing this box now catch the
      // pointer" is circular for a box not yet hovered. Tried against the
      // cursor first — the user expects a drop target to light up the
      // moment the cursor itself crosses into a container's boundary, not
      // only once the dragged box's centroid (which can be well off-cursor,
      // depending on where it was grabbed) gets there — falling back to the
      // centroid so a box whose cursor has strayed outside but whose bulk
      // still visually overlaps the container keeps activating it too.
      const dragCtx: DragContext = { excludeId: entity.id, preview: null };
      hoverTarget =
        containerTarget(hitTest(graph, point, exclude, dragCtx)) ??
        containerTarget(hitTest(graph, target, exclude, dragCtx));
    }

    state.hoverTargetId = hoverTarget ? hoverTarget.id : null;
  });

  function endPress(e: PointerEvent): void {
    if (state.melodyScrollDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.melodyScrollDrag = null;
      return;
    }

    if (state.scrubbingSequencerId) {
      canvas.releasePointerCapture(e.pointerId);
      state.scrubbingSequencerId = null;
      return;
    }

    if (state.resizingSequencer) {
      canvas.releasePointerCapture(e.pointerId);
      state.resizingSequencer = null;
      return;
    }

    if (state.sequencerHScrollDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.sequencerHScrollDrag = null;
      return;
    }

    if (state.sequencerVScrollDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.sequencerVScrollDrag = null;
      return;
    }

    if (state.draggingSequencerEnd) {
      canvas.releasePointerCapture(e.pointerId);
      state.draggingSequencerEnd = null;
      return;
    }

    if (state.draggingSamplerMarker) {
      canvas.releasePointerCapture(e.pointerId);
      const { entityId, ownerId, edge } = state.draggingSamplerMarker;
      // Commit + audition happens once, here, on release — not on every
      // intermediate pointermove during the drag (see ui/sampler.ts's
      // commitTrim comment).
      commitTrim(ownerId, samplerStateFor(entityId), edge);
      state.draggingSamplerMarker = null;
      return;
    }

    if (state.melodyPress) {
      canvas.releasePointerCapture(e.pointerId);
      const press = state.melodyPress;
      if (!press.dragging) {
        // A release without ever crossing DRAG_START_THRESHOLD is a plain
        // click — cycle the item's duration down one step (see TODO.md's
        // melody organelle spec).
        cycleDurationDown(press.item);
      } else if (press.axis === 'x' && press.item.kind === 'note' && press.mergeTarget) {
        // Was hovering a same-pitch note when released (it froze in place
        // rather than reordering — see reorderDuringDrag) — merge into it
        // (TODO.md's spec: dotted/double-dotted notes). If the two
        // durations don't actually form a valid dot relationship, place the
        // note normally instead of the drag having no effect at all.
        if (!mergeIntoTarget(press.entityId, press.item, press.mergeTarget)) {
          forcePlacement(graph, press.entityId, press.item, press.currentPointer.x);
        }
      }
      // A normal horizontal reorder (no merge target) already applied its
      // position live via pointermove above — nothing further to do here.
      state.melodyPress = null;
      return;
    }

    if (state.draggingHandle) {
      canvas.releasePointerCapture(e.pointerId);
      state.draggingHandle = null;
      return;
    }

    if (state.draggingTimeAxis) {
      canvas.releasePointerCapture(e.pointerId);
      state.draggingTimeAxis = null;
      return;
    }

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
      finalizeDrop(graph, canvas, state, pressId);
    }

    pressId = null;
    pressStart = null;
    state.draggingId = null;
    state.dragPointer = null;
    state.hoverTargetId = null;
    state.hoverDock = false;

    // Gate-off for a held pad press (see pointerdown's matching gate-on) —
    // unconditional on release regardless of whether a repositioning drag
    // also happened in between.
    if (state.gatedId) {
      releaseEntity(state.gatedId);
      state.gatedId = null;
    }
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

    // Right-click doubles a melody item's duration one step (TODO.md's
    // spec) — checked first, same priority the melody popup gets in
    // pointerdown, and swallowing the browser's own context menu for any
    // click inside the popup (not just on an item) so it doesn't pop up
    // over what's meant to read as a modal-ish editing surface.
    const melodyHit = hitTestMelodyPopup(graph, point);
    if (melodyHit) {
      e.preventDefault();
      if (melodyHit.kind === 'item') cycleDurationUp(melodyHit.item);
      return;
    }

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

    const hit = hitTestControl(graph, point) ?? hitTestFeatureDot(graph, point);
    if (hit) {
      e.preventDefault();
      removeWireTo(hit.entityId, hit.spec.param);
      return;
    }

    const bodyHit = hitTest(graph, point, new Set());
    if (
      bodyHit &&
      (TRIGGERED_KINDS.has(bodyHit.kind) || CONTINUOUS_KINDS.has(bodyHit.kind)) &&
      isWithinPad(effectiveBounds(graph, bodyHit), point)
    ) {
      e.preventDefault();
      removeEventWiresTo(bodyHit.id);
    }
  });
}

// Letter name -> diatonic step-mod-7 index (0=C, 1=D, ... 6=B) for the
// melody organelle's A-G note-entry shortcut (ui/melody.ts's
// insertLetterNoteAfterSelection) — keyed by e.code so it's independent of
// keyboard layout/shift state the way key-binding elsewhere in this file
// already is.
const LETTER_KEY_INDEX: Record<string, number> = {
  KeyC: 0,
  KeyD: 1,
  KeyE: 2,
  KeyF: 3,
  KeyG: 4,
  KeyA: 5,
  KeyB: 6,
};

// Global keydown handling for tap entities — on `window`, not the canvas,
// since a bound key should fire "from anywhere," not just while the canvas
// has focus. Two mutually exclusive behaviors depending on hover state:
// hovering a tap entity's body means "bind the next key I press to this
// entity" (rebinding always overwrites, see ui/tapBindings.ts); otherwise a
// keydown matching some entity's existing binding fires that entity's tap.
export function attachKeyboard(graph: EntityGraph, state: InteractionState): void {
  window.addEventListener('keydown', (e) => {
    if (isTextureEditorActive()) return; // modal — see the pointerdown/pointermove guards above
    if (e.metaKey || e.ctrlKey || e.altKey) return; // don't steal OS/browser shortcuts

    // Up/Down/Left/Right/Delete/A-G all operate on the melody organelle's
    // current selection (ui/melody.ts's activeSelectedItem — the most
    // recently created or moved note, updated by addNoteAt/
    // updateNotePitchDrag/the drag-reorder and merge paths — but null once
    // that note's own popup has been closed, so a stale selection can't
    // keep acting invisibly). Checked before the tap-binding handling
    // below; if there's no active selection, these fall through to it
    // instead, so keys bound as tap triggers keep working until a melody
    // note exists to select.
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const selected = activeSelectedItem(graph);
      // A rest can be the current selection too (Left/Right/Delete), but
      // has no pitch to nudge — Up/Down simply have nothing to do for one,
      // same as when nothing at all is selected.
      if (selected && selected.item.kind === 'note') {
        nudgePitch(selected.item, e.code === 'ArrowUp' ? 'up' : 'down');
        e.preventDefault();
        return;
      }
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (activeSelectedItem(graph)) {
        selectAdjacentItem(e.code === 'ArrowRight' ? 'next' : 'previous');
        e.preventDefault();
        return;
      }
      // Falls through to the sampler organelle's trim markers (ui/sampler.ts)
      // when there's no active melody selection — the two features
      // shouldn't fight over the same keys, so melody's own selection always
      // takes priority first.
      if (hasSelectedMarker(graph)) {
        nudgeSelectedMarker(e.code === 'ArrowRight' ? 1 : -1);
        e.preventDefault();
        return;
      }
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      if (activeSelectedItem(graph)) {
        deleteSelectedItem();
        e.preventDefault();
        return;
      }
    } else if (e.code in LETTER_KEY_INDEX) {
      // A-G add a new natural note right after the current selection, at
      // whichever octave lands it closest in pitch (TODO.md's melody
      // organelle spec) — see insertLetterNoteAfterSelection. With no
      // current selection at all, fall back to seeding an empty organelle's
      // very first note instead (insertFirstLetterNote), closest to middle
      // C rather than to some nonexistent "current" note.
      const letterIdx = LETTER_KEY_INDEX[e.code];
      if (activeSelectedItem(graph)) {
        insertLetterNoteAfterSelection(letterIdx);
        e.preventDefault();
        return;
      }
      if (insertFirstLetterNote(graph, letterIdx)) {
        e.preventDefault();
        return;
      }
    } else if (e.code === 'Space') {
      if (activeSelectedItem(graph)) {
        insertRestAfterCurrent();
        e.preventDefault();
        return;
      }
    } else if (e.key === '|') {
      // Checked by e.key, not e.code — '|' is a shifted character (e.g.
      // Shift+Backslash on a US layout), and e.code reports the physical
      // key regardless of shift, not the character it produces.
      if (activeSelectedItem(graph)) {
        insertBarlineAfterCurrent();
        e.preventDefault();
        return;
      }
    }

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

function finalizeDrop(
  graph: EntityGraph,
  canvas: HTMLCanvasElement,
  state: InteractionState,
  entityId: string
): void {
  const entity = graph.get(entityId);
  if (!entity || !state.dragPointer) return;

  // Dropped on the dock (ui/dock.ts) — park it there instead of placing it
  // on the canvas. No settle animation: it's no longer part of the canvas
  // tree at all once docked (see EntityGraph.topLevel), so there's nothing
  // left there to animate.
  if (state.hoverDock) {
    dockEntity(graph, entity);
    return;
  }

  const wasDocked = entity.docked;
  entity.docked = false;

  // Trust hoverTargetId rather than re-deriving the drop target from
  // scratch here — it's already been maintained continuously (and stickily,
  // see pointermove above) throughout the drag, and is exactly what was
  // shown highlighted/grown on screen. Recomputing independently risked
  // disagreeing with what the user was looking at when they released.
  const newParentId = state.hoverTargetId;

  // Final settle of the live "canvas as mixing surface" feedback (ui/
  // stereoMix.ts) — normally a no-op vs. the last pointermove's call
  // (state.dragPointer hasn't moved since), but this is also the very
  // first position update for an entity just dragged out of the dock,
  // where the per-move calls already fired too, so it's redundant-but-safe
  // there as well rather than a special case.
  applyPositionToMix(graph, canvas, entityId, state.dragPointer);

  const relative = toRelative(graph, newParentId, state.dragPointer);
  entity.x = relative.x;
  entity.y = relative.y;

  if (entity.parentId !== newParentId) {
    graph.reparent(entityId, newParentId);
    reparentAudio(entityId, newParentId);
  }

  // Dragged out of the dock: build (first time) or reconnect (it was docked
  // before, so its nodes — if any already existed — are currently
  // disconnected) its audio, now that it has a resolved parent (possibly
  // just set above) to connect into.
  if (wasDocked) {
    activateEntity(entity, graph);
  }

  // Independent of whether reparenting happened — dropping one instrument
  // onto another (no containment involved, per the previous change) should
  // still bring the one you just placed to the front of the overlap.
  graph.bringToFront(entityId);

  state.settleAnim = { id: entityId, startedAt: performance.now(), durationMs: 220 };
}
