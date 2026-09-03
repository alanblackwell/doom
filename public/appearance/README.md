# Default appearance pack

This directory is the app's default visual skin, loaded once at startup
(`ui/appearancePack.ts`'s `loadDefaultAppearance`, called from `ui/main.ts`)
before any interactive customization happens. It's a plain Vite `public/`
directory, so everything here is copied verbatim into the build and fetched
at runtime from `/appearance/...` — no code changes needed to update it.

## Producing one

Inside the running app, drop image files onto the canvas to skin the
background or an entity kind (see `ARCHITECTURE.md` §4.3), then click
**export appearance**. That downloads a `doom-appearance-*.zip` containing:

- `manifest.json` — which image is applied to which target, its crop
  window, brightness/hue/saturation/opacity adjustments, and a `copyright`
  field per asset.
- one image file per texture (the original uploaded bytes, unmodified).

## Installing one as the default

Unzip the downloaded pack and replace this directory's contents with it
(`manifest.json` plus its image files). Reloading the app then applies it
automatically at startup.

## The `copyright` field

Each asset entry in `manifest.json` has a `copyright` field, defaulted to
`"Uploaded by user <name> on <date> as file <filename>"` at the moment the
image was first uploaded in the editor. You can hand-edit this field in a
text editor before committing the pack — the app never regenerates it once
set, so an edited value stays attached to that asset permanently, including
into any later re-export of an updated pack that still includes it.

## Empty by default

`manifest.json`'s `assets` array starts empty, and `loadDefaultAppearance`
treats that (or the file being entirely absent) as a normal no-op — the app
just renders with its plain procedural look, exactly as it does today.
