// Geometry for the center "trigger pad" that one-shot instruments (kick,
// and future percussion — see audio/graph.ts's TRIGGERED_KINDS) show
// instead of playing continuously. Deliberately its own small module,
// parallel to controlSpecs.ts, rather than folded into it — a pad isn't a
// parameter with a value, it's a single click-to-fire action, so it doesn't
// share controlSpecs.ts's min/max/value machinery.

export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PAD_RADIUS_RATIO = 0.24; // fraction of the box's shorter side

export function padRadius(bounds: BoxLike): number {
  return Math.min(bounds.width, bounds.height) * PAD_RADIUS_RATIO;
}

export function isWithinPad(bounds: BoxLike, point: { x: number; y: number }): boolean {
  const radius = padRadius(bounds);
  return Math.hypot(point.x - bounds.x, point.y - bounds.y) <= radius;
}

export const PAD_FLASH_DURATION = 320; // ms — the "you hit it" ripple's lifetime
