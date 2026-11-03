export interface PlaybackEnvironment {
  /** The page has the classic MediaSource, which desktops and iPads offer. */
  mediaSource: boolean;
  /** The page has only Apple's ManagedMediaSource, as iPhone Safari does. */
  managedMediaSource: boolean;
  /** The video element plays HLS on its own. */
  nativeHls: boolean;
}

export function playbackEnvironment(video: HTMLVideoElement): PlaybackEnvironment {
  return {
    mediaSource: typeof window !== "undefined" && "MediaSource" in window,
    managedMediaSource: typeof window !== "undefined" && "ManagedMediaSource" in window,
    nativeHls: video.canPlayType("application/vnd.apple.mpegurl") !== "",
  };
}

/**
 * Recordings on iPhone play through Safari's own HLS. Its ManagedMediaSource stops buffering once the page
 * leaves the foreground, which silences audio-only playback, and long seeks can leave the picture behind the
 * clock. Live keeps hls.js, whose loader and latency control the native player cannot offer.
 */
export function prefersNativeHls(environment: PlaybackEnvironment, live: boolean) {
  return !live && environment.nativeHls && environment.managedMediaSource && !environment.mediaSource;
}
