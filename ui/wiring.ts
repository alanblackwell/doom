// Value-parameter wiring: a Control entity's (knob) output routed to a
// target entity's control-dot parameter. This is the "value" half of the
// two control-wiring approaches (value parameters vs. events/triggers) —
// events aren't built yet. Deliberately a pure UI-layer concern, not
// audio/graph.ts's: a wire just writes into entity.params + whatever
// control setter is already registered there, the exact path a manual
// slider drag already uses (see applyControlValue in ui/interaction.ts) —
// audio/graph.ts never needs to know wires exist at all.

export interface Wire {
  sourceEntityId: string;
  sourceParam: string;
  targetEntityId: string;
  targetParam: string;
}

const wiresBySource = new Map<string, Wire[]>();

// A target param accepts at most one incoming wire — deliberately simple
// for now (no "how do multiple modulators combine" question to answer).
// Adding a new wire to an already-wired target replaces the old one,
// wherever it came from.
export function addWire(
  sourceEntityId: string,
  sourceParam: string,
  targetEntityId: string,
  targetParam: string
): void {
  removeWireTo(targetEntityId, targetParam);
  const list = wiresBySource.get(sourceEntityId) ?? [];
  list.push({ sourceEntityId, sourceParam, targetEntityId, targetParam });
  wiresBySource.set(sourceEntityId, list);
}

export function removeWireTo(targetEntityId: string, targetParam: string): void {
  for (const [sourceId, wires] of wiresBySource) {
    const filtered = wires.filter(
      (w) => !(w.targetEntityId === targetEntityId && w.targetParam === targetParam)
    );
    if (filtered.length !== wires.length) {
      wiresBySource.set(sourceId, filtered);
    }
  }
}

export function getWiresFrom(sourceEntityId: string): Wire[] {
  return wiresBySource.get(sourceEntityId) ?? [];
}

export function getWireTo(targetEntityId: string, targetParam: string): Wire | undefined {
  for (const wires of wiresBySource.values()) {
    const found = wires.find(
      (w) => w.targetEntityId === targetEntityId && w.targetParam === targetParam
    );
    if (found) return found;
  }
  return undefined;
}

export function getAllWires(): Wire[] {
  return [...wiresBySource.values()].flat();
}
