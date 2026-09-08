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
import { pulseMelody } from './melodyPlayer';
import { activateSequencerControl, registerSequencerForPlayback } from './sequencerPlayer';
import { activateBeatMatcherControl, registerBeatMatcherForPlayback } from './beatMatcherPlayer';
import { GRIND_TUNING, GRIND_TUNING_KEYS, startGrindVoice } from './grindPlayer';
import { GRAIN_TUNING, GRAIN_TUNING_KEYS, startGrainVoice } from './grainPlayer';
import type { GrainVoiceControls } from './grainPlayer';
import { BASS_TUNING, BASS_TUNING_KEYS } from './bassTuning';
import { METAL_TUNING, METAL_TUNING_KEYS } from './metalTuning';
import { startVocodeVoice } from './vocodePlayer';
import type { VocodeVoiceControls } from './vocodePlayer';
import { startVocodeGranularVoice } from './vocodeGranularPlayer';
import type { VocodeGranularVoiceControls } from './vocodeGranularPlayer';
import { watchSound } from './nodeCapture';
import type { LevelWatcher } from './nodeCapture';
import { estimateF0, extractFormants } from '../ui/pitchAnalysis';
import type { Formant } from '../ui/pitchAnalysis';
import type { Entity, EntityGraph } from './entityGraph';

interface EntityNodes {
  input: GainNode; // children connect here (this entity's internal mixer)
  output: GainNode; // own generator + children, summed — feeds `pan`, not the parent directly
  // Stereo position, driven by the entity's canvas x position (ui/stereoMix.ts)
  // — inserted after `output` so it's what the parent (or master) actually
  // connects from; see setPan below and every output-reconnection site
  // (buildFromEntityGraph, reparentEntity, activateEntity, deactivateEntity),
  // which all target `pan` now, not `output`, for exactly that reason.
  pan: StereoPannerNode;
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

// Live stereo position for an entity's own output — see EntityNodes.pan.
// A no-op if the entity has no audio nodes yet (mirrors every other live
// setter here — e.g. a docked or not-yet-built entity), so ui/stereoMix.ts
// can call this unconditionally as the canvas position changes without
// first checking whether the graph has actually been built.
export function setPan(entityId: string, value: number): void {
  const nodes = nodesByEntity.get(entityId);
  if (!nodes) return;
  // Short time constant — smooths out the zipper noise a hard setValue
  // would cause on every drag tick, without noticeably lagging behind a
  // fast drag the way `level`'s 0.01s (tuned for a slower slider drag)
  // would start to.
  nodes.pan.pan.setTargetAtTime(value, getAudioContext().currentTime, 0.015);
}

// Kinds that are a one-shot "click the pad to trigger it" instrument rather
// than a continuous drone — exported so the UI knows which entities get a
// center pad (see ui/pads.ts) rather than just playing continuously once
// the graph is built. There's no event transport yet (ARCHITECTURE.md
// §5.3) — this is the manual/interactive way to fire a hit until that
// exists.
export const TRIGGERED_KINDS = new Set(['kick', 'pluck', 'metal', 'sample', 'synth']);

// Source kinds that play continuously as soon as their nodes are built,
// rather than needing to be triggered (TRIGGERED_KINDS above) or acting as
// a processing container (PROCESSOR_KINDS below) — exported so the UI
// knows which entities get a play/pause button (ui/render.ts's drawPad,
// ui/interaction.ts's pad-press/event-wire handling) in the same style as
// a TRIGGERED_KINDS entity's own trigger pad, wired the same way too (see
// activateEventTarget below).
export const CONTINUOUS_KINDS = new Set(['bass', 'bow', 'grind', 'grain']);

// Below this actual playback time (buffer duration / current speed — see
// the 'sample' case's registerTrigger), a pad hit layers a fresh voice on
// top of whatever's already sounding (like kick/pluck/metal's short
// one-shots); at or above it, the pad instead pauses/resumes a single
// voice (see startPlayback/pausedOffset) — a slow doom-tempo drone-length
// sample retriggering underneath itself reads as a mistake, not a deliberate
// layered hit, where a short drum/foley sample retriggering fast is exactly
// the point. Arbitrary but reasonable; tune by ear if it's ever wrong.
const LONG_SAMPLE_SECONDS = 5;

// A dropped audio file's decoded data, keyed by the entity id created for
// it (see ui/sampleDrop.ts) — not entity.params, which is numbers-only.
// Registered before the entity's nodes are built (either immediately, if
// dropped while the engine is already running, or later by
// buildFromEntityGraph on "start audio"), and read by createGenerator's
// 'sample' case below. Persists across suspend/resume and across a docked
// round-trip, the same as any other kind's node state.
const sampleBuffers = new Map<string, AudioBuffer>();

export function registerSampleBuffer(entityId: string, buffer: AudioBuffer): void {
  sampleBuffers.set(entityId, buffer);
}

// The live 'grain' voice instance for each entity, keyed by id — unlike
// sampleBuffers above, this isn't a "register before nodes exist" registry:
// a grain voice's captured buffer/points can only ever be produced by
// ui/grainSampler.ts's own popup, which (per ui/render.ts's feature-drawing
// pass) can only be open while its owner is undocked, i.e. already built —
// so there's no "not built yet" case to guard here the way sampleBuffers'
// own comment describes. Cleared on rebuildEntity (see that function) so a
// drag-out-of-dock-and-back-in doesn't leak the old instance's setInterval.
const grainVoices = new Map<string, GrainVoiceControls>();

export function getGrainVoice(entityId: string): GrainVoiceControls | undefined {
  return grainVoices.get(entityId);
}

// The live 'vocode' voice instance for each entity, same registry shape as
// grainVoices above — cleared on rebuildEntity too. Read by
// ui/vocodeTuner.ts (its own re-analyze/live-drag calls push straight
// through analyzeAndApplyVocode below rather than touching this map
// directly).
const vocodeVoices = new Map<string, VocodeVoiceControls>();

export function getVocodeVoice(entityId: string): VocodeVoiceControls | undefined {
  return vocodeVoices.get(entityId);
}

// The 'vocode' pedal's OTHER resynthesis engine (audio/vocodeGranularPlayer.ts's
// granular/overlap-add pitch shifter — ui/vocodeTuner.ts's mode toggle
// switches between this and vocodeVoices above) — a separate registry
// rather than folding the two into one map/shape, since vocodeVoices/
// getVocodeVoice have no callers outside this file to worry about
// disturbing, and each engine's own controls type is genuinely different.
// Both engines run continuously regardless of which is selected — see
// createVocodeFilter's own mode-select gain stage.
const vocodeGranularVoices = new Map<string, VocodeGranularVoiceControls>();

const VOCODE_MODE_SWITCH_FADE_SECONDS = 0.02; // short crossfade between modes, just enough to avoid a click

// Crossfades the pedal's own mode-select gain stage (createVocodeFilter's
// own vocoderModeGain/granularModeGain) and persists the choice on
// entity.params.mode — a genuine first for this codebase (no existing kind
// stores a discrete mode as a plain number) but it belongs on the entity's
// own params rather than as organelle-local UI state (contrast the beat-
// matcher's own ephemeral playbackSpeed, ui/beatMatcher.ts): this is
// audio-engine-affecting state, same category as this pedal's own
// params.f0. Called from ui/vocodeTuner.ts's own cycleVocodeMode.
export function setVocodeMode(entity: Entity, mode: number): void {
  const gains = vocodeModeGainsByEntity.get(entity.id);
  if (!gains) return;
  const ctx = getAudioContext();
  const granular = mode === 1 ? 1 : 0;
  gains.vocoderModeGain.gain.setTargetAtTime(1 - granular, ctx.currentTime, VOCODE_MODE_SWITCH_FADE_SECONDS);
  gains.granularModeGain.gain.setTargetAtTime(granular, ctx.currentTime, VOCODE_MODE_SWITCH_FADE_SECONDS);
  entity.params.mode = granular;
}

const vocodeModeGainsByEntity = new Map<string, { vocoderModeGain: GainNode; granularModeGain: GainNode }>();

// A watcher waiting for a freshly-built 'vocode' pedal's contained source to
// start sounding for the very first time, so createVocodeFilter's own
// "auto-prime once" trigger can fire — see that function's own comment.
// Kept here (rather than a local variable inside createVocodeFilter) only
// so rebuildEntity can stop a still-pending one before it ever fires,
// same "don't leak a live watcher/timer across a rebuild" reasoning as
// grainVoices' own header comment.
const vocodeAutoPrimeWatchers = new Map<string, LevelWatcher>();

// Large enough for at least ~2 full periods of a 20Hz drone fundamental
// (8192 samples / 44.1kHz =~ 185ms) so estimateF0's autocorrelation has
// enough context at the low end of a plausible drone range, and gives a
// reasonable ~5.4Hz-per-bin resolution for extractFormants' own use of the
// same snapshot's frequency-domain data.
const VOCODE_ANALYSER_FFT_SIZE = 8192;

// One-shot analysis snapshot: taps `entity`'s own input mixer with a
// transient AnalyserNode (no AudioBuffer, nothing kept afterward — see
// ui/pitchAnalysis.ts's own header for why), estimates f0 (unless
// `f0Override` is given — ui/vocodeTuner.ts passes its own by-ear-corrected
// value here instead of trusting autocorrelation), extracts a formant bank
// from the same snapshot, and pushes both straight into the live voice.
// Serves three callers: createVocodeFilter's own auto-prime watcher below,
// ui/vocodeTuner.ts's manual re-analyze button (no override — a fresh
// autocorrelation guess), and that same organelle's live marker-drag apply
// (with an override). `entity.params.f0` is written on every call — a
// bespoke, non-control-dot field on the pedal's own params (same "extra
// per-instance state lives in params too" idiom as GRIND_TUNING's own
// non-control-dot keys) — so ui/vocodeTuner.ts can read back the currently-
// locked f0 to seed its marker when it opens, without this module needing
// to expose any separate registry for it.
export function analyzeAndApplyVocode(
  entity: Entity,
  f0Override?: number,
  onDone?: (result: { f0: number; formants: Formant[] }) => void
): void {
  const nodes = nodesByEntity.get(entity.id);
  const voice = vocodeVoices.get(entity.id);
  if (!nodes || !voice) return;
  const ctx = getAudioContext();

  const analyser = ctx.createAnalyser();
  analyser.fftSize = VOCODE_ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0; // a one-shot snapshot, not a live meter — no temporal smoothing to bias it
  nodes.input.connect(analyser);

  // A freshly-created AnalyserNode's own ring buffer starts out entirely
  // zero-initialized and only fills with real signal once the audio thread
  // has actually processed render quanta through it — reading immediately,
  // on this same synchronous tick, would see nothing but that zero-fill
  // (a perfectly flat spectrum has no local maxima at all, so
  // extractFormants would return an empty formant bank every time — the
  // bug this comment replaces). Wait for one full fftSize's worth of real
  // audio time before reading, same "give the audio graph a render
  // round-trip" reasoning as audio/nodeCapture.ts's own startNodeCapture.
  const fillDelayMs = (analyser.fftSize / ctx.sampleRate) * 1000 + 20;
  setTimeout(() => {
    // The entity/voice may have gone away by the time this fires (rebuilt,
    // deleted, redocked) — re-resolve rather than trusting the closure's
    // now-possibly-stale references.
    const liveNodes = nodesByEntity.get(entity.id);
    const liveVoice = vocodeVoices.get(entity.id);
    if (!liveNodes || !liveVoice) {
      nodes.input.disconnect(analyser);
      return;
    }

    const timeDomain = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeDomain);
    const f0 = f0Override ?? estimateF0(timeDomain, ctx.sampleRate);

    const magnitudeDb = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(magnitudeDb);
    const formants = extractFormants(magnitudeDb, ctx.sampleRate, analyser.fftSize, f0);

    liveNodes.input.disconnect(analyser);
    liveVoice.setFormants(formants);
    // Kept in sync regardless of which resynthesis mode is currently
    // selected (ui/vocodeTuner.ts's mode toggle) — both engines' own
    // window/rate math depends on knowing the current f0.
    vocodeGranularVoices.get(entity.id)?.setF0(f0);
    entity.params.f0 = f0;
    onDone?.({ f0, formants });
  }, fillDelayMs);
}

// A single note's worth of one-off overrides for a triggered voice —
// audio/sequencerPlayer.ts's per-note payload, threaded all the way through
// activateEventTarget/triggerEntity/releaseEntity. Optional and per-field:
// a voice that has nothing to say about a given field (e.g. kick has no
// envelope) simply never reads it, and a field left unset on the note
// falls through to whatever the voice's own params/knobs already say —
// "ignored if unused, overridden only where both sides specify it." Units
// match this file's own existing per-voice params (absolute Hz/seconds),
// NOT the sequencer note's own MIDI-pitch/duration-fraction shape — that
// conversion happens in audio/sequencerPlayer.ts, not here.
export interface TriggerOverrides {
  pitchHz?: number;
  velocity?: number; // 0..1, multiplies into whatever level the voice would otherwise use
  envelope?: { attack: number; decay: number; sustain: number; release: number };
}

// Registered by createGenerator() for triggered kinds — one function per
// entity that fires a single hit, reading whatever's currently in
// entity.params at the moment it's called (so param changes take effect on
// the next trigger, with no need for a separate live-control setter —
// there's nothing to push updates into between hits) UNLESS overrides
// supplies its own value for a given field, which wins for just this one
// hit.
const triggersByEntity = new Map<string, (overrides?: TriggerOverrides) => void>();

function registerTrigger(entityId: string, trigger: (overrides?: TriggerOverrides) => void): void {
  triggersByEntity.set(entityId, trigger);
}

export function triggerEntity(entityId: string, overrides?: TriggerOverrides): void {
  triggersByEntity.get(entityId)?.(overrides);
}

// Registered by createGenerator() only for an entity that has an ADSR
// envelope feature attached (audio/entityGraph.ts's EntityType 'feature') —
// the gate-off half of ui/interaction.ts's press-and-hold pad gesture,
// firing the envelope's Release ramp. A no-op (not registered at all) for
// any TRIGGERED_KINDS entity without one, so ui/interaction.ts can call
// this unconditionally on every pad release rather than first checking
// whether an envelope exists.
const releasesByEntity = new Map<string, (overrides?: TriggerOverrides) => void>();

function registerRelease(entityId: string, release: (overrides?: TriggerOverrides) => void): void {
  releasesByEntity.set(entityId, release);
}

export function releaseEntity(entityId: string, overrides?: TriggerOverrides): void {
  releasesByEntity.get(entityId)?.(overrides);
}

// Registered by createGenerator() only for the 'sample' kind (below) — the
// other TRIGGERED_KINDS are short one-shots with nothing worth interrupting
// mid-flight, but a dropped-in audio file can run long, so its pad doubles
// as a stop button once playback has actually started (see
// ui/interaction.ts's pad-press handling and isEntityPlaying just below).
const stopsByEntity = new Map<string, () => void>();

function registerStop(entityId: string, stop: () => void): void {
  stopsByEntity.set(entityId, stop);
}

export function stopEntity(entityId: string): void {
  stopsByEntity.get(entityId)?.();
}

// Which TRIGGERED_KINDS entities currently have sound actually playing —
// only ever populated for 'sample' (below); kick/pluck/metal never add to
// this, so isEntityPlaying is always false for them and ui/render.ts's pad
// icon / ui/interaction.ts's pad-press handling fall back to their normal
// always-triggers behavior unchanged.
const playingEntities = new Set<string>();

export function isEntityPlaying(entityId: string): boolean {
  return playingEntities.has(entityId);
}

// entityId -> the dedicated mute gain a CONTINUOUS_KINDS entity's own
// generator case (below) inserts after its normal level control — kept
// separate from that level gain rather than reusing it, so toggling pause
// can never race with (or get silently undone by) the user still dragging
// the level control-dot slider while paused; whatever level was set while
// paused is simply what's revealed again on resume.
const pauseGatesByEntity = new Map<string, GainNode>();

// Starts muted — a continuous synth stays silent until the user explicitly
// presses its play/pause button (or fires an event wire into it), rather
// than sounding the instant its nodes are built. gate.gain's own initial
// value is set directly here (not ramped via setEntityPaused — there's
// nothing playing yet to ramp away from), and pausedEntities is seeded to
// match so isEntityPaused already reads true before any toggle happens.
function registerPauseGate(entityId: string, gate: GainNode): void {
  pauseGatesByEntity.set(entityId, gate);
  gate.gain.value = 0;
  pausedEntities.add(entityId);
}

// Mirrors playingEntities/isEntityPlaying above, for the same reason: a
// stable current on/off state for ui/render.ts's play/pause icon and
// ui/interaction.ts's toggle to read, independent of whatever the gate's
// own AudioParam happens to read mid-ramp (see setEntityPaused's
// setTargetAtTime).
const pausedEntities = new Set<string>();

export function isEntityPaused(entityId: string): boolean {
  return pausedEntities.has(entityId);
}

export function setEntityPaused(entityId: string, paused: boolean): void {
  const gate = pauseGatesByEntity.get(entityId);
  if (!gate) return;
  if (paused) pausedEntities.add(entityId);
  else pausedEntities.delete(entityId);
  gate.gain.setTargetAtTime(paused ? 0 : 1, getAudioContext().currentTime, 0.02);
}

// Owning entity id -> its attached melody organelle's own feature-entity id
// (see ui/melody.ts), for whichever CONTINUOUS_KINDS entities have one.
// Populated by the 'bass'/'bow' generator cases below. Checked first by
// activateEventTarget: once a melody has notes, a pulse (pad click or wired
// event) advances the melody (audio/melodyPlayer.ts's pulseMelody) instead
// of toggling pause.
const melodyOwnersByEntity = new Map<string, string>();

export function toggleEntityPaused(entityId: string): void {
  setEntityPaused(entityId, !isEntityPaused(entityId));
}

// What "fire an event at this entity" (ui/interaction.ts's
// fireEventWireTargets — a wire's target, or the clock's every-beat
// targets) actually means depends on which of these registries the
// target's own generator case (or, for a sequencer control, its own
// buildFromEntityGraph registration) populated: a TRIGGERED_KINDS entity
// re-hits (triggerEntity), a CONTINUOUS_KINDS one toggles play/pause
// instead, a sequencer control toggles ITS OWN playback (same as clicking
// its center button) — exactly one of these is ever a no-op for a given
// id, so there's no need to look up the entity's kind here at all.
export function activateEventTarget(entityId: string, overrides?: TriggerOverrides): void {
  const melodyId = melodyOwnersByEntity.get(entityId);
  if (melodyId && pulseMelody(melodyId, entityId)) {
    // Once a melody is actually advancing, this pad's clicks/wired pulses
    // never reach the toggleEntityPaused branch below again — so a
    // pauseGate left muted (its own starting state, or wherever a pause
    // toggle last left it before the melody had notes) would otherwise
    // silence the voice permanently, with no remaining way to reopen it.
    // Pause/resume is superseded by melodyGate once melody playback has
    // taken over, so force pauseGate open here every time (a cheap no-op
    // once it already is).
    setEntityPaused(entityId, false);
    return;
  }

  if (activateSequencerControl(entityId)) return;
  if (activateBeatMatcherControl(entityId)) return;

  if (triggersByEntity.has(entityId)) {
    triggerEntity(entityId, overrides);
  } else if (pauseGatesByEntity.has(entityId)) {
    toggleEntityPaused(entityId);
  }
}

// Which entities are currently latched "on" via a right-click sustain
// toggle (ui/interaction.ts's contextmenu handler) — unifies a
// TRIGGERED_KINDS pad's press-and-hold gesture with a CONTINUOUS_KINDS
// pad's own play/pause: for either kind, right-click now means "keep
// sounding regardless of whether the pad is currently held," so a plain
// press-and-hold's own release (ui/interaction.ts's endPress) needs to
// check this before actually silencing anything.
const sustainedEntities = new Set<string>();

export function isEntitySustained(entityId: string): boolean {
  return sustainedEntities.has(entityId);
}

// The gate-on/off primitives shared by a normal press-and-hold pad gesture
// AND the right-click sustain toggle below — same underlying action either
// way (start/stop this entity's own note or drone), just triggered by two
// different gestures. Deliberately bypasses activateEventTarget's own
// melody-pulse/sequencer-toggle dispatch above: those are a click's OTHER
// possible meanings, decided by ui/interaction.ts before it ever calls
// these, not something a held note or a sustain latch should also try to
// re-interpret.
export function startSustainableNote(entityId: string, overrides?: TriggerOverrides): void {
  if (triggersByEntity.has(entityId)) {
    triggerEntity(entityId, overrides);
  } else if (pauseGatesByEntity.has(entityId)) {
    setEntityPaused(entityId, false);
  }
}

export function stopSustainableNote(entityId: string, overrides?: TriggerOverrides): void {
  if (triggersByEntity.has(entityId)) {
    releaseEntity(entityId, overrides);
  } else if (pauseGatesByEntity.has(entityId)) {
    setEntityPaused(entityId, true);
  }
}

// Right-click on a pad (ui/interaction.ts's contextmenu handler): first
// click latches it sounding (a TRIGGERED_KINDS voice gated fully open, a
// CONTINUOUS_KINDS one unpaused) regardless of whether the pad is being
// held; a second click releases/pauses it again — "the current drone"
// behavior a CONTINUOUS_KINDS pad's own plain click used to have
// unconditionally, now shared with TRIGGERED_KINDS voices too.
export function toggleSustain(entityId: string): void {
  if (sustainedEntities.has(entityId)) {
    sustainedEntities.delete(entityId);
    stopSustainableNote(entityId);
  } else {
    sustainedEntities.add(entityId);
    startSustainableNote(entityId);
  }
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
  const [, , , , , , , wasmModule] = await Promise.all([
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
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/growl-processor.js', import.meta.url)
    ),
    // Plain JS, no WASM — see dsp/worklets/capture-processor.js's own header
    // comment on why the sampler organelle (ui/sampler.ts) records raw PCM
    // this way instead of via MediaRecorder.
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/capture-processor.js', import.meta.url)
    ),
    // Also plain JS, no WASM — see dsp/worklets/bitcrush-processor.js's own
    // header comment on why its sample-and-hold decimation doesn't need it
    // either.
    ctx.audioWorklet.addModule(
      new URL('../dsp/worklets/bitcrush-processor.js', import.meta.url)
    ),
    WebAssembly.compileStreaming(fetch(wasmUrl)),
  ]);
  dspModule = wasmModule;

  getMasterChain();
  engineReady = true;
}

const WASM_KINDS = new Set(['noise', 'bass', 'bow', 'pluck', 'metal']);
// Checked separately by createProcessor below — a sink+source kind
// (currently only 'growl') needs the same "don't touch dspModule before
// it's ready" guard createGenerator's own WASM_KINDS check already has,
// just kept as its own set since a processor and a generator are built by
// two different functions.
const WASM_PROCESSOR_KINDS = new Set(['growl']);

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
      // Every BASS_TUNING key seeds this instance's own WASM init state,
      // whether or not it currently has a control-dot (same "tunable
      // regardless of exposed" model as the 'grind' case's GRIND_TUNING
      // below) — entity.params carries a value for it once either the
      // tuning organelle (ui/bassTuner.ts) or a real control-dot has
      // touched it, BASS_TUNING's own factory default otherwise.
      const bassInitial: Record<string, number> = {};
      for (const key of BASS_TUNING_KEYS) {
        bassInitial[key] = entity.params[key] ?? BASS_TUNING[key].value;
      }
      const bass = new AudioWorkletNode(ctx, 'bass-processor', {
        processorOptions: {
          wasmModule: dspModule,
          frequency: entity.params.frequency ?? 41.2, // low E
          detune: bassInitial.detune,
          drive: bassInitial.drive,
        },
      });
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.5;
      bass.connect(level);

      // See registerPauseGate's own comment — a separate mute gain after
      // level, not level itself, so the play/pause button (CONTINUOUS_KINDS)
      // never fights the level control-dot slider.
      const pauseGate = ctx.createGain();
      level.connect(pauseGate);
      registerPauseGate(entity.id, pauseGate);

      // A further gate stage for a melody organelle (ui/melody.ts) attached
      // to this entity — kept separate from pauseGate so a manual full mute
      // always wins regardless of melody note/rest state. Starts fully open
      // so an entity with no melody (or an empty one) is a pure pass-through,
      // unchanged from today.
      const melodyGate = ctx.createGain();
      pauseGate.connect(melodyGate);
      const melody = graph.featuresOf(entity.id).find((f) => f.kind === 'melody');
      if (melody) melodyOwnersByEntity.set(entity.id, melody.id);

      // 'setDetune'/'setDrive' forward straight to bass_set_detune/
      // bass_set_drive (dsp/rust/src/lib.rs) — same "read fresh every
      // render() call" click-free shape as frequency's own setter.
      const BASS_TUNING_MESSAGE_TYPE: Record<string, string> = { detune: 'setDetune', drive: 'setDrive' };
      const bassControls: Record<string, (value: number) => void> = {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        // Genuinely click-free, unlike the bow's frequency control — see
        // bass_set_frequency's comment in dsp/rust/src/lib.rs.
        frequency: (value) => bass.port.postMessage({ type: 'setFrequency', value }),
        melodyGate: (value) => melodyGate.gain.setTargetAtTime(value, ctx.currentTime, 0.008),
      };
      // Registered for EVERY tuning key regardless of its own `exposed`
      // flag — see the 'grind' case's own comment on why (same reasoning,
      // just forwarding through the worklet's message port instead of
      // mutating a JS object directly).
      for (const key of BASS_TUNING_KEYS) {
        bassControls[key] = (value) => bass.port.postMessage({ type: BASS_TUNING_MESSAGE_TYPE[key], value });
      }
      registerControls(entity.id, bassControls);

      return melodyGate;
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

      // See registerPauseGate's own comment — a separate mute gain after
      // level, not level itself, so the play/pause button (CONTINUOUS_KINDS)
      // never fights the level control-dot slider.
      const pauseGate = ctx.createGain();
      level.connect(pauseGate);
      registerPauseGate(entity.id, pauseGate);

      // A further gate stage for a melody organelle (ui/melody.ts) attached
      // to this entity — kept separate from pauseGate so a manual full mute
      // always wins regardless of melody note/rest state. Starts fully open
      // so an entity with no melody (or an empty one) is a pure pass-through,
      // unchanged from today.
      const melodyGate = ctx.createGain();
      pauseGate.connect(melodyGate);
      const melody = graph.featuresOf(entity.id).find((f) => f.kind === 'melody');
      if (melody) melodyOwnersByEntity.set(entity.id, melody.id);

      // None of these are native AudioParams — frequency, bow speed, and
      // bow pressure are all baked into the WASM voice's internal state
      // rather than read per-sample, so live changes go through the
      // worklet's message port instead (see dsp/worklets/bow-processor.js).
      registerControls(entity.id, {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        frequency: (value) => bow.port.postMessage({ type: 'setFrequency', value }),
        bowVelocity: (value) => bow.port.postMessage({ type: 'setVelocity', value }),
        bowPressure: (value) => bow.port.postMessage({ type: 'setPressure', value }),
        melodyGate: (value) => melodyGate.gain.setTargetAtTime(value, ctx.currentTime, 0.008),
      });

      return melodyGate;
    }
    // A granular noise texture (audio/grindPlayer.ts), not a physical model —
    // an earlier bowed-string-driven-into-chaos attempt (reusing 'bow's own
    // WASM voice) just settled into a steady tone instead of true chaos, so
    // this is a different approach entirely: a dense, randomized stream of
    // short filtered-noise grains, irregular BY CONSTRUCTION rather than
    // hoping a nonlinear feedback system stumbles into chaos — the same
    // "many small irregular scrapes" structure a real grinding wheel/
    // chainsaw actually has. Native Web Audio nodes only, no WASM. Otherwise
    // the same level/pauseGate/melodyGate chain every other CONTINUOUS_KINDS
    // voice uses.
    case 'grind': {
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.5;

      const pauseGate = ctx.createGain();
      level.connect(pauseGate);
      registerPauseGate(entity.id, pauseGate);

      const melodyGate = ctx.createGain();
      pauseGate.connect(melodyGate);
      const grindMelody = graph.featuresOf(entity.id).find((f) => f.kind === 'melody');
      if (grindMelody) melodyOwnersByEntity.set(entity.id, grindMelody.id);

      // Every GRIND_TUNING key seeds this instance's own live state, whether
      // or not it currently has a control-dot (see audio/grindPlayer.ts's
      // own header) — entity.params carries a value for it once either the
      // tuning organelle (ui/grindTuner.ts) or a real control-dot has
      // touched it, GRIND_TUNING's own factory default otherwise.
      const grindInitialParams: Record<string, number> = {
        frequency: entity.params.frequency ?? 320,
        grind: entity.params.grind ?? 0.5,
      };
      for (const key of GRIND_TUNING_KEYS) {
        grindInitialParams[key] = entity.params[key] ?? GRIND_TUNING[key].value;
      }
      const grindVoice = startGrindVoice(level, grindInitialParams);

      const grindControls: Record<string, (value: number) => void> = {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        frequency: (value) => grindVoice.set('frequency', value),
        grind: (value) => grindVoice.set('grind', value),
        melodyGate: (value) => melodyGate.gain.setTargetAtTime(value, ctx.currentTime, 0.008),
      };
      // Registered for EVERY tuning key regardless of its own `exposed` flag
      // — that flag only governs whether ui/controlSpecs.ts's static entry
      // also shows a control-dot for it; the live setter exists unconditionally
      // so the tuning organelle's sliders always take immediate audible
      // effect, exposed or not.
      for (const key of GRIND_TUNING_KEYS) {
        grindControls[key] = (value) => grindVoice.set(key, value);
      }
      registerControls(entity.id, grindControls);

      return melodyGate;
    }
    // A grain-cloud voice reading from a CAPTURED sample (audio/grainPlayer.ts,
    // ui/grainSampler.ts's popup) — unlike 'grind' just above, this has no
    // sound of its own until a source has been dropped onto its popup and at
    // least one point has been placed on the resulting spectrogram; until
    // then it's silent, same as an un-plucked TRIGGERED_KINDS voice. No
    // melodyGate — this voice has no melody-organelle feature (see grind's
    // own comment on grindMelody above).
    case 'grain': {
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.7;

      const pauseGate = ctx.createGain();
      level.connect(pauseGate);
      registerPauseGate(entity.id, pauseGate);

      const grainInitialParams: Record<string, number> = {
        density: entity.params.density ?? 0.4,
        grainLength: entity.params.grainLength ?? 0.08,
      };
      for (const key of GRAIN_TUNING_KEYS) {
        grainInitialParams[key] = entity.params[key] ?? GRAIN_TUNING[key].value;
      }
      const grainVoice = startGrainVoice(level, grainInitialParams);
      grainVoices.set(entity.id, grainVoice);

      const grainControls: Record<string, (value: number) => void> = {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        density: (value) => grainVoice.set('density', value),
        grainLength: (value) => grainVoice.set('grainLength', value),
      };
      // Registered for EVERY tuning key regardless of its own `exposed` flag —
      // same reasoning as 'grind' above: the live setter exists unconditionally
      // so ui/grainTuner.ts's sliders always take immediate audible effect.
      for (const key of GRAIN_TUNING_KEYS) {
        grainControls[key] = (value) => grainVoice.set(key, value);
      }
      registerControls(entity.id, grainControls);

      return pauseGate;
    }
    case 'kick': {
      const voiceOutput = ctx.createGain(); // summing point for each transient hit; not itself an envelope
      // Generated once and reused for every hit — it's just raw noise, no
      // reason to regenerate it per trigger the way reverb's decay-length
      // IR has to be.
      const clickBuffer = makeNoiseBuffer(ctx, 0.02);

      registerTrigger(entity.id, (overrides) => {
        const now = ctx.currentTime;
        const pitch = overrides?.pitchHz ?? entity.params.pitch ?? 50;
        const decay = entity.params.decay ?? 0.4;
        const click = entity.params.click ?? 0.3;
        const level = (entity.params.level ?? 0.8) * (overrides?.velocity ?? 1);

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
    // A completely conventional oscillator+LFO synth voice — see
    // createSynthVoice's own header for the full shape.
    case 'synth':
      return createSynthVoice(entity, graph);
    // A dropped-in audio file (ui/sampleDrop.ts) or a recorded-and-trimmed
    // clip (ui/sampler.ts) — click-to-fire like kick, not a drone, so it's
    // in TRIGGERED_KINDS above. Unlike kick's synthesis, there's real
    // per-instance data (the decoded buffer) to play back, and unlike the
    // WASM voices' worklet ports, playbackRate is a native AudioParam —
    // smoothly adjustable live on whichever instance is currently sounding,
    // not just picked up fresh on the next trigger.
    //
    // Unlike a dropped file (registered before the entity ever reaches this
    // function), a sampler entity can sit on canvas with NO buffer yet, and
    // get one — or a re-trimmed replacement — at any later point after its
    // nodes are already built (ui/sampler.ts's commitTrim, called every time
    // a trim marker settles). So every buffer read below happens fresh, via
    // sampleBuffers.get(entity.id), at the moment it's actually needed
    // (offsetNow/startPlayback/registerTrigger) rather than snapshotted into
    // a build-time const the way every other per-instance value here would
    // normally be — see registerTrigger's own no-buffer-yet guard below.
    case 'sample': {
      const level = ctx.createGain();
      level.gain.value = entity.params.level ?? 0.8;

      // The AudioBufferSourceNode currently playing, if any — a fresh node
      // per segment (a WebAudio source can only ever be started once, and
      // pausing means actually stopping it — there's no native pause/resume
      // on an AudioBufferSourceNode). segmentStart{CtxTime,Offset}/segmentRate
      // are what let offsetNow() below reconstruct "how far into the buffer
      // is playback right now" — needed both to capture a pause point and to
      // stay accurate across a live speed change mid-playback (playbackRate
      // isn't constant across the segment in that case).
      let current: AudioBufferSourceNode | null = null;
      let segmentStartCtxTime = 0;
      let segmentStartOffset = 0;
      let segmentRate = entity.params.speed ?? 1;
      // Buffer-seconds to resume from on the next trigger — set by the pad's
      // stop/pause button (registerStop below) and consumed (reset to 0) by
      // the very next trigger, so a trigger that isn't resuming a pause
      // (the first play, or a retrigger while already playing) always starts
      // from the beginning rather than replaying a stale pause point.
      let pausedOffset = 0;

      function offsetNow(): number {
        if (!current) return pausedOffset;
        return segmentStartOffset + (ctx.currentTime - segmentStartCtxTime) * segmentRate;
      }

      // Long/slow single-voice playback (the short-one-shot layering path
      // below never calls this) is hard-coded as if it were an ADSR
      // envelope — instantaneous attack (starts at full level immediately,
      // no ramp) and, in effect, infinite release: gate-on (registerTrigger)
      // starts the buffer LOOPING immediately, so a held or right-click-
      // sustained gate (ui/interaction.ts's press-and-hold/toggleSustain —
      // audio/graph.ts's own registerTrigger/registerRelease pair, same as
      // every other TRIGGERED_KINDS voice) can keep it sounding
      // indefinitely; gate-off (registerRelease below) doesn't stop
      // anything itself, it just clears `source.loop` so the CURRENTLY
      // playing pass finishes on its own rather than being cut off
      // mid-buffer — "terminates when the end of the sample is reached,"
      // not on release itself. A plain quick tap is audibly indistinguishable
      // from a single non-looping play: release clears `loop` almost
      // immediately, well before the first pass would ever repeat. Kept
      // consistent with every other envelope-bearing voice for exactly the
      // reason this shape was chosen: a real attack/decay/sustain/release
      // organelle could read/drive these same two gate calls later, if
      // sampled textures ever want shaping beyond hard on/off.
      function startPlayback(buffer: AudioBuffer, offset: number): void {
        const now = ctx.currentTime;
        const rate = entity.params.speed ?? 1;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.loop = true;
        source.connect(level);
        // Guards a paused-right-at-the-end race (offsetNow() landing at or
        // past duration) — start() would otherwise reject an out-of-range
        // offset; falling back to 0 just replays from the top.
        const clamped = offset > 0 && offset < buffer.duration ? offset : 0;
        source.start(now, clamped);
        current = source;
        segmentStartCtxTime = now;
        segmentStartOffset = clamped;
        segmentRate = rate;
        playingEntities.add(entity.id);

        source.addEventListener('ended', () => {
          source.disconnect();
          if (current === source) {
            current = null;
            playingEntities.delete(entity.id);
          }
        });
      }

      registerTrigger(entity.id, () => {
        // No buffer registered yet (a sampler that hasn't recorded anything,
        // or a dropped file mid-decode) — a silent no-op press rather than
        // an error; see this case's own header comment.
        const buffer = sampleBuffers.get(entity.id);
        if (!buffer) return;

        const rate = entity.params.speed ?? 1;

        // A right-click sustain latch (toggleSustain adds to
        // sustainedEntities BEFORE calling triggerEntity — see
        // startSustainableNote) always loops, regardless of the sample's
        // own length: "a sample can be used as a drone" the same way a
        // synth/pluck/metal voice's own envelope never enters release while
        // its sustain is held. Checked ahead of the short/long split below,
        // which only decides how a PLAIN (unsustained) trigger behaves.
        if (isEntitySustained(entity.id)) {
          current?.stop();
          pausedOffset = 0;
          startPlayback(buffer, 0);
          return;
        }

        // Actual playback time at the current speed, not the buffer's raw
        // duration — a file slowed to 0.2x plays 5x longer than its native
        // length, and that's the "long/slow" behavior that should trigger,
        // not the file's nominal duration.
        const playbackSeconds = buffer.duration / rate;

        if (playbackSeconds < LONG_SAMPLE_SECONDS) {
          // Short hit (a drum/foley one-shot, typically) — always layers a
          // fresh, independent voice on top of whatever's already sounding,
          // same "click it again before the last hit fades" expectation
          // kick/pluck/metal already have. Deliberately never touches
          // current/pausedOffset — those belong to the single-voice
          // gate-driven path below, for slow/long samples where
          // overlapping playback wouldn't read as a deliberate retrigger.
          // Never added to playingEntities either, so the pad never shows
          // a pause icon or treats a press as "stop" for this kind of hit —
          // and never loops, so registerRelease's own loop=false is a
          // harmless no-op on `current` regardless of whichever long
          // sample (if any) it currently references.
          const now = ctx.currentTime;
          const hit = ctx.createBufferSource();
          hit.buffer = buffer;
          hit.playbackRate.value = rate;
          hit.connect(level);
          hit.start(now);
          hit.addEventListener('ended', () => hit.disconnect());
          return;
        }

        // Long/slow — single voice, gate-driven (see startPlayback's own
        // comment). Resumes from a pause point if the pad's own explicit
        // "stop it now" button (registerStop below) left one; a plain
        // release never sets one (see registerRelease), so this is only
        // ever nonzero after that gesture specifically.
        const resumeFrom = pausedOffset;
        pausedOffset = 0;
        // Replaces rather than layers, if something's already playing (e.g.
        // an event-wired retrigger while this is mid-playback) — a sampler
        // pad, not a polyphonic one.
        current?.stop();
        startPlayback(buffer, resumeFrom);
      });

      registerRelease(entity.id, () => {
        // "Infinite release" — see startPlayback's own comment. Not a no-op
        // for the short-one-shot layering path above (current is never set
        // there), so this is safe to fire unconditionally regardless of
        // which path the matching trigger actually took.
        if (current) current.loop = false;
      });

      registerStop(entity.id, () => {
        // The pad's OWN "stop it right now" gesture (a press while already
        // playing — see ui/interaction.ts's isEntityPlaying check) — an
        // explicit, immediate cutoff, distinct from a plain release above,
        // which lets whatever's currently playing finish on its own instead.
        if (!current) return;
        pausedOffset = offsetNow();
        current.stop();
      });

      registerControls(entity.id, {
        level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
        // Live on whichever instance is currently sounding — playbackRate is
        // a native AudioParam, so this actually resamples in real time
        // (audible pitch/speed change while it plays), not just picked up
        // fresh on the next trigger. Checkpoints the offset bookkeeping
        // first so offsetNow() (and thus a later pause) stays accurate
        // across the rate change instead of assuming the old rate applied
        // for the whole segment.
        speed: (value) => {
          if (current) {
            segmentStartOffset = offsetNow();
            segmentStartCtxTime = ctx.currentTime;
            segmentRate = value;
            current.playbackRate.setTargetAtTime(value, ctx.currentTime, 0.01);
          }
        },
      });

      return level;
    }
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

  // The three METAL_TUNING extras only matter once feedback is actually
  // nonzero ('metal', not 'pluck' — see PluckVoiceDefaults.exposeFeedback's
  // own comment), so they're only seeded/exposed at all for that case.
  const pluck = new AudioWorkletNode(ctx, 'pluck-processor', {
    processorOptions: {
      wasmModule: dspModule,
      frequency: entity.params.pitch ?? defaults.pitch,
      damping: entity.params.damping ?? defaults.damping,
      response: entity.params.response ?? defaults.response,
      feedback: entity.params.feedback ?? defaults.feedback,
      feedbackFreq: entity.params.feedbackFreq ?? defaults.feedbackFreq,
      ...(defaults.exposeFeedback
        ? {
            feedbackQ: entity.params.feedbackQ ?? METAL_TUNING.feedbackQ.value,
            feedbackInjectGain: entity.params.feedbackInjectGain ?? METAL_TUNING.feedbackInjectGain.value,
            feedbackDriveScale: entity.params.feedbackDriveScale ?? METAL_TUNING.feedbackDriveScale.value,
          }
        : {}),
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
    registerRelease(entity.id, (overrides) => {
      const now = ctx.currentTime;
      const release = Math.max(0.001, overrides?.envelope?.release ?? envelope.params.release ?? 0.3);
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
    // Registered for every METAL_TUNING key regardless of its own `exposed`
    // flag — same "always live, exposed only decides the control-dot"
    // reasoning as the 'grind'/'bass' cases above.
    const METAL_TUNING_MESSAGE_TYPE: Record<string, string> = {
      feedbackQ: 'setFeedbackQ',
      feedbackInjectGain: 'setFeedbackInjectGain',
      feedbackDriveScale: 'setFeedbackDriveScale',
    };
    for (const key of METAL_TUNING_KEYS) {
      controls[key] = (value) => pluck.port.postMessage({ type: METAL_TUNING_MESSAGE_TYPE[key], value });
    }
  }
  registerControls(entity.id, controls);

  registerTrigger(entity.id, (overrides) => {
    // Always re-asserted, whether or not this trigger carries an override —
    // otherwise a one-off pitch from a wired sequencer note would stick in
    // the worklet's own state and leak into the very next plain pad click.
    // Never writes entity.params.pitch itself, so the knob's own displayed
    // value is untouched by a one-off override. Safe to change immediately
    // before exciting even while the string is still ringing (dsp/rust/src/
    // lib.rs's pluck_set_frequency: "glides slightly instead of clicking").
    pluck.port.postMessage({ type: 'setFrequency', value: overrides?.pitchHz ?? entity.params.pitch ?? defaults.pitch });
    pluck.port.postMessage({ type: 'excite' });

    // Gate-on: Attack up to full, then Decay down to Sustain — the Release
    // half lives in the registerRelease closure above, fired separately on
    // pad-release. Only when an envelope is actually attached; otherwise
    // this is a plain momentary trigger, no envelope machinery involved.
    // Velocity (if given) scales the attack peak and the sustain floor
    // together, rather than the persistent `level` knob — this is the only
    // per-hit gain stage this voice has, since overlapping hits otherwise
    // all share the one knob-driven `level` gain.
    if (envelope && envelopeGain) {
      const now = ctx.currentTime;
      const attack = Math.max(0.001, overrides?.envelope?.attack ?? envelope.params.attack ?? 0.01);
      const decay = Math.max(0.001, overrides?.envelope?.decay ?? envelope.params.decay ?? 0.2);
      const sustain = Math.min(1, Math.max(0, overrides?.envelope?.sustain ?? envelope.params.sustain ?? 0.6));
      const velocity = overrides?.velocity ?? 1;
      envelopeGain.gain.cancelScheduledValues(now);
      envelopeGain.gain.setValueAtTime(envelopeGain.gain.value, now);
      envelopeGain.gain.linearRampToValueAtTime(velocity, now + attack);
      envelopeGain.gain.linearRampToValueAtTime(sustain * velocity, now + attack + decay);

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

// The four native OscillatorNode waveforms a 'synth' voice can blend
// together — ui/synthConfig.ts's own icon row toggles each one on/off
// independently (entity.params[wave], 0 or 1), rather than picking a single
// exclusive waveform, so a "square + sawtooth" blend is exactly as valid as
// a plain sine.
const SYNTH_WAVEFORMS = ['sine', 'square', 'sawtooth', 'triangle'] as const;
type SynthWaveform = (typeof SYNTH_WAVEFORMS)[number];

// Live oscillator/mix-gain handles for one 'synth' entity, kept around (not
// just returned up through createGenerator's own AudioNode return) so
// reconcileSynthConfigModulation below can patch an LFO's own oscillator
// straight into them later, whenever a wire lands on/leaves this voice's
// synthConfig organelle — long after createSynthVoice itself has returned.
interface SynthVoiceNodes {
  oscillators: Record<SynthWaveform, OscillatorNode>;
  // Sum of every waveform's own (enable-gated) gain — tremoloDepth targets
  // THIS gain's own AudioParam (an LFO summed onto it swings the whole
  // voice's loudness); vibratoDepth targets each oscillator's own `detune`
  // instead (see SYNTH_CONFIG_PORTS below).
  mixGain: GainNode;
}
const synthVoicesByEntity = new Map<string, SynthVoiceNodes>();

// A completely conventional oscillator+LFO synth voice: up to four blended
// native OscillatorNode waveforms (SYNTH_WAVEFORMS above, individually
// enabled/disabled via ui/synthConfig.ts's icon row), gated by the same
// ADSR-envelope-organelle mechanism createPluckVoice's own voices use
// (attack/decay/sustain ramps on gate-on, release ramp on gate-off), pitched
// per-trigger from a sequencer note or the doom lever exactly like
// pluck/metal. registerControls only covers `level` and each waveform's own
// enable gain — pitch has no live setter (matching pluck/metal: it's read
// fresh at trigger time, see registerTrigger below) and vibrato/tremolo
// depth are pushed live through the synthConfig FEATURE entity's own
// control setter (registered below, keyed by ITS id, not this voice's —
// see ui/interaction.ts's applyControlValue, which resolves a wire target
// by whatever entity id the wire actually names).
function createSynthVoice(entity: Entity, graph: EntityGraph): AudioNode {
  const ctx = getAudioContext();
  const basePitch = entity.params.pitch ?? 220; // cello/guitar A, a reasonable default melodic register

  const mixGain = ctx.createGain();
  mixGain.gain.value = 1;

  // sine alone is on by default — a plain tone until the synthConfig
  // organelle's waveform row enables more.
  const defaultEnabled: Record<SynthWaveform, number> = { sine: 1, square: 0, sawtooth: 0, triangle: 0 };
  const oscillators = {} as Record<SynthWaveform, OscillatorNode>;
  const waveGains = {} as Record<SynthWaveform, GainNode>;
  for (const wave of SYNTH_WAVEFORMS) {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = basePitch;
    const gain = ctx.createGain();
    gain.gain.value = entity.params[wave] ?? defaultEnabled[wave];
    osc.connect(gain);
    gain.connect(mixGain);
    osc.start();
    oscillators[wave] = osc;
    waveGains[wave] = gain;
  }
  synthVoicesByEntity.set(entity.id, { oscillators, mixGain });

  const level = ctx.createGain();
  level.gain.value = entity.params.level ?? 0.6;

  // Same envelope-organelle wiring as createPluckVoice above — an extra
  // gain stage between the raw voice and `level`, silent until gated on.
  const envelope = graph.featuresOf(entity.id).find((f) => f.kind === 'envelope');
  let tail: AudioNode = mixGain;
  let envelopeGain: GainNode | undefined;
  if (envelope) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    mixGain.connect(gain);
    tail = gain;
    envelopeGain = gain;

    registerRelease(entity.id, (overrides) => {
      const now = ctx.currentTime;
      const release = Math.max(0.001, overrides?.envelope?.release ?? envelope.params.release ?? 0.3);
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

  registerTrigger(entity.id, (overrides) => {
    const now = ctx.currentTime;
    const freq = overrides?.pitchHz ?? entity.params.pitch ?? basePitch;
    // A short glide, not an instant jump — same "glides slightly instead of
    // clicking" reasoning as pluck/metal's own frequency setter, just via a
    // native AudioParam ramp instead of a WASM message.
    for (const wave of SYNTH_WAVEFORMS) {
      oscillators[wave].frequency.setTargetAtTime(freq, now, 0.005);
    }

    if (envelope && envelopeGain) {
      const attack = Math.max(0.001, overrides?.envelope?.attack ?? envelope.params.attack ?? 0.01);
      const decay = Math.max(0.001, overrides?.envelope?.decay ?? envelope.params.decay ?? 0.2);
      const sustain = Math.min(1, Math.max(0, overrides?.envelope?.sustain ?? envelope.params.sustain ?? 0.6));
      const velocity = overrides?.velocity ?? 1;
      envelopeGain.gain.cancelScheduledValues(now);
      envelopeGain.gain.setValueAtTime(envelopeGain.gain.value, now);
      envelopeGain.gain.linearRampToValueAtTime(velocity, now + attack);
      envelopeGain.gain.linearRampToValueAtTime(sustain * velocity, now + attack + decay);

      envelopePlaybackByFeature.set(envelope.id, {
        gateOnAt: performance.now(),
        attack,
        decay,
        gateOffAt: null,
        release: 0,
      });
    }
  });

  const controls: Record<string, (value: number) => void> = {
    level: (value) => level.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    // Unlike pluck/metal's WASM string models (whose pitch only takes
    // effect at the next excite — see createPluckVoice's own registerTrigger),
    // these are plain persistent OscillatorNodes: a live glide while a note
    // is already sustaining (held, or right-click-latched — see
    // audio/graph.ts's toggleSustain) is both technically trivial and
    // musically the whole point of a doom lever wired to pitch. Same
    // AudioParam every trigger already ramps, so a lever drag mid-note and
    // the next note's own attack never fight each other.
    pitch: (value) => {
      const now = ctx.currentTime;
      for (const wave of SYNTH_WAVEFORMS) {
        oscillators[wave].frequency.setTargetAtTime(value, now, 0.02);
      }
    },
  };
  for (const wave of SYNTH_WAVEFORMS) {
    controls[wave] = (value) => waveGains[wave].gain.setTargetAtTime(value, ctx.currentTime, 0.01);
  }
  registerControls(entity.id, controls);

  // The synthConfig organelle's own two depth params (vibratoDepth/
  // tremoloDepth) are pushed live the same way any wired control-dot value
  // is (ui/interaction.ts's applyControlValue: entity.params write + a
  // registered control setter) — but keyed by the FEATURE's own entity id,
  // since that's what a wire into it actually names as its target, not this
  // voice's id. setSynthConfigDepth is a no-op until an LFO is actually
  // wired in (see reconcileSynthConfigModulation below), same as every
  // other "primed but not yet connected" control here.
  const synthConfig = graph.featuresOf(entity.id).find((f) => f.kind === 'synthConfig');
  if (synthConfig) {
    registerControls(synthConfig.id, {
      vibratoDepth: (value) => setSynthConfigDepth(synthConfig.id, 'vibratoDepth', value),
      tremoloDepth: (value) => setSynthConfigDepth(synthConfig.id, 'tremoloDepth', value),
    });
  }

  return level;
}

// Where each synthConfig depth port's own LFO connection actually lands, and
// how far a depth of 1 (the port's own ControlSpec max — ui/controlSpecs.ts)
// pushes that AudioParam. vibratoDepth's 50 cents at full depth is a
// pronounced-but-musical vibrato; tremoloDepth's 1 swings the voice's own
// mix gain the full ±1 around its resting value of 1 (silent at the
// trough), a dramatic full-depth tremolo.
const SYNTH_CONFIG_PORTS: Record<string, { target: 'detune' | 'gain'; scale: number }> = {
  vibratoDepth: { target: 'detune', scale: 50 },
  tremoloDepth: { target: 'gain', scale: 1 },
};

// entityId -> its own persistent LFO oscillator (audio/graph.ts's own 'lfo'
// control case, see buildFromEntityGraph below) — a genuinely different
// shape of "control source" than every other one in this file: it has to
// keep RUNNING and be patchable straight into another entity's AudioParam,
// not just write a value through ui/wiring.ts's one-shot copy mechanism
// (see that module's own header). Read by reconcileSynthConfigModulation
// below whenever a wire from an 'lfo'-kind entity lands on a synthConfig
// port.
const lfoOscillatorsByEntity = new Map<string, OscillatorNode>();

// `${synthConfigEntityId}:${port}` -> the live depth-scaling GainNode
// currently patched between that LFO's oscillator and the target AudioParam
// — exists only while a wire from an 'lfo' actually occupies that port.
const synthModConnections = new Map<string, { lfoEntityId: string; depthGain: GainNode }>();

function synthModKey(synthConfigEntityId: string, port: string): string {
  return `${synthConfigEntityId}:${port}`;
}

function disconnectSynthModulation(synthConfigEntityId: string, port: string): void {
  const key = synthModKey(synthConfigEntityId, port);
  const existing = synthModConnections.get(key);
  if (!existing) return;
  existing.depthGain.disconnect();
  synthModConnections.delete(key);
}

// Live depth control for an already-connected port — a no-op (not an error)
// if nothing's wired in yet, the same "primed but dormant until connected"
// shape every other registered control setter in this file has. Called both
// by createSynthVoice's own registered control setter (a manual depth-slider
// drag, or an ordinary wire's value fanning through applyControlValue) and
// by reconcileSynthConfigModulation itself, to prime a freshly-made
// connection with whatever depth was already dialed in before the LFO was
// ever wired up.
function setSynthConfigDepth(synthConfigEntityId: string, port: string, depth: number): void {
  const portSpec = SYNTH_CONFIG_PORTS[port];
  const connection = synthModConnections.get(synthModKey(synthConfigEntityId, port));
  if (!portSpec || !connection) return;
  connection.depthGain.gain.setTargetAtTime(depth * portSpec.scale, getAudioContext().currentTime, 0.02);
}

// The one deliberate exception to this file's "never needs to know wires
// exist" rule (ui/wiring.ts's own header) — an LFO's modulation has to be a
// real, continuously-running Web Audio connection (an oscillator's own
// audio-rate output summed straight into a target AudioParam), not the
// one-shot value-copy every other wire uses. Called by
// ui/lfoWiring.ts's reconcileLfoWireTarget, itself called from
// ui/interaction.ts right after any wire add/remove — see that module for
// why this narrow bridge lives on the UI-orchestration side rather than
// this file importing ui/wiring.ts directly. `lfoEntityId` null means "no
// LFO wired here right now" (or the
// wire that was there just got removed) — always disconnects whatever was
// there before, then reconnects only if a real LFO is now present, so
// replacing one LFO with another (or with nothing) never leaves a stale
// connection behind.
export function reconcileSynthConfigModulation(
  synthConfigEntityId: string,
  port: string,
  ownerEntityId: string,
  lfoEntityId: string | null,
  depth: number
): void {
  disconnectSynthModulation(synthConfigEntityId, port);
  if (!lfoEntityId) return;

  const portSpec = SYNTH_CONFIG_PORTS[port];
  const lfoOsc = lfoOscillatorsByEntity.get(lfoEntityId);
  const voice = synthVoicesByEntity.get(ownerEntityId);
  if (!portSpec || !lfoOsc || !voice) return;

  const ctx = getAudioContext();
  const depthGain = ctx.createGain();
  depthGain.gain.value = depth * portSpec.scale;
  lfoOsc.connect(depthGain);

  if (portSpec.target === 'detune') {
    for (const wave of SYNTH_WAVEFORMS) depthGain.connect(voice.oscillators[wave].detune);
  } else {
    depthGain.connect(voice.mixGain.gain);
  }

  synthModConnections.set(synthModKey(synthConfigEntityId, port), { lfoEntityId, depthGain });
}

// The general case reconcileSynthConfigModulation above is a special
// instance of: ANY plain control dot backed by a genuine native AudioParam
// can be an LFO's target, not just synth-1's own two dedicated depth ports —
// a resonant/tone filter's own cutoff (the classic auto-wah target) being
// the obvious one. Two real differences from the synthConfig case keep this
// a separate, simpler mechanism rather than a shared one:
//   - one AudioParam per (entity, param) here, vs. vibratoDepth's four
//     oscillator detunes at once — SYNTH_CONFIG_PORTS' own `target` union
//     exists specifically to fan one connection out to all four.
//   - no dedicated depth control exists on a plain dot the way synthConfig's
//     own popup sliders do, so the sweep amount is a fixed proportion of the
//     dot's own ControlSpec range (computed by the caller, ui/lfoWiring.ts,
//     which is where controlsFor(...) already lives) rather than something
//     this file can read live off an entity's own params.
//
// Registered by whichever createGenerator/createProcessor case actually has
// a native AudioParam worth exposing this way — so far just overdrive/fuzz/
// reverb's own `tone` lowpass cutoff. A kind that never registers one here
// (most of them: everything driven by an AudioWorkletNode's message port,
// like bow/pluck/growl/bass, has no real AudioParam to connect an
// oscillator into at all) just makes reconcileLfoDotModulation below a
// harmless no-op for it.
const lfoTargetsByEntity = new Map<string, Record<string, AudioParam>>();

function registerLfoTarget(entityId: string, param: string, audioParam: AudioParam): void {
  const existing = lfoTargetsByEntity.get(entityId);
  if (existing) existing[param] = audioParam;
  else lfoTargetsByEntity.set(entityId, { [param]: audioParam });
}

// `${entityId}:${param}` -> the live depth-scaling GainNode currently
// patched between an LFO's oscillator and the target AudioParam — same
// shape as synthModConnections above, just keyed directly by the target
// dot instead of a synthConfig port.
const lfoDotConnections = new Map<string, { lfoEntityId: string; depthGain: GainNode }>();

function lfoDotKey(entityId: string, param: string): string {
  return `${entityId}:${param}`;
}

function disconnectLfoDotModulation(entityId: string, param: string): void {
  const key = lfoDotKey(entityId, param);
  const existing = lfoDotConnections.get(key);
  if (!existing) return;
  existing.depthGain.disconnect();
  lfoDotConnections.delete(key);
}

// Called by ui/lfoWiring.ts's reconcileLfoWireTarget, the same "right after
// any wire add/remove" bridge reconcileSynthConfigModulation above uses —
// see that function's own comment for the add/remove/replace semantics,
// identical here. `peakSwing` is in the target param's own raw units (e.g.
// Hz for a filter cutoff), not a 0..1 depth — see this section's own header
// for why that's computed by the caller rather than read live from here.
export function reconcileLfoDotModulation(
  entityId: string,
  param: string,
  lfoEntityId: string | null,
  peakSwing: number
): void {
  disconnectLfoDotModulation(entityId, param);
  if (!lfoEntityId) return;

  const lfoOsc = lfoOscillatorsByEntity.get(lfoEntityId);
  const audioParam = lfoTargetsByEntity.get(entityId)?.[param];
  if (!lfoOsc || !audioParam) return;

  const ctx = getAudioContext();
  const depthGain = ctx.createGain();
  depthGain.gain.value = peakSwing;
  lfoOsc.connect(depthGain);
  depthGain.connect(audioParam);

  lfoDotConnections.set(lfoDotKey(entityId, param), { lfoEntityId, depthGain });
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
export const PROCESSOR_KINDS = new Set(['overdrive', 'reverb', 'chorus', 'flanger', 'fuzz', 'growl', 'vocode', 'ringmod', 'bitcrush']);

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

  if (!dspModule && WASM_PROCESSOR_KINDS.has(entity.kind)) {
    throw new Error('initAudioEngine() must complete before building the graph');
  }

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
      // A genuine native AudioParam — the classic auto-wah target. See
      // registerLfoTarget's own header for why most other kinds' params
      // can't offer this at all.
      registerLfoTarget(entity.id, 'tone', tone.frequency);

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
      registerLfoTarget(entity.id, 'tone', tone.frequency);

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
      registerLfoTarget(entity.id, 'tone', wetTone.frequency);

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
    // TODO.md's "growl filter" (doom/industrial palette item 9) — a
    // resonant bandpass pushed into a genuine positive-feedback loop, so it
    // picks out and reinforces whatever's near `frequency` in the INPUT
    // signal rather than exciting its own delay line. WASM (growl_render,
    // dsp/rust/src/lib.rs), reusing the same svf_bandpass/soft_clip building
    // blocks 'metal's own feedback branch (pluck_render) already uses —
    // that voice turned out unusable as an instrument (the squeal
    // dominates, no discernible pitch/gesture), but the mechanism itself is
    // general enough to route ANY source through instead: same "amp/room
    // resonance" idea, just as a routable pedal now. A first native-nodes
    // port of this same idea worked but sounded thinner and could diverge
    // into a runaway self-oscillation with no per-sample bound on the
    // resonator's own state; this WASM version avoids that by construction
    // (see createGrowlFilter's own comment). `kill` is kept anyway as an
    // explicit "make it stop" for a loud resonance that's just musically
    // unwanted mid-performance.
    case 'growl':
      return createGrowlFilter(entity, input);
    case 'vocode':
      return createVocodeFilter(entity, input);
    case 'ringmod':
      return createRingModFilter(entity, input);
    case 'bitcrush':
      return createBitcrushFilter(entity, input);
    default:
      return null;
  }
}

// Q of the resonant filter — capped well above what's musically useful,
// but high enough to get genuinely close to self-oscillating (same
// reasoning as dsp/rust/src/lib.rs's own FEEDBACK_Q comment).
const GROWL_MAX_Q = 40;
// Loop gain is hard-capped below 1 regardless of what a control setter is
// asked to set — same "genuine feedback loop, unity gain means unbounded
// buildup" reasoning as createModulatedDelay's own flanger feedback cap.
const GROWL_MAX_FEEDBACK = 0.95;

// Fixed shaping constants for growl_render's own internal soft-clip drive
// (dsp/rust/src/lib.rs's GROWL_INJECT_GAIN/GROWL_DRIVE_SCALE) — not exposed
// as control-dots (controlSpecs.ts's `growl` entry only lists the four
// musically-relevant params), just passed once at growl_init time. If these
// ever want to be by-ear tunable, they're exactly the kind of thing
// ui/tuningOrganelle.ts was built for.
const GROWL_INJECT_GAIN = 3.0;
const GROWL_DRIVE_SCALE = 4.0;

function createGrowlFilter(entity: Entity, input: GainNode): AudioNode {
  const ctx = getAudioContext();

  const frequency = entity.params.frequency ?? 1200;
  const q = Math.min(GROWL_MAX_Q, Math.max(0.1, entity.params.q ?? 15));
  const initialFeedback = Math.min(GROWL_MAX_FEEDBACK, Math.max(0, entity.params.feedback ?? 0.5));

  // The actual resonant feedback loop, entirely inside WASM (growl_render,
  // dsp/rust/src/lib.rs) — see that function's own comment for why this
  // avoids the native version's "never stops" failure mode: every sample
  // reinjected into the loop has already passed through soft_clip, so the
  // filter's own driving input is bounded every single sample rather than
  // only once the OUTPUT is tapped. `input` connects straight in;
  // growl-processor.js stages each quantum into WASM memory itself.
  const growlNode = new AudioWorkletNode(ctx, 'growl-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      wasmModule: dspModule,
      frequency,
      q,
      feedback: initialFeedback,
      injectGain: GROWL_INJECT_GAIN,
      driveScale: GROWL_DRIVE_SCALE,
    },
  });
  input.connect(growlNode);

  // growl_render() has no dry-signal passthrough built into it — it's a
  // pure wet processor — so dry/wet mixing has to happen out here in JS,
  // same nodes/roles as the native version's own dry/wet/mixBus.
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const mix = Math.min(1, Math.max(0, entity.params.mix ?? 0.7));
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;

  const mixBus = ctx.createGain();
  // A dedicated mute stage, separate from `level`/`mix` — see `kill`'s own
  // comment below for why this needs to be its own node rather than reusing
  // either of those.
  const killMute = ctx.createGain();
  const outLevel = ctx.createGain();
  outLevel.gain.value = entity.params.level ?? 0.8;

  input.connect(dry);
  dry.connect(mixBus);
  growlNode.connect(wet);
  wet.connect(mixBus);
  mixBus.connect(killMute);
  killMute.connect(outLevel);

  // Unlike the native version, the WASM loop is bounded by construction
  // (see growlNode's own comment above) and can't actually diverge on its
  // own — but `kill` is kept anyway, both for controlSpecs.ts UI parity and
  // as a genuine "make it stop right now" for a loud resonance that's just
  // musically unwanted mid-performance: it mutes the audible output
  // immediately (killMute) and tells the WASM instance to drop its
  // internal ringing state instantly (growl_reset) rather than waiting for
  // it to decay under continued silence.
  let currentKill = Math.min(1, Math.max(0, entity.params.kill ?? 0));
  killMute.gain.value = 1 - currentKill;

  registerControls(entity.id, {
    level: (value) => outLevel.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    frequency: (value) => growlNode.port.postMessage({ type: 'setFrequency', value }),
    q: (value) => growlNode.port.postMessage({ type: 'setQ', value: Math.min(GROWL_MAX_Q, Math.max(0.1, value)) }),
    feedback: (value) => {
      growlNode.port.postMessage({ type: 'setFeedback', value: Math.min(GROWL_MAX_FEEDBACK, Math.max(0, value)) });
    },
    kill: (value) => {
      currentKill = Math.min(1, Math.max(0, value));
      killMute.gain.setTargetAtTime(1 - currentKill, ctx.currentTime, 0.01);
      if (currentKill >= 1) {
        growlNode.port.postMessage({ type: 'reset' });
      }
    },
    mix: (value) => {
      const m = Math.min(1, Math.max(0, value));
      dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.01);
      wet.gain.setTargetAtTime(m, ctx.currentTime, 0.01);
    },
  });

  return outLevel;
}

const VOCODE_ENVELOPE_LOWPASS_HZ = 15;
const VOCODE_ENVELOPE_SCALE = 3; // tuned by ear — brings the rectified/smoothed input up near outputGate's own 0..1 working range

// Fixed abs-value rectifying curve for createVocodeFilter's own envelope
// follower below — unlike makeOverdriveCurve/makeFuzzCurve above, this
// isn't parameterized by any per-instance amount, so it's just built once.
const ABS_CURVE = (() => {
  const samples = 256;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.abs(x);
  }
  return curve;
})();

// A pitch-shifting "vocode" filter — NOT a direct filter on the contained
// input's own waveform. See audio/vocodePlayer.ts's own header for the
// full source-filter/resynthesis reasoning: a continuous oscillator drives
// a fixed formant filter bank, both built/owned by that module. What IS
// built from the live `input` here is (a) a one-shot analysis trigger,
// auto-primed the first time it starts sounding, and (b) a continuous
// envelope follower, so the resynthesized drone tracks whether the
// contained source is currently sounding rather than running on regardless
// once primed.
function createVocodeFilter(entity: Entity, input: GainNode): AudioNode {
  const ctx = getAudioContext();

  const voice = startVocodeVoice({
    targetPitch: entity.params.targetPitch ?? 110,
  });
  vocodeVoices.set(entity.id, voice);

  // The pedal's other resynthesis engine (audio/vocodeGranularPlayer.ts) —
  // built and run alongside the oscillator/formant-bank one above
  // regardless of which is currently selected (see the mode-select gain
  // stage below); ui/vocodeTuner.ts's mode toggle just crossfades between
  // their two already-live outputs.
  const granularVoice = startVocodeGranularVoice(input);
  granularVoice.setTargetPitch(entity.params.targetPitch ?? 110);
  // Seeded from whatever was last locked in (persists on the entity itself
  // across a rebuild, unlike the formant bank above, which has no simple
  // persisted equivalent and really does start empty until the next
  // auto-prime/re-analyze) — this engine's own window-length/rate math
  // depends on f0 even before that next analysis runs.
  granularVoice.setF0(entity.params.f0 ?? 110);
  vocodeGranularVoices.set(entity.id, granularVoice);

  // Envelope follower: rectify (abs-value WaveShaper) + smooth (a slow
  // lowpass) the live input, then connect that signal straight into both
  // engines' own outputGate.gain AudioParam — connecting an audio-rate
  // signal into an AudioParam sums with its base .value, same idiom
  // createModulatedDelay below uses for its own LFO. Each outputGate's base
  // value is 0 (see startVocodeVoice's own comment), so whichever engine's
  // resynthesized output is level is driven almost entirely by this
  // envelope rather than running open-loop regardless of whether anything's
  // actually playing.
  const rectifier = ctx.createWaveShaper();
  rectifier.curve = ABS_CURVE;
  const envelopeSmoother = ctx.createBiquadFilter();
  envelopeSmoother.type = 'lowpass';
  envelopeSmoother.frequency.value = VOCODE_ENVELOPE_LOWPASS_HZ;
  const envelopeScale = ctx.createGain();
  envelopeScale.gain.value = VOCODE_ENVELOPE_SCALE;

  input.connect(rectifier);
  rectifier.connect(envelopeSmoother);
  envelopeSmoother.connect(envelopeScale);
  envelopeScale.connect(voice.outputGate.gain);
  envelopeScale.connect(granularVoice.outputGate.gain);

  // Auto-prime: the first time the contained input actually sounds, take
  // one analysis snapshot (analyzeAndApplyVocode above) and lock it in — a
  // ONE-SHOT trigger, not a continuous tracker. The watcher stops itself
  // right after firing; ui/vocodeTuner.ts's manual re-analyze button is the
  // way to re-prime later (e.g. after swapping in a different contained
  // source, which this auto-trigger — deliberately — won't notice).
  const watcher = watchSound(input, (sounding) => {
    if (!sounding) return;
    vocodeAutoPrimeWatchers.get(entity.id)?.stop();
    vocodeAutoPrimeWatchers.delete(entity.id);
    analyzeAndApplyVocode(entity);
  });
  vocodeAutoPrimeWatchers.set(entity.id, watcher);

  // Dry/wet mix, then a post-mix level — same shape (and same reasoning)
  // as createGrowlFilter's own dry/wet/mixBus/outLevel above: `level`
  // needs to scale the pedal's WHOLE audible output, dry included, not
  // just the resynthesized voice — a level knob that only touched the wet
  // path would appear to do nothing at mix=0 (fully dry), which reads as
  // broken rather than as "level only affects the wet signal."
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const mix = Math.min(1, Math.max(0, entity.params.mix ?? 0.85));
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;

  const mixBus = ctx.createGain();
  const outLevel = ctx.createGain();
  outLevel.gain.value = entity.params.level ?? 0.7;

  // Mode-select: both engines' own outputGate feed the SAME wet bus, each
  // through its own gain that setVocodeMode above crossfades between — the
  // inactive engine keeps running (see startVocodeGranularVoice's own
  // comment), just silent, so a mode switch is a plain gain crossfade with
  // no node rebuild.
  const vocoderModeGain = ctx.createGain();
  const granularModeGain = ctx.createGain();
  const initialMode = entity.params.mode === 1 ? 1 : 0;
  vocoderModeGain.gain.value = initialMode === 0 ? 1 : 0;
  granularModeGain.gain.value = initialMode === 1 ? 1 : 0;
  voice.outputGate.connect(vocoderModeGain);
  granularVoice.outputGate.connect(granularModeGain);
  vocoderModeGain.connect(wet);
  granularModeGain.connect(wet);
  vocodeModeGainsByEntity.set(entity.id, { vocoderModeGain, granularModeGain });

  input.connect(dry);
  dry.connect(mixBus);
  wet.connect(mixBus);
  mixBus.connect(outLevel);

  registerControls(entity.id, {
    level: (value) => outLevel.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    targetPitch: (value) => {
      voice.set('targetPitch', value);
      granularVoice.setTargetPitch(value);
    },
    mix: (value) => {
      const m = Math.min(1, Math.max(0, value));
      dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.01);
      wet.gain.setTargetAtTime(m, ctx.currentTime, 0.01);
    },
  });

  return outLevel;
}

// A ring modulator: multiplies the input by a carrier oscillator (rather
// than filtering/shaping it), the classic inharmonic "robotic/metallic
// clang" effect (industrial — Skinny Puppy/NIN-adjacent — and dissonant
// avant-garde metal alike) nothing else in this palette currently makes,
// since nothing else does amplitude modulation. GainNode computes
// output = input * gain; base gain value 0 plus ONE audio-rate signal
// connected into that AudioParam makes the effective per-sample gain
// literally BE the carrier's own waveform each sample — genuine
// multiplication, not the additive LFO idiom createModulatedDelay below
// (or audio/vocodePlayer.ts's envelope follower) uses elsewhere; the only
// difference is what the gain's own base .value is (0 here vs a nonzero
// baseline there). No worklet, no WASM — natively exact.
function createRingModFilter(entity: Entity, input: GainNode): AudioNode {
  const ctx = getAudioContext();

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = entity.params.frequency ?? 200;
  carrier.start();

  const ring = ctx.createGain();
  ring.gain.value = 0; // carrier IS the effective gain — see this function's own header
  input.connect(ring);
  carrier.connect(ring.gain);

  // Dry/wet mix, then a post-mix level — same shape as createGrowlFilter's
  // own dry/wet/mixBus/outLevel.
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const mix = Math.min(1, Math.max(0, entity.params.mix ?? 0.8));
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;

  const mixBus = ctx.createGain();
  const outLevel = ctx.createGain();
  outLevel.gain.value = entity.params.level ?? 0.7;

  input.connect(dry);
  dry.connect(mixBus);
  ring.connect(wet);
  wet.connect(mixBus);
  mixBus.connect(outLevel);

  registerControls(entity.id, {
    level: (value) => outLevel.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    frequency: (value) => carrier.frequency.setTargetAtTime(value, ctx.currentTime, 0.01),
    mix: (value) => {
      const m = Math.min(1, Math.max(0, value));
      dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.01);
      wet.gain.setTargetAtTime(m, ctx.currentTime, 0.01);
    },
  });

  return outLevel;
}

// Fixed staircase-quantization curve for createBitcrushFilter's own
// bit-depth reduction — same WaveShaperNode-as-lookup-table idiom as
// makeOverdriveCurve/makeFuzzCurve above, just rounding to `2^bits`
// discrete levels instead of clipping/folding. Rebuilt on every `bits`
// control change (cheap — 1024 samples), same convention as those curves'
// own live `drive`/`fuzz` updates.
function makeBitcrushCurve(bits: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const levels = Math.max(2, Math.pow(2, Math.round(bits)));
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.round((x * levels) / 2) / (levels / 2);
  }
  return curve;
}

function bitcrushHoldSamples(sampleRate: number, rateHz: number): number {
  return Math.max(1, Math.round(sampleRate / Math.min(sampleRate, Math.max(200, rateHz))));
}

// A bitcrusher: the other pillar of noise/industrial digital harshness
// (Author & Punisher, digital hardcore/breakcore) alongside the ring
// modulator above — two independent stages, each the cheapest tool that
// actually does the job. Bit-depth reduction (the "stair-stepped
// amplitude" half) is a pure lookup-table transform, so a native
// WaveShaperNode (makeBitcrushCurve above) handles it with no worklet at
// all. Sample-rate reduction (the "aliased/crunchy" half, and the actual
// reason for dsp/worklets/bitcrush-processor.js to exist) genuinely needs
// per-sample state — held value, tick counter — a native node has no way
// to express; see that worklet's own header for why this doesn't need
// WASM either. Conventional order: decimate first, then quantize, same as
// a real lo-fi sampler's own ADC path.
function createBitcrushFilter(entity: Entity, input: GainNode): AudioNode {
  const ctx = getAudioContext();

  const rateHz = entity.params.rate ?? 4000;
  const decimator = new AudioWorkletNode(ctx, 'bitcrush-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { holdSamples: bitcrushHoldSamples(ctx.sampleRate, rateHz) },
  });
  input.connect(decimator);

  const quantizer = ctx.createWaveShaper();
  quantizer.curve = makeBitcrushCurve(entity.params.bits ?? 4);
  decimator.connect(quantizer);

  // Dry/wet mix, then a post-mix level — same shape as createGrowlFilter's
  // own dry/wet/mixBus/outLevel.
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const mix = Math.min(1, Math.max(0, entity.params.mix ?? 0.85));
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;

  const mixBus = ctx.createGain();
  const outLevel = ctx.createGain();
  outLevel.gain.value = entity.params.level ?? 0.7;

  input.connect(dry);
  dry.connect(mixBus);
  quantizer.connect(wet);
  wet.connect(mixBus);
  mixBus.connect(outLevel);

  registerControls(entity.id, {
    level: (value) => outLevel.gain.setTargetAtTime(value, ctx.currentTime, 0.01),
    rate: (value) => {
      decimator.port.postMessage({ type: 'setHoldSamples', value: bitcrushHoldSamples(ctx.sampleRate, value) });
    },
    bits: (value) => {
      quantizer.curve = makeBitcrushCurve(value);
    },
    mix: (value) => {
      const m = Math.min(1, Math.max(0, value));
      dry.gain.setTargetAtTime(1 - m, ctx.currentTime, 0.01);
      wet.gain.setTargetAtTime(m, ctx.currentTime, 0.01);
    },
  });

  return outLevel;
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
  const pan = ctx.createStereoPanner();
  output.connect(pan);

  const processorTail = createProcessor(entity, input);
  if (processorTail) {
    processorTail.connect(output);
  } else {
    input.connect(output);
  }

  const generator = createGenerator(entity, graph);
  if (generator) generator.connect(output);

  const nodes: EntityNodes = { input, output, pan };
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
      } else if (entity.kind === 'sequencer') {
        const feature = graph.featuresOf(entity.id).find((f) => f.kind === 'sequencer');
        if (feature) registerSequencerForPlayback(entity.id, feature.id);
      } else if (entity.kind === 'beatMatcher') {
        const feature = graph.featuresOf(entity.id).find((f) => f.kind === 'beatMatcher');
        if (feature) registerBeatMatcherForPlayback(entity.id, feature.id);
      } else if (entity.kind === 'lfo') {
        // Unlike every other Control kind, this one DOES need a real,
        // permanently-running Web Audio node — see lfoOscillatorsByEntity's
        // own comment above for why. Left unconnected to anything until a
        // wire actually lands on a synthConfig depth port
        // (reconcileSynthConfigModulation) — a plain running oscillator
        // with nothing downstream is silent and harmless.
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = entity.params.rate ?? 4;
        osc.start();
        lfoOscillatorsByEntity.set(entity.id, osc);
        registerControls(entity.id, {
          rate: (value) => osc.frequency.setTargetAtTime(value, ctx.currentTime, 0.01),
        });
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
      nodes.pan.connect(parentNodes.input);
    } else {
      nodes.pan.connect(master);
    }
  }
}

export function getEntityNodes(id: string): EntityNodes | undefined {
  return nodesByEntity.get(id);
}

// Live re-routing for a drag-driven reparent (ui/interaction.ts) — an
// entity's `pan` (its final stereo-positioned output — see EntityNodes)
// only ever has one outgoing connection (its parent's input, or master), so
// disconnecting everything and reconnecting once is correct, not just
// convenient. A no-op if the entity has no audio nodes yet (e.g. the graph
// was rearranged before the user started audio).
export function reparentEntity(id: string, newParentId: string | null): void {
  const nodes = nodesByEntity.get(id);
  if (!nodes) return;

  nodes.pan.disconnect();

  const parentNodes = newParentId ? nodesByEntity.get(newParentId) : undefined;
  if (parentNodes) {
    nodes.pan.connect(parentNodes.input);
  } else {
    nodes.pan.connect(getMasterChain());
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
  // Control entities (knobs, etc.) don't make or process sound — see
  // buildFromEntityGraph's own matching skip above. Controls never dock
  // (ui/docking.ts's isDockable), so this guard is only ever defensive —
  // but cheap insurance against createNodes below being attempted against
  // a kind it has no case for (e.g. a control-CONTAINING control like
  // wander/jitter, ui/controlSpecs.ts's CONTROL_CONTAINER_KINDS, which
  // never needs audio nodes of its own) if that ever changes.
  if (entity.type === 'control') return;

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

  nodes.pan.disconnect(); // in case it was already connected somewhere
  const parentNodes = entity.parentId ? nodesByEntity.get(entity.parentId) : undefined;
  if (parentNodes) {
    nodes.pan.connect(parentNodes.input);
  } else {
    nodes.pan.connect(getMasterChain());
  }
}

// Drag an instrument from the canvas into the dock: silence it by
// disconnecting its final output from wherever it currently feeds — its
// nodes are kept around (not torn down), so dragging it back out later is a
// cheap reconnect via activateEntity() above rather than a rebuild. A no-op
// if it was never built (docked before "start audio" was ever pressed).
export function deactivateEntity(id: string): void {
  const nodes = nodesByEntity.get(id);
  if (!nodes) return;
  nodes.pan.disconnect();
}

// Restores entity.params to whatever it was FIRST added to the graph with
// (EntityGraph's own defaultParams snapshot) — a recovery path for a voice
// left in a bad state by an extreme tuning value, per ui/interaction.ts's
// finalizeDrop (dragging an entity into the dock and back out). A no-op if
// this entity was never actually added through EntityGraph.add() (shouldn't
// happen for anything reachable from the canvas).
export function resetEntityToDefaults(entity: Entity, graph: EntityGraph): void {
  const defaults = graph.defaultParamsFor(entity.id);
  if (defaults) entity.params = { ...defaults };
}

// Discards this entity's audio nodes entirely — unlike deactivateEntity's
// own "keep nodes around, just disconnect" convention (its own comment
// above), nothing here is reused: every per-entity cache this file keeps
// (nodesByEntity and friends) is cleared for this id first, so the
// activateEntity() call at the end takes the "nothing found, build fresh"
// path instead of reconnecting whatever was there. That's the actual
// recovery a "turn it off and on again" gesture needs — a crashed/stuck
// WASM instance or JS closure won't fix itself by merely being
// reconnected. Nothing else in the app relies on node IDENTITY surviving a
// rebuild, only on these maps pointing at SOMETHING live for this id, so
// this is safe to call any time the entity is off-canvas (disconnected
// already) — see ui/interaction.ts's finalizeDrop for the one call site.
export function rebuildEntity(entity: Entity, graph: EntityGraph): void {
  const old = nodesByEntity.get(entity.id);
  if (old) old.pan.disconnect();
  nodesByEntity.delete(entity.id);
  controlsByEntity.delete(entity.id);
  triggersByEntity.delete(entity.id);
  releasesByEntity.delete(entity.id);
  stopsByEntity.delete(entity.id);
  pauseGatesByEntity.delete(entity.id);
  pausedEntities.delete(entity.id);
  sustainedEntities.delete(entity.id);
  playingEntities.delete(entity.id);
  melodyOwnersByEntity.delete(entity.id);
  // Stops the old instance's setInterval scheduler before dropping the
  // reference — otherwise a 'grain' voice rebuilt this way (drag out of the
  // dock, then back in) would leak a still-ticking scheduler forever, on
  // top of the fresh one createGenerator's own 'grain' case starts below.
  grainVoices.get(entity.id)?.stop();
  grainVoices.delete(entity.id);
  // Same reasoning, for a 'vocode' pedal's own oscillator plus (if it
  // never fired) its still-pending auto-prime watcher, plus its other
  // (granular) resynthesis engine and their shared mode-select gains.
  vocodeVoices.get(entity.id)?.stop();
  vocodeVoices.delete(entity.id);
  vocodeGranularVoices.get(entity.id)?.stop();
  vocodeGranularVoices.delete(entity.id);
  vocodeModeGainsByEntity.delete(entity.id);
  vocodeAutoPrimeWatchers.get(entity.id)?.stop();
  vocodeAutoPrimeWatchers.delete(entity.id);
  activateEntity(entity, graph);
}
