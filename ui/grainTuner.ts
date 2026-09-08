// The 'grain' source voice's own tuning organelle (EntityType 'feature',
// kind 'grainTuning') — a thin config wrapper around
// ui/tuningOrganelle.ts's shared factory (see that module's own header for
// what the popup actually does), same pattern ui/grindTuner.ts established
// first. Unlike grind's grains (cut from generated noise), this voice's
// grains are cut from a real captured sample (ui/grainSampler.ts's popup),
// but the tuning organelle itself doesn't care about that distinction — it
// just exposes audio/grainPlayer.ts's own GRAIN_TUNING constants as live
// sliders the same way.

import { createTuningOrganelle } from './tuningOrganelle';
import { GRAIN_TUNING } from '../audio/grainPlayer';

const organelle = createTuningOrganelle({
  featureKind: 'grainTuning',
  voiceKind: 'grain',
  title: 'grain tuning',
  coreKeys: ['level', 'density', 'grainLength'],
  coreStep: { level: 0.01, density: 0.01, grainLength: 0.005 },
  // coreKeys aren't part of GRAIN_TUNING (they're the voice's own pre-
  // existing control-dot params, sourced from ui/controlSpecs.ts instead),
  // so their hover-tooltip text lives here alongside them, same "how this
  // relates to the algorithm" spirit as GRAIN_TUNING's own `description`.
  coreDescriptions: {
    level: 'Overall output volume of the voice, after all grains are mixed.',
    density: 'How tightly packed grains are, from sparse individually audible grains (0) to a dense continuous cloud (1) — sets the gap between grain onsets, see interval @ density=0/1 below.',
    grainLength: "Duration of each grain's own playback window, in seconds, read from the captured buffer starting at whichever point it picked. Raising this relative to the density-driven interval is the main lever for making grains overlap instead of reading as separate rhythmic clicks.",
  },
  tuning: GRAIN_TUNING,
  tuningColor: '#7ec850',
  tuningInterfaceName: 'GrainTuningParam',
  tuningExportName: 'GRAIN_TUNING',
  tuningFilePath: 'audio/grainPlayer.ts',
  controlSpecsFilePath: 'ui/controlSpecs.ts',
  mainFilePath: 'ui/main.ts',
  mainEntityId: 'grain-1',
  // 'density' is the one row with a genuine logical ceiling — the voice
  // itself hard-clamps it to [0,1] (audio/grainPlayer.ts's startGrainVoice
  // 'set'), so there's no point letting the caret drag (or the track
  // rescale) past 1 at all. Same reasoning as grind's own hardMax:{grind:1}.
  hardMax: { density: 1 },
});

export const hitTestGrainTunerPopup = organelle.hitTestPopup;
export const drawGrainTunerPopup = organelle.drawPopup;
export const setGrainTunerValue = organelle.setValue;
export const setGrainTunerMin = organelle.setMin;
export const setGrainTunerMax = organelle.setMax;
export const beginGrainTunerMaxDrag = organelle.beginMaxDrag;
export const toggleGrainTunerExposed = organelle.toggleExposed;
export const grainTunerRawValueAtPoint = organelle.rawValueAtPoint;
export const copyGrainTuning = organelle.copyTuning;
