---
"@phantom/ui": minor
"@phantom/theme": minor
"@phantom/still": minor
---

Add listening mode. `@phantom/ui` gains a source-agnostic audio-only layer: `planHlsListening` picks the cheapest stream that still carries the sound from any HLS master (an audio-only variant, an alternate audio rendition, or the smallest picture), `pickListeningFile` does the same for file sources, `useListening` remembers the choice in the browser, `useAudioEnhancement` adds voice boost and mono through Web Audio without ever leaving the player silent, and `ListeningStage`, `ListeningControl` and `listeningSettingsSections` give every player the same cover, toolbar switch and settings rows. Still uses it for live streams, live rewind, VODs and clips: live listening plays Twitch's 160 kb/s audio rendition instead of up to 6 Mb/s of video, the toolbar has an audio-only switch, and on iPhone live listening keeps playing with the screen locked.
