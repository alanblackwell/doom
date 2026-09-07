// By-ear tuning constants for the 'bass' source voice's WASM engine
// (dsp/rust/src/lib.rs's bass_render/bass_init/bass_set_detune/
// bass_set_drive) — same shape and same reason to exist as
// audio/grindPlayer.ts's own GRIND_TUNING (see that file's header): there's
// no formula for "how detuned should the two saws be," only what actually
// sounds right, and these two were previously hardcoded Rust constants
// unreachable without editing source and rebuilding the WASM.
//
// ui/bassTuner.ts is the organelle popup (porthole on the 'bass' source
// itself, ui/tuningOrganelle.ts's shared factory — the same pattern
// GRIND_TUNING/ui/grindTuner.ts established first) that turns these into
// live sliders. Unlike grind's constants (plain JS state), these two live
// inside the WASM instance's own memory — audio/graph.ts's 'bass' case
// still registers a control setter for each key unconditionally, same as
// grind, it just forwards through the worklet's message port
// (dsp/worklets/bass-processor.js) to bass_set_detune/bass_set_drive
// instead of mutating a JS object directly.

export interface BassTuningParam {
  value: number; // current factory default — what a fresh instance seeds bass_init() from
  min: number;
  max: number;
  step: number; // UI drag/readout granularity only, not enforced on live control-wire input
  label: string; // shown in ui/bassTuner.ts's popup and as a ControlSpec label if exposed
  exposed: boolean; // whether ui/controlSpecs.ts's 'bass' entry currently also lists this as a control-dot (kept in sync by hand — see this file's own header)
  description: string; // shown as a hover tooltip over the label in ui/bassTuner.ts's popup — how this constant relates to bass_render's own algorithm, written to double as a source comment
}

export const BASS_TUNING: Record<string, BassTuningParam> = {
  detune: {
    value: 1.0040516,
    min: 1.0,
    max: 1.03,
    step: 0.0001,
    label: 'detune',
    exposed: false,
    description:
      "Frequency ratio between the two saw oscillators bass_render() sums — 1.0 is a single clean unison, further out beats more audibly for a wider, chorus-like fatness (see DETUNE_RATIO's own comment in lib.rs).",
  },
  drive: {
    value: 1.6,
    min: 0.5,
    max: 4,
    step: 0.05,
    label: 'drive',
    exposed: false,
    description:
      'Gain applied to the two mixed saws right before soft_clip() — higher pushes the waveform harder into the clip curve for a warmer, more saturated tone; lower stays closer to a clean saw blend.',
  },
};

export const BASS_TUNING_KEYS = Object.keys(BASS_TUNING);
