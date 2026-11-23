'use strict';
// Subtitle parsing (SRT, WebVTT, ASS/SSA, MicroDVD) and SRT serialisation.

// Non-UTF-8 legacy subtitles use the Windows codepage for their own script, not always Windows-1252
// (e.g. a Greek .srt that predates UTF-8 is Windows-1253; Western-European text stays Windows-1252).
const LEGACY_CODEPAGES = {
  ell: 'windows-1253',
  bul: 'windows-1251',
  rus: 'windows-1251',
  ukr: 'windows-1251',
  scc: 'windows-1250',
  hrv: 'windows-1250',
  cze: 'windows-1250',
  hun: 'windows-1250',
  pol: 'windows-1250',
  rum: 'windows-1250',
  tur: 'windows-1254',
};
function legacyEncodingFor(lang) {
  return LEGACY_CODEPAGES[lang] || 'windows-1252';
}

function decodeBuffer(buf, legacyEncoding = 'windows-1252') {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    // Older subtitles in the target script are frequently in that script's own legacy codepage.
    try {
      return new TextDecoder(legacyEncoding).decode(buf);
    } catch {
      return new TextDecoder('windows-1252').decode(buf);
    }
  }
}

const TIME_RE =
  /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

const toMs = (h, m, s, ms) =>
  (parseInt(h || '0', 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + parseInt(ms.padEnd(3, '0'), 10);

// Which format a subtitle file is in: 'srt' (also WebVTT), 'ass', 'microdvd' or 'unknown'.
function detectFormat(text) {
  const t = text.replace(/^﻿/, '').trimStart();
  if (/^\[Script Info\]/im.test(t.slice(0, 2000)) || /^Dialogue:\s*\d/m.test(t)) return 'ass';
  if (/^\{\d+\}\{\d*\}/m.test(t.slice(0, 2000))) return 'microdvd';
  if (TIME_RE.test(t)) return 'srt';
  return 'unknown';
}

// ASS / SSA: "Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text" (field order from Format:).
function parseAss(text) {
  const cues = [];
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const assTime = (v) => {
    const m = /(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})/.exec(v || '');
    return m ? (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 + parseInt(m[4].padEnd(3, '0').slice(0, 3), 10) : null;
  };
  let inEvents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    if (!inEvents && !/^Dialogue:/i.test(line)) continue;
    if (/^Format:/i.test(line)) { fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase()); continue; }
    if (!/^Dialogue:/i.test(line)) continue;
    const parts = line.slice(9).split(',');
    const ti = fields.indexOf('text');
    const rec = {};
    fields.forEach((f, i) => { rec[f] = i === ti ? parts.slice(i).join(',') : (parts[i] || '').trim(); });
    if (/^(sign|song|karaoke|op|ed)/i.test(rec.style || '') && /\\(pos|move|k|kf|ko)\b/.test(rec.text || '')) continue; // positioned signs / karaoke
    const start = assTime(rec.start);
    const end = assTime(rec.end);
    const body = String(rec.text || '')
      .replace(/\{\\i1\}/g, '<i>').replace(/\{\\i0?\}/g, '</i>')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n').replace(/\\h/g, ' ')
      .trim();
    if (start === null || end === null || !body) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

// MicroDVD: "{startFrame}{endFrame}Line one|Line two". Frame numbers need the video frame rate.
function parseMicroDvd(text, fps) {
  const cues = [];
  let rate = fps || 23.976;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(raw.trim());
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a + Math.round(rate * 3);
    // A first line like "{1}{1}23.976" declares the frame rate.
    if (a <= 1 && b <= 1 && /^\d+(\.\d+)?$/.test(m[3].trim())) { rate = parseFloat(m[3]); continue; }
    const body = m[3]
      .replace(/\{y:i\}/gi, '').replace(/\{[^}]*\}/g, '')
      .split('|').map((l) => l.trim()).join('\n').trim();
    if (body) cues.push({ start: Math.round((a / rate) * 1000), end: Math.round((b / rate) * 1000), text: body });
  }
  return cues;
}

// opts.fps: frame rate for frame-based formats (MicroDVD); defaults to 23.976.
function parseSubtitles(text, opts = {}) {
  const format = detectFormat(text);
  if (format === 'ass') return parseAss(text).sort((a, b) => a.start - b.start);
  if (format === 'microdvd') return parseMicroDvd(text, opts.fps).sort((a, b) => a.start - b.start);
  const cues = [];
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const m = TIME_RE.exec(lines[idx]);
    if (!m) continue;
    const body = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<(?!\/?[ibu]>)[^>\n]+>/gi, '') // strip WebVTT voice/class tags, keep <i>/<b>/<u>
      .trim();
    if (!body) continue;
    cues.push({ start: toMs(m[1], m[2], m[3], m[4]), end: toMs(m[5], m[6], m[7], m[8]), text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function fmt(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}

module.exports = { decodeBuffer, legacyEncodingFor, parseSubtitles, detectFormat, toSrt };
