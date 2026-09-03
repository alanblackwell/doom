// Registry of user-customized visual textures: an image plus a crop window
// into it, assigned either to the whole canvas background or to every box
// of a given entity kind. Populated by ui/textureEditor.ts's interactive
// crop/target/save flow; read by ui/render.ts to actually draw them. A pure
// UI-layer concern (parallel to how audio/graph.ts keeps its own
// sampleBuffers registry for dropped audio files) — textures never touch
// the entity graph or Web Audio at all.

export interface TextureSourceRect {
  // Image-pixel coordinates (not screen/editor pixels) — the exact crop
  // window saved by the editor, independent of whatever screen size it was
  // edited at or is later drawn at, so drawImage's source args can be used
  // directly regardless of the target box's own on-screen size.
  x: number;
  y: number;
  width: number;
  height: number;
}

// Photo-editing-style adjustments, applied on top of the raw crop —
// brightness/saturation as multipliers (1 = unchanged), opacity as a plain
// 0-1 alpha, hue in degrees (0-359) selecting which color the hue-boost
// (applyAdjustments below) favors, gated by hueEnabled (see
// ui/textureEditor.ts's small round toggle between the saturation and hue
// sliders — unlike the other three, hue has no "unchanged" value of its
// own to sit at, so it needs an explicit on/off rather than relying on a
// neutral default). Set interactively via ui/textureEditor.ts's sliders
// and saved as part of the texture, so a kind's box (or the canvas
// background) actually renders with them applied, not just the editor's
// own live preview.
export interface TextureAdjustments {
  brightness: number;
  hue: number;
  hueEnabled: boolean;
  saturation: number;
  opacity: number;
}

export const DEFAULT_ADJUSTMENTS: TextureAdjustments = {
  brightness: 1,
  hue: 0,
  hueEnabled: false,
  saturation: 1,
  opacity: 1,
};

// A reusable offscreen canvas for compositing the crop before adjustments
// are applied to its raw pixels (see applyAdjustments/drawAdjustedTexture
// below) — reused across calls rather than allocated fresh each time, since
// this can run every animation frame while a slider is being dragged.
let scratch: HTMLCanvasElement | null = null;

function scratchCanvas(width: number, height: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas');
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  // Resizing a canvas clears it — only do so when the size actually
  // changed, and always clearRect afterward regardless (an unchanged size
  // still holds the previous draw's pixels otherwise).
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const ctx = scratch.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for the texture scratch canvas');
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// [0,1] RGB → hue (degrees, 0-360). null for an achromatic pixel (R=G=B
// exactly) — hue is genuinely undefined there, not "0/red"; callers decide
// what that should mean (see boostTowardHue, which treats it as full
// proximity — a wholly grey pixel has nothing to disqualify it from the
// target hue, unlike a pixel with some other definite hue of its own).
function rgbToHueDegrees(r: number, g: number, b: number): number | null {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// [0,1] h/s/l → [0,1] r/g/b.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  return [hue2rgb(p, q, hk + 1 / 3), hue2rgb(p, q, hk), hue2rgb(p, q, hk - 1 / 3)];
}

// Circular distance between two hues in degrees, 0-180.
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// How strongly a pixel at `pixelHue` should be pulled toward `targetHue` —
// a raised-cosine falloff, 1 at zero distance down to 0 at HUE_BOOST_WIDTH_DEG
// away, so the effect is a smooth, gently-selective spotlight around the
// chosen color rather than a hard cutoff or a boost spanning the whole wheel.
const HUE_BOOST_WIDTH_DEG = 90;
// How far a fully-matching pixel gets pulled toward the target color —
// not 1 (full replacement), leaving a little of the original visible.
// Tune by eye.
const HUE_BOOST_STRENGTH = 0.85;

function hueBoostProximity(pixelHue: number, targetHue: number): number {
  const d = hueDistance(pixelHue, targetHue);
  if (d >= HUE_BOOST_WIDTH_DEG) return 0;
  return Math.cos((d / HUE_BOOST_WIDTH_DEG) * (Math.PI / 2));
}

// Pulls a pixel toward a fully-saturated version of `targetHue` at the
// pixel's OWN lightness, weighted by proximity — blending toward a
// synthesized target color (rather than scaling the pixel's own existing
// chroma outward, which an earlier version of this did) is what lets this
// actually introduce color into an achromatic pixel: scaling zero chroma by
// any factor is still zero, but blending FROM grey TOWARD a vivid color
// works regardless of how little chroma the source started with. That's
// also why the effect reads as strongest on an already-desaturated pixel —
// blending two already-similar colors (a saturated pixel whose hue matches
// the target already looks close to that target color) barely changes
// anything, where blending a muted pixel toward a vivid one is dramatic —
// without needing any separate "how much room is there to boost" term.
//
// An achromatic pixel (rgbToHueDegrees returns null) has no hue of its own
// to be close or far from the target — treated as full proximity (1), not
// excluded, so a WHOLLY desaturated image, with this enabled, renders
// entirely in varying intensities (lightness) of the selected hue rather
// than staying grey. See ui/textureEditor.ts's own hueEnabled toggle for
// why this needs to be switchable at all — there's no neutral hue value
// this algorithm could sit at to mean "no effect."
function boostTowardHue(r: number, g: number, b: number, targetHue: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;

  const pixelHue = rgbToHueDegrees(rn, gn, bn);
  const proximity = pixelHue === null ? 1 : hueBoostProximity(pixelHue, targetHue);
  if (proximity <= 0) return [r, g, b];

  const amount = proximity * HUE_BOOST_STRENGTH;
  const [tr, tg, tb] = hslToRgb(targetHue, 1, lightness);
  return [r + (tr * 255 - r) * amount, g + (tg * 255 - g) * amount, b + (tb * 255 - b) * amount];
}

// Brightness/hue-boost/saturation applied directly to raw pixel data, in
// place — deliberately NOT CanvasRenderingContext2D.filter (brightness()/
// saturate()): Safari's Canvas2D filter support has real gaps beyond simple
// single-function cases (confirmed by testing — brightness alone worked,
// chaining further filter functions in the same string silently no-opped
// there), where getImageData/putImageData is about as universally and
// reliably supported as canvas gets.
//
// Order: brightness, then saturation, then the hue-boost — deliberately
// AFTER saturation, not before, so a saturation pulled down first leaves
// exactly the desaturated pixels the hue-boost is designed to colorize
// most dramatically (see boostTowardHue's own comment).
function applyAdjustments(imageData: ImageData, adjustments: TextureAdjustments): void {
  const { brightness, hue, hueEnabled, saturation } = adjustments;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * brightness;
    let g = data[i + 1] * brightness;
    let b = data[i + 2] * brightness;

    if (saturation !== 1) {
      const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = gray + (r - gray) * saturation;
      g = gray + (g - gray) * saturation;
      b = gray + (b - gray) * saturation;
    }

    if (hueEnabled) {
      [r, g, b] = boostTowardHue(clampByte(r), clampByte(g), clampByte(b), hue);
    }

    data[i] = clampByte(r);
    data[i + 1] = clampByte(g);
    data[i + 2] = clampByte(b);
    // data[i + 3] (alpha) untouched — opacity is handled separately via
    // destCtx.globalAlpha, not folded into the pixel data itself.
  }
}

// Draws `image`'s `source` crop, with brightness/hue-boost/saturation
// applied, onto `destCtx` filling `dest` — the one shared implementation
// every texture draw (ui/textureEditor.ts's live preview, ui/render.ts's
// per-kind boxes and canvas background) goes through, so all three stay
// visually consistent. Opacity is NOT applied here — callers set
// destCtx.globalAlpha themselves before calling, since the editor's live
// preview and the actually-applied rendering combine it differently (the
// editor multiplies it with a fixed preview-visibility alpha; applied
// rendering uses it directly).
//
export function drawAdjustedTexture(
  destCtx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  source: TextureSourceRect,
  dest: { x: number; y: number; width: number; height: number },
  adjustments: TextureAdjustments
): void {
  const scratchCtx = scratchCanvas(dest.width, dest.height);
  scratchCtx.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, dest.width, dest.height);
  if (adjustments.brightness !== 1 || adjustments.saturation !== 1 || adjustments.hueEnabled) {
    const imageData = scratchCtx.getImageData(0, 0, scratchCtx.canvas.width, scratchCtx.canvas.height);
    applyAdjustments(imageData, adjustments);
    scratchCtx.putImageData(imageData, 0, 0);
  }
  destCtx.drawImage(scratchCtx.canvas, dest.x, dest.y, dest.width, dest.height);
}

export interface SavedTexture {
  image: HTMLImageElement;
  sourceRect: TextureSourceRect;
  adjustments: TextureAdjustments;
}

// 'canvas' for the whole-canvas background, or an entity kind string (e.g.
// 'overdrive') for every box of that kind — see ui/textureEditor.ts's
// target-handle selection. Kind-wide, not per-entity-instance: matches how
// KIND_COLORS/controlSpecs.ts already theme by kind rather than by id.
export type TextureTarget = 'canvas' | string;

const textures = new Map<TextureTarget, SavedTexture>();

export function setTexture(target: TextureTarget, texture: SavedTexture): void {
  textures.set(target, texture);
}

export function getTexture(target: TextureTarget): SavedTexture | undefined {
  return textures.get(target);
}
