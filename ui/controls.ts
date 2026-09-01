// Lightweight per-parameter control affordance: a small colored dot per
// controllable param, stacked in a column rising from an entity's
// bottom-right corner. Hovering reveals a label and a vertical slider
// positioned so the point representing the current value sits exactly
// where the dot was — the cursor is already on the thumb, ready to drag.
// Deliberately minimal by default: this should read as a couple of quiet
// indicator dots, not a rack of visible knobs/faders.

import type { EntityGraph } from '../audio/entityGraph';
import { effectiveBounds } from './layout';
import type { DragContext, Point, Rect } from './layout';

export interface ControlSpec {
  param: string; // matches entity.params key
  label: string; // shown on hover
  min: number;
  max: number;
  color: string;
}

// Per-kind control list — a kind not listed here gets no dots at all.
const CONTROL_SPECS: Record<string, ControlSpec[]> = {
  bass: [
    { param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' },
    // Sub-bass/low-bass territory — deliberately a narrower, lower range
    // than the bow's, matching what this voice is actually for.
    { param: 'frequency', label: 'pitch', min: 20, max: 150, color: '#5aa0c8' },
  ],
  bow: [
    { param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' },
    { param: 'frequency', label: 'pitch', min: 40, max: 500, color: '#5aa0c8' },
    // STK's own reference implementation only really behaves in ~0.03-0.25
    // (see dsp/rust/src/lib.rs) — range goes a bit past that for headroom.
    { param: 'bowVelocity', label: 'bow speed', min: 0, max: 0.3, color: '#7ec850' },
    // STK's normalized [0,1] pressure convention.
    { param: 'bowPressure', label: 'bow pressure', min: 0, max: 1, color: '#c85a5a' },
  ],
};

export function controlsFor(kind: string): ControlSpec[] {
  return CONTROL_SPECS[kind] ?? [];
}

export const CONTROL_DOT_RADIUS = 5;
export const CONTROL_HIT_RADIUS = 10; // generous target around the small visual dot
export const CONTROL_TRACK_LENGTH = 80; // px the slider travels, independent of value

const DOT_INSET = 14; // from the box's right/bottom edge to the first (bottom) dot
const DOT_SPACING = 22; // vertical gap between successive dots in the column

// Rest position of a dot — index 0 is nearest the box (bottom of the column),
// rising from there.
export function dotPosition(bounds: Rect, index: number): Point {
  return {
    x: bounds.x + bounds.width / 2 - DOT_INSET,
    y: bounds.y + bounds.height / 2 - DOT_INSET - index * DOT_SPACING,
  };
}

export function valueFraction(spec: ControlSpec, value: number): number {
  return Math.min(1, Math.max(0, (value - spec.min) / (spec.max - spec.min)));
}

// Track geometry (fixed length, positioned so it grows and shrinks around
// the dot) such that the point representing `value` lands exactly at `dot`.
// Track runs bottom (min) to top (max) — standard vertical-fader convention.
export interface Track {
  x: number;
  top: number;
  bottom: number;
}

export function trackGeometry(dot: Point, spec: ControlSpec, value: number): Track {
  const fraction = valueFraction(spec, value);
  const bottom = dot.y + fraction * CONTROL_TRACK_LENGTH;
  return { x: dot.x, top: bottom - CONTROL_TRACK_LENGTH, bottom };
}

// Inverse of trackGeometry's mapping, against a FIXED track captured once at
// drag-start (not recomputed from the live value mid-drag, which would be
// circular) — given where the pointer is now, what value does that mean.
export function valueFromTrackPosition(track: Track, spec: ControlSpec, pointerY: number): number {
  const fraction = Math.min(1, Math.max(0, (track.bottom - pointerY) / (track.bottom - track.top)));
  return spec.min + fraction * (spec.max - spec.min);
}

export interface ControlHit {
  entityId: string;
  spec: ControlSpec;
  dot: Point;
}

// Nearest dot (within CONTROL_HIT_RADIUS) under `point`, across every
// entity that has any control specs. `drag` (optional) keeps this
// consistent with whatever live drag-preview bounds are currently showing
// (see layout.ts's DragContext) — a control dot should hover/hit-test at
// wherever its box is actually drawn right now, expanded or not.
export function hitTestControl(
  graph: EntityGraph,
  point: Point,
  drag?: DragContext
): ControlHit | null {
  for (const entity of graph.all()) {
    const specs = controlsFor(entity.kind);
    if (specs.length === 0) continue;

    const bounds = effectiveBounds(graph, entity, drag);
    for (let i = 0; i < specs.length; i++) {
      const dot = dotPosition(bounds, i);
      if (Math.hypot(point.x - dot.x, point.y - dot.y) <= CONTROL_HIT_RADIUS) {
        return { entityId: entity.id, spec: specs[i], dot };
      }
    }
  }
  return null;
}
