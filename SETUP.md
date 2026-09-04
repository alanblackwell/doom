# Development setup

What you need installed to build and run this project on a fresh machine,
covering both the JS/TS side and the Rust/WASM DSP side
(`dsp/rust/`, see `ARCHITECTURE.md` §5.2).

## 1. Node.js and npm

Any reasonably recent Node (18+) works. This project was developed against
Node 26. npm comes bundled with Node.

- macOS: `brew install node`, or download from [nodejs.org](https://nodejs.org).
- Any OS: [nvm](https://github.com/nvm-sh/nvm) if you want to manage
  multiple Node versions.

## 2. Rust toolchain (for the DSP crate)

Install via **rustup**, the official installer — this gives you `rustc`,
`cargo`, and the ability to add cross-compilation targets:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

(Windows: download and run `rustup-init.exe` from
[rustup.rs](https://rustup.rs) instead.)

After installing, either restart your terminal or run:

```bash
source "$HOME/.cargo/env"
```

Then add the WebAssembly target the DSP crate builds for:

```bash
rustup target add wasm32-unknown-unknown
```

That's the whole Rust-side requirement. **No `wasm-bindgen` and no
`wasm-pack`** — the build deliberately avoids them (see `dsp/rust/src/lib.rs`'s
top comment and `ARCHITECTURE.md` §5.2): the AudioWorklet reads the compiled
module's linear memory directly, so a plain

```bash
cargo build --release --target wasm32-unknown-unknown
```

(what `dsp/rust/build.sh` runs) is sufficient — no extra Rust tooling beyond
rustup + the one target.

Compiling to `wasm32-unknown-unknown` doesn't need a system C compiler or
linker (unlike compiling native binaries) — rustup's bundled `rust-lld`
handles it. This hasn't specifically been verified on Windows from this
project, but there's no reason it shouldn't work there too, run either
natively or through WSL/Git Bash (`dsp/rust/build.sh` is a bash script).

## 3. Clone and build

```bash
git clone https://github.com/alanblackwell/doom.git
cd doom
npm install
npm run dev
```

`npm run dev` (and `npm run build`) automatically run `npm run build:wasm`
first, which invokes `dsp/rust/build.sh` to compile the crate and copy the
result to `dsp/rust/pkg/doom_dsp.wasm` — the path `audio/graph.ts` fetches
from. That output directory, along with `dsp/rust/target/` (cargo's own
build cache), is gitignored — expect the first `build:wasm` on a new machine
to take a few seconds while cargo builds fresh.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Build the WASM, then start the Vite dev server |
| `npm run build` | Build the WASM, then produce a production build in `dist/` |
| `npm run build:wasm` | Just the Rust → WASM step, useful when iterating on `dsp/rust/src/lib.rs` alone (see its comment on why `?latency=` / rebuild-then-reload is the workflow — no file-watcher wired up yet) |
| `npm run typecheck` | TypeScript check with no build output |

## 4. (Optional) BlackHole — for recording system/loopback audio into the sampler

The sampler organelle (`ui/sampler.ts`) records from any input device the
browser can see via `getUserMedia` — a real microphone or audio interface
needs no extra setup. To record audio that's *playing on the same machine*
(another app, or a track routed through this app's own output) instead,
macOS needs a virtual loopback device, since there's no browser API that can
tap arbitrary system/app audio directly (see the sampler's own design
discussion). **BlackHole** is the tool for this. One-time setup, per machine:

1. **Install the driver:**
   ```bash
   brew install blackhole-2ch
   ```
2. **Get macOS to actually load it.** BlackHole installs as a legacy
   CoreAudio HAL plugin, not a modern system extension — there's no
   Privacy & Security approval prompt to click. Instead, restart Core Audio
   so it picks up the new plugin:
   ```bash
   sudo killall coreaudiod
   ```
   (Needs your password; run it yourself in a terminal rather than through
   an agent, since `sudo` needs an interactive prompt.) Verify it's live:
   ```bash
   system_profiler SPAudioDataType | grep -A2 BlackHole
   ```
   should show a "BlackHole 2ch" entry. If not yet, open **Audio MIDI
   Setup.app** once (Spotlight it) — that alone can be enough to trigger
   recognition — then re-check.
3. **Create a Multi-Output Device**, so routing your system audio into
   BlackHole doesn't also make you go silent: open **Audio MIDI Setup.app**
   → `+` (bottom-left) → **Create Multi-Output Device** → check both your
   normal output (speakers/headphones) and **BlackHole 2ch**.
4. **Select that Multi-Output Device as the system output:** System
   Settings → Sound → Output. Anything macOS plays now goes to both your
   ears and into BlackHole simultaneously.
5. **In the sampler organelle**, open its device dropdown and pick
   "BlackHole 2ch" as the input — you'll get one macOS microphone-permission
   prompt the first time.

**Sample-rate mismatch — check this if the sampler shows a monitoring trace
that silently dies, or a "MediaStreamTrack ended due to a capture failure"
console error.** Everything feeding the Multi-Output Device (BlackHole, your
real output device, and whatever the browser's own `AudioContext` picks)
needs to agree on one sample rate. Open **Audio MIDI Setup.app**, select
**BlackHole 2ch** in the left sidebar, and check its "Format" dropdown
against your real output device's own rate (both devices in the Multi-Output
Device need to match) — 44.1 kHz is a safe default matching this project's
own prior sample-rate fix for external interface ticking (see git history).
The sampler organelle's popup also shows the actual negotiated input rate
next to the AudioContext's own rate once a device is selected, flagged if
they differ — that's the fastest way to confirm this is (or isn't) the
problem.

If you only ever record from a real microphone/interface, none of this
section applies — skip straight to using the sampler.

## Sanity-checking the Rust toolchain alone

If something's wrong specifically with the Rust side, this isolates it from
the rest of the JS toolchain:

```bash
rustc --version && cargo --version
rustup target list --installed   # should list wasm32-unknown-unknown
npm run build:wasm               # should end with "wasm build -> dsp/rust/pkg/doom_dsp.wasm"
```
