'use strict';
// End-to-end: the server picks the right English subtitle for the release, rejects wrong types,
// retimes a reused translation (frame rate + offset) and adds the right on-screen notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockProviders } = require('./helpers/mock-providers');
const { startAddon, api, getJson, waitFor } = require('./helpers/server');

let mock;
let addon;
let token;
const srtTimes = (srt) => [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) -->/g)].map((m) => ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4]);
const payloadOf = (url) => {
  const raw = Buffer.from(url.split('/t/')[1].split('/')[0], 'base64url').toString();
  return raw.startsWith('{') ? JSON.parse(raw) : { s: raw, q: 'unverified' }; // unverified tracks use the plain format
};

test.before(async () => {
  mock = await startMockProviders({ lines: 300 });
  addon = await startAddon(mock.base);
  const r = await api(addon.base, 'encode', { config: { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'm', sources: [mock.base] } });
  token = r.body.token;
});
test.after(async () => {
  await addon?.stop();
  await mock?.close();
});

test('wrong-type subtitles are rejected and the hash-matched release is chosen', async () => {
  mock.state.listings.tt0000010 = [
    { file: '-cd1', release: 'Film.2020.DVDRip.XviD.CD1-OLD' },
    { file: '-forced', release: 'Film.2020.1080p.WEB-DL-GOOD.forced' },
    { file: '-fr', release: 'Film.2020.1080p.WEB-DL-FAKE' },
    { file: '-episode', release: 'Show.S01E02.720p.HDTV-X', episode: 2 },
    { file: '-fps', release: 'Film.2020.PAL.DVDRip-EURO', fps: 25000 },
    { file: '-good', release: 'Film.2020.1080p.WEB-DL.H264-GOOD', group: 'GOOD', m: 'h' },
  ];
  const extra = 'videoHash=abc123&videoSize=1000&filename=Film.2020.1080p.WEB-DL.H264-GOOD.mkv';
  const subs = await getJson(`${addon.base}/${token}/subtitles/movie/tt0000010/${extra}.json`);
  assert.equal(subs.body.subtitles.length, 1);
  const p = payloadOf(subs.body.subtitles[0].url);
  assert.match(p.s, /tt0000010-good\.srt$/);
  assert.equal(p.q, 'hash');

  const report = (await getJson(`${addon.base}/${token}/report/movie/tt0000010/${extra}.json`)).body;
  const byFile = Object.fromEntries(report.candidates.map((c) => [c.release, c]));
  assert.match(byFile['Film.2020.DVDRip.XviD.CD1-OLD'].rejected, /CDs/);
  assert.match(byFile['Film.2020.1080p.WEB-DL-GOOD.forced'].rejected, /forced/);
  assert.match(byFile['Film.2020.1080p.WEB-DL-FAKE'].rejected, /English/);
  assert.match(byFile['Show.S01E02.720p.HDTV-X'].rejected, /episode subtitle for a movie/);
  assert.match(byFile['Film.2020.PAL.DVDRip-EURO'].length, /frame-rate mismatch \(25 → 23\.976 fps\)/);
  assert.equal(byFile['Film.2020.1080p.WEB-DL.H264-GOOD'].chosen, true);
  assert.equal(report.decision.why, 'hash match');
});

test("a translation of another release is reused and retimed (25 → 23.976 fps)", async () => {
  // Opening the title (no filename yet) translates the only candidate known then: a 25 fps PAL release.
  mock.state.listings.tt0000011 = [{ file: '-fps', release: 'Film.2020.PAL.DVDRip-EURO', fps: 25000 }];
  await getJson(`${addon.base}/${token}/stream/movie/tt0000011.json`);
  await waitFor(async () => /\[early\] movie tt0000011/.test(addon.log()) && (await getJson(`${addon.base}/status`)).body.jobs.some((j) => j.status === 'done' && j.cues === 300));

  // Playback starts: now the web release (hash match) is listed too. The PAL translation is reused, retimed to it.
  mock.state.listings.tt0000011 = [
    { file: '-web', release: 'Film.2020.1080p.WEB-DL-GOOD', group: 'GOOD', m: 'h' },
    { file: '-fps', release: 'Film.2020.PAL.DVDRip-EURO', fps: 25000 },
  ];
  const extra = 'videoHash=def456&videoSize=1000&filename=Film.2020.1080p.WEB-DL-GOOD.mkv';
  const subs = await getJson(`${addon.base}/${token}/subtitles/movie/tt0000011/${extra}.json`);
  const p = payloadOf(subs.body.subtitles[0].url);
  assert.match(p.s, /tt0000011-fps\.srt$/, 'reuses the existing translation');
  assert.match(p.r, /tt0000011-web\.srt$/, 'retimed to the hash-matched release');
  assert.match(addon.log(), /reusing .*25 → 23\.976 fps/);

  const srt = await (await fetch(subs.body.subtitles[0].url)).text();
  assert.match(srt, /⏱ Ο συγχρονισμός διορθώθηκε αυτόματα \(25 → 23,976 fps\)/);
  const greek = srt.split('\n\n').filter((b) => /ΕΛ Line/.test(b));
  assert.equal(greek.length, 300);
  // Line 100 of the web release starts at 00:05:01,000; the PAL file had it at 00:04:48,7xx.
  const line100 = greek.find((b) => /ΕΛ Line 100:/.test(b));
  assert.ok(Math.abs(srtTimes(line100)[0] - 301000) <= 5, line100);
});

test('when nothing confirms the release, a note points to the player delay control', async () => {
  mock.state.listings.tt0000012 = [{ file: '-only', release: 'Something.Else.2020.720p.HDTV-XYZ' }];
  const subs = await getJson(`${addon.base}/${token}/subtitles/movie/tt0000012.json`);
  const p = payloadOf(subs.body.subtitles[0].url);
  assert.equal(p.q, 'unverified');
  const srt = await (await fetch(subs.body.subtitles[0].url)).text();
  assert.match(srt, /⚠ Δεν βρέθηκε υπότιτλος για αυτή ακριβώς την έκδοση\.\nΑν δεν συγχρονίζει: μενού υποτίτλων \(CC\) → Καθυστέρηση/);
});

test('length is checked against the runtime and against other subtitles', async () => {
  mock.state.runtimeMin = 16; // 300 lines × 3 s ≈ 15 min
  mock.state.listings.tt0000013 = [
    { file: '-cd1', release: 'Film.2020.WEB-A' }, // half length but not flagged by name
    { file: '-a', release: 'Film.2020.WEB-B' },
    { file: '-b', release: 'Film.2020.WEB-C' },
  ];
  const report = (await getJson(`${addon.base}/${token}/report/movie/tt0000013.json`)).body;
  assert.equal(report.runtime, '16 min');
  const half = report.candidates.find((c) => c.release === 'Film.2020.WEB-A');
  assert.match(half.rejected, /ends at 47% of the runtime/, JSON.stringify(half));
  assert.notEqual(report.decision.chosen, 'Film.2020.WEB-A.srt');
  assert.equal(report.decision.quality, 'length', 'verified by length against the runtime');
  mock.state.runtimeMin = null;
});

test('sync checks can be switched off', async () => {
  const off = await api(addon.base, 'encode', { config: { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'm', sources: [mock.base], autoSync: false, syncNotes: false } });
  mock.state.listings.tt0000014 = [{ file: '-cd1', release: 'Film.CD1' }, { file: '-good', release: 'Film.Good' }];
  const subs = await getJson(`${addon.base}/${off.body.token}/subtitles/movie/tt0000014.json`);
  assert.match(Buffer.from(subs.body.subtitles[0].url.split('/t/')[1].split('/')[0], 'base64url').toString(), /tt0000014-cd1\.srt$/, 'source order is kept');
});

test('length groups that differ by a frame-rate ratio make the choice unverified', async () => {
  mock.state.listings.tt0000015 = [{ file: '-a', release: 'Film.2010.XviD-A' }, { file: '-fps', release: 'Film.2010.XviD-B' }];
  const report = (await getJson(`${addon.base}/${token}/report/movie/tt0000015.json`)).body;
  assert.equal(report.decision.quality, 'unverified');
  assert.match(report.decision.why, /frame-rate ratio/);
  mock.state.listings.tt0000016 = [{ file: '-a', release: 'F-A' }, { file: '-b', release: 'F-B' }, { file: '-fps', release: 'F-C' }];
  const majority = (await getJson(`${addon.base}/${token}/report/movie/tt0000016.json`)).body;
  assert.match(majority.decision.why, /length agrees with 1 other/);
  assert.doesNotMatch(majority.decision.why, /frame-rate ratio/, 'a clear majority (2 vs 1) is trusted');
});

test('real subtitles in the target language (cfg.nativeSubtitles)', async () => {
  // A verified match (same release, hash match) becomes the default pick; the AI track is still listed
  // as a backup, and fetching it does NOT require translating the real one.
  mock.state.listings.tt0000090 = [
    { file: '-eng', release: 'Show.2020.1080p.WEB-DL.H264-GOOD', group: 'GOOD', m: 'h', lang: 'eng' },
    { file: '-ell', release: 'Show.2020.1080p.WEB-DL.H264-GOOD', group: 'GOOD', m: 'h', lang: 'ell' },
  ];
  let subs = (await getJson(`${addon.base}/${token}/subtitles/movie/tt0000090.json`)).body.subtitles;
  assert.equal(subs.length, 2, 'the real subtitle plus an AI backup');
  assert.equal(subs[0].lang, 'ell', 'the verified real subtitle is the default pick');
  assert.match(subs[1].lang, /\(AI\)/, 'the AI track is clearly labelled as the backup');
  let p0 = payloadOf(subs[0].url);
  assert.equal(p0.n, true);
  assert.match(p0.s, /tt0000090-ell\.srt$/);
  // Fetching the real subtitle serves it directly — no translation job is started for it.
  const served = await (await fetch(subs[0].url)).text();
  assert.match(served, /Line 0: /, 'served as-is, not an AI translation');
  const statusAfter = (await getJson(`${addon.base}/status`)).body.jobs;
  assert.ok(!statusAfter.some((j) => String(j.key || '').includes('tt0000090-ell')), 'no job queued for the real subtitle');

  const report = (await getJson(`${addon.base}/${token}/report/movie/tt0000090.json`)).body;
  assert.equal(report.native.quality, 'hash');
  assert.equal(report.native.verified, true);

  // Not a confirmed match (forced/partial-only file, too few lines to trust): AI stays the only track.
  mock.state.listings.tt0000091 = [
    { file: '-eng2', release: 'Movie.2020.1080p.WEB-DL.H264-GOOD', group: 'GOOD', m: 'h', lang: 'eng' },
    { file: '-forced', release: 'Random.Unrelated.Name', lang: 'ell' },
  ];
  subs = (await getJson(`${addon.base}/${token}/subtitles/movie/tt0000091.json`)).body.subtitles;
  assert.equal(subs.length, 1, 'an unverified real subtitle is not used in auto mode');
  assert.equal(subs[0].lang, 'ell');

  // "Always list both": the same unverified real subtitle is now offered too, clearly marked unverified.
  const both = await api(addon.base, 'encode', { config: { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'm', sources: [mock.base], nativeSubtitles: 'both' } });
  subs = (await getJson(`${addon.base}/${both.body.token}/subtitles/movie/tt0000091.json`)).body.subtitles;
  assert.equal(subs.length, 2);
  assert.match(subs[1].lang, /original, unverified/);

  // "Ignore them": the real subtitle is never offered, even when it's a perfect hash match.
  const off = await api(addon.base, 'encode', { config: { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'm', sources: [mock.base], nativeSubtitles: 'off' } });
  subs = (await getJson(`${addon.base}/${off.body.token}/subtitles/movie/tt0000090.json`)).body.subtitles;
  assert.equal(subs.length, 1);
  assert.equal(subs[0].lang, 'ell');
  assert.equal(payloadOf(subs[0].url).n, undefined);
});
