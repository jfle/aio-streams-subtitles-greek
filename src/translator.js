'use strict';
// Translation job manager: downloads an English subtitle, translates it in batches with the
// configured AI provider, serves partial results while in progress and caches finished files.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chat, LANGUAGES, PROVIDERS, localSession, markLocalDown } = require('./providers');
const { toSrt } = require('./subtitles');
const { downloadCues } = require('./sync');
const { DATA_DIR, effectiveLimits } = require('./config');
const { jobEvent, shortUrl } = require('./logbook');

const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CACHE_DAYS = parseFloat(process.env.CACHE_DAYS || '30');
const MAX_BATCH_CHARS = 6000;
const jobs = new Map();

function jobKey(srcUrl, cfg) {
  return crypto
    .createHash('sha256')
    .update([srcUrl, cfg.provider, cfg.model, cfg.targetLang, cfg.instructions].join('|'))
    .digest('hex')
    .slice(0, 32);
}

function systemPrompt(cfg) {
  const lang = LANGUAGES[cfg.targetLang];
  return [
    `You are a professional film and TV subtitle translator. Translate English subtitles into natural, fluent, spoken ${lang}.`,
    'Rules:',
    '- Translate every entry. Keep the same keys; never merge, split, skip or reorder entries.',
    '- Keep subtitles concise and natural for on-screen reading; match the tone, register and slang of the original.',
    '- Preserve line breaks inside an entry where sensible, and keep formatting tags such as <i>, </i>, <b>, {\\an8} unchanged.',
    '- Keep names of people and places as commonly rendered in the target language.',
    '- Sound effects / speaker labels in brackets, e.g. [DOOR SLAMS], should be translated too.',
    `- Use correct ${lang} orthography and punctuation${cfg.targetLang === 'ell' ? ' (accents/τόνοι, and ";" as the Greek question mark)' : ''}.`,
    '- "context" entries are only for understanding; do not translate or return them.',
    cfg.instructions ? `Additional instructions from the user: ${cfg.instructions}` : '',
    'Reply with ONLY a JSON object mapping each key of "lines" to its translation, e.g. {"1":"...","2":"..."}. No markdown, no comments.',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseModelJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) {
    const as = t.indexOf('[');
    const ae = t.lastIndexOf(']');
    if (as >= 0 && ae > as) {
      const arr = JSON.parse(t.slice(as, ae + 1));
      return Object.fromEntries(arr.map((v, i) => [String(i + 1), typeof v === 'string' ? v : v?.text]));
    }
    throw new Error('Model reply did not contain JSON');
  }
  let obj;
  try {
    obj = JSON.parse(t.slice(s, e + 1));
  } catch (err) {
    // Small local models sometimes emit slightly broken JSON (e.g. `,6":"…"`): salvage every "key":"value" pair.
    obj = {};
    const re = /(?:^|[{,\s])"?(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(t))) {
      try { obj[m[1]] = JSON.parse(`"${m[2]}"`); } catch { obj[m[1]] = m[2]; }
    }
    if (!Object.keys(obj).length) throw err;
  }
  for (const k of ['lines', 'translations', 'translation', 'result']) {
    if (obj && typeof obj[k] === 'object' && !Array.isArray(obj[k])) obj = obj[k];
  }
  return obj;
}

// True when the configured cloud provider can actually be called (a key or a stored sign-in).
const hasCloudCredentials = (cfg) => cfg.provider === 'custom' || !!cfg.apiKey || !!cfg.credId;
const filled = (result, keys) => keys.filter((key) => typeof result?.[key] === 'string' && result[key].trim());

// `stats` (optional, per job) counts which engine answered and records local-model problems for the logs.
async function translateLines(lines, context, cfg, stats = null) {
  const payload = { context, lines };
  const keys = Object.keys(lines);
  const translate = async (provider) => parseModelJson(
    await chat(provider, systemPrompt(cfg), JSON.stringify(payload), { keys }),
  );
  if (cfg.provider !== 'custom' && cfg.localBaseUrl) {
    let partial = null;
    let why = '';
    const local = {
      ...cfg,
      provider: 'custom',
      model: PROVIDERS.custom.defaultModel,
      baseUrl: cfg.localBaseUrl,
      apiKey: '',
      credId: '',
      localAttempt: true,
    };
    const poolKey = `local-first:${local.baseUrl}`;
    // The session flag says the local model is offline: go straight to the cloud, no waiting per batch.
    const session = await localSession(local);
    if (!session.up && stats) stats.localSkipped = (stats.localSkipped || 0) + 1;
    if (!session.up && hasCloudCredentials(cfg)) { if (stats) stats.cloud += 1; return translate(cfg); }
    await acquireSlot(poolKey, 2, () => 0);
    try {
      if (session.up) {
        const result = await translate(local);
        const got = filled(result, keys);
        if (got.length === keys.length) {
          if (stats) stats.local += 1;
          return result;
        }
        partial = got.length ? result : null;
        why = `incomplete answer (${got.length}/${keys.length} lines)`;
      } else {
        why = session.why || `model ${local.model} not loaded / server not answering`;
      }
    } catch (e) {
      why = e.message || String(e);
      markLocalDown(local, why);
    } finally {
      releaseSlot(poolKey);
    }
    const host = (() => { try { return new URL(local.baseUrl).host; } catch { return local.baseUrl; } })();
    if (stats) {
      stats.localFailures += 1;
      stats.lastLocalError = why;
      // First problem per job goes to the log in full; the total is in the job's done/error line.
      if (stats.localFailures === 1) console.warn(`[local] ${stats.key || ''} ${host}: ${why}`);
    }
    if (!hasCloudCredentials(cfg)) {
      // No cloud key to fall back to: keep what the local model did translate (the missing lines are
      // retried by translateBatch), or fail just this batch — never call the cloud without a key, which
      // used to end the whole job with "401: You didn't provide an API key".
      if (partial) {
        if (stats) stats.local += 1;
        return partial;
      }
      throw Object.assign(new Error(`Local model (${host}): ${why} — and no cloud API key is configured to fall back to`), { noCloud: true });
    }
    // Otherwise continue with the configured cloud provider.
  }
  if (stats) stats.cloud += 1;
  return translate(cfg);
}

// Priority semaphore per provider endpoint: at most `limit` requests in flight across all jobs;
// when a slot frees up it goes to the waiting job with the highest priority (most recently requested).
const pools = new Map();
function acquireSlot(key, limit, priority) {
  let p = pools.get(key);
  if (!p) pools.set(key, (p = { active: 0, waiters: [] }));
  p.limit = limit;
  if (p.active < p.limit) {
    p.active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => p.waiters.push({ resolve, priority, seq: p.seq = (p.seq || 0) + 1 }));
}
// Between batches: if a higher-priority job is waiting, give it this slot and queue for another one.
function yieldSlot(key, priority) {
  const p = pools.get(key);
  if (!p || !p.waiters.length) return Promise.resolve();
  p.waiters.sort((a, b) => b.priority() - a.priority() || a.seq - b.seq);
  if (p.waiters[0].priority() <= priority()) return Promise.resolve();
  p.waiters.shift().resolve();
  return new Promise((resolve) => p.waiters.push({ resolve, priority, seq: (p.seq = (p.seq || 0) + 1) }));
}

function releaseSlot(key) {
  const p = pools.get(key);
  if (!p) return;
  if (p.waiters.length && p.active <= p.limit) {
    p.waiters.sort((a, b) => b.priority() - a.priority() || a.seq - b.seq);
    p.waiters.shift().resolve(); // hand the slot over directly
  } else {
    p.active = Math.max(0, p.active - 1);
  }
}

// The first few batches are small so the opening lines come back within seconds (Stremio gives up after ~10 s);
// the rest use the configured batch size for throughput.
const LEAD_BATCHES = 4;
const LEAD_SIZE = 5;
// Small batches first so the opening minutes come back within seconds, then ramp up to `size`.
const RAMP = [LEAD_SIZE, LEAD_SIZE, LEAD_SIZE, LEAD_SIZE, 10, 10, 10, 10];
function makeBatches(cues, size) {
  const batches = [];
  let cur = [];
  let chars = 0;
  const limit = () => Math.min(RAMP[batches.length] || size, size);
  cues.forEach((c, i) => {
    if (cur.length && (cur.length >= limit() || chars + c.text.length > MAX_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += c.text.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

async function translateBatch(job, idxs, cfg, depth = 0) {
  const lines = {};
  idxs.forEach((ci, k) => (lines[String(k + 1)] = job.cues[ci].text));
  const first = idxs[0];
  const context = job.cues.slice(Math.max(0, first - 3), first).map((c) => c.text);
  let result;
  try {
    result = await translateLines(lines, context, cfg, job.stats);
  } catch (e) {
    job.lastError = e.message;
    if (e.fatal || e.status === 401 || e.status === 403 || e.status === 404) throw e; // bad key/model/sign-in: abort job
    if (depth < 2 && idxs.length > 4) {
      const mid = Math.ceil(idxs.length / 2);
      await translateBatch(job, idxs.slice(0, mid), cfg, depth + 1);
      await translateBatch(job, idxs.slice(mid), cfg, depth + 1);
      return;
    }
    job.failed += idxs.length;
    job.done += idxs.length;
    return;
  }
  const missing = [];
  idxs.forEach((ci, k) => {
    const v = result?.[String(k + 1)];
    if (typeof v === 'string' && v.trim()) {
      job.out[ci] = v.replace(/\\n/g, '\n').trim();
      job.done += 1;
    } else {
      missing.push(ci);
    }
  });
  if (missing.length) {
    if (depth < 2 && missing.length < idxs.length) {
      await translateBatch(job, missing, cfg, depth + 1);
    } else {
      job.failed += missing.length;
      job.done += missing.length;
    }
  }
}

async function runJob(job, srcUrl, cfg) {
  try {
    const cues = await downloadCues(srcUrl);
    if (!cues.length) throw new Error('Source subtitle has no readable cues (unsupported format?)');
    job.cues = cues;
    job.out = new Array(cues.length).fill(null);
    job.total = cues.length;
    job.status = 'translating';

    const { batchSize, concurrency } = effectiveLimits(cfg);
    const batches = makeBatches(cues, batchSize);
    job.translateStart = Date.now();
    jobEvent('source', { key: job.key, title: job.title, cues: cues.length, batches: batches.length, concurrency });
    let milestone = 25;
    const progress = () => {
      const pct = Math.floor((job.done / job.total) * 100);
      if (pct < milestone || milestone > 75) return;
      while (milestone <= 75 && pct >= milestone) milestone += 25;
      const secs = Math.round((Date.now() - job.startedAt) / 1000);
      console.log(`[progress] ${job.key} ${pct}% (${job.done}/${job.total}, ${job.failed} failed, ${secs}s)`);
      jobEvent('progress', { key: job.key, title: job.title, pct, done: job.done, failed: job.failed, seconds: secs, ...engineStats(job) });
    };
    let next = 0;
    let fatal = null;
    const poolKey = `${cfg.baseUrl}|${cfg.model}|${cfg.apiKey}|${cfg.credId}`;
    const prio = () => job.lastRequested || 0;
    const worker = async () => {
      // Share the provider's request slots across all jobs; the most recently selected track goes first.
      await acquireSlot(poolKey, concurrency, prio);
      try {
        while (next < batches.length && !fatal) {
          const b = batches[next++];
          try {
            await translateBatch(job, b, cfg);
          } catch (e) {
            fatal = e;
          }
          if (!fatal) progress();
          if (next < batches.length && !fatal) await yieldSlot(poolKey, prio);
        }
      } finally {
        releaseSlot(poolKey);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (fatal) throw fatal;
    if (job.failed === job.total) throw new Error(job.lastError || 'Every batch failed');

    job.srt = toSrt(cues.map((c, i) => ({ ...c, text: job.out[i] ?? c.text })));
    job.status = 'done';
    job.finishedAt = Date.now();
    // Only cache fully (or nearly fully) translated files so transient failures get retried later.
    const cached = job.failed / job.total < 0.02;
    if (cached) fs.writeFileSync(path.join(CACHE_DIR, `${job.key}.srt`), job.srt, 'utf8');
    const secs = (job.finishedAt - job.startedAt) / 1000;
    console.log(`[done] ${job.key} ${job.total} cues, ${job.failed} failed, ${secs.toFixed(1)}s${engineNote(job)}`);
    jobEvent('done', {
      key: job.key, title: job.title, cues: job.total, failed: job.failed, seconds: +secs.toFixed(1),
      cached, ...engineStats(job), lastError: job.failed ? job.lastError : undefined,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = Date.now();
    console.error(`[error] ${job.key}: ${e.message}${engineNote(job)}`);
    jobEvent('error', {
      key: job.key, title: job.title, error: e.message, status: e.status,
      pct: job.total ? Math.floor((job.done / job.total) * 100) : 0, done: job.done, failed: job.failed, cues: job.total,
      seconds: +((job.finishedAt - job.startedAt) / 1000).toFixed(1), ...engineStats(job),
    });
  }
}

const engineStats = (job) => ({
  localBatches: job.stats.local, cloudBatches: job.stats.cloud,
  localFailures: job.stats.localFailures, lastLocalError: job.stats.lastLocalError || undefined,
});
const engineNote = (job) => (job.stats.localFailures
  ? ` · local model: ${job.stats.local} ok / ${job.stats.localFailures} failed (last: ${job.stats.lastLocalError}) · cloud: ${job.stats.cloud}`
  : '');

// `meta` (optional): { type, id, via } — which title asked for this, and how (watch, listing, early, prefetch).
function getOrStartJob(srcUrl, cfg, meta = {}) {
  const key = jobKey(srcUrl, cfg);
  let job = jobs.get(key);
  // Retry failed jobs after 60 s.
  const retryOf = job && job.status === 'error' && Date.now() - job.finishedAt > 60000 ? job : null;
  if (retryOf) job = null;
  if (job) {
    if (!job.title && meta.id) job.title = `${meta.type || ''} ${meta.id}`.trim();
    return job;
  }

  const title = meta.id ? `${meta.type || ''} ${meta.id}`.trim() : retryOf?.title;
  job = {
    key, status: 'downloading', done: 0, failed: 0, total: 0, startedAt: Date.now(), srcUrl, title,
    stats: { key, local: 0, cloud: 0, localFailures: 0, lastLocalError: '' },
  };
  const cacheFile = path.join(CACHE_DIR, `${key}.srt`);
  if (fs.existsSync(cacheFile)) {
    job.status = 'done';
    job.srt = fs.readFileSync(cacheFile, 'utf8');
    job.finishedAt = Date.now();
    job.promise = Promise.resolve();
    jobEvent('cache-hit', { key, title, via: meta.via, src: shortUrl(srcUrl) });
  } else {
    if (retryOf) {
      console.log(`[retry] ${key} after error: ${retryOf.error}`);
      jobEvent('retry', { key, title, previousError: retryOf.error, via: meta.via });
    }
    console.log(`[start] ${key} ${cfg.provider}/${cfg.model} -> ${cfg.targetLang}${title ? ` · ${title}` : ''}${meta.via ? ` (${meta.via})` : ''}`);
    jobEvent('start', {
      key, title, via: meta.via, provider: cfg.provider, model: cfg.model, target: cfg.targetLang,
      localModel: cfg.provider !== 'custom' && cfg.localBaseUrl ? shortUrl(cfg.localBaseUrl).split('/')[0] : undefined,
      cloudKey: hasCloudCredentials(cfg), src: shortUrl(srcUrl),
    });
    job.promise = runJob(job, srcUrl, cfg);
  }
  jobs.set(key, job);
  return job;
}

function noticeCue(text, start = 0, end = 8000) {
  return { start, end, text };
}

function hint(cfg, kind, pct) {
  const el = cfg.targetLang === 'ell';
  if (kind === 'progress') {
    return el
      ? `⏳ Μετάφραση AI: ${pct}%\nΓια τη συνέχεια: υπότιτλοι OFF και ξανά ON`
      : `⏳ AI translation: ${pct}%\nTurn subtitles OFF and back ON to load the rest`;
  }
  if (kind === 'pending') {
    return el ? `[⏳ ${pct}% · OFF/ON για ελληνικά]` : `[⏳ ${pct}% · OFF/ON for the translation]`;
  }
  if (kind === 'starting') {
    return el
      ? '⏳ Η μετάφραση AI ξεκίνησε\nΣε λίγο: υπότιτλοι OFF και ξανά ON'
      : '⏳ AI translation started\nIn a moment, turn subtitles OFF and back ON';
  }
  return el ? `⚠ Η μετάφραση AI απέτυχε: ${pct}\nΕμφανίζονται οι αγγλικοί υπότιτλοι.` : `⚠ AI translation failed: ${pct}\nShowing the English original.`;
}

// True once the first lines (the opening minutes) are translated.
function openingReady(job, lines = LEAD_BATCHES * LEAD_SIZE * 0.75) {
  if (job.status === 'done') return true;
  if (!job.cues || !job.out) return false;
  const n = Math.min(lines, job.cues.length);
  for (let i = 0; i < n; i++) if (!job.out[i]) return false;
  return true;
}

// Estimated ms until the job finishes, from its translation rate so far (Infinity when unknown).
function etaMs(job) {
  if (job.status === 'done') return 0;
  if (!job.translateStart || !job.total || job.done < 10) return Infinity;
  const rate = job.done / (Date.now() - job.translateStart);
  return (job.total - job.done) / rate;
}

function renderJob(job, cfg) {
  if (job.status === 'done') return job.srt;
  if (job.status === 'error') {
    const notice = noticeCue(hint(cfg, 'failed', job.error), 0, 12000);
    if (!job.cues) return toSrt([notice]);
    return toSrt([notice, ...job.cues.map((c, i) => ({ ...c, text: job.out?.[i] ?? c.text }))]);
  }
  if (!job.cues) return toSrt([noticeCue(hint(cfg, 'starting'), 0, 30000)]);
  const pct = job.total ? Math.floor((job.done / job.total) * 100) : 0;
  const cues = [noticeCue(hint(cfg, 'progress', pct), 0, 8000)];
  let marked = false;
  job.cues.forEach((c, i) => {
    if (job.out[i]) {
      cues.push({ ...c, text: job.out[i] });
      return;
    }
    // Where the Greek runs out, remind the viewer how to load the rest.
    if (!marked) {
      cues.push(noticeCue(hint(cfg, 'progress', pct), c.start, c.start + 6000));
      marked = true;
    }
    if (cfg.showOriginalWhilePending) cues.push({ ...c, text: `<i>${c.text}</i>\n${hint(cfg, 'pending', pct)}` });
  });
  cues.sort((a, b) => a.start - b.start);
  return toSrt(cues);
}

// 'done' | 'running' | 'none' — used to prefer subtitles that are already (being) translated.
function translationState(srcUrl, cfg) {
  const key = jobKey(srcUrl, cfg);
  const job = jobs.get(key);
  if (job && job.status === 'done') return 'done';
  if (job && job.status !== 'error') return 'running';
  if (fs.existsSync(path.join(CACHE_DIR, `${key}.srt`))) return 'done';
  return 'none';
}

function status() {
  return [...jobs.values()].map((j) => ({
    key: j.key,
    status: j.status,
    progress: j.total ? Math.floor((j.done / j.total) * 100) : 0,
    cues: j.total,
    failed: j.failed,
    error: j.error,
    startedAt: new Date(j.startedAt).toISOString(),
  }));
}

// Housekeeping: drop finished jobs from memory after 6 h, delete cache files after CACHE_DAYS.
function housekeeping() {
  const now = Date.now();
  for (const [k, j] of jobs) if (j.finishedAt && now - j.finishedAt > 6 * 3600e3) jobs.delete(k);
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      if (now - fs.statSync(p).mtimeMs > CACHE_DAYS * 86400e3) fs.unlinkSync(p);
    }
  } catch { /* ignore */ }
}
setInterval(housekeeping, 3600e3).unref();
housekeeping();

module.exports = { getOrStartJob, renderJob, translateLines, status, openingReady, translationState, etaMs };
