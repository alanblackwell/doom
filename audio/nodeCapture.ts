// Generic tap-and-record, for the beat-matcher (ui/beatMatcher.ts): captures
// whatever's flowing through an already-built entity's own output node into
// a plain AudioBuffer. Same technique audio/samplerCapture.ts's mic-based
// startRecording already uses (the `capture-processor` AudioWorkletNode,
// registered once alongside every other worklet by audio/graph.ts's
// initAudioEngine) — just tapping an internal AudioNode instead of a
// MediaStreamAudioSourceNode from getUserMedia, so it's its own small
// module rather than a variant bolted onto samplerCapture.ts, which is
// explicitly scoped to the sampler organelle.

import { getAudioContext } from './context';

export interface Recording {
  stop(): Promise<AudioBuffer>;
}

export function startNodeCapture(source: AudioNode): Recording {
  const ctx = getAudioContext();
  const capture = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  const chunks: Float32Array[] = [];

  capture.port.onmessage = (e) => {
    chunks.push(e.data as Float32Array);
  };
  capture.port.postMessage({ type: 'start' });
  // An additional tap alongside `source`'s existing connection(s) (its
  // parent's input, or master) — disconnecting only this specific edge on
  // stop (below) leaves everything else `source` feeds untouched.
  source.connect(capture);

  return {
    stop(): Promise<AudioBuffer> {
      capture.port.postMessage({ type: 'stop' });
      // One render-quantum round trip so the very last in-flight chunk
      // (posted just before the 'stop' message reaches the processor)
      // still lands in `chunks` before this resolves — same reasoning as
      // audio/samplerCapture.ts's own startRecording.
      return new Promise((resolve) => {
        setTimeout(() => {
          source.disconnect(capture);
          capture.port.onmessage = null;
          capture.disconnect();

          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const buffer = ctx.createBuffer(1, Math.max(1, totalLength), ctx.sampleRate);
          const data = buffer.getChannelData(0);
          let offset = 0;
          for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
          }
          resolve(buffer);
        }, 50);
      });
    },
  };
}

// --- Sound presence watching ------------------------------------------

// Level below which a node reads as silent — calibrated by ear against a
// typical dropped sample/live source, not derived from anything; tune if a
// quiet source fails to auto-arm-trigger or a noise floor never lets it
// auto-stop.
const SILENCE_RMS_THRESHOLD = 0.01;
const LEVEL_POLL_MS = 40;

export interface LevelWatcher {
  stop(): void;
}

// Polls `node`'s current RMS level roughly every LEVEL_POLL_MS and calls
// onChange only when its sounding/silent state actually flips (not on every
// poll) — used by ui/beatMatcher.ts to auto-start capture the moment a
// connected source actually starts sounding, and auto-stop it the moment
// that source goes quiet again, without this module knowing anything about
// arming/capture state itself. A plain AnalyserNode tap, same idiom as
// audio/samplerCapture.ts's own monitoring analyser — a dead-end connection
// (nothing downstream of it), so it never affects what's actually audible.
export function watchSound(node: AudioNode, onChange: (sounding: boolean) => void): LevelWatcher {
  const ctx = getAudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  node.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let sounding = false;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
    const rms = Math.sqrt(sumSquares / data.length);
    const nowSounding = rms >= SILENCE_RMS_THRESHOLD;
    if (nowSounding !== sounding) {
      sounding = nowSounding;
      onChange(sounding);
    }
  }, LEVEL_POLL_MS);

  return {
    stop() {
      clearInterval(timer);
      node.disconnect(analyser);
    },
  };
}
