// Bundles every currently-loaded sample's original audio file into a zip
// for download — so a composition that pulled samples from scattered
// sources (a folder of field recordings, downloads from different sites,
// ...) can be archived and later replayed without depending on wherever
// those original files happened to live. Deliberately its own module,
// parallel to ui/sampleDrop.ts (which owns the raw-bytes registry this
// reads from) — zipping/downloading is a distinct concern from decoding/
// dropping a file onto the canvas.

import { zipSync } from 'fflate';
import type { EntityGraph } from '../audio/entityGraph';
import { getLoadedSampleFiles } from './sampleDrop';

// Local date/time, second precision — sortable and distinct across repeated
// exports of the same evolving composition (e.g. re-exporting after adding
// a few more samples) without needing anything fancier than the clock.
function archiveFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `doom-samples-${stamp}.zip`;
}

export function hasExportableSamples(graph: EntityGraph): boolean {
  const files = getLoadedSampleFiles();
  return graph.all().some((e) => e.kind === 'sample' && files.has(e.id));
}

// Avoids two dropped files silently overwriting each other in the zip if
// they happen to share a filename (e.g. two different "kick.wav" pulled
// from different source folders) — the first keeps its name, later ones
// get a "-2", "-3", ... suffix inserted before the extension.
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${base}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

// Every 'sample' entity currently in the graph, regardless of docked state
// (the point is a full archive of what's loaded, not just what's actively
// placed on the canvas) — filename collisions resolved via uniqueName,
// entities with no registered file (shouldn't happen; decode always
// registers one — see ui/sampleDrop.ts) silently skipped rather than
// failing the whole export.
export function exportSamplesZip(graph: EntityGraph): void {
  const files = getLoadedSampleFiles();
  const used = new Set<string>();
  const zipInput: Record<string, Uint8Array> = {};

  for (const entity of graph.all()) {
    if (entity.kind !== 'sample') continue;
    const loaded = files.get(entity.id);
    if (!loaded) continue;
    zipInput[uniqueName(loaded.fileName, used)] = loaded.bytes;
  }

  if (Object.keys(zipInput).length === 0) return;

  const zipped = zipSync(zipInput);
  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  // The standard no-server download trick: a detached <a download> is
  // enough to trigger a save even though it's never inserted into the DOM.
  const link = document.createElement('a');
  link.href = url;
  link.download = archiveFileName();
  link.click();
  URL.revokeObjectURL(url);
}
