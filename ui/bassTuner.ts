// The 'bass' source voice's own tuning organelle (EntityType 'feature',
// kind 'bassTuning') — a thin config wrapper around
// ui/tuningOrganelle.ts's shared factory (see that module's own header for
// what the popup actually does), same pattern ui/grindTuner.ts established
// first. Unlike grind's tuning constants (plain JS state), bass's two
// (detune/drive — audio/bassTuning.ts) live inside the WASM voice's own
// memory (dsp/rust/src/lib.rs's bass_set_detune/bass_set_drive) — the
// organelle itself doesn't need to know that; it just calls
// getControlSetter like any other control, and audio/graph.ts's 'bass'
// case is what forwards through the worklet's message port instead of
// mutating a JS object directly.

import { createTuningOrganelle } from './tuningOrganelle';
import { BASS_TUNING } from '../audio/bassTuning';

const organelle = createTuningOrganelle({
  featureKind: 'bassTuning',
  voiceKind: 'bass',
  title: 'bass tuning',
  coreKeys: ['level', 'frequency'],
  coreStep: { level: 0.01, frequency: 0.1 },
  // coreKeys aren't part of BASS_TUNING (they're the voice's own pre-
  // existing control-dot params, sourced from ui/controlSpecs.ts instead),
  // so their hover-tooltip text lives here alongside them, same "how this
  // relates to the algorithm" spirit as BASS_TUNING's own `description`.
  coreDescriptions: {
    level: 'Overall output volume of the voice.',
    frequency: 'Fundamental pitch both detuned saw oscillators are built from — the note the drone sounds at.',
  },
  tuning: BASS_TUNING,
  tuningColor: '#7ec850',
  tuningInterfaceName: 'BassTuningParam',
  tuningExportName: 'BASS_TUNING',
  tuningFilePath: 'audio/bassTuning.ts',
  controlSpecsFilePath: 'ui/controlSpecs.ts',
  mainFilePath: 'ui/main.ts',
  mainEntityId: 'bass-1',
});

export const hitTestBassTunerPopup = organelle.hitTestPopup;
export const drawBassTunerPopup = organelle.drawPopup;
export const setBassTunerValue = organelle.setValue;
export const setBassTunerMin = organelle.setMin;
export const setBassTunerMax = organelle.setMax;
export const beginBassTunerMaxDrag = organelle.beginMaxDrag;
export const toggleBassTunerExposed = organelle.toggleExposed;
export const bassTunerRawValueAtPoint = organelle.rawValueAtPoint;
export const copyBassTuning = organelle.copyTuning;
