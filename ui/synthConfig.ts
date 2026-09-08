// The 'synth' voice's own second organelle (EntityType 'feature', kind
// 'synthConfig') — a waveform-blend selector (four icon+toggle buttons, one
// per native OscillatorNode shape audio/graph.ts's createSynthVoice can
// mix in) plus two LFO-modulation input ports (vibrato: pitch, tremolo:
// amplitude), each with its own depth slider. Sits alongside the same
// envelope-organelle every other TRIGGERED_KINDS voice has (ui/organelle.ts)
// — see audio/entityGraph.ts's Entity.ownerId comment on an owner having
// more than one feature.
//
// The two depth ports are wire TARGETS only, exactly like the envelope
// popup's own ADSR params (audio/entityGraph.ts's Entity.ownerId: "never
// itself a wire source the way a knob is") — a control-dot column entry in
// ui/controlSpecs.ts gives them the generic wire-endpoint/porthole-
// convergence machinery (ui/organelle.ts's featureDotAbsolutePosition/
// hitTestFeatureDot, already kind-agnostic across every feature kind) for
// free, so this module only needs to draw them and handle their own manual
// depth slider — new-wire dropping, disconnecting, and porthole-collapse
// behavior all come from that shared mechanism unchanged.
//
// What IS genuinely new here: an incoming wire from an 'lfo'-kind entity
// has to become a real, continuously-running Web Audio connection (an
// oscillator patched straight into an AudioParam), not the one-shot
// value-copy every other wire uses (ui/wiring.ts's own header). wiring.ts
// itself stays wire-mechanism-only and audio-agnostic — ui/lfoWiring.ts's
// reconcileLfoWireTarget is the bridge, called from ui/interaction.ts right
// after any wire add/remove, forwarding to audio/graph.ts's own
// reconcileSynthConfigModulation (for these two ports specifically) or
// reconcileLfoDotModulation (for any other plain control dot with a real
// AudioParam behind it, e.g. overdrive/fuzz/reverb's own 'tone' filter) to
// make/break the actual Web Audio connection.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import type { DragContext, Point, Rect } from './layout';
import {
  ownerOf,
  popupRectFor,
  closeButtonPosition,
  featureDotPosition,
  registerFeaturePopupSize,
  CLOSE_BUTTON_RADIUS,
  TITLE_HEIGHT,
} from './organelle';
import { controlsFor, CONTROL_DOT_OUTER_RADIUS, CONTROL_DOT_RADIUS, CONTROL_DOT_DROP_RADIUS } from './controlSpecs';
import { getControlSetter } from '../audio/graph';
import { getWireTo } from './wiring';
import { ACCENT } from './palette';

// Matches audio/graph.ts's own (private) SYNTH_WAVEFORMS list and native
// OscillatorNode.type strings exactly — kept as its own small, stable copy
// here rather than exported/shared, the same "this is genuinely UI display
// data, that's genuinely audio data" split ui/controlSpecs.ts's own header
// draws for color/range vs. DSP behavior.
const WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'] as const;
type SynthWaveform = (typeof WAVEFORMS)[number];
const DEFAULT_ENABLED: Record<SynthWaveform, boolean> = { sine: true, square: false, sawtooth: false, triangle: false };

const POPUP_WIDTH = 240; // wide enough for "tremolo depth"'s own label plus a usable slider track past it
const POPUP_HEIGHT = 150;
const PANEL_BG = 'rgba(22, 22, 22, 0.97)';
const ICON_W = 26;
const ICON_H = 14;
const TOGGLE_RADIUS = 5;
const TOGGLE_HIT_RADIUS = 8;
const PADDING = 10;
// Matches ui/render.ts's own (unexported) CONTROL_DOT_RING_COLOR — the
// backdrop a top-level control dot's outer ring is drawn in. Duplicated
// rather than imported: render.ts already imports FROM this module
// (drawSynthConfigPopup itself), so the reverse import would cycle.
const CONTROL_DOT_RING_COLOR = '#262626';

// Lets ui/organelle.ts's generic cross-canvas dot resolution
// (featureDotAbsolutePosition/hitTestFeatureDot — used while dragging a
// wire in FROM somewhere else, e.g. lfo-1's own bump) agree with this
// module's own drawing on exactly where the depth-port dots land, instead
// of being measured against envelope's own (differently-sized) popup — see
// that function's own comment for why this registration exists at all.
registerFeaturePopupSize('synthConfig', POPUP_WIDTH, POPUP_HEIGHT);

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function popupRect(graph: EntityGraph, owner: Entity, drag?: DragContext, feature?: Entity): Rect {
  return popupRectFor(graph, owner, POPUP_WIDTH, POPUP_HEIGHT, drag, feature);
}

function iconCenter(popup: Rect, index: number): Point {
  const left = popup.x - popup.width / 2;
  const slot = popup.width / WAVEFORMS.length;
  return { x: left + slot * (index + 0.5), y: popup.y - popup.height / 2 + TITLE_HEIGHT + 22 };
}

function toggleCenter(popup: Rect, index: number): Point {
  const icon = iconCenter(popup, index);
  return { x: icon.x, y: icon.y + 18 };
}

function isWaveEnabled(owner: Entity, wave: SynthWaveform): boolean {
  const value = owner.params[wave];
  return value === undefined ? DEFAULT_ENABLED[wave] : value > 0.5;
}

// Horizontal track for a depth port's own slider, running from just past
// its label to the popup's right edge — same "plain 0..1 linear, no
// expandable ceiling" shape as this port's own ControlSpec range
// (ui/controlSpecs.ts), unlike ui/tuningOrganelle.ts's own draggable-ceiling
// track, which these ports have no need for.
function depthTrackX(popup: Rect): { left: number; right: number } {
  const left = popup.x - popup.width / 2 + 108;
  const right = popup.x + popup.width / 2 - PADDING;
  return { left, right };
}

function depthFromX(popup: Rect, x: number): number {
  const { left, right } = depthTrackX(popup);
  return Math.min(1, Math.max(0, (x - left) / (right - left)));
}

function depthToX(popup: Rect, depth: number): number {
  const { left, right } = depthTrackX(popup);
  return left + Math.min(1, Math.max(0, depth)) * (right - left);
}

export type SynthConfigHit =
  | { entityId: string; kind: 'close' }
  | { entityId: string; kind: 'waveformToggle'; wave: SynthWaveform }
  | { entityId: string; kind: 'depthSlider'; param: string; value: number }
  | { entityId: string; kind: 'background' };

export function hitTestSynthConfigPopup(graph: EntityGraph, point: Point, drag?: DragContext): SynthConfigHit | null {
  for (const entity of graph.all()) {
    if (entity.type !== 'feature' || entity.kind !== 'synthConfig' || !entity.expanded) continue;
    const owner = ownerOf(graph, entity);
    if (!owner) continue;
    const popup = popupRect(graph, owner, drag, entity);

    if (dist(point, closeButtonPosition(popup)) <= CLOSE_BUTTON_RADIUS + 4) {
      return { entityId: entity.id, kind: 'close' };
    }

    for (let i = 0; i < WAVEFORMS.length; i++) {
      if (dist(point, toggleCenter(popup, i)) <= TOGGLE_HIT_RADIUS) {
        return { entityId: entity.id, kind: 'waveformToggle', wave: WAVEFORMS[i] };
      }
    }

    const specs = controlsFor('synthConfig');
    const { left: trackLeft, right: trackRight } = depthTrackX(popup);
    for (let i = 0; i < specs.length; i++) {
      const dot = featureDotPosition(popup, i);
      if (point.x >= trackLeft - 6 && point.x <= trackRight + 6 && Math.abs(point.y - dot.y) <= 9) {
        return { entityId: entity.id, kind: 'depthSlider', param: specs[i].param, value: depthFromX(popup, point.x) };
      }
    }

    const left = popup.x - popup.width / 2;
    const top = popup.y - popup.height / 2;
    if (point.x >= left && point.x <= left + popup.width && point.y >= top && point.y <= top + popup.height) {
      return { entityId: entity.id, kind: 'background' };
    }
  }
  return null;
}

// Recomputes the depth under the pointer's current x alone — same role as
// ui/tuningOrganelle.ts's own rawValueAtPoint, for continuing a slider drag
// on pointermove once the pointer may have wandered outside hitTestSynthConfigPopup's
// own tight vertical hit-band.
export function synthConfigDepthAtPoint(graph: EntityGraph, featureEntityId: string, point: Point, drag?: DragContext): number | null {
  const feature = graph.get(featureEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!feature || !owner) return null;
  return depthFromX(popupRect(graph, owner, drag, feature), point.x);
}

// Writes a dragged depth slider straight through to the synthConfig
// FEATURE's own params AND its registered control setter — same two-step
// shape every other live control write in this app uses (see
// ui/interaction.ts's applyControlValue), just without that function's
// wire-fanout half: these ports are wire TARGETS only, never a source (see
// this module's own header), so there's nothing to fan out regardless.
export function setSynthConfigValue(graph: EntityGraph, featureEntityId: string, param: string, value: number): void {
  const feature = graph.get(featureEntityId);
  if (!feature) return;
  const clamped = Math.min(1, Math.max(0, value));
  feature.params[param] = clamped;
  getControlSetter(featureEntityId, param)?.(clamped);
}

// Flips one waveform's own enable state — written through to the OWNER
// voice's params (not the synthConfig feature's), since that's where
// audio/graph.ts's createSynthVoice registered each waveform's own gain
// setter (keyed by the voice's id, matching every other core param like
// `level`).
export function toggleSynthWaveform(graph: EntityGraph, synthConfigEntityId: string, wave: SynthWaveform): void {
  const feature = graph.get(synthConfigEntityId);
  const owner = feature ? ownerOf(graph, feature) : undefined;
  if (!owner) return;
  const next = isWaveEnabled(owner, wave) ? 0 : 1;
  owner.params[wave] = next;
  getControlSetter(owner.id, wave)?.(next);
}

// --- Drawing -----------------------------------------------------------

// A small drawn waveform path, one full cycle for sine (a single hump reads
// fine at this size) or two for the harder-edged shapes (a single up/down
// step barely reads as "square" — two cycles make the signature shape
// actually recognizable this small). Exported so ui/render.ts can draw the
// same glyph (sine only — see its own drawLfo) at the LFO control's own
// small body, rather than that entity just looking like an unlabeled knob.
export function drawWaveGlyph(
  ctx: CanvasRenderingContext2D,
  center: Point,
  width: number,
  height: number,
  wave: SynthWaveform,
  active: boolean
): void {
  const cycles = wave === 'sine' ? 1 : 2;
  const steps = 32;
  ctx.save();
  ctx.strokeStyle = active ? ACCENT : 'rgba(255, 255, 255, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = center.x - width / 2 + t * width;
    const phase = (t * cycles) % 1;
    let y01: number; // -1..1
    if (wave === 'sine') y01 = Math.sin(t * cycles * Math.PI * 2);
    else if (wave === 'square') y01 = phase < 0.5 ? 1 : -1;
    else if (wave === 'sawtooth') y01 = phase * 2 - 1;
    else y01 = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4; // triangle
    const y = center.y - (y01 * height) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawToggle(ctx: CanvasRenderingContext2D, center: Point, on: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(center.x, center.y, TOGGLE_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (on) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, TOGGLE_RADIUS - 2, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }
  ctx.restore();
}

export function drawSynthConfigPopup(
  ctx: CanvasRenderingContext2D,
  graph: EntityGraph,
  entity: Entity,
  owner: Entity,
  activeDepthDrag: string | null,
  // The param (if any) a wire currently being dragged in from elsewhere is
  // hovering right now (ui/interaction.ts's InteractionState.wireHoverTarget,
  // already narrowed to this entity by ui/render.ts's own call site) — drawn
  // exactly like a top-level control dot's own "compatible drop site" cue
  // (ui/render.ts's drawControls), so dropping an LFO wire here reads the
  // same way dropping one on any other dot does.
  wireDropTarget: string | null,
  drag?: DragContext
): void {
  const popup = popupRect(graph, owner, drag, entity);
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
  ctx.fillText(entity.kind, left + 10, top + TITLE_HEIGHT / 2);

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

  // Waveform row — one icon+toggle per blendable oscillator shape.
  for (let i = 0; i < WAVEFORMS.length; i++) {
    const wave = WAVEFORMS[i];
    const enabled = isWaveEnabled(owner, wave);
    drawWaveGlyph(ctx, iconCenter(popup, i), ICON_W, ICON_H, wave, enabled);
    drawToggle(ctx, toggleCenter(popup, i), enabled);
  }

  // LFO depth ports — the dot is the generic wire-endpoint connection
  // point (ui/organelle.ts's featureDotPosition, same one
  // featureDotAbsolutePosition/hitTestFeatureDot resolve wires against),
  // label and slider are this popup's own.
  const specs = controlsFor('synthConfig');
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const dot = featureDotPosition(popup, i);
    const isWireDropTarget = wireDropTarget === spec.param;
    const active = activeDepthDrag === spec.param;
    // Depth has no audible effect at all until an LFO is actually wired
    // in — dimmed at rest so that's legible at a glance, rather than a
    // slider that LOOKS live but silently does nothing. Not dimmed while
    // it's actively being interacted with (a wire drag hovering it, or its
    // own slider being dragged), so those still read at full brightness.
    const connected = getWireTo(entity.id, spec.param) !== undefined;
    const dim = !connected && !isWireDropTarget && !active;

    // The connection dot itself is drawn at full brightness regardless —
    // same two-layer ring+dot ui/render.ts's drawControls uses for every
    // top-level control dot's own resting state, so this reads as "a wire
    // can land here" exactly the same way a module's own left-edge dots do,
    // whether or not anything's plugged in yet. Only the label/track/thumb
    // below (this port's OWN depth slider, meaningless without a wire) dim.
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, CONTROL_DOT_OUTER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = CONTROL_DOT_RING_COLOR;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, isWireDropTarget ? CONTROL_DOT_DROP_RADIUS : CONTROL_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = spec.color;
    ctx.fill();

    ctx.save();
    if (dim) ctx.globalAlpha = 0.3;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.label, dot.x + 8, dot.y);

    const { left: trackLeft, right: trackRight } = depthTrackX(popup);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(trackLeft, dot.y);
    ctx.lineTo(trackRight, dot.y);
    ctx.stroke();

    const value = entity.params[spec.param] ?? 0;
    const thumbX = depthToX(popup, value);
    ctx.strokeStyle = active ? ACCENT : spec.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(trackLeft, dot.y);
    ctx.lineTo(thumbX, dot.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(thumbX, dot.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = active ? ACCENT : spec.color;
    ctx.fill();

    ctx.restore();
  }

  ctx.restore();
}
