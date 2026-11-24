'use strict';
// Chooses which English subtitle to translate for the video being played, verifies it, and decides
// whether an existing translation can be reused after retiming. See src/sync.js for the checks.

const {
  fingerprint, matchContext, profile, expectedRuntime, lengthVerdict, downloadCues, align, isNoop, describeFix, rememberFps, SCALES, fpsName,
} = require('./sync');
const { legacyEncodingFor } = require('./subtitles');
const { translationState } = require('./translator');

function isTargetLanguage(value, target) {
  const code = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return code === target || (target === 'ell' && ['el', 'gre', 'greek', 'ελληνικά'].includes(code));
}

const isEnglish = (lang) => ['eng', 'en', 'english', 'en-us', 'en-gb'].includes(String(lang || '').toLowerCase());

async function fetchSourceSubs(cfg, type, id, extra, ctx) {
  const suffix = extra ? `/${extra}` : '';
  const sources = [...new Set([...cfg.sources, ...cfg.prioritySources])];
  const responses = await Promise.all(
    sources.map(async (base) => {
      try {
        const r = await fetch(`${base}/subtitles/${type}/${id}${suffix}.json`, { signal: AbortSignal.timeout(4500) });
        if (!r.ok) return [];
        const j = await r.json();
        return Array.isArray(j.subtitles) ? j.subtitles : [];
      } catch {
        return [];
      }
    }),
  );
  const hasPreferred = responses.some((list, i) =>
    cfg.prioritySources.includes(sources[i]) &&
    list.some((s) => s?.url && isTargetLanguage(s.lang, cfg.targetLang) && !fingerprint(s, ctx).reject),
  );
  const results = cfg.sources.map((source) => responses[sources.indexOf(source)]);
  const seen = new Set();
  const out = [];
  // Interleave sources so each configured addon contributes its best match first.
  const maxLen = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of results) {
      const s = list[i];
      if (s && s.url && isEnglish(s.lang) && !seen.has(s.url)) {
        seen.add(s.url);
        out.push(s);
      }
    }
  }
  // Subtitles already in the target language, from every configured source (not just prioritySources) —
  // candidates for cfg.nativeSubtitles (use the real subtitle instead of translating one with AI).
  const nativeSeen = new Set();
  const native = [];
  for (const list of responses) {
    for (const s of list) {
      if (s && s.url && isTargetLanguage(s.lang, cfg.targetLang) && !nativeSeen.has(s.url)) {
        nativeSeen.add(s.url);
        native.push(s);
      }
    }
  }
  return { list: out, native, hasPreferred };
}

// Checks whether a subtitle already in the target language is good enough to use as-is (same checks as
// the English pipeline: release fingerprint, then length against the reference or the runtime).
async function pickNative(cfg, candidates, ctx, { refEnd = null, runtimeMs = null, series = false, ref = null } = {}) {
  if (cfg.nativeSubtitles === 'off' || !candidates.length) return null;
  const cands = candidates.map((s, i) => ({ url: s.url, meta: s, order: i, fp: fingerprint(s, ctx) }));
  const accepted = cands.filter((c) => !c.fp.reject).sort(byRank);
  if (!accepted.length) return null;
  const top = accepted.slice(0, 3);
  const legacyEncoding = legacyEncodingFor(cfg.targetLang);
  await withBudget(
    Promise.allSettled(top.map(async (c) => {
      c.cues = await downloadCues(c.url, { timeout: 6000, legacyEncoding });
    })),
    1800,
  );
  for (const c of top) {
    if (!c.cues || c.cues.length < 20) { c.reject = 'too few lines (forced or broken file)'; continue; }
    const end = c.cues.reduce((m, x) => Math.max(m, x.end), 0);
    c.length = lengthVerdict({ count: c.cues.length, end }, { refEnd, runtimeMs, series });
    if (c.length.partial) c.reject = c.length.reason;
  }
  const pool = top.filter((c) => !c.reject);
  const best = (pool.length ? pool : top).sort(byRank)[0];
  if (!best) return null;
  const verified = !best.reject && Boolean(best.fp.hash || best.fp.score >= 40 || (best.length && best.length.ok === true));
  const quality = best.reject ? 'unverified' : best.fp.hash ? 'hash' : best.fp.score >= 40 ? 'release' : best.length && best.length.ok ? 'length' : 'unverified';
  const why =
    best.reject ||
    (best.fp.hash ? 'hash match' : best.fp.score >= 40 ? 'release match' : best.length && best.length.ok ? `length ok (${best.length.basis})` : 'found, not confirmed to match this release');
  // Unless it is a hash match, retime it against the English subtitle that best fits this video (when known):
  // fixes delays, PAL 25 fps timings and TV cuts that a real subtitle from another release would have.
  const timingRef = !best.fp.hash && ref && ref.url !== best.url ? ref : null;
  return {
    url: best.url, file: best.meta.subtitleFileName || best.url, verified, quality, why, rejected: Boolean(best.reject),
    fps: best.fp.fps || null, ref: timingRef ? timingRef.url : null, refFps: timingRef ? timingRef.fps : null, refQuality: timingRef ? timingRef.q : null,
  };
}

const withBudget = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(undefined), ms))]);
const rank = (c) => c.fp.score - (c.penalty || 0);
const byRank = (a, b) => rank(b) - rank(a) || a.order - b.order;
const fmtMin = (ms) => (ms ? `${Math.round(ms / 60000)} min` : null);

/**
 * Returns { tracks: [{ src, ref, q }], report }.
 *   src — English subtitle URL to translate
 *   ref — English reference to retime the translation to (when reusing another release's translation)
 *   q   — how well the subtitle is known to match: hash | release | length | unverified
 */
async function selectSubtitles(cfg, type, id, extra = '', opts = {}) {
  const ctx = matchContext(type, id, extra);
  const { list, native, hasPreferred } = await fetchSourceSubs(cfg, type, id, extra, ctx);
  const report = {
    video: { type, id, filename: ctx.filename || null, hash: Boolean(ctx.videoHash), release: ctx.release ? { group: ctx.release.group, source: ctx.release.source, edition: ctx.release.edition } : null },
    runtime: null,
    candidates: [],
    hasPreferred,
    native: null,
    decision: null,
  };
  if (!list.length) {
    const runtimeMs = (await withBudget(expectedRuntime(ctx), 400)) || null;
    report.native = await pickNative(cfg, native, ctx, { runtimeMs, series: type === 'series' });
    return { tracks: [], report };
  }

  const cands = list.map((s, i) => ({ url: s.url, meta: s, order: i, fp: fingerprint(s, ctx) }));
  for (const c of cands) if (c.fp.fps) rememberFps(c.url, c.fp.fps);

  if (!cfg.autoSync) {
    // Checks switched off: keep the source order, only prefer an existing translation among the top 3.
    const order = [...cands];
    const ready = order.slice(0, 3).findIndex((c) => translationState(c.url, cfg) !== 'none');
    if (ready > 0) order.unshift(order.splice(ready, 1)[0]);
    report.decision = { mode: 'off', chosen: order[0].meta.subtitleFileName || order[0].url };
    const runtimeMs = (await withBudget(expectedRuntime(ctx), 400)) || null;
    report.native = await pickNative(cfg, native, ctx, { runtimeMs, series: type === 'series' });
    return { tracks: order.slice(0, cfg.maxCandidates).map((c) => ({ src: c.url, ref: null, q: 'unverified' })), report };
  }

  const accepted = cands.filter((c) => !c.fp.reject).sort(byRank);
  const runtimeP = expectedRuntime(ctx);
  const top = accepted.slice(0, opts.analyze || 6);
  await withBudget(
    Promise.allSettled(top.map(async (c) => {
      c.cues = await downloadCues(c.url, { timeout: 8000 });
      c.prof = profile(c.cues);
    })),
    opts.budgetMs || 2500,
  );
  const runtimeMs = (await withBudget(runtimeP, 400)) || null;
  report.runtime = fmtMin(runtimeMs);

  // Content checks on what could be downloaded.
  for (const c of top) {
    if (!c.prof) continue;
    if (c.prof.count < 20) c.reject = 'too few lines (forced or broken file)';
    else if (c.prof.english < 0.08) c.reject = "doesn't look like English";
  }
  const valid = top.filter((c) => c.prof && !c.reject);
  const reference = valid.find((c) => c.fp.hash) || valid.find((c) => c.fp.score >= 40) || null;

  // Length check: against the reference when there is one, otherwise against the runtime.
  for (const c of valid) {
    c.length = lengthVerdict(c.prof, { refEnd: reference && c !== reference ? reference.prof.end : null, runtimeMs, series: type === 'series' });
    if (c === reference) continue;
    if (c.length.partial) c.reject = c.length.reason;
    else if (c.length.ok === false) c.penalty = (c.penalty || 0) + 30;
  }
  const pool = valid.filter((c) => !c.reject);

  let primary = reference;
  let how = reference ? (reference.fp.hash ? 'hash match' : 'release match') : null;
  if (!primary && pool.length >= 3) {
    // No fingerprint: prefer the largest group of subtitles that agree on length (an odd release stands out).
    const sizes = pool.map((c) => pool.filter((o) => Math.abs(o.prof.end / c.prof.end - 1) <= 0.02).length);
    const max = Math.max(...sizes);
    primary = pool.filter((_, k) => sizes[k] === max).sort(byRank)[0];
    how = max > 1 ? `length agrees with ${max - 1} other subtitle(s)` : 'best metadata score';
  } else if (!primary && pool.length) {
    primary = [...pool].sort(byRank)[0];
    how = 'best metadata score';
  }
  if (!primary) {
    // Nothing could be verified in time: fall back to the best candidate by metadata alone.
    primary = accepted.find((c) => !c.reject) || null;
    how = 'unverified (downloads too slow)';
  }
  if (!primary) {
    report.native = await pickNative(cfg, native, ctx, { refEnd: reference ? reference.prof.end : null, runtimeMs, series: type === 'series' });
    report.decision = { chosen: null, why: 'no usable English subtitle' };
    report.candidates = cands.map((c) => describe(c));
    return { tracks: [], report };
  }

  let q = reference ? (reference.fp.hash ? 'hash' : 'release') : primary.length && primary.length.ok ? 'length' : 'unverified';

  // Without a fingerprint, subtitles whose lengths differ by a frame-rate ratio (e.g. a 25 fps PAL group
  // against a 23.976 fps group) can't be told apart by length: unless one group clearly outnumbers the
  // other, call the choice unverified so the viewer gets the note about the player's Delay control.
  if (!reference && primary.prof && pool.length >= 2) {
    const sameGroup = pool.filter((o) => Math.abs(o.prof.end / primary.prof.end - 1) <= 0.02).length;
    let rival = 0;
    let rivalFps = null;
    for (const o of pool) {
      if (!o.prof || o === primary) continue;
      const r = o.prof.end / primary.prof.end;
      const s = SCALES.find((k) => k !== 1 && Math.abs(r * k - 1) < 0.006);
      if (s && Math.abs(r - 1) > 0.02) { rival++; rivalFps = rivalFps || fpsName(1 / s); }
    }
    if (rival && sameGroup < 2 * rival) {
      q = 'unverified';
      how += `; other subtitles differ by a frame-rate ratio (${rivalFps}?) — can't tell which fits without a release match`;
    }
  }

  // The real subtitle in the target language (OpenSubtitles first), retimed to the best English timing we have.
  const timingRef = q !== 'unverified' && primary.cues ? { url: primary.url, fps: primary.fp.fps, q } : null;
  report.native = await pickNative(cfg, native, ctx, { refEnd: reference ? reference.prof.end : null, runtimeMs, series: type === 'series', ref: timingRef });

  // Reuse an existing translation of another release, retimed to the chosen subtitle.
  let translate = primary;
  let timing = null;
  let reuse = null;
  if (cfg.autoTranslate && primary.cues && translationState(primary.url, cfg) === 'none') {
    for (const c of pool) {
      if (c === primary || !c.cues || translationState(c.url, cfg) === 'none') continue;
      const a = align(c.cues, primary.cues);
      if (a.ok && a.confidence >= 0.7) {
        translate = c;
        timing = isNoop(a) ? null : primary.url;
        reuse = { from: c.meta.subtitleFileName || c.url, fix: isNoop(a) ? 'already in sync' : describeFix(a), method: a.method, confidence: Number(a.confidence.toFixed(2)) };
        break;
      }
    }
  }

  const tracks = [{ src: translate.url, ref: timing, q }];
  for (const c of [...pool].sort(byRank)) {
    if (tracks.length >= cfg.maxCandidates) break;
    if (c !== primary && c !== translate) tracks.push({ src: c.url, ref: null, q: 'alternative' });
  }
  report.candidates = cands.map((c) => describe(c, c === primary));
  report.decision = { chosen: primary.meta.subtitleFileName || primary.url, why: how, quality: q, reuse };
  return { tracks, report, primary };
}

function describe(c, chosen = false) {
  return {
    file: c.meta.subtitleFileName || c.url,
    release: c.meta.movieReleaseName || null,
    fps: c.fp.fps,
    score: rank(c),
    reasons: c.fp.reasons,
    rejected: c.fp.reject || c.reject || null,
    lines: c.prof ? c.prof.count : null,
    ends: c.prof ? fmtMin(c.prof.end) : null,
    length: c.length ? (c.length.ok === null ? 'not checked' : c.length.ok ? `ok (${c.length.basis})` : c.length.reason) : null,
    chosen,
  };
}

module.exports = { selectSubtitles, fetchSourceSubs, isEnglish };
