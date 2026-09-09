// Drag an audio file from the desktop onto the canvas: decode it and drop
// a new 'sample' source entity at the release point. Deliberately its own
// small module, parallel to ui/dock.ts/docking.ts — this is native browser
// HTML5 drag-and-drop (dragover/drop DOM events on the canvas element),
// a wholly separate mechanism from ui/interaction.ts's own PointerEvent-
// driven canvas drag, so it doesn't touch or conflict with that state.
//
// Two exceptions to "always creates a new 'sample' entity":
//   - a drop landing inside an OPEN grain-editor/beat-matcher/sampler popup
//     (ui/grainSampler.ts's 'grainEditor' feature, ui/beatMatcher.ts's
//     'beatMatcher' feature, ui/sampler.ts's 'sampler' feature — the same
//     popups a dragged-in-app source, or in the sampler's case a live mic
//     take, can already land on) decodes the file and hands it straight to
//     that popup's own capture instead, via loadGrainFile/
//     loadBeatMatcherFile/loadSamplerFile — same idea as dropping an
//     in-app source onto it, just sourced from the OS instead of the canvas.
//   - a drop landing on the *box* of an entity that OWNS one of those
//     features, while that feature's popup is still closed, opens the
//     popup first (same as clicking its porthole) and then does the same
//     thing — see openLoadableFeature below.

import type { Entity, EntityGraph } from '../audio/entityGraph';
import { getAudioContext } from '../audio/context';
import { activateEntity, registerSampleBuffer } from '../audio/graph';
import { applyPositionToMix } from './stereoMix';
import { hitTest } from './layout';
import { ownerOf } from './organelle';
import { grainSamplerDropTargetAt, loadGrainFile } from './grainSampler';
import { beatMatcherDropTargetAt, loadBeatMatcherFile } from './beatMatcher';
import { samplerDropTargetAt, loadSamplerFile } from './sampler';

const BOX_WIDTH = 110;
const BOX_HEIGHT = 70; // matches kick-1/pluck-1's TRIGGERED_KINDS box size in ui/main.ts

// Multi-file drops land staggered rather than exactly on top of each other.
const MULTI_DROP_OFFSET = 130;

// Browsers don't always populate File.type for less common containers
// dragged straight from Finder/Explorer (empty string rather than
// e.g. 'audio/flac') — falling back to the extension catches those that
// dataTransfer's MIME sniffing misses, without accepting arbitrary files.
const AUDIO_EXTENSION = /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|webm|weba|aiff?|caf)$/i;

function looksLikeAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXTENSION.test(file.name);
}

// Strips the extension and clips long filenames — this is a canvas label
// (ui/render.ts's drawBox), not a full filename display.
function shortLabel(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^./]+$/, '');
  return withoutExt.length > 14 ? `${withoutExt.slice(0, 13)}…` : withoutExt;
}

let nextSeed = 1000; // clear of ui/main.ts's hand-picked demo seeds (1-15)

export interface LoadedSampleFile {
  fileName: string; // original dropped filename, untruncated (contrast Entity.label's shortLabel)
  bytes: Uint8Array; // the untouched original file bytes, not the decoded AudioBuffer — keeps
  // a later archive export (ui/sampleArchive.ts) byte-identical to what was actually dropped,
  // regardless of what decodeAudioData did to it.
}

// Keyed by entity id, one entry per 'sample' entity ever dropped OR recorded
// — read by ui/sampleArchive.ts's exportSamplesZip to bundle them all for
// download. Entries are never removed (there's no entity-delete feature yet
// to prompt it — see audio/entityGraph.ts). Populated directly by
// addSampleEntity below for a dropped file; ui/sampler.ts calls
// registerLoadedSampleFile/renameLoadedSampleFile for a recorded-and-trimmed
// clip instead, since it has no original file on disk to keep bytes from —
// a WAV encode of the current trim (audio/wavEncode.ts) stands in for one.
const loadedSampleFiles = new Map<string, LoadedSampleFile>();

export function getLoadedSampleFiles(): ReadonlyMap<string, LoadedSampleFile> {
  return loadedSampleFiles;
}

export function registerLoadedSampleFile(entityId: string, file: LoadedSampleFile): void {
  loadedSampleFiles.set(entityId, file);
}

// Updates just the export filename of an already-registered entry, leaving
// its bytes alone — for renaming a sampler-recorded clip (ui/sampler.ts's
// name field) without re-encoding audio that hasn't actually changed. A
// no-op if nothing's been recorded/committed yet (nothing to rename).
export function renameLoadedSampleFile(entityId: string, fileName: string): void {
  const existing = loadedSampleFiles.get(entityId);
  if (existing) loadedSampleFiles.set(entityId, { ...existing, fileName });
}

// Shared by the grain-editor/beat-matcher/sampler popup-drop branches
// below: picks the first audio-looking file out of a (possibly multi-file)
// drop, decodes it, and hands the result (plus the File itself, for
// ui/sampler.ts's own loadSamplerFile, which wants the original name) to
// whichever popup's own loader `onLoaded` is — same decodeAudioData step
// addSampleEntity below uses for a canvas drop, just without an entity/
// registerSampleBuffer/archive side of things to also set up, since the
// popup being dropped onto already has its own home for the decoded buffer.
function loadFirstAudioFile(files: FileList, targetLabel: string, onLoaded: (buffer: AudioBuffer, file: File) => void): void {
  const file = Array.from(files).find(looksLikeAudioFile);
  if (!file) return;
  file
    .arrayBuffer()
    .then((arrayBuffer) => getAudioContext().decodeAudioData(arrayBuffer))
    .then((buffer) => onLoaded(buffer, file))
    .catch((err) => {
      console.error(`Failed to load dropped audio file "${file.name}" into the ${targetLabel} popup:`, err);
    });
}

// Routes a drop's file into whichever loadable feature `feature` is —
// shared by both "already open" and "just opened by openLoadableFeature"
// branches in the drop handler below, so the kind dispatch only lives once.
function loadFileIntoFeature(graph: EntityGraph, files: FileList, feature: Entity): void {
  if (feature.kind === 'grainEditor') {
    loadFirstAudioFile(files, 'grain', (buffer) => loadGrainFile(graph, feature.id, buffer));
  } else if (feature.kind === 'beatMatcher') {
    loadFirstAudioFile(files, 'beat-matcher', (buffer) => loadBeatMatcherFile(feature.id, buffer));
  } else if (feature.kind === 'sampler') {
    const owner = ownerOf(graph, feature);
    if (!owner) return;
    loadFirstAudioFile(files, 'sampler', (buffer, file) => loadSamplerFile(owner.id, feature.id, buffer, file.name));
  }
}

// The grainEditor/beatMatcher/sampler feature `entity` owns, if any —
// opened (same effect as clicking its porthole) so a file dropped directly
// on the entity's own BOX, rather than an already-open popup, has
// somewhere to land.
function openLoadableFeature(graph: EntityGraph, entity: Entity): Entity | null {
  const feature = graph
    .featuresOf(entity.id)
    .find((f) => f.kind === 'grainEditor' || f.kind === 'beatMatcher' || f.kind === 'sampler');
  if (!feature) return null;
  feature.expanded = true;
  return feature;
}

async function addSampleEntity(
  graph: EntityGraph,
  canvas: HTMLCanvasElement,
  file: File,
  point: { x: number; y: number }
): Promise<void> {
  const arrayBuffer = await file.arrayBuffer();
  // A copy, independent of whatever decodeAudioData below does to
  // arrayBuffer — older WebKit neuters (detaches) the buffer it's handed,
  // and this needs to survive that to be archived later.
  const bytes = new Uint8Array(arrayBuffer.slice(0));

  // decodeAudioData is the "any necessary file conversion" step — it
  // demuxes/decodes whatever container+codec the browser supports (wav,
  // mp3, ogg, m4a/aac, flac, ...) and always hands back a native-samplerate
  // Float32 AudioBuffer, so audio/graph.ts's 'sample' case never needs to
  // know what format the original file was.
  const buffer = await getAudioContext().decodeAudioData(arrayBuffer);

  const id = `sample-${crypto.randomUUID()}`;
  const entity = {
    id,
    type: 'source' as const,
    kind: 'sample',
    parentId: null,
    children: [],
    params: { level: 0.8, speed: 1 },
    x: point.x,
    y: point.y,
    width: BOX_WIDTH,
    height: BOX_HEIGHT,
    seed: nextSeed++,
    docked: false,
    ownerId: null,
    expanded: false,
    label: shortLabel(file.name),
  };

  // Registered before the entity ever reaches the graph, so whichever path
  // builds its audio nodes (activateEntity right below if the engine's
  // already running, or buildFromEntityGraph later on "start audio") always
  // finds the buffer waiting for it — see audio/graph.ts's createGenerator
  // 'sample' case.
  registerSampleBuffer(id, buffer);
  loadedSampleFiles.set(id, { fileName: file.name, bytes });
  graph.add(entity);
  // No-ops if the engine hasn't started yet (same guard docking.ts's own
  // undock-from-dock call relies on) — buildFromEntityGraph picks the
  // entity up normally the first time "start audio" is pressed instead.
  activateEntity(entity, graph);
  // Where it landed determines its initial pan/volume too (ui/stereoMix.ts)
  // — no reason a freshly-dropped file should default to center/some
  // fallback level rather than reflecting where it was actually dropped.
  applyPositionToMix(graph, canvas, id, point);
}

export function attachSampleDrop(canvas: HTMLCanvasElement, graph: EntityGraph): void {
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); // required for 'drop' to fire at all
    e.dataTransfer.dropEffect = 'copy';
  });

  canvas.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    let point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Landing inside an ALREADY-OPEN grain-editor/beat-matcher/sampler
    // popup takes over the whole drop — each holds one capture at a time,
    // so (same as dropping a single in-app source onto it) only the first
    // audio file in a multi-file drop is used; the rest are silently
    // ignored rather than also spawning 'sample' entities underneath it.
    const openTargetId =
      grainSamplerDropTargetAt(graph, point) ?? beatMatcherDropTargetAt(graph, point) ?? samplerDropTargetAt(graph, point);
    if (openTargetId) {
      const feature = graph.get(openTargetId);
      if (feature) loadFileIntoFeature(graph, files, feature);
      return;
    }

    // Landing on the BOX of an entity that owns one of those same features
    // — grain-1, beat-matcher-1, sampler-1 — while its popup is still
    // closed opens the popup (same as clicking its porthole) and routes
    // the file the same way, so there's no need to open the organelle by
    // hand first just to drop a file onto it.
    const hitEntity = hitTest(graph, point, new Set());
    const openedFeature = hitEntity ? openLoadableFeature(graph, hitEntity) : null;
    if (openedFeature) {
      loadFileIntoFeature(graph, files, openedFeature);
      return;
    }

    for (const file of Array.from(files)) {
      if (!looksLikeAudioFile(file)) continue;
      addSampleEntity(graph, canvas, file, point).catch((err) => {
        console.error(`Failed to load dropped audio file "${file.name}":`, err);
      });
      point = { x: point.x + MULTI_DROP_OFFSET, y: point.y };
    }
  });
}
