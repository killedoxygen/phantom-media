"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { readStoredPlayback, storePlayback } from "@/lib/history";
import { useHistoryRecord } from "../history/use-history";
import { parseStartTime } from "@/lib/validation";
import type { ChannelData } from "@/lib/contracts";
import type { VideoDetails } from "@/lib/playback/data";
import type { VodPlaybackData } from "@/lib/playback/data";

type AppState = "loading" | "video" | "channel" | "error";

export function useWatchSession() {
  const params = useParams<{ videoId?: string; channelName?: string }>();
  const searchParams = useSearchParams();

  const routeVodId = params.videoId ?? "";
  const routeChannel = params.channelName ?? "";
  const routeStartTime = useMemo(
    () => parseStartTime(searchParams.get("t")),
    [searchParams]
  );

  const [state, setState] = useState<AppState>("loading");
  const [vodData, setVodData] = useState<VodPlaybackData | null>(null);
  useHistoryRecord(vodData && { resource: { kind: "vod", id: vodData.vodId }, channel: vodData.channel, broadcastType: vodData.broadcastType, title: vodData.title, previewThumbnailURL: vodData.previewThumbnailURL });
  const [channelData, setChannelData] = useState<ChannelData | null>(null);
  const [error, setError] = useState("");
  const [masterUrl, setMasterUrl] = useState("");
  const [startTime, setStartTime] = useState(routeStartTime ?? 0);
  const [playerTime, setPlayerTime] = useState(0);

  const resetPlayback = useCallback(() => {
    setVodData(null);
    setChannelData(null);
    setMasterUrl("");
    setPlayerTime(0);
    setStartTime(0);
  }, []);

  const loadVod = useCallback(async (vodId: string, nextStartTime: number | undefined, signal: AbortSignal) => {
    setState("loading");
    setError("");
    setChannelData(null);

    const resumeTime = nextStartTime ?? readStoredPlayback({ kind: "vod", id: vodId });
    setStartTime(resumeTime);

    try {
      const resp = await fetch(
        `/api/vod/resolve?vodId=${encodeURIComponent(vodId)}`,
        { cache: "no-store", signal }
      );

      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || `Error: ${resp.status}`);
      }

      const data: VodPlaybackData = await resp.json();
      if (signal.aborted) return;
      setVodData(data);
      setMasterUrl(data.playback.state === "ready" ? `/api/vod/master.m3u8?vodId=${data.vodId}` : "");
      setPlayerTime(resumeTime);
      setState("video");
      // Optional operation failures never delay or invalidate playable media.
      void fetch(`/api/vod/details?vodId=${encodeURIComponent(vodId)}`, { signal })
        .then(response => response.ok ? response.json() : null)
        .then((details: VideoDetails | null) => {
          if (!details || signal.aborted) return;
          setVodData(current => current?.vodId === vodId ? { ...current, chapters: details.chapters, classification: details.classification } : current);
        }).catch(() => {});
    } catch (err) {
      if (signal.aborted) return;
      resetPlayback();
      setError(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  }, [resetPlayback]);

  const loadChannel = useCallback(async (channel: string, signal: AbortSignal) => {
    setState("loading");
    setError("");
    setVodData(null);
    setStartTime(0);
    setPlayerTime(0);

    try {
      const resp = await fetch(
        `/api/channel/resolve?channel=${encodeURIComponent(channel)}`, { signal }
      );

      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.error || `Error: ${resp.status}`);
      }

      const data: ChannelData = await resp.json();
      if (signal.aborted) return;
      setChannelData(data);
      setMasterUrl(
        data.stream
          ? `/api/live/master.m3u8?channel=${encodeURIComponent(data.login)}`
          : ""
      );
      setState("channel");
    } catch (err) {
      if (signal.aborted) return;
      resetPlayback();
      setError(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  }, [resetPlayback]);

  useEffect(() => {
    const controller = new AbortController();
    if (routeVodId) void loadVod(routeVodId, routeStartTime, controller.signal);
    else if (routeChannel) void loadChannel(routeChannel, controller.signal);
    return () => controller.abort();
  }, [loadChannel, loadVod, routeChannel, routeStartTime, routeVodId]);

  const activeVodId = vodData?.vodId;
  const storedTime = useRef(-Infinity);
  const onVodTimeUpdate = useCallback(
    (time: number) => {
      setPlayerTime(time);
      // Storage writes block the main thread on phones; a resume point a few seconds old is just as good.
      if (activeVodId && Math.abs(time - storedTime.current) >= 5) {
        storedTime.current = time;
        storePlayback({ kind: "vod", id: activeVodId }, time);
      }
    },
    [activeVodId]
  );

  return { state, vodData, channelData, error, masterUrl, startTime, playerTime, onVodTimeUpdate };
}
