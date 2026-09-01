// Master output chain. A DynamicsCompressorNode as a safety limiter is a
// reasonable default given the genre — noise/drone sources are easy to
// accidentally sum into clipping.

import { getAudioContext } from './context';

let masterGain: GainNode | null = null;

export function getMasterChain(): GainNode {
  if (!masterGain) {
    const ctx = getAudioContext();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.8;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    masterGain.connect(limiter);
    limiter.connect(ctx.destination);
  }
  return masterGain;
}
