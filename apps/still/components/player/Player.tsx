"use client";

import { useEffect, useRef } from "react";
import { ListeningStage, StageTransport, useAudioEnhancement, useListening } from "@phantom/ui";
import type { PlaybackSegment, SegmentAppearances } from "@phantom/ui";
import { EMPTY_PLAYBACK_SEGMENTS } from "@phantom/ui/playback-segments";
import { Chrome } from "./chrome";
import type { SourceSelection } from "./chrome";
import { useMedia } from "./use-media";
import { useHls } from "./use-hls";
import { useTimeline } from "./use-timeline";
import { useDisplay } from "./use-display";
import { useControls } from "./use-controls";
import { useCaptions } from "./use-captions";
import { useMediaSession } from "./use-media-session";
import { ConnectionWarning } from "./ConnectionWarning";
import { PlayerStage } from "./PlayerStage";

interface PlayerProps {
  src: string;
  delivery?: "hls" | "file";
  /** Only the sound plays: the cover replaces the picture and picture-only controls step aside. */
  audioOnly?: boolean;
  /** Offered when the source can be listened to. The page picks the source, since that is where it lives. */
  onAudioOnlyChange?: (enabled: boolean) => void;
  /** What listening does for this source, shown with the audio-only switch. */
  listeningNote?: string;
  /** A square cover for listening, such as the channel image. Falls back to the artwork. */
  cover?: string;
  sourceSelection?: SourceSelection;
  onMediaError?: (kind: "network" | "media") => void;
  onVideoSize?: (source: string, width: number, height: number) => void;
  seekRequest?: { position: number; revision: number };
  storyboardUrl?: string;
  segments?: readonly PlaybackSegment[];
  segmentAppearances?: SegmentAppearances;
  startTime?: number;
  isLive?: boolean;
  dvrMode?: boolean;
  onTimeUpdate?: (time: number) => void;
  onPlaybackSeek?: () => void;
  title?: string;
  subtitle?: string;
  /** Shown beside the title on the lock screen and in media notifications. */
  artwork?: string;
  chatOpen?: boolean;
  onChatToggle?: () => void;
}

export function Player({ src, delivery = "hls", audioOnly = false, onAudioOnlyChange, listeningNote, cover, sourceSelection, seekRequest, storyboardUrl, onMediaError, onVideoSize, segments = EMPTY_PLAYBACK_SEGMENTS, segmentAppearances,
  startTime = 0, isLive = false, dvrMode = false, onTimeUpdate, onPlaybackSeek,
  title = "Twitch video", subtitle, artwork, chatOpen = false, onChatToggle }: PlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cuesRef = useRef<HTMLDivElement>(null);
  const media = useMedia({ videoRef, isLive, onTimeUpdate, onPlaybackSeek });
  const hls = useHls({ videoRef, src, delivery, audioOnly, startTime, isLive, dvrMode, media, onMediaError, onVideoSize });
  const { syncDisplayedTime } = media;
  useEffect(() => {
    if (seekRequest && videoRef.current) { videoRef.current.currentTime = seekRequest.position; syncDisplayedTime(seekRequest.position); }
  }, [seekRequest, syncDisplayedTime]);
  const timeline = useTimeline(media, isLive, dvrMode);
  const display = useDisplay(containerRef, videoRef);
  const captions = useCaptions(videoRef, cuesRef, src);
  const controls = useControls(videoRef, media, display, captions.toggle, timeline.canSeek);
  const listening = useListening();
  const enhancement = useAudioEnhancement(videoRef, { voiceBoost: listening.voiceBoost, mono: listening.mono, supported: hls.audioProcessing });
  useMediaSession(videoRef, { title, artist: subtitle, artwork, seekable: !isLive, onSeek: syncDisplayedTime });

  return (
    <PlayerStage ref={containerRef} title={title} subtitle={subtitle} idle={controls.idle} crowded={hls.connectionUnstable}
      onMouseMove={controls.showControls} onTouchStart={controls.showControls} onMouseLeave={controls.hideControls}
      picture={<>
        <video ref={videoRef} className="absolute inset-0" playsInline preload="metadata"
          controlsList="nodownload noremoteplayback" disablePictureInPicture={!display.pipSupported}
          onClick={controls.onVideoClick} onPointerDown={controls.onVideoPointerDown} />
        {audioOnly && <ListeningStage artwork={cover ?? artwork} backdrop={artwork} playing={media.playing} />}
        <div ref={cuesRef} className="stage-cues stage-cues-backdrop" />
      </>}>
      {hls.connectionUnstable && <ConnectionWarning />}
      {hls.error && <div role="alert" className="absolute inset-x-0 top-1/3 z-10 bg-black/80 p-4 text-center text-white">{hls.error}</div>}
      <StageTransport playing={media.playing} feedback={controls.feedback} waiting={media.loading}
        onTogglePlay={controls.togglePlay}
        onSeekBack={timeline.canSeek ? () => controls.seekWithFeedback(-1) : undefined}
        onSeekForward={timeline.canSeek ? () => controls.seekWithFeedback(1) : undefined} />
      <Chrome videoRef={videoRef} title={title} isLive={isLive} chatOpen={chatOpen}
        onChatToggle={onChatToggle} audioOnly={audioOnly} onAudioOnlyChange={onAudioOnlyChange} listeningNote={listeningNote} listening={listening} enhancement={enhancement.available} sourceSelection={sourceSelection} segments={segments} segmentAppearances={segmentAppearances} storyboardUrl={storyboardUrl}
        media={media} hls={hls} captions={captions} timeline={timeline} display={display} controls={controls} />
    </PlayerStage>
  );
}
