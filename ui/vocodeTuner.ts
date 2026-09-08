// The 'vocode' pedal's own by-ear f0-correction organelle (EntityType
// 'feature', kind 'vocodeTuner') — NOT built on ui/tuningOrganelle.ts's
// shared factory (that's for a column of by-ear CONSTANT sliders; this is
// one live spectrum histogram plus one draggable frequency marker, a
// genuinely different shape). Deliberately keeps no captured audio at all
// — everything here is a transient tap on the pedal's own live input,
// live-updating while the popup is open and fully torn down the instant
// it's closed (endVocodeTunerFrame below). The only thing that outlives a
// session is a plain number: the owning pedal's own `entity.params.f0`
// (written by audio/graph.ts's analyzeAndApplyVocode), which is what
// actually drives the resynthesis engine's formant extraction — this
// organelle is a way to CORRECT that number by ear, not a sample editor
// like ui/grainSampler.ts's own capture-and-keep spectrogram.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, closeButtonPosition, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { getEntityNodes, analyzeAndApplyVocode, setVocodeMode } from '../audio/graph';
import { getAudioContext } from '../audio/context';
import { getMasterChain } from '../audio/master';
import { ACCENT } from './palette';

export const VOCODE_TUNER_POPUP_WIDTH = 320;
export const VOCODE_TUNER_POPUP_HEIGHT = 210;
const PADDING = 10;
const HIST_HEIGHT = 110;
const AXIS_HEIGHT = 26; // draggable band below the bars, where the marker caret lives
const REANALYZE_BUTTON_HEIGHT = 22;

const AXIS_MIN_HZ = 20;
const AXIS_MAX_HZ = 2000;
const DEFAULT_F0 = 110; // seeded when a pedal's own params.f0 has never been set (no analysis has run yet)
const BAR_COUNT = 48;

// A live display tap, separate from audio/graph.ts's own one-shot analysis
// snapshot — but sized the same (8192) rather than smaller: this drone's
// fundamental is exactly what lives in the low end of the histogram
// (20-200ish Hz), and a smaller FFT's coarser per-bin resolution down
// there would make adjacent log-spaced bars collapse onto the same bin,
// reading as blockier than the bar count implies right where precision
// matters most. A drone barely changes over the resulting ~185ms window,
// so the extra latency this trades for resolution costs nothing perceptually.
const LIVE_ANALYSER_FFT_SIZE = 8192;
const TONE_GAIN = 0.12;
const MONITOR_GAIN = 0.35;
const REANALYZE_THROTTLE_MS = 80; // coalesces rapid marker-drag re-analysis, same idiom as audio/graph.ts's own reverb decay-regen throttle

// The pedal's own resynthesis engines (audio/vocodePlayer.ts's oscillator/
// formant-bank vocoder, audio/vocodeGranularPlayer.ts's granular/overlap-
// add pitch shifter) — index into this array IS entity.params.mode
// (audio/graph.ts's setVocodeMode). Extending this array is the whole
// mechanism for offering further modes (e.g. a future WSOLA engine) the
// same way.
const VOCODE_MODES = ['vocoder', 'granular'] as const;

function hzFromX(left: number, right: number, x: number): number {
  const t = right > left ? Math.min(1, Math.max(0, (x - left) / (right - left))) : 0;
  return AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, t);
}

function xFromHz(left: number, right: number, hz: number): number {
  const t = Math.log(Math.max(AXIS_MIN_HZ, hz) / AXIS_MIN_HZ) / Math.log(AXIS_MAX_HZ / AXIS_MIN_HZ);
  return left + Math.min(1, Math.max(0, t)) * (right - left);
}

interface VocodeTunerState {
  wasOpen: boolean;
  markerHz: number;
  // Whether the pointer is currently held down inside the handle — the
  // reference sine only sounds while this is true (see pressVocodeTunerHandle/
  // releaseVocodeTunerHandle below); also drives the handle's own
  // open-vs-filled drawing.
  handlePressed: boolean;
  analyser: AnalyserNode | null;
  monitorGain: GainNode | null;
  toneOsc: OscillatorNode | null;
  toneGain: GainNode | null;
  reanalyzeTimer: ReturnType<typeof setTimeout> | null;
  // Reused each frame for the live bar display, same "one scratch buffer per
  // feature, resized only if fftSize ever changes" idiom as ui/sampler.ts's
  // own liveTrace.
  freqData: Float32Array<ArrayBuffer> | null;
}

const statesByEntity = new Map<string, VocodeTunerState>();

function vocodeTunerStateFor(entityId: string): VocodeTunerState {
  let state = statesByEntity.get(entityId);
  if (!state) {
    state = {
      wasOpen: false,
      markerHz: DEFAULT_F0,
      handlePressed: false,
      analyser: null,
      monitorGain: null,
      toneOsc: null,
      toneGain: null,
      reanalyzeTimer: null,
      freqData: null,
    };
    statesByEntity.set(entityId, state);
  }
  return state;
}

// --- Session lifecycle ---------------------------------------------------

function startSession(state: VocodeTunerState, owner: Entity): void {
  const nodes = getEntityNodes(owner.id);
  if (!nodes) return;
  const ctx = getAudioContext();
  const master = getMasterChain();

  state.markerHz = owner.params.f0 ?? DEFAULT_F0;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = LIVE_ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6; // a live meter, not a one-shot snapshot — some temporal smoothing reads better than a jittery raw trace
  nodes.input.connect(analyser);
  state.analyser = analyser;
  state.freqData = new Float32Array(analyser.frequencyBinCount);

  // Dry monitor tap — "the sound" the sine tone is tuned against, per this
  // organelle's own header: the pedal's own live INPUT, not its
  // resynthesized/shifted output.
  const monitorGain = ctx.createGain();
  monitorGain.gain.value = MONITOR_GAIN;
  nodes.input.connect(monitorGain);
  monitorGain.connect(master);
  state.monitorGain = monitorGain;

  // Silent until pressVocodeTunerHandle raises it — the reference sine
  // itself runs continuously from here (an OscillatorNode can only ever be
  // started once), but is only audible while the pointer is held down
  // inside the handle (see this organelle's own header).
  const toneGain = ctx.createGain();
  toneGain.gain.value = 0;
  toneGain.connect(master);
  const toneOsc = ctx.createOscillator();
  toneOsc.type = 'sine';
  toneOsc.frequency.value = state.markerHz;
  toneOsc.connect(toneGain);
  toneOsc.start();
  state.toneOsc = toneOsc;
  state.toneGain = toneGain;
  state.handlePressed = false;
}

function stopSession(state: VocodeTunerState, owner: Entity | undefined): void {
  if (state.reanalyzeTimer) {
    clearTimeout(state.reanalyzeTimer);
    state.reanalyzeTimer = null;
  }
  if (state.analyser) {
    const nodes = owner ? getEntityNodes(owner.id) : undefined;
    nodes?.input.disconnect(state.analyser);
    state.analyser = null;
  }
  if (state.monitorGain) {
    const nodes = owner ? getEntityNodes(owner.id) : undefined;
    nodes?.input.disconnect(state.monitorGain);
    state.monitorGain.disconnect();
    state.monitorGain = null;
  }
  if (state.toneOsc) {
    state.toneOsc.stop();
    state.toneOsc.disconnect();
    state.toneOsc = null;
  }
  if (state.toneGain) {
    state.toneGain.disconnect();
    state.toneGain = null;
  }
}

// Called once per render frame regardless of expanded state (same idiom as
// ui/sampler.ts's own endSamplerFrame) — this is what actually detects a
// popup opening/closing, since ui/organelle.ts's porthole toggle is fully
// generic and has no per-kind open/close hook of its own to call into.
export function endVocodeTunerFrame(graph: EntityGraph): void {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'vocodeTuner') continue;
    const state = vocodeTunerStateFor(entity.id);
    const owner = ownerOf(graph, entity);
    const shouldBeOpen = entity.expanded && !!owner;
    if (shouldBeOpen && !state.wasOpen) {
      startSession(state, owner!);
    } else if (!shouldBeOpen && state.wasOpen) {
      stopSession(state, owner);
    }
    state.wasOpen = shouldBeOpen;
  }
}

// --- Live value application -----------------------------------------------

const TONE_FADE_SECONDS = 0.01; // brief ramp on press/release rather than a hard step, so grabbing/releasing the handle doesn't click

// Called on pointerdown inside the handle (ui/interaction.ts) — the
// reference sine only sounds while held, so this is what actually makes it
// audible; setVocodeTunerMarker/applyMarker below keep updating its pitch
// live as the handle is dragged, independent of whether it's audible.
export function pressVocodeTunerHandle(featureEntityId: string): void {
  const state = vocodeTunerStateFor(featureEntityId);
  state.handlePressed = true;
  if (state.toneGain) state.toneGain.gain.setTargetAtTime(TONE_GAIN, getAudioContext().currentTime, TONE_FADE_SECONDS);
}

// Called on pointerup (ui/interaction.ts), however/wherever the drag ends —
// mirrors pressVocodeTunerHandle above.
export function releaseVocodeTunerHandle(featureEntityId: string): void {
  const state = vocodeTunerStateFor(featureEntityId);
  state.handlePressed = false;
  if (state.toneGain) state.toneGain.gain.setTargetAtTime(0, getAudioContext().currentTime, TONE_FADE_SECONDS);
}

function applyMarker(graph: EntityGraph, featureEntityId: string, hz: number): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  const state = vocodeTunerStateFor(featureEntityId);
  state.markerHz = Math.min(AXIS_MAX_HZ, Math.max(AXIS_MIN_HZ, hz));
  if (state.toneOsc) state.toneOsc.frequency.setTargetAtTime(state.markerHz, getAudioContext().currentTime, 0.01);

  if (state.reanalyzeTimer) clearTimeout(state.reanalyzeTimer);
  state.reanalyzeTimer = setTimeout(() => {
    state.reanalyzeTimer = null;
    analyzeAndApplyVocode(owner, state.markerHz);
  }, REANALYZE_THROTTLE_MS);
}

export function setVocodeTunerMarker(graph: EntityGraph, featureEntityId: string, hz: number): void {
  applyMarker(graph, featureEntityId, hz);
}

// The "reset to auto-detected" affordance — a fresh snapshot, fresh
// autocorrelation guess (no override), then the marker jumps to match once
// the (necessarily delayed — see analyzeAndApplyVocode's own comment on
// why) analysis actually resolves.
export function reanalyzeVocodeTuner(graph: EntityGraph, featureEntityId: string): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  analyzeAndApplyVocode(owner, undefined, (result) => {
    const state = vocodeTunerStateFor(featureEntityId);
    state.markerHz = result.f0;
    if (state.toneOsc) state.toneOsc.frequency.setTargetAtTime(state.markerHz, getAudioContext().currentTime, 0.01);
  });
}

// Advances the pedal's own resynthesis mode to the next entry in
// VOCODE_MODES, wrapping around — same "click to cycle through a short
// list of discrete states" idiom as ui/beatMatcher.ts's own
// cycleBeatMatcherSpeed/PLAYBACK_SPEEDS.
export function cycleVocodeMode(graph: EntityGraph, featureEntityId: string): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  const current = owner.params.mode === 1 ? 1 : 0;
  setVocodeMode(owner, (current + 1) % VOCODE_MODES.length);
}

// --- Geometry --------------------------------------------------------------

export function vocodeTunerPopupRect(graph: EntityGraph, owner: Entity, drag?: DragContext, feature?: Entity): Rect {
  return popupRectFor(graph, owner, VOCODE_TUNER_POPUP_WIDTH, VOCODE_TUNER_POPUP_HEIGHT, drag, feature);
}

function histRect(popup: Rect): Rect {
  const left = popup.x - popup.width / 2 + PADDING;
  const top = popup.y - popup.height / 2 + TITLE_HEIGHT + PADDING;
  return { x: left + (popup.width - PADDING * 2) / 2, y: top + HIST_HEIGHT / 2, width: popup.width - PADDING * 2, height: HIST_HEIGHT };
}

function axisRect(popup: Rect, hist: Rect): Rect {
  const top = hist.y + hist.height / 2;
  return { x: hist.x, y: top + AXIS_HEIGHT / 2, width: hist.width, height: AXIS_HEIGHT };
}

function reanalyzeButtonRect(popup: Rect): Rect {
  const bottom = popup.y + popup.height / 2;
  return { x: popup.x, y: bottom - PADDING - REANALYZE_BUTTON_HEIGHT / 2, width: popup.width - PADDING * 2, height: REANALYZE_BUTTON_HEIGHT };
}

// The resynthesis-mode toggle — anchored off the popup's own close button,
// same relative-positioning idiom as ui/beatMatcher.ts's own
// speedControlPosition, so it sits in the title-bar row with no extra
// popup height needed. A rect hit region (it shows a text label, not an
// icon), same reasoning as ui/beatMatcher.ts's own hitTestSpeedControl.
const MODE_CONTROL_WIDTH = 56; // wider than beat-matcher's own 22px speed control — "vocoder"/"granular" are longer labels than "1/1"
const MODE_CONTROL_HEIGHT = 14;
const MODE_CONTROL_GAP = 42; // from the close button's own center — clears both CLOSE_BUTTON_RADIUS and half this control's own width

function modeControlPosition(popup: Rect): Point {
  const close = closeButtonPosition(popup);
  return { x: close.x - MODE_CONTROL_GAP, y: close.y };
}

function hitTestModeControl(popup: Rect, point: Point): boolean {
  const p = modeControlPosition(popup);
  return (
    point.x >= p.x - MODE_CONTROL_WIDTH / 2 - 3 &&
    point.x <= p.x + MODE_CONTROL_WIDTH / 2 + 3 &&
    point.y >= p.y - MODE_CONTROL_HEIGHT / 2 - 3 &&
    point.y <= p.y + MODE_CONTROL_HEIGHT / 2 + 3
  );
}

const HANDLE_RADIUS = 7; // drawn size — matches ui/organelle.ts's own CLOSE_BUTTON_RADIUS for visual consistency
const HANDLE_HIT_RADIUS = HANDLE_RADIUS + 4; // a little grabbier than its drawn size, same margin ui/organelle.ts's own close button uses

// The marker line's own drag handle — a small circle at the line's
// vertical midpoint (between the top of the histogram bars and the bottom
// of the axis strip), horizontally wherever the current markerHz maps to.
// Shared between hit-testing and drawing so they can never drift apart.
function markerHandleCenter(hist: Rect, axis: Rect, markerHz: number): Point {
  const left = hist.x - hist.width / 2;
  const right = hist.x + hist.width / 2;
  const top = hist.y - hist.height / 2;
  const bottom = axis.y + axis.height / 2;
  return { x: xFromHz(left, right, markerHz), y: (top + bottom) / 2 };
}

// --- Hit-testing -------------------------------------------------------

export type VocodeTunerHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'mode' }
  | { entityId: string; kind: 'marker'; hz: number }
  | { entityId: string; kind: 'reanalyze' }
  | { entityId: string; kind: 'background' };

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function hitTestVocodeTunerPopup(graph: EntityGraph, point: Point, drag?: DragContext): VocodeTunerHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'vocodeTuner' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const popup = vocodeTunerPopupRect(graph, owner, drag, entity);

    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }

    if (hitTestModeControl(popup, point)) {
      return { entityId: entity.id, kind: 'mode' };
    }

    const hist = histRect(popup);
    const axis = axisRect(popup, hist);
    const state = vocodeTunerStateFor(entity.id);
    const handle = markerHandleCenter(hist, axis, state.markerHz);
    const left = hist.x - hist.width / 2;
    const right = hist.x + hist.width / 2;
    if (dist(point, handle) <= HANDLE_HIT_RADIUS) {
      return { entityId: entity.id, kind: 'marker', hz: hzFromX(left, right, point.x) };
    }

    const reanalyze = reanalyzeButtonRect(popup);
    if (
      point.x >= reanalyze.x - reanalyze.width / 2 &&
      point.x <= reanalyze.x + reanalyze.width / 2 &&
      point.y >= reanalyze.y - reanalyze.height / 2 &&
      point.y <= reanalyze.y + reanalyze.height / 2
    ) {
      return { entityId: entity.id, kind: 'reanalyze' };
    }

    const popupLeft = popup.x - popup.width / 2;
    const popupTop = popup.y - popup.height / 2;
    if (point.x >= popupLeft && point.x <= popupLeft + popup.width && point.y >= popupTop && point.y <= popupTop + popup.height) {
      return { entityId: entity.id, kind: 'background' };
    }
  }
  return null;
}

// Recomputes the frequency under the pointer's current x alone — used by
// ui/interaction.ts's pointermove to continue an in-progress marker drag
// even once the pointer's wandered outside the tight hit-testing band
// above (same "rawValueAtPoint" idiom as ui/tuningOrganelle.ts's own).
export function vocodeTunerHzAtPoint(graph: EntityGraph, featureEntityId: string, point: Point, drag?: DragContext): number | null {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return null;
  const popup = vocodeTunerPopupRect(graph, owner, drag, feature);
  const hist = histRect(popup);
  const left = hist.x - hist.width / 2;
  const right = hist.x + hist.width / 2;
  return hzFromX(left, right, point.x);
}

// --- Drawing -----------------------------------------------------------

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const BAND_BG = 'rgba(0, 0, 0, 0.35)';
const DB_FLOOR = -90;
const DB_CEIL = -10;

function barMagnitude(freqData: Float32Array, sampleRate: number, fftSize: number, loHz: number, hiHz: number): number {
  const loBin = Math.max(0, Math.floor((loHz * fftSize) / sampleRate));
  const hiBin = Math.min(freqData.length - 1, Math.ceil((hiHz * fftSize) / sampleRate));
  let max = DB_FLOOR;
  for (let bin = loBin; bin <= hiBin; bin++) max = Math.max(max, freqData[bin]);
  return max;
}

export function drawVocodeTunerPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  drag?: DragContext
): void {
  const state = vocodeTunerStateFor(entity.id);
  const popup = vocodeTunerPopupRect(graph, owner, drag, entity);
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

  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('vocode: tune f0', left + 10, top + TITLE_HEIGHT / 2);

  const close = closeButtonPosition(popup);
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

  // The resynthesis-mode toggle — same rounded-rect-label shape as
  // ui/beatMatcher.ts's own drawSpeedControl, ACCENT-highlighted once
  // switched away from the default (vocoder) mode so a glance at the
  // title bar shows whether it's active.
  const modeIndex = owner.params.mode === 1 ? 1 : 0;
  const modeChanged = modeIndex !== 0;
  const modePos = modeControlPosition(popup);
  ctx.beginPath();
  ctx.roundRect(modePos.x - MODE_CONTROL_WIDTH / 2, modePos.y - MODE_CONTROL_HEIGHT / 2, MODE_CONTROL_WIDTH, MODE_CONTROL_HEIGHT, 3);
  ctx.strokeStyle = modeChanged ? ACCENT : 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = modeChanged ? 1.5 : 1;
  ctx.stroke();
  ctx.fillStyle = modeChanged ? ACCENT : 'rgba(255, 255, 255, 0.8)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(VOCODE_MODES[modeIndex], modePos.x, modePos.y + 0.5);

  const hist = histRect(popup);
  const histLeft = hist.x - hist.width / 2;
  const histTop = hist.y - hist.height / 2;
  ctx.fillStyle = BAND_BG;
  ctx.fillRect(histLeft, histTop, hist.width, hist.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.strokeRect(histLeft, histTop, hist.width, hist.height);

  if (state.analyser && state.freqData) {
    if (state.freqData.length !== state.analyser.frequencyBinCount) {
      state.freqData = new Float32Array(state.analyser.frequencyBinCount);
    }
    state.analyser.getFloatFrequencyData(state.freqData);
    const ctxAudio = getAudioContext();
    const barWidth = hist.width / BAR_COUNT;
    for (let i = 0; i < BAR_COUNT; i++) {
      const loHz = AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, i / BAR_COUNT);
      const hiHz = AXIS_MIN_HZ * Math.pow(AXIS_MAX_HZ / AXIS_MIN_HZ, (i + 1) / BAR_COUNT);
      const db = barMagnitude(state.freqData, ctxAudio.sampleRate, LIVE_ANALYSER_FFT_SIZE, loHz, hiHz);
      const t = Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
      const barHeight = t * hist.height;
      const barX = histLeft + i * barWidth;
      ctx.fillStyle = `rgba(232, 220, 192, ${0.25 + t * 0.65})`;
      ctx.fillRect(barX, histTop + hist.height - barHeight, Math.max(1, barWidth - 1), barHeight);
    }
  }

  const axis = axisRect(popup, hist);
  const axisLeft = axis.x - axis.width / 2;
  const axisRight = axis.x + axis.width / 2;
  const markerX = xFromHz(axisLeft, axisRight, state.markerHz);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.beginPath();
  ctx.moveTo(axisLeft, axis.y - axis.height / 2);
  ctx.lineTo(axisRight, axis.y - axis.height / 2);
  ctx.stroke();

  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(markerX, histTop);
  ctx.lineTo(markerX, axis.y + axis.height / 2);
  ctx.stroke();

  // The drag handle: an open circle at the line's own vertical midpoint —
  // filled solid while actually held down (and thus audible; see
  // pressVocodeTunerHandle), open/hollow otherwise, so the pressed state
  // reads visually as well as audibly.
  const handle = markerHandleCenter(hist, axis, state.markerHz);
  ctx.beginPath();
  ctx.arc(handle.x, handle.y, HANDLE_RADIUS, 0, Math.PI * 2);
  if (state.handlePressed) {
    ctx.fillStyle = ACCENT;
    ctx.fill();
  } else {
    ctx.fillStyle = PANEL_BG;
    ctx.fill();
  }
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = ACCENT;
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${state.markerHz.toFixed(1)} Hz`, Math.min(axisRight - 24, Math.max(axisLeft + 24, markerX)), axis.y - 2);

  const reanalyze = reanalyzeButtonRect(popup);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(reanalyze.x - reanalyze.width / 2, reanalyze.y - reanalyze.height / 2, reanalyze.width, reanalyze.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(reanalyze.x - reanalyze.width / 2, reanalyze.y - reanalyze.height / 2, reanalyze.width, reanalyze.height);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('re-analyze', reanalyze.x, reanalyze.y);

  ctx.restore();
}
