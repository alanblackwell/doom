// Bootstrap: builds a demo entity graph, wires up canvas drag/drop
// interaction and the (procedural, pre-texture) grunge-style renderer, and
// starts the audio engine on an explicit button press — a plain canvas
// click now means select/drag, so it can't double as the audio-start
// gesture the way it did before this feature.

import { resumeAudioContext, suspendAudioContext } from '../audio/context';
import { initAudioEngine, buildFromEntityGraph } from '../audio/graph';
import { EntityGraph } from '../audio/entityGraph';
import { renderFrame } from './render';
import { attachInteraction, createInteractionState } from './interaction';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const ctx2d = canvas.getContext('2d')!;
const startButton = document.querySelector<HTMLButtonElement>('#start-audio')!;

function resize(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Demo composition: a sub-bass drone, a bowed-string voice, and an overdrive
// pedal (sink+source — drag bass-1 or bow-1 onto it to route their audio
// through it, rather than just mixing). Swap this out once there's UI for
// adding entities.
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
  width: 160,
  height: 110,
  seed: 1,
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
  width: 160,
  height: 110,
  seed: 2,
});
// Pedals default smaller than instruments — compact until something's
// actually routed through them, so more can be placed without crowding the
// canvas (they grow to fit on drop, and live-preview that growth while a
// drag is still in progress — see effectiveBounds()/DragContext in
// ui/layout.ts).
graph.add({
  id: 'overdrive-1',
  type: 'source',
  kind: 'overdrive',
  parentId: null,
  children: [],
  params: { drive: 6, tone: 3000, level: 0.8 },
  x: 220,
  y: 380,
  width: 100,
  height: 64,
  seed: 3,
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
  width: 100,
  height: 64,
  seed: 4,
});

const interaction = createInteractionState();
attachInteraction(canvas, graph, interaction);

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
    setButtonState();
    return;
  }

  if (running) {
    await suspendAudioContext();
    running = false;
  } else {
    await resumeAudioContext();
    running = true;
  }
  setButtonState();
}

startButton.addEventListener('click', () => {
  toggleAudio();
});

function draw(now: number): void {
  renderFrame(ctx2d, canvas, graph, interaction, now);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
