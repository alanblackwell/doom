// Geometry, state, hit-testing, and drawing for the melody organelle
// (EntityType 'feature', kind 'melody' — see audio/entityGraph.ts and
// ui/organelle.ts's porthole/popup mechanism, which this reuses unchanged
// for the collapsed/expanded toggle). Deliberately its own module rather
// than folded into ui/organelle.ts: a grand-staff note editor doesn't share
// any of the envelope's curve/handle geometry, only the generic
// porthole-anchoring math (ownerOf/portholePosition/popupRectFor), which
// organelle.ts already exports for exactly this kind of reuse.
//
// Editing model (see TODO.md's melody organelle spec for the full brief):
// a left-to-right sequence of notes/rests/barlines. Horizontal position is
// purely the item's INDEX in `MelodyState.items` — rendered at
// staffLeft + FIRST_ITEM_OFFSET + index * DEFAULT_ITEM_SPACING (see
// itemScreenPosition) — rather than a stored pixel offset, so dragging one
// item left/right is really a live reorder of the array: the target slot is
// recomputed from the pointer's x on every move (reorderDuringDrag), which
// both shifts everything between the old and new position to make room and
// closes the gap left behind, automatically and continuously rather than as
// a separate "snap back" step on drop. A note's vertical position is a
// diatonic staff step (see STEP_PX/stepToY below), not a raw pixel, so it
// stays correct across whatever the current octave-shift buttons are doing.
// Horizontal and vertical dragging are mutually exclusive within a single
// drag gesture (see ui/interaction.ts's melodyPress.axis, locked in once
// the initial movement crosses DRAG_START_THRESHOLD) — otherwise a mostly-
// horizontal reorder drag would also nudge the note's pitch via whatever
// small vertical jitter came along with it.
//
// No audio wiring yet — this is purely the editing surface (TODO.md's other
// items, the sequencer especially, are where playback/timing will live).

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import { ownerOf, popupRectFor, CLOSE_BUTTON_RADIUS, TITLE_HEIGHT } from './organelle';
import { ACCENT } from './palette';
import { flatMakesSense, sharpMakesSense } from './musicTheory';
import { isBravuraReady } from './bravuraFont';
import {
  ACCIDENTAL_WIDTH_SP,
  BRAVURA_FONT_FAMILY,
  CLEF_WIDTH_SP,
  GLYPH,
  LEGER_LINE_EXTENSION_SP,
  LEGER_LINE_THICKNESS_SP,
  NOTEHEAD_WIDTH_SP,
  REST_WIDTH_SP,
  STEM_DOWN_NW,
  STEM_THICKNESS_SP,
  STEM_UP_SE,
} from './bravuraGlyphs';

// --- Pitch model ---------------------------------------------------------

// Diatonic staff position relative to middle C (C4 = 0), +1 per natural
// letter step (C→D→E→F→G→A→B), +7 per octave — so a line and the very next
// space differ by 1, and two adjacent lines (or two adjacent spaces) differ
// by 2. This is the "written pitch" ui/organelle.ts's spec describes:
// unaffected by the octave-shift buttons, which only offset it at render
// (and eventually playback) time — see effectiveOctaveSteps.
export type Accidental = 'sharp' | 'flat' | null;

export interface MelodyNoteItem {
  kind: 'note';
  step: number; // written diatonic step, octave-shift NOT applied
  accidental: Accidental;
  durationIndex: number; // -1=breve, 0=semibreve .. 5=demisemiquaver, see DEFAULT_DURATION_INDEX
}

export interface MelodyRestItem {
  kind: 'rest';
  durationIndex: number;
}

export interface MelodyBarlineItem {
  kind: 'barline';
}

export type MelodyItem = MelodyNoteItem | MelodyRestItem | MelodyBarlineItem;

export interface MelodyState {
  items: MelodyItem[];
  octaveUp: number; // 0-2, from the +8ve button (see cycleOctaveUp)
  octaveDown: number; // 0-2 (a magnitude, not a signed value), from the -8ve button
  scrollIndex: number; // how many leading items are scrolled out of view — see VISIBLE_SLOTS
}

// Keyed by the melody feature entity's own id — parallel to how
// ui/textures.ts/ui/sampleDrop.ts keep their own side-registries for
// UI/editor state that doesn't fit Entity.params' plain Record<string,
// number> shape (a note sequence is a list of small objects, not a scalar).
const melodies = new Map<string, MelodyState>();

export function melodyStateFor(entityId: string): MelodyState {
  let state = melodies.get(entityId);
  if (!state) {
    state = { items: [], octaveUp: 0, octaveDown: 0, scrollIndex: 0 };
    melodies.set(entityId, state);
  }
  return state;
}

// Keeps scrollIndex sane after any change to item count — clamped rather
// than reset, so a mutation elsewhere in the visible window doesn't yank
// the view back to the start.
function clampScroll(state: MelodyState): void {
  const maxScroll = Math.max(0, state.items.length - VISIBLE_SLOTS);
  state.scrollIndex = Math.min(maxScroll, Math.max(0, state.scrollIndex));
}

// Each button independently cycles off → 1 octave → 2 octaves → off; the
// two are summed (up minus down) rather than mutually exclusive, so if a
// player somehow leaves both active they simply cancel out rather than one
// silently overriding the other.
export function cycleOctaveUp(state: MelodyState): void {
  state.octaveUp = (state.octaveUp + 1) % 3;
}

export function cycleOctaveDown(state: MelodyState): void {
  state.octaveDown = (state.octaveDown + 1) % 3;
}

export function effectiveOctaveSteps(state: MelodyState): number {
  return (state.octaveUp - state.octaveDown) * 7;
}

// --- Duration model --------------------------------------------------------

// A fixed halving/doubling chain rather than named note values throughout —
// index 2 (crotchet) is where a freshly-added note/rest starts; clicking
// halves (index+1, capped at demisemiquaver) and right-clicking doubles
// (index-1, capped at breve). Kept as a plain index rather than a fraction
// so the render code's flag-count math (index - 2) stays exact, with no
// floating-point duration comparisons anywhere. Negative indices are valid
// here (breve = -1, twice a semibreve's length) — durationInWholeNotes
// below already handles that correctly (2 ** 1 = 2), and the drawing code
// (drawNoteGlyph/drawRestGlyph) special-cases -1 for its own glyph.
export const MIN_DURATION_INDEX = -1; // breve (double whole note)
export const MAX_DURATION_INDEX = 5; // demisemiquaver (1/32)
export const DEFAULT_DURATION_INDEX = 2; // crotchet (1/4) — both a fresh note's and a fresh rest's starting value

export function cycleDurationDown(item: MelodyItem): void {
  if (item.kind === 'barline') return; // no duration to cycle
  item.durationIndex = Math.min(MAX_DURATION_INDEX, item.durationIndex + 1);
}

export function cycleDurationUp(item: MelodyItem): void {
  if (item.kind === 'barline') return;
  item.durationIndex = Math.max(MIN_DURATION_INDEX, item.durationIndex - 1);
}

// Fraction of a semibreve — not read anywhere yet, but this is the natural
// hook point for the future sequencer/transport work (TODO.md) to convert a
// durationIndex into actual playback time.
export function durationInWholeNotes(durationIndex: number): number {
  return 1 / 2 ** durationIndex;
}

// --- Sequence editing ------------------------------------------------------

const DEFAULT_ITEM_SPACING = 20; // px between adjacent item slots — about 60% of the original 34px
const FIRST_ITEM_OFFSET = 14; // px from staffLeft to item index 0's slot — clear of the clef
// "About two bars" (TODO.md) — an approximate common-time sizing (two bars
// of four beats each), not tied to any actual bar-length enforcement (bars
// are just barline items the player inserts manually). Tune by eye.
const VISIBLE_SLOTS = 8;

// `index`/`step` are already resolved against the layout in effect at click
// time (see hitTestMelodyPopup's 'addNote' hit).
export function addNoteAt(state: MelodyState, index: number, step: number): void {
  state.items.splice(index, 0, { kind: 'note', step, accidental: null, durationIndex: DEFAULT_DURATION_INDEX });
  clampScroll(state);
}

// Scrolls to reveal the newly-appended item — "after the last note" (TODO.md)
// would otherwise land off the right edge of the visible window as soon as
// there are already more than VISIBLE_SLOTS items, silently doing nothing
// the player could see.
function scrollToEnd(state: MelodyState): void {
  state.scrollIndex = Math.max(0, state.items.length - VISIBLE_SLOTS);
}

export function insertRestAfterLast(state: MelodyState): void {
  state.items.push({ kind: 'rest', durationIndex: DEFAULT_DURATION_INDEX });
  scrollToEnd(state);
}

export function insertBarlineAfterLast(state: MelodyState): void {
  state.items.push({ kind: 'barline' });
  scrollToEnd(state);
}

// --- Dragging ---------------------------------------------------------

const STEP_PX = 4; // vertical px per diatonic step (half a line/space gap) — 80% of the original 5px
const STAFF_SPACE_PX = STEP_PX * 2; // SMuFL's own unit (ui/bravuraGlyphs.ts) — the gap between two adjacent staff lines
// SMuFL's own sizing convention: a font size of 4x the staff space produces
// glyphs at the font's intended scale (github.com/w3c/smufl's own
// recommendation, followed by every standard SMuFL renderer).
const BRAVURA_FONT_SIZE_PX = STAFF_SPACE_PX * 4;

function sp(staffSpaces: number): number {
  return staffSpaces * STAFF_SPACE_PX;
}

// Nearest half-step count and any leftover accidental for a vertical drag
// distance, in px (positive = up). A drag landing close to a full step
// moves the note there outright (natural — any existing accidental is
// cleared, since it's now a different line/space). A drag landing close to
// a HALF step leaves the note on its current line/space and instead nudges
// it up or down by a semitone via a sharp/flat, matching how an accidental
// actually behaves in real notation (it alters the pitch without moving the
// notehead to a different line) — but ONLY where that accidental actually
// means something in the current key (ui/musicTheory.ts): a half-drag that
// would sharp a note a natural semitone below its neighbor (E, B in a major
// scale — E# is enharmonically just F), or flat one a natural semitone
// above its neighbor (F, C — Fb is just E), instead resolves straight to
// that neighbor with no accidental at all, exactly as a full-step drag
// would. Without this, both a sharp AND a flat would appear "offered" on
// notes where one of them is really just a respelling of the note right
// next door — never a sensible choice. Zero net vertical movement (e.g. a
// purely horizontal reposition drag) leaves `startAccidental` untouched
// rather than resolving to "natural" — without this, dragging a sharped/
// flatted note sideways to retime it would silently wipe the accidental
// every time, since deltaY===0 would otherwise fall through the same
// "no leftover half-step" path a genuine natural does.
function quantizeVerticalDrag(
  deltaY: number,
  startAccidental: Accidental,
  startStep: number
): { stepDelta: number; accidental: Accidental } {
  const halfSteps = Math.round((-deltaY / STEP_PX) * 2);
  if (halfSteps === 0) return { stepDelta: 0, accidental: startAccidental };
  const stepDelta = Math.trunc(halfSteps / 2);
  const remainder = halfSteps - stepDelta * 2;
  if (remainder === 0) return { stepDelta, accidental: null };

  const candidateStep = startStep + stepDelta;
  if (halfSteps > 0) {
    if (sharpMakesSense(candidateStep)) return { stepDelta, accidental: 'sharp' };
    return { stepDelta: stepDelta + 1, accidental: null }; // collapses onto the adjacent natural instead
  }
  if (flatMakesSense(candidateStep)) return { stepDelta, accidental: 'flat' };
  return { stepDelta: stepDelta - 1, accidental: null };
}

export function updateNotePitchDrag(
  item: MelodyNoteItem,
  startStep: number,
  startAccidental: Accidental,
  deltaY: number
): void {
  const { stepDelta, accidental } = quantizeVerticalDrag(deltaY, startAccidental, startStep);
  item.step = startStep + stepDelta;
  item.accidental = accidental;
}

// --- Staff geometry ---------------------------------------------------------

// Grand-staff line steps (bottom to top), using the diatonic-step
// convention above: treble E4,G4,B4,D5,F5 = 2,4,6,8,10; bass G2,B2,D3,F3,A3
// = -10,-8,-6,-4,-2. Middle C (step 0) sits exactly one ledger line below
// the treble staff and one above the bass staff, the standard grand-staff
// convention — which is also why a single linear step→y mapping (stepToY)
// works across the whole grand staff with no separate treble/bass branches.
const TREBLE_LINE_STEPS = [2, 4, 6, 8, 10];
const BASS_LINE_STEPS = [-10, -8, -6, -4, -2];
const TREBLE_TOP_STEP = 10;
const TREBLE_BOTTOM_STEP = 2;
const BASS_TOP_STEP = -2;
const BASS_BOTTOM_STEP = -10;

// "Room for two ledger lines above and below" (TODO.md) — the editable/
// drawable step range extends this many extra lines past each staff's own
// outer line. Ledger steps are 2 apart (a line skips the space next to it),
// matching TREBLE_LINE_STEPS/BASS_LINE_STEPS's own spacing.
const LEDGER_STEPS_BEYOND_STAFF = 2;
const TOP_STEP = TREBLE_TOP_STEP + LEDGER_STEPS_BEYOND_STAFF * 2; // 14
const BOTTOM_STEP = BASS_BOTTOM_STEP - LEDGER_STEPS_BEYOND_STAFF * 2; // -14
const STAFF_PIXEL_HEIGHT = (TOP_STEP - BOTTOM_STEP) * STEP_PX; // 140

const CLEF_COLUMN_WIDTH = 34;
const ICON_COLUMN_WIDTH = 34;
const OCTAVE_BUTTON_SIZE = 16;

// The window's top/bottom edge sits this far past the OUTER of the two
// ledger lines beyond the stave (TOP_STEP/BOTTOM_STEP) — approximating a
// notehead's own height (drawNoteGlyph's rx/ry ellipse, ~6-7px tall once
// its slight rotation is accounted for), so a note sitting right on that
// outer ledger line still clears the edge with a little room, and no more.
// The +8ve/-8ve buttons no longer fit within this much thinner clearance —
// they're centered directly ON the outer ledger line instead (see
// computeLayout), overlapping both the ledger-line drawing and the window
// edge itself, same "allowed to extend past the window bound" treatment a
// note's own stem gets (see drawMelodyPopup's own comment on that).
const NOTE_HEAD_HEIGHT = 7;

// Only added to the popup's height when there are more items than fit —
// see needsScrollbar/melodyPopupHeight below and hitTestMelodyPopup's/
// drawMelodyPopup's scrollbar handling.
const SCROLLBAR_ROW_HEIGHT = 12;
const SCROLLBAR_TRACK_HEIGHT = 4;
const SCROLLBAR_MIN_THUMB_WIDTH = 18;

// Wide enough for VISIBLE_SLOTS item slots plus a little breathing room on
// either side — "about two bars" (TODO.md), not the generous fixed width
// the first version used.
const STAFF_VISIBLE_WIDTH = FIRST_ITEM_OFFSET * 2 + (VISIBLE_SLOTS - 1) * DEFAULT_ITEM_SPACING;
export const MELODY_POPUP_WIDTH = CLEF_COLUMN_WIDTH + STAFF_VISIBLE_WIDTH + ICON_COLUMN_WIDTH;

function needsScrollbar(itemCount: number): boolean {
  return itemCount > VISIBLE_SLOTS;
}

function melodyPopupHeight(itemCount: number): number {
  const base = TITLE_HEIGHT + NOTE_HEAD_HEIGHT + STAFF_PIXEL_HEIGHT + NOTE_HEAD_HEIGHT;
  return needsScrollbar(itemCount) ? base + SCROLLBAR_ROW_HEIGHT : base;
}

function clampStep(step: number): number {
  return Math.min(TOP_STEP, Math.max(BOTTOM_STEP, step));
}

function stepToY(middleCY: number, step: number): number {
  return middleCY - step * STEP_PX;
}

function yToStep(middleCY: number, y: number): number {
  return Math.round((middleCY - y) / STEP_PX);
}

export interface MelodyLayout {
  popup: Rect;
  left: number;
  top: number;
  staffLeft: number;
  staffRight: number;
  staffTop: number;
  staffBottom: number;
  middleCY: number;
  octaveUpButton: Rect;
  octaveDownButton: Rect;
  restIcon: Point;
  barlineIcon: Point;
  closeButton: Point;
  // Center-based, spanning the staff's own width — null when there aren't
  // enough items to need scrolling (see needsScrollbar), in which case the
  // popup is sized without the extra SCROLLBAR_ROW_HEIGHT at all.
  scrollTrack: Rect | null;
}

function computeLayout(graph: EntityGraph, owner: Entity, itemCount: number, drag?: DragContext): MelodyLayout {
  const popup = popupRectFor(graph, owner, MELODY_POPUP_WIDTH, melodyPopupHeight(itemCount), drag);
  const left = popup.x - popup.width / 2;
  const top = popup.y - popup.height / 2;

  const staffLeft = left + CLEF_COLUMN_WIDTH;
  const staffRight = left + popup.width - ICON_COLUMN_WIDTH;
  const staffTop = top + TITLE_HEIGHT + NOTE_HEAD_HEIGHT;
  const staffBottom = staffTop + STAFF_PIXEL_HEIGHT;
  const middleCY = (staffTop + staffBottom) / 2; // step 0 is exactly centered — see TOP_STEP/BOTTOM_STEP's symmetry

  const clefCenterX = left + CLEF_COLUMN_WIDTH / 2;
  const iconX = left + popup.width - ICON_COLUMN_WIDTH / 2;

  return {
    popup,
    left,
    top,
    staffLeft,
    staffRight,
    staffTop,
    staffBottom,
    middleCY,
    // Centered directly on the outer ledger line (staffTop/staffBottom
    // themselves) rather than in a separate reserved band above/below it —
    // see NOTE_HEAD_HEIGHT's own comment for why there's no longer room for
    // a dedicated band once the window is this tight.
    octaveUpButton: { x: clefCenterX, y: staffTop, width: OCTAVE_BUTTON_SIZE, height: OCTAVE_BUTTON_SIZE },
    octaveDownButton: { x: clefCenterX, y: staffBottom, width: OCTAVE_BUTTON_SIZE, height: OCTAVE_BUTTON_SIZE },
    // Moved down clear of the close/+8ve cluster now sitting right at
    // staffTop (see closeButton below) — same relative 26px gap between the
    // two as before.
    restIcon: { x: iconX, y: staffTop + 32 },
    barlineIcon: { x: iconX, y: staffTop + 58 },
    // Top-aligned with the +8ve button (octaveUpButton) rather than
    // organelle.ts's own shared title-row placement — melody has no title
    // text needing that row (see drawMelodyPopup), so the close control
    // moves down to sit with the rest of the top cluster instead.
    closeButton: { x: popup.x + popup.width / 2 - 14, y: staffTop - OCTAVE_BUTTON_SIZE / 2 + CLOSE_BUTTON_RADIUS },
    scrollTrack: needsScrollbar(itemCount)
      ? {
          x: (staffLeft + staffRight) / 2,
          y: staffBottom + NOTE_HEAD_HEIGHT + SCROLLBAR_ROW_HEIGHT / 2,
          width: staffRight - staffLeft,
          height: SCROLLBAR_ROW_HEIGHT,
        }
      : null,
  };
}

// `visibleIndex` is the item's slot position within the currently-scrolled
// window (0 = leftmost visible slot) — callers convert a true array index
// to this by subtracting state.scrollIndex, and skip drawing/hit-testing
// anything that falls outside [0, VISIBLE_SLOTS).
function itemSlotX(layout: MelodyLayout, visibleIndex: number): number {
  return layout.staffLeft + FIRST_ITEM_OFFSET + visibleIndex * DEFAULT_ITEM_SPACING;
}

// For a note; barlines are drawn as a full-height line (see
// drawMelodyPopup) rather than needing a single point at all. Rests are
// handled separately (see restScreenPositions below) — a rest has no pitch
// of its own to hang one point off, unlike a note.
function itemScreenPosition(layout: MelodyLayout, visibleIndex: number, item: MelodyItem, effectiveShift: number): Point {
  const x = itemSlotX(layout, visibleIndex);
  if (item.kind === 'note') return { x, y: stepToY(layout.middleCY, item.step + effectiveShift) };
  return { x, y: layout.middleCY };
}

// A rest applies to the whole texture, not one staff — drawn as TWO glyphs,
// one centered on each staff's own middle line (TREBLE_MIDDLE_LINE_STEP/
// BASS_MIDDLE_LINE_STEP), both for the SAME MelodyRestItem: same x (one
// horizontal slot in the sequence — dragging, duration-cycling, and
// clicking either half all act on that one item, see hitTestMelodyPopup and
// drawMelodyPopup), always moving and changing together since there's only
// ever one underlying item to change.
function restScreenPositions(layout: MelodyLayout, visibleIndex: number): [Point, Point] {
  const x = itemSlotX(layout, visibleIndex);
  return [
    { x, y: stepToY(layout.middleCY, TREBLE_MIDDLE_LINE_STEP) },
    { x, y: stepToY(layout.middleCY, BASS_MIDDLE_LINE_STEP) },
  ];
}

// Which TRUE array index `pointerX` currently sits nearest to, among
// `itemCount` items — shared by the blank-staff "insert here" click
// (hitTestMelodyPopup) and the live reorder-while-dragging math below, so
// both agree on exactly where a given x lands. `scrollIndex` converts the
// pointer's visible-slot position back to a true index, same as
// itemScreenPosition's own conversion in reverse.
function indexFromX(layout: MelodyLayout, pointerX: number, itemCount: number, scrollIndex: number): number {
  const visibleSlot = Math.round((pointerX - layout.staffLeft - FIRST_ITEM_OFFSET) / DEFAULT_ITEM_SPACING);
  return Math.min(itemCount, Math.max(0, visibleSlot + scrollIndex));
}

// Called on every pointermove of a horizontal-axis item drag
// (ui/interaction.ts's melodyPress) — moves `item` to whatever slot the
// pointer is over right now, among the OTHER items' own slots (removing
// `item` from consideration first, so it doesn't block its own gap from
// closing beneath it). This is what makes neighbors shift live to make room
// as the dragged item passes over them, and what makes the gap it left
// behind close immediately rather than needing a separate step on drop —
// there's nothing left to "clean up" on release, the array is already in
// its final order.
export function reorderDuringDrag(graph: EntityGraph, entityId: string, item: MelodyItem, pointerX: number, drag?: DragContext): void {
  const feature = graph.get(entityId);
  const owner = feature && ownerOf(graph, feature);
  if (!feature || !owner) return;

  const state = melodyStateFor(entityId);
  if (!state.items.includes(item)) return;
  const layout = computeLayout(graph, owner, state.items.length, drag);

  const others = state.items.filter((i) => i !== item);
  const targetIndex = indexFromX(layout, pointerX, others.length, state.scrollIndex);
  others.splice(targetIndex, 0, item);
  state.items = others;
}

// --- Scrolling ---------------------------------------------------------

// Proportional to how much of the sequence is visible at once
// (VISIBLE_SLOTS / itemCount) — never narrower than SCROLLBAR_MIN_THUMB_WIDTH,
// so the thumb stays grabbable even when there are many items.
function thumbWidthFor(trackWidth: number, itemCount: number): number {
  const proportion = Math.min(1, VISIBLE_SLOTS / itemCount);
  return Math.max(SCROLLBAR_MIN_THUMB_WIDTH, trackWidth * proportion);
}

function thumbXFor(track: Rect, itemCount: number, scrollIndex: number): number {
  const trackLeft = track.x - track.width / 2;
  const maxScroll = Math.max(0, itemCount - VISIBLE_SLOTS);
  if (maxScroll === 0) return trackLeft;
  const thumbWidth = thumbWidthFor(track.width, itemCount);
  return trackLeft + (track.width - thumbWidth) * (scrollIndex / maxScroll);
}

// Sets scrollIndex from wherever `pointerX` currently is along the track —
// called both when a scrollbar drag starts (an immediate jump to the click
// position) and on every subsequent pointermove while it continues, so
// dragging the track directly maps pointer position to scroll position
// rather than needing separate "grab the thumb at this offset" bookkeeping.
// A deliberate simplification over a real OS scrollbar's relative-drag feel,
// adequate for an occasional "see more of the sequence" control.
export function updateScrollFromTrackX(graph: EntityGraph, entityId: string, pointerX: number, drag?: DragContext): void {
  const feature = graph.get(entityId);
  const owner = feature && ownerOf(graph, feature);
  if (!feature || !owner) return;

  const state = melodyStateFor(entityId);
  const layout = computeLayout(graph, owner, state.items.length, drag);
  const track = layout.scrollTrack;
  if (!track) return;

  const maxScroll = Math.max(0, state.items.length - VISIBLE_SLOTS);
  if (maxScroll === 0) return;
  const thumbWidth = thumbWidthFor(track.width, state.items.length);
  const trackLeft = track.x - track.width / 2;
  const usable = track.width - thumbWidth;
  const t = usable > 0 ? (pointerX - trackLeft - thumbWidth / 2) / usable : 0;
  state.scrollIndex = Math.round(Math.min(1, Math.max(0, t)) * maxScroll);
}

// The ledger-line step positions (each a "line," 2 steps apart) needed to
// visually connect `step` back to whichever staff it's closest to — the
// standard notation rule of "draw every ledger line between the staff and
// the note, including one through the note itself if it lands on a line."
// A note in the gap between the two staves (middle C being the common case)
// picks whichever staff edge is nearer, so this still gives a sensible
// answer if the octave-shift buttons move a note further into that gap.
function ledgerStepsNeeded(step: number): number[] {
  const steps: number[] = [];
  if (step > TREBLE_TOP_STEP) {
    for (let s = TREBLE_TOP_STEP + 2; s <= step; s += 2) steps.push(s);
  } else if (step < BASS_BOTTOM_STEP) {
    for (let s = BASS_BOTTOM_STEP - 2; s >= step; s -= 2) steps.push(s);
  } else if (step > BASS_TOP_STEP && step < TREBLE_BOTTOM_STEP) {
    if (Math.abs(step - BASS_TOP_STEP) <= Math.abs(TREBLE_BOTTOM_STEP - step)) {
      for (let s = BASS_TOP_STEP + 2; s <= step; s += 2) steps.push(s);
    } else {
      for (let s = TREBLE_BOTTOM_STEP - 2; s >= step; s -= 2) steps.push(s);
    }
  }
  return steps;
}

// Each staff's own middle line — B4 for treble, D3 for bass. Used both as
// the flip point for the standard "stem points away from the middle" rule
// (stemUpFor) and as where each half of a rest's two-glyph pair sits (see
// restScreenPositions above): a rest belongs to no one staff, so it's drawn
// centered on both.
const TREBLE_MIDDLE_LINE_STEP = 6;
const BASS_MIDDLE_LINE_STEP = -6;

// Picked by whichever staff's middle line `step` is closer to, so notes in
// the gap between the staves still get a sensible, non-flickery answer.
function stemUpFor(step: number): boolean {
  const useTreble = Math.abs(step - TREBLE_MIDDLE_LINE_STEP) <= Math.abs(step - BASS_MIDDLE_LINE_STEP);
  return step < (useTreble ? TREBLE_MIDDLE_LINE_STEP : BASS_MIDDLE_LINE_STEP);
}

// --- Hit-testing ---------------------------------------------------------

export type MelodyHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'octaveUp' }
  | { entityId: string; kind: 'octaveDown' }
  | { entityId: string; kind: 'restIcon' }
  | { entityId: string; kind: 'barlineIcon' }
  | { entityId: string; kind: 'item'; item: MelodyItem }
  | { entityId: string; kind: 'addNote'; index: number; step: number }
  | { entityId: string; kind: 'scrollTrack' }
  | { entityId: string; kind: 'background' };

const ITEM_HIT_RADIUS = 9;
const ICON_HIT_RADIUS = 10;
const OCTAVE_BUTTON_HIT_PAD = 4;
const SCROLLBAR_HIT_PAD = 5; // generous — the track itself is only SCROLLBAR_TRACK_HEIGHT tall

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function withinButton(rect: Rect, point: Point, pad: number): boolean {
  return (
    point.x >= rect.x - rect.width / 2 - pad &&
    point.x <= rect.x + rect.width / 2 + pad &&
    point.y >= rect.y - rect.height / 2 - pad &&
    point.y <= rect.y + rect.height / 2 + pad
  );
}

export function hitTestMelodyPopup(graph: EntityGraph, point: Point, drag?: DragContext): MelodyHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'melody' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;

    const state = melodyStateFor(entity.id);
    const layout = computeLayout(graph, owner, state.items.length, drag);

    if (dist(point, layout.closeButton) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }
    if (withinButton(layout.octaveUpButton, point, OCTAVE_BUTTON_HIT_PAD)) return { entityId: entity.id, kind: 'octaveUp' };
    if (withinButton(layout.octaveDownButton, point, OCTAVE_BUTTON_HIT_PAD)) return { entityId: entity.id, kind: 'octaveDown' };
    if (dist(point, layout.restIcon) <= ICON_HIT_RADIUS) return { entityId: entity.id, kind: 'restIcon' };
    if (dist(point, layout.barlineIcon) <= ICON_HIT_RADIUS) return { entityId: entity.id, kind: 'barlineIcon' };
    if (layout.scrollTrack && withinButton(layout.scrollTrack, point, SCROLLBAR_HIT_PAD)) {
      return { entityId: entity.id, kind: 'scrollTrack' };
    }

    const shift = effectiveOctaveSteps(state);
    for (let i = 0; i < state.items.length; i++) {
      const visibleIndex = i - state.scrollIndex;
      if (visibleIndex < 0 || visibleIndex >= VISIBLE_SLOTS) continue; // scrolled out of view
      const item = state.items[i];
      if (item.kind === 'rest') {
        const [treblePos, bassPos] = restScreenPositions(layout, visibleIndex);
        if (dist(point, treblePos) <= ITEM_HIT_RADIUS || dist(point, bassPos) <= ITEM_HIT_RADIUS) {
          return { entityId: entity.id, kind: 'item', item };
        }
        continue;
      }
      const pos = itemScreenPosition(layout, visibleIndex, item, shift);
      if (dist(point, pos) <= ITEM_HIT_RADIUS) return { entityId: entity.id, kind: 'item', item };
    }

    if (
      point.x >= layout.staffLeft &&
      point.x <= layout.staffRight &&
      point.y >= layout.staffTop &&
      point.y <= layout.staffBottom
    ) {
      const clickedStep = clampStep(yToStep(layout.middleCY, point.y));
      const index = indexFromX(layout, point.x, state.items.length, state.scrollIndex);
      return { entityId: entity.id, kind: 'addNote', index, step: clickedStep - shift };
    }

    if (
      point.x >= layout.left &&
      point.x <= layout.left + layout.popup.width &&
      point.y >= layout.top &&
      point.y <= layout.top + layout.popup.height
    ) {
      return { entityId: entity.id, kind: 'background' };
    }
  }
  return null;
}

// --- Drawing ---------------------------------------------------------------

const PANEL_BG = 'rgba(22, 22, 22, 0.97)'; // matches ui/organelle.ts's envelope popup panel
const STAFF_COLOR = 'rgba(255, 255, 255, 0.55)';
const NOTE_COLOR = 'rgba(232, 220, 192, 0.95)'; // matches organelle.ts's CURVE_COLOR family

function setBravuraFont(ctx: CanvasRenderingContext2D): void {
  ctx.font = `${BRAVURA_FONT_SIZE_PX}px ${BRAVURA_FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// durationIndex -> notehead glyph/width, and separately -> rest glyph/width
// (ui/bravuraGlyphs.ts) — every one of these is designed with its origin at
// the LEFT edge, vertically centered (bounding box symmetric about y=0), so
// drawing at (desiredCenterX - widthPx / 2, desiredCenterY) lands it right
// on whatever center point this module already computes (pos.x/pos.y),
// with no separate per-glyph vertical offset to work out.
function noteheadGlyphFor(durationIndex: number): { glyph: string; widthSp: number } {
  if (durationIndex <= -1) return { glyph: GLYPH.noteheadDoubleWhole, widthSp: NOTEHEAD_WIDTH_SP.noteheadDoubleWhole };
  if (durationIndex === 0) return { glyph: GLYPH.noteheadWhole, widthSp: NOTEHEAD_WIDTH_SP.noteheadWhole };
  if (durationIndex === 1) return { glyph: GLYPH.noteheadHalf, widthSp: NOTEHEAD_WIDTH_SP.noteheadHalf };
  return { glyph: GLYPH.noteheadBlack, widthSp: NOTEHEAD_WIDTH_SP.noteheadBlack };
}

function noteheadWidthPxFor(durationIndex: number): number {
  return sp(noteheadGlyphFor(durationIndex).widthSp);
}

const REST_GLYPH_BY_DURATION: Record<number, { glyph: string; widthSp: number }> = {
  [-1]: { glyph: GLYPH.restDoubleWhole, widthSp: REST_WIDTH_SP.restDoubleWhole },
  0: { glyph: GLYPH.restWhole, widthSp: REST_WIDTH_SP.restWhole },
  1: { glyph: GLYPH.restHalf, widthSp: REST_WIDTH_SP.restHalf },
  2: { glyph: GLYPH.restQuarter, widthSp: REST_WIDTH_SP.restQuarter },
  3: { glyph: GLYPH.rest8th, widthSp: REST_WIDTH_SP.rest8th },
  4: { glyph: GLYPH.rest16th, widthSp: REST_WIDTH_SP.rest16th },
  5: { glyph: GLYPH.rest32nd, widthSp: REST_WIDTH_SP.rest32nd },
};

// Real engraving hangs/sits each rest duration slightly differently
// relative to a specific staff line; this always anchors on the staff's own
// middle line instead (matching restScreenPositions' own placement) — a
// simplification of textbook placement, not a misdrawn glyph.
function drawRestGlyph(ctx: CanvasRenderingContext2D, center: Point, durationIndex: number, color: string): void {
  const entry = REST_GLYPH_BY_DURATION[durationIndex] ?? REST_GLYPH_BY_DURATION[2];
  ctx.save();
  setBravuraFont(ctx);
  ctx.fillStyle = color;
  ctx.fillText(entry.glyph, center.x - sp(entry.widthSp) / 2, center.y);
  ctx.restore();
}

// `noteheadLeftX` is the notehead glyph's own left edge (from drawNoteGlyph
// below) — the accidental sits immediately to the left of THAT, not of the
// note's center point, so it doesn't creep into the notehead itself for the
// wider whole/breve noteheads.
function drawAccidental(
  ctx: CanvasRenderingContext2D,
  noteheadLeftX: number,
  centerY: number,
  accidental: Accidental,
  color: string
): void {
  if (!accidental) return;
  const widthSp = accidental === 'sharp' ? ACCIDENTAL_WIDTH_SP.sharp : ACCIDENTAL_WIDTH_SP.flat;
  const glyph = accidental === 'sharp' ? GLYPH.accidentalSharp : GLYPH.accidentalFlat;
  const gapSp = 0.25;
  ctx.save();
  setBravuraFont(ctx);
  ctx.fillStyle = color;
  ctx.fillText(glyph, noteheadLeftX - sp(gapSp) - sp(widthSp), centerY);
  ctx.restore();
}

function flagGlyphFor(durationIndex: number, stemUp: boolean): string | null {
  if (durationIndex === 3) return stemUp ? GLYPH.flag8thUp : GLYPH.flag8thDown;
  if (durationIndex === 4) return stemUp ? GLYPH.flag16thUp : GLYPH.flag16thDown;
  if (durationIndex === 5) return stemUp ? GLYPH.flag32ndUp : GLYPH.flag32ndDown;
  return null;
}

// Returns the notehead glyph's own left edge — drawAccidental and the
// ledger-line drawing in drawMelodyPopup both need it (ledger lines extend
// LEGER_LINE_EXTENSION_SP past this, not past the note's center).
function drawNoteGlyph(ctx: CanvasRenderingContext2D, center: Point, durationIndex: number, stemUp: boolean, color: string): number {
  const { glyph, widthSp } = noteheadGlyphFor(durationIndex);
  const leftX = center.x - sp(widthSp) / 2;

  ctx.save();
  setBravuraFont(ctx);
  ctx.fillStyle = color;
  ctx.fillText(glyph, leftX, center.y);
  ctx.restore();

  if (durationIndex >= 1) {
    // Stem-attachment anchors are relative to the notehead's own origin
    // (leftX, center.y) — SMuFL's Y is up-positive, canvas's is
    // down-positive, hence the subtraction rather than addition.
    const anchor = stemUp ? STEM_UP_SE : STEM_DOWN_NW;
    const stemX = leftX + sp(anchor[0]);
    const stemAttachY = center.y - sp(anchor[1]);
    const stemLengthSp = 3.5;
    const stemTipY = stemUp ? stemAttachY - sp(stemLengthSp) : stemAttachY + sp(stemLengthSp);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = sp(STEM_THICKNESS_SP);
    ctx.beginPath();
    ctx.moveTo(stemX, stemAttachY);
    ctx.lineTo(stemX, stemTipY);
    ctx.stroke();
    ctx.restore();

    const flagGlyph = flagGlyphFor(durationIndex, stemUp);
    if (flagGlyph) {
      ctx.save();
      setBravuraFont(ctx);
      ctx.fillStyle = color;
      ctx.fillText(flagGlyph, stemX, stemTipY);
      ctx.restore();
    }
  }

  return leftX;
}

// gClef's origin sits on the G4 line (TREBLE_LINE_STEPS' 2nd-from-bottom,
// step 4); fClef's sits on the F3 line (BASS_LINE_STEPS' 2nd-from-top, step
// -4) — both per SMuFL convention, matching the exact lines this module
// already uses elsewhere (stepToY(layout.middleCY, 4)/(-4)). `columnLeft`/
// `columnWidth` describe the clef column so the glyph (whose own origin,
// unlike a notehead's, is at its LEFT edge but not vertically centered —
// clefs use the specific-line convention above instead) can be horizontally
// centered within it.
function drawTrebleClef(ctx: CanvasRenderingContext2D, columnLeft: number, columnWidth: number, layout: MelodyLayout, color: string): void {
  const x = columnLeft + (columnWidth - sp(CLEF_WIDTH_SP.gClef)) / 2;
  ctx.save();
  setBravuraFont(ctx);
  ctx.fillStyle = color;
  ctx.fillText(GLYPH.gClef, x, stepToY(layout.middleCY, 4));
  ctx.restore();
}

function drawBassClef(ctx: CanvasRenderingContext2D, columnLeft: number, columnWidth: number, layout: MelodyLayout, color: string): void {
  const x = columnLeft + (columnWidth - sp(CLEF_WIDTH_SP.fClef)) / 2;
  ctx.save();
  setBravuraFont(ctx);
  ctx.fillStyle = color;
  ctx.fillText(GLYPH.fClef, x, stepToY(layout.middleCY, -4));
  ctx.restore();
}

function drawOctaveButton(ctx: CanvasRenderingContext2D, rect: Rect, magnitude: number, direction: 'up' | 'down'): void {
  const active = magnitude > 0;
  const color = active ? ACCENT : 'rgba(255, 255, 255, 0.3)';
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(rect.x - rect.width / 2, rect.y - rect.height / 2, rect.width, rect.height);
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = magnitude === 2 ? '15' : '8';
  ctx.fillText(direction === 'up' ? `+${label}` : `-${label}`, rect.x, rect.y + 0.5);
  ctx.restore();
}

// Lets ui/interaction.ts's live horizontal item drag (melodyPress) override
// where the dragged item itself renders — the raw, unsnapped pointer x —
// while every OTHER item still renders at its normal slot-index position
// (already reflowing live around the drag, see reorderDuringDrag). Without
// this the dragged item would only visually move in whole-slot jumps at
// each reorder, rather than tracking the cursor continuously the way a
// direct-manipulation drag should. Not used for a vertical (pitch) drag —
// there the item's x doesn't change at all, and its y is already the live,
// continuously-updating snapped step position (see updateNotePitchDrag).
export interface MelodyDragOverride {
  item: MelodyItem;
  x: number;
}

export function drawMelodyPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  dragOverride?: MelodyDragOverride | null,
  drag?: DragContext
): void {
  const state = melodyStateFor(entity.id);
  const layout = computeLayout(graph, owner, state.items.length, drag);
  const { popup, left, top } = layout;

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

  // No title text here (unlike the envelope popup) — the grand staff itself
  // is unambiguous about what this organelle is, so the row's only content
  // is the close button below.
  const close = layout.closeButton;
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

  // Deliberately NOT clipped to the panel's own rectangle — a note's stem
  // (or, mid-drag, its whole notehead — see MelodyDragOverride) is allowed
  // to visibly extend past the window's top/bottom/side edges rather than
  // being cut off, now that the window itself is sized tightly around the
  // staff (just beyond the outer ledger lines) rather than with generous
  // slack to spare.
  ctx.strokeStyle = STAFF_COLOR;
  ctx.lineWidth = 1;
  for (const step of TREBLE_LINE_STEPS.concat(BASS_LINE_STEPS)) {
    const y = stepToY(layout.middleCY, step);
    ctx.beginPath();
    ctx.moveTo(layout.staffLeft, y);
    ctx.lineTo(layout.staffRight, y);
    ctx.stroke();
  }

  // Every glyph below (clefs, noteheads, rests, accidentals, flags) needs
  // the Bravura font actually loaded — see ui/bravuraFont.ts's own comment
  // on why this is a hard gate rather than just letting canvas fall back to
  // some other font: these are Private Use Area codepoints with no sane
  // fallback glyph anywhere else. Staff lines/barlines below don't depend
  // on it and always draw regardless.
  const bravuraReady = isBravuraReady();
  if (bravuraReady) {
    drawTrebleClef(ctx, layout.left, CLEF_COLUMN_WIDTH, layout, STAFF_COLOR);
    drawBassClef(ctx, layout.left, CLEF_COLUMN_WIDTH, layout, STAFF_COLOR);
  }

  const shift = effectiveOctaveSteps(state);

  for (let i = 0; i < state.items.length; i++) {
    const visibleIndex = i - state.scrollIndex;
    if (visibleIndex < 0 || visibleIndex >= VISIBLE_SLOTS) continue; // scrolled out of view
    const item = state.items[i];

    if (item.kind === 'rest') {
      if (!bravuraReady) continue;
      const [treblePos, bassPos] = restScreenPositions(layout, visibleIndex);
      if (dragOverride && dragOverride.item === item) {
        treblePos.x = dragOverride.x;
        bassPos.x = dragOverride.x;
      }
      // Same item, same duration, drawn twice — one glyph per staff (see
      // restScreenPositions' own comment) — so the two are always in sync
      // by construction, never two separately-tracked rests to keep aligned.
      drawRestGlyph(ctx, treblePos, item.durationIndex, NOTE_COLOR);
      drawRestGlyph(ctx, bassPos, item.durationIndex, NOTE_COLOR);
      continue;
    }

    const pos = itemScreenPosition(layout, visibleIndex, item, shift);
    if (dragOverride && dragOverride.item === item) pos.x = dragOverride.x;
    if (item.kind === 'barline') {
      // Spans only the actual 5-line staves (continuous through the gap
      // between them, as a grand-staff barline should be) — NOT
      // layout.staffTop/staffBottom, which also include the ledger-line
      // margin above/below (see TOP_STEP/BOTTOM_STEP) that a barline should
      // never poke into.
      ctx.strokeStyle = STAFF_COLOR;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(pos.x, stepToY(layout.middleCY, TREBLE_TOP_STEP));
      ctx.lineTo(pos.x, stepToY(layout.middleCY, BASS_BOTTOM_STEP));
      ctx.stroke();
    } else if (bravuraReady) {
      const renderedStep = item.step + shift;
      const ledgerHalfWidth = noteheadWidthPxFor(item.durationIndex) / 2 + sp(LEGER_LINE_EXTENSION_SP);
      ctx.strokeStyle = STAFF_COLOR;
      ctx.lineWidth = sp(LEGER_LINE_THICKNESS_SP);
      for (const ledgerStep of ledgerStepsNeeded(renderedStep)) {
        const ly = stepToY(layout.middleCY, ledgerStep);
        ctx.beginPath();
        ctx.moveTo(pos.x - ledgerHalfWidth, ly);
        ctx.lineTo(pos.x + ledgerHalfWidth, ly);
        ctx.stroke();
      }
      const noteheadLeftX = drawNoteGlyph(ctx, pos, item.durationIndex, stemUpFor(renderedStep), NOTE_COLOR);
      drawAccidental(ctx, noteheadLeftX, pos.y, item.accidental, NOTE_COLOR);
    }
  }

  drawOctaveButton(ctx, layout.octaveUpButton, state.octaveUp, 'up');
  drawOctaveButton(ctx, layout.octaveDownButton, state.octaveDown, 'down');

  if (layout.scrollTrack) {
    const track = layout.scrollTrack;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = SCROLLBAR_TRACK_HEIGHT;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(track.x - track.width / 2, track.y);
    ctx.lineTo(track.x + track.width / 2, track.y);
    ctx.stroke();

    const thumbWidth = thumbWidthFor(track.width, state.items.length);
    const thumbX = thumbXFor(track, state.items.length, state.scrollIndex);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.moveTo(thumbX, track.y);
    ctx.lineTo(thumbX + thumbWidth, track.y);
    ctx.stroke();
  }

  if (bravuraReady) drawRestGlyph(ctx, layout.restIcon, DEFAULT_DURATION_INDEX, 'rgba(255, 255, 255, 0.6)');
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(layout.barlineIcon.x, layout.barlineIcon.y - 9);
  ctx.lineTo(layout.barlineIcon.x, layout.barlineIcon.y + 9);
  ctx.stroke();

  ctx.restore();
}
