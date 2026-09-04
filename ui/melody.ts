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
import { ownerOf, popupRectFor, CLOSE_BUTTON_RADIUS } from './organelle';
import { ACCENT } from './palette';
import { flatMakesSense, nearestStepForLetter, semitoneFromStep, sharpMakesSense } from './musicTheory';
import { isBravuraReady } from './bravuraFont';
import {
  ACCIDENTAL_WIDTH_SP,
  AUGMENTATION_DOT_WIDTH_SP,
  BRAVURA_FONT_FAMILY,
  CLEF_WIDTH_SP,
  GLYPH,
  LEGER_LINE_EXTENSION_SP,
  LEGER_LINE_THICKNESS_SP,
  NOTEHEAD_WIDTH_SP,
  REST_QUARTER_HEIGHT_SP,
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
  dots: number; // 0-2 — see mergeAdjacentSamePitch; independent of durationIndex, carried through halving/doubling unchanged
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

// Notes AND rests are selectable (barlines aren't — there's nothing to
// nudge, delete-and-reselect-sensibly, or dim/undim about a barline the way
// there is for the other two).
export type MelodySelectable = MelodyNoteItem | MelodyRestItem;

function isSelectable(item: MelodyItem): item is MelodySelectable {
  return item.kind === 'note' || item.kind === 'rest';
}

export interface MelodySelectionHit {
  entityId: string;
  item: MelodySelectable;
}

// The single "current" note-or-rest the Up/Down/Left/Right/Delete keyboard
// shortcuts (ui/interaction.ts) operate on — one across the whole app, not
// one per organelle, since there's exactly one "currently selected" concept
// regardless of how many melody organelles happen to be open. Defaults to
// whichever note was most recently created or moved (see selectItem's call
// sites: addNoteAt, updateNotePitchDrag, the horizontal drag/merge paths,
// mergeIntoTarget — a rest only ever becomes selected via explicit
// navigation, Left/Right or Delete's own reselection, never "created or
// moved" the way a note can be) — never set any other way, so it's always
// either that, or null if nothing anywhere has been touched yet. Up/Down
// (nudgePitch) only make sense for a note; ui/interaction.ts guards that
// itself rather than this module refusing to hold a rest at all.
let selectedItem: MelodySelectionHit | null = null;

// Where the NEXT typed insertion (letter note, rest, or barline) goes —
// right after this. Distinct from selectedItem because a barline isn't
// itself selectable, but typing one should still move the insertion point
// past it, so a run like "C D | E" lands as C, D, barline, E — not C, D, E,
// barline with E inserted back before the barline just typed. Always kept
// in sync with selectedItem (selectItem sets both) and additionally
// advanced on its own by insertRestAfterCurrent/insertBarlineAfterCurrent
// when they place a barline, which doesn't touch selectedItem at all.
let insertionPoint: { entityId: string; item: MelodyItem } | null = null;

function selectItem(entityId: string, item: MelodySelectable): void {
  selectedItem = { entityId, item };
  insertionPoint = { entityId, item };
}

export function getSelectedItem(): MelodySelectionHit | null {
  return selectedItem;
}

// The item after which the next typed insertion should go, for `entityId`
// — insertionPoint if it's still valid and belongs to this organelle,
// otherwise `fallback` (always selectedItem's own item at every current
// call site, since insertionPoint can only ever be stale, never point at a
// different organelle's note while selectedItem points at this one — but
// resolved defensively rather than assumed).
function resolveInsertionAnchor(entityId: string, state: MelodyState, fallback: MelodyItem): MelodyItem {
  if (insertionPoint && insertionPoint.entityId === entityId && state.items.includes(insertionPoint.item)) {
    return insertionPoint.item;
  }
  return fallback;
}

// Adjusts scrollIndex by the minimum amount needed to bring visible-index
// `index` into view — left if it's above the current window, right if
// below, unchanged if already visible. Shared by selectAdjacentItem (so
// arrow-key navigation never leaves the selection scrolled out of sight)
// and could equally serve any other future "make sure this item is
// visible" need.
function scrollToShow(state: MelodyState, index: number): void {
  if (index < state.scrollIndex) {
    state.scrollIndex = index;
  } else if (index >= state.scrollIndex + VISIBLE_SLOTS) {
    state.scrollIndex = index - VISIBLE_SLOTS + 1;
  }
  clampScroll(state);
}

// Moves the current selection to the previous/next note-or-rest in the
// same organelle's sequence (ui/interaction.ts's Left/Right arrow keys) —
// barlines are skipped over since they're not selectable. If there's
// nothing further in that direction, 'previous' is simply a no-op, but
// 'next' still scrolls one slot further right instead — with no note/rest
// left to select, this is what lets repeatedly pressing Right reveal the
// always-available blank working area past the end (TODO.md's melody
// organelle spec), without changing what's selected.
export function selectAdjacentItem(direction: 'previous' | 'next'): void {
  if (!selectedItem) return;
  const { entityId, item } = selectedItem;
  const state = melodyStateFor(entityId);
  const index = state.items.indexOf(item);
  if (index === -1) return;

  const step = direction === 'next' ? 1 : -1;
  for (let i = index + step; i >= 0 && i < state.items.length; i += step) {
    const candidate = state.items[i];
    if (isSelectable(candidate)) {
      selectItem(entityId, candidate);
      scrollToShow(state, i);
      return;
    }
  }
  if (direction === 'next') {
    state.scrollIndex += 1;
    clampScroll(state);
  }
}

// getSelectedItem(), but null if that item's own organelle popup isn't
// currently open — closing a popup shouldn't leave its last selection
// silently actionable by the Up/Down/Left/Right/Delete/letter-key
// shortcuts below while nothing on screen shows what's being changed.
// ui/interaction.ts's keydown handler gates all of them through this
// rather than the raw getSelectedItem().
export function activeSelectedItem(graph: EntityGraph): MelodySelectionHit | null {
  if (!selectedItem) return null;
  const entity = graph.get(selectedItem.entityId);
  return entity?.expanded ? selectedItem : null;
}

// Removes the current selection from its sequence (the Delete/Backspace
// keyboard shortcut, ui/interaction.ts). The next note-or-rest in the
// sequence becomes the new selection, or the previous one if it was the
// last — mirroring selectAdjacentItem's own scope — so deleting a run of
// items moves forward through the sequence naturally. Clears the selection
// entirely if none is left.
export function deleteSelectedItem(): void {
  if (!selectedItem) return;
  const { entityId, item } = selectedItem;
  const state = melodyStateFor(entityId);
  const index = state.items.indexOf(item);
  if (index === -1) return;

  state.items.splice(index, 1);
  clampScroll(state);

  for (let i = index; i < state.items.length; i++) {
    const candidate = state.items[i];
    if (isSelectable(candidate)) {
      selectItem(entityId, candidate);
      scrollToShow(state, i);
      return;
    }
  }
  for (let i = index - 1; i >= 0; i--) {
    const candidate = state.items[i];
    if (isSelectable(candidate)) {
      selectItem(entityId, candidate);
      scrollToShow(state, i);
      return;
    }
  }
  selectedItem = null;
}

function noteSemitone(note: MelodyNoteItem): number {
  const accidentalOffset = note.accidental === 'sharp' ? 1 : note.accidental === 'flat' ? -1 : 0;
  return semitoneFromStep(note.step) + accidentalOffset;
}

// The pitch reference for a new letter note (TODO.md's spec): `current`'s
// own pitch if it's a note, or — since a rest carries no pitch of its own —
// the most recent actual note BEFORE it in the sequence, searching
// backward from wherever `current` sits. Falls back to middle C (semitone
// 0) if there's no earlier note at all, matching insertFirstLetterNote's
// own default for a from-scratch sequence.
function referenceSemitoneFor(state: MelodyState, current: MelodySelectable): number {
  if (current.kind === 'note') return noteSemitone(current);
  const index = state.items.indexOf(current);
  for (let i = index - 1; i >= 0; i--) {
    const candidate = state.items[i];
    if (candidate.kind === 'note') return noteSemitone(candidate);
  }
  return 0;
}

// Adds a new NATURAL note (no accidental) named by `letterIdx` (0=C, 1=D,
// ... 6=B) immediately after the current selection, with the same
// duration, and selects it — the A-G letter-key shortcuts
// (ui/interaction.ts). Its octave is chosen so its pitch lands as close as
// possible to the current note's own actual (semitone) pitch
// (nearestStepForLetter — always within six semitones either way, per
// TODO.md's melody organelle spec), rather than defaulting to some fixed
// octave that could land however far away.
export function insertLetterNoteAfterSelection(letterIdx: number): void {
  if (!selectedItem) return;
  const { entityId, item: current } = selectedItem;
  const state = melodyStateFor(entityId);
  const anchorIndex = state.items.indexOf(resolveInsertionAnchor(entityId, state, current));
  if (anchorIndex === -1) return;

  const referenceSemitone = referenceSemitoneFor(state, current);
  const step = nearestStepForLetter(letterIdx, referenceSemitone);

  const note: MelodyNoteItem = { kind: 'note', step, accidental: null, durationIndex: current.durationIndex, dots: 0 };
  const newIndex = anchorIndex + 1;
  state.items.splice(newIndex, 0, note);
  selectItem(entityId, note);
  if (newIndex === state.items.length - 1) {
    scrollToEnd(state);
  } else {
    scrollToShow(state, newIndex);
  }
}

// The A-G letter-key shortcut's bootstrapping case (TODO.md's spec): "if a
// letter key is pressed before any other notes have been entered" — seeds
// an EMPTY, currently-expanded melody organelle with a single crotchet at
// the given letter's own pitch closest to MIDDLE C (semitone 0, rather than
// insertLetterNoteAfterSelection's "closest to the current note," since
// there is no current note yet), selecting it. Picks the first expanded-
// and-empty organelle found — there's normally only one melody popup open
// at a time, so this doesn't need to disambiguate further. Returns false
// (does nothing) if no such organelle exists, so ui/interaction.ts's
// keydown handler can fall through to tap-binding as usual.
export function insertFirstLetterNote(graph: EntityGraph, letterIdx: number): boolean {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'melody' || !entity.expanded) continue;
    const state = melodyStateFor(entity.id);
    if (state.items.length > 0) continue;

    const step = nearestStepForLetter(letterIdx, 0);
    const note: MelodyNoteItem = { kind: 'note', step, accidental: null, durationIndex: DEFAULT_DURATION_INDEX, dots: 0 };
    state.items.push(note);
    selectItem(entity.id, note);
    return true;
  }
  return false;
}

// The closest duration this app's model can actually represent to
// `wholeNotes` — rests have no dots field (unlike notes), so this only
// searches the plain (undotted) durations. Exact for every "fill to the
// next beat" case except a dotted semiquaver or demisemiquaver's own rest
// (restToFillBeat below), where the exact gap would need a dotted rest;
// those get the nearest plain approximation instead rather than extending
// the rest data model/rendering just for that rare case.
function nearestRepresentableRestDuration(wholeNotes: number): number {
  let best = DEFAULT_DURATION_INDEX;
  let bestDiff = Infinity;
  for (let durationIndex = MIN_DURATION_INDEX; durationIndex <= MAX_DURATION_INDEX; durationIndex++) {
    const diff = Math.abs(durationInWholeNotes(durationIndex) - wholeNotes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = durationIndex;
    }
  }
  return best;
}

// "The rest should be the duration needed to get up to the next whole
// beat" (TODO.md's spec, for a dotted current note) — a beat is a crotchet
// (this app's implicit beat unit elsewhere, e.g. VISIBLE_SLOTS' own "about
// two bars" sizing assumes four crotchet beats per bar). If the dotted
// note's own duration already lands exactly on a beat boundary (e.g. a
// dotted minim is exactly 3 beats), "the next" one is a full beat further
// on, not zero — "next" means strictly ahead of where the note ends.
function restToFillBeat(durationIndex: number, dots: number): number {
  const beats = 4 * durationInWholeNotes(durationIndex, dots);
  const fractional = beats - Math.floor(beats);
  const restBeats = fractional > 1e-9 ? 1 - fractional : 1;
  return nearestRepresentableRestDuration(restBeats / 4);
}

// The Space keyboard shortcut (ui/interaction.ts): inserts a rest after
// the current insertion point (resolveInsertionAnchor — so a rest typed
// right after an already-typed note/rest/barline lands after THAT, not
// back next to whichever note is still "current" for Up/Down/Left/Right
// purposes). Duration matches the current note's own value, unless that
// note is dotted, in which case the rest instead fills the gap up to the
// next whole beat (restToFillBeat) — see TODO.md's spec for both rules.
export function insertRestAfterCurrent(): void {
  if (!selectedItem) return;
  const { entityId, item: current } = selectedItem;
  const state = melodyStateFor(entityId);
  const anchorIndex = state.items.indexOf(resolveInsertionAnchor(entityId, state, current));
  if (anchorIndex === -1) return;

  const durationIndex =
    current.kind === 'note' && current.dots > 0 ? restToFillBeat(current.durationIndex, current.dots) : current.durationIndex;
  const rest: MelodyRestItem = { kind: 'rest', durationIndex };
  const newIndex = anchorIndex + 1;
  state.items.splice(newIndex, 0, rest);
  insertionPoint = { entityId, item: rest }; // advances the insertion point WITHOUT touching selectedItem — rests aren't selectable
  if (newIndex === state.items.length - 1) {
    scrollToEnd(state);
  } else {
    scrollToShow(state, newIndex);
  }
}

// The `|` keyboard shortcut (ui/interaction.ts): inserts a barline after
// the current insertion point, same placement logic as
// insertRestAfterCurrent — no duration to compute, a barline just marks a
// position in the sequence.
export function insertBarlineAfterCurrent(): void {
  if (!selectedItem) return;
  const { entityId, item: current } = selectedItem;
  const state = melodyStateFor(entityId);
  const anchorIndex = state.items.indexOf(resolveInsertionAnchor(entityId, state, current));
  if (anchorIndex === -1) return;

  const barline: MelodyBarlineItem = { kind: 'barline' };
  const newIndex = anchorIndex + 1;
  state.items.splice(newIndex, 0, barline);
  insertionPoint = { entityId, item: barline };
  if (newIndex === state.items.length - 1) {
    scrollToEnd(state);
  } else {
    scrollToShow(state, newIndex);
  }
}

// Keeps scrollIndex sane after any change to item count — clamped rather
// than reset, so a mutation elsewhere in the visible window doesn't yank
// the view back to the start.
function clampScroll(state: MelodyState): void {
  const maxScroll = maxScrollFor(state.items.length);
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
// durationIndex/dots pair into actual playback time. Each dot adds half of
// the previous increment (base, then base/2, then base/4, ...) — standard
// dotted-note arithmetic, and exactly what mergeAdjacentSamePitch's own
// "next halving step down" check below is built around.
export function durationInWholeNotes(durationIndex: number, dots = 0): number {
  const base = 1 / 2 ** durationIndex;
  let total = base;
  let increment = base;
  for (let i = 0; i < dots; i++) {
    increment /= 2;
    total += increment;
  }
  return total;
}

// --- Sequence editing ------------------------------------------------------

const DEFAULT_ITEM_SPACING = 20; // px between adjacent item slots — about 60% of the original 34px
const FIRST_ITEM_OFFSET = 14; // px from staffLeft to item index 0's slot — clear of the clef
// "About two bars" (TODO.md) — an approximate common-time sizing (two bars
// of four beats each), not tied to any actual bar-length enforcement (bars
// are just barline items the player inserts manually). Tune by eye.
const VISIBLE_SLOTS = 8;

// The furthest scrollIndex can go — always a full extra window's worth of
// blank space beyond the real content (not just itemCount - VISIBLE_SLOTS,
// which would cap scrolling the instant the last item reaches the right
// edge). This is what makes it possible to always scroll right into a
// full-width blank working area, no matter how full the staff already is —
// see hitTestMelodyPopup's/drawMelodyPopup's own item loops, which just
// skip drawing/hit-testing any slot past the real items, so scrolling out
// here costs nothing but empty staff.
function maxScrollFor(itemCount: number): number {
  return itemCount;
}

// `index`/`step` are already resolved against the layout in effect at click
// time (see hitTestMelodyPopup's 'addNote' hit).
export function addNoteAt(entityId: string, state: MelodyState, index: number, step: number): void {
  const note: MelodyNoteItem = { kind: 'note', step, accidental: null, durationIndex: DEFAULT_DURATION_INDEX, dots: 0 };
  state.items.splice(index, 0, note);
  selectItem(entityId, note); // most recently created — see getSelectedItem's own comment
  if (index === state.items.length - 1) {
    // Appended at the tail (as opposed to inserted somewhere in the middle
    // of the existing sequence) — same "keep at least one blank slot
    // visible after it" auto-scroll as insertRestAfterLast/
    // insertBarlineAfterLast below, so repeatedly clicking to add notes
    // left-to-right never runs out of visible room to click into next. A
    // mid-sequence insertion leaves the current view alone instead —
    // there's no reason editing existing content should yank the view to
    // the end.
    scrollToEnd(state);
  } else {
    clampScroll(state);
  }
}

// Scrolls to reveal the newly-appended item with at least one blank slot
// still visible after it (rather than flush against the right edge) —
// "after the last note" (TODO.md) would otherwise land off the visible
// window entirely as soon as there are already more than VISIBLE_SLOTS
// items, silently doing nothing the player could see.
function scrollToEnd(state: MelodyState): void {
  state.scrollIndex = Math.max(0, state.items.length - VISIBLE_SLOTS + 1);
  clampScroll(state);
}

export function insertRestAfterLast(entityId: string, state: MelodyState): void {
  const rest: MelodyRestItem = { kind: 'rest', durationIndex: DEFAULT_DURATION_INDEX };
  state.items.push(rest);
  insertionPoint = { entityId, item: rest }; // so a following typed insertion continues from here, not from wherever selectedItem still is
  scrollToEnd(state);
}

export function insertBarlineAfterLast(entityId: string, state: MelodyState): void {
  const barline: MelodyBarlineItem = { kind: 'barline' };
  state.items.push(barline);
  insertionPoint = { entityId, item: barline };
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
  entityId: string,
  item: MelodyNoteItem,
  startStep: number,
  startAccidental: Accidental,
  deltaY: number
): void {
  const { stepDelta, accidental } = quantizeVerticalDrag(deltaY, startAccidental, startStep);
  item.step = startStep + stepDelta;
  item.accidental = accidental;
  selectItem(entityId, item); // most recently moved — see getSelectedItem's own comment
}

// Moves a note exactly one chromatic half-step up or down — the Up/Down
// keyboard shortcut (ui/interaction.ts), operating on the current selection
// (getSelectedItem above). Walks the same ladder
// quantizeVerticalDrag's half-step handling uses, just directly in step/
// accidental terms rather than via a pixel distance: a natural note tries
// to become a sharp (going up) or flat (going down) of ITSELF first, per
// ui/musicTheory.ts's gating (skipping straight to the next natural step
// where that accidental wouldn't mean anything, e.g. E has no sharp); an
// already-accidental note either continues on to the next natural step (if
// nudged further the same direction it was reached from) or reverts to
// natural (if nudged back the other way) — so up and down are always exact
// inverses of each other at every position, and the note passes through
// every valid accidental on the way, never skipping one.
export function nudgePitch(item: MelodyNoteItem, direction: 'up' | 'down'): void {
  if (direction === 'up') {
    if (item.accidental === 'flat') {
      item.accidental = null;
    } else if (item.accidental === 'sharp') {
      item.step += 1;
      item.accidental = null;
    } else if (sharpMakesSense(item.step)) {
      item.accidental = 'sharp';
    } else {
      item.step += 1;
    }
  } else {
    if (item.accidental === 'sharp') {
      item.accidental = null;
    } else if (item.accidental === 'flat') {
      item.step -= 1;
      item.accidental = null;
    } else if (flatMakesSense(item.step)) {
      item.accidental = 'flat';
    } else {
      item.step -= 1;
    }
  }
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
// The window's top edge sits flush with the top of the close button/+8ve
// button cluster (both top-aligned at staffTop - this margin — see
// computeLayout's closeButton/octaveUpButton) — melody has no title text
// (unlike the envelope popup, which uses organelle.ts's own TITLE_HEIGHT)
// needing any more room above the staff than that.
const TOP_MARGIN = OCTAVE_BUTTON_SIZE / 2;

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
  const base = TOP_MARGIN + STAFF_PIXEL_HEIGHT + NOTE_HEAD_HEIGHT;
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
  const staffTop = top + TOP_MARGIN;
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
    // Same column as restIcon (aligned under it), but vertically centered
    // on the bass staff's own middle line rather than a fixed offset below
    // the rest icon.
    barlineIcon: { x: iconX, y: stepToY(middleCY, BASS_MIDDLE_LINE_STEP) },
    // Top-aligned with the +8ve button (octaveUpButton) rather than
    // organelle.ts's own shared title-row placement — melody has no title
    // text needing that row (see drawMelodyPopup), so the close control
    // moves down to sit with the rest of the top cluster instead.
    closeButton: { x: popup.x + popup.width / 2 - 14, y: staffTop - OCTAVE_BUTTON_SIZE / 2 + CLOSE_BUTTON_RADIUS },
    scrollTrack: needsScrollbar(itemCount)
      ? {
          x: (staffLeft + staffRight) / 2,
          // Aligned with the bottom of the -8ve button (whose own bottom
          // edge is staffBottom + OCTAVE_BUTTON_SIZE / 2, same as
          // octaveDownButton's own y + height/2 above) rather than sitting
          // lower in the reserved bottom margin.
          y: staffBottom + OCTAVE_BUTTON_SIZE / 2,
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

function resolveLayoutFor(
  graph: EntityGraph,
  entityId: string,
  drag?: DragContext
): { state: MelodyState; layout: MelodyLayout } | null {
  const feature = graph.get(entityId);
  const owner = feature && ownerOf(graph, feature);
  if (!feature || !owner) return null;
  const state = melodyStateFor(entityId);
  const layout = computeLayout(graph, owner, state.items.length, drag);
  return { state, layout };
}

function spliceAtPointerX(state: MelodyState, layout: MelodyLayout, item: MelodyItem, pointerX: number): void {
  const others = state.items.filter((i) => i !== item);
  const targetIndex = indexFromX(layout, pointerX, others.length, state.scrollIndex);
  others.splice(targetIndex, 0, item);
  state.items = others;
}

// How close the pointer needs to be to a same-pitch note's own slot before
// that note freezes in place (see reorderDuringDrag) — a fraction of one
// slot's spacing, not a fixed pixel count, so it scales with
// DEFAULT_ITEM_SPACING if that's ever retuned.
const MERGE_HOVER_FRACTION = 0.5;

// The nearest OTHER note of the exact same written pitch (step AND
// accidental — a merge only makes sense between genuinely identical notes),
// if the pointer is currently within MERGE_HOVER_FRACTION of a slot's width
// of it. Duration compatibility is NOT checked here — that's decided at
// drop time (mergeIntoTarget) — this only decides whether the target
// freezes during the drag at all.
function nearestSamePitchNote(
  state: MelodyState,
  layout: MelodyLayout,
  dragged: MelodyNoteItem,
  pointerX: number
): MelodyNoteItem | null {
  let best: MelodyNoteItem | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < state.items.length; i++) {
    const other = state.items[i];
    if (other === dragged || other.kind !== 'note') continue;
    if (other.step !== dragged.step || other.accidental !== dragged.accidental) continue;
    const x = itemSlotX(layout, i - state.scrollIndex);
    const d = Math.abs(x - pointerX);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best && bestDist <= DEFAULT_ITEM_SPACING * MERGE_HOVER_FRACTION ? best : null;
}

// Called on every pointermove of a horizontal-axis item drag
// (ui/interaction.ts's melodyPress). Two behaviors depending on what's
// under the pointer:
//  - Nowhere near another note of the exact same pitch: the normal live
//    reorder applies — `item` moves to whatever slot the pointer is over
//    right now, among the OTHER items' own slots (removing `item` from
//    consideration first, so it doesn't block its own gap from closing
//    beneath it). This is what makes neighbors shift live to make room as
//    the dragged item passes over them, and what makes the gap it left
//    behind close immediately rather than needing a separate step on drop.
//  - Hovering a same-pitch note (nearestSamePitchNote): that note freezes
//    in place — no reorder happens at all this frame — so it can't be
//    shifted out of the way of the very note that's about to be dropped on
//    it (TODO.md's melody organelle spec: "drag one note onto an adjacent
//    note of the same pitch to add their values together"). The returned
//    note is what ui/render.ts snaps the dragged item's own visual onto
//    (see MelodyDragOverride) — so it reads as "sitting on top of" the
//    target rather than the target moving — and what
//    ui/interaction.ts's endPress passes to mergeIntoTarget on release.
export function reorderDuringDrag(
  graph: EntityGraph,
  entityId: string,
  item: MelodyItem,
  pointerX: number,
  drag?: DragContext
): MelodyNoteItem | null {
  const resolved = resolveLayoutFor(graph, entityId, drag);
  if (!resolved) return null;
  const { state, layout } = resolved;
  if (!state.items.includes(item)) return null;

  if (item.kind === 'note') {
    const target = nearestSamePitchNote(state, layout, item, pointerX);
    if (target) return target;
  }

  spliceAtPointerX(state, layout, item, pointerX);
  if (item.kind === 'note') selectItem(entityId, item); // most recently moved — see getSelectedItem's own comment
  return null;
}

// Places `item` at the pointer's current position with a normal reorder,
// bypassing the same-pitch freeze above entirely — used by
// ui/interaction.ts when a hover-merge (reorderDuringDrag's return value)
// turns out not to be a valid dot relationship on release (mergeIntoTarget
// returns false), so the drag still has a visible effect instead of leaving
// `item` sitting wherever it was before the drag started.
export function forcePlacement(graph: EntityGraph, entityId: string, item: MelodyItem, pointerX: number, drag?: DragContext): void {
  const resolved = resolveLayoutFor(graph, entityId, drag);
  if (!resolved) return;
  const { state, layout } = resolved;
  if (!state.items.includes(item)) return;
  spliceAtPointerX(state, layout, item, pointerX);
  if (item.kind === 'note') selectItem(entityId, item);
}

// Where `item` currently renders — used by ui/render.ts to snap a dragged
// note's own visual onto a frozen hover-merge target (reorderDuringDrag's
// return value) instead of the raw pointer position, so it reads as
// "sitting on top of" the target rather than following the cursor past it.
export function itemScreenX(graph: EntityGraph, entityId: string, item: MelodyItem, drag?: DragContext): number | null {
  const resolved = resolveLayoutFor(graph, entityId, drag);
  if (!resolved) return null;
  const { state, layout } = resolved;
  const index = state.items.indexOf(item);
  if (index === -1) return null;
  return itemSlotX(layout, index - state.scrollIndex);
}

// True if `longer` can absorb `shorter` as one more dot: `longer` isn't
// already double-dotted, and `shorter`'s duration is exactly `longer`'s own
// next halving step down — its plain duration if it has no dots yet, or its
// most recent dot's own contribution otherwise (durationInWholeNotes' own
// comment). That's the only relationship where combining the two durations
// is still a single notatable note (dotted or double-dotted `longer`)
// rather than an unrepresentable sum. Pitch is NOT checked here — by the
// time this is called, `shorter`/`longer` already came from a same-pitch
// hover pairing (nearestSamePitchNote); kept as a separate check so it can
// also be exercised on its own duration logic without a pitch fixture.
function canAbsorbAsDot(longer: MelodyNoteItem, shorter: MelodyNoteItem): boolean {
  return longer.dots < 2 && shorter.durationIndex === longer.durationIndex + longer.dots + 1;
}

// The mechanism this implements (TODO.md's melody organelle spec): drag one
// note onto an adjacent note of the same pitch (reorderDuringDrag's hover-
// freeze already made sure `target` didn't move out of the way) to add
// their values together, producing a dotted or double-dotted note. Called
// once the drag ends (ui/interaction.ts) — merging mid-drag, before the
// player has actually released, would make the note vanish out from under
// the cursor. Returns false if the two durations aren't a valid dot
// relationship in either direction, so the caller can fall back to placing
// `item` normally (forcePlacement) instead of the drag having no effect.
export function mergeIntoTarget(entityId: string, item: MelodyNoteItem, target: MelodyNoteItem): boolean {
  const state = melodyStateFor(entityId);
  const itemIndex = state.items.indexOf(item);
  const targetIndex = state.items.indexOf(target);
  if (itemIndex === -1 || targetIndex === -1) return false;

  if (canAbsorbAsDot(item, target)) {
    // `item` survives (with one more dot) and settles into target's own
    // slot — it visually sat "on top of" target throughout the hover, so
    // landing there on release (rather than back wherever it started this
    // drag) is the only position that doesn't jump. Adjusted for target's
    // own index shifting down by one if item used to sit before it.
    item.dots += 1;
    const adjustedTargetIndex = itemIndex < targetIndex ? targetIndex - 1 : targetIndex;
    state.items = state.items.filter((i) => i !== item && i !== target);
    state.items.splice(Math.min(adjustedTargetIndex, state.items.length), 0, item);
    selectItem(entityId, item); // the surviving note — most recently moved
    clampScroll(state);
    return true;
  }
  if (canAbsorbAsDot(target, item)) {
    target.dots += 1;
    state.items.splice(itemIndex, 1);
    selectItem(entityId, target);
    clampScroll(state);
    return true;
  }
  return false;
}

// --- Scrolling ---------------------------------------------------------

// Proportional to how much of the sequence is visible at once
// (VISIBLE_SLOTS / itemCount) — never narrower than SCROLLBAR_MIN_THUMB_WIDTH,
// so the thumb stays grabbable even when there are many items.
// Proportional to how much of the full scrollable range (real content PLUS
// the always-available trailing blank window — see maxScrollFor) is visible
// at once, not just how much of the real content is — otherwise the thumb
// would read as "you can see everything" right as the blank working area
// past the end becomes the only thing left to scroll into.
function thumbWidthFor(trackWidth: number, itemCount: number): number {
  const virtualLength = itemCount + VISIBLE_SLOTS;
  const proportion = Math.min(1, VISIBLE_SLOTS / virtualLength);
  return Math.max(SCROLLBAR_MIN_THUMB_WIDTH, trackWidth * proportion);
}

function thumbXFor(track: Rect, itemCount: number, scrollIndex: number): number {
  const trackLeft = track.x - track.width / 2;
  const maxScroll = maxScrollFor(itemCount);
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

  const maxScroll = maxScrollFor(state.items.length);
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
const CLEF_COLOR = 'rgba(255, 255, 255, 0.25)'; // dimmer than STAFF_COLOR — large but purely decorative, no interactive function
const NOTE_COLOR = 'rgba(232, 220, 192, 0.95)'; // matches organelle.ts's CURVE_COLOR family
const NOTE_COLOR_DIM = 'rgba(232, 220, 192, 0.55)'; // every note except the current selection (getSelectedItem)

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
function drawNoteGlyph(
  ctx: CanvasRenderingContext2D,
  center: Point,
  durationIndex: number,
  dots: number,
  onLine: boolean,
  stemUp: boolean,
  color: string
): number {
  const { glyph, widthSp } = noteheadGlyphFor(durationIndex);
  const leftX = center.x - sp(widthSp) / 2;
  const rightX = leftX + sp(widthSp);

  ctx.save();
  setBravuraFont(ctx);
  ctx.fillStyle = color;
  ctx.fillText(glyph, leftX, center.y);
  ctx.restore();

  if (dots > 0) {
    // A dot landing exactly on a staff line is nudged up into the space
    // above it — standard engraving practice, so it doesn't read as part of
    // the line itself. A dot in a space already sits fine unmoved.
    const dotY = onLine ? center.y - sp(0.5) : center.y;
    const dotGapSp = 0.2;
    ctx.save();
    setBravuraFont(ctx);
    ctx.fillStyle = color;
    for (let i = 0; i < dots; i++) {
      const dotX = rightX + sp(dotGapSp) + i * sp(AUGMENTATION_DOT_WIDTH_SP + dotGapSp);
      ctx.fillText(GLYPH.augmentationDot, dotX, dotY);
    }
    ctx.restore();
  }

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
    drawTrebleClef(ctx, layout.left, CLEF_COLUMN_WIDTH, layout, CLEF_COLOR);
    drawBassClef(ctx, layout.left, CLEF_COLUMN_WIDTH, layout, CLEF_COLOR);
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
      const restColor = getSelectedItem()?.item === item ? NOTE_COLOR : NOTE_COLOR_DIM;
      drawRestGlyph(ctx, treblePos, item.durationIndex, restColor);
      drawRestGlyph(ctx, bassPos, item.durationIndex, restColor);
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
      const onLine = renderedStep % 2 === 0; // staff lines sit at even steps, spaces at odd — see TREBLE_LINE_STEPS/BASS_LINE_STEPS
      const noteColor = getSelectedItem()?.item === item ? NOTE_COLOR : NOTE_COLOR_DIM;
      const noteheadLeftX = drawNoteGlyph(ctx, pos, item.durationIndex, item.dots, onLine, stemUpFor(renderedStep), noteColor);
      drawAccidental(ctx, noteheadLeftX, pos.y, item.accidental, noteColor);
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
  const barlineIconHalfHeight = sp(REST_QUARTER_HEIGHT_SP) / 2; // matches the rest icon's own glyph height exactly
  ctx.beginPath();
  ctx.moveTo(layout.barlineIcon.x, layout.barlineIcon.y - barlineIconHalfHeight);
  ctx.lineTo(layout.barlineIcon.x, layout.barlineIcon.y + barlineIconHalfHeight);
  ctx.stroke();

  ctx.restore();
}
