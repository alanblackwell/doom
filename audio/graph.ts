// Reconciles the entity graph (audio/entityGraph.ts) into a live Web Audio
// graph. This is the implementation of ARCHITECTURE.md §3.3: containment
// defines routing — an entity's `output` connects to its parent's `input`
// mixer, or straight to the master chain if it's top-level.
//
// `input` isn't always a plain mixer feeding straight through to `output`:
// a "sink+source" kind (an effect — a pedal, a filter) routes `input`
// through real processing before it reaches `output` instead. Containment
// is still the same drag-into-a-boundary interaction either way — what
// differs is whether what's dropped in gets mixed or processed. See
// createProcessor() below.

import { getAudioContext } from './context';
import { getMasterChain } from './master';
import type { Entity, EntityGraph } from './entityGraph';

interface EntityNodes {
  input: GainNode; // children connect here (this entity's internal mixer)
  output: GainNode; // parent connects from here (own generator + children, summed)
}

const nodesByEntity = new Map<string, EntityNodes>();

// Live per-parameter setters, registered by createGenerator()/createProcessor()
// for whichever of an entity's params can actually be adjusted in real time
// (not every param can — e.g. overdrive's WaveShaper curve is a fixed lookup
// table recomputed at construction, not something you can smoothly sweep).
// ui/interaction.ts's control-dot sliders (ui/controls.ts) call through this
// rather than touching AudioNodes directly, so the UI layer never needs to
// know whether a param happens to be a native AudioParam or something that
// has to go through a worklet message.
const controlsByEntity = new Map<string, Record<string, (value: number) => void>>();

function registerControls(entityId: string, controls: Record<string, (value: number) => void>): void {
  controlsByEntity.set(entityId, controls);
}

export function getControlSetter(
  entityId: string,
  param: string
): ((value: number) => void) | undefined {
  return controlsByEntity.get(entityId)?.[param];
}

// Compiled once in initAudioEngine(), then passed (structured-cloned, not
// re-fetched/re-compiled) into every WASM-backed AudioWorkletNode's
// processorOptions — each entity gets its own WASM instance/state (a fresh
// WebAssembly.instantiate() per node), sharing the one compiled module. Both
// noise-processor.js and bass-processor.js are shims over the same
// dsp/rust module (see ARCHITECTURE.md §5.2), just calling different exports.
let dspModule: WebAssembly.Module | null = null;

// Loads any AudioWorklet modules and WASM DSP the graph depends on. Call once
// before buildFromEntityGraph(). Safe to extend with more addModule() calls
// as more worklet-backed DSP kinds are added.
export async function initAudioEngine(): Promise<void> {
  const ctx = getAudioContext();

  const wasmUrl = new URL('../dsp/rust/pkg/doom_dsp.wasm', import.meta.url);
  const [, , , wasmModule] = await Promise.all([
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/noise-processor.js', import.meta.url)
    ),
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/bass-processor.js', import.meta.url)
    ),
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/bow-processor.js', import.meta.url)
    ),
    WebAssembly.compileStreaming(fetch(wasmUrl)),
  ]);
  dspModule = wasmModule;

  getMasterChain();
}

const WASM_KINDS = new Set(['noise', 'bass', 'bow']);

// Creates the node(s) that make an entity's own sound, if it has any.
// A plain group/mixer entity (no matching case) returns undefined — it
// contributes nothing but its children's sound, summed at `output`.
function createGenerator(entity: Entity): AudioNode | undefined {
  const ctx = getAudioContext();

  if (!dspModule && WASM_KINDS.has(entity.kind)) {
    throw new Error('initAudioEngine() must complete before building the graph');
  }

  switch (entity.kind) {
    case 'noise': {
      const noise = new AudioWorkletNode(ctx, 'noise-processor', {
        processorOptions: { wasmModule: dspModule },
      });
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.3;
      noise.connect(level);
      return level;
    }
    case 'bass': {
      const bass = new AudioWorkletNode(ctx, 'bass-processor', {
        processorOptions: {
          wasmModule: dspModule,
          frequency: entity.params.frequency ?? 41.2, // low E
        },
      });
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.5;
      bass.connect(level);

      registerControls(entity.id, {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        // Genuinely click-free, unlike the bow's frequency control — see
        // bass_set_frequency's comment in dsp/rust/src/lib.rs.
        frequency: (value) => bass.port.postMessage({ type: 'setFrequency', value }),
      });

      return level;
    }
    case 'bow': {
      const bow = new AudioWorkletNode(ctx, 'bow-processor', {
        processorOptions: {
          wasmModule: dspModule,
          frequency: entity.params.frequency ?? 220, // cello A string
          // STK's own reference implementation only ever drives this ~0.03-0.25 —
          // outside a fairly narrow "playable" region, expect chaotic scraping
          // rather than a clean note. Tune by ear via this param.
          bowVelocity: entity.params.bowVelocity ?? 0.1,
          // STK's normalized [0,1] convention; 0.5 reproduces the original
          // hardcoded default (see BOW_TABLE_SLOPE's comment in lib.rs).
          bowPressure: entity.params.bowPressure ?? 0.5,
        },
      });
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.5;
      bow.connect(level);

      // None of these are native AudioParams — frequency, bow speed, and
      // bow pressure are all baked into the WASM voice's internal state
      // rather than read per-sample, so live changes go through the
      // worklet's message port instead (see dsp/worklets/bow-processor.js).
      registerControls(entity.id, {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        frequency: (value) => bow.port.postMessage({ type: 'setFrequency', value }),
        bowVelocity: (value) => bow.port.postMessage({ type: 'setVelocity', value }),
        bowPressure: (value) => bow.port.postMessage({ type: 'setPressure', value }),
      });

      return level;
    }
    default:
      return undefined;
  }
}

// Kinds that process `input` into `output` rather than just mixing it
// through — exported so the renderer can mark these visually as sink+source
// ("pedal") entities rather than plain sources/containers.
export const PROCESSOR_KINDS = new Set(['overdrive', 'reverb']);

// Classic WaveShaperNode distortion curve (the one widely cited from
// Kevin Ennis's WebAudio overdrive example) — soft-to-hard clipping
// parameterized by a single `amount`. Recomputed whenever drive changes
// since WaveShaperNode.curve is a fixed lookup table, not a live parameter.
function makeOverdriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// Synthetic impulse response for ConvolverNode: white noise per channel
// shaped by an exponential decay envelope, reaching roughly -60dB (an RT60
// convention) by the end of `decaySeconds` — the standard algorithmic way to
// get a convolution reverb without a recorded IR file, which we don't have
// (textures/ equivalent for audio doesn't exist yet either). Runs on the
// main thread at entity-construction time, not per-frame — a few tens of ms
// for a multi-second buffer, not something to worry about happening once.
function makeReverbImpulseResponse(ctx: AudioContext, decaySeconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * decaySeconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  const decayRate = 6.908; // ln(1000) — envelope reaches ~-60dB by t=1

  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.exp(-decayRate * t);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

// Builds the processing chain for a sink+source ("pedal") kind, wired from
// `input`, returning the tail node to connect to `output` — or null for
// anything that isn't a processor, in which case createNodes() falls back
// to a plain passthrough (mixer) connection instead.
function createProcessor(entity: Entity, input: GainNode): AudioNode | null {
  const ctx = getAudioContext();

  switch (entity.kind) {
    case 'overdrive': {
      const drive = ctx.createGain();
      drive.gain.value = entity.params.drive ?? 6;

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeOverdriveCurve(entity.params.drive ?? 6);
      shaper.oversample = '4x'; // reduces aliasing from the nonlinear folding

      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = entity.params.tone ?? 3000;

      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.8;

      input.connect(drive);
      drive.connect(shaper);
      shaper.connect(tone);
      tone.connect(level);
      return level;
    }
    case 'reverb': {
      const mix = Math.min(1, Math.max(0, entity.params.mix ?? 0.4));

      const dry = ctx.createGain();
      dry.gain.value = 1 - mix;

      const convolver = ctx.createConvolver();
      convolver.normalize = true;
      convolver.buffer = makeReverbImpulseResponse(ctx, entity.params.decay ?? 3.5);

      // Darkens the wet path — a bright shimmery hall reads wrong for this
      // genre; a murkier, cavernous tail fits better.
      const wetTone = ctx.createBiquadFilter();
      wetTone.type = 'lowpass';
      wetTone.frequency.value = entity.params.tone ?? 3500;

      const wet = ctx.createGain();
      wet.gain.value = mix;

      const mixBus = ctx.createGain(); // unity summing junction for dry + wet
      const outLevel = ctx.createGain();
      outLevel.gain.value = entity.params.level ?? 0.8;

      input.connect(dry);
      dry.connect(mixBus);

      input.connect(convolver);
      convolver.connect(wetTone);
      wetTone.connect(wet);
      wet.connect(mixBus);

      mixBus.connect(outLevel);
      return outLevel;
    }
    default:
      return null;
  }
}

function createNodes(entity: Entity): EntityNodes {
  const ctx = getAudioContext();

  const input = ctx.createGain();
  const output = ctx.createGain();

  const processorTail = createProcessor(entity, input);
  if (processorTail) {
    processorTail.connect(output);
  } else {
    input.connect(output);
  }

  const generator = createGenerator(entity);
  if (generator) generator.connect(output);

  const nodes: EntityNodes = { input, output };
  nodesByEntity.set(entity.id, nodes);
  return nodes;
}

export async function buildFromEntityGraph(graph: EntityGraph): Promise<void> {
  const master = getMasterChain();

  // One entity's node construction failing (a bad kind, a bug in its
  // processor/generator setup) must not silence every other entity — this
  // is a patcher where kinds get added incrementally, so a broken one
  // entity shouldn't be able to take the whole graph down.
  for (const entity of graph.all()) {
    try {
      createNodes(entity);
    } catch (err) {
      console.error(
        `Failed to build audio for entity "${entity.id}" (kind: ${entity.kind}) — it will be silent; other entities are unaffected.`,
        err
      );
    }
  }

  for (const entity of graph.all()) {
    const nodes = nodesByEntity.get(entity.id);
    if (!nodes) continue; // construction failed above, already logged

    const parentNodes = entity.parentId ? nodesByEntity.get(entity.parentId) : undefined;

    if (parentNodes) {
      nodes.output.connect(parentNodes.input);
    } else {
      nodes.output.connect(master);
    }
  }
}

export function getEntityNodes(id: string): EntityNodes | undefined {
  return nodesByEntity.get(id);
}

// Live re-routing for a drag-driven reparent (ui/interaction.ts) — an
// entity's `output` only ever has one outgoing connection (its parent's
// input, or master), so disconnecting everything and reconnecting once is
// correct, not just convenient. A no-op if the entity has no audio nodes yet
// (e.g. the graph was rearranged before the user started audio).
export function reparentEntity(id: string, newParentId: string | null): void {
  const nodes = nodesByEntity.get(id);
  if (!nodes) return;

  nodes.output.disconnect();

  const parentNodes = newParentId ? nodesByEntity.get(newParentId) : undefined;
  if (parentNodes) {
    nodes.output.connect(parentNodes.input);
  } else {
    nodes.output.connect(getMasterChain());
  }
}
