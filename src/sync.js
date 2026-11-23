'use strict';
// Making sure the English subtitle we translate belongs to the video being played, and is in sync with it.
//
//  1. Fingerprint + type checks  — OpenSubtitles hash match, release name / group / source / edition
//                                  compared with the video's filename; rejects CD-split, forced-only,
//                                  wrong-episode, movie-vs-episode and non-English files.
//  2. Length check               — subtitle span compared with the reference subtitle and the runtime
//                                  from Cinemeta (catches partial files and other cuts / releases).
//  3. Frame-rate detection       — 23.976 / 24 / 25 / 29.97 / 30 fps ratios found from the length and
//                                  from alignment, then rescaled.
//  4. Alignment                  — retimes a subtitle against the best-matching English reference
//                                  (shared lines as anchors, elastic across cuts; timing-pattern
//                                  matching when the wording differs).
//
// Stremio never gives subtitle addons the video or its embedded tracks, so the reference is always the
// English subtitle that best matches the release (ideally an OpenSubtitles hash match).

const { decodeBuffer, legacyEncodingFor, parseSubtitles } = require('./subtitles');

// ---------------------------------------------------------------------------------------------------
// Downloads (shared with the translator, so a subtitle is fetched once)

const downloads = new Map(); // url -> { at, promise }
const DOWNLOAD_TTL = 30 * 60e3;
const knownFps = new Map(); // url -> frame rate the source says the subtitle was made for (MicroDVD needs it)

function rememberFps(url, fps) {
  if (knownFps.size > 5000) knownFps.clear();
  if (fps > 10 && fps < 61) knownFps.set(url, fps);
}

function downloadCues(url, opts = {}) {
  const now = Date.now();
  for (const [k, v] of downloads) if (now - v.at > DOWNLOAD_TTL) downloads.delete(k);
  opts = { ...opts, fps: opts.fps || knownFps.get(url) };
  const key = `${url}|${opts.fps || ''}`;
  const hit = downloads.get(key);
  if (hit) return hit.promise;
  const promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout || 30000), redirect: 'follow' });
    if (!res.ok) throw new Error(`Could not download source subtitle (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('Source subtitle is too large');
    return parseSubtitles(decodeBuffer(buf, opts.legacyEncoding), { fps: opts.fps });
  })();
  downloads.set(key, { at: now, promise });
  promise.catch(() => downloads.delete(key));
  return promise;
}

// ---------------------------------------------------------------------------------------------------
// 1. Release fingerprint

const SOURCE_RULES = [
  [/\b(?:bd)?remux\b/i, 'bluray'],
  [/\b(?:blu-?ray|bdrip|brrip|bd25|bd50|bdmv|uhd-?bd)\b/i, 'bluray'],
  [/\bweb(?:[-. ]?(?:dl|rip))?\b/i, 'web'],
  [/\b(?:hdtv|pdtv|dsr|tvrip|satrip|dvb)\b/i, 'tv'],
  [/\b(?:dvd-?rip|dvdr|dvd5|dvd9|dvdscr|ntsc|pal)\b/i, 'dvd'],
  [/\b(?:hdrip|hd-?cam|cam-?rip|cam|telesync|ts|telecine|tc|r5)\b/i, 'cam'],
];
const SERVICES = ['amzn', 'nf', 'dsnp', 'atvp', 'hmax', 'max', 'hulu', 'pcok', 'pmtp', 'stan', 'crav', 'it', 'red', 'cc', 'bcore'];
const EDITIONS = [
  [/\bextended\b/i, 'extended'],
  [/\bdirector'?s?[ ._-]?cut\b|\bdc\b/i, 'directors'],
  [/\bunrated\b|\buncut\b/i, 'unrated'],
  [/\btheatrical\b/i, 'theatrical'],
  [/\bimax\b/i, 'imax'],
  [/\bfinal[ ._-]?cut\b/i, 'final'],
  [/\bspecial[ ._-]?edition\b/i, 'special'],
];

function parseRelease(name) {
  const raw = String(name || '');
  const n = raw.replace(/\.(srt|sub|ass|ssa|vtt|txt|mkv|mp4|avi|m4v|ts|webm)$/i, '').replace(/[._]+/g, ' ');
  const rel = {
    raw,
    source: null,
    services: [],
    resolution: (/(2160|1080|720|576|480)[pi]\b/i.exec(n) || [])[1] || (/\b4k\b|\buhd\b/i.test(n) ? '2160' : null),
    edition: null,
    group: null,
    repack: /\b(repack|proper|rerip)\b/i.test(n),
    // "CD1" / "Disc 2" splits ("Part 1" is often part of a title, so it isn't treated as a split).
    cd: /\b(?:cd|disc|disk)\s?[1-9]\b/i.test(n),
    forced: /\bforced\b|\bforeign[ ._-]?(?:parts?|only)\b/i.test(n),
    hi: /\b(?:hi|sdh|cc|hearing[ ._-]?impaired)\b/i.test(n),
    season: null,
    episode: null,
  };
  for (const [re, src] of SOURCE_RULES) if (re.test(n)) { rel.source = src; break; }
  for (const s of SERVICES) if (new RegExp(`\\b${s}\\b`, 'i').test(n) && /\bweb/i.test(n)) rel.services.push(s);
  for (const [re, ed] of EDITIONS) if (re.test(n)) { rel.edition = ed; break; }
  const se = /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i.exec(n) || /\b(\d{1,2})x(\d{2,3})\b/.exec(n);
  if (se) { rel.season = parseInt(se[1], 10); rel.episode = parseInt(se[2], 10); }
  const g = /-\s?([A-Za-z0-9]{2,20})(?:\s?\[[^\]]*\])?\s*$/.exec(raw.replace(/\.(srt|sub|ass|ssa|vtt|txt|mkv|mp4|avi|m4v)$/i, '').replace(/\.(hi|sdh|eng?|english|forced)$/i, ''));
  if (g && !/^(dl|rip|hd|sd|cd\d)$/i.test(g[1])) rel.group = g[1].toLowerCase();
  return rel;
}

// What we know about the video being played (from the Stremio id and the request "extra").
function matchContext(type, id, extra) {
  const q = new URLSearchParams(String(extra || '').replace(/\.json$/, ''));
  let sid = String(id || '');
  try { sid = decodeURIComponent(sid); } catch { /* keep as is */ }
  const parts = sid.split(':');
  const ctx = { type, filename: q.get('filename') || '', videoHash: q.get('videoHash') || '', videoSize: parseInt(q.get('videoSize') || '0', 10) || 0, season: null, episode: null, imdbId: /^tt\d+$/.test(parts[0]) ? parts[0] : null };
  if (type === 'series') {
    if (parts[0] === 'kitsu') ctx.episode = parseInt(parts[2] || parts[1], 10) || null;
    else if (parts.length >= 3) { ctx.season = parseInt(parts[1], 10); ctx.episode = parseInt(parts[2], 10); }
  }
  ctx.release = ctx.filename ? parseRelease(ctx.filename) : null;
  return ctx;
}

// Scores one subtitle candidate (source metadata only, before download). Higher is better.
function fingerprint(meta, ctx) {
  const reasons = [];
  let score = 0;
  let reject = null;
  const names = [meta.movieReleaseName, meta.subtitleFileName].filter(Boolean);
  const rel = parseRelease(names.join(' '));
  if (meta.releaseGroup) rel.group = String(meta.releaseGroup).toLowerCase();
  const hash = meta.m === 'h' || meta.moviehashMatch === true || meta.hashMatch === true;
  if (hash) { score += 100; reasons.push('hash match'); }

  // Wrong type for this media.
  const fileRel = parseRelease(meta.subtitleFileName || '');
  if (fileRel.cd || rel.cd) reject = 'split into CDs/parts (only covers part of the video)';
  else if (fileRel.forced || rel.forced) reject = 'forced/foreign-parts only';
  if (ctx.type === 'series') {
    const s = meta.season || rel.season;
    const e = meta.episode || rel.episode;
    if (ctx.episode && e && e !== ctx.episode && !(meta.season === 0 && meta.episode === 0)) reject = reject || `wrong episode (E${e})`;
    if (ctx.season && s && s !== ctx.season && !(meta.season === 0 && meta.episode === 0)) reject = reject || `wrong season (S${s})`;
  } else if (ctx.type === 'movie' && (meta.episode > 0 || rel.episode)) {
    reject = reject || 'episode subtitle for a movie';
  }
  if (rel.hi) { score -= 4; reasons.push('hearing-impaired'); }

  // Compare the release with the video filename.
  const v = ctx.release;
  if (v) {
    if (v.group && rel.group && v.group === rel.group) { score += 40; reasons.push(`same group (${rel.group})`); }
    if (v.source && rel.source) {
      if (v.source === rel.source) { score += 15; reasons.push(`same source (${rel.source})`); } else { score -= 15; reasons.push(`different source (${rel.source} vs ${v.source})`); }
    }
    if (v.services.length && rel.services.some((s) => v.services.includes(s))) { score += 10; reasons.push('same streaming service'); }
    if (v.resolution && rel.resolution === v.resolution) score += 3;
    if (v.edition || rel.edition) {
      if (v.edition === rel.edition) { score += 20; reasons.push(`same edition (${rel.edition})`); } else { score -= 40; reasons.push(`different edition (${rel.edition || 'standard'} vs ${v.edition || 'standard'})`); }
    }
    if (v.repack && rel.repack) score += 3;
  }
  return { score, hash, reject, reasons, release: rel, fps: meta.fpsMilli ? meta.fpsMilli / 1000 : null };
}

// ---------------------------------------------------------------------------------------------------
// Content profile and language check

const EN_WORDS = new Set('the you i to a and it is that what of in me this we be have not are your on do no for my he was with just know can all so get but here there they she him her don\'t i\'m it\'s you\'re got go yeah right well like oh okay come out up about one will now how want think would if at as or there\'s let\'s'.split(' '));

function profile(cues) {
  if (!cues || !cues.length) return { count: 0, start: 0, end: 0, english: 0 };
  let words = 0;
  let en = 0;
  for (const c of cues.length > 400 ? cues.filter((_, i) => i % Math.ceil(cues.length / 400) === 0) : cues) {
    for (const w of c.text.toLowerCase().replace(/<[^>]+>/g, ' ').split(/[^a-z']+/)) {
      if (!w) continue;
      words++;
      if (EN_WORDS.has(w)) en++;
    }
  }
  const end = cues.reduce((m, c) => Math.max(m, c.end), 0);
  return { count: cues.length, start: cues[0].start, end, english: words ? en / words : 0 };
}

// ---------------------------------------------------------------------------------------------------
// 2. Runtime (Cinemeta) and the length check

const runtimes = new Map();
const CINEMETA = (process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io').replace(/\/+$/, '');

async function expectedRuntime(ctx) {
  if (!ctx.imdbId) return null;
  const key = `${ctx.type}:${ctx.imdbId}`;
  const hit = runtimes.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.ms;
  let ms = null;
  try {
    const r = await fetch(`${CINEMETA}/meta/${ctx.type}/${ctx.imdbId}.json`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    const rt = String((j.meta && j.meta.runtime) || '');
    const h = /(\d+)\s*h/i.exec(rt);
    const m = /(\d+)\s*m/i.exec(rt);
    const total = (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
    if (total > 0) ms = total * 60000;
  } catch { /* no runtime */ }
  runtimes.set(key, { at: Date.now(), ms });
  return ms;
}

const FPS_LIST = [23.976, 24, 25, 29.97, 30];
// Multiplying a subtitle's times by one of these converts it from one frame rate to another.
const SCALES = (() => {
  const set = new Map([['1.000000', 1]]);
  for (const a of FPS_LIST) for (const b of FPS_LIST) {
    if (a === b) continue;
    const r = a / b;
    if (r > 0.79 && r < 1.27) set.set(r.toFixed(6), r);
  }
  return [...set.values()].sort((x, y) => Math.abs(x - 1) - Math.abs(y - 1));
})();

function fpsName(scale) {
  // Times × (a / b) converts a subtitle made for `a` fps to a `b` fps video.
  for (const a of FPS_LIST) for (const b of FPS_LIST) if (a !== b && Math.abs(a / b - scale) < 0.0008) return `${a} → ${b} fps`;
  return null;
}

// Is the subtitle as long as the video? `ref` = profile of the reference subtitle, `runtimeMs` from Cinemeta.
function lengthVerdict(prof, { refEnd = null, runtimeMs = null, series = false } = {}) {
  if (!prof || !prof.count) return { ok: false, reason: 'no readable lines' };
  if (refEnd) {
    const r = prof.end / refEnd;
    if (Math.abs(r - 1) <= 0.02) return { ok: true, basis: 'reference', ratio: r };
    const fix = SCALES.filter((s) => s !== 1 && Math.abs(r * s - 1) < 0.006).sort((a, b) => Math.abs(r * a - 1) - Math.abs(r * b - 1))[0];
    if (fix) return { ok: false, basis: 'reference', ratio: r, fpsScale: fix, reason: `frame-rate mismatch (${fpsName(fix)})` };
    if (r < 0.6) return { ok: false, basis: 'reference', ratio: r, partial: true, reason: `covers only ${Math.round(r * 100)}% of the video` };
    if (Math.abs(r - 1) > 0.08) return { ok: false, basis: 'reference', ratio: r, reason: `different cut/release (${r > 1 ? 'longer' : 'shorter'} by ${Math.round(Math.abs(r - 1) * 100)}%)` };
    return { ok: true, basis: 'reference', ratio: r, drift: true };
  }
  if (runtimeMs) {
    const r = prof.end / runtimeMs;
    const lo = series ? 0.45 : 0.6;
    const hi = series ? 1.4 : 1.06;
    if (r < lo) return { ok: false, basis: 'runtime', ratio: r, partial: r < lo * 0.8, reason: `ends at ${Math.round(r * 100)}% of the runtime (partial?)` };
    if (r > hi) return { ok: false, basis: 'runtime', ratio: r, reason: `runs ${Math.round((r - 1) * 100)}% past the runtime (other cut or frame rate?)` };
    return { ok: true, basis: 'runtime', ratio: r };
  }
  return { ok: null, basis: 'none' };
}

// ---------------------------------------------------------------------------------------------------
// 3 + 4. Alignment of a subtitle (src) against a reference (ref)

function normText(t) {
  return String(t)
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Lines that appear exactly once in both files, paired in order (longest increasing subsequence).
function textAnchors(src, ref) {
  const index = (cues) => {
    const m = new Map();
    cues.forEach((c, i) => {
      const keys = new Set([normText(c.text), ...c.text.split('\n').map(normText)]);
      for (const k of keys) if (k.length >= 6) m.set(k, m.has(k) && m.get(k) !== i ? -1 : i);
    });
    return m;
  };
  const a = index(src);
  const b = index(ref);
  const seen = new Set();
  const pairs = [];
  for (const [k, i] of a) {
    const j = b.get(k);
    if (i >= 0 && j !== undefined && j >= 0 && !seen.has(`${i}:${j}`)) { seen.add(`${i}:${j}`); pairs.push([i, j]); }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  // Longest strictly increasing subsequence in j (drops pairs that cross).
  const tails = [];
  const prev = new Array(pairs.length).fill(-1);
  for (let p = 0; p < pairs.length; p++) {
    const j = pairs[p][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[p] = tails[lo - 1];
    tails[lo] = p;
  }
  const out = [];
  for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = prev[p]) out.push(pairs[p]);
  return out.reverse();
}

function densest(sorted, width) {
  let best = 0;
  let at = 0;
  for (let lo = 0, hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > width) lo++;
    if (hi - lo + 1 > best) { best = hi - lo + 1; at = lo; }
  }
  return { count: best, center: sorted.length ? sorted[at + (best >> 1)] : 0 };
}

function regress(pts) {
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx;
  if (!den) return null;
  const a = (n * sxy - sx * sy) / den;
  return { scale: a, offset: (sy - a * sx) / n };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

// Global scale+offset from point pairs (x = src time, y = ref time), trying every frame-rate ratio.
function fitGlobal(pts, tolerance = 500) {
  let best = null;
  for (const s of SCALES) {
    const offs = pts.map(([x, y]) => y - s * x).sort((a, b) => a - b);
    const d = densest(offs, tolerance * 0.8);
    if (!best || d.count > best.count) best = { scale: s, offset: d.center, count: d.count };
  }
  if (!best) return null;
  let inl = pts.filter(([x, y]) => Math.abs(y - (best.scale * x + best.offset)) < tolerance);
  if (inl.length >= 8) {
    const r = regress(inl);
    if (r && Math.abs(r.scale - best.scale) < 0.002) best = { ...best, ...r };
    else best.offset = median(inl.map(([x, y]) => y - best.scale * x));
    inl = pts.filter(([x, y]) => Math.abs(y - (best.scale * x + best.offset)) < tolerance);
  }
  return { scale: best.scale, offset: best.offset, inliers: inl.length };
}

// Fallback when the wording differs: match the rhythm of cue start times.
function timingFit(src, ref) {
  const xs = src.map((c) => c.start);
  const ys = ref.map((c) => c.start);
  let best = null;
  for (const s of SCALES) {
    const bins = new Map();
    let j0 = 0;
    for (const x of xs) {
      const sx = s * x;
      while (j0 < ys.length && ys[j0] < sx - 120000) j0++;
      for (let j = j0; j < ys.length && ys[j] <= sx + 120000; j++) {
        const b = Math.round((ys[j] - sx) / 100);
        bins.set(b, (bins.get(b) || 0) + 1);
      }
    }
    let peak = 0;
    let at = 0;
    for (const [b, n] of bins) { const v = n + (bins.get(b - 1) || 0) + (bins.get(b + 1) || 0); if (v > peak) { peak = v; at = b; } }
    const offset = at * 100;
    // Count one-to-one matches within 300 ms.
    let matches = 0;
    let j = 0;
    for (const x of xs) {
      const t = s * x + offset;
      while (j < ys.length && ys[j] < t - 300) j++;
      if (j < ys.length && Math.abs(ys[j] - t) <= 300) { matches++; j++; }
    }
    if (!best || matches > best.matches) best = { scale: s, offset, matches };
  }
  return best;
}

/**
 * Finds how to retime `src` so that it matches `ref`.
 * Returns { ok, method, scale, offset, piecewise, anchors, inliers, confidence, maxShift, map(t) }.
 */
function align(src, ref) {
  const fail = (why) => ({ ok: false, reason: why, map: (t) => t, scale: 1, offset: 0 });
  if (!src || !ref || src.length < 10 || ref.length < 10) return fail('not enough lines');
  const anchors = textAnchors(src, ref);
  const minN = Math.min(src.length, ref.length);

  if (anchors.length >= Math.max(12, minN * 0.08)) {
    const pts = anchors.map(([i, j]) => [src[i].start, ref[j].start]);
    const g = fitGlobal(pts);
    const share = g.inliers / pts.length;
    // Residuals after the global fit, median-filtered: steps mean the cuts differ (ads, recaps, scenes).
    const res = pts.map(([x, y]) => y - (g.scale * x + g.offset));
    const w = 4;
    const smooth = res.map((_, k) => median(res.slice(Math.max(0, k - w), k + w + 1)));
    const knots = pts.map(([x], k) => [x, smooth[k]]);
    const stepped = smooth.filter((d) => Math.abs(d) > 400).length / smooth.length > 0.08;
    const piecewise = share < 0.9 && stepped;
    // Piecewise-linear through every anchor's smoothed residual (binary search).
    const interp = (t) => {
      if (!piecewise) return 0;
      if (t <= knots[0][0]) return knots[0][1];
      if (t >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];
      let lo = 0;
      let hi = knots.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (knots[mid][0] <= t) lo = mid; else hi = mid; }
      const [x0, y0] = knots[lo];
      const [x1, y1] = knots[hi];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    };
    const map = (t) => g.scale * t + g.offset + interp(t);
    const fitted = piecewise ? pts.filter(([x, y]) => Math.abs(y - map(x)) < 500).length : g.inliers;
    const confidence = fitted / pts.length;
    if (confidence < 0.6) return fail(`anchors disagree (${Math.round(confidence * 100)}% fit)`);
    const shifts = src.map((c) => Math.abs(map(c.start) - c.start));
    return { ok: true, method: piecewise ? 'text-elastic' : 'text', scale: g.scale, offset: g.offset, piecewise, anchors: pts.length, inliers: fitted, confidence, maxShift: Math.max(...shifts), map };
  }

  const t = timingFit(src, ref);
  const confidence = t.matches / minN;
  if (confidence < 0.5) return fail(`no reliable match (${Math.round(confidence * 100)}% of cue times)`);
  const map = (x) => t.scale * x + t.offset;
  return { ok: true, method: 'timing', scale: t.scale, offset: t.offset, piecewise: false, anchors: 0, inliers: t.matches, confidence, maxShift: Math.max(...src.map((c) => Math.abs(map(c.start) - c.start))), map };
}

// Does an alignment actually change anything noticeable?
function isNoop(a) {
  return !a || !a.ok || (a.maxShift < 150 && Math.abs(a.scale - 1) < 0.0005);
}

function retimeCues(cues, map) {
  const out = cues.map((c) => {
    const start = Math.max(0, Math.round(map(c.start)));
    return { ...c, start, end: Math.max(start + 300, Math.round(map(c.end))) };
  });
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Short human description, e.g. "25 → 23.976 fps, +1.2 s".
function describeFix(a, lang = 'en') {
  if (!a || !a.ok) return '';
  const parts = [];
  const fps = Math.abs(a.scale - 1) > 0.0005 ? fpsName(a.scale) : null;
  if (fps) parts.push(lang === 'el' ? fps.replace(/\./g, ',') : fps);
  if (Math.abs(a.offset) >= 100 || !fps) {
    const s = (a.offset / 1000).toFixed(1);
    parts.push(`${a.offset >= 0 ? '+' : ''}${lang === 'el' ? s.replace('.', ',') : s} ${lang === 'el' ? 'δ' : 's'}`);
  }
  if (a.piecewise) parts.push(lang === 'el' ? 'διορθώσεις ανά σκηνή' : 'per-scene corrections');
  return parts.join(', ');
}

const alignCache = new Map();
async function alignmentFor(srcUrl, refUrl, opts = {}) {
  const key = `${srcUrl}|${refUrl}`;
  const hit = alignCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.result;
  const [src, ref] = await Promise.all([downloadCues(srcUrl, { fps: opts.srcFps }), downloadCues(refUrl, { fps: opts.refFps })]);
  const result = align(src, ref);
  if (alignCache.size > 500) alignCache.clear();
  alignCache.set(key, { at: Date.now(), result });
  return result;
}

module.exports = {
  downloadCues,
  rememberFps,
  parseRelease,
  matchContext,
  fingerprint,
  profile,
  expectedRuntime,
  lengthVerdict,
  align,
  alignmentFor,
  isNoop,
  retimeCues,
  describeFix,
  fpsName,
  SCALES,
};
