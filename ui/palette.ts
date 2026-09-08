// Shared per-kind color palette. Split out from render.ts (which still owns
// all the actual drawing) so ui/dock.ts can reuse the same colors for its
// docked-instrument icons without a render.ts <-> dock.ts import cycle —
// same reasoning as controlSpecs.ts's own split from controls.ts/layout.ts.

export const KIND_COLORS: Record<string, string> = {
  noise: '#4a4a4a',
  bass: '#5b3a24',
  bow: '#6b4630',
  grind: '#7a3a1c', // rust/industrial — distinct from bow's warm wood brown despite sharing its voice
  overdrive: '#8a5a1c',
  fuzz: '#7a2e1c', // hotter/redder than overdrive's amber-brown — a harder-clipping cousin
  reverb: '#2f4a52',
  chorus: '#2c4a3c',
  flanger: '#3a3a52',
  growl: '#5a3020', // a duller, browner red than fuzz's — "threat/growl" rather than "hot clip"
  kick: '#5a2020',
  pluck: '#4a3428',
  metal: '#3f464e', // cold steel, distinct from the warm wood/brown strings above
  sample: '#5a3a52', // dropped-in audio file — magenta-brown, distinct from every other kind's hue
  grain: '#4a5a2e', // olive/moss — a granular voice like grind, but distinct from its rust/industrial hue since the character comes from captured material, not noise
  vocode: '#4a3a6e', // cold violet — robotic/resynthesized, distinct from flanger's own blue-violet
  ringmod: '#2c6a8a', // bright electric teal-blue — modulated/robotic, distinct from reverb's darker teal and vocode's violet
  bitcrush: '#5a8a2c', // acid/toxic green — digital glitch harshness, distinct from grain's olive and grind's rust
  synth: '#2c4a8a', // a clean saturated blue — the "conventional" electronic voice, distinct from every other source's wood/steel/rust/violet hues
};
export const DEFAULT_COLOR = '#3a3a3a';
export const ACCENT = '#c98a3c'; // selection / drop-target accent — warm, reads against the dark palette

export function shadeColor(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((n & 0xff) * factor));
  return `rgb(${r}, ${g}, ${b})`;
}
