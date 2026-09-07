// By-ear tuning constants for the 'metal' source voice's WASM engine
// (dsp/rust/src/lib.rs's pluck_render/svf_bandpass, shared with 'pluck' —
// see that file's own comment on pluck_render's feedback branch) — same
// shape and same reason to exist as audio/grindPlayer.ts's GRIND_TUNING/
// audio/bassTuning.ts's BASS_TUNING (see either's own header): these three
// shaped the feedback/squeal character but were previously fixed constants
// (FEEDBACK_Q and two inline multipliers) with no way to hear what changing
// them actually does short of editing source and rebuilding the WASM.
//
// ui/metalTuner.ts is the organelle popup (porthole on the 'metal' source
// itself, ui/tuningOrganelle.ts's shared factory) that turns these into
// live sliders, alongside the voice's existing pitch/damping/response/
// feedback/feedbackFreq control-dots — the point of building this one was
// to find out whether 'metal' not sounding usable is actually a matter of
// parameter values, which needs ALL of its knobs in one place to explore,
// not just the three new ones.

export interface MetalTuningParam {
  value: number; // current factory default — what a fresh instance seeds pluck_init-adjacent setters from
  min: number;
  max: number;
  step: number; // UI drag/readout granularity only, not enforced on live control-wire input
  label: string; // shown in ui/metalTuner.ts's popup and as a ControlSpec label if exposed
  exposed: boolean; // whether ui/controlSpecs.ts's 'metal' entry currently also lists this as a control-dot (kept in sync by hand — see this file's own header)
  description: string; // shown as a hover tooltip over the label in ui/metalTuner.ts's popup — how this constant relates to pluck_render's own algorithm, written to double as a source comment
}

export const METAL_TUNING: Record<string, MetalTuningParam> = {
  feedbackQ: {
    value: 4,
    min: 0.5,
    max: 20,
    step: 0.1,
    label: 'feedback Q',
    exposed: false,
    description:
      'Resonance (Q) of the bandpass filter that picks out which partial squeals (svf_bandpass in lib.rs) — higher targets one partial more precisely for a purer tone, lower spreads the pickup across a broader range for a buzzier, less-defined squeal.',
  },
  feedbackInjectGain: {
    value: 3,
    min: 0,
    max: 10,
    step: 0.1,
    label: 'feedback inject gain',
    exposed: false,
    description:
      "Fixed gain applied to the picked-out partial before it's summed back into the string in pluck_render's feedback branch — higher makes the squeal build up faster and reach full intensity at a lower `feedback` knob setting.",
  },
  feedbackDriveScale: {
    value: 4,
    min: 0,
    max: 15,
    step: 0.1,
    label: 'feedback drive scale',
    exposed: false,
    description:
      'How much extra soft-clip drive gets added as `feedback` rises (pluck_render: drive = 1 + feedback * this) — higher pushes the squeal into harder clipping/distortion sooner as feedback increases.',
  },
};

export const METAL_TUNING_KEYS = Object.keys(METAL_TUNING);
