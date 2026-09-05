// The sequencer (TODO.md's spec): a `control`-type canvas entity (like
// knob/clock/tap) pairing an event-source role with a piano-roll-style
// authoring `feature` organelle — same porthole/popup mechanism as the
// ADSR envelope/melody/sampler organelles (ui/organelle.ts), just a
// multi-channel timeline editor instead of a curve or staff.
//
// Phase 1: the popup itself, a zoomable real-time grid (0.1s/1s/10s
// gridlines, finer spacing fading in only once zoomed in — reusing
// ui/organelle.ts's own gridStepSeconds), fixed-height channel lanes, a
// working local playback line (animated, scrubbable, with play/stop/
// rewind and a loop/stop track-end marker), a top-right handle that
// resizes the frame (horizontal: reveal more/less of the timeline at the
// same zoom; vertical: add/remove channels — dragging UP adds them, since
// every popup here grows upward from a fixed bottom anchor, see
// applySequencerResize's own comment — with horizontal/vertical
// scrollbars taking over once there's more timeline or more channels than
// the current frame size shows), and a per-channel output connector
// (visual/positional only — Phase 3 gives it real wiring — that pulses
// when Phase 2/3 gives it something to pulse for).
//
// Phase 2 (this pass): note authoring within a channel's own lane — drag
// to paint a note (onset at drag-start, offset at drag-end), drag an
// existing note's edge to resize it or its middle to move it, and a
// speed-gated snap that aligns a dragged edge to another note's boundary
// anywhere on the timeline (see the "--- Notes ---" section below). No
// pitch/velocity annotation yet, and no real per-channel wiring — a
// note's own onset still isn't connected to anything audible (that's
// Phase 3, once ui/eventWiring.ts's EventWire has a port dimension).
//
// Coordinate model, deliberately parallel to ui/organelle.ts's envelope
// popup: `zoomSeconds` is how many seconds the grid's fixed pixel width
// currently represents (its zoom), `scrollSeconds` is the world-time at
// the grid's own left edge (its pan position) — a real-time timeline with
// a rewind/scrub needs to pan, unlike the envelope's curve, which always
// starts at 0.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { getAudioContext, resumeAudioContext } from '../audio/context';
import {
  closeButtonPosition,
  gridStepSeconds,
  ownerOf,
  popupRectFor,
  CLOSE_BUTTON_RADIUS,
  TITLE_HEIGHT,
} from './organelle';
import type { HandleKind } from './organelle';
import { ACCENT } from './palette';

// Amplitude shape, contained entirely within a note's own [onsetSeconds,
// onsetSeconds + durationSeconds] — see noteEnvelopePoints. attack/decay/
// release are fractions of durationSeconds (not absolute seconds) so
// resizing the note rescales its shape proportionally with no reclamping;
// their sum is always <= 1 (see the individual clamps in
// setNoteEnvelopeFromHandle).
export interface NoteEnvelope {
  attack: number;
  decay: number;
  sustain: number; // level, 0..1
  release: number;
}

export interface SequencerNote {
  id: string;
  onsetSeconds: number;
  durationSeconds: number; // always > 0
  // MIDI note number, or null for a drum-like note with no pitch at all
  // (the default — see createSequencerNoteAt) — rendered/reported as "X"
  // until the user actually drags it into a pitch.
  pitch: number | null;
  velocity: number; // 0..1
  // null until the user first touches one of the two seed handles (see
  // drawNoteEnvelopeShape/setNoteEnvelopeFromHandle) — a note with no
  // envelope at all reads as "unshaped," not as some particular default
  // shape.
  envelope: NoteEnvelope | null;
}

export interface SequencerChannel {
  name: string;
  // Kept sorted by onsetSeconds — every create/move/resize clamps against
  // the immediately adjacent note(s) here (array-adjacent, given the sort)
  // so notes within one channel can never overlap or cross each other.
  notes: SequencerNote[];
}

export interface SequencerState {
  channels: SequencerChannel[];
  zoomSeconds: number; // visible width, in seconds — see this file's header comment
  scrollSeconds: number; // world-time at the grid's left edge
  playing: boolean;
  playStartCtxTime: number | null; // AudioContext.currentTime playback last (re)started from
  pausedAtSeconds: number; // playhead position while stopped, or the base currentPlaybackSeconds adds elapsed time to while playing
  popupWidth: number; // resizable via the bottom-right handle — see applySequencerResize
  popupHeight: number;
  channelScrollPx: number; // vertical scroll offset into the (possibly taller-than-visible) lane stack
  // The track's end point, in world-time seconds — where playback loops or
  // stops (see loopAtEnd), and what the horizontal scrollbar's own total
  // length reflects. While trackEndTouched is false, this is "implicit":
  // it starts at the visible window's own width and only ever grows on
  // its own, pushed ahead of an overrunning playhead once auto-scroll
  // starts following it (see updateSequencerPlayback) — never drawn until
  // that's actually happened, since until then it just trails the
  // viewport's own right edge rather than marking a real boundary. Once
  // the user drags the end marker (ui/interaction.ts's
  // draggingSequencerEnd), trackEndTouched flips true and it becomes a
  // real, fixed boundary the implicit-push/rewind-reset logic leaves
  // alone from then on.
  trackEndSeconds: number;
  trackEndTouched: boolean;
  // What happens when playback reaches trackEndSeconds — wrap back to 0
  // and keep playing, or stop there. Toggled by clicking the end marker's
  // own circular control (see endMarkerTogglePosition).
  loopAtEnd: boolean;
  // True from the moment the user manually drags the horizontal
  // scrollbar (updateSequencerScrollFromTrackX) while playing, until the
  // playhead reaches the right edge of wherever they scrolled to — see
  // followPlayhead's own comment. Lets a manual look at another part of
  // the track (or a look ahead of the cursor) stick, instead of the very
  // next frame's auto-follow snapping straight back to the cursor.
  autoScrollSuspended: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DEFAULT_CHANNEL_COUNT = 4;
export const LANE_HEIGHT = 22; // fixed per-lane height — about half the original computed lane height

export const DEFAULT_ZOOM_SECONDS = 8;
// Keeps the 0.1s grid step (the finest one gridStepSeconds ever picks)
// comfortably spaced even at max zoom-in, and the coarsest step readable
// even fully zoomed out.
export const MIN_ZOOM_SECONDS = 1;
export const MAX_ZOOM_SECONDS = 120;
const ZOOM_DRAG_SENSITIVITY = 0.15; // seconds of zoom per px of horizontal drag, same role as organelle.ts's TIME_SCALE_SENSITIVITY

function clampZoom(seconds: number): number {
  return clamp(seconds, MIN_ZOOM_SECONDS, MAX_ZOOM_SECONDS);
}

export function zoomFromDrag(startZoomSeconds: number, deltaX: number): number {
  return clampZoom(startZoomSeconds + deltaX * ZOOM_DRAG_SENSITIVITY);
}

// --- Layout constants --------------------------------------------------

const RULER_HEIGHT = 18; // the draggable/scrubbable strip showing grid labels, just below the title bar
const H_SCROLLBAR_HEIGHT = 10; // reserved bottom strip — always present so the lane area doesn't resize when it appears/disappears
const BOTTOM_PADDING = 8;
const SIDE_PADDING = 10;
const LANE_LABEL_WIDTH = 20; // room for each channel's own index label, to the grid's left
// Room on the right for the per-channel output connector, the vertical
// scrollbar, and the zoom axis-handle, without any of them overlapping —
// see connectorPosition/vScrollbarTrack/withinAxisHandleZone below, all
// measured from this same margin.
const RIGHT_MARGIN = 40;
const LINE_GRAB_TOLERANCE = 6; // px on either side of the drawn playback line that still counts as grabbing it

const RESIZE_CHROME_WIDTH = SIDE_PADDING + LANE_LABEL_WIDTH + RIGHT_MARGIN;
const RESIZE_CHROME_HEIGHT = TITLE_HEIGHT + RULER_HEIGHT + H_SCROLLBAR_HEIGHT + BOTTOM_PADDING;

export const MIN_POPUP_WIDTH = 300;
export const MAX_POPUP_WIDTH = 900;
// The default frame exactly fits DEFAULT_CHANNEL_COUNT lanes with no
// scrollbar needed — also the floor the resize handle can't shrink below
// (TODO.md's spec: "4 to start" is a hard minimum, not just a default).
export const SEQUENCER_POPUP_WIDTH = 420;
export const SEQUENCER_POPUP_HEIGHT = RESIZE_CHROME_HEIGHT + DEFAULT_CHANNEL_COUNT * LANE_HEIGHT;
export const MIN_POPUP_HEIGHT = SEQUENCER_POPUP_HEIGHT;
// How far the frame itself can grow before further downward drag stops
// resizing it and starts only adding channels (past this point a vertical
// scrollbar takes over — see applySequencerResize).
export const MAX_POPUP_HEIGHT = MIN_POPUP_HEIGHT + 6 * LANE_HEIGHT;

const statesByEntity = new Map<string, SequencerState>();

export function sequencerStateFor(entityId: string): SequencerState {
  let state = statesByEntity.get(entityId);
  if (!state) {
    state = {
      channels: Array.from({ length: DEFAULT_CHANNEL_COUNT }, (_, i) => ({ name: String(i + 1), notes: [] })),
      zoomSeconds: DEFAULT_ZOOM_SECONDS,
      scrollSeconds: 0,
      playing: false,
      playStartCtxTime: null,
      pausedAtSeconds: 0,
      popupWidth: SEQUENCER_POPUP_WIDTH,
      popupHeight: SEQUENCER_POPUP_HEIGHT,
      channelScrollPx: 0,
      trackEndSeconds: DEFAULT_ZOOM_SECONDS,
      trackEndTouched: false,
      loopAtEnd: false,
      autoScrollSuspended: false,
    };
    statesByEntity.set(entityId, state);
  }
  return state;
}

// --- Local transport -----------------------------------------------------
// Wall-clock playback reconciled against AudioContext.currentTime at read
// time — same shape as audio/graph.ts's EnvelopePlayback/
// ui/organelle.ts's envelopeCursorPosition, just a free-running position
// instead of one gated by a note's attack/decay/release. No new scheduler
// needed: currentPlaybackSeconds is a pure function of the audio clock.

export function currentPlaybackSeconds(state: SequencerState): number {
  if (!state.playing || state.playStartCtxTime === null) return state.pausedAtSeconds;
  return state.pausedAtSeconds + (getAudioContext().currentTime - state.playStartCtxTime);
}

export function startSequencer(state: SequencerState): void {
  if (state.playing) return;
  state.playing = true;
  state.playStartCtxTime = getAudioContext().currentTime;
  // AudioContext.currentTime is frozen while suspended — unlike a real
  // AudioNode/AudioParam interaction (e.g. audio/graph.ts's pause-gate
  // ramp for a CONTINUOUS_KINDS entity), a bare clock read doesn't itself
  // trigger a browser's autoplay auto-unlock, so without this the playhead
  // would just sit frozen at its start position forever despite `playing`
  // being true. Fire-and-forget, same as ui/main.ts's own prewarm — this
  // is already running from a real click, so it resolves promptly; nothing
  // here needs to block on it (playStartCtxTime is fine either way, since
  // currentTime resumes ticking from wherever it was frozen, not reset).
  resumeAudioContext().catch((err) => {
    console.error('Failed to resume audio for sequencer playback:', err);
  });
}

export function stopSequencer(state: SequencerState): void {
  if (!state.playing) return;
  state.pausedAtSeconds = currentPlaybackSeconds(state);
  state.playing = false;
  state.playStartCtxTime = null;
}

export function toggleSequencer(state: SequencerState): void {
  if (state.playing) stopSequencer(state);
  else startSequencer(state);
}

// Zeroes both the playhead AND the view's scroll position — brings a
// panned-away view back to the start along with the playhead, so rewind
// always leaves the sweep visible rather than needing a separate manual
// scroll back afterward. Also reverts an untouched (implicit) track end
// back to the viewport's own width — per this file's own header, an
// implicit end pushed ahead by a previous overrunning playhead shouldn't
// just linger there once playback has been reset; a touched (explicit)
// end is left alone regardless, since the whole point of setting one is
// that it stays fixed. (Once there's real note content — TODO.md's Phase
// 2 — an untouched end should revert no further than the last note
// instead; there isn't any yet, so the viewport width is the floor.)
export function rewindSequencer(state: SequencerState): void {
  state.pausedAtSeconds = 0;
  state.scrollSeconds = 0;
  if (state.playing) state.playStartCtxTime = getAudioContext().currentTime;
  if (!state.trackEndTouched) state.trackEndSeconds = state.zoomSeconds;
  state.autoScrollSuspended = false;
}

// Jump the playhead to an absolute position — dragging the ruler or the
// line itself (see hitTestSequencerPopup's 'scrub' hit). Keeps playing
// (re-anchored to now) if it already was, rather than stopping it.
export function scrubSequencer(state: SequencerState, seconds: number): void {
  state.pausedAtSeconds = Math.max(0, seconds);
  if (state.playing) state.playStartCtxTime = getAudioContext().currentTime;
}

// Keeps the playhead in view while playing, rather than letting it sweep
// off the right edge — the same "auto-scroll to follow the cursor,
// leaving some look-ahead room" behavior a DAW timeline has. Only while
// playing: while stopped, wherever the user has scrubbed/scrolled to is
// left alone (see hitTestSequencerPopup's own scrub/scrollbar handling —
// this would otherwise fight a manual scroll positioned deliberately
// ahead of a stopped playhead).
//
// Suspended (state.autoScrollSuspended) from the moment the user manually
// drags the horizontal scrollbar while playing — this lets a deliberate
// look at another part of the track, or a look ahead of the cursor, stick
// instead of snapping straight back on the very next frame. Resumes once
// the playhead reaches the right edge of wherever they scrolled to: for a
// look-AHEAD scroll (the cursor starts behind that edge), this fires once
// real playback naturally catches up to it; for a look-elsewhere scroll
// past the cursor's own current position, the edge is already behind the
// cursor, so it resumes right away once the drag ends — still useful for
// glancing at another spot while continuing to hold the drag.
const AUTO_SCROLL_LOOKAHEAD_FRACTION = 0.8; // keep the playhead here, 80% across the visible window, while playing

function followPlayhead(state: SequencerState): void {
  if (!state.playing) return;
  const playhead = currentPlaybackSeconds(state);
  const fraction = (playhead - state.scrollSeconds) / state.zoomSeconds;

  if (state.autoScrollSuspended) {
    if (fraction < 1) return;
    state.autoScrollSuspended = false;
  }

  // Snaps back into place the moment it's out of the desired window at
  // all (not just once it's fully off-screen to the right) — scrolling
  // only once the cursor has already vanished would be a jarring, late
  // correction rather than a smooth follow.
  if (fraction > AUTO_SCROLL_LOOKAHEAD_FRACTION || fraction < 0) {
    state.scrollSeconds = Math.max(0, playhead - AUTO_SCROLL_LOOKAHEAD_FRACTION * state.zoomSeconds);
  }
}

// Fixed VISUAL gap (not a fixed time gap, which would look wildly
// different depending on zoom) between the playhead and an implicit end
// pushed ahead of it — see updateSequencerPlayback's own comment.
const END_MARKER_LOOKAHEAD_PX = 6;

// Per-frame playback housekeeping, called once per frame from
// drawSequencerGrid — the same "adjust lightweight UI state during the
// draw pass" pattern ui/render.ts's drawEntity already uses to clear a
// finished settle animation. Order matters: the track end is enforced
// (loop/stop) before the playhead is followed, since a loop wrap moves
// the playhead back near 0 and the auto-scroll follow needs to react to
// THAT position, not the one it just wrapped from.
function updateSequencerPlayback(grid: GridArea, state: SequencerState): void {
  if (state.playing) {
    const playhead = currentPlaybackSeconds(state);
    if (playhead >= state.trackEndSeconds) {
      if (state.loopAtEnd) {
        // Shifts the ctx-time reference forward by exactly one track
        // length rather than resetting pausedAtSeconds/playStartCtxTime
        // outright — currentPlaybackSeconds reads back as exactly 0
        // afterward (see the arithmetic in this file's own comment on
        // EnvelopePlayback-style reconciliation), with no discontinuity
        // in the underlying bookkeeping.
        state.playStartCtxTime = (state.playStartCtxTime ?? getAudioContext().currentTime) + state.trackEndSeconds;
      } else {
        state.pausedAtSeconds = state.trackEndSeconds;
        state.playing = false;
        state.playStartCtxTime = null;
      }
    } else if (!state.trackEndTouched && state.scrollSeconds > 0) {
      // An implicit end never marks a real boundary — it just rides along
      // right after the playhead once auto-scroll has actually started
      // (state.scrollSeconds > 0 is a reliable proxy for that: nothing
      // else ever moves it off 0 besides followPlayhead or a manual
      // scrollbar drag), staying invisible before that — see
      // endMarkerVisible. Anchored to the playhead itself, a small fixed
      // SCREEN gap ahead of it, not to the viewport's own right edge: at
      // the 80%-across lookahead position (see AUTO_SCROLL_LOOKAHEAD_
      // FRACTION), this puts the band well within view, right next to the
      // cursor, rather than pinned exactly at the (invisible-by-
      // definition, per endMarkerVisible) right edge — which is what the
      // remaining ~20% of the viewport past the cursor is actually for:
      // room to see and grab this band, not just empty look-ahead space.
      const gapSeconds = END_MARKER_LOOKAHEAD_PX / pxPerSecond(grid, state.zoomSeconds);
      state.trackEndSeconds = Math.max(state.trackEndSeconds, playhead + gapSeconds);
    }
  }
  followPlayhead(state);
}

// Drag the end marker itself (ui/interaction.ts's draggingSequencerEnd) to
// a new absolute position — same "jump to wherever the pointer is" shape
// as scrubSequencer, but marks it touched (explicit) permanently rather
// than leaving it to auto-track the viewport edge.
export function setTrackEnd(state: SequencerState, seconds: number): void {
  state.trackEndSeconds = Math.max(MIN_ZOOM_SECONDS, seconds);
  state.trackEndTouched = true;
  // Dragging the boundary behind the cursor should bring the cursor back
  // with it — the cursor should never sit past the loop/stop point it
  // would otherwise immediately trigger against on the very next frame
  // (see updateSequencerPlayback), so pull it back in step rather than
  // leaving it stranded there until playback happens to reach it.
  if (currentPlaybackSeconds(state) > state.trackEndSeconds) {
    scrubSequencer(state, state.trackEndSeconds);
  }
}

// Clicking the toggle engages with the end marker just as directly as
// dragging it does, so it counts as a touch too — locking in wherever the
// (possibly still-implicit) end currently sits as the real, fixed
// boundary, same as setTrackEnd, rather than leaving it free to keep
// auto-tracking the playhead out from under a choice the user just made.
export function toggleLoopAtEnd(state: SequencerState): void {
  state.loopAtEnd = !state.loopAtEnd;
  state.trackEndTouched = true;
}

// --- Resizing (top-right handle) -----------------------------------------

// Shrinking (dragging the resize handle back down) truncates the excess
// channels' notes along with the channels themselves — no confirmation,
// same as this file's other resize behavior; nothing yet warns before an
// otherwise-destructive drag anywhere in this popup.
function resizeChannels(channels: SequencerChannel[], desiredCount: number): SequencerChannel[] {
  if (desiredCount === channels.length) return channels;
  if (desiredCount < channels.length) return channels.slice(0, desiredCount);
  const grown = channels.slice();
  for (let i = grown.length; i < desiredCount; i++) grown.push({ name: String(i + 1), notes: [] });
  return grown;
}

function laneAreaHeightFor(state: SequencerState): number {
  return state.popupHeight - RESIZE_CHROME_HEIGHT;
}

function maxChannelScrollPxFor(state: SequencerState): number {
  return Math.max(0, state.channels.length * LANE_HEIGHT - laneAreaHeightFor(state));
}

export interface SequencerResizeStart {
  popupWidth: number;
  popupHeight: number;
  zoomSeconds: number;
}

export function sequencerResizeStart(state: SequencerState): SequencerResizeStart {
  return { popupWidth: state.popupWidth, popupHeight: state.popupHeight, zoomSeconds: state.zoomSeconds };
}

// Two independent axes from one drag, per this file's own header comment:
//   - horizontal: the frame's width tracks dx directly (clamped), and
//     zoomSeconds is rescaled to keep seconds-per-pixel constant as the
//     grid area's own width changes — dragging right reveals MORE of the
//     timeline at the same zoom, rather than stretching the same range
//     (that's what the separate axis-handle zoom is for).
//   - vertical: every popup in this app (ui/organelle.ts's popupRectFor)
//     anchors near the porthole and grows UPWARD from a fixed bottom edge
//     — deliberately, so a popup near an entity anywhere on the canvas
//     never grows off-screen. The handle sits at the top-right corner
//     (resizeHandlePosition) to match: it's the corner that actually
//     moves. So dragging UP (negative dy) is what adds tracks here, not
//     down — the desired lane-CONTENT height tracks -dy directly (floored
//     at the default channel count's worth — never fewer), the frame's
//     own height grows to match up to MAX_POPUP_HEIGHT, and channel count
//     always matches how much content height is desired regardless of
//     whether the frame is still growing or has already capped out. Past
//     the cap, the frame stops growing but channel count keeps
//     increasing, and a vertical scrollbar takes over for the overflow
//     (see maxChannelScrollPxFor) — so "drag up adds tracks" stays true
//     even once the frame itself can't get any taller.
export function applySequencerResize(state: SequencerState, start: SequencerResizeStart, dx: number, dy: number): void {
  const newWidth = clamp(start.popupWidth + dx, MIN_POPUP_WIDTH, MAX_POPUP_WIDTH);
  const gridWidthBefore = start.popupWidth - RESIZE_CHROME_WIDTH;
  const gridWidthAfter = newWidth - RESIZE_CHROME_WIDTH;
  const pxPerSecBefore = gridWidthBefore / start.zoomSeconds;
  state.popupWidth = newWidth;
  state.zoomSeconds = clampZoom(gridWidthAfter / pxPerSecBefore);

  const startContentHeight = start.popupHeight - RESIZE_CHROME_HEIGHT;
  const desiredContentHeight = Math.max(DEFAULT_CHANNEL_COUNT * LANE_HEIGHT, startContentHeight - dy);
  state.popupHeight = clamp(RESIZE_CHROME_HEIGHT + desiredContentHeight, MIN_POPUP_HEIGHT, MAX_POPUP_HEIGHT);
  const desiredCount = Math.max(DEFAULT_CHANNEL_COUNT, Math.round(desiredContentHeight / LANE_HEIGHT));
  state.channels = resizeChannels(state.channels, desiredCount);
  state.channelScrollPx = clamp(state.channelScrollPx, 0, maxChannelScrollPxFor(state));
}

// --- Popup/grid geometry -------------------------------------------------

export function sequencerPopupRect(graph: EntityGraph, entityId: string, owner: Entity, drag?: DragContext): Rect {
  const state = sequencerStateFor(entityId);
  return popupRectFor(graph, owner, state.popupWidth, state.popupHeight, drag);
}

interface GridArea {
  left: number;
  right: number;
  top: number; // ruler's own top, just below the title bar
  rulerBottom: number; // ruler/lanes divider
  bottom: number; // bottom of the lane area (above the horizontal scrollbar row)
}

function gridAreaFor(popup: Rect): GridArea {
  const left = popup.x - popup.width / 2 + SIDE_PADDING + LANE_LABEL_WIDTH;
  const right = popup.x + popup.width / 2 - RIGHT_MARGIN;
  const top = popup.y - popup.height / 2 + TITLE_HEIGHT;
  const rulerBottom = top + RULER_HEIGHT;
  const bottom = popup.y + popup.height / 2 - BOTTOM_PADDING - H_SCROLLBAR_HEIGHT;
  return { left, right, top, rulerBottom, bottom };
}

function pxPerSecond(grid: GridArea, zoomSeconds: number): number {
  return (grid.right - grid.left) / zoomSeconds;
}

function secondsToX(grid: GridArea, pxPerSec: number, scrollSeconds: number, seconds: number): number {
  return grid.left + (seconds - scrollSeconds) * pxPerSec;
}

function xToSeconds(grid: GridArea, pxPerSec: number, scrollSeconds: number, x: number): number {
  return scrollSeconds + (x - grid.left) / pxPerSec;
}

// --- Buttons / handles ---------------------------------------------------

// Transport buttons sit in the title bar, left of the close button —
// rewind, then play/pause, reading left-to-right same as a real
// transport's button order.
const BUTTON_RADIUS = 8;
const BUTTON_GAP = 20;

function playButtonPosition(popup: Rect): Point {
  const close = closeButtonPosition(popup);
  return { x: close.x - BUTTON_GAP, y: close.y };
}

function rewindButtonPosition(popup: Rect): Point {
  const play = playButtonPosition(popup);
  return { x: play.x - BUTTON_GAP, y: play.y };
}

// A vertical grip strip along the popup's right edge, same shape/position
// as ui/organelle.ts's own axis-handle zoom grip — dragging it rescales
// zoomSeconds via ui/interaction.ts's existing draggingTimeAxis state
// (branched by feature kind there), rather than introducing a second,
// inconsistent zoom gesture just for this popup. Stops above the lane
// area's own bottom (not the full popup) so it doesn't compete with the
// horizontal scrollbar row beneath it.
const AXIS_HANDLE_ZONE_WIDTH = 12;

function withinAxisHandleZone(popup: Rect, grid: GridArea, point: Point): boolean {
  const right = popup.x + popup.width / 2;
  return point.x >= right - AXIS_HANDLE_ZONE_WIDTH && point.x <= right && point.y >= grid.top && point.y <= grid.bottom;
}

const RESIZE_HANDLE_RADIUS = 8;
const RESIZE_HANDLE_Y_OFFSET = 10; // below grid.top, clear of the close/play/rewind buttons' own hit zones just above it

// Top-right, just below the title bar — not the popup's exact geometric
// corner (too close to the close button's own hit zone there), and not
// exactly at grid.top either (same reason, still a bit too close). Still
// moves in exact lockstep with the drag regardless of the offset: the
// popup's TOP edge is the one that actually moves as height changes (see
// applySequencerResize's own comment on why top-right, not bottom-right —
// every popup here grows upward from a fixed bottom anchor), and this
// position is just that edge plus two fixed constants (TITLE_HEIGHT,
// folded into grid.top, plus this offset), so it tracks 1:1 either way.
function resizeHandlePosition(popup: Rect, grid: GridArea): Point {
  return { x: popup.x + popup.width / 2, y: grid.top + RESIZE_HANDLE_Y_OFFSET };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --- Scrollbars ------------------------------------------------------------
// Same "click the track to jump there, keep tracking on move" convention as
// ui/melody.ts's own horizontal scrollbar (updateScrollFromTrackX) — mirrored
// here in continuous seconds/pixels rather than item indices, once for the
// timeline (horizontal) and once for the channel stack (vertical).

// The scrollbar's own notion of "how long is the whole timeline" is
// state.trackEndSeconds (see that field's own comment: it starts at the
// viewport's width, so there's nothing to scroll to yet, and only grows
// from there) PLUS a fixed pixel margin — otherwise, once trackEndSeconds
// sits exactly at the scrollable maximum, the end marker's own strict
// "< grid.right" visibility check (endMarkerVisible) could never be
// satisfied even at full scroll, since its position would always land
// exactly on the boundary rather than short of it — leaving the marker
// (and its band, wide enough to hold the toggle) permanently unreachable.
// A pixel margin, not a fixed time one, so scrolling that last bit always
// reveals a consistent visual amount of the band regardless of zoom.
const SCROLLBAR_MIN_THUMB_LENGTH = 16;
// Declared here (rather than down with the rest of the end-marker layout
// constants) since scrollableTotalSeconds below needs it at module-init
// time, before that section runs — see this file's own "Track end
// marker" comment. Wide enough that BUTTON_RADIUS's own toggle circle
// sits comfortably inside it.
const END_MARKER_WIDTH = 24;
const END_MARKER_SCROLL_MARGIN_PX = END_MARKER_WIDTH + 24;

function scrollableTotalSeconds(grid: GridArea, state: SequencerState): number {
  return state.trackEndSeconds + END_MARKER_SCROLL_MARGIN_PX / pxPerSecond(grid, state.zoomSeconds);
}

function hScrollbarTrack(grid: GridArea): Rect {
  return { x: (grid.left + grid.right) / 2, y: grid.bottom + H_SCROLLBAR_HEIGHT / 2 + 2, width: grid.right - grid.left, height: H_SCROLLBAR_HEIGHT };
}

function hScrollbarNeeded(grid: GridArea, state: SequencerState): boolean {
  return state.zoomSeconds < scrollableTotalSeconds(grid, state);
}

function maxScrollSeconds(grid: GridArea, state: SequencerState): number {
  return Math.max(0, scrollableTotalSeconds(grid, state) - state.zoomSeconds);
}

function hThumbWidth(trackWidth: number, grid: GridArea, state: SequencerState): number {
  return Math.max(SCROLLBAR_MIN_THUMB_LENGTH, trackWidth * Math.min(1, state.zoomSeconds / scrollableTotalSeconds(grid, state)));
}

function hThumbX(track: Rect, grid: GridArea, state: SequencerState): number {
  const trackLeft = track.x - track.width / 2;
  const maxScroll = maxScrollSeconds(grid, state);
  if (maxScroll <= 0) return trackLeft;
  const thumbWidth = hThumbWidth(track.width, grid, state);
  return trackLeft + (track.width - thumbWidth) * (state.scrollSeconds / maxScroll);
}

export function updateSequencerScrollFromTrackX(graph: EntityGraph, entityId: string, pointerX: number, drag?: DragContext): void {
  const entity = graph.get(entityId);
  const owner = entity && ownerOf(graph, entity);
  if (!entity || !owner) return;
  const state = sequencerStateFor(entityId);
  const grid = gridAreaFor(sequencerPopupRect(graph, entityId, owner, drag));
  const track = hScrollbarTrack(grid);
  const maxScroll = maxScrollSeconds(grid, state);
  if (maxScroll <= 0) return;
  const thumbWidth = hThumbWidth(track.width, grid, state);
  const trackLeft = track.x - track.width / 2;
  const usable = track.width - thumbWidth;
  const t = usable > 0 ? (pointerX - trackLeft - thumbWidth / 2) / usable : 0;
  state.scrollSeconds = clamp(t, 0, 1) * maxScroll;
  // A manual scrollbar drag overrides auto-follow until the playhead
  // reaches the right edge of wherever this lands — see followPlayhead's
  // own comment. Harmless to set unconditionally even while stopped.
  state.autoScrollSuspended = true;
}

const V_SCROLLBAR_X_INSET = 20; // from the popup's right edge — between the connector column and the axis-handle zone

function vScrollbarTrack(popup: Rect, grid: GridArea): Rect {
  return { x: popup.x + popup.width / 2 - V_SCROLLBAR_X_INSET, y: (grid.rulerBottom + grid.bottom) / 2, width: 4, height: grid.bottom - grid.rulerBottom };
}

function vScrollbarNeeded(state: SequencerState): boolean {
  return maxChannelScrollPxFor(state) > 0;
}

function vThumbHeight(trackHeight: number, state: SequencerState): number {
  const contentHeight = state.channels.length * LANE_HEIGHT;
  return Math.max(SCROLLBAR_MIN_THUMB_LENGTH, trackHeight * Math.min(1, laneAreaHeightFor(state) / contentHeight));
}

function vThumbY(track: Rect, state: SequencerState): number {
  const trackTop = track.y - track.height / 2;
  const maxScroll = maxChannelScrollPxFor(state);
  if (maxScroll <= 0) return trackTop;
  const thumbHeight = vThumbHeight(track.height, state);
  return trackTop + (track.height - thumbHeight) * (state.channelScrollPx / maxScroll);
}

export function updateSequencerChannelScrollFromTrackY(graph: EntityGraph, entityId: string, pointerY: number, drag?: DragContext): void {
  const entity = graph.get(entityId);
  const owner = entity && ownerOf(graph, entity);
  if (!entity || !owner) return;
  const state = sequencerStateFor(entityId);
  const popup = sequencerPopupRect(graph, entityId, owner, drag);
  const track = vScrollbarTrack(popup, gridAreaFor(popup));
  const maxScroll = maxChannelScrollPxFor(state);
  if (maxScroll <= 0) return;
  const thumbHeight = vThumbHeight(track.height, state);
  const trackTop = track.y - track.height / 2;
  const usable = track.height - thumbHeight;
  const t = usable > 0 ? (pointerY - trackTop - thumbHeight / 2) / usable : 0;
  state.channelScrollPx = clamp(t, 0, 1) * maxScroll;
}

// --- Track end marker ------------------------------------------------------
// A vertical grey band wide enough to hold a circular loop/stop toggle
// (same size/style as the play/rewind buttons) — see
// SequencerState.trackEndSeconds/trackEndTouched/loopAtEnd for the
// underlying state this renders and drags.
//
// The band's LEFT edge, not its centre, is the precise stop/loop position
// (trackEndSeconds) — updateSequencerPlayback enforces the boundary
// exactly there, so the band extends rightward FROM it purely as a
// visual/grabbable affordance. Centering the band on trackEndSeconds
// instead (an earlier version of this did) put the solid edge line
// END_MARKER_WIDTH before the real trigger point, which read as the
// cursor overshooting past the line before actually looping/stopping.
// (END_MARKER_WIDTH itself is declared up with the scrollbar constants
// above — scrollableTotalSeconds needs it too, at module-init time, so it
// has to come before both use sites rather than just this one.)

function endMarkerX(grid: GridArea, state: SequencerState): number {
  return secondsToX(grid, pxPerSecond(grid, state.zoomSeconds), state.scrollSeconds, state.trackEndSeconds);
}

function endMarkerTogglePosition(grid: GridArea, state: SequencerState): Point {
  return { x: endMarkerX(grid, state) + END_MARKER_WIDTH / 2, y: (grid.top + grid.bottom) / 2 };
}

// Whether the marker is currently something to draw/interact with. An
// untouched (implicit) end sits exactly flush with the viewport's own
// right edge by construction (trackEndSeconds starts at, and is
// continually reset to, exactly zoomSeconds — see that field's own
// comment) — using a strict `<` here (not `<=`, unlike the playback
// line's own visibility check) is what keeps it hidden in exactly that
// resting position, while still correctly revealing it the moment
// anything moves it even slightly short of the current right edge:
// zooming out past it, autoscroll pushing the view forward, or the user
// dragging it (which also flips trackEndTouched, so it stays visible
// whereever it ends up from then on regardless of this geometric check —
// though a touched end dragged so far it's scrolled out of view still
// correctly hides, same as the playback line does).
function endMarkerVisible(grid: GridArea, state: SequencerState): boolean {
  const x = endMarkerX(grid, state);
  return x >= grid.left && x < grid.right;
}

export function hitTestEndMarkerToggle(grid: GridArea, state: SequencerState, point: Point): boolean {
  return endMarkerVisible(grid, state) && dist(point, endMarkerTogglePosition(grid, state)) <= BUTTON_RADIUS + 4;
}

export function hitTestEndMarkerBand(grid: GridArea, state: SequencerState, point: Point): boolean {
  if (!endMarkerVisible(grid, state)) return false;
  const x = endMarkerX(grid, state);
  return point.x >= x && point.x <= x + END_MARKER_WIDTH && point.y >= grid.top && point.y <= grid.bottom;
}

// --- Per-channel output connector ---------------------------------------
// Visual/positional only for now — Phase 3 gives it real event-wire
// endpoints (ui/eventWiring.ts's EventWire needs a sourcePort added first,
// since today it's one output per source entity and a channel needs
// several — see TODO.md). Nothing calls flashChannelConnector yet since
// there's no note data to trigger it; exported so Phase 2/3's actual
// note-triggering can flash a channel's connector the same way
// ui/interaction.ts's triggerFlashes already does for a pad.

const CONNECTOR_RADIUS = 4;
const CONNECTOR_OFFSET = 10; // from the grid's own right edge
const CONNECTOR_COLOR = '#c8a05a'; // matches ui/render.ts's WIRE_HANDLE_COLOR — reads as "output jack"
export const CONNECTOR_FLASH_DURATION_MS = 200;

const connectorFlashes = new Map<string, Map<number, number>>();

export function flashChannelConnector(entityId: string, channelIndex: number): void {
  let byChannel = connectorFlashes.get(entityId);
  if (!byChannel) {
    byChannel = new Map();
    connectorFlashes.set(entityId, byChannel);
  }
  byChannel.set(channelIndex, performance.now());
}

function connectorGlow(entityId: string, channelIndex: number, now: number): number {
  const flashAt = connectorFlashes.get(entityId)?.get(channelIndex);
  if (flashAt === undefined) return 0;
  const elapsed = now - flashAt;
  return elapsed >= 0 && elapsed <= CONNECTOR_FLASH_DURATION_MS ? 1 - elapsed / CONNECTOR_FLASH_DURATION_MS : 0;
}

function connectorPosition(grid: GridArea, channelScrollPx: number, index: number): Point {
  return { x: grid.right + CONNECTOR_OFFSET, y: grid.rulerBottom - channelScrollPx + index * LANE_HEIGHT + LANE_HEIGHT / 2 };
}

// --- Notes ---------------------------------------------------------------
// Click-drag in a lane's empty space to paint a note (onset at drag-start,
// offset at drag-end); drag an existing note's edge to resize it, or its
// middle to move it without changing its length. A channel's own notes
// array stays sorted by onsetSeconds, so every create/move/resize below
// clamps against the immediately adjacent note(s) — array-adjacent, given
// the sort — rather than needing a general overlap search.

const NOTE_EDGE_GRAB_PX = 6; // px on either side of a note's own edge that grabs it for resizing rather than moving
const MIN_NOTE_WIDTH_PX = 8; // fixed visual minimum, converted through the current zoom like LINE_GRAB_TOLERANCE already is
// The pitch a null note seeds to the moment it's first dragged (see
// ui/interaction.ts's 'notePitchDrag' pointerdown case) — not the note's
// own default (which is null/"X", see SequencerNote.pitch), just the
// starting point for that first drag.
export const DEFAULT_SEED_PITCH = 60; // "C4" / middle C
const DEFAULT_NOTE_VELOCITY = 1;
const NOTE_NUDGE_PX = 4; // arrow-key time nudge, converted through the current zoom like MIN_NOTE_WIDTH_PX

let nextNoteId = 1;

function channelIndexAtY(grid: GridArea, state: SequencerState, y: number): number | null {
  const relativeY = y - grid.rulerBottom + state.channelScrollPx;
  if (relativeY < 0) return null;
  const index = Math.floor(relativeY / LANE_HEIGHT);
  return index >= 0 && index < state.channels.length ? index : null;
}

function minNoteDurationSeconds(grid: GridArea, state: SequencerState): number {
  return MIN_NOTE_WIDTH_PX / pxPerSecond(grid, state.zoomSeconds);
}

function insertNoteSorted(channel: SequencerChannel, note: SequencerNote): void {
  const insertAt = channel.notes.findIndex((n) => n.onsetSeconds > note.onsetSeconds);
  if (insertAt === -1) channel.notes.push(note);
  else channel.notes.splice(insertAt, 0, note);
}

// Resolves owner/grid/state from just (graph, entityId) — the same
// "geometry stays private to this file" shape as secondsAtPopupX/
// updateSequencerScrollFromTrackX — so ui/interaction.ts never needs to
// know what a GridArea even is. Returns null if the feature/owner is gone
// (e.g. popup closed mid-drag).
function resolveSequencerGrid(graph: EntityGraph, entityId: string, drag?: DragContext): GridArea | null {
  const entity = graph.get(entityId);
  const owner = entity && ownerOf(graph, entity);
  if (!entity || !owner) return null;
  return gridAreaFor(sequencerPopupRect(graph, entityId, owner, drag));
}

// Inserts a new minimal-duration note at `onsetSeconds`, clamped against
// whichever existing note in the channel it would otherwise land on or
// cross. Returns the new note's id, or null if the feature/owner is gone.
export function createSequencerNoteAt(
  graph: EntityGraph,
  entityId: string,
  channelIndex: number,
  onsetSeconds: number,
  drag?: DragContext
): string | null {
  const grid = resolveSequencerGrid(graph, entityId, drag);
  if (!grid) return null;
  const state = sequencerStateFor(entityId);
  const channel = state.channels[channelIndex];
  if (!channel) return null;
  const minDuration = minNoteDurationSeconds(grid, state);

  // Clamp the starting onset itself against whatever's already there —
  // painting a new note doesn't get to start on top of (or past) an
  // existing one; see resizeSequencerNoteRight's own comment for why a
  // fresh note is otherwise handled as "immediately resize its own right
  // edge" rather than as a separate code path.
  let onset = Math.max(0, onsetSeconds);
  for (const existing of channel.notes) {
    const end = existing.onsetSeconds + existing.durationSeconds;
    if (onset >= existing.onsetSeconds && onset < end) onset = end;
  }

  const note: SequencerNote = {
    id: `note-${nextNoteId++}`,
    onsetSeconds: onset,
    durationSeconds: minDuration,
    pitch: null,
    velocity: DEFAULT_NOTE_VELOCITY,
    envelope: null,
  };
  insertNoteSorted(channel, note);
  return note.id;
}

function findNote(state: SequencerState, channelIndex: number, noteId: string): { channel: SequencerChannel; index: number } | null {
  const channel = state.channels[channelIndex];
  if (!channel) return null;
  const index = channel.notes.findIndex((n) => n.id === noteId);
  return index === -1 ? null : { channel, index };
}

// Moves the note's start, keeping its END fixed (so its length changes) —
// clamped so it can never cross the previous note's own end, nor push
// past this note's own end minus the minimum width.
export function resizeSequencerNoteLeft(
  graph: EntityGraph,
  entityId: string,
  channelIndex: number,
  noteId: string,
  newOnsetSeconds: number,
  drag?: DragContext
): void {
  const grid = resolveSequencerGrid(graph, entityId, drag);
  if (!grid) return;
  const state = sequencerStateFor(entityId);
  const found = findNote(state, channelIndex, noteId);
  if (!found) return;
  const { channel, index } = found;
  const note = channel.notes[index];
  const end = note.onsetSeconds + note.durationSeconds;
  const minDuration = minNoteDurationSeconds(grid, state);
  const lowerBound = index > 0 ? channel.notes[index - 1].onsetSeconds + channel.notes[index - 1].durationSeconds : 0;
  const onset = clamp(newOnsetSeconds, Math.max(0, lowerBound), end - minDuration);
  note.onsetSeconds = onset;
  note.durationSeconds = end - onset;
}

// Moves the note's end, keeping its START fixed — clamped so it can never
// cross the next note's own start, nor shrink past the minimum width.
// Also what a fresh 'create' drag turns into the moment it crosses
// DRAG_START_THRESHOLD (see ui/interaction.ts) — painting a note IS
// resizing its own just-created right edge, so there's no separate
// "grow a note while painting it" code path to keep in sync with this one.
export function resizeSequencerNoteRight(
  graph: EntityGraph,
  entityId: string,
  channelIndex: number,
  noteId: string,
  newEndSeconds: number,
  drag?: DragContext
): void {
  const grid = resolveSequencerGrid(graph, entityId, drag);
  if (!grid) return;
  const state = sequencerStateFor(entityId);
  const found = findNote(state, channelIndex, noteId);
  if (!found) return;
  const { channel, index } = found;
  const note = channel.notes[index];
  const minDuration = minNoteDurationSeconds(grid, state);
  const upperBound = index < channel.notes.length - 1 ? channel.notes[index + 1].onsetSeconds : Infinity;
  const end = clamp(newEndSeconds, note.onsetSeconds + minDuration, upperBound);
  note.durationSeconds = end - note.onsetSeconds;
}

// Moves the whole note (both onset and end shift together, duration
// unchanged) to `newOnsetSeconds`, clamped between the previous note's own
// end and the next note's own start minus this note's own length.
export function moveSequencerNote(
  graph: EntityGraph,
  entityId: string,
  channelIndex: number,
  noteId: string,
  newOnsetSeconds: number,
  drag?: DragContext
): void {
  const grid = resolveSequencerGrid(graph, entityId, drag);
  if (!grid) return;
  const state = sequencerStateFor(entityId);
  const found = findNote(state, channelIndex, noteId);
  if (!found) return;
  const { channel, index } = found;
  const note = channel.notes[index];
  const lowerBound = index > 0 ? channel.notes[index - 1].onsetSeconds + channel.notes[index - 1].durationSeconds : 0;
  const upperBound =
    index < channel.notes.length - 1 ? channel.notes[index + 1].onsetSeconds - note.durationSeconds : Infinity;
  note.onsetSeconds = clamp(newOnsetSeconds, Math.max(0, lowerBound), upperBound);
}

// --- Note edge snap --------------------------------------------------------
// Speed-gated hold-to-snap: a dragged note edge/position only locks onto
// another note's boundary (anywhere on the timeline, any channel) after
// the cursor has been both close to that boundary AND moving slowly for
// SNAP_HOLD_MS continuously — a fast drag glides straight past nearby
// boundaries with no snap at all. All four constants below are first-guess
// defaults, same spirit as this file's own ZOOM_DRAG_SENSITIVITY/
// END_MARKER_LOOKAHEAD_PX — reasonable, meant to be tuned by feel once
// tried live, not derived from a formula.
const SNAP_PROXIMITY_PX = 8; // must be this close on screen to be an eligible candidate
const SNAP_RELEASE_PROXIMITY_PX = 16; // hysteresis: once snapped, must move this far to release
const SNAP_SPEED_THRESHOLD_PX_PER_MS = 0.3; // "slow enough" for the hold to count at all
const SNAP_HOLD_MS = 350; // how long "slow and near" has to hold before it locks

export interface NoteSnapState {
  lastPointer: Point;
  lastMoveAt: number; // performance.now()
  snapCandidateSeconds: number | null; // shown as a guide line whenever set, whether or not the hold has completed
  snapHoldStartAt: number | null; // null unless actively counting down toward a lock
  snapped: boolean;
}

export function initialNoteSnapState(pointer: Point, now: number): NoteSnapState {
  return { lastPointer: pointer, lastMoveAt: now, snapCandidateSeconds: null, snapHoldStartAt: null, snapped: false };
}

// null once snapped (nothing left to count down) or not currently holding
// (moving too fast, or just arrived at a different candidate) — exported
// so ui/render.ts can turn this into the countdown dial's fill fraction
// without needing SNAP_HOLD_MS itself.
export function noteSnapHoldFraction(snap: NoteSnapState, now: number): number | null {
  if (snap.snapped || snap.snapHoldStartAt === null) return null;
  return Math.min(1, (now - snap.snapHoldStartAt) / SNAP_HOLD_MS);
}

// Every note boundary (onset and offset) across every channel, except the
// note currently being edited — not restricted to *other* channels only,
// since aligning with a neighboring note on the very same channel is just
// as useful and excluding it would need extra per-channel special-casing
// for no real benefit.
function snapCandidatesFor(state: SequencerState, excludeNoteId: string | null): number[] {
  const candidates: number[] = [];
  for (const channel of state.channels) {
    for (const note of channel.notes) {
      if (note.id === excludeNoteId) continue;
      candidates.push(note.onsetSeconds, note.onsetSeconds + note.durationSeconds);
    }
  }
  return candidates;
}

function applyNoteSnap(
  snap: NoteSnapState,
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

  // In range — always shown as a guide line (snapCandidateSeconds set),
  // but the hold-timeout countdown only actually runs while the cursor
  // stays slow at THIS candidate; picking up speed, or drifting to a
  // different one, restarts it from zero rather than carrying over
  // partial progress.
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

// --- Note selection --------------------------------------------------------
// A single selected note, app-wide (like ui/sampler.ts's own selectedMarker
// module state) — dims every other note in the same sequencer so it reads
// as "this one is now the focus," and is the hook future note-specific
// interactions (delete, pitch/velocity, ...) will act on rather than
// needing their own separate "which note" plumbing.
let selectedNote: { entityId: string; channelIndex: number; noteId: string } | null = null;

// Which note (if any) currently has its velocity slider open, and WHERE —
// see toggleVelocitySlider/velocitySliderOpenFor. The track is fixed at
// whatever position it had the moment the slider was opened (see
// velocityDragTrackAtPointer) and stays there for as long as it's open,
// including after a drag against it ends — recomputing a different
// "resting" position once the pointer lifts would make the slider jump
// somewhere else right as you let go of it, which is exactly the bug this
// avoids. Cleared whenever the selection moves to a DIFFERENT note (or
// away entirely), but preserved across a re-select of the SAME note —
// every note-grab pointerdown (move/resize/pitch/envelope) calls
// selectNote again on its own already-selected note, and that shouldn't
// slam the slider shut mid-interaction.
let velocitySliderOpen: { noteId: string; track: VelocityTrack } | null = null;

export function selectNote(entityId: string, channelIndex: number, noteId: string): void {
  if (velocitySliderOpen && velocitySliderOpen.noteId !== noteId) velocitySliderOpen = null;
  selectedNote = { entityId, channelIndex, noteId };
}

export function deselectNote(): void {
  selectedNote = null;
  velocitySliderOpen = null;
}

// Returns the track to start dragging against if the slider ended up open
// (vs. null, having just been dismissed) — ui/interaction.ts uses this to
// decide whether to also start a drag immediately.
export function toggleVelocitySlider(noteId: string, openAtTrack: VelocityTrack): VelocityTrack | null {
  if (velocitySliderOpen && velocitySliderOpen.noteId === noteId) {
    velocitySliderOpen = null;
    return null;
  }
  velocitySliderOpen = { noteId, track: openAtTrack };
  return openAtTrack;
}

// The slider's current track, if it's open for this note — the single
// source of truth for both drawing and hit-testing, so the two can never
// disagree about where it is.
export function velocitySliderOpenFor(noteId: string): VelocityTrack | null {
  return velocitySliderOpen && velocitySliderOpen.noteId === noteId ? velocitySliderOpen.track : null;
}

// Self-heals a stale selection (the note, or the channel it was in, no
// longer exists — e.g. deleted, or its channel was removed by shrinking
// the track) the same way ui/sampler.ts's hasSelectedMarker verifies its
// own module state before trusting it, rather than requiring every caller
// that mutates channels/notes to remember to clear this separately.
export function selectedNoteFor(entityId: string): { channelIndex: number; noteId: string } | null {
  if (!selectedNote || selectedNote.entityId !== entityId) return null;
  const state = sequencerStateFor(entityId);
  const channel = state.channels[selectedNote.channelIndex];
  if (!channel || !channel.notes.some((n) => n.id === selectedNote!.noteId)) {
    selectedNote = null;
    return null;
  }
  return { channelIndex: selectedNote.channelIndex, noteId: selectedNote.noteId };
}

export function hasSelectedNote(): boolean {
  return !!selectedNote && selectedNoteFor(selectedNote.entityId) !== null;
}

// --- Selected-note actions ---------------------------------------------
// Delete/duplicate/nudge, all driven by ui/interaction.ts's keyboard
// handling (see attachKeyboard) and all resolving the current
// `selectedNote` internally rather than taking it as a parameter — same
// "resolve everything from module state" shape selection itself already
// uses, so callers just need to know THAT something is selected
// (hasSelectedNote), not which one.

export function deleteSelectedNote(): void {
  if (!selectedNote) return;
  const { entityId, channelIndex, noteId } = selectedNote;
  if (!selectedNoteFor(entityId)) return;
  const found = findNote(sequencerStateFor(entityId), channelIndex, noteId);
  if (!found) return;
  found.channel.notes.splice(found.index, 1);
  deselectNote();
}

// Clones the selected note immediately after itself (touching its own end),
// clamped against whatever note follows it — same clamp shape
// createSequencerNoteAt uses for a fresh note. No-ops (returns null) if
// there's no room at all, e.g. the next note already touches this one's end.
export function duplicateSelectedNote(graph: EntityGraph): string | null {
  if (!selectedNote) return null;
  const { entityId, channelIndex, noteId } = selectedNote;
  if (!selectedNoteFor(entityId)) return null;
  const grid = resolveSequencerGrid(graph, entityId);
  if (!grid) return null;
  const state = sequencerStateFor(entityId);
  const found = findNote(state, channelIndex, noteId);
  if (!found) return null;
  const { channel, index } = found;
  const original = channel.notes[index];
  const minDuration = minNoteDurationSeconds(grid, state);
  const onset = original.onsetSeconds + original.durationSeconds;
  const upperBound = index < channel.notes.length - 1 ? channel.notes[index + 1].onsetSeconds : Infinity;
  const duration = Math.min(original.durationSeconds, upperBound - onset);
  if (duration < minDuration) return null;

  const clone: SequencerNote = {
    id: `note-${nextNoteId++}`,
    onsetSeconds: onset,
    durationSeconds: duration,
    pitch: original.pitch,
    velocity: original.velocity,
    envelope: original.envelope ? { ...original.envelope } : null,
  };
  insertNoteSorted(channel, clone);
  selectNote(entityId, channelIndex, clone.id);
  return clone.id;
}

export function nudgeSelectedNoteTime(graph: EntityGraph, direction: -1 | 1): void {
  if (!selectedNote) return;
  const { entityId, channelIndex, noteId } = selectedNote;
  if (!selectedNoteFor(entityId)) return;
  const grid = resolveSequencerGrid(graph, entityId);
  if (!grid) return;
  const state = sequencerStateFor(entityId);
  const found = findNote(state, channelIndex, noteId);
  if (!found) return;
  const note = found.channel.notes[found.index];
  const step = NOTE_NUDGE_PX / pxPerSecond(grid, state.zoomSeconds);
  moveSequencerNote(graph, entityId, channelIndex, noteId, note.onsetSeconds + direction * step);
}

// Moving a note to a different channel has no existing neighbor-clamp to
// reuse (moveSequencerNote only ever slides a note within its OWN channel)
// — rather than inventing a reflow, this only succeeds if the note's exact
// current time range is entirely free in the target channel; otherwise
// it's a no-op, same "always prevent overlap, never resolve it after the
// fact" spirit as every other note edit in this file.
export function moveSelectedNoteChannel(direction: -1 | 1): void {
  if (!selectedNote) return;
  const { entityId, channelIndex, noteId } = selectedNote;
  if (!selectedNoteFor(entityId)) return;
  const state = sequencerStateFor(entityId);
  const targetIndex = channelIndex + direction;
  if (targetIndex < 0 || targetIndex >= state.channels.length) return;
  const found = findNote(state, channelIndex, noteId);
  if (!found) return;
  const note = found.channel.notes[found.index];
  const targetChannel = state.channels[targetIndex];
  const noteEnd = note.onsetSeconds + note.durationSeconds;
  const blocked = targetChannel.notes.some(
    (n) => note.onsetSeconds < n.onsetSeconds + n.durationSeconds && noteEnd > n.onsetSeconds
  );
  if (blocked) return;
  found.channel.notes.splice(found.index, 1);
  insertNoteSorted(targetChannel, note);
  selectNote(entityId, targetIndex, noteId);
}

// Resolves grid/state/candidates from just (graph, entityId), same shape
// as this file's other exported per-drag update functions — `snap` is
// mutated in place, and the seconds value to actually apply is returned.
export function applySequencerNoteSnap(
  graph: EntityGraph,
  entityId: string,
  snap: NoteSnapState,
  excludeNoteId: string | null,
  rawSeconds: number,
  pointer: Point,
  now: number,
  drag?: DragContext
): number {
  const grid = resolveSequencerGrid(graph, entityId, drag);
  if (!grid) return rawSeconds;
  const state = sequencerStateFor(entityId);
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const candidates = snapCandidatesFor(state, excludeNoteId);
  return applyNoteSnap(snap, candidates, rawSeconds, pointer, now, pxPerSec);
}

// --- Note inspector (pitch/velocity) ---------------------------------------
// A small cluster shown only for the currently-selected note, anchored in
// screen space just above it (so it scrolls/zooms along with the note
// itself, using the same secondsToX/lane-top math the note is drawn with)
// rather than living in some fixed corner of the popup — there's no
// meaningful "pitch axis" in this piano-roll (a lane's own vertical axis is
// which channel, not pitch — see TODO.md's own note on this), so pitch and
// velocity get their own tiny controls instead of a spatial position.

const PITCH_DRAG_PX_PER_SEMITONE = 6; // relative-delta drag, same shape as zoomFromDrag
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`;
}

// Pure (startValue, pixelDelta) -> newValue, same shape as zoomFromDrag —
// up is higher pitch, so a negative (upward) deltaY increases it.
export function pitchFromDrag(startPitch: number, deltaY: number): number {
  return clamp(Math.round(startPitch - deltaY / PITCH_DRAG_PX_PER_SEMITONE), 0, 127);
}

// setNotePitch doesn't need to resolve the popup/grid at all — unlike
// every other per-note setter in this file, pitch has no on-screen
// geometry of its own to convert through (it's a relative-delta drag off
// wherever the user first grabbed the pitch text — see pitchFromDrag —
// not an absolute position within some track).
export function setNotePitch(entityId: string, channelIndex: number, noteId: string, pitch: number): void {
  const found = findNote(sequencerStateFor(entityId), channelIndex, noteId);
  if (!found) return;
  found.channel.notes[found.index].pitch = clamp(pitch, 0, 127);
}

// --- Velocity slider ---------------------------------------------------
// Velocity itself is represented on the note's own body (opacity + a
// centered percentage — see drawSequencerNote). Clicking that percentage,
// only reachable while the note is selected, reveals a small vertical
// slider floating above the note (see toggleVelocitySlider/
// velocitySliderOpenFor) rather than dragging being available at all times
// from some other, less discoverable spot.

const VELOCITY_SLIDER_HIT_WIDTH = 14; // matches the thumb stroke's own ±7px width (see drawVelocitySlider)
const VELOCITY_SLIDER_HEIGHT = 50;
const VELOCITY_SLIDER_HIT_MARGIN = 5;

// A vertical fader track — same shape as ui/controls.ts's own Track, kept
// separate rather than imported since this one is never resolved from a
// control spec (velocity's range is always a plain 0..1 fraction).
export interface VelocityTrack {
  x: number;
  top: number;
  bottom: number;
}

// Same idea as ui/controls.ts's own trackGeometry — positions the track so
// the point representing `velocity` lands exactly at `pointer`, the moment
// a drag starts by clicking the percentage text (see
// hitTestVelocityText/toggleVelocitySlider): the handle appears right
// where the cursor already is, ready to drag, rather than the user having
// to first locate the slider and then grab its thumb. No grid/zoom
// involved — velocity has no time axis, just a fixed pixel height.
export function velocityDragTrackAtPointer(pointer: Point, velocity: number): VelocityTrack {
  const bottom = pointer.y + velocity * VELOCITY_SLIDER_HEIGHT;
  return { x: pointer.x, top: bottom - VELOCITY_SLIDER_HEIGHT, bottom };
}

// Absolute-position "fader" set against an already-resolved, FIXED track —
// captured once at drag-start (either resting or pointer-anchored — see
// above) and reused for the whole drag, same "don't let the track chase
// the very value it's producing" reasoning as ui/controls.ts's own
// valueFromTrackPosition.
export function setNoteVelocityFromTrack(entityId: string, channelIndex: number, noteId: string, track: VelocityTrack, y: number): void {
  const found = findNote(sequencerStateFor(entityId), channelIndex, noteId);
  if (!found) return;
  const fraction = 1 - (y - track.top) / (track.bottom - track.top);
  found.channel.notes[found.index].velocity = clamp(fraction, 0, 1);
}

// Same visual language as a knob/synth control's own slider (see
// ui/render.ts's drawControls): a thin rounded track line, a short
// horizontal thumb stroke in the accent color at the current value, and a
// text readout above. `track` is always velocitySliderOpenFor's own
// stored value — fixed at wherever the slider was opened, whether or not
// a drag against it happens to be active right now (see its own comment
// on why this must never be recomputed from the note's position instead).
function drawVelocitySlider(ctx: CanvasRenderingContext2D, state: SequencerState, channelIndex: number, noteId: string, track: VelocityTrack): void {
  const note = state.channels[channelIndex]?.notes.find((n) => n.id === noteId);
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

// Against velocitySliderOpenFor's own stored track — reachable only when
// the slider is already open (a fresh pointerdown; a drag in progress
// captures its own track once and never re-hit-tests).
function hitTestVelocitySlider(track: VelocityTrack, point: Point): boolean {
  return (
    point.x >= track.x - VELOCITY_SLIDER_HIT_WIDTH / 2 - VELOCITY_SLIDER_HIT_MARGIN &&
    point.x <= track.x + VELOCITY_SLIDER_HIT_WIDTH / 2 + VELOCITY_SLIDER_HIT_MARGIN &&
    point.y >= track.top - VELOCITY_SLIDER_HIT_MARGIN &&
    point.y <= track.bottom + VELOCITY_SLIDER_HIT_MARGIN
  );
}


// --- Note envelope shape ----------------------------------------------
// Draggable ADSR-style handles on the currently-selected note, same
// HandleKind names as ui/organelle.ts's own envelope organelle
// (imported directly rather than redefining an identical type) — but a
// separate, much smaller geometry: this shape always fits entirely inside
// the note's own [onset, onset+duration] box (no zoom/timeScale, no
// drawing or dragging past the note's own edges), the way a DAW clip's
// fade handles never extend past the clip itself. attack/decay/release are
// stored as fractions of the note's own duration (see SequencerNote), so
// resizing the note rescales the shape for free.

const NOTE_CURVE_COLOR = 'rgba(232, 220, 192, 0.9)'; // matches ui/organelle.ts's own CURVE_COLOR
const NOTE_HANDLE_RADIUS = 3.5; // small — a lane is only ~16px tall once inset
const NOTE_HANDLE_HIT_RADIUS = 7;
const NOTE_SEED_HANDLE_RADIUS = 2; // smaller/fainter than a real handle — these two haven't shaped anything yet
const NOTE_SEED_HANDLE_COLOR = 'rgba(255, 255, 255, 0.35)';

// The envelope every note starts as before its first edit — attack=0,
// decay=0, release=0 and sustain=1 is a no-op shape (instant on, instant
// off, full level throughout), which conveniently also means its
// attackPeak/decayCorner sit exactly at the note's own top-left corner and
// its releaseStart sits exactly at the top-right — precisely where the two
// subtle "seed" handles are drawn/hit-tested for a note with no envelope
// yet (see drawNoteEnvelopeShape/hitTestNoteEnvelopeHandle), so no separate
// geometry is needed for that state.
const IDENTITY_ENVELOPE: NoteEnvelope = { attack: 0, decay: 0, sustain: 1, release: 0 };

interface NoteEnvelopePoints {
  start: Point;
  attackPeak: Point;
  decayCorner: Point;
  releaseStart: Point;
  end: Point;
}

function noteEnvelopePoints(left: number, right: number, top: number, bottom: number, envelope: NoteEnvelope): NoteEnvelopePoints {
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
// fill, with only the two subtle seed handles (top-left/top-right) drawn
// on top — no curve, since there's no shape to show. Once an envelope
// exists (first touch of either seed handle — see
// setNoteEnvelopeFromHandle), the full ADSR polyline becomes the note's
// own body instead, with all three real handles.
function drawNoteEnvelopeShape(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  top: number,
  bottom: number,
  note: SequencerNote,
  activeHandle: HandleKind | null
): void {
  if (!note.envelope) {
    ctx.save();
    ctx.fillStyle = NOTE_FILL;
    ctx.fillRect(left, top, Math.max(1, right - left), bottom - top);
    ctx.restore();
    const pts = noteEnvelopePoints(left, right, top, bottom, IDENTITY_ENVELOPE);
    drawNoteSeedHandle(ctx, pts.attackPeak, activeHandle === 'attack');
    drawNoteSeedHandle(ctx, pts.releaseStart, activeHandle === 'release');
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

  drawNoteEnvelopeHandle(ctx, pts.attackPeak, activeHandle === 'attack');
  drawNoteEnvelopeHandle(ctx, pts.decayCorner, activeHandle === 'decaySustain');
  drawNoteEnvelopeHandle(ctx, pts.releaseStart, activeHandle === 'release');
}

// Before an envelope exists, only the two seed handles (attack/release) are
// reachable — there's no decaySustain handle to grab since decay/sustain
// haven't been shaped yet, matching what's actually drawn.
function hitTestNoteEnvelopeHandle(
  grid: GridArea,
  state: SequencerState,
  selected: { channelIndex: number; noteId: string } | null,
  point: Point
): HandleKind | null {
  if (!selected) return null;
  const channel = state.channels[selected.channelIndex];
  const note = channel?.notes.find((n) => n.id === selected.noteId);
  if (!note) return null;
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  const laneTop = grid.rulerBottom - state.channelScrollPx + selected.channelIndex * LANE_HEIGHT;
  const top = laneTop + NOTE_VERTICAL_INSET;
  const bottom = laneTop + LANE_HEIGHT - NOTE_VERTICAL_INSET;
  const pts = noteEnvelopePoints(left, right, top, bottom, note.envelope ?? IDENTITY_ENVELOPE);

  if (dist(point, pts.attackPeak) <= NOTE_HANDLE_HIT_RADIUS) return 'attack';
  if (note.envelope && dist(point, pts.decayCorner) <= NOTE_HANDLE_HIT_RADIUS) return 'decaySustain';
  if (dist(point, pts.releaseStart) <= NOTE_HANDLE_HIT_RADIUS) return 'release';
  return null;
}

// True while the decay/sustain handle sits exactly on top of the attack
// handle (decay=0 and sustain=1 — including a note with no envelope at
// all yet, which is the same identity shape) — the two are otherwise
// indistinguishable by position, so ui/interaction.ts uses this to decide
// whether a press on 'attack' needs to stay ambiguous (resolved by drag
// direction — see its own comment) rather than committing immediately.
export function attackDecayHandlesCoincide(entityId: string, channelIndex: number, noteId: string): boolean {
  const found = findNote(sequencerStateFor(entityId), channelIndex, noteId);
  const envelope = found?.channel.notes[found.index].envelope;
  return !envelope || (envelope.decay === 0 && envelope.sustain === 1);
}

// Absolute-position drag, same shape as setNoteVelocityFromTrack — the
// handle's new value IS wherever the pointer currently is, converted back
// through the note's own box geometry, mirroring
// ui/organelle.ts's envelopeValuesFromHandle. Each value is clamped only
// against the OTHER two's current values (attack+decay+release <= 1),
// same single-value-clamp spirit as resizeSequencerNoteLeft/Right. Release
// and decaySustain both set sustain from the vertical position (they sit on
// the same flat sustain line — see noteEnvelopePoints), so dragging either
// one vertically moves the other's handle along with it.
export function setNoteEnvelopeFromHandle(
  graph: EntityGraph,
  entityId: string,
  channelIndex: number,
  noteId: string,
  handle: HandleKind,
  point: Point,
  drag?: DragContext
): void {
  const grid = resolveSequencerGrid(graph, entityId, drag);
  if (!grid) return;
  const state = sequencerStateFor(entityId);
  const found = findNote(state, channelIndex, noteId);
  if (!found) return;
  const note = found.channel.notes[found.index];
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  const width = right - left;
  if (width <= 0) return;

  // First touch of either seed handle materializes the envelope (as the
  // identity shape — see IDENTITY_ENVELOPE) before applying this specific
  // handle's own drag on top of it, so touching just one handle doesn't
  // also jump the other, still-untouched dimensions to some arbitrary
  // default.
  if (!note.envelope) note.envelope = { ...IDENTITY_ENVELOPE };
  const envelope = note.envelope;

  if (handle === 'attack') {
    envelope.attack = clamp((point.x - left) / width, 0, 1 - envelope.decay - envelope.release);
    return;
  }

  // Both release and decaySustain sit on the flat sustain line, so a
  // vertical drag on either one raises/lowers that same line — moving the
  // OTHER handle right along with it, since they share this one y value.
  const laneTop = grid.rulerBottom - state.channelScrollPx + channelIndex * LANE_HEIGHT;
  const top = laneTop + NOTE_VERTICAL_INSET;
  const bottom = laneTop + LANE_HEIGHT - NOTE_VERTICAL_INSET;
  envelope.sustain = clamp(1 - (point.y - top) / (bottom - top), 0, 1);

  if (handle === 'release') {
    envelope.release = clamp((right - point.x) / width, 0, 1 - envelope.attack - envelope.decay);
  } else {
    const attackPeakX = left + envelope.attack * width;
    envelope.decay = clamp((point.x - attackPeakX) / width, 0, 1 - envelope.attack - envelope.release);
  }
}

// --- Hit-testing -------------------------------------------------------

export type SequencerHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'play' }
  | { entityId: string; kind: 'rewind' }
  | { entityId: string; kind: 'scrub'; seconds: number }
  | { entityId: string; kind: 'axisHandle' }
  | { entityId: string; kind: 'resize' }
  | { entityId: string; kind: 'hScroll' }
  | { entityId: string; kind: 'vScroll' }
  | { entityId: string; kind: 'endMarkerToggle' }
  | { entityId: string; kind: 'endMarkerDrag'; seconds: number }
  | { entityId: string; kind: 'noteCreate'; channelIndex: number; seconds: number }
  | { entityId: string; kind: 'noteResizeLeft'; channelIndex: number; noteId: string }
  | { entityId: string; kind: 'noteResizeRight'; channelIndex: number; noteId: string }
  | { entityId: string; kind: 'noteMove'; channelIndex: number; noteId: string; grabOffsetSeconds: number }
  | { entityId: string; kind: 'notePitchDrag'; channelIndex: number; noteId: string }
  | { entityId: string; kind: 'noteVelocityTextClick'; channelIndex: number; noteId: string }
  | { entityId: string; kind: 'noteVelocitySliderDrag'; channelIndex: number; noteId: string }
  | { entityId: string; kind: 'noteEnvelopeHandle'; channelIndex: number; noteId: string; handle: HandleKind }
  | { entityId: string; kind: 'background' };

// Shared by hitTestPitchText/hitTestVelocityText below: the note's own
// visible left/right/center-y, or null if it's not currently on screen or
// too narrow for the "pitch:velocity" label to be drawn at all (matching
// drawSequencerNote's own >= 14px cutoff) — the two text halves are only
// ever grabbable where they're actually visible.
function noteLabelGeometry(
  grid: GridArea,
  state: SequencerState,
  channelIndex: number,
  noteId: string
): { cx: number; cy: number } | null {
  const channel = state.channels[channelIndex];
  const note = channel?.notes.find((n) => n.id === noteId);
  if (!note) return null;
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
  const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
  if (right < grid.left || left > grid.right || right - left < 14) return null;
  const laneTop = grid.rulerBottom - state.channelScrollPx + channelIndex * LANE_HEIGHT;
  return { cx: (left + right) / 2, cy: laneTop + LANE_HEIGHT / 2 };
}

// The "X" (or note name) half of the centered label, just left of the
// colon — only reachable for the currently-selected note, matching what's
// actually drawn/grabbable there (see drawSequencerNote).
function hitTestPitchText(
  grid: GridArea,
  state: SequencerState,
  selected: { channelIndex: number; noteId: string } | null,
  point: Point
): boolean {
  if (!selected) return false;
  const geometry = noteLabelGeometry(grid, state, selected.channelIndex, selected.noteId);
  if (!geometry) return false;
  return (
    point.x >= geometry.cx - NOTE_LABEL_HALF_GAP - 16 &&
    point.x <= geometry.cx - NOTE_LABEL_HALF_GAP &&
    Math.abs(point.y - geometry.cy) <= 7
  );
}

// The percentage half of the centered label, just right of the colon —
// moved off-center (see drawSequencerNote) to make room for the pitch half
// added alongside it; same "only reachable while selected" reasoning.
function hitTestVelocityText(
  grid: GridArea,
  state: SequencerState,
  selected: { channelIndex: number; noteId: string } | null,
  point: Point
): boolean {
  if (!selected) return false;
  const geometry = noteLabelGeometry(grid, state, selected.channelIndex, selected.noteId);
  if (!geometry) return false;
  return (
    point.x >= geometry.cx + NOTE_LABEL_HALF_GAP &&
    point.x <= geometry.cx + NOTE_LABEL_HALF_GAP + 20 &&
    Math.abs(point.y - geometry.cy) <= 7
  );
}

type NoteHit =
  | { kind: 'noteResizeLeft'; channelIndex: number; noteId: string }
  | { kind: 'noteResizeRight'; channelIndex: number; noteId: string }
  | { kind: 'noteMove'; channelIndex: number; noteId: string; grabOffsetSeconds: number };

// Existing notes only — a click on empty lane space falls through to
// hitTestSequencerPopup's own 'noteCreate' fallback instead. Edge grabs
// (within NOTE_EDGE_GRAB_PX) take priority over a body grab so a resize is
// always reachable even on a very short note.
function hitTestNotes(grid: GridArea, state: SequencerState, point: Point): NoteHit | null {
  if (point.x < grid.left || point.x > grid.right) return null;
  const channelIndex = channelIndexAtY(grid, state, point.y);
  if (channelIndex === null) return null;
  const channel = state.channels[channelIndex];
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  for (const note of channel.notes) {
    const left = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
    const right = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
    if (point.x < left - NOTE_EDGE_GRAB_PX || point.x > right + NOTE_EDGE_GRAB_PX) continue;
    if (Math.abs(point.x - left) <= NOTE_EDGE_GRAB_PX) {
      return { kind: 'noteResizeLeft', channelIndex, noteId: note.id };
    }
    if (Math.abs(point.x - right) <= NOTE_EDGE_GRAB_PX) {
      return { kind: 'noteResizeRight', channelIndex, noteId: note.id };
    }
    if (point.x >= left && point.x <= right) {
      const grabOffsetSeconds = xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x) - note.onsetSeconds;
      return { kind: 'noteMove', channelIndex, noteId: note.id, grabOffsetSeconds };
    }
  }
  return null;
}

export function hitTestSequencerPopup(graph: EntityGraph, point: Point, drag?: DragContext): SequencerHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'sequencer' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;

    const popup = sequencerPopupRect(graph, entity.id, owner, drag);
    const grid = gridAreaFor(popup);

    // Resize handle checked before the close/play/rewind buttons it sits
    // near (a small precise circle just below the title bar, at the right
    // edge — see resizeHandlePosition's own comment on the exact spot) —
    // see this file's own layout comments on how the margins were chosen
    // to avoid the several right-edge zones meaningfully overlapping
    // anywhere else.
    if (dist(point, resizeHandlePosition(popup, grid)) <= RESIZE_HANDLE_RADIUS + 4) {
      return { entityId: entity.id, kind: 'resize' };
    }
    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }
    if (dist(point, playButtonPosition(popup)) <= BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'play' };
    }
    if (dist(point, rewindButtonPosition(popup)) <= BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'rewind' };
    }

    const state = sequencerStateFor(entity.id);
    const pxPerSec = pxPerSecond(grid, state.zoomSeconds);

    if (hScrollbarNeeded(grid, state)) {
      const track = hScrollbarTrack(grid);
      if (Math.abs(point.y - track.y) <= 5 && point.x >= track.x - track.width / 2 && point.x <= track.x + track.width / 2) {
        return { entityId: entity.id, kind: 'hScroll' };
      }
    }
    if (vScrollbarNeeded(state)) {
      const track = vScrollbarTrack(popup, grid);
      if (Math.abs(point.x - track.x) <= 5 && point.y >= track.y - track.height / 2 && point.y <= track.y + track.height / 2) {
        return { entityId: entity.id, kind: 'vScroll' };
      }
    }

    // The end marker's own toggle (a precise click) takes priority over
    // dragging the band itself, which in turn takes priority over the
    // playback-line/ruler scrub below — checked first so a click near
    // both (the end marker parked right on top of the playhead, say)
    // unambiguously grabs the marker.
    if (hitTestEndMarkerToggle(grid, state, point)) {
      return { entityId: entity.id, kind: 'endMarkerToggle' };
    }
    if (hitTestEndMarkerBand(grid, state, point)) {
      return {
        entityId: entity.id,
        kind: 'endMarkerDrag',
        seconds: xToSeconds(grid, pxPerSecond(grid, state.zoomSeconds), state.scrollSeconds, point.x),
      };
    }

    // Every check below is only ever reachable for the CURRENT selection
    // (nothing of this shape is drawn for any other note — see
    // drawSequencerNote/drawNoteEnvelopeShape/drawVelocitySlider), resolved
    // once and reused rather than re-querying selectedNoteFor per check.
    const currentSelection = selectedNoteFor(entity.id);

    // The pitch half of the centered label ("X" or a note name, left of
    // the colon) — checked before a plain note-edge/body grab so it
    // doesn't compete with resizing/moving the same note it's drawn on.
    if (hitTestPitchText(grid, state, currentSelection, point)) {
      return { entityId: entity.id, kind: 'notePitchDrag', channelIndex: currentSelection!.channelIndex, noteId: currentSelection!.noteId };
    }

    // The envelope handles, drawn on top of the note's own ADSR shape.
    const envelopeHandle = hitTestNoteEnvelopeHandle(grid, state, currentSelection, point);
    if (envelopeHandle && currentSelection) {
      return {
        entityId: entity.id,
        kind: 'noteEnvelopeHandle',
        channelIndex: currentSelection.channelIndex,
        noteId: currentSelection.noteId,
        handle: envelopeHandle,
      };
    }

    // The velocity slider, if the selected note currently has it open —
    // wherever it was opened (see velocitySliderOpenFor's own comment),
    // same "checked ahead of a plain note grab" reasoning as the pitch/
    // envelope checks above.
    if (currentSelection) {
      const openTrack = velocitySliderOpenFor(currentSelection.noteId);
      if (openTrack && hitTestVelocitySlider(openTrack, point)) {
        return {
          entityId: entity.id,
          kind: 'noteVelocitySliderDrag',
          channelIndex: currentSelection.channelIndex,
          noteId: currentSelection.noteId,
        };
      }
    }

    // The percentage half of the centered label, right of the colon —
    // click to toggle the velocity slider above. Checked before a plain
    // note-body grab (hitTestNotes' 'noteMove') since it sits inside the
    // note itself; grabbing anywhere else on the same note still moves it
    // normally.
    if (hitTestVelocityText(grid, state, currentSelection, point)) {
      return {
        entityId: entity.id,
        kind: 'noteVelocityTextClick',
        channelIndex: currentSelection!.channelIndex,
        noteId: currentSelection!.noteId,
      };
    }

    // An existing note's edge/body takes priority over the playback line
    // grabbed at the same spot below — checked before the ruler/playback
    // checks so a note sitting right under the playhead is still directly
    // editable rather than always starting a scrub.
    const noteHit = hitTestNotes(grid, state, point);
    if (noteHit) {
      return { entityId: entity.id, ...noteHit };
    }

    // Two ways to start a scrub: anywhere along the ruler row (a "click to
    // jump there" strip, like a DAW timeline ruler), or a grab directly on
    // the drawn playback line itself — which spans the FULL grid height
    // through the lanes (see drawSequencerGrid), not just the ruler — so
    // dragging it works wherever it's actually visible, not only in that
    // thin top strip. The near-the-line band is deliberately narrow so it
    // doesn't meaningfully compete with note-painting in the lanes below.
    const inRulerRow = point.x >= grid.left && point.x <= grid.right && point.y >= grid.top && point.y <= grid.rulerBottom;
    const playX = secondsToX(grid, pxPerSec, state.scrollSeconds, currentPlaybackSeconds(state));
    // Matches drawSequencerGrid's own visibility condition exactly — a
    // playhead scrolled out of the visible window isn't drawn there, so it
    // shouldn't be grabbable there either (which could otherwise bleed
    // into the connector/scrollbar column just past grid.right).
    const onPlaybackLine =
      playX >= grid.left &&
      playX <= grid.right &&
      Math.abs(point.x - playX) <= LINE_GRAB_TOLERANCE &&
      point.y >= grid.top &&
      point.y <= grid.bottom;
    if (inRulerRow || onPlaybackLine) {
      return { entityId: entity.id, kind: 'scrub', seconds: xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x) };
    }

    // Empty lane space, below the ruler — starts painting a brand-new note.
    const emptyLaneChannel = channelIndexAtY(grid, state, point.y);
    if (emptyLaneChannel !== null && point.x >= grid.left && point.x <= grid.right) {
      return {
        entityId: entity.id,
        kind: 'noteCreate',
        channelIndex: emptyLaneChannel,
        seconds: xToSeconds(grid, pxPerSec, state.scrollSeconds, point.x),
      };
    }

    if (withinAxisHandleZone(popup, grid, point)) {
      return { entityId: entity.id, kind: 'axisHandle' };
    }

    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return { entityId: entity.id, kind: 'background' };
    }
  }
  return null;
}

// Converts an x screen coordinate into seconds against `entityId`'s own
// current popup/grid/zoom, independent of y — used for continuing a scrub
// drag (ui/interaction.ts's scrubbingSequencerId) once the pointer strays
// off the ruler's own tight vertical bounds, which hitTestSequencerPopup's
// 'scrub' hit deliberately requires (so it doesn't compete with, say, a
// future note-drag over the lanes below it). A real scrub gesture should
// keep tracking horizontally regardless. Returns null if the feature/owner
// is gone (e.g. popup closed mid-drag).
export function secondsAtPopupX(graph: EntityGraph, entityId: string, x: number, drag?: DragContext): number | null {
  const entity = graph.get(entityId);
  if (!entity) return null;
  const owner = ownerOf(graph, entity);
  if (!owner) return null;
  const popup = sequencerPopupRect(graph, entityId, owner, drag);
  const state = sequencerStateFor(entityId);
  const grid = gridAreaFor(popup);
  return xToSeconds(grid, pxPerSecond(grid, state.zoomSeconds), state.scrollSeconds, x);
}

// --- Drawing -------------------------------------------------------------

const BODY_COLOR = '#3a3450'; // distinct cool violet — reads as neither a knob/clock/tap nor any source kind's own hue
const PANEL_BG = 'rgba(22, 22, 22, 0.97)'; // matches ui/organelle.ts's own PANEL_BG

// Collapsed on-canvas presence — a small rounded box (not the circular
// drawControlBody every other control kind uses; there's no reason to
// force a multi-lane timeline widget into a circle) with a kind label.
// The porthole itself (click to open the popup) is drawn separately,
// generically, by ui/organelle.ts's own drawPorthole — unchanged, since
// it's already owner-type-agnostic.
export function drawSequencerBody(ctx: CanvasRenderingContext2D, entity: Entity, bounds: Rect, selected: boolean): void {
  const left = bounds.x - bounds.width / 2;
  const top = bounds.y - bounds.height / 2;
  const radius = 6;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.roundRect(left, top, bounds.width, bounds.height, radius);
  ctx.fillStyle = BODY_COLOR;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = selected ? ACCENT : 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.kind, bounds.x, bounds.y);
  ctx.restore();
}

function drawPlayIcon(ctx: CanvasRenderingContext2D, center: Point, playing: boolean): void {
  const s = BUTTON_RADIUS * 0.6;
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

function drawRewindIcon(ctx: CanvasRenderingContext2D, center: Point): void {
  const s = BUTTON_RADIUS * 0.55;
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

function drawTransportButton(ctx: CanvasRenderingContext2D, center: Point, active: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, BUTTON_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = active ? ACCENT : 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();
  ctx.restore();
}

function drawResizeHandle(ctx: CanvasRenderingContext2D, pos: Point, active: boolean): void {
  ctx.save();
  ctx.strokeStyle = active ? ACCENT : 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const offset of [3, 7]) {
    ctx.beginPath();
    ctx.moveTo(pos.x - offset, pos.y);
    ctx.lineTo(pos.x, pos.y - offset);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHScrollbar(ctx: CanvasRenderingContext2D, grid: GridArea, state: SequencerState): void {
  if (!hScrollbarNeeded(grid, state)) return;
  const track = hScrollbarTrack(grid);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = H_SCROLLBAR_HEIGHT * 0.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(track.x - track.width / 2, track.y);
  ctx.lineTo(track.x + track.width / 2, track.y);
  ctx.stroke();

  const thumbWidth = hThumbWidth(track.width, grid, state);
  const thumbX = hThumbX(track, grid, state);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(thumbX, track.y);
  ctx.lineTo(thumbX + thumbWidth, track.y);
  ctx.stroke();
  ctx.restore();
}

function drawVScrollbar(ctx: CanvasRenderingContext2D, popup: Rect, grid: GridArea, state: SequencerState): void {
  if (!vScrollbarNeeded(state)) return;
  const track = vScrollbarTrack(popup, grid);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = track.width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(track.x, track.y - track.height / 2);
  ctx.lineTo(track.x, track.y + track.height / 2);
  ctx.stroke();

  const thumbHeight = vThumbHeight(track.height, state);
  const thumbY = vThumbY(track, state);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(track.x, thumbY);
  ctx.lineTo(track.x, thumbY + thumbHeight);
  ctx.stroke();
  ctx.restore();
}

function drawChannelConnector(ctx: CanvasRenderingContext2D, pos: Point, glow: number): void {
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 8 * glow;
  }
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, CONNECTOR_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = glow > 0 ? ACCENT : CONNECTOR_COLOR;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// A simplified "repeat" glyph (an open ring with one arrowhead) for loop,
// a plain filled square (the universal "stop" glyph) for stop.
function drawLoopStopIcon(ctx: CanvasRenderingContext2D, center: Point, looping: boolean): void {
  const s = BUTTON_RADIUS * 0.55;
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
const END_MARKER_SOLID_EDGE = 'rgba(220, 220, 220, 0.8)'; // once touched — a real, fixed boundary

function drawEndMarker(ctx: CanvasRenderingContext2D, grid: GridArea, state: SequencerState): void {
  if (!endMarkerVisible(grid, state)) return;
  const x = endMarkerX(grid, state);

  ctx.save();
  ctx.fillStyle = END_MARKER_FILL;
  ctx.fillRect(x, grid.top, END_MARKER_WIDTH, grid.bottom - grid.top);
  // The left edge — the actual, precise stop/loop position — only reads
  // as a real, fixed boundary once the user has actually set it
  // (trackEndTouched): an implicit end is still just trailing the
  // viewport's own edge, not asserting a hard stop/loop point yet, so it
  // gets no distinct edge line at all, just the soft fill.
  if (state.trackEndTouched) {
    ctx.strokeStyle = END_MARKER_SOLID_EDGE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, grid.top);
    ctx.lineTo(x, grid.bottom);
    ctx.stroke();
  }
  ctx.restore();

  const toggle = endMarkerTogglePosition(grid, state);
  drawTransportButton(ctx, toggle, false);
  drawLoopStopIcon(ctx, toggle, state.loopAtEnd);
}

const NOTE_FILL = 'rgba(90, 160, 200, 0.55)';
const NOTE_EDGE_HILITE = 'rgba(200, 230, 245, 0.8)';
const NOTE_VERTICAL_INSET = 3; // keeps a note visually clear of its own lane's dividers
const NOTE_DIMMED_ALPHA = 0.25; // how far a non-selected note fades once something else is selected

// Velocity 0 fades a note almost (not quite — it would otherwise be
// unclickable/invisible) out of view; velocity 1 leaves it exactly as
// dimmed/selected would otherwise render it — a multiplier on top of the
// existing dimmed alpha, not a replacement for it.
const MIN_VELOCITY_ALPHA_FACTOR = 0.4;
const NOTE_LABEL_HALF_GAP = 3; // px from the note's own horizontal center to where the pitch/velocity text starts, on either side of the colon

function drawSequencerNote(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  top: number,
  bottom: number,
  note: SequencerNote,
  selected: boolean,
  dimmed: boolean,
  activeEnvelopeHandle: HandleKind | null
): void {
  const baseAlpha = dimmed ? NOTE_DIMMED_ALPHA : 1;
  const velocityAlpha = MIN_VELOCITY_ALPHA_FACTOR + (1 - MIN_VELOCITY_ALPHA_FACTOR) * note.velocity;

  ctx.save();
  ctx.globalAlpha = baseAlpha * velocityAlpha;
  // The selected note trades its plain flat fill for its own ADSR shape —
  // every other note (never dimmed AND selected at once) keeps the flat
  // rect.
  if (selected) {
    drawNoteEnvelopeShape(ctx, left, right, top, bottom, note, activeEnvelopeHandle);
  } else {
    ctx.fillStyle = NOTE_FILL;
    ctx.fillRect(left, top, Math.max(1, right - left), bottom - top);
  }
  // A brighter sliver at each edge hints "grab here to resize" — same
  // spirit as the end marker's own solid-once-touched edge treatment.
  ctx.fillStyle = NOTE_EDGE_HILITE;
  ctx.fillRect(left, top, 2, bottom - top);
  ctx.fillRect(right - 2, top, 2, bottom - top);
  ctx.restore();

  // A "pitch:velocity" readout, colon fixed at the note's own horizontal
  // center — pitch to its left (a MIDI note name, or "X" for a drum-like
  // note with no pitch at all — see midiNoteName/SequencerNote.pitch),
  // velocity to its right (see hitTestVelocityText's own comment on why
  // it moved off-center to make room). Stays legible regardless of how
  // transparent the fill above is (that's the whole point of having it) —
  // it only fades with `dimmed`, not with velocity itself. Each half is
  // independently hidden at its own default (no pitch / full velocity)
  // unless this note is selected, same "quiet until it's either the
  // selection or actually been touched" rule as the rest of this file's
  // per-note UI; the colon itself only appears if at least one half does.
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
    ctx.strokeRect(left + 1, top + 1, Math.max(1, right - left) - 2, bottom - top - 2);
    ctx.restore();
  }
}

// Shown for a note-edge/move drag while a snap candidate is in range —
// whether or not the hold has completed. The dial only appears while
// still counting down (holdFraction !== null); once actually snapped, the
// guide line alone (brighter/thicker) is enough feedback.
export interface NoteSnapIndicator {
  candidateSeconds: number;
  channelIndex: number;
  snapped: boolean;
  holdFraction: number | null;
}

const SNAP_DIAL_RADIUS = 5;

function drawNoteSnapIndicator(ctx: CanvasRenderingContext2D, grid: GridArea, state: SequencerState, indicator: NoteSnapIndicator): void {
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const x = secondsToX(grid, pxPerSec, state.scrollSeconds, indicator.candidateSeconds);
  if (x < grid.left || x > grid.right) return;

  ctx.save();
  ctx.strokeStyle = indicator.snapped ? ACCENT : 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = indicator.snapped ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(x, grid.top);
  ctx.lineTo(x, grid.bottom);
  ctx.stroke();
  ctx.restore();

  if (indicator.holdFraction === null) return;
  const laneTop = grid.rulerBottom - state.channelScrollPx + indicator.channelIndex * LANE_HEIGHT;
  const center = { x, y: laneTop + LANE_HEIGHT / 2 };

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

function drawSequencerGrid(
  ctx: CanvasRenderingContext2D,
  grid: GridArea,
  entityId: string,
  state: SequencerState,
  now: number,
  noteSnap: NoteSnapIndicator | null,
  selectedNote: { channelIndex: number; noteId: string } | null,
  activeEnvelopeHandle: HandleKind | null
): void {
  updateSequencerPlayback(grid, state);
  const pxPerSec = pxPerSecond(grid, state.zoomSeconds);
  const step = gridStepSeconds(pxPerSec);

  // Faint vertical gridlines + their labels in the ruler strip, same
  // adaptive-density logic as ui/organelle.ts's own drawTimeGrid, just
  // panned by scrollSeconds (the envelope's curve always starts at 0, so
  // it never needed to).
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const firstLine = Math.ceil(state.scrollSeconds / step) * step;
  for (let s = firstLine; ; s += step) {
    const x = secondsToX(grid, pxPerSec, state.scrollSeconds, s);
    if (x > grid.right) break;
    ctx.beginPath();
    ctx.moveTo(x, grid.top);
    ctx.lineTo(x, grid.bottom);
    ctx.stroke();
    ctx.fillText(step < 1 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`, x, grid.top + 2);
  }
  ctx.restore();

  // Channel lanes — alternating subtle shading, index label to the left,
  // and each one's own output connector at the grid's right edge (visual
  // only for now — see this file's own comment on flashChannelConnector).
  // Clipped to the lane area specifically (not just the popup interior),
  // since content here scrolls independently of the ruler above it once
  // there are more channels than fit — see channelScrollPx.
  ctx.save();
  ctx.beginPath();
  ctx.rect(grid.left - LANE_LABEL_WIDTH, grid.rulerBottom, grid.right - grid.left + LANE_LABEL_WIDTH + CONNECTOR_OFFSET + CONNECTOR_RADIUS + 2, grid.bottom - grid.rulerBottom);
  ctx.clip();

  for (let i = 0; i < state.channels.length; i++) {
    const laneTop = grid.rulerBottom - state.channelScrollPx + i * LANE_HEIGHT;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.01)';
    ctx.fillRect(grid.left - LANE_LABEL_WIDTH, laneTop, grid.right - grid.left + LANE_LABEL_WIDTH, LANE_HEIGHT);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.channels[i].name, grid.left - LANE_LABEL_WIDTH / 2, laneTop + LANE_HEIGHT / 2);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= state.channels.length; i++) {
    const y = grid.rulerBottom - state.channelScrollPx + i * LANE_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(grid.left - LANE_LABEL_WIDTH, y);
    ctx.lineTo(grid.right, y);
    ctx.stroke();
  }

  for (let i = 0; i < state.channels.length; i++) {
    const laneTop = grid.rulerBottom - state.channelScrollPx + i * LANE_HEIGHT;
    for (const note of state.channels[i].notes) {
      const noteLeft = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds);
      const noteRight = secondsToX(grid, pxPerSec, state.scrollSeconds, note.onsetSeconds + note.durationSeconds);
      if (noteRight < grid.left || noteLeft > grid.right) continue;
      const selected = note.id === selectedNote?.noteId;
      const dimmed = selectedNote !== null && !selected;
      drawSequencerNote(
        ctx,
        noteLeft,
        noteRight,
        laneTop + NOTE_VERTICAL_INSET,
        laneTop + LANE_HEIGHT - NOTE_VERTICAL_INSET,
        note,
        selected,
        dimmed,
        selected ? activeEnvelopeHandle : null
      );
    }
  }

  for (let i = 0; i < state.channels.length; i++) {
    drawChannelConnector(ctx, connectorPosition(grid, state.channelScrollPx, i), connectorGlow(entityId, i, now));
  }

  ctx.restore();

  drawEndMarker(ctx, grid, state);
  if (noteSnap) {
    drawNoteSnapIndicator(ctx, grid, state, noteSnap);
  }
  if (selectedNote) {
    const openTrack = velocitySliderOpenFor(selectedNote.noteId);
    if (openTrack) {
      drawVelocitySlider(ctx, state, selectedNote.channelIndex, selectedNote.noteId, openTrack);
    }
  }

  // The playback line — bright, glowing while actually playing (a plain
  // static marker while stopped reads as "paused here," not "about to
  // move"), spanning the ruler and every lane. Skipped entirely once
  // scrolled out of the visible window rather than clamping it to an edge,
  // which would misleadingly suggest the playhead is still nearby.
  const playX = secondsToX(grid, pxPerSec, state.scrollSeconds, currentPlaybackSeconds(state));
  if (playX >= grid.left && playX <= grid.right) {
    ctx.save();
    if (state.playing) {
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = 8;
    }
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playX, grid.top);
    ctx.lineTo(playX, grid.bottom);
    ctx.stroke();
    ctx.restore();
  }

  drawHScrollbar(ctx, grid, state);
}

export function drawSequencerPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  now: number,
  draggingAxis: boolean,
  resizing: boolean,
  noteSnap: NoteSnapIndicator | null,
  activeEnvelopeHandle: HandleKind | null,
  drag?: DragContext
): void {
  const popup = sequencerPopupRect(graph, entity.id, owner, drag);
  const left = popup.x - popup.width / 2;
  const top = popup.y - popup.height / 2;
  const state = sequencerStateFor(entity.id);
  const grid = gridAreaFor(popup);

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

  // Title bar
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(entity.kind, left + 10, top + TITLE_HEIGHT / 2);

  const rewind = rewindButtonPosition(popup);
  drawTransportButton(ctx, rewind, false);
  drawRewindIcon(ctx, rewind);

  const play = playButtonPosition(popup);
  drawTransportButton(ctx, play, state.playing);
  drawPlayIcon(ctx, play, state.playing);

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

  // Grid/lanes/playback line clipped to the popup's interior, same
  // reasoning as ui/organelle.ts's own curve clip — content past the
  // visible zoom/pan window stays contained rather than spilling past the
  // panel's own border.
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top + TITLE_HEIGHT, popup.width, popup.height - TITLE_HEIGHT);
  ctx.clip();
  drawSequencerGrid(ctx, grid, entity.id, state, now, noteSnap, selectedNoteFor(entity.id), activeEnvelopeHandle);
  ctx.restore();

  drawVScrollbar(ctx, popup, grid, state);

  // Zoom grip, same visual language as ui/organelle.ts's own drawAxisHandle.
  const x = popup.x + popup.width / 2 - AXIS_HANDLE_ZONE_WIDTH / 2 - 1;
  const axisMidY = (grid.top + grid.bottom) / 2;
  ctx.strokeStyle = draggingAxis ? ACCENT : 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const dy of [-8, 0, 8]) {
    ctx.beginPath();
    ctx.moveTo(x, axisMidY + dy - 3);
    ctx.lineTo(x, axisMidY + dy + 3);
    ctx.stroke();
  }

  drawResizeHandle(ctx, resizeHandlePosition(popup, grid), resizing);

  ctx.restore();
}
