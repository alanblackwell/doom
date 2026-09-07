// AudioWorklet shim for the Rust/WASM detuned-saw bass drone (dsp/rust,
// bass_render()). Same shared-memory pattern as noise-processor.js — see
// that file and ARCHITECTURE.md §5.2 for the rationale.

class BassProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;

    const { wasmModule, frequency, detune, drive } = options.processorOptions;
    WebAssembly.instantiate(wasmModule).then((instance) => {
      this.exports = instance.exports;
      this.exports.bass_init(sampleRate, frequency, detune, drive);
      this.ready = true;
    });

    // Live pitch/detune/drive changes from the UI (audio/graph.ts's 'bass'
    // case, ui/bassTuner.ts's tuning organelle) — none of these are native
    // AudioParams, same reasoning as bow-processor.js.
    this.port.onmessage = (event) => {
      if (!this.ready) return;
      const { type, value } = event.data ?? {};
      if (type === 'setFrequency') {
        this.exports.bass_set_frequency(value);
      } else if (type === 'setDetune') {
        this.exports.bass_set_detune(value);
      } else if (type === 'setDrive') {
        this.exports.bass_set_drive(value);
      }
    };
  }

  process(_inputs, outputs) {
    if (!this.ready) return true;

    this.exports.bass_render();

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

registerProcessor('bass-processor', BassProcessor);
