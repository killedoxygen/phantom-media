export interface PlaybackEnvironment {
  /** The page has the classic MediaSource, which desktops and iPads offer. */
  mediaSource: boolean;
  /** The page has only Apple's ManagedMediaSource, as iPhone Safari does. */
  managedMediaSource: boolean;
  /** The video element plays HLS on its own. */
  nativeHls: boolean;
  /** An iPhone or iPad, where the system suspends Web Audio once the screen locks. */
  mobileWebKit?: boolean;
}

export function playbackEnvironment(video: HTMLVideoElement): PlaybackEnvironment {
  const managedMediaSource = typeof window !== "undefined" && "ManagedMediaSource" in window;
  return {
    mediaSource: typeof window !== "undefined" && "MediaSource" in window,
    managedMediaSource,
    nativeHls: video.canPlayType("application/vnd.apple.mpegurl") !== "",
    mobileWebKit: managedMediaSource && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1,
  };
}

/**
 * Recordings on iPhone play through Safari's own HLS. Its ManagedMediaSource stops buffering once the page
 * leaves the foreground, which silences audio-only playback, and long seeks can leave the picture behind the
 * clock. Live keeps hls.js, whose loader and latency control the native player cannot offer, except while
 * listening: then the point is to keep playing with the screen locked.
 */
export function prefersNativeHls(environment: PlaybackEnvironment, live: boolean, listening = false) {
  return (!live || listening) && environment.nativeHls && environment.managedMediaSource && !environment.mediaSource;
}

/**
 * Voice boost and mono route the element through Web Audio. That needs media the page may read (Media Source
 * playback, or files served from this origin), and must not run where locking the screen suspends Web Audio.
 */
export function canProcessAudio(environment: PlaybackEnvironment, engine: "hls.js" | "native", delivery: "hls" | "file") {
  return !environment.mobileWebKit && (engine === "hls.js" || delivery === "file");
}
