// The 'noisegate' pedal's own tuning organelle (EntityType 'feature',
// kind 'noisegateTuning') — a thin config wrapper around
// ui/tuningOrganelle.ts's shared factory (see that module's own header for
// what the popup actually does), same pattern ui/grindTuner.ts established
// first. Unlike grind's tuning constants (plain JS state) or bass's (WASM
// voice memory), the noise gate's three tuning constants (attack/release/
// hold — audio/noisegateTuning.ts) live inside its own AudioWorkletNode's
// per-sample state machine (dsp/worklets/noisegate-processor.js) — the
// organelle itself doesn't need to know that; it just calls
// getControlSetter like any other control, and audio/graph.ts's
// 'noisegate' case is what forwards through the worklet's message port
// instead of mutating a JS object directly.

import { createTuningOrganelle } from './tuningOrganelle';
import { NOISEGATE_TUNING } from '../audio/noisegateTuning';

const organelle = createTuningOrganelle({
  featureKind: 'noisegateTuning',
  voiceKind: 'noisegate',
  title: 'noise gate tuning',
  coreKeys: ['level', 'threshold', 'mix'],
  coreStep: { level: 0.01, threshold: 0.005, mix: 0.01 },
  // coreKeys aren't part of NOISEGATE_TUNING (they're the pedal's own pre-
  // existing control-dot params, sourced from ui/controlSpecs.ts instead),
  // so their hover-tooltip text lives here alongside them, same "how this
  // relates to the algorithm" spirit as NOISEGATE_TUNING's own
  // `description`.
  coreDescriptions: {
    level: 'Overall output volume of the pedal, after the dry/wet mix.',
    threshold: 'The input level (linear amplitude) the gate opens above — everything quieter than this gets pulled toward silence, everything louder passes through, shaped by attack/release/hold below.',
    mix: 'Blends the gated signal back in with the untouched dry input — 1 is a normal gate, lower values are a parallel-gating effect (a tightened copy layered under the original) rather than full replacement.',
  },
  tuning: NOISEGATE_TUNING,
  tuningColor: '#7ec850',
  tuningInterfaceName: 'NoisegateTuningParam',
  tuningExportName: 'NOISEGATE_TUNING',
  tuningFilePath: 'audio/noisegateTuning.ts',
  controlSpecsFilePath: 'ui/controlSpecs.ts',
  mainFilePath: 'ui/main.ts',
  mainEntityId: 'noisegate-1',
});

export const hitTestNoisegateTunerPopup = organelle.hitTestPopup;
export const drawNoisegateTunerPopup = organelle.drawPopup;
export const setNoisegateTunerValue = organelle.setValue;
export const setNoisegateTunerMin = organelle.setMin;
export const setNoisegateTunerMax = organelle.setMax;
export const beginNoisegateTunerMaxDrag = organelle.beginMaxDrag;
export const toggleNoisegateTunerExposed = organelle.toggleExposed;
export const noisegateTunerRawValueAtPoint = organelle.rawValueAtPoint;
export const copyNoisegateTuning = organelle.copyTuning;
