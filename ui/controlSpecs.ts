// Per-kind control-parameter metadata and control-column layout geometry.
// Deliberately dependency-free (no layout.ts, no audio/*): layout.ts needs
// this to reserve space for a container's own control column when
// computing its bounds (so the column can never get covered by something
// dropped in, and a control-heavy pedal is never smaller than what it
// needs to show all its dots), and controls.ts/render.ts/interaction.ts
// need it to draw and drive the controls — importing this from both
// without a cycle is the reason it's split out on its own.

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
  overdrive: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'tone', label: 'tone', min: 200, max: 8000, color: '#c85ac8' },
    { param: 'drive', label: 'drive', min: 0, max: 20, color: '#e0883c' },
  ],
  reverb: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'tone', label: 'tone', min: 200, max: 8000, color: '#c85ac8' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
    { param: 'decay', label: 'decay', min: 0.5, max: 10, color: '#8a7ec8' },
  ],
  // Colors reused across chorus/flanger for shared param meaning (rate,
  // depth, mix, level are the same concept in both) — feedback reuses bow
  // pressure's red, in keeping with "red = intensity/risk knob."
  chorus: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'rate', label: 'rate', min: 0.05, max: 5, color: '#5ac8a0' },
    { param: 'depth', label: 'depth', min: 0.5, max: 8, color: '#d87ab0' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  flanger: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'rate', label: 'rate', min: 0.02, max: 2, color: '#5ac8a0' },
    { param: 'depth', label: 'depth', min: 0.5, max: 6, color: '#d87ab0' },
    // Capped at 0.95 in audio/graph.ts regardless of what this slider is
    // dragged to — see createModulatedDelay's comment.
    { param: 'feedback', label: 'feedback', min: 0, max: 0.95, color: '#c85a5a' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  kick: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    // Same blue as bass/bow's pitch — same concept, deliberately consistent.
    { param: 'pitch', label: 'pitch', min: 30, max: 100, color: '#5aa0c8' },
    // Same purple-blue as reverb's decay — punchy (short) vs. boomy (long).
    { param: 'decay', label: 'decay', min: 0.1, max: 1.5, color: '#8a7ec8' },
    { param: 'click', label: 'click', min: 0, max: 1, color: '#a0d8e0' },
  ],
  // A knob's own value — reuses the same dot+slider mechanism as every
  // other parameter (see ui/controls.ts), rather than needing bespoke
  // interaction code. Color matches the knob's rotating indicator (see
  // ui/render.ts's drawKnob) so the dot and the thing it's turning read as
  // the same value.
  knob: [{ param: 'value', label: 'value', min: 0, max: 1, color: '#e8dcc0' }],
  // The master clock's own tempo (audio/transport.ts) — same dot+slider
  // mechanism as a knob's value, just a musically-meaningful range instead
  // of a normalized 0-1. Warm amber to match the beat-pulse glow on its
  // wire-output bump (see ui/render.ts's drawClock).
  clock: [{ param: 'bpm', label: 'bpm', min: 5, max: 300, color: '#f0b860' }],
};

export function controlsFor(kind: string): ControlSpec[] {
  return CONTROL_SPECS[kind] ?? [];
}

export const CONTROL_DOT_RADIUS = 5;
export const CONTROL_HIT_RADIUS = 10; // generous target around the small visual dot
export const CONTROL_TRACK_LENGTH = 80; // px the slider travels, independent of value

export const DOT_INSET = 14; // from the box's right/bottom edge to the first (bottom) dot
export const DOT_SPACING = 22; // vertical gap between successive dots in the column

export interface Point {
  x: number;
  y: number;
}

// Only the shape dotPosition actually needs — not layout.ts's Rect, to keep
// this module free of that dependency.
export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Rest position of a dot — index 0 is nearest the box (bottom of the column),
// rising from there.
export function dotPosition(bounds: BoxLike, index: number): Point {
  return {
    x: bounds.x + bounds.width / 2 - DOT_INSET,
    y: bounds.y + bounds.height / 2 - DOT_INSET - index * DOT_SPACING,
  };
}
