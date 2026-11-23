'use strict';
// Persistent logs on the data disk. The system journal is not enough on its own: on Armbian /
// Orange Pi it lives in a small RAM disk that fills up and is lost on a crash or power cut.
//
//   DATA_DIR/logs/addon-YYYY-MM-DD.log  every log line, timestamped      (kept LOG_DAYS, default 90)
//   DATA_DIR/logs/jobs-YYYY-MM.jsonl    one JSON line per translation-job event: start, source,
//                                       progress, local-model problems, done / error, retry, cache hit
//                                       (kept JOB_LOG_DAYS, default 400)
//
// Lines still go to stdout/stderr as before, so `journalctl -u aio-streams-subtitles-greek` keeps working.
// Set LOG_TO_FILES=off to disable the files. API keys and bearer tokens are masked before writing.

const fs = require('fs');
const path = require('path');
const util = require('util');
const { DATA_DIR } = require('./paths');

const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_DAYS = num(process.env.LOG_DAYS, 90);
const JOB_LOG_DAYS = num(process.env.JOB_LOG_DAYS, 400);

let enabled = process.env.LOG_TO_FILES !== 'off';
if (enabled) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    enabled = false;
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
// Local time with its UTC offset, e.g. 2026-11-23T13:05:01.123+02:00 (the Pi runs on local time).
function stamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const month = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function redact(s) {
  return String(s)
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1<redacted>')
    .replace(/\b(sk-|sk_|xai-|gsk_|AIza)[\w-]{12,}/g, '$1<redacted>');
}

let writeFailed = false;
function append(file, text) {
  if (!enabled) return;
  try {
    fs.appendFileSync(path.join(LOG_DIR, file), text, 'utf8');
    writeFailed = false;
  } catch (e) {
    // Report once (e.g. disk full), then keep trying silently on later lines.
    if (!writeFailed) {
      writeFailed = true;
      origError?.(`[logbook] cannot write ${file}: ${e.message}`);
    }
  }
}

let origError = null;
let installed = false;
// Mirror console output into the daily addon log.
function install() {
  if (installed) return;
  installed = true;
  origError = console.error.bind(console);
  for (const [name, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const orig = console[name].bind(console);
    console[name] = (...args) => {
      orig(...args);
      const text = redact(util.format(...args));
      append(`addon-${day()}.log`, text.split('\n').map((l) => `${stamp()} ${level} ${l}`).join('\n') + '\n');
    };
  }
  // Without these an unexpected crash only reaches the RAM journal.
  process.on('uncaughtException', (e) => {
    console.error(`[crash] ${e && e.stack ? e.stack : e}`);
    process.exit(1); // same outcome as Node's default; systemd restarts the service
  });
  process.on('unhandledRejection', (e) => {
    console.error(`[unhandled] ${e && e.stack ? e.stack : e}`);
  });
  prune();
  setInterval(prune, 24 * 3600e3).unref();
}

// One structured line per translation-job event.
function jobEvent(event, fields = {}) {
  append(`jobs-${month()}.jsonl`, redact(JSON.stringify({ ts: stamp(), event, ...fields })) + '\n');
}

// A short, safe description of a subtitle URL for the job log: host + file name, no query string.
function shortUrl(u) {
  try {
    const url = new URL(u);
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    return `${url.host}/…/${decodeURIComponent(last).slice(0, 120)}`;
  } catch {
    return String(u || '').slice(0, 120);
  }
}

function prune(now = Date.now()) {
  if (!enabled) return;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      const keepDays = /^addon-.*\.log$/.test(f) ? LOG_DAYS : /^jobs-.*\.jsonl$/.test(f) ? JOB_LOG_DAYS : 0;
      if (!keepDays) continue;
      const p = path.join(LOG_DIR, f);
      if (now - fs.statSync(p).mtimeMs > keepDays * 86400e3) fs.unlinkSync(p);
    }
  } catch { /* ignore */ }
}

module.exports = { install, jobEvent, shortUrl, redact, prune, stamp, LOG_DIR };
