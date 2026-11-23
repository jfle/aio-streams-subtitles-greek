'use strict';
// AIO-Streams&Subtitles-Greek — zero-dependency Node.js Stremio addon server.

// First, so every line (including start-up errors) also lands in DATA_DIR/logs on the data disk.
const logbook = require('./src/logbook');
logbook.install();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, LANGUAGES, listModels } = require('./src/providers');
const { DEFAULTS, normalizeConfig, encodeConfig, decodeConfig, sign, b64url } = require('./src/config');
const { getOrStartJob, renderJob, translateLines, status, openingReady, etaMs } = require('./src/translator');
const { selectSubtitles } = require('./src/select');
const { alignmentFor, isNoop, retimeCues, describeFix, downloadCues } = require('./src/sync');
const { legacyEncodingFor, parseSubtitles, toSrt } = require('./src/subtitles');
const auth = require('./src/auth');

const PORT = parseInt(process.env.PORT || '7000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // home-network (LAN) address
// Address that works from outside the home network (public IP + forwarded port, or a domain).
const EXTERNAL_URL = (process.env.EXTERNAL_URL || '').replace(/\/+$/, '');
// The bundled AIOStreams instance, if installed (the configure page links to it).
const AIOSTREAMS_URL = (process.env.AIOSTREAMS_URL || '').replace(/\/+$/, '');
const CONFIG_PASSWORD = process.env.CONFIG_PASSWORD || '';
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
const KNOWN_BASES = [PUBLIC_URL, EXTERNAL_URL].filter(Boolean);
const bareHost = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '');
// The configured address a request arrived on: exact host:port first, then the host name alone
// (a router may forward another external port, or a proxy may drop the port).
function knownBaseFor(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  return KNOWN_BASES.find((b) => hostOf(b) === host) || KNOWN_BASES.find((b) => bareHost(hostOf(b)) === bareHost(host)) || null;
}
const SUBTITLE_WAIT_MS = Math.min(9000, parseInt(process.env.SUBTITLE_WAIT_MS || '8500', 10));
const pkg = require('./package.json');
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'configure.html'), 'utf8');
const STATIC = {
  '/logo.png': fs.readFileSync(path.join(__dirname, 'public', 'logo.png')),
  '/background.png': fs.readFileSync(path.join(__dirname, 'public', 'background.png')),
};

function manifest(cfg, base) {
  const lang = cfg ? LANGUAGES[cfg.targetLang] : 'Greek';
  return {
    id: 'community.ai-greek-subs-fletouris',
    version: pkg.version,
    name: 'AI-Fletouris',
    logo: `${base}/logo.png?v=${pkg.version}`,
    background: `${base}/background.png`,
    description:
      `Translates English subtitles to ${lang} with AI` +
      (cfg && cfg.nativeSubtitles !== 'off' ? `, using a real ${lang} subtitle instead when one is found` : '') +
      (cfg ? ` (${PROVIDERS[cfg.provider].label} · ${cfg.model}).` : '. Configure your AI provider to start.'),
    // The (always empty) stream resource only tells the addon which title was opened, so translation
    // can start while the viewer is still picking a stream.
    resources: cfg && cfg.autoTranslate && cfg.earlyStart && !cfg.prioritySources.length
      ? ['subtitles', { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'kitsu'] }]
      : ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

function baseUrl(req) {
  // Answer with the configured address the request came in on (home or external), else the home one.
  const known = knownBaseFor(req);
  if (known) return known;
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function renderPage(cfg) {
  const data = {
    config: cfg,
    defaults: DEFAULTS,
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, baseUrl: p.baseUrl, defaultModel: p.defaultModel, models: p.models, keyUrl: p.keyUrl, auth: p.auth || null }]),
    ),
    credential: cfg && cfg.credId ? auth.credSummary(cfg.credId) : null,
    chatgptRedirect: auth.CHATGPT_REDIRECT,
    languages: LANGUAGES,
    passwordRequired: !!CONFIG_PASSWORD,
    links: { home: PUBLIC_URL || null, external: EXTERNAL_URL || null, aiostreams: AIOSTREAMS_URL || null },
    version: pkg.version,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return PAGE.replace('/*__BOOT__*/', `window.__BOOT__ = ${json};`);
}

// Opening a title in Stremio (before a stream is picked): start translating its best English subtitle.
const earlyStarted = new Map();
async function handleStream(req, res, token, type, id) {
  send(res, 200, { streams: [] }, undefined, { 'Cache-Control': 'no-store' });
  const cfg = decodeConfig(token);
  if (!cfg || !cfg.autoTranslate || !cfg.earlyStart || cfg.prioritySources.length) return;
  id = decodeURIComponent(id);
  if (type === 'series' && !/:\d+:\d+$/.test(id)) return;
  const key = `${type}|${id}|${cfg.provider}|${cfg.model}|${cfg.targetLang}`;
  if (earlyStarted.has(key) && Date.now() - earlyStarted.get(key) < 600e3) return;
  earlyStarted.set(key, Date.now());
  try {
    const { tracks, report } = await selectSubtitles(cfg, type, id, '', { budgetMs: 5000 });
    // A verified real subtitle will be served instead of the AI one — no need to translate ahead of time.
    if (!tracks[0] || (cfg.nativeSubtitles === 'auto' && report.native && report.native.verified)) return;
    const job = getOrStartJob(tracks[0].src, cfg, { type, id, via: 'early' });
    job.lastRequested = Math.max(job.lastRequested || 0, Date.now() - 1800e3);
    console.log(`[early] ${type} ${id} -> ${job.key} (${job.status})`);
  } catch (e) {
    console.error(`[early] ${id}: ${e.message}`);
  }
}

// The translated-track URL carries what to translate, the reference to retime to, and how well it matched.
function trackPayload(t) {
  return t.ref || t.q !== 'unverified' ? b64url(JSON.stringify({ s: t.src, r: t.ref || undefined, q: t.q })) : b64url(t.src);
}
// A real (non-AI) subtitle in the target language: served as-is, never sent to the translator.
function nativePayload(url) {
  return b64url(JSON.stringify({ s: url, n: true }));
}
function readPayload(src) {
  const raw = Buffer.from(src, 'base64url').toString('utf8');
  if (raw.startsWith('{')) {
    try {
      const p = JSON.parse(raw);
      return { srcUrl: p.s, refUrl: p.r || null, quality: p.q || 'unverified', native: Boolean(p.n) };
    } catch { /* fall through */ }
  }
  return { srcUrl: raw, refUrl: null, quality: 'unverified', native: false };
}

async function handleSubtitles(req, res, token, type, id, extra) {
  const cfg = decodeConfig(token);
  if (!cfg) return send(res, 200, { subtitles: [] });
  const { tracks, report } = await selectSubtitles(cfg, type, id, extra);
  const base = baseUrl(req);
  const langName = LANGUAGES[cfg.targetLang] || cfg.targetLang;
  const link = (src) => ({ src, url: `${base}/${token}/t/${src}/${sign(src)}.srt` });

  const aiEntries = tracks.map((t) => ({ ...link(trackPayload(t)), lang: cfg.targetLang }));
  const native = report.native;
  // auto: a verified real subtitle replaces the AI one as the default pick, which still stays available
  // as a backup track. both: the real subtitle (verified or not) is listed next to the AI one so the
  // viewer can pick either, every time, in the player's subtitle menu.
  const useNativePrimary = Boolean(native && cfg.nativeSubtitles === 'auto' && native.verified);
  const listNativeAlongside = Boolean(native && cfg.nativeSubtitles === 'both');
  let entries = aiEntries;
  if (useNativePrimary) {
    entries = [{ ...link(nativePayload(native.url)), lang: cfg.targetLang }, ...aiEntries.map((e) => ({ ...e, lang: `${langName} (AI)` }))];
  } else if (listNativeAlongside) {
    entries = [...aiEntries, { ...link(nativePayload(native.url)), lang: `${langName} (original${native.verified ? '' : ', unverified'})` }];
  } else if (!entries.length && native && cfg.nativeSubtitles !== 'off') {
    // No English subtitle could be found to translate at all: offer the real one anyway, even unverified.
    entries = [{ ...link(nativePayload(native.url)), lang: `${langName} (original${native.verified ? '' : ', unverified'})` }];
  }
  const subtitles = entries.map((e, i) => ({
    id: `sub-${cfg.targetLang}-${i + 1}-${sign(e.src).slice(0, 8)}`,
    url: e.url,
    lang: e.lang,
  }));

  // Pre-translate the chosen English subtitle as soon as playback starts — not needed when a verified
  // real subtitle is already the default pick.
  let current = null;
  if (cfg.autoTranslate && tracks[0] && !report.hasPreferred && !useNativePrimary) {
    const job = (current = getOrStartJob(tracks[0].src, cfg, { type, id: decodeURIComponent(id), via: 'listing' }));
    // Ranks above older, abandoned jobs but below any track the user actually selects.
    job.lastRequested = Math.max(job.lastRequested || 0, Date.now() - 3600e3);
  }
  const d = report.decision || {};
  const nativeNote = native ? ` · real subtitle: ${native.file} (${native.quality} — ${native.why})${useNativePrimary ? ' [used as default]' : listNativeAlongside || entries.some((e) => e.lang.includes('original')) ? ' [listed]' : ' [not used]'}` : '';
  console.log(`[subs] ${type} ${decodeURIComponent(id)}: ${subtitles.length} track(s)${report.hasPreferred ? " · on demand (higher-priority subtitle available)" : ""}${nativeNote}${d.chosen ? ` · ${d.chosen} (${d.why})` : ''}${d.reuse ? ` · reusing ${d.reuse.from} (${d.reuse.fix})` : ''}`);
  logbook.jobEvent('listing', {
    title: `${type} ${decodeURIComponent(id)}`,
    tracks: subtitles.map((s) => s.lang),
    english: d.chosen || undefined,
    real: native ? { file: native.file, quality: native.quality, verified: !!native.verified, use: useNativePrimary ? 'default' : listNativeAlongside ? 'listed' : 'not used' } : undefined,
    aiJob: current ? current.key : undefined,
    mode: cfg.nativeSubtitles,
  });
  send(res, 200, { subtitles, cacheMaxAge: 60 }, undefined, { 'Cache-Control': 'max-age=60' });
  // Start the next episode only after this one is translated, so it never takes LM Studio slots from it.
  if (cfg.prefetchNext && !cfg.prioritySources.length && type === 'series') {
    Promise.resolve(current && current.promise).then(() => prefetchNextEpisode(cfg, decodeURIComponent(id)));
  }
}

// Why a subtitle was (or wasn't) chosen — for troubleshooting sync problems.
async function handleReport(req, res, token, type, id, extra) {
  const cfg = decodeConfig(token);
  if (!cfg) return send(res, 403, { error: 'Unknown configuration' });
  const { tracks, report } = await selectSubtitles(cfg, type, id, extra);
  send(res, 200, { ...report, tracks: tracks.map((t) => ({ translate: t.src, retimeTo: t.ref, quality: t.q })) }, undefined, { 'Cache-Control': 'no-store' });
}

// While an episode plays, translate the next one at the lowest priority so it starts fully in Greek.
const prefetched = new Map();
async function prefetchNextEpisode(cfg, id) {
  const m = /^(.+):(\d+):(\d+)$/.exec(id);
  if (!m) return;
  const nextId = `${m[1]}:${m[2]}:${parseInt(m[3], 10) + 1}`;
  const key = `${nextId}|${cfg.provider}|${cfg.model}|${cfg.targetLang}`;
  if (prefetched.has(key) && Date.now() - prefetched.get(key) < 6 * 3600e3) return;
  prefetched.set(key, Date.now());
  try {
    const { tracks } = await selectSubtitles(cfg, 'series', nextId, '', { budgetMs: 8000 });
    if (!tracks[0]) return;
    const job = getOrStartJob(tracks[0].src, cfg, { type: 'series', id: nextId, via: 'prefetch' });
    job.lastRequested = Math.max(job.lastRequested || 0, 1); // lowest priority
    console.log(`[prefetch] ${nextId} -> ${job.key} (${job.status})`);
  } catch (e) {
    console.error(`[prefetch] ${nextId}: ${e.message}`);
  }
}

async function handleTranslation(req, res, token, src, sig) {
  const cfg = decodeConfig(token);
  if (!cfg || sign(src) !== sig) return send(res, 403, 'Forbidden', 'text/plain');
  const { srcUrl, refUrl, quality, native } = readPayload(src);
  if (native) {
    // A real subtitle in the target language: no AI involved, just fetched, decoded and re-serialised.
    try {
      const cues = await downloadCues(srcUrl, { timeout: 15000, legacyEncoding: legacyEncodingFor(cfg.targetLang) });
      return send(res, 200, toSrt(cues), 'application/x-subrip; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
    } catch (e) {
      console.error(`[native] ${srcUrl}: ${e.message}`);
      logbook.jobEvent('real-subtitle-error', { src: logbook.shortUrl(srcUrl), error: e.message });
      return send(res, 502, 'Could not fetch the subtitle', 'text/plain');
    }
  }
  const job = getOrStartJob(srcUrl, cfg, { via: 'watch' });
  job.lastRequested = Date.now(); // the track being watched gets the provider's slots first
  // Stremio's streaming server gives up after ~10 s, so answer well before that: return as soon as the
  // job is finished, or after ~2.5 s once the English cues are known, and never later than SUBTITLE_WAIT_MS.
  // Stremio loads a subtitle file only once per selection, so use the time it allows (~10 s):
  // keep waiting while the whole file is about to finish; otherwise return once enough of the opening
  // is translated (more on the first request, which starts playback, than on an OFF/ON reload).
  const t0 = Date.now();
  const firstServe = !job.served;
  while (job.status !== 'done' && job.status !== 'error') {
    const waited = Date.now() - t0;
    if (waited >= SUBTITLE_WAIT_MS) break;
    const finishesInTime = etaMs(job) < SUBTITLE_WAIT_MS - waited;
    if (!finishesInTime && waited >= 1000 && openingReady(job, firstServe ? 150 : 15)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  job.served = true;
  console.log(`[serve] ${job.key} ${job.status} ${job.total ? Math.floor((job.done / job.total) * 100) : 0}% after ${Date.now() - t0}ms`);
  send(res, 200, await finishTrack(renderJob(job, cfg), job, cfg, srcUrl, refUrl, quality), 'application/x-subrip; charset=utf-8', {
    'Cache-Control': job.status === 'done' ? 'public, max-age=86400' : 'no-store',
  });
}

// Retime a reused translation to the reference subtitle, and add a short sync note when useful.
async function finishTrack(srt, job, cfg, srcUrl, refUrl, quality) {
  if (!cfg.autoSync || (!refUrl && !(cfg.syncNotes && quality === 'unverified'))) return srt;
  let cues = parseSubtitles(srt);
  let fixed = '';
  if (refUrl && job.status !== 'error') {
    try {
      const a = await Promise.race([alignmentFor(srcUrl, refUrl), new Promise((r) => setTimeout(() => r(null), 3000))]);
      if (a && a.ok && !isNoop(a)) {
        cues = retimeCues(cues, a.map);
        fixed = describeFix(a, cfg.targetLang === 'ell' ? 'el' : 'en');
      }
    } catch (e) {
      console.error(`[sync] retime failed: ${e.message}`);
    }
  }
  if (cfg.syncNotes && job.status === 'done') {
    const el = cfg.targetLang === 'ell';
    let note = null;
    if (fixed) note = el ? `⏱ Ο συγχρονισμός διορθώθηκε αυτόματα (${fixed})` : `⏱ Timing corrected automatically (${fixed})`;
    else if (quality === 'unverified') {
      note = el
        ? '⚠ Δεν βρέθηκε υπότιτλος για αυτή ακριβώς την έκδοση.\nΑν δεν συγχρονίζει: μενού υποτίτλων (CC) → Καθυστέρηση'
        : "⚠ No subtitle found for this exact release.\nIf it's out of sync: subtitles menu (CC) → Delay";
    }
    if (note) cues.push({ start: 500, end: 5000, text: note });
  }
  cues.sort((a, b) => a.start - b.start);
  return toSrt(cues);
}

// Wrong passwords are slowed down and an address is locked out for 15 minutes after 10 failures.
const pwFails = new Map();
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '');
  const fromProxy = /^(::ffff:)?127\.|^::1$/.test(peer); // nginx on this machine passes the visitor's IP
  return fromProxy ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || peer).split(',')[0].trim() : peer;
}
function isExternalRequest(req) {
  return Boolean(EXTERNAL_URL) && knownBaseFor(req) === EXTERNAL_URL;
}
async function checkPassword(body, req) {
  if (!CONFIG_PASSWORD) {
    if (isExternalRequest(req)) {
      const e = new Error('The configuration page can only be used from outside your home network when the server has a password (CONFIG_PASSWORD). Re-run the installer with --public-ip, which sets one, or use the page at home.');
      e.code = 403;
      throw e;
    }
    return;
  }
  const ip = clientIp(req);
  const f = pwFails.get(ip);
  if (f && f.count >= 10 && Date.now() - f.at < 15 * 60e3) {
    const e = new Error('Too many wrong passwords. Try again in 15 minutes.');
    e.code = 429;
    throw e;
  }
  if (body.password !== CONFIG_PASSWORD) {
    pwFails.set(ip, { count: (f && Date.now() - f.at < 15 * 60e3 ? f.count : 0) + 1, at: Date.now() });
    await new Promise((r) => setTimeout(r, 1000));
    const e = new Error('Wrong configuration password');
    e.code = 401;
    throw e;
  }
  pwFails.delete(ip);
}

async function handleApi(req, res, action) {
  try {
    const body = await readBody(req);
    await checkPassword(body, req);
    if (action === 'encode') {
      const cfg = normalizeConfig(body.config || {});
      const pa = PROVIDERS[cfg.provider].auth;
      if (pa === 'chatgpt') {
        if (!cfg.credId) throw new Error('Sign in with ChatGPT first');
        if (!cfg.model) throw new Error('Choose a model (click "Load models")');
      } else if (!cfg.apiKey && !cfg.credId && cfg.provider !== 'custom') {
        throw new Error(pa ? 'Sign in or paste an API key first' : 'An API key is required for this provider');
      }
      const token = encodeConfig(cfg);
      // Install links for each configured address: "home" (LAN) and "external" (works anywhere).
      const link = (base) => {
        const manifestUrl = `${base}/${token}/manifest.json`;
        return { manifestUrl, stremioUrl: manifestUrl.replace(/^https?:\/\//, 'stremio://') };
      };
      const links = { home: link(PUBLIC_URL || baseUrl(req)) };
      if (EXTERNAL_URL) links.external = link(EXTERNAL_URL);
      const chosen = body.target === 'external' && links.external ? links.external : body.target === 'home' ? links.home : link(baseUrl(req));
      return send(res, 200, { token, ...chosen, links });
    }
    if (action === 'models') {
      const cfg = normalizeConfig(body.config || {});
      return send(res, 200, { models: await listModels(cfg) });
    }
    if (action === 'test') {
      const cfg = normalizeConfig(body.config || {});
      const started = Date.now();
      const out = await translateLines(
        { 1: "Where were you last night? I've been calling you for hours!", 2: '<i>Come on, we have to go.</i>' },
        [],
        cfg,
      );
      if (!out['1']) throw new Error('The model replied, but not in the expected format. Try another model.');
      return send(res, 200, { ok: true, sample: out, ms: Date.now() - started });
    }
    if (action === 'oauth/openrouter/start') {
      if (!KNOWN_BASES.length && !/^https:/.test(baseUrl(req))) throw new Error('OpenRouter sign-in needs the HTTPS address (set PUBLIC_URL).');
      return send(res, 200, { url: auth.openrouterStart(baseUrl(req), { limit: body.limit }) });
    }
    if (action === 'oauth/chatgpt/start') {
      return send(res, 200, { url: auth.chatgptStart({ credId: body.credId }), redirect: auth.CHATGPT_REDIRECT });
    }
    if (action === 'oauth/chatgpt/finish') {
      return send(res, 200, await auth.chatgptFinish(body.url));
    }
    if (action === 'oauth/xai/start') {
      return send(res, 200, await auth.xaiStart());
    }
    if (action === 'oauth/xai/poll') {
      return send(res, 200, await auth.xaiPoll(body.pendingId));
    }
    if (action === 'credential') {
      return send(res, 200, { credential: auth.credSummary(body.credId) });
    }
    send(res, 404, { error: 'Unknown action' });
  } catch (e) {
    send(res, [401, 403, 429].includes(e.code) ? e.code : 400, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const { pathname } = new URL(req.url, 'http://x');
    let m;

    if (req.method === 'POST' && (m = pathname.match(/^\/api\/(encode|models|test|credential|oauth\/openrouter\/start|oauth\/chatgpt\/start|oauth\/chatgpt\/finish|oauth\/xai\/start|oauth\/xai\/poll)$/))) {
      return handleApi(req, res, m[1]);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });

    if (pathname === '/') return send(res, 302, '', 'text/plain', { Location: '/configure' });
    if (pathname === '/health') return send(res, 200, { ok: true, version: pkg.version });
    if (pathname === '/status') return send(res, 200, { jobs: status() });
    // Always configure on the public HTTPS address (needed for sign-in callbacks and Stremio installs).
    if (PUBLIC_URL && /(^|\/)configure$/.test(pathname) && !knownBaseFor(req)) {
      return send(res, 302, '', 'text/plain', { Location: `${PUBLIC_URL}${pathname}` });
    }
    if (pathname === '/oauth/openrouter/callback') {
      const q = new URL(req.url, 'http://x').searchParams;
      try {
        if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'));
        const credId = await auth.openrouterFinish(q.get('code'), q.get('state'));
        return send(res, 302, '', 'text/plain', { Location: `/configure#cred=${credId}` });
      } catch (e) {
        return send(res, 302, '', 'text/plain', { Location: `/configure#autherror=${encodeURIComponent(e.message)}` });
      }
    }
    if (pathname === '/configure') return send(res, 200, renderPage(null), 'text/html; charset=utf-8');
    if (pathname === '/manifest.json') return send(res, 200, manifest(null, baseUrl(req)));
    if (pathname === '/logo.png' || pathname === '/background.png') {
      return send(res, 200, STATIC[pathname], 'image/png', { 'Cache-Control': 'public, max-age=604800' });
    }

    if ((m = pathname.match(/^\/([\w-]{20,})\/configure$/))) {
      return send(res, 200, renderPage(decodeConfig(m[1])), 'text/html; charset=utf-8');
    }
    if ((m = pathname.match(/^\/([\w-]{20,})\/manifest\.json$/))) {
      const cfg = decodeConfig(m[1]);
      return send(res, 200, manifest(cfg, baseUrl(req)));
    }
    if ((m = pathname.match(/^\/([\w-]{20,})\/subtitles\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/))) {
      return await handleSubtitles(req, res, m[1], m[2], m[3], m[4]);
    }
    if ((m = pathname.match(/^\/([\w-]{20,})\/report\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/))) {
      return await handleReport(req, res, m[1], m[2], m[3], m[4] || '');
    }
    if ((m = pathname.match(/^\/([\w-]{20,})\/stream\/([^/]+)\/([^/]+?)\.json$/))) {
      return await handleStream(req, res, m[1], m[2], m[3]);
    }
    if ((m = pathname.match(/^\/([\w-]{20,})\/t\/([\w-]+)\/([\w-]+)\.srt$/))) {
      return await handleTranslation(req, res, m[1], m[2], m[3]);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AIO-Streams&Subtitles-Greek v${pkg.version} listening on http://${HOST}:${PORT}`);
  if (PUBLIC_URL) console.log(`Home network address: ${PUBLIC_URL}`);
  if (EXTERNAL_URL) console.log(`External address:     ${EXTERNAL_URL}${CONFIG_PASSWORD ? '' : '  (WARNING: no CONFIG_PASSWORD — the configure page is refused from outside)'}`);
  console.log(`Open http://<this-machine>:${PORT}/configure to set it up.`);
});
