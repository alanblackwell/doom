// AudioWorklet shim for the 'bitcrush' pedal's own sample-rate reduction
// half (audio/graph.ts's createBitcrushFilter) — bit-depth reduction is
// handled separately by a native WaveShaperNode (a pure lookup-table
// transform needs no worklet at all), but decimation genuinely needs one:
// holding a sample for N ticks is per-sample state a native node has no
// way to express. Plain JS, no WASM — same exception dsp/worklets/
// capture-processor.js's own header comment already establishes for this
// codebase: one held value and one counter per channel is exactly the
// "trivial, purely-stateful passthrough-shaped DSP" case that doesn't need
// WASM, unlike the noise/bass/bow/pluck/growl processors alongside this
// one (see ARCHITECTURE.md §5.2).

class BitcrushProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.holdSamples = Math.max(1, opts.holdSamples | 0 || 1);
    this.counter = 0;
    this.heldValue = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'setHoldSamples') {
        this.holdSamples = Math.max(1, e.data.value | 0);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      // Re-samples only every holdSamples ticks — everything in between
      // just repeats heldValue, the actual "stair-stepped" decimation
      // artifact this pedal exists for.
      if (this.counter <= 0) {
        this.heldValue = input ? input[i] : 0;
        this.counter = this.holdSamples;
      }
      output[i] = this.heldValue;
      this.counter--;
    }
    return true;
  }
}

registerProcessor('bitcrush-processor', BitcrushProcessor);
