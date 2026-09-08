// Offline pitch/timbre analysis for the 'vocode' pedal (audio/graph.ts's
// 'vocode' case, audio/vocodePlayer.ts's engine) — a locked, one-shot
// estimate of the input's fundamental (f0) plus a formant filter bank
// (spectral-envelope peaks) extracted from the same snapshot, NOT a
// continuous tracker. Both functions here are pure and take an already-
// captured snapshot (a transient AnalyserNode tap — see ui/vocodeTuner.ts
// and audio/graph.ts's own auto-prime trigger); nothing here ever touches
// an AudioBuffer or keeps audio around, matching this feature's own "no
// stored sample" scope decision (unlike ui/grainSampler.ts's captured-and-
// kept spectrogram).

import { fft } from './spectrogram';

// --- f0 estimation -----------------------------------------------------

// Plain autocorrelation peak-pick over a drone-plausible lag range — no
// need for anything fancier (e.g. YIN) since this is deliberately a rough,
// one-shot estimate: ui/vocodeTuner.ts exists specifically so the user can
// correct it by ear when it's wrong (a noisy/harmonically complex drone can
// fool autocorrelation into locking onto an overtone or subharmonic).
export function estimateF0(timeDomain: Float32Array, sampleRate: number, minHz = 20, maxHz = 800): number {
  const n = timeDomain.length;
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / minHz));
  if (maxLag <= minLag) return minHz;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += timeDomain[i];
  mean /= n;

  let bestLag = minLag;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += (timeDomain[i] - mean) * (timeDomain[i + lag] - mean);
    }
    if (sum > bestCorr) {
      bestCorr = sum;
      bestLag = lag;
    }
  }
  return sampleRate / bestLag;
}

// --- Formant extraction (cepstral liftering) ----------------------------

export interface Formant {
  freq: number; // Hz
  gain: number; // 0..1, loudest extracted peak normalized to 1
}

// Mirrors an AnalyserNode-style half-spectrum (bins 0..fftSize/2 - 1, in dB)
// into a full `fftSize`-length real-even sequence — a real signal's
// spectrum magnitude is symmetric (|X[N-k]| = |X[k]|), so this is exact
// except for the missing Nyquist bin itself (approximated by repeating the
// last bin, negligible for the low/mid frequencies formants live in).
function mirrorSpectrum(halfMagnitudeDb: Float32Array, fftSize: number): Float32Array {
  const half = fftSize / 2;
  const full = new Float32Array(fftSize);
  for (let k = 0; k < half; k++) full[k] = halfMagnitudeDb[k];
  full[half] = halfMagnitudeDb[half - 1];
  for (let k = 1; k < half; k++) full[fftSize - k] = halfMagnitudeDb[k];
  return full;
}

// Real-cepstrum smoothing: for a REAL, EVEN-SYMMETRIC sequence x, DFT(x) =
// N * IDFT(x) (forward and inverse coincide up to that scale — the sin
// terms cancel by symmetry), so running the same forward `fft()` twice,
// zeroing high-quefrency bins in between (the "lifter"), computes the
// cepstrum, smooths it, and transforms back — all with the one FFT this
// module reuses from ui/spectrogram.ts, no separate inverse-transform code
// needed. `cutoffSamples` is the quefrency lifter cutoff: quefrencies below
// it are the slowly-varying spectral envelope (what we keep), at/above it
// is the periodic harmonic fine structure locked to f0 (what we discard) —
// this is why extractFormants needs an f0 estimate at all, not just
// cosmetically: get f0 wrong and this cutoff sits in the wrong place,
// either keeping harmonic combs (formants read as one spike per overtone)
// or over-smoothing real timbral resonances away.
function cepstralSmooth(fullLogMagnitude: Float32Array, cutoffSamples: number): Float32Array {
  const n = fullLogMagnitude.length;
  const re = fullLogMagnitude.slice();
  const im = new Float32Array(n);
  fft(re, im); // re/im now hold n * the real cepstrum (real-even; im ~ 0)

  const lo = Math.max(1, Math.min(n - 1, cutoffSamples));
  for (let q = lo; q <= n - lo; q++) {
    re[q] = 0;
    im[q] = 0;
  }

  const re2 = re.slice();
  const im2 = im.slice();
  fft(re2, im2); // re2 now holds n * the smoothed log-magnitude spectrum

  const smoothed = new Float32Array(n);
  for (let k = 0; k < n; k++) smoothed[k] = re2[k] / n;
  return smoothed;
}

const FORMANT_MIN_HZ = 60;
const FORMANT_MAX_HZ = 5000; // higher formants matter little for a drone's overall "character"

// Extracts up to `count` formant peaks from one magnitude-spectrum snapshot
// (an AnalyserNode's own getFloatFrequencyData output, in dB — see
// ui/vocodeTuner.ts and audio/graph.ts's auto-prime trigger for the two
// callers) plus the effective f0 (auto-detected or user-corrected via
// ui/vocodeTuner.ts) that sets the lifter cutoff above.
export function extractFormants(
  magnitudeDb: Float32Array,
  sampleRate: number,
  fftSize: number,
  f0: number,
  count = 5
): Formant[] {
  const full = mirrorSpectrum(magnitudeDb, fftSize);
  const cutoffSamples = Math.max(2, Math.round(sampleRate / Math.max(1, f0) / 2));
  const smoothed = cepstralSmooth(full, cutoffSamples);

  const half = fftSize / 2;
  const minBin = Math.max(1, Math.round((FORMANT_MIN_HZ * fftSize) / sampleRate));
  const maxBin = Math.min(half - 2, Math.round((FORMANT_MAX_HZ * fftSize) / sampleRate));

  const peaks: { bin: number; db: number }[] = [];
  for (let k = minBin; k <= maxBin; k++) {
    if (smoothed[k] > smoothed[k - 1] && smoothed[k] > smoothed[k + 1]) {
      peaks.push({ bin: k, db: smoothed[k] });
    }
  }
  peaks.sort((a, b) => b.db - a.db);
  const top = peaks.slice(0, count);
  if (top.length === 0) return [];

  const maxDb = top[0].db;
  return top
    .map((p) => ({
      freq: (p.bin * sampleRate) / fftSize,
      gain: Math.pow(10, (p.db - maxDb) / 20),
    }))
    .sort((a, b) => a.freq - b.freq);
}
