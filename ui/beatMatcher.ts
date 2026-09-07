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
import { gridStepSeconds, ownerOf, popupRectFor, closeButtonPosition, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import type { HandleKind } from './organelle';
import { drawBodyBulge, drawControlBody, drawControlLabel } from './render';
import { getEntityNodes } from '../audio/graph';
import { startNodeCapture, watchSound } from '../audio/nodeCapture';
import type { LevelWatcher, Recording } from '../audio/nodeCapture';
import { computeSpectrogram, createLiveSpectrogram, renderSpectrogramImage } from './spectrogram';
import type { LiveSpectrogram, SpectrogramData } from './spectrogram';
import { computeOnsetFeatures, pickOnsetCandidates, rankSuggestedOnsets } from './beatMatcherSuggestions';
import type { OnsetFeature } from './beatMatcherSuggestions';
import { getAudioContext, resumeAudioContext } from '../audio/context';
import { ACCENT, shadeColor } from './palette';
import { padRadius, PAD_FLASH_DURATION } from './pads';
import type { InteractionState } from './interaction';

export const BEAT_MATCHER_POPUP_WIDTH = 420;
// Title bar (which also houses the record button — see captureButtonPosition)
// + a fixed-height track row + a thin selection ruler + spectrogram band +
// time ruler + a little bottom padding. The track row is dual-purpose rather
// than collapsing once captured (an earlier version shrank the popup here —
// reverted): before a capture exists it shows the source/status info inline;
// once captured, the exact same space instead shows the note track
// (drawBeatMatcherNoteTrack), so nothing needs to reflow. The two never need
// to show at once — before a capture there's nothing to author notes against
// yet, and once captured the info only reappears on demand (drawInfoOverlay),
// drawn ON TOP of the track row rather than needing its own room.
const TRACK_ROW_HEIGHT = 40;
// The selection ruler sits between the note track and the spectrogram, time-
// aligned with both (see drawSelectionRulerBand/drawSelectionRulerMarkers) —
// thin, since it's just a line of carets, not a full row of content.
const SELECTION_RULER_HEIGHT = 14;
const SPECTROGRAM_HEIGHT = 100;
const RULER_HEIGHT = 16;
const H_SCROLLBAR_HEIGHT = 8;
const BOTTOM_PADDING = 8;
export const BEAT_MATCHER_POPUP_HEIGHT =
  TITLE_HEIGHT +
  TRACK_ROW_HEIGHT +
  SELECTION_RULER_HEIGHT +
  SPECTROGRAM_HEIGHT +
  RULER_HEIGHT +
  H_SCROLLBAR_HEIGHT +
  BOTTOM_PADDING;
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

// Amplitude shape, contained entirely within a note's own [onsetSeconds,
// onsetSeconds + durationSeconds] — same shape as ui/sequencer.ts's own
// NoteEnvelope (attack/decay/release stored as fractions of durationSeconds,
// not absolute seconds, so resizing the note rescales its shape with no
// reclamping), redefined here rather than imported per this file's own
// header on staying independent of ui/sequencer.ts.
export interface BeatMatcherNoteEnvelope {
  attack: number;
  decay: number;
  sustain: number; // level, 0..1
  release: number;
}

// A single onset marker on the track, authored against the spectrogram —
// same pitch/velocity/envelope shape as ui/sequencer.ts's own SequencerNote,
// independent code (see this file's own header).
export interface BeatMatcherNote {
  id: string;
  onsetSeconds: number;
  durationSeconds: number; // always > 0
  // MIDI note number, or null for a drum-like note with no pitch at all
  // (the default — see createBeatMatcherNoteAt) — rendered/reported as "X"
  // until the user actually gives it one.
  pitch: number | null;
  velocity: number; // 0..1
  // null until the user first touches one of the two seed handles (see
  // drawNoteEnvelopeShape/setBeatMatcherNoteEnvelopeFromHandle) — a note
  // with no envelope at all reads as "unshaped," not as some particular
  // default shape.
  envelope: BeatMatcherNoteEnvelope | null;
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
  // Non-null only while 'capturing' — a progressively-built preview
  // (ui/spectrogram.ts's createLiveSpectrogram) fed raw samples as they
  // arrive, so drawSpectrogramBand has something to show while the capture
  // is still underway instead of a blank "no capture yet" band. Replaced by
  // the real spectrogramImage (and nulled) the instant the capture actually
  // finishes — see beginBeatMatcherCapture/finishBeatMatcherCapture.
  liveSpectrogram: LiveSpectrogram | null;
  // Raw analysis data behind spectrogramImage — computeSpectrogram's result
  // was previously discarded right after rendering the image, but onset-
  // suggestion (below) needs the actual frames, not just the picture of
  // them. Set alongside spectrogramImage, cleared everywhere it is.
  spectrogramData: SpectrogramData | null;
  // Per-frame feature vectors (ui/beatMatcherSuggestions.ts) computed once
  // right after a capture finishes — expensive-ish to build (one pass over
  // every STFT frame) but cheap to search, so this is kept around rather
  // than recomputed on demand. onsetCandidateSeconds is the reduced set of
  // plausible onset locations (spectral-flux peaks) actually searched for
  // suggestions — see suggestedBeatMatcherOnsets below, which combines both
  // with the current notes/currentPointSeconds every time it's called
  // (a cheap distance scan, unlike the two fields here).
  onsetFeatures: OnsetFeature[] | null;
  onsetCandidateSeconds: number[] | null;
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

  // --- Selection ruler ---------------------------------------------------
  // A time-aligned strip between the note track and the spectrogram (see
  // drawSelectionRulerBand/drawSelectionRulerMarkers) — a start/end pair
  // marking a region (highlighted between the two), and a separate "current
  // point" used both as a note-drag snap target (see
  // applyBeatMatcherNoteSnap) and to select whatever note it sits over (see
  // setBeatMatcherCurrentPoint). All null until first touched — quiet until
  // the user actually uses this, same "unshaped until first touched"
  // convention as BeatMatcherNote.envelope. Reset (back to null) whenever a
  // fresh capture completes (finishBeatMatcherCapture) — a selection/point
  // against one clip means nothing against a new, different-length one.
  selectionStartSeconds: number | null;
  selectionEndSeconds: number | null;
  currentPointSeconds: number | null;
  // The one-shot reference used by suggestedBeatMatcherOnsets (ui/
  // beatMatcherSuggestions.ts) before any notes are placed — deliberately a
  // separate field from currentPointSeconds rather than reusing it directly,
  // because currentPointSeconds also moves during a Tab/Shift-Tab walk
  // through suggestions (stepBeatMatcherCandidate) and, feature-selection
  // work has since decided, a landed-on suggestion shouldn't feed straight
  // back in as "this is what a good match looks like" — that would let the
  // algorithm train on its own guesses. Set (replacing whatever was there
  // before, per this feature's "the user's judgment of the exact location is
  // the only one used" spec) by every OTHER way of moving the current point
  // — a plain click, a drag of its own marker, or the arrow-key nudge — see
  // setBeatMatcherCurrentPoint's own `confirm` parameter. Reset alongside
  // currentPointSeconds.
  confirmedPointSeconds: number | null;
  // The gap from confirmedPointSeconds to selectionStartSeconds/
  // selectionEndSeconds, as of the last time the user manually drew or
  // resized the selection (a drag-create, a caret drag, or a keyboard
  // nudge — see captureBeatMatcherSelectionMargins and its call sites in
  // ui/interaction.ts). stepBeatMatcherCandidate reuses these two fixed
  // margins on every Tab/Shift-Tab step rather than re-deriving them from
  // whatever the window currently is — see that function's own comment for
  // why. Null until a selection has been manually drawn at least once, and
  // reset alongside selectionStart/EndSeconds.
  selectionMarginBeforeSeconds: number | null;
  selectionMarginAfterSeconds: number | null;
  // While a selection region exists, playback is bounded to it (see
  // startBeatMatcherPlayback/rewindBeatMatcherPlayback/
  // advanceBeatMatcherPastEnd) — auditioning a specific point, per this
  // feature's own spec — and this decides what happens at the selection's
  // own end: loop back to its start (true) or stop there (false), same
  // "loop vs. stop" meaning as loopAtEnd, just scoped to the selection
  // instead of the whole clip. Toggled via the loop control drawn to the
  // left of the selection region (selectionLoopTogglePosition). Meaningless
  // (but harmless) while no selection exists.
  selectionLoop: boolean;
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
      liveSpectrogram: null,
      spectrogramData: null,
      onsetFeatures: null,
      onsetCandidateSeconds: null,
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
      selectionStartSeconds: null,
      selectionEndSeconds: null,
      selectionMarginBeforeSeconds: null,
      selectionMarginAfterSeconds: null,
      currentPointSeconds: null,
      confirmedPointSeconds: null,
      selectionLoop: false,
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
  // Built up one column at a time as raw samples arrive below, so
  // drawSpectrogramBand can show the capture actually happening instead of
  // staying blank until it finishes.
  const liveSpectrogram = createLiveSpectrogram(getAudioContext().sampleRate);
  state.liveSpectrogram = liveSpectrogram;
  // Tapped before `pan` (audio/graph.ts's EntityNodes) — the entity's own
  // mono mix of its generator + children, unaffected by its stereo canvas
  // position, which is a spatial/performance concern with nothing to do
  // with what's actually being captured for a spectrogram.
  state.recording = startNodeCapture(nodes.output, (chunk) => liveSpectrogram.pushSamples(chunk));
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
    // anything realtime. The onset features/candidates (ui/
    // beatMatcherSuggestions.ts) piggyback on the same SpectrogramData rather
    // than triggering a second analysis pass.
    const spectrogramData = computeSpectrogram(buffer);
    state.spectrogramData = spectrogramData;
    state.spectrogramImage = renderSpectrogramImage(spectrogramData);
    const features = computeOnsetFeatures(spectrogramData);
    state.onsetFeatures = features;
    state.onsetCandidateSeconds = pickOnsetCandidates(features);
    state.liveSpectrogram = null; // the real, offline-computed image now takes over
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
    state.selectionStartSeconds = null;
    state.selectionEndSeconds = null;
    state.selectionMarginBeforeSeconds = null;
    state.selectionMarginAfterSeconds = null;
    state.currentPointSeconds = null;
    state.confirmedPointSeconds = null;
    state.selectionLoop = false;
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
  state.liveSpectrogram = null;
  state.spectrogramData = null;
  state.onsetFeatures = null;
  state.onsetCandidateSeconds = null;
  state.notes = [];
  state.selectionStartSeconds = null;
  state.selectionEndSeconds = null;
  state.selectionMarginBeforeSeconds = null;
  state.selectionMarginAfterSeconds = null;
  state.currentPointSeconds = null;
  state.confirmedPointSeconds = null;
  state.selectionLoop = false;
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
const DEFAULT_NOTE_VELOCITY = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

  // Inherits pitch/velocity/envelope from whichever existing note most
  // recently precedes it (the last one by onset — state.notes stays sorted,
  // per insertNoteSorted) rather than the plain "X"/full-velocity/no-shape
  // defaults every note otherwise starts as — same reasoning as
  // ui/sequencer.ts's own createSequencerNoteAt. The envelope is cloned, not
  // shared, same as duplicateSelectedBeatMatcherNote's own clone.
  let previous: BeatMatcherNote | null = null;
  for (const existing of state.notes) {
    if (existing.onsetSeconds > onset) break;
    previous = existing;
  }

  const note: BeatMatcherNote = {
    id: `beat-note-${nextBeatMatcherNoteId++}`,
    onsetSeconds: onset,
    durationSeconds: MIN_NOTE_DURATION_SECONDS,
    pitch: previous ? previous.pitch : null,
    velocity: previous ? previous.velocity : DEFAULT_NOTE_VELOCITY,
    envelope: previous?.envelope ? { ...previous.envelope } : null,
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

// Sets both edges from `anchorSeconds` (the original press position that
// created the note) and wherever the pointer is now — whichever of the two
// ends up earlier becomes the onset and whichever ends up later becomes the
// end, so dragging backward (right-to-left) from the press point works
// exactly like dragging forward, only resolving "which side is start and
// which is end" once both points are known. Same "normalize whichever
// order was actually dragged" idiom as setBeatMatcherSelectionRange. Used
// only while painting a brand-new note (ui/interaction.ts's 'createSpan'
// drag mode) — once released, further drags on that note go through the
// plain resizeLeft/Right/move above, which each keep one edge fixed.
export function resizeBeatMatcherNoteSpan(featureEntityId: string, noteId: string, anchorSeconds: number, currentSeconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found || !state.capturedBuffer) return;
  const { note, index } = found;
  const prev = state.notes[index - 1];
  const next = state.notes[index + 1];
  const minOnset = prev ? prev.onsetSeconds + prev.durationSeconds : 0;
  const maxEnd = next ? next.onsetSeconds : state.capturedBuffer.duration;
  const rawOnset = Math.min(anchorSeconds, currentSeconds);
  const rawEnd = Math.max(anchorSeconds, currentSeconds);
  const onset = Math.max(minOnset, Math.min(maxEnd - MIN_NOTE_DURATION_SECONDS, rawOnset));
  const end = Math.min(maxEnd, Math.max(onset + MIN_NOTE_DURATION_SECONDS, rawEnd));
  note.onsetSeconds = onset;
  note.durationSeconds = end - onset;
}

// Moves the whole note, preserving its own duration — clamped between its
// neighbors (or 0 / the clip's own end) same as the resize cases above — it
// can never cross past its immediate neighbor. Used for the keyboard nudge
// and as the one-time "settle" step settleBeatMatcherNoteAfterDrag below
// applies once a pointer-drag actually ends; the live pointer-drag itself
// uses dragBeatMatcherNoteAcross instead, which allows exactly the
// neighbor-crossing this function forbids. Same split as ui/sequencer.ts's
// own moveSequencerNote/dragSequencerNoteAcross.
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

// Moves the whole note freely — including past/through other notes, unlike
// moveBeatMatcherNote above — only clamped to the clip's own [0, duration]
// bounds. state.notes is kept re-sorted by onset after every call so every
// OTHER note's own prev/next-neighbor lookups (moveBeatMatcherNote,
// resizeBeatMatcherNoteLeft/Right/Span, snapCandidatesFor, drawing/hit-test
// iteration order) stay correct even though this note's own position in
// that array may now have changed. This is what makes "drag a note over
// another one" possible: the live pointer-drag (ui/interaction.ts's 'move'
// mode) calls this on every pointermove, so the note can freely overlap
// whatever it passes over in transit — settleBeatMatcherNoteAfterDrag below
// is what then resolves that back to a genuinely free gap once the pointer
// is actually released, so the note never PERMANENTLY overlaps another.
// Same shape as ui/sequencer.ts's own dragSequencerNoteAcross.
export function dragBeatMatcherNoteAcross(featureEntityId: string, noteId: string, newOnsetSeconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found || !state.capturedBuffer) return;
  const maxOnset = state.capturedBuffer.duration - found.note.durationSeconds;
  found.note.onsetSeconds = Math.max(0, Math.min(maxOnset, newOnsetSeconds));
  state.notes.sort((a, b) => a.onsetSeconds - b.onsetSeconds);
}

// Called once, right when a 'move' drag actually ends (ui/interaction.ts) —
// dragBeatMatcherNoteAcross above lets the note travel freely past/through
// others while the pointer's still down, so by release it may be sitting
// on top of (or straddling) whichever note it landed near. Reuses
// moveBeatMatcherNote's own neighbor clamp by simply asking it to move to
// wherever the note already is: a no-op if that's already clear, or a snap
// to the nearest valid edge (against its now-current, post-drag neighbors)
// if not. Same shape as ui/sequencer.ts's own settleSequencerNoteAfterDrag.
export function settleBeatMatcherNoteAfterDrag(featureEntityId: string, noteId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found) return;
  moveBeatMatcherNote(featureEntityId, noteId, found.note.onsetSeconds);
}

export function deleteBeatMatcherNote(featureEntityId: string, noteId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  const found = findBeatMatcherNote(state, noteId);
  if (found) state.notes.splice(found.index, 1);
}

// Resolves the plot's own Grid from just (graph, entityId) — same "geometry
// stays private to this file" shape as ui/sequencer.ts's own
// resolveSequencerGrid, used below by the pitch-nudge/envelope-drag actions
// that need real pixel geometry (Grid is declared further down this file,
// in the "Grid / zoom / scroll" section — fine to reference here since
// function declarations and interfaces are both hoisted). Returns null if
// the feature/owner is gone (e.g. popup closed mid-drag).
function resolveBeatMatcherGrid(graph: EntityGraph, entityId: string, drag?: DragContext): Grid | null {
  const entity = graph.get(entityId);
  const owner = entity && ownerOf(graph, entity);
  if (!entity || !owner) return null;
  return gridFor(beatMatcherPopupRect(graph, owner, drag));
}

// --- Note selection --------------------------------------------------------
// A single selected note, app-wide — same "one selection, module-private"
// shape as ui/sequencer.ts's own selectedNote, independent state. This
// track has no channel dimension, so just entityId+noteId identifies it.
let selectedNote: { entityId: string; noteId: string } | null = null;

// Which note (if any) currently has its velocity slider open, and where —
// see toggleBeatMatcherVelocitySlider/beatMatcherVelocitySliderOpenFor.
// Same "frozen at wherever it was opened, until the selection moves to a
// DIFFERENT note" shape as ui/sequencer.ts's own velocitySliderOpen.
let velocitySliderOpen: { noteId: string; track: BeatMatcherVelocityTrack } | null = null;

// Which edge (if any) Left/Right's keyboard nudge (nudgeSelectedBeatMatcherNoteTime)
// currently acts on — same shape as ui/sequencer.ts's own noteEdgeFocus.
let noteEdgeFocus: { noteId: string; edge: 'left' | 'right' } | null = null;

export function selectBeatMatcherNote(entityId: string, noteId: string): void {
  if (velocitySliderOpen && velocitySliderOpen.noteId !== noteId) velocitySliderOpen = null;
  if (noteEdgeFocus && noteEdgeFocus.noteId !== noteId) noteEdgeFocus = null;
  selectedNote = { entityId, noteId };
}

export function deselectBeatMatcherNote(): void {
  selectedNote = null;
  velocitySliderOpen = null;
  noteEdgeFocus = null;
}

// Records which edge (or null, for the whole note) the LAST move/resize
// grab touched — ui/interaction.ts calls this right after selectBeatMatcherNote
// from every note-drag pointerdown case, same as ui/sequencer.ts's own
// setSelectedNoteEdgeFocus.
export function setSelectedBeatMatcherNoteEdgeFocus(edge: 'left' | 'right' | null): void {
  if (!selectedNote) return;
  noteEdgeFocus = edge === null ? null : { noteId: selectedNote.noteId, edge };
}

// The orange edge highlight (drawBeatMatcherNote) and
// nudgeSelectedBeatMatcherNoteTime both key off this rather than the
// module-private `noteEdgeFocus` directly, so a stale focus for some other
// note can never leak through.
export function selectedBeatMatcherNoteEdgeFocus(noteId: string): 'left' | 'right' | null {
  return noteEdgeFocus && noteEdgeFocus.noteId === noteId ? noteEdgeFocus.edge : null;
}

// Self-heals a stale selection (the note no longer exists — e.g. deleted,
// or a fresh capture cleared the whole track) the same way
// ui/sequencer.ts's own selectedNoteFor verifies its own module state
// before trusting it.
export function selectedBeatMatcherNoteFor(entityId: string): { noteId: string } | null {
  if (!selectedNote || selectedNote.entityId !== entityId) return null;
  const state = beatMatcherStateFor(entityId);
  if (!state.notes.some((n) => n.id === selectedNote!.noteId)) {
    selectedNote = null;
    return null;
  }
  return { noteId: selectedNote.noteId };
}

export function hasSelectedBeatMatcherNote(): boolean {
  return !!selectedNote && selectedBeatMatcherNoteFor(selectedNote.entityId) !== null;
}

// --- Selected-note actions ---------------------------------------------
// Delete/duplicate/nudge, all driven by ui/interaction.ts's keyboard
// handling and all resolving the current `selectedNote` internally rather
// than taking it as a parameter — same shape as ui/sequencer.ts's own
// deleteSelectedNote/duplicateSelectedNote/nudgeSelectedNoteTime.

export function deleteSelectedBeatMatcherNote(): void {
  if (!selectedNote) return;
  const { entityId, noteId } = selectedNote;
  if (!selectedBeatMatcherNoteFor(entityId)) return;
  deleteBeatMatcherNote(entityId, noteId);
  deselectBeatMatcherNote();
}

// Clones the selected note immediately after itself (touching its own end),
// clamped against whatever note follows it — same clamp shape
// createBeatMatcherNoteAt uses for a fresh note. No-ops (returns null) if
// there's no room at all, e.g. the next note already touches this one's end.
export function duplicateSelectedBeatMatcherNote(): string | null {
  if (!selectedNote) return null;
  const { entityId, noteId } = selectedNote;
  if (!selectedBeatMatcherNoteFor(entityId)) return null;
  const state = beatMatcherStateFor(entityId);
  if (!state.capturedBuffer) return null;
  const found = findBeatMatcherNote(state, noteId);
  if (!found) return null;
  const { note, index } = found;
  const onset = note.onsetSeconds + note.durationSeconds;
  const upperBound = index < state.notes.length - 1 ? state.notes[index + 1].onsetSeconds : state.capturedBuffer.duration;
  const duration = Math.min(note.durationSeconds, upperBound - onset);
  if (duration < MIN_NOTE_DURATION_SECONDS) return null;

  const clone: BeatMatcherNote = {
    id: `beat-note-${nextBeatMatcherNoteId++}`,
    onsetSeconds: onset,
    durationSeconds: duration,
    pitch: note.pitch,
    velocity: note.velocity,
    envelope: note.envelope ? { ...note.envelope } : null,
  };
  insertNoteSorted(state.notes, clone);
  selectBeatMatcherNote(entityId, clone.id);
  return clone.id;
}

const NOTE_NUDGE_PX = 4; // arrow-key time nudge, converted through the current zoom, same as ui/sequencer.ts's own

// Left/Right keyboard shortcut: by default nudges the whole note, but if the
// last move/resize grab was against one of its edges, nudges just that edge
// instead — same shape as ui/sequencer.ts's own nudgeSelectedNoteTime.
export function nudgeSelectedBeatMatcherNoteTime(graph: EntityGraph, direction: -1 | 1): void {
  if (!selectedNote) return;
  const { entityId, noteId } = selectedNote;
  if (!selectedBeatMatcherNoteFor(entityId)) return;
  closeBeatMatcherVelocitySlider();
  const grid = resolveBeatMatcherGrid(graph, entityId);
  if (!grid) return;
  const state = beatMatcherStateFor(entityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found) return;
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  if (pxPerSec <= 0) return;
  const step = direction * (NOTE_NUDGE_PX / pxPerSec);
  const note = found.note;
  const edge = selectedBeatMatcherNoteEdgeFocus(noteId);
  if (edge === 'left') {
    resizeBeatMatcherNoteLeft(entityId, noteId, note.onsetSeconds + step);
  } else if (edge === 'right') {
    resizeBeatMatcherNoteRight(entityId, noteId, note.onsetSeconds + note.durationSeconds + step);
  } else {
    moveBeatMatcherNote(entityId, noteId, note.onsetSeconds + step);
  }
}

// --- Note pitch entry -----------------------------------------------------
// Keyboard-only, same as ui/sequencer.ts's own pitch entry — there's no
// meaningful pitch axis in this single-track view (its vertical axis is
// nothing at all, unlike the sequencer's per-channel lanes), so pitch gets
// its own tiny keyboard shortcuts instead of a drag gesture.

// The pitch a null note seeds to the moment the keyboard first gives it one
// — not the note's own default (null/"X"), just the starting point for that
// first keypress. Same value as ui/sequencer.ts's own DEFAULT_SEED_PITCH.
const DEFAULT_SEED_PITCH = 60; // "C4" / middle C

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`;
}

// Resolves the selected note's own BeatMatcherNote object, self-healing via
// selectedBeatMatcherNoteFor the same way every other selected-note action
// here does.
function selectedBeatMatcherNoteObject(): BeatMatcherNote | null {
  if (!selectedNote) return null;
  const { entityId, noteId } = selectedNote;
  if (!selectedBeatMatcherNoteFor(entityId)) return null;
  const found = findBeatMatcherNote(beatMatcherStateFor(entityId), noteId);
  return found ? found.note : null;
}

// Up/Down keyboard shortcut: moves the selected note exactly one semitone. A
// null pitch ("X") has nothing to offset from, so the first press instead
// reveals a concrete starting point at DEFAULT_SEED_PITCH regardless of
// direction — only the second and later presses actually move by a
// semitone.
export function nudgeSelectedBeatMatcherNotePitch(direction: -1 | 1): void {
  const note = selectedBeatMatcherNoteObject();
  if (!note) return;
  closeBeatMatcherVelocitySlider();
  note.pitch = note.pitch === null ? DEFAULT_SEED_PITCH : clamp(note.pitch + direction, 0, 127);
}

// a-g keyboard shortcut: sets the selected note's pitch CLASS (0=C .. 11=B)
// while leaving its octave alone — mirrors setSelectedBeatMatcherNotePitchOctave
// below. A null pitch has no octave to keep, so it seeds from
// DEFAULT_SEED_PITCH's own octave first.
export function setSelectedBeatMatcherNotePitchClass(pitchClass: number): void {
  const note = selectedBeatMatcherNoteObject();
  if (!note) return;
  closeBeatMatcherVelocitySlider();
  const band = Math.floor((note.pitch ?? DEFAULT_SEED_PITCH) / 12);
  note.pitch = clamp(band * 12 + pitchClass, 0, 127);
}

// 0-9 keyboard shortcut: sets the selected note's octave (as in "C4") while
// leaving its pitch class alone. A null pitch has no pitch class to keep,
// so it seeds to C.
export function setSelectedBeatMatcherNotePitchOctave(octave: number): void {
  const note = selectedBeatMatcherNoteObject();
  if (!note) return;
  closeBeatMatcherVelocitySlider();
  const pitchClass = note.pitch === null ? 0 : ((note.pitch % 12) + 12) % 12;
  note.pitch = clamp((octave + 1) * 12 + pitchClass, 0, 127);
}

// '#' keyboard shortcut: raises the selected note by a semitone, same as
// nudgeSelectedBeatMatcherNotePitch(1) once a pitch already exists — a sharp
// only makes sense applied to an actual note, so (unlike the arrow key) this
// has no null-pitch seed of its own.
export function sharpenSelectedBeatMatcherNote(): void {
  const note = selectedBeatMatcherNoteObject();
  if (!note || note.pitch === null) return;
  closeBeatMatcherVelocitySlider();
  note.pitch = clamp(note.pitch + 1, 0, 127);
}

// --- Velocity slider ---------------------------------------------------
// Velocity itself is represented on the note's own body (opacity + a
// centered percentage — see drawBeatMatcherNote). Clicking that percentage,
// only reachable while the note is selected, reveals a small vertical
// slider floating above the note — same shape as ui/sequencer.ts's own
// toggleVelocitySlider/velocitySliderOpenFor.

const VELOCITY_SLIDER_HIT_WIDTH = 14;
const VELOCITY_SLIDER_HEIGHT = 50;
const VELOCITY_SLIDER_HIT_MARGIN = 5;

// A vertical fader track — same shape as ui/sequencer.ts's own
// VelocityTrack, kept separate (and separately named) rather than shared
// since this one is never resolved from a control spec.
export interface BeatMatcherVelocityTrack {
  x: number;
  top: number;
  bottom: number;
}

// Positions the track so the point representing `velocity` lands exactly at
// `pointer` — same "the handle appears right where the cursor already is"
// reasoning as ui/sequencer.ts's own velocityDragTrackAtPointer.
export function beatMatcherVelocityDragTrackAtPointer(pointer: Point, velocity: number): BeatMatcherVelocityTrack {
  const bottom = pointer.y + velocity * VELOCITY_SLIDER_HEIGHT;
  return { x: pointer.x, top: bottom - VELOCITY_SLIDER_HEIGHT, bottom };
}

// Absolute-position "fader" set against an already-resolved, FIXED track —
// same reasoning as ui/sequencer.ts's own setNoteVelocityFromTrack.
export function setBeatMatcherNoteVelocityFromTrack(entityId: string, noteId: string, track: BeatMatcherVelocityTrack, y: number): void {
  const found = findBeatMatcherNote(beatMatcherStateFor(entityId), noteId);
  if (!found) return;
  const fraction = 1 - (y - track.top) / (track.bottom - track.top);
  found.note.velocity = clamp(fraction, 0, 1);
}

// Returns the track to start dragging against if the slider ended up open
// (vs. null, having just been dismissed) — same shape as
// ui/sequencer.ts's own toggleVelocitySlider.
export function toggleBeatMatcherVelocitySlider(noteId: string, openAtTrack: BeatMatcherVelocityTrack): BeatMatcherVelocityTrack | null {
  if (velocitySliderOpen && velocitySliderOpen.noteId === noteId) {
    velocitySliderOpen = null;
    return null;
  }
  velocitySliderOpen = { noteId, track: openAtTrack };
  return openAtTrack;
}

// The slider's current track, if it's open for this note — the single
// source of truth for both drawing and hit-testing.
export function beatMatcherVelocitySliderOpenFor(noteId: string): BeatMatcherVelocityTrack | null {
  return velocitySliderOpen && velocitySliderOpen.noteId === noteId ? velocitySliderOpen.track : null;
}

// Unconditionally dismisses the slider, regardless of which note (if any)
// it's open for — every action on the selected note other than dragging the
// slider itself calls this, same as ui/sequencer.ts's own closeVelocitySlider.
export function closeBeatMatcherVelocitySlider(): void {
  velocitySliderOpen = null;
}

function drawBeatMatcherVelocitySlider(
  ctx: CanvasRenderingContext2D,
  state: BeatMatcherState,
  noteId: string,
  track: BeatMatcherVelocityTrack
): void {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(track.x, track.top);
  ctx.lineTo(track.x, track.bottom);
  ctx.stroke();

  const thumbY = track.bottom - note.velocity * (track.bottom - track.top);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(track.x - 7, thumbY);
  ctx.lineTo(track.x + 7, thumbY);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`velocity ${Math.round(note.velocity * 100)}%`, track.x, track.top - 6);
  ctx.restore();
}

function hitTestBeatMatcherVelocitySlider(track: BeatMatcherVelocityTrack, point: Point): boolean {
  return (
    point.x >= track.x - VELOCITY_SLIDER_HIT_WIDTH / 2 - VELOCITY_SLIDER_HIT_MARGIN &&
    point.x <= track.x + VELOCITY_SLIDER_HIT_WIDTH / 2 + VELOCITY_SLIDER_HIT_MARGIN &&
    point.y >= track.top - VELOCITY_SLIDER_HIT_MARGIN &&
    point.y <= track.bottom + VELOCITY_SLIDER_HIT_MARGIN
  );
}

// --- Duplicate button ----------------------------------------------------
// A small "+" just past the selected note's own right edge, for
// duplicateSelectedBeatMatcherNote — same shape as ui/sequencer.ts's own
// duplicate button.

const DUPLICATE_BUTTON_RADIUS = 5;
const DUPLICATE_BUTTON_GAP = 12;

function duplicateButtonPosition(grid: Grid, pxPerSec: number, state: BeatMatcherState, noteId: string): Point | null {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return null;
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  if (right < grid.left || right > grid.right) return null;
  const x = right + DUPLICATE_BUTTON_GAP;
  if (x + DUPLICATE_BUTTON_RADIUS > grid.right) return null;
  return { x, y: (grid.trackTop + grid.trackBottom) / 2 };
}

function hitTestDuplicateButton(
  grid: Grid,
  pxPerSec: number,
  state: BeatMatcherState,
  selected: { noteId: string } | null,
  point: Point
): boolean {
  if (!selected) return false;
  const center = duplicateButtonPosition(grid, pxPerSec, state, selected.noteId);
  return !!center && dist(point, center) <= DUPLICATE_BUTTON_RADIUS + 3;
}

function drawDuplicateButton(ctx: CanvasRenderingContext2D, center: Point): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, DUPLICATE_BUTTON_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.lineCap = 'round';
  const s = DUPLICATE_BUTTON_RADIUS * 0.5;
  ctx.beginPath();
  ctx.moveTo(center.x - s, center.y);
  ctx.lineTo(center.x + s, center.y);
  ctx.moveTo(center.x, center.y - s);
  ctx.lineTo(center.x, center.y + s);
  ctx.stroke();
  ctx.restore();
}

// --- Note envelope shape ----------------------------------------------
// Draggable ADSR-style handles on the currently-selected note, same
// HandleKind names as ui/organelle.ts's own envelope organelle (imported
// directly rather than redefining an identical type) — but a separate,
// much smaller geometry: this shape always fits entirely inside the note's
// own [onset, onset+duration] box, the way a DAW clip's fade handles never
// extend past the clip itself. Same shape as ui/sequencer.ts's own note
// envelope, independent code (see this file's own header).

const NOTE_CURVE_COLOR = 'rgba(232, 220, 192, 0.9)'; // matches ui/sequencer.ts's own NOTE_CURVE_COLOR
const NOTE_HANDLE_RADIUS = 3.5;
const NOTE_HANDLE_HIT_RADIUS = 7;
const NOTE_SEED_HANDLE_RADIUS = 2;
const NOTE_SEED_HANDLE_COLOR = 'rgba(255, 255, 255, 0.35)';
const NOTE_VERTICAL_INSET = 6; // keeps a note visually clear of the track row's own top/bottom edge
// Extra height trimmed off (on top of NOTE_VERTICAL_INSET) while a note is
// actively being drag-moved — since dragBeatMatcherNoteAcross now lets it
// travel over/through other notes in transit, this keeps its own top/bottom
// edges visually distinct from whatever it's currently passing over. Same
// idea/value as ui/sequencer.ts's own DRAGGED_NOTE_EXTRA_INSET.
const DRAGGED_NOTE_EXTRA_INSET = 3;

// The envelope every note starts as before its first edit — attack=0,
// decay=0, release=0 and sustain=1 is a no-op shape, which conveniently
// also means its attackPeak/decayCorner sit exactly at the note's own
// top-left corner and its releaseStart sits exactly at the top-right —
// precisely where the two subtle "seed" handles are drawn/hit-tested for a
// note with no envelope yet. Same as ui/sequencer.ts's own IDENTITY_ENVELOPE.
const IDENTITY_ENVELOPE: BeatMatcherNoteEnvelope = { attack: 0, decay: 0, sustain: 1, release: 0 };

interface NoteEnvelopePoints {
  start: Point;
  attackPeak: Point;
  decayCorner: Point;
  releaseStart: Point;
  end: Point;
}

function noteEnvelopePoints(left: number, right: number, top: number, bottom: number, envelope: BeatMatcherNoteEnvelope): NoteEnvelopePoints {
  const width = right - left;
  const height = bottom - top;
  const sustainY = top + (1 - envelope.sustain) * height;
  return {
    start: { x: left, y: bottom },
    attackPeak: { x: left + envelope.attack * width, y: top },
    decayCorner: { x: left + (envelope.attack + envelope.decay) * width, y: sustainY },
    releaseStart: { x: right - envelope.release * width, y: sustainY },
    end: { x: right, y: bottom },
  };
}

// The envelope's own gain (0..1) at `fraction` (0..1) across the note's own
// [onset, onset+duration] — used by drawEnvelopeCrossingDot to trace the
// live playhead along the curve exactly. Same as ui/sequencer.ts's own
// envelopeValueAtFraction.
function envelopeValueAtFraction(envelope: BeatMatcherNoteEnvelope, fraction: number): number {
  const decayEnd = envelope.attack + envelope.decay;
  const releaseStart = 1 - envelope.release;
  if (fraction <= envelope.attack) {
    return envelope.attack > 0 ? fraction / envelope.attack : 1;
  }
  if (fraction <= decayEnd) {
    const local = envelope.decay > 0 ? (fraction - envelope.attack) / envelope.decay : 1;
    return 1 - local * (1 - envelope.sustain);
  }
  if (fraction <= releaseStart) {
    return envelope.sustain;
  }
  const local = envelope.release > 0 ? (fraction - releaseStart) / envelope.release : 1;
  return envelope.sustain * (1 - local);
}

function drawNoteEnvelopeHandle(ctx: CanvasRenderingContext2D, p: Point, active: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, active ? NOTE_HANDLE_RADIUS + 1 : NOTE_HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = active ? ACCENT : NOTE_CURVE_COLOR;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawNoteSeedHandle(ctx: CanvasRenderingContext2D, p: Point, active: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, active ? NOTE_SEED_HANDLE_RADIUS + 1 : NOTE_SEED_HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = active ? ACCENT : NOTE_SEED_HANDLE_COLOR;
  ctx.fill();
  ctx.restore();
}

// Selected-note body: a note with no envelope yet keeps its plain flat
// fill, with only the two subtle seed handles drawn on top. Once an
// envelope exists (first touch of either seed handle — see
// setBeatMatcherNoteEnvelopeFromHandle), the full ADSR polyline becomes the
// note's own body instead, with all three real handles. Same as
// ui/sequencer.ts's own drawNoteEnvelopeShape.
function drawNoteEnvelopeShape(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  top: number,
  bottom: number,
  note: BeatMatcherNote,
  activeHandle: HandleKind | null,
  showHandles: boolean
): void {
  if (!note.envelope) {
    ctx.save();
    ctx.fillStyle = NOTE_FILL;
    ctx.fillRect(left, top, Math.max(1, right - left), bottom - top);
    ctx.restore();
    if (showHandles) {
      const pts = noteEnvelopePoints(left, right, top, bottom, IDENTITY_ENVELOPE);
      drawNoteSeedHandle(ctx, pts.attackPeak, activeHandle === 'attack');
      drawNoteSeedHandle(ctx, pts.releaseStart, activeHandle === 'release');
    }
    return;
  }

  const pts = noteEnvelopePoints(left, right, top, bottom, note.envelope);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts.start.x, pts.start.y);
  ctx.lineTo(pts.attackPeak.x, pts.attackPeak.y);
  ctx.lineTo(pts.decayCorner.x, pts.decayCorner.y);
  ctx.lineTo(pts.releaseStart.x, pts.releaseStart.y);
  ctx.lineTo(pts.end.x, pts.end.y);
  ctx.lineTo(pts.end.x, bottom);
  ctx.closePath();
  ctx.fillStyle = NOTE_FILL;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(pts.start.x, pts.start.y);
  ctx.lineTo(pts.attackPeak.x, pts.attackPeak.y);
  ctx.lineTo(pts.decayCorner.x, pts.decayCorner.y);
  ctx.lineTo(pts.releaseStart.x, pts.releaseStart.y);
  ctx.lineTo(pts.end.x, pts.end.y);
  ctx.strokeStyle = NOTE_CURVE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  if (showHandles) {
    drawNoteEnvelopeHandle(ctx, pts.attackPeak, activeHandle === 'attack');
    drawNoteEnvelopeHandle(ctx, pts.decayCorner, activeHandle === 'decaySustain');
    drawNoteEnvelopeHandle(ctx, pts.releaseStart, activeHandle === 'release');
  }
}

// The live playhead's own position on the envelope curve, while a note is
// being crossed — traces the actual shape via envelopeValueAtFraction,
// same as ui/sequencer.ts's own drawEnvelopeCrossingDot.
function drawEnvelopeCrossingDot(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  top: number,
  bottom: number,
  envelope: BeatMatcherNoteEnvelope,
  fraction: number
): void {
  const clamped = Math.min(1, Math.max(0, fraction));
  const x = left + clamped * (right - left);
  const value = envelopeValueAtFraction(envelope, clamped);
  const y = top + (1 - value) * (bottom - top);
  ctx.save();
  ctx.shadowColor = ACCENT;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = shadeColor(ACCENT, 1.6);
  ctx.fill();
  ctx.restore();
}

// Before an envelope exists, only the two seed handles (attack/release) are
// reachable — same as ui/sequencer.ts's own hitTestNoteEnvelopeHandle.
function hitTestNoteEnvelopeHandle(
  grid: Grid,
  pxPerSec: number,
  state: BeatMatcherState,
  selected: { noteId: string } | null,
  point: Point
): HandleKind | null {
  if (!selected) return null;
  const note = state.notes.find((n) => n.id === selected.noteId);
  if (!note) return null;
  const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  const top = grid.trackTop + NOTE_VERTICAL_INSET;
  const bottom = grid.trackBottom - NOTE_VERTICAL_INSET;
  const pts = noteEnvelopePoints(left, right, top, bottom, note.envelope ?? IDENTITY_ENVELOPE);

  if (dist(point, pts.attackPeak) <= NOTE_HANDLE_HIT_RADIUS) return 'attack';
  if (note.envelope && dist(point, pts.decayCorner) <= NOTE_HANDLE_HIT_RADIUS) return 'decaySustain';
  if (dist(point, pts.releaseStart) <= NOTE_HANDLE_HIT_RADIUS) return 'release';
  return null;
}

// True while the decay/sustain handle sits exactly on top of the attack
// handle — same as ui/sequencer.ts's own attackDecayHandlesCoincide, used
// by ui/interaction.ts to decide whether a press on 'attack' needs to stay
// ambiguous (resolved by drag direction) rather than committing immediately.
export function beatMatcherAttackDecayHandlesCoincide(entityId: string, noteId: string): boolean {
  const found = findBeatMatcherNote(beatMatcherStateFor(entityId), noteId);
  const envelope = found?.note.envelope;
  return !envelope || (envelope.decay === 0 && envelope.sustain === 1);
}

// Absolute-position drag, same shape as setBeatMatcherNoteVelocityFromTrack
// — the handle's new value IS wherever the pointer currently is, converted
// back through the note's own box geometry. Same as ui/sequencer.ts's own
// setNoteEnvelopeFromHandle.
export function setBeatMatcherNoteEnvelopeFromHandle(
  graph: EntityGraph,
  entityId: string,
  noteId: string,
  handle: HandleKind,
  point: Point,
  drag?: DragContext
): void {
  const grid = resolveBeatMatcherGrid(graph, entityId, drag);
  if (!grid) return;
  const state = beatMatcherStateFor(entityId);
  const found = findBeatMatcherNote(state, noteId);
  if (!found) return;
  const note = found.note;
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  const width = right - left;
  if (width <= 0) return;

  // First touch of either seed handle materializes the envelope (as the
  // identity shape) before applying this specific handle's own drag on top
  // of it, so touching just one handle doesn't also jump the other,
  // still-untouched dimensions to some arbitrary default.
  if (!note.envelope) note.envelope = { ...IDENTITY_ENVELOPE };
  const envelope = note.envelope;

  if (handle === 'attack') {
    envelope.attack = clamp((point.x - left) / width, 0, 1 - envelope.decay - envelope.release);
    return;
  }

  // Both release and decaySustain sit on the flat sustain line, so a
  // vertical drag on either one raises/lowers that same line — moving the
  // OTHER handle right along with it, since they share this one y value.
  const top = grid.trackTop + NOTE_VERTICAL_INSET;
  const bottom = grid.trackBottom - NOTE_VERTICAL_INSET;
  envelope.sustain = clamp(1 - (point.y - top) / (bottom - top), 0, 1);

  if (handle === 'release') {
    envelope.release = clamp((right - point.x) / width, 0, 1 - envelope.attack - envelope.decay);
  } else {
    const attackPeakX = left + envelope.attack * width;
    envelope.decay = clamp((point.x - attackPeakX) / width, 0, 1 - envelope.attack - envelope.release);
  }
}

// --- Selection ruler -----------------------------------------------------
// A start/end region and a separate "current point" (see BeatMatcherState's
// own comment) — a start/end drag along the ruler defines the region; a
// plain click, or dragging the current point's own marker, moves the point
// instead (see ui/interaction.ts's own pointerdown/pointermove handling for
// exactly which gesture does which). The point also doubles as an extra
// snap target for note dragging in the track above (applyBeatMatcherNoteSnap
// below) — and so, while a Tab/Shift-Tab walk has it diverge from
// confirmedPointSeconds, does the confirmed point: both stay visible
// (drawCurrentPointLine/drawConfirmedPointLine) and both stay snappable
// (snapCandidatesFor) for as long as they differ.

// Moves the current point, clamped to the clip's own bounds, and selects
// whatever note (if any) now sits under it — the one part of this feature
// that reaches into note selection, per this feature's own spec.
//
// `confirm` (default true) also updates confirmedPointSeconds — the
// reference suggestedBeatMatcherOnsets trains on — replacing whatever
// confirmed position was there before. Every caller except
// stepBeatMatcherCandidate's Tab/Shift-Tab walk wants this: a click, a drag
// of the marker, or an arrow-key nudge is the user saying "here, exactly,"
// where landing on a suggestion mid-Tab-walk is not.
export function setBeatMatcherCurrentPoint(featureEntityId: string, seconds: number, confirm = true): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.capturedBuffer) return;
  const clamped = Math.max(0, Math.min(state.capturedBuffer.duration, seconds));
  state.currentPointSeconds = clamped;
  if (confirm) state.confirmedPointSeconds = clamped;
  const note = state.notes.find((n) => clamped >= n.onsetSeconds && clamped < n.onsetSeconds + n.durationSeconds);
  if (note) selectBeatMatcherNote(featureEntityId, note.id);
}

// Sets the selection region from a drag's two endpoints, in whichever order
// they were actually dragged — always normalized so start <= end. Does NOT
// touch selectionMarginBeforeSeconds/AfterSeconds itself — callers that
// represent a MANUAL edit (a drag, a resize, a nudge) follow up with
// captureBeatMatcherSelectionMargins; stepBeatMatcherCandidate's own
// programmatic calls deliberately don't, since re-deriving margins from its
// own output on every step is what used to make the window grow-only.
export function setBeatMatcherSelectionRange(featureEntityId: string, aSeconds: number, bSeconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.capturedBuffer) return;
  const duration = state.capturedBuffer.duration;
  const a = Math.max(0, Math.min(duration, aSeconds));
  const b = Math.max(0, Math.min(duration, bSeconds));
  state.selectionStartSeconds = Math.min(a, b);
  state.selectionEndSeconds = Math.max(a, b);
}

// Snapshots the current selection window's margins around
// confirmedPointSeconds — the gap from the anchor back to the window start,
// and out to the window end — into selectionMarginBeforeSeconds/
// AfterSeconds. Call this after any MANUAL edit to the window (drag-create,
// caret drag, keyboard nudge — see ui/interaction.ts's beatMatcherSelectionDrag
// handling and this file's own nudgeBeatMatcherSelection), so
// stepBeatMatcherCandidate has a fixed, user-chosen pair of margins to
// reuse on every Tab/Shift-Tab step rather than ones inflated by its own
// prior steps. A no-op while there's no anchor or no window yet.
export function captureBeatMatcherSelectionMargins(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.confirmedPointSeconds === null || state.selectionStartSeconds === null || state.selectionEndSeconds === null) return;
  state.selectionMarginBeforeSeconds = state.confirmedPointSeconds - state.selectionStartSeconds;
  state.selectionMarginAfterSeconds = state.selectionEndSeconds - state.confirmedPointSeconds;
}

// Tab/Shift-Tab (ui/interaction.ts's attachKeyboard, gated on
// state.hoveredBeatMatcherTimelineId) — steps the current point through a
// FIXED set of candidates: the same handful suggestedBeatMatcherOnsets ranks
// (the faint lines actually drawn in the spectrogram, not the much larger
// raw pool of every detected transient in onsetCandidateSeconds), but walked
// in TIME order rather than rank order — rank order made consecutive Tab
// presses jump back and forth across the clip, which reads as random rather
// than "next." The set is a pure function of the confirmed reference (placed
// notes, or confirmedPointSeconds — see suggestedBeatMatcherOnsets), and
// Tab/Shift-Tab never touch that reference (setBeatMatcherCurrentPoint's
// `confirm` parameter, passed false below) — otherwise Tab would train the
// next ranking on its own guess, drifting away from what the user actually
// meant. So the set only changes when the user does define a new reference:
// placing a note, or clicking/dragging/nudging the current point (confirm
// defaults true for all of those) — never as a side effect of walking it.
//
// Wraps at both ends: Tab past the latest candidate lands back on the
// earliest; Shift-Tab before the earliest wraps to the latest. Landing with
// nothing currently selected enters at the natural end for the direction
// pressed — earliest for Tab, latest for Shift-Tab.
//
// Landing on a candidate moves the current point there for audition/preview,
// but deliberately does NOT confirm it as the new reference, per above.
//
// If an audition selection window (selectionStartSeconds/selectionEndSeconds)
// is already active, each step recomputes it to TIGHTLY bracket just the
// confirmed anchor (confirmedPointSeconds — the last manual selection, not
// wherever a previous Tab step left the point) and the current candidate:
// [min(anchor, candidate) - marginBefore, max(anchor, candidate) +
// marginAfter], using the fixed margins captured from the user's last
// manual edit of the window (selectionMarginBeforeSeconds/AfterSeconds —
// lazily captured here on the first step of a walk if nothing's been
// captured yet, since at that point the current window IS still the
// manually-drawn one). Recomputing from the anchor and the fixed margins
// on every step — rather than growing the previous step's own window — is
// what lets the region SHRINK again as well as grow: stepping to a
// candidate closer to the anchor than the previous one pulls the far edge
// back in, instead of it only ever having crept outward.
export function stepBeatMatcherCandidate(featureEntityId: string, direction: 1 | -1): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (!state.capturedBuffer) return;
  const candidates = suggestedBeatMatcherOnsets(state).slice().sort((a, b) => a - b); // time order, frozen while the reference doesn't change
  if (candidates.length === 0) return;
  const previousPoint = state.currentPointSeconds;
  const previousIndex = previousPoint !== null ? candidates.indexOf(previousPoint) : -1;
  const targetIndex =
    previousIndex === -1
      ? (direction === 1 ? 0 : candidates.length - 1)
      : (previousIndex + direction + candidates.length) % candidates.length;
  const target = candidates[targetIndex];

  const hadWindow = state.selectionStartSeconds !== null && state.selectionEndSeconds !== null;
  const anchor = state.confirmedPointSeconds;

  setBeatMatcherCurrentPoint(featureEntityId, target, false);
  focusBeatMatcherSelection(featureEntityId, 'point');

  if (hadWindow && anchor !== null) {
    if (state.selectionMarginBeforeSeconds === null || state.selectionMarginAfterSeconds === null) {
      captureBeatMatcherSelectionMargins(featureEntityId);
    }
    const marginBefore = state.selectionMarginBeforeSeconds ?? 0;
    const marginAfter = state.selectionMarginAfterSeconds ?? 0;
    setBeatMatcherSelectionRange(
      featureEntityId,
      Math.min(anchor, target) - marginBefore,
      Math.max(anchor, target) + marginAfter
    );
  }

  // Both points need to stay visible while they're both "in play" (see
  // ensureBeatMatcherPointsVisible's own comment) — independent of the
  // selection-window logic above, since the two points are worth keeping in
  // frame even when there's no selection region active at all.
  if (anchor !== null) {
    ensureBeatMatcherPointsVisible(state, anchor, target);
  }
}

// Moves just the start caret, clamped so it can never cross the end (and
// never below 0) — dragging the caret directly, or the keyboard nudge when
// that's what's focused (see nudgeBeatMatcherSelection).
export function setBeatMatcherSelectionStart(featureEntityId: string, seconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.selectionEndSeconds === null) return;
  state.selectionStartSeconds = Math.max(0, Math.min(state.selectionEndSeconds, seconds));
}

// Moves just the end caret, clamped so it can never cross the start (and
// never past the clip's own duration) — same shape as
// setBeatMatcherSelectionStart above.
export function setBeatMatcherSelectionEnd(featureEntityId: string, seconds: number): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.selectionStartSeconds === null || !state.capturedBuffer) return;
  state.selectionEndSeconds = Math.max(state.selectionStartSeconds, Math.min(state.capturedBuffer.duration, seconds));
}

// Cancels the selection region (the "x" button just past the end caret —
// see selectionClearButtonPosition/drawSelectionClearButton) — leaves the
// current point untouched, since that's a separate marker with its own
// independent lifetime.
export function clearBeatMatcherSelection(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  state.selectionStartSeconds = null;
  state.selectionEndSeconds = null;
  state.selectionMarginBeforeSeconds = null;
  state.selectionMarginAfterSeconds = null;
}

// The loop control to the left of the selection region (see
// selectionLoopTogglePosition/drawSelectionLoopToggle) — same "loop vs.
// stop at the end" meaning as toggleBeatMatcherLoopAtEnd, just for the
// selection's own bounds instead of the whole clip's.
export function toggleBeatMatcherSelectionLoop(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  state.selectionLoop = !state.selectionLoop;
}

// --- Selection ruler keyboard focus ---------------------------------------
// Which part of the ruler Left/Right's keyboard nudge acts on: one edge, the
// whole region (null), or the current point — set by whichever
// selection-ruler interaction happened most recently (see
// ui/interaction.ts's own pointerdown/pointermove/endPress): dragging a
// caret directly focuses that one edge, a drag that defines a brand-new
// region focuses the whole thing, and moving the current point (by click or
// by dragging its own marker) focuses that. Self-heals (see
// resolvedSelectionFocus below) once whatever it pointed at is gone, rather
// than needing every unrelated action elsewhere to explicitly clear it.
type SelectionFocusTarget = 'start' | 'end' | 'point' | null; // null = whole region
let selectionFocus: { entityId: string; target: SelectionFocusTarget } | null = null;

export function focusBeatMatcherSelection(entityId: string, target: SelectionFocusTarget): void {
  selectionFocus = { entityId, target };
}

// Self-heals a stale focus (whatever it pointed at has since been cleared)
// the same way this file's own selectedBeatMatcherNoteFor does for note
// selection.
function resolvedSelectionFocus(): { entityId: string; target: SelectionFocusTarget } | null {
  if (!selectionFocus) return null;
  const state = beatMatcherStateFor(selectionFocus.entityId);
  const stale =
    selectionFocus.target === 'point' ? state.currentPointSeconds === null : state.selectionStartSeconds === null;
  if (stale) {
    selectionFocus = null;
    return null;
  }
  return selectionFocus;
}

export function hasBeatMatcherSelectionFocus(): boolean {
  return resolvedSelectionFocus() !== null;
}

// For drawSelectionRulerMarkers below — which caret (if any) to highlight
// as the current keyboard-nudge target, so "special keyboard focus" isn't
// invisible state. 'whole' means both carets move together (target === null).
export function beatMatcherSelectionFocusFor(entityId: string): 'start' | 'end' | 'whole' | 'point' | null {
  const focus = resolvedSelectionFocus();
  if (!focus || focus.entityId !== entityId) return null;
  return focus.target ?? 'whole';
}

const SELECTION_NUDGE_PX = 2; // arrow-key time nudge, converted through the current zoom — half the note track's own NOTE_NUDGE_PX, for finer adjustment

// Left/Right keyboard shortcut: nudges whichever part of the ruler was last
// touched — one edge, the current point, or (no specific edge focused —
// including right after a full drag that defined the region) the whole
// selection, preserving its width.
export function nudgeBeatMatcherSelection(graph: EntityGraph, direction: -1 | 1): void {
  const focus = resolvedSelectionFocus();
  if (!focus) return;
  const { entityId, target } = focus;
  const state = beatMatcherStateFor(entityId);
  if (!state.capturedBuffer) return;
  const grid = resolveBeatMatcherGrid(graph, entityId);
  if (!grid) return;
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  if (pxPerSec <= 0) return;
  const step = direction * (SELECTION_NUDGE_PX / pxPerSec);

  if (target === 'point') {
    if (state.currentPointSeconds === null) return;
    setBeatMatcherCurrentPoint(entityId, state.currentPointSeconds + step);
    return;
  }

  if (state.selectionStartSeconds === null || state.selectionEndSeconds === null) return;
  if (target === 'start') {
    setBeatMatcherSelectionStart(entityId, state.selectionStartSeconds + step);
  } else if (target === 'end') {
    setBeatMatcherSelectionEnd(entityId, state.selectionEndSeconds + step);
  } else {
    const width = state.selectionEndSeconds - state.selectionStartSeconds;
    const duration = state.capturedBuffer.duration;
    const newStart = clamp(state.selectionStartSeconds + step, 0, duration - width);
    state.selectionStartSeconds = newStart;
    state.selectionEndSeconds = newStart + width;
  }
  captureBeatMatcherSelectionMargins(entityId); // a manual edit — see that function's own comment
}

const CURRENT_POINT_MARKER_HIT_RADIUS = 7;
const SELECTION_CARET_HIT_RADIUS = 7; // matches CURRENT_POINT_MARKER_HIT_RADIUS

function hitTestSelectionStartCaret(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  if (state.selectionStartSeconds === null) return false;
  const x = secondsToX(grid, pxPerSec, state.scrollSeconds, state.selectionStartSeconds);
  const y = (grid.selectionRulerTop + grid.selectionRulerBottom) / 2;
  return dist(point, { x, y }) <= SELECTION_CARET_HIT_RADIUS;
}

function hitTestSelectionEndCaret(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  if (state.selectionEndSeconds === null) return false;
  const x = secondsToX(grid, pxPerSec, state.scrollSeconds, state.selectionEndSeconds);
  const y = (grid.selectionRulerTop + grid.selectionRulerBottom) / 2;
  return dist(point, { x, y }) <= SELECTION_CARET_HIT_RADIUS;
}

function currentPointMarkerPosition(grid: Grid, pxPerSec: number, state: BeatMatcherState): Point | null {
  if (state.currentPointSeconds === null) return null;
  const x = secondsToX(grid, pxPerSec, state.scrollSeconds, state.currentPointSeconds);
  return { x, y: (grid.selectionRulerTop + grid.selectionRulerBottom) / 2 };
}

function hitTestCurrentPointMarker(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  const center = currentPointMarkerPosition(grid, pxPerSec, state);
  return !!center && dist(point, center) <= CURRENT_POINT_MARKER_HIT_RADIUS;
}

// Only meaningful while it differs from the current point — i.e. mid Tab/
// Shift-Tab walk (stepBeatMatcherCandidate leaves confirmedPointSeconds
// alone while moving currentPointSeconds around). Null the rest of the
// time so drawConfirmedPointLine has nothing extra to draw over the single
// current-point marker.
function confirmedPointMarkerPosition(grid: Grid, pxPerSec: number, state: BeatMatcherState): Point | null {
  if (state.confirmedPointSeconds === null || state.confirmedPointSeconds === state.currentPointSeconds) return null;
  const x = secondsToX(grid, pxPerSec, state.scrollSeconds, state.confirmedPointSeconds);
  return { x, y: (grid.selectionRulerTop + grid.selectionRulerBottom) / 2 };
}

const SELECTION_CLEAR_BUTTON_RADIUS = 5;
const SELECTION_CLEAR_BUTTON_GAP = 10; // from the end caret's own x to the button's center

// Null (nothing to clear, or no room to draw it before the plot's own right
// edge — the margin past that belongs to the zoom handle/scrollbar) unless
// a selection region actually exists.
function selectionClearButtonPosition(grid: Grid, pxPerSec: number, state: BeatMatcherState): Point | null {
  if (state.selectionStartSeconds === null || state.selectionEndSeconds === null) return null;
  const endX = secondsToX(grid, pxPerSec, state.scrollSeconds, state.selectionEndSeconds);
  const x = endX + SELECTION_CLEAR_BUTTON_GAP;
  if (x + SELECTION_CLEAR_BUTTON_RADIUS > grid.right) return null;
  return { x, y: (grid.selectionRulerTop + grid.selectionRulerBottom) / 2 };
}

function hitTestSelectionClearButton(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  const center = selectionClearButtonPosition(grid, pxPerSec, state);
  return !!center && dist(point, center) <= SELECTION_CLEAR_BUTTON_RADIUS + 3;
}

const SELECTION_LOOP_TOGGLE_GAP = 10; // from the start caret's own x to the toggle's own center, mirroring SELECTION_CLEAR_BUTTON_GAP on the other side

// Null (no selection, or no room to draw it past the plot's own left edge)
// unless a selection region actually exists — same shape as
// selectionClearButtonPosition, just anchored off the start caret instead
// of the end one, and on the opposite side.
function selectionLoopTogglePosition(grid: Grid, pxPerSec: number, state: BeatMatcherState): Point | null {
  if (state.selectionStartSeconds === null || state.selectionEndSeconds === null) return null;
  const startX = secondsToX(grid, pxPerSec, state.scrollSeconds, state.selectionStartSeconds);
  const x = startX - SELECTION_LOOP_TOGGLE_GAP;
  if (x - TRANSPORT_BUTTON_RADIUS < grid.left) return null;
  return { x, y: (grid.selectionRulerTop + grid.selectionRulerBottom) / 2 };
}

function hitTestSelectionLoopToggle(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): boolean {
  const center = selectionLoopTogglePosition(grid, pxPerSec, state);
  return !!center && dist(point, center) <= TRANSPORT_BUTTON_RADIUS + 4;
}

function hitTestSelectionRulerBand(grid: Grid, point: Point): boolean {
  return point.x >= grid.left && point.x <= grid.right && point.y >= grid.selectionRulerTop && point.y <= grid.selectionRulerBottom;
}

// A plain press anywhere in the spectrogram image itself (not just the
// selection ruler strip above it) moves the current point there too — the
// spectrogram is where the sound you're actually looking at lives, so
// picking a reference for onset suggestions (suggestedBeatMatcherOnsets)
// directly off it, rather than only via the thin ruler strip, is the more
// natural gesture. Checked well after hitTestSuggestionLine (a suggestion
// line drawn right on top of the spectrogram takes priority over starting a
// new reference point there) and after the playback-line grab, but ahead of
// nothing else — this is the last, catch-all claim on the band's own pixels.
function hitTestSpectrogramBand(grid: Grid, point: Point): boolean {
  return point.x >= grid.left && point.x <= grid.right && point.y >= grid.selectionRulerBottom && point.y <= grid.spectrogramBottom;
}

// Suggestion lines span the same trackTop..spectrogramBottom range they're
// drawn in (drawBeatMatcherSuggestions) — checked with the same pixel
// tolerance as grabbing the playback line (LINE_GRAB_TOLERANCE, declared
// further down this file but a plain top-level const, so referencing it
// here ahead of its own declaration is fine — this function only ever runs
// after the whole module has loaded). Returns the matched candidate's own
// seconds (not just a boolean) so the click can snap exactly to it.
function hitTestSuggestionLine(grid: Grid, pxPerSec: number, state: BeatMatcherState, point: Point): number | null {
  if (point.y < grid.trackTop || point.y > grid.spectrogramBottom) return null;
  for (const seconds of suggestedBeatMatcherOnsets(state)) {
    const x = secondsToX(grid, pxPerSec, state.scrollSeconds, seconds);
    if (Math.abs(point.x - x) <= LINE_GRAB_TOLERANCE) return seconds;
  }
  return null;
}

// --- Note-drag snap --------------------------------------------------------
// Speed-gated hold-to-snap: a dragged note edge/position only locks onto
// another note's boundary (or the selection ruler's own current point)
// after the cursor has been both close to that candidate AND moving slowly
// for SNAP_HOLD_MS continuously — a fast drag glides straight past nearby
// candidates with no snap at all. Same algorithm as ui/sequencer.ts's own
// note-edge snap, duplicated per this file's own header on staying
// independent of ui/sequencer.ts — the candidate set is what differs: a
// single track has no "other channels" to align across the way the
// sequencer's own snap does, so this track's own other notes plus the
// selection ruler's current point stand in for that.
const SNAP_PROXIMITY_PX = 8; // must be this close on screen to be an eligible candidate
const SNAP_RELEASE_PROXIMITY_PX = 16; // hysteresis: once snapped, must move this far to release
const SNAP_SPEED_THRESHOLD_PX_PER_MS = 0.3; // "slow enough" for the hold to count at all
const SNAP_HOLD_MS = 350; // how long "slow and near" has to hold before it locks

export interface BeatMatcherNoteSnapState {
  lastPointer: Point;
  lastMoveAt: number; // performance.now()
  snapCandidateSeconds: number | null; // shown as a guide line whenever set, whether or not the hold has completed
  snapHoldStartAt: number | null; // null unless actively counting down toward a lock
  snapped: boolean;
}

export function initialBeatMatcherNoteSnapState(pointer: Point, now: number): BeatMatcherNoteSnapState {
  return { lastPointer: pointer, lastMoveAt: now, snapCandidateSeconds: null, snapHoldStartAt: null, snapped: false };
}

// null once snapped (nothing left to count down) or not currently holding —
// exported so ui/render.ts can turn this into the countdown dial's fill
// fraction, same as ui/sequencer.ts's own noteSnapHoldFraction.
export function beatMatcherNoteSnapHoldFraction(snap: BeatMatcherNoteSnapState, now: number): number | null {
  if (snap.snapped || snap.snapHoldStartAt === null) return null;
  return Math.min(1, (now - snap.snapHoldStartAt) / SNAP_HOLD_MS);
}

// Every note boundary (onset and offset) in the track except the note
// currently being dragged, plus the selection ruler's own current point and
// confirmed point (if set) — see this section's own header. The two points
// coincide outside a Tab/Shift-Tab walk (setBeatMatcherCurrentPoint keeps
// them in sync by default), but diverge during one — the manual selection
// (confirmedPointSeconds) is still a meaningful place to snap a note to
// even while the current point is off auditioning a candidate elsewhere.
function snapCandidatesFor(state: BeatMatcherState, excludeNoteId: string | null): number[] {
  const candidates: number[] = [];
  for (const note of state.notes) {
    if (note.id === excludeNoteId) continue;
    candidates.push(note.onsetSeconds, note.onsetSeconds + note.durationSeconds);
  }
  if (state.currentPointSeconds !== null) candidates.push(state.currentPointSeconds);
  if (state.confirmedPointSeconds !== null && state.confirmedPointSeconds !== state.currentPointSeconds) {
    candidates.push(state.confirmedPointSeconds);
  }
  return candidates;
}

function applyNoteSnap(
  snap: BeatMatcherNoteSnapState,
  candidates: number[],
  rawSeconds: number,
  pointer: Point,
  now: number,
  pxPerSec: number
): number {
  const dtMs = Math.max(1, now - snap.lastMoveAt); // avoid div-by-zero on a same-tick call
  const speedPxPerMs = dist(pointer, snap.lastPointer) / dtMs;
  snap.lastPointer = pointer;
  snap.lastMoveAt = now;

  // Stay snapped as long as we're within the (larger) release tolerance of
  // whatever we snapped to, regardless of speed — deliberate hysteresis so
  // a snapped edge doesn't immediately chatter loose from a tiny jitter.
  if (snap.snapped && snap.snapCandidateSeconds !== null) {
    const releaseSeconds = SNAP_RELEASE_PROXIMITY_PX / pxPerSec;
    if (Math.abs(rawSeconds - snap.snapCandidateSeconds) <= releaseSeconds) {
      return snap.snapCandidateSeconds;
    }
    snap.snapped = false;
    snap.snapCandidateSeconds = null;
    snap.snapHoldStartAt = null;
  }

  const proximitySeconds = SNAP_PROXIMITY_PX / pxPerSec;
  let nearest: number | null = null;
  let nearestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(rawSeconds - c);
    if (d <= proximitySeconds && d < nearestDist) {
      nearest = c;
      nearestDist = d;
    }
  }

  if (nearest === null) {
    snap.snapCandidateSeconds = null;
    snap.snapHoldStartAt = null;
    return rawSeconds;
  }

  // In range — always shown as a guide line (snapCandidateSeconds set), but
  // the hold-timeout countdown only actually runs while the cursor stays
  // slow at THIS candidate; picking up speed, or drifting to a different
  // one, restarts it from zero rather than carrying over partial progress.
  const candidateChanged = snap.snapCandidateSeconds !== nearest;
  const tooFast = speedPxPerMs >= SNAP_SPEED_THRESHOLD_PX_PER_MS;
  snap.snapCandidateSeconds = nearest;

  if (tooFast || candidateChanged) {
    snap.snapHoldStartAt = tooFast ? null : now;
    return rawSeconds;
  }
  if (snap.snapHoldStartAt === null) {
    snap.snapHoldStartAt = now;
  } else if (now - snap.snapHoldStartAt >= SNAP_HOLD_MS) {
    snap.snapped = true;
    return nearest;
  }
  return rawSeconds;
}

// Resolves grid/state/candidates from just (graph, entityId), same shape as
// ui/sequencer.ts's own applySequencerNoteSnap — `snap` is mutated in place,
// and the seconds value to actually apply is returned.
export function applyBeatMatcherNoteSnap(
  graph: EntityGraph,
  entityId: string,
  snap: BeatMatcherNoteSnapState,
  excludeNoteId: string | null,
  rawSeconds: number,
  pointer: Point,
  now: number,
  drag?: DragContext
): number {
  const grid = resolveBeatMatcherGrid(graph, entityId, drag);
  if (!grid) return rawSeconds;
  const state = beatMatcherStateFor(entityId);
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const candidates = snapCandidatesFor(state, excludeNoteId);
  return applyNoteSnap(snap, candidates, rawSeconds, pointer, now, pxPerSec);
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

// Keeps a small gap from the view's own left/right edges so a point marker
// never draws flush against the popup border — same idea as
// AUTO_SCROLL_LOOKAHEAD_FRACTION's margin during playback, just symmetric
// instead of a single lookahead direction.
const POINT_VISIBILITY_MARGIN_FRACTION = 0.05;

// Scrolls (never rezooms) so both aSeconds and bSeconds are visible at
// once — stepBeatMatcherCandidate's own fix for the manual selection
// (confirmedPointSeconds) going off-screen and effectively disappearing
// once a Tab walk lands on a candidate far enough away: nothing previously
// adjusted scrollSeconds to follow the walk at all, so the confirmed
// point's line (drawConfirmedPointLine) would silently scroll out of the
// clipped [grid.left, grid.right] range it's drawn against. If the two
// points are farther apart than the current zoom can show at once, the
// live point (b — whichever one was just tabbed to) wins and the view
// centers on it instead, same as if there were no anchor to keep in frame;
// never widens zoomSeconds to force a fit, since that would resize the
// user's own view as a surprising side effect of pressing Tab.
function ensureBeatMatcherPointsVisible(state: BeatMatcherState, aSeconds: number, bSeconds: number): void {
  const lo = Math.min(aSeconds, bSeconds);
  const hi = Math.max(aSeconds, bSeconds);
  const margin = state.zoomSeconds * POINT_VISIBILITY_MARGIN_FRACTION;
  if (hi - lo + margin * 2 <= state.zoomSeconds) {
    if (lo - margin < state.scrollSeconds) {
      state.scrollSeconds = lo - margin;
    } else if (hi + margin > state.scrollSeconds + state.zoomSeconds) {
      state.scrollSeconds = hi + margin - state.zoomSeconds;
    }
  } else {
    state.scrollSeconds = bSeconds - state.zoomSeconds / 2;
  }
  clampBeatMatcherScroll(state);
}

interface Grid {
  left: number;
  right: number; // popup's own right edge minus RIGHT_MARGIN — where the axis handle/zoom icons live
  trackTop: number;
  trackBottom: number;
  selectionRulerTop: number;
  selectionRulerBottom: number;
  spectrogramBottom: number;
  rulerTop: number;
  rulerBottom: number;
}

function gridFor(popup: Rect): Grid {
  const b = popupBounds(popup);
  const trackTop = b.top + TITLE_HEIGHT;
  const trackBottom = trackTop + TRACK_ROW_HEIGHT;
  const selectionRulerTop = trackBottom;
  const selectionRulerBottom = selectionRulerTop + SELECTION_RULER_HEIGHT;
  const spectrogramBottom = selectionRulerBottom + SPECTROGRAM_HEIGHT;
  const rulerTop = spectrogramBottom;
  return {
    left: b.left,
    right: b.right - RIGHT_MARGIN,
    trackTop,
    trackBottom,
    selectionRulerTop,
    selectionRulerBottom,
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

// Which expanded beat-matcher popup (if any) the point falls within the
// note track, selection ruler, or spectrogram of — i.e. everywhere
// stepBeatMatcherCandidate's Tab/Shift-Tab gesture should be captured
// (matching this feature's own "anywhere in the spectrogram, ruler or
// sequencer track" spec), but NOT the title bar's buttons, the axis handle/
// zoom icons, or the h-scrollbar. ui/interaction.ts tracks this continuously
// on pure hover (no drag/press in progress) and attachKeyboard reads it.
export function beatMatcherTimelineIdAt(graph: EntityGraph, point: Point, drag?: DragContext): string | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'beatMatcher' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const state = beatMatcherStateFor(entity.id);
    if (!state.capturedBuffer) continue;
    const grid = gridFor(beatMatcherPopupRect(graph, owner, drag));
    if (point.x >= grid.left && point.x <= grid.right && point.y >= grid.trackTop && point.y <= grid.spectrogramBottom) {
      return entity.id;
    }
  }
  return null;
}

// --- Onset-similarity suggestions ---------------------------------------
// See ui/beatMatcherSuggestions.ts's own header for the approach (nearest-
// centroid similarity, not a trained classifier). This is the one place
// that combines its pure feature/candidate/ranking functions with the
// beat-matcher's own live state (which onsets exist, or the current point
// before any do) — called fresh from both drawing
// (drawBeatMatcherSuggestions) and hit-testing (hitTestSuggestionLine)
// rather than cached, since the actual search (a distance scan over a few
// dozen candidates) is cheap; only the per-frame features/candidates
// themselves (onsetFeatures/onsetCandidateSeconds) are worth precomputing
// once, at capture time.
export function suggestedBeatMatcherOnsets(state: BeatMatcherState): number[] {
  if (!state.onsetFeatures || !state.onsetCandidateSeconds || state.onsetCandidateSeconds.length === 0) return [];
  // Before any notes exist, the reference is confirmedPointSeconds (not
  // currentPointSeconds) — see that field's own comment on BeatMatcherState:
  // a point merely landed on mid-Tab-walk hasn't been confirmed by the user
  // as a good match yet, so it must not be trained on.
  const referenceSeconds =
    state.notes.length > 0
      ? state.notes.map((n) => n.onsetSeconds)
      : state.confirmedPointSeconds !== null
        ? [state.confirmedPointSeconds]
        : [];
  if (referenceSeconds.length === 0) return [];
  const existingOnsets = state.notes.map((n) => n.onsetSeconds);
  return rankSuggestedOnsets(state.onsetFeatures, state.onsetCandidateSeconds, referenceSeconds, existingOnsets);
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

// A brief flash on the playback cursor each time playback crosses a note's
// own onset — audio/beatMatcherPlayer.ts's tick dispatch calls this at the
// exact ctx-time the tick itself sounds (deferred to match, since ticks are
// actually scheduled a little ahead of when they're heard), so the flash
// and the tick land together. Same "external map of last-fired timestamps,
// faded by elapsed time" idiom as ui/sequencer.ts's own
// flashChannelConnector/connectorGlow — kept outside BeatMatcherState since
// it's pure animation state, not anything worth persisting or reasoning
// about alongside the transport.
const CURSOR_FLASH_DURATION_MS = 150;
const lastCursorFlashAt = new Map<string, number>();

export function flashBeatMatcherCursor(featureEntityId: string): void {
  lastCursorFlashAt.set(featureEntityId, performance.now());
}

function beatMatcherCursorFlashGlow(featureEntityId: string, now: number): number {
  const at = lastCursorFlashAt.get(featureEntityId);
  if (at === undefined) return 0;
  const elapsed = now - at;
  if (elapsed < 0 || elapsed > CURSOR_FLASH_DURATION_MS) return 0;
  return 1 - elapsed / CURSOR_FLASH_DURATION_MS;
}

export function startBeatMatcherPlayback(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  if (state.playing || !state.capturedBuffer) return;
  if (state.selectionStartSeconds !== null) {
    // Auditioning a specific point (this feature's own spec): while a
    // selection region exists, playback always starts at its own start,
    // not wherever the playhead happened to be parked.
    state.pausedAtSeconds = state.selectionStartSeconds;
  } else if (state.pausedAtSeconds >= state.endSeconds) {
    // Restart from the top if it's already run off the end (or sitting
    // exactly at the end marker, having just stopped there) — pressing play
    // again should replay from 0, not immediately re-trigger
    // advanceBeatMatcherPastEnd on the very next frame and stop again.
    state.pausedAtSeconds = 0;
  }
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
// to the start along with the playhead. While a selection region exists,
// "the start" means the selection's own start instead of absolute zero —
// same reasoning as startBeatMatcherPlayback.
export function rewindBeatMatcherPlayback(featureEntityId: string): void {
  const state = beatMatcherStateFor(featureEntityId);
  state.pausedAtSeconds = state.selectionStartSeconds ?? 0;
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

  // Auditioning a specific point (this feature's own spec): while a
  // selection region exists, it bounds playback instead of the whole
  // clip's own endSeconds/loopAtEnd — same loop-or-stop shape as the plain
  // case below, just against the selection's own start/end/selectionLoop.
  if (state.selectionStartSeconds !== null && state.selectionEndSeconds !== null) {
    const start = state.selectionStartSeconds;
    const end = state.selectionEndSeconds;
    if (playhead < end) return;
    if (state.selectionLoop) {
      // Same "shift the ctx-time anchor back by exactly one loop length"
      // technique as the plain case below, just a (end - start)-long loop
      // instead of one starting at 0.
      state.playStartCtxTime = (state.playStartCtxTime ?? getAudioContext().currentTime) + (end - start) / state.playbackSpeed;
    } else {
      state.pausedAtSeconds = end;
      state.playing = false;
      state.playStartCtxTime = null;
    }
    return;
  }

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

const NOTE_LABEL_HALF_GAP = 3; // px from the note's own horizontal center to where the pitch/velocity text starts, on either side of the colon

// Shared by hitTestVelocityText below: the note's own visible left/right/
// center-y, or null if it's not currently on screen or too narrow for the
// "pitch:velocity" label to be drawn at all (matching drawBeatMatcherNote's
// own >= 14px cutoff) — same as ui/sequencer.ts's own noteLabelGeometry.
function noteLabelGeometry(grid: Grid, pxPerSec: number, state: BeatMatcherState, noteId: string): { cx: number; cy: number } | null {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return null;
  const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  if (right < grid.left || left > grid.right || right - left < 14) return null;
  return { cx: (left + right) / 2, cy: (grid.trackTop + grid.trackBottom) / 2 };
}

// The percentage half of the centered label, just right of the colon — same
// as ui/sequencer.ts's own hitTestVelocityText.
function hitTestVelocityText(grid: Grid, pxPerSec: number, state: BeatMatcherState, selected: { noteId: string } | null, point: Point): boolean {
  if (!selected) return false;
  const geometry = noteLabelGeometry(grid, pxPerSec, state, selected.noteId);
  if (!geometry) return false;
  return (
    point.x >= geometry.cx + NOTE_LABEL_HALF_GAP &&
    point.x <= geometry.cx + NOTE_LABEL_HALF_GAP + 20 &&
    Math.abs(point.y - geometry.cy) <= 7
  );
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
  | { entityId: string; kind: 'noteDuplicateButton'; noteId: string }
  | { entityId: string; kind: 'noteVelocityTextClick'; noteId: string }
  | { entityId: string; kind: 'noteVelocitySliderDrag'; noteId: string }
  | { entityId: string; kind: 'noteEnvelopeHandle'; noteId: string; handle: HandleKind }
  | { entityId: string; kind: 'currentPointMarkerDrag' }
  | { entityId: string; kind: 'selectionStartCaretDrag' }
  | { entityId: string; kind: 'selectionEndCaretDrag' }
  | { entityId: string; kind: 'selectionClearButton' }
  | { entityId: string; kind: 'selectionLoopToggle' }
  | { entityId: string; kind: 'selectionRulerPress'; seconds: number }
  | { entityId: string; kind: 'suggestionAccept'; seconds: number }
  | { entityId: string; kind: 'spectrogramPress'; seconds: number }
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

      // Every check below is only ever reachable for the CURRENT selection
      // (nothing of this shape is drawn for any other note) — same priority
      // order as ui/sequencer.ts's own hitTestSequencerPopup: duplicate
      // button, then envelope handles, then the velocity slider (if open),
      // then the velocity-text click, all ahead of a plain note grab.
      const currentSelection = selectedBeatMatcherNoteFor(entity.id);

      if (hitTestDuplicateButton(grid, pxPerSec, state, currentSelection, point)) {
        return { entityId: entity.id, kind: 'noteDuplicateButton', noteId: currentSelection!.noteId };
      }

      const envelopeHandle = hitTestNoteEnvelopeHandle(grid, pxPerSec, state, currentSelection, point);
      if (envelopeHandle && currentSelection) {
        return { entityId: entity.id, kind: 'noteEnvelopeHandle', noteId: currentSelection.noteId, handle: envelopeHandle };
      }

      if (currentSelection) {
        const openTrack = beatMatcherVelocitySliderOpenFor(currentSelection.noteId);
        if (openTrack && hitTestBeatMatcherVelocitySlider(openTrack, point)) {
          return { entityId: entity.id, kind: 'noteVelocitySliderDrag', noteId: currentSelection.noteId };
        }
      }

      if (hitTestVelocityText(grid, pxPerSec, state, currentSelection, point)) {
        return { entityId: entity.id, kind: 'noteVelocityTextClick', noteId: currentSelection!.noteId };
      }

      const noteHit = hitTestNoteTrack(grid, pxPerSec, state, point);
      if (noteHit) return { entityId: entity.id, ...noteHit };

      // The selection ruler's own current-point marker takes priority over
      // a plain press elsewhere on the ruler, which instead starts a
      // start/end selection drag (or, without crossing the drag threshold,
      // just moves the current point — see ui/interaction.ts's own
      // pointerdown/pointermove handling for the click-vs-drag split).
      if (hitTestCurrentPointMarker(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'currentPointMarkerDrag' };
      }
      // A press directly on the start/end caret drags just that edge,
      // rather than starting a new selection drag — checked ahead of the
      // clear button/loop toggle/plain ruler press below.
      if (hitTestSelectionStartCaret(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'selectionStartCaretDrag' };
      }
      if (hitTestSelectionEndCaret(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'selectionEndCaretDrag' };
      }
      // The clear ("x") button sits just past the end caret, and the loop
      // toggle just before the start caret, both inside the ruler's own
      // bounds — checked ahead of a plain ruler press so neither gets
      // swallowed by the "start a new selection drag" case.
      if (hitTestSelectionClearButton(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'selectionClearButton' };
      }
      if (hitTestSelectionLoopToggle(grid, pxPerSec, state, point)) {
        return { entityId: entity.id, kind: 'selectionLoopToggle' };
      }
      // Checked ahead of the ruler-band/scrub/noteCreate catch-alls below
      // (which would otherwise swallow the click first) but after every
      // precise control above — a suggestion line is a thin target, but
      // still lower priority than an actual note/marker/button.
      const suggestionSeconds = hitTestSuggestionLine(grid, pxPerSec, state, point);
      if (suggestionSeconds !== null) {
        return { entityId: entity.id, kind: 'suggestionAccept', seconds: suggestionSeconds };
      }
      if (hitTestSelectionRulerBand(grid, point)) {
        return { entityId: entity.id, kind: 'selectionRulerPress', seconds: xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x) };
      }

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

      // A plain press anywhere else in the spectrogram picks that point as
      // the current point (see hitTestSpectrogramBand's own comment) —
      // checked after the playback-line grab above (which also crosses the
      // spectrogram) so grabbing the cursor still wins where the two overlap.
      if (hitTestSpectrogramBand(grid, point)) {
        return { entityId: entity.id, kind: 'spectrogramPress', seconds: xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x) };
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

const PLAY_BUTTON_RING = 'rgba(255, 255, 255, 0.3)'; // matches ui/render.ts's drawPad ring

// The collapsed body's own center play/pause button — a small inset pad,
// same geometry/behavior as ui/sequencer.ts's own drawSequencerPlayButton:
// a ring (highlighted while a dragged event wire is hovering it as a valid
// drop target), the same play/pause glyph the title-bar transport button
// uses, and the shared trigger-flash ring for a wired activation (a direct
// click doesn't flash this one, matching the sequencer's own — the icon
// swap already shows the state change).
function drawBeatMatcherPlayButton(
  ctx: CanvasRenderingContext2D,
  bounds: Rect,
  playing: boolean,
  interaction: InteractionState,
  entityId: string,
  now: number
): void {
  const radius = padRadius(bounds);
  ctx.save();
  ctx.beginPath();
  ctx.arc(bounds.x, bounds.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = PLAY_BUTTON_RING;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (interaction.eventWireHoverTarget === entityId) {
    ctx.beginPath();
    ctx.arc(bounds.x, bounds.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fill();
  }
  ctx.restore();

  drawTransportPlayIcon(ctx, { x: bounds.x, y: bounds.y }, playing);

  const flashStart = interaction.triggerFlashes.get(entityId);
  if (flashStart !== undefined) {
    const elapsed = now - flashStart;
    if (elapsed < PAD_FLASH_DURATION) {
      const t = elapsed / PAD_FLASH_DURATION;
      ctx.save();
      ctx.beginPath();
      ctx.arc(bounds.x, bounds.y, radius + t * radius * 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 210, 150, ${1 - t})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    } else {
      interaction.triggerFlashes.delete(entityId);
    }
  }
}

// Collapsed on-canvas presence — same small circular body every other
// control kind uses (ui/render.ts's drawControlBody). Its right-edge bulge
// (drawBodyBulge, the same spot knob/clock/tap protrude their own wire jack
// from) instead frames its organelle porthole, drawn separately and
// generically by ui/organelle.ts's own drawPorthole once portholePosition's
// control-type-owner case points it here — same treatment as the
// sequencer's own drawSequencerBody (ui/sequencer.ts), just independent
// code. The center is a play/pause trigger button, also matching the
// sequencer's own.
export function drawBeatMatcherBody(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  bounds: Rect,
  selected: boolean,
  interaction: InteractionState,
  now: number
): void {
  const radius = drawControlBody(ctx, bounds, selected, entity.kind);
  drawBodyBulge(ctx, bounds);
  const feature = graph.featuresOf(entity.id).find((f) => f.kind === 'beatMatcher');
  drawBeatMatcherPlayButton(ctx, bounds, feature ? beatMatcherStateFor(feature.id).playing : false, interaction, entity.id, now);
  drawControlLabel(ctx, entity, bounds, radius);
}

const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const DROP_ZONE_BG = 'rgba(255, 255, 255, 0.06)';
const DROP_ZONE_BG_HOVER = 'rgba(255, 255, 255, 0.14)';
const CAPTURE_BUTTON_RADIUS = 9;
const CAPTURE_ARMED_COLOR = '#8a2f2f';
const CAPTURE_ACTIVE_COLOR = '#e04a3c';
const CAPTURE_PAUSED_COLOR = '#5a5a5a'; // grey housing, per the record-dot glyph drawn on top — the usual "record button" look

// Lives right in the title bar, to the left of the title text — always,
// regardless of status, so it never needs its own dedicated row once a
// capture exists (see beatMatcherPopupHeight/drawBeatMatcherPopup).
function captureButtonPosition(popup: Rect): Point {
  const b = popupBounds(popup);
  return { x: b.left + 15, y: b.top + TITLE_HEIGHT / 2 };
}

// The button's look tracks BeatMatcherStatus directly: dim/inert while
// 'idle' (nothing connected), a hollow ring gently pulsing while 'armed'
// (watching, nothing captured yet), a grey housing with a red record dot
// while 'paused' — the standard "record button" convention — and a bright,
// strongly pulsing red fill with a stop glyph while actually 'capturing'.
// 'paused' deliberately reuses the record-dot glyph rather than a pause icon
// — pressing it re-arms and rescans from the sample
// (pressBeatMatcherRecordButton), which a pause glyph reads as "resume
// playback," not "record again." See this file's own header for what each
// status means and what pressing the button does in it.
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
  } else {
    // Record icon (dot) — bright red against the grey 'paused' housing (the
    // usual "record button" look, and what makes it read as "press to
    // record"), dim red on the hollow 'armed' ring, dim white once 'idle'
    // with nothing connected to capture from.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = status === 'paused' ? CAPTURE_ACTIVE_COLOR : armed ? CAPTURE_ARMED_COLOR : 'rgba(255, 255, 255, 0.3)';
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

const NOTE_FILL = 'rgba(90, 160, 200, 0.55)'; // matches ui/sequencer.ts's own NOTE_FILL — same note-body color regardless of track kind
const NOTE_EDGE_HILITE = 'rgba(200, 230, 245, 0.8)'; // matches ui/sequencer.ts's own NOTE_EDGE_HILITE — the "grab here to resize" edge stripes
const NOTE_DIMMED_ALPHA = 0.25; // how far a non-selected note fades once something else is selected — same as ui/sequencer.ts's own
// Velocity 0 fades a note almost (not quite) out of view; velocity 1 leaves
// it exactly as dimmed/selected would otherwise render it — same as
// ui/sequencer.ts's own MIN_VELOCITY_ALPHA_FACTOR.
const MIN_VELOCITY_ALPHA_FACTOR = 0.4;

// A single note's body — the plain flat fill (or, once selected/shaped, its
// own ADSR shape via drawNoteEnvelopeShape), a "pitch:velocity" readout, the
// selected-note outline (narrowed to just one edge when a keyboard nudge is
// focused there), and a glowing crossing highlight while the playhead is
// actually inside it. Same shape as ui/sequencer.ts's own drawSequencerNote.
function drawBeatMatcherNote(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  top: number,
  bottom: number,
  note: BeatMatcherNote,
  selected: boolean,
  dimmed: boolean,
  activeEnvelopeHandle: HandleKind | null,
  edgeFocus: 'left' | 'right' | null,
  // 0..1 while the playhead is currently somewhere inside this note (null
  // otherwise) — how far across its own [onset, onset+duration] that is.
  playingFraction: number | null
): void {
  const baseAlpha = dimmed ? NOTE_DIMMED_ALPHA : 1;
  const velocityAlpha = MIN_VELOCITY_ALPHA_FACTOR + (1 - MIN_VELOCITY_ALPHA_FACTOR) * note.velocity;

  ctx.save();
  ctx.globalAlpha = baseAlpha * velocityAlpha;
  if (selected || (playingFraction !== null && note.envelope)) {
    drawNoteEnvelopeShape(ctx, left, right, top, bottom, note, activeEnvelopeHandle, selected);
  } else {
    ctx.fillStyle = NOTE_FILL;
    ctx.fillRect(left, top, Math.max(1, right - left), bottom - top);
  }
  // A brighter sliver at each edge hints "grab here to resize" — same as
  // ui/sequencer.ts's own drawSequencerNote (the note's start/end markers).
  ctx.fillStyle = NOTE_EDGE_HILITE;
  ctx.fillRect(left, top, 2, bottom - top);
  ctx.fillRect(right - 2, top, 2, bottom - top);
  ctx.restore();

  // A "pitch:velocity" readout, colon fixed at the note's own horizontal
  // center — same as ui/sequencer.ts's own drawSequencerNote.
  const showPitchText = selected || note.pitch !== null;
  const showVelocityText = selected || note.velocity !== DEFAULT_NOTE_VELOCITY;
  if ((showPitchText || showVelocityText) && right - left >= 14) {
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '7px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(':', cx, cy);
    if (showPitchText) {
      ctx.textAlign = 'right';
      ctx.fillText(note.pitch === null ? 'X' : midiNoteName(note.pitch), cx - NOTE_LABEL_HALF_GAP, cy);
    }
    if (showVelocityText) {
      ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(note.velocity * 100)}%`, cx + NOTE_LABEL_HALF_GAP, cy);
    }
    ctx.restore();
  }

  if (selected) {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    if (edgeFocus === 'left') {
      ctx.beginPath();
      ctx.moveTo(left + 1, top + 1);
      ctx.lineTo(left + 1, bottom - 1);
      ctx.stroke();
    } else if (edgeFocus === 'right') {
      ctx.beginPath();
      ctx.moveTo(right - 1, top + 1);
      ctx.lineTo(right - 1, bottom - 1);
      ctx.stroke();
    } else {
      ctx.strokeRect(left + 1, top + 1, Math.max(1, right - left) - 2, bottom - top - 2);
    }
    ctx.restore();
  }

  if (playingFraction !== null) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(left, top, Math.max(1, right - left), bottom - top);
    ctx.restore();
    if (note.envelope) {
      drawEnvelopeCrossingDot(ctx, left, right, top, bottom, note.envelope, playingFraction);
    }
  }
}

// The track row once there's a capture to author against — paint-a-note
// blocks aligned to the same fit-to-width timeline the spectrogram/ruler
// use, drawn in its own dedicated row (see drawBeatMatcherPopup) rather
// than overlaid on the spectrogram image itself, so notes stay legible
// regardless of what's under them.
function drawBeatMatcherNoteTrack(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  pxPerSec: number,
  state: BeatMatcherState,
  selected: { noteId: string } | null,
  activeEnvelopeHandle: HandleKind | null,
  movingNoteId: string | null
): void {
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

  const noteTop = rowTop + NOTE_VERTICAL_INSET;
  const noteBottom = rowTop + TRACK_ROW_HEIGHT - NOTE_VERTICAL_INSET;
  const playhead = currentBeatMatcherPlaybackSeconds(state);

  for (const note of state.notes) {
    const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
    const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
    if (right < grid.left || left > grid.right) continue;
    const isSelected = note.id === selected?.noteId;
    const dimmed = selected !== null && !isSelected;
    const crossing = state.playing && playhead >= note.onsetSeconds && playhead < note.onsetSeconds + note.durationSeconds;
    const playingFraction = crossing ? (playhead - note.onsetSeconds) / note.durationSeconds : null;
    const extraInset = note.id === movingNoteId ? DRAGGED_NOTE_EXTRA_INSET : 0;
    drawBeatMatcherNote(
      ctx,
      left,
      right,
      noteTop + extraInset,
      noteBottom - extraInset,
      note,
      isSelected,
      dimmed,
      isSelected ? activeEnvelopeHandle : null,
      isSelected ? selectedBeatMatcherNoteEdgeFocus(note.id) : null,
      playingFraction
    );
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(grid.left, rowTop, grid.right - grid.left, TRACK_ROW_HEIGHT);
  ctx.restore();
}

// --- Selection ruler ------------------------------------------------------
// Sits between the note track and the spectrogram, time-aligned with both
// (see BeatMatcherState's own comment on the feature) — carets mark the
// start/end selection region (highlighted between them) and the current
// point. drawSelectionRulerBand draws the row's own background (always,
// even before a capture, so the row doesn't look like a gap in the
// layout); drawSelectionRulerMarkers draws the carets/highlight themselves
// (gated on hasCapture, same as the note track/end marker).

const SELECTION_RULER_BG = 'rgba(0, 0, 0, 0.3)';
const SELECTION_HIGHLIGHT = 'rgba(201, 138, 60, 0.22)'; // translucent ACCENT wash
const CARET_COLOR = 'rgba(255, 255, 255, 0.65)';
const CARET_SIZE = 5;

function drawSelectionRulerBand(ctx: CanvasRenderingContext2D, grid: Grid): void {
  const height = grid.selectionRulerBottom - grid.selectionRulerTop;
  ctx.save();
  ctx.fillStyle = SELECTION_RULER_BG;
  ctx.fillRect(grid.left, grid.selectionRulerTop, grid.right - grid.left, height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(grid.left, grid.selectionRulerTop, grid.right - grid.left, height);
  ctx.restore();
}

// A small downward-pointing triangle sitting on the ruler's own line — same
// "caret" shape a text cursor or a DAW loop-region handle uses.
function drawCaret(ctx: CanvasRenderingContext2D, x: number, grid: Grid, color: string): void {
  const midY = (grid.selectionRulerTop + grid.selectionRulerBottom) / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - CARET_SIZE / 2, grid.selectionRulerTop);
  ctx.lineTo(x + CARET_SIZE / 2, grid.selectionRulerTop);
  ctx.lineTo(x, midY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSelectionRulerMarkers(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  pxPerSec: number,
  state: BeatMatcherState,
  keyboardFocus: 'start' | 'end' | 'whole' | 'point' | null
): void {
  if (state.selectionStartSeconds !== null && state.selectionEndSeconds !== null) {
    const startX = secondsToX(grid, pxPerSec, state.scrollSeconds, state.selectionStartSeconds);
    const endX = secondsToX(grid, pxPerSec, state.scrollSeconds, state.selectionEndSeconds);
    if (endX >= grid.left && startX <= grid.right) {
      const left = Math.max(grid.left, startX);
      const right = Math.min(grid.right, endX);
      ctx.save();
      ctx.fillStyle = SELECTION_HIGHLIGHT;
      ctx.fillRect(left, grid.selectionRulerTop, Math.max(0, right - left), grid.selectionRulerBottom - grid.selectionRulerTop);
      ctx.restore();
    }
    // Whichever edge (or both, for 'whole') is the current keyboard-nudge
    // target reads as ACCENT — same "highlight what arrow keys would move"
    // idea as ui/sequencer.ts's own edgeFocus outline on a selected note.
    const startFocused = keyboardFocus === 'start' || keyboardFocus === 'whole';
    const endFocused = keyboardFocus === 'end' || keyboardFocus === 'whole';
    if (startX >= grid.left && startX <= grid.right) drawCaret(ctx, startX, grid, startFocused ? ACCENT : CARET_COLOR);
    if (endX >= grid.left && endX <= grid.right) drawCaret(ctx, endX, grid, endFocused ? ACCENT : CARET_COLOR);

    const clearButton = selectionClearButtonPosition(grid, pxPerSec, state);
    if (clearButton) drawSelectionClearButton(ctx, clearButton);

    const loopToggle = selectionLoopTogglePosition(grid, pxPerSec, state);
    if (loopToggle) drawSelectionLoopToggle(ctx, loopToggle, state.selectionLoop);
  }

  const point = currentPointMarkerPosition(grid, pxPerSec, state);
  if (point && point.x >= grid.left && point.x <= grid.right) {
    drawCaret(ctx, point.x, grid, ACCENT);
  }
}

// A small "x" just past the selection's own end caret, for
// clearBeatMatcherSelection — same small-circle-with-glyph visual language
// as this file's own drawDuplicateButton.
function drawSelectionClearButton(ctx: CanvasRenderingContext2D, center: Point): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, SELECTION_CLEAR_BUTTON_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill();
  ctx.strokeStyle = CARET_COLOR;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.lineCap = 'round';
  const s = SELECTION_CLEAR_BUTTON_RADIUS * 0.5;
  ctx.beginPath();
  ctx.moveTo(center.x - s, center.y - s);
  ctx.lineTo(center.x + s, center.y + s);
  ctx.moveTo(center.x + s, center.y - s);
  ctx.lineTo(center.x - s, center.y + s);
  ctx.stroke();
  ctx.restore();
}

// The loop control to the left of the selection region — same ring+glyph
// visual language as the whole-clip end marker's own toggle
// (drawTransportButtonRing/drawLoopStopIcon, both defined further down this
// file), reused directly rather than redrawn, since it's the identical
// "loop vs. stop" glyph either way.
function drawSelectionLoopToggle(ctx: CanvasRenderingContext2D, center: Point, looping: boolean): void {
  drawTransportButtonRing(ctx, center);
  drawLoopStopIcon(ctx, center, looping);
}

// The dotted vertical line marking the current point, spanning the note
// track and the spectrogram (per this feature's own spec) — drawn on top of
// both, same "overlay cursor" treatment as drawBeatMatcherPlaybackLine, just
// dashed and in a distinct style so the two are never mistaken for one
// another when both happen to be visible at once.
function drawCurrentPointLine(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  const point = currentPointMarkerPosition(grid, pxPerSec, state);
  if (!point || point.x < grid.left || point.x > grid.right) return;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(point.x, grid.trackTop);
  ctx.lineTo(point.x, grid.spectrogramBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// The manual selection's own line, drawn alongside drawCurrentPointLine's
// during a Tab/Shift-Tab walk (confirmedPointMarkerPosition is null the rest
// of the time, so this is a no-op then) — deliberately the SAME weight/dash
// as drawCurrentPointLine (not a fainter/thinner treatment, which read as
// "the original line disappeared" rather than "there are now two lines" —
// per this feature's own spec, the manually-clicked line is meant to stay
// visibly put while a Tab walk adds a second one next to it, not fade into
// the background). Both remain valid note-drag snap targets
// (snapCandidatesFor) while they're both visible.
function drawConfirmedPointLine(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  const point = confirmedPointMarkerPosition(grid, pxPerSec, state);
  if (!point || point.x < grid.left || point.x > grid.right) return;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(point.x, grid.trackTop);
  ctx.lineTo(point.x, grid.spectrogramBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Shown for a note-edge/move drag while a snap candidate is in range —
// whether or not the hold has completed. Same shape as
// ui/sequencer.ts's own NoteSnapIndicator, independent code.
export interface BeatMatcherNoteSnapIndicator {
  candidateSeconds: number;
  snapped: boolean;
  holdFraction: number | null;
}

const SNAP_DIAL_RADIUS = 5;

function drawBeatMatcherNoteSnapIndicator(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  pxPerSec: number,
  state: BeatMatcherState,
  indicator: BeatMatcherNoteSnapIndicator
): void {
  const x = secondsToX(grid, pxPerSec, state.scrollSeconds, indicator.candidateSeconds);
  if (x < grid.left || x > grid.right) return;

  ctx.save();
  ctx.strokeStyle = indicator.snapped ? ACCENT : 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = indicator.snapped ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(x, grid.trackTop);
  ctx.lineTo(x, grid.spectrogramBottom);
  ctx.stroke();
  ctx.restore();

  if (indicator.holdFraction === null) return;
  const center = { x, y: (grid.trackTop + grid.trackBottom) / 2 };

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(center.x, center.y, SNAP_DIAL_RADIUS, 0, Math.PI * 2);
  ctx.stroke();

  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + indicator.holdFraction * Math.PI * 2;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.arc(center.x, center.y, SNAP_DIAL_RADIUS, startAngle, endAngle);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Faint, dashed vertical lines at each of suggestedBeatMatcherOnsets' own
// candidates — same trackTop..spectrogramBottom span as
// drawBeatMatcherNoteSnapIndicator's own single line, just drawn for a whole
// array of them at once and dashed (rather than that indicator's solid
// line) so the two read as distinct even when both happen to be visible.
// Not brightened on hover — no pointer position is threaded into this draw
// call today (unlike the drag-only indicators, which get their own state
// object each frame), so every suggestion just stays this one faint style
// until it's clicked into an actual note.
const SUGGESTION_LINE_COLOR = 'rgba(255, 255, 255, 0.3)';

function drawBeatMatcherSuggestions(ctx: CanvasRenderingContext2D, grid: Grid, pxPerSec: number, state: BeatMatcherState): void {
  const suggestions = suggestedBeatMatcherOnsets(state);
  if (suggestions.length === 0) return;
  ctx.save();
  ctx.strokeStyle = SUGGESTION_LINE_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  for (const seconds of suggestions) {
    const x = secondsToX(grid, pxPerSec, state.scrollSeconds, seconds);
    if (x < grid.left || x > grid.right) continue;
    ctx.beginPath();
    ctx.moveTo(x, grid.trackTop);
    ctx.lineTo(x, grid.spectrogramBottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function drawSpectrogramBand(ctx: CanvasRenderingContext2D, grid: Grid, state: BeatMatcherState): void {
  const bandTop = grid.selectionRulerBottom;
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
  } else if (state.liveSpectrogram && state.liveSpectrogram.columnCount > 0) {
    // A capture in progress — the clip's own final length isn't known yet,
    // so (unlike the finished-capture case above) this doesn't map through
    // zoomSeconds/scrollSeconds at all: it just stretches everything
    // captured so far across the whole band, growing to fill it as more
    // audio arrives, same visual idea as a live level meter filling up.
    const live = state.liveSpectrogram;
    ctx.drawImage(live.canvas, 0, 0, live.columnCount, live.canvas.height, grid.left, bandTop, width, SPECTROGRAM_HEIGHT);
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
function drawBeatMatcherPlaybackLine(
  ctx: CanvasRenderingContext2D,
  grid: Grid,
  pxPerSec: number,
  state: BeatMatcherState,
  flashGlow: number
): void {
  const playX = secondsToX(grid, pxPerSec, state.scrollSeconds, currentBeatMatcherPlaybackSeconds(state));
  if (playX < grid.left || playX > grid.right) return;

  // A bright, wide halo flashed under the normal line each time playback
  // crosses a note's own onset (audio/beatMatcherPlayer.ts's tick dispatch
  // calls flashBeatMatcherCursor at the exact same ctx-time the tick itself
  // sounds) — drawn first so the crisp accent line on top still reads
  // clearly through it.
  if (flashGlow > 0) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 255, 255, 0.95)';
    ctx.shadowBlur = 24 * flashGlow;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * flashGlow})`;
    ctx.lineWidth = 2 + 7 * flashGlow;
    ctx.beginPath();
    ctx.moveTo(playX, grid.trackTop);
    ctx.lineTo(playX, grid.spectrogramBottom);
    ctx.stroke();
    ctx.restore();
  }

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
  activeEnvelopeHandle: HandleKind | null,
  noteSnap: BeatMatcherNoteSnapIndicator | null,
  movingNoteId: string | null,
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
  const selectedNote = hasCapture ? selectedBeatMatcherNoteFor(entity.id) : null;

  if (hasCapture) {
    drawBeatMatcherNoteTrack(ctx, grid, pxPerSec, state, selectedNote, activeEnvelopeHandle, movingNoteId);
  } else {
    drawInlineCaptureInfo(ctx, popup, bodyTop, source, state);
  }

  // Reserved the same whether or not there's a capture yet (like the track
  // row above), so the layout never reflows — its own carets/highlight only
  // draw once there's actually a clip to place them against (below).
  drawSelectionRulerBand(ctx, grid);

  drawSpectrogramBand(ctx, grid, state);
  drawTimeRuler(ctx, grid, pxPerSec, state);

  if (hasCapture) {
    drawBeatMatcherTimeGrid(ctx, grid, pxPerSec, state);
    drawBeatMatcherSuggestions(ctx, grid, pxPerSec, state);
    drawEndMarker(ctx, grid, pxPerSec, state);
    drawSelectionRulerMarkers(ctx, grid, pxPerSec, state, beatMatcherSelectionFocusFor(entity.id));
    if (noteSnap) {
      drawBeatMatcherNoteSnapIndicator(ctx, grid, pxPerSec, state, noteSnap);
    }
    drawConfirmedPointLine(ctx, grid, pxPerSec, state);
    drawCurrentPointLine(ctx, grid, pxPerSec, state);
    drawBeatMatcherPlaybackLine(ctx, grid, pxPerSec, state, beatMatcherCursorFlashGlow(entity.id, now));
    drawAxisHandle(ctx, grid, isAxisDragging);
    drawZoomIcon(ctx, axisZoomInIconPosition(grid), 'in');
    drawZoomIcon(ctx, axisZoomOutIconPosition(grid), 'out');
    drawBeatMatcherHScrollbar(ctx, grid, state);

    // The selected note's own velocity slider (if open) and duplicate
    // button — floating above/beside the note itself, so drawn here rather
    // than inside drawBeatMatcherNoteTrack's own clip region, same as
    // ui/sequencer.ts's own drawSequencerGrid.
    if (selectedNote) {
      const openTrack = beatMatcherVelocitySliderOpenFor(selectedNote.noteId);
      if (openTrack) {
        drawBeatMatcherVelocitySlider(ctx, state, selectedNote.noteId, openTrack);
      }
      const duplicateButton = duplicateButtonPosition(grid, pxPerSec, state, selectedNote.noteId);
      if (duplicateButton) {
        drawDuplicateButton(ctx, duplicateButton);
      }
    }
  }

  // Drawn last, on top of everything else in the plot, rather than
  // reflowing the layout — see infoOverlayRect's own comment.
  if (hasCapture && state.infoOverlayOpen) {
    drawInfoOverlay(ctx, popup, state, source);
  }

  ctx.restore();
}
