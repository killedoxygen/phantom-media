# Phantom Stream

Search a film or a series, then let the app work through its sources until one
of them actually plays.

Part of the [Phantom monorepo](../../README.md). Install from the root.

## What it does

- Searches by title, IMDb link, TMDB URL, `movie:ID` or `tv:ID`. No API key
  and no account are involved at any point.
- Reads artwork, ratings, synopses and the full episode listing from Cinemeta
  in a single request, which is also where the TMDB id the resolver needs
  comes from. Wikidata bridges the identifiers on the rare title that lacks it.
- Starts routing the moment the page opens and verifies what the active source
  returned before handing it to the native player.
- Prefers 1080p and above when ranking what a source offers, because the
  difference is plain to see and half a second of extra latency is not.
- Reports what it learned about every source it asked, so picking one by hand
  is an informed choice rather than a guess.
- Hands off to the next source when one stalls mid-play, rather than dropping
  you back to a dead player.
- Remembers where you stopped, per episode, and resumes there.

## Routes

| Route              | What it serves                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| `/`                | Browse: a featured title over rails of popular and highly rated films and series. |
| `/search?q=`       | Results grid.                                                               |
| `/watchlist`        | Locally saved films and series, newest saved first. |
| `/watch/:type/:id` | Player and episode list. `:type` is `movie` or `tv`, `:id` is an IMDb id (a TMDB id still resolves). TV URLs accept `?season=5&episode=2` and keep the selection in browser history. |

Watchlist bookmarks are available on posters, the featured title, and title details.
The list stores display metadata in `localStorage` under `phantom-stream:watchlist:v1`,
updates across tabs, and requires no account or backend. It belongs to the current
browser and origin; clearing site data removes it. Storage failures are shown in
the header without pretending a change was saved.

On mobile, the header stays in one row with the brand, search, and watchlist.
Opening search replaces that row with a search field and a back button.

## Type

Labels, kickers and status words are set in the display face with tracking
through `.eyebrow` in the theme, not in the monospace one. Monospace is reserved for
figures that have to line up or be read exactly: timecodes, ratings, bitrates,
episode numbers.

Metadata rows use spacing, and genres are tags rather than a punctuated list.

## Surface

This app runs on the cinema surface defined by `@phantom/theme/cinema.css`, which
re-points the theme's own variables to ink. Same accent, same type, same radii
as the paper apps; nothing else in the system has to know which one it is on. A
paper ground would have sat in front of the thing you came to look at.

## Sources

Upstream identifies each playback source by a short code and labels it with a
third party's brand. This app keeps the codes, because the API needs them, and
replaces every label with a fixed in-house alias from `Source 01` through
`Source 30`. Retired and unconfigured slots remain hidden. The mapping lives in
`src/source-ids.mjs` and is the only place
those names are decided, so no third-party brand reaches a response body, a
screen or a log line. The aliases are positional and the order never changes,
which keeps `Source 07` meaning the same thing between sessions. That last part
is why the id list is append-only: inserting one renumbers every alias after it.

### Retiring one

Add its code to `RETIRED_SOURCE_IDS` with the reason beside it. Nothing is
deleted from `SOURCE_IDS`. The alias *is* the index, so removing an entry
would slide every source after it up a number and quietly change what a
persisted score, a debug log or a support conversation from last week refers
to. The retired code stays known forever and stops resolving: no descriptor, no
registry entry, no roster row, and a 400 from the route if something asks for
it by name.

`normalizeVariants` in `src/providers/normalize.mjs` is the only function that
can mint a candidate, and it stamps identity from the catalog while discarding
whatever the provider supplied for those fields. `test/providers.test.mjs`
asserts that no upstream name survives it, which makes the rule a build gate
rather than something each new provider has to remember.

### Adding one

- **A browser-direct source.** Append its two-character code to `SOURCE_IDS`
  and `ACTIVE_SOURCE_IDS` in `src/source-ids.mjs`. Verify that every playlist,
  segment, and audio track loads in the browser without a Phantom media route.
  Then append `{ id, kind }` to `DECLARED` in
  `src/providers/catalog.mjs`, write `src/providers/<kind>.mjs` exporting
  `create<Kind>Resolver(id)`, and add one line to `RESOLVERS` in
  `registry.mjs`. Resolvers are keyed by kind, so more sources of a kind that
  already works cost nothing. The whole contract:

  ```js
  async (media, { signal, fresh }) => ({
    candidates: normalizeVariants(rawVariants, id),
    subtitles: [],
    latencyMs: number,
  })
  ```

  Errors throw a `RelayError` shape: `{ status, retryable, retryAfterMs }`. A
  provider never names itself and never scores itself.

### Native playback only

Production sources must resolve to HLS, DASH or MP4 that Phantom can attach to
its own player. Wrapper pages and third-party iframes are not playback
candidates: they can navigate to advertising or unrelated landing pages, hide
their real failure state, and bypass the app's language and recovery policy.

Sources 19 through 27 remain reserved so historical aliases never shift, but
their embed-only implementations are retired. Research against those providers
can return one to production only after it establishes a reproducible public
native-media contract. Duplicate native routes remain useful; shared
failure-domain fingerprints serialize them instead of deleting a route that
may work better for a particular title or region.

Sources 29 and 31 are active. Source 29 follows VixSrc's public episode lookup to a native
HLS playlist, checks the playlist before offering it, and plays media directly
from VixSrc in the browser. Source 31 follows VidZee's episode lookup to a
browser-readable HLS playlist on an independent CDN. Some of its transport
streams contain multiple embedded audio tracks; the browser reorders the
program map to select English when requested. The resolver fetches only API
data and the playlist, while the viewer fetches all video segments directly.
Sources 28 (CineSrc) and 30 (VidNest) require video
to pass through Phantom and are retired. Source 04 was retired after Videasy's
September 2026 shutdown. Historical aliases remain stable, but inactive
providers cannot be selected or raced. The media proxy routes have been removed
so the app cannot transfer video for these providers.

## Routing

Sources are raced, not tried in turn, and the race is decided by what each one
actually produced rather than by which answered first. A fast source holding a
480p file should not beat a slower one holding 1080p.

- Five at a time, narrowing to two after a rate limit and climbing back one per
  clean race. One request here is one request upstream, and a single 429 arms a
  cooldown that affects every source on the isolate. Sources that share a
  control plane or media-host fingerprint never occupy independent race slots
  at the same time.
- Seven seconds per source, end to end: five for the scrape and one round of
  manifest probing after it. The sum is the number that matters, because a slot
  is the scarcest thing in the race. Every source still queued is waiting
  behind whoever holds one.
- **A request the router walks away from is not a failure.** When one source
  wins, its four siblings are aborted; those aborts used to reach the server as
  errors and cool the source that was serving them, so every *successful* race
  benched the four it had abandoned. The pool outlives the page, so the next
  load raced without them. This caused the minute-long waits.
- An offer that is already excellent, such as a **verified** 1080p or adaptive
  master, goes on screen immediately. Anything less is held for up to 1.2s,
  capped at 4s from the start of the race, to see whether something better is close
  behind. A stream that merely *claims* 1080p has proven nothing; only a
  manifest that answered counts.
- Attaching runs alongside collection instead of blocking it, so a source that
  fails to start costs the element and nothing else.
- Picking a source by hand pins it. The router will not quietly play a
  different one; a pinned source that dies gets one retry and then says so.
  **Automatic** at the top of the list is the way back.

### Scoring

`src/source-score.mjs` turns one race against one source into a reward in
`[0,1]`. Half comes from producing a playable stream at all, 0.3 from
resolution and 0.2 from speed. Half is taken back if the stream dies within
thirty seconds of attaching. The reward is folded into a running mean whose
weight decays with wall-clock age.

Records are kept per source and per source-and-season; the global record is the
prior that per-title evidence shifts, so a title that loads cleanly from one
source bends *that title* toward it while everything unmeasured still follows
the general record.

A rate limit records nothing, because the upstream cooldown is process-wide and
whichever source was in flight is not the one at fault. New sources start with
an optimistic prior and the last slot of the first wave is reserved for the
least-measured one, so nothing gets buried by two unlucky attempts.

Scores live in `localStorage` behind a two-method synchronous transport
(`lib/source-score.ts`), so they are per-device today and a shared store is a
drop-in later. The `{v, w, t}` records merge as weighted means, which would
allow voting from other sessions without a schema change.

## Subtitles

Whatever the playback source returned, merged with the keyless OpenSubtitles
addon (`opensubtitles-v3.strem.io`, keyed on IMDb ids). OpenSubtitles' own REST
API is not used here.

Set `SUBDL_API_KEY` as a server-only environment variable to enable the optional
Spanish fallback. Keep local keys in `apps/stream/.env.local` (gitignored), and
configure the same variable in the deployment's secret settings. No public key
is needed. SubDL is queried only when the OpenSubtitles result lacks Spanish;
searches use Next's four-hour data cache. Provider failures preserve existing
tracks. Search matches IMDb and exact season/episode, and only individual raw
subtitle files are offered (no archive extraction). Returned API-key query
parameters are stripped before tracks reach the browser. Downloads happen when
selected and converted responses have public cache headers. Actual shared cache
behavior depends on the deployment adapter. Anonymous download quotas still apply.

Catalogue subtitles are fetched through `/api/subtitles/file`, which converts
SubRip and ASS/SSA dialogue to WebVTT, decodes legacy encodings, and serves same-origin.
ASS positioning, drawings, and advanced styling are not preserved. Same-origin
delivery matters: a `<track>` on
a `crossOrigin="anonymous"` video fails
silently against any host without CORS headers, which is most of them, and
silently is the worst way for a subtitle to fail. The route is restricted to
the catalogue's own hosts. Without an allowlist, an endpoint that fetches a URL
from a query string is an open proxy.

Cues are painted by the player rather than by the browser, which is the only way
they can be sized, given a backdrop, and moved clear of the controls. Files are
still parsed by the browser's own WebVTT parser (`getCueAsHTML`), so no
third-party text file is ever treated as markup.

## The player

Built here rather than pulled in, because the source-routing behaviour above
has to reach into attachment and failure handling.

- Two gradient bands sharing one idle timer, so the picture is framed rather
  than having one heavy strip along the bottom. The top one carries what is
  playing, which in fullscreen is otherwise nowhere on screen.
- Scrub bar with buffered ranges, hover preview and pointer dragging.
- One settings sheet for audio language, quality, speed, subtitles, subtitle
  appearance and the secondary source override.
- A quality menu of the stream's actual renditions, not of its URLs, with
  automatic switching that opens high rather than climbing up from 360p.
- While a race is running: a mark per source coloured by what it said, and a
  count. A spinner looks the same whether three sources have answered or none,
  which is what made a slow search feel like a stuck one.
- Audio language is a strict routing constraint: HLS and DASH manifests must
  prove that the selected language exists before playback can start, and the
  matching track is selected before `play()`. Unknown or mismatched audio is
  rejected instead of guessed. The language picker is built from reachable
  source manifests and the active player's real tracks; a language disappears
  when the sources advertising it are empty, unreachable or cooling.
- Volume, audio language, subtitle language, subtitle size and speed are
  remembered. The source override keeps stable Source numbers but orders
  verified/current entries first and shows green, orange, red or grey status
  indicators for availability.
- Audio only, like a podcast, from the headphones button or the audio sheet.
  An HLS source with an audio-only stream (an audio-only variant, or an audio
  rendition in the chosen language) is attached again on that stream from the
  same moment, so no picture is downloaded. Without one, HLS and DASH hold the
  picture at their cheapest rendition behind the poster, and a progressive file
  only hides it. The choice is remembered and applies through failover and
  recovery. Voice boost evens out quiet and loud speech and mono folds both
  channels into each ear, both through Web Audio, except on iPhone and iPad,
  where Web Audio would stop with the screen locked. There, listening to HLS
  uses Safari's own playback, which keeps going in the background.
- Resuming says so, dismissibly, with a way to start over. It used to seek
  silently.
- The full episode list inside the picture, so changing episode never means
  leaving what you are watching. It opens on what is playing and survives
  fullscreen, because it is part of the stage rather than part of the page.
- An "up next" card over the closing stretch, sized to the runtime rather than
  to a fixed number of seconds, and a cancellable countdown at the end rather
  than a jump nobody asked for.
- Chapter skipping only when the stream declares chapters. There
  is no public source of intro and credit timings for film and television: the
  services that offer "skip intro" generate those markers from the files they
  host, and the one open dataset (AniSkip) covers anime only. A fixed guess
  would be wrong for most of what it was applied to, so nothing is offered
  where nothing is known.
- Keyboard: <kbd>Space</kbd>/<kbd>K</kbd> play, <kbd>J</kbd>/<kbd>L</kbd> ten
  seconds, arrows to seek and set volume, <kbd>M</kbd> mute, <kbd>C</kbd>
  subtitles, <kbd>N</kbd> next episode, <kbd>E</kbd> episodes, <kbd>F</kbd>
  fullscreen, <kbd>&lt;</kbd>/<kbd>&gt;</kbd> speed,
  <kbd>0</kbd>–<kbd>9</kbd> to jump by tenths, <kbd>?</kbd> for the list.
- On a touch screen the picture is not a play button: a tap shows the controls
  and a double tap on either side seeks.
- Adaptive HLS through `hls.js`, native HLS where the browser has it, and
  progressive MP4 as the fallback.
- HLS fragment loads use the current bounded retry policy. If playback remains
  stuck, the player nudges a buffered decoder stall or restarts a starved load
  at the lowest automatic level, with a strict per-stall attempt limit.
- The playhead, the buffer, the hover preview and the auto-hiding chrome are
  written to the DOM directly rather than held in React state. Sixty frames a
  second of scrubbing costs sixty style writes, not sixty renders.

## Debugging a slow start

For a complete local trace, start the app with:

```sh
pnpm --filter @phantom/stream dev:debug
```

That is equivalent to `DEBUG=1 pnpm --filter @phantom/stream dev`. In
development, `DEBUG=1` enables both halves of the trace, prints server events
to stdout, and appends a combined redacted NDJSON stream to
`.debug/phantom-stream.ndjson`. Browser and server entries share a playback
trace id. Media tokens, credentials, encoded proxy targets and URL query
strings are removed before they reach disk. Set `STREAM_DEBUG_LOG` to override
the path.

Append `?debug=1` to any watch URL. The choice is remembered, which is the
point. A race that is slow once and fine the next four times is only ever
caught by an instrument that was already running.

Every timing the router has goes to the console and into a ring buffer of the
last two thousand events: when each slot opened, what each source was asked and
what it answered, every manifest probe with its host and latency, each step of
the race reducer with what it was holding and how long the window had left,
attachment and hls.js errors, and each score written. With the log on, requests
carry `x-phantom-debug: 1` and the resolve route answers with its own timings,
so an upstream that is slow can be told apart from a route that was queued.

```js
__phantom.help()      // the rest of the commands
__phantom.sources()   // a table of every source's progress this session
__phantom.summary()   // counts per channel and the twenty slowest spans
__phantom.copy()      // the whole buffer as JSON, onto the clipboard
__phantom.off()       // and stop
```

`STREAM_DEBUG=1` remains available for the server half only. Prefer `DEBUG=1`
when reproducing a player problem because it captures candidate eligibility,
source answers, manifest probes, language evidence, failure-domain cooldown
changes, attachment and the final race outcome in one file.

Switched off, the log costs one `if` per call site and allocates nothing.

## Local commands

Run these from the monorepo root:

```sh
pnpm --filter @phantom/stream dev
pnpm --filter @phantom/stream test        # scoring, routing policy, providers, subtitles, debug
pnpm --filter @phantom/stream typecheck
pnpm --filter @phantom/stream build
```

## Configuration

Copy `apps/stream/.env.example` to `apps/stream/.env.local`. Every value is
optional. Stremio entries must be public, unauthenticated HTTPS addon
manifests; authenticated or paid services are intentionally unsupported.

## Deployment

Build the Worker from the monorepo root and deploy it with Wrangler. Set the
canonical URL in both the build environment and the Worker. The custom domain
is supplied at deploy time so it does not appear in the public repository:

```sh
NEXT_PUBLIC_BASE_URL=https://your-host.example pnpm --filter @phantom/stream exec opennextjs-cloudflare build
pnpm --filter @phantom/stream exec wrangler deploy --domain your-host.example --var NEXT_PUBLIC_BASE_URL:https://your-host.example
```

Runtime secrets, including `SUBDL_API_KEY`, are stored in Worker secrets and
must never be committed to Git.

Cloudflare Builds deploys this Worker from the `deploy/stream` branch with
`/apps/stream` as its root. That branch only moves to a `@phantom/stream@<version>`
release, which is tagged once the commit has passed CI and built as a preview,
so pushes to `main` do not reach production.
The build installs the workspace dependencies and runs OpenNext; Wrangler then
deploys to the configured custom domain. Build caching is enabled and preview
builds are disabled. The Worker watches this app, shared packages, and workspace
dependency files, so changes confined to other apps do not rebuild it.

The old Dokploy `phantom-resolver` service is not part of the active playback
path and is not needed for a frontend-only deployment.

## Legal

Phantom Stream stores no media library and is affiliated with none of the
catalogs or playback providers it talks to. Media streams play directly from
third-party hosts in the browser.

`/disclaimer` states that in full: no stored media library, no affiliation,
authorized use only, no warranty, and a limitation of liability. It is linked
from the footer of every page.

Set `NEXT_PUBLIC_NOTICE_EMAIL` before deploying. Until it is set, the page
omits its infringement-reporting section, because a takedown route with no
address behind it is worse than none. A reachable takedown route is the
most useful thing on a page like this.
