// Bootstrap: builds a demo entity graph, wires up canvas drag/drop
// interaction and the (procedural, pre-texture) grunge-style renderer, and
// starts the audio engine on an explicit button press — a plain canvas
// click now means select/drag, so it can't double as the audio-start
// gesture the way it did before this feature.

import { resumeAudioContext, suspendAudioContext } from '../audio/context';
import { initAudioEngine, buildFromEntityGraph } from '../audio/graph';
import { getTempo, start as startTransport, stop as stopTransport } from '../audio/transport';
import { EntityGraph } from '../audio/entityGraph';
import { renderFrame } from './render';
import { attachInteraction, attachKeyboard, createInteractionState } from './interaction';
import { attachClockPulse } from './clockPulse';
import { attachSampleDrop } from './sampleDrop';
import { exportSamplesZip, hasExportableSamples } from './sampleArchive';
import { attachTextureEditor } from './textureEditor';
import { effectiveBounds } from './layout';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const ctx2d = canvas.getContext('2d')!;
const startButton = document.querySelector<HTMLButtonElement>('#start-audio')!;
const exportButton = document.querySelector<HTMLButtonElement>('#export-samples')!;

// Demo composition: a sub-bass drone, a bowed-string voice, and an overdrive
// pedal (sink+source — drag bass-1 or bow-1 onto it to route their audio
// through it, rather than just mixing). Swap this out once there's UI for
// adding entities. All start docked (ui/dock.ts) — silent, parked in the
// right-hand dock — rather than already sounding on the canvas; drag one out
// to bring it in. x/y below are only where each one lands the very first
// time it's dragged out (or if docked: true is ever flipped off here) —
// meaningless while docked, see Entity.docked's comment.
const graph = new EntityGraph();
graph.add({
  id: 'bass-1',
  type: 'source',
  kind: 'bass',
  parentId: null,
  children: [],
  params: { level: 0.5, frequency: 41.2 },
  x: 180,
  y: 160,
  width: 110,
  height: 70,
  seed: 1,
  docked: true,
  ownerId: null,
  expanded: false,
});
graph.add({
  id: 'bow-1',
  type: 'source',
  kind: 'bow',
  parentId: null,
  children: [],
  // bowVelocity/bowPressure are by-ear tuning knobs — see audio/graph.ts's
  // comment. bowPressure: 0.5 reproduces this voice's original hardcoded
  // default (see BOW_TABLE_SLOPE's comment in dsp/rust/src/lib.rs).
  params: { level: 0.6, frequency: 180, bowVelocity: 0.05, bowPressure: 0.5 },
  x: 480,
  y: 160,
  width: 110,
  height: 70,
  seed: 2,
  docked: true,
  ownerId: null,
  expanded: false,
});
// One-shot, not a drone — click the pad at its center to fire a hit rather
// than it playing continuously once audio starts. See audio/graph.ts's
// TRIGGERED_KINDS; there's no event transport yet (ARCHITECTURE.md §5.3),
// so this is the manual way to trigger it for now.
graph.add({
  id: 'kick-1',
  type: 'source',
  kind: 'kick',
  parentId: null,
  children: [],
  params: { level: 0.8, pitch: 50, decay: 0.4, click: 0.3 },
  x: 780,
  y: 160,
  width: 110,
  height: 70,
  seed: 7,
  docked: true,
  ownerId: null,
  expanded: false,
});
// Karplus-Strong plucked string (dsp/rust/src/lib.rs) — also one-shot/pad-
// triggered like kick-1 above, tuned by ear (via ui/render.ts's per-slider
// value readout) for a thumb-plucked bass string: a heavily muted attack
// (low response) and a long, dark decay (high damping).
graph.add({
  id: 'pluck-1',
  type: 'source',
  kind: 'pluck',
  parentId: null,
  children: [],
  params: { level: 0.89, pitch: 34.4, damping: 0.91, response: 0.21 },
  x: 1080,
  y: 160,
  width: 110,
  height: 70,
  seed: 11,
  docked: true,
  ownerId: null,
  expanded: false,
});
// pluck-1's ADSR envelope organelle (EntityType 'feature', ui/organelle.ts) —
// the first "internal feature" of a source: drawn nested within pluck-1's
// own box (a small porthole) rather than as a sibling on the canvas, and
// owned by it via ownerId rather than parentId/containment (see
// audio/entityGraph.ts's Entity.ownerId). Gates on press-and-hold of
// pluck-1's own pad (ui/interaction.ts) — a quick tap still just plucks
// briefly, cut short before reaching Sustain. x/y/width/height/seed are
// unused for a feature entity; its popup's position is computed fresh each
// frame from pluck-1's current bounds instead (see ui/organelle.ts).
graph.add({
  id: 'pluck-1-envelope',
  type: 'feature',
  kind: 'envelope',
  parentId: null,
  children: [],
  // timeScale (seconds) is UI-only display state, not an audio param — how
  // much of the time axis the popup currently shows (ui/organelle.ts); drag
  // its right-edge zoom grip to change it.
  params: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3, timeScale: 2 },
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  seed: 12,
  docked: false,
  ownerId: 'pluck-1',
  expanded: false,
});
// Same Karplus-Strong voice as pluck-1 (audio/graph.ts's createPluckVoice),
// tuned the opposite way: bright pick attack, little natural damping, and
// positive feedback (dsp/rust/src/lib.rs's PLUCK_FEEDBACK) so the string
// sustains and squeals instead of decaying — a doom/metal guitar starting
// point, not a finished amp tone. Drag it into overdrive-1 for distortion;
// this voice only supplies the string/feedback side.
graph.add({
  id: 'metal-1',
  type: 'source',
  kind: 'metal',
  parentId: null,
  children: [],
  params: { level: 0.8, pitch: 82.4, damping: 0.25, response: 0.85, feedback: 0.45, feedbackFreq: 1200 },
  x: 1380,
  y: 160,
  width: 110,
  height: 70,
  seed: 13,
  docked: true,
  ownerId: null,
  expanded: false,
});
// metal-1's own ADSR envelope organelle — same mechanism as pluck-1-
// envelope above, tuned for a note that rings out rather than plucks and
// stops: a high sustain level (feedback is already keeping the string loud)
// and a long release so the squeal actually has room to fade.
graph.add({
  id: 'metal-1-envelope',
  type: 'feature',
  kind: 'envelope',
  parentId: null,
  children: [],
  params: { attack: 0.02, decay: 0.15, sustain: 0.85, release: 1.5, timeScale: 3 },
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  seed: 14,
  docked: false,
  ownerId: 'metal-1',
  expanded: false,
});
// Pedals default smaller than instruments — compact until something's
// actually routed through them, so more can be placed without crowding the
// canvas (they grow to fit on drop, and live-preview that growth while a
// drag is still in progress — see effectiveBounds()/DragContext in
// ui/layout.ts). Small enough that an empty one is just its hollow outline
// and kind label (ui/render.ts's drawBox) — there's no dot column to leave
// room for either, until something's actually dropped in (see
// effectiveBounds's isEmptyFilter exemption).
graph.add({
  id: 'overdrive-1',
  type: 'source',
  kind: 'overdrive',
  parentId: null,
  children: [],
  params: { drive: 6, tone: 3000, level: 0.8 },
  x: 220,
  y: 380,
  width: 64,
  height: 44,
  seed: 3,
  docked: true,
  ownerId: null,
  expanded: false,
});
graph.add({
  id: 'reverb-1',
  type: 'source',
  kind: 'reverb',
  parentId: null,
  children: [],
  params: { decay: 4, mix: 0.4, tone: 3500, level: 0.8 },
  x: 500,
  y: 380,
  width: 64,
  height: 44,
  seed: 4,
  docked: true,
  ownerId: null,
  expanded: false,
});
graph.add({
  id: 'chorus-1',
  type: 'source',
  kind: 'chorus',
  parentId: null,
  children: [],
  params: { rate: 0.8, depth: 3, mix: 0.5, level: 0.8 },
  x: 220,
  y: 560,
  width: 64,
  height: 44,
  seed: 5,
  docked: true,
  ownerId: null,
  expanded: false,
});
graph.add({
  id: 'flanger-1',
  type: 'source',
  kind: 'flanger',
  parentId: null,
  children: [],
  params: { rate: 0.2, depth: 2, feedback: 0.5, mix: 0.5, level: 0.8 },
  x: 500,
  y: 560,
  width: 64,
  height: 44,
  seed: 6,
  docked: true,
  ownerId: null,
  expanded: false,
});
// A harder-clipping cousin of overdrive-1 (audio/graph.ts's makeFuzzCurve)
// — drag metal-1 in here (or any source) for a fuzzbox tone rather than
// overdrive's smoother saturation.
graph.add({
  id: 'fuzz-1',
  type: 'source',
  kind: 'fuzz',
  parentId: null,
  children: [],
  params: { fuzz: 10, tone: 2500, level: 0.7 },
  x: 780,
  y: 380,
  width: 64,
  height: 44,
  seed: 15,
  docked: true,
  ownerId: null,
  expanded: false,
});
// A Control entity (type: 'control'), not a source — no audio node of its
// own (audio/graph.ts skips it entirely), just a value that can be wired to
// any control dot on another entity. Drag from its small round bump
// (protruding from the right side) onto e.g. bow-1's pitch dot to try it;
// right-click a wired dot to disconnect. Left unwired by default.
graph.add({
  id: 'knob-1',
  type: 'control',
  kind: 'knob',
  parentId: null,
  children: [],
  params: { value: 0.5 },
  x: 60,
  y: 90,
  width: 30,
  height: 30,
  seed: 8,
  docked: false, // controls never dock — see ui/docking.ts's isDockable
  ownerId: null,
  expanded: false,
});
// The master clock (audio/transport.ts), as a Control entity like knob-1
// above — same drag-a-wire-from-the-bump mechanism, just carrying bpm
// (20-300) instead of a normalized 0-1 value. See ui/render.ts's drawClock
// for why it looks different (a live number instead of a rotating dial) and
// ui/clockPulse.ts for the beat-synced glow on its output bump.
graph.add({
  id: 'clock-1',
  type: 'control',
  kind: 'clock',
  parentId: null,
  children: [],
  params: { bpm: getTempo() },
  x: 60,
  y: 160,
  width: 30,
  height: 30,
  seed: 9,
  docked: false,
  ownerId: null,
  expanded: false,
});
// A momentary trigger, also a Control entity — no continuous value (no
// entry in controlSpecs.ts's CONTROL_SPECS, so no dot/slider at all),
// just a single event fired by clicking its body or pressing a bound key.
// Hover it and press any key to bind that key (shown at its center in
// place of the usual "TAP" placeholder); once bound, that key fires it
// from anywhere. See ui/interaction.ts's fireTap/attachKeyboard and
// ui/tapBindings.ts.
graph.add({
  id: 'tap-1',
  type: 'control',
  kind: 'tap',
  parentId: null,
  children: [],
  params: {},
  x: 60,
  y: 230,
  width: 30,
  height: 30,
  seed: 10,
  docked: false,
  ownerId: null,
  expanded: false,
});

// Margin kept past the furthest entity's edge so it doesn't sit flush
// against the scrollable area's border.
const CONTENT_MARGIN = 40;

// The canvas's drawing-buffer size: always at least the viewport, but grown
// to enclose every top-level entity's effectiveBounds() once content
// extends past it, so #viewport (see index.html) picks up scrollbars
// instead of clipping anything. Re-run every frame (see draw() below) since
// dragging can grow the content bounds at any time, not just on resize.
function resize(): void {
  let maxRight = 0;
  let maxBottom = 0;
  for (const entity of graph.topLevel()) {
    const bounds = effectiveBounds(graph, entity);
    maxRight = Math.max(maxRight, bounds.x + bounds.width / 2);
    maxBottom = Math.max(maxBottom, bounds.y + bounds.height / 2);
  }
  const width = Math.max(window.innerWidth, maxRight + CONTENT_MARGIN);
  const height = Math.max(window.innerHeight, maxBottom + CONTENT_MARGIN);
  // Assigning canvas.width/height clears the drawing buffer, so only touch
  // it when the size actually changed — harmless here since every frame is
  // fully redrawn anyway, but avoids fighting the browser's scroll-anchoring
  // while a scrollbar is being dragged.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
window.addEventListener('resize', resize);
resize();

const interaction = createInteractionState();
// Registered before attachInteraction: while the texture editor is open it
// gates ui/interaction.ts's own handlers off entirely (isTextureEditorActive
// — see ui/textureEditor.ts's comment), but registering it first keeps
// startup order matching "the modal owns the canvas first."
attachTextureEditor(canvas, graph);
attachInteraction(canvas, graph, interaction);
attachKeyboard(graph, interaction);
attachClockPulse('clock-1', interaction);
attachSampleDrop(canvas, graph);

// Two independent states: whether the engine/graph has been built at all
// (one-time — worklets registered, WASM compiled, nodes created), and
// whether the AudioContext is currently running vs. suspended (toggled
// freely thereafter — suspend/resume is cheap, unlike rebuilding the graph).
let engineBuilt = false;
let running = false;

function setButtonState(): void {
  startButton.classList.toggle('running', running);
  startButton.textContent = running ? 'stop audio' : 'start audio';
}

async function toggleAudio(): Promise<void> {
  if (!engineBuilt) {
    engineBuilt = true;
    startButton.disabled = true;
    startButton.textContent = 'starting…';

    await resumeAudioContext();
    await initAudioEngine();
    await buildFromEntityGraph(graph);

    // Dev-only console inspection hook (excluded from production builds by
    // import.meta.env.DEV) — lets you check from real devtools whether
    // signal is reaching the master node, the same check used to diagnose
    // issues headless testing can't reach (device selection, tab mute,
    // real output).
    if (import.meta.env.DEV) {
      const { getAudioContext } = await import('../audio/context');
      const { getMasterChain } = await import('../audio/master');
      const { getEntityNodes } = await import('../audio/graph');
      (window as unknown as { __doom: unknown }).__doom = {
        ctx: getAudioContext(),
        master: getMasterChain(),
        getEntityNodes,
      };
    }

    startButton.disabled = false;
    running = true;
    startTransport();
    setButtonState();
    return;
  }

  if (running) {
    await suspendAudioContext();
    running = false;
    stopTransport();
  } else {
    await resumeAudioContext();
    running = true;
    startTransport();
  }
  setButtonState();
}

startButton.addEventListener('click', () => {
  toggleAudio();
});

exportButton.addEventListener('click', () => {
  exportSamplesZip(graph);
});

function draw(now: number): void {
  resize();
  // Cheap enough (a handful of entities, one Map lookup each) to just
  // recompute every frame rather than threading an update call through
  // every place a sample can be added/removed.
  exportButton.disabled = !hasExportableSamples(graph);
  renderFrame(ctx2d, canvas, graph, interaction, now);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
