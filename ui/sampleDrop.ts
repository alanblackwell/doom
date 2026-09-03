// Drag an audio file from the desktop onto the canvas: decode it and drop
// a new 'sample' source entity at the release point. Deliberately its own
// small module, parallel to ui/dock.ts/docking.ts — this is native browser
// HTML5 drag-and-drop (dragover/drop DOM events on the canvas element),
// a wholly separate mechanism from ui/interaction.ts's own PointerEvent-
// driven canvas drag, so it doesn't touch or conflict with that state.

import type { EntityGraph } from '../audio/entityGraph';
import { getAudioContext } from '../audio/context';
import { activateEntity, registerSampleBuffer } from '../audio/graph';

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

async function addSampleEntity(
  graph: EntityGraph,
  file: File,
  point: { x: number; y: number }
): Promise<void> {
  const arrayBuffer = await file.arrayBuffer();
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
  graph.add(entity);
  // No-ops if the engine hasn't started yet (same guard docking.ts's own
  // undock-from-dock call relies on) — buildFromEntityGraph picks the
  // entity up normally the first time "start audio" is pressed instead.
  activateEntity(entity, graph);
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

    for (const file of Array.from(files)) {
      if (!looksLikeAudioFile(file)) continue;
      addSampleEntity(graph, file, point).catch((err) => {
        console.error(`Failed to load dropped audio file "${file.name}":`, err);
      });
      point = { x: point.x + MULTI_DROP_OFFSET, y: point.y };
    }
  });
}
