// AudioWorklet shim for raw PCM recording (audio/samplerCapture.ts). Unlike
// the synthesis worklets alongside this one (noise/bass/bow/pluck-processor,
// all Rust/WASM shims — see ARCHITECTURE.md §5.2), this is plain passthrough
// capture: no DSP, just copy each render quantum's mono input straight back
// to the main thread over the port while armed. Chosen over MediaRecorder
// specifically to sidestep Safari's inconsistent MediaRecorder mimeType
// support (see the sampler organelle's own design discussion) — this
// produces raw Float32 samples the main thread assembles into an AudioBuffer
// directly, no container/codec involved at all.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'start') this.recording = true;
      else if (e.data?.type === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    if (this.recording) {
      const input = inputs[0];
      const channel = input && input[0];
      // A silent/disconnected input can hand back a zero-length channel for
      // a render quantum or two right at start-up — skip rather than post an
      // empty chunk main-thread bookkeeping would otherwise have to filter.
      if (channel && channel.length > 0) {
        // .slice() copies out of the shared render-quantum buffer, which the
        // engine reuses/overwrites next callback — postMessage's structured
        // clone would copy anyway, but slicing first keeps that copy tight
        // instead of deferring it to a lower-level (and less obviously
        // correct) implicit copy.
        this.port.postMessage(channel.slice());
      }
    }
    return true; // keep this processor alive for the lifetime of the node
  }
}

registerProcessor('capture-processor', CaptureProcessor);
