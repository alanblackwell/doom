// The "doom lever": a new decoration applied to every sound source and
// filter/pedal entity (anything with `type === 'source'` — a pedal like
// growl/vocode is architecturally still a Source that happens to also
// consume contained children, same as ui/controlSpecs.ts's own PROCESSOR_KINDS
// reasoning), industrial/steampunk in style: a hemispherical rivet head
// always sitting at the center of the entity's own bottom boundary, which
// expands on click into a pressure-gauge dial plus a long cylindrical lever
// the user can swing around that same rivet as a pivot.
//
// Visual/interaction only for now — no audio wiring. entity.params.doomLeverAngle
// is written and read like any other live param (the same Record<string,
// number> every other control value already lives in), so a later pass can
// wire it into the audio graph with zero storage changes; nothing here
// reaches into audio/graph.ts.
//
// Kept graph-agnostic like ui/eventPulse.ts/ui/spectrogram.ts: everything
// below takes plain points/angles/bounds. The two callers are
// ui/render.ts (drawing, in the same top-layer overlay pass as
// ui/controls.ts's drawControls) and ui/interaction.ts (hit-testing plus the
// InteractionState fields that track which entities are expanded and mid-
// rotate-drag — gesture state belongs there, alongside draggingControl/
// portholePress, not here).

import type { Point, Rect } from './layout';
import { shadeColor } from './palette';
import { MONO_FONT_FAMILY } from './monoFont';

// --- Geometry / sizing --------------------------------------------------

export const DOOM_LEVER_RIVET_RADIUS = 8;
export const DOOM_LEVER_GAUGE_RADIUS = 29; // ~30% smaller than the original 42
export const DOOM_LEVER_LENGTH = 120; // final lever length beyond the gauge's own rim
export const DOOM_LEVER_ROD_THICKNESS = 10.5;
// Generous hit tolerance around the rivet/lever centerline — same "generous
// target around a small visual element" reasoning as controlSpecs.ts's own
// CONTROL_HIT_RADIUS (10), just a couple px bigger since this thing is
// meant to read as a big mechanical grab handle, not a fiddly dot.
export const DOOM_LEVER_HIT_RADIUS = 12;

// Anchor point: dead center of the entity's own bottom edge, in the same
// center-based absolute-Rect coordinate space effectiveBounds()/dotPosition()
// already use elsewhere (ui/layout.ts's Rect: x/y is the CENTER, not the
// top-left corner).
export function doomLeverAnchor(bounds: Rect): Point {
  return { x: bounds.x, y: bounds.y + bounds.height / 2 };
}

// --- Gauge-degree angle convention --------------------------------------
//
// "Gauge degrees" g ranges -135 (min) to +135 (max), g=0 pointing straight
// up — the classic ~270-degree-sweep analog gauge (a 90-degree gap at the
// bottom with no markings, sweeping from lower-left up through the top down
// to lower-right). It's the LOW end of the range, g in [-135, -45], that's
// "danger" here — a deliberate inversion of the usual pressure-gauge
// convention (where high = danger): this is a "doom lever," so it's the low
// values that are the doomy/dangerous ones. That first third of the sweep
// lands in the lower-LEFT of the dial.
export const DOOM_LEVER_MIN_ANGLE = -135;
export const DOOM_LEVER_MAX_ANGLE = 135;
export const DOOM_LEVER_DANGER_MAX_ANGLE = -45;

export function clampGaugeAngle(deg: number): number {
  return Math.min(DOOM_LEVER_MAX_ANGLE, Math.max(DOOM_LEVER_MIN_ANGLE, deg));
}

export function isDangerAngle(deg: number): boolean {
  return deg <= DOOM_LEVER_DANGER_MAX_ANGLE;
}

// --- Pitch mapping ---------------------------------------------------------
//
// By default, the doom lever REPLACES every voice's own pitch/frequency
// control-dot (see ui/controlSpecs.ts — the 9 entries that used to carry
// color '#5aa0c8', the codebase's own "this is a pitch" convention, are
// gone now) rather than sitting alongside it. -135deg (the low end, also the
// danger zone — see isDangerAngle above) maps to a fixed, near-inaudible
// sub-bass floor; +135deg maps to that voice's own original top-of-range
// value (the same `max` its removed ControlSpec used to have). Log-
// interpolated, not linear — a linear map would spend nearly the entire
// swing inaudibly close to the low end, since these ranges span more than
// an octave or two.
//
// Deliberately plain data/functions with no EntityGraph/wiring knowledge
// (same "graph-agnostic" reasoning as this module's own header) — the
// graph-aware glue that actually calls doomLeverAngleToValue and pushes the
// result into entity.params/the audio engine lives in ui/interaction.ts's
// setDoomLeverAngle, alongside applyControlValue.
export interface DoomLeverPitchTarget {
  param: string; // the entity.params key this drives (matches an audio/graph.ts registerControls key)
  minValue: number; // value at -135deg (the doomy/danger end)
  maxValue: number; // value at +135deg — the voice's own former ControlSpec max
}

export const DOOM_LEVER_PITCH_TARGETS: Record<string, DoomLeverPitchTarget> = {
  bass: { param: 'frequency', minValue: 5, maxValue: 150 },
  bow: { param: 'frequency', minValue: 5, maxValue: 500 },
  grind: { param: 'frequency', minValue: 5, maxValue: 80 },
  kick: { param: 'pitch', minValue: 5, maxValue: 100 },
  pluck: { param: 'pitch', minValue: 5, maxValue: 200 },
  metal: { param: 'pitch', minValue: 5, maxValue: 400 },
  // A conventional oscillator voice (audio/graph.ts's 'synth' case) — the
  // widest pitch range of any TRIGGERED_KINDS voice here, since it's meant
  // to cover a full melodic range rather than one instrument's own register.
  synth: { param: 'pitch', minValue: 5, maxValue: 1000 },
  vocode: { param: 'targetPitch', minValue: 5, maxValue: 800 },
  ringmod: { param: 'frequency', minValue: 5, maxValue: 2000 },
  // Not a frequency at all — a playback-rate multiplier — but the same
  // "raising it audibly raises pitch too" physical coupling ui/controlSpecs.ts's
  // old 'sample' comment already noted, so it gets the same log-mapped
  // treatment, just with unitless bounds instead of Hz. 0.01x is deep enough
  // into "inaudibly slow" that a normal recording reads as a near-frozen
  // drone rather than a recognizably slowed-down copy of itself.
  sample: { param: 'speed', minValue: 0.01, maxValue: 4 },
  // Not a pitch either, but the same "the lever swings from a wrecked/
  // doomy extreme up to the original clean setting" shape applies — a
  // crushed sample rate is the bitcrusher's own equivalent of "sub-bass
  // and inaudible," just via aliasing/digital artifacting instead of a
  // literal low pitch. Reuses the removed ControlSpec's own former
  // min/max unchanged (200-20000) rather than picking a new extreme, since
  // nothing here calls for a more/less aggressive floor than it already had.
  bitcrush: { param: 'rate', minValue: 200, maxValue: 20000 },
};

// Log-interpolated angle -> value, clamped to the valid gauge-degree range
// first so a caller passing an already-clamped or not-yet-clamped angle
// behaves identically either way.
export function doomLeverAngleToValue(angleDeg: number, minValue: number, maxValue: number): number {
  const t = (clampGaugeAngle(angleDeg) - DOOM_LEVER_MIN_ANGLE) / (DOOM_LEVER_MAX_ANGLE - DOOM_LEVER_MIN_ANGLE);
  return minValue * Math.pow(maxValue / minValue, t);
}

// Gauge-degrees -> canvas radians (canvas: 0 = pointing along +x/right,
// increasing = clockwise since y is down) — g=0 (up) maps to -90deg/-pi/2,
// exactly what ctx.arc/rotate expect. Exported so render.ts's rod/needle
// drawing rotates the canvas context by the identical value this module
// uses for hit-testing and tick placement, so the visible lever and its own
// grab zone can never drift apart.
export function gaugeAngleToCanvasRadians(deg: number): number {
  return ((deg - 90) * Math.PI) / 180;
}

export function leverDirection(deg: number): Point {
  const rad = gaugeAngleToCanvasRadians(deg);
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

// Inverse of gaugeAngleToCanvasRadians, folded into the valid -180..180
// range first so a drag straight down (near the range's own wraparound
// seam) clamps to whichever end it's actually closer to rather than
// jumping to the opposite one.
export function gaugeAngleToward(pivot: Point, point: Point): number {
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  const rad = Math.atan2(dy, dx);
  let deg = (rad * 180) / Math.PI + 90;
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return clampGaugeAngle(deg);
}

// --- Growth animation ----------------------------------------------------
//
// "Initially slower, then speeding to a steady pace, then settling to its
// final length" — a trapezoidal velocity profile: quadratic ease-in,
// linear cruise, quadratic ease-out to rest. Deliberately slow (heavy/
// mechanical, "ominous") relative to the app's other transitions (e.g.
// ui/render.ts's own settleScale, a ~150-200ms snap-and-settle).
export const DOOM_LEVER_GROW_MS = 800;
// Collapse is a much less important curve to get right than the growth-in
// one — a plain, quicker ease-out reads fine.
export const DOOM_LEVER_SHRINK_MS = 300;
// The gauge's own appearance/disappearance is quicker still than the lever's
// growth — it "appears" (a reveal, not a slow reach) while the lever "grows"
// outward from its edge; faded in/out over this short a window rather than
// popping instantly, so it doesn't read as a hard cut against the lever's
// own slow-starting animation happening right next to it.
export const DOOM_LEVER_GAUGE_FADE_MS = 150;

const GROW_ACCEL_FRACTION = 0.3;
const GROW_DECEL_FRACTION = 0.3;

function growthFraction(elapsedMs: number, durationMs: number): number {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  const t = elapsedMs / durationMs;
  const a = GROW_ACCEL_FRACTION;
  const d = GROW_DECEL_FRACTION;
  const c = 1 - a - d;
  const v = 1 / (a / 2 + c + d / 2); // peak cruise velocity, chosen so the curve reaches exactly 1 at t=1
  if (t <= a) {
    return (v * t * t) / (2 * a);
  }
  if (t <= a + c) {
    return (v * a) / 2 + v * (t - a);
  }
  const t2 = 1 - t;
  return 1 - (v * t2 * t2) / (2 * d);
}

function shrinkFraction(elapsedMs: number, durationMs: number): number {
  if (elapsedMs <= 0) return 1;
  if (elapsedMs >= durationMs) return 0;
  const t = elapsedMs / durationMs;
  return (1 - t) * (1 - t); // quick ease-out toward 0
}

// 0..1 fraction of DOOM_LEVER_LENGTH currently visible, given whether this
// entity's lever is presently expanded and when that expand/collapse last
// toggled (undefined transitionAt means "always been in this state" — a
// freshly-loaded entity that's never been touched, so it just reads its
// resting value with no animation).
export function leverLengthFraction(isExpanded: boolean, transitionAt: number | undefined, now: number): number {
  if (transitionAt === undefined) return isExpanded ? 1 : 0;
  const elapsed = now - transitionAt;
  return isExpanded ? growthFraction(elapsed, DOOM_LEVER_GROW_MS) : shrinkFraction(elapsed, DOOM_LEVER_SHRINK_MS);
}

export function gaugeAlpha(isExpanded: boolean, transitionAt: number | undefined, now: number): number {
  if (transitionAt === undefined) return isExpanded ? 1 : 0;
  const elapsed = now - transitionAt;
  if (isExpanded) return Math.min(1, elapsed / DOOM_LEVER_GAUGE_FADE_MS);
  return Math.max(0, 1 - elapsed / DOOM_LEVER_SHRINK_MS);
}

// --- Danger-zone glow ------------------------------------------------------
//
// Same "record a transition moment, then derive a pure function of elapsed
// time" idiom as ui/eventPulse.ts's own pulse-glow tracking, just tracking
// "entered/left the danger zone" instead of "fired" — a continuous smooth
// cross-fade rather than a snap the instant the angle crosses the boundary.

const dangerInZone = new Map<string, boolean>();
const dangerTransitionAt = new Map<string, number>();
const DANGER_GLOW_FADE_MS = 250;

// Called once per entity per drawn frame (ui/render.ts) with its current
// live angle — updates the tracked zone-membership/transition-time state as
// a side effect and returns the current glow opacity (0..1) in one call,
// same "call it from the one place that actually observes the live value"
// shape as ui/eventPulse.ts's recordSourcePulse/sourcePulseGlow pair, just
// merged into one function since there's no separate discrete "fire" moment
// here — only a continuously-tracked boolean.
export function dangerGlowOpacity(entityId: string, angleDeg: number, now: number): number {
  const inZone = isDangerAngle(angleDeg);
  const wasInZone = dangerInZone.get(entityId) ?? false;
  if (inZone !== wasInZone) {
    dangerInZone.set(entityId, inZone);
    dangerTransitionAt.set(entityId, now);
  }
  const transitionAt = dangerTransitionAt.get(entityId);
  const elapsed = transitionAt === undefined ? DANGER_GLOW_FADE_MS : now - transitionAt;
  const t = Math.min(1, Math.max(0, elapsed / DANGER_GLOW_FADE_MS));
  return inZone ? t : 1 - t;
}

// --- Hit-testing -----------------------------------------------------------

export function isWithinRivet(pivot: Point, point: Point): boolean {
  return Math.hypot(point.x - pivot.x, point.y - pivot.y) <= DOOM_LEVER_HIT_RADIUS;
}

// A capsule test along the rod's own centerline from `innerRadius` to
// `outerRadius` (both measured from `pivot`, along `angleDeg`) — used for
// both the gauge needle segment and the external lever segment, since
// they're conceptually the same rigid rod (see this module's own header).
export function isWithinLeverRod(
  pivot: Point,
  angleDeg: number,
  innerRadius: number,
  outerRadius: number,
  point: Point
): boolean {
  const dir = leverDirection(angleDeg);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  const along = dx * dir.x + dy * dir.y; // distance along the rod's own axis
  const perp = Math.abs(dx * dir.y - dy * dir.x); // perpendicular distance off the rod's centerline
  if (perp > DOOM_LEVER_HIT_RADIUS) return false;
  return along >= innerRadius - DOOM_LEVER_HIT_RADIUS && along <= outerRadius + DOOM_LEVER_HIT_RADIUS;
}

// --- Drawing ---------------------------------------------------------------

// Dark iron — deliberately colder/darker than KNOB_BODY_COLOR ('#3a3a3a' in
// ui/render.ts), so the doom lever's own machinery reads as a distinct
// material bolted onto every source/filter, not just another knob.
const IRON_COLOR = '#2e2e30';
// Aged brass dial face — warm, contrasts against the cold iron bezel around
// it, matching this app's existing warm "distressed metal" accent choices
// (e.g. ui/render.ts's own ACCENT/amber palette) rather than a clinical
// white/grey gauge face.
const DIAL_FACE_COLOR = '#64522e'; // slightly darker than the original '#7a6438'
// Same base tone/brightness as DIAL_FACE_COLOR now (was a noticeably
// brighter brass) — the ring-shading in drawDoomLeverGauge still gives the
// bezel its own highlight/shadow banding around this shared base, it just
// no longer reads as a lighter material than the face itself.
const BEZEL_COLOR = DIAL_FACE_COLOR;
// Single by-eye brightness knobs — tweak these two numbers and every use of
// the bezel/danger red below follows. BEZEL_BRIGHTNESS multiplies directly
// into drawDoomLeverGauge's own per-ring shadeFactor (so 1 leaves that ring
// shading exactly as designed; >1 brightens the whole bezel, <1 dims it).
// DANGER_BRIGHTNESS scales the raw red RGB triple the same way, clamped to
// 255 per channel so it can't wrap or go negative.
const BEZEL_BRIGHTNESS = 1.2;
const DANGER_BRIGHTNESS = 0.8;
const DANGER_COLOR_BASE: [number, number, number] = [200, 30, 20];
const DANGER_COLOR = DANGER_COLOR_BASE.map((c) => Math.min(255, Math.max(0, Math.round(c * DANGER_BRIGHTNESS)))).join(
  ', '
);

// The rivet's own dark recessed socket, where the dome meets the surface —
// also doubles as the inner edge of the value-text band below (see
// drawDoomLeverValueText), so the two never overlap.
const RIVET_SOCKET_RADIUS = DOOM_LEVER_RIVET_RADIUS + 2.5;

export function drawDoomLeverRivet(ctx: CanvasRenderingContext2D, center: Point): void {
  ctx.save();

  // A dark recessed socket where the dome meets the surface, so it reads as
  // sitting IN the box's own material rather than floating on top of it.
  ctx.beginPath();
  ctx.arc(center.x, center.y, RIVET_SOCKET_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();

  const gradient = ctx.createRadialGradient(
    center.x - DOOM_LEVER_RIVET_RADIUS * 0.35,
    center.y - DOOM_LEVER_RIVET_RADIUS * 0.35,
    DOOM_LEVER_RIVET_RADIUS * 0.15,
    center.x,
    center.y,
    DOOM_LEVER_RIVET_RADIUS
  );
  gradient.addColorStop(0, shadeColor(IRON_COLOR, 2.4));
  gradient.addColorStop(0.55, shadeColor(IRON_COLOR, 1.1));
  gradient.addColorStop(1, shadeColor(IRON_COLOR, 0.35));

  ctx.beginPath();
  ctx.arc(center.x, center.y, DOOM_LEVER_RIVET_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.restore();
}

// Cylindrical iron rod from `innerRadius` to `innerRadius + length` (both
// measured from `center` along `angleDeg`), shaded perpendicular to its own
// axis for a 3D-cylinder read, with a small rounded end-cap at its tip.
// No-ops for a non-positive length (still collapsed, or fully shrunk).
export function drawDoomLeverRod(
  ctx: CanvasRenderingContext2D,
  center: Point,
  angleDeg: number,
  innerRadius: number,
  length: number
): void {
  if (length <= 0.5) return;

  const thickness = DOOM_LEVER_ROD_THICKNESS;
  const half = thickness / 2;
  const x0 = innerRadius;
  const x1 = innerRadius + length;
  const capX = Math.max(x0, x1 - half);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(gaugeAngleToCanvasRadians(angleDeg));

  ctx.beginPath();
  ctx.moveTo(x0, -half);
  ctx.lineTo(capX, -half);
  ctx.arc(capX, 0, half, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x0, half);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, -half, 0, half);
  gradient.addColorStop(0, shadeColor(IRON_COLOR, 0.55));
  gradient.addColorStop(0.5, shadeColor(IRON_COLOR, 2.1));
  gradient.addColorStop(1, shadeColor(IRON_COLOR, 0.55));
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.stroke();

  ctx.restore();
}

// A decal overlaid on the external lever rod — a committed static asset
// (public/images/doom-lever/, same "self-hosted at a fixed URL" convention
// as public/fonts/bravura and public/fonts/fira-code), rather than anything
// user-uploaded (that's ui/appearancePack.ts's separate skin-pack system).
// A plain <img> — not FontFace-style readiness tracking — since drawImage on
// a not-yet-loaded image is a harmless no-op per spec, and this is redrawn
// every frame anyway, so the decal just fades in as soon as decoding
// finishes with no promise/state to wire up.
const LEVER_IMAGE_URL = '/images/doom-lever/doom-graphic.png';
const leverImage = new Image();
leverImage.src = LEVER_IMAGE_URL;

const LEVER_IMAGE_WIDTH_FRACTION = 0.8; // decal's narrow dimension, as a fraction of the rod's own thickness

// Centered along the FULL lever length (DOOM_LEVER_LENGTH), at a fixed
// position and rotation that tracks `angleDeg` exactly like the rod itself
// — `length` (the growth-animated current rod extent, not the full length)
// only controls how much of that fixed decal is currently clipped into
// view, so it's progressively revealed as the lever grows outward rather
// than popping in all at once. No-ops before any length has grown, same as
// drawDoomLeverRod, and before the image itself has decoded.
export function drawDoomLeverImage(
  ctx: CanvasRenderingContext2D,
  center: Point,
  angleDeg: number,
  innerRadius: number,
  length: number
): void {
  if (length <= 0.5) return;
  if (!leverImage.complete || leverImage.naturalWidth === 0) return;

  const half = DOOM_LEVER_ROD_THICKNESS / 2;
  const x0 = innerRadius;
  const x1 = innerRadius + length;
  const capX = Math.max(x0, x1 - half);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(gaugeAngleToCanvasRadians(angleDeg));

  // Clip to the rod's own current silhouette (identical path to
  // drawDoomLeverRod's own fill) so the decal can never draw past whatever
  // extent of rod is actually visible right now.
  ctx.beginPath();
  ctx.moveTo(x0, -half);
  ctx.lineTo(capX, -half);
  ctx.arc(capX, 0, half, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x0, half);
  ctx.closePath();
  ctx.clip();

  const isPortrait = leverImage.naturalHeight >= leverImage.naturalWidth;
  const narrowPx = isPortrait ? leverImage.naturalWidth : leverImage.naturalHeight;
  const longPx = isPortrait ? leverImage.naturalHeight : leverImage.naturalWidth;
  const scale = (DOOM_LEVER_ROD_THICKNESS * LEVER_IMAGE_WIDTH_FRACTION) / narrowPx;
  const thicknessSize = narrowPx * scale;
  const lengthSize = longPx * scale;

  const centerRadius = innerRadius + DOOM_LEVER_LENGTH / 2;
  ctx.translate(centerRadius, 0);
  if (isPortrait) {
    // The image's long pixel dimension is its height, which drawImage would
    // otherwise lay along the current y-axis (across the rod) — rotate a
    // further -90deg first so it runs along the rod's own length instead.
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(leverImage, -thicknessSize / 2, -lengthSize / 2, thicknessSize, lengthSize);
  } else {
    ctx.drawImage(leverImage, -lengthSize / 2, -thicknessSize / 2, lengthSize, thicknessSize);
  }

  ctx.restore();
}

// Ivory body for the needle — only its final third (see NEEDLE_RED_FRACTION
// below) is picked out in DANGER_COLOR, the way a real instrument needle's
// own paint often marks just its tip as a warning accent rather than the
// whole thing.
const NEEDLE_COLOR = '#f0ead6';
const NEEDLE_RED_FRACTION = 0.3; // fraction of the needle's own length, counted back from the tip, painted red

// The gauge's own short needle, from the pivot out to near the dial face's
// own rim — the segment of the SAME rod that reads as "the pointer on the
// gauge" per the spec, sharing angleDeg with drawDoomLeverRod exactly. A
// solid tapered triangle (wide at the pivot, a sharp point at the tip) —
// the classic instrument-needle silhouette — split into two fills along its
// own taper: an ivory body, then a red tip over the final
// NEEDLE_RED_FRACTION of its length. Since the triangle's half-width tapers
// linearly from baseHalfWidth (at the pivot end) to 0 (at the tip), the
// split point's own half-width is just baseHalfWidth scaled by how much of
// the taper remains past that point — no separate width formula needed.
export function drawDoomLeverNeedle(ctx: CanvasRenderingContext2D, center: Point, angleDeg: number, faceRadius: number): void {
  const dir = leverDirection(angleDeg);
  const perp = { x: -dir.y, y: dir.x };
  const tipRadius = faceRadius; // right out to the dial's own rim
  const baseRadius = 2;
  const baseHalfWidth = 3.5;
  const splitRadius = baseRadius + (tipRadius - baseRadius) * (1 - NEEDLE_RED_FRACTION);
  const splitHalfWidth = baseHalfWidth * NEEDLE_RED_FRACTION;

  const point = (r: number, offset: number): Point => ({
    x: center.x + dir.x * r + perp.x * offset,
    y: center.y + dir.y * r + perp.y * offset,
  });

  ctx.save();

  // Ivory body: base to the split point.
  ctx.beginPath();
  ctx.moveTo(point(baseRadius, baseHalfWidth).x, point(baseRadius, baseHalfWidth).y);
  ctx.lineTo(point(baseRadius, -baseHalfWidth).x, point(baseRadius, -baseHalfWidth).y);
  ctx.lineTo(point(splitRadius, -splitHalfWidth).x, point(splitRadius, -splitHalfWidth).y);
  ctx.lineTo(point(splitRadius, splitHalfWidth).x, point(splitRadius, splitHalfWidth).y);
  ctx.closePath();
  ctx.fillStyle = NEEDLE_COLOR;
  ctx.fill();

  // Red tip: split point to the sharp point at the very end.
  ctx.beginPath();
  ctx.moveTo(point(tipRadius, 0).x, point(tipRadius, 0).y);
  ctx.lineTo(point(splitRadius, splitHalfWidth).x, point(splitRadius, splitHalfWidth).y);
  ctx.lineTo(point(splitRadius, -splitHalfWidth).x, point(splitRadius, -splitHalfWidth).y);
  ctx.closePath();
  ctx.fillStyle = `rgb(${DANGER_COLOR})`;
  ctx.fill();

  ctx.restore();
}

const TICK_COUNT = 12;

// Printed underneath the rivet, in the same un-ticked ~90deg gap at the
// bottom of the sweep the ticks/danger band already leave empty (see the
// TICK_COUNT loop below) — so it never competes with them. Two lines, value
// over unit, the way a manufacturer's nameplate/rating is set on a real
// pressure gauge — vertically centered in the band between the rivet's own
// socket and the face's bottom rim, rather than hung off the rivet's edge.
// Ivory, matching NEEDLE_COLOR, the dial's existing "painted-on instrument
// marking" tone; both lines are undefined for a kind with no
// DOOM_LEVER_PITCH_TARGETS mapping (see setDoomLeverAngle in
// ui/interaction.ts), which draws nothing rather than a stale/meaningless 0.
const VALUE_TEXT_COLOR = 'rgba(240, 234, 214, 0.92)';
const VALUE_TEXT_SIZE = 7;
const VALUE_TEXT_LINE_GAP = 7; // distance between the two lines' own baselines-worth of vertical center

function drawDoomLeverValueText(
  ctx: CanvasRenderingContext2D,
  center: Point,
  faceRadius: number,
  valueLine: string,
  unitLine: string
): void {
  const bandMid = center.y + (RIVET_SOCKET_RADIUS + faceRadius) / 2;

  ctx.save();
  ctx.font = `${VALUE_TEXT_SIZE}px ${MONO_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 2;
  ctx.fillStyle = VALUE_TEXT_COLOR;
  ctx.fillText(valueLine, center.x, bandMid - VALUE_TEXT_LINE_GAP / 2);
  ctx.fillText(unitLine, center.x, bandMid + VALUE_TEXT_LINE_GAP / 2);
  ctx.restore();
}

// The dial: beveled bezel ring, an aged brass face, tick marks around the
// same -135..+135 sweep the needle/lever share, a red arc band over the
// danger third, and (when dangerGlow > 0) a soft red wash across the whole
// face — `alpha` is the gauge's own appear/disappear fade (see gaugeAlpha),
// separate from dangerGlow, which fades independently based on the current
// angle regardless of how long the gauge itself has been open. `valueLine`/
// `unitLine` (already formatted — see ui/render.ts's own call site) are the
// two-line numeric readout printed below the rivet, nameplate-style; both
// omitted for a kind whose lever doesn't drive any value yet.
export function drawDoomLeverGauge(
  ctx: CanvasRenderingContext2D,
  center: Point,
  radius: number,
  angleDeg: number,
  dangerGlow: number,
  alpha: number,
  valueLine?: string,
  unitLine?: string
): void {
  if (alpha <= 0.01) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Drop shadow, cast by the gauge's own outer silhouette so the whole dial
  // reads as sitting proud of the box behind it — a throwaway filled circle
  // under shadow settings, immediately covered by the real bezel/face fills
  // drawn on top with no shadow of their own (a shadow on every individual
  // element below would blur each of them into its own grey halo instead of
  // contributing to one shared shadow under the assembly).
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = IRON_COLOR;
  ctx.fill();
  ctx.restore();

  // Bezel — a thin rounded brass rim, not the dark iron/heavy-black-outline
  // treatment every other box edge in this app already uses. Rather than one
  // radial gradient (which reads flat across a ring this thin — a radial
  // gradient shades by distance from the CENTER, not by position across the
  // ring's own narrow band), several concentric solid-color circles are
  // drawn back-to-front, each a couple px smaller than the last: painter's
  // algorithm means only the outer annulus of each one stays visible, so the
  // stack reads as a handful of consecutive shaded bands narrowing toward
  // the face — a cheap but effective stand-in for a genuine rounded/domed
  // cross-section, brightest at the outer edge and darkening toward the
  // face the way a curved-over metal rim actually catches the light.
  const faceRadius = radius * 0.9; // thin rim (was 0.8), per the earlier "thin bezel" ask
  const BEZEL_RING_COUNT = 5;
  for (let i = 0; i < BEZEL_RING_COUNT; i++) {
    const t = i / (BEZEL_RING_COUNT - 1); // 0 at the outer edge, 1 at the face
    const ringRadius = radius - (radius - faceRadius) * t;
    const shadeFactor = (1.55 - t * 1.15) * BEZEL_BRIGHTNESS; // bright highlight -> dark shadow
    ctx.beginPath();
    ctx.arc(center.x, center.y, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = shadeColor(BEZEL_COLOR, shadeFactor);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.stroke();

  // Dial face, inset from the bezel.
  ctx.beginPath();
  ctx.arc(center.x, center.y, faceRadius, 0, Math.PI * 2);
  ctx.fillStyle = DIAL_FACE_COLOR;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.stroke();

  // Tick marks across the sweep, the danger third picked out in red even
  // before the wash below cross-fades in.
  for (let i = 0; i <= TICK_COUNT; i++) {
    const g = DOOM_LEVER_MIN_ANGLE + ((DOOM_LEVER_MAX_ANGLE - DOOM_LEVER_MIN_ANGLE) * i) / TICK_COUNT;
    const dir = leverDirection(g);
    const inner = faceRadius * 0.8;
    const outer = faceRadius * 0.95;
    ctx.beginPath();
    ctx.moveTo(center.x + dir.x * inner, center.y + dir.y * inner);
    ctx.lineTo(center.x + dir.x * outer, center.y + dir.y * outer);
    ctx.strokeStyle = isDangerAngle(g) ? `rgb(${DANGER_COLOR})` : 'rgba(20, 15, 8, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // The danger band itself, a thicker arc along the rim's own first third
  // (the low end of the range — see isDangerAngle's own comment).
  ctx.beginPath();
  ctx.arc(
    center.x,
    center.y,
    faceRadius * 0.92,
    gaugeAngleToCanvasRadians(DOOM_LEVER_MIN_ANGLE),
    gaugeAngleToCanvasRadians(DOOM_LEVER_DANGER_MAX_ANGLE)
  );
  ctx.strokeStyle = `rgb(${DANGER_COLOR})`;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Soft red wash across the whole face once the needle is actually IN the
  // danger zone — clipped to the face so it never bleeds onto the bezel.
  if (dangerGlow > 0.01) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, faceRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.shadowColor = `rgba(${DANGER_COLOR}, ${0.9 * dangerGlow})`;
    ctx.shadowBlur = 18 * dangerGlow;
    ctx.fillStyle = `rgba(${DANGER_COLOR}, ${0.45 * dangerGlow})`;
    ctx.fillRect(center.x - faceRadius, center.y - faceRadius, faceRadius * 2, faceRadius * 2);
    ctx.restore();
  }

  drawDoomLeverNeedle(ctx, center, angleDeg, faceRadius);

  if (valueLine && unitLine) drawDoomLeverValueText(ctx, center, faceRadius, valueLine, unitLine);

  ctx.restore();
}
