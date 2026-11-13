"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_WAVE,
  SOURCE_COOLDOWN_MS,
  describeSource,
  nextWaveSize,
  orderSources,
  type ScoreSnapshot,
  type SourceOffer,
} from "@/src/router-policy.mjs";
import {
  attachCandidate,
  applyPlaybackSnapshot,
  capturePlaybackSnapshot,
  type AudioState,
  type ListeningRequest,
  type PlaybackSnapshot,
  type PlayerController,
  type QualityLevel,
  type QualityState,
} from "@/lib/player";
import type { ListeningPlan } from "@phantom/ui/listening";
import { debug } from "@/lib/debug";
import {
  PINNED_STARTUP_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  SourceFailure,
  askSource,
  runRace,
} from "@/lib/source-router";
import { readScores, recordObservation, titleKey } from "@/lib/source-score";
import { formatTimecode } from "@/lib/media";
import { progressKey, readResumePoint, resumableTime } from "@/lib/resume";
import type {
  MediaResult,
  StreamCandidate,
  SubtitleTrack,
} from "@/lib/types";
import { failureDomainFor } from "@/src/failure-domain.mjs";
import {
  coolingMapFor,
  recordCooldown,
} from "@/src/source-health.mjs";
import {
  UNVERIFIED_AUDIO_LANGUAGE,
  audioLanguageName,
  normalizeAudioLanguage,
} from "@/src/media-language.mjs";
import { SourceRunGuard } from "@/src/source-run-guard.mjs";
import { PlaybackRecoveryState } from "@/src/playback-recovery.mjs";
import { collectAvailableAudioLanguages } from "@/src/audio-availability.mjs";
import { scheduleSourceAutostartOnce } from "@/src/source-autostart.mjs";

export interface SourceEntry {
  id: string;
  label: string;
  automatic?: boolean;
}

export type SourceStatus =
  | "idle"
  | "queued"
  | "asking"
  | "offered"
  | "holding"
  | "playing"
  | "empty"
  | "unplayable"
  | "languageUnknown"
  | "languageMismatch"
  | "slow"
  | "unreachable"
  | "limited";

export interface SourceProgress {
  id: string;
  label: string;
  status: SourceStatus;
  reputation: string;
  elapsedMs: number | null;
  bestLabel: string | null;
}

export type RouterPhase =
  | "idle"
  | "racing"
  | "holding"
  | "attaching"
  | "playing"
  | "cooldown"
  | "error";

export interface RouterState {
  phase: RouterPhase;
  statusText: string;
  activeSource: string | null;
  activeCandidate: StreamCandidate | null;
  audioUnverified: boolean;
  availableAudioLanguages: readonly string[];
  candidates: readonly StreamCandidate[];
  subtitles: readonly SubtitleTrack[];
  levels: readonly QualityLevel[];
  quality: QualityState;
  audio: AudioState;
  /** What listening does for the attached source, or null while watching. */
  listening: ListeningPlan | null;
  progress: readonly SourceProgress[];
  answered: number;
  asking: number;
  total: number;
  raceElapsedMs: number;
  retryAt: number;
  retrySeconds: number;
  pinned: string | null;
  resumedFrom: number | null;
}

const STALL_WINDOW_MS = 30_000;

const FLUSH_INTERVAL_MS = 150;

const PLAY_TIMEOUT_MS = 2_000;
const RECOVERY_DELAY_MS = 650;
const MAX_AUTO_RECOVERIES = 2;
const MAX_AUTOMATIC_RACE_RETRIES = 1;

interface StartOptions {
  pin?: string | null;
  recovery?: boolean;
  handoff?: PlaybackSnapshot | null;
}

const isAutomaticSource = (source: SourceEntry) => source.automatic !== false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

interface Pending {
  resolveMs: number;
  probeMs: number | null;
  tier: number;
  startedAt: number;
}

function initialState(total: number): RouterState {
  return {
    phase: "idle",
    statusText: "",
    activeSource: null,
    activeCandidate: null,
    audioUnverified: false,
    availableAudioLanguages: [],
    candidates: [],
    subtitles: [],
    levels: [],
    quality: { selected: -1, effective: -1 },
    audio: { tracks: [], selected: -1 },
    listening: null,
    progress: [],
    answered: 0,
    asking: 0,
    total,
    raceElapsedMs: 0,
    retryAt: 0,
    retrySeconds: 0,
    pinned: null,
    resumedFrom: null,
  };
}

export interface UseSourceRouterOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  media: MediaResult;
  season: number;
  episode: number;
  sources: readonly SourceEntry[];
  preferredAudioLanguage: string;
  /** Listen instead of watch: every source is attached for its sound, through failover and recovery too. */
  listening?: boolean;
}

export function useSourceRouter({
  videoRef,
  media,
  season,
  episode,
  sources,
  preferredAudioLanguage,
  listening = false,
}: UseSourceRouterOptions) {
  const initialAudioLanguage = normalizeAudioLanguage(preferredAudioLanguage);
  const [state, setState] = useState<RouterState>(() =>
    initialState(sources.filter(isAutomaticSource).length),
  );

  const controllerRef = useRef<PlayerController | null>(null);
  const listeningRef = useRef(listening);
  const applyListeningRef = useRef<() => void>(() => {});
  const attachedRef = useRef<{
    candidate: StreamCandidate;
    sourceId: string;
    allowUnverifiedAudio: boolean;
  } | null>(null);
  const unsubscribeQualityRef = useRef<(() => void) | null>(null);
  const unsubscribeAudioRef = useRef<(() => void) | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const startRef = useRef<(options?: StartOptions) => void>(() => {});
  const runGuardRef = useRef(new SourceRunGuard());
  const recoveryTimerRef = useRef<number | null>(null);
  const fatalHandledRequestRef = useRef(0);
  const playbackRecoveryRef = useRef(
    new PlaybackRecoveryState(MAX_AUTO_RECOVERIES),
  );

  const coolingRef = useRef<Record<string, number>>({});
  const handoffRef = useRef<PlaybackSnapshot | null>(null);
  const coolDomain = useCallback((sourceId: string, retryAfterMs: number | null) => {
    const domain = failureDomainFor(sourceId);
    const until = recordCooldown(domain, retryAfterMs, {
      fallbackMs: SOURCE_COOLDOWN_MS,
      capMs: SOURCE_COOLDOWN_MS,
    });
    // Local mirror keeps the existing per-instance behaviour in sync with
    // the shared breaker so concurrent hook instances observe each other.
    coolingRef.current[domain] = until;
    return until;
  }, []);
  const coolingFor = useCallback(
    (ids: readonly string[]) => {
      const shared = coolingMapFor(ids, failureDomainFor);
      const merged: Record<string, number> = { ...shared };
      for (const id of ids) {
        const local = coolingRef.current[failureDomainFor(id)] ?? 0;
        if (local > (merged[id] ?? 0)) merged[id] = local;
      }
      return merged;
    },
    [],
  );
  const waveRef = useRef(MAX_WAVE);
  const pinnedRef = useRef<string | null>(null);
  const pinRetriedRef = useRef(false);
  const attachedAtRef = useRef(0);
  const attachedSourceRef = useRef<string | null>(null);
  const pendingRef = useRef<Record<string, Pending>>({});
  const progressRef = useRef<Record<string, SourceProgress>>({});
  const raceStartedAtRef = useRef(0);
  const languageMismatchRef = useRef(0);
  const sourceAudioLanguagesRef = useRef<Record<string, readonly string[]>>({});
  const automaticRaceRetriesRef = useRef(MAX_AUTOMATIC_RACE_RETRIES);
  const dirtyRef = useRef(false);

  const normalizedAudioLanguage = initialAudioLanguage;
  const selectedLanguageName = audioLanguageName(normalizedAudioLanguage);
  const playable = media.tmdbId !== null;
  const resumeKey = progressKey(media, season, episode);
  const currentTitleKey = titleKey(media, season);

  const labelOf = useCallback(
    (id: string) => sources.find((entry) => entry.id === id)?.label ?? id,
    [sources],
  );

  const patch = useCallback((next: Partial<RouterState>) => {
    setState((current) => ({ ...current, ...next }));
  }, [setState]);

  const publishAudioAvailability = useCallback(() => {
    const availableAudioLanguages = collectAvailableAudioLanguages(
      Object.values(progressRef.current).map((entry) => ({
        status: entry.status,
        languages: sourceAudioLanguagesRef.current[entry.id] ?? [],
      })),
    );
    patch({ availableAudioLanguages });
    debug("router", "audio-availability", {
      languages: availableAudioLanguages,
      sources: Object.values(progressRef.current)
        .filter((entry) => sourceAudioLanguagesRef.current[entry.id]?.length)
        .map((entry) => ({
          source: entry.label,
          status: entry.status,
          languages: sourceAudioLanguagesRef.current[entry.id],
        })),
    });
  }, [patch]);

  const setProgress = useCallback(
    (id: string, next: Partial<SourceProgress>) => {
      const existing = progressRef.current[id];
      if (!existing) return;
      progressRef.current[id] = { ...existing, ...next };
      dirtyRef.current = true;
    },
    [],
  );

  const flush = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const progress = Object.values(progressRef.current);
    setState((current) => ({
      ...current,
      progress,
      answered: progress.filter(
        (entry) =>
          entry.status !== "idle" &&
          entry.status !== "queued" &&
          entry.status !== "asking",
      ).length,
      asking: progress.filter((entry) => entry.status === "asking").length,
      raceElapsedMs: raceStartedAtRef.current
        ? Date.now() - raceStartedAtRef.current
        : 0,
    }));
  }, [setState]);

  const detach = useCallback(() => {
    unsubscribeQualityRef.current?.();
    unsubscribeQualityRef.current = null;
    unsubscribeAudioRef.current?.();
    unsubscribeAudioRef.current = null;
    controllerRef.current?.destroy();
    controllerRef.current = null;
    patch({
      levels: [],
      quality: { selected: -1, effective: -1 },
      audio: { tracks: [], selected: -1 },
      listening: null,
    });
  }, [patch]);

  const adopt = useCallback(
    (controller: PlayerController) => {
      controllerRef.current = controller;
      unsubscribeQualityRef.current = controller.subscribeQuality((quality) =>
        patch({ quality }),
      );
      unsubscribeAudioRef.current = controller.subscribeAudio((audio) =>
        patch({ audio }),
      );
      patch({
        levels: controller.levels,
        audio: controller.audio(),
        listening: controller.listening(),
      });
    },
    [patch],
  );

  const record = useCallback(
    (
      sourceId: string,
      outcome: "verified" | "empty" | "unreachable" | "limited",
      extra: { attached?: boolean; ttffMs?: number | null; stalled?: boolean } = {},
    ) => {
      const pending = pendingRef.current[sourceId];
      const observation = {
        sourceId,
        titleKey: currentTitleKey,
        outcome,
        resolveMs: pending?.resolveMs ?? 0,
        probeMs: pending?.probeMs ?? null,
        tier: pending?.tier ?? 0,
        attached: extra.attached ?? false,
        ttffMs: extra.ttffMs ?? null,
        stalled: extra.stalled ?? false,
      };
      recordObservation(observation);
      debug("score", "observed", { ...observation, source: labelOf(sourceId) });
    },
    [currentTitleKey, labelOf],
  );

  const attachOne = useCallback(
    async (
      candidate: StreamCandidate,
      sourceId: string,
      requestId: number,
      resumeFrom: number | null,
      timeoutMs: number,
      allowUnverifiedAudio = false,
      handoff: PlaybackSnapshot | null = null,
    ) => {
      const video = videoRef.current;
      if (!video) throw new Error("The player is not mounted");

      detach();
      const startedAt = performance.now();
      const attachedListening = listeningRef.current;

      const controller = await attachCandidate(video, candidate, {
        timeoutMs,
        listening: attachedListening ? { language: normalizedAudioLanguage } : null,
        onFatal: () => {
          if (requestIdRef.current !== requestId) return;
          if (fatalHandledRequestRef.current === requestId) return;
          fatalHandledRequestRef.current = requestId;
          // Snapshot the exact playhead before the controller is torn down
          // so recovery restores it instead of the 5s-interval resume point.
          try {
            handoffRef.current = capturePlaybackSnapshot(
              videoRef.current,
              controllerRef.current,
            );
          } catch {
            handoffRef.current = null;
          }
          const stalled = Date.now() - attachedAtRef.current < STALL_WINDOW_MS;
          record(sourceId, "verified", { attached: true, stalled });
          if (pinnedRef.current === sourceId && !pinRetriedRef.current) {
            pinRetriedRef.current = true;
            patch({ statusText: `${labelOf(sourceId)} dropped out. Reconnecting` });
            runGuardRef.current.clear();
            if (recoveryTimerRef.current) {
              window.clearTimeout(recoveryTimerRef.current);
            }
            recoveryTimerRef.current = window.setTimeout(() => {
              recoveryTimerRef.current = null;
              startRef.current({
                pin: sourceId,
                recovery: true,
                handoff: handoffRef.current,
              });
            }, RECOVERY_DELAY_MS);
            return;
          }
          if (pinnedRef.current === sourceId) {
            detach();
            patch({
              phase: "error",
              statusText: `${labelOf(sourceId)} keeps dropping out. Try another source, or switch back to automatic.`,
            });
            return;
          }
          delete sourceAudioLanguagesRef.current[sourceId];
          setProgress(sourceId, { status: "unreachable" });
          publishAudioAvailability();
          coolDomain(sourceId, SOURCE_COOLDOWN_MS);
          if (!playbackRecoveryRef.current.recordFailure(sourceId, stalled)) {
            detach();
            patch({
              phase: "error",
              activeSource: null,
              activeCandidate: null,
              statusText:
                "Playback stopped repeatedly. Automatic recovery was paused.",
            });
            return;
          }
          patch({ statusText: "Playback stopped. Finding another option" });
          runGuardRef.current.clear();
          if (recoveryTimerRef.current) {
            window.clearTimeout(recoveryTimerRef.current);
          }
          recoveryTimerRef.current = window.setTimeout(() => {
            recoveryTimerRef.current = null;
            startRef.current({ recovery: true, handoff: handoffRef.current });
          }, RECOVERY_DELAY_MS);
        },
      });

      if (requestIdRef.current !== requestId) {
        controller.destroy();
        throw new Error("superseded");
      }

      const audio = controller.audio();
      if (audio.tracks.length > 0 && !allowUnverifiedAudio) {
        const handoffTrack =
          handoff && handoff.selectedAudio >= 0
            ? audio.tracks.find((track) => track.index === handoff.selectedAudio)
            : undefined;
        const handoffMatches =
          handoffTrack &&
          (normalizeAudioLanguage(handoffTrack.language) === normalizedAudioLanguage ||
            normalizeAudioLanguage(handoffTrack.label) === normalizedAudioLanguage);
        if (handoffMatches) {
          controller.setAudioTrack(handoffTrack.index);
        } else {
          const matchingTrack = audio.tracks.find(
            (track) =>
              normalizeAudioLanguage(track.language) ===
                normalizedAudioLanguage ||
              normalizeAudioLanguage(track.label) === normalizedAudioLanguage,
          );
          if (!matchingTrack) {
            controller.destroy();
            throw new Error(
              `This playback option did not contain ${selectedLanguageName} audio`,
            );
          }
          controller.setAudioTrack(matchingTrack.index);
        }
      } else if (handoff && handoff.selectedAudio >= 0 && audio.tracks.length > 0) {
        const track = audio.tracks.find((entry) => entry.index === handoff.selectedAudio);
        if (track) controller.setAudioTrack(track.index);
      }

      adopt(controller);
      // Restore the exact rendition selections that survived the handoff.
      applyPlaybackSnapshot(null, controller, handoff);
      if (handoff && handoff.selectedLevel >= 0) {
        try {
          controller.setLevel(handoff.selectedLevel);
        } catch {
          // ignore missing rendition
        }
      }
      attachedAtRef.current = Date.now();
      attachedSourceRef.current = sourceId;
      attachedRef.current = { candidate, sourceId, allowUnverifiedAudio };
      // The choice changed while this source was attaching.
      if (attachedListening !== listeningRef.current) {
        queueMicrotask(() => applyListeningRef.current());
      }
      record(sourceId, "verified", {
        attached: true,
        ttffMs: performance.now() - startedAt,
      });

      // Exact playhead wins over the stored resume point.
      const exactTime = handoff?.currentTime ?? resumeFrom;
      if (exactTime !== null && exactTime !== undefined) {
        seekWhenReady(video, exactTime);
      }
      if (handoff?.paused === true) {
        try {
          video.pause();
        } catch {
          // ignore
        }
      } else {
        await Promise.race([
          video.play().catch(() => {
          }),
          delay(PLAY_TIMEOUT_MS),
        ]);
      }
      return controller;
    },
    [
      adopt,
      coolDomain,
      detach,
      labelOf,
      normalizedAudioLanguage,
      patch,
      record,
      publishAudioAvailability,
      selectedLanguageName,
      setProgress,
      videoRef,
    ],
  );

  const start = useCallback(
    async (options: StartOptions = {}) => {
      if (!videoRef.current || !playable) return;

      if (!options.recovery) {
        playbackRecoveryRef.current.reset();
      }
      if (options.pin !== undefined) {
        pinnedRef.current = options.pin;
        pinRetriedRef.current = false;
      }
      const pinned = pinnedRef.current;
      const runKey = [
        media.id,
        season,
        episode,
        normalizedAudioLanguage,
        pinned ?? "auto",
      ].join(":");
      if (!runGuardRef.current.begin(runKey)) return;
      if (recoveryTimerRef.current) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }

      const requestId = ++requestIdRef.current;
      const traceId = [
        "playback",
        Date.now().toString(36),
        requestId.toString(36),
      ].join(":");
      fatalHandledRequestRef.current = 0;
      fetchControllerRef.current?.abort();
      const fetchController = new AbortController();
      fetchControllerRef.current = fetchController;
      // Exact-playhead handoff: an explicit snapshot from a fatal error wins;
      // otherwise fall back to the stored resume point. Fresh starts drop it.
      const handoff = options.handoff ?? handoffRef.current ?? null;
      if (!options.recovery) handoffRef.current = null;
      // Capture the live playhead for mid-playback source switches when no
      // fatal snapshot exists yet (e.g. manual recovery without onFatal).
      if (options.recovery && !handoff && videoRef.current && controllerRef.current) {
        try {
          handoffRef.current = capturePlaybackSnapshot(
            videoRef.current,
            controllerRef.current,
          );
        } catch {
          // ignore
        }
      }
      const activeHandoff = options.recovery ? (handoff ?? handoffRef.current) : null;
      detach();

      const snapshot: ScoreSnapshot = readScores(currentTitleKey);
      const eligibleSources = pinned
        ? sources.map((entry) => entry.id)
        : playbackRecoveryRef.current.eligible(
            sources
              .filter(isAutomaticSource)
              .map((entry) => entry.id),
          );
      const scoredOrder = orderSources(
        eligibleSources,
        snapshot,
        {
          pinned,
          cooling: coolingFor(sources.map((entry) => entry.id)),
          now: Date.now(),
          preferredAudioLanguage: normalizedAudioLanguage,
        },
      );
      const order = scoredOrder;
      const wave = pinned ? 1 : waveRef.current;

      raceStartedAtRef.current = Date.now();
      languageMismatchRef.current = 0;
      sourceAudioLanguagesRef.current = {};
      pendingRef.current = {};
      progressRef.current = Object.fromEntries(
        sources.map((entry) => [
          entry.id,
          {
            id: entry.id,
            label: entry.label,
            status: order.includes(entry.id)
              ? ("queued" as SourceStatus)
              : ("idle" as SourceStatus),
            reputation: describeSource(snapshot, entry.id),
            elapsedMs: null,
            bestLabel: null,
          },
        ]),
      );
      dirtyRef.current = true;

      const storedResume = resumableTime(readResumePoint(resumeKey));
      const resumeFrom = activeHandoff?.currentTime ?? storedResume;
      setState((current) => ({
        ...current,
        phase: "racing",
        statusText: pinned
          ? `Asking ${labelOf(pinned)}`
          : `Finding ${selectedLanguageName} audio`,
        activeSource: null,
        activeCandidate: null,
        audioUnverified: false,
        availableAudioLanguages: [],
        candidates: [],
        subtitles: [],
        progress: Object.values(progressRef.current),
        answered: 0,
        asking: 0,
        total: order.length,
        raceElapsedMs: 0,
        retryAt: 0,
        retrySeconds: 0,
        pinned,
        resumedFrom: resumeFrom,
      }));

      debug("router", "start", {
        traceId,
        requestId,
        titleKey: currentTitleKey,
        pinned: pinned ? labelOf(pinned) : null,
        wave,
        order: order.map(labelOf),
        cooling: (() => {
          const snapshotCooling = coolingFor(sources.map((entry) => entry.id));
          return sources
            .filter((entry) => (snapshotCooling[entry.id] ?? 0) > Date.now())
            .map(
              (entry) =>
                `${entry.label}:${Math.round(((snapshotCooling[entry.id] ?? 0) - Date.now()) / 1_000)}s`,
            );
        })(),
        scores: order.map((id) => ({
          source: labelOf(id),
          score: Math.round(snapshot.score(id) * 1_000) / 1_000,
          weight: Math.round(snapshot.weight(id) * 100) / 100,
          titleWeight: Math.round(snapshot.titleWeight(id) * 100) / 100,
        })),
      });

      let outcome;
      try {
        outcome = await runRace({
          order,
          wave,
          snapshot,
          signal: fetchController.signal,
          ask: async (sourceId) => {
            try {
              return await askSource(sourceId, {
                media,
                season,
                episode,
                label: labelOf,
                signal: fetchController.signal,
                preferredAudioLanguage: normalizedAudioLanguage,
                fresh: options.recovery,
                traceId,
              });
            } finally {
              if (
                fetchController.signal.aborted &&
                requestIdRef.current === requestId &&
                progressRef.current[sourceId]?.status === "asking"
              ) {
                setProgress(sourceId, { status: "idle" });
              }
            }
          },
          onAsking: (sourceId) => {
            setProgress(sourceId, { status: "asking" });
            debug("router", "slot", {
              source: labelOf(sourceId),
              sinceStartMs: Date.now() - raceStartedAtRef.current,
            });
          },
          onOffer: (offer) => {
            sourceAudioLanguagesRef.current[offer.sourceId] =
              offer.availableAudioLanguages ?? [];
            pendingRef.current[offer.sourceId] = {
              resolveMs: offer.resolveMs,
              probeMs: offer.probeMs,
              tier: offer.verifiedTier,
              startedAt: Date.now(),
            };
            setProgress(offer.sourceId, {
              status: "offered",
              elapsedMs: Math.round(offer.totalMs),
              bestLabel: tierLabel(offer),
            });
            patch({ candidates: offer.ranked, subtitles: offer.subtitles });
            publishAudioAvailability();
          },
          onHolding: (offer) => {
            setProgress(offer.sourceId, { status: "holding" });
            patch({
              phase: "holding",
              statusText: `Preparing ${tierLabel(offer) ?? "playback"}`,
            });
          },
          onAttaching: () => {
            patch({ phase: "attaching", statusText: "Starting playback" });
          },
          onFailure: (sourceId, failure) => {
            if (
              failure.languageMismatch &&
              failure.availableAudioLanguages.length > 0
            ) {
              sourceAudioLanguagesRef.current[sourceId] =
                failure.availableAudioLanguages;
            } else {
              delete sourceAudioLanguagesRef.current[sourceId];
            }
            setProgress(sourceId, {
              status: failure.languageMismatch
                ? failure.languageUnknown
                  ? "languageUnknown"
                  : "languageMismatch"
                : failure.kind,
            });
            publishAudioAvailability();
            if (failure.languageMismatch) {
              languageMismatchRef.current += 1;
              return;
            }
            if (
              failure.kind === "slow" ||
              failure.kind === "unplayable"
            ) {
              return;
            }
            record(sourceId, failure.kind);
            if (failure.kind === "unreachable" && failure.retryable) {
              const until = coolDomain(sourceId, failure.retryAfterMs);
              debug("router", "cooling", {
                traceId,
                source: labelOf(sourceId),
                ms: Math.max(0, until - Date.now()),
                hinted: failure.retryAfterMs,
              });
            }
          },
          attach: async (offer) => {
            const timeoutMs = pinned
              ? PINNED_STARTUP_TIMEOUT_MS
              : STARTUP_TIMEOUT_MS;
            for (const candidate of offer.attempts) {
              try {
                await attachOne(
                  candidate,
                  offer.sourceId,
                  requestId,
                  resumeFrom,
                  timeoutMs,
                  offer.audioVerified === false,
                  activeHandoff,
                );
                if (requestIdRef.current !== requestId) {
                  throw new Error("superseded");
                }
                setProgress(offer.sourceId, { status: "playing" });
                patch({
                  phase: "playing",
                  activeSource: offer.sourceId,
                  activeCandidate: candidate,
                  audioUnverified: offer.audioVerified === false,
                  candidates: offer.ranked,
                  subtitles: offer.subtitles,
                  retryAt: 0,
                  statusText:
                    resumeFrom !== null
                      ? `Resumed at ${formatTimecode(resumeFrom)}`
                      : offer.audioVerified === false
                        ? "Unverified audio"
                        : `${selectedLanguageName} audio`,
                });
                return;
              } catch (error) {
                if ((error as Error).message === "superseded") throw error;
              }
            }
            setProgress(offer.sourceId, { status: "unreachable" });
            delete sourceAudioLanguagesRef.current[offer.sourceId];
            publishAudioAvailability();
            coolDomain(offer.sourceId, SOURCE_COOLDOWN_MS);
            throw new Error(`${offer.label} would not start`);
          },
        });
      } catch (error) {
        runGuardRef.current.finish(runKey);
        if (
          requestIdRef.current === requestId &&
          !fetchController.signal.aborted
        ) {
          debug("router", "failed", {
            message: (error as Error)?.message ?? "Unknown router failure",
          });
          patch({
            phase: "error",
            activeSource: null,
            statusText: "Playback search stopped unexpectedly. Try again.",
          });
        }
        return;
      }

      if (requestIdRef.current !== requestId) {
        runGuardRef.current.finish(runKey);
        return;
      }

      debug("router", "outcome", {
        traceId,
        requestId,
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason,
        elapsedMs: Date.now() - raceStartedAtRef.current,
        answered: Object.values(progressRef.current).filter(
          (entry) => !["idle", "queued", "asking"].includes(entry.status),
        ).length,
        nextWave: nextWaveSize(
          waveRef.current,
          !outcome.ok && outcome.reason === "rateLimited",
        ),
      });

      if (outcome.ok) {
        runGuardRef.current.finish(runKey);
        handoffRef.current = null;
        automaticRaceRetriesRef.current = MAX_AUTOMATIC_RACE_RETRIES;
        waveRef.current = nextWaveSize(waveRef.current, false);
        fetchController.abort();
        fetchControllerRef.current = null;
        for (const entry of Object.values(progressRef.current)) {
          if (entry.status === "asking" || entry.status === "queued") {
            progressRef.current[entry.id] = { ...entry, status: "idle" };
            dirtyRef.current = true;
          }
        }
        flush();
        return;
      }
      if (outcome.reason === "cancelled") {
        runGuardRef.current.finish(runKey);
        return;
      }

      fetchController.abort();
      fetchControllerRef.current = null;
      for (const entry of Object.values(progressRef.current)) {
        if (entry.status === "asking" || entry.status === "queued") {
          progressRef.current[entry.id] = { ...entry, status: "idle" };
        }
      }
      waveRef.current = nextWaveSize(
        waveRef.current,
        outcome.reason === "rateLimited",
      );
      const cooldownMs = outcome.cooldownMs;
      const shouldRetryAutomatically =
        !pinned && languageMismatchRef.current === 0 && cooldownMs > 0;
      setState((current) => ({
        ...current,
        phase: pinned ? "error" : "cooldown",
        activeSource: null,
        audioUnverified: false,
        retryAt: shouldRetryAutomatically ? Date.now() + cooldownMs : 0,
        retrySeconds: shouldRetryAutomatically
          ? Math.ceil(cooldownMs / 1_000)
          : 0,
        progress: Object.values(progressRef.current),
        statusText: pinned
          ? `${labelOf(pinned)} has nothing for this. Pick another source, or switch back to automatic.`
          : outcome.reason === "rateLimited"
            ? `Upstream is rate limiting. Retrying in ${Math.ceil(cooldownMs / 1_000)}s`
            : languageMismatchRef.current > 0
              ? `No verified ${selectedLanguageName} audio is available for this title.`
              : `Playback is unavailable. Retrying in ${Math.ceil(cooldownMs / 1_000)}s`,
        asking: 0,
      }));
      runGuardRef.current.finish(runKey);
    },
    [
      attachOne,
      coolDomain,
      coolingFor,
      currentTitleKey,
      detach,
      episode,
      flush,
      labelOf,
      media,
      patch,
      playable,
      publishAudioAvailability,
      record,
      resumeKey,
      season,
      selectedLanguageName,
      setProgress,
      sources,
      normalizedAudioLanguage,
      videoRef,
    ],
  );

  useEffect(() => {
    startRef.current = (options) => {
      void start(options);
    };
  }, [start]);

  const autoStartedRef = useRef("");
  useEffect(() => {
    const key = `${media.id}:${season}:${episode}:${normalizedAudioLanguage}`;
    if (!playable) return;
    automaticRaceRetriesRef.current = MAX_AUTOMATIC_RACE_RETRIES;
    pinnedRef.current = null;
    return scheduleSourceAutostartOnce(
      autoStartedRef,
      key,
      () => {
        startRef.current({ pin: null });
      },
      window,
    );
  }, [episode, media.id, normalizedAudioLanguage, playable, season]);

  useEffect(() => {
    const timer = window.setInterval(flush, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [flush]);

  const retryAt = state.retryAt;
  const retryPhase = state.phase;
  useEffect(() => {
    if (retryAt <= 0) return;
    let triggered = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
      const canRetry =
        !triggered &&
        left === 0 &&
        retryPhase === "cooldown" &&
        automaticRaceRetriesRef.current > 0;
      if (canRetry) {
        triggered = true;
        automaticRaceRetriesRef.current -= 1;
      }
      setState((current) =>
        current.retryAt !== retryAt
          ? current
          : left > 0
            ? { ...current, retrySeconds: left }
            : {
                ...current,
                phase: canRetry ? "racing" : "error",
                retryAt: 0,
                retrySeconds: 0,
                statusText: canRetry
                  ? "Checking refreshed sources"
                  : "Playback is unavailable. Try again.",
              },
      );
      if (canRetry) {
        window.queueMicrotask(() => {
          startRef.current({ pin: null, recovery: true });
        });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt, retryPhase]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      runGuardRef.current.clear();
      playbackRecoveryRef.current.reset();
      if (recoveryTimerRef.current) {
        window.clearTimeout(recoveryTimerRef.current);
      }
      fetchControllerRef.current?.abort();
      unsubscribeQualityRef.current?.();
      unsubscribeAudioRef.current?.();
      controllerRef.current?.destroy();
    },
    [],
  );

  const cancel = useCallback(() => {
    requestIdRef.current += 1;
    runGuardRef.current.clear();
    playbackRecoveryRef.current.reset();
    if (recoveryTimerRef.current) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    fetchControllerRef.current?.abort();
    fetchControllerRef.current = null;
    detach();
    attachedSourceRef.current = null;
    attachedRef.current = null;

    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    progressRef.current = {};
    setState(
      initialState(sources.filter(isAutomaticSource).length),
    );
  }, [detach, setState, sources, videoRef]);

  const pin = useCallback((sourceId: string) => {
    startRef.current({ pin: sourceId });
  }, []);

  const unpin = useCallback(() => {
    startRef.current({ pin: null });
  }, []);

  const retry = useCallback(() => {
    automaticRaceRetriesRef.current = MAX_AUTOMATIC_RACE_RETRIES;
    startRef.current();
  }, []);

  const setQualityLevel = useCallback((index: number) => {
    controllerRef.current?.setLevel(index);
  }, []);

  const setAudioTrack = useCallback((index: number) => {
    controllerRef.current?.setAudioTrack(index);
  }, []);

  const applyListening = useCallback(async () => {
    const controller = controllerRef.current;
    const attached = attachedRef.current;
    // Nothing attached yet: the next attach reads the choice itself.
    if (!controller || !attached) return;
    const wanted = listeningRef.current;
    let result: "applied" | "reattach";
    try {
      result = await controller.setListening(
        wanted ? { language: normalizedAudioLanguage } : null,
      );
    } catch {
      result = "applied";
    }
    if (controllerRef.current !== controller || listeningRef.current !== wanted) return;
    if (result === "applied") {
      patch({ listening: controller.listening() });
      return;
    }
    // The sound and the picture come from different streams: attach the same candidate again, from the same moment.
    const handoff = capturePlaybackSnapshot(videoRef.current, controller);
    const requestId = ++requestIdRef.current;
    debug("attach", "listening.reattach", {
      source: attached.sourceId,
      listening: wanted,
    });
    attachOne(
      attached.candidate,
      attached.sourceId,
      requestId,
      handoff?.currentTime || null,
      STARTUP_TIMEOUT_MS,
      attached.allowUnverifiedAudio,
      handoff,
    ).catch((error: Error) => {
      if (error.message === "superseded" || requestIdRef.current !== requestId) return;
      // Let the router find a way back, keeping the moment and the listening choice.
      handoffRef.current = handoff;
      runGuardRef.current.clear();
      startRef.current({ recovery: true, handoff });
    });
  }, [attachOne, normalizedAudioLanguage, patch, videoRef]);

  useEffect(() => {
    applyListeningRef.current = () => void applyListening();
  }, [applyListening]);

  useEffect(() => {
    if (listeningRef.current === listening) return;
    listeningRef.current = listening;
    applyListeningRef.current();
  }, [listening]);

  const selectCandidate = useCallback(
    (candidateId: string) => {
      const candidate = state.candidates.find((item) => item.id === candidateId);
      const sourceId = state.activeSource;
      if (!candidate || !sourceId) return;
      // Exact handoff: keep the live playhead + rendition selections across
      // the candidate switch instead of re-reading the resume point.
      const handoff = capturePlaybackSnapshot(
        videoRef.current,
        controllerRef.current,
      );
      const resumeFrom = handoff?.currentTime ?? videoRef.current?.currentTime ?? 0;
      const requestId = ++requestIdRef.current;
      attachOne(
        candidate,
        sourceId,
        requestId,
        resumeFrom || null,
        STARTUP_TIMEOUT_MS,
        state.audioUnverified,
        handoff,
      )
        .then(() => {
          patch({ activeCandidate: candidate });
        })
        .catch((error: Error) => {
          if (error.message === "superseded") return;
          patch({ phase: "error", statusText: error.message });
        });
    },
    [
      attachOne,
      patch,
      state.activeSource,
      state.audioUnverified,
      state.candidates,
      videoRef,
    ],
  );

  const retrySeconds = state.retrySeconds;

  const canStart =
    playable &&
    retrySeconds === 0 &&
    state.phase !== "racing" &&
    state.phase !== "holding" &&
    state.phase !== "attaching";

  return useMemo(
    () => ({
      state,
      retrySeconds,
      canStart,
      start: retry,
      pin,
      unpin,
      cancel,
      selectCandidate,
      setQualityLevel,
      setAudioTrack,
    }),
    [
      cancel,
      canStart,
      pin,
      retry,
      retrySeconds,
      selectCandidate,
      setAudioTrack,
      setQualityLevel,
      state,
      unpin,
    ],
  );
}

function seekWhenReady(video: HTMLVideoElement, seconds: number): void {
  if (video.readyState >= 1) {
    video.currentTime = seconds;
    return;
  }
  video.addEventListener(
    "loadedmetadata",
    () => {
      video.currentTime = seconds;
    },
    { once: true },
  );
}

function tierLabel(offer: SourceOffer): string | null {
  if (offer.audioVerified === false) return "unverified audio";
  switch (offer.verifiedTier) {
    case 4:
      return "1080p or better";
    case 3:
      return "adaptive";
    case 2:
      return "720p";
    case 1:
      return "low quality";
    default:
      return null;
  }
}
