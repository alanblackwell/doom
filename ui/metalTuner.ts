// The 'metal' source voice's own tuning organelle (EntityType 'feature',
// kind 'metalTuning') — a thin config wrapper around
// ui/tuningOrganelle.ts's shared factory (see that module's own header),
// same pattern ui/grindTuner.ts/ui/bassTuner.ts established first. Unlike
// those two, every one of metal's CORE_KEYS already had a control-dot
// (pitch/damping/response/feedback/feedbackFreq) before this — the point of
// building this organelle wasn't to expose brand-new controls so much as to
// put ALL of them (existing plus the three new METAL_TUNING extras) in one
// place with wider, draggable ranges, to find out whether 'metal' not
// sounding usable is actually just a matter of parameter values.

import { createTuningOrganelle } from './tuningOrganelle';
import { METAL_TUNING } from '../audio/metalTuning';

const organelle = createTuningOrganelle({
  featureKind: 'metalTuning',
  voiceKind: 'metal',
  title: 'metal tuning',
  coreKeys: ['level', 'pitch', 'damping', 'response', 'feedback', 'feedbackFreq'],
  coreStep: { level: 0.01, pitch: 0.1, damping: 0.01, response: 0.01, feedback: 0.01, feedbackFreq: 1 },
  // coreKeys aren't part of METAL_TUNING (they're the voice's own pre-
  // existing control-dot params, sourced from ui/controlSpecs.ts instead),
  // so their hover-tooltip text lives here alongside them, same "how this
  // relates to the algorithm" spirit as METAL_TUNING's own `description`.
  coreDescriptions: {
    level: 'Overall output volume of the voice.',
    pitch: "Fundamental frequency of the plucked string (the Karplus-Strong delay line's own length) — the note played.",
    damping:
      "How quickly the string's own energy decays each cycle (pluck_render's pole/loop_gain, dsp/rust/src/lib.rs) — higher dulls and shortens the ring, lower lets it ring longer and brighter.",
    response:
      'Brightness of the initial pluck excitation (pluck_excite\'s noise-shaping pole) — higher is a sharper, pick-like attack; lower a duller, thumb-like one.',
    feedback:
      "Amount of amp/pickup-style positive feedback reinjected into the string (pluck_render's feedback branch) — 0 is a plain decaying pluck, higher sustains and pushes toward a self-oscillating squeal.",
    feedbackFreq:
      'Fixed frequency the feedback locks onto (svf_bandpass) — stands in for the amp/room\'s own resonance rather than tracking the note\'s own pitch, so which notes squeal most readily depends on how close one of their own partials lands here.',
  },
  tuning: METAL_TUNING,
  tuningColor: '#7ec850',
  tuningInterfaceName: 'MetalTuningParam',
  tuningExportName: 'METAL_TUNING',
  tuningFilePath: 'audio/metalTuning.ts',
  controlSpecsFilePath: 'ui/controlSpecs.ts',
  mainFilePath: 'ui/main.ts',
  mainEntityId: 'metal-1',
  // damping/response/feedback are all hard-clamped to [0,1] in the WASM
  // voice itself (dsp/rust/src/lib.rs's pluck_set_damping/pluck_set_
  // response/pluck_set_feedback) — no point letting their carets (or the
  // track scale) go past 1 at all.
  hardMax: { damping: 1, response: 1, feedback: 1 },
});

export const hitTestMetalTunerPopup = organelle.hitTestPopup;
export const drawMetalTunerPopup = organelle.drawPopup;
export const setMetalTunerValue = organelle.setValue;
export const setMetalTunerMin = organelle.setMin;
export const setMetalTunerMax = organelle.setMax;
export const beginMetalTunerMaxDrag = organelle.beginMaxDrag;
export const toggleMetalTunerExposed = organelle.toggleExposed;
export const metalTunerRawValueAtPoint = organelle.rawValueAtPoint;
export const copyMetalTuning = organelle.copyTuning;
