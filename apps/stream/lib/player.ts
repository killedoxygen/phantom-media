"use client";

import Hls, {
  FetchLoader,
  type ErrorData,
  type Events,
  type FragmentLoaderConstructor,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from "hls.js";
import type {
  ErrorEvent as DashErrorEvent,
  MediaInfo,
  PeriodSwitchEvent,
  QualityChangeRenderedEvent,
  TrackChangeRenderedEvent,
} from "dashjs";
import {
  planHlsListening,
  planLowestRung,
  type ListeningPlan,
} from "@phantom/ui/listening";
import { asSettled } from "./concurrent";
import { debug, span } from "./debug";
import { languageName, normalizeLanguage } from "./subtitles";
import type { StreamCandidate } from "./types";
import {
  UNVERIFIED_AUDIO_LANGUAGE,
  candidateAudioLanguages,
  listeningAudioFits,
  normalizeAudioLanguage,
} from "../src/media-language.mjs";
import { manifestVideoHeight } from "../src/media-quality.mjs";
import {
  HLS_FRAGMENT_LOAD_POLICY,
  HLS_STALL_RECOVERY_DELAY_MS,
  HLS_STALL_RECOVERY_LIMIT,
  hlsStallRecoveryAction,
} from "../src/hls-recovery.mjs";
import { preferEnglishAudioInTs } from "../src/embedded-audio.mjs";

class EnglishAudioFragmentLoader extends FetchLoader {
  override load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    // Wait for a complete TS fragment so the PMT can be edited before hls.js
    // demuxes any bytes. The underlying fetch still goes straight to the CDN.
    super.load(context, config, {
      ...callbacks,
      onProgress: undefined,
      onSuccess: (response, stats, loadedContext, networkDetails) => {
        if (response.data instanceof ArrayBuffer) {
          const audio = preferEnglishAudioInTs(response.data);
          if (audio.found && !audio.english) {
            callbacks.onError(
              { code: 422, text: "English audio is unavailable" },
              loadedContext,
              networkDetails,
              stats,
            );
            return;
          }
        }
        callbacks.onSuccess(response, stats, loadedContext, networkDetails);
      },
    });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

export interface QualityLevel {
  index: number;
  label: string;
  height: number;
  bitrate: number;
}

export interface QualityState {
  selected: number;
  effective: number;
}

export interface PlayerAudioTrack {
  index: number;
  id: string;
  label: string;
  language: string;
  channels?: string;
  default: boolean;
}

export interface AudioState {
  tracks: readonly PlayerAudioTrack[];
  selected: number;
}

export interface PlayerController {
  destroy(): void;
  levels: QualityLevel[];
  quality(): QualityState;
  setLevel(index: number): void;
  subscribeQuality(listener: (state: QualityState) => void): () => void;
  audio(): AudioState;
  setAudioTrack(index: number): void;
  subscribeAudio(listener: (state: AudioState) => void): () => void;
  /** What listening does for this source right now, or null while watching. */
  listening(): ListeningPlan | null;
  /**
   * Start or stop listening in place. Answers "reattach" when the source has to be attached again for it, because
   * an audio-only stream replaces the picture's stream (or the reverse).
   */
  setListening(request: ListeningRequest | null): Promise<ListeningSwitch>;
}

/** Listening as asked for at attach time or later. */
export interface ListeningRequest {
  /** The audio language the viewer chose; an audio rendition is only played on its own when it matches. */
  language: string;
}

export type ListeningSwitch = "applied" | "reattach";

type AudioListeningPlan = Extract<ListeningPlan, { kind: "audio" }>;
const UNTHINNED: ListeningPlan = { kind: "unavailable" };
const LISTENING_PLAN_TTL_MS = 60_000;
const LISTENING_PLAN_TIMEOUT_MS = 4_000;
const listeningPlans = new Map<
  string,
  { at: number; plan: Promise<AudioListeningPlan | null> }
>();

/**
 * The audio-only stream an HLS master offers in the requested language, or null when it offers none.
 * Remembered briefly, since switching to it re-attaches the source and asks again.
 */
function audioOnlyPlan(
  url: string,
  request: ListeningRequest,
  timeoutMs: number,
): Promise<AudioListeningPlan | null> {
  const key = `${url}\n${request.language}`;
  const cached = listeningPlans.get(key);
  if (cached && Date.now() - cached.at < LISTENING_PLAN_TTL_MS) return cached.plan;
  const plan = (async () => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const found = planHlsListening(await response.text(), response.url || url, {
        language:
          request.language === UNVERIFIED_AUDIO_LANGUAGE ? undefined : request.language,
      });
      return found.kind === "audio" && listeningAudioFits(found, request.language)
        ? found
        : null;
    } catch (error) {
      // A failed read is not an answer: ask again next time.
      listeningPlans.delete(key);
      debug("attach", "listening.plan-failed", {
        host: hostOf(url),
        message: (error as Error)?.message,
      });
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  })();
  listeningPlans.set(key, { at: Date.now(), plan });
  if (listeningPlans.size > 32) {
    listeningPlans.delete(listeningPlans.keys().next().value!);
  }
  return plan;
}

function forgetAudioOnlyPlan(url: string, request: ListeningRequest) {
  listeningPlans.set(`${url}\n${request.language}`, {
    at: Date.now(),
    plan: Promise.resolve(null),
  });
}

/**
 * iPhone and iPad Safari stop feeding Media Source buffers once the page is in the background, which ends a
 * listening session at the lock screen. Their own HLS playback keeps going, so listening uses it there.
 */
function prefersNativeListening(video: HTMLVideoElement): boolean {
  return (
    typeof window !== "undefined" &&
    "ManagedMediaSource" in window &&
    navigator.maxTouchPoints > 1 &&
    video.canPlayType("application/vnd.apple.mpegurl") !== ""
  );
}

export interface PlaybackSnapshot {
  currentTime: number;
  paused: boolean;
  selectedLevel: number;
  selectedAudio: number;
  selectedSubtitle?: number | null;
}

export {
  applyPlaybackSnapshot,
  capturePlaybackSnapshot,
} from "../src/playback-handoff.mjs";

export interface CandidateProbe {
  candidate: StreamCandidate;
  ok: boolean | null;
  latencyMs: number;
  tier: number;
  audioLanguages: readonly string[];
  languageMatch: boolean;
}

export interface CandidateProbeResult {
  ranked: StreamCandidate[];
  verified: StreamCandidate[];
  unverified: StreamCandidate[];
  failed: StreamCandidate[];
  outcomes: CandidateProbe[];
  languageRejected: StreamCandidate[];
  verifiedTier: number;
  unverifiedTier: number;
  probeMs: number | null;
}

const NO_LEVELS: PlayerController["levels"] = [];
const NO_AUDIO: AudioState = { tracks: [], selected: -1 };

const MAX_PROBE_CANDIDATES = 6;
const PROBE_CONCURRENCY = MAX_PROBE_CANDIDATES;

const MANIFEST_PROBE_BYTES = 256 * 1024;

export function qualityTier(candidate: StreamCandidate): number {
  const resolution = candidate.resolution ?? 0;
  if (resolution >= 1080) return 4;
  if (
    resolution === 0 &&
    (candidate.type === "hls" || candidate.type === "dash")
  ) {
    return 3;
  }
  if (resolution >= 720) return 2;
  if (resolution > 0) return 1;
  return 0;
}

function audioTrack(
  index: number,
  id: string | number | null | undefined,
  label: string | null | undefined,
  language: string | null | undefined,
  channels: string | null | undefined,
  isDefault: boolean,
): PlayerAudioTrack {
  const normalized = normalizeLanguage(language ?? undefined);
  const named = label?.trim();
  return {
    index,
    id: String(id ?? index),
    label: named || languageName(normalized),
    language: normalized,
    channels: channels || undefined,
    default: isDefault,
  };
}

interface NativeAudioTrack {
  enabled: boolean;
  id?: string;
  kind?: string;
  label?: string;
  language?: string;
}

interface NativeAudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: NativeAudioTrack;
}

function nativeAudioTracks(video: HTMLVideoElement): NativeAudioTrackList | null {
  return (
    (
      video as HTMLVideoElement & {
        audioTracks?: NativeAudioTrackList;
      }
    ).audioTracks ?? null
  );
}

interface NativeListening {
  /** The HLS master behind this source, when the browser plays HLS itself and could switch to its audio. */
  master: string | null;
  /** What was attached: an audio-only stream, the full source while listening, or null while watching. */
  plan: ListeningPlan | null;
}

function nativeController(
  video: HTMLVideoElement,
  destroy: () => void,
  initialListening: NativeListening = { master: null, plan: null },
): PlayerController {
  const nativeTracks = nativeAudioTracks(video);
  let listening = initialListening.plan;
  const listeners = new Set<(state: AudioState) => void>();
  const audio = (): AudioState => {
    if (!nativeTracks) return NO_AUDIO;
    const tracks = Array.from({ length: nativeTracks.length }, (_, index) => {
      const track = nativeTracks[index]!;
      return audioTrack(
        index,
        track.id,
        track.label,
        track.language,
        undefined,
        track.kind === "main",
      );
    });
    const selected = tracks.findIndex((track) => nativeTracks[track.index]?.enabled);
    return { tracks, selected };
  };
  const publishAudio = () => {
    const state = audio();
    for (const listener of listeners) listener(state);
  };

  nativeTracks?.addEventListener("addtrack", publishAudio);
  nativeTracks?.addEventListener("removetrack", publishAudio);
  nativeTracks?.addEventListener("change", publishAudio);

  return {
    destroy: () => {
      nativeTracks?.removeEventListener("addtrack", publishAudio);
      nativeTracks?.removeEventListener("removetrack", publishAudio);
      nativeTracks?.removeEventListener("change", publishAudio);
      listeners.clear();
      destroy();
    },
    levels: NO_LEVELS,
    quality: () => ({ selected: -1, effective: -1 }),
    setLevel: () => {},
    subscribeQuality: () => () => {},
    audio,
    setAudioTrack: (index) => {
      if (!nativeTracks || index < 0 || index >= nativeTracks.length) return;
      for (let position = 0; position < nativeTracks.length; position += 1) {
        nativeTracks[position]!.enabled = position === index;
      }
      publishAudio();
    },
    subscribeAudio: (listener) => {
      listeners.add(listener);
      listener(audio());
      return () => {
        listeners.delete(listener);
      };
    },
    listening: () => listening,
    setListening: async (request) => {
      if (listening?.kind === "audio") return request ? "applied" : "reattach";
      if (!request) {
        listening = null;
        return "applied";
      }
      const { master } = initialListening;
      if (master && (await audioOnlyPlan(master, request, LISTENING_PLAN_TIMEOUT_MS))) {
        return "reattach";
      }
      // A whole file cannot drop its picture: hide it and keep playing.
      listening = UNTHINNED;
      return "applied";
    },
  };
}

async function readManifestSample(response: Response): Promise<string> {
  if (!response.body) {
    return (await response.text()).slice(0, MANIFEST_PROBE_BYTES);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sample = "";
  let size = 0;
  try {
    while (size < MANIFEST_PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      sample += decoder.decode(
        size > MANIFEST_PROBE_BYTES
          ? value.subarray(0, value.byteLength - (size - MANIFEST_PROBE_BYTES))
          : value,
        { stream: true },
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return sample;
}

async function probeEmbeddedEnglish(
  manifest: string,
  playlistUrl: string,
  signal: AbortSignal,
): Promise<boolean | null> {
  if (!manifest.includes("#EXTINF:")) return null;
  const segment = manifest.split(/\r?\n/).find((line) =>
    line.trim() && !line.trimStart().startsWith("#"));
  if (!segment) return null;
  const url = new URL(segment.trim(), playlistUrl);
  const response = await fetch(url, {
    credentials: "omit",
    mode: "cors",
    headers: { range: "bytes=0-6015" },
    signal,
  });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error("The audio sample was not available to the browser");
  }
  if (Number(response.headers.get("content-length")) > 6_016) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const sample = new Uint8Array(6_016);
  let bytes = 0;
  try {
    while (bytes < sample.length) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > sample.length - bytes) return null;
      sample.set(value, bytes);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const audio = preferEnglishAudioInTs(sample.buffer.slice(0, bytes));
  return audio.found ? audio.english : null;
}

async function probeOne(
  candidate: StreamCandidate,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  preferredAudioLanguage: string | undefined,
): Promise<CandidateProbe> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, timeoutMs);
  const startedAt = performance.now();

  try {
    // A Range header triggers a CORS preflight that many media hosts reject.
    const response = await fetch(candidate.url, {
      cache: "default",
      credentials: "omit",
      mode: "cors",
      signal: controller.signal,
    });
    const sample = response.ok ? await readManifestSample(response) : "";
    const manifestOk =
      response.ok &&
      (candidate.type === "hls"
        ? sample.trimStart().startsWith("#EXTM3U")
        : /<MPD(?:\s|>)/i.test(sample));
    let audioLanguages = candidateAudioLanguages(candidate, sample);
    if (manifestOk && candidate.embeddedAudioLanguage === "en") {
      const english = await probeEmbeddedEnglish(sample, candidate.url, controller.signal);
      if (english !== null) audioLanguages = english ? ["en"] : ["hi"];
    }
    const preferred = normalizeAudioLanguage(preferredAudioLanguage);
    const languageMatch =
      preferred === UNVERIFIED_AUDIO_LANGUAGE
        ? audioLanguages.length === 0
        : audioLanguages.includes(preferred);
    const ok = manifestOk;
    const manifestHeight = manifestVideoHeight(candidate.type, sample);
    const tier =
      manifestHeight > 0
        ? qualityTier({ ...candidate, resolution: manifestHeight })
        : manifestOk && !(candidate.resolution && candidate.resolution > 0)
          ? 2
          : qualityTier(candidate);
    debug("probe", ok ? "ok" : "rejected", {
      host: hostOf(candidate.url),
      status: response.status,
      ms: performance.now() - startedAt,
      tier,
      manifestHeight,
      audioLanguages,
      preferredAudioLanguage: preferred,
      languageMatch,
    });
    return {
      candidate,
      ok,
      latencyMs: performance.now() - startedAt,
      tier,
      audioLanguages,
      languageMatch,
    };
  } catch (error) {
    debug("probe", "failed", {
      host: hostOf(candidate.url),
      ms: performance.now() - startedAt,
      timedOut: !signal?.aborted,
      message: (error as Error)?.message,
    });
    return {
      candidate,
      ok: false,
      latencyMs: performance.now() - startedAt,
      tier: qualityTier(candidate),
      audioLanguages: candidateAudioLanguages(candidate),
      languageMatch:
        normalizeAudioLanguage(preferredAudioLanguage) ===
        UNVERIFIED_AUDIO_LANGUAGE
          ? candidateAudioLanguages(candidate).length === 0
          : candidateAudioLanguages(candidate).includes(
              normalizeAudioLanguage(preferredAudioLanguage),
            ),
    };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function probeCandidates(
  candidates: StreamCandidate[],
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    preferredAudioLanguage?: string;
  } = {},
): Promise<CandidateProbeResult> {
  const timeoutMs = options.timeoutMs ?? 2_500;
  const order = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const position = (candidate: StreamCandidate) => order.get(candidate.id) ?? 0;
  const byTier = (left: StreamCandidate, right: StreamCandidate) =>
    qualityTier(right) - qualityTier(left) || position(left) - position(right);

  const probeable = candidates
    .filter(
      (candidate) =>
        candidate.type === "hls" || candidate.type === "dash",
    )
    .sort(byTier)
    .slice(0, MAX_PROBE_CANDIDATES);
  const probeableIds = new Set(probeable.map((candidate) => candidate.id));

  const probed: CandidateProbe[] = [];
  for await (const settled of asSettled(probeable, PROBE_CONCURRENCY, (candidate) =>
    probeOne(
      candidate,
      timeoutMs,
      options.signal,
      options.preferredAudioLanguage,
    ),
  )) {
    if (settled.value) probed.push(settled.value);
  }

  if (options.signal?.aborted) {
    throw new DOMException("Source probing was aborted", "AbortError");
  }

  const unprobed: CandidateProbe[] = candidates
    .filter((candidate) => !probeableIds.has(candidate.id))
    .map((candidate) => {
      const audioLanguages = candidateAudioLanguages(candidate);
      const preferred = normalizeAudioLanguage(options.preferredAudioLanguage);
      return {
        candidate,
        ok: null,
        latencyMs: Number.POSITIVE_INFINITY,
        tier: qualityTier(candidate),
        audioLanguages,
        languageMatch:
          preferred === UNVERIFIED_AUDIO_LANGUAGE
            ? audioLanguages.length === 0
            : audioLanguages.includes(preferred),
      };
    });

  const verifiedOutcomes = probed
    .filter((outcome) => outcome.ok === true && outcome.languageMatch)
    .sort(
      (left, right) =>
        right.tier - left.tier ||
        left.latencyMs - right.latencyMs ||
        position(left.candidate) - position(right.candidate),
    );
  const unverifiedOutcomes = [...probed, ...unprobed]
    .filter(
      (outcome) =>
        outcome.audioLanguages.length === 0 && outcome.ok !== false,
    )
    .sort(
      (left, right) =>
        right.tier - left.tier ||
        left.latencyMs - right.latencyMs ||
        position(left.candidate) - position(right.candidate),
    );
  const untested = unprobed.filter((outcome) => outcome.languageMatch).sort(
    (left, right) =>
      right.tier - left.tier ||
      position(left.candidate) - position(right.candidate),
  );
  const failedOutcomes = probed.filter(
    (outcome) => outcome.ok === false && outcome.languageMatch,
  );
  const languageRejected = [...probed, ...unprobed].filter(
    (outcome) =>
      !outcome.languageMatch && outcome.audioLanguages.length > 0,
  );

  return {
    ranked: [
      ...verifiedOutcomes,
      ...untested,
      ...unverifiedOutcomes.filter(
        (outcome) =>
          !verifiedOutcomes.includes(outcome) && !untested.includes(outcome),
      ),
      ...failedOutcomes,
    ].map((outcome) => outcome.candidate),
    verified: verifiedOutcomes.map((outcome) => outcome.candidate),
    unverified: unverifiedOutcomes.map((outcome) => outcome.candidate),
    failed: failedOutcomes.map((outcome) => outcome.candidate),
    outcomes: [
      ...verifiedOutcomes,
      ...untested,
      ...unverifiedOutcomes.filter(
        (outcome) =>
          !verifiedOutcomes.includes(outcome) && !untested.includes(outcome),
      ),
      ...failedOutcomes,
      ...languageRejected,
    ],
    languageRejected: languageRejected.map((outcome) => outcome.candidate),
    verifiedTier: verifiedOutcomes[0]?.tier ?? 0,
    unverifiedTier: unverifiedOutcomes[0]?.tier ?? 0,
    probeMs:
      verifiedOutcomes[0]?.latencyMs ??
      unverifiedOutcomes[0]?.latencyMs ??
      null,
  };
}

function waitForNativeMedia(
  video: HTMLVideoElement,
  timeoutMs: number,
  onFatal: (error: Error) => void,
  listening?: NativeListening,
): Promise<PlayerController> {
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The source did not respond in time"));
    }, timeoutMs);

    const onReady = () => {
      ready = true;
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onReady);
      resolve(
        nativeController(video, () => {
          cleanup();
          video.removeAttribute("src");
          video.load();
        }, listening),
      );
    };
    const onError = () => {
      const error = new Error(
        video.error?.message || "The browser rejected this media source",
      );
      if (ready) onFatal(error);
      else {
        cleanup();
        reject(error);
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("error", onError);
  });
}

function levelLabel(height: number, bitrate: number): string {
  if (height > 0) return `${height}p`;
  if (bitrate > 0) return `${Math.round(bitrate / 1_000)} kbps`;
  return "Stream";
}

function isBufferedAt(video: HTMLVideoElement, position: number): boolean {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (
      video.buffered.start(index) <= position &&
      position < video.buffered.end(index)
    ) {
      return true;
    }
  }
  return false;
}

function bufferAheadAt(video: HTMLVideoElement, position: number): number {
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start <= position && position < end) return end - position;
  }
  return 0;
}

async function attachHls(
  video: HTMLVideoElement,
  url: string,
  timeoutMs: number,
  onFatal: (error: Error) => void,
  embeddedAudioLanguage?: "en",
  listeningRequest: ListeningRequest | null = null,
): Promise<PlayerController> {
  const audioPlan = listeningRequest
    ? await audioOnlyPlan(url, listeningRequest, Math.min(timeoutMs, LISTENING_PLAN_TIMEOUT_MS))
    : null;
  let hls: Hls;
  let audioSource = false;
  if (audioPlan && listeningRequest) {
    try {
      hls = await startHls(video, audioPlan.url, timeoutMs, embeddedAudioLanguage);
      audioSource = true;
    } catch (error) {
      // The audio-only stream is not worth losing the title over: play the full source, at its cheapest.
      debug("attach", "listening.audio-failed", {
        host: hostOf(audioPlan.url),
        message: (error as Error)?.message,
      });
      forgetAudioOnlyPlan(url, listeningRequest);
      hls = await startHls(video, url, timeoutMs, embeddedAudioLanguage);
    }
  } else {
    hls = await startHls(video, url, timeoutMs, embeddedAudioLanguage);
  }
  return hlsController(video, hls, audioSource ? audioPlan!.url : url, {
    onFatal,
    master: url,
    listening: listeningRequest ? (audioSource ? audioPlan : "cap") : null,
  });
}

async function startHls(
  video: HTMLVideoElement,
  url: string,
  timeoutMs: number,
  embeddedAudioLanguage?: "en",
): Promise<Hls> {
  const hls = new Hls({
    ...(embeddedAudioLanguage === "en"
      ? { fLoader: EnglishAudioFragmentLoader as unknown as FragmentLoaderConstructor }
      : {}),
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 60,
    maxBufferLength: 40,
    maxMaxBufferLength: 120,
    fragLoadPolicy: {
      default: {
        ...HLS_FRAGMENT_LOAD_POLICY,
        timeoutRetry: { ...HLS_FRAGMENT_LOAD_POLICY.timeoutRetry },
        errorRetry: { ...HLS_FRAGMENT_LOAD_POLICY.errorRetry },
      },
    },
    abrEwmaDefaultEstimate: 3_000_000,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The manifest did not respond in time"));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      hls.off(Hls.Events.MANIFEST_PARSED, onReady);
      hls.off(Hls.Events.ERROR, onStartupError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onStartupError = (_event: Events.ERROR, data: ErrorData) => {
      if (!data.fatal) return;
      cleanup();
      reject(new Error(data.details || "The stream failed to start"));
    };

    hls.on(Hls.Events.MANIFEST_PARSED, onReady);
    hls.on(Hls.Events.ERROR, onStartupError);
    hls.loadSource(url);
    hls.attachMedia(video);
  }).catch((error) => {
    hls.destroy();
    throw error;
  });
  return hls;
}

function hlsController(
  video: HTMLVideoElement,
  hls: Hls,
  url: string,
  {
    onFatal,
    master,
    listening: initialListening,
  }: {
    onFatal: (error: Error) => void;
    /** The source's own master, for switching to its audio-only stream. */
    master: string;
    /** An audio-only stream now playing, "cap" for the cheapest picture, or null while watching. */
    listening: AudioListeningPlan | "cap" | null;
  },
): PlayerController {
  const audioSource = initialListening !== null && initialListening !== "cap";
  // An audio-only stream has no pictures to choose between.
  const levels: QualityLevel[] = audioSource
    ? []
    : hls.levels.map((level, index) => ({
        index,
        label: levelLabel(level.height ?? 0, level.bitrate ?? 0),
        height: level.height ?? 0,
        bitrate: level.bitrate ?? 0,
      }));

  // The viewer's quality choice, held while listening caps the picture and restored after.
  let chosenLevel = -1;
  let capped = false;
  let listening: ListeningPlan | null = audioSource ? initialListening : null;
  const cap = (on: boolean) => {
    if (on === capped || hls.levels.length < 2) return;
    capped = on;
    if (on) {
      chosenLevel = hls.manualLevel;
      const lowest = hls.levels.reduce(
        (low, level, index) =>
          (level.bitrate ?? Infinity) < (hls.levels[low]!.bitrate ?? Infinity) ? index : low,
        0,
      );
      // Switch at the next segment rather than flushing what is already buffered.
      hls.loadLevel = -1;
      hls.autoLevelCapping = lowest;
      hls.nextLoadLevel = lowest;
    } else {
      hls.autoLevelCapping = -1;
      if (chosenLevel >= 0) hls.loadLevel = chosenLevel;
    }
    publish();
  };

  const listeners = new Set<(state: QualityState) => void>();
  const audioListeners = new Set<(state: AudioState) => void>();
  const quality = (): QualityState => {
    if (audioSource) return { selected: chosenLevel, effective: -1 };
    if (capped) return { selected: chosenLevel, effective: hls.currentLevel };
    return {
      selected: hls.autoLevelEnabled ? -1 : hls.currentLevel,
      effective: hls.currentLevel,
    };
  };
  const audio = (): AudioState => ({
    tracks: hls.audioTracks.map((track, index) =>
      audioTrack(
        index,
        `${track.groupId}:${track.id}`,
        track.name,
        track.lang,
        track.channels,
        track.default,
      ),
    ),
    selected: hls.audioTrack,
  });
  const publish = () => {
    const state = quality();
    for (const listener of listeners) listener(state);
  };
  const publishAudio = () => {
    const state = audio();
    for (const listener of audioListeners) listener(state);
  };
  let destroyed = false;
  let stallRecoveryTimer: number | null = null;
  let stallRecoveryAttempts = 0;
  const clearStallRecovery = (resetAttempts = false) => {
    if (stallRecoveryTimer !== null) {
      window.clearTimeout(stallRecoveryTimer);
      stallRecoveryTimer = null;
    }
    if (resetAttempts) stallRecoveryAttempts = 0;
  };
  const scheduleStallRecovery = () => {
    if (
      destroyed ||
      stallRecoveryTimer !== null ||
      stallRecoveryAttempts >= HLS_STALL_RECOVERY_LIMIT
    ) {
      return;
    }
    const stalledAt = video.currentTime;
    stallRecoveryTimer = window.setTimeout(() => {
      stallRecoveryTimer = null;
      if (destroyed || Math.abs(video.currentTime - stalledAt) >= 0.25) {
        stallRecoveryAttempts = 0;
        return;
      }
      const bufferAheadSeconds = bufferAheadAt(video, video.currentTime);
      const action = hlsStallRecoveryAction({
        paused: video.paused,
        seeking: video.seeking,
        ended: video.ended,
        playbackRate: video.playbackRate,
        currentTime: video.currentTime,
        readyState: video.readyState,
        bufferAheadSeconds,
      });
      if (action === "none") return;

      stallRecoveryAttempts += 1;
      debug("attach", `hls.stall-${action}`, {
        host: hostOf(url),
        position: video.currentTime,
        bufferAheadSeconds,
        attempt: stallRecoveryAttempts,
      });
      if (action === "nudge") {
        video.currentTime = Math.min(
          video.currentTime + 0.05,
          Number.isFinite(video.duration)
            ? Math.max(0, video.duration - 0.05)
            : video.currentTime + 0.05,
        );
      } else {
        if (hls.autoLevelEnabled) hls.nextLoadLevel = hls.minAutoLevel;
        hls.startLoad(video.currentTime, true);
      }
      scheduleStallRecovery();
    }, HLS_STALL_RECOVERY_DELAY_MS);
  };
  const onWaiting = () => scheduleStallRecovery();
  const onPlaying = () => clearStallRecovery(true);
  const onSeeking = () => {
    const position = video.currentTime;
    if (!Number.isFinite(position) || isBufferedAt(video, position)) return;

    // A long scrub can leave the previous fragment request in flight. Restart
    // loading at the new position and, in auto mode, fetch one low-bandwidth
    // segment first so playback resumes before ABR climbs again.
    if (hls.autoLevelEnabled) {
      hls.nextLoadLevel = hls.minAutoLevel;
    }
    debug("attach", "hls.seek", {
      host: hostOf(url),
      position,
      recoveryLevel: hls.nextLoadLevel,
    });
    hls.startLoad(position, true);
  };

  let recoveredNetwork = false;
  let recoveredMedia = false;
  const onError = (_event: Events.ERROR, data: ErrorData) => {
    debug("attach", data.fatal ? "hls.fatal" : "hls.error", {
      type: data.type,
      details: data.details,
      host: hostOf(url),
    });
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recoveredNetwork) {
      recoveredNetwork = true;
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
      recoveredMedia = true;
      hls.recoverMediaError();
      return;
    }
    onFatal(new Error(data.details || "The stream stopped"));
  };

  if (initialListening === "cap") {
    cap(true);
    listening = capped
      ? planLowestRung(url, hls.levels.map((level) => level.bitrate ?? 0))
      : UNTHINNED;
  }

  hls.on(Hls.Events.ERROR, onError);
  hls.on(Hls.Events.LEVEL_SWITCHED, publish);
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, publishAudio);
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, publishAudio);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("waiting", onWaiting);
  video.addEventListener("stalled", onWaiting);
  video.addEventListener("playing", onPlaying);

  return {
    destroy: () => {
      destroyed = true;
      clearStallRecovery();
      listeners.clear();
      audioListeners.clear();
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onWaiting);
      video.removeEventListener("playing", onPlaying);
      hls.destroy();
    },
    levels,
    quality,
    setLevel: (index: number) => {
      if (audioSource || capped) {
        // Kept for when the picture comes back.
        chosenLevel =
          index >= 0 && (audioSource || index < hls.levels.length) ? index : -1;
        publish();
        return;
      }
      hls.currentLevel = index;
      if (index >= 0) hls.nextLevel = index;
      publish();
    },
    subscribeQuality: (listener) => {
      listeners.add(listener);
      listener(quality());
      return () => {
        listeners.delete(listener);
      };
    },
    audio,
    setAudioTrack: (index: number) => {
      if (index < 0 || index >= hls.audioTracks.length) return;
      hls.audioTrack = index;
      publishAudio();
    },
    subscribeAudio: (listener) => {
      audioListeners.add(listener);
      listener(audio());
      return () => {
        audioListeners.delete(listener);
      };
    },
    listening: () => listening,
    setListening: async (request) => {
      if (audioSource) return request ? "applied" : "reattach";
      if (!request) {
        cap(false);
        listening = null;
        return "applied";
      }
      if (prefersNativeListening(video)) return "reattach";
      if (await audioOnlyPlan(master, request, LISTENING_PLAN_TIMEOUT_MS)) {
        return destroyed ? "applied" : "reattach";
      }
      if (destroyed) return "applied";
      cap(true);
      listening = capped
        ? planLowestRung(url, hls.levels.map((level) => level.bitrate ?? 0))
        : UNTHINNED;
      return "applied";
    },
  };
}

function dashErrorMessage(event: DashErrorEvent): string {
  const error = event.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message) return message;
  }
  if ("event" in event && event.event && typeof event.event === "object") {
    const detail = event.event;
    if ("message" in detail && typeof detail.message === "string") {
      return detail.message;
    }
  }
  return "The DASH stream failed";
}

function dashAudioLabel(info: MediaInfo, index: number): string {
  const matchingLabel =
    info.labels.find((label) => label.lang === info.lang)?.text ??
    info.labels[0]?.text;
  return matchingLabel || languageName(info.lang ?? undefined) || `Audio ${index + 1}`;
}

async function attachDash(
  video: HTMLVideoElement,
  url: string,
  timeoutMs: number,
  onFatal: (error: Error) => void,
  listeningRequest: ListeningRequest | null = null,
): Promise<PlayerController> {
  if (typeof MediaSource === "undefined") {
    throw new Error("This browser cannot play DASH streams");
  }

  const { MediaPlayer } = await import("dashjs");
  const player = MediaPlayer().create();
  player.updateSettings({
    debug: { logLevel: 0 },
    streaming: {
      buffer: {
        bufferToKeep: 60,
        bufferTimeDefault: 20,
        bufferTimeAtTopQuality: 30,
        bufferTimeAtTopQualityLongForm: 45,
      },
      retryAttempts: {
        MPD: 2,
        MediaSegment: 4,
        InitializationSegment: 3,
        IndexSegment: 3,
      },
      abr: {
        // Listening starts at the cheapest picture instead of climbing down to it.
        initialBitrate: { video: listeningRequest ? 1 : 3_000 },
      },
    },
  });

  let destroyed = false;
  const teardown = () => {
    if (destroyed) return;
    destroyed = true;
    player.destroy();
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The DASH manifest did not respond in time"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      player.off(MediaPlayer.events.STREAM_INITIALIZED, onReady);
      player.off(MediaPlayer.events.ERROR, onStartupError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onStartupError = (event: DashErrorEvent) => {
      cleanup();
      reject(new Error(dashErrorMessage(event)));
    };

    player.on(MediaPlayer.events.STREAM_INITIALIZED, onReady);
    player.on(MediaPlayer.events.ERROR, onStartupError);
    try {
      player.initialize(video, url, false);
    } catch (error) {
      cleanup();
      reject(error);
    }
  }).catch((error) => {
    teardown();
    throw error;
  });

  let selectedLevel = -1;
  let dashAudioInfos: MediaInfo[] = [];
  const qualityListeners = new Set<(state: QualityState) => void>();
  const audioListeners = new Set<(state: AudioState) => void>();

  const representations = player.getRepresentationsByType("video");
  const levels: QualityLevel[] = representations.map((representation, index) => ({
    index,
    label: levelLabel(representation.height ?? 0, representation.bandwidth ?? 0),
    height: representation.height ?? 0,
    bitrate: representation.bandwidth ?? 0,
  }));
  const quality = (): QualityState => {
    const current = player.getCurrentRepresentationForType("video");
    return {
      selected: selectedLevel,
      effective: current
        ? representations.findIndex(
            (representation) => representation.id === current.id,
          )
        : -1,
    };
  };
  const publishQuality = () => {
    const state = quality();
    for (const listener of qualityListeners) listener(state);
  };

  // DASH has no audio-only switch in dash.js, so listening holds the picture at its cheapest representation.
  let listening: ListeningPlan | null = null;
  const applyLevel = (immediate: boolean) => {
    const lowest = representations.reduce(
      (low, representation, index) =>
        (representation.bandwidth ?? Infinity) <
        (representations[low]?.bandwidth ?? Infinity)
          ? index
          : low,
      0,
    );
    const capped = listening?.kind === "reduced";
    const target = capped ? lowest : selectedLevel;
    player.updateSettings({
      streaming: { abr: { autoSwitchBitrate: { video: target === -1 } } },
    });
    if (target >= 0) {
      player.setRepresentationForTypeByIndex("video", target, immediate && !capped);
    }
    publishQuality();
  };
  const listen = (request: ListeningRequest | null) => {
    listening = request
      ? planLowestRung(url, representations.map((representation) => representation.bandwidth ?? 0))
      : null;
    applyLevel(false);
  };

  const refreshAudio = () => {
    dashAudioInfos = player.getTracksFor("audio");
  };
  const audio = (): AudioState => {
    const current = player.getCurrentTrackFor("audio");
    const tracks = dashAudioInfos.map((info, index) =>
      audioTrack(
        index,
        info.id,
        dashAudioLabel(info, index),
        info.lang,
        info.audioChannelConfiguration?.[0]?.value,
        info.roles?.some((role) => role.value === "main") ?? index === 0,
      ),
    );
    const selected = current
      ? dashAudioInfos.findIndex(
          (info) =>
            info === current ||
            (info.id !== null && current.id !== null && info.id === current.id),
        )
      : -1;
    return { tracks, selected };
  };
  const publishAudio = () => {
    refreshAudio();
    const state = audio();
    for (const listener of audioListeners) listener(state);
  };

  const onQualityChanged = (event: QualityChangeRenderedEvent) => {
    if (event.mediaType === "video") publishQuality();
  };
  const onAudioChanged = (event: TrackChangeRenderedEvent) => {
    if (event.mediaType === "audio") publishAudio();
  };
  const onPeriodChanged = (_event: PeriodSwitchEvent) => {
    publishQuality();
    publishAudio();
  };
  let fatalReported = false;
  const onError = (event: DashErrorEvent) => {
    debug("attach", "dash.error", {
      host: hostOf(url),
      message: dashErrorMessage(event),
    });
    if (fatalReported || destroyed) return;
    fatalReported = true;
    onFatal(new Error(dashErrorMessage(event)));
  };

  if (listeningRequest) listen(listeningRequest);
  refreshAudio();
  player.on(MediaPlayer.events.ERROR, onError);
  player.on(MediaPlayer.events.QUALITY_CHANGE_RENDERED, onQualityChanged);
  player.on(MediaPlayer.events.TRACK_CHANGE_RENDERED, onAudioChanged);
  player.on(MediaPlayer.events.PERIOD_SWITCH_COMPLETED, onPeriodChanged);

  return {
    destroy: () => {
      qualityListeners.clear();
      audioListeners.clear();
      teardown();
    },
    levels,
    quality,
    setLevel: (index: number) => {
      selectedLevel =
        index >= 0 && index < representations.length ? index : -1;
      applyLevel(true);
    },
    subscribeQuality: (listener) => {
      qualityListeners.add(listener);
      listener(quality());
      return () => {
        qualityListeners.delete(listener);
      };
    },
    audio,
    setAudioTrack: (index: number) => {
      const track = dashAudioInfos[index];
      if (!track) return;
      player.setCurrentTrack(track);
      publishAudio();
    },
    subscribeAudio: (listener) => {
      audioListeners.add(listener);
      listener(audio());
      return () => {
        audioListeners.delete(listener);
      };
    },
    listening: () => listening,
    setListening: async (request) => {
      if (!destroyed) listen(request);
      return "applied";
    },
  };
}

export async function attachCandidate(
  video: HTMLVideoElement,
  candidate: StreamCandidate,
  options: {
    timeoutMs?: number;
    onFatal: (error: Error) => void;
    /** Attach for listening: the audio-only stream when the source has one, else its cheapest picture. */
    listening?: ListeningRequest | null;
  },
): Promise<PlayerController> {
  const listening = options.listening ?? null;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const done = span("attach", "element", {
    host: hostOf(candidate.url),
    type: candidate.type,
    resolution: candidate.resolution,
    timeoutMs,
  });
  const finish = async (pending: Promise<PlayerController>) => {
    try {
      const controller = await pending;
      done({ ok: true, levels: controller.levels.length });
      return controller;
    } catch (error) {
      done({ ok: false, message: (error as Error)?.message });
      throw error;
    }
  };

  if (candidate.type === "hls") {
    const nativeListening =
      listening !== null &&
      !candidate.embeddedAudioLanguage &&
      prefersNativeListening(video);
    if (Hls.isSupported() && !nativeListening) {
      return finish(attachHls(
        video,
        candidate.url,
        timeoutMs,
        options.onFatal,
        candidate.embeddedAudioLanguage,
        listening,
      ));
    }
    if (candidate.embeddedAudioLanguage) {
      done({ ok: false, message: "embedded audio requires MSE" });
      throw new Error("This browser cannot select the requested audio track");
    }
    if (!video.canPlayType("application/vnd.apple.mpegurl")) {
      done({ ok: false, message: "no HLS support" });
      throw new Error("This browser cannot play HLS streams");
    }
  }

  if (candidate.type === "dash") {
    return finish(attachDash(video, candidate.url, timeoutMs, options.onFatal, listening));
  }

  // Safari's own HLS can still switch to an audio-only stream; a whole file only hides its picture.
  const master = candidate.type === "hls" ? candidate.url : null;
  const audioPlan =
    listening && master
      ? await audioOnlyPlan(master, listening, Math.min(timeoutMs, LISTENING_PLAN_TIMEOUT_MS))
      : null;
  const pending = waitForNativeMedia(video, timeoutMs, options.onFatal, {
    master,
    plan: listening ? (audioPlan ?? UNTHINNED) : null,
  });
  video.src = audioPlan?.url ?? candidate.url;
  video.load();
  return finish(pending);
}
