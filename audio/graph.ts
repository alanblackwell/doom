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
import { getTempo, setTempo } from './transport';
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
export const TRIGGERED_KINDS = new Set(['kick', 'pluck', 'metal']);

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

// Registered by createGenerator() only for an entity that has an ADSR
// envelope feature attached (audio/entityGraph.ts's EntityType 'feature') —
// the gate-off half of ui/interaction.ts's press-and-hold pad gesture,
// firing the envelope's Release ramp. A no-op (not registered at all) for
// any TRIGGERED_KINDS entity without one, so ui/interaction.ts can call
// this unconditionally on every pad release rather than first checking
// whether an envelope exists.
const releasesByEntity = new Map<string, () => void>();

function registerRelease(entityId: string, release: () => void): void {
  releasesByEntity.set(entityId, release);
}

export function releaseEntity(entityId: string): void {
  releasesByEntity.get(entityId)?.();
}

// Wall-clock (performance.now()) timing for an in-progress envelope, so
// ui/organelle.ts's rAF-driven cursor animation can compute "where along
// the curve is playback right now" without needing to reconcile against
// AudioContext.currentTime's own (differently-epoched) clock — the cursor
// only needs to read roughly in sync with the ear, not sample-accurately,
// so tracking it independently on the same clock the render loop already
// uses is simpler and sufficient. attack/decay are snapshotted at gate-on
// (registerTrigger below) and release at gate-off (registerRelease) —
// exactly the same "read fresh at the moment it happens" values the actual
// audio ramps were scheduled with, so the visual always matches what's
// actually sounding even if the popup's sliders keep moving afterward.
export interface EnvelopePlayback {
  gateOnAt: number;
  attack: number;
  decay: number;
  gateOffAt: number | null;
  release: number;
}

const envelopePlaybackByFeature = new Map<string, EnvelopePlayback>();

export function getEnvelopePlayback(featureId: string): EnvelopePlayback | undefined {
  return envelopePlaybackByFeature.get(featureId);
}

// Compiled once in initAudioEngine(), then passed (structured-cloned, not
// re-fetched/re-compiled) into every WASM-backed AudioWorkletNode's
// processorOptions — each entity gets its own WASM instance/state (a fresh
// WebAssembly.instantiate() per node), sharing the one compiled module. Both
// noise-processor.js and bass-processor.js are shims over the same
// dsp/rust module (see ARCHITECTURE.md §5.2), just calling different exports.
let dspModule: WebAssembly.Module | null = null;

// True once initAudioEngine() has completed — guards activateEntity() below,
// called when an instrument is dragged out of the dock (ui/docking.ts),
// which may happen before "start audio" has ever been pressed.
let engineReady = false;

// Loads any AudioWorklet modules and WASM DSP the graph depends on. Call once
// before buildFromEntityGraph(). Safe to extend with more addModule() calls
// as more worklet-backed DSP kinds are added.
export async function initAudioEngine(): Promise<void> {
  const ctx = getAudioContext();

  const wasmUrl = new URL('../dsp/rust/pkg/doom_dsp.wasm', import.meta.url);
  const [, , , , wasmModule] = await Promise.all([
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/noise-processor.js', import.meta.url)
    ),
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/bass-processor.js', import.meta.url)
    ),
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/bow-processor.js', import.meta.url)
    ),
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/pluck-processor.js', import.meta.url)
    ),
    WebAssembly.compileStreaming(fetch(wasmUrl)),
  ]);
  dspModule = wasmModule;

  getMasterChain();
  engineReady = true;
}

const WASM_KINDS = new Set(['noise', 'bass', 'bow', 'pluck', 'metal']);

// Creates the node(s) that make an entity's own sound, if it has any.
// A plain group/mixer entity (no matching case) returns undefined — it
// contributes nothing but its children's sound, summed at `output`. Takes
// `graph` only so a generator can look up its own internal-feature
// organelles (EntityGraph.featuresOf — see the 'pluck' case's envelope
// below); every other kind ignores it.
function createGenerator(entity: Entity, graph: EntityGraph): AudioNode | undefined {
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
    // Same Karplus-Strong voice as 'pluck' (see createPluckVoice below),
    // tuned by ear the opposite way: a heavily muted thumb attack and a
    // long, dark decay, and no feedback control — a fingerstyle bass note
    // doesn't self-sustain via amp feedback the way a loud electric guitar
    // does (see 'metal' below).
    case 'pluck':
      return createPluckVoice(entity, graph, {
        pitch: 34.4,
        damping: 0.91,
        response: 0.21,
        feedback: 0,
        feedbackFreq: 1200,
        level: 0.89,
        exposeFeedback: false,
      });
    // A bright, aggressive pick attack (high response) and comparatively
    // little natural damping, plus positive feedback (dsp/rust/src/lib.rs's
    // PLUCK_FEEDBACK/PLUCK_FEEDBACK_FREQ) driving the string into a
    // sustained squeal instead of decaying away — the same string model as
    // 'pluck', just leaning on the parameters that voice deliberately
    // doesn't use. feedbackFreq is where that squeal locks on (a fixed
    // frequency, standing in for the amp/room's own resonance rather than
    // tracking the note's own pitch — see svf_bandpass's comment in
    // dsp/rust/src/lib.rs for why that's what makes it sound like real
    // feedback rather than just a longer decay), so which notes squeal most
    // readily genuinely depends on pitch, the same as on a real amp. Route
    // this into the overdrive pedal (drag it in) for the full "screaming
    // metal guitar" tone; this voice only supplies the string/feedback side.
    case 'metal':
      return createPluckVoice(entity, graph, {
        pitch: 82.4, // standard guitar low E
        damping: 0.25,
        response: 0.85,
        feedback: 0.45,
        feedbackFreq: 1200,
        level: 0.8,
        exposeFeedback: true,
      });
    default:
      return undefined;
  }
}

interface PluckVoiceDefaults {
  pitch: number;
  damping: number;
  response: number;
  feedback: number;
  feedbackFreq: number;
  level: number;
  exposeFeedback: boolean; // whether this kind's controlsFor entry includes feedback/feedbackFreq at all (ui/controlSpecs.ts)
}

// Shared by the 'pluck' and 'metal' cases above — same Karplus-Strong voice
// (dsp/rust/src/lib.rs, dsp/worklets/pluck-processor.js) and the same
// envelope-organelle wiring (audio/entityGraph.ts's EntityType 'feature'),
// just different tunings and whether `feedback` is exposed as a live
// control. Unlike kick, this is one long-lived AudioWorkletNode — always
// connected through `level` — re-excited per trigger via the worklet's port
// rather than rebuilt per hit, since a Karplus-Strong voice needs its
// delay-line state to persist across the whole render loop.
function createPluckVoice(entity: Entity, graph: EntityGraph, defaults: PluckVoiceDefaults): AudioNode {
  const ctx = getAudioContext();

  const pluck = new AudioWorkletNode(ctx, 'pluck-processor', {
    processorOptions: {
      wasmModule: dspModule,
      frequency: entity.params.pitch ?? defaults.pitch,
      damping: entity.params.damping ?? defaults.damping,
      response: entity.params.response ?? defaults.response,
      feedback: entity.params.feedback ?? defaults.feedback,
      feedbackFreq: entity.params.feedbackFreq ?? defaults.feedbackFreq,
    },
  });
  const level = ctx.createGain();
  level.gain.value = entity.params.level ?? defaults.level;

  // An attached ADSR envelope organelle inserts an extra gain stage between
  // the raw voice and `level` — `level` stays the user-facing volume knob,
  // this is what the envelope's Attack/Decay/Sustain/Release ramps actually
  // drive. Silent (gain 0) until gated on.
  const envelope = graph.featuresOf(entity.id).find((f) => f.kind === 'envelope');
  let tail: AudioNode = pluck;
  let envelopeGain: GainNode | undefined;
  if (envelope) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    pluck.connect(gain);
    tail = gain;
    envelopeGain = gain;

    // Gate-off (ui/interaction.ts's pad-release, via releaseEntity) — ramp
    // down to silence from wherever the envelope currently sits, not just
    // from Sustain, so releasing mid-Attack/Decay doesn't jump/click. Reads
    // envelope.params fresh each call, same "no baked-in values" reasoning
    // as kick's registerTrigger.
    registerRelease(entity.id, () => {
      const now = ctx.currentTime;
      const release = Math.max(0.001, envelope.params.release ?? 0.3);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + release);

      const playback = envelopePlaybackByFeature.get(envelope.id);
      if (playback) {
        playback.gateOffAt = performance.now();
        playback.release = release;
      }
    });
  }
  tail.connect(level);

  // None of these are native AudioParams — same reasoning as bow's controls.
  const controls: Record<string, (value: number) => void> = {
    level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    pitch: (value) => pluck.port.postMessage({ type: 'setFrequency', value }),
    damping: (value) => pluck.port.postMessage({ type: 'setDamping', value }),
    response: (value) => pluck.port.postMessage({ type: 'setResponse', value }),
  };
  if (defaults.exposeFeedback) {
    controls.feedback = (value) => pluck.port.postMessage({ type: 'setFeedback', value });
    controls.feedbackFreq = (value) => pluck.port.postMessage({ type: 'setFeedbackFreq', value });
  }
  registerControls(entity.id, controls);

  registerTrigger(entity.id, () => {
    pluck.port.postMessage({ type: 'excite' });

    // Gate-on: Attack up to full, then Decay down to Sustain — the Release
    // half lives in the registerRelease closure above, fired separately on
    // pad-release. Only when an envelope is actually attached; otherwise
    // this is a plain momentary trigger, no envelope machinery involved.
    if (envelope && envelopeGain) {
      const now = ctx.currentTime;
      const attack = Math.max(0.001, envelope.params.attack ?? 0.01);
      const decay = Math.max(0.001, envelope.params.decay ?? 0.2);
      const sustain = Math.min(1, Math.max(0, envelope.params.sustain ?? 0.6));
      envelopeGain.gain.cancelScheduledValues(now);
      envelopeGain.gain.setValueAtTime(envelopeGain.gain.value, now);
      envelopeGain.gain.linearRampToValueAtTime(1, now + attack);
      envelopeGain.gain.linearRampToValueAtTime(sustain, now + attack + decay);

      envelopePlaybackByFeature.set(envelope.id, {
        gateOnAt: performance.now(),
        attack,
        decay,
        gateOffAt: null,
        release: 0,
      });
    }
  });

  return level;
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
export const PROCESSOR_KINDS = new Set(['overdrive', 'reverb', 'chorus', 'flanger', 'fuzz']);

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

// tanh-based hard clip — a genuinely different curve shape from
// makeOverdriveCurve above, not just a bigger `amount`: overdrive's rational
// function saturates gently and stays fairly smooth even at its max, where
// this saturates fast and hard, approaching a square wave well before
// `amount`'s top end. That harder, buzzier clip is what actually
// distinguishes a fuzzbox from an overdrive pedal — a bigger `amount` on
// the same curve shape wouldn't get there.
function makeFuzzCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const drive = 1 + amount * 1.5;
  const norm = Math.tanh(drive) || 1; // keeps full-scale input still reaching close to ±1
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(drive * x) / norm;
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
    case 'fuzz': {
      // Same overall shape as overdrive above (pre-shaper boost + a
      // WaveShaper curve both driven by one param, then a post tone
      // lowpass) — what's different is makeFuzzCurve's much harder clip,
      // which is the actual "fuzzbox vs overdrive pedal" distinction.
      const drive = ctx.createGain();
      drive.gain.value = entity.params.fuzz ?? 10;

      const shaper = ctx.createWaveShaper();
      shaper.curve = makeFuzzCurve(entity.params.fuzz ?? 10);
      shaper.oversample = '4x';

      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = entity.params.tone ?? 2500;

      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.7;

      input.connect(drive);
      drive.connect(shaper);
      shaper.connect(tone);
      tone.connect(level);

      registerControls(entity.id, {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        tone: (value) => tone.frequency.setTargetAtTime(value, ctx.currentTime, 0.01),
        fuzz: (value) => {
          drive.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
          shaper.curve = makeFuzzCurve(value);
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

function createNodes(entity: Entity, graph: EntityGraph): EntityNodes {
  const ctx = getAudioContext();

  const input = ctx.createGain();
  const output = ctx.createGain();

  const processorTail = createProcessor(entity, input);
  if (processorTail) {
    processorTail.connect(output);
  } else {
    input.connect(output);
  }

  const generator = createGenerator(entity, graph);
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
    if (entity.type === 'control') {
      // The master clock (audio/transport.ts) isn't a Web Audio node, but
      // its tempo is still just a control-dot param like any other —
      // registering a setter here reuses the exact same slider-drag path
      // instead of needing bespoke UI wiring. Also syncs the transport to
      // whatever the entity's param already holds (e.g. adjusted before
      // "start audio" was first clicked), the same way every other kind's
      // initial node state is read from entity.params at construction time.
      if (entity.kind === 'clock') {
        registerControls(entity.id, { bpm: setTempo });
        setTempo(entity.params.bpm ?? getTempo());
      }
      continue;
    }

    // Docked instruments (ui/dock.ts) get no audio nodes at all until
    // they're dragged out onto the canvas — see activateEntity() below,
    // which builds them lazily at that point instead.
    if (entity.docked) continue;

    // 'feature' entities (audio/entityGraph.ts, ui/organelle.ts) have no
    // audio nodes of their own — their owning source's own generator reads
    // them directly (see the 'pluck' case's envelope above, via
    // graph.featuresOf()).
    if (entity.type === 'feature') continue;

    try {
      createNodes(entity, graph);
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

// Drag an instrument out of the dock (ui/docking.ts) onto the canvas: build
// its audio nodes the first time this happens (nothing was built while it
// sat docked — see buildFromEntityGraph's skip above), then connect it to
// whatever it landed on (a parent's input, or straight to master), same as
// buildFromEntityGraph's own connect pass. A no-op before "start audio" has
// ever been pressed — buildFromEntityGraph() picks the entity up normally
// once it does, since it's no longer docked by then.
export function activateEntity(entity: Entity, graph: EntityGraph): void {
  if (!engineReady) return;

  let nodes = nodesByEntity.get(entity.id);
  if (!nodes) {
    try {
      nodes = createNodes(entity, graph);
    } catch (err) {
      console.error(
        `Failed to build audio for entity "${entity.id}" (kind: ${entity.kind}) — it will be silent.`,
        err
      );
      return;
    }
  }

  nodes.output.disconnect(); // in case it was already connected somewhere
  const parentNodes = entity.parentId ? nodesByEntity.get(entity.parentId) : undefined;
  if (parentNodes) {
    nodes.output.connect(parentNodes.input);
  } else {
    nodes.output.connect(getMasterChain());
  }
}

// Drag an instrument from the canvas into the dock: silence it by
// disconnecting its output from wherever it currently feeds — its nodes
// are kept around (not torn down), so dragging it back out later is a cheap
// reconnect via activateEntity() above rather than a rebuild. A no-op if it
// was never built (docked before "start audio" was ever pressed).
export function deactivateEntity(id: string): void {
  const nodes = nodesByEntity.get(id);
  if (!nodes) return;
  nodes.output.disconnect();
}
