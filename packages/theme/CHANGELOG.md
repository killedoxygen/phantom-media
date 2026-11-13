# @phantom/theme

## 0.3.0

### Minor Changes

- cdf60df: Add listening mode. `@phantom/ui` gains a source-agnostic audio-only layer: `planHlsListening` picks the cheapest stream that still carries the sound from any HLS master (an audio-only variant, an alternate audio rendition, or the smallest picture), `pickListeningFile` does the same for file sources, `useListening` remembers the choice in the browser, `useAudioEnhancement` adds voice boost and mono through Web Audio without ever leaving the player silent, and `ListeningStage`, `ListeningControl` and `listeningSettingsSections` give every player the same cover, toolbar switch and settings rows. Still uses it for live streams, live rewind, VODs and clips: live listening plays Twitch's 160 kb/s audio rendition instead of up to 6 Mb/s of video, the toolbar has an audio-only switch, and on iPhone live listening keeps playing with the screen locked.
- ef80b46: Phantom Stream can play films and episodes as audio only. The choice lives in the player engines, so it survives source failover and recovery. An HLS source with an audio-only stream (an audio-only variant, or an audio rendition in the chosen language) is attached again on it from the same moment. HLS or DASH without one holds the picture at its cheapest rendition behind the poster. `@phantom/ui` adds `planLowestRung` for an engine's own bitrate ladder, gives audio plans their rendition's language, and `ListeningStage` takes a portrait shape for posters; `@phantom/theme` styles it.

## 0.2.2

### Patch Changes

- ca0468b: Carry the header scrim up behind the iPhone status bar. Safari draws the page above the viewport there, so scrolled content used to show through over the clock and battery, ending in a hard edge where the header began.

## 0.2.1

### Patch Changes

- 1937ee3: Redesign playback controls as a compact charcoal surface consistent with the watch page. Choreograph the control reveal and dismissal, transition between the shared playback icons and buffering state in place, and animate seeking directionally. Use Phosphor return arrows at 95% of the standard icon size for seeking, with the 10-second interval in their tooltips and accessible labels. Keep seek icons mounted and visible, and replay directional feedback on every click or keyboard seek from the current animation position. Keep controls centered and respect reduced motion.
- 9955e87: Show focus outlines throughout Still and Stream only after Tab navigation, clearing them on pointer interaction; typing and playback shortcuts do not enable them.
- 3a5762a: Give the video the page on windows narrower than 1400px. The player now runs the full width of the frame and as tall as the window under the header allows, with the title and the action bar beneath it, instead of always leaving room for a chat column beside it. Chat starts closed at those widths and connects only once it is opened; from 1400px it still opens beside the video. Action labels open above the bar when it runs under the video.

## 0.2.0

### Minor Changes

- 9d37de9: BREAKING: Replace the liquid sleep timer picker with a standard sheet; `SleepTimerPicker` is now controlled through `open` and `onOpenChange`, and the `stage-sleep-liquid` styles are gone.
  
  Add scrub bar previews (`preview`, `onPreview`) with a muted-audio marker in the tooltip, a `small` search field size with an optional submit button and verified badges in results, a `quiet` select variant, and `loading`/`decoding` hints on artwork.
