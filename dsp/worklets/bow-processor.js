// AudioWorklet shim for the Rust/WASM bowed-string voice (dsp/rust,
// bow_render()). Same shared-memory pattern as the other processors — see
// noise-processor.js and ARCHITECTURE.md §5.2.
//
// bowVelocity is the main thing worth experimenting with by ear: STK's own
// reference implementation only ever drives this in roughly the 0.03-0.25
// range (see dsp/rust/src/lib.rs's bowed-string comment) — outside a fairly
// narrow "playable" region for a given frequency/bow-position, this kind of
// physical model produces chaotic scraping instead of a clean pitch. There's
// no substitute for listening and adjusting processorOptions.bowVelocity
// (wired to the 'bow' entity's params.bowVelocity in audio/graph.ts).

class BowProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;

    const { wasmModule, frequency, bowVelocity, bowPressure } = options.processorOptions;
    WebAssembly.instantiate(wasmModule).then((instance) => {
      this.exports = instance.exports;
      this.exports.bow_init(sampleRate, frequency, bowVelocity);
      this.exports.bow_set_pressure(bowPressure ?? 0.5);
      this.ready = true;
    });

    // Live control changes from the UI (audio/graph.ts's control setters) —
    // none of these are native AudioParams, since they're all baked into
    // the WASM voice's internal state rather than read per-sample.
    this.port.onmessage = (event) => {
      if (!this.ready) return;
      const { type, value } = event.data ?? {};
      if (type === 'setFrequency') {
        this.exports.bow_set_frequency(value);
      } else if (type === 'setVelocity') {
        this.exports.bow_set_velocity(value);
      } else if (type === 'setPressure') {
        this.exports.bow_set_pressure(value);
      }
    };
  }

  process(_inputs, outputs) {
    if (!this.ready) return true;

    this.exports.bow_render();

    const wasmBuffer = new Float32Array(
      this.exports.memory.buffer,
      this.exports.buffer_ptr(),
      this.exports.buffer_len()
    );

    const output = outputs[0];
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(wasmBuffer);
    }
    return true;
  }
}

registerProcessor('bow-processor', BowProcessor);
