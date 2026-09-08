// By-ear tuning constants for the 'noisegate' pedal's own AudioWorklet
// engine (dsp/worklets/noisegate-processor.js) — same shape and same
// reason to exist as audio/bassTuning.ts's own BASS_TUNING (see that
// file's header): there's no formula for "how fast should a gate open and
// close," only what actually sounds tight rather than choppy or pumpy,
// and unlike GRIND_TUNING's own plain-JS-object state, these three live
// inside the worklet's own per-instance state, reached through its
// message port (see audio/graph.ts's 'noisegate' case) rather than a
// mutated JS object.
//
// ui/noisegateTuner.ts is the organelle popup (ui/tuningOrganelle.ts's
// shared factory) that turns these into live sliders alongside the
// pedal's own core control-dots (level/threshold/mix).

export interface NoisegateTuningParam {
  value: number; // current factory default — what a fresh instance seeds the worklet's own constructor from
  min: number;
  max: number;
  step: number; // UI drag/readout granularity only, not enforced on live control-wire input
  label: string; // shown in ui/noisegateTuner.ts's popup and as a ControlSpec label if exposed
  exposed: boolean; // whether ui/controlSpecs.ts's 'noisegate' entry currently also lists this as a control-dot (kept in sync by hand — see this file's own header)
  description: string; // shown as a hover tooltip over the label in ui/noisegateTuner.ts's popup — how this constant relates to the worklet's own algorithm, written to double as a source comment
}

export const NOISEGATE_TUNING: Record<string, NoisegateTuningParam> = {
  attack: {
    value: 0.003,
    min: 0.0005,
    max: 0.05,
    step: 0.0005,
    label: 'attack',
    exposed: false,
    description: "How fast the gate opens once the input crosses above threshold, in seconds — too slow clips the front of a transient (a drum hit or a palm-mute chug loses its own attack), too fast can click.",
  },
  release: {
    value: 0.08,
    min: 0.005,
    max: 0.5,
    step: 0.005,
    label: 'release',
    exposed: false,
    description: "How fast the gate closes once the input drops back below threshold (after hold expires), in seconds — the classic tight-chug 'choke' character comes from keeping this short; too short instead reads as a clipped, unnatural cutoff.",
  },
  hold: {
    value: 0.03,
    min: 0,
    max: 0.3,
    step: 0.005,
    label: 'hold',
    exposed: false,
    description: 'Minimum time the gate stays fully open after the last moment the input was above threshold, before release begins — prevents rapid chatter/retriggering on a signal hovering right at the threshold (a decaying cymbal wash, a sustained note fading out).',
  },
};

export const NOISEGATE_TUNING_KEYS = Object.keys(NOISEGATE_TUNING);
