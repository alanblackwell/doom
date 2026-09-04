// Geometry, hit-testing, and drawing for internal "feature" organelles
// (EntityType 'feature', see audio/entityGraph.ts) — an ADSR envelope is
// the first one. Parallel to controlSpecs.ts/pads.ts/knobs.ts: this module
// owns everything about how a feature is positioned and drawn, relative to
// its owning source's current bounds, in two states:
//
//   - collapsed (Entity.expanded === false): a small "porthole" inset in
//     the owner's own box — click it to open the popup. Any wire already
//     connected to one of the feature's params still works; it just
//     visually converges on the porthole rather than a specific dot (see
//     featureDotAbsolutePosition below).
//   - expanded: a popup panel floating over the canvas, anchored near the
//     porthole, in the SAME canvas-content coordinate space as everything
//     else (unlike ui/dock.ts's viewport-fixed HUD) — it has to be, so
//     wires drawn from anywhere else on the canvas can reach its connection
//     dots. Not itself draggable in this version — see popupRect.
//
// Deliberately NOT built on ui/controls.ts's generic per-kind dot column
// (controlsFor/dotPositionFor/hitTestControl) even though it reuses that
// module's ControlSpec/ControlHit shapes for wire compatibility — a popup's
// layout (title bar, curve, edge-column dots) doesn't fit that column
// model, and retrofitting it risked entangling with assumptions (empty-
// filter hiding, knob-center override) that don't apply here. The one
// integration point is ui/controls.ts's controlDotAbsolutePosition, which
// delegates to featureDotAbsolutePosition for a 'feature' target — from
// there, the whole existing wire-drawing/opacity/right-click-disconnect
// system works unchanged.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { effectiveBounds } from './layout';
import type { DragContext, Point, Rect } from './layout';
import { controlsFor, CONTROL_HIT_RADIUS } from './controlSpecs';
import type { ControlSpec } from './controlSpecs';
import type { ControlHit } from './controls';
import { ACCENT } from './palette';
import { getEnvelopePlayback } from '../audio/graph';
import type { EnvelopePlayback } from '../audio/graph';

export const PORTHOLE_RADIUS = 7;
const PORTHOLE_INSET = 12; // from the owner's bottom-right corner

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// The owner a feature belongs to, or undefined if it's gone or currently
// docked (silent and off-canvas — nothing for the organelle to anchor to,
// see audio/entityGraph.ts's Entity.docked). Every exported function below
// that takes a bare feature `entity` resolves this first and bails to
// null/false if it comes back empty. Exported so other feature-kind modules
// (e.g. ui/melody.ts) can resolve an owner the same way without duplicating
// the docked/missing-owner guard.
export function ownerOf(graph: EntityGraph, entity: Entity): Entity | undefined {
  const owner = entity.ownerId ? graph.get(entity.ownerId) : undefined;
  return owner && !owner.docked ? owner : undefined;
}

export function portholePosition(graph: EntityGraph, owner: Entity, drag?: DragContext): Point {
  const bounds = effectiveBounds(graph, owner, drag);
  return { x: bounds.x + bounds.width / 2 - PORTHOLE_INSET, y: bounds.y + bounds.height / 2 - PORTHOLE_INSET };
}

export const POPUP_WIDTH = 240;
export const POPUP_HEIGHT = 170;
const POPUP_OFFSET_X = 16; // porthole to popup's near (bottom-left) corner
const POPUP_OFFSET_Y = 16;
export const TITLE_HEIGHT = 22;
export const CLOSE_BUTTON_RADIUS = 7;
const DOT_COLUMN_INSET = 18; // from the popup's left edge
const DOT_SPACING = 22;
const DOT_BOTTOM_INSET = 22; // from the popup's bottom edge, where index 0 sits

// Anchored to the porthole's current position, growing up and to the right
// from it — not draggable/repositionable in this version, and not clamped
// to the viewport, so a porthole very near the canvas's own edge can run a
// popup off it. A reasonable v1 gap, not a design ceiling. Takes an explicit
// size so other feature kinds with a differently-shaped popup (e.g.
// ui/melody.ts's grand-staff editor, much bigger than the envelope's curve)
// can reuse the same anchoring math — popupRect below is just this called
// with the envelope's own fixed size.
export function popupRectFor(graph: EntityGraph, owner: Entity, width: number, height: number, drag?: DragContext): Rect {
  const porthole = portholePosition(graph, owner, drag);
  const left = porthole.x + POPUP_OFFSET_X;
  const bottom = porthole.y - POPUP_OFFSET_Y;
  const top = bottom - height;
  return { x: left + width / 2, y: top + height / 2, width, height };
}

export function popupRect(graph: EntityGraph, owner: Entity, drag?: DragContext): Rect {
  return popupRectFor(graph, owner, POPUP_WIDTH, POPUP_HEIGHT, drag);
}

export function closeButtonPosition(popup: Rect): Point {
  return { x: popup.x + popup.width / 2 - 14, y: popup.y - popup.height / 2 + 12 };
}

// Index 0 (attack) nearest the popup's bottom edge, rising — same
// bottom-up-column convention as controlSpecs.ts's dotPosition uses for a
// box's own edge.
function featureDotPosition(popup: Rect, index: number): Point {
  return {
    x: popup.x - popup.width / 2 + DOT_COLUMN_INSET,
    y: popup.y + popup.height / 2 - DOT_BOTTOM_INSET - index * DOT_SPACING,
  };
}

interface CurveArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function curveArea(popup: Rect): CurveArea {
  const left = popup.x - popup.width / 2;
  const top = popup.y - popup.height / 2;
  return {
    left: left + DOT_COLUMN_INSET + 20,
    right: left + popup.width - 16,
    top: top + TITLE_HEIGHT + 12,
    bottom: top + popup.height - 18,
  };
}

// Time-axis mapping for the curve display: how many seconds the curve
// area's fixed pixel width currently represents — a per-feature UI setting
// (Entity.params.timeScale, NOT one of controlsFor('envelope')'s specs, so
// it never gets a connection dot or participates in wiring — see
// ui/interaction.ts's axisHandle drag, which writes it directly rather than
// through applyControlValue). Doom/drone releases routinely run many
// seconds long (see controlSpecs.ts's envelope ranges), well past what a
// fixed pixels-per-second constant could show at once — dragging the
// popup's right-edge handle rescales this instead of the popup itself
// resizing, which is what makes the background grid (drawGrid) compress as
// you drag: more seconds now fit in the same physical width.
export const DEFAULT_TIME_SCALE = 2; // seconds
export const MIN_TIME_SCALE = 0.5;
// Comfortably above the worst case (every one of attack/decay/release at
// its own spec.max simultaneously, plus sustainDisplaySeconds — see
// requiredTimeScaleFor) so "the whole envelope stays visible" (below) is
// always actually achievable, never itself the thing clipping it.
export const MAX_TIME_SCALE = 40;
const TIME_SCALE_SENSITIVITY = 0.06; // seconds of zoom per px of horizontal drag

export function timeScaleOf(entity: Entity): number {
  return Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, entity.params.timeScale ?? DEFAULT_TIME_SCALE));
}

export function timeScaleFromDrag(startTimeScale: number, deltaX: number): number {
  return Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, startTimeScale + deltaX * TIME_SCALE_SENSITIVITY));
}

function pxPerSecond(curve: CurveArea, timeScale: number): number {
  return (curve.right - curve.left) / timeScale;
}

function segmentPx(seconds: number, pxPerSec: number): number {
  return Math.max(2, seconds * pxPerSec);
}

// Clamped to the param's own spec range only — NOT to the curve's current
// drawable width. Dragging a handle past the currently visible edge is
// exactly what should be able to happen; ui/interaction.ts grows timeScale
// afterward (see requiredTimeScaleFor) to bring it back into view, rather
// than this function silently capping the value at whatever the old zoom
// level happened to show.
function pxToSeconds(px: number, spec: ControlSpec, pxPerSec: number): number {
  const clampedPx = Math.max(0, px);
  return Math.min(spec.max, Math.max(spec.min, clampedPx / pxPerSec));
}

const ENVELOPE_SPECS = controlsFor('envelope');
function specFor(param: string): ControlSpec {
  return ENVELOPE_SPECS.find((s) => s.param === param)!;
}

// Illustrative only — sustain has no real duration — but expressed as a
// fraction of the envelope's OWN attack+decay+release (not of the current
// visible time range, which would make it circular: this feeds into
// requiredTimeScaleFor, which decides how much range needs to be visible).
// Wide enough to comfortably fit the break mark (drawBreakMark) at its
// midpoint without crowding the decay/release slopes on either side.
function sustainDisplaySeconds(attack: number, decay: number, release: number): number {
  return Math.max(0.08, (attack + decay + release) * 0.24);
}

// Total time the curve actually needs to draw start-to-finish — the basis
// for requiredTimeScaleFor's auto-zoom below.
export function envelopeTotalSeconds(entity: Entity): number {
  const attack = entity.params.attack ?? specFor('attack').min;
  const decay = entity.params.decay ?? specFor('decay').min;
  const release = entity.params.release ?? specFor('release').min;
  return attack + decay + sustainDisplaySeconds(attack, decay, release) + release;
}

const TIME_SCALE_MARGIN = 1.08; // a little breathing room past the release-end handle, not flush against the popup's edge

// What timeScale would need to be for the whole envelope to fit, or null if
// the current one already comfortably does — ui/interaction.ts calls this
// after a handle drag and grows (never shrinks) timeScale to match.
export function requiredTimeScaleFor(entity: Entity): number | null {
  const required = Math.min(MAX_TIME_SCALE, envelopeTotalSeconds(entity) * TIME_SCALE_MARGIN);
  return required > timeScaleOf(entity) ? required : null;
}

export interface EnvelopePoints {
  start: Point;
  attackPeak: Point;
  decayCorner: Point;
  sustainEnd: Point;
  releaseEnd: Point;
}

function envelopePoints(entity: Entity, curve: CurveArea): EnvelopePoints {
  const attack = entity.params.attack ?? specFor('attack').min;
  const decay = entity.params.decay ?? specFor('decay').min;
  const sustain = Math.min(1, Math.max(0, entity.params.sustain ?? 0));
  const release = entity.params.release ?? specFor('release').min;
  const height = curve.bottom - curve.top;
  const pxPerSec = pxPerSecond(curve, timeScaleOf(entity));
  const sustainSec = sustainDisplaySeconds(attack, decay, release);

  const start = { x: curve.left, y: curve.bottom };
  const attackPeak = { x: curve.left + segmentPx(attack, pxPerSec), y: curve.top };
  const decayCorner = { x: attackPeak.x + segmentPx(decay, pxPerSec), y: curve.bottom - sustain * height };
  const sustainEnd = { x: decayCorner.x + segmentPx(sustainSec, pxPerSec), y: decayCorner.y };
  const releaseEnd = { x: sustainEnd.x + segmentPx(release, pxPerSec), y: curve.bottom };
  return { start, attackPeak, decayCorner, sustainEnd, releaseEnd };
}

function lerp(a: Point, b: Point, t: number): Point {
  const clamped = Math.min(1, Math.max(0, t));
  return { x: a.x + (b.x - a.x) * clamped, y: a.y + (b.y - a.y) * clamped };
}

// The middle of the (illustrative) sustain segment — shared by the
// playback cursor's pause point (positionDuringHold below) and the break
// mark drawn there (drawBreakMark) — both mark the same "sustain has no
// real duration" spot, so they'd better agree on exactly where it is.
function sustainMidpoint(pts: EnvelopePoints): Point {
  return { x: (pts.decayCorner.x + pts.sustainEnd.x) / 2, y: pts.decayCorner.y };
}

// Time (from gate-on, in seconds — audio/graph.ts's EnvelopePlayback) it
// takes the cursor to settle from the decay corner into its sustain pause —
// not a real envelope stage, just enough motion to read as "arriving and
// holding" rather than an abrupt jump/teleport to the pause point.
const SUSTAIN_SETTLE_SECONDS = 0.15;

// Where the cursor sits `elapsedSec` after gate-on, ASSUMING the gate is
// still held that whole time (i.e. ignoring release entirely) — used both
// for live playback while held, and (in envelopeCursorPosition below) to
// find exactly where release started from, including mid-Attack/Decay.
function positionDuringHold(pts: EnvelopePoints, attack: number, decay: number, elapsedSec: number): Point {
  const decayEnd = attack + decay;
  const settleEnd = decayEnd + SUSTAIN_SETTLE_SECONDS;
  const midpoint = sustainMidpoint(pts);

  if (elapsedSec < attack) return lerp(pts.start, pts.attackPeak, attack > 0 ? elapsedSec / attack : 1);
  if (elapsedSec < decayEnd) return lerp(pts.attackPeak, pts.decayCorner, decay > 0 ? (elapsedSec - attack) / decay : 1);
  if (elapsedSec < settleEnd) return lerp(pts.decayCorner, midpoint, (elapsedSec - decayEnd) / SUSTAIN_SETTLE_SECONDS);
  return midpoint;
}

// The playback cursor's current position, or null while idle (no note
// played yet) or once a Release has fully finished (nothing left to show).
// Held: Attack → Decay → settle into a pause at the middle of the sustain
// segment, and stay there for as long as the gate stays on. Released: pick
// up from wherever the cursor actually was the instant gate-off happened
// (the sustain pause point in the common case, but mid-Attack/Decay for an
// early release) and move on to the release-end, over the release time.
// Of the release phase's total on-screen time (always exactly
// playback.release, matching the audio ramp's own duration, so the dot
// reaches releaseEnd exactly as the sound actually goes silent), at most
// this much is spent finishing the hop from the sustain pause out to
// sustainEnd before the real release ramp starts — see the comment below
// on why that hop exists at all.
const MAX_SUSTAIN_EXIT_SECONDS = 0.12;

export function envelopeCursorPosition(pts: EnvelopePoints, playback: EnvelopePlayback, now: number): Point | null {
  const elapsedSec = (now - playback.gateOnAt) / 1000;
  if (playback.gateOffAt === null) {
    return positionDuringHold(pts, playback.attack, playback.decay, elapsedSec);
  }
  const releaseElapsed = (now - playback.gateOffAt) / 1000;
  if (playback.release <= 0 || releaseElapsed >= playback.release) return null;

  const releaseStartElapsed = (playback.gateOffAt - playback.gateOnAt) / 1000;
  const decayEnd = playback.attack + playback.decay;

  // Released mid-Attack/Decay, before ever reaching the sustain pause —
  // no flat segment to finish first, so animate straight into the release
  // ramp from wherever it actually was (a reasonable approximation; unlike
  // the sustain-pause case below there's no single "correct" drawn path
  // connecting an arbitrary Attack/Decay point to releaseEnd anyway).
  if (releaseStartElapsed < decayEnd) {
    const releaseFrom = positionDuringHold(pts, playback.attack, playback.decay, releaseStartElapsed);
    return lerp(releaseFrom, pts.releaseEnd, releaseElapsed / playback.release);
  }

  // Released from the sustain pause (the common case): first finish the
  // short hop along the FLAT sustain line out to sustainEnd, then follow
  // the actual release ramp from there to releaseEnd — matching the
  // curve's own drawn path exactly. A straight line from the pause point
  // straight to releaseEnd (the previous approach) cuts diagonally through
  // where the flat sustain segment actually is, visibly dipping below it.
  const exitDuration = Math.min(MAX_SUSTAIN_EXIT_SECONDS, playback.release * 0.3);
  if (releaseElapsed < exitDuration) {
    return lerp(sustainMidpoint(pts), pts.sustainEnd, exitDuration > 0 ? releaseElapsed / exitDuration : 1);
  }
  const rampDuration = playback.release - exitDuration;
  const rampElapsed = releaseElapsed - exitDuration;
  return lerp(pts.sustainEnd, pts.releaseEnd, rampDuration > 0 ? rampElapsed / rampDuration : 1);
}

export type HandleKind = 'attack' | 'decaySustain' | 'release';
const HANDLE_HIT_RADIUS = 9;

// What a pointerdown inside an open popup landed on — ui/interaction.ts
// switches on `kind` to decide what to do; 'background' is the catch-all
// that still absorbs the click (so it never falls through to whatever's
// underneath on the canvas) without starting anything.
export type PopupHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'handle'; handle: HandleKind }
  | { entityId: string; kind: 'dot'; spec: ControlSpec }
  | { entityId: string; kind: 'axisHandle' }
  | { entityId: string; kind: 'background' };

// A vertical grip strip along the popup's right edge — drag it to rescale
// the time axis (see timeScaleFromDrag). Below the title bar so it doesn't
// compete with the close button's own hit zone in the top-right corner.
const AXIS_HANDLE_ZONE_WIDTH = 12;

function withinAxisHandleZone(popup: Rect, point: Point): boolean {
  const right = popup.x + popup.width / 2;
  const top = popup.y - popup.height / 2;
  const bottom = popup.y + popup.height / 2;
  return point.x >= right - AXIS_HANDLE_ZONE_WIDTH && point.x <= right && point.y >= top + TITLE_HEIGHT && point.y <= bottom;
}

export function hitTestPopup(graph: EntityGraph, point: Point, drag?: DragContext): PopupHit | null {
  for (const entity of graph.all()) {
    // Envelope-specific hit-testing only (curve geometry, ADSR handles) —
    // other feature kinds own their own popup shape and hit-testing
    // entirely (e.g. ui/melody.ts's hitTestMelodyPopup for kind 'melody'),
    // called separately by ui/interaction.ts before this. Without this
    // guard a different kind's (differently-sized) popup would still get
    // matched here against the envelope's own POPUP_WIDTH/HEIGHT-derived
    // rect, stealing clicks that land in the real popup but outside that
    // unrelated phantom rect.
    if (entity.type !== 'feature' || entity.kind !== 'envelope' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;

    const popup = popupRect(graph, owner, drag);
    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }

    const curve = curveArea(popup);
    const pts = envelopePoints(entity, curve);
    if (dist(point, pts.attackPeak) <= HANDLE_HIT_RADIUS) return { entityId: entity.id, kind: 'handle', handle: 'attack' };
    if (dist(point, pts.decayCorner) <= HANDLE_HIT_RADIUS) return { entityId: entity.id, kind: 'handle', handle: 'decaySustain' };
    if (dist(point, pts.releaseEnd) <= HANDLE_HIT_RADIUS) return { entityId: entity.id, kind: 'handle', handle: 'release' };

    const specs = controlsFor(entity.kind);
    for (let i = 0; i < specs.length; i++) {
      const dot = featureDotPosition(popup, i);
      if (dist(point, dot) <= CONTROL_HIT_RADIUS) return { entityId: entity.id, kind: 'dot', spec: specs[i] };
    }

    if (withinAxisHandleZone(popup, point)) {
      return { entityId: entity.id, kind: 'axisHandle' };
    }

    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return { entityId: entity.id, kind: 'background' };
    }
  }
  return null;
}

// Only meaningful while collapsed — an expanded popup has its own close
// button (hitTestPopup above) instead.
export function hitTestPorthole(graph: EntityGraph, point: Point, drag?: DragContext): Entity | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    if (dist(point, portholePosition(graph, owner, drag)) <= PORTHOLE_RADIUS + 4) return entity;
  }
  return null;
}

// One or two (param, value) updates for a live handle drag — 'decaySustain'
// carries both decay (horizontal) and sustain (vertical) since one point
// controls both, same as a classic ADSR editor's decay/sustain corner.
export function envelopeValuesFromHandle(
  entity: Entity,
  owner: Entity,
  graph: EntityGraph,
  handle: HandleKind,
  point: Point,
  drag?: DragContext
): Array<{ param: string; value: number }> {
  const popup = popupRect(graph, owner, drag);
  const curve = curveArea(popup);
  const pxPerSec = pxPerSecond(curve, timeScaleOf(entity));
  const attack = entity.params.attack ?? specFor('attack').min;
  const decay = entity.params.decay ?? specFor('decay').min;
  const release = entity.params.release ?? specFor('release').min;

  if (handle === 'attack') {
    return [{ param: 'attack', value: pxToSeconds(point.x - curve.left, specFor('attack'), pxPerSec) }];
  }
  if (handle === 'release') {
    const sustainSec = sustainDisplaySeconds(attack, decay, release); // pre-drag release as the anchor's reference, same approximation the decaySustain case below makes against attack/decay
    const sustainEndX = curve.left + segmentPx(attack, pxPerSec) + segmentPx(decay, pxPerSec) + segmentPx(sustainSec, pxPerSec);
    return [{ param: 'release', value: pxToSeconds(point.x - sustainEndX, specFor('release'), pxPerSec) }];
  }
  const attackPeakX = curve.left + segmentPx(attack, pxPerSec);
  const decayValue = pxToSeconds(point.x - attackPeakX, specFor('decay'), pxPerSec);
  const sustainValue = Math.min(1, Math.max(0, (curve.bottom - point.y) / (curve.bottom - curve.top)));
  return [
    { param: 'decay', value: decayValue },
    { param: 'sustain', value: sustainValue },
  ];
}

// The single integration point into ui/controls.ts's generic wire-endpoint
// resolution (controlDotAbsolutePosition) — collapsed, every param
// converges on the porthole regardless of which one a wire actually
// targets; expanded, each gets its own dot along the popup's left edge.
// Returns null if the owner is gone/docked, same as the generic path does
// for a deleted entity.
export function featureDotAbsolutePosition(
  graph: EntityGraph,
  entity: Entity,
  param: string,
  drag?: DragContext
): Point | null {
  const owner = ownerOf(graph, entity);
  if (!owner) return null;
  if (!entity.expanded) return portholePosition(graph, owner, drag);
  const specs = controlsFor(entity.kind);
  const index = specs.findIndex((s) => s.param === param);
  if (index === -1) return null;
  return featureDotPosition(popupRect(graph, owner, drag), index);
}

// Used for wiring a NEW connection in (dragging a wire's endpoint onto one
// of the popup's dots) — only hit-testable while expanded, matching
// hitTestPopup's 'dot' case; an existing wire keeps working while
// collapsed regardless (see featureDotAbsolutePosition above), this is only
// about where a fresh drag can land.
export function hitTestFeatureDot(graph: EntityGraph, point: Point, drag?: DragContext): ControlHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const popup = popupRect(graph, owner, drag);
    const specs = controlsFor(entity.kind);
    for (let i = 0; i < specs.length; i++) {
      const dot = featureDotPosition(popup, i);
      if (dist(point, dot) <= CONTROL_HIT_RADIUS) return { entityId: entity.id, spec: specs[i], dot };
    }
  }
  return null;
}

// --- Drawing ---

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const PORTHOLE_RING = 'rgba(255, 255, 255, 0.35)';
const CURVE_COLOR = 'rgba(232, 220, 192, 0.9)'; // matches a knob's indicator (ui/palette.ts adjacent tone)

export function drawPorthole(ctx: CanvasRenderingContext2D, graph: EntityGraph, entity: Entity, owner: Entity, drag?: DragContext): void {
  const p = portholePosition(graph, owner, drag);
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, PORTHOLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();
  ctx.strokeStyle = PORTHOLE_RING;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawHandle(ctx: CanvasRenderingContext2D, p: Point, label: string, active: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, active ? 6 : 4.5, 0, Math.PI * 2);
  ctx.fillStyle = active ? ACCENT : CURVE_COLOR;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, p.x, p.y - 8);
  ctx.restore();
}

const CURSOR_COLOR = 'rgba(255, 210, 150, 0.95)'; // matches the pad-trigger flash ring's warm glow elsewhere in the app

// The playback cursor (see envelopeCursorPosition) — a small glowing dot
// tracking live gate-on/gate-off timing, so a player can see where the
// actual sound is in its envelope right now, not just the static shape.
function drawEnvelopeCursor(ctx: CanvasRenderingContext2D, p: Point): void {
  ctx.save();
  ctx.shadowColor = CURSOR_COLOR;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = CURSOR_COLOR;
  ctx.fill();
  ctx.restore();
}

// Half-width of the gap cut into the sustain segment for the break mark
// below, at full size — shrinks (see drawPopup's gapHalf) for a sustain
// segment too short to fit it without eating into the decay/release
// slopes on either side.
const MAX_BREAK_GAP_HALF = 6;

// The conventional chart "this line isn't a continuous function" mark —
// two short parallel S-curves — drawn in the gap cut into the sustain
// segment (see drawPopup) at its midpoint, the same spot the playback
// cursor pauses at. `scale` shrinks it in step with a narrow gap rather
// than letting it overflow past the shortened segment.
function drawBreakMark(ctx: CanvasRenderingContext2D, center: Point, scale: number): void {
  if (scale <= 0) return;
  const halfHeight = 6 * scale;
  const bulge = 3 * scale;
  ctx.save();
  ctx.strokeStyle = CURVE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const dx of [-3 * scale, 3 * scale]) {
    ctx.beginPath();
    ctx.moveTo(center.x + dx, center.y - halfHeight);
    ctx.bezierCurveTo(
      center.x + dx - bulge,
      center.y - halfHeight / 3,
      center.x + dx + bulge,
      center.y + halfHeight / 3,
      center.x + dx,
      center.y + halfHeight
    );
    ctx.stroke();
  }
  ctx.restore();
}

// Faint vertical lines every whole second — makes the time-axis rescaling
// from dragging the axis handle (see drawAxisHandle) visible: the grid
// compresses as timeScale grows, exactly mirroring how far a given
// attack/decay/release time now sits from the popup's left edge.
// Whole-second lines are only readable up to a point — timeScale can auto-
// extend well past what a 1s grid can usefully show (MAX_TIME_SCALE's own
// comment explains why it needs that much headroom), so the step widens at
// wider zooms rather than the grid turning into an unreadable comb. Picks
// the smallest of these that still keeps lines at least MIN_PX_PER_LINE
// apart at the current zoom.
const MIN_PX_PER_LINE = 24;
const GRID_STEPS_SECONDS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20];

function gridStepSeconds(pxPerSec: number): number {
  const needed = MIN_PX_PER_LINE / pxPerSec;
  return GRID_STEPS_SECONDS.find((step) => step >= needed) ?? GRID_STEPS_SECONDS[GRID_STEPS_SECONDS.length - 1];
}

function drawTimeGrid(ctx: CanvasRenderingContext2D, curve: CurveArea, timeScale: number): void {
  const pxPerSec = pxPerSecond(curve, timeScale);
  const step = gridStepSeconds(pxPerSec);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let s = step; s <= timeScale; s += step) {
    const x = curve.left + s * pxPerSec;
    if (x > curve.right) break;
    ctx.beginPath();
    ctx.moveTo(x, curve.top);
    ctx.lineTo(x, curve.bottom);
    ctx.stroke();
    ctx.fillText(step < 1 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`, x, curve.bottom + 2);
  }
  ctx.restore();
}

// The zoom grip along the popup's right edge (see AXIS_HANDLE_ZONE_WIDTH) —
// three short dashes, brightening while actively dragged, same active-state
// treatment as drawHandle's envelope handles.
function drawAxisHandle(ctx: CanvasRenderingContext2D, popup: Rect, active: boolean): void {
  const x = popup.x + popup.width / 2 - AXIS_HANDLE_ZONE_WIDTH / 2 - 1;
  ctx.save();
  ctx.strokeStyle = active ? ACCENT : 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const dy of [-8, 0, 8]) {
    ctx.beginPath();
    ctx.moveTo(x, popup.y + dy - 3);
    ctx.lineTo(x, popup.y + dy + 3);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  formatValue: (value: number) => string,
  draggingHandle: HandleKind | null,
  draggingAxis: boolean,
  now: number,
  drag?: DragContext
): void {
  const popup = popupRect(graph, owner, drag);
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

  // Title bar
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.kind, left + 10, top + TITLE_HEIGHT / 2);

  const close = closeButtonPosition(popup);
  ctx.beginPath();
  ctx.arc(close.x, close.y, CLOSE_BUTTON_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.beginPath();
  ctx.moveTo(close.x - 3, close.y - 3);
  ctx.lineTo(close.x + 3, close.y + 3);
  ctx.moveTo(close.x + 3, close.y - 3);
  ctx.lineTo(close.x - 3, close.y + 3);
  ctx.stroke();

  // Connection dots — always visible (not hover-revealed like the generic
  // control-dot column; there's no slider hiding behind them to reveal).
  const specs = controlsFor(entity.kind);
  for (let i = 0; i < specs.length; i++) {
    const dot = featureDotPosition(popup, i);
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = specs[i].color;
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(specs[i].label, dot.x + 8, dot.y);
  }

  // Curve + grid + handles are clipped to the popup's own interior (below
  // the title bar) — a param set beyond what the current zoom shows (a wire
  // driving it past spec.max, say) draws off the right edge of the curve
  // area but stays visually contained rather than spilling past the panel's
  // own border. Dots/title/close above are drawn outside this clip since
  // they're never a function of the time axis.
  const curve = curveArea(popup);
  const timeScale = timeScaleOf(entity);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top + TITLE_HEIGHT, popup.width, popup.height - TITLE_HEIGHT);
  ctx.clip();

  drawTimeGrid(ctx, curve, timeScale);

  const pts = envelopePoints(entity, curve);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(curve.left, curve.bottom);
  ctx.lineTo(curve.right, curve.bottom);
  ctx.stroke();

  // The sustain segment is drawn with a gap at its midpoint, marked with the
  // conventional "this isn't a continuous function" break symbol (two short
  // parallel S-curves — see drawBreakMark) — sustain has no real duration,
  // unlike every other segment here, and the break makes that legible
  // rather than implying it's just another timed ramp. The gap shrinks
  // (never overlapping the decay/release slopes on either side) for a very
  // short sustain segment rather than assuming it's always wide enough for
  // the default gap.
  const mid = sustainMidpoint(pts);
  const sustainSegmentPx = Math.max(0, pts.sustainEnd.x - pts.decayCorner.x);
  const gapHalf = Math.min(MAX_BREAK_GAP_HALF, sustainSegmentPx * 0.35);

  ctx.strokeStyle = CURVE_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pts.start.x, pts.start.y);
  ctx.lineTo(pts.attackPeak.x, pts.attackPeak.y);
  ctx.lineTo(pts.decayCorner.x, pts.decayCorner.y);
  ctx.lineTo(mid.x - gapHalf, mid.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(mid.x + gapHalf, mid.y);
  ctx.lineTo(pts.sustainEnd.x, pts.sustainEnd.y);
  ctx.lineTo(pts.releaseEnd.x, pts.releaseEnd.y);
  ctx.stroke();

  drawBreakMark(ctx, mid, gapHalf / MAX_BREAK_GAP_HALF);

  drawHandle(ctx, pts.attackPeak, `atk ${formatValue(entity.params.attack ?? 0)}`, draggingHandle === 'attack');
  drawHandle(
    ctx,
    pts.decayCorner,
    `dec ${formatValue(entity.params.decay ?? 0)} sus ${formatValue(entity.params.sustain ?? 0)}`,
    draggingHandle === 'decaySustain'
  );
  drawHandle(ctx, pts.releaseEnd, `rel ${formatValue(entity.params.release ?? 0)}`, draggingHandle === 'release');

  const playback = getEnvelopePlayback(entity.id);
  const cursor = playback ? envelopeCursorPosition(pts, playback, now) : null;
  if (cursor) drawEnvelopeCursor(ctx, cursor);

  ctx.restore(); // clip

  drawAxisHandle(ctx, popup, draggingAxis);

  ctx.restore();
}
