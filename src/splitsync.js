'use strict';
// Split-aware timing alignment (alass-style), independent of language.
//
// Lines up a subtitle with a timing reference by comparing *when* lines are on screen, never what they say,
// so a Greek subtitle can be retimed against an English one (or, in the app, against the speech found in the
// audio). Handles, in one pass:
//   • a constant delay                            (the usual "subtitle is 2 s late")
//   • a frame-rate stretch                        (25 ↔ 23.976 / 24 / 29.97 / 30 fps, PAL speed-up)
//   • different cuts                              (TV/DVR releases with ad breaks or recaps, extended scenes,
//                                                  logos added or removed): each part gets its own delay
//
//  1. Both tracks become on/off masks at 50 ms; FFT cross-correlation finds the best delay for every
//     frame-rate ratio at once (the reference's spectrum is computed only once).
//  2. The same correlation over 10-minute stretches of the subtitle proposes delays for individual parts.
//  3. Dynamic programming picks a delay per line among those candidates, charging a penalty for every
//     change of delay, so it only splits where the overlap clearly improves (like alass's split penalty).
//  4. Tiny parts are merged into their neighbours and each part's delay is fine-tuned at 10 ms.

const STEP = 100; // ms per mask cell (delays are fine-tuned to 10 ms afterwards)
const FPS = [23.976, 24, 25, 29.97, 30];
const SCALES = (() => {
  const m = new Map([['1.000000', 1]]);
  for (const a of FPS) for (const b of FPS) if (a !== b) { const r = a / b; if (r > 0.79 && r < 1.27) m.set(r.toFixed(6), r); }
  return [...m.values()];
})();

// ------------------------------------------------------------------------------------------------- FFT

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// ------------------------------------------------------------------------------------------------- helpers

/** Merged, sorted [start, end] intervals. */
function union(cues, scale = 1, offset = 0) {
  const iv = cues.map((c) => [c.start * scale + offset, c.end * scale + offset]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

const total = (iv) => iv.reduce((n, [s, e]) => n + (e - s), 0);

/** ms of [s, e] covered by the intervals (binary search, intervals merged + sorted). */
function covered(iv, s, e) {
  let lo = 0;
  let hi = iv.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (iv[m][1] <= s) lo = m + 1; else hi = m; }
  let n = 0;
  for (let i = lo; i < iv.length && iv[i][0] < e; i++) n += Math.max(0, Math.min(e, iv[i][1]) - Math.max(s, iv[i][0]));
  return n;
}

function fill(arr, iv, origin) {
  for (const [s, e] of iv) {
    const a = Math.max(0, Math.floor((s - origin) / STEP));
    const b = Math.min(arr.length - 1, Math.ceil((e - origin) / STEP));
    for (let i = a; i < b; i++) arr[i] = 1;
  }
}

// ------------------------------------------------------------------------------------------------- correlation

/** Prepared reference: its spectrum is reused for every scale and every stretch of the subtitle. */
function prepare(refIv, tgtEndMs, maxShiftMs) {
  const refEnd = refIv.length ? refIv[refIv.length - 1][1] : 0;
  const span = Math.max(refEnd, tgtEndMs * 1.27) + 2 * maxShiftMs + 10000;
  const cells = Math.ceil(span / STEP);
  let n = 1;
  while (n < cells * 2) n <<= 1;
  const origin = -maxShiftMs - 5000;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  fill(re, refIv, origin);
  fft(re, im);
  return { n, origin, re, im, K: Math.ceil(maxShiftMs / STEP) };
}

/** Correlation (ms of overlap) of the subtitle intervals against the reference for every delay in ±maxShift. */
function correlate(P, tgtIv) {
  const re = new Float64Array(P.n);
  const im = new Float64Array(P.n);
  fill(re, tgtIv, P.origin);
  fft(re, im);
  // R · conj(T)
  for (let i = 0; i < P.n; i++) {
    const a = P.re[i]; const b = P.im[i]; const c = re[i]; const d = im[i];
    re[i] = a * c + b * d;
    im[i] = b * c - a * d;
  }
  fft(re, im, true);
  const out = new Float64Array(2 * P.K + 1);
  for (let k = -P.K; k <= P.K; k++) out[k + P.K] = re[(k + P.n) % P.n] * STEP;
  return out; // index k+K ↔ delay k·STEP ms (subtitle moved later by that much)
}

/** Like correlate(), but only for one stretch of the subtitle and delays within [lo, hi] ms — a small FFT. */
function correlateLocal(refIv, tgtIv, lo, hi) {
  if (!tgtIv.length) return { corr: new Float64Array(1), lo };
  const t0 = tgtIv[0][0];
  const t1 = tgtIv[tgtIv.length - 1][1];
  const origin = t0 + lo - 2 * STEP;
  const cells = Math.ceil((t1 + hi - origin) / STEP) + 4;
  let n = 1;
  while (n < cells * 2) n <<= 1;
  const rr = new Float64Array(n); const ri = new Float64Array(n);
  const tr = new Float64Array(n); const ti = new Float64Array(n);
  fill(rr, refIv.filter(([a, b]) => b >= origin && a <= t1 + hi + STEP), origin);
  // the subtitle stretch is placed so that index 0 ↔ delay `lo`
  fill(tr, tgtIv.map(([a, b]) => [a + lo, b + lo]), origin);
  fft(rr, ri); fft(tr, ti);
  for (let i = 0; i < n; i++) {
    const a = rr[i]; const b = ri[i]; const c = tr[i]; const d = ti[i];
    rr[i] = a * c + b * d; ri[i] = b * c - a * d;
  }
  fft(rr, ri, true);
  const K = Math.ceil((hi - lo) / STEP);
  const corr = new Float64Array(K + 1);
  for (let k = 0; k <= K; k++) corr[k] = rr[k] * STEP;
  return { corr, lo };
}

function peaks(corr, K, count, minGapCells = 6) {
  const order = [...corr.keys()].sort((a, b) => corr[b] - corr[a]);
  const out = [];
  for (const i of order) {
    if (out.length >= count) break;
    if (out.every((j) => Math.abs(j - i) > minGapCells)) out.push(i);
  }
  return out.map((i) => ({ delay: (i - K) * STEP, value: corr[i] }));
}

// ------------------------------------------------------------------------------------------------- scoring

/** Duration-weighted share of the subtitle's on-screen time that lands on reference activity. */
function overlapShare(refIv, cues, scale, delayFor) {
  let hit = 0;
  let dur = 0;
  cues.forEach((c, i) => {
    const d = delayFor(i);
    const s = c.start * scale + d;
    const e = c.end * scale + d;
    hit += covered(refIv, s, e);
    dur += e - s;
  });
  return dur > 0 ? hit / dur : 0;
}

const NOISE = [23000, -41000, 67000, -97000, 131000, -173000];

/**
 * Aligns `tgt` (cues to fix) onto `ref` (reference cues or speech spans; only times are used).
 * opts: { scaleHint, maxShiftMs = 600000, splitPenalty = 3.5, allowSplit = true }
 * Returns { ok, scale, segments: [{ from, delay }], score, globalScore, baseScore, confidence, splits, map(t), delayAt(i) }.
 */
function splitAlign(ref, tgt, opts = {}) {
  const fail = (reason) => ({ ok: false, reason, scale: 1, segments: [{ from: 0, delay: 0 }], map: (t) => t, delayAt: () => 0, confidence: 0, splits: 0 });
  if (!ref || !tgt || ref.length < 10 || tgt.length < 10) return fail('not enough lines');
  const cues = [...tgt].sort((a, b) => a.start - b.start);
  const refIv = union(ref);
  const maxShift = opts.maxShiftMs || 600000;
  const tgtEnd = cues[cues.length - 1].end;
  const P = prepare(refIv, tgtEnd, maxShift);
  const refTotal = total(refIv);
  const baseScore = overlapShare(refIv, cues, 1, () => 0);

  // 1. global delay for every frame-rate ratio
  let best = null;
  // Only frame-rate ratios that the two lengths make plausible (a 25→23.976 stretch makes the subtitle ~4%
  // shorter), plus 1 and the subtitle's own fps hint; all of them when the lengths say nothing (cuts differ).
  const span = (iv) => (iv.length ? iv[iv.length - 1][1] - iv[0][0] : 0);
  const ratio = span(refIv) / Math.max(1, span(union(cues)));
  const plausible = SCALES.filter((s) => s === 1 || Math.abs(ratio / s - 1) < 0.025);
  const pool = opts.allScales || plausible.length <= 1 ? SCALES : plausible;
  const scales = opts.scaleHint && !pool.some((s) => Math.abs(s - opts.scaleHint) < 1e-4) ? [...pool, opts.scaleHint] : pool;
  for (const s of scales) {
    const iv = union(cues, s, 0);
    const corr = correlate(P, iv);
    const [top] = peaks(corr, P.K, 1);
    const norm = top.value / Math.max(1, Math.min(refTotal, total(iv)));
    // a frame-rate change has to earn its place, unless the subtitle's own fps says so
    const hinted = opts.scaleHint && Math.abs(s - opts.scaleHint) < 1e-3;
    const adj = norm - (s === 1 || hinted ? 0 : 0.015);
    if (!best || adj > best.adj) best = { scale: s, delay: top.delay, norm, adj, corr, iv };
  }
  // Not a standard frame-rate ratio but a slow drift (a re-encode, a slightly different speed): when one delay
  // doesn't fit the start and the end alike, try fine scale steps around the winner before splitting into parts.
  const thirdsOf = (s, d) => [0, 1, 2].map((q) => {
    const part = cues.filter((c) => c.start * s >= (tgtEnd * s * q) / 3 && c.start * s < (tgtEnd * s * (q + 1)) / 3);
    return part.length ? overlapShare(refIv, part, s, () => d) : 0;
  });
  {
    const th = thirdsOf(best.scale, best.delay);
    if (Math.max(...th) - Math.min(...th) > 0.05) {
      // delay near the start and near the end (small FFTs) → the drift's slope → one candidate scale
      const near = (from, to) => {
        const part = cues.filter((c) => c.start * best.scale >= from && c.start * best.scale < to);
        if (part.length < 20) return null;
        const iv = union(part, best.scale, 0);
        const { corr, lo } = correlateLocal(refIv, iv, best.delay - 60000, best.delay + 60000);
        const [p] = peaks(corr, 0, 1);
        return p && p.value / Math.max(1, total(iv)) >= 0.35 ? { t: (from + to) / 2, d: p.delay + lo } : null;
      };
      const end = tgtEnd * best.scale;
      const a = near(end * 0.05, end * 0.05 + 900000);
      const b = near(end * 0.95 - 900000, end * 0.95);
      if (a && b && b.t - a.t > 1200000) {
        const slope = (b.d - a.d) / (b.t - a.t);
        if (Math.abs(slope) > 0.0003 && Math.abs(slope) < 0.01) {
          const s = best.scale * (1 + slope);
          const iv = union(cues, s, 0);
          const corr = correlate(P, iv);
          const [top] = peaks(corr, P.K, 1);
          const norm = top.value / Math.max(1, Math.min(refTotal, total(iv)));
          if (norm > best.norm + 0.01) best = { scale: s, delay: top.delay, norm, adj: norm, corr, iv };
        }
      }
    }
  }
  const scale = best.scale;
  let globalDelay = best.delay;
  // fine-tune the global delay at 10 ms
  const fine = (delay, idx) => {
    let bd = delay;
    let bs = -1;
    for (let d = delay - 120; d <= delay + 120; d += 10) {
      const sc = idx ? idx.reduce((n, i) => n + covered(refIv, cues[i].start * scale + d, cues[i].end * scale + d), 0)
        : overlapShare(refIv, cues, scale, () => d);
      if (sc > bs) { bs = sc; bd = d; }
    }
    return bd;
  };
  globalDelay = fine(globalDelay);
  const globalScore = overlapShare(refIv, cues, scale, () => globalDelay);

  // 2. candidate delays: global peaks + best delay of each 10-minute stretch
  const cand = peaks(best.corr, P.K, 4).map((p) => p.delay);
  cand.push(globalDelay);
  // A single delay that fits every third of the film equally well needs no split search.
  const thirds = thirdsOf(scale, globalDelay).map((x) => x || globalScore);
  const even = Math.min(...thirds) >= globalScore - 0.05;
  if (opts.allowSplit !== false && !even) {
    const win = 600000;
    const hop = 300000;
    for (let w = 0; w < tgtEnd * scale; w += hop) {
      const part = cues.filter((c) => c.start * scale >= w && c.start * scale < w + win);
      if (part.length < 12) continue;
      const iv = union(part, scale, 0);
      // parts differ from the global delay by minutes at most (an ad break, a recap): search ±3 min around it
      const { corr, lo } = correlateLocal(refIv, iv, globalDelay - 180000, globalDelay + 180000);
      for (const p of peaks(corr, 0, 2)) if (p.value / Math.max(1, total(iv)) >= 0.3) cand.push(p.delay + lo);
    }
  }
  const delays = [];
  for (const d of cand.sort((a, b) => a - b)) if (!delays.length || d - delays[delays.length - 1] > 150) delays.push(d);

  // 3. DP: one delay per line, penalty per change
  const n = cues.length;
  const m = delays.length;
  const pen = opts.splitPenalty ?? 3.5;
  const score = (i, d) => {
    const c = cues[i];
    const s = c.start * scale + d;
    const e = c.end * scale + d;
    return e > s ? covered(refIv, s, e) / (e - s) : 0;
  };
  let prev = new Float64Array(m);
  const back = [];
  for (let j = 0; j < m; j++) prev[j] = score(0, delays[j]) + (delays[j] === globalDelay ? 1e-6 : 0);
  for (let i = 1; i < n; i++) {
    let bj = 0;
    for (let j = 1; j < m; j++) if (prev[j] > prev[bj]) bj = j;
    const cur = new Float64Array(m);
    const bk = new Int32Array(m);
    for (let j = 0; j < m; j++) {
      const stay = prev[j];
      const jump = prev[bj] - pen;
      if (stay >= jump) { cur[j] = stay; bk[j] = j; } else { cur[j] = jump; bk[j] = bj; }
      cur[j] += score(i, delays[j]);
    }
    back.push(bk);
    prev = cur;
  }
  let j = 0;
  for (let k = 1; k < m; k++) if (prev[k] > prev[j]) j = k;
  const pick = new Int32Array(n);
  pick[n - 1] = j;
  for (let i = n - 1; i >= 1; i--) { j = back[i - 1][j]; pick[i - 1] = j; }

  // 4. segments; merge tiny ones into the neighbour that fits them better
  let segs = [];
  for (let i = 0; i < n; i++) if (!segs.length || pick[i] !== pick[i - 1]) segs.push({ from: i, delay: delays[pick[i]] });
  const lenOf = (k) => (k + 1 < segs.length ? segs[k + 1].from : n) - segs[k].from;
  const idxOf = (k) => Array.from({ length: lenOf(k) }, (_, q) => segs[k].from + q);
  // How clearly a part fits its delay compared with random delays (0 = no better than chance).
  const partConf = (k) => {
    const idx = idxOf(k);
    let hit = 0; let dur = 0;
    const at = (d) => idx.reduce((s2, i) => { const c = cues[i]; return s2 + covered(refIv, c.start * scale + d, c.end * scale + d); }, 0);
    for (const i of idx) dur += (cues[i].end - cues[i].start) * scale;
    hit = at(segs[k].delay);
    const sh = hit / Math.max(1, dur);
    const nz = NOISE.reduce((s2, o) => s2 + at(segs[k].delay + o), 0) / NOISE.length / Math.max(1, dur);
    return nz >= 0.999 ? 0 : (sh - nz) / (1 - nz);
  };
  const MIN_PART = 15;
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    // weakest part first: too short, or not clearly better than chance
    let worst = -1; let worstConf = Infinity;
    for (let k = 0; k < segs.length; k++) {
      const c = lenOf(k) < MIN_PART ? -1 : partConf(k);
      if (c < 0.45 && c < worstConf) { worst = k; worstConf = c; }
    }
    if (worst < 0) break;
    // fold it into whichever neighbour's delay fits its lines better
    const k = worst;
    const left = k > 0 ? segs[k - 1] : null;
    const right = k + 1 < segs.length ? segs[k + 1] : null;
    const fit = (d) => idxOf(k).reduce((s2, i) => s2 + score(i, d), 0);
    const toLeft = !right || (left && fit(left.delay) >= fit(right.delay));
    if (!toLeft) right.from = segs[k].from;
    segs.splice(k, 1);
    changed = true;
  }
  // merge neighbours that ended up with (nearly) the same delay
  segs = segs.reduce((acc, s) => {
    if (acc.length && Math.abs(s.delay - acc[acc.length - 1].delay) <= 120) return acc;
    acc.push(s);
    return acc;
  }, []);
  for (let k = 0; k < segs.length; k++) {
    const to = k + 1 < segs.length ? segs[k + 1].from : n;
    segs[k].delay = fine(segs[k].delay, Array.from({ length: to - segs[k].from }, (_, q) => segs[k].from + q));
  }
  const delayAt = (i) => { let d = segs[0].delay; for (const s of segs) { if (s.from <= i) d = s.delay; else break; } return d; };
  let splitScore = overlapShare(refIv, cues, scale, delayAt);
  // only keep the split if it clearly beats a single delay
  if (segs.length > 1 && splitScore < globalScore + 0.04) { segs = [{ from: 0, delay: globalDelay }]; splitScore = globalScore; }
  const final = segs.length > 1 ? splitScore : globalScore;
  const noise = NOISE.reduce((s2, o) => s2 + overlapShare(refIv, cues, scale, (i) => (segs.length > 1 ? delayAt(i) : globalDelay) + o), 0) / NOISE.length;
  const confidence = noise >= 0.999 ? 0 : Math.max(0, Math.min(1, (final - noise) / (1 - noise)));
  // map(t) works on the original (unsorted) times too: parts start at their first line's time
  const bounds = segs.map((s) => ({ at: cues[s.from].start, delay: s.delay }));
  const map = (t) => { let d = bounds[0].delay; for (const b of bounds) { if (t >= b.at - 1) d = b.delay; else break; } return t * scale + d; };
  return {
    ok: confidence >= (opts.minConfidence ?? 0.3),
    reason: confidence < (opts.minConfidence ?? 0.3) ? `timing doesn't match (${Math.round(confidence * 100)}%)` : undefined,
    scale,
    segments: segs.map((s) => ({ from: s.from, at: cues[s.from].start, delay: Math.round(s.delay) })),
    splits: segs.length - 1,
    score: final,
    globalScore,
    baseScore,
    confidence,
    map,
    delayAt,
  };
}

module.exports = { splitAlign, union, covered, fft, SCALES, STEP };
