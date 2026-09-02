// Shared per-kind color palette. Split out from render.ts (which still owns
// all the actual drawing) so ui/dock.ts can reuse the same colors for its
// docked-instrument icons without a render.ts <-> dock.ts import cycle —
// same reasoning as controlSpecs.ts's own split from controls.ts/layout.ts.

export const KIND_COLORS: Record<string, string> = {
  noise: '#4a4a4a',
  bass: '#5b3a24',
  bow: '#6b4630',
  overdrive: '#8a5a1c',
  reverb: '#2f4a52',
  chorus: '#2c4a3c',
  flanger: '#3a3a52',
  kick: '#5a2020',
  pluck: '#4a3428',
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
