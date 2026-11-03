"use client";

import { useEffect, useEffectEvent } from "react";
import type { RefObject } from "react";
import { PLAYER_SEEK_SECONDS } from "@phantom/ui";

interface SessionOptions {
  title: string;
  artist?: string;
  artwork?: string;
  /** Seeking applies to the whole recording; a live stream without a timeline offers play and pause only. */
  seekable: boolean;
  onSeek: (time: number) => void;
}

function setAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  // Browsers throw for actions they do not know.
  try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
}

/** Lock screen, notification and hardware media keys drive the same video as the toolbar. */
export function useMediaSession(videoRef: RefObject<HTMLVideoElement | null>, { title, artist, artwork, seekable, onSeek }: SessionOptions) {
  const seek = useEffectEvent(onSeek);

  useEffect(() => {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const usable = artwork && !artwork.includes("/_404/");
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist: artist ?? "",
      artwork: usable ? [{ src: new URL(artwork, window.location.href).href, sizes: "1280x720", type: "image/jpeg" }] : [],
    });
    return () => { navigator.mediaSession.metadata = null; };
  }, [title, artist, artwork]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const publishPosition = () => {
      session.playbackState = video.paused ? "paused" : "playing";
      if (!seekable || !session.setPositionState) return;
      const { duration, currentTime, playbackRate } = video;
      try {
        if (Number.isFinite(duration) && duration > 0 && playbackRate > 0) {
          session.setPositionState({ duration, playbackRate, position: Math.max(0, Math.min(currentTime, duration)) });
        } else {
          session.setPositionState();
        }
      } catch {}
    };
    // The lock screen keeps running while the page is hidden, where animation frames never arrive, so seeks land directly.
    const seekTo = (time: number) => {
      const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
      const target = Math.max(0, Math.min(time, end));
      video.currentTime = target;
      seek(target);
      publishPosition();
    };
    setAction("play", () => { void video.play().catch(() => {}); });
    setAction("pause", () => video.pause());
    setAction("stop", () => video.pause());
    setAction("seekbackward", seekable ? details => seekTo(video.currentTime - (details.seekOffset ?? PLAYER_SEEK_SECONDS)) : null);
    setAction("seekforward", seekable ? details => seekTo(video.currentTime + (details.seekOffset ?? PLAYER_SEEK_SECONDS)) : null);
    setAction("seekto", seekable ? details => { if (details.seekTime !== undefined) seekTo(details.seekTime); } : null);
    const events = ["play", "pause", "seeked", "ratechange", "durationchange", "loadedmetadata"] as const;
    for (const event of events) video.addEventListener(event, publishPosition);
    publishPosition();
    return () => {
      for (const event of events) video.removeEventListener(event, publishPosition);
      for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"] as const) setAction(action, null);
      session.playbackState = "none";
      try { session.setPositionState?.(); } catch {}
    };
  }, [videoRef, seekable]);
}
