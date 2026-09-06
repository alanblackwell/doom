// Offline spectral analysis for the beat-matcher's one-shot capture (ui/
// beatMatcher.ts): a finished AudioBuffer in, a full spectrogram out, plus a
// prerendered image to blit. Pure and graph-agnostic — no entity/canvas
// knowledge here. Plain TS rather than Rust/WASM: this runs once against a
// static buffer right after a capture finishes, not per render-quantum on
// the audio thread, so it doesn't need ARCHITECTURE.md §5.2's treatment.

export interface SpectrogramData {
  // One entry per STFT hop, each `fftSize / 2` bins long, in dB, low
  // frequency first (index 0).
  frames: Float32Array[];
  fftSize: number;
  hopSize: number;
  sampleRate: number;
  durationSeconds: number;
}

const FFT_SIZE = 2048;
const HOP_SIZE = 512;

function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return window;
}

const WINDOW = hannWindow(FFT_SIZE);

// In-place radix-2 Cooley-Tukey FFT over separate real/imaginary arrays
// (both length `size`, a power of two) — a one-shot offline analysis has no
// need for anything fancier (SIMD, real-input optimizations, ...).
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const theta = (-2 * Math.PI) / len;
    const wRe = Math.cos(theta);
    const wIm = Math.sin(theta);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const evenIndex = start + k;
        const oddIndex = start + k + half;
        const oddRe = re[oddIndex] * curRe - im[oddIndex] * curIm;
        const oddIm = re[oddIndex] * curIm + im[oddIndex] * curRe;
        re[oddIndex] = re[evenIndex] - oddRe;
        im[oddIndex] = im[evenIndex] - oddIm;
        re[evenIndex] += oddRe;
        im[evenIndex] += oddIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

// Floors every bin's magnitude before the log so a true-zero (or windowed-
// silent) frame maps to a finite, stable dB value instead of -Infinity.
const MIN_MAGNITUDE = 1e-6;

export function computeSpectrogram(buffer: AudioBuffer): SpectrogramData {
  const data = buffer.getChannelData(0); // mono capture (audio/nodeCapture.ts) — channel 0 is all there is
  const frameCount = Math.max(1, Math.floor(Math.max(0, data.length - FFT_SIZE) / HOP_SIZE) + 1);
  const frames: Float32Array[] = new Array(frameCount);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const bins = FFT_SIZE / 2;

  for (let f = 0; f < frameCount; f++) {
    const offset = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = offset + i < data.length ? data[offset + i] : 0;
      re[i] = sample * WINDOW[i];
      im[i] = 0;
    }
    fft(re, im);
    const magnitudes = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin++) {
      const mag = Math.hypot(re[bin], im[bin]) / FFT_SIZE;
      magnitudes[bin] = 20 * Math.log10(Math.max(mag, MIN_MAGNITUDE));
    }
    frames[f] = magnitudes;
  }

  return { frames, fftSize: FFT_SIZE, hopSize: HOP_SIZE, sampleRate: buffer.sampleRate, durationSeconds: buffer.duration };
}

// --- Rendering -------------------------------------------------------

const DB_FLOOR = -80; // maps to the coldest (near-black) color
const DB_CEIL = 0; // maps to the brightest

// A dark -> amber -> white heat ramp, matching the app's warm "distressed
// metal" palette (ARCHITECTURE.md §4.1) rather than a clinical blue/green
// spectrogram: quiet reads as near-black, loud as a hot amber/white.
function magnitudeColor(db: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
  const r = Math.round(255 * Math.min(1, t * 1.8));
  const g = Math.round(255 * Math.min(1, Math.max(0, t * 1.8 - 0.4)));
  const b = Math.round(255 * Math.max(0, t * 1.8 - 1.1));
  return [r, g, b];
}

// Prerenders the whole spectrogram once into an offscreen canvas — one
// column per STFT frame, full frequency range, low frequency at the bottom
// (the conventional reading) — so the beat-matcher's popup can just
// `drawImage` (stretched/cropped to whatever's currently visible) rather
// than recomputing anything per draw call.
export function renderSpectrogramImage(data: SpectrogramData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, data.frames.length);
  canvas.height = data.fftSize / 2;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, canvas.height);

  for (let x = 0; x < data.frames.length; x++) {
    const frame = data.frames[x];
    for (let bin = 0; bin < frame.length; bin++) {
      const [r, g, b] = magnitudeColor(frame[bin]);
      const y = frame.length - 1 - bin; // flip: low frequency at the image's bottom
      const idx = (y * canvas.width + x) * 4;
      image.data[idx] = r;
      image.data[idx + 1] = g;
      image.data[idx + 2] = b;
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
