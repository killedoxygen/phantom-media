# @phantom/still

## 0.4.0

### Minor Changes

- cdf60df: Add listening mode. `@phantom/ui` gains a source-agnostic audio-only layer: `planHlsListening` picks the cheapest stream that still carries the sound from any HLS master (an audio-only variant, an alternate audio rendition, or the smallest picture), `pickListeningFile` does the same for file sources, `useListening` remembers the choice in the browser, `useAudioEnhancement` adds voice boost and mono through Web Audio without ever leaving the player silent, and `ListeningStage`, `ListeningControl` and `listeningSettingsSections` give every player the same cover, toolbar switch and settings rows. Still uses it for live streams, live rewind, VODs and clips: live listening plays Twitch's 160 kb/s audio rendition instead of up to 6 Mb/s of video, the toolbar has an audio-only switch, and on iPhone live listening keeps playing with the screen locked.

### Patch Changes

- 4747bb1: Play recordings on iPhone through Safari's own HLS so seeks land on the right picture and audio-only keeps playing with the screen locked. Resumed recordings start loading at the resume point. A tap on the video shows or hides the controls on touch screens, and a double tap on either side skips 10 seconds. Lock screen and media keys show the title, channel and thumbnail, and can seek. The resume point is saved every few seconds instead of on every tick.
- Updated dependencies
- Updated dependencies [cdf60df]
- Updated dependencies [ef80b46]
  - @phantom/ui@0.4.0
  - @phantom/theme@0.3.0

## 0.3.3

### Patch Changes

- 5afc47c: Fix live buffering and unavailable-media failures caused by Twitch fMP4 prefetch URLs changing on completion and progressive chunks resetting timestamps. Preserve progressive playback and manual quality, use smaller batches and faster buffer checks, and retain a bounded fallback for unsupported predictive sequences.

## 0.3.2

### Patch Changes

- 0ea0c16: Show channel polls in chat. Live chat pins the running poll above the messages with each choice's share, a countdown and the final result. The replay of a broadcast that is still on air places the polls seen during the session at their moment in the recording.

## 0.3.1

### Patch Changes

- b6e932e: Give the welcome tour a warmer voice and a steadier pace. The mascot says what Still is before it starts, talks in plain spoken sentences, and leads from each feature into the next with a line or a quiet moment instead of jumping. It reacts to what happens on screen, narrowing its eyes at an ad break or a lock and hopping when it has dealt with one. The whole view blinks like an eye when it talks about looking away. The tour now watches a stream of its own, a small drawn game of hoops on a made-up channel, in place of a frozen thumbnail of whoever was live: one shot goes in while your eyes are shut, and the rewind runs the stream backwards to show it. It no longer waits on the home feed or shows a real channel under an ad break or a lock. The locked video is its own joke: three hours of Still staring at a toaster. Skip no longer cuts: wherever it is pressed, what is on screen fades away and the mascot settles into the header first.
- Updated dependencies [ca0468b]
  - @phantom/theme@0.2.2

## 0.3.0

### Minor Changes

- 3b8d880: Show broadcaster captions during live and VOD playback. When a stream carries captions, the player settings gain a Captions choice and the C key turns them on or off, and the choice is remembered.
- fdebc02: BREAKING: Remove the extension catalog: the navbar menu, the static file export and both `/api/extensions` routes are gone.
- 2bdeb62: Rename the product to Still with an original SVG resting-face icon and wordmark, matching app icons and social card. Move the Phantom mark into a Phantom Media footer signature and update public product copy and metadata. Rename the workspace package and release tags to `@phantom/still` while preserving existing deployment coordinates and browser storage compatibility.
- 130d15a: Greet first-time visitors on the home page: the Still mascot wakes up full screen, says hello and settles into the navbar logo, then leaves it to pitch Still on the real pages. It names each Twitch frustration and works the search and the watch page itself to show the answer (Twitch's ad break thrown off the stream, a live stream dragged back, a pasted link to a subscriber-only video unlocking), with each line given time to be read, and hands the home page back. Skippable throughout and shown once per browser. The player toolbar no longer jumps on narrow screens when the Live button appears on a rewindable stream.
- 724744d: Rebuild categories as a directory: `/categories` lists the most watched categories with a carousel of top streams for each of the leading three, the header search now suggests categories and forgives typos, and each category page opens on a Live tab with sort and language filters ahead of Videos and Clips.
- f0cefef: BREAKING: Replace the watch history page with a panel that opens from the header on any page. It lists what you watched, removes single entries or all of them with an undo, and can pause history so nothing you watch is saved. `/watch-history` no longer exists.

### Patch Changes

- 1e0c247: Switching tabs or filters in a catalog now fades the old list out and the new one in, and the page keeps its place when a shorter tab such as About replaces a longer one instead of jumping to its new end.
- f6aed02: Tidy the channel page's hierarchy: a stream or video title now wraps at the edge of the page instead of the edge of the player, a live stream shows its category under the title, the channel block under a player is set off as its own section, and the channel's name is the page title on its own page.
- 3e015dd: Derive permanent www redirects from NEXT_PUBLIC_BASE_URL and omit them when unconfigured.
- a4dee36: Restore live chat badges using Twitch's global and channel-specific badge artwork.
- 2278bc8: Fix the player settings sheet collapsing to a sliver: it now attaches to the player frame once its options load, and in a narrow player beside chat the settings and sleep timer sheets use the frame's full height.
- 1937ee3: Redesign playback controls as a compact charcoal surface consistent with the watch page. Choreograph the control reveal and dismissal, transition between the shared playback icons and buffering state in place, and animate seeking directionally. Use Phosphor return arrows at 95% of the standard icon size for seeking, with the 10-second interval in their tooltips and accessible labels. Keep seek icons mounted and visible, and replay directional feedback on every click or keyboard seek from the current animation position. Keep controls centered and respect reduced motion.
- 4fc21b2: Show a page-wide sleeping Still animation while channel, video, and clip pages load, including server navigation and client data fetching. Keep the eyes visible, animate breathing and rising Zs, and respect reduced-motion preferences. Use compact versions for chat loading and download preparation.
- 44e27f0: Show a quiet connection warning in the player when Twitch delivery is unstable, with a compact hint explaining possible connection issues and suggesting Automatic quality. Clear the warning after sustained stable playback.
- 20d7e45: Move the application to `apps/still` and use Still names for the stylesheet, UI selectors, transitions, and search component. Use domain names for app-level channel contracts and map Still explicitly to its existing production Worker and deploy branch. Cloudflare Builds must use `/apps/still` as its build root and watch the new app path.
- 6143922: Return live playback to the live edge on resume, including native HLS and resumes before metadata arrives. Use Automatic quality and a buffer-aware latency controller to recover drift, adapt safety headroom after stalls, preserve archive rewind, and show when playback is behind live.
- e8aadd4: Widen the navbar logo's eyes on hover and keyboard focus, holding the awake expression until the interaction ends. Preserve the sleepy idle animation and reduced-motion support.
- 0b00137: Request Twitch’s low-latency feed and progressively play upcoming segments with fallback to completed media. Forward low-latency playlist reload hints, protect encoder-paced transfers from misleading ABR estimates, retain recovery for genuinely slow delivery, and count predictive failures until buffering succeeds.
- 9955e87: Show focus outlines throughout Still and Stream only after Tab navigation, clearing them on pointer interaction; typing and playback shortcuts do not enable them.
- 3a5762a: Give the video the page on windows narrower than 1400px. The player now runs the full width of the frame and as tall as the window under the header allows, with the title and the action bar beneath it, instead of always leaving room for a chat column beside it. Chat starts closed at those widths and connects only once it is opened; from 1400px it still opens beside the video. Action labels open above the bar when it runs under the video.
- Updated dependencies [2278bc8]
- Updated dependencies [1937ee3]
- Updated dependencies [9955e87]
- Updated dependencies [3a5762a]
  - @phantom/ui@0.3.0
  - @phantom/theme@0.2.1

## 0.2.0

### Minor Changes

- 8eda975: BREAKING: Watch history and resume positions move to new storage keys. Existing local history is not migrated.
  
  Rebuild Twitch playback around separate metadata and media resolution. Add native clip playback with continuous MP4 downloads, audio-only listening, cancellable TS/MP4 downloads, category browsing, channel and category video and clip libraries, official chapters, storyboard previews, chat replay with badges, colors and emotes, sampled chat search, and an extensions panel.

### Patch Changes

- Updated dependencies [9d37de9]
  - @phantom/ui@0.2.0
  - @phantom/theme@0.2.0

## 0.1.1

### Patch Changes

- Release through the preview-gated deploy pipeline. No functional change.
