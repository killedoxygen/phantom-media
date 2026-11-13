"use client";

import { useEffect, useMemo, type RefObject } from "react";

/**
 * Voice boost and mono through Web Audio, for any media element.
 *
 * Routing an element through Web Audio is permanent, and a suspended context would leave it silent. The graph is
 * therefore only built once the context is running, after a user gesture; until then the element plays as usual.
 *
 * The caller decides `supported`. Media fetched cross-origin without CORS reaches Web Audio as silence, and
 * phones that suspend audio contexts with the screen locked would stop background listening, so a player only
 * enables this for media it knows is readable (Media Source playback or same-origin files) on such platforms.
 */
interface Graph {
  input: GainNode;
  chain: AudioNode;
  output: AudioNode;
  routed: "direct" | "boost" | null;
}

let sharedContext: AudioContext | null = null;
const graphs = new WeakMap<HTMLMediaElement, Graph>();

function audioContext() {
  if (sharedContext) return sharedContext;
  if (typeof AudioContext === "undefined") return null;
  try { sharedContext = new AudioContext({ latencyHint: "playback" }); } catch { return null; }
  return sharedContext;
}

function buildGraph(context: AudioContext, media: HTMLMediaElement): Graph | null {
  let source: MediaElementAudioSourceNode;
  try { source = context.createMediaElementSource(media); } catch { return null; }
  const input = context.createGain();
  source.connect(input);

  // Speech lives above the rumble and is clearest around 3 kHz.
  const highpass = new BiquadFilterNode(context, { type: "highpass", frequency: 80, Q: 0.7 });
  const presence = new BiquadFilterNode(context, { type: "peaking", frequency: 3_000, Q: 0.9, gain: 3 });
  // Bring quiet talkers up and loud moments down, then make up the level.
  const leveler = new DynamicsCompressorNode(context, { threshold: -30, knee: 12, ratio: 4, attack: 0.008, release: 0.3 });
  const makeup = new GainNode(context, { gain: 2.2 });
  // A ceiling, so the makeup gain never clips.
  const limiter = new DynamicsCompressorNode(context, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
  highpass.connect(presence).connect(leveler).connect(makeup).connect(limiter).connect(context.destination);
  return { input, chain: highpass, output: context.destination, routed: null };
}

function apply(graph: Graph, voiceBoost: boolean, mono: boolean) {
  const { input } = graph;
  // An explicit single channel makes Web Audio fold left and right together; the destination spreads it back.
  input.channelCount = mono ? 1 : 2;
  input.channelCountMode = mono ? "explicit" : "max";
  input.channelInterpretation = "speakers";
  const route = voiceBoost ? "boost" : "direct";
  if (graph.routed === route) return;
  input.disconnect();
  input.connect(route === "boost" ? graph.chain : graph.output);
  graph.routed = route;
}

export function useAudioEnhancement(
  mediaRef: RefObject<HTMLMediaElement | null>,
  { voiceBoost, mono, supported }: { voiceBoost: boolean; mono: boolean; supported: boolean },
) {
  const available = useMemo(() => supported && typeof window !== "undefined" && typeof AudioContext !== "undefined", [supported]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const existing = graphs.get(media);
    if (!available) {
      // Already routed: keep the sound flowing, untouched.
      if (existing) apply(existing, false, false);
      return;
    }
    if (existing) {
      apply(existing, voiceBoost, mono);
      // A context the system suspended (a call, another app) comes back with the next play.
      const wake = () => { if (sharedContext?.state !== "running") void sharedContext?.resume().catch(() => {}); };
      media.addEventListener("play", wake);
      return () => media.removeEventListener("play", wake);
    }
    if (!voiceBoost && !mono) return;

    const context = audioContext();
    if (!context) return;
    let disposed = false;
    const gestures = ["pointerdown", "keydown", "touchend"] as const;
    let attempt = () => {};
    const connect = () => {
      if (disposed || context.state !== "running" || graphs.has(media)) return;
      const graph = buildGraph(context, media);
      if (!graph) return;
      graphs.set(media, graph);
      apply(graph, voiceBoost, mono);
      stop();
    };
    const stop = () => {
      for (const name of gestures) document.removeEventListener(name, attempt, true);
      media.removeEventListener("play", attempt);
      context.removeEventListener("statechange", connect);
    };
    attempt = () => { void context.resume().then(connect, () => {}); };
    for (const name of gestures) document.addEventListener(name, attempt, true);
    media.addEventListener("play", attempt);
    context.addEventListener("statechange", connect);
    attempt();
    return () => { disposed = true; stop(); };
  }, [available, mediaRef, mono, voiceBoost]);

  return { available };
}
