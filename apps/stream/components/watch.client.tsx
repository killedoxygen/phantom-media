"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useListening } from "@phantom/ui";
import { AppHeader } from "@/components/app-header";
import { WatchlistButton } from "@/components/watchlist-button";
import { BrowseRail } from "@/components/browse-rail";
import { EpisodeBrowser } from "@/components/episode-browser";
import { TitleLogo } from "@/components/title-logo";
import { TitleMeta } from "@/components/title-meta";
import { SiteFooter } from "@/components/site-footer";
import {
  VideoStage,
  type CaptionChoice,
  type StageMenuModel,
  type StageStatus,
  type StageToast,
} from "@/components/player/video-stage";
import { EpisodePanel } from "@/components/player/episode-panel";
import { useChapters } from "@/components/player/use-chapters";
import { useResumeTracking } from "@/components/player/use-resume-tracking";
import {
  useSourceRouter,
  type SourceEntry,
} from "@/components/player/use-source-router";
import { formatTimecode } from "@/lib/media";
import {
  prefsOnServer,
  prefsSnapshot,
  readPrefs,
  savePrefs,
  subscribePrefs,
} from "@/lib/player-prefs";
import { progressKey, saveResumePoint } from "@/lib/resume";
import {
  captionDetail,
  captionLabel,
  captionLanguage,
  mergeTracks,
  proxiedCaptionUrl,
} from "@/lib/subtitles";
import type {
  EpisodeSummary,
  MediaResult,
  SeasonSummary,
  StreamCandidate,
  SubtitleTrack,
} from "@/lib/types";
import {
  episodeSelectionFromUrl,
  urlWithEpisodeSelection,
} from "@/src/episode-selection.mjs";
import {
  UNVERIFIED_AUDIO_LANGUAGE,
  audioLanguageName,
  normalizeAudioLanguage,
} from "@/src/media-language.mjs";
import {
  collectAvailableAudioLanguages,
  orderAvailableAudioLanguages,
} from "@/src/audio-availability.mjs";
import {
  sourceAvailabilityBars,
  sourceAvailabilityRank,
  sourceAvailabilityTone,
} from "@/src/source-availability.mjs";

export type { SourceEntry };

const AUTO_QUALITY = "auto";
const AUTO_SOURCE = "auto";

function candidateLabel(candidate: StreamCandidate, index: number): string {
  if (candidate.resolution && candidate.resolution >= 144) {
    return `${candidate.resolution}p`;
  }
  if (candidate.type === "hls") {
    return index === 0 ? "Adaptive" : `Adaptive ${index + 1}`;
  }
  return candidate.format?.toUpperCase() || candidate.type.toUpperCase();
}

const STAGE_STATUS: Record<string, StageStatus> = {
  idle: "idle",
  racing: "working",
  holding: "working",
  attaching: "working",
  playing: "ready",
  cooldown: "error",
  error: "error",
};

export default function WatchPageClient({
  media,
  seasons,
  episodes,
  related,
  relatedTitle,
  sources,
  initialSeason,
  initialEpisode,
}: {
  media: MediaResult;
  seasons: readonly SeasonSummary[];
  episodes: readonly EpisodeSummary[];
  related: readonly MediaResult[];
  relatedTitle: string;
  sources: readonly SourceEntry[];
  initialSeason: number;
  initialEpisode: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [season, setSeason] = useState(initialSeason);
  const [episode, setEpisode] = useState(initialEpisode);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [catalogTracks, setCatalogTracks] = useState<SubtitleTrack[]>([]);
  const [toastDismissed, setToastDismissed] = useState(false);

  const playerPrefs = useSyncExternalStore(
    subscribePrefs,
    prefsSnapshot,
    prefsOnServer,
  );
  const preferredAudioLanguage = normalizeAudioLanguage(
    playerPrefs.audioLanguage,
  );
  const { listening } = useListening();
  const router = useSourceRouter({
    videoRef,
    media,
    season,
    episode,
    sources,
    preferredAudioLanguage,
    listening,
  });
  const { state } = router;
  const status = STAGE_STATUS[state.phase] ?? "idle";

  useResumeTracking(
    videoRef,
    state.phase === "playing" ? progressKey(media, season, episode) : null,
  );

  const position = useMemo(
    () =>
      episodes.findIndex(
        (item) =>
          item.seasonNumber === season && item.episodeNumber === episode,
      ),
    [episode, episodes, season],
  );
  const currentEpisode = position >= 0 ? episodes[position] : undefined;
  const nextEpisode = position >= 0 ? episodes[position + 1] : undefined;

  const changeEpisode = useCallback(
    (nextSeason: number, next: number, history: "push" | "none" = "push") => {
      if (nextSeason === season && next === episode) return;

      const video = videoRef.current;
      if (state.phase === "playing" && video) {
        saveResumePoint(
          progressKey(media, season, episode),
          video.currentTime,
          video.duration,
        );
      }
      router.cancel();
      setCatalogTracks([]);
      setToastDismissed(false);
      setSeason(nextSeason);
      setEpisode(next);
      if (history === "push") {
        window.history.pushState(
          null,
          "",
          urlWithEpisodeSelection(window.location.href, {
            season: nextSeason,
            episode: next,
          }),
        );
      }
    },
    [episode, media, router, season, state.phase],
  );

  useEffect(() => {
    const onPopState = () => {
      const selected = episodeSelectionFromUrl(
        window.location.href,
        seasons,
        episodes,
      );
      changeEpisode(selected.season, selected.episode, "none");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [changeEpisode, episodes, seasons]);

  const goToEpisode = useCallback(
    (target?: EpisodeSummary) => {
      if (!target) return;
      setEpisodesOpen(false);
      changeEpisode(target.seasonNumber, target.episodeNumber);
    },
    [changeEpisode],
  );

  useEffect(() => {
    if (!media.imdbId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      imdbId: media.imdbId,
      type: media.mediaType,
    });
    if (media.mediaType === "tv") {
      params.set("season", String(season));
      params.set("episode", String(episode));
    }

    fetch(`/api/subtitles/search?${params}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { tracks: [] }))
      .then((body: { tracks?: SubtitleTrack[] }) => {
        setCatalogTracks(body.tracks ?? []);
      })
      .catch(() => {});

    return () => controller.abort();
  }, [episode, media.imdbId, media.mediaType, season]);

  const captionTracks = useMemo(() => {
    const preferred = typeof window === "undefined" ? [] : preferredLanguages();
    return mergeTracks(state.subtitles, catalogTracks, preferred);
  }, [catalogTracks, state.subtitles]);

  const captionChoices = useMemo<CaptionChoice[]>(
    () =>
      captionTracks.map((track, index) => ({
        value: String(index),
        label: captionLabel(track),
        detail: captionDetail(track),
        language: captionLanguage(track),
      })),
    [captionTracks],
  );

  const trackKey = useMemo(
    () => `${state.activeCandidate?.id ?? "none"}:${captionTracks.length}`,
    [captionTracks.length, state.activeCandidate?.id],
  );

  const chapters = useChapters(
    videoRef,
    state.phase === "playing" ? (state.activeCandidate?.id ?? null) : null,
  );

  const changeQuality = useCallback(
    (value: string) => {
      if (value === AUTO_QUALITY) {
        router.setQualityLevel(-1);
        return;
      }
      if (value.startsWith("level:")) {
        router.setQualityLevel(Number(value.slice(6)));
        return;
      }
      router.selectCandidate(value);
    },
    [router],
  );

  const qualityMenu = useMemo<StageMenuModel | undefined>(() => {
    const { levels, quality, candidates, activeCandidate } = state;
    if (levels.length > 1) {
      const effective = levels.find(
        (level) => level.index === quality.effective,
      );
      return {
        options: [
          {
            value: AUTO_QUALITY,
            label: "Auto",
            detail: effective ? `now ${effective.label}` : undefined,
          },
          ...[...levels]
            .sort((left, right) => right.height - left.height)
            .map((level) => ({
              value: `level:${level.index}`,
              label: level.label,
              detail:
                level.bitrate > 0
                  ? `${Math.round(level.bitrate / 1_000)} kbps`
                  : undefined,
            })),
        ],
        value:
          quality.selected === -1 ? AUTO_QUALITY : `level:${quality.selected}`,
        onChange: changeQuality,
        summary:
          quality.selected === -1
            ? (effective?.label ?? "Auto")
            : (levels.find((level) => level.index === quality.selected)
                ?.label ?? "Auto"),
      };
    }

    if (candidates.length > 1) {
      return {
        options: candidates.map((candidate, index) => ({
          value: candidate.id,
          label: candidateLabel(candidate, index),
          detail: candidate.type.toUpperCase(),
        })),
        value: activeCandidate?.id ?? null,
        onChange: changeQuality,
      };
    }

    return undefined;
  }, [changeQuality, state]);

  const sourceMenu = useMemo<StageMenuModel>(() => {
    const byId = new Map(state.progress.map((entry) => [entry.id, entry]));
    const ordinal = new Map(sources.map((source, index) => [source.id, index]));
    const playingLabel = state.activeSource
      ? (sources.find((entry) => entry.id === state.activeSource)?.label ??
        null)
      : null;
    const ordered = [...sources].sort((left, right) => {
      const difference =
        sourceAvailabilityRank(byId.get(left.id)?.status) -
        sourceAvailabilityRank(byId.get(right.id)?.status);
      return (
        difference || (ordinal.get(left.id) ?? 0) - (ordinal.get(right.id) ?? 0)
      );
    });

    return {
      options: [
        {
          value: AUTO_SOURCE,
          label: "Automatic",
          detail: playingLabel ? `using ${playingLabel}` : "recommended",
        },
        ...ordered.map((source) => {
          const progress = byId.get(source.id);
          return {
            value: source.id,
            label: source.label,
            detail: liveDetail(progress?.status) ?? progress?.reputation,
            signal: {
              bars: sourceAvailabilityBars(progress?.status),
              tone: sourceAvailabilityTone(progress?.status),
            },
          };
        }),
      ],
      value: state.pinned ?? AUTO_SOURCE,
      onChange: (value) =>
        value === AUTO_SOURCE ? router.unpin() : router.pin(value),
    };
  }, [router, sources, state.activeSource, state.pinned, state.progress]);

  const languageMenu = useMemo<StageMenuModel>(() => {
    const languages = orderAvailableAudioLanguages(
      collectAvailableAudioLanguages(
        [
          {
            status: "offered",
            languages: state.availableAudioLanguages,
          },
        ],
        state.audio.tracks,
      ),
      preferredAudioLanguage,
    );
    const effectiveLanguage =
      state.audioUnverified ||
      preferredAudioLanguage === UNVERIFIED_AUDIO_LANGUAGE
        ? UNVERIFIED_AUDIO_LANGUAGE
        : preferredAudioLanguage;
    return {
      options: languages.map((language) => ({
        value: language,
        label: audioLanguageName(language),
        language,
      })),
      value: effectiveLanguage,
      onChange: (value) => {
        const next = normalizeAudioLanguage(value);
        savePrefs({ audioLanguage: next });
        if (next === preferredAudioLanguage) router.start();
      },
      summary: audioLanguageName(effectiveLanguage),
    };
  }, [
    preferredAudioLanguage,
    router,
    state.audio.tracks,
    state.audioUnverified,
    state.availableAudioLanguages,
  ]);

  const toast = useMemo<StageToast | null>(() => {
    if (toastDismissed || state.resumedFrom === null) return null;
    return {
      text: `Resumed from ${formatTimecode(state.resumedFrom)}`,
      action: {
        label: "Start over",
        onClick: () => {
          const video = videoRef.current;
          if (video) video.currentTime = 0;
          setToastDismissed(true);
        },
      },
    };
  }, [state.resumedFrom, toastDismissed]);

  useEffect(() => {
    if (state.resumedFrom === null || toastDismissed) return;
    const timer = window.setTimeout(() => setToastDismissed(true), 9_000);
    return () => window.clearTimeout(timer);
  }, [state.resumedFrom, toastDismissed]);

  const requestLabel =
    media.tmdbId === null
      ? "This title has no playable identifier"
      : router.retrySeconds > 0
        ? `Cooling down, ${router.retrySeconds}s left`
        : state.phase === "error" || state.phase === "cooldown"
          ? "Try playback again"
          : "Play";

  const isSeries = media.mediaType === "tv";
  const hasListing = isSeries && episodes.length > 0;

  return (
    <main className="watch-page workspace-canvas flex min-h-screen flex-col">
      <AppHeader />

      <div className="stage-frame">
        <VideoStage
          videoRef={videoRef}
          title={media.title}
          subtitle={
            currentEpisode
              ? `S${currentEpisode.seasonNumber} E${currentEpisode.episodeNumber} ${currentEpisode.name}`
              : media.year
          }
          poster={media.backdropUrl}
          status={status}
          statusText={state.statusText}
          onRequestPlayback={router.start}
          canRequestPlayback={router.canStart}
          requestLabel={requestLabel}
          progress={{
            sources: state.progress,
            answered: state.answered,
            asking: state.asking,
            total: state.total,
            elapsedMs: state.raceElapsedMs,
          }}
          quality={listening ? undefined : qualityMenu}
          language={languageMenu}
          listeningPlan={state.listening}
          listeningArtwork={media.posterUrl}
          listeningBackdrop={currentEpisode?.stillUrl ?? media.backdropUrl}
          sources={sourceMenu}
          captions={captionChoices}
          trackKey={trackKey}
          toast={toast}
          onDismissToast={() => setToastDismissed(true)}
          chapters={chapters}
          onNextEpisode={
            nextEpisode ? () => goToEpisode(nextEpisode) : undefined
          }
          episodesOpen={episodesOpen}
          onEpisodesOpenChange={setEpisodesOpen}
          episodePanel={
            hasListing ? (
              <EpisodePanel
                media={media}
                seasons={seasons}
                episodes={episodes}
                season={season}
                episode={episode}
                onSelect={goToEpisode}
                onClose={() => setEpisodesOpen(false)}
              />
            ) : undefined
          }
          upNext={
            nextEpisode && state.phase === "playing"
              ? { episode: nextEpisode, onPlay: () => goToEpisode(nextEpisode) }
              : undefined
          }
          tracks={captionTracks.map((track, index) => (
            <track
              key={`${trackKey}:${index}`}
              kind="subtitles"
              src={proxiedCaptionUrl(track) ?? undefined}
              label={captionLabel(track)}
              srcLang={captionLanguage(track)}
            />
          ))}
        />
      </div>

      <div className="app-shell pb-5 pt-5 lg:pb-0 lg:pt-7" id="about">
        <div className="max-w-3xl">
          <TitleLogo
            media={media}
            maxHeight="clamp(2.75rem, 11vw, 6rem)"
            maxWidth="20rem"
            headingClassName="text-[clamp(1.5rem,3vw,2.3rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-text"
          />

          {currentEpisode && (
            <p className="mt-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-phantom">
                S{currentEpisode.seasonNumber} E{currentEpisode.episodeNumber}
              </span>
              <span className="text-[15px] font-bold text-text">
                {currentEpisode.name}
              </span>
            </p>
          )}

          <div className="mt-4">
            <TitleMeta media={media} />
          </div>
          <div className="mt-5"><WatchlistButton media={media} /></div>

          {(currentEpisode?.overview || media.overview) && (
            <Synopsis text={currentEpisode?.overview || media.overview} />
          )}
        </div>
      </div>

      {isSeries && (
        <div className="order-3 app-shell pb-12 sm:pb-16">
          <EpisodeBrowser
            media={media}
            seasons={seasons}
            episodes={episodes}
            season={season}
            episode={episode}
            onSelect={goToEpisode}
            onSeasonChange={(next) =>
              changeEpisode(
                next,
                episodes.find((item) => item.seasonNumber === next)
                  ?.episodeNumber ?? 1,
              )
            }
          />
        </div>
      )}

      {related.length > 0 && (
        <div className="order-4 pb-10">
          <BrowseRail
            row={{
              id: "related",
              title: relatedTitle,
              mediaType: media.mediaType,
              items: [...related],
            }}
          />
        </div>
      )}

      <div className="order-5 app-shell mt-auto">
        <SiteFooter />
      </div>
    </main>
  );
}

function liveDetail(status?: string): string | undefined {
  switch (status) {
    case "idle":
      return "not checked";
    case "queued":
      return "waiting";
    case "asking":
      return "checking";
    case "offered":
      return "available";
    case "holding":
      return "available";
    case "playing":
      return "current";
    case "empty":
      return "unavailable";
    case "unplayable":
      return "stream failed";
    case "languageUnknown":
      return "audio not verified";
    case "languageMismatch":
      return "different audio";
    case "slow":
      return "slow response";
    case "unreachable":
      return "offline";
    case "limited":
      return "cooling down";
    default:
      return undefined;
  }
}

function Synopsis({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-5">
      <p
        className={`text-[13.5px] leading-6 text-text-secondary ${
          expanded ? "" : "line-clamp-3 sm:line-clamp-none"
        }`}
      >
        {text}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="mt-1.5 text-[10.5px] font-bold text-text-secondary underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-text hover:decoration-text sm:hidden"
      >
        {expanded ? "Less" : "More"}
      </button>
    </div>
  );
}

function preferredLanguages(): string[] {
  const saved = readPrefs().captionLanguage;
  const fromBrowser = navigator.languages ?? [navigator.language];
  const languages = fromBrowser
    .map((tag) => tag.split("-")[0]!)
    .filter(Boolean);
  return saved ? [saved, ...languages] : languages;
}
