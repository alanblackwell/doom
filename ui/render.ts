// Canvas2D rendering of the entity graph. Procedural (noise-jittered path,
// gradient fill) rather than bitmap textures for now — ARCHITECTURE.md §4.1's
// grunge texture assets don't exist yet (textures/ is empty); this gets an
// organic, non-clinical silhouette without depending on them, and can be
// swapped for pattern fills later without touching the containment/hit-test
// logic in layout.ts.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { CONTINUOUS_KINDS, PROCESSOR_KINDS, TRIGGERED_KINDS, isEntityPaused, isEntityPlaying } from '../audio/graph';
import { absolutePosition, descendantIds, effectiveBounds } from './layout';
import type { DragContext, Point, Rect } from './layout';
import type { InteractionState } from './interaction';
import {
  controlDotAbsolutePosition,
  controlsFor,
  dotPositionFor,
  formatControlValue,
  restTrackGeometry,
  trackGeometry,
  valueFraction,
  CONTROL_DOT_OUTER_RADIUS,
  CONTROL_DOT_RADIUS,
  CONTROL_DOT_DROP_RADIUS,
} from './controls';
import { padRadius, PAD_FLASH_DURATION } from './pads';
import { knobIndicatorAngle, wireHandlePosition, WIRE_BUMP_RADIUS } from './knobs';
import { getAllWires, getWireTo } from './wiring';
import { getAllEventWires } from './eventWiring';
import { eventWireEndpoints, valueWireEndpoints, wireCurveControlPoint } from './wireGeometry';
import { sourcePulseGlow } from './eventPulse';
import { getBeatFlashGlow } from './clockPulse';
import { formatKeyLabel, getBoundKey } from './tapBindings';
import { drawDock } from './dock';
import { drawPopup, drawPorthole } from './organelle';
import { drawMelodyPopup, itemScreenX } from './melody';
import type { MelodyItem } from './melody';
import { beginSamplerFrame, drawSamplerPopup, endSamplerFrame } from './sampler';
import { KIND_COLORS, DEFAULT_COLOR, ACCENT, shadeColor } from './palette';
import { positionModifier, viewportSize } from './stereoMix';
import { drawAdjustedTexture, getTexture } from './textures';
import type { SavedTexture } from './textures';
import { drawTextureEditor } from './textureEditor';

// A control dot's outer ring — quiet backdrop for the smaller colored dot
// resting at its center (see drawControls), a little lighter than the
// canvas's own #111 backdrop, matching the app's existing dark
// control-surface color (index.html's #start-audio button background).
const CONTROL_DOT_RING_COLOR = '#262626';

// Deterministic per-entity PRNG (mulberry32) so an entity's jittered
// silhouette is stable across frames/reloads instead of re-randomizing.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a rough, hand-torn-looking closed path around a centered rect,
// rather than a clean rounded rectangle — this is the main "not clinical
// SVG" move from ARCHITECTURE.md §4.1, done with plain path jitter.
function jitteredRectPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  seed: number
): void {
  const rand = mulberry32(seed);
  const roughness = Math.min(w, h) * 0.05;
  const perSide = 4;
  const hw = w / 2;
  const hh = h / 2;
  const corners: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];

  const points: [number, number][] = [];
  for (let side = 0; side < 4; side++) {
    const [x0, y0] = corners[side];
    const [x1, y1] = corners[(side + 1) % 4];
    const horizontal = y0 === y1;
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const jitter = (rand() - 0.5) * roughness;
      points.push([cx + x + (horizontal ? 0 : jitter), cy + y + (horizontal ? jitter : 0)]);
    }
  }

  ctx.beginPath();
  ctx.moveTo((points[0][0] + points[points.length - 1][0]) / 2, (points[0][1] + points[points.length - 1][1]) / 2);
  for (let i = 0; i < points.length; i++) {
    const p = points[(i + 1) % points.length];
    const mid: [number, number] = [
      (points[i][0] + p[0]) / 2,
      (points[i][1] + p[1]) / 2,
    ];
    ctx.quadraticCurveTo(points[i][0], points[i][1], mid[0], mid[1]);
  }
  ctx.closePath();
}

// Quick ease-out-back overshoot, used for the post-drop "settle" — starts
// slightly oversized and springs down to 1, rather than snapping instantly.
function settleScale(elapsedMs: number, durationMs: number): number {
  if (elapsedMs >= durationMs) return 1;
  const t = elapsedMs / durationMs;
  const overshoot = 1.7;
  const eased = 1 + (overshoot + 1) * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
  return 1 + (1 - eased) * 0.12;
}

function drawEntity(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  depth: number,
  interaction: InteractionState,
  now: number,
  drag: DragContext | undefined
): void {
  // The dragged entity is drawn separately, as an overlay, so it visually
  // lifts above the whole tree instead of staying nested where it started.
  if (entity.id === interaction.draggingId) return;

  const bounds = effectiveBounds(graph, entity, drag);
  let scale = 1;
  if (interaction.settleAnim && interaction.settleAnim.id === entity.id) {
    const elapsed = now - interaction.settleAnim.startedAt;
    if (elapsed < interaction.settleAnim.durationMs) {
      scale = settleScale(elapsed, interaction.settleAnim.durationMs);
    } else {
      interaction.settleAnim = null;
    }
  }

  if (entity.type === 'control') {
    if (entity.kind === 'clock') {
      drawClock(ctx, entity, bounds, entity.id === interaction.selectedId, now);
    } else if (entity.kind === 'tap') {
      const highlighted = entity.id === interaction.selectedId || interaction.hoveredTapId === entity.id;
      drawTap(ctx, entity, bounds, highlighted, now, interaction);
    } else {
      drawKnob(ctx, entity, bounds, entity.id === interaction.selectedId);
    }
  } else {
    drawBox(ctx, entity, bounds.x, bounds.y, bounds.width * scale, bounds.height * scale, depth, {
      selected: entity.id === interaction.selectedId,
      dropTarget: entity.id === interaction.hoverTargetId,
      lifted: false,
    });
  }

  // Controls are NOT drawn here — they render in a separate final pass in
  // renderFrame(), on top of every box including the drag overlay. Drawing
  // them inline (as before) meant anything dropped into a filter, or drawn
  // after it in the normal tree order, could visually cover its own control
  // dots/slider even though the box had grown to make room underneath.

  for (const child of graph.childrenOf(entity.id)) {
    drawEntity(ctx, graph, child, depth + 1, interaction, now, drag);
  }
}

// Quiet-by-default per-parameter control dots (see ui/controls.ts): a small
// resting dot per param, morphing into a labeled vertical slider on hover —
// positioned so the point representing the current value lands exactly
// where the dot was, so the cursor is already on the thumb. Called from
// renderFrame()'s final overlay pass, not inline with the box that owns it —
// see the comment in drawEntity() for why.
// True when (entityId, param) is wired from a source param that's currently
// being hovered or dragged (see isControlActive below) — i.e. its value is
// live-changing right now because of that interaction, not just sitting at
// whatever it was last set to.
function isReceivingFromActiveWire(
  graph: EntityGraph,
  interaction: InteractionState,
  entityId: string,
  param: string
): boolean {
  const wire = getWireTo(entityId, param);
  return wire !== undefined && isControlActive(interaction, wire.sourceEntityId, wire.sourceParam);
}

function drawControls(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  bounds: Rect,
  interaction: InteractionState
): void {
  const specs = controlsFor(entity.kind);
  if (specs.length === 0) return;
  // An empty filter has nothing routed through it yet for these params to
  // affect — hiding them saves space and clutter until something's
  // actually dropped in (see layout.ts's matching effectiveBounds
  // exemption, which is what lets the box itself shrink to match).
  if (PROCESSOR_KINDS.has(entity.kind) && graph.childrenOf(entity.id).length === 0) return;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const dot = dotPositionFor(entity, bounds, i);
    const isHovering = interaction.hoverControl?.entityId === entity.id && interaction.hoverControl.param === spec.param;
    const dragging = interaction.draggingControl?.entityId === entity.id && interaction.draggingControl.spec.param === spec.param;
    // A wire target whose feeding source is itself being hovered/dragged
    // right now — rendered expanded too, so every slider a live change is
    // reaching visibly tracks it at the same time, not just the one under
    // the pointer.
    const receivingLiveWire =
      !isHovering && !dragging && isReceivingFromActiveWire(graph, interaction, entity.id, spec.param);
    // This dot is where a wire currently being dragged out would land if
    // released right now — a "compatible drop site" cue: the inner colored
    // dot grows to fill the outer grey ring, rather than the whole thing
    // expanding past its own footprint.
    const isWireDropTarget =
      interaction.wireHoverTarget?.entityId === entity.id && interaction.wireHoverTarget.spec.param === spec.param;

    if (!isHovering && !dragging && !receivingLiveWire) {
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, CONTROL_DOT_OUTER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = CONTROL_DOT_RING_COLOR;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(dot.x, dot.y, isWireDropTarget ? CONTROL_DOT_DROP_RADIUS : CONTROL_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = spec.color;
      ctx.fill();
      continue;
    }

    const currentValue = entity.params[spec.param] ?? spec.min;
    // While actively dragging, use the FIXED track captured at drag-start —
    // recomputing it from the live (constantly-changing) value would make
    // the mapping chase itself instead of tracking the pointer smoothly.
    // Same reasoning for a wire-driven slider: its value changes on its own,
    // so it needs a value-independent track too, or the scale itself would
    // shift around instead of the thumb moving within it.
    const track = dragging
      ? interaction.draggingControl!.track
      : receivingLiveWire
        ? restTrackGeometry(dot)
        : trackGeometry(dot, spec, currentValue);

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(track.x, track.top);
    ctx.lineTo(track.x, track.bottom);
    ctx.stroke();

    const thumbY = track.bottom - valueFraction(spec, currentValue) * (track.bottom - track.top);
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(track.x - 7, thumbY);
    ctx.lineTo(track.x + 7, thumbY);
    ctx.stroke();

    // Label + numeric readout together, e.g. "damping 0.62" — precise
    // enough to read back and report as a new default (e.g. in
    // dsp/rust/src/lib.rs's tune-by-ear params, or ui/main.ts's initial
    // params), not just the dot's rough visual position. Kept on the same
    // side as the dot column (left, outside the box — see controlSpecs.ts's
    // DOT_OUTSET) rather than next to the thumb, which would run the text
    // into the box itself.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${spec.label} ${formatControlValue(currentValue)}`, track.x - 12, track.top - 6);
    ctx.restore();
  }
}

// Center trigger pad for one-shot instruments (audio/graph.ts's
// TRIGGERED_KINDS) — a quiet ring at rest, with an expanding-and-fading
// flash ring on trigger for "you hit it" feedback. Also doubles as the
// play/pause button for a continuous drone (CONTINUOUS_KINDS) — same ring/
// icon-swap/flash treatment, an event wire can land on either kind's pad
// exactly the same way (see ui/interaction.ts), just with different
// semantics once it fires. Called from renderFrame()'s final overlay pass,
// same reasoning as drawControls above.
function drawPad(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  bounds: Rect,
  interaction: InteractionState,
  now: number
): void {
  const continuous = CONTINUOUS_KINDS.has(entity.kind);
  if (!TRIGGERED_KINDS.has(entity.kind) && !continuous) return;

  const radius = padRadius(bounds);

  ctx.save();
  ctx.beginPath();
  ctx.arc(bounds.x, bounds.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // A wire being dragged from an event source (see ui/eventWiring.ts) that
  // would land on THIS pad if released now — a low-alpha white wash over
  // the whole circle, not an expansion like a control dot's drop-target
  // grow (this is a fixed-size button, not something with room to grow).
  if (interaction.eventWireHoverTarget === entity.id) {
    ctx.beginPath();
    ctx.arc(bounds.x, bounds.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fill();
  }

  // Small "play"-style triangle at rest, subtle — enough to read as a
  // button without competing with the id/kind labels underneath it. Swaps
  // to a "pause"-style two-bar icon while sound is actually coming out of
  // it: for a 'sample' entity, once playback has actually started (see
  // audio/graph.ts's isEntityPlaying — always false for the other
  // TRIGGERED_KINDS, so their pad never shows this); for a CONTINUOUS_KINDS
  // drone, the icon's polarity is reversed — playing is its normal resting
  // state, so the bars show whenever it's NOT paused, inviting a click to
  // pause rather than to start something that's already sounding.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  const s = radius * 0.5;
  const showPauseIcon = continuous ? !isEntityPaused(entity.id) : isEntityPlaying(entity.id);
  if (showPauseIcon) {
    const barWidth = s * 0.4;
    const barHeight = s * 1.4;
    ctx.fillRect(bounds.x - s * 0.6, bounds.y - barHeight / 2, barWidth, barHeight);
    ctx.fillRect(bounds.x + s * 0.2, bounds.y - barHeight / 2, barWidth, barHeight);
  } else {
    ctx.beginPath();
    ctx.moveTo(bounds.x - s * 0.5, bounds.y - s * 0.7);
    ctx.lineTo(bounds.x - s * 0.5, bounds.y + s * 0.7);
    ctx.lineTo(bounds.x + s * 0.8, bounds.y);
    ctx.closePath();
    ctx.fill();
  }

  const flashStart = interaction.triggerFlashes.get(entity.id);
  if (flashStart !== undefined) {
    const elapsed = now - flashStart;
    if (elapsed < PAD_FLASH_DURATION) {
      const t = elapsed / PAD_FLASH_DURATION;
      ctx.beginPath();
      ctx.arc(bounds.x, bounds.y, radius + t * radius * 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 210, 150, ${1 - t})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    } else {
      interaction.triggerFlashes.delete(entity.id);
    }
  }

  ctx.restore();
}

const KNOB_BODY_COLOR = '#3a3a3a';
const KNOB_INDICATOR_COLOR = '#e8dcc0'; // matches its own value dot's color (controlSpecs.ts)
const WIRE_HANDLE_COLOR = '#c8a05a'; // warm brass — reads as "output jack"

// A Control entity (currently just 'knob') — a circular body with a
// rotating indicator for its own value, plus the wire-start handle drawn
// separately below (see drawWires). Deliberately NOT the jittered-rect
// treatment drawBox uses for audio sources — a clean circle reads at a
// glance as "this is a different kind of object, not an instrument."
// Shared body for every control-type entity (knob, clock, ...): the
// circular case, its shadow/gradient/selection border. Returns the radius
// so callers can position their own center indicator and label off it.
function drawControlBody(ctx: CanvasRenderingContext2D, bounds: Rect, selected: boolean): number {
  const radius = Math.min(bounds.width, bounds.height) / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  ctx.arc(bounds.x, bounds.y, radius, 0, Math.PI * 2);
  const gradient = ctx.createRadialGradient(
    bounds.x,
    bounds.y - radius * 0.25,
    radius * 0.1,
    bounds.x,
    bounds.y,
    radius
  );
  gradient.addColorStop(0, shadeColor(KNOB_BODY_COLOR, 1.6));
  gradient.addColorStop(1, shadeColor(KNOB_BODY_COLOR, 0.8));
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeStyle = selected ? ACCENT : 'rgba(0, 0, 0, 0.6)';
  ctx.stroke();
  ctx.restore();

  return radius;
}

// Output connector: a round bump protruding from the body's right edge,
// rather than a dot sitting flush on the boundary — reads as a jack stuck
// onto the body rather than a mark on it. `glow` (0..1) brightens it with a
// soft flash, used by drawClock to pulse the bump in time with the beat —
// plain 0 for drawKnob, which has nothing to pulse to.
function drawWireBump(ctx: CanvasRenderingContext2D, bounds: Rect, glow: number): void {
  const handle = wireHandlePosition(bounds);

  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = `rgba(255, 210, 150, ${0.9 * glow})`;
    ctx.shadowBlur = 10 * glow;
  }
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, WIRE_BUMP_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = glow > 0 ? shadeColor(WIRE_HANDLE_COLOR, 1 + glow) : WIRE_HANDLE_COLOR;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawControlLabel(ctx: CanvasRenderingContext2D, entity: Entity, bounds: Rect, radius: number): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.id, bounds.x, bounds.y + radius + 14);
}

function drawKnob(ctx: CanvasRenderingContext2D, entity: Entity, bounds: Rect, selected: boolean): void {
  const radius = drawControlBody(ctx, bounds, selected);
  const value = Math.min(1, Math.max(0, entity.params.value ?? 0.5));
  const angle = knobIndicatorAngle(value);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(bounds.x, bounds.y);
  ctx.lineTo(bounds.x + Math.sin(angle) * radius * 0.8, bounds.y - Math.cos(angle) * radius * 0.8);
  ctx.strokeStyle = KNOB_INDICATOR_COLOR;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  drawWireBump(ctx, bounds, 0);
  drawControlLabel(ctx, entity, bounds, radius);
}

// The master clock (audio/transport.ts): same body as a knob, but its
// tempo readout ("nn BPM", live as the slider drags) stands in for both the
// rotating dial pointer a knob has (no single dial position means anything
// for a tempo) and the entity.id label every other control gets — the
// number already says what this is. Its output bump pulses in time with the
// beat (ui/clockPulse.ts) rather than sitting at a flat color — both a
// status readout and, since it's a normal control-type wire-output bump
// underneath, a wireable connector.
function drawClock(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  bounds: Rect,
  selected: boolean,
  now: number
): void {
  const radius = drawControlBody(ctx, bounds, selected);
  const bpm = Math.round(entity.params.bpm ?? 80);

  drawWireBump(ctx, bounds, getBeatFlashGlow(now));

  // Below the body, not at its center — the center is where the control
  // dot/slider (drawn separately, in renderFrame's overlay pass) sits, and
  // would otherwise cover the readout.
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${bpm} BPM`, bounds.x, bounds.y + radius + 14);
  ctx.restore();
}

const TAP_FLASH_DURATION_MS = 150; // matches ui/clockPulse.ts's FLASH_DURATION_MS

// A momentary trigger (ui/interaction.ts's fireTap): same body as a knob,
// but its center shows the bound key ('TAP' until one is bound — see
// ui/tapBindings.ts) instead of a dial pointer, and its output bump flashes
// once per tap/keypress rather than pulsing on a recurring beat like the
// clock's.
function drawTap(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  bounds: Rect,
  highlighted: boolean,
  now: number,
  interaction: InteractionState
): void {
  drawControlBody(ctx, bounds, highlighted);

  const flashAt = interaction.triggerFlashes.get(entity.id);
  const elapsed = flashAt === undefined ? Infinity : now - flashAt;
  const glow = elapsed >= 0 && elapsed <= TAP_FLASH_DURATION_MS ? 1 - elapsed / TAP_FLASH_DURATION_MS : 0;
  drawWireBump(ctx, bounds, glow);

  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatKeyLabel(getBoundKey(entity.id)), bounds.x, bounds.y);
  ctx.restore();
}

// Wire opacity tracks the value actually being propagated along it — 25% at
// the source param's minimum, 100% at its maximum — but only while that
// param is actually being operated (hovered or dragged); otherwise the wire
// sits at the minimum. So a wire brightens/dims live as you work the slider
// that feeds it, rather than just reflecting a static "current value" at
// all times.
const MIN_WIRE_OPACITY = 0.25;
const MAX_WIRE_OPACITY = 1;

function isControlActive(interaction: InteractionState, entityId: string, param: string): boolean {
  const hover = interaction.hoverControl;
  const dragging = interaction.draggingControl;
  return (
    (hover !== null && hover.entityId === entityId && hover.param === param) ||
    (dragging !== null && dragging.entityId === entityId && dragging.spec.param === param)
  );
}

function wireOpacity(
  graph: EntityGraph,
  interaction: InteractionState,
  entityId: string,
  param: string
): number {
  const entity = graph.get(entityId);
  const spec = entity && controlsFor(entity.kind).find((s) => s.param === param);
  if (!entity || !spec) return MAX_WIRE_OPACITY;
  if (!isControlActive(interaction, entityId, param)) return MIN_WIRE_OPACITY;
  const fraction = valueFraction(spec, entity.params[param] ?? spec.min);
  return MIN_WIRE_OPACITY + fraction * (MAX_WIRE_OPACITY - MIN_WIRE_OPACITY);
}

// A soft-sagging cable curve, like a real patch cord — used for both
// committed wires and the live rubber band while dragging a new one.
// `glow` (0-1, default 0) adds a soft bloom on top of the flat stroke —
// only event wires pass a nonzero value (ui/eventPulse.ts's per-source
// pulse animation), matching the warm flash-ring glow the pad/clock/tap
// endpoints already use elsewhere so the whole wire reads as one animation.
function drawWireLine(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  opacity: number,
  glow = 0
): void {
  const control = wireCurveControlPoint(from, to);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = opacity;
  if (glow > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow * 10;
  }
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

// All committed wires, plus the live rubber band while one's being dragged
// out. Drawn before controls/pads in the final overlay pass so a wire's end
// looks like it plugs into the dot, not draws over it.
// Event wires (ui/eventWiring.ts) carry no continuous value, so there's
// nothing to fade proportionally the way wireOpacity does for value wires —
// a flat, warm color/opacity, matching the palette trigger feedback already
// uses elsewhere (the pad flash ring, the clock/tap bump glow).
const EVENT_WIRE_COLOR = 'rgba(255, 210, 150, 0.3)';

function drawWires(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  interaction: InteractionState,
  drag: DragContext | undefined,
  dragDelta: { x: number; y: number } | null,
  draggedSubtreeIds: Set<string>,
  now: number
): void {
  // A wire's endpoint follows the live drag position throughout, not just
  // once the drop commits it to entity.x/y — same delta-translation the
  // final controls/pads pass below already applies, so a wire never visibly
  // detaches from the box it's plugged into while that box is being dragged.
  // draggedSubtreeIds (see below) is descendants only, not the dragged
  // entity itself — checked separately here since a wire is just as likely
  // to be plugged directly into the entity actually being dragged as into
  // one of its children.
  const translate = (p: Point, entityId: string): Point =>
    dragDelta && (entityId === interaction.draggingId || draggedSubtreeIds.has(entityId))
      ? { x: p.x + dragDelta.x, y: p.y + dragDelta.y }
      : p;

  for (const wire of getAllWires()) {
    const endpoints = valueWireEndpoints(graph, wire, drag);
    if (!endpoints) continue;

    const target = graph.get(wire.targetEntityId)!;
    const spec = controlsFor(target.kind).find((s) => s.param === wire.targetParam);
    const opacity = wireOpacity(graph, interaction, wire.sourceEntityId, wire.sourceParam);
    const from = translate(endpoints.from, wire.sourceEntityId);
    const to = translate(endpoints.to, wire.targetEntityId);
    drawWireLine(ctx, from, to, spec?.color ?? 'rgba(255, 255, 255, 0.4)', opacity);
  }

  for (const wire of getAllEventWires()) {
    const endpoints = eventWireEndpoints(graph, wire, drag);
    if (!endpoints) continue;
    const from = translate(endpoints.from, wire.sourceEntityId);
    const to = translate(endpoints.to, wire.targetEntityId);
    // Whole-line pulse in sync with this wire's own source firing (see
    // ui/eventPulse.ts) — 0 only for a wire whose source has never fired at
    // all yet, which falls back to the flat opacity this always used to
    // draw at, rather than animating from nothing.
    const glow = sourcePulseGlow(wire.sourceEntityId, now);
    drawWireLine(ctx, from, to, EVENT_WIRE_COLOR, glow > 0 ? glow : MAX_WIRE_OPACITY, glow);
  }

  if (interaction.wiringFrom && interaction.wireDragPoint) {
    const source = graph.get(interaction.wiringFrom.entityId);
    if (source) {
      const anchor = wireHandlePosition(effectiveBounds(graph, source, drag));

      // A valid pad hover (see ui/interaction.ts's pointermove — checked
      // for ANY control-type source, not just an event-only one like tap)
      // always wins the rubber band's styling: snap the endpoint to the
      // pad's center and draw it event-style, regardless of what else this
      // source might otherwise be able to wire to.
      if (interaction.eventWireHoverTarget) {
        const eventTarget = graph.get(interaction.eventWireHoverTarget);
        const eventTargetBounds = eventTarget ? effectiveBounds(graph, eventTarget, drag) : undefined;
        const endPoint = eventTargetBounds ? { x: eventTargetBounds.x, y: eventTargetBounds.y } : interaction.wireDragPoint;
        drawWireLine(ctx, anchor, endPoint, EVENT_WIRE_COLOR, MAX_WIRE_OPACITY);
        return;
      }

      const target = interaction.wireHoverTarget;
      const endPoint = target
        ? (controlDotAbsolutePosition(graph, target.entityId, target.spec.param, drag) ?? interaction.wireDragPoint)
        : interaction.wireDragPoint;
      // A source with no control spec at all (tap) has no value to fade
      // proportionally — full opacity, same as wireOpacity already falls
      // back to when it can't find a spec.
      const sourceSpec = controlsFor(source.kind)[0];
      const opacity = sourceSpec
        ? wireOpacity(graph, interaction, interaction.wiringFrom.entityId, sourceSpec.param)
        : MAX_WIRE_OPACITY;
      drawWireLine(ctx, anchor, endPoint, target ? target.spec.color : 'rgba(255, 255, 255, 0.5)', opacity);
    }
  }
}

// Draws a saved texture's crop window (ui/textures.ts) stretched to fill
// an entity's box rect — its own alpha channel is what shows through
// (nothing else is drawn under it here), so transparent regions of the
// source image reveal whatever's already on the canvas beneath the box,
// which is what gives a customized texture the ability to redefine the
// box's visible silhouette rather than just recoloring the usual rect.
function drawTexturedFill(
  ctx: CanvasRenderingContext2D,
  texture: SavedTexture,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const { image, sourceRect, adjustments } = texture;
  ctx.save();
  // Opacity applied directly here (unlike ui/textureEditor.ts's own live
  // preview, which multiplies it with a fixed visibility alpha that only
  // matters while editing) — brightness/hue/saturation via
  // drawAdjustedTexture, which isolates the filtered draw onto its own
  // scratch canvas rather than combining ctx.filter with this globalAlpha
  // in the same pass.
  ctx.globalAlpha = adjustments.opacity;
  drawAdjustedTexture(
    ctx,
    image,
    sourceRect,
    { x: x - w / 2, y: y - h / 2, width: w, height: h },
    adjustments
  );
  ctx.restore();
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  flags: { selected: boolean; dropTarget: boolean; lifted: boolean }
): void {
  const baseColor = KIND_COLORS[entity.kind] ?? DEFAULT_COLOR;
  // Sink+source ("pedal"/filter) kinds render hollow — an empty container
  // waiting for something to be routed through it, rather than a solid
  // mass like a plain source/mixer. No id label (the box is about what's
  // inside it, not its own name) and the kind label sits in a top-left
  // corner that stays clear once contents grow the box, rather than a
  // centered label that would get buried under whatever's dropped in.
  const isFilter = PROCESSOR_KINDS.has(entity.kind);
  // A user-customized texture (ui/textureEditor.ts) replaces the fill AND
  // the jittered-rect outline below — its own alpha channel defines the
  // visible silhouette (e.g. reshaping a filter's outline boundary),
  // rather than being clipped to the same rectangle every other kind uses.
  const texture = getTexture(entity.kind);

  ctx.save();

  if (flags.lifted) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
  } else {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 6 + depth * 2;
    ctx.shadowOffsetY = 2;
  }

  if (texture) {
    drawTexturedFill(ctx, texture, x, y, w, h);
    ctx.shadowColor = 'transparent';
    if (flags.selected || flags.dropTarget) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2.5;
      if (flags.dropTarget) ctx.setLineDash([6, 4]);
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      ctx.setLineDash([]);
    }
  } else if (isFilter) {
    jitteredRectPath(ctx, x, y, w, h, entity.seed);
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = flags.selected || flags.dropTarget ? 2.5 : 1.5;
    // A near-black edge (the plain-source default below) would be nearly
    // invisible against the canvas backdrop with no fill behind it to set
    // it off — the kind color itself, lightened, reads clearly instead.
    ctx.strokeStyle = flags.selected || flags.dropTarget ? ACCENT : shadeColor(baseColor, 1.3);
    if (flags.dropTarget) {
      ctx.setLineDash([6, 4]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    jitteredRectPath(ctx, x, y, w, h, entity.seed);
    const gradient = ctx.createRadialGradient(x, y - h * 0.2, w * 0.1, x, y, w * 0.7);
    // Nested boxes read as recessed layers — each depth level a touch darker.
    const shade = Math.max(0, 1 - depth * 0.12);
    gradient.addColorStop(0, shadeColor(baseColor, shade * 1.15));
    gradient.addColorStop(1, shadeColor(baseColor, shade * 0.75));
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.lineWidth = flags.selected || flags.dropTarget ? 2.5 : 1;
    ctx.strokeStyle = flags.selected || flags.dropTarget ? ACCENT : 'rgba(0, 0, 0, 0.5)';
    if (flags.dropTarget) {
      ctx.setLineDash([6, 4]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (isFilter) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(entity.kind, x - w / 2 + 8, y - h / 2 + 8);
  } else {
    // Just the kind, centered — no instance id (e.g. "bow-1"), which
    // named nothing a player needs while performing; the kind alone is
    // enough to tell voices apart at a glance. entity.label overrides this
    // for a kind where the kind name alone can't distinguish instances
    // (e.g. 'sample' — see audio/entityGraph.ts's Entity.label).
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(entity.label ?? entity.kind, x, y);
  }

  ctx.restore();
}

// Peak alpha at 100% modification (right at/past either edge) — deliberately
// well short of opaque, so the overlay stays "semi-transparent": entities,
// wires, and controls underneath stay legible even where the wash is
// strongest. Tune by eye.
const MIX_OVERLAY_MAX_ALPHA = 0.4;
// Gradient color-stop count approximating ui/stereoMix.ts's curve — a
// native CanvasGradient only linearly interpolates between stops, so this
// needs to be high enough that the smooth cubic doesn't facet visibly; 40
// is plenty for that and negligible either way (stop-building is cheap,
// and the actual fill is hardware-rasterized regardless of canvas size —
// no per-pixel JS scan).
const MIX_OVERLAY_STOPS = 40;

// Whether ui/render.ts's canvas-position-mix visualization (below) is
// currently drawn — on by default for now; exposed as a toggle for a future
// on/off control (a button, keyboard shortcut, ...) that doesn't exist yet.
let mixOverlayVisible = true;

export function setMixOverlayVisible(visible: boolean): void {
  mixOverlayVisible = visible;
}

export function isMixOverlayVisible(): boolean {
  return mixOverlayVisible;
}

// Dark red — reads as a warning/heat wash (untouched center, "hotter"
// toward the edges) rather than a plain brightness overlay.
const MIX_OVERLAY_COLOR = '139, 0, 0';

// Visualizes ui/stereoMix.ts's canvas-position → mix-modification curve: a
// semi-transparent dark red wash whose opacity tracks the same modification
// percentage the actual pan/volume mapping uses for that position — flat/
// invisible over the dead-center region, brightening non-linearly toward
// each edge exactly like the real mapping does. Built from two 1D
// gradients (one per axis, sampling positionModifier directly so this can
// never drift out of sync with the real mapping) rather than a per-pixel
// scan, composited via ordinary alpha blending — not an exact max() of the
// two axes, but close enough that it reads the same way: darkest in the
// middle, brightest near any edge, and it's cheap regardless of canvas
// size. Stops are defined only across the viewport span (the same fixed
// reference frame the real mapping uses — see viewportSize's own comment);
// a CanvasGradient clamps to its nearest stop's color beyond that span, so
// canvas content scrolled out past the viewport reads as "fully modified"
// too, matching positionModifier's own clamping.
function drawMixModificationOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  if (!mixOverlayVisible) return;

  const { width, height } = viewportSize(canvas);
  if (width <= 0 || height <= 0) return;

  ctx.save();

  const xGradient = ctx.createLinearGradient(0, 0, width, 0);
  for (let i = 0; i <= MIX_OVERLAY_STOPS; i++) {
    const fraction = i / MIX_OVERLAY_STOPS;
    const alpha = Math.abs(positionModifier(fraction * width, width)) * MIX_OVERLAY_MAX_ALPHA;
    xGradient.addColorStop(fraction, `rgba(${MIX_OVERLAY_COLOR}, ${alpha})`);
  }
  ctx.fillStyle = xGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const yGradient = ctx.createLinearGradient(0, 0, 0, height);
  for (let i = 0; i <= MIX_OVERLAY_STOPS; i++) {
    const fraction = i / MIX_OVERLAY_STOPS;
    const alpha = Math.abs(positionModifier(fraction * height, height)) * MIX_OVERLAY_MAX_ALPHA;
    yGradient.addColorStop(fraction, `rgba(${MIX_OVERLAY_COLOR}, ${alpha})`);
  }
  ctx.fillStyle = yGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.restore();
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  graph: EntityGraph,
  interaction: InteractionState,
  now: number
): void {
  // Reset-then-reconfirm for the sampler organelle's floating name <input>
  // (ui/sampler.ts) — it's a real DOM element, not drawn on canvas, so its
  // visibility can't just follow from "was drawPopup called this frame" the
  // way everything else here works. beginSamplerFrame clears a "shown this
  // frame" flag; drawSamplerPopup below sets it back if an expanded sampler
  // popup is actually drawn; endSamplerFrame (bottom of this function) hides
  // the input if nothing did.
  beginSamplerFrame();

  // Always an opaque base fill first — canvas content otherwise persists
  // frame to frame, so a texture with opacity < 1 (see ui/textures.ts's
  // TextureAdjustments) would blend with whatever was drawn last frame
  // (ghosting/trails) rather than a stable backdrop if drawn alone.
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // A user-customized 'canvas' texture (ui/textureEditor.ts) then replaces
  // that flat fill, stretched to cover the full drawing buffer, with its
  // own brightness/hue/saturation/opacity adjustments applied.
  const canvasTexture = getTexture('canvas');
  if (canvasTexture) {
    const { image, sourceRect, adjustments } = canvasTexture;
    ctx.save();
    ctx.globalAlpha = adjustments.opacity;
    drawAdjustedTexture(
      ctx,
      image,
      sourceRect,
      { x: 0, y: 0, width: canvas.width, height: canvas.height },
      adjustments
    );
    ctx.restore();
  }

  // Built once per frame so every effectiveBounds() call below sees the
  // same live drag state — the dragged entity excluded from wherever it
  // structurally still sits (its old container shrinks immediately), and,
  // if it's currently hovering a valid container, previewed as already
  // dropped there (that container grows immediately) — both continuously,
  // for as long as the drag is in progress, not just snapped on drop.
  let drag: DragContext | undefined;
  if (interaction.draggingId) {
    const draggedEntity = graph.get(interaction.draggingId);
    drag = {
      excludeId: interaction.draggingId,
      preview:
        draggedEntity && interaction.hoverTargetId && interaction.dragPointer
          ? {
              intoId: interaction.hoverTargetId,
              liveAbsolute: interaction.dragPointer,
              entity: draggedEntity,
            }
          : null,
    };
  }

  for (const entity of graph.topLevel()) {
    drawEntity(ctx, graph, entity, 0, interaction, now, drag);
  }

  // Dragged entity (and, if it's a container, its whole subtree — children
  // ride along rather than being left behind at their pre-drag position)
  // drawn last, translated to the live pointer position, lifted above
  // everything else regardless of where it started in the hierarchy.
  let dragDelta: { x: number; y: number } | null = null;
  if (interaction.draggingId && interaction.dragPointer) {
    const entity = graph.get(interaction.draggingId);
    if (entity) {
      const original = absolutePosition(graph, entity);
      dragDelta = {
        x: interaction.dragPointer.x - original.x,
        y: interaction.dragPointer.y - original.y,
      };
      drawDraggedSubtree(ctx, graph, entity, dragDelta, 0, true, drag);
    }
  }

  // Controls and trigger pads render last of all, on top of every box
  // including the drag overlay above — "pop-up controls always float above
  // all other content." The dragged entity itself shows neither (nothing
  // else about it renders inline either while it's flying), but a child
  // riding along with a dragged container still needs its own controls/pad
  // translated by the same delta, or they'd stay drawn at its pre-drag
  // position.
  const draggedSubtreeIds = interaction.draggingId
    ? descendantIds(graph, interaction.draggingId)
    : new Set<string>();

  // Wires drawn before controls/pads so a wire's end looks plugged into its
  // dot rather than drawn over it. Needs dragDelta/draggedSubtreeIds (just
  // above) so a wire's endpoint tracks the live drag too, not just the
  // eventual dropped position.
  drawWires(ctx, graph, interaction, drag, dragDelta, draggedSubtreeIds, now);

  for (const entity of graph.all()) {
    if (entity.id === interaction.draggingId) continue;
    if (entity.docked) continue; // no controls/pad while parked in the dock — see ui/dock.ts
    if (entity.type === 'feature') continue; // drawn in its own pass below, anchored to its owner

    const bounds = effectiveBounds(graph, entity, drag);
    const drawAt =
      dragDelta && draggedSubtreeIds.has(entity.id)
        ? { ...bounds, x: bounds.x + dragDelta.x, y: bounds.y + dragDelta.y }
        : bounds;
    drawControls(ctx, graph, entity, drawAt, interaction);
    drawPad(ctx, entity, drawAt, interaction, now);
  }

  // Internal-feature organelles (ui/organelle.ts) — a porthole inset in the
  // owner's box while collapsed, or a popup floating over the canvas while
  // expanded. Skipped, same as controls/pads above, while the owner itself
  // is mid-drag (nothing about a dragged entity renders inline while it's
  // flying) or docked (nothing to anchor to).
  for (const feature of graph.all()) {
    if (feature.type !== 'feature') continue;
    const owner = feature.ownerId ? graph.get(feature.ownerId) : undefined;
    if (!owner || owner.docked || owner.id === interaction.draggingId) continue;

    if (feature.expanded) {
      if (feature.kind === 'melody') {
        // A live horizontal item drag (ui/interaction.ts's melodyPress)
        // renders that one item at the raw pointer x rather than its
        // snapped slot — see ui/melody.ts's MelodyDragOverride for why. If
        // the pointer is hovering a same-pitch note (mergeTarget), that
        // note has frozen in place instead of reordering (reorderDuringDrag),
        // so the dragged item's own visual snaps onto ITS position instead
        // of the raw pointer — reading as "sitting on top of" the target.
        const press = interaction.melodyPress;
        let dragOverride: { item: MelodyItem; x: number } | null = null;
        if (press && press.entityId === feature.id && press.dragging && press.axis === 'x') {
          const x = press.mergeTarget
            ? (itemScreenX(graph, feature.id, press.mergeTarget, drag) ?? press.currentPointer.x)
            : press.currentPointer.x;
          dragOverride = { item: press.item, x };
        }
        drawMelodyPopup(ctx, graph, feature, owner, dragOverride, drag);
      } else if (feature.kind === 'sampler') {
        drawSamplerPopup(ctx, graph, feature, owner, canvas, now, drag);
      } else {
        const activeHandle =
          interaction.draggingHandle?.entityId === feature.id ? interaction.draggingHandle.handle : null;
        const draggingAxis = interaction.draggingTimeAxis?.entityId === feature.id;
        drawPopup(ctx, graph, feature, owner, formatControlValue, activeHandle, draggingAxis, now, drag);
      }
    } else {
      drawPorthole(ctx, graph, feature, owner, drag);
    }
  }

  // A wash over everything drawn on the canvas so far (entities, wires,
  // controls, popups) — but before the dock HUD below, so the dock (whose
  // icons have no x/y position for this mapping to mean anything about)
  // stays unwashed and fully legible.
  drawMixModificationOverlay(ctx, canvas);

  // A fixed HUD panel pinned to the viewport's right edge (see ui/dock.ts),
  // not part of the scrollable canvas content, so it always sits in front
  // regardless of what's been scrolled underneath it.
  drawDock(ctx, canvas, graph, interaction, now);

  // Absolute topmost, over the dock included — the texture crop/target
  // editor (ui/textureEditor.ts) is effectively modal while open, so it
  // draws in front of everything else on the page.
  drawTextureEditor(ctx, canvas, graph);

  endSamplerFrame();
}

function drawDraggedSubtree(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  delta: { x: number; y: number },
  depth: number,
  isRoot: boolean,
  drag: DragContext | undefined
): void {
  const bounds = effectiveBounds(graph, entity, drag);
  const scale = isRoot ? 1.06 : 1;
  drawBox(
    ctx,
    entity,
    bounds.x + delta.x,
    bounds.y + delta.y,
    bounds.width * scale,
    bounds.height * scale,
    depth,
    { selected: isRoot, dropTarget: false, lifted: isRoot }
  );
  for (const child of graph.childrenOf(entity.id)) {
    drawDraggedSubtree(ctx, graph, child, delta, depth + 1, false, drag);
  }
}
