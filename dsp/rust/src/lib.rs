// Real-time DSP for the browser's AudioWorklet, compiled to
// wasm32-unknown-unknown. See ARCHITECTURE.md §5.2.
//
// Deliberately NOT using wasm-bindgen: bindgen's JS glue is built for
// ergonomic app-level calls (strings, JsValue, etc.), and its marshalling
// has a per-call cost that's fine at UI-interaction rates but unwelcome on
// the audio render thread. Instead this exposes a plain C ABI and a fixed
// static buffer in the module's own linear memory — the AudioWorklet shim
// reads that memory directly (via a Float32Array view over
// `instance.exports.memory.buffer`), so there's no per-sample boundary
// crossing at all, just one pointer + one render() call per 128-frame
// render quantum.
//
// Because nothing here touches the heap (no String/Vec/Box), there's no
// need for a #[global_allocator] — keep it that way as long as possible;
// pulling one in is the point at which future algorithms (granular
// buffers, delay lines) will need deliberate memory planning instead.

const QUANTUM: usize = 128;

static mut RNG_STATE: u32 = 0x9E3779B9;
static mut BUFFER: [f32; QUANTUM] = [0.0; QUANTUM];

// bass_render() reuses BUFFER/buffer_ptr/buffer_len above — a WASM instance
// is only ever driven by one worklet processor (noise-processor.js calls
// render(); bass-processor.js calls bass_render()), so there's no conflict,
// and it avoids a second buffer/pointer/length trio for every new voice.
static mut PHASE_A: f32 = 0.0;
static mut PHASE_B: f32 = 0.0;
static mut SAMPLE_RATE: f32 = 48000.0;
static mut FREQUENCY: f32 = 41.2; // low E — standard doom/drop-tuned guitar territory

// Two detuned saws beat against each other for width/"fatness" (the classic
// unison-detune trick) rather than a single naive saw. Precomputed constant
// ratio instead of calling powf() at runtime — this module has no reason to
// pull in libm for a fixed detune amount. 1.0040516 ≈ +7 cents.
const DETUNE_RATIO: f32 = 1.0040516;

fn soft_clip(x: f32) -> f32 {
    x / (1.0 + x.abs())
}

// Takes a raw pointer rather than `&mut u32` — this module never forms a
// reference to a `static mut`, only raw pointers via `&raw`, per the
// rust_2024_compatibility lint (forming references to mutable statics is
// deprecated even in single-threaded contexts like this one).
unsafe fn xorshift32(state: *mut u32) -> u32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

#[no_mangle]
pub extern "C" fn seed(value: u32) {
    unsafe {
        RNG_STATE = if value == 0 { 0x9E3779B9 } else { value };
    }
}

#[no_mangle]
pub extern "C" fn buffer_ptr() -> *const f32 {
    (&raw const BUFFER) as *const f32
}

#[no_mangle]
pub extern "C" fn buffer_len() -> usize {
    QUANTUM
}

// Fills BUFFER with one render quantum of white noise in [-1.0, 1.0].
// Call once per AudioWorkletProcessor.process() before reading buffer_ptr().
#[no_mangle]
pub extern "C" fn render() {
    let base = (&raw mut BUFFER) as *mut f32;
    let rng = &raw mut RNG_STATE;
    unsafe {
        for i in 0..QUANTUM {
            let r = xorshift32(rng);
            *base.add(i) = (r as f32 / u32::MAX as f32) * 2.0 - 1.0;
        }
    }
}

#[no_mangle]
pub extern "C" fn bass_init(sample_rate: f32, freq: f32) {
    unsafe {
        SAMPLE_RATE = sample_rate;
        FREQUENCY = freq;
        PHASE_A = 0.0;
        PHASE_B = 0.0;
    }
}

// Live pitch change: bass_render() already reads FREQUENCY fresh every
// call and derives freq_a/freq_b from it, and phase keeps advancing
// continuously through the change — unlike the bow voice, there's no
// cached derived state to recompute and no delay-line read-position jump,
// so this is a genuinely click-free frequency change, not just a small one.
#[no_mangle]
pub extern "C" fn bass_set_frequency(freq: f32) {
    unsafe {
        FREQUENCY = freq;
    }
}

// Fills BUFFER with one render quantum of a detuned-unison sawtooth drone,
// driven into soft clipping for harmonic warmth — the "fat and bassy"
// contrast to render()'s hiss. Call bass_init() once first.
#[no_mangle]
pub extern "C" fn bass_render() {
    let base = (&raw mut BUFFER) as *mut f32;
    unsafe {
        let sr = SAMPLE_RATE;
        let freq_a = FREQUENCY / DETUNE_RATIO;
        let freq_b = FREQUENCY * DETUNE_RATIO;
        let mut phase_a = PHASE_A;
        let mut phase_b = PHASE_B;

        for i in 0..QUANTUM {
            let saw_a = 2.0 * phase_a - 1.0;
            let saw_b = 2.0 * phase_b - 1.0;
            let mixed = (saw_a + saw_b) * 0.5;
            *base.add(i) = soft_clip(mixed * 1.6);

            phase_a += freq_a / sr;
            if phase_a >= 1.0 {
                phase_a -= 1.0;
            }
            phase_b += freq_b / sr;
            if phase_b >= 1.0 {
                phase_b -= 1.0;
            }
        }

        PHASE_A = phase_a;
        PHASE_B = phase_b;
    }
}

// --- Bowed string (two-segment digital waveguide) ---
//
// Ported from STK's Bowed.cpp / BowTable.h / OnePole.h
// (github.com/thestk/stk — Cook & Scavone, after Smith 1986 / McIntyre,
// Schumacher & Woodhouse 1983), checked directly against that source rather
// than reconstructed from memory. An earlier single-delay-loop attempt here
// converged to a silent DC fixed point (string velocity locked to bow
// velocity) instead of oscillating — it was missing the actual mechanism:
// the string has to be split into TWO delay segments (nut-to-bow and
// bow-to-bridge) whose reflections invert sign. That inversion is the
// restoring force that makes "stuck to the bow" an *unstable* equilibrium,
// which is what forces the stick/slip cycle that makes this self-sustaining.
//
// Per sample: read each segment's last output, invert both (the nut and
// bridge reflections), sum them for the string's velocity at the bow, run
// (bow velocity − string velocity) through the nonlinear friction table, and
// feed the result — cross-coupled — back into both delay lines: the neck
// line receives the bridge reflection plus the bow correction, and vice
// versa. That cross-coupling is the wave actually propagating from the bow
// point in both directions.
//
// STK's 6-cascaded-biquad body-resonance filter is deliberately NOT ported
// here — those coefficients are fixed for one sample rate, and fit better as
// a native BiquadFilterNode/ConvolverNode downstream of this entity in the
// Web Audio graph (ARCHITECTURE.md §3.3: containment-based routing), where
// they're also editable live rather than baked into WASM. Without it this
// voice is the raw bowed string, not yet shaped by a cello body — expect it
// to sound more "raw fiddle" than "cello in a room" until that's added.

const WAVEGUIDE_LEN: usize = 2048; // power of two; supports fundamentals down to ~23Hz at 48kHz
const WAVEGUIDE_MASK: usize = WAVEGUIDE_LEN - 1;

// Exactly STK's BowTable defaults as used by Bowed's constructor.
const BOW_TABLE_OFFSET: f32 = 0.001;
const BOW_TABLE_MIN: f32 = 0.01;
const BOW_TABLE_MAX: f32 = 0.98;

const BOW_POSITION: f32 = 0.127236; // fraction of string length from the bridge (STK default)
const STRING_FILTER_GAIN: f32 = 0.95;

static mut NECK_DELAY: [f32; WAVEGUIDE_LEN] = [0.0; WAVEGUIDE_LEN];
static mut BRIDGE_DELAY: [f32; WAVEGUIDE_LEN] = [0.0; WAVEGUIDE_LEN];
static mut NECK_WRITE_IDX: usize = 0;
static mut BRIDGE_WRITE_IDX: usize = 0;
static mut NECK_LAST_OUT: f32 = 0.0;
static mut BRIDGE_LAST_OUT: f32 = 0.0;
static mut NECK_DELAY_LEN: f32 = 0.0;
static mut BRIDGE_DELAY_LEN: f32 = 0.0;
static mut STRING_FILTER_STATE: f32 = 0.0;
static mut STRING_FILTER_POLE: f32 = 0.6;
static mut BOW_VELOCITY: f32 = 0.6;
// STK's Bowed constructor hardcodes bowTable_.setSlope(3.0) rather than
// deriving it from a "pressure" control — this is that same default. Bow
// pressure (bow_set_pressure below) is exposed as STK's own normalized
// [0,1] control convention (slope = 5.0 - 4.0*pressure), and 0.5 is chosen
// deliberately as this control's default because it reproduces this exact
// 3.0 starting slope, so adding the control doesn't change the sound of
// anything already tuned.
static mut BOW_TABLE_SLOPE: f32 = 3.0;

// input^-4 done as a reciprocal squaring rather than powf() — matches STK's
// BowTable::tick() (pow(x, -4.0), x always > 0 here) without needing libm.
// Takes slope as a parameter (read once per render() call into a local,
// same as bow_velocity/pole below) rather than reading the static directly,
// consistent with this file's "no references to mutable statics" approach.
fn bow_table(delta_v: f32, slope: f32) -> f32 {
    let x = (delta_v + BOW_TABLE_OFFSET) * slope;
    let x = x.abs() + 0.75;
    let x2 = x * x;
    let mut friction = 1.0 / (x2 * x2);
    if friction < BOW_TABLE_MIN {
        friction = BOW_TABLE_MIN;
    }
    if friction > BOW_TABLE_MAX {
        friction = BOW_TABLE_MAX;
    }
    friction
}

// Fractional (linearly interpolated) delay line: writes `input` at the write
// pointer, advances it, and returns the newly computed delayed read — this
// is STK's DelayL::tick() (write-then-read-ahead; the return value becomes
// "lastOut()" for the next call).
unsafe fn delay_tick(buf: *mut f32, write_idx: *mut usize, delay_len: f32, input: f32) -> f32 {
    *buf.add(*write_idx & WAVEGUIDE_MASK) = input;
    *write_idx = (*write_idx + 1) & WAVEGUIDE_MASK;

    let read_pos = *write_idx as f32 - delay_len;
    let read_pos = if read_pos < 0.0 {
        read_pos + WAVEGUIDE_LEN as f32
    } else {
        read_pos
    };
    let idx0 = read_pos as usize & WAVEGUIDE_MASK;
    let idx1 = (idx0 + 1) & WAVEGUIDE_MASK;
    let frac = read_pos - read_pos.floor();
    let s0 = *buf.add(idx0);
    let s1 = *buf.add(idx1);
    s0 + frac * (s1 - s0)
}

// "Delay = length - approximate filter delay" (STK's comment, verbatim
// rationale). Shared by bow_init() and bow_set_frequency() so a live pitch
// change computes the split exactly the same way the initial one did.
fn bow_delay_lengths(sample_rate: f32, freq: f32) -> (f32, f32) {
    let base_delay = (sample_rate / freq - 4.0).max(4.0);
    let neck = (base_delay * (1.0 - BOW_POSITION)).clamp(2.0, (WAVEGUIDE_LEN - 2) as f32);
    let bridge = (base_delay * BOW_POSITION).clamp(2.0, (WAVEGUIDE_LEN - 2) as f32);
    (neck, bridge)
}

#[no_mangle]
pub extern "C" fn bow_init(sample_rate: f32, freq: f32, bow_velocity: f32) {
    unsafe {
        SAMPLE_RATE = sample_rate;
        FREQUENCY = freq;
        BOW_VELOCITY = bow_velocity;

        let (neck_len, bridge_len) = bow_delay_lengths(sample_rate, freq);
        NECK_DELAY_LEN = neck_len;
        BRIDGE_DELAY_LEN = bridge_len;

        STRING_FILTER_POLE = 0.75 - 0.2 * 22050.0 / sample_rate;
        STRING_FILTER_STATE = 0.0;

        let neck = (&raw mut NECK_DELAY) as *mut f32;
        let bridge = (&raw mut BRIDGE_DELAY) as *mut f32;
        for i in 0..WAVEGUIDE_LEN {
            *neck.add(i) = 0.0;
            *bridge.add(i) = 0.0;
        }
        NECK_WRITE_IDX = 0;
        BRIDGE_WRITE_IDX = 0;
        NECK_LAST_OUT = 0.0;
        BRIDGE_LAST_OUT = 0.0;
    }
}

// Live pitch change: recomputes the neck/bridge split for the new frequency
// without resetting the delay-line contents or write pointers, so the
// string keeps vibrating through the change rather than restarting from
// silence. The read position is derived fresh from the delay length each
// sample (see delay_tick), so changing the length mid-stream does shift
// what's being read — for a continuously-dragged slider this reads as a
// pitch glide, not a click, the same character a real delay-line/tape pitch
// change has. Bigger sudden jumps (not from a drag) would be more audible;
// nothing currently drives this except the UI slider, so that's the
// intended use.
#[no_mangle]
pub extern "C" fn bow_set_frequency(freq: f32) {
    unsafe {
        FREQUENCY = freq;
        let (neck_len, bridge_len) = bow_delay_lengths(SAMPLE_RATE, freq);
        NECK_DELAY_LEN = neck_len;
        BRIDGE_DELAY_LEN = bridge_len;
    }
}

// Live "bow speed" change — BOW_VELOCITY is read fresh every bow_render()
// call, so this is a plain, click-free coefficient update (same reasoning
// as bass_set_frequency above).
#[no_mangle]
pub extern "C" fn bow_set_velocity(value: f32) {
    unsafe {
        BOW_VELOCITY = value;
    }
}

// Live "bow pressure" change, in STK's own normalized [0,1] control
// convention (matching Bowed::controlChange's __SK_BowPressure_ handler
// exactly: slope = 5.0 - 4.0*pressure). Also just a coefficient read fresh
// each render() call — see the comment on BOW_TABLE_SLOPE's declaration for
// why 0.5 is the pressure value that reproduces this voice's original
// (pre-control) default sound.
#[no_mangle]
pub extern "C" fn bow_set_pressure(pressure: f32) {
    unsafe {
        BOW_TABLE_SLOPE = 5.0 - 4.0 * pressure.clamp(0.0, 1.0);
    }
}

#[no_mangle]
pub extern "C" fn bow_render() {
    let out = (&raw mut BUFFER) as *mut f32;
    let neck = (&raw mut NECK_DELAY) as *mut f32;
    let bridge = (&raw mut BRIDGE_DELAY) as *mut f32;
    let neck_write_idx = &raw mut NECK_WRITE_IDX;
    let bridge_write_idx = &raw mut BRIDGE_WRITE_IDX;

    unsafe {
        let bow_velocity = BOW_VELOCITY;
        let slope = BOW_TABLE_SLOPE;
        let pole = STRING_FILTER_POLE;
        let neck_len = NECK_DELAY_LEN;
        let bridge_len = BRIDGE_DELAY_LEN;
        let mut string_filter_state = STRING_FILTER_STATE;
        let mut neck_last_out = NECK_LAST_OUT;
        let mut bridge_last_out = BRIDGE_LAST_OUT;

        for i in 0..QUANTUM {
            string_filter_state =
                pole * string_filter_state + (1.0 - pole) * STRING_FILTER_GAIN * bridge_last_out;
            let bridge_reflection = -string_filter_state;
            let nut_reflection = -neck_last_out;

            let string_velocity = bridge_reflection + nut_reflection;
            let delta_v = bow_velocity - string_velocity;
            let new_velocity = delta_v * bow_table(delta_v, slope);

            neck_last_out = delay_tick(
                neck,
                neck_write_idx,
                neck_len,
                bridge_reflection + new_velocity,
            );
            bridge_last_out = delay_tick(
                bridge,
                bridge_write_idx,
                bridge_len,
                nut_reflection + new_velocity,
            );

            *out.add(i) = bridge_last_out;
        }

        STRING_FILTER_STATE = string_filter_state;
        NECK_LAST_OUT = neck_last_out;
        BRIDGE_LAST_OUT = bridge_last_out;
    }
}

// --- Plucked string (Karplus-Strong) ---
//
// The classic algorithm (Karplus & Strong 1983 / Jaffe & Smith's extensions):
// a circular delay line sized to one period of the target pitch, refilled
// with lowpass-shaped noise on every pluck (pluck_excite()), then
// continuously read-and-written-back in place (pluck_render(), called every
// process() like bow_render/bass_render) through an averaging filter — it's
// that averaging (`s0`/`s1` below) that makes higher harmonics decay faster
// than the fundamental, which is the entire "plucked string" character; a
// naive one-tap delay loop would just repeat forever unchanged.
//
// Two controls layer on top of the bare algorithm, per the "thumb plucking
// a bass E string" brief: PLUCK_RESPONSE shapes only the initial excitation
// burst's brightness (a thumb's attack is far more lowpassed than a pick's —
// low response reads as a muted thumb pluck, high as a sharper, more
// percussive one), while PLUCK_DAMPING adds an extra one-pole lowpass *and*
// a per-sample loop-gain trim to the ongoing feedback loop, so higher
// damping both dulls the tone and shortens the decay together — like palm-
// muting a string, not just an EQ move. Both are tune-by-ear controls (no
// physical ground truth to derive the mapping from), wired to the 'pluck'
// entity's params.damping/response in audio/graph.ts.
//
// Deliberately no fractional-delay interpolation (contrast bow_render's
// delay_tick): classic Karplus-Strong just rounds the period to the nearest
// sample and accepts the resulting small tuning error, which is inaudible
// for a decaying plucked note. A live pitch change (pluck_set_frequency)
// follows bow_set_frequency's approach — recompute the length, let the
// existing buffer content carry over rather than resetting it — so a pluck
// already ringing glides slightly instead of clicking.

const PLUCK_MAX_LEN: usize = 8192; // supports down to ~6Hz at 48kHz — ample headroom under this voice's tuned pitch range
const PLUCK_MIN_SAMPLES: usize = 8;

static mut PLUCK_DELAY: [f32; PLUCK_MAX_LEN] = [0.0; PLUCK_MAX_LEN];
static mut PLUCK_WRITE_IDX: usize = 0;
static mut PLUCK_LEN_SAMPLES: usize = 1024;
static mut PLUCK_SAMPLE_RATE: f32 = 48000.0;
// Overwritten by pluck_init() on every real instantiation (see
// dsp/worklets/pluck-processor.js) — these are just the pre-init values.
// Tuned by ear to a heavily muted thumb attack and a long, dark decay; see
// ui/main.ts's pluck-1 for where the authoritative defaults now live.
static mut PLUCK_DAMPING: f32 = 0.91;
static mut PLUCK_RESPONSE: f32 = 0.21;
// 0 (the 'pluck' kind's only value — see audio/graph.ts) leaves
// pluck_render's original decay-only math completely untouched, so this
// can't regress that already-tuned voice. >0 (the 'metal' kind) is real
// amp/pickup-style feedback: see the comment on svf_bandpass below for why
// this isn't just a blanket per-cycle gain boost.
static mut PLUCK_FEEDBACK: f32 = 0.0;
// The fixed frequency feedback locks onto — stands in for the amp/room's
// own resonance, NOT the string's pitch (see svf_bandpass). Independently
// controllable (pluck_set_feedback_freq) so different notes can be tuned to
// squeal more or less readily, the way moving a real guitar around the room
// does.
static mut PLUCK_FEEDBACK_FREQ: f32 = 1200.0;
static mut PLUCK_SVF_LOW: f32 = 0.0;
static mut PLUCK_SVF_BAND: f32 = 0.0;
static mut PLUCK_FILTER_STATE: f32 = 0.0;

// Q of the feedback resonance below — narrow enough to genuinely pick out
// one partial rather than reinforcing a broad swath of the spectrum, but
// not so narrow it needs an exact frequency match to excite.
const FEEDBACK_Q: f32 = 4.0;

// Chamberlin state-variable filter, band-pass output. Standard/stable
// direct-form design (not derived from anything else in this file) — `f`
// is the usual `2*sin(pi*freq/sampleRate)` coefficient, clamped so it stays
// well-behaved even at this voice's highest playable pitches.
fn svf_bandpass(input: f32, freq: f32, sample_rate: f32, low: &mut f32, band: &mut f32) -> f32 {
    let f = (2.0 * (std::f32::consts::PI * freq / sample_rate).sin()).clamp(0.0, 1.0);
    *low += f * *band;
    let high = input - *low - *band / FEEDBACK_Q;
    *band += f * high;
    *band
}

fn pluck_len_for(sample_rate: f32, freq: f32) -> usize {
    let n = (sample_rate / freq.max(1.0)).round() as usize;
    n.clamp(PLUCK_MIN_SAMPLES, PLUCK_MAX_LEN - 1)
}

#[no_mangle]
pub extern "C" fn pluck_init(
    sample_rate: f32,
    freq: f32,
    damping: f32,
    response: f32,
    feedback: f32,
    feedback_freq: f32,
) {
    unsafe {
        PLUCK_SAMPLE_RATE = sample_rate;
        PLUCK_DAMPING = damping.clamp(0.0, 1.0);
        PLUCK_RESPONSE = response.clamp(0.0, 1.0);
        PLUCK_FEEDBACK = feedback.clamp(0.0, 1.0);
        PLUCK_FEEDBACK_FREQ = feedback_freq.max(20.0);
        PLUCK_SVF_LOW = 0.0;
        PLUCK_SVF_BAND = 0.0;
        PLUCK_LEN_SAMPLES = pluck_len_for(sample_rate, freq);
        PLUCK_WRITE_IDX = 0;
        PLUCK_FILTER_STATE = 0.0;
        let buf = (&raw mut PLUCK_DELAY) as *mut f32;
        for i in 0..PLUCK_MAX_LEN {
            *buf.add(i) = 0.0;
        }
    }
}

#[no_mangle]
pub extern "C" fn pluck_set_frequency(freq: f32) {
    unsafe {
        PLUCK_LEN_SAMPLES = pluck_len_for(PLUCK_SAMPLE_RATE, freq);
    }
}

#[no_mangle]
pub extern "C" fn pluck_set_damping(value: f32) {
    unsafe {
        PLUCK_DAMPING = value.clamp(0.0, 1.0);
    }
}

#[no_mangle]
pub extern "C" fn pluck_set_response(value: f32) {
    unsafe {
        PLUCK_RESPONSE = value.clamp(0.0, 1.0);
    }
}

#[no_mangle]
pub extern "C" fn pluck_set_feedback(value: f32) {
    unsafe {
        PLUCK_FEEDBACK = value.clamp(0.0, 1.0);
    }
}

#[no_mangle]
pub extern "C" fn pluck_set_feedback_freq(value: f32) {
    unsafe {
        PLUCK_FEEDBACK_FREQ = value.max(20.0);
    }
}

// Re-excites the string: refills the active delay line with lowpass-shaped
// noise (see PLUCK_RESPONSE above) and resets the feedback filter and write
// pointer, so every trigger gets a clean, identically-shaped attack rather
// than inheriting whatever state the previous pluck's decay happened to
// leave behind — the same "fresh hit every time" reasoning as kick's
// per-trigger envelope in audio/graph.ts. Reuses RNG_STATE/xorshift32 above
// rather than a second RNG — safe because a WASM instance only ever drives
// one voice (each entity gets its own instance/state; see audio/graph.ts's
// dspModule comment), so there's no cross-voice interference.
#[no_mangle]
pub extern "C" fn pluck_excite() {
    let buf = (&raw mut PLUCK_DELAY) as *mut f32;
    let rng = &raw mut RNG_STATE;
    unsafe {
        let n = PLUCK_LEN_SAMPLES;
        // Lower response = heavier smoothing = a duller, more muted attack
        // (thumb); higher = closer to the raw noise burst (pick-like).
        let excite_pole = 0.92 - 0.87 * PLUCK_RESPONSE;
        let mut state = 0.0f32;
        for i in 0..n {
            let r = xorshift32(rng);
            let noise = (r as f32 / u32::MAX as f32) * 2.0 - 1.0;
            state = excite_pole * state + (1.0 - excite_pole) * noise;
            *buf.add(i) = state;
        }
        for i in n..PLUCK_MAX_LEN {
            *buf.add(i) = 0.0;
        }
        PLUCK_WRITE_IDX = 0;
        PLUCK_FILTER_STATE = 0.0;
        PLUCK_SVF_LOW = 0.0;
        PLUCK_SVF_BAND = 0.0;
    }
}

#[no_mangle]
pub extern "C" fn pluck_render() {
    let out = (&raw mut BUFFER) as *mut f32;
    let buf = (&raw mut PLUCK_DELAY) as *mut f32;
    unsafe {
        let n = PLUCK_LEN_SAMPLES.max(1);
        // Higher damping = a darker filter pole AND a slightly leakier loop
        // gain, so the string both dulls and dies out faster — matching a
        // palm-muted/heavily-damped string rather than just a tone change.
        let damping = PLUCK_DAMPING;
        let feedback = PLUCK_FEEDBACK;
        let feedback_freq = PLUCK_FEEDBACK_FREQ;
        let sample_rate = PLUCK_SAMPLE_RATE;
        let pole = 0.1 + 0.85 * damping;
        let loop_gain = 0.999 - 0.03 * damping;
        let mut filter_state = PLUCK_FILTER_STATE;
        let mut svf_low = PLUCK_SVF_LOW;
        let mut svf_band = PLUCK_SVF_BAND;
        let mut idx = PLUCK_WRITE_IDX % n;

        for i in 0..QUANTUM {
            let idx_next = if idx + 1 >= n { 0 } else { idx + 1 };
            let s0 = *buf.add(idx);
            let s1 = *buf.add(idx_next);
            let avg = 0.5 * (s0 + s1);
            filter_state = pole * filter_state + (1.0 - pole) * avg;

            if feedback > 0.0001 {
                // Real amp/pickup feedback is frequency-selective — it picks
                // out whichever of the string's own partials happens to sit
                // near the amp/room's own resonance and grows THAT one, while
                // the rest of the note keeps decaying normally (see
                // svf_bandpass's comment). Injecting a resonant band-pass tap
                // back into the string, scaled by feedback, reproduces that:
                // unlike a blanket gain boost (which just makes the whole
                // note louder/longer), only the partial near feedback_freq
                // gets reinforced enough to actually squeal — which partial
                // that is depends on which note is fretted, same as on a
                // real amp. soft_clip on the combined result is what keeps
                // this genuine positive-feedback loop bounded rather than
                // diverging once the targeted partial starts to run away.
                let injected = svf_bandpass(filter_state, feedback_freq, sample_rate, &mut svf_low, &mut svf_band);
                let driven = filter_state * loop_gain + injected * feedback * 3.0;
                let drive = 1.0 + feedback * 4.0;
                *buf.add(idx) = soft_clip(driven * drive) / drive;
            } else {
                *buf.add(idx) = filter_state * loop_gain;
            }

            *out.add(i) = s0;
            idx = idx_next;
        }

        PLUCK_FILTER_STATE = filter_state;
        PLUCK_SVF_LOW = svf_low;
        PLUCK_SVF_BAND = svf_band;
        PLUCK_WRITE_IDX = idx;
    }
}
