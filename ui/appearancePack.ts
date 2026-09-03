// Bundles every currently-applied visual texture (ui/textures.ts) — image
// bytes, crop/adjustment settings, and per-asset attribution — into a
// downloadable "appearance pack" zip, and the reverse: loading a pack back
// in, either from a dropped .zip (ui/appearancePack.ts's own drop listener)
// or from the asset pack committed to the repo at public/appearance/ (see
// loadDefaultAppearance, called once at startup by ui/main.ts). Deliberately
// its own module, parallel to ui/sampleArchive.ts — packaging/loading is a
// distinct concern from the interactive crop/adjust editor (ui/textureEditor.ts)
// that produces a SavedTexture in the first place.
//
// manifest.json is the pack's one JSON configuration file: which image file
// is applied to which target (canvas background, or an entity kind), its
// crop rect and brightness/hue/saturation/opacity adjustments, and a
// free-text `copyright` field. That field is stamped with a default value
// once, when an image is first uploaded (ui/attribution.ts, from
// ui/textureEditor.ts's commitSave) — every load/export round-trip in this
// module carries whatever string is already there straight through
// unexamined, so a value hand-edited directly in an exported pack's
// manifest.json (before dropping it into public/appearance/, say) stays
// attached to that asset for good, including into any later re-export.

import { zipSync, unzipSync } from 'fflate';
import { allTextures, setTexture } from './textures';
import type { SavedTexture, TextureAdjustments, TextureSourceRect, TextureTarget } from './textures';

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 1;

interface AppearanceAsset {
  target: TextureTarget;
  file: string;
  sourceRect: TextureSourceRect;
  adjustments: TextureAdjustments;
  copyright: string;
}

interface AppearanceManifest {
  version: number;
  assets: AppearanceAsset[];
}

export function hasExportableAppearance(): boolean {
  return allTextures().size > 0;
}

function archiveFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `doom-appearance-${stamp}.zip`;
}

// Avoids two textures whose source files happened to share a name (e.g. a
// canvas background and a kind's texture both dropped as "texture.png")
// silently overwriting each other's zip entry — same approach as
// ui/sampleArchive.ts's own uniqueName.
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

// Downloads every currently-applied texture as a single zip: manifest.json
// plus one image file per texture, ready to be unzipped straight into
// public/appearance/ in the repo (see loadDefaultAppearance) or re-dropped
// onto the canvas later (see attachAppearancePackDrop).
export function exportAppearancePack(): void {
  const textures = allTextures();
  if (textures.size === 0) return;

  const used = new Set<string>();
  const zipInput: Record<string, Uint8Array> = {};
  const assets: AppearanceAsset[] = [];

  for (const [target, texture] of textures) {
    const file = uniqueName(texture.fileName, used);
    zipInput[file] = texture.fileBytes;
    assets.push({
      target,
      file,
      sourceRect: texture.sourceRect,
      adjustments: texture.adjustments,
      copyright: texture.copyright,
    });
  }

  const manifest: AppearanceManifest = { version: MANIFEST_VERSION, assets };
  zipInput[MANIFEST_FILE] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(zipInput);
  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = archiveFileName();
  link.click();
  URL.revokeObjectURL(url);
}

// Decodes raw image bytes into an HTMLImageElement — the same
// object-URL-via-Image route ui/textureEditor.ts's own drop handler uses,
// just without the interactive crop/adjust step since a pack's manifest
// already carries a finished sourceRect/adjustments for it.
function decodeImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes.slice()]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url); // fully decoded by the time onload fires — safe to free immediately
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

function isAppearanceManifest(value: unknown): value is AppearanceManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as AppearanceManifest).assets)
  );
}

// Applies every asset in `manifest` to the live texture registry, pulling
// each one's image bytes via `getBytes` — the only difference between
// loading a dropped zip and loading the repo's committed default pack is
// where those bytes come from (the zip's own entries vs. a fetch()), so
// both paths share this. An asset whose image bytes can't be found is
// skipped with a console error rather than aborting the whole pack, same
// tolerance ui/sampleArchive.ts's export takes toward missing entries.
async function applyManifest(
  manifest: AppearanceManifest,
  getBytes: (file: string) => Promise<Uint8Array | undefined>
): Promise<void> {
  for (const asset of manifest.assets) {
    const bytes = await getBytes(asset.file);
    if (!bytes) {
      console.error(`Appearance pack: missing image file "${asset.file}" for target "${asset.target}"`);
      continue;
    }
    let image: HTMLImageElement;
    try {
      image = await decodeImage(bytes);
    } catch {
      console.error(`Appearance pack: failed to decode image file "${asset.file}"`);
      continue;
    }
    const texture: SavedTexture = {
      image,
      sourceRect: asset.sourceRect,
      adjustments: asset.adjustments,
      fileName: asset.file,
      fileBytes: bytes,
      copyright: asset.copyright,
    };
    setTexture(asset.target, texture);
  }
}

export async function importAppearancePackFromZip(bytes: Uint8Array): Promise<void> {
  const files = unzipSync(bytes);
  const manifestBytes = files[MANIFEST_FILE];
  if (!manifestBytes) throw new Error('appearance pack is missing manifest.json');
  const manifest: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (!isAppearanceManifest(manifest)) throw new Error('appearance pack manifest.json is malformed');
  await applyManifest(manifest, async (file) => files[file]);
}

// The pack committed to the repo (public/appearance/ — a plain Vite public
// directory, so its contents are served as-is at these same paths in both
// dev and the built app) is the default visual appearance applied once at
// startup, before the user has customized anything this session. A repo
// with nothing committed there yet (manifest.json absent, or present with
// an empty assets array) is a normal, silent no-op — the app just renders
// with no textures applied, exactly as it does today.
export async function loadDefaultAppearance(): Promise<void> {
  let manifest: unknown;
  try {
    const res = await fetch('/appearance/manifest.json');
    if (!res.ok) return;
    manifest = await res.json();
  } catch (err) {
    console.error('Failed to fetch default appearance manifest:', err);
    return;
  }
  if (!isAppearanceManifest(manifest)) {
    console.error('public/appearance/manifest.json is malformed');
    return;
  }
  await applyManifest(manifest, async (file) => {
    const res = await fetch(`/appearance/${file}`);
    if (!res.ok) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  });
}

const ZIP_EXTENSION = /\.zip$/i;

function looksLikeAppearancePack(file: File): boolean {
  return file.type === 'application/zip' || ZIP_EXTENSION.test(file.name);
}

// Drop a previously-exported appearance pack .zip onto the canvas to load
// it wholesale — a separate listener from ui/textureEditor.ts's (single
// image → interactive editor) and ui/sampleDrop.ts's (audio → new sample
// entity), all attached to the same canvas element; each checks its own
// file type and no-ops otherwise, so the three coexist without conflict.
export function attachAppearancePackDrop(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  canvas.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files) return;
    const file = Array.from(files).find(looksLikeAppearancePack);
    if (!file) return;
    e.preventDefault();

    file.arrayBuffer().then((buf) => {
      importAppearancePackFromZip(new Uint8Array(buf)).catch((err) => {
        console.error(`Failed to load appearance pack "${file.name}":`, err);
      });
    });
  });
}
