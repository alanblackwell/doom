// Keyboard-binding storage for tap-kind Control entities — parallel to
// ui/wiring.ts's module-level Map pattern. A binding is entirely in-memory
// (same lifetime as wires), and deliberately lives outside the Entity model
// itself (Entity.params is numeric-only, and this isn't a wired value)
// rather than adding a bespoke string field to every entity for one kind's
// sake.

const keyByEntity = new Map<string, string>();
const entityByKey = new Map<string, string>();

// Binding always overwrites: an entity keeps at most one key, and a key is
// owned by at most one entity — rebinding steals the key from whoever else
// held it, and replaces whatever this entity had before. Simplest
// unambiguous behavior, no "what if both fire" case to reason about.
export function bindKey(entityId: string, code: string): void {
  const oldKey = keyByEntity.get(entityId);
  if (oldKey) entityByKey.delete(oldKey);
  const oldOwner = entityByKey.get(code);
  if (oldOwner) keyByEntity.delete(oldOwner);

  keyByEntity.set(entityId, code);
  entityByKey.set(code, entityId);
}

export function getBoundKey(entityId: string): string | undefined {
  return keyByEntity.get(entityId);
}

export function getEntityForKey(code: string): string | undefined {
  return entityByKey.get(code);
}

// KeyboardEvent.code (physical key, e.g. 'KeyA'/'Digit1'/'Space') is what's
// stored, not .key — a binding then means the same physical key regardless
// of Shift/AltGr state. This just makes that code readable on the entity's
// face; 'TAP' as the not-yet-bound placeholder.
export function formatKeyLabel(code: string | undefined): string {
  if (!code) return 'TAP';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'SPACE';
  return code.toUpperCase();
}
