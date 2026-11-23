'use strict';
// Unit tests for configuration, subtitle parsing and rendering (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigreeksubs-unit-'));
const { normalizeConfig, encodeConfig, decodeConfig, effectiveLimits, sign } = require('../src/config');
const { decodeBuffer, legacyEncodingFor, parseSubtitles, toSrt } = require('../src/subtitles');
const { renderJob, openingReady } = require('../src/translator');

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('config: defaults and normalisation', () => {
  const c = normalizeConfig({ provider: 'nope', targetLang: 'xx', concurrency: '99', batchSize: '2', sources: 'stremio://example.com/manifest.json' });
  assert.equal(c.provider, 'openai');
  assert.equal(c.targetLang, 'ell');
  assert.equal(c.concurrency, 32);
  assert.equal(c.batchSize, 5);
  assert.deepEqual(c.sources, ['https://example.com']);
  assert.equal(c.autoTranslate, true);
  assert.equal(c.earlyStart, true);
  assert.equal(c.nativeSubtitles, 'auto');
  assert.equal(normalizeConfig({ nativeSubtitles: 'both' }).nativeSubtitles, 'both');
  assert.equal(normalizeConfig({ nativeSubtitles: 'off' }).nativeSubtitles, 'off');
  assert.equal(normalizeConfig({ nativeSubtitles: 'bogus' }).nativeSubtitles, 'auto');
});

test('config: encrypted token round-trip, tamper detection, defaults not stored', () => {
  const token = encodeConfig({ provider: 'custom', baseUrl: 'http://pc:1234/v1', model: 'krikri', apiKey: 'secret-key' });
  assert.match(token, /^[\w-]{20,}$/);
  assert.ok(!token.includes('secret-key'));
  const back = decodeConfig(token);
  assert.equal(back.provider, 'custom');
  assert.equal(back.apiKey, 'secret-key');
  assert.equal(back.model, 'krikri');
  const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
  assert.equal(decodeConfig(tampered), null);
  assert.equal(decodeConfig('not-a-token-at-all-xxxxxxxxxxxx'), null);
  // A default-only config stays short because defaults are omitted.
  assert.ok(encodeConfig({ provider: 'openai', apiKey: 'k' }).length < 120);
});

test('config: automatic limits per provider', () => {
  assert.deepEqual(effectiveLimits(normalizeConfig({ provider: 'chatgpt' })), { batchSize: 20, concurrency: 24, local: false });
  assert.deepEqual(effectiveLimits(normalizeConfig({ provider: 'custom' })), { batchSize: 20, concurrency: 3, local: true });
  assert.equal(effectiveLimits(normalizeConfig({ provider: 'openrouter' })).concurrency, 8);
  assert.deepEqual(effectiveLimits(normalizeConfig({ provider: 'xai', concurrency: 4, batchSize: 30 })), { batchSize: 30, concurrency: 4, local: false });
});

test('config: signatures are stable and input-dependent', () => {
  assert.equal(sign('abc'), sign('abc'));
  assert.notEqual(sign('abc'), sign('abd'));
});

test('subtitles: parses SRT with BOM, CRLF, tags and multi-line cues', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<font color="red">Bye</font>\r\n';
  const cues = parseSubtitles(srt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1000, end: 2500, text: '<i>Hello</i>\nthere' });
  assert.equal(cues[1].text, 'Bye');
});

test('subtitles: parses WebVTT and writes SRT', () => {
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n<v Anna>Hi\n\n01:00:00.500 --> 01:00:01.000 align:start\nLate line\n';
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hi');
  assert.equal(cues[1].start, 3600500);
  assert.equal(toSrt(cues), '1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\n01:00:00,500 --> 01:00:01,000\nLate line\n');
});

test('subtitles: decodes UTF-16 and Windows-1252 files', () => {
  const text = '1\n00:00:01,000 --> 00:00:02,000\nCafé\n';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeBuffer(utf16), text);
  const cp1252 = Buffer.from(text.replace('é', 'é'), 'latin1');
  assert.equal(decodeBuffer(cp1252), text);
});

test('subtitles: legacy (non-UTF-8) files use the target script\'s own codepage, not always Windows-1252', () => {
  assert.equal(legacyEncodingFor('ell'), 'windows-1253');
  assert.equal(legacyEncodingFor('rus'), 'windows-1251');
  assert.equal(legacyEncodingFor('tur'), 'windows-1254');
  assert.equal(legacyEncodingFor('fre'), 'windows-1252');
  assert.equal(legacyEncodingFor('unknown-code'), 'windows-1252');

  // A non-UTF-8 byte sequence that decodes to different (and both valid) text under each codepage —
  // confirms decodeBuffer actually uses the codepage it's given, not just that the names differ.
  const bytes = Buffer.from([0xe4, 0xe5, 0xed]); // "δεν" in Windows-1253; different Latin letters in -1252
  const asGreek = new TextDecoder('windows-1253').decode(bytes);
  const asWestern = new TextDecoder('windows-1252').decode(bytes);
  assert.notEqual(asGreek, asWestern);
  assert.equal(decodeBuffer(bytes, legacyEncodingFor('ell')), asGreek);
  assert.equal(decodeBuffer(bytes, legacyEncodingFor('fre')), asWestern);
});

test('render: partial job shows Greek, then tagged English with a reload hint', () => {
  const cfg = normalizeConfig({ provider: 'custom' });
  const cues = Array.from({ length: 4 }, (_, i) => ({ start: i * 3000, end: i * 3000 + 2000, text: `Line ${i}` }));
  const job = { status: 'translating', cues, out: ['Γραμμή 0', 'Γραμμή 1', null, null], done: 2, total: 4 };
  const srt = renderJob(job, cfg);
  assert.match(srt, /Μετάφραση AI: 50%/);
  assert.match(srt, /Γραμμή 1/);
  assert.match(srt, /<i>Line 2<\/i>\n\[⏳ 50% · OFF\/ON για ελληνικά\]/);
  assert.equal(openingReady(job, 2), true);
  assert.equal(openingReady(job, 3), false);
});

test('render: English hints for other target languages, failure and starting notices', () => {
  const cfg = normalizeConfig({ provider: 'custom', targetLang: 'spa' });
  const cues = [{ start: 0, end: 1000, text: 'Hello' }];
  assert.match(renderJob({ status: 'translating', cues, out: [null], done: 0, total: 1 }, cfg), /OFF\/ON for the translation/);
  assert.match(renderJob({ status: 'error', error: 'bad key', cues, out: [null] }, cfg), /AI translation failed: bad key/);
  assert.match(renderJob({ status: 'downloading' }, cfg), /AI translation started/);
  assert.equal(renderJob({ status: 'done', srt: 'X' }, cfg), 'X');
});
