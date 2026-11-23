# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

- Add a real-subtitle-or-AI choice: when a verified subtitle already exists in the target language, offer it instead of (or alongside) the AI translation. New `nativeSubtitles` setting (`auto` | `both` | `off`, default `auto`) on the configure page. In `auto`, a verified real subtitle becomes the primary track with the AI translation kept as a `(AI)`-labeled backup; in `both`, the real subtitle is always listed alongside the AI track, labeled unverified when it couldn't be confirmed; in `off`, behavior is unchanged from before this release.
- Fix legacy (non-UTF-8) subtitle files being decoded with the Western European codepage (Windows-1252) regardless of the target language; each language now uses its own legacy codepage (e.g. Windows-1253 for Greek, Windows-1251 for Russian/Bulgarian/Ukrainian).
- Add a guided fresh install of AIOStreams, subtitles, and AIOMetadata with Redis through Tailscale Funnel for users behind CGNAT.

- Offer a ready-to-select AIOStreams template for English audio and Greek subtitles on fresh installs. Provide a separate mainstream catalog template for AIOMetadata.
- Add `--aio-public-url` for the bundled AIOStreams installer and document free HTTPS hostnames behind CGNAT.
- Add an AIOMetadata updater that verifies a SQLite backup before updating and checks service health afterward.

## [2.0.2] — 2026-11-19

- Offer an AI backup track when a higher-priority addon already has subtitles. The player can request a translation by loading the backup track.

## [2.0.1] — 2026-11-19

- Rename the Stremio addon to **AI-Fletouris** and use the Greek flag as its logo.
- Skip AI translation when a configured higher-priority subtitle addon offers the target language.
- Try local Llama-Krikri-8B-Instruct with thinking off before the configured cloud provider.
- Preserve the priority source list and local model endpoint when upgrading an installer-based deployment.

## [2.0.0] — 2026-11-19

### Changed
- **New name: AIO-Streams&Subtitles-Greek** (repository `jfle/aio-streams-subtitles-greek`, installer `aio-streams-subtitles-greek-installer.sh`, service `aio-streams-subtitles-greek`, folder `/opt/aio-streams-subtitles-greek`). The Stremio addon ID is unchanged, so existing installs keep working.
- Updating from AI-Greek-Subs-Fletouris migrates automatically: settings, sign-ins, cache, outside-access options and password move to the new name; the old service and nginx site are removed.

### Added
- **Bundled AIOStreams**: the installer also sets up the official AIOStreams Docker image behind the same HTTPS (port 8444), with a generated login and secret key, outside access, and weekly automatic updates (`sudo aiostreams-update`). Options: `--no-aiostreams`, `--aio-port`, `--aio-public-port`, `--aio-user`. Existing `/opt/aiostreams` installations are adopted unchanged.
- The configure page links to the bundled AIOStreams and explains how to add the subtitle addon to it, so Stremio needs one addon.

## [1.9.0] — 2026-11-19

### Added
- **Outside access:** an external address next to the home-network one.
  - `--public-ip auto|<ip>` + `--public-port <port>`: `https://<public-ip>.local-ip.sh:<port>` with the same free wildcard certificate — no domain needed; forward the port on your router.
  - `--public-url https://…`: your own domain or tunnel.
  - `--no-public` to switch it off; the installer remembers settings between updates (`/etc/ai-greek-subs-fletouris.conf`, secrets in a root-only `.env`).
- The configure page offers the install link for **Anywhere** or **Home network only**.
- Configuration password generated automatically when outside access is enabled; configuration requests through the external address are refused without one. Wrong passwords are delayed and locked out per address (10 tries / 15 min).
- `EXTERNAL_URL` environment variable (Docker / manual installs).

## [1.8.0] — 2026-11-19

### Added
- **Subtitle matching & sync checks** (on by default):
  1. **Fingerprint + type:** OpenSubtitles hash match first, then release group / source / streaming service / edition compared with the video filename. Rejects CD-split, forced-only, wrong-season/episode, episode-on-movie and non-English files.
  2. **Length check** against the reference subtitle and the runtime from Cinemeta; without a fingerprint, the subtitle whose length agrees with the others wins.
  3. **Frame-rate detection** (23.976 / 24 / 25 / 29.97 / 30 fps) with automatic rescaling.
  4. **Alignment** to the best-matching English reference: shared lines as anchors, global or elastic per-scene corrections across different cuts, timing-pattern fallback when the wording differs.
- An existing translation of another release is **reused and retimed** instead of translated again (e.g. a title opened before the stream was chosen).
- Short on-screen note when timing was corrected, or when the release couldn't be verified (pointing to the player's *subtitles menu → Delay*).
- `/<token>/report/<type>/<id>.json` explains which subtitle was chosen and why.
- Reads **ASS/SSA** and **MicroDVD** subtitles (MicroDVD frame numbers use the source's frame rate).

## [1.7.1] — 2026-11-18

### Fixed
- CI: Docker smoke test used a container name that current Docker rejects.
- GitHub Actions updated to the Node 24 versions (checkout v5, setup-node v5).
- First release with the downloadable single-file installer and Docker image.

## [1.7.0] — 2026-11-18

First public release on GitHub.

### Added
- **Sign in with Grok** — use a SuperGrok / X Premium plan through xAI's OAuth device-code sign-in (approve on x.ai with a short code; works from any device). Falls back between xAI's API endpoints automatically and explains clearly when xAI doesn't enable an account.
- One-click **"Use … through OpenRouter sign-in"** for providers that offer no sign-in (Claude, Gemini, Mistral, DeepSeek, Groq, Together); picks a fast model from that vendor after signing in.
- One-click switch from the OpenAI API-key provider to **Sign in with ChatGPT**.
- Full documentation (README, INSTALL, REQUIREMENTS, SECURITY, CONTRIBUTING), zero-dependency test suite, GitHub Actions CI, release workflow (single-file installer + multi-arch Docker image).

## [1.6.0] — 2026-11-18

### Added
- **Early start:** translation begins as soon as you *open* a movie or episode in Stremio (the addon listens to Stremio's stream request and always answers "no streams").
- **Automatic parallelism:** 24 parallel requests with ChatGPT sign-in, 8 for other cloud providers, 3 for local servers (configurable). A 1,010-line episode now translates in about 1 minute instead of 5.
- Untranslated lines are tagged `[⏳ 42% · OFF/ON για ελληνικά]` so it's clear how to load the rest.

### Changed
- Batches ramp up (5 → 10 → 20 lines) so the opening minutes come back first.
- The subtitle request waits for the whole file when it is about to finish, and for more of the opening on the first request.

## [1.5.2] — 2026-11-18

### Fixed
- The model picker showed only the selected model; it is now a real dropdown of every model your account can use, plus "Other…".

## [1.5.1] — 2026-11-18

### Fixed
- "Load models" returned nothing after signing in with ChatGPT (different response format of the plan's model list).

## [1.5.0] — 2026-11-18

### Added
- **Sign in with OpenRouter** (OAuth PKCE, optional spending limit) and **Sign in with ChatGPT** (ChatGPT Plus/Pro plan usage, rotating refresh tokens kept alive automatically).
- Single-file **installer** for Debian-based hosts with automatic HTTPS (nginx + local-ip.sh), systemd service, update and uninstall.
- Greek flag theme, new name **AI-Greek-Subs-Fletouris**, logo and background.

## [1.0.0 – 1.4.x] — 2026-11-17

Early development.

- Stremio subtitle addon translating English subtitles with OpenAI, Anthropic, Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, Together or any OpenAI-compatible server.
- Configuration page with encrypted settings inside the addon URL, model loading and test translation.
- LM Studio support: on-demand model loading, "thinking" switched off (`reasoning_effort: none`), JSON-schema structured output and recovery of malformed replies.
- Works within Stremio's ~10 s subtitle timeout: partial results, priority scheduling of the track being watched, opening lines first.
- One Greek track per title, next-episode prefetch, reuse of already translated subtitles, 30-day cache.

[2.0.0]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v2.0.0
[1.9.0]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.9.0
[1.8.0]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.8.0
[1.7.1]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.7.1
[1.7.0]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.7.0
[1.6.0]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.6.0
[1.5.2]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.5.2
[1.5.1]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.5.1
[1.5.0]: https://github.com/jfle/aio-streams-subtitles-greek/releases/tag/v1.5.0
