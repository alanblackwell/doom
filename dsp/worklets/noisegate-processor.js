// AudioWorklet shim for the 'noisegate' pedal (audio/graph.ts's
// createNoisegateFilter) — a proper attack/hold/release noise gate. Web
// Audio's native DynamicsCompressorNode only compresses ABOVE a
// threshold; there's no native node that mutes BELOW one. And getting a
// tight, non-chattery gate (the "djent chug" sound this exists for) needs
// independent attack/release timing — a single native lowpass envelope
// follower responds at the same rate both directions, which is exactly
// the "single cutoff" limitation TODO.md's own noise-gate entry flagged.
// Plain JS, no WASM — same "trivial, purely-stateful passthrough-shaped
// DSP" exception dsp/worklets/capture-processor.js and
// dsp/worklets/bitcrush-processor.js already established: a rectified,
// lightly-smoothed envelope, a threshold comparison, and a linear ramp
// toward 0 or 1 is exactly that, nothing WASM would meaningfully help
// with.

// Fixed smoothing on the DETECTOR itself — distinct from the gate's own
// attack/release below, which shape how fast the GATE reacts once it's
// decided to open/close, not how fast it notices the input changed. Keeps
// a signal's own zero-crossings from making the open/close decision
// flicker. Not exposed as a control; a by-ear constant, same spirit as
// audio/vocodePlayer.ts's own fixed FILTER_Q.
const DETECTOR_SMOOTHING_SECONDS = 0.002;

class NoisegateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.threshold = opts.threshold ?? 0.05;
    this.attackSeconds = opts.attack ?? 0.003;
    this.releaseSeconds = opts.release ?? 0.08;
    this.holdSeconds = opts.hold ?? 0.03;

    this.envelope = 0;
    this.gateGain = 0;
    this.holdRemaining = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'setThreshold') this.threshold = Math.max(0, data.value);
      else if (data.type === 'setAttack') this.attackSeconds = Math.max(0.0001, data.value);
      else if (data.type === 'setRelease') this.releaseSeconds = Math.max(0.0001, data.value);
      else if (data.type === 'setHold') this.holdSeconds = Math.max(0, data.value);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;

    // Recomputed every render quantum (128 samples) rather than cached
    // across control changes — cheap, and picks up a live threshold/
    // attack/release/hold edit within one quantum with no extra
    // invalidation bookkeeping, same "read live state fresh" idiom
    // audio/grainPlayer.ts's own scheduleGrain uses per grain.
    const detectorCoeff = 1 - Math.exp(-1 / (DETECTOR_SMOOTHING_SECONDS * sampleRate));
    const attackStep = 1 / Math.max(1, this.attackSeconds * sampleRate);
    const releaseStep = 1 / Math.max(1, this.releaseSeconds * sampleRate);
    const holdSamples = this.holdSeconds * sampleRate;

    for (let i = 0; i < output.length; i++) {
      const x = input ? input[i] : 0;
      this.envelope += (Math.abs(x) - this.envelope) * detectorCoeff;

      if (this.envelope >= this.threshold) {
        this.holdRemaining = holdSamples;
      } else if (this.holdRemaining > 0) {
        this.holdRemaining--;
      }

      const open = this.envelope >= this.threshold || this.holdRemaining > 0;
      this.gateGain = open
        ? Math.min(1, this.gateGain + attackStep)
        : Math.max(0, this.gateGain - releaseStep);

      output[i] = x * this.gateGain;
    }
    return true;
  }
}

registerProcessor('noisegate-processor', NoisegateProcessor);
