"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Broadcast, ChatCircle, VideoCamera } from "@phosphor-icons/react/ssr";
import { Button, describeListeningPlan, useHlsListeningPlan, useListening } from "@phantom/ui";
import { Player } from "@/components/player/Player";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { Footer } from "@/components/Footer";
import type { ChannelData } from "@/lib/contracts";
import type { SliceReceipt } from "@/lib/catalog/contracts";
import { buildVodPath } from "@/lib/validation";
import { WatchLayout, useWatchChat } from "./WatchLayout";
import { WatchRail } from "./WatchRail";
import { VodInfo } from "./VodInfo";
import { ChannelProfile } from "./ChannelProfile";

export function ChannelView({ channel: served, revalidate = false, videos }: {
  channel: ChannelData;
  /** The served copy is old enough that the channel may have gone live or offline since. */
  revalidate?: boolean;
  /** The channel's latest videos, read by the server alongside the page. */
  videos?: Promise<SliceReceipt | null>;
}) {
  const router = useRouter();
  const [fresh, setFresh] = useState<ChannelData>();
  const channel = fresh ?? served;
  const watchChat = useWatchChat(Boolean(served.stream));
  const chatOpen = watchChat.open;
  const [unlistedArchive, setUnlistedArchive] = useState<{ login: string; masterUrl: string } | null>(null);
  const [watchingArchive, setWatchingArchive] = useState(false);
  const stream = channel.stream;
  const masterUrl = `/api/live/master.m3u8?channel=${encodeURIComponent(channel.login)}`;
  const listedArchiveId = stream?.archiveVideo?.id;
  const archiveUrl = unlistedArchive?.login === channel.login ? unlistedArchive.masterUrl : null;
  const showingArchive = watchingArchive && Boolean(archiveUrl);
  const listening = useListening(true);
  // Listening to live reads the master once to find its audio-only stream; the archive has its own audio mode.
  const livePlan = useHlsListeningPlan(masterUrl, Boolean(stream) && listening.listening && !showingArchive);
  // A listening source that fails falls back to the full source, still behind the cover.
  const [listeningFailed, setListeningFailed] = useState<string | null>(null);
  const fullSource = showingArchive && archiveUrl ? archiveUrl : masterUrl;
  const listeningSource = !listening.listening ? null : showingArchive && archiveUrl ? `${archiveUrl}&mode=audio`
    : livePlan.status === "ready" && livePlan.plan.kind !== "unavailable" ? livePlan.plan.url
    : livePlan.status === "failed" || livePlan.status === "ready" ? fullSource : null;
  const playerSource = !listening.listening ? fullSource : listeningSource === listeningFailed ? fullSource : listeningSource;
  const listeningNote = describeListeningPlan(showingArchive ? { kind: "audio", url: "" } : livePlan.plan);

  useEffect(() => {
    if (!revalidate) return;
    const controller = new AbortController();
    fetch(`/api/channel/resolve?channel=${encodeURIComponent(served.login)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      // Only a change of broadcast is worth redrawing the page for.
      .then((data: ChannelData | null) => { if (data?.login === served.login && data.stream?.id !== served.stream?.id) setFresh(data); })
      .catch(() => {});
    return () => controller.abort();
  }, [revalidate, served.login, served.stream?.id]);

  useEffect(() => {
    if (!stream || listedArchiveId) return;
    const controller = new AbortController();
    fetch(`/api/live/archive?channel=${encodeURIComponent(channel.login)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { masterUrl: string | null } | null) => { if (data?.masterUrl) setUnlistedArchive({ login: channel.login, masterUrl: data.masterUrl }); })
      .catch(() => {});
    return () => controller.abort();
  }, [channel.login, listedArchiveId, stream]);
  const toggleChat = watchChat.toggle;
  const closeChat = () => {
    watchChat.close();
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".still-watch-rail [aria-controls='watch-chat'], [aria-controls='channel-chat']")?.focus();
    });
  };
  const chat = <ChatPanel idle={!watchChat.started} channel={channel.login} onClose={closeChat} />;

  return (
    <div className={`media-content still-channel-page ${stream ? "still-watch" : ""} relative pb-8`}>
      {stream && <WatchLayout chatOpen={chatOpen} chatState={watchChat.state}
        video={playerSource ? <Player key={showingArchive ? "archive" : "live"} src={playerSource} isLive dvrMode={showingArchive} title={stream.title} subtitle={channel.displayName}
          audioOnly={listening.listening} onAudioOnlyChange={enabled => listening.setMode(enabled ? "audio" : "video")} listeningNote={listeningNote}
          cover={channel.profileImageURL} artwork={listening.listening ? channel.profileImageURL : undefined}
          onMediaError={() => { if (listening.listening && listeningSource && playerSource === listeningSource) setListeningFailed(listeningSource); }}
          chatOpen={chatOpen} onChatToggle={toggleChat} /> : <div className="stage-frame still-stage-frame"><div className="stage w-full" role="status" aria-label="Loading audio" /></div>}
        rail={<WatchRail channel={channel.login} displayName={channel.displayName} image={channel.profileImageURL} verified={channel.roles?.isPartner === true} broadcastType="Live" actions={[
          <button key="chat" type="button" className="still-rail-action" onClick={toggleChat} aria-label={chatOpen ? "Hide chat" : "Show chat"} aria-expanded={chatOpen} aria-controls="watch-chat"><ChatCircle size={21} /></button>,
          ...(listedArchiveId ? [<button key="archive" type="button" className="still-rail-action" onClick={() => router.push(buildVodPath(listedArchiveId))} aria-label="Open archive"><VideoCamera size={21} /></button>]
            : archiveUrl ? [<button key="archive" type="button" className="still-rail-action" onClick={() => setWatchingArchive((watching) => !watching)} aria-label={showingArchive ? "Back to live" : "Open archive"}>
              {showingArchive ? <Broadcast size={21} /> : <VideoCamera size={21} />}</button>] : []),
        ]} />}
        chat={chat}
      ><div className="still-watch-details"><VodInfo channel={channel.login} channelDisplayName={channel.displayName} channelProfileImageURL={channel.profileImageURL} title={stream.title} broadcastType="live" isLive titleOnly titleAs="h2" category={stream.game?.name} /></div></WatchLayout>}
      <ChannelProfile channel={channel} videos={videos} actions={!stream && <Button variant="secondary" onClick={toggleChat} aria-expanded={chatOpen} aria-controls="channel-chat"><ChatCircle weight="regular" size={17} />{chatOpen ? "Hide chat" : "Show chat"}</Button>}>
        {!stream && chatOpen && <div id="channel-chat" className="still-standalone-chat">{chat}</div>}
      </ChannelProfile>
      <Footer />
    </div>
  );
}
