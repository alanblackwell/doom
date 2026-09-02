// Event wiring: a tap-style Control entity's single-shot event routed to a
// TRIGGERED_KINDS instrument's own pad (audio/graph.ts's triggerEntity),
// rather than a continuous value routed to a control-dot param
// (ui/wiring.ts). Kept as its own module/storage rather than folded into
// ui/wiring.ts's Wire — the two have genuinely different shapes: a value
// wire targets one specific (entityId, param) and a target accepts at most
// one (see ui/wiring.ts's removeWireTo comment), where an event wire has no
// param at all (just "fire"), and both ends are many-to-many — several taps
// can trigger the same drum, and one tap can trigger several instruments.

export interface EventWire {
  sourceEntityId: string;
  targetEntityId: string;
}

const wires: EventWire[] = [];

export function addEventWire(sourceEntityId: string, targetEntityId: string): void {
  const exists = wires.some(
    (w) => w.sourceEntityId === sourceEntityId && w.targetEntityId === targetEntityId
  );
  if (!exists) wires.push({ sourceEntityId, targetEntityId });
}

// Removes every wire landing on this target — right-clicking a drum's pad
// itself (rather than one specific wire's line) disconnects everything
// feeding it, mirroring ui/wiring.ts's removeWireTo (there's no single dot
// to pick for an event target, just the one pad).
export function removeEventWiresTo(targetEntityId: string): void {
  for (let i = wires.length - 1; i >= 0; i--) {
    if (wires[i].targetEntityId === targetEntityId) wires.splice(i, 1);
  }
}

// Removes exactly one wire — right-clicking its drawn line (see
// ui/wireGeometry.ts's hitTestWireCurve), as opposed to the pad-wide clear
// above, which would take out every other source feeding the same target
// too.
export function removeEventWire(sourceEntityId: string, targetEntityId: string): void {
  const index = wires.findIndex(
    (w) => w.sourceEntityId === sourceEntityId && w.targetEntityId === targetEntityId
  );
  if (index !== -1) wires.splice(index, 1);
}

export function getEventWiresFrom(sourceEntityId: string): EventWire[] {
  return wires.filter((w) => w.sourceEntityId === sourceEntityId);
}

export function getAllEventWires(): EventWire[] {
  return wires;
}
