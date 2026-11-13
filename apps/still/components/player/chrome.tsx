"use client";

import { ChatCircle, Monitor, Timer } from "@phosphor-icons/react/ssr";
import { ListeningControl, listeningSettingsSections, ScrubBar, SleepTimerPicker, StageChrome, StageControl, StageSettings, useSleepTimer } from "@phantom/ui";
import type { Listening, PlaybackSegment, SegmentAppearances, SettingsSection } from "@phantom/ui";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { formatTime } from "@/lib/format";
import type { MediaState } from "./use-media";
import type { HlsState } from "./use-hls";
import type { Captions } from "./use-captions";
import type { Timeline } from "./use-timeline";
import type { Display } from "./use-display";
import { SPEEDS } from "./use-controls";
import type { Controls } from "./use-controls";
import { useStoryboardPreview } from "@/components/previews/use-storyboard-preview";

export interface SourceSelection {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

interface ChromeProps {
  audioOnly: boolean;
  onAudioOnlyChange?: (enabled: boolean) => void;
  listeningNote?: string;
  listening: Listening;
  /** Voice boost and mono can run on this playback. */
  enhancement: boolean;
  sourceSelection?: SourceSelection;
  videoRef: RefObject<HTMLVideoElement | null>;
  title: string;
  isLive: boolean;
  chatOpen: boolean;
  onChatToggle?: () => void;
  segments: readonly PlaybackSegment[];
  segmentAppearances?: SegmentAppearances;
  storyboardUrl?: string;
  media: MediaState;
  hls: HlsState;
  captions: Captions;
  timeline: Timeline;
  display: Display;
  controls: Controls;
}

const FILLED_ICON = { weight: "fill" as const };

export function Chrome({ videoRef, title, isLive, chatOpen, onChatToggle, segments, segmentAppearances, storyboardUrl, audioOnly, onAudioOnlyChange, listeningNote, listening, enhancement, sourceSelection,
  media, hls, captions, timeline, display, controls }: ChromeProps) {
  const { playing, muted, volume, loading, currentTime, duration, speed, toggleMute, changeVolume } = media;
  const { levels, currentLevel } = hls;
  const { hasTimeline, useDvrTimeline, liveLag } = timeline;
  const { isFullscreen, pipSupported, togglePip } = display;
  const { togglePlay, toggleFullscreen, seekWithFeedback, showControls, changeSpeed,
    menu, changeMenu } = controls;
  const sleepTimer = useSleepTimer(videoRef);
  const { preview, onPreview } = useStoryboardPreview(storyboardUrl);
  const changeQuality = (level: number) => {
    hls.changeQuality(level);
    changeMenu(null);
  };
  const seekToLive = () => {
    if (useDvrTimeline) timeline.seekToLive();
    else hls.jumpToLive();
    showControls();
  };

  const settingsSections: SettingsSection[] = [
    ...listeningSettingsSections({
      listening: audioOnly, onListeningChange: onAudioOnlyChange, note: listeningNote,
      enhancement, voiceBoost: listening.voiceBoost, onVoiceBoostChange: listening.setVoiceBoost,
      mono: listening.mono, onMonoChange: listening.setMono,
      onChange: () => changeMenu(null),
    }),
    ...(!audioOnly && sourceSelection ? [{
      id: "quality", title: "Quality", options: sourceSelection.options, value: sourceSelection.value,
      onChange: (value: string) => { sourceSelection.onChange(value); changeMenu(null); },
    }] : !audioOnly && levels.length > 0 ? [{
      id: "quality",
      title: "Quality",
      options: [
        { value: "auto", label: "Automatic" },
        ...levels.map((level) => ({ value: String(level.index), label: level.name })),
      ],
      value: currentLevel === -1 ? "auto" : String(currentLevel),
      onChange: (value: string) => changeQuality(value === "auto" ? -1 : Number(value)),
      summary: currentLevel === -1 ? "Automatic" : levels.find((level) => level.index === currentLevel)?.name,
    }] : []),
    ...(captions.tracks.length > 0 ? [{
      id: "captions",
      title: "Captions",
      options: [
        { value: "off", label: "Off" },
        ...captions.tracks.map((track) => ({ value: track, label: captions.tracks.length === 1 ? "On" : track })),
      ],
      value: captions.selected ?? "off",
      onChange: (value: string) => { captions.select(value === "off" ? null : value); changeMenu(null); },
      summary: captions.selected === null ? "Off" : captions.tracks.length === 1 ? "On" : captions.selected,
    }] : []),
    ...(!isLive ? [{
      id: "speed",
      title: "Playback speed",
      options: SPEEDS.map((value) => ({ value: String(value), label: value === 1 ? "Normal" : `${value}×` })),
      value: String(speed),
      onChange: (value: string) => changeSpeed(Number(value)),
      summary: speed === 1 ? "Normal" : `${speed}×`,
    }] : []),
  ];

  return <PlayerControls
    ready={hasTimeline || !loading}
    title={title}
    playing={playing}
    muted={muted}
    volume={volume}
    fullscreen={isFullscreen}
    onTogglePlay={togglePlay}
    onToggleMute={toggleMute}
    onVolumeChange={changeVolume}
    onToggleFullscreen={toggleFullscreen}
    timeline={hasTimeline ? (
      <ScrubBar
        segments={segments}
        segmentAppearances={segmentAppearances}
        timelineStart={timeline.timelineStart}
        onSeekStep={seekWithFeedback}
        subscribe={timeline.subscribe}
        onSeek={timeline.seek}
        onScrubbingChange={(scrubbing) => { if (scrubbing) showControls(); }}
        preview={preview}
        onPreview={onPreview}
      />
    ) : undefined}
    clock={{ live: isLive, rewindable: useDvrTimeline, lag: liveLag, behind: hls.behindLive, currentTime, duration }}
    onSeekToLive={seekToLive}
    sleep={sleepTimer}
    menu={menu}
    onMenuChange={changeMenu}
    chatOpen={chatOpen}
    onChatToggle={onChatToggle && !isFullscreen ? onChatToggle : undefined}
    settings={settingsSections}
    listening={onAudioOnlyChange ? { active: audioOnly, onChange: onAudioOnlyChange } : undefined}
    actions={pipSupported && !audioOnly ? [{ label: "Picture in picture", icon: <Monitor {...FILLED_ICON} size={20} />, onClick: togglePip }] : []}
  />;
}

/** Where playback stands, as the toolbar words it. */
export interface PlayerClock {
  live: boolean;
  /** A live broadcast played from its growing archive, so it has a timeline that ends at the live edge. */
  rewindable: boolean;
  lag: number;
  behind: boolean;
  currentTime: number;
  duration: number;
}

type PlayerMenu = "settings" | "sleep" | null;

/**
 * The player's toolbar, from plain values. Chrome fills it from a playing video; the welcome tour fills it from a
 * script, which is why nothing here reaches for the video itself.
 */
export function PlayerControls({ ready, title, playing, muted, volume, fullscreen, onTogglePlay, onToggleMute, onVolumeChange, onToggleFullscreen,
  timeline, clock, onSeekToLive, sleep, menu, onMenuChange, chatOpen, onChatToggle, settings, listening, actions }: {
  ready: boolean;
  title: string;
  playing: boolean;
  muted: boolean;
  volume: number;
  fullscreen: boolean;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
  timeline?: ReactNode;
  clock: PlayerClock;
  onSeekToLive: () => void;
  sleep: Pick<ReturnType<typeof useSleepTimer>, "minutes" | "minutesLeft" | "setMinutes">;
  menu: PlayerMenu;
  onMenuChange: (menu: PlayerMenu) => void;
  chatOpen: boolean;
  onChatToggle?: () => void;
  settings: SettingsSection[];
  /** The toolbar's audio-only switch, when the source can be listened to. */
  listening?: { active: boolean; onChange: (active: boolean) => void };
  actions: ComponentProps<typeof StageSettings>["actions"];
}) {
  return (
    <>
      <StageChrome
        ready={ready}
        title={title}
        playing={playing}
        muted={muted}
        volume={volume}
        fullscreen={fullscreen}
        onTogglePlay={onTogglePlay}
        onToggleMute={onToggleMute}
        onVolumeChange={onVolumeChange}
        onToggleFullscreen={onToggleFullscreen}
        timeline={timeline}
        timecode={
          <p className="stage-timecode">
            {clock.live && !clock.rewindable
              ? clock.behind ? "Behind live" : "Live"
              : <><span className="text-stage-text">{clock.rewindable ? `-${formatTime(clock.lag)}` : formatTime(clock.currentTime)}</span><span className="stage-duration"> / {clock.rewindable ? "Live" : formatTime(clock.duration)}</span></>}
          </p>
        }
        rightExtra={
          <>
            {/* A rewindable stream keeps the button's place at the live edge: narrow toolbars wrap around it, and would jump as it came and went. */}
            {(clock.rewindable || (clock.live && clock.behind)) && (
              <button type="button" onClick={onSeekToLive} disabled={clock.rewindable && clock.lag <= 3} className="stage-control stage-live-trigger min-w-11 text-[12px] font-medium disabled:invisible" aria-label="Jump to live">Live</button>
            )}
            {listening && <ListeningControl listening={listening.active} onChange={listening.onChange} />}
            <StageControl
              label={sleep.minutes === null ? "Sleep timer" : `Sleep timer, ${sleep.minutesLeft} minutes left`}
              onClick={() => onMenuChange(menu === "sleep" ? null : "sleep")}
              expanded={menu === "sleep"}
              className={`stage-sleep-trigger ${sleep.minutes !== null ? "stage-sleep-trigger-active" : ""}`}
            >
              <Timer {...FILLED_ICON} size={22} />
            </StageControl>
            {onChatToggle && <StageControl label={chatOpen ? "Hide chat" : "Show chat"} onClick={onChatToggle} expanded={chatOpen} className="stage-chat-trigger">
              <ChatCircle {...FILLED_ICON} size={22} />
            </StageControl>}
            <StageSettings
              sections={settings}
              open={menu === "settings"}
              onOpenChange={open => onMenuChange(open ? "settings" : null)}
              actions={actions}
            />
          </>
        }
      />
      <SleepTimerPicker
        open={menu === "sleep"}
        onOpenChange={open => onMenuChange(open ? "sleep" : null)}
        minutes={sleep.minutes}
        minutesLeft={sleep.minutesLeft}
        onChange={sleep.setMinutes}
      />
    </>
  );
}
