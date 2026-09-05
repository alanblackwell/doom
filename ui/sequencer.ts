// The sequencer (TODO.md's spec): a `control`-type canvas entity (like
// knob/clock/tap) pairing an event-source role with a piano-roll-style
// authoring `feature` organelle — same porthole/popup mechanism as the
// ADSR envelope/melody/sampler organelles (ui/organelle.ts), just a
// multi-channel timeline editor instead of a curve or staff.
//
// Phase 1 only, per TODO.md: the popup itself, a zoomable real-time grid
// (0.1s/1s/10s gridlines, finer spacing fading in only once zoomed in —
// reusing ui/organelle.ts's own gridStepSeconds), fixed-height channel
// lanes (empty — no notes yet, see TODO.md's Phase 2), a working local
// playback line (animated, scrubbable, with play/stop/rewind), a
// top-right handle that resizes the frame (horizontal: reveal more/less
// of the timeline at the same zoom; vertical: add/remove channels —
// dragging UP adds them, since every popup here grows upward from a fixed
// bottom anchor, see applySequencerResize's own comment — with
// horizontal/vertical scrollbars taking over once there's more timeline
// or more channels than the current frame size shows), and a per-channel
// output connector (visual/positional only — Phase 3 gives it real wiring
// — that pulses when Phase 2/3 gives it something to pulse for). No
// notes, no wiring, no pitch/velocity annotation yet.
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
import { ACCENT } from './palette';

export interface SequencerChannel {
  name: string;
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
      channels: Array.from({ length: DEFAULT_CHANNEL_COUNT }, (_, i) => ({ name: String(i + 1) })),
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

function resizeChannels(channels: SequencerChannel[], desiredCount: number): SequencerChannel[] {
  if (desiredCount === channels.length) return channels;
  if (desiredCount < channels.length) return channels.slice(0, desiredCount);
  const grown = channels.slice();
  for (let i = grown.length; i < desiredCount; i++) grown.push({ name: String(i + 1) });
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
  | { entityId: string; kind: 'background' };

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

    // Two ways to start a scrub: anywhere along the ruler row (a "click to
    // jump there" strip, like a DAW timeline ruler), or a grab directly on
    // the drawn playback line itself — which spans the FULL grid height
    // through the lanes (see drawSequencerGrid), not just the ruler — so
    // dragging it works wherever it's actually visible, not only in that
    // thin top strip. The near-the-line band is deliberately narrow so it
    // won't meaningfully compete with Phase 2's future note-painting in
    // the lanes below.
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

function drawSequencerGrid(ctx: CanvasRenderingContext2D, grid: GridArea, entityId: string, state: SequencerState, now: number): void {
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
    drawChannelConnector(ctx, connectorPosition(grid, state.channelScrollPx, i), connectorGlow(entityId, i, now));
  }

  ctx.restore();

  drawEndMarker(ctx, grid, state);

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
  drawSequencerGrid(ctx, grid, entity.id, state, now);
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
