// The 'grind' source voice's own tuning organelle (EntityType 'feature',
// kind 'grindTuning' — ui/organelle.ts's porthole/popup mechanism, reused
// unchanged for the collapsed/expanded toggle and popup anchoring, same as
// ui/sampler.ts). A by-ear tuning panel for every constant
// audio/grindPlayer.ts's granular engine uses (GRIND_TUNING), PLUS the
// voice's existing control ports (level/frequency/grind — CORE_KEYS below)
// so the whole instrument can be tuned from one place. There's no physical
// ground truth for e.g. "how long should a grain be," only what actually
// sounds right, and none of these were previously reachable without editing
// source and reloading. Meant as a reusable pattern (see this module's own
// shape) for other synth voices' own tuning organelles later.
//
// Each row is a live slider (dragging one calls applyGrindParam below,
// which writes straight through to the owning entity's own params AND its
// registered control setter — audio/graph.ts's 'grind' case registers one
// for every GRIND_TUNING key unconditionally, so every constant is tunable
// by ear immediately, whether or not it also has a permanent control-dot)
// plus a checkbox marking whether that parameter should ALSO get a
// permanent control-dot on the entity's own box — CORE_KEYS start checked,
// since they already are real control-dots. A row's own slider and its
// real control-dot (if any) are simply the SAME entity.params value read
// from two places, so dragging either one moves the other automatically —
// no separate sync code needed.
//
// Each row also has a pair of draggable carets marking its own min/max —
// the track itself always spans [0, some headroom past the current max],
// not [min, max], so there's always room to drag either caret outward. The
// Copy button turns the current slider values, caret ranges, and checkbox
// selections into ready-to-paste source text — see
// buildGrindTuningCopyText's own comment for exactly what it produces and
// where each part goes: ui/controlSpecs.ts is deliberately audio/*-
// independent (its own header), so there's no way to make an "exposed"
// checkbox take effect on the live control-dot column without a source
// edit in that file too.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, closeButtonPosition, drawTooltip, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { GRIND_TUNING, GRIND_TUNING_KEYS } from '../audio/grindPlayer';
import { getControlSetter } from '../audio/graph';
import { controlsFor } from './controlSpecs';
import { ACCENT } from './palette';

export const GRIND_TUNER_POPUP_WIDTH = 300;
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

// The voice's existing control-dot params — already real ControlSpec
// entries in ui/controlSpecs.ts's 'grind' array, so their rows start with
// the "expose as control port" checkbox already checked (see
// exposedStateFor) and their min/max/label/color come from that array
// rather than GRIND_TUNING (see factoryFor). Listed first — CORE_KEYS
// before GRIND_TUNING_KEYS in ALL_ROW_KEYS — per this organelle's own spec:
// control ports at the top of the list.
const CORE_KEYS = ['level', 'frequency', 'grind'];
const CORE_STEP: Record<string, number> = { level: 0.01, frequency: 1, grind: 0.01 };
// CORE_KEYS aren't part of GRIND_TUNING (they're the voice's own pre-
// existing control-dot params, sourced from ui/controlSpecs.ts instead —
// see factoryFor), so their hover-tooltip text lives here alongside them,
// same "how this relates to the algorithm" spirit as GRIND_TUNING's own
// `description` field.
const CORE_DESCRIPTIONS: Record<string, string> = {
  level: 'Overall output volume of the voice, after all grains are mixed.',
  frequency: "Center frequency each grain's own bandpass filter targets — the pitch the grinding texture centers around.",
  grind: 'Blends grain density and pitch chaos together, from sparse individual scrapes (0) to a dense chaotic roar (1) — see grainIntervalMin/Max and filterJitter below.',
};

export const ALL_ROW_KEYS = [...CORE_KEYS, ...GRIND_TUNING_KEYS];

function isCoreKey(key: string): boolean {
  return CORE_KEYS.includes(key);
}

interface RowFactory {
  label: string;
  min: number;
  max: number;
  step: number;
  color: string;
  defaultValue: number;
  description: string;
}

// Factory (as-shipped) label/range/step/color/default/description for any
// row key, whether it's a CORE_KEYS control-dot (sourced from
// ui/controlSpecs.ts's own 'grind' array — the actual live ControlSpec,
// not a duplicate) or a GRIND_TUNING extra. Used only to SEED a fresh
// feature entity's own per-instance state (exposedStateFor/rangeStateFor)
// — never read live thereafter, so editing one grind entity's ranges here
// never affects another's, or the factory defaults themselves.
function factoryFor(key: string): RowFactory {
  if (isCoreKey(key)) {
    const spec = controlsFor('grind').find((s) => s.param === key);
    return {
      label: spec?.label ?? key,
      min: spec?.min ?? 0,
      max: spec?.max ?? 1,
      step: CORE_STEP[key] ?? 0.01,
      color: spec?.color ?? '#e0c840',
      defaultValue: spec?.min ?? 0,
      description: CORE_DESCRIPTIONS[key] ?? '',
    };
  }
  const tuning = GRIND_TUNING[key];
  return {
    label: tuning.label,
    min: tuning.min,
    max: tuning.max,
    step: tuning.step,
    color: '#7ec850',
    defaultValue: tuning.value,
    description: tuning.description,
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function popupHeight(): number {
  return TITLE_HEIGHT + ALL_ROW_KEYS.length * ROW_HEIGHT + COPY_BUTTON_HEIGHT + PADDING * 2;
}

function grindTunerPopupRect(graph: EntityGraph, owner: Entity, drag?: DragContext): Rect {
  return popupRectFor(graph, owner, GRIND_TUNER_POPUP_WIDTH, popupHeight(), drag);
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

// The track's own full scale always runs from 0 (never the row's own min —
// per this feature's own spec, "full scale length going down to zero") up
// to 1.5x the CURRENT max, recomputed fresh every time — so dragging the
// max caret outward always has room ahead of it instead of ever hitting a
// hard ceiling.
function ceilingFor(range: { min: number; max: number }): number {
  return range.max > 0 ? range.max * 1.5 : 1;
}

function xFromValue(trackLeft: number, trackRight: number, ceiling: number, value: number): number {
  const t = ceiling > 0 ? Math.min(1, Math.max(0, value / ceiling)) : 0;
  return trackLeft + t * (trackRight - trackLeft);
}

function valueFromX(trackLeft: number, trackRight: number, ceiling: number, x: number): number {
  const t = trackRight > trackLeft ? Math.min(1, Math.max(0, (x - trackLeft) / (trackRight - trackLeft))) : 0;
  return t * ceiling;
}

function formatTunedValue(value: number, step: number): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(Math.max(step, 1e-6))));
  return value.toFixed(decimals);
}

// --- Per-feature UI-only state ---------------------------------------------

// Which row keys are currently checked "expose as control port" — purely a
// copy-button input, never audio-affecting (see this file's own header): a
// checkbox here has no live meaning until its resulting source edit is made
// and the app reloaded. CORE_KEYS seed checked (they already are real
// control-dots); GRIND_TUNING extras seed from GRIND_TUNING[key].exposed.
// Lazily seeded per feature entity, then kept independent of the factory
// tables so toggling one grind entity's checkboxes doesn't affect
// another's.
const exposedByFeature = new Map<string, Record<string, boolean>>();

function exposedStateFor(featureEntityId: string): Record<string, boolean> {
  let state = exposedByFeature.get(featureEntityId);
  if (!state) {
    state = {};
    for (const key of CORE_KEYS) state[key] = true;
    for (const key of GRIND_TUNING_KEYS) state[key] = GRIND_TUNING[key].exposed;
    exposedByFeature.set(featureEntityId, state);
  }
  return state;
}

// Each row's currently EDITED min/max (draggable via its own carets) —
// seeded from factoryFor(key) per feature entity, independent thereafter
// (same reasoning as exposedStateFor above). This is what actually bounds
// the value slider and what the Copy button writes out, NOT GRIND_TUNING's
// or controlsFor('grind')'s own static min/max, which stay untouched until
// the copied text is pasted back in by hand.
const rangeByFeature = new Map<string, Record<string, { min: number; max: number }>>();

function rangeStateFor(featureEntityId: string): Record<string, { min: number; max: number }> {
  let state = rangeByFeature.get(featureEntityId);
  if (!state) {
    state = {};
    for (const key of ALL_ROW_KEYS) {
      const f = factoryFor(key);
      state[key] = { min: f.min, max: f.max };
    }
    rangeByFeature.set(featureEntityId, state);
  }
  return state;
}

// performance.now() timestamp of the last successful copy, per feature
// entity — drives the Copy button's brief "copied to clipboard" flash (see
// drawGrindTunerPopup).
const copiedAtByFeature = new Map<string, number>();

// --- Live tuning ------------------------------------------------------------

// Writes a dragged slider's value straight through to the owning entity's
// own params AND its registered control setter — same two-step
// ui/interaction.ts's own applyControlValue does for a real control-dot
// drag, just without that function's wire-fanout half: an UNexposed tuning
// param has no control-dot for a wire to have been dragged from in the
// first place, so there's nothing to fan out regardless. For a CORE_KEYS
// param this IS the same entity.params/control-setter pair the real
// control-dot drag already uses, which is exactly what keeps the two in
// sync — see this file's own header.
function applyGrindParam(graph: EntityGraph, ownerId: string, key: string, value: number): void {
  const owner = graph.get(ownerId);
  if (!owner) return;
  owner.params[key] = value;
  getControlSetter(ownerId, key)?.(value);
}

function currentValue(owner: Entity, key: string): number {
  return owner.params[key] ?? factoryFor(key).defaultValue;
}

export function setGrindTunerValue(graph: EntityGraph, featureEntityId: string, key: string, value: number): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  const range = rangeStateFor(featureEntityId)[key];
  if (!range) return;
  applyGrindParam(graph, owner.id, key, Math.max(range.min, Math.min(range.max, value)));
}

// Dragging a caret past the other one is clamped to MIN_MAX_GAP apart
// rather than allowed to cross — same "can't cross the other" shape as the
// beat-matcher's own selection start/end carets. Narrowing the range past
// the current value pulls the value in to match, same as those carets pull
// the playhead back too.
export function setGrindTunerMin(graph: EntityGraph, featureEntityId: string, key: string, value: number): void {
  const range = rangeStateFor(featureEntityId);
  const entry = range[key];
  if (!entry) return;
  entry.min = Math.max(0, Math.min(entry.max - MIN_MAX_GAP, value));
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  if (currentValue(owner, key) < entry.min) applyGrindParam(graph, owner.id, key, entry.min);
}

export function setGrindTunerMax(graph: EntityGraph, featureEntityId: string, key: string, value: number): void {
  const range = rangeStateFor(featureEntityId);
  const entry = range[key];
  if (!entry) return;
  entry.max = Math.max(entry.min + MIN_MAX_GAP, value);
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  if (currentValue(owner, key) > entry.max) applyGrindParam(graph, owner.id, key, entry.max);
}

export function toggleGrindTunerExposed(featureEntityId: string, key: string): void {
  const state = exposedStateFor(featureEntityId);
  state[key] = !state[key];
}

// Recomputes the RAW value under the pointer's CURRENT x alone (clamped to
// the track's own [0, ceiling] scale, y ignored, NOT clamped to the row's
// own min/max) — used by ui/interaction.ts's pointermove to continue an
// in-progress drag of any of a row's three handles (value/min/max), where
// the pointer may well have wandered outside the row's own tight vertical
// hit-band that hitTestGrindTunerPopup requires for the initial press.
// Which setter (setGrindTunerValue/Min/Max) the caller applies this to is
// up to it — this function doesn't know which handle is being dragged.
// Null if the owning entity/popup is gone (e.g. closed mid-drag).
export function grindTunerRawValueAtPoint(
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
  const popup = grindTunerPopupRect(graph, owner, drag);
  const { left: trackLeft, right: trackRight } = sliderTrackX(popup);
  return valueFromX(trackLeft, trackRight, ceilingFor(range), point.x);
}

// --- Copy-to-source ----------------------------------------------------------

function formatSourceNumber(value: number, step: number): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(Math.max(step, 1e-6))));
  return String(Number(value.toFixed(decimals)));
}

// Three ready-to-paste snippets in one clipboard payload, since promoting a
// tuning constant to a real control-dot genuinely does touch three files —
// there's no way around that split (see this file's own header on why
// ui/controlSpecs.ts can't just read GRIND_TUNING's `exposed` flags itself):
//   1. audio/grindPlayer.ts — the whole GRIND_TUNING table (the 8 extras
//      only — CORE_KEYS aren't part of it), values and min/max updated to
//      whatever's currently live/dragged on this entity, exposed flags
//      updated to whatever's currently checked here.
//   2. ui/controlSpecs.ts — the 'grind' array, level/frequency/grind first
//      (their own tuned min/max/value, not the factory ones, in case those
//      carets were dragged too) plus one ControlSpec entry per checked
//      GRIND_TUNING extra.
//   3. ui/main.ts — grind-1's own params object, so a freshly-exposed
//      control-dot's initial slider position matches what was just tuned
//      rather than falling back to its spec's own min.
export function buildGrindTuningCopyText(graph: EntityGraph, featureEntityId: string): string | null {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!feature || !owner) return null;
  const exposed = exposedStateFor(featureEntityId);
  const ranges = rangeStateFor(featureEntityId);

  const tuningLines = GRIND_TUNING_KEYS.map((key) => {
    const factory = factoryFor(key);
    const range = ranges[key];
    const value = formatSourceNumber(currentValue(owner, key), factory.step);
    const description = factory.description.replace(/"/g, '\\"');
    return (
      `  ${key}: { value: ${value}, min: ${range.min}, max: ${range.max}, step: ${factory.step}, ` +
      `label: '${factory.label}', exposed: ${exposed[key]}, description: "${description}" },`
    );
  });

  const controlSpecLines = ALL_ROW_KEYS.filter((key) => exposed[key]).map((key) => {
    const factory = factoryFor(key);
    const range = ranges[key];
    return `  { param: '${key}', label: '${factory.label}', min: ${range.min}, max: ${range.max}, color: '${factory.color}' },`;
  });

  const paramsEntries = [
    ...CORE_KEYS.map((key) => `${key}: ${formatSourceNumber(currentValue(owner, key), factoryFor(key).step)}`),
    ...GRIND_TUNING_KEYS.filter((key) => exposed[key]).map(
      (key) => `${key}: ${formatSourceNumber(currentValue(owner, key), factoryFor(key).step)}`
    ),
  ];

  return [
    '// --- audio/grindPlayer.ts: replace the GRIND_TUNING object body with this ---',
    'export const GRIND_TUNING: Record<string, GrindTuningParam> = {',
    ...tuningLines,
    '};',
    '',
    "// --- ui/controlSpecs.ts: replace the 'grind' entry's array with this ---",
    'grind: [',
    ...controlSpecLines,
    '],',
    '',
    "// --- ui/main.ts: replace grind-1's params object with this ---",
    `params: { ${paramsEntries.join(', ')} },`,
  ].join('\n');
}

export function copyGrindTuning(graph: EntityGraph, featureEntityId: string): void {
  const text = buildGrindTuningCopyText(graph, featureEntityId);
  if (!text) return;
  navigator.clipboard?.writeText(text).catch((err) => {
    console.error('Failed to copy grind tuning to clipboard:', err);
  });
  copiedAtByFeature.set(featureEntityId, performance.now());
}

// --- Hit-testing -------------------------------------------------------------

export type GrindTunerHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'checkbox'; key: string }
  | { entityId: string; kind: 'slider'; key: string; value: number }
  | { entityId: string; kind: 'minCaret'; key: string; value: number }
  | { entityId: string; kind: 'maxCaret'; key: string; value: number }
  | { entityId: string; kind: 'copy' }
  | { entityId: string; kind: 'background' };

export function hitTestGrindTunerPopup(graph: EntityGraph, point: Point, drag?: DragContext): GrindTunerHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'grindTuning' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const popup = grindTunerPopupRect(graph, owner, drag);

    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }

    const { left: trackLeft, right: trackRight } = sliderTrackX(popup);
    const ranges = rangeStateFor(entity.id);

    for (let i = 0; i < ALL_ROW_KEYS.length; i++) {
      const key = ALL_ROW_KEYS[i];
      const y = rowY(popup, i);

      const cb = checkboxCenter(popup, i);
      if (dist(point, cb) <= CHECKBOX_SIZE) {
        return { entityId: entity.id, kind: 'checkbox', key };
      }

      if (Math.abs(point.y - y) <= ROW_HEIGHT / 2) {
        const range = ranges[key];
        const ceiling = ceilingFor(range);

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

// --- Drawing -----------------------------------------------------------------

const COPY_FLASH_MS = 1200;

export function drawGrindTunerPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  now: number,
  activeCaretDrag: { key: string; target: 'min' | 'max' } | null,
  pointer: Point | null,
  drag?: DragContext
): void {
  const popup = grindTunerPopupRect(graph, owner, drag);
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
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('grind tuning', left + 10, top + TITLE_HEIGHT / 2);

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
  // during the loop below, then drawn as a tooltip AFTER every row, so it
  // layers on top of the whole popup rather than getting drawn under a
  // later row.
  let hoveredKey: string | null = null;
  let hoveredRowY = 0;

  for (let i = 0; i < ALL_ROW_KEYS.length; i++) {
    const key = ALL_ROW_KEYS[i];
    const factory = factoryFor(key);
    const range = ranges[key];
    const ceiling = ceilingFor(range);
    const y = rowY(popup, i);
    const value = currentValue(owner, key);

    const cb = checkboxCenter(popup, i);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cb.x - CHECKBOX_SIZE / 2, cb.y - CHECKBOX_SIZE / 2, CHECKBOX_SIZE, CHECKBOX_SIZE);
    if (exposed[key]) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(cb.x - CHECKBOX_SIZE / 2 + 2, cb.y - CHECKBOX_SIZE / 2 + 2, CHECKBOX_SIZE - 4, CHECKBOX_SIZE - 4);
    }

    ctx.font = '9px monospace';
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
    // distinct from the value's own filled circle so the three never read
    // as the same kind of handle.
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
    // being dragged — the row's own fixed readout at the right edge always
    // shows the CURRENT VALUE, not the min/max being adjusted, so without
    // this a min/max drag would otherwise show no numeric feedback at all.
    if (activeCaretDrag && activeCaretDrag.key === key) {
      const caretX = activeCaretDrag.target === 'min' ? minX : maxX;
      const caretValue = activeCaretDrag.target === 'min' ? range.min : range.max;
      const label = formatTunedValue(caretValue, factory.step);
      ctx.font = '9px monospace';
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
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(flashing ? 'copied to clipboard' : 'copy tuning as source', copyRect.x, copyRect.y);
  ctx.textAlign = 'left';

  if (hoveredKey) {
    const description = factoryFor(hoveredKey).description;
    if (description) {
      // Directly over the popup itself, roughly centered on the hovered
      // row — covering the sliders is fine here, since reading the
      // explanation and dragging a slider are never something you need to
      // do at the same moment.
      const width = popup.width - PADDING * 2;
      drawTooltip(ctx, { x: left + PADDING, y: hoveredRowY - 8 }, description, width);
    }
  }

  ctx.restore();
}
