// AudioWorklet shim for the Rust/WASM noise generator (dsp/rust). Deliberately
// thin: instantiate once, then each process() call is one render() call into
// the WASM module's own linear memory and one Float32Array view over it — no
// per-sample JS/WASM boundary crossing, no wasm-bindgen marshalling. See
// ARCHITECTURE.md §5.2 and dsp/rust/src/lib.rs for the rationale.

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;

    const { wasmModule } = options.processorOptions;
    WebAssembly.instantiate(wasmModule).then((instance) => {
      this.exports = instance.exports;
      // Seed per-instance so multiple noise entities don't produce identical
      // streams; sampleRate/currentTime are available in AudioWorkletGlobalScope.
      this.exports.seed((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
      this.ready = true;
    });
  }

  process(_inputs, outputs) {
    if (!this.ready) return true;

    this.exports.render();

    // Re-view each call: WASM memory can grow (which detaches any prior
    // ArrayBuffer view), so don't cache the Float32Array across calls.
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

registerProcessor('noise-processor', NoiseProcessor);
