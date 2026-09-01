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

// Kinds that are a one-shot "click the pad to trigger it" instrument rather
// than a continuous drone — exported so the UI knows which entities get a
// center pad (see ui/pads.ts) rather than just playing continuously once
// the graph is built. There's no event transport yet (ARCHITECTURE.md
// §5.3) — this is the manual/interactive way to fire a hit until that
// exists.
export const TRIGGERED_KINDS = new Set(['kick']);

// Registered by createGenerator() for triggered kinds — one no-argument
// function per entity that fires a single hit, reading whatever's currently
// in entity.params at the moment it's called (so param changes take effect
// on the next trigger, with no need for a separate live-control setter —
// there's nothing to push updates into between hits).
const triggersByEntity = new Map<string, () => void>();

function registerTrigger(entityId: string, trigger: () => void): void {
  triggersByEntity.set(entityId, trigger);
}

export function triggerEntity(entityId: string): void {
  triggersByEntity.get(entityId)?.();
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
    case 'kick': {
      const voiceOutput = ctx.createGain(); // summing point for each transient hit; not itself an envelope
      // Generated once and reused for every hit — it's just raw noise, no
      // reason to regenerate it per trigger the way reverb's decay-length
      // IR has to be.
      const clickBuffer = makeNoiseBuffer(ctx, 0.02);

      registerTrigger(entity.id, () => {
        const now = ctx.currentTime;
        const pitch = entity.params.pitch ?? 50;
        const decay = entity.params.decay ?? 0.4;
        const click = entity.params.click ?? 0.3;
        const level = entity.params.level ?? 0.8;

        // The body: a sine whose pitch sweeps down fast from ~4x the
        // fundamental — this downward sweep is what actually reads as a
        // "thump" rather than a plain tone; it's the main character of the
        // sound, more than the fundamental itself.
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(pitch * 4, now);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, pitch), now + 0.05);

        const ampEnv = ctx.createGain();
        ampEnv.gain.setValueAtTime(Math.max(0.0001, level), now);
        ampEnv.gain.exponentialRampToValueAtTime(0.001, now + decay);

        osc.connect(ampEnv);
        ampEnv.connect(voiceOutput);
        osc.start(now);
        osc.stop(now + decay + 0.05);
        osc.addEventListener('ended', () => {
          osc.disconnect();
          ampEnv.disconnect();
        });

        // The click: a short burst of the reusable noise buffer, highpassed
        // so it adds attack definition without stepping on the body's low end.
        if (click > 0) {
          const clickSource = ctx.createBufferSource();
          clickSource.buffer = clickBuffer;

          const clickFilter = ctx.createBiquadFilter();
          clickFilter.type = 'highpass';
          clickFilter.frequency.value = 800;

          const clickEnv = ctx.createGain();
          clickEnv.gain.setValueAtTime(Math.max(0.0001, click * level), now);
          clickEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

          clickSource.connect(clickFilter);
          clickFilter.connect(clickEnv);
          clickEnv.connect(voiceOutput);
          clickSource.start(now);
          clickSource.stop(now + 0.03);
          clickSource.addEventListener('ended', () => {
            clickSource.disconnect();
            clickFilter.disconnect();
            clickEnv.disconnect();
          });
        }
      });

      return voiceOutput;
    }
    default:
      return undefined;
  }
}

// Reusable short noise buffer for one-shot click/attack transients — plain
// white noise, generated once rather than per-trigger.
function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

// Kinds that process `input` into `output` rather than just mixing it
// through — exported so the renderer can mark these visually as sink+source
// ("pedal") entities rather than plain sources/containers.
export const PROCESSOR_KINDS = new Set(['overdrive', 'reverb', 'chorus', 'flanger']);

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

      registerControls(entity.id, {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        tone: (value) => tone.frequency.setTargetAtTime(value, ctx.currentTime, 0.01),
        // Drive affects two things that both need updating: the pre-shaper
        // boost, and the shaper curve itself (a fixed lookup table computed
        // from the same amount, not something with its own live parameter).
        drive: (value) => {
          drive.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
          shaper.curve = makeOverdriveCurve(value);
        },
      });

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

      // Regenerating the impulse response is real work (up to ~1M samples
      // for the longest decay) — fine once, but not something to redo on
      // every single pointermove tick of a live-dragged slider without
      // risking jank. Throttled: coalesces rapid updates and applies only
      // the latest value at most once per window, so it still tracks the
      // drag closely without hammering the main thread.
      let decayRegenTimer: ReturnType<typeof setTimeout> | null = null;
      let latestDecay = entity.params.decay ?? 3.5;

      registerControls(entity.id, {
        level: (value) => outLevel.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        tone: (value) => wetTone.frequency.setTargetAtTime(value, ctx.currentTime, 0.01),
        mix: (value) => {
          const m = Math.min(1, Math.max(0, value));
          dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.01);
          wet.gain.setTargetAtTime(m, ctx.currentTime, 0.01);
        },
        decay: (value) => {
          latestDecay = value;
          if (decayRegenTimer) return;
          decayRegenTimer = setTimeout(() => {
            convolver.buffer = makeReverbImpulseResponse(ctx, latestDecay);
            decayRegenTimer = null;
          }, 80);
        },
      });

      return outLevel;
    }
    case 'chorus':
      return createModulatedDelay(entity, input, {
        baseDelaySeconds: 0.025, // ~25ms — classic chorus center delay
        feedback: false, // the defining difference from flanger: none
      });
    case 'flanger':
      return createModulatedDelay(entity, input, {
        baseDelaySeconds: 0.008, // ~8ms — much shorter than chorus, strong comb filtering
        feedback: true, // the resonant "jet swoosh" comes from this regeneration loop
      });
    default:
      return null;
  }
}

// Shared DSP for chorus and flanger: both are an LFO-modulated delay mixed
// with the dry signal — a native DelayNode whose delayTime is swept by an
// OscillatorNode (connecting an audio-rate signal straight into an
// AudioParam sums with its base .value automatically, which is what makes
// this the LFO). What actually distinguishes the two, beyond delay-time
// range, is the feedback loop flanger has and chorus doesn't — a delay
// tap without feedback broadens/thickens (chorus); the same tap regenerated
// back into itself builds the resonant comb-filter "jet" sound (flanger).
function createModulatedDelay(
  entity: Entity,
  input: GainNode,
  opts: { baseDelaySeconds: number; feedback: boolean }
): AudioNode {
  const ctx = getAudioContext();

  const preDelay = ctx.createGain(); // summing junction: input (+ feedback, for flanger)
  const delay = ctx.createDelay(1); // 1s max — comfortably above either effect's range
  delay.delayTime.value = opts.baseDelaySeconds;

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = entity.params.rate ?? (opts.feedback ? 0.2 : 0.8);

  const lfoDepth = ctx.createGain();
  // depth is a UI param in milliseconds; the LFO's ±1 swing needs to be
  // scaled into seconds to modulate delayTime directly.
  lfoDepth.gain.value = (entity.params.depth ?? (opts.feedback ? 2 : 3)) / 1000;

  lfo.connect(lfoDepth);
  lfoDepth.connect(delay.delayTime);
  lfo.start();

  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const mix = Math.min(1, Math.max(0, entity.params.mix ?? 0.5));
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;

  const mixBus = ctx.createGain();
  const outLevel = ctx.createGain();
  outLevel.gain.value = entity.params.level ?? 0.8;

  input.connect(preDelay);
  preDelay.connect(delay);
  delay.connect(wet);
  wet.connect(mixBus);

  input.connect(dry);
  dry.connect(mixBus);

  mixBus.connect(outLevel);

  const controls: Record<string, (value: number) => void> = {
    level: (value) => outLevel.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    rate: (value) => lfo.frequency.setTargetAtTime(value, ctx.currentTime, 0.01),
    depth: (value) => lfoDepth.gain.setTargetAtTime(value / 1000, ctx.currentTime, 0.01),
    mix: (value) => {
      const m = Math.min(1, Math.max(0, value));
      dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.01);
      wet.gain.setTargetAtTime(m, ctx.currentTime, 0.01);
    },
  };

  if (opts.feedback) {
    const feedbackGain = ctx.createGain();
    // Hard-capped below 1 regardless of what a control setter is asked to
    // set — this is a genuine feedback loop through the delay line, so
    // reaching unity gain would mean unbounded buildup, not just "more
    // flange." 0.95 is already an intense, near-self-oscillating setting.
    const initialFeedback = Math.min(0.95, Math.max(0, entity.params.feedback ?? 0.5));
    feedbackGain.gain.value = initialFeedback;
    delay.connect(feedbackGain);
    feedbackGain.connect(preDelay);

    controls.feedback = (value) => {
      const f = Math.min(0.95, Math.max(0, value));
      feedbackGain.gain.setTargetAtTime(f, ctx.currentTime, 0.01);
    };
  }

  registerControls(entity.id, controls);

  return outLevel;
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
    // Control entities (knobs, etc.) don't make or process sound — they
    // only ever write into entity.params + a control setter, the same path
    // a manual slider drag already uses (see ui/wiring.ts). No AudioNodes,
    // no place in the mix.
    if (entity.type === 'control') continue;

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
