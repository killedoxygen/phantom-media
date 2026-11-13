---
"@phantom/ui": minor
"@phantom/theme": minor
"@phantom/stream": minor
---

Phantom Stream can play films and episodes as audio only. The choice lives in the player engines, so it survives source failover and recovery. An HLS source with an audio-only stream (an audio-only variant, or an audio rendition in the chosen language) is attached again on it from the same moment. HLS or DASH without one holds the picture at its cheapest rendition behind the poster. `@phantom/ui` adds `planLowestRung` for an engine's own bitrate ladder, gives audio plans their rendition's language, and `ListeningStage` takes a portrait shape for posters; `@phantom/theme` styles it.
