// Continuous resynthesis engine for the 'vocode' pedal (audio/graph.ts's
// 'vocode' case) — an oscillator driving a bank of fixed bandpass filters
// (the "formants" extracted by ui/pitchAnalysis.ts), NOT a direct filter on
// the live input's own waveform. This is deliberately independent of the
// dsp/rust WASM machinery every other voice with a resonant/feedback
// element (audio/grindPlayer.ts, growl) needs: a parallel bank of
// non-feedback bandpass taps is unconditionally stable, so plain native
// BiquadFilterNodes suffice — see TODO.md's vocode entry for the fuller
// reasoning.
//
// This module only does synthesis. Analysis (f0/formant extraction) lives
// in ui/pitchAnalysis.ts and is triggered by audio/graph.ts's own one-shot
// "auto-prime on first sound" watcher plus ui/vocodeTuner.ts's manual
// re-analyze button — neither keeps an AudioBuffer around, so neither does
// this module.

import { getAudioContext } from './context';
import type { Formant } from '../ui/pitchAnalysis';

const FILTER_Q = 10; // tuned by ear; not yet a control-dot, same "start as a fixed constant" convention as GRAIN_TUNING's own early days

export interface VocodeVoiceControls {
  get: (key: string) => number;
  set: (key: string, value: number) => void; // 'targetPitch' — 'level' and 'mix' are audio/graph.ts's own post-mix stages, not this module's concern (see createVocodeFilter's own comment on why)
  setFormants: (formants: Formant[]) => void;
  // Exposed so audio/graph.ts's own envelope-follower (built from the
  // pedal's live input, outside this module) can connect its rectified/
  // smoothed signal straight into this gain stage's own AudioParam —
  // that's what makes the resynthesized output continuously track whether
  // the contained source is actually sounding, rather than droning on
  // regardless once primed. Also what createVocodeFilter taps as its own
  // "wet" signal for the dry/wet mix it builds around this voice.
  outputGate: GainNode;
  stop: () => void;
}

// Starts a continuous vocode voice. Unlike audio/grainPlayer.ts/
// audio/grindPlayer.ts's own startXVoice (SOURCE voices, connected onward
// to a `destination` an entity's own further internal stages provide), this
// is a PROCESSOR — audio/graph.ts's createVocodeFilter returns `outputGate`
// itself as the processor's own tail node, left for its caller
// (createNodes) to connect onward, same "return the tail, don't connect it
// yourself" convention every other createXFilter in that file follows (see
// e.g. its own 'overdrive' case). The oscillator runs immediately; with
// zero formants connected (the idle state, before any analysis has run)
// nothing bridges it to `outputGate` at all, so it's silent by construction
// rather than needing an explicit mute flag.
export function startVocodeVoice(initialParams: Record<string, number>): VocodeVoiceControls {
  const ctx = getAudioContext();

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = initialParams.targetPitch ?? 110;
  osc.start();

  const formantBus = ctx.createGain(); // unity summing junction for the filter bank's own per-band gains

  const outputGate = ctx.createGain();
  outputGate.gain.value = 0; // envelope-driven from outside — see outputGate's own comment above

  formantBus.connect(outputGate);

  let filterTaps: { filter: BiquadFilterNode; gain: GainNode }[] = [];

  function clearFilterTaps(): void {
    for (const tap of filterTaps) {
      // Disconnecting the filter's own OUTPUT (tap.filter.disconnect())
      // isn't enough on its own — osc's connection INTO the filter is a
      // separate edge, on osc's own output side, that survives that call.
      // Left unpaired, every setFormants call (which can fire every
      // REANALYZE_THROTTLE_MS while ui/vocodeTuner.ts's marker is being
      // dragged) would leak one more dangling osc->filter edge forever.
      osc.disconnect(tap.filter);
      tap.filter.disconnect();
      tap.gain.disconnect();
    }
    filterTaps = [];
  }

  function setFormants(formants: Formant[]): void {
    clearFilterTaps();
    for (const formant of formants) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = formant.freq;
      filter.Q.value = FILTER_Q;
      const gain = ctx.createGain();
      gain.gain.value = formant.gain;

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(formantBus);
      filterTaps.push({ filter, gain });
    }
  }

  return {
    get: (key: string) => (key === 'targetPitch' ? osc.frequency.value : 0),
    set: (key: string, value: number) => {
      if (key === 'targetPitch') osc.frequency.setTargetAtTime(value, ctx.currentTime, 0.02);
    },
    setFormants,
    outputGate,
    stop: () => {
      clearFilterTaps();
      osc.stop();
      osc.disconnect();
      formantBus.disconnect();
      outputGate.disconnect();
    },
  };
}
