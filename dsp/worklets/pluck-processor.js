// AudioWorklet shim for the Rust/WASM Karplus-Strong plucked string
// (dsp/rust, pluck_render()). Same shared-memory pattern as the other
// processors — see noise-processor.js and ARCHITECTURE.md §5.2.
//
// Unlike kick (audio/graph.ts's TRIGGERED_KINDS, but built from fresh native
// nodes per hit), this is a persistent AudioWorkletNode like bow/bass — a
// Karplus-Strong voice needs its delay-line state to live across the whole
// render loop, not just one hit's duration, so it stays connected and
// (mostly silent) running the whole time, only becoming audible when
// 'excite' re-seeds the delay line (see ui/interaction.ts's triggerEntity).

class PluckProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;

    const { wasmModule, frequency, damping, response } = options.processorOptions;
    WebAssembly.instantiate(wasmModule).then((instance) => {
      this.exports = instance.exports;
      // Seeded per-instance, same reasoning as noise-processor.js — without
      // it every pluck entity's very first hit would use identical noise.
      this.exports.seed((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
      this.exports.pluck_init(sampleRate, frequency, damping ?? 0.91, response ?? 0.21);
      this.ready = true;
    });

    // Live control changes from the UI (audio/graph.ts's control setters),
    // plus 'excite' — the actual "pluck it now" trigger, fired from
    // audio/graph.ts's registerTrigger. None of these are native
    // AudioParams, same reasoning as bow-processor.js.
    this.port.onmessage = (event) => {
      if (!this.ready) return;
      const { type, value } = event.data ?? {};
      if (type === 'setFrequency') {
        this.exports.pluck_set_frequency(value);
      } else if (type === 'setDamping') {
        this.exports.pluck_set_damping(value);
      } else if (type === 'setResponse') {
        this.exports.pluck_set_response(value);
      } else if (type === 'excite') {
        this.exports.pluck_excite();
      }
    };
  }

  process(_inputs, outputs) {
    if (!this.ready) return true;

    this.exports.pluck_render();

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

registerProcessor('pluck-processor', PluckProcessor);
