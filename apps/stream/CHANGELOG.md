# @phantom/stream

## 0.2.0

### Minor Changes

- ef80b46: Phantom Stream can play films and episodes as audio only. The choice lives in the player engines, so it survives source failover and recovery. An HLS source with an audio-only stream (an audio-only variant, or an audio rendition in the chosen language) is attached again on it from the same moment. HLS or DASH without one holds the picture at its cheapest rendition behind the poster. `@phantom/ui` adds `planLowestRung` for an engine's own bitrate ladder, gives audio plans their rendition's language, and `ListeningStage` takes a portrait shape for posters; `@phantom/theme` styles it.

### Patch Changes

- Updated dependencies
- Updated dependencies [cdf60df]
- Updated dependencies [ef80b46]
  - @phantom/ui@0.4.0
  - @phantom/theme@0.3.0

## 0.1.4

### Patch Changes

- Updated dependencies [ca0468b]
  - @phantom/theme@0.2.2

## 0.1.3

### Patch Changes

- 1937ee3: Redesign playback controls as a compact charcoal surface consistent with the watch page. Choreograph the control reveal and dismissal, transition between the shared playback icons and buffering state in place, and animate seeking directionally. Use Phosphor return arrows at 95% of the standard icon size for seeking, with the 10-second interval in their tooltips and accessible labels. Keep seek icons mounted and visible, and replay directional feedback on every click or keyboard seek from the current animation position. Keep controls centered and respect reduced motion.
- 9955e87: Show focus outlines throughout Still and Stream only after Tab navigation, clearing them on pointer interaction; typing and playback shortcuts do not enable them.
- Updated dependencies [2278bc8]
- Updated dependencies [1937ee3]
- Updated dependencies [9955e87]
- Updated dependencies [3a5762a]
  - @phantom/ui@0.3.0
  - @phantom/theme@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies [9d37de9]
  - @phantom/ui@0.2.0
  - @phantom/theme@0.2.0

## 0.1.1

### Patch Changes

- Release through the preview-gated deploy pipeline. No functional change.
