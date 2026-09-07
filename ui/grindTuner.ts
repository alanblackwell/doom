// The 'grind' source voice's own tuning organelle (EntityType 'feature',
// kind 'grindTuning') — a thin config wrapper around
// ui/tuningOrganelle.ts's shared factory (see that module's own header for
// what the popup actually does: live sliders, expose-as-control-dot
// checkboxes, draggable min/max carets, hover tooltips, and a Copy button
// producing ready-to-paste source text). This was the first voice the
// pattern was built for; ui/bassTuner.ts is the second, using the exact
// same factory.

import { createTuningOrganelle } from './tuningOrganelle';
import { GRIND_TUNING } from '../audio/grindPlayer';

const organelle = createTuningOrganelle({
  featureKind: 'grindTuning',
  voiceKind: 'grind',
  title: 'grind tuning',
  coreKeys: ['level', 'frequency', 'grind'],
  coreStep: { level: 0.01, frequency: 1, grind: 0.01 },
  // CORE_KEYS aren't part of GRIND_TUNING (they're the voice's own pre-
  // existing control-dot params, sourced from ui/controlSpecs.ts instead),
  // so their hover-tooltip text lives here alongside them, same "how this
  // relates to the algorithm" spirit as GRIND_TUNING's own `description`.
  coreDescriptions: {
    level: 'Overall output volume of the voice, after all grains are mixed.',
    frequency: "Center frequency each grain's own bandpass filter targets — the pitch the grinding texture centers around.",
    grind: 'Blends grain density and pitch chaos together, from sparse individual scrapes (0) to a dense chaotic roar (1) — see grainIntervalMin/Max and filterJitter below.',
  },
  tuning: GRIND_TUNING,
  tuningColor: '#7ec850',
  tuningInterfaceName: 'GrindTuningParam',
  tuningExportName: 'GRIND_TUNING',
  tuningFilePath: 'audio/grindPlayer.ts',
  controlSpecsFilePath: 'ui/controlSpecs.ts',
  mainFilePath: 'ui/main.ts',
  mainEntityId: 'grind-1',
  // 'grind' is the one row with a genuine logical ceiling — the voice
  // itself hard-clamps it to [0,1] (audio/grindPlayer.ts's startGrindVoice
  // 'set'), so there's no point letting the caret drag (or the track
  // rescale) past 1 at all.
  hardMax: { grind: 1 },
});

export const hitTestGrindTunerPopup = organelle.hitTestPopup;
export const drawGrindTunerPopup = organelle.drawPopup;
export const setGrindTunerValue = organelle.setValue;
export const setGrindTunerMin = organelle.setMin;
export const setGrindTunerMax = organelle.setMax;
export const beginGrindTunerMaxDrag = organelle.beginMaxDrag;
export const toggleGrindTunerExposed = organelle.toggleExposed;
export const grindTunerRawValueAtPoint = organelle.rawValueAtPoint;
export const copyGrindTuning = organelle.copyTuning;
