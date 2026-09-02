// The composition graph: the single source of truth that both the canvas
// renderer and the Web Audio graph are projections of. See ARCHITECTURE.md §3.

// 'feature' is a new kind of relationship, distinct from both containment
// (parentId/children — audio routing) and Control's cross-branch wiring: an
// internal organelle owned by exactly one Source (Entity.ownerId), drawn
// nested *within* that source's own boundary rather than as a sibling box
// on the canvas. See ui/organelle.ts for the porthole/popup rendering and
// audio/graph.ts for how a source's own generator reads its features.
export type EntityType = 'source' | 'control' | 'liveInput' | 'feature';

// `kind` identifies which DSP/generator implementation a Source instantiates
// (e.g. 'noise', or 'group' for a pure mixer with no sound of its own).
// Control/liveInput entities will grow their own kind vocabularies as those
// are implemented.
export interface Entity {
  id: string;
  type: EntityType;
  kind: string;
  parentId: string | null;
  children: string[];
  params: Record<string, number>;

  // Visual layout. Position is relative to the parent's position when
  // parentId is set — so dragging a container carries its contents with it —
  // and in canvas-absolute coordinates when top-level. See ui/layout.ts for
  // the absolute-position resolution and ui/render.ts for how these are drawn.
  x: number;
  y: number;
  width: number;
  height: number;
  // Seeds the boundary-jitter noise (ui/render.ts) so an entity's silhouette
  // is stable across redraws/reloads rather than re-randomizing every frame.
  seed: number;

  // True while this entity sits in the instrument dock (ui/dock.ts) rather
  // than on the canvas: silent (no audio nodes connected — see
  // audio/graph.ts's activateEntity/deactivateEntity), drawn as a small
  // icon with no controls, and excluded from topLevel()/containment. Always
  // false for control-type entities (knob/clock/tap) — they never dock, see
  // ui/docking.ts's isDockable. x/y are meaningless while docked (the dock's
  // own layout is index-based, see ui/dock.ts) — whatever they were last
  // set to is harmless leftover, not read until the entity is dropped back
  // onto the canvas and given a fresh position there.
  docked: boolean;

  // The owning source's id, for a 'feature'-type entity only (null for
  // everything else) — deliberately a SEPARATE relationship from
  // parentId/children rather than reusing containment: a feature has no
  // audio routing meaning of its own (audio/graph.ts's buildFromEntityGraph
  // skips it entirely — its owner's own generator reads it directly via
  // EntityGraph.featuresOf), isn't drawn by the normal recursive box-walk
  // (ui/render.ts), and shouldn't make its owner's box grow to "contain" it
  // the way a nested Source or reserved control-dot column does (see
  // ui/layout.ts's effectiveBounds). Reusing parentId/children for this
  // would have required auditing every containment-assuming code path for
  // a type it was never meant to see; a separate field keeps features
  // invisible to all of that by construction.
  ownerId: string | null;

  // Whether this feature's popup (ui/organelle.ts) is currently open. While
  // false, it draws as a small "porthole" inset in its owner's box — direct
  // manipulation and, for now, new wire connections both require opening
  // it first (an existing wire keeps working either way; it just visually
  // converges on the porthole while collapsed). Always false for non-
  // 'feature' entities. x/y/width/height are unused for a feature entity —
  // its popup's position/size are computed fresh each frame from its
  // owner's current bounds (ui/organelle.ts), not stored.
  expanded: boolean;
}

export class EntityGraph {
  private entities = new Map<string, Entity>();

  add(entity: Entity): void {
    this.entities.set(entity.id, entity);
    if (entity.parentId) {
      const parent = this.entities.get(entity.parentId);
      if (parent && !parent.children.includes(entity.id)) {
        parent.children.push(entity.id);
      }
    }
  }

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  all(): Entity[] {
    return [...this.entities.values()];
  }

  // Excludes docked entities (see Entity.docked) — they're not part of the
  // canvas tree at all while parked in the dock, just a separate list
  // ui/dock.ts renders and hit-tests on its own. Also excludes 'feature'
  // entities (see Entity.ownerId) — they always have parentId === null (they
  // never participate in containment) but aren't free-floating canvas
  // objects either; ui/organelle.ts renders them via featuresOf() below,
  // anchored to their owner.
  topLevel(): Entity[] {
    return this.all().filter((e) => e.parentId === null && !e.docked && e.type !== 'feature');
  }

  dockedEntities(): Entity[] {
    return this.all().filter((e) => e.docked);
  }

  featuresOf(ownerId: string): Entity[] {
    return this.all().filter((e) => e.type === 'feature' && e.ownerId === ownerId);
  }

  childrenOf(id: string): Entity[] {
    const entity = this.entities.get(id);
    if (!entity) return [];
    return entity.children
      .map((childId) => this.entities.get(childId))
      .filter((e): e is Entity => e !== undefined);
  }

  // Moves an entity to a new parent (or to top level if null), matching the
  // "drag into another entity's boundary" interaction — containment defines
  // audio routing, so this is also what the Web Audio reconciliation layer
  // calls when the canvas reports a reparent.
  reparent(id: string, newParentId: string | null): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    if (entity.parentId) {
      const oldParent = this.entities.get(entity.parentId);
      if (oldParent) {
        oldParent.children = oldParent.children.filter((c) => c !== id);
      }
    }

    entity.parentId = newParentId;

    if (newParentId) {
      const newParent = this.entities.get(newParentId);
      if (newParent && !newParent.children.includes(id)) {
        newParent.children.push(id);
      }
    }
  }

  // Moves an entity to the end of its current sibling order — top-level
  // entities are drawn in Map insertion order, children in `children` array
  // order, and later means "on top" in both (see ui/layout.ts's hitTest and
  // ui/render.ts's draw order), so this is what "bring to front" means
  // structurally. A Map has no in-place reorder, so a top-level move is a
  // delete-then-reinsert; a nested move just re-pushes onto the parent's
  // children array.
  bringToFront(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    if (entity.parentId) {
      const parent = this.entities.get(entity.parentId);
      if (parent) {
        parent.children = parent.children.filter((c) => c !== id);
        parent.children.push(id);
      }
    } else {
      this.entities.delete(id);
      this.entities.set(id, entity);
    }
  }
}
