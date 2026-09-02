// Dock/undock behavior: what actually happens to an entity's graph
// structure, wiring, and audio nodes when it's dropped into or out of the
// dock (ui/dock.ts's geometry/rendering). Parallel to ui/wiring.ts —
// ui/interaction.ts's finalizeDrop calls into this rather than inlining it.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { deactivateEntity } from '../audio/graph';
import { controlsFor } from './controlSpecs';
import { removeWireTo } from './wiring';
import { removeEventWiresTo } from './eventWiring';

// Only a leaf, non-control entity can dock — a Control (knob/clock/tap) has
// no independent sound to silence and isn't drawn as a box at all (see
// ui/knobs.ts), so "park it in the dock" has no meaning for one. A
// non-empty container (a pedal with something routed through it) can't dock
// either: docking silences and detaches an entity on its own, and there's no
// defined behavior yet for what should happen to whatever's nested inside
// it — empty it out first, same as you'd have to before deleting it.
export function isDockable(entity: Entity): boolean {
  return entity.type !== 'control' && entity.children.length === 0;
}

// Park an entity in the dock: silence it (audio nodes are kept around, not
// torn down — see audio/graph.ts's deactivateEntity), detach it from
// whatever container it was in, and drop any wires feeding it (a docked
// instrument has no visible control dots or pad for a wire to land on — see
// render.ts's/controls.ts's docked skips). Its own value/event wires as a
// SOURCE never need cleanup here: only Control entities are ever wire
// sources (ui/interaction.ts's hitTestWireHandle), and those can't dock.
export function dockEntity(graph: EntityGraph, entity: Entity): void {
  deactivateEntity(entity.id);
  if (entity.parentId !== null) {
    graph.reparent(entity.id, null);
  }
  for (const spec of controlsFor(entity.kind)) {
    removeWireTo(entity.id, spec.param);
  }
  removeEventWiresTo(entity.id);
  entity.docked = true;
}
