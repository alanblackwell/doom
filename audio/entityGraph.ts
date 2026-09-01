// The composition graph: the single source of truth that both the canvas
// renderer and the Web Audio graph are projections of. See ARCHITECTURE.md §3.

export type EntityType = 'source' | 'control' | 'liveInput';

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

  topLevel(): Entity[] {
    return this.all().filter((e) => e.parentId === null);
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
