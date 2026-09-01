// Canvas2D rendering of the entity graph. Procedural (noise-jittered path,
// gradient fill) rather than bitmap textures for now — ARCHITECTURE.md §4.1's
// grunge texture assets don't exist yet (textures/ is empty); this gets an
// organic, non-clinical silhouette without depending on them, and can be
// swapped for pattern fills later without touching the containment/hit-test
// logic in layout.ts.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { PROCESSOR_KINDS } from '../audio/graph';
import { absolutePosition, effectiveBounds } from './layout';
import type { DragContext, Rect } from './layout';
import type { InteractionState } from './interaction';
import { controlsFor, dotPosition, trackGeometry, valueFraction, CONTROL_DOT_RADIUS } from './controls';

const KIND_COLORS: Record<string, string> = {
  noise: '#4a4a4a',
  bass: '#5b3a24',
  bow: '#6b4630',
  overdrive: '#8a5a1c',
  reverb: '#2f4a52',
};
const DEFAULT_COLOR = '#3a3a3a';
const ACCENT = '#c98a3c'; // selection / drop-target accent — warm, reads against the dark palette
const PROCESSOR_ACCENT = '#e0a840'; // sink+source marker — brighter than the selection accent, always visible

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

  drawBox(ctx, entity, bounds.x, bounds.y, bounds.width * scale, bounds.height * scale, depth, {
    selected: entity.id === interaction.selectedId,
    dropTarget: entity.id === interaction.hoverTargetId,
    lifted: false,
  });

  drawControls(ctx, entity, bounds, interaction);

  for (const child of graph.childrenOf(entity.id)) {
    drawEntity(ctx, graph, child, depth + 1, interaction, now, drag);
  }
}

// Quiet-by-default per-parameter control dots (see ui/controls.ts): a small
// resting dot per param, morphing into a labeled vertical slider on hover —
// positioned so the point representing the current value lands exactly
// where the dot was, so the cursor is already on the thumb.
function drawControls(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  bounds: Rect,
  interaction: InteractionState
): void {
  const specs = controlsFor(entity.kind);
  if (specs.length === 0) return;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const dot = dotPosition(bounds, i);
    const isHovering = interaction.hoverControl?.entityId === entity.id && interaction.hoverControl.param === spec.param;
    const dragging = interaction.draggingControl?.entityId === entity.id && interaction.draggingControl.spec.param === spec.param;

    if (!isHovering && !dragging) {
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, CONTROL_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = spec.color;
      ctx.fill();
      continue;
    }

    const currentValue = entity.params[spec.param] ?? spec.min;
    // While actively dragging, use the FIXED track captured at drag-start —
    // recomputing it from the live (constantly-changing) value would make
    // the mapping chase itself instead of tracking the pointer smoothly.
    const track = dragging ? interaction.draggingControl!.track : trackGeometry(dot, spec, currentValue);

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

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.label, track.x - 12, track.top - 6);
    ctx.restore();
  }
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

  // Sink+source ("pedal"/filter) marker: an IN -> OUT arrow across the box,
  // so processing entities read differently from plain sources/mixers at a
  // glance — dropping something in here means "route through," not "mix."
  if (PROCESSOR_KINDS.has(entity.kind)) {
    ctx.strokeStyle = PROCESSOR_ACCENT;
    ctx.fillStyle = PROCESSOR_ACCENT;
    ctx.lineWidth = 1.5;
    const arrowY = y + h * 0.28;
    const left = x - w * 0.32;
    const right = x + w * 0.32;
    ctx.beginPath();
    ctx.moveTo(left, arrowY);
    ctx.lineTo(right, arrowY);
    ctx.moveTo(right - 6, arrowY - 5);
    ctx.lineTo(right, arrowY);
    ctx.lineTo(right - 6, arrowY + 5);
    ctx.stroke();
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('IN', left, arrowY - 8);
    ctx.textAlign = 'right';
    ctx.fillText('OUT', right, arrowY - 8);
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = '13px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${entity.id}`, x, y - 6);
  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText(`(${entity.kind})`, x, y + 10);

  ctx.restore();
}

function shadeColor(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((n & 0xff) * factor));
  return `rgb(${r}, ${g}, ${b})`;
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  graph: EntityGraph,
  interaction: InteractionState,
  now: number
): void {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

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
  if (interaction.draggingId && interaction.dragPointer) {
    const entity = graph.get(interaction.draggingId);
    if (entity) {
      const original = absolutePosition(graph, entity);
      const delta = {
        x: interaction.dragPointer.x - original.x,
        y: interaction.dragPointer.y - original.y,
      };
      drawDraggedSubtree(ctx, graph, entity, delta, 0, true, drag);
    }
  }
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
