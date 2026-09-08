// Bridges ui/wiring.ts's plain add/remove of a value-copy wire into a real,
// continuously-running Web Audio connection whenever the wire's SOURCE is
// an 'lfo' control — the one deliberate exception to wiring.ts's own
// "audio-agnostic" rule (see that module's header). Called from
// ui/interaction.ts right after any wire add/remove, for the specific
// (entityId, param) pair that just changed — a no-op for anything that
// isn't currently fed by an lfo, so it's safe to call unconditionally for
// every wire target in the app, not just LFO-relevant ones.
//
// Two shapes, matching the two things an LFO can usefully reach (see
// audio/graph.ts's own reconcileSynthConfigModulation/
// reconcileLfoDotModulation for the actual Web Audio wiring):
//  - a synthConfig organelle's own dedicated depth port (vibrato/tremolo) —
//    a real, continuously-adjustable 0..1 depth slider lives right there in
//    the popup, so the connection's own depth tracks it live.
//  - any other plain control dot with a genuine native AudioParam behind it
//    (so far: overdrive/fuzz/reverb's own 'tone' filter cutoff — a classic
//    auto-wah target). No separate depth control exists for an arbitrary
//    dot, so the sweep is a fixed proportion of that dot's own ControlSpec
//    range instead, centered wherever the dot's own base value currently
//    sits (dragging it while an LFO is connected just moves the sweep's own
//    center, same as the live AudioParam-summing behavior everywhere else
//    in this app).

import type { EntityGraph } from '../audio/entityGraph';
import { getWireTo } from './wiring';
import { controlsFor } from './controlSpecs';
import { reconcileSynthConfigModulation, reconcileLfoDotModulation } from '../audio/graph';
import { ownerOf } from './organelle';

// How much of a plain dot's own ControlSpec range an LFO sweeps it across,
// symmetric around wherever the dot's base value currently sits — tuned by
// ear for a musically obvious but not overwhelming auto-wah sweep on a
// 'tone' filter; not user-adjustable, since a plain dot has no depth
// control of its own to adjust it with (see this module's own header).
const DEFAULT_LFO_DEPTH_FRACTION = 0.3;

export function reconcileLfoWireTarget(graph: EntityGraph, entityId: string, param: string): void {
  const entity = graph.get(entityId);
  if (!entity) return;

  const wire = getWireTo(entityId, param);
  const source = wire ? graph.get(wire.sourceEntityId) : undefined;
  const lfoEntityId = source && source.kind === 'lfo' ? source.id : null;

  // The one target with its own real depth control — see this module's
  // own header.
  if (entity.type === 'feature' && entity.kind === 'synthConfig') {
    const owner = ownerOf(graph, entity);
    if (!owner) return;
    reconcileSynthConfigModulation(entityId, param, owner.id, lfoEntityId, entity.params[param] ?? 0);
    return;
  }

  // Every other target: a fixed-depth sweep, only if this kind actually
  // registered a real AudioParam for this param (audio/graph.ts's
  // registerLfoTarget) — reconcileLfoDotModulation itself no-ops otherwise,
  // but skipping the controlsFor lookup for a kind/param with no ControlSpec
  // at all (most feature kinds, e.g. envelope) avoids doing that lookup for
  // every wire target in the app for no reason.
  const spec = controlsFor(entity.kind).find((s) => s.param === param);
  if (!spec) return;
  const peakSwing = (spec.max - spec.min) * DEFAULT_LFO_DEPTH_FRACTION;
  reconcileLfoDotModulation(entityId, param, lfoEntityId, peakSwing);
}
