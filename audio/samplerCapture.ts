// Audio-side of the sampler organelle (ui/sampler.ts): device listing, live
// input monitoring, raw PCM recording via dsp/worklets/capture-processor.js,
// and short audition previews of a trim edit. Independent of
// audio/graph.ts's entity-node bookkeeping — parallel to audio/melodyPlayer.ts
// — since none of this is itself part of the Web Audio *composition* graph;
// it only ever hands a finished AudioBuffer to graph.ts's registerSampleBuffer,
// same as ui/sampleDrop.ts does for a dropped file.

import { getAudioContext } from './context';
import { getMasterChain } from './master';

// Matches ARCHITECTURE.md §5.4's live-input convention: browsers' own voice-
// chat processing (echo cancellation, noise suppression, auto gain) actively
// degrades a musical signal, so all three are explicitly disabled here rather
// than left at their (chat-oriented) defaults.
//
// Deliberately NOT requesting a channelCount at all (an earlier version
// asked for `{ ideal: 1 }`) — that still asks the driver/OS to convert
// BlackHole's native 2-channel stream down to mono before it ever reaches
// us. Real hardware mics handle that conversion routinely; a virtual
// loopback device is a much less-traveled path for it, and got it wrong
// silently: the OS-level input meter (tapping the raw device directly)
// showed real signal while our captured track showed nothing, and the
// mismatch eventually killed the track outright ("capture failure"). Taking
// whatever channel count the device natively provides and letting Web
// Audio's own nodes handle any downmixing (AnalyserNode always analyses a
// mono downmix internally regardless of input channels; the capture
// worklet just reads channel 0) avoids asking the driver to do a conversion
// it may not implement correctly for this kind of device.
function constraintsFor(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

// Before this origin has ever been granted microphone permission,
// enumerateDevices() doesn't just return unlabeled entries for every real
// device — Safari in particular collapses the whole list down to a single
// generic placeholder, which is what an unlabeled first call actually looks
// like (not "all your inputs, just unnamed"). Getting real labels requires
// permission to already be granted — but deliberately NOT via a throwaway
// getUserMedia call opened and immediately closed just for that: opening,
// closing, then immediately reopening the same device (ui/sampler.ts's
// armMonitor, moments later) is exactly the kind of rapid churn that's been
// observed to destabilize a virtual/aggregate CoreAudio device (BlackHole
// included) into "MediaStreamTrack ended due to a capture failure". Instead,
// ui/sampler.ts's ensureDevices arms the REAL monitor first (which is what
// actually requests permission) and calls this afterward, so there's only
// ever one stream opened, not an open-close-reopen pair.
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export interface Monitor {
  stream: MediaStream;
  analyser: AnalyserNode;
  // Exposed so startRecording can tap the SAME node rather than creating a
  // second one from the same stream — see startMonitoring's own comment.
  source: MediaStreamAudioSourceNode;
  // The track's own negotiated sample rate, straight from getSettings() —
  // not always reported (undefined on some browsers/devices), in which case
  // this is null. Surfaced by ui/sampler.ts next to the AudioContext's own
  // rate (audio/context.ts's getAudioContext().sampleRate) specifically so a
  // mismatch between the two — the actual root cause of the "MediaStreamTrack
  // ended due to a capture failure" issue this session hit with BlackHole —
  // is visible immediately instead of only showing up as a downstream
  // capture failure with no obvious cause.
  sampleRate: number | null;
  stop(): void;
}

// Starts live input monitoring for the scope display — deliberately NOT
// connected to master output (the analyser is a dead end): this is a visual
// tap only, so an already-audible input (a real mic in a real room, or a
// BlackHole loopback feeding the user's own ears via a Multi-Output Device —
// see the earlier conversation) never doubles up through this app's own
// output and risks a feedback loop.
//
// `onCaptureEnded`, if given, fires if the OS/browser kills the underlying
// track on its own after this resolves — a real possibility with virtual/
// aggregate CoreAudio devices (BlackHole included), which can drop out with
// "MediaStreamTrack ended due to a capture failure" for reasons outside this
// app's control (a sample-rate renegotiation, the aggregate's clock losing
// sync, ...). Without this, ui/sampler.ts had no way to notice: the scope
// just silently stopped updating, indistinguishable from "nothing's making
// sound right now" rather than "the input actually died".
export async function startMonitoring(deviceId: string | null, onCaptureEnded?: () => void): Promise<Monitor> {
  const ctx = getAudioContext();
  const stream = await navigator.mediaDevices.getUserMedia(constraintsFor(deviceId));
  // ONE source node for the whole monitor's lifetime, shared by the analyser
  // tap here and, while actively recording, the capture worklet's tap
  // (startRecording below) — deliberately not a separate
  // createMediaStreamSource() per consumer. Two independent source nodes
  // reading the same track works per spec, but tearing one of them down
  // (exactly what happens when a recording stops while monitoring keeps
  // going) is a plausible destabilizer for a virtual/aggregate CoreAudio
  // device like BlackHole — sharing one node and disconnecting only the
  // specific edge that's ending (see startRecording's stop()) avoids ever
  // creating or removing a second independent consumer of the same track.
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  if (onCaptureEnded) {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', onCaptureEnded);
    }
  }

  const sampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? null;

  return {
    stream,
    analyser,
    source,
    sampleRate,
    stop() {
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

export interface Recording {
  stop(): Promise<AudioBuffer>;
}

// Records raw samples from an already-monitoring stream via the capture
// worklet (registered in audio/graph.ts's initAudioEngine, alongside the
// synthesis worklets) until stop() is called. The worklet node is connected
// through a zero-gain node to destination — an AudioWorkletNode with no
// downstream connection at all can get throttled/skipped by some engines,
// and this keeps it actually ticking without letting anything audible out.
export function startRecording(monitor: Monitor): Recording {
  const ctx = getAudioContext();
  // Reuses the monitor's own source node (see its comment) rather than
  // creating a second one from the same stream — this is an additional tap
  // alongside the always-on analyser connection, not a replacement for it.
  const source = monitor.source;
  const capture = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  const chunks: Float32Array[] = [];

  capture.port.onmessage = (e) => {
    chunks.push(e.data as Float32Array);
  };
  capture.port.postMessage({ type: 'start' });
  source.connect(capture);

  return {
    stop(): Promise<AudioBuffer> {
      capture.port.postMessage({ type: 'stop' });
      // One render-quantum round trip so the very last in-flight chunk (posted
      // just before the 'stop' message reaches the processor) still lands in
      // `chunks` before this resolves — a plain synchronous return risked
      // clipping the tail end of every recording by up to ~128 samples.
      return new Promise((resolve) => {
        setTimeout(() => {
          // Disconnects only the edge TO capture, not source's other
          // connections — source is the monitor's shared node (see
          // startMonitoring), still feeding the live analyser after
          // recording stops, so a blanket disconnect() here would silently
          // kill monitoring too.
          source.disconnect(capture);
          capture.port.onmessage = null;
          capture.disconnect();

          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const buffer = ctx.createBuffer(1, Math.max(1, totalLength), ctx.sampleRate);
          const data = buffer.getChannelData(0);
          let offset = 0;
          for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
          }
          resolve(buffer);
        }, 50);
      });
    },
  };
}

// A committed trim: copies [startSec, endSec) into a fresh AudioBuffer for
// audio/graph.ts's registerSampleBuffer, so the owner's normal pad-trigger
// plays exactly the current trim, starting from its own sample 0 — the
// 'sample' case has no notion of an offset into a longer buffer.
export function sliceBuffer(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const ctx = getAudioContext();
  const start = Math.max(0, Math.min(buffer.duration, startSec));
  const end = Math.max(start, Math.min(buffer.duration, endSec));
  const startSample = Math.floor(start * buffer.sampleRate);
  const endSample = Math.ceil(end * buffer.sampleRate);
  const length = Math.max(1, endSample - startSample);

  const sliced = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel).subarray(startSample, startSample + length);
    // A subarray is a view over the same ArrayBufferLike as its parent,
    // which TS 5.7+'s typed-array generics no longer accept where a plain
    // Float32Array<ArrayBuffer> is expected (copyToChannel's own signature) —
    // copying into a fresh Float32Array satisfies that and is cheap at this
    // size regardless.
    sliced.copyToChannel(new Float32Array(source), channel);
  }
  return sliced;
}

let auditionVoice: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

// A short preview of a just-adjusted trim edge, played directly against the
// raw (untrimmed) buffer with an offset/duration rather than needing a
// sliced copy first: 1s from the new start then a 1s fade-out (edge ===
// 'start'), or a 1s fade-in leading into the new end then stop (edge ===
// 'end') — see ui/sampler.ts's marker-adjustment handling for why exactly
// these two shapes: whichever marker just moved is the one whose new
// position this plays around, so the user hears exactly where it landed.
export function auditionClip(buffer: AudioBuffer, trimStart: number, trimEnd: number, edge: 'start' | 'end'): void {
  auditionVoice?.source.stop();
  auditionVoice = null;

  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const clipDuration = Math.max(0, trimEnd - trimStart);
  if (clipDuration <= 0) return;

  const previewDuration = Math.min(2, clipDuration);
  const offset = edge === 'start' ? trimStart : trimEnd - previewDuration;
  const fadeDuration = Math.min(1, previewDuration);

  const gain = ctx.createGain();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(getMasterChain());

  if (edge === 'start') {
    // Play at full volume for the fade duration, then ramp to silence over
    // whatever's left of the 2s preview window (equal to fadeDuration again
    // when the clip is at least 2s long, shorter otherwise).
    const fadeOutDuration = previewDuration - fadeDuration;
    gain.gain.setValueAtTime(1, now);
    if (fadeOutDuration > 0) {
      gain.gain.setValueAtTime(1, now + fadeDuration);
      gain.gain.linearRampToValueAtTime(0, now + previewDuration);
    }
  } else {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fadeDuration);
  }

  source.start(now, offset, previewDuration);
  auditionVoice = { source, gain };
  source.addEventListener('ended', () => {
    if (auditionVoice?.source === source) auditionVoice = null;
  });
}
