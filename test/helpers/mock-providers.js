'use strict';
// One local HTTP server that imitates everything the addon talks to:
// a Stremio subtitle source, an OpenAI-compatible LLM, OpenRouter OAuth, OpenAI "Sign in with ChatGPT"
// (authorize, token, JWKS, models, Responses API) and xAI device-code sign-in + Responses API.
// Behaviour can be changed from tests through the returned `state` object.

const http = require('http');
const crypto = require('crypto');

const PHRASES = ['you know what I mean, right?', 'I think we have to go now.', 'what is that? Is it yours?', 'we can do this, just trust me.', 'he was here a minute ago.', 'come on, get in the car!', 'are you okay? Talk to me.', "I don't know what to say."];

// A subtitle with `lines` cues every ~3 s. Variants (by file name) model real-world problems:
//   -shift   +3 s late          -fps   made for 25 fps (times × 23.976/25)
//   -cd1     first half only    -forced 10 lines only      -fr   French text
function makeSrt(lines, variant = '') {
  const fmt = (ms) => {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  const map = (t) => (variant.includes('-shift') ? t + 3000 : variant.includes('-fps') ? Math.round((t * 23.976) / 25) : t);
  const n = variant.includes('-cd1') ? Math.floor(lines / 2) : variant.includes('-forced') ? 10 : lines;
  let out = '';
  // -irr: natural, irregular dialogue rhythm (same for every file of a title) so timing alone can place it;
  // -greektext: Greek text (no shared lines with the English reference)
  let t = 1000;
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    let dur = 2000;
    if (variant.includes('-irr')) { dur = 900 + Math.floor(rnd() * 3200); } else t = 1000 + i * 3000;
    const text = variant.includes('-fr') ? `Ligne ${i} : je ne sais pas quoi dire, mon ami.` : variant.includes('-greektext') ? `Γραμμή ${i}: δεν ξέρω τι να πω, φίλε μου.` : `Line ${i}: ${PHRASES[i % PHRASES.length]}`;
    out += `${i + 1}\n${fmt(map(t))} --> ${fmt(map(t + dur))}\n${text}\n\n`;
    if (variant.includes('-irr')) t += dur + (rnd() < 0.08 ? 6000 + Math.floor(rnd() * 20000) : 250 + Math.floor(rnd() * 3000));
  }
  return out;
}

const greek = (lines, prefix) => Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, `${prefix} ${v}`]));

function startMockProviders({ lines = 120, llmDelayMs = 30 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = (aud, nonce) => {
    const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const p = b64({ iss: 'https://auth.openai.com', aud, sub: 'user-123', email: 'viewer@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600 });
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };

  // Per-title source listings can be overridden by tests: state.listings[id] = [{ file, m, release, group, fps, season, episode }]
  const codes = new Map();
  const state = {
    requests: [],
    chatCalls: 0,
    chatBodies: [],
    rejectChat: false,
    localModel: false,
    xaiPolls: 0,
    listings: {},
    runtimeMin: null,
    xaiApiDenied: true, // api.x.ai refuses sign-in tokens -> addon must fall back to the proxy endpoint
    xaiProxyDenied: false,
    refreshCount: 0,
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      state.requests.push(`${req.method} ${p}`);
      const json = (code, o, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
      let m;

      // ---- Stremio subtitle source (OpenSubtitles-like) ----
      if ((m = p.match(/^\/subtitles\/(series|movie)\/([^/]+?)(?:\/([^/]+))?\.json$/))) {
        const rawId = decodeURIComponent(m[2]);
        const id = rawId.replace(/[^\w]/g, '_');
        const base = `http://127.0.0.1:${server.address().port}`;
        const custom = state.listings[rawId];
        if (custom) {
          return json(200, { subtitles: custom.map((c) => ({ url: `${base}/files/${id}${c.file}.srt`, lang: c.lang || 'eng', m: c.m || 'i', subtitleFileName: c.release ? `${c.release}.srt` : `${id}${c.file}.srt`, movieReleaseName: c.release || '', releaseGroup: c.group || '', fpsMilli: c.fps || 23976, season: c.season || 0, episode: c.episode || 0 })) });
        }
        const names = m[3] ? [`${id}-hashmatch`, `${id}-popular`, `${id}-other`] : [`${id}-popular`, `${id}-hashmatch`, `${id}-other`];
        return json(200, { subtitles: [...names.map((n) => ({ url: `${base}/files/${n}.srt`, lang: 'eng', m: m[3] && n.endsWith('-hashmatch') ? 'h' : 'i' })), { url: `${base}/files/${id}-fr.srt`, lang: 'fre' }] });
      }
      if (p.startsWith('/files/')) { res.writeHead(200, { 'Content-Type': 'application/x-subrip' }); return res.end(makeSrt(lines, p)); }
      if ((m = p.match(/^\/meta\/(movie|series)\/(tt\d+)\.json$/))) return json(200, { meta: { id: m[2], runtime: state.runtimeMin ? `${state.runtimeMin} min` : undefined } });

      // ---- OpenAI-compatible LLM (custom provider / OpenRouter / API keys) ----
      if (p === '/v1/chat/completions') {
        state.chatCalls++;
        const j = JSON.parse(body);
        state.chatBodies.push(j);
        if (state.rejectChat) return json(503, { error: 'offline' });
        const payload = JSON.parse(j.messages[j.messages.length - 1].content);
        const out = greek(payload.lines, 'ΕΛ');
        // state.dropLines = N: answer with the last N lines missing (an incomplete local-model reply).
        if (state.dropLines) Object.keys(out).slice(-state.dropLines).forEach((k) => delete out[k]);
        return setTimeout(() => json(200, { choices: [{ message: { content: JSON.stringify(out) } }] }), llmDelayMs);
      }

      // ---- OpenRouter OAuth PKCE ----
      if (p === '/api/v1/auth/keys') {
        const j = JSON.parse(body);
        if (j.code !== 'good-code' || !j.code_verifier) return json(403, { error: { message: 'bad code' } });
        return json(200, { key: 'sk-or-v1-mock' });
      }

      // ---- OpenAI: Sign in with ChatGPT ----
      if (p === '/api/accounts/authorize') {
        const q = u.searchParams;
        const code = `c-${crypto.randomBytes(4).toString('hex')}`;
        codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
        const loc = new URL(q.get('redirect_uri'));
        loc.searchParams.set('code', code);
        loc.searchParams.set('state', q.get('state'));
        if (q.get('client_id') === 'dynamic_agent_client') loc.searchParams.set('client_id', 'oaiapp_test');
        loc.searchParams.set('scope', q.get('scope'));
        res.writeHead(302, { Location: loc.toString() });
        return res.end();
      }
      if (p === '/.well-known/jwks.json') return json(200, { keys: [jwk] });
      if (p === '/api/accounts/oauth/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code'));
          const ok = c && crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') === c.challenge && f.get('redirect_uri') === c.redirect && f.get('client_id') === 'oaiapp_test';
          if (!ok) return json(400, { error: 'invalid_grant' });
          return json(200, { id_token: idToken('oaiapp_test', c.nonce), access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
        }
        if (f.get('grant_type') === 'refresh_token') {
          state.refreshCount++;
          return json(200, { access_token: `at-${state.refreshCount + 1}`, refresh_token: `rt-${state.refreshCount + 1}`, expires_in: 3600 });
        }
      }
      if (p === '/v1/models' && state.localModel) {
        return json(200, { data: [{ id: 'llama-krikri-8b-instruct' }] });
      }
      if (p === '/v1/models') return json(200, { data: [{ id: 'gpt-6-luna', visibility: 'list' }, { id: 'gpt-6-sol', visibility: 'list' }, { id: 'internal-x', visibility: 'hidden' }] });
      if (p === '/v1/responses') {
        const j = JSON.parse(body);
        if (j.reasoning && j.reasoning.effort === 'unsupported') return json(400, { error: { message: 'Unsupported value reasoning.effort' } });
        const out = JSON.stringify(greek(JSON.parse(j.input[0].content[0].text).lines, 'ΕΛ'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.created' })}\n\n`);
        for (let i = 0; i < out.length; i += 20) res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: out.slice(i, i + 20) })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`);
        return res.end();
      }

      // ---- xAI: Sign in with Grok (device code) ----
      if (p === '/xai/oauth2/device/code') {
        const f = new URLSearchParams(body);
        state.xaiDevice = { client_id: f.get('client_id'), scope: f.get('scope'), referrer: f.get('referrer') };
        state.xaiPolls = 0;
        return json(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://accounts.x.ai/device', verification_uri_complete: 'https://accounts.x.ai/device?user_code=ABCD-EFGH', expires_in: 600, interval: 1 });
      }
      if (p === '/xai/oauth2/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type').endsWith('device_code')) {
          if (++state.xaiPolls < 2) return json(400, { error: 'authorization_pending' });
          return json(200, { access_token: 'xat-1', refresh_token: 'xrt-1', expires_in: 3600, id_token: `h.${b64({ email: 'viewer@example.com' })}.s` });
        }
        if (f.get('grant_type') === 'refresh_token') return json(200, { access_token: 'xat-2', expires_in: 3600 });
      }
      if ((m = p.match(/^\/xai\/(api|proxy)\/v1\/(models|responses)$/))) {
        const denied = m[1] === 'api' ? state.xaiApiDenied : state.xaiProxyDenied;
        if (denied) return json(403, { error: 'The caller does not have permission to execute the specified operation.' });
        if (m[2] === 'models') return json(403, { error: 'listing not allowed' });
        const j = JSON.parse(body);
        const out = JSON.stringify(greek(JSON.parse(j.input[1].content).lines, 'ΓΚ'));
        return json(200, { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: out }] }] });
      }

      json(404, { error: `mock: no route ${p}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startMockProviders, makeSrt };
