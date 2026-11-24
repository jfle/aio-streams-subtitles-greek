'use strict';
// User configuration is stored inside the addon URL as an AES-256-GCM encrypted token,
// so API keys are never visible in plain text in the manifest URL.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, LANGUAGES } = require('./providers');
const { DATA_DIR } = require('./paths');

function loadSecret() {
  if (process.env.SECRET) {
    return crypto.createHash('sha256').update(process.env.SECRET).digest();
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}
const KEY = loadSecret();

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const DEFAULTS = {
  provider: 'openai',
  apiKey: '',
  model: '',
  baseUrl: '',
  targetLang: 'ell',
  sources: ['https://opensubtitles-v3.strem.io'],
  prioritySources: sourceList(process.env.PRIORITY_SUBTITLE_SOURCES),
  localBaseUrl: endpoint(process.env.LOCAL_LLM_URL),
  maxCandidates: 1,
  autoTranslate: true,
  batchSize: 0, // 0 = automatic (see effectiveLimits)
  concurrency: 0, // 0 = automatic
  temperature: 0.3,
  showOriginalWhilePending: true,
  disableThinking: true,
  prefetchNext: true,
  earlyStart: true,
  autoSync: true, // fingerprint / length / frame-rate / alignment checks (src/sync.js)
  syncNotes: true, // short on-screen note when timing was corrected or couldn't be verified
  // off = always translate with AI; auto = use a verified real subtitle when one is found, AI as a
  // backup track; both = always list the real subtitle next to the AI one so you pick in the player.
  nativeSubtitles: 'auto',
  credId: '',
  instructions: '',
};

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeSourceUrl(u) {
  return String(u || '')
    .trim()
    .replace(/^stremio:\/\//i, 'https://')
    .replace(/\/manifest\.json$/i, '')
    .replace(/\/+$/, '');
}

function sourceList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(list.map(normalizeSourceUrl).filter((s) => /^https?:\/\//i.test(s)))];
}

function endpoint(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(url) ? url : '';
}

function normalizeConfig(input = {}) {
  const c = { ...DEFAULTS, ...input };
  if (!PROVIDERS[c.provider]) c.provider = DEFAULTS.provider;
  const p = PROVIDERS[c.provider];
  c.apiKey = String(c.apiKey || '').trim();
  c.model = String(c.model || '').trim() || p.defaultModel;
  c.baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '') || p.baseUrl;
  if (c.provider === 'custom' && DEFAULTS.localBaseUrl) {
    c.baseUrl = DEFAULTS.localBaseUrl;
    c.model = p.defaultModel;
    c.apiKey = '';
  }
  c.localBaseUrl = endpoint(c.localBaseUrl);
  c.prioritySources = sourceList(c.prioritySources);
  if (!LANGUAGES[c.targetLang]) c.targetLang = DEFAULTS.targetLang;
  let sources = Array.isArray(c.sources) ? c.sources : String(c.sources || '').split(/[\n,]+/);
  sources = sources.map(normalizeSourceUrl).filter((s) => /^https?:\/\//i.test(s));
  c.sources = sources.length ? [...new Set(sources)] : DEFAULTS.sources;
  // Real subtitles first: OpenSubtitles v3 is always asked first (then any other source, then AI).
  c.sources = [...c.sources.filter((u) => /opensubtitles-v3\.strem\.io/i.test(u)), ...c.sources.filter((u) => !/opensubtitles-v3\.strem\.io/i.test(u))];
  c.maxCandidates = clampInt(c.maxCandidates, 1, 10, DEFAULTS.maxCandidates);
  c.batchSize = c.batchSize === '' || +c.batchSize === 0 ? 0 : clampInt(c.batchSize, 5, 150, DEFAULTS.batchSize);
  c.concurrency = c.concurrency === '' || +c.concurrency === 0 ? 0 : clampInt(c.concurrency, 1, 32, DEFAULTS.concurrency);
  const t = parseFloat(c.temperature);
  c.temperature = Number.isNaN(t) ? DEFAULTS.temperature : Math.min(1.5, Math.max(0, t));
  c.autoTranslate = c.autoTranslate === true || c.autoTranslate === 'true' || c.autoTranslate === 'on';
  c.showOriginalWhilePending =
    c.showOriginalWhilePending === true || c.showOriginalWhilePending === 'true' || c.showOriginalWhilePending === 'on';
  c.disableThinking = true;
  c.prefetchNext = c.prefetchNext === true || c.prefetchNext === 'true' || c.prefetchNext === 'on';
  c.earlyStart = c.earlyStart === true || c.earlyStart === 'true' || c.earlyStart === 'on';
  c.autoSync = c.autoSync === true || c.autoSync === 'true' || c.autoSync === 'on';
  c.syncNotes = c.syncNotes === true || c.syncNotes === 'true' || c.syncNotes === 'on';
  if (!['off', 'auto', 'both'].includes(c.nativeSubtitles)) c.nativeSubtitles = DEFAULTS.nativeSubtitles;
  c.credId = /^[\w-]{16,64}$/.test(String(c.credId || '')) ? String(c.credId) : '';
  if (!PROVIDERS[c.provider].auth) c.credId = '';
  c.instructions = String(c.instructions || '').slice(0, 1000);
  return c;
}

function encodeConfig(obj) {
  const cfg = normalizeConfig(obj);
  // Store only non-default values to keep the addon URL short.
  const p = PROVIDERS[cfg.provider];
  const compact = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'model' && v === p.defaultModel) continue;
    if (k === 'baseUrl' && v === p.baseUrl) continue;
    if (k !== 'provider' && JSON.stringify(v) === JSON.stringify(DEFAULTS[k])) continue;
    compact[k] = v;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(compact), 'utf8'), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

function decodeConfig(token) {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return normalizeConfig(JSON.parse(json));
  } catch {
    return null;
  }
}

// Automatic request sizing. Cloud models answer a 20-line batch in ~8-30 s no matter how fast the
// account is, so speed comes from many parallel requests; a ChatGPT plan handled 24 at once in tests.
// Local servers (LM Studio) only run a few requests at a time.
function effectiveLimits(cfg) {
  const local = cfg.provider === 'custom';
  const autoConc = cfg.provider === 'chatgpt' ? 24 : local ? 3 : 8;
  return {
    batchSize: cfg.batchSize > 0 ? cfg.batchSize : 20,
    concurrency: cfg.concurrency > 0 ? cfg.concurrency : autoConc,
    local,
  };
}

// Signs subtitle source URLs so the server can only be made to download URLs it handed out itself.
function sign(str) {
  return crypto.createHmac('sha256', KEY).update(str).digest('base64url').slice(0, 22);
}

module.exports = { DATA_DIR, DEFAULTS, normalizeConfig, encodeConfig, decodeConfig, sign, b64url, effectiveLimits };
