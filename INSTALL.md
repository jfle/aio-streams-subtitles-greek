# Installation guide

**AIO-Streams&Subtitles-Greek** = the Greek AI subtitle addon + a bundled, self-hosted [AIOStreams](https://github.com/Viren070/AIOStreams).

This guide covers every way to run **AIO-Streams&Subtitles-Greek**, how to give it HTTPS (Stremio requires it), how to configure each AI provider, how to install it in Stremio, and how to update, back up and remove it.

Check **[REQUIREMENTS.md](REQUIREMENTS.md)** first if you're unsure whether your hardware or account will work.

**Contents**

1. [Option A — one-file installer (recommended)](#option-a--one-file-installer-recommended)
2. [Option B — from a git clone](#option-b--from-a-git-clone)
3. [Option C — Docker](#option-c--docker)
4. [Option D — manually with Node.js (Windows, macOS, any Linux)](#option-d--manually-with-nodejs-windows-macos-any-linux)
5. [HTTPS](#https)
   - [Outside your home network (public IP or domain)](#outside-your-home-network-public-ip-or-domain)
6. [Configure the addon](#configure-the-addon)
7. [Install in Stremio](#install-in-stremio)
8. [Local models (LM Studio / Ollama)](#local-models-lm-studio--ollama)
9. [Environment variables](#environment-variables)
10. [Update, back up, uninstall](#update-back-up-uninstall)
11. [Troubleshooting](#troubleshooting)

---

## Option A — one-file installer (recommended)

For **Debian, Ubuntu, Raspberry Pi OS, Armbian** and other Debian-based systems (amd64, arm64, armhf). Ideal for a Raspberry Pi, Orange Pi, mini-PC, NAS VM or home server.

```bash
curl -fsSLO https://github.com/jfle/aio-streams-subtitles-greek/releases/latest/download/aio-streams-subtitles-greek-installer.sh
sudo bash aio-streams-subtitles-greek-installer.sh
```

(Or download `aio-streams-subtitles-greek-installer.sh` from the [Releases page](https://github.com/jfle/aio-streams-subtitles-greek/releases) and copy it to the machine.)

The installer:

1. Installs **Node.js 22** (from NodeSource) if Node 18.17+ isn't present.
2. Copies the app to `/opt/aio-streams-subtitles-greek` and creates a dedicated system user `aigreeksubs`.
3. Creates and starts the **`aio-streams-subtitles-greek`** systemd service (auto-starts on boot, restarts on failure, hardened).
4. Sets up **HTTPS on your home network** with nginx and the free [local-ip.sh](https://local-ip.sh) certificate, at `https://<your-ip-with-dashes>.local-ip.sh` (e.g. `https://192-168-1-50.local-ip.sh`). The certificate is refreshed weekly by cron.
5. Keeps settings, cache and sign-ins from a previous installation.
6. Prints the address to open next.

### Installer options

| Option | Meaning |
|---|---|
| *(none)* | Install, or update an existing installation (settings are kept) |
| `--public-ip auto` / `--public-ip 1.2.3.4` | Also make the addon reachable **outside your home network** through your public IP — see [Outside your home network](#outside-your-home-network-public-ip-or-domain) |
| `--public-port 8443` | The port you forward on your router for outside access (default: the HTTPS port, 443) |
| `--public-url https://subs.example.com` | Outside access through your own domain or tunnel (it provides HTTPS) |
| `--no-public` | Home network only again |
| `--password PW` | Set the configuration-page password (one is generated automatically when you enable outside access) |
| `--no-aiostreams` | Subtitle addon only: don't install the bundled AIOStreams (stops it if it was installed; its data is kept) |
| `--aio-port 8444` | HTTPS port for AIOStreams (default 8444) |
| `--aio-public-port 8444` | Router port for outside access to AIOStreams (default: same as `--aio-port`) |
| `--aio-public-url https://streams.example.com` | HTTPS origin for bundled AIOStreams when a tunnel or reverse proxy provides HTTPS |
| `--aio-user NAME` | Username for the AIOStreams login (default `admin`; the password is generated) |
| `--https none` | Skip nginx/HTTPS — plain HTTP only. Use this if you provide HTTPS yourself (Caddy, Cloudflare Tunnel, Tailscale…) |
| `--port 7100` | Run the addon on another local port (default `7000`; the installer also picks a free one automatically) |
| `--uninstall` | Remove the service and program, keep `data/` (settings, sign-ins, cache) |
| `--uninstall --purge` | Remove everything, including data |
| `--help` | Show the options |

If port 443 is already used by another program, HTTPS is set up on **8443** instead (the printed address includes it).

The installer remembers your choices (in `/etc/aio-streams-subtitles-greek.conf`, secrets in `/etc/aio-streams-subtitles-greek.env`, both root-only), so later updates keep them without repeating the options.

Useful commands afterwards:

```bash
systemctl status aio-streams-subtitles-greek       # is it running?
journalctl -u aio-streams-subtitles-greek -f       # live logs
sudo systemctl restart aio-streams-subtitles-greek # restart
# Kept on the data disk, survive reboots (the journal on Armbian/Orange Pi lives in RAM):
sudo tail -f /opt/aio-streams-subtitles-greek/data/logs/addon-$(date +%F).log   # today's full log
sudo tail -n 20 /opt/aio-streams-subtitles-greek/data/logs/jobs-$(date +%Y-%m).jsonl  # translation jobs
```

---

### The bundled AIOStreams

Unless you pass `--no-aiostreams`, the installer also sets up AIOStreams (64-bit systems only — amd64 / arm64):

1. Installs **Docker** if it's missing (official `get.docker.com` script).
2. Creates `/opt/aiostreams` with `compose.yaml` and `.env`: the public base URL, a random **SECRET_KEY** (encrypts your saved AIOStreams configurations — never change it), SQLite storage in `/opt/aiostreams/data`, and a **login** (`AIOSTREAMS_AUTH`, printed once at the end).
3. Runs the official `ghcr.io/viren070/aiostreams` image, reachable only through nginx, on **`https://<your-ip>.local-ip.sh:8444`** (and the public address when outside access is on).
4. Installs `sudo aiostreams-update` and runs it **weekly** (pulls the newest image, keeps everything else).

An existing `/opt/aiostreams` is kept as it is (secret key, login, configurations); updates only follow address changes. On first start AIOStreams downloads its title databases, which takes a minute or two.

**Set it up:** open the AIOStreams address, sign in, add your debrid service (its API key), choose stream addons and filters — or import a configuration exported from another instance (keys are not included in exports; enter them again). Some features (title / year matching, digital-release filter) need a free [TMDB](https://www.themoviedb.org/settings/api) **API Read Access Token**. Then add your subtitle addon: on the subtitle configure page click **Generate install link**, copy the manifest URL, and in AIOStreams add it under **Addons → Custom addon**. Save, then **Install** — Stremio needs only AIOStreams.

**Change the login:** edit `AIOSTREAMS_AUTH=user:password` in `/opt/aiostreams/.env`, then `sudo aiostreams-update`.

### Schedule AIOMetadata updates

The bundled AIOStreams installer already sets up a weekly updater. If you run AIOMetadata separately using Docker Compose and SQLite, copy the [AIOMetadata updater](scripts/aiometadata-update.sh) from this checkout:

```bash
sudo install -m 755 scripts/aiometadata-update.sh /usr/local/bin/aiometadata-update
sudo /usr/local/bin/aiometadata-update /path/to/aiometadata
```

The argument is the directory containing the AIOMetadata Compose file. The updater expects the service name `aiometadata` and the standard SQLite data mount at `/app/addon/data`. It creates a private, integrity-checked SQLite snapshot in `update-backups/` before pulling the image. It then updates only AIOMetadata and checks its health endpoint. Keep the backups private because copied environment files may contain credentials.

For a weekly schedule, add this line to root's crontab with `sudo crontab -e`, replacing the Compose directory with your own:

```cron
15 4 * * 3 /usr/local/bin/aiometadata-update /path/to/aiometadata
```

Run the updater manually once before scheduling it. The command returns an error if the service fails the health check and leaves the pre-update snapshot available for recovery.

## Option B — from a git clone

Same result as Option A, using the repository directly:

```bash
git clone https://github.com/jfle/aio-streams-subtitles-greek.git
cd aio-streams-subtitles-greek
sudo ./install.sh            # accepts the same options as the installer
```

To update later: `git pull && sudo ./install.sh`.

---

## Option C — Docker

Works on any machine with Docker (Linux, Synology/QNAP, Unraid, Windows/macOS with Docker Desktop).

**Prebuilt image** (multi-arch: amd64, arm64):

```bash
docker run -d --name ai-greek-subs --restart unless-stopped \
  -p 7000:7000 -v "$PWD/data:/data" \
  ghcr.io/jfle/aio-streams-subtitles-greek:latest
```

**Or build it yourself** with the included `docker-compose.yml`:

```bash
git clone https://github.com/jfle/aio-streams-subtitles-greek.git
cd aio-streams-subtitles-greek
docker compose up -d --build
```

The container serves **plain HTTP on port 7000**. Stremio needs HTTPS for anything other than `localhost`, so put one of the [HTTPS options](#https) in front of it and set `PUBLIC_URL` (in `docker-compose.yml` or with `-e PUBLIC_URL=https://…`) to the HTTPS address.

Keep the `data` volume: it holds your encryption key, sign-ins and cache.

---

## Option D — manually with Node.js (Windows, macOS, any Linux)

1. Install **Node.js 18.17 or newer** (22 LTS recommended) from [nodejs.org](https://nodejs.org).
2. Download the source (`git clone` or **Code → Download ZIP** on GitHub) and open a terminal in the folder.
3. Start it:

   ```bash
   npm start          # same as: node server.js
   ```

   There is nothing to `npm install` — the project has no dependencies.

4. Open `http://localhost:7000/configure`.

**Stremio on the same computer** accepts plain `http://127.0.0.1:7000/…` addon links, so no HTTPS is needed in that case. Generate the install link from `http://127.0.0.1:7000/configure`.

To keep it running in the background:

- **Linux:** use Option B (systemd), or a user service / `pm2`.
- **Windows:** Task Scheduler → *Create task* → trigger *At log on* → action `node.exe` with argument `server.js` and *Start in* set to the folder. (Or `npm i -g pm2 && pm2 start server.js --name ai-greek-subs && pm2 save`.)
- **macOS:** `pm2`, or a `launchd` agent.

Settings, sign-ins and cache are stored in `./data` (change with `DATA_DIR`).

---

## HTTPS

Stremio only installs addons over **HTTPS** (except `localhost`). Pick one:

| Method | Works from | Effort |
|---|---|---|
| **local-ip.sh** (the installer's default) | Devices on your home network | None — automatic |
| **Tailscale Serve** | Your devices anywhere (phone, TV, laptop) on your tailnet | Low |
| **Tailscale Funnel** | Anywhere, including behind CGNAT, using a supplied `ts.net` hostname | Tailscale account and Funnel enabled |
| **Cloudflare Tunnel** | Anywhere, no port forwarding | Low–medium (needs a domain on Cloudflare) |
| **Caddy + your domain / DuckDNS** | Anywhere | Medium (port forwarding 80/443) |

### Outside your home network (public IP or domain)

To use the addon away from home (phone on mobile data, a hotel, a friend's TV), give the server a second, **external** address. The home address keeps working.

**With a static (or rarely changing) public IP — no domain needed:**

```bash
sudo bash aio-streams-subtitles-greek-installer.sh --public-ip auto --public-port 8443
```

1. The installer detects your public IP (or give it: `--public-ip 194.0.2.10`) and adds `https://<your-public-ip>.local-ip.sh:8443` — the same free wildcard certificate covers it, because `194-0-2-10.local-ip.sh` simply resolves to `194.0.2.10`.
2. **On your router, forward TCP port 8443 to the server's LAN IP, port 443** — and, for AIOStreams, **TCP 8444 to the server's LAN IP, port 8444** (often called *port forwarding*, *virtual server* or *NAT rules*). Use any free external port; 8443 avoids clashing with a router's own remote-admin page on 443.
3. Because the configuration page becomes reachable from the internet, the installer **sets a configuration password** (printed at the end; change it with `--password`). Wrong passwords are slowed down and an address is locked out for 15 minutes after 10 attempts. Without a password, the server refuses configuration requests that arrive through the external address.
4. Open the configure page, generate the install link and choose **Anywhere**. That link works at home and away.

> **At home, the "Anywhere" link goes out to your public IP and back in.** Most routers handle this ("NAT loopback"/"hairpinning"). If yours doesn't, the addon won't load at home with that link: install the **Home network only** link on devices that never leave home, or enable NAT loopback on the router.

If your public IP changes, re-run the installer (with no options — it re-detects `auto`) and reinstall the addon link. For a changing IP, a free dynamic-DNS name with your own HTTPS is the better fit:

**With your own domain or a tunnel:**

```bash
sudo bash aio-streams-subtitles-greek-installer.sh --public-url https://subs.example.com
```

The domain must provide HTTPS itself — Cloudflare Tunnel, Tailscale Funnel, or Caddy/another reverse proxy forwarding to the server (see the sections below). The installer adds it as the external address and sets a password, just like `--public-ip`.

**Docker / manual:** set `EXTERNAL_URL=https://…` and `CONFIG_PASSWORD=…` in the environment.

To switch outside access off again: `sudo bash aio-streams-subtitles-greek-installer.sh --no-public`, then remove the router's port forward.

### local-ip.sh (installer default)

Nothing to do — the installer configures nginx with the public `*.local-ip.sh` wildcard certificate. `192-168-1-50.local-ip.sh` simply resolves to `192.168.1.50`, so it only works **inside your network**.

> Some routers and DNS filters block "DNS rebinding" (public names that resolve to private IPs). If `https://<ip>.local-ip.sh` doesn't open, allow `local-ip.sh` in your router / Pi-hole / NextDNS settings, or use another method below.

### Tailscale Serve

```bash
sudo tailscale serve --bg 7000
```

Your addon is now at `https://<machine>.<tailnet>.ts.net`. Install with `--https none`, set `PUBLIC_URL` to that address (`sudo systemctl edit aio-streams-subtitles-greek` → `[Service]` `Environment=PUBLIC_URL=https://…`), restart, and generate the install link from `https://<machine>.<tailnet>.ts.net/configure`. Every device that runs Stremio must be on your tailnet.

### Behind CGNAT with a free HTTPS hostname

**Guided fresh install (all three add-ons):**

```bash
git clone https://github.com/jfle/aio-streams-subtitles-greek.git
cd aio-streams-subtitles-greek
sudo bash install-funnel.sh
```

The script installs Tailscale if needed, prompts for Tailscale sign-in and Funnel approval, and prints three Stremio configuration URLs. It installs AIOMetadata with Redis in `/opt/aiometadata`, enables configuration protection, and checks that AIOMetadata is ready before enabling Funnel. Use the manual steps below for an existing Pi setup.

To finish AIOMetadata, open its setup URL, choose **Configuration → Import Configuration**, and select `templates/aiometadata-mainstream.json` from the checkout. Enter your own TMDB key and the generated `ADDON_PASSWORD` from `/opt/aiometadata/.env` when prompted, then save and install the private Stremio link. The app data and Redis cache are in separate Docker volumes.

If you do not have an inbound-reachable public IP, a free dynamic DNS hostname alone cannot route traffic through CGNAT. [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) supplies a stable `*.ts.net` HTTPS address on the free plan and works without router port forwarding or a purchased domain. Funnel URLs are public. For access only by devices on your tailnet, use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) instead.

1. Install Tailscale on the host, sign in, and enable MagicDNS, HTTPS, and Funnel in your tailnet. Replace `YOUR_HOST.YOUR_TAILNET.ts.net` below with the actual name of the host.
2. From a checkout of the current source, configure the bundled installer with the two HTTPS origins. The published v2.0.2 one-file installer predates the bundled `--aio-public-url` flag. For a fresh install with available local ports, use:

   ```bash
   sudo bash install.sh --https none --port 7000 \
     --public-url https://YOUR_HOST.YOUR_TAILNET.ts.net \
     --aio-public-url https://YOUR_HOST.YOUR_TAILNET.ts.net:8443
   ```

   For the standalone PolyCue installer, pass only the subtitle options. For an existing AIOStreams deployment, enable **Auth Required** in the AIOStreams dashboard or set `AIOSTREAMS_AUTH_REQUIRED=true` before making its configuration page public. Keep your existing login and encryption key.

3. Point Funnel at the local ports. If the installer reports a different AIOStreams internal port, use that port in the second command.

   ```bash
   sudo tailscale funnel --bg --https=443 http://127.0.0.1:7000
   sudo tailscale funnel --bg --https=8443 http://127.0.0.1:3000
   sudo tailscale funnel status
   ```

4. Open `https://YOUR_HOST.YOUR_TAILNET.ts.net/configure` for subtitles and `https://YOUR_HOST.YOUR_TAILNET.ts.net:8443/stremio/configure` for AIOStreams. Generate fresh Stremio install links when switching to the new hostname. Verify the links from a device off your home network.

For a manual or existing AIOMetadata deployment, set its Compose `HOST_NAME` to `https://YOUR_HOST.YOUR_TAILNET.ts.net:10000` and point a third Funnel at its loopback HTTP port, ordinarily `3232`:

```bash
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:3232
```

Funnel has bandwidth limits. Use it for add-on requests and subtitles. If you enable AIOStreams' optional video proxy, check throughput before sending playback traffic through Funnel.

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://127.0.0.1:7000          # quick test (random trycloudflare.com address)
```

For a permanent address, create a named tunnel to `http://127.0.0.1:7000` on a hostname such as `subs.example.com`, set `PUBLIC_URL=https://subs.example.com`, and set `CONFIG_PASSWORD` because the configure page becomes public.

### Caddy with your own domain

```caddyfile
# /etc/caddy/Caddyfile
subs.example.com {
    reverse_proxy 127.0.0.1:7000
}
```

Forward ports 80 and 443 to the server, install with `--https none`, set `PUBLIC_URL=https://subs.example.com` and `CONFIG_PASSWORD`, and generate the install link from `https://subs.example.com/configure`. A free [DuckDNS](https://www.duckdns.org) name works too.

---

## Configure the addon

Open `https://<your-address>/configure`.

### 1. AI provider

Choose a provider, then **either sign in or paste an API key**:

- **OpenAI — sign in with ChatGPT (Plus/Pro plan).** Click **Sign in with ChatGPT** and approve in the new tab. The tab then ends on a page that *can't load* (`http://127.0.0.1:1455/auth/callback?code=…`) — that's expected. Copy that **whole address** from the address bar, paste it into the configure page and click **Finish sign-in**. Usage counts toward your ChatGPT plan; you can revoke access in ChatGPT settings.
- **xAI (Grok) — sign in with SuperGrok / X Premium.** Click **Sign in with Grok**. An x.ai page opens (you can also use any other device) and the configure page shows a short code. Sign in, enter the code if asked and approve — the configure page continues by itself. The consent screen may say *"Grok Build"*: that's xAI's shared sign-in for apps. xAI decides which accounts may use Grok through sign-in; if it refuses, the addon tells you, and an xAI API key always works.
- **OpenRouter.** Click **Sign in with OpenRouter**, log in and approve; you come back automatically. You can set an optional spending limit for the key OpenRouter creates. *(This needs the HTTPS address.)*
- **Claude, Gemini, Mistral, DeepSeek, Groq, Together.** Paste an API key, or click **Use … through OpenRouter sign-in**: you sign in to OpenRouter and the addon picks a fast model from that vendor.
- **Custom OpenAI-compatible.** For LM Studio, Ollama, vLLM, LocalAI… — see [Local models](#local-models-lm-studio--ollama).

Then click **Load models**, choose a model from the list and click **Test translation**. Fast models are best: *luna* (ChatGPT plan), *non-reasoning* (Grok), *Flash* (Gemini), *mini*, *Haiku*, *small*.

### 2. Translation

| Setting | Default | Meaning |
|---|---|---|
| Translate English to | Greek | Target language (18 available) |
| Extra instructions | – | e.g. "Use informal Greek", "Keep swear words" |
| Start translating as soon as a video starts | on | Pre-translates the best-matching subtitle |
| Start translating as soon as you open a movie or episode | on | Head start while you pick a stream (uses Stremio's stream request) |
| Translate the next episode in the background | on | The next episode then starts fully in Greek |
| Check that the subtitle matches your video, and fix its timing | on | Release fingerprint, wrong-type rejection, length check, frame-rate detection and alignment — see [README → Subtitle matching & sync](README.md#subtitle-matching--sync) |
| Show a short note when the timing was corrected or couldn't be verified | on | A 4-second note at the start of the subtitle |
| Show remaining lines in English while translating | on | Otherwise only the translated part is shown |

### 3. Advanced

| Setting | Default | Meaning |
|---|---|---|
| English subtitle sources | OpenSubtitles v3 | Any Stremio subtitle addon URL(s), one per line |
| Greek AI tracks | 1 | Extra tracks translate other English files (rarely useful) |
| Lines per request | auto (20) | Batch size |
| Parallel requests | auto | 24 for ChatGPT sign-in, 8 for other cloud providers, 3 for local servers. Lower it if you hit rate limits |
| Temperature | 0.3 | Lower = more literal |

If the server has `CONFIG_PASSWORD` set, a **Server password** field appears.

### 4. Generate the install link

Click **Generate install link**, then **Install in Stremio** (opens Stremio) or **Copy** the manifest URL.

If outside access is enabled, choose **Anywhere** (works at home and away) or **Home network only** first.

Your settings live *inside* that link (encrypted). To change them later, open the addon's ⚙ **Configure** button in Stremio — the page opens pre-filled — and install the new link.

---

## Install in Stremio

- **Stremio desktop / web:** click **Install in Stremio** on the configure page, or open Stremio → **Add-ons** → paste the manifest URL into the search box → **Install**.
- **Android / Android TV / other devices:** install it once from desktop or [web.stremio.com](https://web.stremio.com) while logged in to the same Stremio account — addons sync to all your devices. (With local-ip.sh the devices must be on your home network.)

Then play a movie or episode, open the subtitles menu and choose **Greek**.

---

## Local models (LM Studio / Ollama)

Run translations on your own GPU — free and private. A good choice for Greek is **Llama-Krikri-8B-Instruct** (ILSP), a Greek-tuned 8B model; general models such as Qwen or Gemma also work.

### LM Studio

1. In LM Studio, download the model and turn on the server: **Developer → Start server**, and enable **Serve on Local Network**.
2. Load the model with a large enough context and several parallel slots (command line):

   ```bash
   lms load llama-krikri-8b-instruct --context-length 16384 --parallel 4 --gpu max
   ```

3. In the configure page choose **Custom OpenAI-compatible**:
   - **Base URL:** `http://<pc-ip>:1234/v1`
   - **Model:** click **Load models** and choose the model (LM Studio loads it on demand)
   - Keep **Turn off model "thinking" (reasoning)** enabled — the addon sends `reasoning_effort: none` and uses structured (JSON-schema) output so models don't waste time "thinking".
4. Set **Advanced → Parallel requests** to the same number as `--parallel` (or leave auto = 3).

A 1,000-line episode takes about 3–4 minutes with an 8B model on a modern GPU; the next-episode prefetch hides this while you binge.

### Ollama

```bash
OLLAMA_HOST=0.0.0.0 OLLAMA_NUM_PARALLEL=4 ollama serve
ollama pull qwen3:8b
```

Configure page → **Custom OpenAI-compatible** → Base URL `http://<pc-ip>:11434/v1`, model `qwen3:8b`.

---

## Environment variables

Set them in the systemd unit (`sudo systemctl edit aio-streams-subtitles-greek`, then `[Service]` / `Environment=NAME=value`), in `docker-compose.yml`, or in your shell. See also [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address (`127.0.0.1` when behind a local reverse proxy only) |
| `PUBLIC_URL` | from the request | HTTPS base URL for the home network (the installer sets it) |
| `EXTERNAL_URL` | – | Second address that works outside the home network (public IP + forwarded port, or your domain). Requests arriving through it need `CONFIG_PASSWORD` for the configuration page |
| `CONFIG_PASSWORD` | – | Password required to test, list models, sign in and generate links on the configure page |
| `DATA_DIR` | `./data` | Encryption key, sign-ins, cache |
| `SECRET` | random, saved in `data/secret.key` | Encrypts the settings inside addon links. Changing it (or losing `secret.key`) invalidates existing install links |
| `CACHE_DAYS` | `30` | Days to keep finished translations |
| `SUBTITLE_WAIT_MS` | `8500` | Longest a subtitle request waits before sending partial results (max 9000 — Stremio gives up after ~10 s) |

Advanced / testing only: `OPENAI_API_URL`, `OPENAI_AUTH_URL`, `OPENAI_ISSUER`, `OPENROUTER_URL`, `XAI_AUTH_URL`, `XAI_OAUTH_API_URL`, `XAI_OAUTH_PROXY_URL` override provider endpoints (used by the test suite's mock servers).

Server endpoints for monitoring: `GET /health` (version), `GET /status` (running and finished translation jobs), `GET /<addon token>/report/<type>/<id>.json` (how the subtitle for a title was chosen and verified). `CINEMETA_URL` overrides the catalog used for runtimes.

---

## Update, back up, uninstall

**Update**

- Installer: download the newest `aio-streams-subtitles-greek-installer.sh` and run it again — settings, sign-ins and cache are kept, and existing Stremio install links keep working.
- Git: `git pull && sudo ./install.sh`
- Docker: `docker pull ghcr.io/jfle/aio-streams-subtitles-greek:latest` and recreate the container, or `git pull && docker compose up -d --build`.

If a release note says the addon's *features* changed (new manifest resources), reinstall the addon once from its ⚙ Configure page so Stremio reads the new manifest.

**Back up** the data folder — `/opt/aio-streams-subtitles-greek/data` (installer), `./data` (manual/Docker). The important file is `secret.key`: without it, existing install links stop working and you'd have to configure and install again.

**Uninstall**

```bash
sudo bash aio-streams-subtitles-greek-installer.sh --uninstall           # keeps data
sudo bash aio-streams-subtitles-greek-installer.sh --uninstall --purge   # removes everything
```

Then remove the addon in Stremio (**Add-ons → AIO-Streams&Subtitles-Greek → Uninstall**). Revoke sign-ins on the provider side if you like (ChatGPT settings, x.ai account, OpenRouter keys).

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **"Manifest error"** or install fails in Stremio | The link isn't HTTPS (or the certificate isn't trusted). Use the `https://…` address printed by the installer and generate the link from there. |
| `https://<ip>.local-ip.sh` doesn't open | Your router/DNS blocks DNS rebinding — allow `local-ip.sh`, or use Tailscale / Cloudflare (see [HTTPS](#https)). Also check the server's IP didn't change (give it a fixed DHCP lease). |
| Subtitles show **in English** with `[⏳ …]` tags | The translation is still running. Turn subtitles **OFF and back ON** to load the translated part. Check `/status` for progress. |
| Subtitles stay English, no `⏳` tag | The first line of the file says why (e.g. *AI translation failed: …*). Common causes: expired sign-in, invalid key, model not available. Open the configure page, **Test translation**, fix and reinstall. |
| Subtitles are **out of sync** | Most often no English subtitle exists for your exact release; the note at the start then says *No subtitle found for this exact release*. Fix a constant offset with the player's **subtitles menu (CC button or S key) → Delay**, or pick another stream (a common release such as a WEB-DL usually has a hash-matched subtitle). Check what was found with the report: replace `manifest.json` in your addon link with `report/movie/<imdb id>.json` or `report/series/<imdb id>:<season>:<episode>.json`. |
| A subtitle **drifts** further off over time | A frame-rate mismatch. The addon rescales automatically when it has a reference subtitle to compare with; if it says the release couldn't be verified, try another stream. |
| No **Greek** track in the menu | No English subtitle exists for that title in your sources, or the addon isn't installed in this Stremio account / profile. |
| Translation is slow | Use a faster model (luna / non-reasoning / Flash / mini) and leave *Parallel requests* on auto. For local models raise `--parallel` in LM Studio and the matching setting here. |
| HTTP **429** / rate limit errors | Lower **Advanced → Parallel requests** (e.g. 8 → 4). |
| "ChatGPT/Grok sign-in has expired" | Sign in again on the configure page and reinstall the link. Sign-ins are refreshed automatically while the server runs; long downtime can expire them. |
| Grok: "xAI did not allow this account…" | Your plan isn't enabled by xAI for app sign-in. Use an xAI API key instead. |
| LM Studio: model doesn't load / times out | Make sure *Serve on Local Network* is on, the Base URL uses the PC's LAN IP, and the model fits in VRAM. Load it once with `lms load … --parallel 4`. |
| The **Anywhere** link doesn't work away from home | Check the router's port forward (external port → server LAN IP, port 443) and that your public IP hasn't changed (`curl https://api.ipify.org` on the server). If your ISP uses CGNAT, use the [free HTTPS hostname option](#behind-cgnat-with-a-free-https-hostname). |
| The **Anywhere** link doesn't work at home | Your router lacks NAT loopback — use the **Home network only** link at home, or enable NAT loopback. |
| "Too many wrong passwords" | Wait 15 minutes; the lockout is per address. The password is in `/etc/aio-streams-subtitles-greek.env`. |
| AIOStreams says "missing API key" when saving | An imported configuration has services or features enabled without their keys: enter your debrid API key, and either a TMDB access token or switch off title matching, year matching and the digital-release filter. The reason is in `docker logs aiostreams`. |
| AIOStreams page doesn't load | `docker ps` should show `aiostreams` as healthy; first start takes a minute or two. Logs: `docker logs -f aiostreams`. Outside access needs the router forward for 8444. |
| Port 7000 already in use | The installer picks the next free port automatically; for manual runs set `PORT`. |

Logs: `journalctl -u aio-streams-subtitles-greek -f` (installer), `docker logs -f aiostreams` (AIOStreams), `docker logs -f ai-greek-subs` (Docker), or the terminal (manual). Each translation logs lines like `[start]`, `[serve] … translating 47%`, `[progress] … 50%`, `[done] … 1010 cues, 0 failed, 56.5s`.

The addon also keeps its own logs in `DATA_DIR/logs` (for the installer: `/opt/aio-streams-subtitles-greek/data/logs`), independent of the system journal:

- `addon-YYYY-MM-DD.log` — every log line with a timestamp; kept 90 days (`LOG_DAYS`).
- `jobs-YYYY-MM.jsonl` — one JSON line per translation-job event: `listing` (which tracks were offered, real subtitle used or not), `start`, `source`, `progress` (25/50/75%), `done` / `error` (cues, failed lines, duration, local-model vs cloud batches, last local-model error), `retry`, `cache-hit`, `real-subtitle-error`; kept 400 days (`JOB_LOG_DAYS`).

API keys and bearer tokens are masked. Set `LOG_TO_FILES=off` to disable the files.

Still stuck? [Open an issue](https://github.com/jfle/aio-streams-subtitles-greek/issues/new/choose) with the log lines (remove anything personal).
