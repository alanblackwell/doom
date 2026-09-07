// AudioWorklet shim for the Rust/WASM resonant feedback filter (dsp/rust,
// growl_render()). Same shared-memory pattern as the other processors — see
// noise-processor.js and ARCHITECTURE.md §5.2 — but the FIRST one in this
// codebase that actually reads an audio INPUT rather than only generating:
// every other processor here (noise/bass/bow/pluck) ignores `inputs`
// entirely. `growl_render()` needs a fresh copy of whatever's connected in,
// staged into WASM's own memory (growl_input_ptr()/growl_input_len()) via a
// Float32Array view, before every render() call.

class GrowlProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;

    const { wasmModule, frequency, q, feedback, injectGain, driveScale } = options.processorOptions;
    WebAssembly.instantiate(wasmModule).then((instance) => {
      this.exports = instance.exports;
      this.exports.growl_init(sampleRate, frequency, q, feedback, injectGain, driveScale);
      this.ready = true;
    });

    // Live control changes from the UI (audio/graph.ts's 'growl' case),
    // plus 'reset' — the kill switch's own panic-button call, clearing the
    // filter's internal ringing state instantly rather than waiting for it
    // to decay on its own (dsp/rust/src/lib.rs's growl_reset). None of
    // these are native AudioParams, same reasoning as every other WASM
    // voice's own message-port controls.
    this.port.onmessage = (event) => {
      if (!this.ready) return;
      const { type, value } = event.data ?? {};
      if (type === 'setFrequency') {
        this.exports.growl_set_frequency(value);
      } else if (type === 'setQ') {
        this.exports.growl_set_q(value);
      } else if (type === 'setFeedback') {
        this.exports.growl_set_feedback(value);
      } else if (type === 'setInjectGain') {
        this.exports.growl_set_inject_gain(value);
      } else if (type === 'setDriveScale') {
        this.exports.growl_set_drive_scale(value);
      } else if (type === 'reset') {
        this.exports.growl_reset();
      }
    };
  }

  process(inputs, outputs) {
    if (!this.ready) return true;

    // Mono in (the whole graph is mono-ish throughout this app — every
    // generator here writes identical content to every output channel) —
    // stage it into WASM memory before rendering. Nothing connected yet
    // (input[0] missing/empty) is treated as silence rather than reading
    // stale WASM memory from the previous quantum.
    const inputChannels = inputs[0];
    const growlInput = new Float32Array(
      this.exports.memory.buffer,
      this.exports.growl_input_ptr(),
      this.exports.growl_input_len()
    );
    if (inputChannels && inputChannels.length > 0 && inputChannels[0].length > 0) {
      growlInput.set(inputChannels[0]);
    } else {
      growlInput.fill(0);
    }

    this.exports.growl_render();

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

registerProcessor('growl-processor', GrowlProcessor);
