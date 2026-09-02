# Architecture — Doom/Drone/Industrial Composition & Performance App

## 1. Overview

A browser-hosted instrument for composing and performing doom / drone / industrial metal:
noise synthesis, live audio input, and sample playback, arranged as a graphically
patchable canvas of nested sound-source entities, driven by a slow-evolving-texture
+ steady-beat-with-fills scheduling model.

Core architectural decision: **the visual canvas graph and the audio signal graph are
the same object.** There is no separate "UI model" that gets translated into a
"DSP model" — an entity on screen *is* a node (or subgraph) in the Web Audio graph.
This keeps the graphically-configurable requirement cheap to implement and cheap to
keep correct, at the cost of ruling out a fully independent native audio server
(see §9 for when that tradeoff would need revisiting).

## 2. System Layers

```
┌─────────────────────────────────────────────────────────┐
│  Canvas Rendering Layer  (Canvas2D + optional WebGL/GPU  │
│  overlay for procedural texture / noise effects)         │
├─────────────────────────────────────────────────────────┤
│  Entity Graph  (composition tree: sources, controls,     │
│  live inputs — the single source of truth)                │
├─────────────────────────────────────────────────────────┤
│  Web Audio Graph  (native nodes + AudioWorkletNodes,      │
│  1:1 derived from the entity graph's containment)         │
├─────────────────────────────────────────────────────────┤
│  AudioWorklet DSP  (Rust → WASM, runs on the audio        │
│  rendering thread, per render quantum)                    │
├─────────────────────────────────────────────────────────┤
│  Transport / Scheduler  (lookahead clock driving pattern  │
│  playback; independent of the graph, writes into it)      │
├─────────────────────────────────────────────────────────┤
│  Live Input  (2ch: voice + instrument, getUserMedia)      │
└─────────────────────────────────────────────────────────┘
```

The rendering layer and the audio layers are deliberately decoupled by the entity
graph sitting between them — the canvas never talks to Web Audio directly, and the
scheduler never touches pixels.

## 3. Entity Model (the composition graph)

This is the central data structure. Everything else (rendering, audio routing,
save/load) is a projection of it.

### 3.1 Entity types

- **Source** — an independent sound generator or processor with audio output.
  Top-level sources connect directly to the master output. A source can itself
  contain other sources as children, mixed internally before reaching its own
  output (e.g. a "drone" entity that internally mixes a noise generator + a
  Karplus-Strong string + a slow filter sweep, then exposes one output).
- **Control** — a parameter modulator with no audio output: a knob, XY pad, LFO,
  or sequencer step lane. Controls only ever target `AudioParam`s — either on
  their parent source, or (via explicit patch reference) on any other entity in
  the graph. (An ADSR envelope turned out to fit better as a Feature, below —
  it belongs to one specific source rather than being freely relocatable.)
- **Live Input** — a special Source backed by a hardware input channel
  (`MediaStreamAudioSourceNode`) rather than a synthesis algorithm. Behaves like
  any other Source for routing/nesting purposes once created.
- **Feature** — an internal organelle belonging to exactly one Source (an ADSR
  envelope is the first one), drawn *within* that source's own boundary rather
  than as a sibling box on the canvas — the "metaphorical organelle within the
  cell" framing. Distinct from both of the above: unlike containment, a Feature
  has no audio-routing meaning of its own (its owner's own generator reads it
  directly, e.g. an extra gain stage the envelope's ramps drive); unlike a
  Control, it isn't a freely-relocatable, freely-wireable top-level entity — it
  belongs to one Source for its whole life (`ownerId`, not `parentId`), and is
  never itself a wire *source* the way a knob is. It still accepts incoming
  value wires on its own params (e.g. an LFO modulating attack time), the same
  Control→AudioParam wiring §3.2 describes, just as a target rather than ever
  a source. Two visual states: a small **porthole** inset in the owner's box
  (any wire converges there, whichever param it actually targets) or, expanded,
  a **popup** — a simulated (canvas-drawn, not a native browser window, so it
  works without popup support) floating panel with direct-manipulation handles
  and per-param connection dots, positioned in the same canvas-content
  coordinate space as everything else so wires from anywhere else on the
  canvas can still reach it. See `ui/organelle.ts`.

### 3.2 Containment = routing (default), explicit patch cables (escape hatch)

**Default rule:** visual nesting determines audio routing. Dropping Source B
inside Source A's boundary connects B's output → A's internal mixer → A's output.
This is what makes the canvas "graphically configurable" without a separate
patching step, and it matches the way you described the interaction paradigm.

**Escape hatch:** Controls (and, if you later want it, cross-branch audio taps)
are *not* constrained by containment — a Control nested inside Source A can target
an `AudioParam` on Source B via an explicit reference, rendered on canvas as a
distinct visual (a thin tendril/wire, textured differently from the thick
patch-cable used for audio-stream containment, so the two relationships stay
visually distinguishable). This keeps the common case (drag-to-route) simple while
not locking out modular-style cross-patching for controls, which you'll want for
things like "this LFO on entity A also slews the filter cutoff on entity C."

### 3.3 Entity → Web Audio mapping

Each entity owns:
- an **input node** (if it accepts children) — typically a `GainNode` acting as
  the internal mixer
- an **output node** — what parents connect to
- a **processing chain** — anything between input and output: native nodes
  (`BiquadFilterNode`, `DelayNode`, `ConvolverNode`, `WaveShaperNode`) and/or one
  or more `AudioWorkletNode`s running Rust/WASM DSP (§5)
- **AudioParam bindings** — the set of params exposed to child Controls

Reparenting an entity on canvas (drag it into a different container) tears down
and rebuilds only the affected `connect()`/`disconnect()` calls — the rest of the
graph is untouched. Because Web Audio connections are cheap to make/break, live
re-patching during performance is safe.

## 4. Canvas Rendering Architecture

### 4.1 Technology: Canvas2D now, layered WebGL/GPU later

Canvas2D (not SVG) for the entity/patcher rendering, because the aesthetic target
is textured/painterly (torn paper, rust, concrete, distressed metal) rather than
clean vector shapes — SVG fights you here; raster compositing doesn't.

- Entity boundaries: not clean rounded rectangles. Render as an irregular path —
  jitter the boundary using a value/Simplex noise function seeded per-entity (so
  each entity has a consistent-but-organic silhouette across frames), then stroke
  with a textured brush (a tiled distressed-edge PNG/canvas pattern) rather than a
  solid line.
- Fills: `CanvasRenderingContext2D.createPattern()` with grunge texture tiles
  (concrete, rust, static/noise grain) instead of flat fills. Vary opacity/tint by
  entity type (Source vs. Control vs. Live Input) so the type is readable at a
  glance without relying on clean iconography.
- Patch cables (audio-stream containment) vs. control tendrils (§3.2): different
  stroke textures — thick frayed rope/cable texture for audio, thin scratchy
  wire for control targeting.
- All of this is static-texture compositing, cheap on Canvas2D, no GPU needed yet.

### 4.2 GPU offload path (future)

Keep this as a **layered overlay**, not a rewrite of entity rendering:

```
[ Canvas2D entity/patcher layer ]  →  rendered to an offscreen canvas or texture
                    ↓
[ WebGL/WebGPU post-process pass ]  →  samples the Canvas2D output as a texture,
                                        applies procedural noise / grain / VHS-
                                        flicker / distortion shaders, composites
                                        to the visible canvas
```

This lets you add procedural visual noise, scanline/VHS artifacts, or reactive
distortion (e.g. driven by the current audio's RMS/spectral data via
`AnalyserNode`) as a single full-screen shader pass, without touching how
individual entities are drawn. Only move to per-entity GPU rendering (rendering
entities themselves as WebGL/WebGPU objects) if the post-process layer turns out
to be insufficient — it's a bigger redesign and shouldn't be the starting point.

`OffscreenCanvas` + a Worker is worth using for the Canvas2D layer regardless of
GPU work, so heavy redraws (many entities, complex textures) don't compete with
the main thread — keep the main thread free for input handling and keep the audio
thread (AudioWorklet) completely separate from both.

## 5. Audio Engine

### 5.1 Native Web Audio nodes

Use built-in nodes wherever they suffice: `GainNode` (mixers), `BiquadFilterNode`,
`DelayNode` (+ feedback loop for dub-style repeats), `ConvolverNode` (impulse
responses from real amps/rooms), `WaveShaperNode` (distortion curves),
`AudioBufferSourceNode` (samples), `ConstantSourceNode` (as a modulation-signal
source for Control entities driving `AudioParam`s at audio rate).

### 5.2 Custom DSP: Rust → WASM in AudioWorklet

For noise generators, granular synthesis, physical-modeling drones (Karplus-Strong
and variants), and any distortion/waveshaping beyond what `WaveShaperNode`'s
static curve model supports.

- Rust crate(s) compiled to `wasm32-unknown-unknown`, one module per DSP algorithm
  family (or one module, multiple exported processor types — decide based on how
  many distinct algorithms you end up with).
- **Avoid `wasm-bindgen`'s per-call marshalling on the audio thread.** Use raw
  linear-memory access instead: allocate input/output sample buffers inside the
  WASM module's own memory, pass pointers once, and have the `AudioWorkletProcessor`
  JS shim read/write directly into that memory region each `process()` call
  (128-frame render quantum). This avoids per-sample (or even per-call) boundary
  overhead, which matters once you have several worklets running concurrently.
- Each `AudioWorkletNode` exposes its Rust-side parameters as `AudioParam`s (for
  sample-accurate automation from the transport or a Control entity) or as plain
  message-passed values (for non-time-critical settings, e.g. switching a noise
  color or algorithm mode) via the worklet's `port`.
- Faust is worth prototyping with early if you want working filters/oscillators
  fast — it compiles straight to an AudioWorklet-ready WASM module — but treat
  hand-written Rust as the long-term home for anything genre-specific or
  idiosyncratic, since that's where you'll want full control.

### 5.3 Transport / Scheduler

Independent of the entity/audio graph — it only *writes into* AudioParams and
triggers note/sample events; it doesn't own any nodes itself.

- Lookahead scheduler (hand-rolled per the classic pattern, or Tone.js's
  `Transport`/`Sequence`/`Part`): a periodic JS timer wakes, looks ahead a fixed
  window, and schedules events at precise `AudioContext.currentTime` offsets —
  sample-accurate regardless of JS timer jitter.
- Two cooperating pattern engines, matching "steady beat with jazz-like fills":
  - **Pulse engine** — steady, quantized, low-variance timing for the underlying
    beat/drone pulse.
  - **Fill engine** — same clock, but reads from a probability/humanization model
    (timing jitter, velocity variance, off-grid subdivisions) so fills don't feel
    mechanically quantized against the steady pulse underneath them.
- Both engines address entities/AudioParams by ID from the entity graph — they
  don't know or care about the canvas.

### 5.4 Live input (2 channels: voice + instrument)

Two `Live Input` entities, each backed by its own `getUserMedia` stream (or one
stereo stream split into two mono sources if using a single 2-in interface) —
explicitly disable browser voice-chat processing on both:

```js
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1
  }
})
```

Each then behaves as an ordinary Source entity — droppable into any container,
processable through the same worklet/native-node chains as synthesized sources.
At two channels there's no pressing need for multichannel-interface routing
complexity — standard `getUserMedia` device selection is sufficient; revisit only
if the input count grows.

## 6. Persistence — composition format

A composition is a serialization of the entity graph: tree structure, per-entity
type + parameters + visual seed (for the noise-jittered boundary, so reloading
looks the same), Control→AudioParam bindings, and transport/pattern state. Plain
JSON is sufficient — this is config data, not a performance-critical path.
Load = rebuild the entity graph from JSON, which rebuilds the Web Audio graph and
the canvas rendering state from it (§3.3, §4.1) — same reconciliation logic used
for live drag-and-drop reparenting.

## 7. Deployment / Packaging

Ship as a normal web app for portability, but run live performances inside a
kiosk-mode wrapper (Electron, or Chrome launched with `--app=`) rather than a
literal multi-tab browser — avoids tab-throttling, notification pop-ins, and
accidental navigation mid-set, while keeping the "it's just a web app" portability
for rehearsal/travel/laptop-switching.

## 8. Proposed repository structure

```
/ui              canvas rendering, entity graph state, patcher interaction
/audio           Web Audio graph construction/reconciliation, scheduler/transport
/dsp             Rust crate(s) compiled to WASM, AudioWorklet processor shims
/textures         grunge texture assets (fills, edge brushes, cable strokes)
/shaders          (future) WebGL/WebGPU post-process passes
```

## 9. Open questions / future work

- **GPU post-processing**: land the Canvas2D layer first; add the WebGL overlay
  pass once there's real visual content to react to (audio-reactive shaders via
  `AnalyserNode` data are a natural next step, not a starting requirement).
- **Ableton Link / external tempo sync**: not in scope now (no external
  bandmates/hardware mentioned) — if it becomes needed, it's an additive bridge
  (native helper relaying Link's clock over WebSocket into the Transport layer),
  not an architecture change.
- **Native audio server escape hatch**: only reconsider this if you're CPU-bound
  on the single Web Audio render thread with several concurrent WASM voices
  running — and even then, prefer offloading just the heavy specific voice(s) via
  an OSC/WebSocket bridge to a native engine, keeping the entity graph and
  everything else exactly as described here, rather than a wholesale rewrite.
