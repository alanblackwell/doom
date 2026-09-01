// Single shared AudioContext for the app. Created lazily so it's constructed
// after a user gesture (browsers block autoplay of unstarted contexts).

let ctx: AudioContext | null = null;

// `latencyHint` controls the requested buffer size. 'interactive' asks for the
// smallest buffer the device will support — great for low latency, but some
// external audio interfaces can't sustain it and repeatedly underrun/reset
// (heard as clean audio for ~1s, then a ticking reset loop). Override via
// ?latency=<value> for on-device testing without editing code, e.g.:
//   ?latency=playback        (largest, most stable buffer)
//   ?latency=balanced
//   ?latency=0.1             (explicit seconds — any number works)
function resolveLatencyHint(): AudioContextLatencyCategory | number {
  const raw = new URLSearchParams(window.location.search).get('latency');
  if (!raw) return 'interactive';
  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber)) return asNumber;
  return raw as AudioContextLatencyCategory;
}

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: resolveLatencyHint() });
  }
  return ctx;
}

export async function resumeAudioContext(): Promise<void> {
  const c = getAudioContext();
  if (c.state === 'suspended') {
    await c.resume();
  }
}

// Suspending (rather than tearing down the graph) is the right "stop" for a
// toggle button — it pauses the whole audio clock cheaply and resume() picks
// up exactly where it left off, with no need to re-register worklets or
// rebuild the entity graph.
export async function suspendAudioContext(): Promise<void> {
  const c = getAudioContext();
  if (c.state === 'running') {
    await c.suspend();
  }
}
