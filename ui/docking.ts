// Dock/undock behavior: what actually happens to an entity's graph
// structure, wiring, and audio nodes when it's dropped into or out of the
// dock (ui/dock.ts's geometry/rendering). Parallel to ui/wiring.ts —
// ui/interaction.ts's finalizeDrop calls into this rather than inlining it.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { deactivateEntity } from '../audio/graph';
import { controlsFor } from './controlSpecs';
import { removeWireTo } from './wiring';
import { removeEventWiresTo } from './eventWiring';
import { stopCapture } from './sampler';
import { stopGrainCapture } from './grainSampler';

// Only a leaf, non-control entity can dock — a Control (knob/clock/tap,
// including a control-CONTAINING control like wander/jitter — see
// ui/controlSpecs.ts's CONTROL_CONTAINER_KINDS) has no independent sound to
// silence and lives in the left-hand control column instead (ui/main.ts),
// so "park it in the dock" has no meaning for one. A non-empty container (a
// pedal with something routed through it) can't dock either: docking
// silences and detaches an entity on its own, and there's no defined
// behavior yet for what should happen to whatever's nested inside it —
// empty it out first, same as you'd have to before deleting it.
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
  // The doom lever's own rivet (ui/doomLever.ts) is deliberately not one of
  // controlsFor(entity.kind)'s specs (see ui/controls.ts's
  // hitTestDoomLeverDrop) — clean it up explicitly, same reasoning as every
  // other control-dot wire above: a docked entity has no visible rivet for
  // a wire to still be landing on.
  removeWireTo(entity.id, 'doomLeverAngle');
  removeEventWiresTo(entity.id);
  // Any internal-feature popup (ui/organelle.ts) has nothing to anchor to
  // once its owner is off-canvas — close it rather than leaving it stuck
  // open with a stale position for whenever it reappears.
  for (const feature of graph.featuresOf(entity.id)) {
    feature.expanded = false;
    // A sampler organelle (ui/sampler.ts) may be mid-recording or holding a
    // live mic stream — parking the instrument in the dock must release
    // that, not leave it running silently in the background.
    if (feature.kind === 'sampler') stopCapture(feature.id);
    // A grain-editor organelle (ui/grainSampler.ts) may be mid-capture too —
    // same reasoning, its own watcher/recording must stop, not run on
    // silently in the background.
    if (feature.kind === 'grainEditor') stopGrainCapture(feature.id);
  }
  entity.docked = true;
}
