// The beat-matcher (TODO.md item 4): a standalone `control`-type canvas
// entity (like knob/clock/tap/sequencer) pairing a single-track event-source
// role with an authoring `feature` organelle — same porthole/popup mechanism
// as the ADSR envelope/melody/sampler/sequencer organelles (ui/organelle.ts).
//
// Deliberately NOT built on top of ui/sequencer.ts/audio/sequencerPlayer.ts,
// even though the finished feature will look and behave similarly (a
// paint-a-note gesture, a scrub/rewind/loop transport, a real-time-seconds
// timeline) — this is its own control kind with its own state, rendering,
// interaction, and playback code. It shares only genuinely generic,
// kind-agnostic infrastructure the codebase already treats as shared:
// ui/organelle.ts's porthole/popup positioning, ui/render.ts's
// drawControlBody/drawBodyBulge/drawControlLabel, ui/eventWiring.ts's
// event-wire registry.
//
// What makes this different from the sequencer: instead of authoring notes
// against a blank grid, the track is authored against a spectrogram of a
// captured, one-shot audio sample.
//
// Getting a source in: audio Source entities don't have an output jack of
// their own — they only ever join the audio graph by containment (dropped
// inside a filter/pedal, ARCHITECTURE.md §3.2). So rather than inventing a
// new wire kind, the beat-matcher's popup is itself a drop target: drag any
// Source (or live input) entity onto its blank interior while the popup is
// open (ui/interaction.ts's pointermove/finalizeDrop — see
// beatMatcherDropTargetAt below) to reference it as the capture source.
// Unlike a filter's containment drop, this is NOT containment — the dropped
// entity is not reparented into the beat-matcher (it isn't a container at
// all; a Control never is, per audio/entityGraph.ts), it just lands
// wherever it was released, same as dropping it on any other bare patch of
// canvas, while the beat-matcher separately remembers its id as the thing to
// capture from.
//
// Capture is sound-triggered, not manually timed: as soon as a source is
// connected it's "armed" — watching that source's own output level
// (audio/nodeCapture.ts's watchSound) — and capture starts automatically
// the instant that source actually starts sounding, and stops automatically
// the instant it goes quiet again. This is deliberately hands-off: nothing
// here triggers the connected source's own playback for you, it just
// reacts to whatever you do (press its pad, tweak a live drone, ...).
// The record button doubles as two different manual overrides depending on
// where things stand:
//   - while armed (not yet sounding): press to PAUSE — stop watching, so
//     you can let the source play for a while (an intro, a false start)
//     before anything gets recorded. Press again to re-arm.
//   - while capturing (auto-started): press to stop early, before the
//     source would have gone quiet on its own.
// One-shot either way: nothing here is live/continuous once a capture ends.
// audio/nodeCapture.ts does the actual tap-and-record, reusing the same
// raw-PCM capture worklet audio/samplerCapture.ts's mic recording already
// uses, just tapping the connected entity's own already-built output node
// (audio/graph.ts's getEntityNodes) instead of a MediaStreamAudioSourceNode.
//
// View/transport: the note track, spectrogram, and ruler all share one
// zoomable/scrollable timeline (zoomSeconds/scrollSeconds, same coordinate
// model as ui/sequencer.ts's own popup — a real-time axis, not bars/beats)
// and one playback cursor drawn across both the track and the spectrogram,
// with its own play/rewind/scrub — independent code, modeled on how the
// sequencer's popup does all of this, per this file's own header above.
// Actually driving audible playback from this (and dispatching notes to
// wired targets) lands in a later pass — this is the view/transport layer
// only, same "Phase 1 view, Phase 3 audio" split the sequencer itself was
// originally built in.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { gridStepSeconds, ownerOf, portholePosition, popupRectFor, closeButtonPosition, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { drawBodyBulge, drawControlBody, drawControlLabel } from './render';
import { getEntityNodes } from '../audio/graph';
import { startNodeCapture, watchSound } from '../audio/nodeCapture';
import type { LevelWatcher, Recording } from '../audio/nodeCapture';
import { computeSpectrogram, renderSpectrogramImage } from './spectrogram';
import { getAudioContext, resumeAudioContext } from '../audio/context';
import { ACCENT, shadeColor } from './palette';

export const BEAT_MATCHER_POPUP_WIDTH = 420;
// Title bar (which also houses the record button — see captureButtonPosition)
// + a fixed-height track row + spectrogram band + time ruler + a little
// bottom padding. The track row is dual-purpose rather than collapsing once
// captured (an earlier version shrank the popup here — reverted): before a
// capture exists it shows the source/status info inline; once captured, the
// exact same space instead shows the note track (drawBeatMatcherNoteTrack),
// so nothing needs to reflow. The two never need to show at once — before a
// capture there's nothing to author notes against yet, and once captured
// the info only reappears on demand (drawInfoOverlay), drawn ON TOP of the
// track row rather than needing its own room.
const TRACK_ROW_HEIGHT = 40;
const SPECTROGRAM_HEIGHT = 100;
const RULER_HEIGHT = 16;
const H_SCROLLBAR_HEIGHT = 8;
const BOTTOM_PADDING = 8;
export const BEAT_MATCHER_POPUP_HEIGHT =
  TITLE_HEIGHT + TRACK_ROW_HEIGHT + SPECTROGRAM_HEIGHT + RULER_HEIGHT + H_SCROLLBAR_HEIGHT + BOTTOM_PADDING;
// Room on the right for the zoom axis-handle (flush against the plot
// area), same spot ui/sequencer.ts reserves RIGHT_MARGIN for (its own
// per-channel connectors share that margin too, which this track has no
// equivalent of — a single track's whole body already does the job a
// sequencer channel's own connector would).
const RIGHT_MARGIN = 20;
// The plot's own pixel width never varies with popup position (only the
// grid's left/right offsets do) — a fixed popup width minus the margin —
// so a few scroll-range calculations below need this without going through
// a real Grid/popup at all.
const PLOT_WIDTH = BEAT_MATCHER_POPUP_WIDTH - RIGHT_MARGIN;

function pxPerSecondForZoom(zoomSeconds: number): number {
  return zoomSeconds > 0 ? PLOT_WIDTH / zoomSeconds : 0;
}

export function beatMatcherPopupRect(graph: EntityGraph, owner: Entity, drag?: DragContext): Rect {
  return popupRectFor(graph, owner, BEAT_MATCHER_POPUP_WIDTH, BEAT_MATCHER_POPUP_HEIGHT, drag);
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function popupBounds(popup: Rect): { left: number; top: number; right: number; bottom: number } {
  return {
    left: popup.x - popup.width / 2,
    top: popup.y - popup.height / 2,
    right: popup.x + popup.width / 2,
    bottom: popup.y + popup.height / 2,
  };
}

// --- Per-entity state ----------------------------------------------------

// 'idle': no source connected, nothing to do. 'armed': connected and
// watching for the source to start sounding. 'paused': connected but not
// watching — a deliberate pause, either before anything's ever been
// captured (let the source play a while first) or after a capture already
// finished (holding onto capturedBuffer until re-armed). 'capturing': a
// capture is actively in progress, watching for silence to end it.
export type BeatMatcherStatus = 'idle' | 'armed' | 'paused' | 'capturing';

// A single onset marker on the track, authored against the spectrogram.
// Deliberately minimal for now (no pitch/velocity/envelope yet, unlike
// ui/sequencer.ts's own SequencerNote) — this track has no dispatch wiring
// to drive with those yet; added if/when that lands.
export interface BeatMatcherNote {
  id: string;
  onsetSeconds: number;
  durationSeconds: number; // always > 0
}

export interface BeatMatcherState {
  // The Source/liveInput entity this beat-matcher captures from, or null
  // until one's been dropped onto the popup (see beatMatcherDropTargetAt).
  // Deliberately just a reference, not containment — audio/entityGraph.ts's
  // Entity.parentId/children are untouched by this.
  sourceEntityId: string | null;
  status: BeatMatcherStatus;
  // Non-null while 'armed' or 'capturing' — the same watcher instance spans
  // both (it's what notices the armed -> capturing transition in the first
  // place), torn down on 'paused' or when the source changes.
  watcher: LevelWatcher | null;
  // Non-null exactly while 'capturing' — same "hold the in-flight handle
  // directly in state" convention as ui/sampler.ts's SamplerState.recording.
  recording: Recording | null;
  capturedBuffer: AudioBuffer | null;
  // Prerendered once, right after capturedBuffer is set (ui/spectrogram.ts's
  // renderSpectrogramImage) — recomputing a full STFT every draw call would
  // be wasted work when nothing about a finished capture ever changes.
  spectrogramImage: HTMLCanvasElement | null;
  // Whether the source/status text is currently shown as an overlay panel
  // over the track row. Once a capture exists, that row shows the note
  // track instead of this text by default — see pressBeatMatcherRecordButton:
  // the record button's first press in that state only reveals this overlay
  // (a confirm-before-reset step, since actually re-arming will discard the
  // current capture the moment new sound starts), a second press re-arms,
  // and the overlay's own close
  // button dismisses it without re-arming. Meaningless (always false) in
  // every other status — those already show the text inline.
  infoOverlayOpen: boolean;
  // Kept sorted by onsetSeconds — every create/move/resize clamps against
  // the immediately adjacent note(s) here (array-adjacent, given the sort)
  // so notes can never overlap or cross each other, same invariant as
  // ui/sequencer.ts's own SequencerChannel.notes. Cleared whenever a new
  // capture starts (beginBeatMatcherCapture) — notes authored against one
  // recording don't carry over to a different one.
  notes: BeatMatcherNote[];

  // --- View/transport — shared by the track/spectrogram/ruler, see this
  // file's own header. Reset to fit the whole clip (and playback reset to
  // its start) whenever a fresh capture actually completes
  // (finishBeatMatcherCapture) — a zoom/scroll/playhead left over from a
  // previous, different-length capture wouldn't mean anything against a
  // new one.
  zoomSeconds: number; // visible width, in seconds
  scrollSeconds: number; // world-time at the plot's own left edge
  playing: boolean;
  playStartCtxTime: number | null; // AudioContext.currentTime playback last (re)started from
  pausedAtSeconds: number; // playhead position while stopped, or the base currentPlaybackSeconds adds elapsed time to while playing

  // The stop/repeat end marker — where playback loops back to 0 or stops,
  // draggable anywhere in (0, capturedBuffer.duration]. Defaults to the
  // clip's own full duration (so playback just plays the whole thing once,
  // unless the user narrows it down) — unlike ui/sequencer.ts's own
  // trackEndSeconds, there's no "implicit end tracking the viewport" concept
  // to worry about here: this clip already has a real, fixed, always-known
  // length, so the marker is just a plain value from the start, always a
  // real boundary. See advanceBeatMatcherPastEnd/setBeatMatcherEnd.
  endSeconds: number;
  loopAtEnd: boolean;

  // True from the moment the user manually drags the horizontal scrollbar
  // while playing, until the playhead reaches the right edge of wherever
  // they scrolled to — same as ui/sequencer.ts's own field of the same
  // name: lets a deliberate look at another part of the clip (or a look
  // ahead of the cursor) stick, instead of the very next frame's
  // auto-follow snapping straight back to the cursor. See
  // followBeatMatcherPlayhead.
  autoScrollSuspended: boolean;

  // Playback rate for the (not yet wired up — view/transport only for now)
  // captured-audio playback: one of PLAYBACK_SPEEDS. Slows the cursor's own
  // advance through the clip's timeline to match, so notes can be placed
  // accurately against a slowed-down (and, accepting the pitch shift for
  // now — no resynthesis — lower-pitched) sample without resorting to
  // per-note pitch-correction machinery. See cycleBeatMatcherSpeed.
  playbackSpeed: number;
}

const statesByEntity = new Map<string, BeatMatcherState>();

export function beatMatcherStateFor(entityId: string): BeatMatcherState {
  let state = statesByEntity.get(entityId);
  if (!state) {
    state = {
      sourceEntityId: null,
      status: 'idle',
      watcher: null,
      recording: null,
      capturedBuffer: null,
      spectrogramImage: null,
      infoOverlayOpen: false,
      notes: [],
      zoomSeconds: DEFAULT_ZOOM_SECONDS,
      scrollSeconds: 0,
      playing: false,
      playStartCtxTime: null,
      pausedAtSeconds: 0,
      endSeconds: 0,
      loopAtEnd: false,
      autoScrollSuspended: false,
      playbackSpeed: 1,
    };
    statesByEntity.set(entityId, state);
  }
  return state;
}

function stopWatcher(state: BeatMatcherState): void {
  if (state.watcher) {
    state.watcher.stop();
    state.watcher = null;
  }
}

// Starts (or restarts) watching the connected source for sound, per this
// module's own header: onset auto-starts capture, silence auto-stops it. A
// silent no-op if there's no source or its audio nodes don't exist yet
// (audio not started, or it's currently docked) — same "not built yet"
// no-op convention as a TRIGGERED_KINDS pad press against an unbuilt entity
// elsewhere in this codebase; status still becomes 'armed' so the intent is
// recorded, but nothing actually watches until this is called again with
// nodes available (e.g. the next drop, or a future press of the record
// button — a known v1 gap, see this file's own build notes).
function armBeatMatcher(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  stopWatcher(state);
  state.status = 'armed';
  state.infoOverlayOpen = false; // its whole purpose (deciding whether to re-arm) is resolved once this actually happens
  if (!state.sourceEntityId) return;
  const nodes = getEntityNodes(state.sourceEntityId);
  if (!nodes) return;

  state.watcher = watchSound(nodes.output, (sounding) => {
    const current = beatMatcherStateFor(featureEntityId);
    if (sounding && current.status === 'armed') {
      beginBeatMatcherCapture(featureEntityId);
    } else if (!sounding && current.status === 'capturing') {
      finishBeatMatcherCapture(featureEntityId);
    }
  });
}

function beginBeatMatcherCapture(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.sourceEntityId) return;
  const nodes = getEntityNodes(state.sourceEntityId);
  if (!nodes) return;
  state.capturedBuffer = null;
  state.notes = []; // notes authored against the old capture don't carry over to whatever this one turns out to be
  // Tapped before `pan` (audio/graph.ts's EntityNodes) — the entity's own
  // mono mix of its generator + children, unaffected by its stereo canvas
  // position, which is a spatial/performance concern with nothing to do
  // with what's actually being captured for a spectrogram.
  state.recording = startNodeCapture(nodes.output);
  state.status = 'capturing';
}

function finishBeatMatcherCapture(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.recording) return;
  const recording = state.recording;
  state.recording = null;
  recording.stop().then((buffer) => {
    state.capturedBuffer = buffer;
    // One-shot analysis right away — see SpectrogramData/renderSpectrogramImage's
    // own comments for why this is plain TS run once here rather than
    // anything realtime.
    state.spectrogramImage = renderSpectrogramImage(computeSpectrogram(buffer));
    // Fresh view/transport for the new clip — see BeatMatcherState's own
    // comment on why a previous capture's zoom/scroll/playhead can't carry
    // over.
    state.zoomSeconds = clampZoomSeconds(state, buffer.duration);
    state.scrollSeconds = 0;
    state.playing = false;
    state.playStartCtxTime = null;
    state.pausedAtSeconds = 0;
    state.endSeconds = buffer.duration;
    state.loopAtEnd = false;
    state.autoScrollSuspended = false;
    state.playbackSpeed = 1;
  });
  stopWatcher(state);
  state.status = 'paused';
}

// Dropping a (new, or replacement) source onto the popup arms it
// immediately, per this module's own header — no separate "start capture"
// press needed for the normal flow. Replacing an already-connected source
// tears down whatever was watching/capturing from the old one first; an
// in-flight capture from the old source is abandoned (not resolved into
// capturedBuffer) since it was never a capture of the new source anyway.
export function setBeatMatcherSource(featureEntityId: string, sourceEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  stopWatcher(state);
  if (state.recording) {
    state.recording.stop();
    state.recording = null;
  }
  state.sourceEntityId = sourceEntityId;
  state.capturedBuffer = null;
  state.spectrogramImage = null;
  state.notes = [];
  armBeatMatcher(featureEntityId);
}

// The record button's behavior depends entirely on current status — see
// this file's own header for the armed/capturing cases (idle is a no-op).
// 'paused' is the interesting one when there's already a finished capture
// to protect: the first press only reveals the info overlay (source/status,
// same text that's hidden while the overlay's closed) rather than
// re-arming immediately — re-arming discards the capture the moment new
// sound actually starts (beginBeatMatcherCapture), so this is a deliberate
// confirm step. A second press (overlay already open) actually re-arms.
export function pressBeatMatcherRecordButton(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
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
      armBeatMatcher(featureEntityId);
      return;
    case 'capturing':
      finishBeatMatcherCapture(featureEntityId);
      return;
  }
}

// The info overlay's own close button — dismisses it without re-arming, so
// the finished capture just goes back to being hidden behind the button
// alone (drawBeatMatcherPopup's own capturedAndIdle check).
export function closeBeatMatcherInfoOverlay(featureEntityId: string): void {
  beatMatcherStateFor(featureEntityId).infoOverlayOpen = false;
}

// --- Note track ------------------------------------------------------

// Short by default — these are onset markers over a spectrogram, not
// melodic notes with a meaningful sustain, so a short minimum (rather than
// the sequencer's own longer floor) keeps a plain click-not-drag useful on
// its own.
const MIN_NOTE_DURATION_SECONDS = 0.03;

let nextBeatMatcherNoteId = 1;

function insertNoteSorted(notes: BeatMatcherNote[], note: BeatMatcherNote): void {
  const index = notes.findIndex((n) => n.onsetSeconds > note.onsetSeconds);
  if (index === -1) notes.push(note);
  else notes.splice(index, 0, note);
}

function findBeatMatcherNote(state: BeatMatcherState, noteId: string): { index: number; note: BeatMatcherNote } | null {
  const index = state.notes.findIndex((n) => n.id === noteId);
  return index === -1 ? null : { index, note: state.notes[index] };
}

// Paints a new minimum-duration note at `onsetSeconds` — clamped against
// whatever's already there (never starts on top of or past an existing
// note; see ui/sequencer.ts's createSequencerNoteAt, same reasoning). A
// drag that extends past the create press immediately continues as a
// 'resizeRight' on the id this returns (ui/interaction.ts), rather than a
// separate "creating" code path.
export function createBeatMatcherNoteAt(featureEntityId: string, onsetSeconds: number): string | null {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.capturedBuffer) return null;
  const duration = state.capturedBuffer.duration;

  let onset = Math.max(0, Math.min(duration, onsetSeconds));
  for (const existing of state.notes) {
    const end = existing.onsetSeconds + existing.durationSeconds;
    if (onset >= existing.onsetSeconds && onset < end) onset = end;
  }
  if (onset + MIN_NOTE_DURATION_SECONDS > duration) return null;

  const note: BeatMatcherNote = {
    id: `beat-note-${nextBeatMatcherNoteId++}`,
    onsetSeconds: onset,
    durationSeconds: MIN_NOTE_DURATION_SECONDS,
  };
  insertNoteSorted(state.notes, note);
  return note.id;
}

// Moves the note's start, keeping its end fixed — clamped so it can never
// cross the previous note's own end, nor push past its own end minus the
// minimum width.
export function resizeBeatMatcherNoteLeft(featureEntityId: string, noteId: string, seconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found) return;
  const { note, index } = found;
  const prev = state.notes[index - 1];
  const minOnset = prev ? prev.onsetSeconds + prev.durationSeconds : 0;
  const end = note.onsetSeconds + note.durationSeconds;
  const onset = Math.max(minOnset, Math.min(end - MIN_NOTE_DURATION_SECONDS, seconds));
  note.onsetSeconds = onset;
  note.durationSeconds = end - onset;
}

// Moves the note's end, keeping its start fixed — clamped against the next
// note's own start and the captured clip's own duration.
export function resizeBeatMatcherNoteRight(featureEntityId: string, noteId: string, seconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found || !state.capturedBuffer) return;
  const { note, index } = found;
  const next = state.notes[index + 1];
  const maxEnd = next ? next.onsetSeconds : state.capturedBuffer.duration;
  const end = Math.min(maxEnd, Math.max(note.onsetSeconds + MIN_NOTE_DURATION_SECONDS, seconds));
  note.durationSeconds = end - note.onsetSeconds;
}

// Moves the whole note, preserving its own duration — clamped between its
// neighbors (or 0 / the clip's own end) same as the resize cases above.
export function moveBeatMatcherNote(featureEntityId: string, noteId: string, newOnsetSeconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found || !state.capturedBuffer) return;
  const { note, index } = found;
  const prev = state.notes[index - 1];
  const next = state.notes[index + 1];
  const minOnset = prev ? prev.onsetSeconds + prev.durationSeconds : 0;
  const maxOnset = (next ? next.onsetSeconds : state.capturedBuffer.duration) - note.durationSeconds;
  note.onsetSeconds = Math.max(minOnset, Math.min(maxOnset, newOnsetSeconds));
}

export function deleteBeatMatcherNote(featureEntityId: string, noteId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (found) state.notes.splice(found.index, 1);
}

// --- Grid / zoom / scroll ------------------------------------------------
// Real-time-seconds timeline, same coordinate model as ui/organelle.ts's
// envelope curve and ui/sequencer.ts's own popup: zoomSeconds is how many
// seconds the plot's fixed pixel width currently represents, scrollSeconds
// is the world-time at its left edge. Shared by the note track, spectrogram,
// and ruler — see this file's own header.

export const DEFAULT_ZOOM_SECONDS = 4;
export const MIN_ZOOM_SECONDS = 0.1;

// Never more than the clip's own duration — unlike the sequencer's
// open-ended track, there's no "more timeline" to reveal by zooming out
// further than that; the whole clip already fits.
function clampZoomSeconds(state: BeatMatcherState, seconds: number): number {
  const max = Math.max(MIN_ZOOM_SECONDS, state.capturedBuffer?.duration ?? seconds);
  return Math.min(max, Math.max(MIN_ZOOM_SECONDS, seconds));
}

const ZOOM_DRAG_SENSITIVITY = 0.03; // seconds of zoom per px of horizontal drag — smaller than the sequencer's own (these clips are typically much shorter)

function beatMatcherZoomFromDrag(featureEntityId: string, startZoomSeconds: number, deltaX: number): number {
  return clampZoomSeconds(beatMatcherStateFor(featureEntityId), startZoomSeconds + deltaX * ZOOM_DRAG_SENSITIVITY);
}

// ui/interaction.ts's draggingTimeAxis continuous-drag case — sets
// zoomSeconds and re-clamps scrollSeconds against it in one call, same
// "zoom, then make sure scroll still makes sense" pairing
// beatMatcherZoomStep's own icon-click case does.
export function applyBeatMatcherZoomDrag(featureEntityId: string, startZoomSeconds: number, deltaX: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  state.zoomSeconds = beatMatcherZoomFromDrag(featureEntityId, startZoomSeconds, deltaX);
  clampBeatMatcherScroll(state);
}

const AXIS_ZOOM_STEP_FACTOR = 1.4; // discrete per-click zoom step — multiplicative, same as ui/sequencer.ts's own zoomStep

export function beatMatcherZoomStep(featureEntityId: string, direction: 'in' | 'out'): void {
  const state = beatMatcherStateFor(featureEntityId);
  const next = direction === 'in' ? state.zoomSeconds / AXIS_ZOOM_STEP_FACTOR : state.zoomSeconds * AXIS_ZOOM_STEP_FACTOR;
  state.zoomSeconds = clampZoomSeconds(state, next);
  clampBeatMatcherScroll(state);
}

// The clip's own duration, PLUS enough extra to scroll the end marker (and
// its loop/stop toggle, sitting just past it) comfortably into view even
// when endSeconds sits at the very end of the clip (the default) — without
// this margin, the viewport's right edge could never scroll past exactly
// `duration`, and the marker's own drawn width means it'd sit right at (or
// just past) that edge, failing endMarkerVisible's strict `x < grid.right`
// check no matter how far scrolled. Same "the boundary needs scrollable
// room past it" reasoning as ui/sequencer.ts's own scrollableTotalSeconds.
function scrollableBeatMatcherSeconds(state: BeatMatcherState): number {
  const duration = state.capturedBuffer?.duration ?? 0;
  const pxPerSec = pxPerSecondForZoom(state.zoomSeconds);
  const marginSeconds = pxPerSec > 0 ? (END_MARKER_WIDTH + 24) / pxPerSec : 0;
  return duration + marginSeconds;
}

function maxScrollSeconds(state: BeatMatcherState): number {
  return Math.max(0, scrollableBeatMatcherSeconds(state) - state.zoomSeconds);
}

function clampBeatMatcherScroll(state: BeatMatcherState): void {
  state.scrollSeconds = Math.max(0, Math.min(maxScrollSeconds(state), state.scrollSeconds));
}

interface Grid {
  left: number;
  right: number; // popup's own right edge minus RIGHT_MARGIN — where the axis handle/zoom icons live
  trackTop: number;
  trackBottom: number;
  spectrogramBottom: number;
  rulerTop: number;
  rulerBottom: number;
}

function gridFor(popup: Rect): Grid {
  const b = popupBounds(popup);
  const trackTop = b.top + TITLE_HEIGHT;
  const trackBottom = trackTop + TRACK_ROW_HEIGHT;
  const spectrogramBottom = trackBottom + SPECTROGRAM_HEIGHT;
  const rulerTop = spectrogramBottom;
  return {
    left: b.left,
    right: b.right - RIGHT_MARGIN,
    trackTop,
    trackBottom,
    spectrogramBottom,
    rulerTop,
    rulerBottom: rulerTop + RULER_HEIGHT,
  };
}

function pxPerSecond(grid: Grid, zoomSeconds: number): number {
  return zoomSeconds > 0 ? (grid.right - grid.left) / zoomSeconds : 0;
}

function secondsToX(grid: Grid, pxPerSec: number, scrollSeconds: number, seconds: number): number {
  return grid.left + (seconds - scrollSeconds) * pxPerSec;
}

function xToSeconds(grid: Grid, pxPerSec: number, scrollSeconds: number, x: number): number {
  return pxPerSec > 0 ? scrollSeconds + (x - grid.left) / pxPerSec : 0;
}

// Converts a canvas point into a position on the captured clip's own
// timeline — null if there's no capture (nothing to convert against) or the
// feature/owner is gone. Used by ui/interaction.ts to drive note
// create/move/resize and scrub drags every pointermove.
export function beatMatcherSecondsAtPoint(graph: EntityGraph, featureEntityId: string, point: Point, drag?: DragContext): number | null {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  const state = beatMatcherStateFor(featureEntityId);
  if (!feature || !owner || !state.capturedBuffer) return null;
  const grid = gridFor(beatMatcherPopupRect(graph, owner, drag));
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  return xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x);
}

// --- Transport -------------------------------------------------------
// Independent of ui/sequencer.ts's own (audio/graph.ts's getAudioContext
// clock underneath, same idiom, separate state) — see this file's header.

export function currentBeatMatcherPlaybackSeconds(state: BeatMatcherState): number {
  if (!state.playing || state.playStartCtxTime === null) return state.pausedAtSeconds;
  // Real elapsed time scaled by playbackSpeed — at half speed, a real
  // second of wall-clock time only advances the clip's own timeline by
  // half a second, giving a slowed-down clip proportionally more real time
  // to work with (see BeatMatcherState.playbackSpeed's own comment).
  return state.pausedAtSeconds + (getAudioContext().currentTime - state.playStartCtxTime) * state.playbackSpeed;
}

export function startBeatMatcherPlayback(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.playing || !state.capturedBuffer) return;
  // Restart from the top if it's already run off the end (or sitting
  // exactly at the end marker, having just stopped there) — pressing play
  // again should replay from 0, not immediately re-trigger
  // advanceBeatMatcherPastEnd on the very next frame and stop again.
  if (state.pausedAtSeconds >= state.endSeconds) state.pausedAtSeconds = 0;
  state.playing = true;
  state.playStartCtxTime = getAudioContext().currentTime;
  // Same "unfreeze ctx.currentTime from a real click" fire-and-forget as
  // ui/sequencer.ts's own startSequencer — nothing here needs to block on
  // it, playStartCtxTime is fine either way.
  resumeAudioContext().catch((err) => {
    console.error('Failed to resume audio for beat-matcher playback:', err);
  });
}

export function stopBeatMatcherPlayback(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.playing) return;
  state.pausedAtSeconds = currentBeatMatcherPlaybackSeconds(state);
  state.playing = false;
  state.playStartCtxTime = null;
}

export function toggleBeatMatcherPlayback(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.playing) stopBeatMatcherPlayback(featureEntityId);
  else startBeatMatcherPlayback(featureEntityId);
}

// Zeroes both the playhead and the view's scroll position, same as
// ui/sequencer.ts's own rewindSequencer — brings a panned-away view back
// to the start along with the playhead.
export function rewindBeatMatcherPlayback(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  state.pausedAtSeconds = 0;
  state.scrollSeconds = 0;
  if (state.playing) state.playStartCtxTime = getAudioContext().currentTime;
  state.autoScrollSuspended = false;
}

// Jump the playhead to an absolute position — dragging the ruler or the
// line itself. Keeps playing (re-anchored to now) if it already was.
export function scrubBeatMatcherPlayback(featureEntityId: string, seconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  const duration = state.capturedBuffer?.duration ?? 0;
  state.pausedAtSeconds = Math.max(0, Math.min(duration, seconds));
  if (state.playing) state.playStartCtxTime = getAudioContext().currentTime;
}

// Loop-or-stop at the end marker (state.endSeconds — defaults to the whole
// clip's own duration, see BeatMatcherState's own comment) — called from
// the render pass (drawBeatMatcherPopup), same "only ticks while the popup
// is open" scope ui/sequencer.ts's own updateSequencerPlayback/
// advancePastTrackEnd started with, before that one grew an independent
// scheduler in a later pass (this one will too, once real audio dispatch
// lands here).
function advanceBeatMatcherPastEnd(state: BeatMatcherState): void {
  if (!state.playing || !state.capturedBuffer) return;
  const playhead = currentBeatMatcherPlaybackSeconds(state);
  if (playhead < state.endSeconds) return;
  if (state.loopAtEnd) {
    // Shifts the ctx-time reference forward by exactly one loop length
    // (divided by playbackSpeed — currentBeatMatcherPlaybackSeconds scales
    // real elapsed ctx-time BY playbackSpeed, so undoing endSeconds'-worth
    // of clip-time takes endSeconds/playbackSpeed of real ctx-time) rather
    // than resetting pausedAtSeconds/playStartCtxTime outright —
    // currentBeatMatcherPlaybackSeconds reads back as exactly (playhead -
    // endSeconds) afterward, preserving whatever fraction of a frame it
    // overshot by instead of snapping to a slightly-early 0, same
    // reasoning as ui/sequencer.ts's own advancePastTrackEnd.
    state.playStartCtxTime = (state.playStartCtxTime ?? getAudioContext().currentTime) + state.endSeconds / state.playbackSpeed;
  } else {
    state.pausedAtSeconds = state.endSeconds;
    state.playing = false;
    state.playStartCtxTime = null;
    // Only in stop mode — looping resets the cursor back to 0, where the
    // marker was never the thing to look at. Nudges the view a little
    // further right, past where followBeatMatcherPlayhead's own 80%-lookahead
    // would otherwise have left it, so the marker (and its toggle, sitting
    // just past it) ends up comfortably visible rather than right at the
    // viewport's own edge — same "fixed VISUAL gap, not a fixed time one"
    // reasoning as ui/sequencer.ts's own END_MARKER_LOOKAHEAD_PX.
    const pxPerSec = pxPerSecondForZoom(state.zoomSeconds);
    const marginSeconds = pxPerSec > 0 ? (END_MARKER_WIDTH + 16) / pxPerSec : 0;
    if (state.endSeconds > state.scrollSeconds + state.zoomSeconds - marginSeconds) {
      state.scrollSeconds = state.endSeconds - state.zoomSeconds + marginSeconds;
      clampBeatMatcherScroll(state);
    }
  }
}

// Keeps the playhead in view while playing, rather than letting it sweep
// off the right edge — same "auto-scroll to follow the cursor, leaving some
// look-ahead room" behavior as ui/sequencer.ts's own followPlayhead,
// independent code. Called right after advanceBeatMatcherPastEnd (a loop
// wrap moves the playhead back near 0 first; this needs to react to THAT
// position, not the one it just wrapped from) from the render pass.
const AUTO_SCROLL_LOOKAHEAD_FRACTION = 0.8; // keep the playhead here, 80% across the visible window, while playing

function followBeatMatcherPlayhead(state: BeatMatcherState): void {
  if (!state.playing) return;
  // Once the end marker already sits within the visible window, there's
  // nothing further ahead worth scrolling toward — also what keeps a short,
  // fully-visible loop from endlessly creeping the view forward on every
  // wrap, despite always looping back to the same content.
  if (state.endSeconds <= state.scrollSeconds + state.zoomSeconds) return;
  const playhead = currentBeatMatcherPlaybackSeconds(state);
  const fraction = (playhead - state.scrollSeconds) / state.zoomSeconds;

  if (state.autoScrollSuspended) {
    if (fraction < 1) return;
    state.autoScrollSuspended = false;
  }

  // Snaps back into place the moment it's out of the desired window at all
  // (not just once it's fully off-screen to the right) — scrolling only
  // once the cursor has already vanished would be a jarring, late
  // correction rather than a smooth follow.
  if (fraction > AUTO_SCROLL_LOOKAHEAD_FRACTION || fraction < 0) {
    state.scrollSeconds = Math.max(0, playhead - AUTO_SCROLL_LOOKAHEAD_FRACTION * state.zoomSeconds);
    clampBeatMatcherScroll(state);
  }
}

// Drag the end marker to a new absolute position (ui/interaction.ts's
// beatMatcherEndDrag) — same "jump to wherever the pointer is" shape as
// scrubBeatMatcherPlayback. Pulls the playhead back with it if dragging the
// boundary behind the cursor would otherwise leave it stranded past a point
// it's about to immediately loop/stop against on the very next frame —
// same reasoning as ui/sequencer.ts's own setTrackEnd.
export function setBeatMatcherEnd(featureEntityId: string, seconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.capturedBuffer) return;
  state.endSeconds = Math.max(MIN_ZOOM_SECONDS, Math.min(state.capturedBuffer.duration, seconds));
  if (currentBeatMatcherPlaybackSeconds(state) > state.endSeconds) {
    scrubBeatMatcherPlayback(featureEntityId, state.endSeconds);
  }
}

export function toggleBeatMatcherLoopAtEnd(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  state.loopAtEnd = !state.loopAtEnd;
}

// 1/1 (normal), 1/2, 1/4 — accepting the pitch shift from plain sample-rate
// playback rather than resynthesizing to preserve pitch (BeatMatcherState.
// playbackSpeed's own comment).
const PLAYBACK_SPEEDS = [1, 0.5, 0.25];

function beatMatcherSpeedLabel(speed: number): string {
  if (speed === 0.5) return '1/2';
  if (speed === 0.25) return '1/4';
  return '1/1';
}

// Cycles 1/1 -> 1/2 -> 1/4 -> 1/1 ... Re-anchors the playhead first (using
// the speed still in effect) if currently playing, so a live speed change
// doesn't jump the cursor — currentBeatMatcherPlaybackSeconds scales
// elapsed real time by playbackSpeed, so changing it out from under a
// still-ticking playStartCtxTime would otherwise read back a wrong
// position the very next frame.
export function cycleBeatMatcherSpeed(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.playing) {
    state.pausedAtSeconds = currentBeatMatcherPlaybackSeconds(state);
    state.playStartCtxTime = getAudioContext().currentTime;
  }
  const index = PLAYBACK_SPEEDS.indexOf(state.playbackSpeed);
  state.playbackSpeed = PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length];
}

export function updateBeatMatcherScrollFromTrackX(graph: EntityGraph, featureEntityId: string, pointerX: number, drag?: DragContext): void {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!feature || !owner) return;
  const state = beatMatcherStateFor(featureEntityId);
  const grid = gridFor(beatMatcherPopupRect(graph, owner, drag));
  const track = hScrollbarTrack(grid);
  const maxScroll = maxScrollSeconds(state);
  if (maxScroll <= 0) return;
  const thumbWidth = hThumbWidth(track.width, state);
  const trackLeft = track.x - track.width / 2;
  const usable = track.width - thumbWidth;
  const t = usable > 0 ? (pointerX - trackLeft - thumbWidth / 2) / usable : 0;
  state.scrollSeconds = Math.min(1, Math.max(0, t)) * maxScroll;
  // A manual scrollbar drag overrides auto-follow until the playhead
  // reaches the right edge of wherever this lands — see
  // followBeatMatcherPlayhead's own comment. Harmless to set unconditionally
  // even while stopped.
  state.autoScrollSuspended = true;
}

const NOTE_EDGE_GRAB_PX = 5;
const LINE_GRAB_TOLERANCE = 6; // px on either side of the drawn playback line that still counts as grabbing it

export type BeatMatcherTrackHit =
  | { kind: 'noteResizeLeft'; noteId: string }
  | { kind: 'noteResizeRight'; noteId: string }
  | { kind: 'noteMove'; noteId: string; grabOffsetSeconds: number };

// Hit-tests only the notes themselves within the track row (see
// drawBeatMatcherNoteTrack) — null if there's no capture yet, `point` isn't
// within the row's own vertical span, or no note is actually under it (an
// empty-space press is a separate 'noteCreate' case, checked afterward in
// hitTestBeatMatcherPopup — same priority order as
// ui/sequencer.ts's own hitTestSequencerPopup: notes, then scrub, then
// empty-space create).
function hitTestNoteTrack(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): BeatMatcherTrackHit | null {
  if (!state.capturedBuffer) return null;
  if (point.y < grid.trackTop || point.y > grid.trackBottom || point.x < grid.left || point.x > grid.right) return null;

  const pointSeconds = xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x);

  for (const note of state.notes) {
    const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
    const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
    if (right < grid.left || left > grid.right) continue;
    if (point.x < left - NOTE_EDGE_GRAB_PX || point.x > right + NOTE_EDGE_GRAB_PX) continue;
    if (Math.abs(point.x - left) <= NOTE_EDGE_GRAB_PX) return { kind: 'noteResizeLeft', noteId: note.id };
    if (Math.abs(point.x - right) <= NOTE_EDGE_GRAB_PX) return { kind: 'noteResizeRight', noteId: note.id };
    if (point.x >= left && point.x <= right) {
      return { kind: 'noteMove', noteId: note.id, grabOffsetSeconds: pointSeconds - note.onsetSeconds };
    }
  }
  return null;
}

// Where a just-dropped entity should actually come to rest, clear of the
// popup's own bounds — landing it exactly at the release point (necessarily
// somewhere inside the popup's interior, since that's the only place the
// drop registers at all) would leave it rendered underneath the popup's
// opaque panel: feature popups always draw on top of ordinary entity boxes
// (ui/render.ts's draw order draws every popup in a pass after the whole
// entity tree), so it'd be stuck there, unreachable to click or drag away
// afterward. Centered under the popup's bottom edge, offset by the dropped
// entity's own half-height so it doesn't overlap the popup at all. Returns
// null if the feature/owner is somehow gone (shouldn't happen right after a
// drop landed on it) — ui/interaction.ts's finalizeDrop falls back to the
// raw drop point in that case.
export function beatMatcherClearDropPosition(graph: EntityGraph, featureEntityId: string, droppedHalfHeight: number): Point | null {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!feature || !owner) return null;
  const popup = beatMatcherPopupRect(graph, owner);
  return { x: popup.x, y: popup.y + popup.height / 2 + droppedHalfHeight + 24 };
}

// The feature entity id whose open popup's interior contains `point` (or the
// live drag `target`, from ui/interaction.ts's own hoverTargetId-style
// check), if any — used both as a drag-hover drop-target test and, on
// release, to actually make the connection. Not restricted to any smaller
// "blank region" within the popup: the whole interior is the drop target,
// same as a filter's whole body is a valid containment drop target.
export function beatMatcherDropTargetAt(graph: EntityGraph, point: Point, drag?: DragContext): string | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'beatMatcher' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const b = popupBounds(beatMatcherPopupRect(graph, owner, drag));
    if (point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom) {
      return entity.id;
    }
  }
  return null;
}

// --- Transport buttons / zoom handle / scrollbar -------------------------
// Geometry only — drawing further down, hit-testing in
// hitTestBeatMatcherPopup below. Modeled directly on ui/sequencer.ts's own
// (playButtonPosition/rewindButtonPosition/axisHandleX/
// withinAxisHandleZone/hScrollbarTrack/...), independent code — see this
// file's own header for why.

// Rewind, then play/pause, then the speed control — title bar, left of the
// close button, reading left-to-right same as a real transport's button
// order. The beat-matcher's own record button lives at the FAR left of the
// title bar instead of here (captureButtonPosition) — these two never
// compete for the same spot.
const TRANSPORT_BUTTON_RADIUS = 8;
const TRANSPORT_BUTTON_GAP = 20;

function speedControlPosition(popup: Rect): Point {
  const close = closeButtonPosition(popup);
  return { x: close.x - TRANSPORT_BUTTON_GAP, y: close.y };
}

// A small rounded-rect label ("1/1"/"1/2"/"1/4"), not a circular icon like
// its neighbors — text is the whole point of it — so its own hit region is
// a rect around speedControlPosition rather than a dist() radius check.
const SPEED_CONTROL_WIDTH = 22;
const SPEED_CONTROL_HEIGHT = 14;

function hitTestSpeedControl(popup: Rect, point: Point): boolean {
  const p = speedControlPosition(popup);
  return (
    point.x >= p.x - SPEED_CONTROL_WIDTH / 2 - 3 &&
    point.x <= p.x + SPEED_CONTROL_WIDTH / 2 + 3 &&
    point.y >= p.y - SPEED_CONTROL_HEIGHT / 2 - 3 &&
    point.y <= p.y + SPEED_CONTROL_HEIGHT / 2 + 3
  );
}

function playButtonPosition(popup: Rect): Point {
  const speed = speedControlPosition(popup);
  return { x: speed.x - TRANSPORT_BUTTON_GAP, y: speed.y };
}

function rewindButtonPosition(popup: Rect): Point {
  const play = playButtonPosition(popup);
  return { x: play.x - TRANSPORT_BUTTON_GAP, y: play.y };
}

// A vertical grip strip flush against the plot's own right edge (grid.right,
// RIGHT_MARGIN's worth of room) — dragging it rescales zoomSeconds
// continuously; the small zoom in/out icons on it (below) do the same in
// discrete steps. Spans the track + spectrogram + ruler rows (not the
// h-scrollbar below that), same "stops above the scrollbar row" reasoning
// as the sequencer's own axis handle.
const AXIS_HANDLE_ZONE_WIDTH = 12;

function axisHandleX(grid: Grid): number {
  return grid.right + AXIS_HANDLE_ZONE_WIDTH / 2;
}

function withinAxisHandleZone(grid: Grid, point: Point): boolean {
  return (
    point.x >= grid.right &&
    point.x <= grid.right + AXIS_HANDLE_ZONE_WIDTH &&
    point.y >= grid.trackTop &&
    point.y <= grid.rulerBottom
  );
}

const AXIS_ZOOM_ICON_RADIUS = 4;
const AXIS_ZOOM_ICON_MARGIN = 9;

function axisZoomInIconPosition(grid: Grid): Point {
  return { x: axisHandleX(grid), y: grid.trackTop + AXIS_ZOOM_ICON_MARGIN };
}

function axisZoomOutIconPosition(grid: Grid): Point {
  return { x: axisHandleX(grid), y: grid.rulerBottom - AXIS_ZOOM_ICON_MARGIN };
}

function hitTestAxisZoomIcon(grid: Grid, point: Point): 'in' | 'out' | null {
  if (dist(point, axisZoomInIconPosition(grid)) <= AXIS_ZOOM_ICON_RADIUS + 3) return 'in';
  if (dist(point, axisZoomOutIconPosition(grid)) <= AXIS_ZOOM_ICON_RADIUS + 3) return 'out';
  return null;
}

function hScrollbarTrack(grid: Grid): Rect {
  return {
    x: (grid.left + grid.right) / 2,
    y: grid.rulerBottom + H_SCROLLBAR_HEIGHT / 2 + 2,
    width: grid.right - grid.left,
    height: H_SCROLLBAR_HEIGHT,
  };
}

const SCROLLBAR_MIN_THUMB_LENGTH = 16;

function hScrollbarNeeded(state: BeatMatcherState): boolean {
  return state.zoomSeconds < scrollableBeatMatcherSeconds(state);
}

function hThumbWidth(trackWidth: number, state: BeatMatcherState): number {
  const total = scrollableBeatMatcherSeconds(state);
  return Math.max(SCROLLBAR_MIN_THUMB_LENGTH, trackWidth * Math.min(1, total > 0 ? state.zoomSeconds / total : 1));
}

function hThumbX(track: Rect, state: BeatMatcherState): number {
  const trackLeft = track.x - track.width / 2;
  const maxScroll = maxScrollSeconds(state);
  if (maxScroll <= 0) return trackLeft;
  const thumbWidth = hThumbWidth(track.width, state);
  return trackLeft + (track.width - thumbWidth) * (state.scrollSeconds / maxScroll);
}

// --- Stop/repeat end marker -----------------------------------------------
// A draggable band marking where playback loops back to 0 or stops
// (state.endSeconds/loopAtEnd) — modeled on ui/sequencer.ts's own end
// marker, independent code. Spans the same track+spectrogram+ruler height
// as the axis handle (grid.trackTop..grid.rulerBottom), so its toggle sits
// clear of both the playback cursor's own span and the axis handle/zoom
// icons over at grid.right.

const END_MARKER_WIDTH = 24;

function endMarkerX(grid: Grid, pxPerSec: number, state: BeatMatcherState): number {
  return secondsToX(grid, pxPerSec, state.scrollSeconds, state.endSeconds);
}

function endMarkerTogglePosition(grid: Grid, pxPerSec: number, state: BeatMatcherState): Point {
  return { x: endMarkerX(grid, pxPerSec, state) + END_MARKER_WIDTH / 2, y: (grid.trackTop + grid.rulerBottom) / 2 };
}

function endMarkerVisible(grid: Grid, pxPerSec: number, state: BeatMatcherState): boolean {
  const x = endMarkerX(grid, pxPerSec, state);
  return x >= grid.left && x < grid.right;
}

function hitTestEndMarkerToggle(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  return endMarkerVisible(grid, pxPerSec, state) && dist(point, endMarkerTogglePosition(grid, pxPerSec, state)) <= TRANSPORT_BUTTON_RADIUS + 4;
}

function hitTestEndMarkerBand(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  if (!endMarkerVisible(grid, pxPerSec, state)) return false;
  const x = endMarkerX(grid, pxPerSec, state);
  return point.x >= x && point.x <= x + END_MARKER_WIDTH && point.y >= grid.trackTop && point.y <= grid.rulerBottom;
}

export type BeatMatcherHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'captureButton' }
  | { entityId: string; kind: 'infoOverlayClose' }
  | { entityId: string; kind: 'rewind' }
  | { entityId: string; kind: 'play' }
  | { entityId: string; kind: 'speed' }
  | { entityId: string; kind: 'scrub'; seconds: number }
  | { entityId: string; kind: 'noteResizeLeft'; noteId: string }
  | { entityId: string; kind: 'noteResizeRight'; noteId: string }
  | { entityId: string; kind: 'noteMove'; noteId: string; grabOffsetSeconds: number }
  | { entityId: string; kind: 'noteCreate' }
  | { entityId: string; kind: 'axisZoomIn' }
  | { entityId: string; kind: 'axisZoomOut' }
  | { entityId: string; kind: 'axisHandle' }
  | { entityId: string; kind: 'hScroll' }
  | { entityId: string; kind: 'endMarkerToggle' }
  | { entityId: string; kind: 'endMarkerDrag'; seconds: number }
  | { entityId: string; kind: 'background' };

// Checked early in ui/interaction.ts's pointerdown, same priority as
// hitTestMelodyPopup/hitTestSequencerPopup — an open beat-matcher popup
// sits visually on top of everything else on the canvas, so a click
// anywhere inside it (including its background) must never fall through to
// whatever's underneath.
export function hitTestBeatMatcherPopup(graph: EntityGraph, point: Point, drag?: DragContext): BeatMatcherHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'beatMatcher' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;

    const state = beatMatcherStateFor(entity.id);
    const popup = beatMatcherPopupRect(graph, owner, drag);
    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }
    if (dist(point, captureButtonPosition(popup)) <= CAPTURE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'captureButton' };
    }
    if (dist(point, rewindButtonPosition(popup)) <= TRANSPORT_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'rewind' };
    }
    if (dist(point, playButtonPosition(popup)) <= TRANSPORT_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'play' };
    }
    if (hitTestSpeedControl(popup, point)) {
      return { entityId: entity.id, kind: 'speed' };
    }
    if (state.infoOverlayOpen && dist(point, infoOverlayClosePosition(popup)) <= INFO_OVERLAY_CLOSE_RADIUS + 4) {
      return { entityId: entity.id, kind: 'infoOverlayClose' };
    }

    // Everything below is the track/spectrogram/ruler/zoom/scroll plot —
    // none of it is reachable while the info overlay covers the track row
    // (same priority as ui/sequencer.ts's own popup-vs-lane checks).
    if (!state.infoOverlayOpen && state.capturedBuffer) {
      const grid = gridFor(popup);
      const pxPerSec = pxPerSecond(grid, state.zoomSeconds);

      // The end marker's own toggle (a precise click) takes priority over
      // dragging the band itself, which in turn takes priority over
      // everything below — same order ui/sequencer.ts's own popup uses, so
      // a click near both (the marker parked right on the playhead, say)
      // unambiguously grabs the marker.
      if (hitTestEndMarkerToggle(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'endMarkerToggle' };
      }
      if (hitTestEndMarkerBand(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'endMarkerDrag', seconds: xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x) };
      }

      const noteHit = hitTestNoteTrack(grid, pxPerSec, state, point);
      if (noteHit) return { entityId: entity.id, ...noteHit };

      // Two ways to start a scrub: anywhere along the ruler row (a "click
      // to jump there" strip), or a grab directly on the drawn playback
      // line itself, which spans the full track+spectrogram height (see
      // drawBeatMatcherPlaybackLine) — same as ui/sequencer.ts's own
      // inRulerRow/onPlaybackLine reasoning.
      const inRulerRow = point.x >= grid.left && point.x <= grid.right && point.y >= grid.rulerTop && point.y <= grid.rulerBottom;
      const playX = secondsToX(grid, pxPerSec, state.scrollSeconds, currentBeatMatcherPlaybackSeconds(state));
      const onPlaybackLine =
        playX >= grid.left &&
        playX <= grid.right &&
        Math.abs(point.x - playX) <= LINE_GRAB_TOLERANCE &&
        point.y >= grid.trackTop &&
        point.y <= grid.spectrogramBottom;
      if (inRulerRow || onPlaybackLine) {
        return { entityId: entity.id, kind: 'scrub', seconds: xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x) };
      }

      // Empty track-row space — starts painting a brand-new note.
      if (point.x >= grid.left && point.x <= grid.right && point.y >= grid.trackTop && point.y <= grid.trackBottom) {
        return { entityId: entity.id, kind: 'noteCreate' };
      }

      // The zoom icons are checked ahead of the drag zone they sit inside.
      const axisZoomIcon = hitTestAxisZoomIcon(grid, point);
      if (axisZoomIcon === 'in') return { entityId: entity.id, kind: 'axisZoomIn' };
      if (axisZoomIcon === 'out') return { entityId: entity.id, kind: 'axisZoomOut' };
      if (withinAxisHandleZone(grid, point)) {
        return { entityId: entity.id, kind: 'axisHandle' };
      }

      if (hScrollbarNeeded(state)) {
        const track = hScrollbarTrack(grid);
        if (
          point.x >= track.x - track.width / 2 &&
          point.x <= track.x + track.width / 2 &&
          point.y >= track.y - track.height &&
          point.y <= track.y + track.height
        ) {
          return { entityId: entity.id, kind: 'hScroll' };
        }
      }
    }

    const b = popupBounds(popup);
    if (point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom) {
      return { entityId: entity.id, kind: 'background' };
    }
  }
  return null;
}

// Collapsed on-canvas presence — same small circular body every other
// control kind uses (ui/render.ts's drawControlBody). Its right-edge bulge
// (drawBodyBulge, the same spot knob/clock/tap protrude their own wire jack
// from) instead frames its organelle porthole, drawn separately and
// generically by ui/organelle.ts's own drawPorthole once portholePosition's
// control-type-owner case points it here — same treatment as the
// sequencer's own drawSequencerBody (ui/sequencer.ts), just independent
// code.
export function drawBeatMatcherBody(ctx: CanvasRenderingContext2D, entity: Entity, bounds: Rect, selected: boolean): void {
  const radius = drawControlBody(ctx, bounds, selected, entity.kind);
  drawBodyBulge(ctx, bounds);
  drawControlLabel(ctx, entity, bounds, radius);
}

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const DROP_ZONE_BG = 'rgba(255, 255, 255, 0.06)';
const DROP_ZONE_BG_HOVER = 'rgba(255, 255, 255, 0.14)';
const CAPTURE_BUTTON_RADIUS = 9;
const CAPTURE_ARMED_COLOR = '#8a2f2f';
const CAPTURE_ACTIVE_COLOR = '#e04a3c';
const CAPTURE_PAUSED_COLOR = '#5a5a5a';

// Lives right in the title bar, to the left of the title text — always,
// regardless of status, so it never needs its own dedicated row once a
// capture exists (see beatMatcherPopupHeight/drawBeatMatcherPopup).
function captureButtonPosition(popup: Rect): Point {
  const b = popupBounds(popup);
  return { x: b.left + 15, y: b.top + TITLE_HEIGHT / 2 };
}

// The button's look tracks BeatMatcherStatus directly: dim/inert while
// 'idle' (nothing connected), a hollow ring gently pulsing while 'armed'
// (watching, nothing captured yet), a flat grey pause glyph while 'paused',
// and a solid, strongly pulsing fill with a stop glyph while 'capturing' —
// see this file's own header for what each status means and what pressing
// the button does in it.
function drawCaptureButton(ctx: CanvasRenderingContext2D, popup: Rect, status: BeatMatcherStatus, now: number): void {
  const p = captureButtonPosition(popup);
  const capturing = status === 'capturing';
  const armed = status === 'armed';

  ctx.save();
  if (capturing) {
    // Strong pulse while actively recording — same "glow tracks a live
    // process" idiom as ui/clockPulse.ts's beat flash, just continuous
    // rather than per-tick.
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.shadowColor = `rgba(224, 74, 60, ${0.5 + 0.4 * pulse})`;
    ctx.shadowBlur = 10 + 6 * pulse;
  } else if (armed) {
    // Gentle pulse while watching/waiting — deliberately subtler than the
    // capturing glow, so the two states read as distinct at a glance.
    const pulse = 0.5 + 0.5 * Math.sin(now / 500);
    ctx.shadowColor = `rgba(138, 47, 47, ${0.3 + 0.25 * pulse})`;
    ctx.shadowBlur = 4 + 3 * pulse;
  }

  ctx.beginPath();
  ctx.arc(p.x, p.y, CAPTURE_BUTTON_RADIUS, 0, Math.PI * 2);
  if (status === 'idle') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fill();
  } else if (armed) {
    // Hollow ring — "watching," not yet actually recording.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = CAPTURE_ARMED_COLOR;
    ctx.stroke();
  } else {
    ctx.fillStyle = capturing ? CAPTURE_ACTIVE_COLOR : CAPTURE_PAUSED_COLOR;
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  if (capturing) {
    // Stop icon (square)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    const half = 3.5;
    ctx.fillRect(p.x - half, p.y - half, half * 2, half * 2);
  } else if (status === 'paused') {
    // Pause icon (two bars)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(p.x - 4, p.y - 3.5, 2.5, 7);
    ctx.fillRect(p.x + 1.5, p.y - 3.5, 2.5, 7);
  } else {
    // Record icon (dot) — dim once nothing's connected to capture from.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = armed ? CAPTURE_ARMED_COLOR : 'rgba(255, 255, 255, 0.3)';
    ctx.fill();
  }
  ctx.restore();
}

// Text shown next to (or, once a capture exists and the overlay's closed,
// in place of) the capture button — factored out so both the inline case
// and the overlay case (drawInfoOverlay below) render identical wording.
function captureStatusText(state: BeatMatcherState): string {
  const previousCapture = state.capturedBuffer ? ` (previous: ${state.capturedBuffer.duration.toFixed(2)}s)` : '';
  switch (state.status) {
    case 'armed':
      return `armed — recording starts once it sounds${previousCapture}`;
    case 'paused':
      return state.capturedBuffer
        ? `captured ${state.capturedBuffer.duration.toFixed(2)}s — press record to re-arm`
        : 'paused — press to arm and wait for sound';
    case 'capturing':
      return 'capturing… stops automatically at silence (press to stop now)';
    default:
      return '';
  }
}

// Drawn in the dedicated info row below the title bar (no panel) — the
// normal case whenever there's nothing finished yet to protect from an
// accidental reset (idle, armed, capturing, or paused with no capture at
// all). Independent of the record button's own position — that now lives
// up in the title bar (captureButtonPosition), not in this row.
function drawInlineCaptureInfo(
  ctx: CanvasRenderingContext2D,
  popup: Rect,
  rowTop: number,
  source: Entity | undefined,
  state: BeatMatcherState
): void {
  const left = popupBounds(popup).left + 10;
  ctx.fillStyle = source ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 255, 255, 0.35)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(source ? `source: ${source.label ?? source.kind}` : 'drag an audio source here to begin', left, rowTop + 13);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  const statusText = captureStatusText(state);
  if (statusText) ctx.fillText(statusText, left, rowTop + 28);
}

const INFO_OVERLAY_BG = 'rgba(10, 10, 10, 0.94)';
const INFO_OVERLAY_CLOSE_RADIUS = 6;

// Full width, right under the title bar — the record button lives up IN
// the title bar now (captureButtonPosition), not in this row, so there's no
// button position left to avoid overlapping here the way there used to be.
// Drawn on top of the spectrogram's own top edge rather than reflowing the
// popup's layout, since re-arming (what a second press of the button does
// from here) is about to reset everything else anyway.
function infoOverlayRect(popup: Rect): { left: number; top: number; width: number; height: number } {
  const b = popupBounds(popup);
  return { left: b.left, top: b.top + TITLE_HEIGHT, width: popup.width, height: TRACK_ROW_HEIGHT };
}

function infoOverlayClosePosition(popup: Rect): Point {
  const r = infoOverlayRect(popup);
  return { x: r.left + r.width - 12, y: r.top + 12 };
}

// The "press record to re-arm" confirm panel (see pressBeatMatcherRecordButton
// and this file's own header) — an overlay in the sense that it's drawn on
// top of whatever's already there rather than reflowing the popup's own
// layout, since re-arming is about to reset everything else regardless.
function drawInfoOverlay(ctx: CanvasRenderingContext2D, popup: Rect, state: BeatMatcherState, source: Entity | undefined): void {
  const r = infoOverlayRect(popup);
  ctx.save();
  ctx.fillStyle = INFO_OVERLAY_BG;
  ctx.fillRect(r.left, r.top, r.width, r.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(r.left, r.top, r.width, r.height);

  ctx.fillStyle = source ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.4)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(source ? `source: ${source.label ?? source.kind}` : 'no source', r.left + 8, r.top + 13);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.fillText(captureStatusText(state), r.left + 8, r.top + 28);

  const close = infoOverlayClosePosition(popup);
  ctx.beginPath();
  ctx.arc(close.x, close.y, INFO_OVERLAY_CLOSE_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.beginPath();
  ctx.moveTo(close.x - 2.5, close.y - 2.5);
  ctx.lineTo(close.x + 2.5, close.y + 2.5);
  ctx.moveTo(close.x + 2.5, close.y - 2.5);
  ctx.lineTo(close.x - 2.5, close.y + 2.5);
  ctx.stroke();
  ctx.restore();
}

const NOTE_COLOR = '#c98a3c'; // matches ACCENT (ui/palette.ts) — this track's only kind of mark, no per-channel color needed
const NOTE_EDGE_COLOR = 'rgba(0, 0, 0, 0.5)';

// The track row once there's a capture to author against — paint-a-note
// blocks aligned to the same fit-to-width timeline the spectrogram/ruler
// use, drawn in its own dedicated row (see drawBeatMatcherPopup) rather
// than overlaid on the spectrogram image itself, so notes stay legible
// regardless of what's under them.
function drawBeatMatcherNoteTrack(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  const rowTop = grid.trackTop;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(grid.left, rowTop, grid.right - grid.left, TRACK_ROW_HEIGHT);

  if (!state.capturedBuffer) {
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.rect(grid.left, rowTop, grid.right - grid.left, TRACK_ROW_HEIGHT);
  ctx.clip();

  const noteTop = rowTop + 6;
  const noteHeight = TRACK_ROW_HEIGHT - 12;
  const playhead = currentBeatMatcherPlaybackSeconds(state);

  for (const note of state.notes) {
    const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
    const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
    if (right < grid.left || left > grid.right) continue;
    const width = Math.max(2, right - left);
    // A brief brightening while the playhead is actually crossing it — same
    // "highlight whatever the cursor is currently over" idea as
    // ui/sequencer.ts's own playingFraction, just a flat highlight rather
    // than a wipe (this track has no per-note envelope to visualize a
    // progress fraction against).
    const crossing = state.playing && playhead >= note.onsetSeconds && playhead < note.onsetSeconds + note.durationSeconds;
    ctx.fillStyle = crossing ? shadeColor(NOTE_COLOR, 1.5) : NOTE_COLOR;
    ctx.fillRect(left, noteTop, width, noteHeight);
    ctx.strokeStyle = NOTE_EDGE_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(left, noteTop, width, noteHeight);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(grid.left, rowTop, grid.right - grid.left, TRACK_ROW_HEIGHT);
  ctx.restore();
}

function drawSpectrogramBand(ctx: CanvasRenderingContext2D, grid: Grid, state: BeatMatcherState): void {
  const bandTop = grid.trackBottom;
  const width = grid.right - grid.left;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(grid.left, bandTop, width, SPECTROGRAM_HEIGHT);

  if (state.spectrogramImage && state.capturedBuffer) {
    const duration = state.capturedBuffer.duration;
    const image = state.spectrogramImage;
    // The image spans the WHOLE clip (one column per STFT hop) — sample
    // just the currently-visible zoomSeconds/scrollSeconds window out of
    // it via drawImage's source rect, so zoom/scroll never need to
    // recompute the spectrogram itself.
    const sx = duration > 0 ? (state.scrollSeconds / duration) * image.width : 0;
    const sWidth = duration > 0 ? Math.max(1, (state.zoomSeconds / duration) * image.width) : image.width;
    ctx.drawImage(image, sx, 0, sWidth, image.height, grid.left, bandTop, width, SPECTROGRAM_HEIGHT);
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no capture yet', (grid.left + grid.right) / 2, bandTop + SPECTROGRAM_HEIGHT / 2);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(grid.left, bandTop, width, SPECTROGRAM_HEIGHT);
  ctx.restore();
}

// Faint vertical gridlines spanning the track + spectrogram + ruler rows
// together (grid.trackTop..grid.rulerBottom) — same adaptive step-picking
// as the ruler's own labels below (gridStepSeconds), panned by
// scrollSeconds. Drawn on top of the track/spectrogram content (both have
// opaque fills, unlike ui/sequencer.ts's own translucent lanes, so a line
// drawn underneath would just be hidden) but kept faint enough not to
// compete with either.
function drawBeatMatcherTimeGrid(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  if (pxPerSec <= 0) return;
  const step = gridStepSeconds(pxPerSec);
  ctx.save();
  ctx.beginPath();
  ctx.rect(grid.left, grid.trackTop, grid.right - grid.left, grid.rulerBottom - grid.trackTop);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  const firstLine = Math.ceil(state.scrollSeconds / step) * step;
  for (let s = firstLine; ; s += step) {
    const x = secondsToX(grid, pxPerSec, state.scrollSeconds, s);
    if (x > grid.right) break;
    ctx.beginPath();
    ctx.moveTo(x, grid.trackTop);
    ctx.lineTo(x, grid.rulerBottom);
    ctx.stroke();
  }
  ctx.restore();
}

// The ruler's own labels — reuses ui/organelle.ts's own adaptive
// step-picking (0.1s/1s/10s/..., widening at wider zooms so labels never
// crowd together), same step drawBeatMatcherTimeGrid uses so every label
// lines up with its own gridline. Panned by scrollSeconds, unlike the
// envelope popup's own curve (which always starts at 0 and never needed to).
function drawTimeRuler(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  if (pxPerSec <= 0) return;
  const step = gridStepSeconds(pxPerSec);
  const rulerTop = grid.rulerTop;

  ctx.save();
  ctx.beginPath();
  ctx.rect(grid.left, rulerTop, grid.right - grid.left, RULER_HEIGHT);
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const firstLine = Math.ceil(state.scrollSeconds / step) * step;
  for (let s = firstLine; ; s += step) {
    const x = secondsToX(grid, pxPerSec, state.scrollSeconds, s);
    if (x > grid.right) break;
    ctx.fillText(step < 1 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`, x, rulerTop + 5);
  }
  ctx.restore();
}

// The playback line — bright, glowing while actually playing (a plain
// static marker while stopped reads as "paused here," not "about to move"),
// spanning the track row AND the spectrogram (per this file's own header:
// an aligned cursor over both). Skipped entirely once scrolled out of the
// visible window rather than clamping it to an edge, which would
// misleadingly suggest the playhead is still nearby.
function drawBeatMatcherPlaybackLine(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  const playX = secondsToX(grid, pxPerSec, state.scrollSeconds, currentBeatMatcherPlaybackSeconds(state));
  if (playX < grid.left || playX > grid.right) return;
  ctx.save();
  if (state.playing) {
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 8;
  }
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, grid.trackTop);
  ctx.lineTo(playX, grid.spectrogramBottom);
  ctx.stroke();
  ctx.restore();
}

function drawRewindIcon(ctx: CanvasRenderingContext2D, center: Point): void {
  const s = TRANSPORT_BUTTON_RADIUS * 0.55;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  for (const dx of [0, s * 0.9]) {
    ctx.beginPath();
    ctx.moveTo(center.x + s * 0.7 - dx, center.y - s * 0.8);
    ctx.lineTo(center.x + s * 0.7 - dx, center.y + s * 0.8);
    ctx.lineTo(center.x - s * 0.2 - dx, center.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawTransportPlayIcon(ctx: CanvasRenderingContext2D, center: Point, playing: boolean): void {
  const s = TRANSPORT_BUTTON_RADIUS * 0.6;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  if (playing) {
    const barWidth = s * 0.5;
    const barHeight = s * 1.6;
    ctx.fillRect(center.x - s * 0.7, center.y - barHeight / 2, barWidth, barHeight);
    ctx.fillRect(center.x + s * 0.2, center.y - barHeight / 2, barWidth, barHeight);
  } else {
    ctx.beginPath();
    ctx.moveTo(center.x - s * 0.5, center.y - s * 0.8);
    ctx.lineTo(center.x - s * 0.5, center.y + s * 0.8);
    ctx.lineTo(center.x + s * 0.9, center.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawTransportButtonRing(ctx: CanvasRenderingContext2D, center: Point): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, TRANSPORT_BUTTON_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// A small rounded-rect label button, distinct from the circular transport
// buttons either side of it since it shows text rather than an icon —
// brighter than "1/1" (normal speed, nothing special in effect) once
// actually slowed down, so a glance at the title bar shows whether it's
// active.
function drawSpeedControl(ctx: CanvasRenderingContext2D, popup: Rect, speed: number): void {
  const p = speedControlPosition(popup);
  const slowed = speed !== 1;
  ctx.save();
  ctx.beginPath();
  const left = p.x - SPEED_CONTROL_WIDTH / 2;
  const top = p.y - SPEED_CONTROL_HEIGHT / 2;
  const radius = 3;
  ctx.roundRect(left, top, SPEED_CONTROL_WIDTH, SPEED_CONTROL_HEIGHT, radius);
  ctx.strokeStyle = slowed ? ACCENT : 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = slowed ? 1.5 : 1;
  ctx.stroke();
  ctx.fillStyle = slowed ? ACCENT : 'rgba(255, 255, 255, 0.8)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(beatMatcherSpeedLabel(speed), p.x, p.y + 0.5);
  ctx.restore();
}

function drawBeatMatcherTransportButtons(ctx: CanvasRenderingContext2D, popup: Rect, state: BeatMatcherState): void {
  const rewind = rewindButtonPosition(popup);
  const play = playButtonPosition(popup);
  drawTransportButtonRing(ctx, rewind);
  drawRewindIcon(ctx, rewind);
  drawTransportButtonRing(ctx, play);
  drawTransportPlayIcon(ctx, play, state.playing);
  drawSpeedControl(ctx, popup, state.playbackSpeed);
}

// A loop (circular arrow) or stop (square) glyph, same shape as
// ui/sequencer.ts's own drawLoopStopIcon — independent code.
function drawLoopStopIcon(ctx: CanvasRenderingContext2D, center: Point, looping: boolean): void {
  const s = TRANSPORT_BUTTON_RADIUS * 0.55;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  if (looping) {
    ctx.lineWidth = 1.5;
    const startAngle = -Math.PI * 0.15;
    const endAngle = Math.PI * 1.15;
    ctx.beginPath();
    ctx.arc(center.x, center.y, s, startAngle, endAngle);
    ctx.stroke();
    const tip = { x: center.x + s * Math.cos(endAngle), y: center.y + s * Math.sin(endAngle) };
    const tangent = endAngle + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(tip.x + Math.cos(tangent - 2.6) * 4, tip.y + Math.sin(tangent - 2.6) * 4);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(tip.x + Math.cos(tangent + 2.6) * 4, tip.y + Math.sin(tangent + 2.6) * 4);
    ctx.stroke();
  } else {
    ctx.fillRect(center.x - s * 0.7, center.y - s * 0.7, s * 1.4, s * 1.4);
  }
  ctx.restore();
}

const END_MARKER_FILL = 'rgba(160, 160, 160, 0.18)';
const END_MARKER_EDGE = 'rgba(220, 220, 220, 0.8)';

// The stop/repeat end marker itself — a soft-filled band with a solid edge
// at the precise loop/stop position (always a real, fixed boundary here,
// unlike the sequencer's own "implicit vs. touched" distinction — see
// BeatMatcherState.endSeconds's own comment) plus its loop/stop toggle.
function drawEndMarker(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  if (!endMarkerVisible(grid, pxPerSec, state)) return;
  const x = endMarkerX(grid, pxPerSec, state);

  ctx.save();
  ctx.fillStyle = END_MARKER_FILL;
  ctx.fillRect(x, grid.trackTop, END_MARKER_WIDTH, grid.rulerBottom - grid.trackTop);
  ctx.strokeStyle = END_MARKER_EDGE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, grid.trackTop);
  ctx.lineTo(x, grid.rulerBottom);
  ctx.stroke();
  ctx.restore();

  const toggle = endMarkerTogglePosition(grid, pxPerSec, state);
  drawTransportButtonRing(ctx, toggle);
  drawLoopStopIcon(ctx, toggle, state.loopAtEnd);
}

// A vertical grip strip flush against the plot's own right edge — dragging
// it rescales zoomSeconds (ui/interaction.ts's draggingTimeAxis, branched by
// feature kind). `active` while actually being dragged.
function drawAxisHandle(ctx: CanvasRenderingContext2D, grid: Grid, active: boolean): void {
  const x = axisHandleX(grid);
  const y = (grid.trackTop + grid.rulerBottom) / 2;
  ctx.save();
  ctx.strokeStyle = active ? ACCENT : 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const dy of [-8, 0, 8]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy - 3);
    ctx.lineTo(x, y + dy + 3);
    ctx.stroke();
  }
  ctx.restore();
}

// A tiny magnifying glass — a lens (with a +/- inside, per direction) — at
// the axis handle's own icon positions, same as ui/sequencer.ts's own
// drawZoomIcon.
function drawZoomIcon(ctx: CanvasRenderingContext2D, center: Point, direction: 'in' | 'out'): void {
  const lensRadius = 3;
  const lensCenter = { x: center.x - 1, y: center.y - 1 };
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(lensCenter.x, lensCenter.y, lensRadius, 0, Math.PI * 2);
  ctx.moveTo(lensCenter.x + lensRadius * 0.7, lensCenter.y + lensRadius * 0.7);
  ctx.lineTo(lensCenter.x + lensRadius * 1.8, lensCenter.y + lensRadius * 1.8);
  ctx.moveTo(lensCenter.x - lensRadius * 0.5, lensCenter.y);
  ctx.lineTo(lensCenter.x + lensRadius * 0.5, lensCenter.y);
  if (direction === 'in') {
    ctx.moveTo(lensCenter.x, lensCenter.y - lensRadius * 0.5);
    ctx.lineTo(lensCenter.x, lensCenter.y + lensRadius * 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawBeatMatcherHScrollbar(ctx: CanvasRenderingContext2D, grid: Grid, state: BeatMatcherState): void {
  if (!hScrollbarNeeded(state)) return;
  const track = hScrollbarTrack(grid);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = H_SCROLLBAR_HEIGHT * 0.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(track.x - track.width / 2, track.y);
  ctx.lineTo(track.x + track.width / 2, track.y);
  ctx.stroke();

  const thumbWidth = hThumbWidth(track.width, state);
  const thumbX = hThumbX(track, state);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(thumbX, track.y);
  ctx.lineTo(thumbX + thumbWidth, track.y);
  ctx.stroke();
  ctx.restore();
}

// `isDropHover` — true while a draggable entity is currently poised to drop
// onto this popup (ui/interaction.ts's hoverBeatMatcherId) — highlights the
// interior the same way a filter's own boundary highlights while something
// hovers over it as a containment drop target (ui/render.ts's drawBox
// dropTarget flag).
export function drawBeatMatcherPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  isDropHover: boolean,
  isAxisDragging: boolean,
  now: number,
  drag?: DragContext
): void {
  const state = beatMatcherStateFor(entity.id);
  const source = state.sourceEntityId ? graph.get(state.sourceEntityId) : undefined;
  const hasCapture = !!state.capturedBuffer;
  advanceBeatMatcherPastEnd(state);
  followBeatMatcherPlayhead(state);

  const popup = beatMatcherPopupRect(graph, owner, drag);
  const b = popupBounds(popup);
  const grid = gridFor(popup);
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(b.left, b.top, popup.width, popup.height);
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(b.left, b.top, popup.width, popup.height);

  // Title bar — the record button sits at its far left (captureButtonPosition),
  // ahead of the title text; rewind/play sit at the right, ahead of the
  // close button (ui/sequencer.ts's own transport button placement) — all
  // always there, regardless of what the rows below are currently showing.
  drawCaptureButton(ctx, popup, state.status, now);
  drawBeatMatcherTransportButtons(ctx, popup, state);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.kind, b.left + 15 + CAPTURE_BUTTON_RADIUS + 8, b.top + TITLE_HEIGHT / 2);

  const close = closeButtonPosition(popup);
  ctx.beginPath();
  ctx.arc(close.x, close.y, CLOSE_BUTTON_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.beginPath();
  ctx.moveTo(close.x - 3, close.y - 3);
  ctx.lineTo(close.x + 3, close.y + 3);
  ctx.moveTo(close.x + 3, close.y - 3);
  ctx.lineTo(close.x - 3, close.y + 3);
  ctx.stroke();

  // The drop zone spans the whole body below the title bar — a drop is
  // still valid anywhere in here (beatMatcherDropTargetAt), track/
  // spectrogram included, so the highlight covers all of it.
  const bodyTop = b.top + TITLE_HEIGHT;
  ctx.fillStyle = isDropHover ? DROP_ZONE_BG_HOVER : DROP_ZONE_BG;
  ctx.fillRect(b.left, bodyTop, popup.width, popup.height - TITLE_HEIGHT);

  // The track row is always there, same height either way — before a
  // capture it shows the source/status info inline; once captured, the
  // exact same space shows the note track instead (see this file's own
  // header). The info text only reappears on demand from there, via the
  // record button, drawn on top of the track (never both at once — see
  // pressBeatMatcherRecordButton).
  if (hasCapture) {
    drawBeatMatcherNoteTrack(ctx, grid, pxPerSec, state);
  } else {
    drawInlineCaptureInfo(ctx, popup, bodyTop, source, state);
  }

  drawSpectrogramBand(ctx, grid, state);
  drawTimeRuler(ctx, grid, pxPerSec, state);

  if (hasCapture) {
    drawBeatMatcherTimeGrid(ctx, grid, pxPerSec, state);
    drawEndMarker(ctx, grid, pxPerSec, state);
    drawBeatMatcherPlaybackLine(ctx, grid, pxPerSec, state);
    drawAxisHandle(ctx, grid, isAxisDragging);
    drawZoomIcon(ctx, axisZoomInIconPosition(grid), 'in');
    drawZoomIcon(ctx, axisZoomOutIconPosition(grid), 'out');
    drawBeatMatcherHScrollbar(ctx, grid, state);
  }

  // Drawn last, on top of everything else in the plot, rather than
  // reflowing the layout — see infoOverlayRect's own comment.
  if (hasCapture && state.infoOverlayOpen) {
    drawInfoOverlay(ctx, popup, state, source);
  }

  ctx.restore();
}
