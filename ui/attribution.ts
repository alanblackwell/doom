// Default copyright-status text stamped onto a texture the first time it's
// uploaded (ui/textureEditor.ts's commitSave) — see ui/textures.ts's
// `copyright` field. This is a single-user personal instrument app with no
// login system, so there's no runtime identity to read; ASSET_AUTHOR is a
// fixed constant rather than a prompt()/localStorage lookup.
const ASSET_AUTHOR = 'Alan Blackwell';

// yyyy-mm-dd — sortable and unambiguous, matching ui/sampleArchive.ts's own
// date formatting convention.
function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function defaultCopyright(fileName: string): string {
  return `Uploaded by user ${ASSET_AUTHOR} on ${todayStamp()} as file ${fileName}`;
}
