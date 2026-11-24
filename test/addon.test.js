'use strict';
// Integration tests: the real server (child process) against local mock providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockProviders } = require('./helpers/mock-providers');
const { startAddon, api, getJson, waitFor } = require('./helpers/server');
const pkg = require('../package.json');

let mock;
let addon;
let token;

test.before(async () => {
  mock = await startMockProviders({ lines: 120 });
  addon = await startAddon(mock.base);
  const r = await api(addon.base, 'encode', { config: { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'local-model', sources: [mock.base] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
});
test.after(async () => {
  await addon?.stop();
  await mock?.close();
});

test('health, unconfigured manifest and configure page', async () => {
  const h = await getJson(`${addon.base}/health`);
  assert.deepEqual(h.body, { ok: true, version: pkg.version });
  const m = await getJson(`${addon.base}/manifest.json`);
  assert.equal(m.body.id, 'community.ai-greek-subs-fletouris');
  assert.equal(m.body.behaviorHints.configurationRequired, true);
  assert.deepEqual(m.body.resources, ['subtitles']);
  const page = await (await fetch(`${addon.base}/configure`)).text();
  assert.match(page, /window\.__BOOT__ = /);
  assert.match(page, /Sign in with Grok/);
});

test('encode validates input', async () => {
  const r = await api(addon.base, 'encode', { config: { provider: 'openai' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /API key/i);
  const g = await api(addon.base, 'encode', { config: { provider: 'chatgpt' } });
  assert.equal(g.status, 400);
  assert.match(g.body.error, /Sign in with ChatGPT/);
});

test('configured manifest advertises subtitles and the early-start stream resource', async () => {
  const m = await getJson(`${addon.base}/${token}/manifest.json`);
  assert.equal(m.body.behaviorHints.configurable, true);
  assert.equal(m.body.behaviorHints.configurationRequired, false);
  assert.equal(m.body.resources[0], 'subtitles');
  assert.equal(m.body.resources[1].name, 'stream');
  assert.match(m.body.description, /local-model/);
  assert.match(m.body.logo, /\/logo\.png\?v=/);
  const page = await (await fetch(`${addon.base}/${token}/configure`)).text();
  assert.match(page, /"model":"local-model"/);
});

test('opening a title starts translation early; the subtitle request reuses it', async () => {
  const s = await getJson(`${addon.base}/${token}/stream/series/tt0000001:1:2.json`);
  assert.deepEqual(s.body, { streams: [] });
  await waitFor(async () => (await getJson(`${addon.base}/status`)).body.jobs.find((j) => j.status === 'done'));

  // With a video hash the source ranks another file first; the addon prefers the one already translated.
  const subs = await getJson(`${addon.base}/${token}/subtitles/series/tt0000001:1:2/videoHash=abc&videoSize=1.json`);
  assert.equal(subs.body.subtitles.length, 1);
  const track = subs.body.subtitles[0];
  assert.equal(track.lang, 'ell');
  const payload = JSON.parse(Buffer.from(track.url.split('/t/')[1].split('/')[0], 'base64url').toString());
  assert.match(payload.s, /tt0000001_1_2-popular\.srt$/);
  assert.equal(payload.q, 'hash', 'the hash-matched subtitle is the timing reference');
  assert.equal(payload.r, undefined, 'same timing, so no retiming is needed');

  const t0 = Date.now();
  const srt = await (await fetch(track.url)).text();
  assert.ok(Date.now() - t0 < 1000, 'cached translation is served immediately');
  assert.equal((srt.match(/ΕΛ Line \d+/g) || []).length, 120);
  assert.doesNotMatch(srt, /⏳/);
});

test('a fresh subtitle request translates within the wait window', async () => {
  const subs = await getJson(`${addon.base}/${token}/subtitles/movie/tt0000002.json`);
  const srt = await (await fetch(subs.body.subtitles[0].url)).text();
  assert.equal((srt.match(/ΕΛ Line \d+/g) || []).length, 120);
});

test('the next episode is prefetched while one plays', async () => {
  await getJson(`${addon.base}/${token}/subtitles/series/tt0000003:2:5.json`);
  await waitFor(() => /\[prefetch\] tt0000003:2:6/.test(addon.log()));
});

test('signed subtitle links cannot be forged; unknown tokens get no subtitles', async () => {
  const subs = await getJson(`${addon.base}/${token}/subtitles/movie/tt0000002.json`);
  const forged = subs.body.subtitles[0].url.replace(/\/[\w-]+\.srt$/, '/AAAAAAAAAAAAAAAAAAAAAA.srt');
  assert.equal((await fetch(forged)).status, 403);
  const none = await getJson(`${addon.base}/${'x'.repeat(40)}/subtitles/movie/tt0000002.json`);
  assert.deepEqual(none.body, { subtitles: [] });
});

test('test translation and model listing through the API', async () => {
  const cfg = { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'local-model' };
  const t = await api(addon.base, 'test', { config: cfg });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.match(t.body.sample['1'], /^ΕΛ /);
  const m = await api(addon.base, 'models', { config: cfg });
  assert.ok(m.body.models.includes('gpt-6-luna'));
});

test('CONFIG_PASSWORD protects the configuration API', async () => {
  const locked = await startAddon(mock.base, { CONFIG_PASSWORD: 'pw123' });
  try {
    const cfg = { provider: 'custom', baseUrl: `${mock.base}/v1`, model: 'm' };
    assert.equal((await api(locked.base, 'encode', { config: cfg })).status, 401);
    assert.equal((await api(locked.base, 'encode', { config: cfg, password: 'pw123' })).status, 200);
  } finally {
    await locked.stop();
  }
});

test('a higher-priority Greek track leaves AI translation available on demand', async () => {
  const id = 'tt0000101';
  mock.state.listings[id] = [{ file: '-english' }, { file: '-greek', lang: 'el-GR' }];
  const { body } = await api(addon.base, 'encode', { config: {
    provider: 'custom', baseUrl: `${mock.base}/v1`, sources: [mock.base], prioritySources: [mock.base],
  }});
  const configured = `${addon.base}/${body.token}`;
  assert.deepEqual((await getJson(`${configured}/manifest.json`)).body.resources, ['subtitles']);
  const calls = mock.state.chatCalls;
  await getJson(`${configured}/stream/movie/${id}.json`);
  const { body: { subtitles } } = await getJson(`${configured}/subtitles/movie/${id}.json`);
  assert.equal(subtitles.length, 1);
  assert.equal(subtitles[0].lang, 'ell');
  assert.ok(!(await getJson(`${addon.base}/status`)).body.jobs.some((job) => job.status === 'translating'));
  assert.equal(mock.state.chatCalls, calls);
  assert.match(await (await fetch(subtitles[0].url)).text(), /ΕΛ Line 0/);
  assert.ok(mock.state.chatCalls > calls);

  const withoutGreek = 'tt0000102';
  mock.state.listings[withoutGreek] = [{ file: '-english' }];
  const afterSelection = mock.state.chatCalls;
  assert.equal((await getJson(`${configured}/subtitles/movie/${withoutGreek}.json`)).body.subtitles.length, 1);
  await waitFor(() => mock.state.chatCalls > afterSelection);
});

test('Krikri runs first with thinking off and cloud takes over if it fails', async () => {
  const local = await startMockProviders();
  const cloud = await startMockProviders();
  try {
    local.state.localModel = true;
    const config = {
      provider: 'openai', model: 'cloud-model', apiKey: 'cloud-key',
      baseUrl: `${cloud.base}/v1`, localBaseUrl: `${local.base}/v1`,
    };
    assert.equal((await api(addon.base, 'test', { config })).status, 200);
    assert.equal(cloud.state.chatCalls, 0);
    assert.equal(local.state.chatBodies[0].model, 'llama-krikri-8b-instruct');
    assert.equal(local.state.chatBodies[0].reasoning_effort, 'none');
    local.state.rejectChat = true;
    assert.equal((await api(addon.base, 'test', { config })).status, 200);
    assert.equal(cloud.state.chatCalls, 1);
    assert.equal(local.state.chatCalls, 2);
    local.state.localModel = false;
    assert.equal((await api(addon.base, 'test', { config })).status, 200);
    assert.equal(cloud.state.chatCalls, 2);
    assert.equal(local.state.chatCalls, 2);
  } finally {
    await local.close();
    await cloud.close();
  }
});

test('local model offline (port closed): one quick check, then straight to the cloud', async () => {
  const cloud = await startMockProviders();
  try {
    // nothing listens on this port: like the PC with LM Studio being off
    const srv = require('net').createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port; await new Promise((r) => srv.close(r));
    const { portOpen } = require('../src/providers');
    assert.equal(await portOpen(`http://127.0.0.1:${port}/v1`), false);
    const config = { provider: 'openai', model: 'cloud-model', apiKey: 'cloud-key', baseUrl: `${cloud.base}/v1`, localBaseUrl: `http://127.0.0.1:${port}/v1` };
    const t0 = Date.now();
    assert.equal((await api(addon.base, 'test', { config })).status, 200);
    assert.equal((await api(addon.base, 'test', { config })).status, 200);
    assert.equal(cloud.state.chatCalls, 2);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  } finally {
    await cloud.close();
  }
});
