// A reusable by-ear tuning organelle (EntityType 'feature') factory — first
// built for ui/grindTuner.ts's granular-noise voice, generalized here once
// a second voice (ui/bassTuner.ts) needed the exact same shape, per this
// codebase's own "don't design for hypothetical future requirements until
// there's a real second caller" convention. Each call to
// createTuningOrganelle(config) below builds one independent organelle:
// a popup (ui/organelle.ts's porthole/popup mechanism, unchanged) listing
// every tunable a voice's algorithm uses as a live slider, with:
//
//   - a checkbox marking whether that parameter should ALSO get a
//     permanent control-dot on the entity's own box — the voice's existing
//     control-dot params (config.coreKeys) start checked, since they
//     already are real control-dots; everything else (config.tuning)
//     starts from its own factory `exposed` flag. A coreKey the doom lever
//     already drives (ui/doomLever.ts's DOOM_LEVER_PITCH_TARGETS, e.g.
//     grind's own 'frequency') draws a skull there instead — it isn't a
//     real checkbox, can't be toggled, and never gets exposed, since a
//     control-dot for that param would just fight the lever over the same
//     entity.params value (see isDoomLeverKey below).
//   - draggable min/max carets, on a track that always spans [0, some
//     headroom past the current max] rather than [min, max] — so there's
//     always room to drag either caret outward.
//   - a hover tooltip over each row's own label, explaining how that
//     parameter relates to the algorithm (config.tuning's own
//     `description`, or config.coreDescriptions for core params).
//   - a Copy button producing ready-to-paste source snippets, since
//     promoting a tuning constant to a real control-dot genuinely touches
//     multiple files (ui/controlSpecs.ts is deliberately audio/*-independent —
//     its own header — so there's no way for an "exposed" checkbox to take
//     effect on the live control-dot column without a source edit there). A
//     skull row instead gets a DOOM_LEVER_PITCH_TARGETS `centerValue`
//     snippet, so the lever's own straight-up position picks up whatever
//     this row was just tuned to.
//
// A row's own slider and its real control-dot (if any) are simply the SAME
// entity.params value read from two places (applyTuningParam below writes
// through both the entity's params AND its registered control setter,
// exactly like a real control-dot drag does) — dragging either one moves
// the other automatically, no separate sync code needed.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, closeButtonPosition, drawTooltip, registerFeaturePopupSize, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { getControlSetter } from '../audio/graph';
import { controlsFor } from './controlSpecs';
import { DOOM_LEVER_PITCH_TARGETS } from './doomLever';
import { ACCENT } from './palette';
import { MONO_FONT_FAMILY } from './monoFont';

// bass/grind/metal's own tuning organelles all list their pitch/frequency
// param as a coreKey (factoryFor below), on the assumption it's still a real
// ControlSpec in controlsFor(voiceKind) — true before the doom lever shipped,
// no longer true now that it's one of the 9 pitch-colored entries that dot
// removed in favor of DOOM_LEVER_PITCH_TARGETS (ui/doomLever.ts). Same
// pitch-blue this row always had, matching every other pitch control-dot
// this codebase ever drew before that removal.
const DOOM_LEVER_PITCH_COLOR = '#5aa0c8';

export interface TuningParam {
  value: number; // current factory default — what a fresh instance seeds from
  min: number;
  max: number;
  step: number; // UI drag/readout granularity only, not enforced on live control-wire input
  label: string;
  exposed: boolean; // whether the voice's ControlSpec entry currently also lists this as a control-dot (kept in sync by hand — see this module's own header)
  description: string; // shown as a hover tooltip over the label — how this constant relates to the voice's own algorithm, written to double as a source comment
}

export interface TuningOrganelleConfig {
  featureKind: string; // the feature entity's own kind (e.g. 'grindTuning')
  voiceKind: string; // the owning source entity's kind, for controlsFor(voiceKind) (e.g. 'grind')
  title: string; // popup title text
  coreKeys: string[]; // the voice's existing control-dot params, in display order (listed first)
  coreStep: Record<string, number>;
  coreDescriptions: Record<string, string>;
  tuning: Record<string, TuningParam>; // by-ear-only constants with no control-dot yet
  tuningColor: string; // ControlSpec color used for a newly-exposed tuning extra
  tuningInterfaceName: string; // e.g. 'GrindTuningParam' — for the paste text's type annotation
  tuningExportName: string; // e.g. 'GRIND_TUNING'
  tuningFilePath: string; // e.g. 'audio/grindPlayer.ts'
  controlSpecsFilePath: string; // e.g. 'ui/controlSpecs.ts'
  mainFilePath: string; // e.g. 'ui/main.ts'
  mainEntityId: string; // e.g. 'grind-1' — for the params-object paste comment
  // Sparse — only keys with a genuine logical ceiling the algorithm itself
  // enforces (e.g. grind's own [0,1] clamp in audio/grindPlayer.ts) belong
  // here. For a listed key, the max caret simply can't be dragged past this
  // value at all — see setMax's own comment. Every other key is open-ended:
  // its track rescales (grows) once dragged past its own current right
  // edge, rather than having any fixed limit.
  hardMax?: Record<string, number>;
}

const POPUP_WIDTH = 300;
const PADDING = 10;
const ROW_HEIGHT = 24;
const CHECKBOX_SIZE = 11;
const LABEL_WIDTH = 92;
const READOUT_WIDTH = 46;
const COPY_BUTTON_HEIGHT = 22;
const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const CARET_HIT_RADIUS = 7;
const CARET_SIZE = 5; // half-width of the drawn min/max triangle
const MIN_MAX_GAP = 1e-6; // smallest allowed (max - min), just enough to avoid a zero-width range
const COPY_FLASH_MS = 1200;

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function formatTunedValue(value: number, step: number): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(Math.max(step, 1e-6))));
  return value.toFixed(decimals);
}

function formatSourceNumber(value: number, step: number): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(Math.max(step, 1e-6))));
  return String(Number(value.toFixed(decimals)));
}

function xFromValue(trackLeft: number, trackRight: number, ceiling: number, value: number): number {
  const t = ceiling > 0 ? Math.min(1, Math.max(0, value / ceiling)) : 0;
  return trackLeft + t * (trackRight - trackLeft);
}

// Deliberately UNCLAMPED past t=1 (only floored at 0) — a pointer dragged
// past the track's own right edge needs to keep producing a value
// proportionally past `ceiling`, not pin at it, so setMax can tell "still
// within the current scale" apart from "pushing past it" and grow the
// ceiling only in the latter case (see that function's own comment).
// setValue/setMin still clamp their OWN result to the row's real min/max
// afterward regardless, so this having no upper bound never lets the
// value/min handles themselves escape the track.
function valueFromX(trackLeft: number, trackRight: number, ceiling: number, x: number): number {
  const t = trackRight > trackLeft ? Math.max(0, (x - trackLeft) / (trackRight - trackLeft)) : 0;
  return t * ceiling;
}

export type TuningOrganelleHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'checkbox'; key: string }
  | { entityId: string; kind: 'slider'; key: string; value: number }
  | { entityId: string; kind: 'minCaret'; key: string; value: number }
  | { entityId: string; kind: 'maxCaret'; key: string; value: number }
  | { entityId: string; kind: 'copy' }
  | { entityId: string; kind: 'background' };

export interface TuningOrganelle {
  ALL_ROW_KEYS: string[];
  hitTestPopup: (graph: EntityGraph, point: Point, drag?: DragContext) => TuningOrganelleHit | null;
  drawPopup: (
    ctx: CanvasRenderingContext2D,
    graph: EntityGraph,
    entity: Entity,
    owner: Entity,
    now: number,
    activeCaretDrag: { key: string; target: 'min' | 'max' } | null,
    pointer: Point | null,
    drag?: DragContext
  ) => void;
  setValue: (graph: EntityGraph, featureEntityId: string, key: string, value: number) => void;
  setMin: (graph: EntityGraph, featureEntityId: string, key: string, value: number) => void;
  setMax: (graph: EntityGraph, featureEntityId: string, key: string, value: number) => void;
  // Call once, right when a max-caret press/drag begins, before the first
  // setMax call — see that function's own comment for why.
  beginMaxDrag: (featureEntityId: string, key: string) => void;
  toggleExposed: (featureEntityId: string, key: string) => void;
  rawValueAtPoint: (
    graph: EntityGraph,
    featureEntityId: string,
    key: string,
    point: Point,
    drag?: DragContext
  ) => number | null;
  copyTuning: (graph: EntityGraph, featureEntityId: string) => void;
}

export function createTuningOrganelle(config: TuningOrganelleConfig): TuningOrganelle {
  const tuningKeys = Object.keys(config.tuning);
  const ALL_ROW_KEYS = [...config.coreKeys, ...tuningKeys];

  function isCoreKey(key: string): boolean {
    return config.coreKeys.includes(key);
  }

  // True for a coreKey the doom lever already drives (ui/doomLever.ts's
  // DOOM_LEVER_PITCH_TARGETS) — e.g. grind's own 'frequency'. Such a row has
  // no real control-dot to expose (the lever replaced it), so its checkbox
  // is drawn as a skull instead and is neither togglable nor ever emitted
  // as a ControlSpec line by the Copy button — see exposedStateFor,
  // toggleExposed, hitTestPopup's checkbox branch, and buildCopyText below.
  function isDoomLeverKey(key: string): boolean {
    return DOOM_LEVER_PITCH_TARGETS[config.voiceKind]?.param === key;
  }

  interface RowFactory {
    label: string;
    min: number;
    max: number;
    step: number;
    color: string;
    defaultValue: number;
    description: string;
    hardMax: number | undefined;
  }

  // Factory (as-shipped) label/range/step/color/default/description for any
  // row key, whether it's a core control-dot (sourced from the voice's own
  // live ControlSpec array via controlsFor, not a duplicate) or a tuning
  // extra. Used to SEED a fresh feature entity's own per-instance state
  // (exposedStateFor/rangeStateFor below) and, for hardMax specifically,
  // read live on every max-caret drag too (see setMax) — that part is
  // static config either way, not per-entity state, so reading it live
  // doesn't let editing one entity's ranges affect another's.
  function factoryFor(key: string): RowFactory {
    if (isCoreKey(key)) {
      const spec = controlsFor(config.voiceKind).find((s) => s.param === key);
      // No live ControlSpec for this core key — true for every voice's own
      // former pitch/frequency dot now that the doom lever owns it (see this
      // file's own header import comment). Fall back to the same range the
      // lever itself now drives that param across, rather than the
      // generic 0..1/yellow default below, which would render as a
      // nonsensical slider.
      const pitchFallback =
        DOOM_LEVER_PITCH_TARGETS[config.voiceKind]?.param === key ? DOOM_LEVER_PITCH_TARGETS[config.voiceKind] : undefined;
      return {
        label: spec?.label ?? key,
        min: spec?.min ?? pitchFallback?.minValue ?? 0,
        max: spec?.max ?? pitchFallback?.maxValue ?? 1,
        step: config.coreStep[key] ?? 0.01,
        color: spec?.color ?? (pitchFallback ? DOOM_LEVER_PITCH_COLOR : '#e0c840'),
        defaultValue: spec?.min ?? pitchFallback?.minValue ?? 0,
        description: config.coreDescriptions[key] ?? '',
        hardMax: config.hardMax?.[key],
      };
    }
    const tuning = config.tuning[key];
    return {
      label: tuning.label,
      min: tuning.min,
      max: tuning.max,
      step: tuning.step,
      color: config.tuningColor,
      defaultValue: tuning.value,
      description: tuning.description,
      hardMax: config.hardMax?.[key],
    };
  }

  function popupHeight(): number {
    return TITLE_HEIGHT + ALL_ROW_KEYS.length * ROW_HEIGHT + COPY_BUTTON_HEIGHT + PADDING * 2;
  }

  // So ui/organelle.ts's own popupRectFor can stack this popup against a
  // sibling feature's on the same owner (e.g. metal-1's envelope alongside
  // this tuning organelle) — see registerFeaturePopupSize's own comment.
  // popupHeight() is fixed once ALL_ROW_KEYS is known (config.coreKeys/
  // config.tuning don't change after this call), so registering it once
  // here, rather than every frame, is safe.
  registerFeaturePopupSize(config.featureKind, POPUP_WIDTH, popupHeight());

  // `feature` (this organelle's own feature entity) is optional and only
  // matters when its owner has more than one feature (e.g. metal-1's
  // envelope plus this tuning organelle) — see portholePosition's own
  // comment for why passing it keeps a second feature's porthole/popup
  // from landing exactly on top of the first one's.
  function popupRect(graph: EntityGraph, owner: Entity, drag?: DragContext, feature?: Entity): Rect {
    return popupRectFor(graph, owner, POPUP_WIDTH, popupHeight(), drag, feature);
  }

  function rowY(popup: Rect, index: number): number {
    const top = popup.y - popup.height / 2;
    return top + TITLE_HEIGHT + PADDING + index * ROW_HEIGHT + ROW_HEIGHT / 2;
  }

  function checkboxCenter(popup: Rect, index: number): Point {
    const left = popup.x - popup.width / 2;
    return { x: left + PADDING + CHECKBOX_SIZE / 2, y: rowY(popup, index) };
  }

  function sliderTrackX(popup: Rect): { left: number; right: number } {
    const left = popup.x - popup.width / 2;
    const right = popup.x + popup.width / 2;
    return {
      left: left + PADDING + CHECKBOX_SIZE + 6 + LABEL_WIDTH,
      right: right - PADDING - READOUT_WIDTH,
    };
  }

  function copyButtonRect(popup: Rect): Rect {
    const bottom = popup.y + popup.height / 2;
    return {
      x: popup.x,
      y: bottom - PADDING - COPY_BUTTON_HEIGHT / 2,
      width: popup.width - PADDING * 2,
      height: COPY_BUTTON_HEIGHT,
    };
  }

  // --- Per-feature UI-only state ---------------------------------------

  // Which row keys are currently checked "expose as control port" — purely
  // a copy-button input, never audio-affecting: a checkbox here has no live
  // meaning until its resulting source edit is made and the app reloaded.
  // coreKeys seed checked (they already are real control-dots); tuning
  // extras seed from their own factory `exposed` flag. Lazily seeded per
  // feature entity, then kept independent of the factory tables so
  // toggling one entity's checkboxes doesn't affect another's.
  const exposedByFeature = new Map<string, Record<string, boolean>>();

  function exposedStateFor(featureEntityId: string): Record<string, boolean> {
    let state = exposedByFeature.get(featureEntityId);
    if (!state) {
      state = {};
      for (const key of config.coreKeys) state[key] = !isDoomLeverKey(key);
      for (const key of tuningKeys) state[key] = config.tuning[key].exposed;
      exposedByFeature.set(featureEntityId, state);
    }
    return state;
  }

  // Each row's currently EDITED min/max (draggable via its own carets) —
  // seeded from factoryFor(key) per feature entity, independent thereafter
  // (same reasoning as exposedStateFor above). This is what actually
  // bounds the value slider and what the Copy button writes out, NOT the
  // factory tables' own static min/max, which stay untouched until the
  // copied text is pasted back in by hand.
  //
  // `ceiling` is the track's own full scale (always 0 at the left edge —
  // per this feature's own spec — up to `ceiling` at the right) — kept as
  // STORED, STABLE state rather than derived fresh from `max` on every
  // frame, specifically so dragging the max caret doesn't rescale the
  // whole row out from under the pointer on every small move: it only
  // grows once a drag actually pushes past the current right edge (see
  // setMax), and never for a row with a hardMax (config.hardMax), whose
  // ceiling IS that hard max, fixed for good.
  const rangeByFeature = new Map<string, Record<string, { min: number; max: number; ceiling: number }>>();

  function initialCeiling(f: { max: number; hardMax: number | undefined }): number {
    if (f.hardMax !== undefined) return f.hardMax;
    return f.max > 0 ? f.max * 1.5 : 1;
  }

  function rangeStateFor(featureEntityId: string): Record<string, { min: number; max: number; ceiling: number }> {
    let state = rangeByFeature.get(featureEntityId);
    if (!state) {
      state = {};
      for (const key of ALL_ROW_KEYS) {
        const f = factoryFor(key);
        state[key] = { min: f.min, max: f.max, ceiling: initialCeiling(f) };
      }
      rangeByFeature.set(featureEntityId, state);
    }
    return state;
  }

  // performance.now() timestamp of the last successful copy, per feature
  // entity — drives the Copy button's brief "copied to clipboard" flash.
  const copiedAtByFeature = new Map<string, number>();

  // The max value a row had right when the CURRENT max-caret drag began —
  // set once per press (beginMaxDrag, called from ui/interaction.ts's
  // pointerdown) and read by setMax to tell "still exploring past the
  // current edge" apart from "dragged back left of where this drag
  // started," which is what should shrink the scale back down again (see
  // setMax's own comment) rather than leaving it stuck at whatever it was
  // accidentally extended to.
  const maxDragAnchorByFeature = new Map<string, Record<string, number>>();

  // --- Live tuning -------------------------------------------------------

  // Writes a dragged slider's value straight through to the owning entity's
  // own params AND its registered control setter — same two-step
  // ui/interaction.ts's own applyControlValue does for a real control-dot
  // drag, just without that function's wire-fanout half: an UNexposed
  // tuning param has no control-dot for a wire to have been dragged from
  // in the first place, so there's nothing to fan out regardless. For a
  // core param this IS the same entity.params/control-setter pair the real
  // control-dot drag already uses, which is exactly what keeps the two in
  // sync.
  function applyTuningParam(graph: EntityGraph, ownerId: string, key: string, value: number): void {
    const owner = graph.get(ownerId);
    if (!owner) return;
    owner.params[key] = value;
    getControlSetter(ownerId, key)?.(value);
  }

  function currentValue(owner: Entity, key: string): number {
    return owner.params[key] ?? factoryFor(key).defaultValue;
  }

  function setValue(graph: EntityGraph, featureEntityId: string, key: string, value: number): void {
    const feature = graph.get(featureEntityId);
    const owner = feature ? ownerOf(graph, feature) : undefined;
    if (!owner) return;
    const range = rangeStateFor(featureEntityId)[key];
    if (!range) return;
    applyTuningParam(graph, owner.id, key, Math.max(range.min, Math.min(range.max, value)));
  }

  // Dragging a caret past the other one is clamped to MIN_MAX_GAP apart
  // rather than allowed to cross — same "can't cross the other" shape as
  // the beat-matcher's own selection start/end carets. Narrowing the range
  // past the current value pulls the value in to match, same as those
  // carets pull the playhead back too.
  function setMin(graph: EntityGraph, featureEntityId: string, key: string, value: number): void {
    const ranges = rangeStateFor(featureEntityId);
    const entry = ranges[key];
    if (!entry) return;
    entry.min = Math.max(0, Math.min(entry.max - MIN_MAX_GAP, value));
    const feature = graph.get(featureEntityId);
    const owner = feature ? ownerOf(graph, feature) : undefined;
    if (!owner) return;
    if (currentValue(owner, key) < entry.min) applyTuningParam(graph, owner.id, key, entry.min);
  }

  // Snapshots this row's current max as the anchor setMax measures a drag
  // against — call once, right when a max-caret press/drag begins (before
  // the first setMax call), so setMax can tell "still exploring past the
  // edge from where I started" apart from "dragged back left of that,"
  // which is what should shrink the scale (see setMax's own comment). A
  // no-op if the row doesn't exist yet, same guard every other setter here
  // has.
  function beginMaxDrag(featureEntityId: string, key: string): void {
    const entry = rangeStateFor(featureEntityId)[key];
    if (!entry) return;
    let anchors = maxDragAnchorByFeature.get(featureEntityId);
    if (!anchors) {
      anchors = {};
      maxDragAnchorByFeature.set(featureEntityId, anchors);
    }
    anchors[key] = entry.max;
  }

  // `rawValue` comes from rawValueAtPoint below, which is NOT clamped to
  // the track's own [0, ceiling] scale (see valueFromX's own comment) —
  // exactly so this can tell apart three cases, relative to this drag's
  // own start (beginMaxDrag's anchor, defaulting to the current max if a
  // drag was somehow never begun):
  //   - between the anchor and the current ceiling: just move the caret,
  //     scale untouched — this is the common case, and the whole reason
  //     the ceiling is stable state rather than derived fresh every frame
  //     (see rangeByFeature's own comment) — small drags within the
  //     existing range never wobble the rest of the row.
  //   - past the current ceiling (pushed right, past the track's own right
  //     edge): extend it just enough to keep tracking the pointer.
  //   - back past the anchor (pulled left of where THIS drag started):
  //     shrink it back down the same way, so an accidental huge extension
  //     (drag to a wildly large value) can be undone by dragging back —
  //     the caret's own number (drawn above it) visibly gets smaller as
  //     this happens. Never shrinks below the row's own original ceiling,
  //     so this can undo an extension but won't zoom in past where the row
  //     started out.
  // A row with a hardMax never grows OR shrinks at all — its ceiling IS
  // that hard max, fixed, and the caret simply can't be dragged past it,
  // per this feature's own spec ("if there's a logical maximum, it's OK to
  // not allow interactive drag past that point").
  function setMax(graph: EntityGraph, featureEntityId: string, key: string, rawValue: number): void {
    const ranges = rangeStateFor(featureEntityId);
    const entry = ranges[key];
    if (!entry) return;
    const factory = factoryFor(key);
    if (factory.hardMax === undefined) {
      const anchor = maxDragAnchorByFeature.get(featureEntityId)?.[key] ?? entry.max;
      if (rawValue > entry.ceiling) {
        entry.ceiling = rawValue * 1.05; // a little headroom past wherever the pointer just reached, not a big jump
      } else if (rawValue < anchor) {
        entry.ceiling = Math.max(rawValue * 1.05, initialCeiling(factory));
      }
    }
    const upperBound = factory.hardMax ?? entry.ceiling;
    entry.max = Math.max(entry.min + MIN_MAX_GAP, Math.min(upperBound, rawValue));
    const feature = graph.get(featureEntityId);
    const owner = feature ? ownerOf(graph, feature) : undefined;
    if (!owner) return;
    if (currentValue(owner, key) > entry.max) applyTuningParam(graph, owner.id, key, entry.max);
  }

  function toggleExposed(featureEntityId: string, key: string): void {
    if (isDoomLeverKey(key)) return; // hardcoded to the lever — not a real checkbox
    const state = exposedStateFor(featureEntityId);
    state[key] = !state[key];
  }

  // Recomputes the RAW value under the pointer's CURRENT x alone (clamped
  // to the track's own [0, ceiling] scale, y ignored, NOT clamped to the
  // row's own min/max) — used by ui/interaction.ts's pointermove to
  // continue an in-progress drag of any of a row's three handles
  // (value/min/max), where the pointer may well have wandered outside the
  // row's own tight vertical hit-band that hitTestPopup requires for the
  // initial press. Which setter the caller applies this to is up to it —
  // this function doesn't know which handle is being dragged. Null if the
  // owning entity/popup is gone (e.g. closed mid-drag).
  function rawValueAtPoint(
    graph: EntityGraph,
    featureEntityId: string,
    key: string,
    point: Point,
    drag?: DragContext
  ): number | null {
    const feature = graph.get(featureEntityId);
    const owner = feature ? ownerOf(graph, feature) : undefined;
    if (!owner) return null;
    const range = rangeStateFor(featureEntityId)[key];
    if (!range) return null;
    const popup = popupRect(graph, owner, drag, feature);
    const { left: trackLeft, right: trackRight } = sliderTrackX(popup);
    return valueFromX(trackLeft, trackRight, range.ceiling, point.x);
  }

  // --- Copy-to-source ------------------------------------------------------

  // Three ready-to-paste snippets in one clipboard payload, since promoting
  // a tuning constant to a real control-dot genuinely does touch three
  // files — there's no way around that split (see this module's own header
  // on why the ControlSpecs file can't just read the tuning table's
  // `exposed` flags itself):
  //   1. config.tuningFilePath — the whole tuning table (extras only —
  //      coreKeys aren't part of it), values and min/max updated to
  //      whatever's currently live/dragged on this entity, exposed flags
  //      updated to whatever's currently checked here.
  //   2. config.controlSpecsFilePath — the voice's ControlSpec array,
  //      coreKeys first (their own tuned min/max/value, not the factory
  //      ones, in case those carets were dragged too) plus one entry per
  //      checked tuning extra.
  //   3. config.mainFilePath — the entity's own params object, so a
  //      freshly-exposed control-dot's initial slider position matches
  //      what was just tuned rather than falling back to its spec's own
  //      min.
  function buildCopyText(graph: EntityGraph, featureEntityId: string): string | null {
    const feature = graph.get(featureEntityId);
    const owner = feature ? ownerOf(graph, feature) : undefined;
    if (!feature || !owner) return null;
    const exposed = exposedStateFor(featureEntityId);
    const ranges = rangeStateFor(featureEntityId);

    const tuningLines = tuningKeys.map((key) => {
      const factory = factoryFor(key);
      const range = ranges[key];
      const value = formatSourceNumber(currentValue(owner, key), factory.step);
      const description = factory.description.replace(/"/g, '\\"');
      return (
        `  ${key}: { value: ${value}, min: ${range.min}, max: ${range.max}, step: ${factory.step}, ` +
        `label: '${factory.label}', exposed: ${exposed[key]}, description: "${description}" },`
      );
    });

    const controlSpecLines = ALL_ROW_KEYS.filter((key) => exposed[key] && !isDoomLeverKey(key)).map((key) => {
      const factory = factoryFor(key);
      const range = ranges[key];
      return `  { param: '${key}', label: '${factory.label}', min: ${range.min}, max: ${range.max}, color: '${factory.color}' },`;
    });

    // A coreKey the doom lever drives gets no control-dot line above —
    // instead, whatever this row was just tuned to becomes the lever's own
    // centerValue (its straight-up/resting position), the same adjustment
    // ui/doomLever.ts's DOOM_LEVER_PITCH_TARGETS entry needs by hand for
    // that to actually take effect.
    const leverKey = config.coreKeys.find((key) => isDoomLeverKey(key));
    const leverLines: string[] = [];
    if (leverKey) {
      const target = DOOM_LEVER_PITCH_TARGETS[config.voiceKind]!;
      const factory = factoryFor(leverKey);
      const centerValue = formatSourceNumber(currentValue(owner, leverKey), factory.step);
      leverLines.push(
        '',
        `// --- ui/doomLever.ts: replace the '${config.voiceKind}' entry in DOOM_LEVER_PITCH_TARGETS with this ---`,
        `${config.voiceKind}: { param: '${target.param}', minValue: ${target.minValue}, maxValue: ${target.maxValue}, centerValue: ${centerValue} },`
      );
    }

    const paramsEntries = [
      ...config.coreKeys.map((key) => `${key}: ${formatSourceNumber(currentValue(owner, key), factoryFor(key).step)}`),
      ...tuningKeys
        .filter((key) => exposed[key])
        .map((key) => `${key}: ${formatSourceNumber(currentValue(owner, key), factoryFor(key).step)}`),
    ];

    return [
      `// --- ${config.tuningFilePath}: replace the ${config.tuningExportName} object body with this ---`,
      `export const ${config.tuningExportName}: Record<string, ${config.tuningInterfaceName}> = {`,
      ...tuningLines,
      '};',
      '',
      `// --- ${config.controlSpecsFilePath}: replace the '${config.voiceKind}' entry's array with this ---`,
      `${config.voiceKind}: [`,
      ...controlSpecLines,
      '],',
      ...leverLines,
      '',
      `// --- ${config.mainFilePath}: replace ${config.mainEntityId}'s params object with this ---`,
      `params: { ${paramsEntries.join(', ')} },`,
    ].join('\n');
  }

  function copyTuning(graph: EntityGraph, featureEntityId: string): void {
    const text = buildCopyText(graph, featureEntityId);
    if (!text) return;
    navigator.clipboard?.writeText(text).catch((err) => {
      console.error(`Failed to copy ${config.voiceKind} tuning to clipboard:`, err);
    });
    copiedAtByFeature.set(featureEntityId, performance.now());
  }

  // --- Hit-testing ---------------------------------------------------------

  function hitTestPopup(graph: EntityGraph, point: Point, drag?: DragContext): TuningOrganelleHit | null {
    for (const entity of graph.all()) {
      if (entity.type !== 'feature' || entity.kind !== config.featureKind || !entity.expanded) continue;
      const owner = ownerOf(graph, entity);
      if (!owner) continue;
      const popup = popupRect(graph, owner, drag, entity);

      if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
        return { entityId: entity.id, kind: 'close' };
      }

      const { left: trackLeft, right: trackRight } = sliderTrackX(popup);
      const ranges = rangeStateFor(entity.id);

      for (let i = 0; i < ALL_ROW_KEYS.length; i++) {
        const key = ALL_ROW_KEYS[i];
        const y = rowY(popup, i);

        if (!isDoomLeverKey(key)) {
          const cb = checkboxCenter(popup, i);
          if (dist(point, cb) <= CHECKBOX_SIZE) {
            return { entityId: entity.id, kind: 'checkbox', key };
          }
        }

        if (Math.abs(point.y - y) <= ROW_HEIGHT / 2) {
          const range = ranges[key];
          const ceiling = range.ceiling;

          const minX = xFromValue(trackLeft, trackRight, ceiling, range.min);
          if (Math.abs(point.x - minX) <= CARET_HIT_RADIUS) {
            return { entityId: entity.id, kind: 'minCaret', key, value: valueFromX(trackLeft, trackRight, ceiling, point.x) };
          }

          const maxX = xFromValue(trackLeft, trackRight, ceiling, range.max);
          if (Math.abs(point.x - maxX) <= CARET_HIT_RADIUS) {
            return { entityId: entity.id, kind: 'maxCaret', key, value: valueFromX(trackLeft, trackRight, ceiling, point.x) };
          }

          if (point.x >= trackLeft - 6 && point.x <= trackRight + 6) {
            return { entityId: entity.id, kind: 'slider', key, value: valueFromX(trackLeft, trackRight, ceiling, point.x) };
          }
        }
      }

      const copyRect = copyButtonRect(popup);
      if (
        point.x >= copyRect.x - copyRect.width / 2 &&
        point.x <= copyRect.x + copyRect.width / 2 &&
        point.y >= copyRect.y - copyRect.height / 2 &&
        point.y <= copyRect.y + copyRect.height / 2
      ) {
        return { entityId: entity.id, kind: 'copy' };
      }

      const left = popup.x - popup.width / 2;
      const top = popup.y - popup.height / 2;
      if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
        return { entityId: entity.id, kind: 'background' };
      }
    }
    return null;
  }

  // --- Drawing ---------------------------------------------------------------

  function drawPopup(
    ctx: CanvasRenderingContext2D,
    graph: EntityGraph,
    entity: Entity,
    owner: Entity,
    now: number,
    activeCaretDrag: { key: string; target: 'min' | 'max' } | null,
    pointer: Point | null,
    drag?: DragContext
  ): void {
    const popup = popupRect(graph, owner, drag, entity);
    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(left, top, popup.width, popup.height);
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, popup.width, popup.height);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `10px ${MONO_FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(config.title, left + 10, top + TITLE_HEIGHT / 2);

    const close = closeButtonPosition(popup);
    ctx.beginPath();
    ctx.arc(close.x, close.y, CLOSE_BUTTON_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(close.x - 3, close.y - 3);
    ctx.lineTo(close.x + 3, close.y + 3);
    ctx.moveTo(close.x + 3, close.y - 3);
    ctx.lineTo(close.x - 3, close.y + 3);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.stroke();

    const exposed = exposedStateFor(entity.id);
    const ranges = rangeStateFor(entity.id);
    const { left: trackLeft, right: trackRight } = sliderTrackX(popup);

    // Which row's label (if any) the pointer is currently over — tracked
    // during the loop below, then drawn as a tooltip AFTER every row, so
    // it layers on top of the whole popup rather than getting drawn under
    // a later row.
    let hoveredKey: string | null = null;
    let hoveredRowY = 0;

    for (let i = 0; i < ALL_ROW_KEYS.length; i++) {
      const key = ALL_ROW_KEYS[i];
      const factory = factoryFor(key);
      const range = ranges[key];
      const ceiling = range.ceiling;
      const y = rowY(popup, i);
      const value = currentValue(owner, key);

      const cb = checkboxCenter(popup, i);
      if (isDoomLeverKey(key)) {
        // No real checkbox here — the doom lever already owns this param
        // (ui/doomLever.ts's DOOM_LEVER_PITCH_TARGETS), so a skull marks it
        // hardcoded rather than offering a control-dot toggle that would
        // just fight the lever for the same entity.params value.
        ctx.font = `${CHECKBOX_SIZE + 3}px ${MONO_FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText('💀', cb.x, cb.y + 1);
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cb.x - CHECKBOX_SIZE / 2, cb.y - CHECKBOX_SIZE / 2, CHECKBOX_SIZE, CHECKBOX_SIZE);
        if (exposed[key]) {
          ctx.fillStyle = ACCENT;
          ctx.fillRect(cb.x - CHECKBOX_SIZE / 2 + 2, cb.y - CHECKBOX_SIZE / 2 + 2, CHECKBOX_SIZE - 4, CHECKBOX_SIZE - 4);
        }
      }

      ctx.font = `9px ${MONO_FONT_FAMILY}`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.textAlign = 'left';
      const labelX = cb.x + CHECKBOX_SIZE / 2 + 6;
      ctx.fillText(factory.label, labelX, y);

      if (
        pointer &&
        pointer.x >= labelX &&
        pointer.x <= labelX + LABEL_WIDTH &&
        Math.abs(pointer.y - y) <= ROW_HEIGHT / 2
      ) {
        hoveredKey = key;
        hoveredRowY = y;
      }

      // Full-scale track, 0 at trackLeft.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(trackLeft, y);
      ctx.lineTo(trackRight, y);
      ctx.stroke();

      // Filled portion from the min caret up to the current value, so the
      // row reads as "this much of the allowed range is in use."
      const minX = xFromValue(trackLeft, trackRight, ceiling, range.min);
      const maxX = xFromValue(trackLeft, trackRight, ceiling, range.max);
      const valueX = xFromValue(trackLeft, trackRight, ceiling, value);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(minX, y);
      ctx.lineTo(valueX, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(valueX, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();

      // Min/max carets — small triangles pointing down into the track,
      // distinct from the value's own filled circle so the three never
      // read as the same kind of handle.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath();
      ctx.moveTo(minX - CARET_SIZE, y - CARET_SIZE - 3);
      ctx.lineTo(minX + CARET_SIZE, y - CARET_SIZE - 3);
      ctx.lineTo(minX, y - 3);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(maxX - CARET_SIZE, y - CARET_SIZE - 3);
      ctx.lineTo(maxX + CARET_SIZE, y - CARET_SIZE - 3);
      ctx.lineTo(maxX, y - 3);
      ctx.closePath();
      ctx.fill();

      // A live value readout floating above whichever caret is currently
      // being dragged — the row's own fixed readout at the right edge
      // always shows the CURRENT VALUE, not the min/max being adjusted, so
      // without this a min/max drag would otherwise show no numeric
      // feedback at all.
      if (activeCaretDrag && activeCaretDrag.key === key) {
        const caretX = activeCaretDrag.target === 'min' ? minX : maxX;
        const caretValue = activeCaretDrag.target === 'min' ? range.min : range.max;
        const label = formatTunedValue(caretValue, factory.step);
        ctx.font = `9px ${MONO_FONT_FAMILY}`;
        const textWidth = ctx.measureText(label).width;
        const labelY = y - CARET_SIZE - 14;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(caretX - textWidth / 2 - 3, labelY - 6, textWidth + 6, 12);
        ctx.fillStyle = ACCENT;
        ctx.textAlign = 'center';
        ctx.fillText(label, caretX, labelY);
        ctx.textAlign = 'left';
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(formatTunedValue(value, factory.step), popup.x + popup.width / 2 - PADDING, y);
      ctx.textAlign = 'left';
    }

    const copyRect = copyButtonRect(popup);
    const copiedAt = copiedAtByFeature.get(entity.id);
    const flashing = copiedAt !== undefined && now - copiedAt < COPY_FLASH_MS;
    ctx.fillStyle = flashing ? 'rgba(126, 200, 80, 0.35)' : 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(copyRect.x - copyRect.width / 2, copyRect.y - copyRect.height / 2, copyRect.width, copyRect.height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(copyRect.x - copyRect.width / 2, copyRect.y - copyRect.height / 2, copyRect.width, copyRect.height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = `10px ${MONO_FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText(flashing ? 'copied to clipboard' : 'copy tuning as source', copyRect.x, copyRect.y);
    ctx.textAlign = 'left';

    if (hoveredKey) {
      const description = factoryFor(hoveredKey).description;
      if (description) {
        // Directly over the popup itself, roughly centered on the hovered
        // row — covering the sliders is fine here, since reading the
        // explanation and dragging a slider are never something you need
        // to do at the same moment.
        const width = popup.width - PADDING * 2;
        drawTooltip(ctx, { x: left + PADDING, y: hoveredRowY - 8 }, description, width);
      }
    }

    ctx.restore();
  }

  return {
    ALL_ROW_KEYS,
    hitTestPopup,
    drawPopup,
    setValue,
    setMin,
    setMax,
    beginMaxDrag,
    toggleExposed,
    rawValueAtPoint,
    copyTuning,
  };
}
