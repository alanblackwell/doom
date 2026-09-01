#!/usr/bin/env bash
# Builds the Rust DSP crate to WASM and copies it to pkg/, the stable path
# audio/graph.ts fetches from. Run via `npm run build:wasm` (wired into
# `npm run dev` / `npm run build`), or directly when iterating on the crate.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

cargo build --release --target wasm32-unknown-unknown

mkdir -p pkg
cp target/wasm32-unknown-unknown/release/doom_dsp.wasm pkg/doom_dsp.wasm

echo "wasm build -> dsp/rust/pkg/doom_dsp.wasm"
