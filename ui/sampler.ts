// Geometry, state, hit-testing, and drawing for the sampler organelle
// (EntityType 'feature', kind 'sampler' — see audio/entityGraph.ts and
// ui/organelle.ts's porthole/popup mechanism, reused unchanged for the
// collapsed/expanded toggle and popup anchoring). Parallel to ui/melody.ts:
// its own module rather than folded into organelle.ts, since none of its
// popup contents (device selector, oscilloscope/waveform, record button,
// name field) share the envelope's curve/handle geometry.
//
// The owning Source is always kind 'sample' (audio/controlSpecs.ts's
// existing entry, audio/graph.ts's existing 'sample' case) — recording
// captures into the exact same buffer registry ui/sampleDrop.ts's dropped-
// file path uses (registerSampleBuffer), so once something's been recorded
// and trimmed, the owner's own pad/level/speed controls work completely
// unmodified. See TODO.md item 2 ("Sample capture").

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, closeButtonPosition, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { registerSampleBuffer } from '../audio/graph';
import { getAudioContext } from '../audio/context';
import {
  auditionClip,
  listInputDevices,
  sliceBuffer,
  startMonitoring,
  startRecording,
} from '../audio/samplerCapture';
import type { Monitor, Recording } from '../audio/samplerCapture';
import { encodeWav } from '../audio/wavEncode';
import { registerLoadedSampleFile, renameLoadedSampleFile } from './sampleDrop';
import { ACCENT } from './palette';

export const SAMPLER_POPUP_WIDTH = 300;
export const SAMPLER_POPUP_HEIGHT = 190;
const PADDING = 10;
const ROW_HEIGHT = 20;
const MARKER_HIT_RADIUS = 8;
const DEVICE_OPTION_HEIGHT = 18;

// Seconds nudged per Left/Right keypress (ui/interaction.ts's attachKeyboard)
// — fine enough for precise trim placement without needing a modifier key
// for a coarser/finer step; revisit if that turns out too coarse/fine once
// tried on a real clip.
export const MARKER_NUDGE_SECONDS = 0.01;

// Column rate for the live scrolling trace while actively recording (see
// drawRecordingScroll) — independent of the finished waveform's own zoom
// (pxPerSecondFor always fits the whole clip to the popup's width once
// recording stops), since while still recording there's no known final
// duration to fit anything to yet.
const RECORDING_PX_PER_SECOND = 60;

export interface SamplerState {
  name: string;
  inputDeviceId: string | null;
  devices: MediaDeviceInfo[];
  deviceListOpen: boolean;
  status: 'idle' | 'monitoring' | 'recording';
  monitor: Monitor | null;
  recording: Recording | null;
  recordedBuffer: AudioBuffer | null;
  trimStart: number;
  trimEnd: number;
  // Reused each frame for the live scope trace (monitoring/recording) —
  // avoids reallocating a Float32Array every animation frame just to read
  // the analyser. Explicitly <ArrayBuffer> (not the general ArrayBufferLike
  // default) to match AnalyserNode.getFloatTimeDomainData's own signature.
  liveTrace: Float32Array<ArrayBuffer>;
  // The growing scrolling trace while status === 'recording' (see
  // drawRecordingScroll) — one entry per RECORDING_PX_PER_SECOND-th of a
  // second since recordingStartedAt, appended lazily as frames are drawn
  // rather than on a separate timer. Reset empty each time a new recording
  // starts; not read once recordedBuffer is set (drawWaveform takes over).
  recordingPeaks: { min: number; max: number }[];
  recordingStartedAt: number;
  // Set when armMonitor's getUserMedia call rejects (a permission denial, or
  // a constraint the selected device can't satisfy) — shown in the scope
  // area in place of the placeholder text, so a failure is visible instead
  // of silently looking identical to "no device chosen yet" (previously only
  // logged to console). Cleared at the start of every new attempt.
  lastError: string | null;
}

// Keyed by the sampler feature entity's own id — same side-registry idiom as
// ui/melody.ts's `melodies` (Entity.params is plain Record<string, number>,
// no room for a MediaStream/AudioBuffer/device list).
const samplers = new Map<string, SamplerState>();

export function samplerStateFor(entityId: string): SamplerState {
  let state = samplers.get(entityId);
  if (!state) {
    state = {
      name: '',
      inputDeviceId: null,
      devices: [],
      deviceListOpen: false,
      status: 'idle',
      monitor: null,
      recording: null,
      recordedBuffer: null,
      trimStart: 0,
      trimEnd: 0,
      liveTrace: new Float32Array(1024),
      recordingPeaks: [],
      recordingStartedAt: 0,
      lastError: null,
    };
    samplers.set(entityId, state);
  }
  return state;
}

// Tears down any live stream/recording — called when the owner is docked
// (ui/docking.ts, parking an instrument silences and detaches it) and when a
// popup closes for a different reason than finishing a recording normally.
// Leaves recordedBuffer/trim alone: docking silences, it doesn't discard.
export function stopCapture(entityId: string): void {
  const state = samplers.get(entityId);
  if (!state) return;
  state.recording = null;
  state.monitor?.stop();
  state.monitor = null;
  state.status = 'idle';
  if (nameInputEntityId === entityId) hideNameInput();
}

async function ensureDevices(state: SamplerState): Promise<void> {
  if (state.devices.length > 0) return;
  // Real device labels need permission already granted (see
  // audio/samplerCapture.ts's listInputDevices) — get that by arming the
  // REAL monitor first (if nothing's monitoring yet), rather than a
  // throwaway getUserMedia call opened and immediately closed just to
  // trigger the permission prompt. Opening the same device twice in quick
  // succession (open-close-reopen) is what was actually behind a "capture
  // failure" console error seen with BlackHole — this way there's only ever
  // one stream open. A side effect: opening the device list for the first
  // time also starts monitoring the default input immediately, which is a
  // reasonable bonus, not just a workaround.
  if (!state.monitor) {
    await armMonitor(state, state.inputDeviceId);
  }
  try {
    state.devices = await listInputDevices();
  } catch (err) {
    console.error('Failed to enumerate audio input devices:', err);
  }
}

export function toggleDeviceList(entityId: string): void {
  const state = samplerStateFor(entityId);
  state.deviceListOpen = !state.deviceListOpen;
  if (state.deviceListOpen) ensureDevices(state);
}

async function armMonitor(state: SamplerState, deviceId: string | null): Promise<Monitor | null> {
  state.monitor?.stop();
  state.monitor = null;
  state.lastError = null;
  try {
    // currentMonitor is assigned right after startMonitoring resolves, below
    // — the ended-callback only ever fires later, asynchronously, so by the
    // time it can run this is already set. The identity check guards against
    // a stale callback from an OLDER monitor (already replaced by a newer
    // arm/re-record) clobbering state that no longer belongs to it.
    let currentMonitor: Monitor | null = null;
    const monitor = await startMonitoring(deviceId, () => {
      if (state.monitor === currentMonitor) {
        state.monitor = null;
        state.status = 'idle';
        state.lastError = 'input disconnected — capture ended unexpectedly';
      }
    });
    currentMonitor = monitor;
    state.monitor = monitor;
    state.status = 'monitoring';
    return monitor;
  } catch (err) {
    console.error('Failed to start input monitoring:', err);
    state.status = 'idle';
    state.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return null;
  }
}

export function selectDevice(entityId: string, deviceId: string | null): void {
  const state = samplerStateFor(entityId);
  state.inputDeviceId = deviceId;
  state.deviceListOpen = false;
  armMonitor(state, deviceId);
}

// this-sample.wav, sanitized and defaulted — used both when a trim first
// makes the clip exportable (commitTrim below) and whenever the name field
// changes afterward (see the name <input>'s own 'input' listener, which
// renames the already-registered export entry without re-encoding it).
function exportFileName(name: string): string {
  const trimmed = name.trim();
  const base = (trimmed.length > 0 ? trimmed : 'recording').replace(/[\\/:*?"<>|]/g, '_');
  return /\.wav$/i.test(base) ? base : `${base}.wav`;
}

// Commit the current trim into the owner's playback buffer, register a WAV
// encode of it for "Export samples" (ui/sampleArchive.ts — it already
// bundles any 'sample'-kind entity with a registered file, the same
// registry ui/sampleDrop.ts's dropped files use, so no changes were needed
// there), and audition the edge that just moved — the things every discrete
// marker adjustment (a drag release, or one nudge keypress) does, per the
// sampler's own spec: hear exactly where the moved edge landed. Not called
// on every intermediate pointermove of a drag in progress — see
// ui/interaction.ts's marker-drag handling — only once the adjustment is
// actually settled.
export function commitTrim(ownerId: string, state: SamplerState, edge: 'start' | 'end'): void {
  if (!state.recordedBuffer) return;
  const trimmed = sliceBuffer(state.recordedBuffer, state.trimStart, state.trimEnd);
  registerSampleBuffer(ownerId, trimmed);
  registerLoadedSampleFile(ownerId, { fileName: exportFileName(state.name), bytes: encodeWav(trimmed) });
  auditionClip(state.recordedBuffer, state.trimStart, state.trimEnd, edge);
}

// Idle/already-recorded -> arm monitoring (if not already) and start a fresh
// recording, discarding any previous take immediately (see below); recording
// -> stop, decode, and commit the whole thing as the initial trim (as if the
// end marker had just been placed), so there's audible feedback the instant
// recording stops, before any manual trim.
export async function toggleRecord(entityId: string, ownerId: string): Promise<void> {
  const state = samplerStateFor(entityId);

  if (state.status === 'recording' && state.recording) {
    const recording = state.recording;
    state.recording = null;
    const buffer = await recording.stop();
    state.recordedBuffer = buffer;
    state.trimStart = 0;
    state.trimEnd = buffer.duration;
    state.status = 'monitoring';
    state.recordingPeaks = []; // free the live-scroll history; drawWaveform takes over now
    commitTrim(ownerId, state, 'end');
    return;
  }

  // Pressing record again after a previous take discards it right away —
  // both so the scope immediately falls through to the live recording trace
  // (drawSamplerPopup's dispatch checks recordedBuffer first) rather than
  // still showing the old, now-stale waveform, and so the old clip's trim
  // points don't linger into whatever gets recorded next. The owner's
  // already-registered playback buffer (audio/graph.ts's sampleBuffers) is
  // left as-is until this new take is committed — its pad keeps playing the
  // previous recording in the meantime, same as any 'sample' entity's pad
  // does while nothing newer has replaced it yet.
  state.recordedBuffer = null;
  state.trimStart = 0;
  state.trimEnd = 0;

  let monitor = state.monitor;
  if (!monitor) monitor = await armMonitor(state, state.inputDeviceId);
  if (!monitor) return;

  state.recording = startRecording(monitor);
  state.status = 'recording';
  state.recordingPeaks = [];
  state.recordingStartedAt = performance.now();
}

// --- Popup layout ---------------------------------------------------------

interface SamplerLayout {
  popup: Rect;
  deviceRow: Rect;
  scope: Rect; // {x,y,width,height} center-based, matching Rect's own convention
  recordButton: Point;
  nameField: Rect;
}

export function samplerPopupRect(graph: EntityGraph, owner: Entity, drag?: DragContext): Rect {
  return popupRectFor(graph, owner, SAMPLER_POPUP_WIDTH, SAMPLER_POPUP_HEIGHT, drag);
}

function layoutFor(popup: Rect): SamplerLayout {
  const left = popup.x - popup.width / 2;
  const top = popup.y - popup.height / 2;
  const bottom = popup.y + popup.height / 2;

  const deviceRow: Rect = {
    x: popup.x,
    y: top + TITLE_HEIGHT + ROW_HEIGHT / 2 + 4,
    width: popup.width - PADDING * 2,
    height: ROW_HEIGHT,
  };
  const bottomRowY = bottom - PADDING - ROW_HEIGHT / 2;
  const recordButton: Point = { x: left + PADDING + 10, y: bottomRowY };
  const nameField: Rect = {
    x: left + PADDING + 28 + (popup.width - PADDING * 2 - 28) / 2,
    y: bottomRowY,
    width: popup.width - PADDING * 2 - 28,
    height: ROW_HEIGHT,
  };
  const scope: Rect = {
    x: popup.x,
    y: (deviceRow.y + deviceRow.height / 2 + 6 + (bottomRowY - ROW_HEIGHT / 2 - 6)) / 2,
    width: popup.width - PADDING * 2,
    height: bottomRowY - ROW_HEIGHT / 2 - 6 - (deviceRow.y + deviceRow.height / 2 + 6),
  };

  return { popup, deviceRow, scope, recordButton, nameField };
}

function scopeRectBounds(scope: Rect): { left: number; right: number; top: number; bottom: number } {
  return {
    left: scope.x - scope.width / 2,
    right: scope.x + scope.width / 2,
    top: scope.y - scope.height / 2,
    bottom: scope.y + scope.height / 2,
  };
}

// Always fits the WHOLE recording into the scope's width, stretched or
// compressed as needed — no scrolling once a recording is finished (that's
// only ever needed live, while still recording — see drawRecordingScroll's
// own fixed-rate scroll instead).
function pxPerSecondFor(scope: Rect, duration: number): number {
  const bounds = scopeRectBounds(scope);
  const width = bounds.right - bounds.left;
  return duration > 0 ? width / duration : width;
}

function timeToX(scope: Rect, pxPerSec: number, t: number): number {
  return scopeRectBounds(scope).left + t * pxPerSec;
}

function xToTime(scope: Rect, pxPerSec: number, x: number): number {
  return (x - scopeRectBounds(scope).left) / pxPerSec;
}

// --- Hit-testing -----------------------------------------------------------

export type SamplerPopupHit =
  | { entityId: string; ownerId: string; kind: 'close' }
  | { entityId: string; ownerId: string; kind: 'deviceRow' }
  | { entityId: string; ownerId: string; kind: 'deviceOption'; deviceId: string | null }
  | { entityId: string; ownerId: string; kind: 'record' }
  | { entityId: string; ownerId: string; kind: 'marker'; edge: 'start' | 'end' }
  | { entityId: string; ownerId: string; kind: 'nameField' }
  | { entityId: string; ownerId: string; kind: 'background' };

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function hitTestSamplerPopup(graph: EntityGraph, point: Point, drag?: DragContext): SamplerPopupHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'sampler' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;

    const popup = samplerPopupRect(graph, owner, drag);
    const layout = layoutFor(popup);
    const ownerId = owner.id;

    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, ownerId, kind: 'close' };
    }

    const state = samplerStateFor(entity.id);

    if (state.deviceListOpen) {
      const listTop = layout.deviceRow.y + layout.deviceRow.height / 2 + 2;
      const rowLeft = layout.deviceRow.x - layout.deviceRow.width / 2;
      const rowRight = layout.deviceRow.x + layout.deviceRow.width / 2;
      const options: Array<string | null> = [null, ...state.devices.map((d) => d.deviceId)];
      for (let i = 0; i < options.length; i++) {
        const optTop = listTop + i * DEVICE_OPTION_HEIGHT;
        // x-range only (not withinRow's y-band, which is the device row
        // itself — these options are drawn in a dropdown BELOW that row).
        if (point.x >= rowLeft && point.x <= rowRight && point.y >= optTop && point.y <= optTop + DEVICE_OPTION_HEIGHT) {
          return { entityId: entity.id, ownerId, kind: 'deviceOption', deviceId: options[i] };
        }
      }
    }

    if (withinRow(point, layout.deviceRow)) {
      return { entityId: entity.id, ownerId, kind: 'deviceRow' };
    }

    if (dist(point, layout.recordButton) <= 11) {
      return { entityId: entity.id, ownerId, kind: 'record' };
    }

    if (withinRow(point, layout.nameField)) {
      return { entityId: entity.id, ownerId, kind: 'nameField' };
    }

    if (state.recordedBuffer) {
      const pxPerSec = pxPerSecondFor(layout.scope, state.recordedBuffer.duration);
      const startX = timeToX(layout.scope, pxPerSec, state.trimStart);
      const endX = timeToX(layout.scope, pxPerSec, state.trimEnd);
      const bounds = scopeRectBounds(layout.scope);
      if (Math.abs(point.x - startX) <= MARKER_HIT_RADIUS && point.y >= bounds.top && point.y <= bounds.bottom) {
        return { entityId: entity.id, ownerId, kind: 'marker', edge: 'start' };
      }
      if (Math.abs(point.x - endX) <= MARKER_HIT_RADIUS && point.y >= bounds.top && point.y <= bounds.bottom) {
        return { entityId: entity.id, ownerId, kind: 'marker', edge: 'end' };
      }
    }

    // No dedicated 'scope' hit-kind — the finished waveform never scrolls
    // (see pxPerSecondFor), so there's nothing for a background scope-drag
    // to do; a click there just falls through to 'background' below.

    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return { entityId: entity.id, ownerId, kind: 'background' };
    }
  }
  return null;
}

function withinRow(point: Point, row: Rect): boolean {
  return (
    point.x >= row.x - row.width / 2 &&
    point.x <= row.x + row.width / 2 &&
    point.y >= row.y - row.height / 2 &&
    point.y <= row.y + row.height / 2
  );
}

// A collapsed sampler's porthole is hit-tested via ui/organelle.ts's generic
// hitTestPorthole (kind-agnostic) — no sampler-specific version needed here,
// unlike hitTestSamplerPopup above.

// --- Marker drag / keyboard nudge ------------------------------------------

// Live-drag update only — no commit/audition here (see commitTrim's own
// comment): dragging a marker gives continuous visual feedback, but only the
// drag's eventual release actually re-registers the playback buffer and
// plays a preview, so a fast drag doesn't fire overlapping auditions.
export function updateMarkerDrag(entityId: string, edge: 'start' | 'end', point: Point, layout: {
  scope: Rect;
  pxPerSec: number;
}): void {
  const state = samplerStateFor(entityId);
  if (!state.recordedBuffer) return;
  const t = Math.max(0, Math.min(state.recordedBuffer.duration, xToTime(layout.scope, layout.pxPerSec, point.x)));
  if (edge === 'start') {
    state.trimStart = Math.min(t, state.trimEnd);
  } else {
    state.trimEnd = Math.max(t, state.trimStart);
  }
}

export function scopeLayoutFor(graph: EntityGraph, entityId: string, drag?: DragContext): { scope: Rect; pxPerSec: number } | null {
  const feature = graph.get(entityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!feature || !owner) return null;
  const state = samplerStateFor(entityId);
  const popup = samplerPopupRect(graph, owner, drag);
  const layout = layoutFor(popup);
  const duration = state.recordedBuffer?.duration ?? 0;
  return { scope: layout.scope, pxPerSec: pxPerSecondFor(layout.scope, duration) };
}

// The single "current" marker Left/Right operates on — same global-
// selection idiom as ui/melody.ts's selectedItem, since there's exactly one
// "currently selected" concept regardless of how many sampler organelles
// happen to be open. Set on a marker click/drag-start (see
// ui/interaction.ts), cleared once its popup closes.
let selectedMarker: { entityId: string; ownerId: string; edge: 'start' | 'end' } | null = null;

export function selectMarker(entityId: string, ownerId: string, edge: 'start' | 'end'): void {
  selectedMarker = { entityId, ownerId, edge };
}

export function hasSelectedMarker(graph: EntityGraph): boolean {
  if (!selectedMarker) return false;
  const feature = graph.get(selectedMarker.entityId);
  if (!feature || !feature.expanded) {
    selectedMarker = null;
    return false;
  }
  return true;
}

export function nudgeSelectedMarker(direction: -1 | 1): void {
  if (!selectedMarker) return;
  const { entityId, ownerId, edge } = selectedMarker;
  const state = samplerStateFor(entityId);
  if (!state.recordedBuffer) return;
  const delta = direction * MARKER_NUDGE_SECONDS;
  if (edge === 'start') {
    state.trimStart = Math.max(0, Math.min(state.trimEnd, state.trimStart + delta));
  } else {
    state.trimEnd = Math.max(state.trimStart, Math.min(state.recordedBuffer.duration, state.trimEnd + delta));
  }
  commitTrim(ownerId, state, edge);
}

// --- Name field (floating HTML <input>) ------------------------------------
//
// The app's first DOM form control — everything else is drawn on the single
// <canvas id="stage">. A real <input> is used here (rather than a hand-
// rolled canvas text field) specifically for native cursor/selection/IME
// text editing, which would otherwise all need reimplementing from scratch.
// One reusable singleton, shown/repositioned each frame the owning popup is
// open (see drawSamplerPopup), hidden the rest of the time.

let nameInputEl: HTMLInputElement | null = null;
let nameInputEntityId: string | null = null;
// The owning Source entity (a direct object reference, kept in sync each
// frame by drawSamplerPopup, which already has it) — needed alongside
// nameInputEntityId so the 'input' listener below can mirror the typed name
// onto both the box label (Entity.label, read by ui/render.ts) and the
// export filename (ui/sampleDrop.ts's renameLoadedSampleFile), both of which
// are keyed by the OWNER's id, not the feature's.
let nameInputOwner: Entity | null = null;
let nameInputShownThisFrame = false;

function ensureNameInput(): HTMLInputElement {
  if (nameInputEl) return nameInputEl;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'name this sample…';
  input.style.position = 'fixed';
  input.style.display = 'none';
  input.style.boxSizing = 'border-box';
  input.style.font = '11px monospace';
  input.style.color = '#e8dcc0';
  input.style.background = 'rgba(0, 0, 0, 0.55)';
  input.style.border = '1px solid rgba(255, 255, 255, 0.25)';
  input.style.borderRadius = '3px';
  input.style.padding = '2px 6px';
  input.style.zIndex = '2';
  input.addEventListener('input', () => {
    if (!nameInputEntityId) return;
    const state = samplerStateFor(nameInputEntityId);
    state.name = input.value;
    if (nameInputOwner) {
      // Falls back to the generic "sample" box label (ui/render.ts's
      // entity.label ?? entity.kind) once the field's emptied out again,
      // rather than leaving it pinned to whatever was last typed.
      nameInputOwner.label = input.value.trim().length > 0 ? input.value : undefined;
      // A no-op until something's actually been recorded/committed (see
      // commitTrim, which is what first registers an export entry) —
      // nothing to rename before that.
      renameLoadedSampleFile(nameInputOwner.id, exportFileName(input.value));
    }
  });
  document.body.appendChild(input);
  nameInputEl = input;
  return input;
}

function hideNameInput(): void {
  if (nameInputEl) nameInputEl.style.display = 'none';
  nameInputEntityId = null;
  nameInputOwner = null;
}

// canvas isn't CSS-scaled (see ui/dock.ts's own comment on the same mapping)
// so canvas-content coordinates convert to viewport pixels with a single
// subtract-scroll-then-add-canvas-offset step.
function contentPointToScreen(canvas: HTMLCanvasElement, point: Point): Point {
  const rect = canvas.getBoundingClientRect();
  const viewport = canvas.parentElement as HTMLElement;
  return {
    x: rect.left + (point.x - viewport.scrollLeft),
    y: rect.top + (point.y - viewport.scrollTop),
  };
}

export function focusNameField(entityId: string): void {
  if (nameInputEl && nameInputEntityId === entityId) nameInputEl.focus();
}

export function beginSamplerFrame(): void {
  nameInputShownThisFrame = false;
}

export function endSamplerFrame(): void {
  if (!nameInputShownThisFrame) hideNameInput();
}

// --- Drawing ---------------------------------------------------------------

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const SCOPE_BG = 'rgba(0, 0, 0, 0.35)';
const TRACE_COLOR = 'rgba(126, 200, 80, 0.9)'; // monitoring (pre-record) — green
const RECORDING_TRACE_COLOR = 'rgba(224, 80, 80, 0.9)'; // recording — matches the record button's red
const MARKER_COLOR = 'rgba(232, 220, 192, 0.9)';

function drawScopeFrame(ctx: CanvasRenderingContext2D, scope: Rect): void {
  const b = scopeRectBounds(scope);
  ctx.fillStyle = SCOPE_BG;
  ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
}

function drawLiveTrace(ctx: CanvasRenderingContext2D, scope: Rect, state: SamplerState): void {
  const analyser = state.monitor?.analyser;
  if (!analyser) return;
  if (state.liveTrace.length !== analyser.fftSize) state.liveTrace = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(state.liveTrace);

  const b = scopeRectBounds(scope);
  const width = b.right - b.left;
  const midY = (b.top + b.bottom) / 2;
  const halfHeight = (b.bottom - b.top) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(b.left, b.top, width, b.bottom - b.top);
  ctx.clip();
  ctx.strokeStyle = TRACE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < state.liveTrace.length; i++) {
    const x = b.left + (i / (state.liveTrace.length - 1)) * width;
    const y = midY - state.liveTrace[i] * halfHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// Appends however many RECORDING_PX_PER_SECOND-th-of-a-second columns have
// elapsed since the last draw, each holding the analyser's CURRENT peak at
// the moment it's appended — an approximation (a real DAW-style record meter
// samples "now," not a perfectly reconstructed history of every sample
// since), not the actually-captured audio sample-for-sample. That's fine
// here: the real captured samples are safe in the worklet's own accumulating
// buffer (audio/samplerCapture.ts) regardless of this trace's accuracy, and
// once recording stops drawWaveform draws the true, exact waveform from that
// buffer — this is only ever the live "something's happening" feedback.
function appendRecordingColumns(state: SamplerState, now: number): void {
  const analyser = state.monitor?.analyser;
  if (!analyser) return;
  if (state.liveTrace.length !== analyser.fftSize) state.liveTrace = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(state.liveTrace);

  let min = 1;
  let max = -1;
  for (const v of state.liveTrace) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const columnPeriodMs = 1000 / RECORDING_PX_PER_SECOND;
  const targetColumns = Math.floor((now - state.recordingStartedAt) / columnPeriodMs);
  while (state.recordingPeaks.length < targetColumns) {
    state.recordingPeaks.push({ min, max });
  }
}

// The live scrolling trace while status === 'recording': grows in from the
// left as columns accumulate, then — once there are more columns than fit
// the scope's width — only the most recent `width` columns are shown, so
// newly-recorded audio keeps entering at the right edge and older content
// scrolls off the left, continuously, for as long as recording continues.
function drawRecordingScroll(ctx: CanvasRenderingContext2D, scope: Rect, state: SamplerState, now: number): void {
  appendRecordingColumns(state, now);

  const b = scopeRectBounds(scope);
  const width = Math.floor(b.right - b.left);
  const midY = (b.top + b.bottom) / 2;
  const halfHeight = (b.bottom - b.top) / 2;
  const visible = state.recordingPeaks.slice(Math.max(0, state.recordingPeaks.length - width));

  ctx.save();
  ctx.beginPath();
  ctx.rect(b.left, b.top, width, b.bottom - b.top);
  ctx.clip();
  ctx.strokeStyle = RECORDING_TRACE_COLOR;
  ctx.lineWidth = 1;
  for (let i = 0; i < visible.length; i++) {
    const x = b.left + i;
    ctx.beginPath();
    ctx.moveTo(x, midY - visible[i].max * halfHeight);
    ctx.lineTo(x, midY - visible[i].min * halfHeight);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWaveform(ctx: CanvasRenderingContext2D, scope: Rect, state: SamplerState): void {
  const buffer = state.recordedBuffer!;
  const b = scopeRectBounds(scope);
  const width = b.right - b.left;
  const midY = (b.top + b.bottom) / 2;
  const halfHeight = (b.bottom - b.top) / 2;
  const pxPerSec = pxPerSecondFor(scope, buffer.duration);
  const data = buffer.getChannelData(0);
  const samplesPerPx = buffer.sampleRate / pxPerSec;

  ctx.save();
  ctx.beginPath();
  ctx.rect(b.left, b.top, width, b.bottom - b.top);
  ctx.clip();
  ctx.strokeStyle = TRACE_COLOR;
  ctx.lineWidth = 1;
  for (let px = 0; px < width; px++) {
    const t = px / pxPerSec;
    const startSample = Math.floor(t * buffer.sampleRate);
    const endSample = Math.min(data.length, Math.ceil(startSample + samplesPerPx));
    if (startSample >= data.length) break;
    let min = 1;
    let max = -1;
    for (let s = Math.max(0, startSample); s < endSample; s++) {
      const v = data[s];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) continue; // empty window (shouldn't normally happen)
    const x = b.left + px;
    ctx.beginPath();
    ctx.moveTo(x, midY - max * halfHeight);
    ctx.lineTo(x, midY - min * halfHeight);
    ctx.stroke();
  }
  ctx.restore();

  // Dim the trimmed-away head/tail so the kept [trimStart, trimEnd) region
  // reads as visually distinct, then draw the two marker lines on top.
  const startX = timeToX(scope, pxPerSec, state.trimStart);
  const endX = timeToX(scope, pxPerSec, state.trimEnd);
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.left, b.top, width, b.bottom - b.top);
  ctx.clip();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  if (startX > b.left) ctx.fillRect(b.left, b.top, Math.min(width, startX - b.left), b.bottom - b.top);
  if (endX < b.right) ctx.fillRect(Math.max(b.left, endX), b.top, b.right - Math.max(b.left, endX), b.bottom - b.top);
  ctx.restore();

  for (const x of [startX, endX]) {
    if (x < b.left - 1 || x > b.right + 1) continue;
    ctx.save();
    ctx.strokeStyle = MARKER_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, b.top);
    ctx.lineTo(x, b.bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 4, b.top);
    ctx.lineTo(x + 4, b.top);
    ctx.lineTo(x, b.top + 6);
    ctx.closePath();
    ctx.fillStyle = MARKER_COLOR;
    ctx.fill();
    ctx.restore();
  }
}

function drawRecordButton(ctx: CanvasRenderingContext2D, p: Point, status: SamplerState['status']): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = status === 'recording' ? '#e05050' : 'rgba(224, 80, 80, 0.6)';
  if (status === 'recording') {
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function deviceLabel(state: SamplerState): string {
  if (!state.inputDeviceId) return 'default input';
  const device = state.devices.find((d) => d.deviceId === state.inputDeviceId);
  return device?.label || 'input device';
}

export function drawSamplerPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  canvas: HTMLCanvasElement,
  now: number,
  drag?: DragContext
): void {
  const state = samplerStateFor(entity.id);
  const popup = samplerPopupRect(graph, owner, drag);
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
  ctx.fillText('sampler', left + 10, top + TITLE_HEIGHT / 2);

  // Input sample rate, right-aligned in the same title row, once a device
  // is actually monitoring — this is what would have made the BlackHole
  // sample-rate mismatch (this session's actual bug) visible immediately
  // instead of only showing up later as a capture failure with no obvious
  // cause. Flagged in a warning color whenever it differs from the
  // AudioContext's own rate (everything else in the graph runs at that
  // rate; a device feeding samples at a different one is exactly the
  // mismatch that caused the failure).
  if (state.monitor?.sampleRate) {
    const contextRate = Math.round(getAudioContext().sampleRate);
    const deviceRate = Math.round(state.monitor.sampleRate);
    const mismatched = deviceRate !== contextRate;
    ctx.fillStyle = mismatched ? 'rgba(224, 150, 80, 0.95)' : 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'right';
    const label = mismatched ? `${deviceRate} Hz ≠ ctx ${contextRate} Hz` : `${deviceRate} Hz`;
    ctx.fillText(label, close.x - CLOSE_BUTTON_RADIUS - 8, top + TITLE_HEIGHT / 2);
    ctx.textAlign = 'left';
  }

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

  // Device row
  ctx.fillStyle = state.deviceListOpen ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(
    layout.deviceRow.x - layout.deviceRow.width / 2,
    layout.deviceRow.y - layout.deviceRow.height / 2,
    layout.deviceRow.width,
    layout.deviceRow.height
  );
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`◂ ${deviceLabel(state)} ▸`, layout.deviceRow.x - layout.deviceRow.width / 2 + 6, layout.deviceRow.y);

  if (state.deviceListOpen) {
    const listTop = layout.deviceRow.y + layout.deviceRow.height / 2 + 2;
    const options: Array<{ id: string | null; label: string }> = [
      { id: null, label: 'default input' },
      ...state.devices.map((d, i) => ({ id: d.deviceId, label: d.label || `microphone ${i + 1}` })),
    ];
    ctx.save();
    ctx.fillStyle = 'rgba(10, 10, 10, 0.96)';
    ctx.fillRect(
      layout.deviceRow.x - layout.deviceRow.width / 2,
      listTop,
      layout.deviceRow.width,
      options.length * DEVICE_OPTION_HEIGHT
    );
    for (let i = 0; i < options.length; i++) {
      const y = listTop + i * DEVICE_OPTION_HEIGHT + DEVICE_OPTION_HEIGHT / 2;
      if (options[i].id === state.inputDeviceId) {
        ctx.fillStyle = ACCENT;
        ctx.fillText('•', layout.deviceRow.x - layout.deviceRow.width / 2 + 2, y);
      }
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillText(options[i].label, layout.deviceRow.x - layout.deviceRow.width / 2 + 12, y);
    }
    ctx.restore();
  }

  // Scope: recorded waveform (static, whole clip fit to width) once there is
  // one, regardless of current status — otherwise the live trace, in one of
  // two styles: a redrawn-in-place oscilloscope snapshot while just
  // monitoring, or the scrolling recording trace (distinct color) once
  // record has actually been pressed. Checked in this order since 'status'
  // is 'recording', never 'monitoring', while actually recording.
  drawScopeFrame(ctx, layout.scope);
  if (state.recordedBuffer) {
    drawWaveform(ctx, layout.scope, state);
  } else if (state.status === 'recording') {
    drawRecordingScroll(ctx, layout.scope, state, now);
  } else if (state.status === 'monitoring') {
    drawLiveTrace(ctx, layout.scope, state);
  } else {
    ctx.save();
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (state.lastError) {
      // A failed getUserMedia attempt (permission denied, or a constraint
      // the device can't satisfy) — shown here rather than only logged to
      // console, so it doesn't look identical to "no device chosen yet".
      ctx.fillStyle = 'rgba(224, 120, 120, 0.85)';
      ctx.fillText('input failed:', layout.scope.x, layout.scope.y - 6);
      ctx.fillText(state.lastError, layout.scope.x, layout.scope.y + 6);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillText('pick an input to monitor', layout.scope.x, layout.scope.y);
    }
    ctx.restore();
  }

  // Record button
  drawRecordButton(ctx, layout.recordButton, state.status);

  // Name field — the canvas draws only the field's frame; the actual text
  // editing happens in the real <input> positioned on top of it (see
  // ensureNameInput/contentPointToScreen below).
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    layout.nameField.x - layout.nameField.width / 2,
    layout.nameField.y - layout.nameField.height / 2,
    layout.nameField.width,
    layout.nameField.height
  );

  ctx.restore();

  // Position the floating name <input> over the field just drawn.
  const input = ensureNameInput();
  if (nameInputEntityId !== entity.id) {
    input.value = state.name;
    nameInputEntityId = entity.id;
  }
  nameInputOwner = owner; // kept fresh every frame — see its own declaration
  const topLeftContent = { x: layout.nameField.x - layout.nameField.width / 2, y: layout.nameField.y - layout.nameField.height / 2 };
  const screen = contentPointToScreen(canvas, topLeftContent);
  input.style.left = `${screen.x}px`;
  input.style.top = `${screen.y}px`;
  input.style.width = `${layout.nameField.width}px`;
  input.style.height = `${layout.nameField.height}px`;
  input.style.display = 'block';
  nameInputShownThisFrame = true;
}
