// Onset-similarity suggestions for the beat-matcher (ui/beatMatcher.ts):
// given the spectrogram of a captured clip, find points elsewhere in the
// clip that sound similar to the onset(s) already placed (or, before any
// exist, similar to wherever the selection ruler's current point sits), so
// they can be offered as clickable "maybe a beat goes here too" suggestions.
//
// Deliberately its own file rather than folded into ui/spectrogram.ts or
// ui/beatMatcher.ts's core — a parallel, independent feature, same reasoning
// as ui/beatMatcher.ts's own header on staying independent of ui/sequencer.ts.
//
// Approach (nearest-centroid similarity, not a trained classifier): with
// only ever a handful of onsets to learn from, a discriminative classifier
// (SVM, LDA, ...) needs negative examples this workflow doesn't reliably
// have, and is unstable until there are enough of them. Distance-to-centroid
// in a small, per-clip-normalized feature space degrades gracefully instead,
// which matters more here than raw accuracy would.
//
// Pure functions only, no entity/canvas/UI knowledge — same spirit as
// ui/spectrogram.ts.

import type { SpectrogramData } from './spectrogram';

// A handful of log-spaced frequency bands, not the full FFT bin resolution —
// low sample counts (this ever only has a few placed onsets to compare
// against) favor fewer feature dimensions, matching the earlier reasoning
// that motivated skipping a classifier at all.
const NUM_BANDS = 6;
const MIN_BAND_FREQUENCY_HZ = 20;

// Every frame's feature vector is [bandEnergy x NUM_BANDS, firstDerivative x
// NUM_BANDS, secondDerivative x NUM_BANDS] — energy shape plus how fast it's
// rising/falling, the classic spectral-flux onset signature — z-score
// normalized per dimension across the whole clip so no one dimension
// dominates distance purely from having larger raw magnitude.
export interface OnsetFeature {
  seconds: number;
  vector: number[];
}

function bandEdgeBins(data: SpectrogramData): number[] {
  const bins = data.fftSize / 2;
  const nyquist = data.sampleRate / 2;
  const edges: number[] = [];
  for (let i = 0; i <= NUM_BANDS; i++) {
    const t = i / NUM_BANDS;
    const hz = MIN_BAND_FREQUENCY_HZ * Math.pow(nyquist / MIN_BAND_FREQUENCY_HZ, t);
    edges.push(Math.max(0, Math.min(bins, Math.round((hz * data.fftSize) / data.sampleRate))));
  }
  return edges;
}

// Frames are already in dB (ui/spectrogram.ts's computeSpectrogram) — averaged
// as power (not dB) within the band so a band's value reflects mean energy,
// not a dB-averaging artifact, then converted back to dB for the same scale
// the rest of this module works in.
function bandEnergyDb(frame: Float32Array, loBin: number, hiBin: number): number {
  let sum = 0;
  let count = 0;
  for (let bin = loBin; bin < hiBin; bin++) {
    sum += Math.pow(10, frame[bin] / 10);
    count++;
  }
  const mean = count > 0 ? sum / count : 1e-10;
  return 10 * Math.log10(Math.max(mean, 1e-10));
}

export function computeOnsetFeatures(data: SpectrogramData): OnsetFeature[] {
  if (data.frames.length === 0) return [];
  const edgeBins = bandEdgeBins(data);

  const bandSeries: number[][] = data.frames.map((frame) => {
    const bands: number[] = new Array(NUM_BANDS);
    for (let b = 0; b < NUM_BANDS; b++) {
      const lo = edgeBins[b];
      const hi = Math.max(lo + 1, edgeBins[b + 1]);
      bands[b] = bandEnergyDb(frame, lo, hi);
    }
    return bands;
  });

  const raw: number[][] = [];
  let prevBands: number[] | null = null;
  let prevDelta: number[] | null = null;
  for (const bands of bandSeries) {
    const delta = prevBands ? bands.map((v, b) => v - prevBands![b]) : bands.map(() => 0);
    const accel = prevDelta ? delta.map((v, b) => v - prevDelta![b]) : delta.map(() => 0);
    raw.push([...bands, ...delta, ...accel]);
    prevBands = bands;
    prevDelta = delta;
  }

  const dims = NUM_BANDS * 3;
  const means = new Array(dims).fill(0);
  const stdevs = new Array(dims).fill(0);
  for (const vec of raw) for (let d = 0; d < dims; d++) means[d] += vec[d];
  for (let d = 0; d < dims; d++) means[d] /= raw.length;
  for (const vec of raw) for (let d = 0; d < dims; d++) { const diff = vec[d] - means[d]; stdevs[d] += diff * diff; }
  for (let d = 0; d < dims; d++) stdevs[d] = Math.sqrt(stdevs[d] / raw.length) || 1;

  // The delta/accel dimensions are near-zero for almost every frame (audio
  // is mostly NOT in the middle of an onset) with rare, huge spikes exactly
  // at a transient — a z-score alone doesn't tame that peakedness, so an
  // unclipped spike (tens of std devs) would swamp the Euclidean distance
  // below and reduce similarity to "did something suddenly start here" only,
  // drowning out the steadier band-energy dimensions that actually carry
  // timbre. Clipping keeps a spike's contribution bounded but still present
  // (a candidate with a sharper/softer attack than the reference still
  // scores as less similar) instead of dominating.
  const CLIP = 3;
  return raw.map((vec, i) => ({
    seconds: (i * data.hopSize) / data.sampleRate,
    vector: vec.map((v, d) => Math.max(-CLIP, Math.min(CLIP, (v - means[d]) / stdevs[d]))),
  }));
}

// Reduces every frame down to plausible onset locations: local peaks of
// positive spectral flux (the sum of positive band-energy deltas — the
// middle third of each vector, per computeOnsetFeatures's own [bands, delta,
// accel] layout), non-max-suppressed by a minimum time spacing. Reuses the
// derivative features already computed above rather than a separate
// onset-detection pass — this is what keeps the similarity search down to a
// few dozen candidates instead of scoring every single STFT frame.
const MIN_PEAK_SPACING_SECONDS = 0.06;
const FLUX_PEAK_THRESHOLD_FRACTION = 0.05; // relative to the clip's own peak flux

function positiveFlux(vector: number[]): number {
  let sum = 0;
  for (let b = NUM_BANDS; b < NUM_BANDS * 2; b++) sum += Math.max(0, vector[b]);
  return sum;
}

export function pickOnsetCandidates(features: OnsetFeature[]): number[] {
  if (features.length < 3) return [];
  const flux = features.map((f) => positiveFlux(f.vector));
  const maxFlux = Math.max(...flux);
  if (maxFlux <= 0) return [];
  const threshold = maxFlux * FLUX_PEAK_THRESHOLD_FRACTION;

  const peaks: { seconds: number; flux: number }[] = [];
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] >= threshold && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1]) {
      peaks.push({ seconds: features[i].seconds, flux: flux[i] });
    }
  }
  peaks.sort((a, b) => b.flux - a.flux);

  const accepted: number[] = [];
  for (const peak of peaks) {
    if (accepted.every((s) => Math.abs(s - peak.seconds) >= MIN_PEAK_SPACING_SECONDS)) {
      accepted.push(peak.seconds);
    }
  }
  return accepted.sort((a, b) => a - b);
}

function nearestFeatureIndex(features: OnsetFeature[], seconds: number): number {
  let lo = 0;
  let hi = features.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (features[mid].seconds < seconds) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(features[lo - 1].seconds - seconds) < Math.abs(features[lo].seconds - seconds)) return lo - 1;
  return lo;
}

// A reference point (a placed note's own onsetSeconds, or the ruler's
// current point) is picked by ear/eye, not by this module's own peak
// search, so it rarely lands on the exact frame pickOnsetCandidates would
// have chosen for the very same transient — one frame either side of a
// sharp attack can look quite different (still rising vs. already past the
// peak). Snapping to the nearest local flux peak within a small window
// puts a reference on the same footing as every candidate (which, by
// construction, IS always exactly at its own peak frame), so the distance
// comparison in rankSuggestedOnsets below reflects actual timbre rather
// than which frame of a rising transient each one happened to land on.
const PEAK_SNAP_WINDOW_SECONDS = 0.05;

function nearestPeakFeatureIndex(features: OnsetFeature[], seconds: number): number {
  const center = nearestFeatureIndex(features, seconds);
  let best = center;
  let bestFlux = positiveFlux(features[center].vector);
  for (let i = center - 1; i >= 0 && features[i].seconds >= seconds - PEAK_SNAP_WINDOW_SECONDS; i--) {
    const flux = positiveFlux(features[i].vector);
    if (flux > bestFlux) { bestFlux = flux; best = i; }
  }
  for (let i = center + 1; i < features.length && features[i].seconds <= seconds + PEAK_SNAP_WINDOW_SECONDS; i++) {
    const flux = positiveFlux(features[i].vector);
    if (flux > bestFlux) { bestFlux = flux; best = i; }
  }
  return best;
}

function meanVector(vectors: number[][]): number[] {
  const dims = vectors[0]?.length ?? 0;
  const mean = new Array(dims).fill(0);
  for (const v of vectors) for (let d = 0; d < dims; d++) mean[d] += v[d];
  for (let d = 0; d < dims; d++) mean[d] /= Math.max(1, vectors.length);
  return mean;
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// Twice the beat-matcher's own MIN_NOTE_DURATION_SECONDS (ui/beatMatcher.ts)
// — candidates this close to an existing onset or reference point are
// already-covered ground, not a useful suggestion. Not imported directly to
// keep this module independent of ui/beatMatcher.ts (see this file's header).
const EXCLUDE_WINDOW_SECONDS = 0.06;

// A plain nearest-neighbor ranking tends to cluster its top matches right
// next to whichever reference point produced them — the tail/ring-out of the
// very sound you just clicked is, unsurprisingly, the most "similar" thing
// in the whole clip. That's rarely a useful suggestion (it's the same hit,
// not a different occurrence of it), so a candidate's score gets a bonus for
// being temporally FAR from every reference point, on top of its feature
// distance — enough to reliably out-rank a near-duplicate a hair's-breadth
// away, but capped so a genuinely dissimilar sound far across the clip still
// can't out-rank a strong match nearby (a look at this module's own test
// data: a clearly similar hit scores ~1-2, a clearly different one ~7-8, so
// a max bonus of 2.5 nudges ties/near-ties toward spread without inverting a
// real similarity gap).
const TEMPORAL_SPREAD_WEIGHT = 2.5; // score subtracted per second of separation from the nearest reference point
const TEMPORAL_SPREAD_CAP_SECONDS = 1; // separation beyond this earns no further bonus

// `referenceSecondsList` is what the suggestions should look similar TO:
// the placed notes' own onsets once there are any, or just the ruler's
// current point before the first one exists (the "one-shot" case). Their
// feature vectors are averaged into a single centroid — with only one
// reference point that's just that point's own vector, so this covers both
// cases without a separate code path.
export function rankSuggestedOnsets(
  features: OnsetFeature[],
  candidateSeconds: number[],
  referenceSecondsList: number[],
  existingOnsets: number[],
  count = 6
): number[] {
  if (features.length === 0 || candidateSeconds.length === 0 || referenceSecondsList.length === 0) return [];
  const referenceVector = meanVector(referenceSecondsList.map((s) => features[nearestPeakFeatureIndex(features, s)].vector));
  const excluded = [...existingOnsets, ...referenceSecondsList];

  return candidateSeconds
    .filter((s) => excluded.every((e) => Math.abs(e - s) >= EXCLUDE_WINDOW_SECONDS))
    .map((s) => {
      const featureDistance = euclideanDistance(features[nearestPeakFeatureIndex(features, s)].vector, referenceVector);
      const nearestReferenceGap = Math.min(...referenceSecondsList.map((r) => Math.abs(r - s)));
      const spreadBonus = TEMPORAL_SPREAD_WEIGHT * Math.min(nearestReferenceGap, TEMPORAL_SPREAD_CAP_SECONDS);
      return { seconds: s, score: featureDistance - spreadBonus };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((c) => c.seconds)
    .sort((a, b) => a - b);
}
