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
  // Which of the source's own outputs this is — undefined for a
  // single-port source (tap/clock, the only kind that existed before the
  // sequencer), a channel index for a multi-port source (the sequencer,
  // audio/sequencerPlayer.ts). Compared with ===, so two port-less wires
  // still match each other and never collide with a ported one.
  sourcePort?: number;
  targetEntityId: string;
}

const wires: EventWire[] = [];

export function addEventWire(sourceEntityId: string, targetEntityId: string, sourcePort?: number): void {
  const exists = wires.some(
    (w) => w.sourceEntityId === sourceEntityId && w.targetEntityId === targetEntityId && w.sourcePort === sourcePort
  );
  if (!exists) wires.push({ sourceEntityId, targetEntityId, sourcePort });
}

// Removes every wire landing on this target — right-clicking a drum's pad
// itself (rather than one specific wire's line) disconnects everything
// feeding it, mirroring ui/wiring.ts's removeWireTo (there's no single dot
// to pick for an event target, just the one pad). Port-agnostic on
// purpose: clearing a target's pad clears every channel feeding it too.
export function removeEventWiresTo(targetEntityId: string): void {
  for (let i = wires.length - 1; i >= 0; i--) {
    if (wires[i].targetEntityId === targetEntityId) wires.splice(i, 1);
  }
}

// Removes exactly one wire — right-clicking its drawn line (see
// ui/wireGeometry.ts's hitTestWireCurve), as opposed to the pad-wide clear
// above, which would take out every other source feeding the same target
// too. sourcePort must match exactly so removing one sequencer channel's
// wire to a target never takes out another channel's wire to that same
// target.
export function removeEventWire(sourceEntityId: string, targetEntityId: string, sourcePort?: number): void {
  const index = wires.findIndex(
    (w) => w.sourceEntityId === sourceEntityId && w.targetEntityId === targetEntityId && w.sourcePort === sourcePort
  );
  if (index !== -1) wires.splice(index, 1);
}

// With no sourcePort given, matches only port-less wires (tap/clock's own
// call sites) — a ported source (the sequencer) always passes its channel
// index explicitly instead.
export function getEventWiresFrom(sourceEntityId: string, sourcePort?: number): EventWire[] {
  return wires.filter((w) => w.sourceEntityId === sourceEntityId && w.sourcePort === sourcePort);
}

export function getAllEventWires(): EventWire[] {
  return wires;
}
