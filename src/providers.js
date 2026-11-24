'use strict';
// AI provider adapters. Most providers expose an OpenAI-compatible Chat Completions API;
// Anthropic and Google Gemini use their native APIs.

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'gpt-5-mini', 'gpt-5'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  chatgpt: {
    label: 'OpenAI — sign in with ChatGPT (Plus/Pro plan)',
    type: 'chatgpt',
    auth: 'chatgpt',
    baseUrl: (process.env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    defaultModel: '',
    models: [],
    keyUrl: '',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-haiku-4-5',
    models: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    label: 'Google Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-flash-latest',
    models: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  mistral: {
    label: 'Mistral AI',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  xai: {
    label: 'xAI (Grok) — sign in with SuperGrok / X Premium, or API key',
    auth: 'xai',
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.20-0309-non-reasoning',
    models: ['grok-4.20-0309-non-reasoning', 'grok-4.7', 'grok-4.6', 'grok-4.3', 'grok-build-0.1'],
    keyUrl: 'https://console.x.ai',
  },
  groq: {
    label: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    keyUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter (any model) — sign in or API key',
    auth: 'openrouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-2.5-flash',
    models: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'anthropic/claude-haiku-4.5', 'deepseek/deepseek-chat'],
    keyUrl: 'https://openrouter.ai/keys',
  },
  together: {
    label: 'Together AI',
    type: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
  },
  custom: {
    label: 'Custom OpenAI-compatible (Ollama, LM Studio, vLLM…)',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama-krikri-8b-instruct',
    models: [],
    keyUrl: '',
  },
};

// Stremio / OpenSubtitles use ISO 639-2 (bibliographic) codes.
const LANGUAGES = {
  ell: 'Greek',
  bul: 'Bulgarian',
  hrv: 'Croatian',
  cze: 'Czech',
  dut: 'Dutch',
  fre: 'French',
  ger: 'German',
  hun: 'Hungarian',
  ita: 'Italian',
  pol: 'Polish',
  por: 'Portuguese',
  rum: 'Romanian',
  rus: 'Russian',
  scc: 'Serbian',
  spa: 'Spanish',
  swe: 'Swedish',
  tur: 'Turkish',
  ukr: 'Ukrainian',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, body) {
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = j.error?.message || j.message || j.error || body;
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch { /* keep raw body */ }
    super(`HTTP ${status}: ${String(msg).slice(0, 300)}`);
    this.status = status;
    this.body = body || '';
  }
}

async function requestJson(url, opts = {}, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 180000) });
  } catch (e) {
    if (opts.retry !== false && attempt < 3) {
      await sleep(1500 * 2 ** attempt);
      return requestJson(url, opts, attempt + 1);
    }
    throw new Error(`Network error contacting ${new URL(url).host}: ${e.message}`);
  }
  if ((res.status === 429 || res.status >= 500) && opts.retry !== false && attempt < 5) {
    const retryAfter = parseFloat(res.headers.get('retry-after')) || 0;
    await res.text().catch(() => {});
    await sleep(Math.min(60000, Math.max(retryAfter * 1000, 2000 * 2 ** attempt)));
    return requestJson(url, opts, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).host}`);
  }
}

// API key from the config, or from a stored sign-in (OpenRouter OAuth).
function resolveKey(cfg) {
  if (cfg.credId && PROVIDERS[cfg.provider].auth === 'openrouter') return auth().staticKey(cfg.credId);
  return cfg.apiKey;
}
let authMod = null;
const auth = () => (authMod ||= require('./auth'));

function openaiHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  const key = resolveKey(cfg);
  if (key) h.Authorization = `Bearer ${key}`;
  if (cfg.provider === 'openrouter') {
    h['HTTP-Referer'] = 'https://github.com/aio-streams-subtitles-greek';
    h['X-Title'] = 'AIO-Streams&Subtitles-Greek';
  }
  return h;
}

// Removes inline <think>…</think> blocks that some local models put in the answer text.
const stripThinking = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();

async function chatOpenAI(cfg, system, user, opts = {}) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: cfg.temperature,
  };
  const local = cfg.provider === 'custom';
  // LM Studio (and other local servers) skip a model's "thinking" phase when asked for reasoning effort "none".
  if (local) body.reasoning_effort = 'none';
  // Structured output: the server's grammar forces valid JSON with exactly one string per subtitle key.
  if (local && opts.keys?.length) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'subtitle_translations',
        strict: true,
        schema: {
          type: 'object',
          properties: Object.fromEntries(opts.keys.map((k) => [k, { type: 'string' }])),
          required: opts.keys,
          additionalProperties: false,
        },
      },
    };
  }
  // Some servers/models reject a parameter (temperature, reasoning_effort): drop it and retry.
  for (let i = 0; i < 4; i++) {
    try {
      const j = await requestJson(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: openaiHeaders(cfg),
        body: JSON.stringify(body),
        // Local servers may need to load the model into memory on the first request.
        timeout: cfg.localAttempt ? 30000 : local ? 600000 : 180000,
        retry: !cfg.localAttempt,
      });
      let content = j.choices?.[0]?.message?.content;
      if (Array.isArray(content)) content = content.map((p) => p.text || '').join('');
      return stripThinking(content);
    } catch (e) {
      if (e.status === 400 && /temperature/i.test(e.body) && 'temperature' in body) {
        delete body.temperature;
        continue;
      }
      if (e.status === 400 && /reasoning/i.test(e.body) && 'reasoning_effort' in body) {
        delete body.reasoning_effort;
        continue;
      }
      if (e.status === 400 && /response_format|json_schema|grammar|schema/i.test(e.body) && 'response_format' in body) {
        delete body.response_format;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Request failed');
}

async function chatAnthropic(cfg, system, user) {
  const j = await requestJson(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      temperature: Math.min(1, cfg.temperature),
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function chatGemini(cfg, system, user) {
  const model = cfg.model.replace(/^models\//, '');
  const categories = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ];
  const j = await requestJson(`${cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: cfg.temperature, responseMimeType: 'application/json' },
      // Film dialogue often contains violence/profanity; don't let safety filters drop whole batches.
      safetySettings: categories.map((category) => ({ category, threshold: 'BLOCK_NONE' })),
    }),
  });
  const cand = j.candidates?.[0];
  if (!cand?.content?.parts) {
    throw new Error(`Gemini returned no content (${cand?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`);
  }
  return cand.content.parts.map((p) => p.text || '').join('');
}


// ChatGPT plan usage: Responses API with the signed-in user's access token.
// Required by OpenAI for this flow: store=false, stream=true; no temperature / max_output_tokens.
function subtitleSchema(keys) {
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
    required: keys,
    additionalProperties: false,
  };
}

async function readResponsesStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let completed = null;
  let failed = null;
  const handle = (block) => {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.type === 'response.output_text.delta') text += j.delta || '';
    else if (j.type === 'response.completed') completed = j.response || {};
    else if (j.type === 'response.failed' || j.type === 'response.incomplete' || j.type === 'error') {
      failed = j.response?.error?.message || j.response?.incomplete_details?.reason || j.error?.message || j.message || j.type;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handle(buf);
  if (failed) throw new Error(`ChatGPT: ${failed}`);
  if (!completed) throw new Error('ChatGPT response ended before it completed');
  if (!text) {
    for (const item of completed.output || []) {
      for (const c of item.content || []) if (c.type === 'output_text') text += c.text || '';
    }
  }
  return text;
}

async function chatChatgpt(cfg, system, user, opts = {}) {
  if (!cfg.model) throw Object.assign(new Error('Choose a model (click "Load models" after signing in).'), { fatal: true });
  const body = {
    model: cfg.model,
    instructions: system,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }],
    store: false,
    stream: true,
  };
  if (opts.keys?.length) {
    body.text = { format: { type: 'json_schema', name: 'subtitle_translations', strict: true, schema: subtitleSchema(opts.keys) } };
  }
  if (cfg.disableThinking) body.reasoning = { effort: 'low' }; // lowest level these models support
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await auth().chatgptAccessToken(cfg.credId);
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000),
      });
    } catch (e) {
      if (attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
      throw new Error(`Network error contacting OpenAI: ${e.message}`);
    }
    if (res.ok) return readResponsesStream(res);
    const text = await res.text();
    const err = new HttpError(res.status, text);
    if (res.status === 401 && attempt === 0) { await auth().refreshChatgpt(cfg.credId, true); continue; }
    if (/usage_limit|subscription_sharing/i.test(text)) {
      throw Object.assign(new Error('Your ChatGPT plan usage limit for this app is reached. Raise the limit in ChatGPT settings or try later.'), { fatal: true, status: 429 });
    }
    if (res.status === 400 && /reasoning/i.test(text) && body.reasoning) { delete body.reasoning; continue; }
    if (res.status === 400 && /text\.format|json_schema|response_format/i.test(text) && body.text) { delete body.text; continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const ra = parseFloat(res.headers.get('retry-after')) || 0;
      await sleep(Math.min(60000, Math.max(ra * 1000, 2000 * 2 ** attempt)));
      continue;
    }
    throw err;
  }
  throw new Error('OpenAI request failed');
}

// Sign in with Grok: plan usage goes through xAI's Responses API with the OAuth access token.
// Grok CLI sessions are served by cli-chat-proxy.grok.com; try the public API first, then that.
const XAI_OAUTH_BASES = [process.env.XAI_OAUTH_API_URL || 'https://api.x.ai/v1', process.env.XAI_OAUTH_PROXY_URL || 'https://cli-chat-proxy.grok.com/v1'];
const xaiBaseOk = new Map(); // credId -> base that worked last

function responsesText(j) {
  if (typeof j.output_text === 'string') return j.output_text;
  return (j.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text' || c.type === 'text')
    .map((c) => c.text)
    .join('');
}

async function chatXai(cfg, system, user, opts = {}) {
  const body = {
    model: cfg.model,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    store: false,
    temperature: cfg.temperature,
  };
  if (opts.keys?.length) body.text = { format: { type: 'json_schema', name: 'subtitle_translations', strict: true, schema: subtitleSchema(opts.keys) } };
  const known = xaiBaseOk.get(cfg.credId);
  const bases = known ? [known, ...XAI_OAUTH_BASES.filter((b) => b !== known)] : [...XAI_OAUTH_BASES];
  let refreshed = false;
  let lastErr = null;
  for (let bi = 0; bi < bases.length; bi++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await auth().xaiAccessToken(cfg.credId);
      let res;
      try {
        res = await fetch(`${bases[bi]}/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300000),
        });
      } catch (e) {
        if (attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
        throw new Error(`Network error contacting xAI: ${e.message}`);
      }
      const text = await res.text();
      if (res.ok) {
        xaiBaseOk.set(cfg.credId, bases[bi]);
        return responsesText(JSON.parse(text));
      }
      lastErr = new HttpError(res.status, text);
      if (res.status === 401 && !refreshed) { refreshed = true; await auth().refreshXai(cfg.credId, true); continue; }
      if (res.status === 400 && /temperature/i.test(text) && 'temperature' in body) { delete body.temperature; continue; }
      if (res.status === 400 && /text\.format|json_schema|response_format|structured/i.test(text) && body.text) { delete body.text; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const ra = parseFloat(res.headers.get('retry-after')) || 0;
        await sleep(Math.min(60000, Math.max(ra * 1000, 2000 * 2 ** attempt)));
        continue;
      }
      break; // 403/404 etc.: try the next endpoint
    }
  }
  if (lastErr && (lastErr.status === 403 || lastErr.status === 401)) {
    throw Object.assign(
      new Error('xAI did not allow this account to use Grok through sign-in (it needs an active SuperGrok or X Premium subscription that xAI has enabled for apps). Use an xAI API key instead.'),
      { fatal: true, status: 403 },
    );
  }
  throw lastErr || new Error('xAI request failed');
}

async function chat(cfg, system, user, opts = {}) {
  if (cfg.provider === 'xai' && cfg.credId) return chatXai(cfg, system, user, opts);
  const type = PROVIDERS[cfg.provider].type;
  if (type === 'anthropic') return chatAnthropic(cfg, system, user);
  if (type === 'gemini') return chatGemini(cfg, system, user);
  if (type === 'chatgpt') return chatChatgpt(cfg, system, user, opts);
  return chatOpenAI(cfg, system, user, opts);
}

async function listModels(cfg) {
  if (cfg.provider === 'xai' && cfg.credId) {
    const token = await auth().xaiAccessToken(cfg.credId);
    for (const base of XAI_OAUTH_BASES) {
      try {
        const j = await requestJson(`${base}/models`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }, 3);
        const ids = (j.data || j.models || []).map((m) => m.id || m.slug || m.name).filter((id) => id && !/imagine|image|video|tts|embed/i.test(id));
        if (ids.length) return ids.sort();
      } catch { /* try the next endpoint */ }
    }
    return PROVIDERS.xai.models; // listing is not always open to sign-in tokens; these work on the plans
  }
  const type = PROVIDERS[cfg.provider].type;
  if (type === 'chatgpt') {
    const token = await auth().chatgptAccessToken(cfg.credId);
    const j = await requestJson(`${cfg.baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    // ChatGPT plan usage returns { models: [{ slug, display_name, visibility, … }] }; the API key flow returns { data: [{ id }] }.
    return (j.models || j.data || [])
      .filter((m) => !m.visibility || m.visibility === 'list')
      .map((m) => m.slug || m.id)
      .filter(Boolean);
  }
  if (type === 'anthropic') {
    const j = await requestJson(`${cfg.baseUrl}/models?limit=100`, {
      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      timeout: 20000,
    });
    return (j.data || []).map((m) => m.id);
  }
  if (type === 'gemini') {
    const j = await requestJson(`${cfg.baseUrl}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': cfg.apiKey },
      timeout: 20000,
    });
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  const j = await requestJson(`${cfg.baseUrl}/models`, { headers: openaiHeaders(cfg), timeout: 20000 });
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

// Is anything listening on the local model's port? A plain TCP connect (no HTTP, ~1 s at most), so a PC that is
// off or asleep costs one quick check instead of a timeout on every batch.
const net = require('net');
function portOpen(baseUrl, timeoutMs = 1200) {
  let u;
  try { u = new URL(baseUrl); } catch { return Promise.resolve(false); }
  const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Per-session flag for the free local model: checked once (port, then the model list) and remembered —
// 'up' for 20 minutes, 'down' for 3 — so every job in a viewing session uses the same, already known answer.
const localState = new Map(); // baseUrl|model -> { at, up, why }
async function localSession(cfg, { force = false } = {}) {
  const key = `${cfg.baseUrl}|${cfg.model}`;
  const hit = localState.get(key);
  if (!force && hit && Date.now() - hit.at < (hit.up ? 20 : 3) * 60e3) return hit;
  let up = false;
  let why = '';
  if (!(await portOpen(cfg.baseUrl))) why = 'port closed (PC off, asleep or LM Studio server not started)';
  else {
    try { up = await localModelAvailable(cfg); if (!up) why = `model ${cfg.model} not loaded`; } catch (e) { why = e.message || String(e); }
  }
  const state = { at: Date.now(), up, why };
  if (!hit || hit.up !== up) console.log(`[local] ${cfg.baseUrl} is ${up ? 'online — used first (free)' : `offline — ${why}; using the cloud providers in order`}`);
  localState.set(key, state);
  return state;
}

/** A local call failed outright (connection/HTTP error): treat the model as offline until the next check. */
function markLocalDown(cfg, why) {
  const key = `${cfg.baseUrl}|${cfg.model}`;
  const was = localState.get(key);
  localState.set(key, { at: Date.now(), up: false, why });
  if (!was || was.up) console.log(`[local] ${cfg.baseUrl} stopped answering (${why}); using the cloud providers in order`);
}

async function localModelAvailable(cfg) {
  const models = await requestJson(`${cfg.baseUrl}/models`, {
    headers: openaiHeaders(cfg), timeout: 1500, retry: false,
  });
  return (models.data || models.models || []).some((model) => (model.id || model.name) === cfg.model);
}

module.exports = { PROVIDERS, LANGUAGES, chat, listModels, localModelAvailable, localSession, markLocalDown, portOpen };
