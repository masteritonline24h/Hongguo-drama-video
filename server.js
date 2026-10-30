// Thin proxy so the Apify token never reaches the browser.
import 'dotenv/config';
import express from 'express';
import convert from 'heic-convert';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const TOKEN = process.env.APIFY_TOKEN;
const BASE = 'https://api.apify.com/v2';
const ACTORS = {
  search: 'spider_studio~hongguo-search',
  detail: 'spider_studio~hongguo-series-detail',
  download: 'spider_studio~hongguo-series-download-kvs',
  feed: 'spider_studio~hongguo-recommend-feed',
  dlVideo: 'spider_studio~hongguo-video-download-kvs',
};

async function apify(p, body) {
  const r = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Apify ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
const sync = (actor, input) =>
  apify(`/acts/${actor}/run-sync-get-dataset-items?timeout=300`, input);
const isId = (s) => /^\d{5,30}$/.test(String(s));
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

const app = express();
app.use(express.json());

app.use((req, res, next) =>
  !TOKEN && req.path.startsWith('/api')
    ? res.status(500).json({ error: 'APIFY_TOKEN is not set in .env' })
    : next());

// Home feed: cached on disk for 24h so restarts / reloads don't burn Apify quota.
const CACHE_FILE = path.resolve('.cache/home.json');
const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; } };
app.get('/api/home', wrap(async ({ query }) => {
  const n = Math.min(+query.limit || 200, 1000);
  const c = readCache();
  if (c && c.requested >= n && Date.now() - c.t < 864e5) return c.items.slice(0, n);
  const items = await sync(ACTORS.feed, { maxResults: n, includeRaw: true });
  const good = items.filter((i) => i.success !== false);
  if (good.length) {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ t: Date.now(), requested: n, items: good }));
    return good;
  }
  // Quota/error: fall back to stale cache if we have one.
  return c?.items?.length ? c.items.slice(0, n) : items;
}));

app.post('/api/search', wrap(async ({ body }) => {
  const q = String(body.query || '').trim();
  if (!q) throw new Error('Empty query');
  return sync(ACTORS.search, { queries: [q], maxPages: Math.min(+body.maxPages || 1, 5) });
}));

// Series details cached 7 days on disk (free plan allows only 100 series IDs/month).
app.get('/api/series/:id', wrap(async ({ params }) => {
  if (!isId(params.id)) throw new Error('Invalid series id');
  const f = path.resolve(`.cache/series-${params.id}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - c.t < 7 * 864e5) return c.items;
  } catch {}
  const items = await sync(ACTORS.detail, { seriesIds: [params.id] });
  if (items.some((i) => i.success !== false)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ t: Date.now(), items }));
  }
  return items;
}));

// Downloads can take minutes, so start an async run and let the client poll.
app.post('/api/download', wrap(async ({ body }) => {
  if (Array.isArray(body.videoIds)) {
    const ids = [...new Set(body.videoIds.map(String))].filter(isId).slice(0, 100);
    if (!ids.length) throw new Error('No valid episode ids');
    const { data } = await apify(`/acts/${ACTORS.dlVideo}/runs`, { videoIds: ids });
    return { runId: data.id };
  }
  if (!isId(body.seriesId)) throw new Error('Invalid series id');
  const { data } = await apify(`/acts/${ACTORS.download}/runs`, { seriesIds: [body.seriesId] });
  return { runId: data.id };
}));

app.get('/api/download/:runId', wrap(async ({ params }) => {
  const { data: run } = await apify(`/actor-runs/${encodeURIComponent(params.runId)}`);
  const done = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status);
  const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true`).catch(() => []);
  return { status: run.status, done, items };
}));

// Diagnostic: reports exactly what the image server returns for a cover URL.
app.get('/api/imgcheck', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname))
      return res.json({ error: 'blocked url' });
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || '';
    res.json({
      status: r.status, type, bytes: buf.length, host: u.hostname,
      ext: (u.pathname.match(/\.(\w+)$/) || [])[1] || null,
      preview: type.startsWith('image/') ? undefined : buf.subarray(0, 160).toString('utf8'),
    });
  } catch (e) { res.json({ error: e.cause?.code || e.message }); }
});

// Forces a real file download (with a filename) for signed Apify KVS links.
app.get('/api/file', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (u.protocol !== 'https:' || u.hostname !== 'api.apify.com') return res.sendStatus(400);
    const name = String(req.query.name || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
    const r = await fetch(u);
    if (!r.ok || !r.body) return res.sendStatus(502);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.mp4`,
    });
    const len = r.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    Readable.fromWeb(r.body).pipe(res);
  } catch { res.sendStatus(502); }
});

// Image proxy: fetches covers server-side (no Referer) and converts HEIC -> JPEG,
// because browsers cannot display HEIC.
const imgCache = new Map();
let active = 0; const waiters = [];
const acquire = () => (active < 3 ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => { const n = waiters.shift(); n ? n() : active--; };
const isHeic = (b) => b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' &&
  /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(b.toString('ascii', 8, 12));

app.get('/api/img', async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    const bad = u.protocol !== 'https:' || u.hostname === 'localhost' ||
      /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || !u.hostname.includes('.');
    if (bad) return res.sendStatus(400);
    const send = ({ type, body }) => {
      res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.send(body);
    };
    const hit = imgCache.get(u.href);
    if (hit) return send(hit);

    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    let type = r.headers.get('content-type') || '';
    let body = Buffer.from(await r.arrayBuffer());
    if (!r.ok) return res.status(404).send(`upstream ${r.status} ${type}`);
    if (isHeic(body) || /hei[cf]/i.test(type)) {
      await acquire();
      try { body = Buffer.from(await convert({ buffer: body, format: 'JPEG', quality: 0.8 })); type = 'image/jpeg'; }
      finally { release(); }
    } else if (!type.startsWith('image/')) {
      return res.status(404).send(`upstream not an image: ${type}`);
    }
    const out = { type, body };
    if (imgCache.size > 600) imgCache.delete(imgCache.keys().next().value);
    imgCache.set(u.href, out);
    send(out);
  } catch (e) { res.status(502).send(String(e.message || e)); }
});

app.use(express.static('dist'));
app.get('*', (_, res) => res.sendFile(path.resolve('dist/index.html')));

app.listen(process.env.PORT || 3001, () => console.log('API on :' + (process.env.PORT || 3001)));
