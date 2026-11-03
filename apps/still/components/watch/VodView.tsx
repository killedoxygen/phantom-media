"use client";

import { useCallback, useMemo, useState } from "react";
import { videoVariants, hasVideoAttributes, videoQualityLabel } from "@/lib/media/variants";
import { ResourceNotice } from "../resources/ResourcePage";
import { RecordingPosition } from "../previews/RecordingPosition";
import { ChatCircle } from "@phosphor-icons/react/ssr";
import { Player } from "@/components/player/Player";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import { Footer } from "@/components/Footer";
import { WatchLayout, useWatchChat } from "./WatchLayout";
import { WatchRail } from "./WatchRail";
import { ShareButton } from "./ShareButton";
import { VodInfo } from "./VodInfo";
import { VodChapters } from "./VodChapters";
import { ChannelProfile } from "./ChannelProfile";
import type { VodPlaybackData } from "@/lib/playback/data";

export function VodView({ vodData, masterUrl, startTime, playerTime, onTimeUpdate }: {
  vodData: VodPlaybackData;
  masterUrl: string;
  startTime: number;
  playerTime: number;
  onTimeUpdate: (time: number) => void;
}) {
  const [playbackSeekVersion, setPlaybackSeekVersion] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ position: number; revision: number }>();
  const seek = useCallback((position: number) => {
    const bounded = Math.max(0, Math.min(vodData.duration || position, position));
    setSeekRequest(previous => ({ position: bounded, revision: (previous?.revision ?? 0) + 1 }));
    onTimeUpdate(bounded); setPlaybackSeekVersion(value => value + 1);
  }, [vodData.duration, onTimeUpdate]);
  const [mode, setMode] = useState<"video" | "audio">("video");
  const [quality, setQuality] = useState("");
  const [sourceTime, setSourceTime] = useState(startTime);
  const [decodedSizes, setDecodedSizes] = useState<Record<string, string>>({});
  const variants = useMemo(() => videoVariants(vodData.qualities), [vodData.qualities]);
  const adaptive = variants.some(hasVideoAttributes);
  const activeQuality = quality || (!adaptive ? variants[0]?.key : undefined);
  const onVideoSize = useCallback((source: string, width: number, height: number) => {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return;
    const params = new URL(source, window.location.origin).searchParams;
    if (params.get("mode") === "audio") return;
    const key = params.get("quality") || (!adaptive ? variants[0]?.key : undefined);
    if (!key || !variants.some(variant => variant.key === key)) return;
    const resolution = `${width}x${height}`;
    setDecodedSizes(previous => previous[key] === resolution ? previous : { ...previous, [key]: resolution });
  }, [adaptive, variants]);
  const labeledQualities = vodData.qualities.map(variant => ({ ...variant, name: videoQualityLabel(variant, decodedSizes[variant.key]) }));
  const sourceSelection = variants.length ? {
    options: [...(adaptive ? [{ value: "", label: "Automatic" }] : []), ...variants.map(variant => ({ value: variant.key, label: videoQualityLabel(variant, decodedSizes[variant.key]) }))],
    value: activeQuality ?? "",
    onChange: (key: string) => { setSourceTime(playerTime); setQuality(key); },
  } : undefined;
  const sourceUrl = mode === "audio" ? `${masterUrl}&mode=audio` : quality ? `${masterUrl}&quality=${encodeURIComponent(quality)}` : masterUrl;
  const timelineSegments = useMemo(() => [...vodData.segments, ...vodData.chapters.map(chapter => ({ id: `chapter:${chapter.id}`, kind: "chapter", start: chapter.start, end: chapter.end, label: chapter.title }))], [vodData.segments, vodData.chapters]);
  const watchChat = useWatchChat();
  const chatOpen = watchChat.open;
  const onPlaybackSeek = useCallback(() => setPlaybackSeekVersion((value) => value + 1), []);
  const toggleChat = watchChat.toggle;
  const closeChat = () => {
    watchChat.close();
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".still-watch-rail [aria-controls='watch-chat']")?.focus();
    });
  };
  return (
    <div className="media-content still-watch relative pb-8">
      <div className="pt-2">
        <WatchLayout chatOpen={chatOpen} chatState={watchChat.state}
          video={masterUrl ? <Player seekRequest={seekRequest} src={sourceUrl} audioOnly={mode === "audio"} title={vodData.title || `Video ${vodData.vodId}`} subtitle={vodData.channelDisplayName || vodData.channel} artwork={vodData.previewThumbnailURL}
            startTime={sourceTime} isLive={Boolean(vodData.isLiveArchive)} dvrMode={Boolean(vodData.isLiveArchive)}
            segments={timelineSegments} storyboardUrl={vodData.seekPreviewsURL} sourceSelection={sourceSelection}
            onAudioOnlyChange={vodData.qualities.some(variant => variant.kind === "audio") ? enabled => { setSourceTime(playerTime); setMode(enabled ? "audio" : "video"); } : undefined}
            onVideoSize={onVideoSize} onTimeUpdate={onTimeUpdate} onPlaybackSeek={onPlaybackSeek} chatOpen={chatOpen} onChatToggle={toggleChat} /> : <div className="still-recording-unavailable"><ResourceNotice title="Video unavailable">Metadata and chat replay remain available.</ResourceNotice>
            <RecordingPosition label="Replay position" position={playerTime} duration={vodData.duration} onSeek={seek} segments={timelineSegments} /></div>}
          rail={<WatchRail channel={vodData.channel} displayName={vodData.channelDisplayName} image={vodData.channelProfileImageURL} verified={vodData.channelIsPartner}
            broadcastType={vodData.isLiveArchive ? "Live" : vodData.broadcastType.toLowerCase() === "highlight" ? "Highlight" : vodData.broadcastType.toLowerCase() === "upload" ? "Upload" : "Past broadcast"}
            actions={[
              <button key="chat" type="button" className="still-rail-action" onClick={toggleChat} aria-label={chatOpen ? "Hide chat" : "Show chat"} aria-expanded={chatOpen} aria-controls="watch-chat"><ChatCircle size={21} /></button>,
              <DownloadButton key="download" iconOnly qualities={labeledQualities} channel={vodData.channel} vodId={vodData.vodId} />,
              <ShareButton key="share" iconOnly vodId={vodData.vodId} currentTime={playerTime} />,
            ]} />}
          chat={<ChatPanel idle={!watchChat.started} onSeek={seek} channel={vodData.channel} vodId={vodData.vodId} time={playerTime} playbackSeekVersion={playbackSeekVersion}
            recordingStartedAt={vodData.isLiveArchive ? vodData.createdAt : undefined} onClose={closeChat} />}
        >
        <div className="still-watch-information">
          <div className="still-watch-details"><VodInfo channel={vodData.channel} channelDisplayName={vodData.channelDisplayName} channelProfileImageURL={vodData.channelProfileImageURL}
            broadcastType={vodData.broadcastType} title={vodData.title} titleOnly category={vodData.classification?.game} contentLabels={vodData.classification?.labels} /></div>
          <VodChapters chapters={vodData.chapters} time={playerTime} onSeek={seek} />
        </div>
        </WatchLayout>
      </div>
      {vodData.channelProfile && <ChannelProfile key={vodData.channelProfile.login} channel={vodData.channelProfile} linked />}
      <Footer />
    </div>
  );
}
