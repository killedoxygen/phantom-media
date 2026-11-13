"use client";
import { readStoredPlayback, storePlayback } from "@/lib/history";
import { useHistoryRecord } from "../history/use-history";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeListeningPlan, pickListeningFile, useListening } from "@phantom/ui";
import { Player } from "@/components/player/Player";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import type { ClipPlaybackData } from "@/lib/playback/data";
import { ResourceNotice } from "../resources/ResourcePage";
import { Footer } from "../Footer";
import { VodLoading } from "./VodLoading";
export function ClipView({ slug, requestedTime }: { slug: string; requestedTime?: number }) {
  const [data, setData] = useState<ClipPlaybackData>();
  useHistoryRecord(data ? { resource: { kind: "clip", slug }, channel: "", broadcastType: "clip", title: data.title, previewThumbnailURL: data.thumbnail, lengthSeconds: data.duration } : null);
  const [error, setError] = useState("");
  const [startTime] = useState(() => requestedTime ?? readStoredPlayback({ kind: "clip", slug }));
  const currentTime = useRef(startTime);
  const [sourceTime, setSourceTime] = useState(startTime);
  const onTimeUpdate = useCallback((time: number) => { currentTime.current = time; storePlayback({ kind: "clip", slug }, time); }, [slug]);
  const signingRefresh = useRef({ attempted: false, controller: new AbortController() });
  useEffect(() => { const controller = new AbortController(); signingRefresh.current = { attempted: false, controller }; return () => controller.abort(); }, [slug]);
  const [quality, setQuality] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/clip/resolve?slug=${encodeURIComponent(slug)}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Clip is unavailable");
      const next = await response.json() as ClipPlaybackData;
      if (controller.signal.aborted) return;
      setData(next); setQuality(next.qualities[0]?.key ?? "");
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [slug]);
  const videoFiles = data?.qualities.filter(variant => variant.kind === "video") ?? [];
  // A clip is a single video file per quality: listening plays the smallest one behind the cover.
  const listening = useListening(videoFiles.length > 0);
  const smallest = pickListeningFile(videoFiles, variant => Number.parseInt(variant.key, 10) || variant.bandwidth);
  const playing = listening.listening && smallest ? smallest.key : quality;
  const refreshOnError = (kind: "network" | "media") => {
    if (kind !== "network" || !data || signingRefresh.current.attempted || data.expiresAt && Date.now() < data.expiresAt) return;
    signingRefresh.current.attempted = true;
    const current = data.qualities.find(variant => variant.key === playing);
    void fetch(`/api/clip/resolve?slug=${encodeURIComponent(slug)}&refresh=1`, { signal: signingRefresh.current.controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Clip signing refresh failed");
      const next = await response.json() as ClipPlaybackData;
      const replacement = next.qualities.find(variant => variant.key === playing);
      if (current?.delivery !== "file" || replacement?.delivery !== "file" || current.identity !== replacement.identity) throw new Error("Clip representation changed");
      setSourceTime(currentTime.current); setData(next);
    }).catch(error => { if (!signingRefresh.current.controller.signal.aborted) setError(error.message); });
  };
  const selected = data?.qualities.find(variant => variant.key === playing);
  const listeningNote = describeListeningPlan(smallest && videoFiles.length > 1 && smallest.key !== quality
    ? { kind: "reduced", url: smallest.playlistUrl } : null);
  if (!data && !error) return <VodLoading label="Loading clip…" />;
  return <main className="still-main"><div className="media-content still-page">
    {error && <ResourceNotice title="Clip unavailable" error>{error}</ResourceNotice>}
    {data && <>
      {selected ? <Player src={selected.playlistUrl} delivery="file" onMediaError={refreshOnError} startTime={sourceTime} onTimeUpdate={onTimeUpdate} title={data.title} artwork={data.thumbnail}
        audioOnly={listening.listening} onAudioOnlyChange={enabled => { setSourceTime(currentTime.current); listening.setMode(enabled ? "audio" : "video"); }} listeningNote={listeningNote}
        sourceSelection={{ options: videoFiles.map(variant => ({ value: variant.key, label: variant.name })), value: quality, onChange: value => { setSourceTime(currentTime.current); setQuality(value); } }} /> : <ResourceNotice title="Video unavailable">This clip has no playable video quality.</ResourceNotice>}
      <div className="still-watch-details still-clip-details">
        <div className="still-video-info"><h1 className="still-video-title">{data.title || "Clip"}</h1>{data.createdAt && <p className="still-clip-date"><time dateTime={data.createdAt}>{new Date(data.createdAt).toLocaleDateString()}</time></p>}</div>
        <DownloadButton qualities={data.qualities} channel="clip" vodId={slug} clipSlug={slug} />
      </div>
    </>}
    <Footer />
  </div></main>;
}
