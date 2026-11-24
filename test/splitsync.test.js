'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { splitAlign } = require('../src/splitsync');

// Deterministic PRNG
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const between = (r, a, b) => a + Math.floor(r() * (b - a));

/** ~1000 dialogue lines over 100 minutes with silences. */
function film(seed, len = 100 * 60000) {
  const r = rng(seed);
  const out = [];
  let t = 30000;
  while (t < len - 120000) {
    const d = between(r, 800, 4500);
    out.push({ start: t, end: t + d, text: `line ${out.length}` });
    t += d + (r() < 1 / 12 ? between(r, 8000, 40000) : between(r, 200, 3500));
  }
  return out;
}

/** Another translator: merges/splits lines, jitters boundaries, drops some. */
function retranslate(src, seed) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (r() < 0.1) continue;
    if (r() < 1 / 6 && i + 1 < src.length && src[i + 1].start - c.end < 1200) { out.push({ start: c.start, end: src[i + 1].end, text: 'μαζί' }); i++; continue; }
    if (r() < 1 / 8 && c.end - c.start > 2500) { const m = (c.start + c.end) >> 1; out.push({ start: c.start, end: m - 40, text: 'α' }, { start: m, end: c.end, text: 'β' }); continue; }
    out.push({ start: c.start + between(r, -120, 120), end: c.end + between(r, -200, 200), text: 'Ελληνικά' });
  }
  return out;
}

const err = (a, ref, tgtOrig, map) => {
  // mean absolute error of the corrected subtitle against where its lines really are
  let s = 0;
  tgtOrig.forEach((c, i) => { s += Math.abs(map(a[i].start) - c.start); });
  return s / tgtOrig.length;
};

test('constant delay across languages', () => {
  const en = film(1);
  const truth = retranslate(en, 2);
  const late = truth.map((c) => ({ ...c, start: c.start + 2300, end: c.end + 2300 }));
  const a = splitAlign(en, late);
  assert.ok(a.ok, a.reason);
  assert.strictEqual(a.splits, 0);
  assert.ok(Math.abs(a.segments[0].delay + 2300) <= 60, `delay ${a.segments[0].delay}`);
  assert.ok(err(late, en, truth, a.map) < 80);
});

test('PAL 25 fps subtitle on a 23.976 fps video', () => {
  const en = film(3);
  const truth = retranslate(en, 4);
  const k = 23.976 / 25; // subtitle times run faster
  const pal = truth.map((c) => ({ ...c, start: Math.round(c.start * k) + 800, end: Math.round(c.end * k) + 800 }));
  const a = splitAlign(en, pal);
  assert.ok(a.ok, a.reason);
  assert.ok(Math.abs(a.scale - 25 / 23.976) < 1e-3, `scale ${a.scale}`);
  assert.ok(err(pal, en, truth, a.map) < 120, `err ${err(pal, en, truth, a.map)}`);
});

test('scale hint from the subtitle fps is used', () => {
  const en = film(5);
  const truth = retranslate(en, 6);
  const k = 24 / 25;
  const sub = truth.map((c) => ({ ...c, start: Math.round(c.start * k), end: Math.round(c.end * k) }));
  const a = splitAlign(en, sub, { scaleHint: 25 / 24 });
  assert.ok(a.ok);
  assert.ok(Math.abs(a.scale - 25 / 24) < 1e-3);
});

test('TV/DVR cut: ad breaks removed in the video, subtitle from the WEB release', () => {
  // The video (reference) lost two ad-break stretches: after 25 min (−40 s) and after 60 min (−95 s more).
  const web = film(7);
  const cut = (t) => (t < 25 * 60000 ? t : t < 60 * 60000 ? t - 40000 : t - 135000);
  const tvRef = retranslate(web, 8).map((c) => ({ ...c, start: cut(c.start), end: cut(c.end) }));
  const greek = retranslate(web, 9); // subtitle made for the WEB timing
  const a = splitAlign(tvRef, greek);
  assert.ok(a.ok, a.reason);
  assert.ok(a.splits >= 2, `splits ${a.splits}`);
  let bad = 0;
  for (const c of greek) if (Math.abs(a.map(c.start) - cut(c.start)) > 400) bad++;
  assert.ok(bad / greek.length < 0.03, `${bad} of ${greek.length} lines off`);
});

test('wrong film is not "fixed"', () => {
  const a = splitAlign(film(11), retranslate(film(12), 13));
  assert.ok(!a.ok || a.confidence < 0.3, `conf ${a.confidence}`);
});

test('already in sync stays untouched', () => {
  const en = film(14);
  const gr = retranslate(en, 15);
  const a = splitAlign(en, gr);
  assert.ok(a.ok);
  assert.strictEqual(a.splits, 0);
  assert.strictEqual(a.scale, 1);
  assert.ok(Math.abs(a.segments[0].delay) <= 30);
});

test('slow non-standard drift becomes one scale, not a staircase', () => {
  const en = film(31);
  const truth = retranslate(en, 32);
  const k = 1 / 1.0021;
  const sub = truth.map((c) => ({ ...c, start: Math.round(c.start * k) + 600, end: Math.round(c.end * k) + 600 }));
  const a = splitAlign(en, sub);
  assert.ok(a.ok);
  assert.strictEqual(a.splits, 0, `splits ${a.splits}`);
  assert.ok(Math.abs(a.scale - 1.0021) < 4e-4, `scale ${a.scale}`);
  assert.ok(err(sub, en, truth, a.map) < 150);
});
