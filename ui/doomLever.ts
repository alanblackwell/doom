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

export function drawDoomLeverRivet(ctx: CanvasRenderingContext2D, center: Point): void {
  ctx.save();

  // A dark recessed socket where the dome meets the surface, so it reads as
  // sitting IN the box's own material rather than floating on top of it.
  ctx.beginPath();
  ctx.arc(center.x, center.y, DOOM_LEVER_RIVET_RADIUS + 2.5, 0, Math.PI * 2);
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

// The dial: beveled bezel ring, an aged brass face, tick marks around the
// same -135..+135 sweep the needle/lever share, a red arc band over the
// danger third, and (when dangerGlow > 0) a soft red wash across the whole
// face — `alpha` is the gauge's own appear/disappear fade (see gaugeAlpha),
// separate from dangerGlow, which fades independently based on the current
// angle regardless of how long the gauge itself has been open.
export function drawDoomLeverGauge(
  ctx: CanvasRenderingContext2D,
  center: Point,
  radius: number,
  angleDeg: number,
  dangerGlow: number,
  alpha: number
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

  ctx.restore();
}
