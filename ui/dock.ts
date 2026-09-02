// The instrument dock: a fixed panel pinned to the right edge of the
// *viewport*, not the scrollable canvas content — it stays put as you
// scroll, like index.html's #start-audio button, except drawn on the same
// canvas (rather than a separate DOM element) so it can share hit-testing
// and drag machinery with everything else in ui/interaction.ts. Holds
// docked instruments (Entity.docked, see audio/entityGraph.ts) as small
// inert icons — no controls, no sound (ui/docking.ts handles the
// audio/graph-structure side of dock/undock; this module is pure
// geometry/rendering, parallel to controlSpecs.ts/pads.ts/knobs.ts).

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { InteractionState } from './interaction';
import type { Point, Rect } from './layout';
import { KIND_COLORS, DEFAULT_COLOR, ACCENT, shadeColor } from './palette';

export const DOCK_WIDTH = 96;
const DOCK_TOP_PADDING = 44; // room for the "DOCK" label above the first icon
const ICON_WIDTH = 56;
const ICON_HEIGHT = 34;
const ICON_GAP = 16;

// The viewport is canvas's own parent (see index.html) — reading its
// scroll position directly rather than threading it through renderFrame's
// signature, since nothing else needs it. scrollLeft/scrollTop map 1:1 onto
// canvas pixel coordinates (the canvas isn't CSS-scaled), so this rect is
// already in the same coordinate space as every entity's x/y.
function viewportEl(canvas: HTMLCanvasElement): HTMLElement {
  return canvas.parentElement as HTMLElement;
}

// Center-based, matching layout.ts's Rect convention.
export function dockPanelRect(canvas: HTMLCanvasElement): Rect {
  const viewport = viewportEl(canvas);
  const left = viewport.scrollLeft + viewport.clientWidth - DOCK_WIDTH;
  const top = viewport.scrollTop;
  return {
    x: left + DOCK_WIDTH / 2,
    y: top + viewport.clientHeight / 2,
    width: DOCK_WIDTH,
    height: viewport.clientHeight,
  };
}

export function isOverDock(canvas: HTMLCanvasElement, point: Point): boolean {
  const panel = dockPanelRect(canvas);
  const left = panel.x - panel.width / 2;
  const top = panel.y - panel.height / 2;
  return (
    point.x >= left && point.x <= left + panel.width && point.y >= top && point.y <= top + panel.height
  );
}

// Stacked vertically from the panel's top, in graph insertion order — no
// reordering-by-drag support, dropping a docked icon back into the dock is
// just a no-op (see ui/docking.ts).
function dockIconRect(canvas: HTMLCanvasElement, index: number): Rect {
  const panel = dockPanelRect(canvas);
  const top = panel.y - panel.height / 2;
  return {
    x: panel.x,
    y: top + DOCK_TOP_PADDING + index * (ICON_HEIGHT + ICON_GAP) + ICON_HEIGHT / 2,
    width: ICON_WIDTH,
    height: ICON_HEIGHT,
  };
}

// Entities currently shown in the dock — excludes whichever one (if any) is
// actively being dragged out, since that one's drawn full-size via the
// normal drag-overlay path instead (see ui/render.ts's drawDraggedSubtree).
function visibleDockedEntities(graph: EntityGraph, interaction: InteractionState): Entity[] {
  return graph.dockedEntities().filter((e) => e.id !== interaction.draggingId);
}

export function hitTestDockIcon(
  graph: EntityGraph,
  canvas: HTMLCanvasElement,
  point: Point
): Entity | null {
  const entities = graph.dockedEntities();
  for (let i = 0; i < entities.length; i++) {
    const rect = dockIconRect(canvas, i);
    const left = rect.x - rect.width / 2;
    const top = rect.y - rect.height / 2;
    if (point.x >= left && point.x <= left + rect.width && point.y >= top && point.y <= top + rect.height) {
      return entities[i];
    }
  }
  return null;
}

export function drawDock(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  graph: EntityGraph,
  interaction: InteractionState,
  now: number
): void {
  const panel = dockPanelRect(canvas);
  const left = panel.x - panel.width / 2;
  const top = panel.y - panel.height / 2;

  ctx.save();
  ctx.fillStyle = 'rgba(24, 24, 24, 0.95)';
  ctx.fillRect(left, top, panel.width, panel.height);
  ctx.strokeStyle = interaction.hoverDock ? ACCENT : 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = interaction.hoverDock ? 2.5 : 1;
  if (interaction.hoverDock) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, top + panel.height);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('DOCK', panel.x, top + 24);

  const entities = visibleDockedEntities(graph, interaction);
  const allDocked = graph.dockedEntities();
  for (const entity of entities) {
    const index = allDocked.indexOf(entity);
    const rect = dockIconRect(canvas, index);
    drawDockIcon(ctx, entity, rect, entity.id === interaction.selectedId);
  }

  ctx.restore();
}

function drawDockIcon(ctx: CanvasRenderingContext2D, entity: Entity, rect: Rect, selected: boolean): void {
  const baseColor = KIND_COLORS[entity.kind] ?? DEFAULT_COLOR;
  const left = rect.x - rect.width / 2;
  const top = rect.y - rect.height / 2;

  ctx.save();
  ctx.fillStyle = shadeColor(baseColor, 0.85);
  ctx.fillRect(left, top, rect.width, rect.height);
  ctx.strokeStyle = selected ? ACCENT : 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(left, top, rect.width, rect.height);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.kind, rect.x, rect.y);
  ctx.restore();
}
