# Phantom Media

Free, open-source media tools, led by **Still**:
an ad-free alternative Twitch player for live streams, subscriber-only VODs,
and live rewind through broadcast archives. Watch without a Twitch account,
with no app analytics or tracking cookies.

[Still documentation](apps/still/README.md) and [local setup](#getting-set-up).

![Still playing an Overwatch broadcast with live chat in a minimal dark frame](docs/screenshots/still/still-player.webp)

## Still: watch on your terms

- **Ad-free Twitch playback:** live streams and past broadcasts without Twitch ad breaks.
- **Subscriber-only VODs:** play sub-only broadcasts without signing in when their source playlists are available.
- **Live rewind and seeking:** open the current broadcast’s archive to catch up while the channel is still live, when an archive is available.
- **More playback controls:** quality selection, playback speed, broadcaster captions, keyboard shortcuts, picture-in-picture, and VOD downloads.
- **Listen like a podcast:** audio-only mode for live streams, VODs and clips, with voice boost and mono audio, using a fraction of the data.
- **Live chat and VOD chat replay:** read chat alongside playback, with replay synchronized to pauses and seeks.
- **Account-free viewing:** no Twitch login, app analytics, or tracking cookies. History, resume positions, and preferences stay in your browser.

![Still's live stream discovery page in desktop and mobile mockups](docs/screenshots/still/still-discovery.webp)

Local testing at 720p measured **1.85–1.94 seconds of live delay**, with no
rebuffering after startup. [Playback results](apps/still/README.md#results).

Media availability depends on Twitch. Deleted or unavailable source media cannot
be recovered. Third-party media, chat, and hosting services still process network
requests; the app does not promise network anonymity or zero infrastructure logs.

Phantom Media also includes **Phantom Downloader**, for downloading videos and
playlists, and **Phantom Stream**, a film and series frontend. The three apps
share a design system and toolchain in this monorepo.

> **Work in progress.** The apps and their architecture are under active
> development; features and platform compatibility may change.

## Workspace

| Package                | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `apps/downloader`      | Phantom Downloader pulls a video or a whole playlist down as a file.    |
| `apps/stream`          | Phantom Stream finds a film or series and plays it.                     |
| `apps/still`          | Still: ad-free Twitch player, subscriber-only VODs, and live rewind.                            |
| `packages/theme`       | Design tokens, base layer and CSS primitives. Tailwind v4.              |
| `packages/ui`          | React components the apps share, consumed as source.                    |
| `packages/config`      | tsconfig, ESLint and PostCSS bases.                                     |

## Phantom tools

A Phantom tool does one job. That is the whole idea: a small, focused tool that
does its single thing well, rather than a growing suite that does everything
badly. This monorepo holds the tools that happen to share a design system and a
toolchain, and it is not otherwise a boundary. When a need appears that none of
the current tools serve, the answer is a new tool built alongside these ones
rather than another feature bolted onto an existing one.

The shared interest running through all of it is a free, open internet. That
means circumvention, bypasses, and keeping pace with platforms as they change
underneath you. There are walls that will not be climbed, and they do not get
climbed.

## Scope and roadmap

**Downloader** grows outward. Today it resolves and downloads YouTube; the goal
is inexpensive YouTube downloading plus Spotify, Twitch, and the other video and
audio platforms worth supporting. Twitch is already covered by Still,
so the work there is making the downloader the front door to it.

**Still** broadens into a fuller client than the channel and VOD player it is
today.

**Stream** narrows, on purpose. It is a stream frontend, and that is what it
stays: the sources are on their way out of this repository and the app is
heading toward being agnostic about where playback comes from. That is the
destination rather than the current state. The sources are still here, and the
app is still coupled to them.

## Getting set up

```sh
corepack enable
pnpm install
```

Node 22 or newer, pnpm 12.6.0. Everything else comes from the lockfile.

## Working on it

```sh
pnpm dev                              # all apps
pnpm --filter @phantom/stream dev     # just one
pnpm --filter @phantom/still dev     # Still only
pnpm check                            # typecheck, lint, test and build everything
pnpm deployment:check                 # Worker/OpenNext dry runs, no deployment
pnpm container:build:downloader       # real Downloader image build
```

Turborepo fans tasks out across the workspace and caches what has not changed,
so a second `pnpm check` on an untouched tree finishes in seconds.

Dev servers listen on `0.0.0.0`. From another device, open
`http://<development-machine-LAN-or-Tailscale-IP>:<port>` using the port printed
by Next.js. The dev origin allowlist includes the machine's interface addresses,
its hostname, `*.local` names, and Tailscale `**.ts.net` names. Hot reload supports
both `ws:` and `wss:` in development.

For custom DNS names, short Tailscale names that differ from the machine hostname,
or a container/VM whose interfaces do not include the host's address, add the
browser-facing hostnames or IP addresses explicitly:

```sh
PHANTOM_DEV_ORIGINS=devbox,192.168.1.50,dev.example.test pnpm dev
```

You can also set `PHANTOM_DEV_ORIGINS` in an app's `.env.local`. Entries are
comma-separated hostnames (no scheme or port); Next.js hostname wildcard patterns
are supported. Restart the dev servers after changing names or network interfaces.
These origin allowances apply to Next.js development resources; production CSP
and API CORS policies keep their existing behavior.

There is no dev server in the verification path on purpose: `pnpm check` is
what tells you the tree is sound.

## Versioning

Every app and package carries its own [SemVer](https://semver.org) version,
starting at `0.1.0`, and moves only through a changeset. A pull request that
touches a workspace needs one:

```sh
pnpm changeset                        # record which workspaces change, and how
pnpm release:version                  # apply pending changesets: bump + changelog
```

Committing that bump to `main` is the release. Tags are created for you, and
only once the commit has passed CI and built on Cloudflare.

The rules for choosing a bump are in [`docs/VERSIONING.md`](docs/VERSIONING.md).

## How the sharing works

All apps are Next.js 16 with React 19 and Tailwind v4, and pin the same
majors through the pnpm catalog in `pnpm-workspace.yaml`. A split there would
break `@phantom/ui`, which ships as TypeScript source and is compiled by
whichever app imports it. The apps’ `next.config.ts` files therefore include
`transpilePackages: ["@phantom/ui"]`.

Styling starts with the shared base. Each app's `globals.css` keeps the shared
Tailwind source scan and then loads the media surface appropriate to that app:

```css
@import "tailwindcss";
@import "@phantom/theme";
@import "@phantom/theme/media.css";
@source "../../../packages/ui/src";
```

Stream and Still add their additional cinema/player layers. The `@source`
line is not optional: Tailwind only ships classes it can find, and the shared
components live outside the app it is scanning.

Anything genuinely local stays local. The downloader keeps its locale-switcher
transition and its download/format workflows. All three apps now use the shared
media header, search field, artwork, and media surface. Stream and Still also
import `@phantom/theme/player.css` for shared video chrome; their playback
engines remain app-specific.

The theme also ships a dark media surface. `@phantom/theme/media.css` re-points
the palette variables to ink for all three apps. Stream adds
`@phantom/theme/cinema.css` for its catalog and watch pages. Downloader keeps
its download-specific layouts and queue state, while all apps use the shared
media shell. Stream and Still use `@phantom/theme/player.css` and player
controls from `@phantom/ui`. Still keeps its playback engine and chat behavior.

Still, formerly Phantom Twitch, was imported from the separate `twitchsubonlybypass` checkout.
Its channel, VOD, and playlist routes remain local to that app; the source
checkout is unchanged.

## Design

Sora anchors the interface across all three apps. Still uses its local outlined
SVG wordmark and resting-face symbol, with the shared Phantom identity in its
“Part of Phantom Media” footer signature. Downloader and Stream retain the
shared Phantom wordmark; JetBrains Mono serves that treatment and technical
readouts. All three use the shared dark media palette, search field, buttons,
artwork, media header, and media tiles from `@phantom/ui`. Stream and Still also
use the shared player controls; app-specific catalog, channel, playback, and
download workflows stay with their apps.

The [media layout and size reference](packages/theme/README.md) records the
shared content frame, spacing, type, and element variants used by Still.

## Deployment

Production deploys on release, not on push. Every push to `main` is built by
Cloudflare as a preview. A new version is tagged only on a commit that passed
CI and that preview build; its `deploy/<app>` branch then moves to that commit
and Cloudflare Builds deploys it to production. See
[`docs/VERSIONING.md`](docs/VERSIONING.md#production-deploys).

All three apps have Cloudflare deployment configuration. Downloader uses a
Container; Stream and Still run as Workers through OpenNext. Deploy only the
apps intended for the current environment.

**Downloader** runs in a Cloudflare Container. It shells out to `yt-dlp` and
FFmpeg, so it needs a real filesystem and real binaries. The Worker in
`apps/downloader/cloudflare/worker.ts` caches immutable assets at the edge,
rejects junk routes there, and routes build-coupled HTML and dynamic download
APIs to the container.

```sh
pnpm deploy:downloader
```

The image builds from the workspace root because the app compiles against
packages that live outside its own folder. The `image_build_context` setting is
in `apps/downloader/wrangler.jsonc`.

**Stream and Still** run on Workers through OpenNext. Build each app, then
deploy its Worker with `wrangler --domain` and `NEXT_PUBLIC_BASE_URL` set to its
canonical HTTPS URL. Keep production hostnames in deployment settings rather
than this repository.

```sh
NEXT_PUBLIC_BASE_URL=https://your-host.example pnpm --filter @phantom/stream exec opennextjs-cloudflare build
pnpm --filter @phantom/stream exec wrangler deploy --domain your-host.example --var NEXT_PUBLIC_BASE_URL:https://your-host.example
```

For local work, copy an app's `.env.example` to `.env.local` in that same app
directory. For production, configure values through the target host. In
particular, the Downloader's Cloudflare deployment requires
`EWYOUTUBE_PROXY_URLS` to be provisioned with Wrangler as a Worker secret; do
not commit proxy credentials in an environment file.

The Downloader dry run uses `--containers-rollout=none`: it validates the
Worker and container binding without requiring Docker or publishing an image.
The separate container command validates the real image. Neither command
authenticates, provisions resources, uploads secrets, or proves that the
production account and custom domains are correctly configured. Those remain
explicit operator checks before the first deployment from this repository.

## Extraction provenance

This repository retains the media products' Git history, including Downloader's
pre-monorepo root history. The current shared `config`, `theme`, and `ui`
packages are owned here as independent copies so the two repositories can
evolve without a permanent cross-repository build dependency. See
[`docs/EXTRACTION.md`](docs/EXTRACTION.md) for the exact source checkpoint,
history method, dependency boundary, and deletion gate.

## Legal

This repository is licensed under the [MIT License](LICENSE). Third-party
software, assets, and services retain their own licenses and terms.

The apps are independent projects, affiliated with none of the services they
talk to, and none hosts any media. Use them only for media you own, control,
or are legally authorized to access.
