// Reactive per-event-source pulse timing, used to animate the WHOLE LENGTH
// of an event wire (ui/render.ts's drawWires) in sync with its endpoints'
// own flash indicators (ui/interaction.ts's triggerFlashes pad-ring,
// ui/clockPulse.ts's beat glow) — TODO.md item 5.
//
// Deliberately generic over which kind of event source fired (the
// recurring clock, ui/clockPulse.ts; or a one-off tap click/keypress,
// ui/interaction.ts's fireTap) rather than special-casing either: every
// source's own inter-pulse period is estimated reactively, from the gap
// actually observed between its own last two firings, so a steady clock
// converges on its true beat period and an irregularly-clicked tap just
// uses whatever gap it last saw — the same mechanism either way, and it
// keeps working correctly if the clock's own tempo changes mid-performance.

const lastPulseAt = new Map<string, number>();
const lastPulseInterval = new Map<string, number>();

// Used only for a source's very first-ever pulse, before there's a second
// one yet to measure a real interval from — a reasonable generic guess (a
// moderate tempo's beat length), not tied to any specific source.
const DEFAULT_PULSE_INTERVAL_MS = 600;

// A source entity id plus an optional port (audio/sequencerPlayer.ts's
// channel index) into one map key — undefined for a single-port source
// (tap/clock), so their existing callers (which never pass a port) keep
// working unchanged. A multi-port source needs one independent pulse
// history per port: without this, firing one sequencer channel would make
// every other channel's own wire glow too, since they'd all share one
// entry keyed by the same entity id.
function pulseKey(entityId: string, port: number | undefined): string {
  return `${entityId}:${port ?? ''}`;
}

// Call exactly when an event source actually fires — see ui/interaction.ts's
// fireTap, ui/clockPulse.ts's per-beat handler, and audio/sequencerPlayer.ts's
// per-channel firing, the only places an event source's own pulse
// originates (all already compute a fresh performance.now() for their own
// flash bookkeeping; pass that same value here so everything stays exactly
// in sync).
export function recordSourcePulse(entityId: string, now: number, port?: number): void {
  const key = pulseKey(entityId, port);
  const previous = lastPulseAt.get(key);
  if (previous !== undefined) {
    lastPulseInterval.set(key, now - previous);
  }
  lastPulseAt.set(key, now);
}

// "Very dim" rather than fully invisible right before the next pulse is due
// — the wire should always read as live-and-waiting, not gone.
const MIN_GLOW = 0.3;
// The quick rise to full brightness happens over this fraction of the
// (estimated) inter-pulse period, capped in absolute ms too so a slow tempo
// or a rarely-clicked tap doesn't stretch the rise itself into something
// that reads as gradual rather than quick.
const ATTACK_FRACTION = 0.12;
const ATTACK_MAX_MS = 120;

// 1 (brightest) right as elapsedMs crosses 0 — reached via a quick linear
// rise from MIN_GLOW over the attack window — then a gradual linear fade
// back down to MIN_GLOW by the time elapsedMs reaches periodMs (the next
// pulse's estimated due time). Matches ui/clockPulse.ts's getBeatFlashGlow
// in spirit (1 at the pulse, linear fade after) but stretched across the
// WHOLE inter-pulse period instead of a fixed short duration, and with a
// floor instead of fading all the way to nothing.
function pulseEnvelope(elapsedMs: number, periodMs: number): number {
  if (elapsedMs < 0) return MIN_GLOW;
  if (elapsedMs >= periodMs) return MIN_GLOW;
  const attackMs = Math.min(ATTACK_MAX_MS, periodMs * ATTACK_FRACTION);
  if (elapsedMs <= attackMs) {
    return attackMs > 0 ? MIN_GLOW + (1 - MIN_GLOW) * (elapsedMs / attackMs) : 1;
  }
  const decayFraction = (elapsedMs - attackMs) / (periodMs - attackMs);
  return 1 - (1 - MIN_GLOW) * decayFraction;
}

// The wire-line glow for whichever entity is acting as an event source right
// now (a wire's own sourceEntityId) — 0 if it's never fired at all (a freshly
// wired connection with nothing to sync to yet — ui/render.ts falls back to
// its usual flat opacity for that case), otherwise cycling between MIN_GLOW
// and 1 in time with its own actual firing rate.
export function sourcePulseGlow(entityId: string, now: number, port?: number): number {
  const key = pulseKey(entityId, port);
  const at = lastPulseAt.get(key);
  if (at === undefined) return 0;
  const period = lastPulseInterval.get(key) ?? DEFAULT_PULSE_INTERVAL_MS;
  return pulseEnvelope(now - at, period);
}
