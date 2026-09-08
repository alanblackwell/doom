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
import { PROCESSOR_KINDS } from '../audio/graph';
import type { InteractionState } from './interaction';
import type { Point, Rect } from './layout';
import { KIND_COLORS, DEFAULT_COLOR, ACCENT, shadeColor } from './palette';

const COLUMN_WIDTH = 96; // one column's worth of panel width, same as the old fixed DOCK_WIDTH
const DOCK_TOP_PADDING = 60; // room for the "DOCK" label + the "show all" toggle row above the first icon
const DOCK_BOTTOM_PADDING = 12;
const ICON_WIDTH = 56;
const ICON_HEIGHT = 34;
const ICON_GAP = 16;

// Kinds hidden from the dock by default (still fully functional if dragged
// out via "show all" — this only affects which icons are visible while
// docked, nothing about the kind itself). A brand-new kind is NEVER added
// here automatically — it shows by default the moment it's added anywhere
// else in the app (ui/main.ts) — this set only grows when explicitly told
// to demote a specific kind, same as ui/doomLever.ts's own
// DOOM_LEVER_PITCH_TARGETS is hand-maintained rather than derived.
export const LESS_USED_KINDS = new Set(['fuzz', 'flanger', 'growl', 'metal']);

// The "show all" toggle row, just below the "DOCK" label — always at the
// dock panel's own top, spanning its current width (whichever column count
// that currently is) so it stays hit-testable/visible regardless of how
// many columns are showing.
const TOGGLE_ROW_HEIGHT = 16;
const TOGGLE_ROW_Y_OFFSET = 26; // from the panel's own top

export function dockShowAllToggleRect(canvas: HTMLCanvasElement, entityCount: number): Rect {
  const panel = dockPanelRect(canvas, entityCount);
  const top = panel.y - panel.height / 2;
  return {
    x: panel.x,
    y: top + TOGGLE_ROW_Y_OFFSET + TOGGLE_ROW_HEIGHT / 2,
    width: panel.width,
    height: TOGGLE_ROW_HEIGHT,
  };
}

export function isOverDockShowAllToggle(canvas: HTMLCanvasElement, entityCount: number, point: Point): boolean {
  const rect = dockShowAllToggleRect(canvas, entityCount);
  const left = rect.x - rect.width / 2;
  const top = rect.y - rect.height / 2;
  return point.x >= left && point.x <= left + rect.width && point.y >= top && point.y <= top + rect.height;
}

// How many icons fit in one column of a dock this tall. Always at least 1 —
// a viewport too short to fit even one icon still shows one, just clipped,
// rather than dividing by a non-positive row count below.
function maxRowsFor(viewportHeight: number): number {
  const available = viewportHeight - DOCK_TOP_PADDING - DOCK_BOTTOM_PADDING;
  return Math.max(1, Math.floor((available + ICON_GAP) / (ICON_HEIGHT + ICON_GAP)));
}

// Two columns only: once the second column's rows are exhausted too, later
// icons overflow past the bottom rather than starting a third column — same
// as a single column silently overflowing today, just delayed.
function columnsFor(entityCount: number, viewportHeight: number): number {
  return entityCount > maxRowsFor(viewportHeight) ? 2 : 1;
}

// The viewport is canvas's own parent (see index.html) — reading its
// scroll position directly rather than threading it through renderFrame's
// signature, since nothing else needs it. scrollLeft/scrollTop map 1:1 onto
// canvas pixel coordinates (the canvas isn't CSS-scaled), so this rect is
// already in the same coordinate space as every entity's x/y.
function viewportEl(canvas: HTMLCanvasElement): HTMLElement {
  return canvas.parentElement as HTMLElement;
}

// Center-based, matching layout.ts's Rect convention. Widens to two columns
// once there are more docked entities than fit in one column at this
// viewport's height (see columnsFor) — entityCount is the caller's current
// dockedEntities().length.
export function dockPanelRect(canvas: HTMLCanvasElement, entityCount: number): Rect {
  const viewport = viewportEl(canvas);
  const width = COLUMN_WIDTH * columnsFor(entityCount, viewport.clientHeight);
  const left = viewport.scrollLeft + viewport.clientWidth - width;
  const top = viewport.scrollTop;
  return {
    x: left + width / 2,
    y: top + viewport.clientHeight / 2,
    width,
    height: viewport.clientHeight,
  };
}

// Docked entities actually shown right now — every less-used-kind entity
// filtered out unless showAll is on. Shared by drawing, hit-testing, and
// panel sizing so all three always agree on what's actually visible.
export function shownDockedEntities(graph: EntityGraph, showAll: boolean): Entity[] {
  const all = graph.dockedEntities();
  return showAll ? all : all.filter((e) => !LESS_USED_KINDS.has(e.kind));
}

export function isOverDock(canvas: HTMLCanvasElement, graph: EntityGraph, point: Point, showAll: boolean): boolean {
  const panel = dockPanelRect(canvas, shownDockedEntities(graph, showAll).length);
  const left = panel.x - panel.width / 2;
  const top = panel.y - panel.height / 2;
  return (
    point.x >= left && point.x <= left + panel.width && point.y >= top && point.y <= top + panel.height
  );
}

// Stacked vertically within each column, in graph insertion order — no
// reordering-by-drag support, dropping a docked icon back into the dock is
// just a no-op (see ui/docking.ts). Fills the rightmost column (the one
// pinned to the viewport edge) top-to-bottom first, then flows overflow
// into a second column that expands the panel leftward, so the icons
// nearest the edge never shift position as more get docked.
function dockIconRect(canvas: HTMLCanvasElement, index: number, entityCount: number): Rect {
  const panel = dockPanelRect(canvas, entityCount);
  const top = panel.y - panel.height / 2;
  const left = panel.x - panel.width / 2;
  const rows = maxRowsFor(panel.height);
  const totalColumns = panel.width / COLUMN_WIDTH;
  const columnFromRight = Math.floor(index / rows);
  const column = totalColumns - 1 - columnFromRight;
  const row = index % rows;
  return {
    x: left + column * COLUMN_WIDTH + COLUMN_WIDTH / 2,
    y: top + DOCK_TOP_PADDING + row * (ICON_HEIGHT + ICON_GAP) + ICON_HEIGHT / 2,
    width: ICON_WIDTH,
    height: ICON_HEIGHT,
  };
}

// Entities currently drawn as icons — shownDockedEntities, minus whichever
// one (if any) is actively being dragged out, since that one's drawn
// full-size via the normal drag-overlay path instead (see ui/render.ts's
// drawDraggedSubtree).
function visibleDockedEntities(graph: EntityGraph, interaction: InteractionState): Entity[] {
  return shownDockedEntities(graph, interaction.dockShowAll).filter((e) => e.id !== interaction.draggingId);
}

export function hitTestDockIcon(
  graph: EntityGraph,
  canvas: HTMLCanvasElement,
  point: Point,
  showAll: boolean
): Entity | null {
  const entities = shownDockedEntities(graph, showAll);
  for (let i = 0; i < entities.length; i++) {
    const rect = dockIconRect(canvas, i, entities.length);
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
  const allDocked = shownDockedEntities(graph, interaction.dockShowAll);
  const panel = dockPanelRect(canvas, allDocked.length);
  const left = panel.x - panel.width / 2;
  const top = panel.y - panel.height / 2;

  ctx.save();
  // Semi-transparent rather than near-opaque — the canvas background
  // texture (ui/render.ts's renderFrame, ui/textureEditor.ts) is already
  // drawn to fill the full drawing buffer before this, dock panel included,
  // so this reads as a dark scrim over that image rather than hiding it
  // behind a flat panel. Icons/text below are drawn after this fill, within
  // this same function, so they stay legible on top of it regardless.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
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

  // "Show all" toggle — a small checkbox + label row, right below the DOCK
  // label. Ticked reveals every LESS_USED_KINDS icon too (see that set's own
  // comment); unticked (the default) hides them, same idea as a DAW's own
  // "hide unused tracks" toggle.
  const toggleRect = dockShowAllToggleRect(canvas, allDocked.length);
  const boxSize = 10;
  const boxX = toggleRect.x - toggleRect.width / 2 + 14;
  const boxY = toggleRect.y;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX - boxSize / 2, boxY - boxSize / 2, boxSize, boxSize);
  if (interaction.dockShowAll) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(boxX - boxSize / 2 + 2, boxY - boxSize / 2 + 2, boxSize - 4, boxSize - 4);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('show all', boxX + boxSize / 2 + 6, boxY + 1);

  const entities = visibleDockedEntities(graph, interaction);
  for (const entity of entities) {
    const index = allDocked.indexOf(entity);
    const rect = dockIconRect(canvas, index, allDocked.length);
    drawDockIcon(ctx, entity, rect, entity.id === interaction.selectedId);
  }

  ctx.restore();
}

function drawDockIcon(ctx: CanvasRenderingContext2D, entity: Entity, rect: Rect, selected: boolean): void {
  const baseColor = KIND_COLORS[entity.kind] ?? DEFAULT_COLOR;
  const left = rect.x - rect.width / 2;
  const top = rect.y - rect.height / 2;

  ctx.save();
  // A filter/pedal (PROCESSOR_KINDS, audio/graph.ts — overdrive/growl/
  // vocode/...) has no sound of its own, only whatever's routed through
  // it, so it's drawn "open" — a colored border with a translucent-black
  // fill (not the kind's own solid color) — rather than as a solid block
  // like a sound source, the same "empty until something's dropped in"
  // distinction ui/render.ts's own box drawing already makes for these on
  // the main canvas, just carried into the dock's own iconography.
  if (PROCESSOR_KINDS.has(entity.kind)) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; // not the kind's own hue — deliberately dark enough that white label text stays legible over any background image
    ctx.fillRect(left, top, rect.width, rect.height);
    ctx.strokeStyle = selected ? ACCENT : baseColor;
    ctx.lineWidth = selected ? 2 : 1.5;
    ctx.strokeRect(left, top, rect.width, rect.height);
  } else {
    ctx.fillStyle = shadeColor(baseColor, 0.85);
    ctx.fillRect(left, top, rect.width, rect.height);
    ctx.strokeStyle = selected ? ACCENT : 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(left, top, rect.width, rect.height);
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.kind, rect.x, rect.y);
  ctx.restore();
}
