"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { RefObject } from "react";
import Hls from "hls.js";
import type { MediaState } from "./use-media";
import { CONNECTION_ERROR_DETAILS, createConnectionHealth } from "@/lib/media/connection-health";
import { createLiveLatencyController } from "@/lib/media/live-latency";
import { LiveAbrController } from "@/lib/media/live-abr";
import { createLiveFragmentLoader } from "@/lib/media/live-loader";
import { canProcessAudio, playbackEnvironment, prefersNativeHls } from "@/lib/media/engine";

interface HlsOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  src: string;
  delivery: "hls" | "file";
  audioOnly: boolean;
  isLive: boolean;
  dvrMode: boolean;
  startTime: number;
  media: MediaState;
  onMediaError?: (kind: "network" | "media") => void;
  onVideoSize?: (source: string, width: number, height: number) => void;
}

function pickInitialLevel(
  levels: { name: string; index: number }[],
  sourceLevels: Hls["levels"]
) {
  if (levels.length === 0) return -1;

  return levels.reduce((best, current) => {
    const bestLevel = sourceLevels[best.index];
    const currentLevel = sourceLevels[current.index];
    const bestBitrate = bestLevel?.bitrate ?? bestLevel?.maxBitrate ?? 0;
    const currentBitrate = currentLevel?.bitrate ?? currentLevel?.maxBitrate ?? 0;
    return currentBitrate > bestBitrate ? current : best;
  }, levels[0]).index;
}

function labelHlsLevel(level: Hls["levels"][number]) {
  const attrs = level.attrs as Record<string, string | undefined> | undefined;
  const twitchName =
    attrs?.["STABLE-VARIANT-ID"] ??
    attrs?.["IVS-NAME"] ??
    attrs?.VIDEO ??
    attrs?.NAME ?? level.name;

  if (twitchName) {
    if (twitchName === "chunked") return "Source";
    return twitchName;
  }

  const frameRate = level.frameRate ? Math.round(level.frameRate) : 0;
  return level.height
    ? `${level.height}p${frameRate >= 50 ? frameRate : ""}`
    : "Quality";
}

export function useHls({ videoRef, src, delivery, audioOnly, isLive, dvrMode, startTime, media, onMediaError, onVideoSize }: HlsOptions) {
  const { syncDisplayedTime, setLoading, setSeekableStart, setSeekableEnd } = media;
  const resumePlaying = useRef(false);
  const resumeTime = useRef<number | undefined>(undefined);
  const resumeSpeed = useRef(1);
  const preferredQualityRef = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const resetConnectionPlaybackRef = useRef<(() => void) | null>(null);
  const liveControllerRef = useRef<ReturnType<typeof createLiveLatencyController> | null>(null);
  const [levels, setLevels] = useState<{ name: string; index: number }[]>([]);
  const [error, setError] = useState("");
  const [connectionUnstable, setConnectionUnstable] = useState(false);
  const [behindLive, setBehindLive] = useState(false);
  const reportError = useEffectEvent((kind: "network" | "media") => onMediaError?.(kind));
  const reportVideoSize = useEffectEvent((source: string, width: number, height: number) => onVideoSize?.(source, width, height));
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [audioProcessing, setAudioProcessing] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const resetVideo = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    let recoveries = 0;
    preferredQualityRef.current = null;
    let metadataLoaded = false;
    const connection = createConnectionHealth();
    setConnectionUnstable(false);
    setBehindLive(false);
    const plainLive = isLive && !dvrMode;
    const progressive = plainLive && typeof fetch !== "undefined" && typeof AbortController !== "undefined" &&
      typeof ReadableStream !== "undefined" && typeof Request !== "undefined";
    const environment = playbackEnvironment(video);
    const native = delivery === "file" || !Hls.isSupported() || prefersNativeHls(environment, isLive, audioOnly);
    setAudioProcessing(canProcessAudio(environment, native ? "native" : "hls.js", delivery));
    const startPosition = !isLive || dvrMode ? resumeTime.current ?? startTime : 0;
    let attachedHls: Hls | null = null;
    let segmentDuration = 2;
    let predictiveTimeline = false;
    let prefetchDuration = 0;
    const liveController = plainLive ? createLiveLatencyController(video, {
      native,
      timeline: () => {
        const details = attachedHls?.latestLevelDetails;
        return details ? {
          live: details.live, targetDuration: details.targetduration, segmentDuration,
          partTarget: details.partTarget, partHoldBack: details.partHoldBack,
          age: details.age, edge: details.edge, prefetch: predictiveTimeline, prefetchDuration,
        } : null;
      },
      setTargetLatency: seconds => { if (attachedHls) attachedHls.targetLatency = seconds; },
      refreshTimeline: native ? undefined : () => attachedHls?.startLoad(video.currentTime, true),
      onSeek: syncDisplayedTime,
    }) : null;
    liveControllerRef.current = liveController;
    let previousTime = video.currentTime;
    let playbackGraceUntil = 0;
    const publishConnection = () => setConnectionUnstable(connection.unstable);
    const sampleConnection = () => {
      const now = performance.now();
      const active = video.played.length > 0 && !video.paused && !video.ended && !video.seeking && !video.error &&
          now >= playbackGraceUntil && document.visibilityState === "visible";
      connection.playback(now, {
        active,
        starved: video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
        progressing: video.currentTime > previousTime,
        online: navigator.onLine,
      });
      liveController?.tick(active, connection.unstable || !navigator.onLine);
      setBehindLive(liveController?.behindLive ?? false);
      previousTime = video.currentTime;
      publishConnection();
    };
    const resetConnectionPlayback = () => {
      connection.resetPlayback();
      playbackGraceUntil = performance.now() + 3_000;
    };
    resetConnectionPlaybackRef.current = resetConnectionPlayback;
    const connectionTimer = window.setInterval(sampleConnection, plainLive ? 250 : 1_000);
    window.addEventListener("offline", sampleConnection);
    window.addEventListener("online", sampleConnection);
    video.addEventListener("seeking", resetConnectionPlayback);
    video.addEventListener("seeked", resetConnectionPlayback);
    document.addEventListener("visibilitychange", resetConnectionPlayback);
    sampleConnection();
    const stopConnectionMonitor = () => {
      liveController?.destroy();
      liveControllerRef.current = null;
      resetConnectionPlaybackRef.current = null;
      window.clearInterval(connectionTimer);
      window.removeEventListener("offline", sampleConnection);
      window.removeEventListener("online", sampleConnection);
      video.removeEventListener("seeking", resetConnectionPlayback);
      video.removeEventListener("seeked", resetConnectionPlayback);
      document.removeEventListener("visibilitychange", resetConnectionPlayback);
    };
    const onVideoResize = () => {
      if (metadataLoaded && !audioOnly && video.videoWidth > 0 && video.videoHeight > 0) {
        reportVideoSize(src, video.videoWidth, video.videoHeight);
      }
    };
    const capturePlayback = () => {
      // Strict Mode can clean up before a source has loaded. That empty element
      // must not replace a deep link or the previous source's playback state.
      if (!metadataLoaded) return;
      resumePlaying.current = !video.paused;
      resumeTime.current = video.currentTime;
      resumeSpeed.current = plainLive ? 1 : video.playbackRate;
    };
    const onNativeError = () => {
      if (video.error?.code === 2) {
        connection.networkError(performance.now(), true);
        publishConnection();
      }
      setError("Media is unavailable"); setLoading(false); reportError(video.error?.code === 2 ? "network" : "media");
    };
    setError("");
    video.addEventListener("error", onNativeError);
    const onLoadedMetadata = () => {
      metadataLoaded = true;
      onVideoResize();
      // hls.js already started at this position; seeking again would flush what it buffered there.
      if (startPosition > 0 && Math.abs(video.currentTime - startPosition) > 0.5) {
        video.currentTime = startPosition;
        syncDisplayedTime(startPosition);
      }
      setLoading(false);
      video.playbackRate = plainLive ? 1 : resumeSpeed.current;
      if (resumePlaying.current) void video.play().catch(() => {});
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("resize", onVideoResize);
    if (native) {
      video.src = src;
      return () => {
        stopConnectionMonitor();
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("resize", onVideoResize);
        video.removeEventListener("error", onNativeError);
        capturePlayback();
        resetVideo();
      };
    }

    const hls = new Hls({
      enableWorker: true,
      progressive,
      lowLatencyMode: isLive && !dvrMode,
      ...(plainLive ? {
        abrController: LiveAbrController,
        liveSyncDurationCount: 1.5,
        // Our controller owns rate/seek decisions and recovers its stall margin.
        maxLiveSyncPlaybackRate: 1,
        liveSyncOnStallIncrease: 0,
      } : {}),
      capLevelToPlayerSize: true,
      startLevel: -1,
      autoStartLoad: !(isLive || dvrMode),
      // A resumed recording loads its first segment at the resume point rather than at zero.
      startPosition: !isLive && startPosition > 0 ? startPosition : -1,
      backBufferLength: isLive && !dvrMode ? 15 : 30,
      maxBufferLength: isLive && !dvrMode ? 8 : 30,
      maxMaxBufferLength: isLive && !dvrMode ? 20 : 60,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 3,
      capLevelOnFPSDrop: isLive && !dvrMode,
      // Twitch does not say which language a caption channel carries, so the tracks are named after the channel.
      captionsTextTrack1Label: "CC1", captionsTextTrack1LanguageCode: "",
      captionsTextTrack2Label: "CC2", captionsTextTrack2LanguageCode: "",
      captionsTextTrack3Label: "CC3", captionsTextTrack3LanguageCode: "",
      captionsTextTrack4Label: "CC4", captionsTextTrack4LanguageCode: "",
    });
    attachedHls = hls;
    hlsRef.current = hls;
    if (progressive) hls.config.fLoader = createLiveFragmentLoader(hls);
    let levelsSynced = false;
    const sourceUrl = new URL(src, window.location.href);
    // Listening plays the live audio media playlist directly, which takes the same predictive delivery.
    let prefetchEnabled = progressive && sourceUrl.origin === window.location.origin &&
      (sourceUrl.pathname === "/api/live/master.m3u8" || sourceUrl.pathname === "/api/live/media.m3u8");
    let prefetchFailures = 0;
    let fallbackQuality: string | null = null;

    const syncLevels = (sourceLevels = hls.levels) => {
      const hevcSupported =
        typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"');

      const filteredLevels = sourceLevels
        .map((level) => {
          if (audioOnly || level.audioCodec && !level.videoCodec) return null;
          const index = hls.levels.indexOf(level);
          const levelIndex = index >= 0 ? index : sourceLevels.indexOf(level);
          if (level.codecs?.startsWith("hev1") && !hevcSupported) return null;
          return { name: labelHlsLevel(level), index: levelIndex };
        })
        .filter((level): level is NonNullable<typeof level> => level !== null);

      setLevels(filteredLevels);
      // Listening offers no picture qualities; an empty list is the settled answer, not a pending one.
      levelsSynced = audioOnly || filteredLevels.length > 0;
      const restoredLevel = fallbackQuality === null ? -1 :
        filteredLevels.find(level => level.name === fallbackQuality)?.index ?? -1;
      if ((dvrMode || restoredLevel >= 0) && filteredLevels.length > 0) {
        const actualLevels = hls.levels.length > 0 ? hls.levels : sourceLevels;
        const firstLevel = restoredLevel >= 0 ? restoredLevel : pickInitialLevel(filteredLevels, actualLevels);
        hls.currentLevel = firstLevel;
        hls.nextLevel = firstLevel;
        hls.loadLevel = firstLevel;
        hls.autoLevelCapping = -1;
        setCurrentLevel(firstLevel);
        preferredQualityRef.current = labelHlsLevel(actualLevels[firstLevel]);
      } else {
        setCurrentLevel(-1);
      }
      fallbackQuality = null;
    };

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {

      syncLevels(data.levels.length > 0 ? data.levels : hls.levels);
      if (isLive || dvrMode) {
        // An archive is opened to catch up, so it starts from the beginning. Only the plain live stream starts at the edge.
        hls.startLoad(dvrMode ? startTime : -1);
      }
      if (startPosition > 0) {
        if (dvrMode) video.currentTime = startPosition;
        syncDisplayedTime(startPosition);
      }
      setLoading(false);
    });

    hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
      if (!levelsSynced && hls.levels.length > 0) {
        syncLevels();
      }

      if (dvrMode && data.details.live && data.details.fragments.length > 0) {
        const first = data.details.fragments[0];
        const last = data.details.fragments[data.details.fragments.length - 1];
        const start = first.start;
        const end = last.start + last.duration;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {

          setSeekableStart(start);
          setSeekableEnd(end);
        }
      }
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      // Playlist merge failures have no frag. Retreat before hls.js exhausts
      // all renditions when a promoted URL changes at segment completion.
      const sequenceMismatch = predictiveTimeline && data.details === Hls.ErrorDetails.LEVEL_PARSING_ERROR &&
        /(?:media|discontinuity) sequence mismatch/.test(data.reason ?? data.error?.message ?? "");
      const predictiveFragmentError = data.frag?.tagList.some(tag => tag[0] === "EXT-X-STILL-PREFETCH") &&
        (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR);
      if (prefetchEnabled && (sequenceMismatch || predictiveFragmentError)) {
        if (++prefetchFailures >= 2 || data.fatal || sequenceMismatch) {
          // Unsupported/failed predictive delivery gets one automatic retreat
          // to completed segments, rather than exhausting fatal recovery.
          prefetchEnabled = false;
          predictiveTimeline = false;
          prefetchDuration = 0;
          // hls.js may already have reset manual mode while routing the error.
          // Preserve the viewer's choice rather than that transient state.
          fallbackQuality = preferredQualityRef.current;
          levelsSynced = false;
          capturePlayback();
          liveController?.reset();
          hls.loadSource(src);
          return;
        }
      }
      if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) liveController?.stall();
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && CONNECTION_ERROR_DETAILS.has(data.details)) {
        connection.networkError(performance.now(), data.fatal);
        publishConnection();
      }
      if (!data.fatal) return;
      if (recoveries++ >= 2) { setError("Media is unavailable"); setLoading(false); reportError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "media"); hls.destroy(); hlsRef.current = null; return; }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        hls.destroy();
        hlsRef.current = null;
      }
    });

    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      if (data.frag.type !== "main" && data.frag.type !== "audio") return;
      if (data.frag.sn === "initSegment") return;
      // Prefetch segments arrive at encoder speed, not connection speed.
      if (data.frag.tagList.some(tag => tag[0] === "EXT-X-STILL-PREFETCH")) {
        return;
      }
      const { start, first, end } = (data.part?.stats ?? data.frag.stats).loading;
      // A low-latency part may wait on the server until it exists; that wait is expected.
      const loadStart = data.part && first > start ? first : start;
      connection.fragmentLoaded(performance.now(), end - loadStart, data.part?.duration ?? data.frag.duration);
      publishConnection();
    });

    hls.on(Hls.Events.FRAG_BUFFERED, (_, data) => {
      // Download success precedes parsing/append completion. Only playable
      // predictive media breaks a consecutive failure sequence.
      if (!data.stats.aborted && data.frag.sn !== "initSegment" &&
          (data.frag.type === "main" || data.frag.type === "audio") &&
          data.frag.tagList.some(tag => tag[0] === "EXT-X-STILL-PREFETCH")) {
        prefetchFailures = 0;
      }
    });

    // A resume before metadata or after a stale playlist is completed as soon
    // as the live window becomes available, without restarting healthy loading.
    hls.on(Hls.Events.LEVEL_UPDATED, (_, data) => {
      // Use the largest of the recent complete segments, rather than Twitch's
      // conservative TARGETDURATION upper bound or an entire broadcast average.
      const recent = data.details.fragments.filter(fragment =>
        !fragment.tagList.some(tag => tag[0] === "EXT-X-STILL-PREFETCH")
      ).slice(-3).map(fragment => fragment.duration)
        .filter(duration => Number.isFinite(duration) && duration > 0);
      segmentDuration = recent.length ? Math.max(...recent) : data.details.targetduration;
      predictiveTimeline = data.details.fragments.some(fragment =>
        fragment.tagList.some(tag => tag[0] === "EXT-X-STILL-PREFETCH")
      );
      prefetchDuration = data.details.fragments.filter(fragment =>
        fragment.tagList.some(tag => tag[0] === "EXT-X-STILL-PREFETCH")
      ).reduce((duration, fragment) => duration + fragment.duration, 0);
      liveController?.refresh();
    });

    if (prefetchEnabled) {
      sourceUrl.searchParams.set("prefetch", "1");
      hls.loadSource(sourceUrl.href);
    } else {
      hls.loadSource(src);
    }
    hls.attachMedia(video);

    return () => {
      stopConnectionMonitor();
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("resize", onVideoResize);
      video.removeEventListener("error", onNativeError);
      capturePlayback();
      hls.destroy();
      hlsRef.current = null;
      resetVideo();
    };
  }, [videoRef, dvrMode, isLive, delivery, audioOnly, src, startTime, syncDisplayedTime, setLoading, setSeekableStart, setSeekableEnd]);

  const changeQuality = useCallback((level: number) => {
    if (hlsRef.current) {
      const hls = hlsRef.current;
      const video = videoRef.current;
      // A deliberate quality switch flushes the buffer; allow it to settle.
      resetConnectionPlaybackRef.current?.();
      liveControllerRef.current?.reset();
      hls.currentLevel = level;
      hls.nextLevel = level;
      hls.loadLevel = level;
      preferredQualityRef.current = level >= 0 && hls.levels[level] ? labelHlsLevel(hls.levels[level]) : null;
      setCurrentLevel(level);

      if (dvrMode && video && level >= 0) {
        const resumeAt = video.currentTime;
        hls.stopLoad();
        hls.startLoad(resumeAt);
        video.currentTime = resumeAt;
      }
    }
  }, [videoRef, dvrMode]);

  const jumpToLive = useCallback(() => {
    liveControllerRef.current?.goLive();
    setBehindLive(false);
  }, []);

  return { levels, currentLevel, changeQuality, jumpToLive, behindLive, error, connectionUnstable, audioProcessing };
}

export type HlsState = ReturnType<typeof useHls>;
