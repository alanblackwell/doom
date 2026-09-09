// Geometry, state, hit-testing, and drawing for the grain-sampler organelle
// (EntityType 'feature', kind 'grainEditor' — see audio/entityGraph.ts and
// ui/organelle.ts's porthole/popup mechanism, reused unchanged for the
// collapsed/expanded toggle and popup anchoring). The owning Source is
// always kind 'grain' (audio/graph.ts's 'grain' case, audio/grainPlayer.ts's
// engine) — see TODO.md's grain-sampler entry.
//
// Capture mechanism is a direct, trimmed-down port of ui/beatMatcher.ts's own
// (see that file's own header for the full reasoning): a Source/liveInput
// entity dropped onto this popup while it's open is referenced (NOT
// contained — a feature is never a container, same as beat-matcher) as the
// capture source; capture is sound-triggered, auto-starting the instant that
// source actually sounds and auto-stopping the instant it goes quiet again
// (audio/nodeCapture.ts's watchSound/startNodeCapture, tapping the source's
// own already-built output node via audio/graph.ts's getEntityNodes). What's
// entirely different from the beat-matcher: no note track, no selection
// ruler, no playback transport, no onset suggestions — once a capture
// finishes, its spectrogram (ui/spectrogram.ts, reused unmodified) is just a
// surface to click POINTS onto, each a small circle marking a time offset
// the engine can start a grain from (see audio/grainPlayer.ts's own
// GrainPoint). A point's vertical position is currently cosmetic only — see
// GrainPoint's own comment for why, and TODO.md for the deferred per-point
// bandpass-by-height idea.
//
// A file dragged straight from the OS onto this same popup while it's open
// (ui/sampleDrop.ts's own drop handler, which decodes it and calls
// loadGrainFile below instead of its usual "spawn a new 'sample' entity"
// path) is accepted the same way, just with no live source/watchSound
// involved — it arrives as an already-decoded AudioBuffer and goes
// straight to 'paused' with a capture in hand. decodeAudioData rejecting
// an unrecognized file is left to surface as a console error there, same
// as sampleDrop.ts's own canvas-drop failure handling — no separate
// user-facing validation here.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, closeButtonPosition, registerFeaturePopupSize, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { getEntityNodes, getGrainVoice } from '../audio/graph';
import { startNodeCapture, watchSound } from '../audio/nodeCapture';
import type { LevelWatcher, Recording } from '../audio/nodeCapture';
import { computeSpectrogram, createLiveSpectrogram, renderSpectrogramImage } from './spectrogram';
import type { LiveSpectrogram, SpectrogramData } from './spectrogram';
import type { GrainPoint } from '../audio/grainPlayer';

export const GRAIN_POPUP_WIDTH = 320;
export const GRAIN_POPUP_HEIGHT = 190;
// So ui/organelle.ts's own popupRectFor can stack this popup against a
// sibling feature's on the same owner (e.g. grain-1's own grainTuning) —
// see registerFeaturePopupSize's own comment.
registerFeaturePopupSize('grainEditor', GRAIN_POPUP_WIDTH, GRAIN_POPUP_HEIGHT);
const PADDING = 10;
const POINT_RADIUS = 5;
const POINT_HIT_RADIUS = 9;

export type GrainSamplerStatus = 'idle' | 'armed' | 'capturing' | 'paused';

export interface GrainSamplerState {
  // The Source/liveInput entity this popup captures from, or null until one
  // has been dropped onto it — same "reference, not containment" idiom as
  // ui/beatMatcher.ts's own BeatMatcherState.sourceEntityId.
  sourceEntityId: string | null;
  status: GrainSamplerStatus;
  watcher: LevelWatcher | null;
  recording: Recording | null;
  capturedBuffer: AudioBuffer | null;
  spectrogramImage: HTMLCanvasElement | null;
  liveSpectrogram: LiveSpectrogram | null;
  spectrogramData: SpectrogramData | null;
  points: GrainPoint[];
  // Same confirm-before-re-arm guard as ui/beatMatcher.ts's own
  // infoOverlayOpen — re-arming discards the current capture (and every
  // point placed against it) the instant new sound starts, so the record
  // button's first press while paused-with-a-capture only reveals this
  // overlay; a second press actually re-arms. See pressGrainRecordButton.
  infoOverlayOpen: boolean;
}

const statesByEntity = new Map<string, GrainSamplerState>();

export function grainSamplerStateFor(entityId: string): GrainSamplerState {
  let state = statesByEntity.get(entityId);
  if (!state) {
    state = {
      sourceEntityId: null,
      status: 'idle',
      watcher: null,
      recording: null,
      capturedBuffer: null,
      spectrogramImage: null,
      liveSpectrogram: null,
      spectrogramData: null,
      points: [],
      infoOverlayOpen: false,
    };
    statesByEntity.set(entityId, state);
  }
  return state;
}

// The owning 'grain' Source entity's own id, cached at setGrainSource time —
// pushPointsToEngine/finishGrainCapture need it to reach the live voice
// (audio/graph.ts's getGrainVoice), but only ever get a `graph` reference
// from ui/interaction.ts's call sites for SOME of these paths, not all
// (e.g. the sound-triggered auto-start/stop callbacks below have neither).
// Kept as its own small side map rather than threading `graph`/`owner`
// through every function here, same "side registry keyed by feature id"
// idiom as ui/sampler.ts's own `samplers` map.
const grainVoiceOwnerId = new Map<string, string>();

function pushPointsToEngine(featureEntityId: string): void {
  const ownerId = grainVoiceOwnerId.get(featureEntityId);
  if (!ownerId) return;
  const state = grainSamplerStateFor(featureEntityId);
  getGrainVoice(ownerId)?.setPoints(state.points);
}

function stopWatcher(state: GrainSamplerState): void {
  if (state.watcher) {
    state.watcher.stop();
    state.watcher = null;
  }
}

// Tears down any live watcher/recording — called when the owner is docked
// (ui/docking.ts silences/detaches a parked instrument) and when the popup
// closes for a reason other than finishing a capture normally. Leaves
// capturedBuffer/points alone: docking silences, it doesn't discard — same
// convention as ui/sampler.ts's own stopCapture.
export function stopGrainCapture(entityId: string): void {
  const state = statesByEntity.get(entityId);
  if (!state) return;
  state.recording = null;
  stopWatcher(state);
  state.status = state.capturedBuffer ? 'paused' : 'idle';
}

// See ui/beatMatcher.ts's own armBeatMatcher for the full reasoning (sound-
// triggered auto-start/stop) — this is a direct, unmodified-in-spirit port.
function armGrainSampler(featureEntityId: string): void {
  const state = grainSamplerStateFor(featureEntityId);
  stopWatcher(state);
  state.status = 'armed';
  state.infoOverlayOpen = false;
  if (!state.sourceEntityId) return;
  const nodes = getEntityNodes(state.sourceEntityId);
  if (!nodes) return; // not built yet (docked, or audio not started) — re-arm on the next drop/press picks this up once it is

  state.watcher = watchSound(nodes.output, (sounding) => {
    const current = grainSamplerStateFor(featureEntityId);
    if (sounding && current.status === 'armed') {
      beginGrainCapture(featureEntityId);
    } else if (!sounding && current.status === 'capturing') {
      finishGrainCapture(featureEntityId);
    }
  });
}

function beginGrainCapture(featureEntityId: string): void {
  const state = grainSamplerStateFor(featureEntityId);
  if (!state.sourceEntityId) return;
  const nodes = getEntityNodes(state.sourceEntityId);
  if (!nodes) return;
  state.capturedBuffer = null;
  state.points = []; // points authored against the old capture don't carry over to whatever this one turns out to be
  pushPointsToEngine(featureEntityId);
  const liveSpectrogram = createLiveSpectrogram(nodes.output.context.sampleRate);
  state.liveSpectrogram = liveSpectrogram;
  state.recording = startNodeCapture(nodes.output, (chunk) => liveSpectrogram.pushSamples(chunk));
  state.status = 'capturing';
}

function finishGrainCapture(featureEntityId: string): void {
  const state = grainSamplerStateFor(featureEntityId);
  if (!state.recording) return;
  const recording = state.recording;
  state.recording = null;
  recording.stop().then((buffer) => {
    state.capturedBuffer = buffer;
    const spectrogramData = computeSpectrogram(buffer);
    state.spectrogramData = spectrogramData;
    state.spectrogramImage = renderSpectrogramImage(spectrogramData);
    state.liveSpectrogram = null;
    const ownerId = grainVoiceOwnerId.get(featureEntityId);
    if (ownerId) getGrainVoice(ownerId)?.setBuffer(buffer);
  });
  stopWatcher(state);
  state.status = 'paused';
}

// Dropping a (new, or replacement) source onto the popup arms it
// immediately — same "no separate start-capture press needed" flow as
// ui/beatMatcher.ts's own setBeatMatcherSource. Replacing an
// already-connected source tears down whatever was watching/capturing from
// the old one, and discards any points along with the now-gone buffer they
// were placed against.
export function setGrainSource(graph: EntityGraph, featureEntityId: string, sourceEntityId: string): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  const ownerId = owner.id;
  grainVoiceOwnerId.set(featureEntityId, ownerId);
  const state = grainSamplerStateFor(featureEntityId);
  stopWatcher(state);
  if (state.recording) {
    state.recording.stop();
    state.recording = null;
  }
  state.sourceEntityId = sourceEntityId;
  state.capturedBuffer = null;
  state.spectrogramImage = null;
  state.liveSpectrogram = null;
  state.spectrogramData = null;
  state.points = [];
  pushPointsToEngine(featureEntityId);
  getGrainVoice(ownerId)?.setBuffer(null);
  armGrainSampler(featureEntityId);
}

// A file dragged straight from the OS onto this popup while it's open
// (ui/sampleDrop.ts, which decodes it and calls this instead of its own
// usual "drop a new 'sample' entity on the canvas" path — see that
// module's own drop handler) — an already-fully-decoded buffer arrives
// here directly, so unlike setGrainSource above there's no live source to
// reference or watchSound for: this goes straight to 'paused' with a
// capture already in hand, same end state finishGrainCapture reaches, just
// without ever having been 'armed'/'capturing'. Replaces whatever the
// popup previously had (live-source or another file), same as dropping a
// new in-app source over it would.
export function loadGrainFile(graph: EntityGraph, featureEntityId: string, buffer: AudioBuffer): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  const ownerId = owner.id;
  grainVoiceOwnerId.set(featureEntityId, ownerId);
  const state = grainSamplerStateFor(featureEntityId);
  stopWatcher(state);
  if (state.recording) {
    state.recording.stop();
    state.recording = null;
  }
  state.sourceEntityId = null; // nothing live to reference — see this function's own header
  state.capturedBuffer = buffer;
  state.spectrogramData = computeSpectrogram(buffer);
  state.spectrogramImage = renderSpectrogramImage(state.spectrogramData);
  state.liveSpectrogram = null;
  state.points = [];
  state.infoOverlayOpen = false;
  pushPointsToEngine(featureEntityId);
  getGrainVoice(ownerId)?.setBuffer(buffer);
  state.status = 'paused';
}

// Same four-status behavior as ui/beatMatcher.ts's own
// pressBeatMatcherRecordButton — see that function's own comment for the
// 'paused' confirm-before-re-arm case.
export function pressGrainRecordButton(featureEntityId: string): void {
  const state = grainSamplerStateFor(featureEntityId);
  switch (state.status) {
    case 'idle':
      return;
    case 'armed':
      stopWatcher(state);
      state.status = 'paused';
      return;
    case 'paused':
      if (state.capturedBuffer && !state.infoOverlayOpen) {
        state.infoOverlayOpen = true;
        return;
      }
      armGrainSampler(featureEntityId);
      return;
    case 'capturing':
      finishGrainCapture(featureEntityId);
      return;
  }
}

export function closeGrainInfoOverlay(featureEntityId: string): void {
  grainSamplerStateFor(featureEntityId).infoOverlayOpen = false;
}

// --- Points -----------------------------------------------------------

let nextGrainPointId = 1;

export function addGrainPoint(featureEntityId: string, timeSeconds: number, y: number): void {
  const state = grainSamplerStateFor(featureEntityId);
  if (!state.capturedBuffer) return;
  const t = Math.max(0, Math.min(state.capturedBuffer.duration, timeSeconds));
  state.points.push({ id: `grain-point-${nextGrainPointId++}`, timeSeconds: t, y: Math.max(0, Math.min(1, y)) });
  pushPointsToEngine(featureEntityId);
}

export function moveGrainPoint(featureEntityId: string, pointId: string, timeSeconds: number, y: number): void {
  const state = grainSamplerStateFor(featureEntityId);
  const point = state.points.find((p) => p.id === pointId);
  if (!point || !state.capturedBuffer) return;
  point.timeSeconds = Math.max(0, Math.min(state.capturedBuffer.duration, timeSeconds));
  point.y = Math.max(0, Math.min(1, y));
  pushPointsToEngine(featureEntityId);
}

export function deleteGrainPoint(featureEntityId: string, pointId: string): void {
  const state = grainSamplerStateFor(featureEntityId);
  const index = state.points.findIndex((p) => p.id === pointId);
  if (index === -1) return;
  state.points.splice(index, 1);
  pushPointsToEngine(featureEntityId);
}

// --- Popup layout -----------------------------------------------------

interface GrainSamplerLayout {
  popup: Rect;
  band: Rect; // the spectrogram display area, center-based like every other Rect here
  recordButton: Point;
}

export function grainSamplerPopupRect(graph: EntityGraph, owner: Entity, drag?: DragContext): Rect {
  return popupRectFor(graph, owner, GRAIN_POPUP_WIDTH, GRAIN_POPUP_HEIGHT, drag);
}

function layoutFor(popup: Rect): GrainSamplerLayout {
  const top = popup.y - popup.height / 2;
  const bottom = popup.y + popup.height / 2;
  const bandTop = top + TITLE_HEIGHT + 4;
  const recordButton: Point = { x: popup.x - popup.width / 2 + PADDING + 10, y: bottom - PADDING - 10 };
  const bandBottom = bottom - PADDING * 2 - 20;
  const band: Rect = {
    x: popup.x,
    y: (bandTop + bandBottom) / 2,
    width: popup.width - PADDING * 2,
    height: Math.max(1, bandBottom - bandTop),
  };
  return { popup, band, recordButton };
}

function bandBounds(band: Rect): { left: number; right: number; top: number; bottom: number } {
  return {
    left: band.x - band.width / 2,
    right: band.x + band.width / 2,
    top: band.y - band.height / 2,
    bottom: band.y + band.height / 2,
  };
}

// Fraction-of-clip <-> screen-x, and fraction-of-band-height <-> screen-y —
// the whole clip always fits the band's width (no zoom/scroll, unlike
// ui/beatMatcher.ts's own timeline; same "always fit the whole thing"
// convention as ui/sampler.ts's own waveform).
function pointScreenPosition(band: Rect, duration: number, point: GrainPoint): Point {
  const b = bandBounds(band);
  const x = duration > 0 ? b.left + (point.timeSeconds / duration) * (b.right - b.left) : b.left;
  const y = b.top + point.y * (b.bottom - b.top);
  return { x, y };
}

function screenToGrainPlacement(band: Rect, duration: number, p: Point): { timeSeconds: number; y: number } {
  const b = bandBounds(band);
  const xFraction = (b.right - b.left) > 0 ? (p.x - b.left) / (b.right - b.left) : 0;
  const yFraction = (b.bottom - b.top) > 0 ? (p.y - b.top) / (b.bottom - b.top) : 0;
  return {
    timeSeconds: Math.max(0, Math.min(duration, xFraction * duration)),
    y: Math.max(0, Math.min(1, yFraction)),
  };
}

// --- Hit-testing --------------------------------------------------------

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export type GrainPopupHit =
  | { entityId: string; ownerId: string; kind: 'close' }
  | { entityId: string; ownerId: string; kind: 'record' }
  | { entityId: string; ownerId: string; kind: 'overlayClose' }
  | { entityId: string; ownerId: string; kind: 'point'; pointId: string }
  | { entityId: string; ownerId: string; kind: 'band'; timeSeconds: number; y: number }
  | { entityId: string; ownerId: string; kind: 'background' };

export function hitTestGrainSamplerPopup(graph: EntityGraph, point: Point, drag?: DragContext): GrainPopupHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'grainEditor' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const ownerId = owner.id;

    const popup = grainSamplerPopupRect(graph, owner, drag);
    const layout = layoutFor(popup);

    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, ownerId, kind: 'close' };
    }

    const state = grainSamplerStateFor(entity.id);

    if (state.infoOverlayOpen) {
      const overlayClose = { x: popup.x + popup.width / 2 - PADDING - 6, y: layout.band.y - layout.band.height / 2 + 10 };
      if (dist(point, overlayClose) <= 8) {
        return { entityId: entity.id, ownerId, kind: 'overlayClose' };
      }
    }

    if (dist(point, layout.recordButton) <= 11) {
      return { entityId: entity.id, ownerId, kind: 'record' };
    }

    if (state.capturedBuffer) {
      for (const p of state.points) {
        const screen = pointScreenPosition(layout.band, state.capturedBuffer.duration, p);
        if (dist(point, screen) <= POINT_HIT_RADIUS) {
          return { entityId: entity.id, ownerId, kind: 'point', pointId: p.id };
        }
      }
      const b = bandBounds(layout.band);
      if (point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom) {
        const placement = screenToGrainPlacement(layout.band, state.capturedBuffer.duration, point);
        return { entityId: entity.id, ownerId, kind: 'band', timeSeconds: placement.timeSeconds, y: placement.y };
      }
    }

    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return { entityId: entity.id, ownerId, kind: 'background' };
    }
  }
  return null;
}

// --- Point drag ----------------------------------------------------------

export function updateGrainPointDrag(featureEntityId: string, pointId: string, screenPoint: Point, graph: EntityGraph, drag?: DragContext): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  const state = grainSamplerStateFor(featureEntityId);
  if (!owner || !state.capturedBuffer) return;
  const popup = grainSamplerPopupRect(graph, owner, drag);
  const layout = layoutFor(popup);
  const placement = screenToGrainPlacement(layout.band, state.capturedBuffer.duration, screenPoint);
  moveGrainPoint(featureEntityId, pointId, placement.timeSeconds, placement.y);
}

// --- Drop target -----------------------------------------------------

// Where a just-dropped entity should actually come to rest, clear of the
// popup's own bounds — same reasoning (and same offset) as
// ui/beatMatcher.ts's own beatMatcherClearDropPosition.
export function grainSamplerClearDropPosition(graph: EntityGraph, featureEntityId: string, droppedHalfHeight: number): Point | null {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!feature || !owner) return null;
  const popup = grainSamplerPopupRect(graph, owner);
  return { x: popup.x, y: popup.y + popup.height / 2 + droppedHalfHeight + 24 };
}

// The feature entity id whose open popup's interior contains `point` (or the
// live drag target) — same "whole interior is the drop target" idiom as
// ui/beatMatcher.ts's own beatMatcherDropTargetAt.
export function grainSamplerDropTargetAt(graph: EntityGraph, point: Point, drag?: DragContext): string | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'grainEditor' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const popup = grainSamplerPopupRect(graph, owner, drag);
    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return entity.id;
    }
  }
  return null;
}

// --- Drawing -----------------------------------------------------------

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
// Same subtle wash idiom as ui/beatMatcher.ts's own DROP_ZONE_BG/_HOVER —
// a dragged source/file passing over this popup is a valid "capture from
// this" drop target (see ui/interaction.ts's hoverGrainId), so it needs the
// same "about to accept a drop" visual cue that a filter's own containment
// boundary already gets (ui/render.ts's drawBox dropTarget flag).
const DROP_ZONE_BG_HOVER = 'rgba(255, 255, 255, 0.14)';
const BAND_BG = 'rgba(0, 0, 0, 0.35)';
const POINT_COLOR = 'rgba(232, 220, 192, 0.95)';
const POINT_STROKE = 'rgba(0, 0, 0, 0.6)';

function drawBandFrame(ctx: CanvasRenderingContext2D, band: Rect): void {
  const b = bandBounds(band);
  ctx.fillStyle = BAND_BG;
  ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
}

function drawRecordButton(ctx: CanvasRenderingContext2D, p: Point, status: GrainSamplerStatus): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = status === 'capturing' ? '#e05050' : 'rgba(224, 80, 80, 0.6)';
  if (status === 'capturing') {
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function statusText(state: GrainSamplerState): string {
  switch (state.status) {
    case 'idle':
      return 'drag a source, or a file, in to capture';
    case 'armed':
      return 'armed — waiting for sound…';
    case 'capturing':
      return 'capturing…';
    case 'paused':
      return state.capturedBuffer ? `captured ${state.capturedBuffer.duration.toFixed(2)}s — click record to re-arm` : 'paused';
  }
}

export function drawGrainSamplerPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  isDropHover: boolean,
  drag?: DragContext
): void {
  const state = grainSamplerStateFor(entity.id);
  const popup = grainSamplerPopupRect(graph, owner, drag);
  const layout = layoutFor(popup);
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

  const close = closeButtonPosition(popup);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('grain', left + 10, top + TITLE_HEIGHT / 2);

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

  // A dragged source/file currently poised to become this popup's capture
  // input (see the DROP_ZONE_BG_HOVER comment above) — drawn under the band
  // frame/spectrogram/points below so it reads as a wash on the body rather
  // than obscuring that content.
  if (isDropHover) {
    ctx.fillStyle = DROP_ZONE_BG_HOVER;
    ctx.fillRect(left, top + TITLE_HEIGHT, popup.width, popup.height - TITLE_HEIGHT);
  }

  drawBandFrame(ctx, layout.band);
  const b = bandBounds(layout.band);

  if (state.spectrogramImage && state.capturedBuffer) {
    const image = state.spectrogramImage;
    ctx.drawImage(image, 0, 0, image.width, image.height, b.left, b.top, b.right - b.left, b.bottom - b.top);
  } else if (state.liveSpectrogram && state.liveSpectrogram.columnCount > 0) {
    const live = state.liveSpectrogram;
    ctx.drawImage(live.canvas, 0, 0, live.columnCount, live.canvas.height, b.left, b.top, b.right - b.left, b.bottom - b.top);
  } else {
    ctx.save();
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillText('drag a source, or a file, in to capture', layout.band.x, layout.band.y);
    ctx.restore();
  }

  // Points — small filled circles, per the "grain" metaphor (see this
  // file's own header on why the vertical position is cosmetic for now).
  if (state.capturedBuffer) {
    for (const p of state.points) {
      const screen = pointScreenPosition(layout.band, state.capturedBuffer.duration, p);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = POINT_COLOR;
      ctx.fill();
      ctx.strokeStyle = POINT_STROKE;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  drawRecordButton(ctx, layout.recordButton, state.status);

  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.fillText(statusText(state), layout.recordButton.x + 16, layout.recordButton.y);

  // Info/confirm overlay — same "are you sure, this discards the capture"
  // step as ui/beatMatcher.ts's own infoOverlayOpen, drawn over the band.
  if (state.infoOverlayOpen) {
    ctx.fillStyle = 'rgba(10, 10, 10, 0.92)';
    ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('re-arm? this discards the current capture', layout.band.x, layout.band.y - 6);
    ctx.fillText('and every point placed on it', layout.band.x, layout.band.y + 6);
    ctx.textAlign = 'left';
    const overlayClose = { x: popup.x + popup.width / 2 - PADDING - 6, y: layout.band.y - layout.band.height / 2 + 10 };
    ctx.beginPath();
    ctx.arc(overlayClose.x, overlayClose.y, 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(overlayClose.x - 2.5, overlayClose.y - 2.5);
    ctx.lineTo(overlayClose.x + 2.5, overlayClose.y + 2.5);
    ctx.moveTo(overlayClose.x + 2.5, overlayClose.y - 2.5);
    ctx.lineTo(overlayClose.x - 2.5, overlayClose.y + 2.5);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.stroke();
  }

  ctx.restore();
}
