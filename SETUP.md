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

## Sanity-checking the Rust toolchain alone

If something's wrong specifically with the Rust side, this isolates it from
the rest of the JS toolchain:

```bash
rustc --version && cargo --version
rustup target list --installed   # should list wasm32-unknown-unknown
npm run build:wasm               # should end with "wasm build -> dsp/rust/pkg/doom_dsp.wasm"
```
