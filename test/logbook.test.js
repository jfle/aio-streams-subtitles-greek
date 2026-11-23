'use strict';
// Persistent logs (src/logbook.js) and local-model-only translation without a cloud key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aigreeksubs-logbook-'));
const logbook = require('../src/logbook');
const { translateLines } = require('../src/translator');
const { startMockProviders } = require('./helpers/mock-providers');

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const files = (re) => fs.readdirSync(logbook.LOG_DIR).filter((f) => re.test(f));
const readAll = (re) => files(re).map((f) => fs.readFileSync(path.join(logbook.LOG_DIR, f), 'utf8')).join('');

test('logbook: console lines and job events are written to the data disk, keys masked', () => {
  logbook.install();
  console.log('[start] abc openai/gpt-4.1-mini -> ell');
  console.error('[error] abc: HTTP 401 Bearer sk-proj-ABCDEFGHIJKLMNOP1234 rejected');
  logbook.jobEvent('done', { key: 'abc', title: 'movie tt0000001', cues: 10, failed: 0, header: 'Bearer abcdefghijklmnop' });

  const addon = readAll(/^addon-\d{4}-\d{2}-\d{2}\.log$/);
  assert.match(addon, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} INFO \[start\] abc/m);
  assert.match(addon, / ERROR \[error\] abc: HTTP 401 Bearer <redacted> rejected/);
  assert.ok(!addon.includes('ABCDEFGHIJKLMNOP1234'));

  const lines = readAll(/^jobs-\d{4}-\d{2}\.jsonl$/).trim().split('\n').map((l) => JSON.parse(l));
  const done = lines.find((l) => l.event === 'done');
  assert.equal(done.title, 'movie tt0000001');
  assert.equal(done.cues, 10);
  assert.equal(done.header, 'Bearer <redacted>');
  assert.match(done.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('logbook: old files are pruned, recent ones and other files kept', () => {
  const dir = logbook.LOG_DIR;
  const old = path.join(dir, 'addon-2000-01-01.log');
  const oldJobs = path.join(dir, 'jobs-2000-01.jsonl');
  const other = path.join(dir, 'notes.txt');
  for (const f of [old, oldJobs, other]) fs.writeFileSync(f, 'x');
  const longAgo = new Date(Date.now() - 500 * 86400e3);
  for (const f of [old, oldJobs, other]) fs.utimesSync(f, longAgo, longAgo);
  logbook.prune();
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(oldJobs));
  assert.ok(fs.existsSync(other));
  assert.ok(files(/^addon-/).length >= 1);
});

test('logbook: shortUrl keeps host and file name only', () => {
  assert.equal(logbook.shortUrl('https://subs5.strem.io/en/download/file/1952393674?token=secret'), 'subs5.strem.io/…/1952393674');
});

test('local model only (no cloud key): never calls the cloud, keeps partial answers, fails just the batch', async () => {
  const local = await startMockProviders();
  const cloud = await startMockProviders();
  try {
    local.state.localModel = true;
    const cfg = { provider: 'openai', model: 'gpt-4.1-mini', apiKey: '', credId: '', baseUrl: `${cloud.base}/v1`, localBaseUrl: `${local.base}/v1`, targetLang: 'ell', temperature: 0.3, instructions: '' };
    const lines = { 1: 'Hello there.', 2: 'How are you?', 3: 'Fine, thanks.' };
    const stats = { key: 't', local: 0, cloud: 0, localFailures: 0, lastLocalError: '' };

    // Complete local answer.
    const ok = await translateLines(lines, [], cfg, stats);
    assert.equal(Object.keys(ok).length, 3);
    assert.equal(stats.local, 1);

    // Incomplete local answer: the translated lines are kept (translateBatch retries the rest).
    local.state.dropLines = 1;
    const part = await translateLines(lines, [], cfg, stats);
    assert.ok(part['1'] && part['2'] && !part['3']);
    assert.equal(stats.localFailures, 1);
    assert.match(stats.lastLocalError, /incomplete answer \(2\/3 lines\)/);
    local.state.dropLines = 0;

    // Local server failing: a non-fatal error for this batch, no cloud call, no 401.
    local.state.rejectChat = true;
    await assert.rejects(translateLines(lines, [], cfg, stats), (e) => e.noCloud === true && !e.fatal && e.status === undefined && /no cloud API key/.test(e.message));
    assert.equal(cloud.state.chatCalls, 0);
    assert.equal(stats.cloud, 0);

    // With a cloud key the old behaviour stays: the cloud takes over.
    await translateLines(lines, [], { ...cfg, apiKey: 'cloud-key' }, stats);
    assert.equal(cloud.state.chatCalls, 1);
    assert.equal(stats.cloud, 1);
  } finally {
    await local.close();
    await cloud.close();
  }
});
