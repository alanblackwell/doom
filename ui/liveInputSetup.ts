// Geometry, state, hit-testing, and drawing for the live-input setup
// organelle (EntityType 'feature', kind 'liveInputSetup' — see
// audio/entityGraph.ts and ui/organelle.ts's porthole/popup mechanism,
// reused unchanged for the collapsed/expanded toggle and popup anchoring).
//
// The owning Source is always kind 'liveInput' (audio/graph.ts's 'liveInput'
// case). Unlike ui/sampler.ts — which captures a mic into a STATIC buffer,
// then never touches it again once recording stops — this organelle's job
// is to open (and keep open) a genuinely live, ongoing connection into the
// composition graph: picking a device and pressing Connect wires a real
// MediaStreamAudioSourceNode straight into the owner's own audio chain
// (audio/graph.ts's `liveInputSourceGains` registry), where it stays for as
// long as the owner is on canvas — closing this popup does NOT tear that
// down (unlike ui/sampler.ts's own close button), since the whole point of
// a live channel is to keep running once it's set up and the panel is
// tucked away. It's ui/docking.ts's dockEntity that releases it — parking
// the instrument is the "put this away" gesture, matching the same
// privacy-on-dock convention ui/sampler.ts/ui/grainSampler.ts already use.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, closeButtonPosition, registerFeaturePopupSize, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { getLiveInputSourceGain } from '../audio/graph';
import { getAudioContext } from '../audio/context';
import { listInputDevices, startMonitoring } from '../audio/samplerCapture';
import type { Monitor } from '../audio/samplerCapture';
import { ACCENT } from './palette';
import { MONO_FONT_FAMILY } from './monoFont';

export const LIVE_INPUT_POPUP_WIDTH = 220;
export const LIVE_INPUT_POPUP_HEIGHT = 140;
registerFeaturePopupSize('liveInputSetup', LIVE_INPUT_POPUP_WIDTH, LIVE_INPUT_POPUP_HEIGHT);

const PADDING = 10;
const ROW_HEIGHT = 20;
const DEVICE_OPTION_HEIGHT = 18;

export interface LiveInputSetupState {
  inputDeviceId: string | null;
  devices: MediaDeviceInfo[];
  deviceListOpen: boolean;
  status: 'idle' | 'connecting' | 'live' | 'error';
  monitor: Monitor | null;
  // Set when connectLiveInput's getUserMedia call rejects, or the OS/browser
  // ends the track later on its own — shown in the status row in place of
  // the idle placeholder, same "visible, not just logged" idiom as
  // ui/sampler.ts's own lastError.
  lastError: string | null;
  // Reused each frame for the level meter — avoids reallocating a
  // Float32Array every animation frame (same idiom as ui/sampler.ts's own
  // liveTrace).
  levelTrace: Float32Array<ArrayBuffer>;
}

// Keyed by the setup feature entity's own id — same side-registry idiom as
// ui/sampler.ts's `samplers` (Entity.params is plain Record<string, number>,
// no room for a MediaStream/device list).
const setups = new Map<string, LiveInputSetupState>();

export function liveInputSetupStateFor(entityId: string): LiveInputSetupState {
  let state = setups.get(entityId);
  if (!state) {
    state = {
      inputDeviceId: null,
      devices: [],
      deviceListOpen: false,
      status: 'idle',
      monitor: null,
      lastError: null,
      levelTrace: new Float32Array(1024),
    };
    setups.set(entityId, state);
  }
  return state;
}

// Mirrors `status === 'live'` above, but keyed by the OWNER entity's id
// rather than this feature's own — ui/render.ts's drawBox only ever sees the
// 'liveInput' Source entity itself (no entity graph in hand there to walk
// from owner to its setup feature), so it needs a cheap owner-id lookup to
// dim the box until something's actually connected. Kept in sync by
// connectLiveInput/disconnectLiveInput below.
const liveOwnerIds = new Set<string>();

export function isLiveInputConnected(ownerId: string): boolean {
  return liveOwnerIds.has(ownerId);
}

async function ensureDevices(state: LiveInputSetupState): Promise<void> {
  if (state.devices.length > 0) return;
  try {
    state.devices = await listInputDevices();
  } catch (err) {
    console.error('Failed to enumerate audio input devices:', err);
  }
}

export function toggleDeviceList(entityId: string): void {
  const state = liveInputSetupStateFor(entityId);
  state.deviceListOpen = !state.deviceListOpen;
  if (state.deviceListOpen) ensureDevices(state);
}

// Opens (or re-opens, for a device switch) a real getUserMedia stream and
// wires it straight into the owner's `sourceInput` gain node (audio/graph.ts's
// 'liveInput' case) — unlike ui/sampler.ts's armMonitor, this is a genuine,
// ongoing graph connection, not just an analyser tap. `ownerId` is the
// 'liveInput' Source entity's own id, distinct from `entityId` (this setup
// feature's own id, used only for state lookup) — same split as
// ui/sampler.ts's armMonitor(state, ...) vs. commitTrim(ownerId, ...).
export async function connectLiveInput(entityId: string, ownerId: string, deviceId: string | null): Promise<void> {
  const state = liveInputSetupStateFor(entityId);
  state.monitor?.stop();
  state.monitor = null;
  liveOwnerIds.delete(ownerId);
  state.status = 'connecting';
  state.lastError = null;
  state.inputDeviceId = deviceId;

  const sourceInput = getLiveInputSourceGain(ownerId);
  if (!sourceInput) {
    // The owner's own audio nodes don't exist yet (docked before "start
    // audio" was ever pressed, or the engine genuinely isn't running) —
    // same "nothing to connect into yet" case audio/graph.ts's other
    // async-resource registries (sampleBuffers) tolerate silently, just
    // surfaced here since this popup has a status row to show it in.
    state.status = 'error';
    state.lastError = 'not ready yet — start audio first';
    return;
  }

  try {
    // currentMonitor is assigned right after startMonitoring resolves,
    // below — the ended-callback only ever fires later, asynchronously, so
    // by the time it can run this is already set. The identity check guards
    // against a stale callback from an OLDER monitor (already replaced by a
    // newer connect/device switch) clobbering state that no longer belongs
    // to it — same guard as ui/sampler.ts's own armMonitor.
    let currentMonitor: Monitor | null = null;
    const monitor = await startMonitoring(deviceId, () => {
      if (state.monitor === currentMonitor) {
        state.monitor = null;
        state.status = 'idle';
        state.lastError = 'input disconnected — capture ended unexpectedly';
        liveOwnerIds.delete(ownerId);
      }
    });
    currentMonitor = monitor;
    monitor.source.connect(sourceInput);
    state.monitor = monitor;
    state.status = 'live';
    liveOwnerIds.add(ownerId);
  } catch (err) {
    console.error('Failed to connect live input:', err);
    state.status = 'error';
    state.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}

// Explicit "take this mic out of the mix" — releases the stream entirely
// (mirrors ui/sampler.ts's Monitor.stop(), which both disconnects and stops
// every track) rather than just disconnecting the one edge into sourceInput,
// so the OS's own mic-active indicator actually goes dark. Also what
// ui/docking.ts's dockEntity calls when the owner is parked in the dock.
export function disconnectLiveInput(entityId: string, ownerId: string): void {
  const state = liveInputSetupStateFor(entityId);
  state.monitor?.stop();
  state.monitor = null;
  state.status = 'idle';
  liveOwnerIds.delete(ownerId);
}

export function selectDevice(entityId: string, ownerId: string, deviceId: string | null): void {
  const state = liveInputSetupStateFor(entityId);
  state.deviceListOpen = false;
  // Switching devices while already connected (or mid-connect) reconnects
  // at the new device immediately, rather than silently dropping the live
  // channel out of the mix until the next explicit Connect press.
  if (state.status === 'live' || state.status === 'connecting') {
    connectLiveInput(entityId, ownerId, deviceId);
  } else {
    state.inputDeviceId = deviceId;
  }
}

export function toggleConnect(entityId: string, ownerId: string): void {
  const state = liveInputSetupStateFor(entityId);
  if (state.status === 'live' || state.status === 'connecting') {
    disconnectLiveInput(entityId, ownerId);
  } else {
    connectLiveInput(entityId, ownerId, state.inputDeviceId);
  }
}

// --- Popup layout -----------------------------------------------------

interface LiveInputLayout {
  popup: Rect;
  deviceRow: Rect;
  statusRow: Rect;
  meterRow: Rect;
  connectButton: Rect;
}

export function liveInputSetupPopupRect(graph: EntityGraph, owner: Entity, drag?: DragContext): Rect {
  return popupRectFor(graph, owner, LIVE_INPUT_POPUP_WIDTH, LIVE_INPUT_POPUP_HEIGHT, drag);
}

function layoutFor(popup: Rect): LiveInputLayout {
  const left = popup.x - popup.width / 2;
  const top = popup.y - popup.height / 2;
  const bottom = popup.y + popup.height / 2;

  const deviceRow: Rect = {
    x: popup.x,
    y: top + TITLE_HEIGHT + ROW_HEIGHT / 2 + 4,
    width: popup.width - PADDING * 2,
    height: ROW_HEIGHT,
  };
  const statusRow: Rect = {
    x: popup.x,
    y: deviceRow.y + deviceRow.height / 2 + 8 + 7,
    width: popup.width - PADDING * 2,
    height: 14,
  };
  const meterRow: Rect = {
    x: popup.x,
    y: statusRow.y + statusRow.height / 2 + 6 + 6,
    width: popup.width - PADDING * 2,
    height: 10,
  };
  const connectButton: Rect = {
    x: popup.x,
    y: bottom - PADDING - ROW_HEIGHT / 2,
    width: popup.width - PADDING * 2,
    height: ROW_HEIGHT,
  };

  return { popup, deviceRow, statusRow, meterRow, connectButton };
}

function withinRow(point: Point, row: Rect): boolean {
  return (
    point.x >= row.x - row.width / 2 &&
    point.x <= row.x + row.width / 2 &&
    point.y >= row.y - row.height / 2 &&
    point.y <= row.y + row.height / 2
  );
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --- Hit-testing --------------------------------------------------------

export type LiveInputPopupHit =
  | { entityId: string; ownerId: string; kind: 'close' }
  | { entityId: string; ownerId: string; kind: 'deviceRow' }
  | { entityId: string; ownerId: string; kind: 'deviceOption'; deviceId: string | null }
  | { entityId: string; ownerId: string; kind: 'connect' }
  | { entityId: string; ownerId: string; kind: 'background' };

export function hitTestLiveInputSetupPopup(graph: EntityGraph, point: Point, drag?: DragContext): LiveInputPopupHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'liveInputSetup' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;

    const popup = liveInputSetupPopupRect(graph, owner, drag);
    const layout = layoutFor(popup);
    const ownerId = owner.id;

    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, ownerId, kind: 'close' };
    }

    const state = liveInputSetupStateFor(entity.id);
    if (state.deviceListOpen) {
      const listTop = layout.deviceRow.y + layout.deviceRow.height / 2 + 2;
      const rowLeft = layout.deviceRow.x - layout.deviceRow.width / 2;
      const rowRight = layout.deviceRow.x + layout.deviceRow.width / 2;
      const options: Array<string | null> = [null, ...state.devices.map((d) => d.deviceId)];
      for (let i = 0; i < options.length; i++) {
        const optTop = listTop + i * DEVICE_OPTION_HEIGHT;
        if (point.x >= rowLeft && point.x <= rowRight && point.y >= optTop && point.y <= optTop + DEVICE_OPTION_HEIGHT) {
          return { entityId: entity.id, ownerId, kind: 'deviceOption', deviceId: options[i] };
        }
      }
    }

    if (withinRow(point, layout.deviceRow)) {
      return { entityId: entity.id, ownerId, kind: 'deviceRow' };
    }

    if (withinRow(point, layout.connectButton)) {
      return { entityId: entity.id, ownerId, kind: 'connect' };
    }

    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return { entityId: entity.id, ownerId, kind: 'background' };
    }
  }
  return null;
}

// A collapsed setup organelle's porthole is hit-tested via
// ui/organelle.ts's generic hitTestPorthole (kind-agnostic) — no
// liveInputSetup-specific version needed here, same as the sampler's own.

// --- Drawing -------------------------------------------------------------

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const LIVE_COLOR = 'rgba(126, 200, 80, 0.9)'; // matches sampler's own monitoring/live green
const ERROR_COLOR = 'rgba(224, 120, 120, 0.85)';
const METER_BG = 'rgba(0, 0, 0, 0.35)';
const METER_WARN_FRACTION = 0.85; // past this, the meter tints toward a clip warning

function deviceLabel(state: LiveInputSetupState): string {
  if (!state.inputDeviceId) return 'default input';
  const device = state.devices.find((d) => d.deviceId === state.inputDeviceId);
  return device?.label || 'input device';
}

function currentPeak(state: LiveInputSetupState): number {
  const analyser = state.monitor?.analyser;
  if (!analyser) return 0;
  if (state.levelTrace.length !== analyser.fftSize) state.levelTrace = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(state.levelTrace);
  let peak = 0;
  for (const v of state.levelTrace) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return peak;
}

function drawMeter(ctx: CanvasRenderingContext2D, row: Rect, peak: number): void {
  const left = row.x - row.width / 2;
  const top = row.y - row.height / 2;
  ctx.fillStyle = METER_BG;
  ctx.fillRect(left, top, row.width, row.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, row.width, row.height);

  const fraction = Math.min(1, peak);
  if (fraction <= 0) return;
  ctx.fillStyle = fraction >= METER_WARN_FRACTION ? 'rgba(224, 150, 80, 0.9)' : LIVE_COLOR;
  ctx.fillRect(left, top, row.width * fraction, row.height);
}

function statusText(state: LiveInputSetupState): { text: string; color: string } {
  if (state.lastError) return { text: state.lastError, color: ERROR_COLOR };
  switch (state.status) {
    case 'live':
      return { text: 'live', color: LIVE_COLOR };
    case 'connecting':
      return { text: 'connecting…', color: 'rgba(255, 255, 255, 0.5)' };
    default:
      return { text: 'not connected', color: 'rgba(255, 255, 255, 0.3)' };
  }
}

export function drawLiveInputSetupPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  now: number,
  drag?: DragContext
): void {
  const state = liveInputSetupStateFor(entity.id);
  const popup = liveInputSetupPopupRect(graph, owner, drag);
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
  ctx.font = `10px ${MONO_FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('live input', left + 10, top + TITLE_HEIGHT / 2);

  // Input sample rate, right-aligned in the title row, once actually
  // connected — same diagnostic ui/sampler.ts's own popup shows, reused
  // verbatim: a rate mismatch against the AudioContext's own is exactly the
  // failure mode that already bit this app once with a virtual/aggregate
  // device (see audio/samplerCapture.ts's own comment).
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
  ctx.font = `10px ${MONO_FONT_FAMILY}`;
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

  // Status row
  const status = statusText(state);
  ctx.fillStyle = status.color;
  ctx.font = `9px ${MONO_FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.fillText(status.text, layout.statusRow.x - layout.statusRow.width / 2, layout.statusRow.y);

  // Level meter — reads the monitor's analyser whenever one is open
  // (connecting/live), even independent of whether it's status 'live'
  // (wired into the mix) yet, so a connect-in-progress or an errored-out
  // stream that's still technically open shows real signal presence.
  drawMeter(ctx, layout.meterRow, currentPeak(state));

  // Connect / Disconnect button
  const connecting = state.status === 'connecting';
  const live = state.status === 'live';
  ctx.fillStyle = live ? 'rgba(126, 200, 80, 0.18)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(
    layout.connectButton.x - layout.connectButton.width / 2,
    layout.connectButton.y - layout.connectButton.height / 2,
    layout.connectButton.width,
    layout.connectButton.height
  );
  ctx.strokeStyle = live ? LIVE_COLOR : 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    layout.connectButton.x - layout.connectButton.width / 2,
    layout.connectButton.y - layout.connectButton.height / 2,
    layout.connectButton.width,
    layout.connectButton.height
  );
  ctx.fillStyle = live ? LIVE_COLOR : 'rgba(255, 255, 255, 0.7)';
  ctx.font = `10px ${MONO_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(connecting ? 'connecting…' : live ? 'disconnect' : 'connect', layout.connectButton.x, layout.connectButton.y);

  ctx.restore();
  void now; // reserved for a future level-decay/peak-hold animation, unused for now
}
