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
  // Karplus-Strong plucked string (dsp/rust/src/lib.rs) — a one-shot
  // TRIGGERED_KINDS instrument like kick, not a drone: click its pad to
  // pluck it. Bass-guitar pitch range, matching 'bass' above.
  pluck: [
    { param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' },
    { param: 'pitch', label: 'pitch', min: 20, max: 200, color: '#5aa0c8' },
    // Same purple-blue as kick/reverb's decay — how fast the string dies out.
    { param: 'damping', label: 'damping', min: 0, max: 1, color: '#8a7ec8' },
    // Same magenta as overdrive/reverb's tone — brightness of the pluck's
    // initial attack (see dsp/rust/src/lib.rs's PLUCK_RESPONSE comment).
    { param: 'response', label: 'response', min: 0, max: 1, color: '#c85ac8' },
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

// Two-layer dot: a grey outer ring (a fixed backdrop, roughly matching the
// UI's own dark control-surface color — see ui/render.ts's drawControls)
// with a smaller colored dot resting at its center. The colored dot grows
// (not all the way to the ring's own edge — just to CONTROL_DOT_DROP_RADIUS)
// when it's a valid wire drop target, rather than the whole thing growing
// past its own footprint.
export const CONTROL_DOT_OUTER_RADIUS = 8;
export const CONTROL_DOT_RADIUS = 1.5; // resting inner colored dot
export const CONTROL_DOT_DROP_RADIUS = 3; // grown size as a wire drop target
export const CONTROL_HIT_RADIUS = 10; // generous target around the visual dot
export const CONTROL_TRACK_LENGTH = 80; // px the slider travels, independent of value

export const DOT_INSET = 14; // from the box's bottom edge to the first (bottom) dot
// Distance from the box's left edge to the dot's center — mostly outside
// the boundary (poking out to the left, mirroring a knob's wire-output
// bump poking out to the right — inputs left, outputs right, matching the
// wires' left-to-right flow), with a couple of px of overlap back in so it
// reads as attached rather than floating free of the box.
export const DOT_OUTSET = CONTROL_DOT_OUTER_RADIUS - 2;
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

// Rest position of a dot — index 0 is nearest the box (bottom of the
// column), rising from there. On the left, outside the box (see
// DOT_OUTSET): these are a target's inputs, and wires flow left-to-right
// from a source's output bump (ui/knobs.ts's wireHandlePosition) on its
// right — so a wire runs straight across from one box's right side to the
// next box's left, rather than doubling back.
export function dotPosition(bounds: BoxLike, index: number): Point {
  return {
    x: bounds.x - bounds.width / 2 - DOT_OUTSET,
    y: bounds.y + bounds.height / 2 - DOT_INSET - index * DOT_SPACING,
  };
}
