# @phantom/ui

## 0.4.0

### Minor Changes

- cdf60df: Add listening mode. `@phantom/ui` gains a source-agnostic audio-only layer: `planHlsListening` picks the cheapest stream that still carries the sound from any HLS master (an audio-only variant, an alternate audio rendition, or the smallest picture), `pickListeningFile` does the same for file sources, `useListening` remembers the choice in the browser, `useAudioEnhancement` adds voice boost and mono through Web Audio without ever leaving the player silent, and `ListeningStage`, `ListeningControl` and `listeningSettingsSections` give every player the same cover, toolbar switch and settings rows. Still uses it for live streams, live rewind, VODs and clips: live listening plays Twitch's 160 kb/s audio rendition instead of up to 6 Mb/s of video, the toolbar has an audio-only switch, and on iPhone live listening keeps playing with the screen locked.
- ef80b46: Phantom Stream can play films and episodes as audio only. The choice lives in the player engines, so it survives source failover and recovery. An HLS source with an audio-only stream (an audio-only variant, or an audio rendition in the chosen language) is attached again on it from the same moment. HLS or DASH without one holds the picture at its cheapest rendition behind the poster. `@phantom/ui` adds `planLowestRung` for an engine's own bitrate ladder, gives audio plans their rendition's language, and `ListeningStage` takes a portrait shape for posters; `@phantom/theme` styles it.

### Patch Changes

- Prefer the requested regional audio language in listening mode before falling back to another variant of the same language.

## 0.3.0

### Minor Changes

- 9955e87: Show focus outlines throughout Still and Stream only after Tab navigation, clearing them on pointer interaction; typing and playback shortcuts do not enable them.

### Patch Changes

- 2278bc8: Fix the player settings sheet collapsing to a sliver: it now attaches to the player frame once its options load, and in a narrow player beside chat the settings and sleep timer sheets use the frame's full height.
- 1937ee3: Redesign playback controls as a compact charcoal surface consistent with the watch page. Choreograph the control reveal and dismissal, transition between the shared playback icons and buffering state in place, and animate seeking directionally. Use Phosphor return arrows at 95% of the standard icon size for seeking, with the 10-second interval in their tooltips and accessible labels. Keep seek icons mounted and visible, and replay directional feedback on every click or keyboard seek from the current animation position. Keep controls centered and respect reduced motion.

## 0.2.0

### Minor Changes

- 9d37de9: BREAKING: Replace the liquid sleep timer picker with a standard sheet; `SleepTimerPicker` is now controlled through `open` and `onOpenChange`, and the `stage-sleep-liquid` styles are gone.
  
  Add scrub bar previews (`preview`, `onPreview`) with a muted-audio marker in the tooltip, a `small` search field size with an optional submit button and verified badges in results, a `quiet` select variant, and `loading`/`decoding` hints on artwork.
