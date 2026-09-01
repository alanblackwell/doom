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
