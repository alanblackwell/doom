// Per-kind control-parameter metadata and control-column layout geometry.
// Deliberately dependency-free (no layout.ts, no audio/*): layout.ts needs
// this to reserve space for a container's own control column when
// computing its bounds (so the column can never get covered by something
// dropped in, and a control-heavy pedal is never smaller than what it
// needs to show all its dots), and controls.ts/render.ts/interaction.ts
// need it to draw and drive the controls — importing this from both
// without a cycle is the reason it's split out on its own.

export interface ControlSpec {
  param: string; // matches entity.params key
  label: string; // shown on hover
  min: number;
  max: number;
  color: string;
}

// Per-kind control list — a kind not listed here gets no dots at all.
const CONTROL_SPECS: Record<string, ControlSpec[]> = {
  // pitch (formerly a 'frequency' dot here) is now driven by the doom lever
  // (ui/doomLever.ts's DOOM_LEVER_PITCH_TARGETS) instead of its own slider —
  // see that module's own header.
  bass: [{ param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' }],
  bow: [
    { param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' },
    // STK's own reference implementation only really behaves in ~0.03-0.25
    // (see dsp/rust/src/lib.rs) — range goes a bit past that for headroom.
    { param: 'bowVelocity', label: 'bow speed', min: 0, max: 0.3, color: '#7ec850' },
    // STK's normalized [0,1] pressure convention.
    { param: 'bowPressure', label: 'bow pressure', min: 0, max: 1, color: '#c85a5a' },
  ],
  // A granular noise voice (audio/grindPlayer.ts, audio/graph.ts's 'grind'
  // case) — NOT the bow_* WASM voice despite sharing 'pitch's blue below
  // for the same "same concept" reason bass/bow share it. 'grind' is the
  // one knob unique to this voice: grain density/pitch-jitter amount, 0
  // (sparse individual scrapes) to 1 (a dense, chaotic roar) — reuses bow
  // pressure's red "intensity/risk" convention, since turning it up is
  // literally "how far into the chaos." Frequency range shifted up into
  // buzzier chainsaw/grinder territory rather than a cello's.
grind: [
  { param: 'level', label: 'volume', min: 0, max: 1.7567999999999997, color: '#e0c840' },
  { param: 'grind', label: 'grind', min: 0, max: 1, color: '#c85a5a' },
],
overdrive: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'tone', label: 'tone', min: 200, max: 8000, color: '#c85ac8' },
    { param: 'drive', label: 'drive', min: 0, max: 20, color: '#e0883c' },
  ],
  // Same shape as overdrive above (level/tone/one drive-ish knob), but
  // audio/graph.ts's makeFuzzCurve is a genuinely harder clip — reuses
  // overdrive's drive orange since it's the same "how hard is it clipping"
  // concept, just with a buzzier result.
  fuzz: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'tone', label: 'tone', min: 200, max: 8000, color: '#c85ac8' },
    { param: 'fuzz', label: 'fuzz', min: 0, max: 20, color: '#e0883c' },
  ],
  reverb: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'tone', label: 'tone', min: 200, max: 8000, color: '#c85ac8' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
    { param: 'decay', label: 'decay', min: 0.5, max: 10, color: '#8a7ec8' },
  ],
  // Colors reused across chorus/flanger for shared param meaning (rate,
  // depth, mix, level are the same concept in both) — feedback reuses bow
  // pressure's red, in keeping with "red = intensity/risk knob."
  chorus: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'rate', label: 'rate', min: 0.05, max: 5, color: '#5ac8a0' },
    { param: 'depth', label: 'depth', min: 0.5, max: 8, color: '#d87ab0' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  flanger: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'rate', label: 'rate', min: 0.02, max: 2, color: '#5ac8a0' },
    { param: 'depth', label: 'depth', min: 0.5, max: 6, color: '#d87ab0' },
    // Capped at 0.95 in audio/graph.ts regardless of what this slider is
    // dragged to — see createModulatedDelay's comment.
    { param: 'feedback', label: 'feedback', min: 0, max: 0.95, color: '#c85a5a' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  // A resonant bandpass in a genuine positive-feedback loop (audio/graph.ts's
  // 'growl' case) — TODO.md's "growl filter" item, and a native-Web-Audio
  // port of the same feedback/soft-clip mechanism 'metal's own WASM voice
  // uses (dsp/rust/src/lib.rs's pluck_render), just as a routable pedal
  // instead of baked into one string voice. frequency/feedback reuse
  // feedbackFreq/feedback's own colors from 'metal' for the same concepts;
  // mix/level match every other pedal's own convention.
  growl: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'frequency', label: 'frequency', min: 100, max: 5000, color: '#5ac8a0' },
    { param: 'q', label: 'resonance', min: 0.1, max: 40, color: '#c85ac8' },
    // Capped at 0.95 in audio/graph.ts regardless of what this slider is
    // dragged to — see createGrowlFilter's own comment.
    { param: 'feedback', label: 'feedback', min: 0, max: 0.95, color: '#c85a5a' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
    // A real "make it stop" control, not just another tone knob — high
    // enough Q*feedback is a genuinely unstable loop that keeps ringing off
    // nothing but its own resonance once it gets going, and neither
    // removing the input nor a plain dock/undock reliably stops that (see
    // createGrowlFilter's own comment). Alarm red, distinct from feedback's
    // own muted red, so it doesn't read as just another tone/character dial.
    { param: 'kill', label: 'kill', min: 0, max: 1, color: '#e04a3c' },
  ],
  // A pitch-shifting resynthesis pedal (audio/vocodePlayer.ts,
  // audio/graph.ts's 'vocode' case): locks a one-shot f0/formant estimate
  // from whatever's contained inside it (ui/pitchAnalysis.ts,
  // ui/vocodeTuner.ts's own by-ear correction organelle), then continuously
  // resynthesizes at targetPitch through that fixed formant bank, dry/wet
  // mixed with the untouched contained source. targetPitch reuses bass/
  // bow/grind's own "pitch" blue; mix reuses growl's own dry/wet teal, same
  // concept.
  vocode: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  // A ring modulator (audio/graph.ts's 'ringmod' case) — multiplies rather
  // than filters, the inharmonic "robotic/metallic clang" effect nothing
  // else here does. frequency reuses bass/bow/grind/vocode's own "pitch"
  // blue since the carrier IS a pitch, just one that multiplies rather
  // than sounds on its own; mix reuses growl's own dry/wet teal.
  ringmod: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  // A bitcrusher (audio/graph.ts's 'bitcrush' case) — sample-rate
  // reduction (dsp/worklets/bitcrush-processor.js) plus bit-depth
  // reduction (a native WaveShaper curve), the other pillar of noise/
  // industrial digital harshness alongside ringmod above. bits reuses
  // overdrive/fuzz's own "how hard/crunchy is it" drive orange; mix
  // reuses growl's own dry/wet teal. rate no longer has its own dot —
  // it's doom-lever-driven now (see ui/doomLever.ts's
  // DOOM_LEVER_PITCH_TARGETS), same "the lever replaces the slider"
  // treatment as bass/bow/grind/etc.'s own pitch dots.
  bitcrush: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'bits', label: 'bit depth', min: 1, max: 16, color: '#e0883c' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  // A noise gate (audio/graph.ts's 'noisegate' case,
  // dsp/worklets/noisegate-processor.js) — mutes below threshold rather
  // than compressing above one, the tight silence-between-hits character
  // modern metal production wants. attack/release/hold are by-ear tunable
  // through ui/noisegateTuner.ts's own tuning organelle
  // (audio/noisegateTuning.ts's NOISEGATE_TUNING, reusing
  // ui/tuningOrganelle.ts same as grind/bass/metal/grain/vocode) but have
  // no control-dot of their own yet. mix reuses growl's own dry/wet teal;
  // threshold gets its own new "cutoff/floor" grey-teal, distinct from
  // every other pedal's own hues.
  noisegate: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'threshold', label: 'threshold', min: 0, max: 0.3, color: '#5a7a8a' },
    { param: 'mix', label: 'mix', min: 0, max: 1, color: '#4ab8a8' },
  ],
  // A grain-cloud voice reading from a captured sample (audio/grainPlayer.ts,
  // audio/graph.ts's 'grain' case; ui/grainSampler.ts's popup is where the
  // capture and its point markers actually live — this voice has no
  // frequency/pitch dot the way grind does, since its character comes from
  // whatever was captured, not a synthesized tone). density reuses grind's
  // own red for the same "sparse -> dense/chaotic" concept.
  grain: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    { param: 'density', label: 'density', min: 0, max: 1, color: '#c85a5a' },
    { param: 'grainLength', label: 'grain length', min: 0.01, max: 0.5, color: '#8a7ec8' },
  ],
  kick: [
    { param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' },
    // Same purple-blue as reverb's decay — punchy (short) vs. boomy (long).
    { param: 'decay', label: 'decay', min: 0.1, max: 1.5, color: '#8a7ec8' },
    { param: 'click', label: 'click', min: 0, max: 1, color: '#a0d8e0' },
  ],
  // Karplus-Strong plucked string (dsp/rust/src/lib.rs) — a one-shot
  // TRIGGERED_KINDS instrument like kick, not a drone: click its pad to
  // pluck it. Bass-guitar pitch range, matching 'bass' above.
  pluck: [
    { param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' },
    // Same purple-blue as kick/reverb's decay — how fast the string dies out.
    { param: 'damping', label: 'damping', min: 0, max: 1, color: '#8a7ec8' },
    // Same magenta as overdrive/reverb's tone — brightness of the pluck's
    // initial attack (see dsp/rust/src/lib.rs's PLUCK_RESPONSE comment).
    { param: 'response', label: 'response', min: 0, max: 1, color: '#c85ac8' },
  ],
  // Same Karplus-Strong voice as 'pluck' (audio/graph.ts's createPluckVoice),
  // tuned for a bright, aggressive pick attack with positive string
  // feedback instead of a muted decay — guitar pitch range, and a 'feedback'
  // knob 'pluck' doesn't expose.
  metal: [
    { param: 'level', label: 'volume', min: 0, max: 1.2, color: '#e0c840' },
    { param: 'damping', label: 'damping', min: 0, max: 1, color: '#8a7ec8' },
    { param: 'response', label: 'response', min: 0, max: 1, color: '#c85ac8' },
    // Reuses bow pressure's red — "intensity/risk knob," same convention as
    // flanger's feedback (ui/controlSpecs.ts's own comment on that entry):
    // past a certain point this is what pushes the string into runaway
    // self-oscillating squeal rather than a stable sustain.
    { param: 'feedback', label: 'feedback', min: 0, max: 1, color: '#c85a5a' },
    // Where the squeal locks on — a fixed frequency standing in for the
    // amp/room's own resonance (dsp/rust/src/lib.rs's PLUCK_FEEDBACK_FREQ),
    // not the note's own pitch, so different notes squeal more or less
    // readily depending how close one of their own partials lands here —
    // the same "move the guitar to find the sweet spot" tuning a real amp
    // needs. Reuses chorus/flanger's rate teal — same concept, a frequency
    // you're dialing in by ear rather than a fixed physical quantity.
    { param: 'feedbackFreq', label: 'squeal', min: 200, max: 3000, color: '#5ac8a0' },
  ],
  // A dropped-in audio file (ui/sampleDrop.ts, audio/graph.ts's 'sample'
  // case) — a TRIGGERED_KINDS one-shot like kick/pluck/metal above, not a
  // drone: click its pad to play it from the start. speed (playback rate,
  // "raising it audibly raises pitch too") is now driven by the doom lever
  // instead of its own slider — see ui/doomLever.ts's DOOM_LEVER_PITCH_TARGETS,
  // whose 'sample' entry goes all the way down to 0.01x at the lever's own
  // doomy end, far below what this dot's old 0.1x floor allowed.
  sample: [{ param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' }],
  // A hardware live-input channel (audio/graph.ts's 'liveInput' case,
  // ui/liveInputSetup.ts's own device-connect organelle) — just `level` for
  // now, capped well below every other voice's own headroom since there's
  // deliberately no anti-feedback protection yet (see ARCHITECTURE.md
  // §5.4). A feedback-margin control belongs here once that work lands, not
  // before.
  liveInput: [{ param: 'level', label: 'volume', min: 0, max: 0.6, color: '#e0c840' }],
  // A knob's own value — reuses the same dot+slider mechanism as every
  // other parameter (see ui/controls.ts), rather than needing bespoke
  // interaction code. Color matches the knob's rotating indicator (see
  // ui/render.ts's drawKnob) so the dot and the thing it's turning read as
  // the same value.
  knob: [{ param: 'value', label: 'value', min: 0, max: 1, color: '#e8dcc0' }],
  // The master clock's own tempo (audio/transport.ts) — same dot+slider
  // mechanism as a knob's value, just a musically-meaningful range instead
  // of a normalized 0-1. Warm amber to match the beat-pulse glow on its
  // wire-output bump (see ui/render.ts's drawClock).
  clock: [{ param: 'bpm', label: 'bpm', min: 5, max: 300, color: '#f0b860' }],
  // An ADSR envelope organelle (ui/organelle.ts, EntityType 'feature') —
  // not drawn via the generic dot column these specs otherwise describe
  // (see organelle.ts's own connection-point layout, positioned along its
  // popup's edge instead), but still keyed off the same ControlSpec shape
  // so the generic wire-color/opacity lookups in ui/render.ts (wireOpacity,
  // drawWires) and controlDotAbsolutePosition's feature branch in
  // ui/controls.ts work exactly like any other wire target.
  // Decay/release headroom well past what the popup's default zoom shows at
  // once (ui/organelle.ts's timeScale) — doom/drone tails routinely run into
  // many seconds, longer than a typical synth's ADSR ever needs to reach.
  envelope: [
    { param: 'attack', label: 'attack', min: 0.001, max: 5, color: '#7ec850' },
    { param: 'decay', label: 'decay', min: 0.001, max: 10, color: '#8a7ec8' },
    { param: 'sustain', label: 'sustain', min: 0, max: 1, color: '#e0c840' },
    { param: 'release', label: 'release', min: 0.001, max: 15, color: '#5aa0c8' },
  ],
  // A conventional oscillator+LFO synth voice (audio/graph.ts's 'synth'
  // case, a TRIGGERED_KINDS voice like pluck/metal — see ui/synthConfig.ts
  // for its own waveform-blend + LFO-routing organelle). Just `level` here:
  // pitch is doom-lever-driven (ui/doomLever.ts's DOOM_LEVER_PITCH_TARGETS,
  // same convention as every other pitched voice), and waveform mix/LFO
  // depth live entirely in the synthConfig popup instead of this generic
  // per-kind dot column.
  synth: [{ param: 'level', label: 'volume', min: 0, max: 1.5, color: '#e0c840' }],
  // A shared modulation source (audio/graph.ts's 'lfo' case) — a Control
  // entity like knob/clock, but its own live AudioParam value never gets
  // copied through a wire the way a knob's does (see ui/wiring.ts's own
  // header): it's wired into a synthConfig organelle's depth port instead,
  // where audio/graph.ts makes a real, continuously-running Web Audio
  // connection (reconcileSynthConfigModulation) rather than a one-shot
  // value-copy. rate reuses chorus/flanger's own teal for the same "a
  // frequency you're dialing in by ear" concept.
  lfo: [{ param: 'rate', label: 'rate', min: 0.05, max: 20, color: '#5ac8a0' }],
  // The 'synth' voice's own second organelle (ui/synthConfig.ts) — a
  // waveform-blend selector plus two LFO-modulation input ports (vibrato:
  // pitch, via each oscillator's own detune; tremolo: amplitude, via the
  // voice's own mix gain). These two are wire TARGETS only, same as
  // envelope's own params — a control-dot column entry gives them the
  // generic wire-endpoint/porthole-convergence machinery (ui/organelle.ts's
  // featureDotAbsolutePosition/hitTestFeatureDot, already kind-agnostic)
  // for free, without this popup needing to reimplement any of it.
  // vibratoDepth reuses chorus/flanger's own "depth" pink; tremoloDepth
  // reuses volume's own amber, since what it's modulating IS a gain.
  synthConfig: [
    { param: 'vibratoDepth', label: 'vibrato depth', min: 0, max: 1, color: '#d87ab0' },
    { param: 'tremoloDepth', label: 'tremolo depth', min: 0, max: 1, color: '#e0c840' },
  ],
  // A control-CONTAINING Control (audio/entityGraph.ts's containment reused
  // for controls, not audio — see CONTROL_CONTAINER_KINDS' own header):
  // continuously re-walks every contained control's own value (drawn via
  // ui/interaction.ts's stepControlContainers) by a fresh Gaussian-sampled
  // delta each step, so it drifts rather than jumping — a "sample and hold
  // random LFO" idiom. rate reuses lfo's own teal ("a frequency you're
  // dialing in by ear," same concept, just how often a fresh step is drawn
  // rather than a continuous oscillation); amount reuses chorus/flanger's
  // own depth pink (how big each step's neighbourhood is, as a fraction of
  // the contained control's own range).
  wander: [
    { param: 'rate', label: 'rate', min: 0.05, max: 10, color: '#5ac8a0' },
    { param: 'amount', label: 'amount', min: 0, max: 1, color: '#d87ab0' },
  ],
  // A control-containing Control like wander above, but for a contained
  // tap/clock's own fired EVENTS rather than a continuous value: each firing
  // is delayed by a random, Gaussian-magnitude offset (ui/interaction.ts's
  // jitterDelayMs) instead of landing exactly on the beat/keypress — a
  // "sloppy timing" humanizer. One-sided (always later, never earlier) —
  // an event that already fired can't un-fire, so there's no way to honor a
  // negative sample the way wander's own continuous value can. amount reuses
  // bow pressure/grind's own "how far into the chaos" red, in seconds of
  // jitter magnitude rather than a 0-1 fraction (there's no natural
  // "full-scale" for a time offset the way a value dot's own min/max gives
  // wander one).
  jitter: [{ param: 'amount', label: 'amount', min: 0, max: 1, color: '#c85a5a' }],
};

// Control-CONTAINING Control kinds — the "control container" analog of
// audio/graph.ts's PROCESSOR_KINDS (a sink+source pedal a Source can be
// dropped into): a box a Control (knob/clock/tap/lfo/...) can be dropped
// into, which then continuously modifies whatever's inside it rather than
// passing audio through. Still `type: 'control'` (no audio output, no Web
// Audio node — see audio/graph.ts's buildFromEntityGraph control-kind
// switch, which needs no case for these, same as knob/tap's own no-op
// entries there), but — unlike every OTHER control kind (knob/clock/tap/
// lfo/sequencer/beatMatcher) — draws as a hollow box (ui/render.ts's
// drawBox) and participates in containment/docking (ui/docking.ts's
// isDockable, ui/interaction.ts's containerTarget) the same way a
// PROCESSOR_KINDS pedal does, just gated on the DRAGGED entity being a
// Control instead of a Source. Nesting one of these inside another is not
// supported (ui/interaction.ts's containerTarget refuses it) — keeps "what
// does dropping a wander into a jitter even mean" from ever coming up.
export const CONTROL_CONTAINER_KINDS = new Set(['wander', 'jitter']);

export function controlsFor(kind: string): ControlSpec[] {
  return CONTROL_SPECS[kind] ?? [];
}

// Two-layer dot: a grey outer ring (a fixed backdrop, roughly matching the
// UI's own dark control-surface color — see ui/render.ts's drawControls)
// with a smaller colored dot resting at its center. The colored dot grows
// (not all the way to the ring's own edge — just to CONTROL_DOT_DROP_RADIUS)
// when it's a valid wire drop target, rather than the whole thing growing
// past its own footprint.
export const CONTROL_DOT_OUTER_RADIUS = 8;
export const CONTROL_DOT_RADIUS = 1.5; // resting inner colored dot
export const CONTROL_DOT_DROP_RADIUS = 3; // grown size as a wire drop target
export const CONTROL_HIT_RADIUS = 10; // generous target around the visual dot
export const CONTROL_TRACK_LENGTH = 80; // px the slider travels, independent of value

export const DOT_INSET = 14; // from the box's bottom edge to the first (bottom) dot
// Distance from the box's left edge to the dot's center — mostly outside
// the boundary (poking out to the left, mirroring a knob's wire-output
// bump poking out to the right — inputs left, outputs right, matching the
// wires' left-to-right flow), with a couple of px of overlap back in so it
// reads as attached rather than floating free of the box.
export const DOT_OUTSET = CONTROL_DOT_OUTER_RADIUS - 2;
export const DOT_SPACING = 22; // vertical gap between successive dots in the column

export interface Point {
  x: number;
  y: number;
}

// Only the shape dotPosition actually needs — not layout.ts's Rect, to keep
// this module free of that dependency.
export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Rest position of a dot — index 0 is nearest the box (bottom of the
// column), rising from there. On the left, outside the box (see
// DOT_OUTSET): these are a target's inputs, and wires flow left-to-right
// from a source's output bump (ui/knobs.ts's wireHandlePosition) on its
// right — so a wire runs straight across from one box's right side to the
// next box's left, rather than doubling back.
export function dotPosition(bounds: BoxLike, index: number): Point {
  return {
    x: bounds.x - bounds.width / 2 - DOT_OUTSET,
    y: bounds.y + bounds.height / 2 - DOT_INSET - index * DOT_SPACING,
  };
}
