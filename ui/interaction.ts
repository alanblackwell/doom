// Pointer-driven drag/drop and selection over the entity graph's canvas
// layout. Mutates shared state that render.ts reads each animation frame —
// handlers themselves never draw; the existing rAF loop in main.ts picks up
// whatever state changed here, which is what keeps dragging smooth (no
// synchronous draw calls competing with the frame loop).

import type { Entity, EntityGraph } from '../audio/entityGraph';
import {
  reparentEntity as reparentAudio,
  activateEventTarget,
  getControlSetter,
  rebuildEntity,
  resetEntityToDefaults,
  triggerEntity,
  isEntityPlaying,
  isEntitySustained,
  startSustainableNote,
  stopSustainableNote,
  toggleSustain,
  stopEntity,
  CONTINUOUS_KINDS,
  PROCESSOR_KINDS,
  TRIGGERED_KINDS,
} from '../audio/graph';
import { absolutePosition, descendantIds, effectiveBounds, hitTest, toRelative } from './layout';
import type { DragContext, Point, Rect } from './layout';
import {
  controlsFor,
  hitTestControl,
  hitTestDoomLeverDrop,
  trackGeometry,
  valueFraction,
  valueFromTrackPosition,
} from './controls';
import { CONTROL_CONTAINER_KINDS } from './controlSpecs';
import {
  DOOM_LEVER_GAUGE_RADIUS,
  DOOM_LEVER_LENGTH,
  DOOM_LEVER_MAX_ANGLE,
  DOOM_LEVER_MIN_ANGLE,
  DOOM_LEVER_PITCH_TARGETS,
  doomLeverAngleToValue,
  doomLeverAnchor,
  gaugeAngleToward,
  isWithinLeverRod,
  isWithinRivet,
  leverLengthFraction,
} from './doomLever';
import type { ControlHit, ControlSpec, Track } from './controls';
import { isWithinPad } from './pads';
import { hitTestWireHandle, withinControlBody } from './knobs';
import { addWire, getAllWires, getWiresFrom, removeWireTo } from './wiring';
import { addEventWire, getAllEventWires, getEventWiresFrom, removeEventWire } from './eventWiring';
import { eventWireEndpoints, hitTestWireCurve, valueWireEndpoints } from './wireGeometry';
import { bindKey, getEntityForKey } from './tapBindings';
import { recordSourcePulse } from './eventPulse';
import { scheduleSoon } from '../audio/transport';
import { isOverDock, hitTestDockIcon, isOverDockShowAllToggle, shownDockedEntities } from './dock';
import { isDockable, dockEntity } from './docking';
import { applyPositionToMix, clearLevelOverride, markLevelOverridden } from './stereoMix';
import { isTextureEditorActive } from './textureEditor';
import {
  envelopeValuesFromHandle,
  hitTestFeatureDot,
  hitTestPopup,
  hitTestPorthole,
  ownerOf,
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
  addGrainPoint,
  closeGrainInfoOverlay,
  deleteGrainPoint,
  grainSamplerClearDropPosition,
  grainSamplerDropTargetAt,
  hitTestGrainSamplerPopup,
  pressGrainRecordButton,
  setGrainSource,
  stopGrainCapture,
  updateGrainPointDrag,
} from './grainSampler';
import {
  beginGrindTunerMaxDrag,
  copyGrindTuning,
  grindTunerRawValueAtPoint,
  hitTestGrindTunerPopup,
  setGrindTunerMax,
  setGrindTunerMin,
  setGrindTunerValue,
  toggleGrindTunerExposed,
} from './grindTuner';
import {
  bassTunerRawValueAtPoint,
  beginBassTunerMaxDrag,
  copyBassTuning,
  hitTestBassTunerPopup,
  setBassTunerMax,
  setBassTunerMin,
  setBassTunerValue,
  toggleBassTunerExposed,
} from './bassTuner';
import {
  beginMetalTunerMaxDrag,
  copyMetalTuning,
  hitTestMetalTunerPopup,
  metalTunerRawValueAtPoint,
  setMetalTunerMax,
  setMetalTunerMin,
  setMetalTunerValue,
  toggleMetalTunerExposed,
} from './metalTuner';
import {
  beginGrainTunerMaxDrag,
  copyGrainTuning,
  grainTunerRawValueAtPoint,
  hitTestGrainTunerPopup,
  setGrainTunerMax,
  setGrainTunerMin,
  setGrainTunerValue,
  toggleGrainTunerExposed,
} from './grainTuner';
import {
  beginNoisegateTunerMaxDrag,
  copyNoisegateTuning,
  hitTestNoisegateTunerPopup,
  noisegateTunerRawValueAtPoint,
  setNoisegateTunerMax,
  setNoisegateTunerMin,
  setNoisegateTunerValue,
  toggleNoisegateTunerExposed,
} from './noisegateTuner';
import {
  cycleVocodeMode,
  hitTestVocodeTunerPopup,
  pressVocodeTunerHandle,
  reanalyzeVocodeTuner,
  releaseVocodeTunerHandle,
  setVocodeTunerMarker,
  vocodeTunerHzAtPoint,
} from './vocodeTuner';
import {
  hitTestSynthConfigPopup,
  setSynthConfigValue,
  synthConfigDepthAtPoint,
  toggleSynthWaveform,
} from './synthConfig';
import { reconcileLfoWireTarget } from './lfoWiring';
import {
  applySequencerNoteSnap,
  applySequencerResize,
  attackDecayHandlesCoincide,
  closeVelocitySlider,
  createSequencerNoteAt,
  deleteSelectedNote,
  deselectNote,
  dragSequencerNoteAcross,
  duplicateSelectedNote,
  hasSelectedNote,
  hitTestChannelConnector,
  hitTestSequencerPopup,
  initialNoteSnapState,
  moveSequencerNote,
  nudgeSelectedNotePitch,
  nudgeSelectedNoteTime,
  resizeSequencerNoteLeft,
  resizeSequencerNoteRight,
  resizeSequencerNoteSpan,
  rewindSequencer,
  scrubSequencer,
  secondsAtPopupX,
  sequencerGridScreenBounds,
  selectNote,
  sequencerResizeStart,
  sequencerStateFor,
  settleSequencerNoteAfterDrag,
  setNoteEnvelopeFromHandle,
  setNoteVelocityFromTrack,
  setSelectedNoteEdgeFocus,
  setSelectedNotePitchClass,
  setSelectedNotePitchOctave,
  sharpenSelectedNote,
  setTrackEnd,
  toggleLoopAtEnd,
  toggleSequencer,
  toggleVelocitySlider,
  updateSequencerChannelScrollFromTrackY,
  updateSequencerNoteDragChannel,
  updateSequencerScrollFromTrackX,
  velocityDragTrackAtPointer,
  velocitySliderOpenFor,
  relocateAbandonedEndMarker,
  zoomFromDrag,
  zoomStep,
} from './sequencer';
import type { NoteSnapState, SequencerResizeStart, VelocityTrack } from './sequencer';
import {
  applyBeatMatcherZoomDrag,
  beatMatcherAttackDecayHandlesCoincide,
  beatMatcherClearDropPosition,
  beatMatcherDropTargetAt,
  beatMatcherNoteSnapHoldFraction,
  beatMatcherSecondsAtPoint,
  beatMatcherStateFor,
  beatMatcherTimelineIdAt,
  beatMatcherVelocityDragTrackAtPointer,
  beatMatcherVelocitySliderOpenFor,
  beatMatcherZoomStep,
  applyBeatMatcherNoteSnap,
  captureBeatMatcherSelectionMargins,
  closeBeatMatcherInfoOverlay,
  clearBeatMatcherSelection,
  closeBeatMatcherVelocitySlider,
  createBeatMatcherNoteAt,
  cycleBeatMatcherSpeed,
  deleteBeatMatcherNote,
  deleteSelectedBeatMatcherNote,
  deselectBeatMatcherNote,
  dragBeatMatcherNoteAcross,
  duplicateSelectedBeatMatcherNote,
  focusBeatMatcherSelection,
  hasBeatMatcherSelectionFocus,
  hasSelectedBeatMatcherNote,
  hitTestBeatMatcherPopup,
  initialBeatMatcherNoteSnapState,
  moveBeatMatcherNote,
  nudgeBeatMatcherSelection,
  nudgeSelectedBeatMatcherNotePitch,
  nudgeSelectedBeatMatcherNoteTime,
  pressBeatMatcherRecordButton,
  resizeBeatMatcherNoteLeft,
  resizeBeatMatcherNoteRight,
  resizeBeatMatcherNoteSpan,
  rewindBeatMatcherPlayback,
  scrubBeatMatcherPlayback,
  selectBeatMatcherNote,
  settleBeatMatcherNoteAfterDrag,
  setBeatMatcherCurrentPoint,
  setBeatMatcherEnd,
  setBeatMatcherNoteEnvelopeFromHandle,
  setBeatMatcherNoteVelocityFromTrack,
  setBeatMatcherSelectionEnd,
  setBeatMatcherSelectionRange,
  setBeatMatcherSelectionStart,
  setBeatMatcherSource,
  setBeatMatcherStart,
  setSelectedBeatMatcherNoteEdgeFocus,
  setSelectedBeatMatcherNotePitchClass,
  setSelectedBeatMatcherNotePitchOctave,
  sharpenSelectedBeatMatcherNote,
  stepBeatMatcherCandidate,
  toggleBeatMatcherLoopAtEnd,
  toggleBeatMatcherPlayback,
  toggleBeatMatcherSelectionLoop,
  toggleBeatMatcherVelocitySlider,
  updateBeatMatcherScrollFromTrackX,
} from './beatMatcher';
import type { BeatMatcherNoteSnapState, BeatMatcherVelocityTrack } from './beatMatcher';

// Only sink+source ("pedal") kinds are valid containers for a dragged
// Source/liveInput — nesting one instrument inside another has no coherent
// audio meaning (what would that even route to?), so a drop onto a plain
// source is not a reparent: it's just two boxes ending up visually
// overlapping at wherever it was dropped.
//
// A dragged CONTROL, symmetrically, can only ever target a control-
// CONTAINING control (wander/jitter, CONTROL_CONTAINER_KINDS — see that
// set's own header) — never a PROCESSOR_KINDS pedal (audio routing has no
// meaning for a Control, per ARCHITECTURE.md §3.2's containment-is-routing
// rule) and never another control container (nesting one control container
// inside another has no defined behavior, so it's refused the same way
// nesting a pedal inside another instrument is above).
function containerTarget(hit: Entity | null, dragged: Entity): Entity | null {
  if (!hit) return null;
  if (dragged.type === 'control') {
    if (CONTROL_CONTAINER_KINDS.has(dragged.kind)) return null;
    return CONTROL_CONTAINER_KINDS.has(hit.kind) ? hit : null;
  }
  return PROCESSOR_KINDS.has(hit.kind) ? hit : null;
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
  // Ticked = every ui/dock.ts LESS_USED_KINDS icon is shown too, not just
  // the default set — a plain view toggle, not persisted per-entity state,
  // same "session-local UI preference" footing as e.g. hoverDock itself.
  dockShowAll: boolean;
  // The beat-matcher feature entity (ui/beatMatcher.ts) whose open popup the
  // drag is currently poised to drop a Source/liveInput onto, if any — a
  // reference, not containment (a Control is never a container), so it's
  // tracked independently of hoverTargetId/hoverDock rather than reusing
  // either.
  hoverBeatMatcherId: string | null;
  // Same idiom as hoverBeatMatcherId just above, for an open grain-editor
  // popup (ui/grainSampler.ts) instead — a Source/liveInput entity dropped
  // here is referenced as that grain voice's capture source, also not
  // containment (a feature is never a container either).
  hoverGrainId: string | null;
  settleAnim: { id: string; startedAt: number; durationMs: number } | null;

  // The tap entity the pointer is currently over (pure hover, nothing
  // pressed) — while set, a keydown binds that key to this entity instead
  // of firing whichever entity that key already fires. See attachKeyboard.
  hoveredTapId: string | null;

  // The open beat-matcher popup (if any) the pointer is currently over the
  // note track/selection ruler/spectrogram of — pure hover, same shape as
  // hoveredTapId above. attachKeyboard reads this to capture Tab/Shift-Tab
  // for ui/beatMatcher.ts's stepBeatMatcherCandidate, per that feature's own
  // "anywhere in the spectrogram, ruler or sequencer track" spec.
  hoveredBeatMatcherTimelineId: string | null;

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

  // The most recent pointer position on the canvas, in content coordinates —
  // updated unconditionally on every pointermove regardless of what (if
  // anything) is being dragged. Needed so a per-frame update (e.g.
  // ui/sequencer.ts's updateSequencerAutoscroll) can react to where the
  // pointer currently sits even between pointermove events, since the
  // render loop runs continuously (ui/main.ts's rAF loop) whether or not
  // the pointer is actually moving right now.
  lastPointerPoint: Point | null;

  // A porthole (ui/organelle.ts) pressed but not yet resolved into either a
  // click (open its popup, on release without a drag) or a drag (currently
  // only meaningful for a beat-matcher's porthole, which doubles as its own
  // single event-output jack — see pointermove's own handling). Replaces
  // the porthole's old immediate-on-press open, specifically to leave room
  // for that drag.
  portholePress: { entity: Entity; startPoint: Point } | null;

  // Which entities currently have their doom lever (ui/doomLever.ts)
  // expanded — rivet-only vs. gauge+lever visible. Transient UI state, not
  // an audio-relevant param (unlike doomLeverAngle, which lives in
  // entity.params like every other live-controllable value), so it's a Set
  // here rather than another entity.params flag — same reasoning as every
  // organelle's own `entity.expanded` field, just per-entity-source instead
  // of per-feature-popup.
  doomLeverExpanded: Set<string>;
  // entityId -> performance.now() at the moment its doom lever last toggled
  // expand/collapse — ui/doomLever.ts's leverLengthFraction/gaugeAlpha read
  // this to animate the growth/shrink transition. A Map, not a single slot,
  // so multiple entities' doom levers can be independently mid-animation at
  // once — same "concurrent per-entity animations" reasoning as
  // triggerFlashes below.
  doomLeverTransitionAt: Map<string, number>;
  // A rivet pressed but not yet resolved into either a click (toggle
  // expand/collapse on release without crossing DRAG_START_THRESHOLD) or a
  // drag (starts rotating the lever, only meaningful once this entity's
  // lever is already expanded — see pointermove's own handling). Same
  // click-vs-drag deferral shape as portholePress above.
  doomLeverPress: { entityId: string; startPoint: Point } | null;
  // Set while the lever/needle is actively being rotated by a live drag —
  // either grabbed directly (pressing the rod itself) or promoted from
  // doomLeverPress once a press on the rivet crosses the drag threshold
  // while already expanded.
  draggingDoomLever: { entityId: string } | null;

  // Set while dragging a new wire out from a knob's wire-start handle.
  wiringFrom: { entityId: string; sourcePort?: number } | null;
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
  // Set while directly dragging one of an open grain-editor popup's point
  // markers (ui/grainSampler.ts) — live position updates happen continuously
  // on move, same "no separate commit-on-release step needed" reasoning as
  // moving a beat-matcher note (unlike draggingSamplerMarker above, there's
  // no expensive re-audition to defer to release here).
  draggingGrainPoint: { entityId: string; ownerId: string; pointId: string } | null;
  // A row handle currently being dragged in an open grind-tuning popup
  // (ui/grindTuner.ts) — entityId is the FEATURE entity (the popup itself),
  // key one of ui/grindTuner.ts's ALL_ROW_KEYS, target which of the row's
  // three draggable handles this is.
  grindTunerSliderDrag: { entityId: string; key: string; target: 'value' | 'min' | 'max' } | null;
  // Same shape as grindTunerSliderDrag above, for an open bass-tuning
  // popup (ui/bassTuner.ts) instead.
  bassTunerSliderDrag: { entityId: string; key: string; target: 'value' | 'min' | 'max' } | null;
  // Same shape again, for an open metal-tuning popup (ui/metalTuner.ts).
  metalTunerSliderDrag: { entityId: string; key: string; target: 'value' | 'min' | 'max' } | null;
  // Same shape again, for an open grain-tuning popup (ui/grainTuner.ts).
  grainTunerSliderDrag: { entityId: string; key: string; target: 'value' | 'min' | 'max' } | null;
  // Same shape again, for an open noise-gate-tuning popup
  // (ui/noisegateTuner.ts).
  noisegateTunerSliderDrag: { entityId: string; key: string; target: 'value' | 'min' | 'max' } | null;
  // The vocode pedal's own f0-tuner popup (ui/vocodeTuner.ts) has just one
  // draggable handle (the frequency marker), not a value/min/max trio, so
  // this only needs to remember which feature entity's popup is being
  // dragged.
  vocodeMarkerDrag: { entityId: string } | null;
  // A depth slider currently being dragged in an open synth-config popup
  // (ui/synthConfig.ts) — entityId is the synthConfig FEATURE entity,
  // param one of its two ControlSpec params ('vibratoDepth'/'tremoloDepth').
  synthConfigSliderDrag: { entityId: string; param: string } | null;

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

  // A note being painted, moved, or resized in a sequencer's lanes — same
  // press/threshold shape as melodyPress above: a fresh 'create' drag
  // starts with noteId: null (nothing inserted yet) and only actually
  // creates the note once DRAG_START_THRESHOLD is crossed, at which point it
  // switches to 'createSpan' — both edges set from the press position
  // (anchorSeconds) and the current pointer, whichever ends up earlier
  // becoming the onset (ui/sequencer.ts's resizeSequencerNoteSpan) — so
  // painting backward (right-to-left) works the same as painting forward.
  // `snap` is mutated in place every pointermove by ui/sequencer.ts's
  // applySequencerNoteSnap.
  sequencerNoteDrag: {
    entityId: string;
    channelIndex: number;
    noteId: string | null;
    mode: 'create' | 'move' | 'resizeLeft' | 'resizeRight' | 'createSpan';
    startPointer: Point;
    grabOffsetSeconds: number; // 'move' only — preserves where within the note you grabbed it
    anchorSeconds: number | null; // 'createSpan' only — the press position the span is measured from
    snap: NoteSnapState;
  } | null;

  // The selected sequencer note's own velocity slider being dragged — an
  // absolute-position "fader" drag against a FIXED track captured once at
  // drag-start (see setNoteVelocityFromTrack), same "don't let the track
  // chase the value" reasoning as ui/controls.ts's own draggingControl.
  // That track is either the slider's normal resting position (grabbing it
  // directly while already open) or one newly positioned so the handle
  // lands right at the click (opening it by clicking the percentage text —
  // see velocityDragTrackAtPointer/toggleVelocitySlider).
  sequencerVelocityDrag: { entityId: string; channelIndex: number; noteId: string; track: VelocityTrack } | null;

  // The selected sequencer note's own envelope handle (attack/decaySustain/
  // release) being dragged — absolute-position, same shape as
  // sequencerVelocityDrag above (see setNoteEnvelopeFromHandle). `handle`
  // starts as whatever hitTestSequencerPopup resolved, but a press that
  // lands on 'attack' while it visually coincides with the decaySustain
  // handle (see attackDecayHandlesCoincide) leaves `pendingAxisFrom` set
  // instead of applying anything immediately — pointermove then decides
  // between the two the first time the drag moves far enough (mirroring
  // melodyPress's own "decide the axis once, freeze it" pattern), rewrites
  // `handle` to match, and clears `pendingAxisFrom` for the rest of the
  // drag.
  sequencerEnvelopeDrag: {
    entityId: string;
    channelIndex: number;
    noteId: string;
    handle: HandleKind;
    pendingAxisFrom: Point | null;
  } | null;

  // A beat-matcher note being moved or resized (ui/beatMatcher.ts) — no
  // separate press/threshold stage the way sequencerNoteDrag has: a press on
  // empty track space creates a minimum-duration note immediately, so a
  // plain click still leaves a short, visible note rather than requiring a
  // drag to produce anything at all. That immediate note then starts a
  // 'createSpan' drag — both edges set from the press position (anchorSeconds)
  // and the current pointer, whichever ends up earlier becoming the onset
  // (ui/beatMatcher.ts's resizeBeatMatcherNoteSpan) — so painting backward
  // (right-to-left) works the same as painting forward. `snap` is mutated in
  // place every pointermove by ui/beatMatcher.ts's own
  // applyBeatMatcherNoteSnap, same shape as sequencerNoteDrag's own snap.
  beatMatcherNoteDrag: {
    entityId: string;
    noteId: string;
    mode: 'move' | 'resizeLeft' | 'resizeRight' | 'createSpan';
    grabOffsetSeconds: number; // 'move' only — preserves where within the note you grabbed it
    anchorSeconds: number | null; // 'createSpan' only — the press position the span is measured from
    snap: BeatMatcherNoteSnapState;
  } | null;

  // The beat-matcher feature whose playback line/ruler is currently being
  // scrubbed, or whose horizontal scrollbar is being dragged — same shape
  // as scrubbingSequencerId/sequencerHScrollDrag, independent state (see
  // ui/beatMatcher.ts's own header on why). Zoom-axis dragging reuses the
  // existing draggingTimeAxis field instead of a third one here — see its
  // own comment for how that's branched by feature kind.
  scrubbingBeatMatcherId: string | null;
  beatMatcherHScrollDrag: { entityId: string } | null;
  // The beat-matcher end marker currently being dragged (ui/beatMatcher.ts's
  // setBeatMatcherEnd) — same shape as beatMatcherHScrollDrag above.
  beatMatcherEndDrag: { entityId: string } | null;
  // The beat-matcher start marker currently being dragged (ui/beatMatcher.ts's
  // setBeatMatcherStart) — same shape as beatMatcherEndDrag above.
  beatMatcherStartDrag: { entityId: string } | null;

  // The selected beat-matcher note's own velocity slider being dragged —
  // same shape as sequencerVelocityDrag above (see
  // ui/beatMatcher.ts's setBeatMatcherNoteVelocityFromTrack).
  beatMatcherVelocityDrag: { entityId: string; noteId: string; track: BeatMatcherVelocityTrack } | null;

  // The selected beat-matcher note's own envelope handle being dragged —
  // same shape (including the attack/decaySustain ambiguity resolved by
  // drag direction) as sequencerEnvelopeDrag above (see
  // ui/beatMatcher.ts's setBeatMatcherNoteEnvelopeFromHandle).
  beatMatcherEnvelopeDrag: { entityId: string; noteId: string; handle: HandleKind; pendingAxisFrom: Point | null } | null;

  // The beat-matcher's selection ruler (ui/beatMatcher.ts) being dragged —
  // 'create' is a press on the ruler body itself, not yet resolved into
  // either a click (sets the current point, on release without crossing the
  // drag threshold — see endPress) or a drag (sets the start/end selection
  // region live, from `startSeconds` to wherever the pointer currently is),
  // same press/threshold shape as melodyPress and sequencerNoteDrag's own
  // 'create' mode above. 'resizeStart'/'resizeEnd' are a direct grab of one
  // caret — no click-vs-drag ambiguity, so no threshold/startSeconds needed.
  beatMatcherSelectionDrag:
    | { entityId: string; mode: 'create'; startPointer: Point; startSeconds: number; dragging: boolean }
    | { entityId: string; mode: 'resizeStart' | 'resizeEnd' }
    | null;

  // The beat-matcher selection ruler's own current-point marker being
  // dragged directly — moves the point (and whatever note selection follows
  // it, see ui/beatMatcher.ts's setBeatMatcherCurrentPoint) rather than
  // defining a selection region, distinct from beatMatcherSelectionDrag
  // above.
  beatMatcherCurrentPointDrag: { entityId: string } | null;
}

export function createInteractionState(): InteractionState {
  return {
    selectedId: null,
    draggingId: null,
    dragPointer: null,
    hoverTargetId: null,
    hoverDock: false,
    dockShowAll: false,
    hoverBeatMatcherId: null,
    hoverGrainId: null,
    settleAnim: null,
    hoveredTapId: null,
    hoveredBeatMatcherTimelineId: null,
    hoverControl: null,
    draggingControl: null,
    triggerFlashes: new Map(),
    lastPointerPoint: null,
    portholePress: null,
    doomLeverExpanded: new Set(),
    doomLeverTransitionAt: new Map(),
    doomLeverPress: null,
    draggingDoomLever: null,
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
    draggingGrainPoint: null,
    grindTunerSliderDrag: null,
    bassTunerSliderDrag: null,
    metalTunerSliderDrag: null,
    grainTunerSliderDrag: null,
    noisegateTunerSliderDrag: null,
    vocodeMarkerDrag: null,
    synthConfigSliderDrag: null,
    scrubbingSequencerId: null,
    resizingSequencer: null,
    sequencerHScrollDrag: null,
    sequencerVScrollDrag: null,
    draggingSequencerEnd: null,
    sequencerNoteDrag: null,
    sequencerVelocityDrag: null,
    sequencerEnvelopeDrag: null,
    beatMatcherNoteDrag: null,
    scrubbingBeatMatcherId: null,
    beatMatcherHScrollDrag: null,
    beatMatcherEndDrag: null,
    beatMatcherStartDrag: null,
    beatMatcherVelocityDrag: null,
    beatMatcherEnvelopeDrag: null,
    beatMatcherSelectionDrag: null,
    beatMatcherCurrentPointDrag: null,
  };
}

export function applyControlValue(graph: EntityGraph, entityId: string, param: string, value: number): void {
  const entity = graph.get(entityId);
  if (!entity) return;

  // 'doomLeverAngle' has no real registered control setter of its own (see
  // ui/doomLever.ts's header) — setDoomLeverAngle both writes it into
  // entity.params (so render.ts's live read keeps working) AND applies this
  // entity's own pitch mapping, if it has one. Every OTHER param keeps the
  // plain params-write + control-setter path this function has always used.
  if (param === 'doomLeverAngle') {
    setDoomLeverAngle(graph, entityId, value);
  } else {
    entity.params[param] = value;
    getControlSetter(entityId, param)?.(value);
  }

  // Fan this same value out to anything wired from this (entityId, param) —
  // a knob's own value dot changing is exactly what should drive its wires.
  // Reuses this exact function recursively for the target, so a wired
  // target's own control setter fires the same way a manual slider drag
  // would; nothing downstream needs to know the value came from a wire.
  // Safe from infinite recursion only because wire targets are restricted
  // to non-control entities (see the pointermove wiring-hover check below)
  // — a knob can never itself be a target, so this recurses at most once.
  // An 'lfo' entity's own wires never go through this one-shot value-copy —
  // its 'rate' is a live rate, not a modulation depth/target value, and the
  // wire itself carries a real continuously-running audio-rate signal
  // instead (see ui/lfoWiring.ts's reconcileLfoWireTarget and
  // audio/graph.ts's reconcileSynthConfigModulation/reconcileLfoDotModulation).
  // Without this guard, connecting an LFO to any target would immediately
  // clobber that target's own value with 'rate' remapped into its range,
  // the moment the wire lands (right below, at this function's own "apply
  // immediately" call site in the wiring pointerup handler).
  if (entity.kind === 'lfo') return;

  for (const wire of getWiresFrom(entityId)) {
    if (wire.sourceParam !== param) continue;
    const sourceSpec = controlsFor(entity.kind).find((s) => s.param === param);
    if (!sourceSpec) continue;
    // 'doomLeverAngle' is deliberately not a real ControlSpec (the rivet
    // isn't drawn via the generic per-kind dot column — see
    // ui/controls.ts's hitTestDoomLeverDrop/controlDotAbsolutePosition), so
    // controlsFor(...) can never find it; use its fixed gauge-degree range
    // directly instead of a spec lookup for that one target param.
    let targetMin: number;
    let targetMax: number;
    if (wire.targetParam === 'doomLeverAngle') {
      targetMin = DOOM_LEVER_MIN_ANGLE;
      targetMax = DOOM_LEVER_MAX_ANGLE;
    } else {
      const targetSpec = controlsFor(graph.get(wire.targetEntityId)?.kind ?? '').find(
        (s) => s.param === wire.targetParam
      );
      if (!targetSpec) continue;
      targetMin = targetSpec.min;
      targetMax = targetSpec.max;
    }
    // Normalize against the SOURCE's own range first — value isn't always
    // already a 0-1 fraction (a knob's is, by construction, but e.g. a
    // clock's bpm is 20-300) — then remap that fraction onto the target's
    // range, same as wireOpacity's mapping in ui/render.ts.
    const mapped = targetMin + valueFraction(sourceSpec, value) * (targetMax - targetMin);
    applyControlValue(graph, wire.targetEntityId, wire.targetParam, mapped);
  }
}

// entity.params.doomLeverAngle's one true setter — both the manual
// drag-the-lever gesture (applyDoomLeverAngle below) and an external wire
// dropped onto the rivet (via applyControlValue's own special case above)
// go through this, so "if the lever is visible, the dial and lever should
// move as the control value changes" (render.ts reads entity.params.doomLeverAngle
// live every frame) and the actual pitch mapping stay in lock-step no matter
// which path changed the angle. Deliberately does NOT touch entity.params
// at all for a kind with no DOOM_LEVER_PITCH_TARGETS entry (e.g. growl,
// grain, every filter pedal) — the lever still moves visually for those, it
// just isn't wired to anything yet, exactly as specified.
function setDoomLeverAngle(graph: EntityGraph, entityId: string, angleDeg: number): void {
  const entity = graph.get(entityId);
  if (!entity) return;
  entity.params.doomLeverAngle = angleDeg;
  const mapping = DOOM_LEVER_PITCH_TARGETS[entity.kind];
  if (mapping) {
    const value = doomLeverAngleToValue(angleDeg, mapping.minValue, mapping.maxValue);
    applyControlValue(graph, entityId, mapping.param, value);
  }
}

// Fires a tap entity's single event, scheduled through the transport for
// minimum latency (audio/transport.ts's scheduleSoon) rather than stamping
// the flash/triggering immediately — everything below should visibly happen
// exactly when the event actually lands, not when the tap/keypress
// happened. Reuses the existing triggerFlashes map (already read by
// render.ts's drawPad/drawTap) rather than a parallel per-entity flash
// store, for both the tap's own bump and any instrument it fires.
function fireTap(graph: EntityGraph, entityId: string, state: InteractionState): void {
  scheduleSoon(() => {
    const now = performance.now();
    state.triggerFlashes.set(entityId, now);
    recordSourcePulse(entityId, now); // ui/eventPulse.ts — animates any wire out of this tap's bump
    fireEventWireTargets(graph, entityId, state);
  });
}

// Standard-normal (mean 0, stddev 1) sample via Box-Muller — shared by
// stepControlContainers' own wander walk and jitterDelayMs' own event
// jitter below, the two consumers of CONTROL_CONTAINER_KINDS' "Gaussian
// neighbourhood"/"Gaussian jitter" spec (see controlSpecs.ts's own 'wander'/
// 'jitter' comments). Math.random() can return exactly 0, which would make
// Math.log(u1) diverge to -Infinity — clamped away from that.
function gaussianSample(): number {
  const u1 = Math.max(Math.random(), 1e-9);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// How long to defer this event source's firing before it actually reaches
// its own wired targets — 0 unless it's sitting inside a 'jitter' control
// container (CONTROL_CONTAINER_KINDS), in which case it's a random,
// Gaussian-magnitude delay in milliseconds, scaled by that container's own
// 'amount' (seconds). One-sided (|sample|, never negative) rather than a
// genuine ± spread around the un-jittered onset — the onset has already
// been decided (a keypress just happened, or the transport's own lookahead
// already committed to this exact beat time), so there's no way to honor a
// negative sample; only checks the IMMEDIATE parent, matching
// containerTarget's own refusal to let one control container nest inside
// another (so there's never a chain of these to walk).
function jitterDelayMs(graph: EntityGraph, entityId: string): number {
  const entity = graph.get(entityId);
  const parent = entity?.parentId ? graph.get(entity.parentId) : undefined;
  if (!parent || parent.kind !== 'jitter') return 0;
  const amountSeconds = parent.params.amount ?? 0;
  if (amountSeconds <= 0) return 0;
  return Math.abs(gaussianSample()) * amountSeconds * 1000;
}

// Fires every instrument wired from this event source's bump — deferred by
// jitterDelayMs above first, if this source sits inside a 'jitter' control
// container. Exported so the clock's own recurring per-beat trigger
// (ui/clockPulse.ts) can reuse the exact same firing path a tap's one-off
// click/keypress uses (fireTap above), rather than duplicating it.
export function fireEventWireTargets(graph: EntityGraph, entityId: string, state: InteractionState): void {
  const delayMs = jitterDelayMs(graph, entityId);
  if (delayMs > 0) {
    setTimeout(() => fireEventWireTargetsNow(entityId, state), delayMs);
    return;
  }
  fireEventWireTargetsNow(entityId, state);
}

function fireEventWireTargetsNow(entityId: string, state: InteractionState): void {
  for (const wire of getEventWiresFrom(entityId)) {
    // Trigger (TRIGGERED_KINDS) or toggle play/pause (CONTINUOUS_KINDS),
    // whichever this particular target actually is — see
    // audio/graph.ts's own comment on activateEventTarget.
    activateEventTarget(wire.targetEntityId);
    state.triggerFlashes.set(wire.targetEntityId, performance.now());
  }
}

// How often (ms) a given (childId, param) pair sitting inside a 'wander'
// control container is next due for a fresh Gaussian step — see
// stepControlContainers below. Keyed by a plain string rather than a
// nested Map since a child only ever has a handful of params, not enough to
// justify the extra indirection.
const wanderStepDueAt = new Map<string, number>();

// Steps every 'wander' control container's contained controls by a fresh
// Gaussian-sampled delta, at whatever cadence its own 'rate' dot specifies —
// a "sample and hold random LFO" over each contained control's own value,
// continuing from wherever that value currently sits (itself, not a
// separate stored "center") rather than jumping to a freshly-centered
// range each step, so a manual drag of the contained control's own dot
// seamlessly becomes the walk's new starting point rather than being
// fought/overwritten. Called once per animation frame from ui/main.ts's
// draw loop, `now` the same performance.now() timestamp threaded through
// renderFrame — cheap enough to just walk the whole graph every frame
// rather than tracking which entities are inside a wander container as
// they're dragged in/out.
export function stepControlContainers(graph: EntityGraph, now: number): void {
  for (const entity of graph.all()) {
    if (entity.kind !== 'wander' || entity.docked) continue;
    const rate = entity.params.rate ?? 0;
    const amount = entity.params.amount ?? 0;
    if (rate <= 0 || amount <= 0) continue;
    const intervalMs = 1000 / rate;

    for (const child of graph.childrenOf(entity.id)) {
      if (child.type !== 'control' || CONTROL_CONTAINER_KINDS.has(child.kind)) continue;
      for (const spec of controlsFor(child.kind)) {
        const key = `${child.id}:${spec.param}`;
        const dueAt = wanderStepDueAt.get(key) ?? 0;
        if (now < dueAt) continue;
        wanderStepDueAt.set(key, now + intervalMs);

        const current = child.params[spec.param] ?? spec.min;
        const range = spec.max - spec.min;
        const delta = gaussianSample() * amount * range;
        const next = Math.min(spec.max, Math.max(spec.min, current + delta));
        applyControlValue(graph, child.id, spec.param, next);
      }
    }
  }
}

const DRAG_START_THRESHOLD = 4; // px of movement before a press becomes a drag, vs. a click/select
// "A small amount of expansion is OK" — slack around a container's real
// bounds within which the dragged entity still counts as "inside" once
// already hovering. See the sticky-hover comment below.
const HOVER_EXIT_MARGIN = 32;

// --- Sequencer drags ------------------------------------------------------
// Each pulled out into its own function, rather than left inline in
// pointermove below, so updateSequencerDragAutoscroll further down can
// re-apply the same logic against a synthetic (unmoved) pointer position
// once the view has scrolled — not just from a real pointermove event.

function applySequencerScrub(graph: EntityGraph, entityId: string, point: Point): void {
  // secondsAtPopupX tracks x only, independent of the ruler's own tight
  // vertical hit-zone (hitTestSequencerPopup's 'scrub' case) — a scrub drag
  // should keep tracking even once the pointer strays off the ruler itself,
  // same "drag doesn't need to stay exactly on the control" leniency every
  // other drag in this file already gets via pointer capture.
  const seconds = secondsAtPopupX(graph, entityId, point.x);
  if (seconds !== null) scrubSequencer(sequencerStateFor(entityId), seconds);
}

function applySequencerEndMarkerDrag(graph: EntityGraph, entityId: string, point: Point): void {
  // Same x-only tracking as applySequencerScrub above, so this keeps
  // working even once the pointer strays off the marker band's own tight
  // vertical bounds.
  const seconds = secondsAtPopupX(graph, entityId, point.x);
  if (seconds !== null) setTrackEnd(sequencerStateFor(entityId), seconds);
}

function applySequencerNoteDrag(
  graph: EntityGraph,
  noteDrag: NonNullable<InteractionState['sequencerNoteDrag']>,
  point: Point
): void {
  const rawSeconds = secondsAtPopupX(graph, noteDrag.entityId, point.x);
  if (rawSeconds === null) return;

  let noteId = noteDrag.noteId;
  let mode = noteDrag.mode;

  if (mode === 'create' && noteId === null) {
    const dx = point.x - noteDrag.startPointer.x;
    const dy = point.y - noteDrag.startPointer.y;
    if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
    // Crossing the threshold inserts the note anchored at the original
    // press location, then switches to 'createSpan' — both edges set from
    // that anchor and the current pointer (resizeSequencerNoteSpan) — so
    // painting backward (right-to-left) from here works the same as
    // painting forward.
    const onsetSeconds = secondsAtPopupX(graph, noteDrag.entityId, noteDrag.startPointer.x);
    if (onsetSeconds === null) return;
    const createdId = createSequencerNoteAt(graph, noteDrag.entityId, noteDrag.channelIndex, onsetSeconds);
    if (createdId === null) return;
    noteId = createdId;
    mode = 'createSpan';
    noteDrag.noteId = noteId;
    noteDrag.mode = mode;
    noteDrag.anchorSeconds = onsetSeconds;
    selectNote(noteDrag.entityId, noteDrag.channelIndex, noteId);
    setSelectedNoteEdgeFocus('right');
  }
  if (noteId === null) return;

  // Dragging a note's body across a lane boundary moves it to that channel
  // (if the note's own time range is free there — see the function's own
  // comment) before applying this frame's horizontal position, so the two
  // axes of the same drag gesture both land in one motion rather than
  // needing a separate vertical-only step.
  if (mode === 'move') {
    noteDrag.channelIndex = updateSequencerNoteDragChannel(graph, noteDrag.entityId, noteDrag.channelIndex, noteId, point.y);
  }

  const targetSeconds = mode === 'move' ? rawSeconds - noteDrag.grabOffsetSeconds : rawSeconds;
  const snappedSeconds = applySequencerNoteSnap(
    graph,
    noteDrag.entityId,
    noteDrag.snap,
    noteId,
    targetSeconds,
    point,
    performance.now()
  );

  if (mode === 'resizeLeft') {
    resizeSequencerNoteLeft(graph, noteDrag.entityId, noteDrag.channelIndex, noteId, snappedSeconds);
  } else if (mode === 'resizeRight') {
    resizeSequencerNoteRight(graph, noteDrag.entityId, noteDrag.channelIndex, noteId, snappedSeconds);
  } else if (mode === 'move') {
    // Free during the live drag — can travel over/through other notes — see
    // dragSequencerNoteAcross's own comment; settleSequencerNoteAfterDrag
    // (ui/interaction.ts's own pointerup handling) resolves it back into a
    // free gap once the pointer's actually released.
    dragSequencerNoteAcross(graph, noteDrag.entityId, noteDrag.channelIndex, noteId, snappedSeconds);
  } else if (mode === 'createSpan' && noteDrag.anchorSeconds !== null) {
    resizeSequencerNoteSpan(graph, noteDrag.entityId, noteDrag.channelIndex, noteId, noteDrag.anchorSeconds, snappedSeconds);
  }
}

// Continuously re-applies the active scrub/end-marker/note drag using the
// pointer's own last known position whenever it currently sits left of the
// sequencer timeline's visible left edge or right of its right edge — the
// same "hold near the edge to keep revealing more" behavior most
// drag-and-drop editors have. None of the three drags above are otherwise
// clamped to the currently-visible window (secondsAtPopupX extrapolates
// linearly past either edge with no limit), so without this the user could
// drag a note/cursor/marker to a spot they can no longer see, and the view
// would never scroll to follow it. Called every frame from ui/main.ts's
// render loop, independent of whether the pointer is actually moving right
// now — the render loop itself runs continuously (its own rAF loop), and
// holding the pointer still just past the edge must keep scrolling (and
// keep extending whatever's being dragged, so it doesn't visually drift
// away from a stationary pointer as the view scrolls underneath it) on its
// own.
const AUTOSCROLL_MAX_SPEED_SEC_PER_SEC = 8; // world-seconds revealed per real second, at full overshoot
const AUTOSCROLL_RAMP_PX = 60; // screen-px past the edge that reaches max speed

// Only one of the three drags above can ever be active at a time (pointer
// capture), so a single shared timestamp is enough — updated every call,
// including when nothing is dragging, so a fresh drag's first tick never
// sees a stale, ancient gap.
let lastAutoscrollFrameTime: number | null = null;

export function updateSequencerDragAutoscroll(graph: EntityGraph, state: InteractionState, now: number): void {
  const lastTime = lastAutoscrollFrameTime;
  lastAutoscrollFrameTime = now;

  const entityId = state.scrubbingSequencerId ?? state.draggingSequencerEnd ?? state.sequencerNoteDrag?.entityId ?? null;
  const pointer = state.lastPointerPoint;
  if (!entityId || !pointer || lastTime === null) return;

  const bounds = sequencerGridScreenBounds(graph, entityId);
  if (!bounds) return;

  const dtSeconds = Math.min(0.1, (now - lastTime) / 1000); // caps a huge/first-ever gap from producing one giant jump
  const seqState = sequencerStateFor(entityId);
  if (pointer.x < bounds.left) {
    const fraction = Math.min(1, (bounds.left - pointer.x) / AUTOSCROLL_RAMP_PX);
    seqState.scrollSeconds = Math.max(0, seqState.scrollSeconds - fraction * AUTOSCROLL_MAX_SPEED_SEC_PER_SEC * dtSeconds);
  } else if (pointer.x > bounds.right) {
    // No upper clamp — dragging a note's edge or the end marker itself past
    // the current track end needs to be able to scroll into that
    // not-yet-defined space to extend it, same as setTrackEnd already
    // allows an arbitrary position.
    const fraction = Math.min(1, (pointer.x - bounds.right) / AUTOSCROLL_RAMP_PX);
    seqState.scrollSeconds += fraction * AUTOSCROLL_MAX_SPEED_SEC_PER_SEC * dtSeconds;
  } else {
    return; // pointer is inside the visible window — nothing to extend
  }

  // Re-derive the drag's own value against the just-updated scroll
  // position, using the SAME pointer x — this is what makes the dragged
  // note/cursor/marker keep extending in the scrolled direction instead of
  // visually drifting away from the (unmoved) pointer while the view moves
  // underneath it.
  if (state.scrubbingSequencerId) applySequencerScrub(graph, state.scrubbingSequencerId, pointer);
  else if (state.draggingSequencerEnd) applySequencerEndMarkerDrag(graph, state.draggingSequencerEnd, pointer);
  else if (state.sequencerNoteDrag) applySequencerNoteDrag(graph, state.sequencerNoteDrag, pointer);
}

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

// The doom lever's own rivet/lever hit-test (ui/doomLever.ts) — checked for
// every type:'source' entity uniformly (a pedal/filter kind is still
// architecturally a Source here, same PROCESSOR_KINDS reasoning as
// hitTestControl's own docs). The rivet is always hittable; the rod
// (external lever + internal gauge needle, one continuous grab zone) only
// once that entity's own lever is expanded — there's nothing to grab yet
// otherwise. Returns which entity and whether the hit landed on the
// rod specifically (a rotate-drag should start immediately) vs. the rivet
// itself (deferred to a click/drag distinction — see doomLeverPress).
function hitTestDoomLever(
  graph: EntityGraph,
  state: InteractionState,
  point: Point,
  now: number
): { entityId: string; onRod: boolean } | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'source' || entity.docked) continue;
    const bounds = effectiveBounds(graph, entity);
    const pivot = doomLeverAnchor(bounds);
    if (isWithinRivet(pivot, point)) return { entityId: entity.id, onRod: false };
    if (!state.doomLeverExpanded.has(entity.id)) continue;
    const angle = entity.params.doomLeverAngle ?? 0;
    const length = DOOM_LEVER_LENGTH * leverLengthFraction(true, state.doomLeverTransitionAt.get(entity.id), now);
    // One continuous rod, pivot to tip — covers both the short needle
    // segment inside the gauge face and the external lever segment beyond
    // its rim, so grabbing anywhere along either reads as "grab the lever."
    if (isWithinLeverRod(pivot, angle, 0, DOOM_LEVER_GAUGE_RADIUS + length, point)) {
      return { entityId: entity.id, onRod: true };
    }
  }
  return null;
}

// Snaps `entityId`'s doomLeverAngle to point directly at `point` from its
// own rivet pivot — shared by every place a rotate-drag needs to apply the
// live pointer position (initial grab and every subsequent move). Routed
// through setDoomLeverAngle (not a direct entity.params write) so a manual
// drag applies this entity's own pitch mapping exactly like an incoming
// wire does — see setDoomLeverAngle's own comment.
function applyDoomLeverAngle(graph: EntityGraph, entityId: string, point: Point): void {
  const entity = graph.get(entityId);
  if (!entity) return;
  const bounds = effectiveBounds(graph, entity);
  const pivot = doomLeverAnchor(bounds);
  setDoomLeverAngle(graph, entityId, gaugeAngleToward(pivot, point));
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

    // A press landing on anything other than a sequencer note (or its own
    // inspector) deselects the current note — see the sequencerHit switch
    // below for the note-related exceptions, which (re-)select instead.
    // This can't be done as a single unconditional call up front: the
    // sequencer popup's own hit-test (below) depends on reading the
    // CURRENT selection to know where its inspector cluster is, so
    // clearing it before that hit-test runs would make the inspector
    // ungrabbable. Every branch below that isn't the sequencer popup's own
    // switch is unaffected by selection state, so deselecting there is
    // safe regardless of order.

    // An open melody popup (ui/melody.ts) sits visually on top of everything
    // else too, same reasoning as the envelope popup right below — checked
    // first since it's a distinct feature kind with its own hit-testing
    // (organelle.ts's hitTestPopup only handles kind 'envelope').
    const melodyHit = hitTestMelodyPopup(graph, point);
    if (melodyHit) {
      deselectNote(); // a press elsewhere always clears the sequencer's own note selection
      deselectBeatMatcherNote(); // ...and the beat-matcher's own, same reasoning
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
      deselectNote(); // a press elsewhere always clears the sequencer's own note selection
      deselectBeatMatcherNote(); // ...and the beat-matcher's own, same reasoning
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

    // An open grain-editor popup (ui/grainSampler.ts) sits visually on top
    // of everything else too, same reasoning as the melody/sampler popups
    // above.
    const grainHit = hitTestGrainSamplerPopup(graph, point);
    if (grainHit) {
      switch (grainHit.kind) {
        case 'close': {
          const feature = graph.get(grainHit.entityId);
          if (feature) feature.expanded = false;
          // Same "closing also releases whatever's live" reasoning as the
          // sampler popup's own close case above.
          stopGrainCapture(grainHit.entityId);
          break;
        }
        case 'record':
          pressGrainRecordButton(grainHit.entityId);
          break;
        case 'overlayClose':
          closeGrainInfoOverlay(grainHit.entityId);
          break;
        case 'point':
          canvas.setPointerCapture(e.pointerId);
          state.draggingGrainPoint = {
            entityId: grainHit.entityId,
            ownerId: grainHit.ownerId,
            pointId: grainHit.pointId,
          };
          break;
        case 'band':
          addGrainPoint(grainHit.entityId, grainHit.timeSeconds, grainHit.y);
          break;
        // 'background' is absorbed with no further action, same as every
        // other popup's own catch-all.
      }
      return;
    }

    // An open grind-tuning popup (ui/grindTuner.ts) sits visually on top of
    // everything else too, same reasoning as the melody/sampler popups
    // above.
    const grindTunerHit = hitTestGrindTunerPopup(graph, point);
    if (grindTunerHit) {
      switch (grindTunerHit.kind) {
        case 'close': {
          const feature = graph.get(grindTunerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'checkbox':
          toggleGrindTunerExposed(grindTunerHit.entityId, grindTunerHit.key);
          break;
        case 'slider':
          canvas.setPointerCapture(e.pointerId);
          setGrindTunerValue(graph, grindTunerHit.entityId, grindTunerHit.key, grindTunerHit.value);
          state.grindTunerSliderDrag = { entityId: grindTunerHit.entityId, key: grindTunerHit.key, target: 'value' };
          break;
        case 'minCaret':
          canvas.setPointerCapture(e.pointerId);
          setGrindTunerMin(graph, grindTunerHit.entityId, grindTunerHit.key, grindTunerHit.value);
          state.grindTunerSliderDrag = { entityId: grindTunerHit.entityId, key: grindTunerHit.key, target: 'min' };
          break;
        case 'maxCaret':
          canvas.setPointerCapture(e.pointerId);
          beginGrindTunerMaxDrag(grindTunerHit.entityId, grindTunerHit.key);
          setGrindTunerMax(graph, grindTunerHit.entityId, grindTunerHit.key, grindTunerHit.value);
          state.grindTunerSliderDrag = { entityId: grindTunerHit.entityId, key: grindTunerHit.key, target: 'max' };
          break;
        case 'copy':
          copyGrindTuning(graph, grindTunerHit.entityId);
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler popups' own catch-all.
      }
      return;
    }

    // An open bass-tuning popup (ui/bassTuner.ts) — same shape as the
    // grind-tuning popup just above.
    const bassTunerHit = hitTestBassTunerPopup(graph, point);
    if (bassTunerHit) {
      switch (bassTunerHit.kind) {
        case 'close': {
          const feature = graph.get(bassTunerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'checkbox':
          toggleBassTunerExposed(bassTunerHit.entityId, bassTunerHit.key);
          break;
        case 'slider':
          canvas.setPointerCapture(e.pointerId);
          setBassTunerValue(graph, bassTunerHit.entityId, bassTunerHit.key, bassTunerHit.value);
          state.bassTunerSliderDrag = { entityId: bassTunerHit.entityId, key: bassTunerHit.key, target: 'value' };
          break;
        case 'minCaret':
          canvas.setPointerCapture(e.pointerId);
          setBassTunerMin(graph, bassTunerHit.entityId, bassTunerHit.key, bassTunerHit.value);
          state.bassTunerSliderDrag = { entityId: bassTunerHit.entityId, key: bassTunerHit.key, target: 'min' };
          break;
        case 'maxCaret':
          canvas.setPointerCapture(e.pointerId);
          beginBassTunerMaxDrag(bassTunerHit.entityId, bassTunerHit.key);
          setBassTunerMax(graph, bassTunerHit.entityId, bassTunerHit.key, bassTunerHit.value);
          state.bassTunerSliderDrag = { entityId: bassTunerHit.entityId, key: bassTunerHit.key, target: 'max' };
          break;
        case 'copy':
          copyBassTuning(graph, bassTunerHit.entityId);
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler popups' own catch-all.
      }
      return;
    }

    // An open metal-tuning popup (ui/metalTuner.ts) — same shape as the
    // grind/bass-tuning popups just above.
    const metalTunerHit = hitTestMetalTunerPopup(graph, point);
    if (metalTunerHit) {
      switch (metalTunerHit.kind) {
        case 'close': {
          const feature = graph.get(metalTunerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'checkbox':
          toggleMetalTunerExposed(metalTunerHit.entityId, metalTunerHit.key);
          break;
        case 'slider':
          canvas.setPointerCapture(e.pointerId);
          setMetalTunerValue(graph, metalTunerHit.entityId, metalTunerHit.key, metalTunerHit.value);
          state.metalTunerSliderDrag = { entityId: metalTunerHit.entityId, key: metalTunerHit.key, target: 'value' };
          break;
        case 'minCaret':
          canvas.setPointerCapture(e.pointerId);
          setMetalTunerMin(graph, metalTunerHit.entityId, metalTunerHit.key, metalTunerHit.value);
          state.metalTunerSliderDrag = { entityId: metalTunerHit.entityId, key: metalTunerHit.key, target: 'min' };
          break;
        case 'maxCaret':
          canvas.setPointerCapture(e.pointerId);
          beginMetalTunerMaxDrag(metalTunerHit.entityId, metalTunerHit.key);
          setMetalTunerMax(graph, metalTunerHit.entityId, metalTunerHit.key, metalTunerHit.value);
          state.metalTunerSliderDrag = { entityId: metalTunerHit.entityId, key: metalTunerHit.key, target: 'max' };
          break;
        case 'copy':
          copyMetalTuning(graph, metalTunerHit.entityId);
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler popups' own catch-all.
      }
      return;
    }

    // An open grain-tuning popup (ui/grainTuner.ts) — same shape as the
    // grind/bass/metal-tuning popups just above.
    const grainTunerHit = hitTestGrainTunerPopup(graph, point);
    if (grainTunerHit) {
      switch (grainTunerHit.kind) {
        case 'close': {
          const feature = graph.get(grainTunerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'checkbox':
          toggleGrainTunerExposed(grainTunerHit.entityId, grainTunerHit.key);
          break;
        case 'slider':
          canvas.setPointerCapture(e.pointerId);
          setGrainTunerValue(graph, grainTunerHit.entityId, grainTunerHit.key, grainTunerHit.value);
          state.grainTunerSliderDrag = { entityId: grainTunerHit.entityId, key: grainTunerHit.key, target: 'value' };
          break;
        case 'minCaret':
          canvas.setPointerCapture(e.pointerId);
          setGrainTunerMin(graph, grainTunerHit.entityId, grainTunerHit.key, grainTunerHit.value);
          state.grainTunerSliderDrag = { entityId: grainTunerHit.entityId, key: grainTunerHit.key, target: 'min' };
          break;
        case 'maxCaret':
          canvas.setPointerCapture(e.pointerId);
          beginGrainTunerMaxDrag(grainTunerHit.entityId, grainTunerHit.key);
          setGrainTunerMax(graph, grainTunerHit.entityId, grainTunerHit.key, grainTunerHit.value);
          state.grainTunerSliderDrag = { entityId: grainTunerHit.entityId, key: grainTunerHit.key, target: 'max' };
          break;
        case 'copy':
          copyGrainTuning(graph, grainTunerHit.entityId);
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler popups' own catch-all.
      }
      return;
    }

    // An open noise-gate-tuning popup (ui/noisegateTuner.ts) — same shape
    // as the grind/bass/metal/grain-tuning popups just above.
    const noisegateTunerHit = hitTestNoisegateTunerPopup(graph, point);
    if (noisegateTunerHit) {
      switch (noisegateTunerHit.kind) {
        case 'close': {
          const feature = graph.get(noisegateTunerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'checkbox':
          toggleNoisegateTunerExposed(noisegateTunerHit.entityId, noisegateTunerHit.key);
          break;
        case 'slider':
          canvas.setPointerCapture(e.pointerId);
          setNoisegateTunerValue(graph, noisegateTunerHit.entityId, noisegateTunerHit.key, noisegateTunerHit.value);
          state.noisegateTunerSliderDrag = { entityId: noisegateTunerHit.entityId, key: noisegateTunerHit.key, target: 'value' };
          break;
        case 'minCaret':
          canvas.setPointerCapture(e.pointerId);
          setNoisegateTunerMin(graph, noisegateTunerHit.entityId, noisegateTunerHit.key, noisegateTunerHit.value);
          state.noisegateTunerSliderDrag = { entityId: noisegateTunerHit.entityId, key: noisegateTunerHit.key, target: 'min' };
          break;
        case 'maxCaret':
          canvas.setPointerCapture(e.pointerId);
          beginNoisegateTunerMaxDrag(noisegateTunerHit.entityId, noisegateTunerHit.key);
          setNoisegateTunerMax(graph, noisegateTunerHit.entityId, noisegateTunerHit.key, noisegateTunerHit.value);
          state.noisegateTunerSliderDrag = { entityId: noisegateTunerHit.entityId, key: noisegateTunerHit.key, target: 'max' };
          break;
        case 'copy':
          copyNoisegateTuning(graph, noisegateTunerHit.entityId);
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler popups' own catch-all.
      }
      return;
    }

    // An open vocode f0-tuner popup (ui/vocodeTuner.ts) — one draggable
    // handle (the frequency marker) instead of the value/min/max trio the
    // tuning-constant popups above have, plus a re-analyze button rather
    // than a checkbox/copy pair.
    const vocodeTunerHit = hitTestVocodeTunerPopup(graph, point);
    if (vocodeTunerHit) {
      switch (vocodeTunerHit.kind) {
        case 'close': {
          const feature = graph.get(vocodeTunerHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'marker':
          canvas.setPointerCapture(e.pointerId);
          setVocodeTunerMarker(graph, vocodeTunerHit.entityId, vocodeTunerHit.hz);
          pressVocodeTunerHandle(vocodeTunerHit.entityId);
          state.vocodeMarkerDrag = { entityId: vocodeTunerHit.entityId };
          break;
        case 'reanalyze':
          reanalyzeVocodeTuner(graph, vocodeTunerHit.entityId);
          break;
        case 'mode':
          cycleVocodeMode(graph, vocodeTunerHit.entityId);
          break;
        // 'background' is absorbed with no further action, same as the
        // melody/sampler popups' own catch-all.
      }
      return;
    }

    // An open synth-config popup (ui/synthConfig.ts) — the 'synth' voice's
    // waveform-blend + LFO-depth-port organelle. Same priority as every
    // other feature-kind popup above.
    const synthConfigHit = hitTestSynthConfigPopup(graph, point);
    if (synthConfigHit) {
      switch (synthConfigHit.kind) {
        case 'close': {
          const feature = graph.get(synthConfigHit.entityId);
          if (feature) feature.expanded = false;
          break;
        }
        case 'waveformToggle':
          toggleSynthWaveform(graph, synthConfigHit.entityId, synthConfigHit.wave);
          break;
        case 'depthSlider':
          canvas.setPointerCapture(e.pointerId);
          setSynthConfigValue(graph, synthConfigHit.entityId, synthConfigHit.param, synthConfigHit.value);
          state.synthConfigSliderDrag = { entityId: synthConfigHit.entityId, param: synthConfigHit.param };
          break;
        // 'background' is absorbed with no further action, same as every
        // other popup's own catch-all.
      }
      return;
    }

    // A sequencer channel's own output connector — the multi-port
    // equivalent of a knob's wire-start handle below, checked ahead of
    // hitTestSequencerPopup just below since that popup's own catch-all
    // 'background' hit otherwise absorbs a click anywhere inside its
    // bounds, connector included, before ever reaching that handle check.
    const channelConnectorHit = hitTestChannelConnector(graph, point);
    if (channelConnectorHit) {
      canvas.setPointerCapture(e.pointerId);
      state.wiringFrom = { entityId: channelConnectorHit.controlEntityId, sourcePort: channelConnectorHit.channelIndex };
      state.wireDragPoint = point;
      state.wireHoverTarget = null;
      return;
    }

    // An open sequencer popup (ui/sequencer.ts) sits visually on top of
    // everything else too, same reasoning as the melody/sampler popups
    // above.
    const sequencerHit = hitTestSequencerPopup(graph, point);
    if (sequencerHit) {
      // Every case below re-selects its own note except these seven — for
      // anything else (transport, scrollbars, the end marker, empty lane
      // space, background), a press deselects whatever note was current.
      // noteDuplicateButton doesn't itself call selectNote (it hands off
      // to duplicateSelectedNote, which selects the CLONE instead) but
      // still needs the ORIGINAL to still be selected when that runs, so
      // it's excluded here too.
      if (
        sequencerHit.kind !== 'noteResizeLeft' &&
        sequencerHit.kind !== 'noteResizeRight' &&
        sequencerHit.kind !== 'noteMove' &&
        sequencerHit.kind !== 'noteDuplicateButton' &&
        sequencerHit.kind !== 'noteVelocityTextClick' &&
        sequencerHit.kind !== 'noteVelocitySliderDrag' &&
        sequencerHit.kind !== 'noteEnvelopeHandle'
      ) {
        deselectNote();
        deselectBeatMatcherNote();
      }
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
        case 'axisZoomIn':
        case 'axisZoomOut': {
          // A discrete click, not a drag — no pointer capture needed, same
          // as the transport buttons above.
          const zoomState = sequencerStateFor(sequencerHit.entityId);
          zoomState.zoomSeconds = zoomStep(zoomState.zoomSeconds, sequencerHit.kind === 'axisZoomIn' ? 'in' : 'out');
          relocateAbandonedEndMarker(graph, sequencerHit.entityId);
          break;
        }
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
        case 'noteCreate':
          // Nothing is actually inserted yet — noteId stays null until
          // pointermove crosses DRAG_START_THRESHOLD, so a plain click on
          // empty lane space (no drag at all) creates nothing.
          canvas.setPointerCapture(e.pointerId);
          state.sequencerNoteDrag = {
            entityId: sequencerHit.entityId,
            channelIndex: sequencerHit.channelIndex,
            noteId: null,
            mode: 'create',
            startPointer: point,
            grabOffsetSeconds: 0,
            anchorSeconds: null,
            snap: initialNoteSnapState(point, performance.now()),
          };
          break;
        case 'noteResizeLeft':
        case 'noteResizeRight':
          canvas.setPointerCapture(e.pointerId);
          selectNote(sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId);
          closeVelocitySlider();
          setSelectedNoteEdgeFocus(sequencerHit.kind === 'noteResizeLeft' ? 'left' : 'right');
          state.sequencerNoteDrag = {
            entityId: sequencerHit.entityId,
            channelIndex: sequencerHit.channelIndex,
            noteId: sequencerHit.noteId,
            mode: sequencerHit.kind === 'noteResizeLeft' ? 'resizeLeft' : 'resizeRight',
            startPointer: point,
            grabOffsetSeconds: 0,
            anchorSeconds: null,
            snap: initialNoteSnapState(point, performance.now()),
          };
          break;
        case 'noteMove':
          canvas.setPointerCapture(e.pointerId);
          selectNote(sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId);
          closeVelocitySlider();
          setSelectedNoteEdgeFocus(null);
          state.sequencerNoteDrag = {
            entityId: sequencerHit.entityId,
            channelIndex: sequencerHit.channelIndex,
            noteId: sequencerHit.noteId,
            mode: 'move',
            startPointer: point,
            grabOffsetSeconds: sequencerHit.grabOffsetSeconds,
            anchorSeconds: null,
            snap: initialNoteSnapState(point, performance.now()),
          };
          break;
        case 'noteDuplicateButton':
          // A discrete click, not a drag — no pointer capture needed, same
          // as the transport buttons above. duplicateSelectedNote resolves
          // the note to clone from its own current selection (still the
          // ORIGINAL here — see this switch's own exclusion-list comment)
          // and moves the selection to the clone itself.
          duplicateSelectedNote(graph);
          break;
        case 'noteVelocityTextClick': {
          // Closing (already open) is a discrete toggle, nothing left to
          // drag. Opening immediately starts a drag too, anchored at the
          // click itself — same "the handle appears right where the
          // cursor already is, at the current value" pattern as this
          // app's other sliders (ui/controls.ts's own trackGeometry) —
          // rather than requiring a second click to then find and grab
          // the handle where it happens to have appeared. That track then
          // stays put for as long as the slider is open (see
          // toggleVelocitySlider's own comment) — it must never be
          // recomputed once the drag ends, or the slider would jump.
          const currentVelocity =
            sequencerStateFor(sequencerHit.entityId).channels[sequencerHit.channelIndex].notes.find(
              (n) => n.id === sequencerHit.noteId
            )?.velocity ?? 1;
          const track = toggleVelocitySlider(sequencerHit.noteId, velocityDragTrackAtPointer(point, currentVelocity));
          if (track) {
            canvas.setPointerCapture(e.pointerId);
            state.sequencerVelocityDrag = {
              entityId: sequencerHit.entityId,
              channelIndex: sequencerHit.channelIndex,
              noteId: sequencerHit.noteId,
              track,
            };
          }
          break;
        }
        case 'noteVelocitySliderDrag': {
          canvas.setPointerCapture(e.pointerId);
          selectNote(sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId);
          // The slider's own stored track (wherever it was opened) —
          // reused as-is, never recomputed, so grabbing it again can't
          // make it jump either.
          const track = velocitySliderOpenFor(sequencerHit.noteId);
          if (track) {
            setNoteVelocityFromTrack(sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId, track, point.y); // jump to the click, then keep tracking on move
            state.sequencerVelocityDrag = {
              entityId: sequencerHit.entityId,
              channelIndex: sequencerHit.channelIndex,
              noteId: sequencerHit.noteId,
              track,
            };
          }
          break;
        }
        case 'noteEnvelopeHandle': {
          canvas.setPointerCapture(e.pointerId);
          selectNote(sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId);
          closeVelocitySlider();
          // A press on 'attack' while it's stacked on the still-untouched
          // decaySustain handle stays undecided until the drag actually
          // moves (see pointermove) — applying nothing yet avoids a
          // visible jump if it turns out the user meant to drag decay/
          // sustain instead.
          const ambiguous = sequencerHit.handle === 'attack' && attackDecayHandlesCoincide(sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId);
          if (!ambiguous) {
            setNoteEnvelopeFromHandle(graph, sequencerHit.entityId, sequencerHit.channelIndex, sequencerHit.noteId, sequencerHit.handle, point); // jump to the click, then keep tracking on move
          }
          state.sequencerEnvelopeDrag = {
            entityId: sequencerHit.entityId,
            channelIndex: sequencerHit.channelIndex,
            noteId: sequencerHit.noteId,
            handle: sequencerHit.handle,
            pendingAxisFrom: ambiguous ? point : null,
          };
          break;
        }
        // 'background' is absorbed with no further action, same as the
        // melody/sampler/envelope popups' own catch-all.
      }
      return;
    }

    // An open beat-matcher popup (ui/beatMatcher.ts) — its own independent
    // control kind (see that file's header for why it's not built on the
    // sequencer above), but same "sits on top of everything, checked early"
    // treatment as every other feature popup here.
    const beatMatcherHit = hitTestBeatMatcherPopup(graph, point);
    if (beatMatcherHit) {
      // Every case below re-selects its own note (noteCreate included — a
      // beat-matcher note exists the instant it's created, unlike the
      // sequencer's own deferred-until-drag creation, so it can be selected
      // right away) except the ones listed below — for anything else, a
      // press deselects whatever note was current (currentPointMarkerDrag/
      // selectionRulerPress included: those go through
      // setBeatMatcherCurrentPoint instead, which re-selects on its own if
      // the point lands on a note — see ui/beatMatcher.ts's own comment).
      // noteDuplicateButton doesn't
      // itself call selectBeatMatcherNote (it hands off to
      // duplicateSelectedBeatMatcherNote, which selects the CLONE instead)
      // but still needs the ORIGINAL to still be selected when that runs,
      // so it's excluded here too. Same shape as ui/sequencer.ts's own
      // exclusion-list reasoning.
      if (
        beatMatcherHit.kind !== 'noteResizeLeft' &&
        beatMatcherHit.kind !== 'noteResizeRight' &&
        beatMatcherHit.kind !== 'noteMove' &&
        beatMatcherHit.kind !== 'noteCreate' &&
        beatMatcherHit.kind !== 'suggestionAccept' &&
        beatMatcherHit.kind !== 'noteDuplicateButton' &&
        beatMatcherHit.kind !== 'noteVelocityTextClick' &&
        beatMatcherHit.kind !== 'noteVelocitySliderDrag' &&
        beatMatcherHit.kind !== 'noteEnvelopeHandle'
      ) {
        deselectNote();
        deselectBeatMatcherNote();
      }
      if (beatMatcherHit.kind === 'close') {
        const feature = graph.get(beatMatcherHit.entityId);
        if (feature) feature.expanded = false;
      } else if (beatMatcherHit.kind === 'captureButton') {
        // A discrete click, not a drag — no pointer capture needed, same as
        // the sequencer's own transport buttons. What this actually does
        // depends on current status — see ui/beatMatcher.ts's own header.
        pressBeatMatcherRecordButton(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'infoOverlayClose') {
        closeBeatMatcherInfoOverlay(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'noteCreate') {
        // Immediate, unlike the sequencer's own create-drag threshold — see
        // InteractionState.beatMatcherNoteDrag's own comment for why a plain
        // click still needs to leave something behind here. The drag that
        // follows is 'createSpan', not 'resizeRight' — see that mode's own
        // comment on InteractionState.beatMatcherNoteDrag for why: it lets
        // dragging backward (right-to-left) from this press point work the
        // same as dragging forward.
        const seconds = beatMatcherSecondsAtPoint(graph, beatMatcherHit.entityId, point);
        const noteId = seconds !== null ? createBeatMatcherNoteAt(beatMatcherHit.entityId, seconds) : null;
        if (noteId && seconds !== null) {
          canvas.setPointerCapture(e.pointerId);
          selectBeatMatcherNote(beatMatcherHit.entityId, noteId);
          setSelectedBeatMatcherNoteEdgeFocus('right');
          state.beatMatcherNoteDrag = {
            entityId: beatMatcherHit.entityId,
            noteId,
            mode: 'createSpan',
            grabOffsetSeconds: 0,
            anchorSeconds: seconds,
            snap: initialBeatMatcherNoteSnapState(point, performance.now()),
          };
        }
      } else if (beatMatcherHit.kind === 'suggestionAccept') {
        // Same immediate-creation shape as 'noteCreate' just above, but the
        // onset is already resolved by the hit-test itself (the suggestion
        // line's own candidate seconds — ui/beatMatcher.ts's
        // hitTestSuggestionLine/suggestedBeatMatcherOnsets) rather than the
        // raw click pixel.
        const noteId = createBeatMatcherNoteAt(beatMatcherHit.entityId, beatMatcherHit.seconds);
        if (noteId) {
          canvas.setPointerCapture(e.pointerId);
          selectBeatMatcherNote(beatMatcherHit.entityId, noteId);
          setSelectedBeatMatcherNoteEdgeFocus('right');
          state.beatMatcherNoteDrag = {
            entityId: beatMatcherHit.entityId,
            noteId,
            mode: 'createSpan',
            grabOffsetSeconds: 0,
            anchorSeconds: beatMatcherHit.seconds,
            snap: initialBeatMatcherNoteSnapState(point, performance.now()),
          };
        }
      } else if (beatMatcherHit.kind === 'noteMove') {
        canvas.setPointerCapture(e.pointerId);
        selectBeatMatcherNote(beatMatcherHit.entityId, beatMatcherHit.noteId);
        closeBeatMatcherVelocitySlider();
        setSelectedBeatMatcherNoteEdgeFocus(null);
        state.beatMatcherNoteDrag = {
          entityId: beatMatcherHit.entityId,
          noteId: beatMatcherHit.noteId,
          mode: 'move',
          grabOffsetSeconds: beatMatcherHit.grabOffsetSeconds,
          anchorSeconds: null,
          snap: initialBeatMatcherNoteSnapState(point, performance.now()),
        };
      } else if (beatMatcherHit.kind === 'noteResizeLeft' || beatMatcherHit.kind === 'noteResizeRight') {
        canvas.setPointerCapture(e.pointerId);
        selectBeatMatcherNote(beatMatcherHit.entityId, beatMatcherHit.noteId);
        closeBeatMatcherVelocitySlider();
        setSelectedBeatMatcherNoteEdgeFocus(beatMatcherHit.kind === 'noteResizeLeft' ? 'left' : 'right');
        state.beatMatcherNoteDrag = {
          entityId: beatMatcherHit.entityId,
          noteId: beatMatcherHit.noteId,
          mode: beatMatcherHit.kind === 'noteResizeLeft' ? 'resizeLeft' : 'resizeRight',
          grabOffsetSeconds: 0,
          anchorSeconds: null,
          snap: initialBeatMatcherNoteSnapState(point, performance.now()),
        };
      } else if (beatMatcherHit.kind === 'currentPointMarkerDrag') {
        canvas.setPointerCapture(e.pointerId);
        setBeatMatcherCurrentPoint(beatMatcherHit.entityId, beatMatcherSecondsAtPoint(graph, beatMatcherHit.entityId, point) ?? 0); // jump to the click, then keep tracking on move
        focusBeatMatcherSelection(beatMatcherHit.entityId, 'point');
        state.beatMatcherCurrentPointDrag = { entityId: beatMatcherHit.entityId };
      } else if (beatMatcherHit.kind === 'spectrogramPress') {
        // Same "jump to the click, then keep tracking on move" shape as
        // currentPointMarkerDrag just above — a press directly on the
        // spectrogram picks a reference point exactly the same way, just
        // from a different starting gesture (ui/beatMatcher.ts's own
        // hitTestSpectrogramBand).
        canvas.setPointerCapture(e.pointerId);
        setBeatMatcherCurrentPoint(beatMatcherHit.entityId, beatMatcherHit.seconds);
        focusBeatMatcherSelection(beatMatcherHit.entityId, 'point');
        state.beatMatcherCurrentPointDrag = { entityId: beatMatcherHit.entityId };
      } else if (beatMatcherHit.kind === 'selectionStartCaretDrag') {
        // A press directly on the start caret drags just that edge, rather
        // than starting a new selection — see ui/beatMatcher.ts's own
        // hitTestSelectionStartCaret. Focuses this edge for the keyboard
        // nudge too (see this feature's own spec).
        canvas.setPointerCapture(e.pointerId);
        focusBeatMatcherSelection(beatMatcherHit.entityId, 'start');
        state.beatMatcherSelectionDrag = { entityId: beatMatcherHit.entityId, mode: 'resizeStart' };
      } else if (beatMatcherHit.kind === 'selectionEndCaretDrag') {
        canvas.setPointerCapture(e.pointerId);
        focusBeatMatcherSelection(beatMatcherHit.entityId, 'end');
        state.beatMatcherSelectionDrag = { entityId: beatMatcherHit.entityId, mode: 'resizeEnd' };
      } else if (beatMatcherHit.kind === 'selectionClearButton') {
        // A discrete click, not a drag — no pointer capture needed, same as
        // the note track's own duplicate button.
        clearBeatMatcherSelection(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'selectionLoopToggle') {
        // A discrete click, not a drag — no pointer capture needed, same as
        // the whole-clip end marker's own loop/stop toggle.
        toggleBeatMatcherSelectionLoop(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'selectionRulerPress') {
        // Not yet resolved into a click (sets the current point) or a drag
        // (defines the start/end selection region, and focuses the WHOLE
        // selection for the keyboard nudge the moment it actually starts —
        // see pointermove below) — see this decision in pointermove/endPress
        // below, same press/threshold shape as sequencerNoteDrag's own
        // 'create' mode.
        canvas.setPointerCapture(e.pointerId);
        state.beatMatcherSelectionDrag = {
          entityId: beatMatcherHit.entityId,
          mode: 'create',
          startPointer: point,
          startSeconds: beatMatcherHit.seconds,
          dragging: false,
        };
      } else if (beatMatcherHit.kind === 'noteDuplicateButton') {
        // A discrete click, not a drag — no pointer capture needed, same as
        // the transport buttons above. duplicateSelectedBeatMatcherNote
        // resolves the note to clone from its own current selection (still
        // the ORIGINAL here — see this branch's own exclusion-list comment)
        // and moves the selection to the clone itself.
        duplicateSelectedBeatMatcherNote();
      } else if (beatMatcherHit.kind === 'noteVelocityTextClick') {
        // Closing (already open) is a discrete toggle. Opening immediately
        // starts a drag too, anchored at the click itself — same pattern as
        // ui/sequencer.ts's own noteVelocityTextClick handling.
        const currentVelocity =
          beatMatcherStateFor(beatMatcherHit.entityId).notes.find((n) => n.id === beatMatcherHit.noteId)?.velocity ?? 1;
        const track = toggleBeatMatcherVelocitySlider(beatMatcherHit.noteId, beatMatcherVelocityDragTrackAtPointer(point, currentVelocity));
        if (track) {
          canvas.setPointerCapture(e.pointerId);
          state.beatMatcherVelocityDrag = { entityId: beatMatcherHit.entityId, noteId: beatMatcherHit.noteId, track };
        }
      } else if (beatMatcherHit.kind === 'noteVelocitySliderDrag') {
        canvas.setPointerCapture(e.pointerId);
        selectBeatMatcherNote(beatMatcherHit.entityId, beatMatcherHit.noteId);
        // The slider's own stored track (wherever it was opened) — reused
        // as-is, never recomputed, so grabbing it again can't make it jump.
        const track = beatMatcherVelocitySliderOpenFor(beatMatcherHit.noteId);
        if (track) {
          setBeatMatcherNoteVelocityFromTrack(beatMatcherHit.entityId, beatMatcherHit.noteId, track, point.y); // jump to the click, then keep tracking on move
          state.beatMatcherVelocityDrag = { entityId: beatMatcherHit.entityId, noteId: beatMatcherHit.noteId, track };
        }
      } else if (beatMatcherHit.kind === 'noteEnvelopeHandle') {
        canvas.setPointerCapture(e.pointerId);
        selectBeatMatcherNote(beatMatcherHit.entityId, beatMatcherHit.noteId);
        closeBeatMatcherVelocitySlider();
        // A press on 'attack' while it's stacked on the still-untouched
        // decaySustain handle stays undecided until the drag actually moves
        // (see pointermove) — same as ui/sequencer.ts's own handling.
        const ambiguous =
          beatMatcherHit.handle === 'attack' && beatMatcherAttackDecayHandlesCoincide(beatMatcherHit.entityId, beatMatcherHit.noteId);
        if (!ambiguous) {
          setBeatMatcherNoteEnvelopeFromHandle(graph, beatMatcherHit.entityId, beatMatcherHit.noteId, beatMatcherHit.handle, point); // jump to the click, then keep tracking on move
        }
        state.beatMatcherEnvelopeDrag = {
          entityId: beatMatcherHit.entityId,
          noteId: beatMatcherHit.noteId,
          handle: beatMatcherHit.handle,
          pendingAxisFrom: ambiguous ? point : null,
        };
      } else if (beatMatcherHit.kind === 'rewind') {
        rewindBeatMatcherPlayback(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'play') {
        toggleBeatMatcherPlayback(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'speed') {
        // A discrete click, not a drag — no pointer capture needed, same as
        // the record/transport buttons above. Cycles 1/1 -> 1/2 -> 1/4 -> ...
        cycleBeatMatcherSpeed(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'scrub') {
        canvas.setPointerCapture(e.pointerId);
        scrubBeatMatcherPlayback(beatMatcherHit.entityId, beatMatcherHit.seconds); // jump to the click, then keep tracking on move
        state.scrubbingBeatMatcherId = beatMatcherHit.entityId;
      } else if (beatMatcherHit.kind === 'axisZoomIn' || beatMatcherHit.kind === 'axisZoomOut') {
        // A discrete click, not a drag — no pointer capture needed, same as
        // the zoom icons above the axis handle drag zone.
        beatMatcherZoomStep(beatMatcherHit.entityId, beatMatcherHit.kind === 'axisZoomIn' ? 'in' : 'out');
      } else if (beatMatcherHit.kind === 'axisHandle') {
        canvas.setPointerCapture(e.pointerId);
        state.draggingTimeAxis = {
          entityId: beatMatcherHit.entityId,
          startX: point.x,
          startTimeScale: beatMatcherStateFor(beatMatcherHit.entityId).zoomSeconds,
        };
      } else if (beatMatcherHit.kind === 'hScroll') {
        canvas.setPointerCapture(e.pointerId);
        updateBeatMatcherScrollFromTrackX(graph, beatMatcherHit.entityId, point.x); // jump to the click, then keep tracking on move
        state.beatMatcherHScrollDrag = { entityId: beatMatcherHit.entityId };
      } else if (beatMatcherHit.kind === 'endMarkerToggle' || beatMatcherHit.kind === 'startMarkerToggle') {
        // Same underlying state.loopAtEnd either way — see ui/beatMatcher.ts's
        // start marker header comment for why there are two clickable
        // instances of one toggle.
        toggleBeatMatcherLoopAtEnd(beatMatcherHit.entityId);
      } else if (beatMatcherHit.kind === 'endMarkerDrag') {
        canvas.setPointerCapture(e.pointerId);
        setBeatMatcherEnd(beatMatcherHit.entityId, beatMatcherHit.seconds); // jump to the click, then keep tracking on move
        state.beatMatcherEndDrag = { entityId: beatMatcherHit.entityId };
      } else if (beatMatcherHit.kind === 'startMarkerDrag') {
        canvas.setPointerCapture(e.pointerId);
        setBeatMatcherStart(beatMatcherHit.entityId, beatMatcherHit.seconds); // jump to the click, then keep tracking on move
        state.beatMatcherStartDrag = { entityId: beatMatcherHit.entityId };
      }
      // 'background' is absorbed with no further action, same as every
      // other feature popup's own catch-all.
      return;
    }

    // Nothing past this point is the sequencer or beat-matcher popup, or one
    // of their notes (those branches always returned above) — a press
    // anywhere else on the canvas always clears both features' own note
    // selection.
    deselectNote();
    deselectBeatMatcherNote();

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

    // A feature's porthole (ui/organelle.ts) — click to toggle its popup
    // open/closed, now meaningful in both states (see hitTestPorthole's own
    // comment). Deferred to release rather than resolved immediately here:
    // a beat-matcher's porthole doubles as its own single event-output jack
    // (ui/organelle.ts's portholePosition control-owner case), so a drag
    // away from this same spot needs to be free to start a wire instead —
    // see pointermove's own portholePress handling below.
    const portholeHit = hitTestPorthole(graph, point);
    if (portholeHit) {
      canvas.setPointerCapture(e.pointerId);
      state.portholePress = { entity: portholeHit, startPoint: point };
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

    // The doom lever (ui/doomLever.ts) — every source/filter's own rivet,
    // and (once expanded) its rod. Checked right after control dots, same
    // "small interactive decoration before the plain box" priority; no
    // positional conflict with them either way (dots sit at the box's own
    // left edge via DOT_OUTSET, the rivet at its bottom-center).
    const doomLeverHit = hitTestDoomLever(graph, state, point, performance.now());
    if (doomLeverHit) {
      canvas.setPointerCapture(e.pointerId);
      if (doomLeverHit.onRod) {
        state.draggingDoomLever = { entityId: doomLeverHit.entityId };
        applyDoomLeverAngle(graph, doomLeverHit.entityId, point);
      } else {
        state.doomLeverPress = { entityId: doomLeverHit.entityId, startPoint: point };
      }
      return;
    }

    // The dock's own "show all" toggle (ui/dock.ts) — checked before the
    // icons themselves since it sits inside the same panel, above them.
    if (isOverDockShowAllToggle(canvas, shownDockedEntities(graph, state.dockShowAll).length, point)) {
      state.dockShowAll = !state.dockShowAll;
      return;
    }

    // A docked instrument's icon (ui/dock.ts) — checked before the normal
    // canvas hitTest below since the dock panel visually sits on top of
    // everything else. Pressing it can only ever lead to a drag (undocking,
    // see finalizeDrop) or a plain select; it has no pad/controls to fire.
    const dockHit = hitTestDockIcon(graph, canvas, point, state.dockShowAll);
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
      if (isEntitySustained(hit.id)) {
        // Any click ends a sustain latch, not just another right-click —
        // see the contextmenu handler's own toggleSustain call for how one
        // gets started. Takes priority over the 'sample' pause-button
        // check below: ending the sustain IS this click's meaning here,
        // regardless of what a plain (unsustained) click on this pad would
        // otherwise do.
        toggleSustain(hit.id);
      } else if (isEntityPlaying(hit.id)) {
        // A long-running 'sample' already playing: this press means "stop
        // it" rather than "retrigger" — the pad doubles as a pause button
        // while sound is coming out of it (see ui/render.ts's drawPad for
        // the matching play/pause icon swap). isEntityPlaying is always
        // false for the other TRIGGERED_KINDS (short one-shots), so they
        // always hit the normal trigger branch below.
        stopEntity(hit.id);
      } else {
        triggerEntity(hit.id);
        state.triggerFlashes.set(hit.id, performance.now());
        // Gate-on for a press-and-hold envelope (see endPress's matching
        // gate-off) — a no-op release if this instrument has no envelope
        // feature attached, so tracked unconditionally. Skipped at release
        // time if a right-click has since latched this pad sustaining (see
        // toggleSustain in the contextmenu handler below) — a held note and
        // a sustain latch share the same underlying gate, so releasing on
        // mouse-up would otherwise cut a sustain short.
        state.gatedId = hit.id;
      }
    } else if (CONTINUOUS_KINDS.has(hit.kind) && isWithinPad(effectiveBounds(graph, hit), point)) {
      if (isEntitySustained(hit.id)) {
        // Same "any click ends it" as the TRIGGERED_KINDS branch above.
        toggleSustain(hit.id);
      } else {
        // A melody organelle attached (bow-1's own, so far) takes over this
        // click entirely — advancing through its notes, not a hold gesture —
        // exactly as before, via activateEventTarget (see its own comment
        // in audio/graph.ts). Pulsing also force-opens pauseGate every
        // time, which the new hold-to-sound gesture below would otherwise
        // fight (gating pauseGate closed again on release, right after a
        // pulse just forced it open) — so a melody-equipped drone keeps its
        // own click-to-advance behavior unconditionally, never the new
        // gesture.
        const hasMelody = graph.featuresOf(hit.id).some((f) => f.kind === 'melody');
        if (hasMelody) {
          activateEventTarget(hit.id);
          state.triggerFlashes.set(hit.id, performance.now());
        } else {
          // New: press-and-hold plays it like a single note ("note on" on
          // press, "note off" on release — see endPress below), unifying
          // with a TRIGGERED_KINDS pad's own gesture. A right-click instead
          // latches it playing continuously regardless of hold (see
          // toggleSustain in the contextmenu handler below) — "the current
          // drone" behavior this pad used to give on every plain click.
          startSustainableNote(hit.id);
          state.triggerFlashes.set(hit.id, performance.now());
          state.gatedId = hit.id;
        }
      }
    } else if (hit.kind === 'tap' && withinControlBody(effectiveBounds(graph, hit), point)) {
      // Same "fires on press, still draggable" reasoning as a trigger pad
      // above — a tap entity's whole body is its button (see
      // withinControlBody), not a smaller inset pad.
      fireTap(graph, hit.id, state);
    } else if (hit.kind === 'sequencer' && isWithinPad(effectiveBounds(graph, hit), point)) {
      // The sequencer's own center button — a small inset pad, same as a
      // 'sample' source's own center button above, not the tap's
      // whole-body click (the rest of this control's circle stays a normal
      // drag handle, same as any other control's).
      const feature = graph.featuresOf(hit.id).find((f) => f.kind === 'sequencer');
      if (feature) toggleSequencer(sequencerStateFor(feature.id));
    } else if (hit.kind === 'beatMatcher' && isWithinPad(effectiveBounds(graph, hit), point)) {
      // Same center-button treatment as the sequencer's own, immediately
      // above.
      const feature = graph.featuresOf(hit.id).find((f) => f.kind === 'beatMatcher');
      if (feature) toggleBeatMatcherPlayback(feature.id);
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
    // Kept in sync unconditionally, regardless of what (if anything) is
    // being dragged — a per-frame update (ui/sequencer.ts's
    // updateSequencerAutoscroll) needs to react to where the pointer
    // currently sits even between pointermove events, since the render
    // loop runs continuously (ui/main.ts's rAF loop) whether or not the
    // pointer is actually moving right now.
    state.lastPointerPoint = point;

    if (state.draggingDoomLever) {
      applyDoomLeverAngle(graph, state.draggingDoomLever.entityId, point);
      return;
    }

    if (state.doomLeverPress) {
      const { entityId, startPoint } = state.doomLeverPress;
      if (Math.hypot(point.x - startPoint.x, point.y - startPoint.y) < DRAG_START_THRESHOLD) return;
      // Past the threshold — no longer a pending click (see endPress's
      // matching branch). Only promotes to an actual rotate-drag if this
      // entity's lever is already expanded; otherwise (still collapsed,
      // nothing to grab yet) this just cancels the pending click, same
      // "drag from here does nothing further" shape as portholePress above.
      state.doomLeverPress = null;
      if (state.doomLeverExpanded.has(entityId)) {
        state.draggingDoomLever = { entityId };
        applyDoomLeverAngle(graph, entityId, point);
      }
      return;
    }

    if (state.portholePress) {
      const { entity, startPoint } = state.portholePress;
      if (Math.hypot(point.x - startPoint.x, point.y - startPoint.y) < DRAG_START_THRESHOLD) return;
      // Past the threshold — a drag, not a click, so the popup no longer
      // opens (see endPress's matching branch). Only a beat-matcher's
      // porthole doubles as an event-output jack (ui/organelle.ts's
      // portholePosition control-owner case); anywhere else, a drag from
      // here just cancels the pending click with no further action.
      state.portholePress = null;
      if (entity.kind === 'beatMatcher') {
        const owner = ownerOf(graph, entity);
        if (owner) {
          state.wiringFrom = { entityId: owner.id };
          state.wireDragPoint = point;
          state.wireHoverTarget = null;
          state.eventWireHoverTarget = null;
        }
      }
      return;
    }

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
        relocateAbandonedEndMarker(graph, entityId);
      } else if (feature?.kind === 'beatMatcher') {
        // Same "own module-state zoomSeconds" reasoning as the sequencer
        // case above, independent code (ui/beatMatcher.ts's own header).
        applyBeatMatcherZoomDrag(entityId, startTimeScale, point.x - startX);
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
      applySequencerScrub(graph, state.scrubbingSequencerId, point);
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
      applySequencerEndMarkerDrag(graph, state.draggingSequencerEnd, point);
      return;
    }

    if (state.sequencerNoteDrag) {
      applySequencerNoteDrag(graph, state.sequencerNoteDrag, point);
      return;
    }

    if (state.beatMatcherNoteDrag) {
      const noteDrag = state.beatMatcherNoteDrag;
      const { entityId, noteId, mode, grabOffsetSeconds, anchorSeconds } = noteDrag;
      const rawSeconds = beatMatcherSecondsAtPoint(graph, entityId, point);
      if (rawSeconds !== null) {
        const targetSeconds = mode === 'move' ? rawSeconds - grabOffsetSeconds : rawSeconds;
        const snappedSeconds = applyBeatMatcherNoteSnap(graph, entityId, noteDrag.snap, noteId, targetSeconds, point, performance.now());
        // Free during the live drag — can travel over/through other notes —
        // see dragBeatMatcherNoteAcross's own comment;
        // settleBeatMatcherNoteAfterDrag (this file's own pointerup
        // handling) resolves it back into a free gap once the pointer's
        // actually released.
        if (mode === 'move') dragBeatMatcherNoteAcross(entityId, noteId, snappedSeconds);
        else if (mode === 'resizeLeft') resizeBeatMatcherNoteLeft(entityId, noteId, snappedSeconds);
        else if (mode === 'resizeRight') resizeBeatMatcherNoteRight(entityId, noteId, snappedSeconds);
        else if (anchorSeconds !== null) resizeBeatMatcherNoteSpan(entityId, noteId, anchorSeconds, snappedSeconds);
      }
      return;
    }

    if (state.beatMatcherSelectionDrag) {
      const drag = state.beatMatcherSelectionDrag;
      if (drag.mode === 'create') {
        if (!drag.dragging) {
          const dx = point.x - drag.startPointer.x;
          const dy = point.y - drag.startPointer.y;
          if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
          drag.dragging = true;
          // Only now — an actual region is being defined, not just a
          // still-ambiguous press — does this focus the WHOLE selection for
          // the keyboard nudge (see this feature's own spec).
          focusBeatMatcherSelection(drag.entityId, null);
        }
        const seconds = beatMatcherSecondsAtPoint(graph, drag.entityId, point);
        if (seconds !== null) setBeatMatcherSelectionRange(drag.entityId, drag.startSeconds, seconds);
      } else {
        const seconds = beatMatcherSecondsAtPoint(graph, drag.entityId, point);
        if (seconds !== null) {
          if (drag.mode === 'resizeStart') setBeatMatcherSelectionStart(drag.entityId, seconds);
          else setBeatMatcherSelectionEnd(drag.entityId, seconds);
        }
      }
      // A manual edit to the window — see captureBeatMatcherSelectionMargins'
      // own comment on why stepBeatMatcherCandidate needs this snapshotted.
      captureBeatMatcherSelectionMargins(drag.entityId);
      return;
    }

    if (state.beatMatcherCurrentPointDrag) {
      const { entityId } = state.beatMatcherCurrentPointDrag;
      const seconds = beatMatcherSecondsAtPoint(graph, entityId, point);
      if (seconds !== null) setBeatMatcherCurrentPoint(entityId, seconds);
      return;
    }

    if (state.scrubbingBeatMatcherId) {
      const seconds = beatMatcherSecondsAtPoint(graph, state.scrubbingBeatMatcherId, point);
      if (seconds !== null) scrubBeatMatcherPlayback(state.scrubbingBeatMatcherId, seconds);
      return;
    }

    if (state.beatMatcherHScrollDrag) {
      updateBeatMatcherScrollFromTrackX(graph, state.beatMatcherHScrollDrag.entityId, point.x);
      return;
    }

    if (state.beatMatcherEndDrag) {
      const { entityId } = state.beatMatcherEndDrag;
      const seconds = beatMatcherSecondsAtPoint(graph, entityId, point);
      if (seconds !== null) setBeatMatcherEnd(entityId, seconds);
      return;
    }

    if (state.beatMatcherStartDrag) {
      const { entityId } = state.beatMatcherStartDrag;
      const seconds = beatMatcherSecondsAtPoint(graph, entityId, point);
      if (seconds !== null) setBeatMatcherStart(entityId, seconds);
      return;
    }

    if (state.beatMatcherVelocityDrag) {
      const { entityId, noteId, track } = state.beatMatcherVelocityDrag;
      setBeatMatcherNoteVelocityFromTrack(entityId, noteId, track, point.y);
      return;
    }

    if (state.beatMatcherEnvelopeDrag) {
      const envelopeDrag = state.beatMatcherEnvelopeDrag;
      if (envelopeDrag.pendingAxisFrom) {
        const dx = point.x - envelopeDrag.pendingAxisFrom.x;
        const dy = point.y - envelopeDrag.pendingAxisFrom.y;
        if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
        // Same axis-decision shape as sequencerEnvelopeDrag's own handling
        // above.
        envelopeDrag.handle = Math.abs(dy) > Math.abs(dx) && dy > 0 ? 'decaySustain' : 'attack';
        envelopeDrag.pendingAxisFrom = null;
      }
      setBeatMatcherNoteEnvelopeFromHandle(graph, envelopeDrag.entityId, envelopeDrag.noteId, envelopeDrag.handle, point);
      return;
    }

    if (state.sequencerVelocityDrag) {
      const { entityId, channelIndex, noteId, track } = state.sequencerVelocityDrag;
      setNoteVelocityFromTrack(entityId, channelIndex, noteId, track, point.y);
      return;
    }

    if (state.sequencerEnvelopeDrag) {
      const envelopeDrag = state.sequencerEnvelopeDrag;
      if (envelopeDrag.pendingAxisFrom) {
        const dx = point.x - envelopeDrag.pendingAxisFrom.x;
        const dy = point.y - envelopeDrag.pendingAxisFrom.y;
        if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
        // Decided once, frozen for the rest of the drag — same pattern as
        // melodyPress's own axis decision. A predominantly-downward move
        // means "shape decay/sustain instead"; anything else (including
        // upward, which has nowhere to go from the attack handle's fixed
        // top position) stays a plain attack drag.
        envelopeDrag.handle = Math.abs(dy) > Math.abs(dx) && dy > 0 ? 'decaySustain' : 'attack';
        envelopeDrag.pendingAxisFrom = null;
      }
      setNoteEnvelopeFromHandle(graph, envelopeDrag.entityId, envelopeDrag.channelIndex, envelopeDrag.noteId, envelopeDrag.handle, point);
      return;
    }

    if (state.draggingSamplerMarker) {
      const { entityId, edge } = state.draggingSamplerMarker;
      const layout = scopeLayoutFor(graph, entityId);
      if (layout) updateMarkerDrag(entityId, edge, point, layout);
      return;
    }

    if (state.draggingGrainPoint) {
      const { entityId, pointId } = state.draggingGrainPoint;
      updateGrainPointDrag(entityId, pointId, point, graph);
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

    if (state.grindTunerSliderDrag) {
      const { entityId, key, target } = state.grindTunerSliderDrag;
      const value = grindTunerRawValueAtPoint(graph, entityId, key, point);
      if (value !== null) {
        if (target === 'value') setGrindTunerValue(graph, entityId, key, value);
        else if (target === 'min') setGrindTunerMin(graph, entityId, key, value);
        else setGrindTunerMax(graph, entityId, key, value);
      }
      return;
    }

    if (state.bassTunerSliderDrag) {
      const { entityId, key, target } = state.bassTunerSliderDrag;
      const value = bassTunerRawValueAtPoint(graph, entityId, key, point);
      if (value !== null) {
        if (target === 'value') setBassTunerValue(graph, entityId, key, value);
        else if (target === 'min') setBassTunerMin(graph, entityId, key, value);
        else setBassTunerMax(graph, entityId, key, value);
      }
      return;
    }

    if (state.metalTunerSliderDrag) {
      const { entityId, key, target } = state.metalTunerSliderDrag;
      const value = metalTunerRawValueAtPoint(graph, entityId, key, point);
      if (value !== null) {
        if (target === 'value') setMetalTunerValue(graph, entityId, key, value);
        else if (target === 'min') setMetalTunerMin(graph, entityId, key, value);
        else setMetalTunerMax(graph, entityId, key, value);
      }
      return;
    }

    if (state.grainTunerSliderDrag) {
      const { entityId, key, target } = state.grainTunerSliderDrag;
      const value = grainTunerRawValueAtPoint(graph, entityId, key, point);
      if (value !== null) {
        if (target === 'value') setGrainTunerValue(graph, entityId, key, value);
        else if (target === 'min') setGrainTunerMin(graph, entityId, key, value);
        else setGrainTunerMax(graph, entityId, key, value);
      }
      return;
    }

    if (state.noisegateTunerSliderDrag) {
      const { entityId, key, target } = state.noisegateTunerSliderDrag;
      const value = noisegateTunerRawValueAtPoint(graph, entityId, key, point);
      if (value !== null) {
        if (target === 'value') setNoisegateTunerValue(graph, entityId, key, value);
        else if (target === 'min') setNoisegateTunerMin(graph, entityId, key, value);
        else setNoisegateTunerMax(graph, entityId, key, value);
      }
      return;
    }

    if (state.vocodeMarkerDrag) {
      const { entityId } = state.vocodeMarkerDrag;
      const hz = vocodeTunerHzAtPoint(graph, entityId, point);
      if (hz !== null) setVocodeTunerMarker(graph, entityId, hz);
      return;
    }

    if (state.synthConfigSliderDrag) {
      const { entityId, param } = state.synthConfigSliderDrag;
      const value = synthConfigDepthAtPoint(graph, entityId, point);
      if (value !== null) setSynthConfigValue(graph, entityId, param, value);
      return;
    }

    if (state.wiringFrom) {
      state.wireDragPoint = point;
      const source = graph.get(state.wiringFrom.entityId);

      // A TRIGGERED_KINDS instrument's or CONTINUOUS_KINDS drone's whole pad
      // circle (see ui/pads.ts), or a sequencer/beat-matcher control's own
      // center play/pause button (ui/sequencer.ts's drawSequencerPlayButton/
      // ui/beatMatcher.ts's drawBeatMatcherPlayButton, same padRadius
      // geometry) — always a valid drop target from ANY control-type
      // source's bump, not just an event-only source like tap. Whether
      // anything actually fires through it depends on whether that source
      // ever calls fireEventWireTargets (tap on click/keypress, the clock on
      // every beat) — a knob dropped here would just sit inert, same as a
      // tap dropped on a value dot already silently does nothing. Checked
      // before dot-targeting since the pad is the bigger, more likely
      // target when both are near the pointer.
      const padHit = hitTest(graph, point, new Set());
      const validPadHit =
        source &&
        padHit &&
        padHit.id !== source.id &&
        (TRIGGERED_KINDS.has(padHit.kind) ||
          CONTINUOUS_KINDS.has(padHit.kind) ||
          padHit.kind === 'sequencer' ||
          padHit.kind === 'beatMatcher') &&
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
      // hitTestDoomLeverDrop covers the rivet — "a connection point for
      // dropping control lines" per the doom lever's own spec, deliberately
      // not a real ControlSpec so it isn't part of hitTestControl's own
      // per-kind column scan.
      const hit = hitTestControl(graph, point) ?? hitTestFeatureDot(graph, point) ?? hitTestDoomLeverDrop(graph, point);
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

      // Separately, whether the pointer is over an open beat-matcher's
      // note track/selection ruler/spectrogram — attachKeyboard reads this
      // to capture Tab/Shift-Tab (ui/beatMatcher.ts's own
      // beatMatcherTimelineIdAt/stepBeatMatcherCandidate).
      state.hoveredBeatMatcherTimelineId = beatMatcherTimelineIdAt(graph, point);
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

    // No Control (knob/clock/tap/lfo/sequencer/beatMatcher, or a control-
    // CONTAINING control like wander/jitter, CONTROL_CONTAINER_KINDS) ever
    // participates in the dock, or in an open beat-matcher/grain-editor
    // popup's own "reference this as my capture source" drop (neither has
    // any audio output to capture, and a Control never docks — see
    // ui/docking.ts's isDockable). It CAN still target a control container
    // though — the one deliberate exception to ARCHITECTURE.md §3.2's
    // "a Control targets params by explicit reference (the wire), never by
    // nesting" rule (see CONTROL_CONTAINER_KINDS' own header) — so this
    // still falls through to the shared container-hover search below,
    // rather than returning early the way it used to.
    if (entity.type === 'control') {
      state.hoverDock = false;
      state.hoverBeatMatcherId = null;
      state.hoverGrainId = null;
    } else {
      // Dragging a Source/liveInput over an open beat-matcher popup (ui/
      // beatMatcher.ts) references it as that beat-matcher's capture source
      // on drop — not containment, so this is checked ahead of, and
      // mutually exclusive with, the dock/container-hover checks below,
      // same "one drop-target cue at a time" priority the dock check gets.
      const beatMatcherId = beatMatcherDropTargetAt(graph, target) ?? beatMatcherDropTargetAt(graph, point);
      if (beatMatcherId) {
        state.hoverBeatMatcherId = beatMatcherId;
        state.hoverGrainId = null;
        state.hoverTargetId = null;
        state.hoverDock = false;
        return;
      }
      state.hoverBeatMatcherId = null;

      // Same idiom, for an open grain-editor popup (ui/grainSampler.ts)
      // instead — see hoverGrainId's own comment.
      const grainId = grainSamplerDropTargetAt(graph, target) ?? grainSamplerDropTargetAt(graph, point);
      if (grainId) {
        state.hoverGrainId = grainId;
        state.hoverTargetId = null;
        state.hoverDock = false;
        return;
      }
      state.hoverGrainId = null;
    }

    if (isDockable(entity) && isOverDock(canvas, graph, target, state.dockShowAll)) {
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
        containerTarget(hitTest(graph, point, exclude, dragCtx), entity) ??
        containerTarget(hitTest(graph, target, exclude, dragCtx), entity);
    }

    state.hoverTargetId = hoverTarget ? hoverTarget.id : null;
  });

  function endPress(e: PointerEvent): void {
    if (state.draggingDoomLever) {
      canvas.releasePointerCapture(e.pointerId);
      state.draggingDoomLever = null;
      return;
    }

    if (state.doomLeverPress) {
      // Never dragged past the threshold (pointermove's own doomLeverPress
      // branch would have cleared this otherwise) — a plain click on the
      // rivet, so it toggles expand/collapse now, recording this moment so
      // ui/render.ts's leverLengthFraction/gaugeAlpha can animate the
      // transition from here.
      canvas.releasePointerCapture(e.pointerId);
      const { entityId } = state.doomLeverPress;
      if (state.doomLeverExpanded.has(entityId)) {
        state.doomLeverExpanded.delete(entityId);
      } else {
        state.doomLeverExpanded.add(entityId);
      }
      state.doomLeverTransitionAt.set(entityId, performance.now());
      state.doomLeverPress = null;
      return;
    }

    if (state.portholePress) {
      // Never dragged past the threshold (pointermove's own portholePress
      // branch would have cleared this otherwise) — a plain click, so it
      // toggles now, same as the porthole's old immediate-on-press open
      // just deferred to release. A toggle rather than always opening,
      // since hitTestPorthole now matches an already-expanded feature too
      // (where a click should close it instead) — for a still-collapsed
      // one this is equivalent to the old unconditional open.
      canvas.releasePointerCapture(e.pointerId);
      state.portholePress.entity.expanded = !state.portholePress.entity.expanded;
      state.portholePress = null;
      return;
    }

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

    if (state.sequencerNoteDrag) {
      // A plain click that never crossed the threshold (noteId still null)
      // creates nothing — the note's final state is otherwise already
      // committed live by every pointermove above, EXCEPT a 'move' drag:
      // dragSequencerNoteAcross tracks the pointer freely, including over
      // other notes, so it may currently be overlapping one — this settle
      // step snaps it back into a genuinely free gap now that the pointer's
      // actually being released.
      const drag = state.sequencerNoteDrag;
      if (drag.mode === 'move' && drag.noteId !== null) {
        settleSequencerNoteAfterDrag(graph, drag.entityId, drag.channelIndex, drag.noteId);
      }
      canvas.releasePointerCapture(e.pointerId);
      state.sequencerNoteDrag = null;
      return;
    }

    if (state.beatMatcherNoteDrag) {
      // dragBeatMatcherNoteAcross tracks the pointer freely during a 'move'
      // drag, including over other notes, so it may currently be
      // overlapping one — this settle step snaps it back into a genuinely
      // free gap now that the pointer's actually being released. Same
      // shape as this file's own sequencerNoteDrag handling just above.
      const drag = state.beatMatcherNoteDrag;
      if (drag.mode === 'move') {
        settleBeatMatcherNoteAfterDrag(drag.entityId, drag.noteId);
      }
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherNoteDrag = null;
      return;
    }

    if (state.beatMatcherSelectionDrag) {
      canvas.releasePointerCapture(e.pointerId);
      const drag = state.beatMatcherSelectionDrag;
      if (drag.mode === 'create' && !drag.dragging) {
        // Never crossed the drag threshold — a plain click, so it sets the
        // current point instead of leaving a zero-length selection region,
        // and focuses it for the keyboard nudge too.
        setBeatMatcherCurrentPoint(drag.entityId, drag.startSeconds);
        focusBeatMatcherSelection(drag.entityId, 'point');
      }
      // A real drag (of any mode) already committed the selection region
      // live via every pointermove above — nothing further to do here.
      state.beatMatcherSelectionDrag = null;
      return;
    }

    if (state.beatMatcherCurrentPointDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherCurrentPointDrag = null;
      return;
    }

    if (state.scrubbingBeatMatcherId) {
      canvas.releasePointerCapture(e.pointerId);
      state.scrubbingBeatMatcherId = null;
      return;
    }

    if (state.beatMatcherHScrollDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherHScrollDrag = null;
      return;
    }

    if (state.beatMatcherEndDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherEndDrag = null;
      return;
    }

    if (state.beatMatcherStartDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherStartDrag = null;
      return;
    }

    if (state.beatMatcherVelocityDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherVelocityDrag = null;
      return;
    }

    if (state.beatMatcherEnvelopeDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.beatMatcherEnvelopeDrag = null;
      return;
    }

    if (state.sequencerVelocityDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.sequencerVelocityDrag = null;
      return;
    }

    if (state.sequencerEnvelopeDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.sequencerEnvelopeDrag = null;
      return;
    }

    if (state.grindTunerSliderDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.grindTunerSliderDrag = null;
      return;
    }

    if (state.bassTunerSliderDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.bassTunerSliderDrag = null;
      return;
    }

    if (state.metalTunerSliderDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.metalTunerSliderDrag = null;
      return;
    }

    if (state.grainTunerSliderDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.grainTunerSliderDrag = null;
      return;
    }

    if (state.noisegateTunerSliderDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.noisegateTunerSliderDrag = null;
      return;
    }

    if (state.synthConfigSliderDrag) {
      canvas.releasePointerCapture(e.pointerId);
      state.synthConfigSliderDrag = null;
      return;
    }

    if (state.vocodeMarkerDrag) {
      canvas.releasePointerCapture(e.pointerId);
      releaseVocodeTunerHandle(state.vocodeMarkerDrag.entityId);
      state.vocodeMarkerDrag = null;
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

    if (state.draggingGrainPoint) {
      canvas.releasePointerCapture(e.pointerId);
      state.draggingGrainPoint = null;
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
        addEventWire(state.wiringFrom.entityId, state.eventWireHoverTarget, state.wiringFrom.sourcePort);
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
          // The real audio-rate connection an 'lfo' source's own wire needs
          // — see ui/lfoWiring.ts's reconcileLfoWireTarget and
          // applyControlValue's own 'lfo' guard above. A no-op unless this
          // wire's source is actually an lfo.
          reconcileLfoWireTarget(graph, state.wireHoverTarget.entityId, state.wireHoverTarget.spec.param);
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
    state.hoverBeatMatcherId = null;
    state.hoverGrainId = null;

    // Gate-off for a held pad press (see pointerdown's matching gate-on) —
    // happens on release regardless of whether a repositioning drag also
    // happened in between, UNLESS a right-click has since latched this same
    // pad sustaining (toggleSustain, in the contextmenu handler below) — a
    // held note and a sustain latch share the same gate, so releasing here
    // would otherwise cut a sustain short the moment this press's own
    // mouse-up fires. stopSustainableNote (not releaseEntity directly)
    // since this same gate-off now also covers a CONTINUOUS_KINDS pad's own
    // new hold-to-sound gesture, not just a TRIGGERED_KINDS envelope.
    if (state.gatedId) {
      if (!isEntitySustained(state.gatedId)) {
        stopSustainableNote(state.gatedId);
      }
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

    // Right-click removes a beat-matcher note — same priority/reasoning as
    // the melody popup above (swallow the browser's own menu for any click
    // inside this popup, note-authoring track included).
    const beatMatcherHit = hitTestBeatMatcherPopup(graph, point);
    if (beatMatcherHit) {
      e.preventDefault();
      if (
        beatMatcherHit.kind === 'noteMove' ||
        beatMatcherHit.kind === 'noteResizeLeft' ||
        beatMatcherHit.kind === 'noteResizeRight'
      ) {
        deleteBeatMatcherNote(beatMatcherHit.entityId, beatMatcherHit.noteId);
      }
      return;
    }

    // Right-click removes a grain point — same priority/reasoning as the
    // melody/beat-matcher popups above.
    const grainHit = hitTestGrainSamplerPopup(graph, point);
    if (grainHit) {
      e.preventDefault();
      if (grainHit.kind === 'point') {
        deleteGrainPoint(grainHit.entityId, grainHit.pointId);
      }
      return;
    }

    for (const wire of getAllWires()) {
      const endpoints = valueWireEndpoints(graph, wire);
      if (endpoints && hitTestWireCurve(ctx2d, endpoints, point)) {
        e.preventDefault();
        removeWireTo(wire.targetEntityId, wire.targetParam);
        reconcileLfoWireTarget(graph, wire.targetEntityId, wire.targetParam);
        return;
      }
    }
    for (const wire of getAllEventWires()) {
      const endpoints = eventWireEndpoints(graph, wire);
      if (endpoints && hitTestWireCurve(ctx2d, endpoints, point)) {
        e.preventDefault();
        removeEventWire(wire.sourceEntityId, wire.targetEntityId, wire.sourcePort);
        return;
      }
    }

    // hitTestDoomLeverDrop alongside the other two so a wire terminating at
    // the rivet can be right-click-removed the same way any other control
    // dot's wire can.
    const hit = hitTestControl(graph, point) ?? hitTestFeatureDot(graph, point) ?? hitTestDoomLeverDrop(graph, point);
    if (hit) {
      e.preventDefault();
      removeWireTo(hit.entityId, hit.spec.param);
      reconcileLfoWireTarget(graph, hit.entityId, hit.spec.param);
      return;
    }

    // A pad's own sustain switch (see this file's pointerdown/endPress for
    // the matching press-and-hold gesture, and audio/graph.ts's
    // toggleSustain for what each kind's own gate-on/off actually does):
    // first right-click latches it sounding regardless of hold, a second
    // releases/pauses it again. Replaces this pad's own former right-click
    // behavior (bulk-clearing every event wire feeding it) — an individual
    // event wire can still be removed by right-clicking its own curve
    // (checked above), just not the whole pad in one click anymore.
    const bodyHit = hitTest(graph, point, new Set());
    if (
      bodyHit &&
      (TRIGGERED_KINDS.has(bodyHit.kind) || CONTINUOUS_KINDS.has(bodyHit.kind)) &&
      isWithinPad(effectiveBounds(graph, bodyHit), point)
    ) {
      e.preventDefault();
      toggleSustain(bodyHit.id);
      if (isEntitySustained(bodyHit.id)) {
        state.triggerFlashes.set(bodyHit.id, performance.now());
      }
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

// Same A-G keys, but as a chromatic pitch-class semitone offset (0=C ...
// 11=B) rather than a diatonic step index — the sequencer organelle's own
// pitch-entry shortcut (setSelectedNotePitchClass), which has no notion of
// "diatonic" the way the melody organelle's key-of-C staff does.
const PITCH_CLASS_KEY: Record<string, number> = {
  KeyC: 0,
  KeyD: 2,
  KeyE: 4,
  KeyF: 5,
  KeyG: 7,
  KeyA: 9,
  KeyB: 11,
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

    // Tab/Shift-Tab step the beat-matcher's current point to the
    // next/previous onset candidate (ui/beatMatcher.ts's own
    // stepBeatMatcherCandidate) — captured, ahead of everything else below
    // (including the browser's own default focus-cycling), whenever the
    // pointer is hovering that popup's note track/selection ruler/
    // spectrogram (state.hoveredBeatMatcherTimelineId, tracked on pure
    // hover in this file's own pointermove handling), per this feature's
    // own "anywhere in the spectrogram, ruler or sequencer track" spec.
    if (e.code === 'Tab' && state.hoveredBeatMatcherTimelineId) {
      stepBeatMatcherCandidate(state.hoveredBeatMatcherTimelineId, e.shiftKey ? -1 : 1);
      e.preventDefault();
      return;
    }

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
      // Falls through to a selected sequencer note when there's no active
      // melody selection, same priority order as every other key below —
      // nudges its pitch by a semitone (see nudgeSelectedNotePitch's own
      // comment on the null-pitch/"X" first-press special case).
      if (hasSelectedNote()) {
        nudgeSelectedNotePitch(e.code === 'ArrowUp' ? 1 : -1);
        e.preventDefault();
        return;
      }
      // Then a selected beat-matcher note, same fall-through order and
      // null-pitch/"X" first-press special case as the sequencer's own
      // nudgeSelectedBeatMatcherNotePitch.
      if (hasSelectedBeatMatcherNote()) {
        nudgeSelectedBeatMatcherNotePitch(e.code === 'ArrowUp' ? 1 : -1);
        e.preventDefault();
        return;
      }
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      // The beat-matcher's own selection ruler acts as a genuinely "special"
      // keyboard focus (per this feature's own spec) — checked FIRST, ahead
      // of melody/sampler/sequencer/beat-matcher-note selection, so a stale
      // selection left over in one of those (e.g. a sequencer note selected
      // earlier in the session, whose popup was since closed) can never
      // silently swallow the arrow key meant for the selection the user just
      // touched. hasBeatMatcherSelectionFocus() is only ever true right
      // after a real drag on the ruler (see ui/beatMatcher.ts's own
      // resolvedSelectionFocus), so this can't misfire for unrelated work.
      if (hasBeatMatcherSelectionFocus()) {
        nudgeBeatMatcherSelection(graph, e.code === 'ArrowRight' ? 1 : -1);
        e.preventDefault();
        return;
      }
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
      // Then a selected sequencer note, same fall-through order as above.
      if (hasSelectedNote()) {
        nudgeSelectedNoteTime(graph, e.code === 'ArrowRight' ? 1 : -1);
        e.preventDefault();
        return;
      }
      // Then a selected beat-matcher note, same fall-through order.
      if (hasSelectedBeatMatcherNote()) {
        nudgeSelectedBeatMatcherNoteTime(graph, e.code === 'ArrowRight' ? 1 : -1);
        e.preventDefault();
        return;
      }
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      if (activeSelectedItem(graph)) {
        deleteSelectedItem();
        e.preventDefault();
        return;
      }
      if (hasSelectedNote()) {
        deleteSelectedNote();
        e.preventDefault();
        return;
      }
      if (hasSelectedBeatMatcherNote()) {
        deleteSelectedBeatMatcherNote();
        e.preventDefault();
        return;
      }
    } else if (e.code === 'KeyR' && (hasSelectedNote() || hasSelectedBeatMatcherNote())) {
      // Not in LETTER_KEY_INDEX below (C/D/E/F/G/A/B only), so this never
      // competes with the melody organelle's own letter-key note entry.
      // Sequencer selection takes priority, same order as every other key
      // here — the two features' selections are mutually exclusive in
      // practice (selecting one always deselects the other, see
      // ui/interaction.ts's own pointerdown), so this is really just
      // "whichever one is currently selected."
      if (hasSelectedNote()) {
        duplicateSelectedNote(graph);
      } else {
        duplicateSelectedBeatMatcherNote();
      }
      e.preventDefault();
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
      // Falls through to a selected sequencer note, same priority order as
      // every other key above — sets its pitch class, leaving whatever
      // octave it already has (or DEFAULT_SEED_PITCH's, if it's still "X")
      // alone. See setSelectedNotePitchClass/PITCH_CLASS_KEY.
      if (hasSelectedNote()) {
        setSelectedNotePitchClass(PITCH_CLASS_KEY[e.code]);
        e.preventDefault();
        return;
      }
      // Then a selected beat-matcher note, same fall-through order.
      if (hasSelectedBeatMatcherNote()) {
        setSelectedBeatMatcherNotePitchClass(PITCH_CLASS_KEY[e.code]);
        e.preventDefault();
        return;
      }
    } else if (e.code.startsWith('Digit') && (hasSelectedNote() || hasSelectedBeatMatcherNote())) {
      // 0-9 set the selected note's octave (as in "C4"), leaving its pitch
      // class alone — see setSelectedNotePitchOctave/
      // setSelectedBeatMatcherNotePitchOctave. Gated on a selection existing
      // up front, same shape as the KeyR/duplicate branch above, so digits
      // stay free for tap-entity bindings otherwise.
      if (hasSelectedNote()) {
        setSelectedNotePitchOctave(Number(e.code.slice('Digit'.length)));
      } else {
        setSelectedBeatMatcherNotePitchOctave(Number(e.code.slice('Digit'.length)));
      }
      e.preventDefault();
    } else if (e.key === '#' && (hasSelectedNote() || hasSelectedBeatMatcherNote())) {
      // Checked by e.key, not e.code — '#' is a shifted character (e.g.
      // Shift+3 on a US layout), same reasoning as the '|' barline shortcut
      // below. Raises the selected note by a semitone.
      if (hasSelectedNote()) {
        sharpenSelectedNote();
      } else {
        sharpenSelectedBeatMatcherNote();
      }
      e.preventDefault();
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
      fireTap(graph, entityId, state);
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

  // Dropped onto an open beat-matcher popup (ui/beatMatcher.ts) — reference
  // it as that beat-matcher's capture source and fall through to the normal
  // placement logic below (hoverTargetId is null throughout this branch, so
  // it still isn't reparented) rather than returning early the way the dock
  // case above does: unlike docking, this entity isn't going anywhere
  // special, it's just additionally being referenced. It does NOT land at
  // the raw drop point, though — that's necessarily inside the popup's own
  // interior, which would leave it rendered underneath the popup (popups
  // always draw on top — see beatMatcherClearDropPosition's own comment)
  // and unreachable afterward, so its landing position is overridden to
  // just outside the popup instead.
  if (state.hoverBeatMatcherId) {
    setBeatMatcherSource(state.hoverBeatMatcherId, entityId);
    const clearPosition = beatMatcherClearDropPosition(graph, state.hoverBeatMatcherId, entity.height / 2);
    if (clearPosition) state.dragPointer = clearPosition;
  }

  // Same idiom, for an open grain-editor popup (ui/grainSampler.ts) instead
  // — see hoverBeatMatcherId's own comment just above.
  if (state.hoverGrainId) {
    setGrainSource(graph, state.hoverGrainId, entityId);
    const clearPosition = grainSamplerClearDropPosition(graph, state.hoverGrainId, entity.height / 2);
    if (clearPosition) state.dragPointer = clearPosition;
  }

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

  // Dragged out of the dock: reset to factory params and rebuild its audio
  // from scratch (first time, or every time — see resetEntityToDefaults/
  // rebuildEntity's own comments in audio/graph.ts) rather than just
  // reconnecting whatever was there, now that it has a resolved parent
  // (possibly just set above) to connect into. This is the "drag off the
  // canvas and back on" recovery path for an entity a bad tuning value left
  // crashed/stuck — at the real cost that any deliberate tuning is ALSO
  // discarded by docking, not just a genuine crash.
  if (wasDocked) {
    resetEntityToDefaults(entity, graph);
    rebuildEntity(entity, graph);
  }

  // Independent of whether reparenting happened — dropping one instrument
  // onto another (no containment involved, per the previous change) should
  // still bring the one you just placed to the front of the overlap.
  graph.bringToFront(entityId);

  // Auto-play a sample source the moment it's dropped onto a beat-matcher,
  // so acquisition (ui/beatMatcher.ts's own sound-triggered arm/capture)
  // starts right away rather than needing a separate, easy-to-miss press of
  // the sample's own pad afterward — the one exception to this feature's
  // own "hands-off, just reacts to whatever you do" header comment. Only
  // 'sample' (a one-shot clip, not a continuous drone the user might still
  // be about to tweak first) and only if it isn't already mid-playback (a
  // press on an already-playing sample means "stop," not "retrigger" — see
  // the pointerdown pad-press handling above). Placed after activateEntity
  // above so a just-undocked sample's audio nodes actually exist to trigger.
  if (state.hoverBeatMatcherId && entity.kind === 'sample' && !isEntityPlaying(entityId)) {
    triggerEntity(entityId);
    state.triggerFlashes.set(entityId, performance.now());
  }

  // Same reasoning, for a 'sample' dropped onto an open grain-editor popup
  // (ui/grainSampler.ts) instead — its capture is sound-triggered too.
  if (state.hoverGrainId && entity.kind === 'sample' && !isEntityPlaying(entityId)) {
    triggerEntity(entityId);
    state.triggerFlashes.set(entityId, performance.now());
  }

  state.settleAnim = { id: entityId, startedAt: performance.now(), durationMs: 220 };
}
