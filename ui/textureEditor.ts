// Drag an image file from the desktop onto the canvas to customize the
// UI's own visuals: crop/pan/zoom it interactively, pick which component
// it textures (an entity kind, or the whole canvas by default), then save
// or cancel. Deliberately its own module and its own independent set of
// canvas pointer/wheel listeners, parallel to ui/sampleDrop.ts — while this
// editor is open it's effectively modal, so ui/interaction.ts's own
// pointer handlers each guard on isTextureEditorActive() and no-op
// entirely rather than this module fighting them for the same events.
//
// Coordinate model: the crop rectangle lives in canvas-content screen
// space (the same space as entity.x/y, dragPointer, etc — see layout.ts).
// What's framed inside it is described independently, in the source
// IMAGE's own pixel space: imageCenterX/Y is the image pixel that maps to
// the crop rect's center, and imageScale is editor-pixels-per-image-pixel
// (its zoom). Panning adjusts imageCenterX/Y; the wheel adjusts imageScale;
// resize handles adjust the crop rect itself (aspect-locked to whatever
// the current target is). Saving converts all of that into one resolution-
// independent TextureSourceRect (see ui/textures.ts) — the actual image-
// pixel crop window — so ui/render.ts never needs to know any of this
// editor-space math.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { effectiveBounds, hitTest } from './layout';
import type { Point, Rect } from './layout';
import { viewportSize } from './stereoMix';
import { drawAdjustedTexture, setTexture, DEFAULT_ADJUSTMENTS } from './textures';
import type { TextureAdjustments, TextureTarget } from './textures';
import { ACCENT } from './palette';
import { defaultCopyright } from './attribution';

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';
// Excludes hueEnabled — a boolean toggle, not a slider value (see the
// dedicated hue-toggle handle/render code, separate from the 4 sliders).
type AdjustParam = Exclude<keyof TextureAdjustments, 'hueEnabled'>;

type EditorDrag =
  | { kind: 'pan'; startPointer: Point; startCenterX: number; startCenterY: number }
  | { kind: 'move'; startPointer: Point; startRect: Rect }
  | { kind: 'resize'; handle: ResizeHandle; startRect: Rect }
  | { kind: 'scale'; startPointer: Point; startScale: number; pointer: Point }
  | { kind: 'target'; pointer: Point }
  | { kind: 'adjust'; param: AdjustParam };

interface EditorState {
  image: HTMLImageElement;
  objectUrl: string;
  fileName: string; // original dropped filename — carried into the saved SavedTexture (ui/textures.ts)
  fileBytes: Uint8Array; // original file bytes, likewise
  copyright: string; // defaulted once at drop time (ui/attribution.ts), fixed for this editor session
  cropRect: Rect; // editor/screen space, center-based (see layout.ts's Rect)
  aspect: number; // width/height currently locked to — see retarget()
  target: TextureTarget;
  imageCenterX: number;
  imageCenterY: number;
  imageScale: number; // editor-pixels per image-pixel
  adjustments: TextureAdjustments; // brightness/hue/saturation/opacity — see the 4 side sliders
  drag: EditorDrag | null;
  hoverTargetEntityId: string | null; // live preview while dragging the target handle
  // Absolute canvas position the reticle rests at once a specific entity's
  // been targeted — that entity's own center — so it stays put there
  // rather than snapping back to the crop rect's center after a selection.
  // null for the default 'canvas' target (nothing specific to point at),
  // in which case the crop rect's center is used instead — see
  // targetHandlePosition.
  targetAnchor: Point | null;
}

let state: EditorState | null = null;

export function isTextureEditorActive(): boolean {
  return state !== null;
}

const MIN_CROP_SIZE = 60; // px, editor space
const HANDLE_SIZE = 10;
const HANDLE_HIT_RADIUS = HANDLE_SIZE / 2 + 5;
// Band straddling each edge of the crop rect (half inside, half outside)
// that grabs-and-moves the whole rect rather than panning the image or
// resizing — "the sides," excluding the corner handles (checked first, so
// they still win right at a corner) and the deeper interior (still pan).
const MOVE_BORDER_WIDTH = 16;
const TARGET_HANDLE_RADIUS = 10;
const SCALE_HANDLE_RADIUS = 9;
const ICON_SIZE = 20;
const ICON_GAP = 8;
const ICON_ROW_OFFSET = 20; // above the crop rect's top edge
// Translucent, not opaque — lets whatever's underneath (a potential target
// entity included) stay visible through the preview, since the target
// handle now rests at the rect's own center rather than outside it.
const IMAGE_PREVIEW_ALPHA = 0.6;

// The four side sliders (subtle, no text — see drawAdjustSlider): opacity
// above brightness on the left, saturation above hue on the right. 1
// (100%) is "unchanged" for brightness/saturation, matching
// ui/textures.ts's applyAdjustments (which implements them by hand, not
// via CanvasRenderingContext2D.filter — see its own comment for why). hue
// is degrees (0-359) selecting which color the hue-boost favors — see
// ui/textures.ts's boostSaturationTowardHue; it has no "unchanged" value,
// since every hue selects some color to favor.
const ADJUST_RANGES: Record<AdjustParam, { min: number; max: number }> = {
  opacity: { min: 0, max: 1 },
  brightness: { min: 0, max: 2 },
  saturation: { min: 0, max: 2 },
  hue: { min: 0, max: 359 },
};
const ADJUST_TRACK_LENGTH = 56; // px, editor space
const ADJUST_TRACK_GAP = 16; // between the two stacked sliders on one side
const ADJUST_TRACK_OUTSET = 18; // outward from the crop rect's edge
const ADJUST_DOT_RADIUS = 4; // the top/bottom end-icon dots
const ADJUST_THUMB_RADIUS = 4.5; // the draggable value indicator
const ADJUST_HIT_HALF_WIDTH = 10; // horizontal grab tolerance around each track

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cropBounds(rect: Rect): { left: number; top: number; right: number; bottom: number } {
  return {
    left: rect.x - rect.width / 2,
    top: rect.y - rect.height / 2,
    right: rect.x + rect.width / 2,
    bottom: rect.y + rect.height / 2,
  };
}

export function handlePosition(rect: Rect, handle: ResizeHandle): Point {
  const b = cropBounds(rect);
  switch (handle) {
    case 'nw':
      return { x: b.left, y: b.top };
    case 'ne':
      return { x: b.right, y: b.top };
    case 'sw':
      return { x: b.left, y: b.bottom };
    case 'se':
      return { x: b.right, y: b.bottom };
  }
}

// Where the target reticle currently rests. Three cases:
//  - actively being dragged: the live pointer position, so it visibly
//    tracks the cursor instead of only jumping between candidate centers
//    (the dashed hover-highlight already shows which entity would be
//    picked — this is just the handle itself moving smoothly under the
//    pointer, the way any other drag handle in this editor does).
//  - a specific entity's been targeted (state.targetAnchor): that entity's
//    own center, so it stays there marking what's targeted rather than
//    snapping back once the drag ends.
//  - otherwise (target === 'canvas', or right when the editor first
//    opens): the crop rect's own center.
function targetHandlePosition(): Point {
  if (!state) return { x: 0, y: 0 }; // unreachable — only called while state is set
  if (state.drag?.kind === 'target') return state.drag.pointer;
  return state.targetAnchor ?? { x: state.cropRect.x, y: state.cropRect.y };
}

// Top-left of the crop rect, to the left of the "target: <kind>" label
// (see drawTextureEditor) — a fixed offset from the crop bounds, unlike
// the target reticle above, since scaling is always relative to the crop
// window itself rather than to whatever's targeted.
export function scaleHandlePosition(rect: Rect): Point {
  const b = cropBounds(rect);
  return { x: b.left + SCALE_HANDLE_RADIUS + 3, y: b.top - ICON_ROW_OFFSET };
}

// Whether `point` is within the grab band straddling one of the crop
// rect's four edges — "the sides," for moving the whole rect. Deliberately
// generous (extends slightly outside the rect too, like the corner
// handles' own hit radius), but still requires being roughly within the
// rect's own footprint first so it doesn't swallow clicks out in the
// dimmed scrim beyond it.
function isOnCropBorder(rect: Rect, point: Point): boolean {
  const b = cropBounds(rect);
  const half = MOVE_BORDER_WIDTH / 2;
  if (point.x < b.left - half || point.x > b.right + half) return false;
  if (point.y < b.top - half || point.y > b.bottom + half) return false;
  const distLeft = Math.abs(point.x - b.left);
  const distRight = Math.abs(point.x - b.right);
  const distTop = Math.abs(point.y - b.top);
  const distBottom = Math.abs(point.y - b.bottom);
  return Math.min(distLeft, distRight, distTop, distBottom) <= half;
}

interface AdjustTrack {
  param: AdjustParam;
  x: number;
  top: number;
  bottom: number; // top is always the MAX end (see valueFromAdjustY), bottom the MIN
}

// The four slider tracks' geometry — opacity above brightness on the left
// (poking left of the crop rect), saturation above hue on the right,
// each pair stacked around the rect's own vertical center. Fixed pixel
// sizing (not proportional to the rect), matching every other handle in
// this editor — a slider stays a consistent, grabbable size regardless of
// how small or large the crop rect currently is.
function adjustTracks(rect: Rect): AdjustTrack[] {
  const b = cropBounds(rect);
  const half = ADJUST_TRACK_LENGTH + ADJUST_TRACK_GAP / 2;
  const upper = { top: rect.y - half, bottom: rect.y - ADJUST_TRACK_GAP / 2 };
  const lower = { top: rect.y + ADJUST_TRACK_GAP / 2, bottom: rect.y + half };
  const leftX = b.left - ADJUST_TRACK_OUTSET;
  const rightX = b.right + ADJUST_TRACK_OUTSET;
  return [
    { param: 'opacity', x: leftX, ...upper },
    { param: 'brightness', x: leftX, ...lower },
    { param: 'saturation', x: rightX, ...upper },
    { param: 'hue', x: rightX, ...lower },
  ];
}

function hitTestAdjustTrack(rect: Rect, point: Point): AdjustTrack | null {
  for (const track of adjustTracks(rect)) {
    if (
      Math.abs(point.x - track.x) <= ADJUST_HIT_HALF_WIDTH &&
      point.y >= track.top - ADJUST_DOT_RADIUS - 2 &&
      point.y <= track.bottom + ADJUST_DOT_RADIUS + 2
    ) {
      return track;
    }
  }
  return null;
}

// Sits in the gap between the saturation and hue tracks (both on the
// right, at the same x) — exactly the rect's own vertical center, matching
// how far each track's own near edge already sits from center (half the
// gap), so it doesn't crowd either one.
function hueTogglePosition(rect: Rect): Point {
  const b = cropBounds(rect);
  return { x: b.right + ADJUST_TRACK_OUTSET, y: rect.y };
}

const HUE_TOGGLE_RADIUS = 5;

function isOnHueToggle(rect: Rect, point: Point): boolean {
  const p = hueTogglePosition(rect);
  return Math.hypot(point.x - p.x, point.y - p.y) <= HUE_TOGGLE_RADIUS + 4;
}

// Top of the track is the MAX value, bottom is MIN — matching this app's
// established "up = more" convention (ui/stereoMix.ts's volume mapping,
// the scale handle's up-zooms-in) — clicking/dragging anywhere on the
// track jumps the value straight to that position, the same
// click-to-set-not-just-drag-the-thumb convention as the entity control-
// dot sliders elsewhere (ui/controls.ts).
function valueFromAdjustY(track: AdjustTrack, y: number, param: AdjustParam): number {
  const { min, max } = ADJUST_RANGES[param];
  const fraction = clamp((track.bottom - y) / (track.bottom - track.top), 0, 1);
  return min + fraction * (max - min);
}

function adjustThumbY(track: AdjustTrack, value: number, param: AdjustParam): number {
  const { min, max } = ADJUST_RANGES[param];
  const fraction = clamp((value - min) / (max - min), 0, 1);
  return track.bottom - fraction * (track.bottom - track.top);
}

// "Just above the top right of the crop rectangle" — cancel then save,
// right-aligned to the crop rect's own right edge.
export function saveCancelPositions(rect: Rect): { save: Point; cancel: Point } {
  const b = cropBounds(rect);
  const y = b.top - ICON_ROW_OFFSET;
  return {
    save: { x: b.right - ICON_SIZE / 2, y },
    cancel: { x: b.right - ICON_SIZE * 1.5 - ICON_GAP, y },
  };
}

// The larger of the two axis ratios — the minimum zoom at which the crop
// rect is still fully covered by image content on both axes (like CSS
// `background-size: cover`), so panning/resizing can never open up a gap
// of empty transparency at the crop window's edge.
function coverScale(rect: Rect, image: HTMLImageElement): number {
  return Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
}

// Keeps the crop window fully covered by image content: clamps the zoom to
// never go below "just covering" (see coverScale), then — since that
// guarantees the framed source rect is no bigger than the image on either
// axis — clamps the pan center so that source rect can never extend past
// the image's own edges either. Called after every resize/pan/zoom change,
// since each can invalidate the other's previous clamping (e.g. shrinking
// the zoom needs a wider source rect, which may now push a previously-fine
// pan position out of bounds).
function clampToCoverage(): void {
  if (!state) return;
  const minScale = coverScale(state.cropRect, state.image);
  state.imageScale = clamp(state.imageScale, minScale, minScale * 12);

  const halfSrcW = state.cropRect.width / state.imageScale / 2;
  const halfSrcH = state.cropRect.height / state.imageScale / 2;
  state.imageCenterX = clamp(state.imageCenterX, halfSrcW, state.image.naturalWidth - halfSrcW);
  state.imageCenterY = clamp(state.imageCenterY, halfSrcH, state.image.naturalHeight - halfSrcH);
}

// Opens the editor for a freshly-decoded dropped image. If the drop lands
// directly on an entity's box, it's targeted immediately (same rule as
// dragging the target handle onto it by hand afterward — see
// targetAndAspectFor/applyHoverTarget), with the crop rect matching that
// entity's own on-screen footprint and centered on it, reticle included —
// no extra retargeting step needed. Otherwise it falls back to the
// previous behavior: the default 'canvas' target, the canvas's own
// (viewport) aspect ratio, centered exactly on the drop point. Either way,
// if a rect of the desired size centered there would extend past the
// visible viewport on any side, it's shrunk (preserving aspect, still
// centered on the same point) until it fits entirely within view — the
// image's own zoom (coverScale) is derived from the crop rect's final
// size, so it scales down to match automatically.
export function openTextureEditor(
  canvas: HTMLCanvasElement,
  graph: EntityGraph,
  image: HTMLImageElement,
  objectUrl: string,
  dropPoint: Point,
  fileName: string,
  fileBytes: Uint8Array
): void {
  const viewport = canvas.parentElement as HTMLElement;
  const { width: vw, height: vh } = viewportSize(canvas);

  const hitEntity = hitTest(graph, dropPoint, new Set());
  const { target, aspect, anchor } = targetAndAspectFor(canvas, graph, hitEntity);
  const center = anchor ?? dropPoint;
  const targetEntityId = anchor && hitEntity ? hitEntity.id : null;
  const entityBounds = targetEntityId ? effectiveBounds(graph, hitEntity!) : null;

  const desiredHeight = entityBounds
    ? Math.max(MIN_CROP_SIZE, entityBounds.height)
    : Math.max(MIN_CROP_SIZE, Math.min(vw, vh) * 0.5);
  const desiredWidth = desiredHeight * aspect;

  // Distance from the crop rect's intended center to the nearest viewport
  // edge on each axis — the limiting factor for how big a rect centered
  // there can be without spilling past that edge. A drop always lands
  // within the visible viewport (it's wherever the cursor was), and a hit
  // entity's own center is necessarily on-screen too, so both distances
  // are always >= 0.
  const viewLeft = viewport.scrollLeft;
  const viewTop = viewport.scrollTop;
  const distX = Math.min(center.x - viewLeft, viewLeft + vw - center.x);
  const distY = Math.min(center.y - viewTop, viewTop + vh - center.y);
  const maxWidth = Math.min(2 * distX, 2 * aspect * distY);

  const width = Math.max(MIN_CROP_SIZE, Math.min(desiredWidth, maxWidth));
  const height = width / aspect;

  const cropRect: Rect = { x: center.x, y: center.y, width, height };

  state = {
    image,
    objectUrl,
    fileName,
    fileBytes,
    copyright: defaultCopyright(fileName),
    cropRect,
    aspect,
    target,
    imageCenterX: image.naturalWidth / 2,
    imageCenterY: image.naturalHeight / 2,
    imageScale: coverScale(cropRect, image),
    adjustments: { ...DEFAULT_ADJUSTMENTS },
    drag: null,
    hoverTargetEntityId: null,
    targetAnchor: anchor,
  };
}

function retarget(target: TextureTarget, aspect: number, anchor: Point | null): void {
  if (!state) return;
  state.target = target;
  state.aspect = aspect;
  state.targetAnchor = anchor;
  const height = state.cropRect.height;
  const width = Math.max(MIN_CROP_SIZE, height * aspect);
  state.cropRect = { ...state.cropRect, width };
  clampToCoverage();
}

// What retargeting to `hitEntity` (or nothing, i.e. the default canvas
// target) would mean — a pure lookup, no state mutation, so it can be used
// both for the live hover preview during a target-handle drag and to
// finalize on release without duplicating the branching.
//
// Uses effectiveBounds (ui/layout.ts), not the entity's raw width/height —
// a box's actual on-screen footprint is often larger (a reserved control-
// dot column, or padding grown to enclose nested children), and for a
// NESTED entity, raw x/y are relative to its parent rather than an absolute
// canvas position at all (see audio/entityGraph.ts's Entity comment).
// effectiveBounds resolves both, so this always matches what's actually
// drawn on screen — the same bounds hoverHighlightRect below outlines, and
// the same center the reticle then rests at (targetHandlePosition).
function targetAndAspectFor(
  canvas: HTMLCanvasElement,
  graph: EntityGraph,
  hitEntity: Entity | null
): { target: TextureTarget; aspect: number; anchor: Point | null } {
  if (hitEntity && hitEntity.type === 'source') {
    const bounds = effectiveBounds(graph, hitEntity);
    if (bounds.width > 0 && bounds.height > 0) {
      return { target: hitEntity.kind, aspect: bounds.width / bounds.height, anchor: { x: bounds.x, y: bounds.y } };
    }
  }
  const { width, height } = viewportSize(canvas);
  return { target: 'canvas', aspect: width > 0 && height > 0 ? width / height : 1, anchor: null };
}

// Re-targets live to whatever's under the target handle right now — called
// on every pointermove while dragging it, not just on release, so the crop
// rectangle's aspect visibly snaps to each candidate as it's dragged over,
// the same "see it happen as you drag" feedback ui/stereoMix.ts's live pan/
// volume preview already gives elsewhere in this app. This also means the
// reticle itself tracks onto each candidate's center as it's dragged over
// (targetHandlePosition), settling there for good once the drag ends on
// one, rather than only updating the dashed hover-highlight.
function applyHoverTarget(canvas: HTMLCanvasElement, graph: EntityGraph, point: Point): void {
  if (!state) return;
  const hit = hitTest(graph, point, new Set());
  state.hoverTargetEntityId = hit?.id ?? null;
  const { target, aspect, anchor } = targetAndAspectFor(canvas, graph, hit);
  retarget(target, aspect, anchor);
}

function closeEditor(): void {
  if (state) URL.revokeObjectURL(state.objectUrl);
  state = null;
}

function commitSave(): void {
  if (!state) return;
  const srcW = state.cropRect.width / state.imageScale;
  const srcH = state.cropRect.height / state.imageScale;
  setTexture(state.target, {
    image: state.image,
    sourceRect: {
      x: state.imageCenterX - srcW / 2,
      y: state.imageCenterY - srcH / 2,
      width: srcW,
      height: srcH,
    },
    adjustments: { ...state.adjustments },
    fileName: state.fileName,
    fileBytes: state.fileBytes,
    copyright: state.copyright,
  });
  closeEditor();
}

const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'ne', 'sw', 'se'];

function iconHit(center: Point, point: Point): boolean {
  const half = ICON_SIZE / 2 + 4;
  return Math.abs(point.x - center.x) <= half && Math.abs(point.y - center.y) <= half;
}

function onPointerDown(canvas: HTMLCanvasElement, graph: EntityGraph, point: Point): void {
  if (!state) return;

  const { save, cancel } = saveCancelPositions(state.cropRect);
  if (iconHit(save, point)) {
    commitSave();
    return;
  }
  if (iconHit(cancel, point)) {
    closeEditor();
    return;
  }

  for (const handle of RESIZE_HANDLES) {
    const hp = handlePosition(state.cropRect, handle);
    if (Math.hypot(point.x - hp.x, point.y - hp.y) <= HANDLE_HIT_RADIUS) {
      state.drag = { kind: 'resize', handle, startRect: { ...state.cropRect } };
      return;
    }
  }

  const th = targetHandlePosition();
  if (Math.hypot(point.x - th.x, point.y - th.y) <= TARGET_HANDLE_RADIUS + 4) {
    state.drag = { kind: 'target', pointer: point };
    applyHoverTarget(canvas, graph, point); // in case the handle already starts over a candidate
    return;
  }

  const sh = scaleHandlePosition(state.cropRect);
  if (Math.hypot(point.x - sh.x, point.y - sh.y) <= SCALE_HANDLE_RADIUS + 4) {
    state.drag = { kind: 'scale', startPointer: point, startScale: state.imageScale, pointer: point };
    return;
  }

  if (isOnHueToggle(state.cropRect, point)) {
    // A stateless click-to-toggle, like the save/cancel icons — no drag
    // involved.
    state.adjustments.hueEnabled = !state.adjustments.hueEnabled;
    return;
  }

  const adjustTrack = hitTestAdjustTrack(state.cropRect, point);
  if (adjustTrack) {
    // Jumps straight to the click position (see valueFromAdjustY's own
    // comment), not just starting a drag from wherever the value already was.
    state.adjustments[adjustTrack.param] = valueFromAdjustY(adjustTrack, point.y, adjustTrack.param);
    state.drag = { kind: 'adjust', param: adjustTrack.param };
    return;
  }

  // The rect's edges (excluding the corner handles above, already checked)
  // move the whole rect; the deeper interior still pans the image within it.
  if (isOnCropBorder(state.cropRect, point)) {
    state.drag = { kind: 'move', startPointer: point, startRect: { ...state.cropRect } };
    return;
  }

  const b = cropBounds(state.cropRect);
  if (point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom) {
    state.drag = {
      kind: 'pan',
      startPointer: point,
      startCenterX: state.imageCenterX,
      startCenterY: state.imageCenterY,
    };
  }
  // Anywhere else (the dimmed scrim) — swallowed by virtue of
  // isTextureEditorActive() gating ui/interaction.ts, but starts no drag.
}

function onPointerMove(canvas: HTMLCanvasElement, graph: EntityGraph, point: Point): void {
  if (!state?.drag) return;
  const drag = state.drag;

  if (drag.kind === 'pan') {
    const dx = point.x - drag.startPointer.x;
    const dy = point.y - drag.startPointer.y;
    // Screen delta → image-pixel delta (divide by zoom); subtracted since
    // dragging the image right means the framed center moves left.
    state.imageCenterX = drag.startCenterX - dx / state.imageScale;
    state.imageCenterY = drag.startCenterY - dy / state.imageScale;
    clampToCoverage(); // keeps the pan from running the crop window off the image's edge
    return;
  }

  if (drag.kind === 'move') {
    // Slides the whole rect around the screen, carrying its current
    // framing with it unchanged — same image content, same zoom, just
    // repositioned — rather than touching imageCenterX/Y or imageScale at
    // all like pan/scale do.
    const dx = point.x - drag.startPointer.x;
    const dy = point.y - drag.startPointer.y;
    state.cropRect = { ...drag.startRect, x: drag.startRect.x + dx, y: drag.startRect.y + dy };
    return;
  }

  if (drag.kind === 'adjust') {
    const track = adjustTracks(state.cropRect).find((t) => t.param === drag.param);
    if (track) state.adjustments[drag.param] = valueFromAdjustY(track, point.y, drag.param);
    return;
  }

  if (drag.kind === 'scale') {
    drag.pointer = point; // rubber-band line + +/- badge tracks the cursor — see drawTextureEditor
    // Vertical drag distance from the handle's press point — up zooms in,
    // down zooms out, matching the wheel zoom's own up-is-in convention
    // (see onWheel). Computed from the absolute displacement since the
    // drag started (not incremental per-move deltas), same reasoning as
    // 'resize' below, so it can't drift from rounding/order-of-events.
    const dy = point.y - drag.startPointer.y;
    state.imageScale = drag.startScale * Math.exp(-dy * 0.01);
    clampToCoverage();
    return;
  }

  if (drag.kind === 'resize') {
    const b0 = cropBounds(drag.startRect);
    const fixed =
      drag.handle === 'nw'
        ? { x: b0.right, y: b0.bottom }
        : drag.handle === 'ne'
          ? { x: b0.left, y: b0.bottom }
          : drag.handle === 'sw'
            ? { x: b0.right, y: b0.top }
            : { x: b0.left, y: b0.top };
    const signX = drag.handle === 'ne' || drag.handle === 'se' ? 1 : -1;
    const signY = drag.handle === 'sw' || drag.handle === 'se' ? 1 : -1;

    const dx = Math.abs(point.x - fixed.x);
    const dy = Math.abs(point.y - fixed.y);
    // Whichever axis moved further (in aspect-adjusted terms) drives the
    // new size, so a mostly-horizontal or mostly-vertical drag still feels
    // responsive instead of only reacting to purely diagonal movement.
    const width = Math.max(MIN_CROP_SIZE, Math.max(dx, dy * state.aspect));
    const height = width / state.aspect;

    state.cropRect = {
      x: fixed.x + (signX * width) / 2,
      y: fixed.y + (signY * height) / 2,
      width,
      height,
    };
    clampToCoverage();
    return;
  }

  if (drag.kind === 'target') {
    drag.pointer = point; // the reticle itself visibly tracks the cursor — see targetHandlePosition
    // Live — the crop rect's aspect visibly snaps to each candidate as the
    // handle passes over it, not just once on release (see
    // applyHoverTarget's own comment).
    applyHoverTarget(canvas, graph, point);
  }
}

function onPointerUp(): void {
  if (!state?.drag) return;
  if (state.drag.kind === 'target') {
    // Already applied live by the last pointermove (applyHoverTarget) —
    // release just ends the drag and clears the hover highlight.
    state.hoverTargetEntityId = null;
  }
  state.drag = null;
}

function onWheel(point: Point, deltaY: number): boolean {
  if (!state) return false;
  const b = cropBounds(state.cropRect);
  if (point.x < b.left || point.x > b.right || point.y < b.top || point.y > b.bottom) return false;

  const factor = Math.exp(-deltaY * 0.0015);
  state.imageScale *= factor;
  clampToCoverage();
  return true;
}

function canvasPoint(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

function looksLikeImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSION.test(file.name);
}

export function attachTextureEditor(canvas: HTMLCanvasElement, graph: EntityGraph): void {
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  canvas.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files) return;
    // Only the first image in a multi-file drop — one editor at a time.
    // Non-image files (e.g. an audio drop) are left alone for
    // ui/sampleDrop.ts's own listener to handle.
    const file = Array.from(files).find(looksLikeImageFile);
    if (!file) return;
    e.preventDefault();

    const dropPoint = canvasPoint(canvas, e);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      file.arrayBuffer().then((buf) => {
        openTextureEditor(canvas, graph, img, url, dropPoint, file.name, new Uint8Array(buf));
      });
    };
    img.onerror = () => {
      console.error(`Failed to load dropped image "${file.name}"`);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state) return;
    onPointerDown(canvas, graph, canvasPoint(canvas, e));
    if (state?.drag) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state) return;
    onPointerMove(canvas, graph, canvasPoint(canvas, e));
  });

  const endDrag = (e: PointerEvent) => {
    if (!state) return;
    onPointerUp();
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Non-passive: zooming inside the crop must suppress the viewport's own
  // wheel-scroll, not just the browser's default (rare) wheel action.
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!state) return;
      if (onWheel(canvasPoint(canvas, e), e.deltaY)) e.preventDefault();
    },
    { passive: false }
  );
}

// --- Rendering ---------------------------------------------------------

// A conventional sight/reticle: a ring with crosshair ticks poking out past
// it on all four sides and a small center dot — reads as "aim here" rather
// than a generic handle, which matters now that it rests at the crop rect's
// own center, over the (translucent) image preview rather than off in
// empty space. The dark shadow keeps it legible over arbitrary image
// content underneath.
function drawTargetReticle(ctx: CanvasRenderingContext2D, center: Point, active: boolean): void {
  const r = TARGET_HANDLE_RADIUS;
  const tick = r * 0.6;
  const color = active ? ACCENT : 'rgba(240, 240, 240, 0.95)';

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(center.x - r - tick, center.y);
  ctx.lineTo(center.x - r + 2, center.y);
  ctx.moveTo(center.x + r - 2, center.y);
  ctx.lineTo(center.x + r + tick, center.y);
  ctx.moveTo(center.x, center.y - r - tick);
  ctx.lineTo(center.x, center.y - r + 2);
  ctx.moveTo(center.x, center.y + r - 2);
  ctx.lineTo(center.x, center.y + r + tick);
  ctx.stroke();

  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(center.x, center.y, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// A magnifying-glass silhouette (ring + short angled handle) — visually
// distinct from the square resize handles and the target reticle, reading
// as "zoom" at a glance.
function drawScaleHandle(ctx: CanvasRenderingContext2D, center: Point, active: boolean): void {
  const r = SCALE_HANDLE_RADIUS * 0.62;
  const color = active ? ACCENT : 'rgba(240, 240, 240, 0.95)';
  const lensCenter = { x: center.x - r * 0.4, y: center.y - r * 0.4 };

  ctx.save();
  ctx.fillStyle = 'rgba(24, 24, 24, 0.7)';
  ctx.beginPath();
  ctx.arc(center.x, center.y, SCALE_HANDLE_RADIUS + 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.arc(lensCenter.x, lensCenter.y, r, 0, Math.PI * 2);
  ctx.stroke();

  const handleStart = {
    x: lensCenter.x + r * Math.cos(Math.PI / 4),
    y: lensCenter.y + r * Math.sin(Math.PI / 4),
  };
  const handleEnd = {
    x: center.x + SCALE_HANDLE_RADIUS * 0.75 * Math.cos(Math.PI / 4),
    y: center.y + SCALE_HANDLE_RADIUS * 0.75 * Math.sin(Math.PI / 4),
  };
  ctx.beginPath();
  ctx.moveTo(handleStart.x, handleStart.y);
  ctx.lineTo(handleEnd.x, handleEnd.y);
  ctx.stroke();
  ctx.restore();
}

// Tiny round on/off switch for the hue-boost (ui/textures.ts's
// hueEnabled), sitting in the gap between the saturation and hue tracks —
// filled accent when on, hollow grey when off, same visual language as a
// checkbox rather than a labeled button, since there's no text anywhere on
// this row.
function drawHueToggle(ctx: CanvasRenderingContext2D, center: Point, enabled: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, HUE_TOGGLE_RADIUS, 0, Math.PI * 2);
  if (enabled) {
    ctx.fillStyle = ACCENT;
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(24, 24, 24, 0.6)';
    ctx.fill();
  }
  ctx.strokeStyle = enabled ? 'rgba(0, 0, 0, 0.6)' : 'rgba(240, 240, 240, 0.5)';
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.restore();
}

// A small dot icon standing in for one end of an adjustment slider — no
// text anywhere on these sliders, so the icon itself has to say "this end
// means more/less of the thing" at a glance: brighter/dimmer for
// brightness, vivid/grey for saturation, solid/hollow for opacity, and an
// actual color swatch for hue (see drawAdjustSlider's gradient track,
// which is what actually conveys the full color-wheel sweep in between —
// these two dots alone would otherwise look like near-identical reds,
// since hue wraps from 359° back to 0°).
function drawAdjustDotIcon(
  ctx: CanvasRenderingContext2D,
  center: Point,
  param: AdjustParam,
  end: 'min' | 'max',
  hueEnabled: boolean
): void {
  const r = ADJUST_DOT_RADIUS;
  ctx.save();

  if (param === 'opacity') {
    if (end === 'max') {
      ctx.fillStyle = 'rgba(240, 240, 240, 0.95)';
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(240, 240, 240, 0.6)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (param === 'brightness') {
    ctx.fillStyle = end === 'max' ? '#fff4c8' : 'rgba(70, 70, 70, 0.9)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.fill();
  } else if (param === 'saturation') {
    ctx.fillStyle = end === 'max' ? '#d8543c' : 'rgba(150, 150, 150, 0.85)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // hue — the actual color at this end (0° at the bottom, 359° at the
    // top), not a min/max intensity distinction the way the others use.
    // Desaturated (grey) while the hue toggle is off, matching the track's
    // own grey-when-off styling below.
    const hueDeg = end === 'max' ? ADJUST_RANGES.hue.max : ADJUST_RANGES.hue.min;
    ctx.fillStyle = `hsl(${hueDeg}, ${hueEnabled ? 75 : 0}%, 55%)`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// One subtle adjustment slider: a thin track between the two dot icons
// (min/max — see drawAdjustDotIcon) and a draggable thumb marking the
// current value. No text, per the "subtle, standard dot icons" brief. The
// hue track is the one exception to "thin plain track" — a full color-wheel
// gradient while its toggle (ui/textures.ts's hueEnabled) is on, the
// conventional way a hue picker conveys its own range, which a pair of dots
// alone (both reddish, since hue wraps) couldn't — falling back to the same
// plain grey line every other track uses while it's off, so "off" reads
// unambiguously at a glance rather than just freezing the last color shown.
function drawAdjustSlider(
  ctx: CanvasRenderingContext2D,
  track: AdjustTrack,
  value: number,
  active: boolean,
  hueEnabled: boolean
): void {
  ctx.save();
  if (track.param === 'hue' && hueEnabled) {
    const gradient = ctx.createLinearGradient(track.x, track.top, track.x, track.bottom);
    const { min, max } = ADJUST_RANGES.hue;
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Top of the track is the max end (see valueFromAdjustY's own
      // "up = more" convention), so the gradient runs max → min top-to-bottom.
      const hueDeg = max - t * (max - min);
      gradient.addColorStop(t, `hsl(${hueDeg}, 75%, 55%)`);
    }
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 3;
  } else {
    ctx.strokeStyle = 'rgba(240, 240, 240, 0.3)';
    ctx.lineWidth = 1.5;
  }
  ctx.beginPath();
  ctx.moveTo(track.x, track.top);
  ctx.lineTo(track.x, track.bottom);
  ctx.stroke();
  ctx.restore();

  drawAdjustDotIcon(ctx, { x: track.x, y: track.top }, track.param, 'max', hueEnabled);
  drawAdjustDotIcon(ctx, { x: track.x, y: track.bottom }, track.param, 'min', hueEnabled);

  const thumbY = adjustThumbY(track, value, track.param);
  ctx.save();
  ctx.beginPath();
  ctx.arc(track.x, thumbY, ADJUST_THUMB_RADIUS, 0, Math.PI * 2);
  // The hue thumb shows the actual selected color (while enabled) rather
  // than the generic neutral/accent dot the other three sliders use —
  // seeing the color you've picked matters more here than "where on the
  // track" does. Falls back to the generic style while off, matching the
  // track/dots.
  ctx.fillStyle =
    track.param === 'hue' && hueEnabled ? `hsl(${value}, 75%, 55%)` : active ? ACCENT : 'rgba(240, 240, 240, 0.9)';
  ctx.fill();
  ctx.strokeStyle = active ? ACCENT : 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();
  ctx.restore();
}

// tick/cross for the save/cancel buttons; plus/minus for the scale-drag
// rubber-band feedback below — same badge styling either way (a small dark
// rounded box), and the same green-means-positive/red-means-negative color
// convention (tick and plus both green; cross and minus both red).
type IconGlyph = 'tick' | 'cross' | 'plus' | 'minus';

function drawIconButton(ctx: CanvasRenderingContext2D, center: Point, kind: IconGlyph): void {
  const half = ICON_SIZE / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(24, 24, 24, 0.85)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(center.x - half, center.y - half, ICON_SIZE, ICON_SIZE, 4);
  ctx.fill();
  ctx.stroke();

  const positive = kind === 'tick' || kind === 'plus';
  ctx.strokeStyle = positive ? '#5ac85a' : '#c85a5a';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (kind === 'tick') {
    ctx.moveTo(center.x - half * 0.5, center.y);
    ctx.lineTo(center.x - half * 0.1, center.y + half * 0.4);
    ctx.lineTo(center.x + half * 0.5, center.y - half * 0.4);
  } else if (kind === 'cross') {
    ctx.moveTo(center.x - half * 0.4, center.y - half * 0.4);
    ctx.lineTo(center.x + half * 0.4, center.y + half * 0.4);
    ctx.moveTo(center.x + half * 0.4, center.y - half * 0.4);
    ctx.lineTo(center.x - half * 0.4, center.y + half * 0.4);
  } else {
    ctx.moveTo(center.x - half * 0.5, center.y);
    ctx.lineTo(center.x + half * 0.5, center.y);
    if (kind === 'plus') {
      ctx.moveTo(center.x, center.y - half * 0.5);
      ctx.lineTo(center.x, center.y + half * 0.5);
    }
  }
  ctx.stroke();
  ctx.restore();
}

// Live feedback for an in-progress scale drag: a rubber-band line from the
// magnifying-glass handle to the cursor, ending in a +/- badge showing
// which way the image is about to zoom at the current drag point (see
// onPointerMove's 'scale' case for the matching math — up zooms in).
function drawScaleDragFeedback(ctx: CanvasRenderingContext2D, from: Point, to: Point, zoomingIn: boolean): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(240, 240, 240, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();

  drawIconButton(ctx, to, zoomingIn ? 'plus' : 'minus');
}

export function drawTextureEditor(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, graph: EntityGraph): void {
  if (!state) return;

  ctx.save();

  // Dims everything already drawn so the floating crop panel reads as
  // being in front of (rather than just overlapping) the rest of the UI.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const b = cropBounds(state.cropRect);

  // The framed image content, clipped to the crop window — panning/
  // zooming moves the image *within* this fixed window (only what's
  // currently framed is visible), rather than showing the whole photo with
  // a highlighted sub-region. Brightness/saturation/hue applied live
  // via drawAdjustedTexture (ui/textures.ts — the same shared helper
  // ui/render.ts's applied rendering uses, isolated onto its own scratch
  // canvas rather than combining ctx.filter with this clip+globalAlpha in
  // one pass). Opacity is the user's own slider value MULTIPLIED by the
  // fixed preview-visibility alpha, not used alone — at the slider's full
  // 100%, the preview still only reaches IMAGE_PREVIEW_ALPHA, so whatever's
  // underneath (a potential target entity included) stays visible enough
  // to aim at even at "fully opaque." The saved texture itself uses the
  // slider value directly, with no such cap — see ui/render.ts's
  // drawTexturedFill.
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.left, b.top, state.cropRect.width, state.cropRect.height);
  ctx.clip();
  ctx.globalAlpha = state.adjustments.opacity * IMAGE_PREVIEW_ALPHA;
  const srcW = state.cropRect.width / state.imageScale;
  const srcH = state.cropRect.height / state.imageScale;
  drawAdjustedTexture(
    ctx,
    state.image,
    { x: state.imageCenterX - srcW / 2, y: state.imageCenterY - srcH / 2, width: srcW, height: srcH },
    { x: b.left, y: b.top, width: state.cropRect.width, height: state.cropRect.height },
    state.adjustments
  );
  ctx.restore();

  // Live highlight of whatever entity the target handle is currently
  // hovering — drawn AFTER (on top of) the now-translucent image preview
  // above, unclipped, so it always reads crisply regardless of what part
  // of the image or canvas is behind it (including when the hovered
  // entity sits right under the crop window itself). Uses effectiveBounds
  // (ui/layout.ts) — the same resolved, absolute, already-expanded rect
  // ui/render.ts's own drawBox uses to actually draw that entity's box —
  // not its raw x/y/width/height, which are relative to its parent for a
  // nested entity and don't include the extra room a control-dot column or
  // nested children grow the box to (see targetAndAspectFor's own comment).
  if (state.drag?.kind === 'target' && state.hoverTargetEntityId) {
    const hoverEntity = graph.get(state.hoverTargetEntityId);
    if (hoverEntity) {
      const bounds = effectiveBounds(graph, hoverEntity);
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(
        bounds.x - bounds.width / 2 - 4,
        bounds.y - bounds.height / 2 - 4,
        bounds.width + 8,
        bounds.height + 8
      );
      ctx.restore();
    }
  }

  ctx.strokeStyle = 'rgba(240, 240, 240, 0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(b.left, b.top, state.cropRect.width, state.cropRect.height);

  ctx.fillStyle = 'rgba(240, 240, 240, 0.95)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  for (const handle of RESIZE_HANDLES) {
    const hp = handlePosition(state.cropRect, handle);
    ctx.fillRect(hp.x - HANDLE_SIZE / 2, hp.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(hp.x - HANDLE_SIZE / 2, hp.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  }

  for (const track of adjustTracks(state.cropRect)) {
    const active = state.drag?.kind === 'adjust' && state.drag.param === track.param;
    drawAdjustSlider(ctx, track, state.adjustments[track.param], active, state.adjustments.hueEnabled);
  }
  drawHueToggle(ctx, hueTogglePosition(state.cropRect), state.adjustments.hueEnabled);

  drawTargetReticle(ctx, targetHandlePosition(), state.drag?.kind === 'target');

  // Top-left row, mirroring the save/cancel row's own top-right placement:
  // the scale (magnifying-glass) handle, then its label immediately to
  // its right.
  const scalePos = scaleHandlePosition(state.cropRect);
  drawScaleHandle(ctx, scalePos, state.drag?.kind === 'scale');
  if (state.drag?.kind === 'scale') {
    const zoomingIn = state.drag.pointer.y - state.drag.startPointer.y <= 0;
    drawScaleDragFeedback(ctx, scalePos, state.drag.pointer, zoomingIn);
  }

  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(240, 240, 240, 0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`target: ${state.target}`, scalePos.x + SCALE_HANDLE_RADIUS + 3 + ICON_GAP, scalePos.y);

  const { save, cancel } = saveCancelPositions(state.cropRect);
  drawIconButton(ctx, cancel, 'cross');
  drawIconButton(ctx, save, 'tick');

  ctx.restore();
}
