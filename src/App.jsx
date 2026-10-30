import { useState, useRef, useEffect, useMemo } from 'react';
import AdBanner from './AdBanner';

const PAGE = 200;   // home loads this many up front
const MAX = 1000;   // hard cap (server enforces too)

const api = async (url, body) => {
  const r = await fetch(url, body && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};

const dig = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const pick = (o, ...paths) => {
  for (const p of paths) { const v = dig(o, p); if (v != null && v !== '') return v; }
};

// ---- cover helpers -------------------------------------------------------
const IMG_KEY = /cover|thumb|poster|pic|image|img/i;
function toUrl(v) {
  if (typeof v === 'string')
    return /^(https?:)?\/\//.test(v) ? v.replace(/^\/\//, 'https://').replace(/^http:/, 'https:') : null;
  if (Array.isArray(v)) return toUrl(v[0]);
  if (v && typeof v === 'object') return toUrl(v.url_list ?? v.url ?? v.uri);
  return null;
}
function findCover(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(o)) if (IMG_KEY.test(k)) { const u = toUrl(v); if (u) return u; }
  for (const v of Object.values(o))
    if (v && typeof v === 'object') { const u = findCover(v, depth + 1); if (u) return u; }
  return null;
}

// Covers are HEIC; the server proxy converts them to JPEG.
const variants = (src) => {
  const proxied = `/api/img?u=${encodeURIComponent(src)}`;
  return /\.hei[cf]/i.test(src) ? [proxied] : [src, proxied];
};
function Cover({ src }) {
  const [stage, setStage] = useState(0);
  const [why, setWhy] = useState('');
  useEffect(() => setStage(0), [src]);
  const list = src ? variants(src) : [];
  const failed = !src || stage >= list.length;
  useEffect(() => {
    if (!src || !failed) return;
    api(`/api/imgcheck?u=${encodeURIComponent(src)}`)
      .then((d) => setWhy(d.error ? `error: ${d.error}` : `${d.status} ${d.type || ''} .${d.ext}`))
      .catch(() => setWhy('diagnostic route missing: restart server'));
  }, [failed, src]);
  if (failed)
    return (
      <div className="ph" title={src || 'no cover URL in data'}>
        <span>{src ? 'Cover failed' : 'No cover'}<br /><small>{why}</small></span>
      </div>
    );
  return (
    <img src={list[stage]} referrerPolicy="no-referrer" alt="" loading="lazy"
      onError={() => setStage((s) => s + 1)} />
  );
}

// ---- data normalisation --------------------------------------------------
const GENRES = ['都市', '重生', '逆袭', '甜宠', '古装', '悬疑', '战神', '总裁', '穿越', '玄幻', '复仇', '家庭'];

function toTags(v) {
  if (!v) return [];
  if (typeof v === 'string') return v.split(/[,，、|\s]+/).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap((t) => (typeof t === 'string' ? toTags(t) : toTags(t?.name ?? t?.tag ?? t?.title ?? t?.text)));
  return [];
}
const TAG_KEYS = ['recommendReasons', 'tags', 'categories', 'category', 'genre', 'raw.tags', 'raw.series_tags', 'raw.category', 'raw.categories'];

function normalize(item) {
  const d = item.data || item;
  const v = d.video_data?.[0] || d;
  return {
    id: String(pick(v, 'series_id', 'seriesId', 'book_id', 'id') ?? pick(d, 'series_id', 'seriesId') ?? ''),
    title: pick(v, 'series_name', 'title', 'series.title', 'name', 'book_name') || 'Untitled',
    cover: findCover(v) || findCover(d),
    episodes: pick(v, 'episode_cnt', 'episodeCount', 'series.episodeCount', 'series_count'),
    desc: pick(v, 'series_intro', 'intro', 'synopsis', 'series.synopsis', 'introduction', 'desc'),
    tags: [...new Set(TAG_KEYS.flatMap((k) => toTags(dig(v, k))))].slice(0, 8),
  };
}

// ---- main app ------------------------------------------------------------
export default function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('home'); // 'home' | 'search'
  const [limit, setLimit] = useState(PAGE);
  const [cat, setCat] = useState('All');

  const toCards = (items) => {
    const seen = new Set();
    return items.filter((i) => i.success !== false).map(normalize)
      .filter((r) => r.id && !seen.has(r.id) && seen.add(r.id));
  };

  function explain(items, cards) {
    if (cards.length) return '';
    const d = items.find((i) => i.success === false) || items[0] || {};
    if (d.errorCode === 'FREE_TIER_MONTHLY_QUOTA_REACHED')
      return 'Your Apify free-plan monthly quota for this actor is used up (resets on the 1st, 00:00 UTC). Upgrade the plan or wait for the reset.';
    if (d.error) return `Apify actor error: ${d.error}`;
    return items.length
      ? `Got ${items.length} items but could not read series IDs. Open "Raw first result" below and send it to fix the field mapping.`
      : 'No results returned.';
  }

  async function loadHome(n = limit) {
    setLoading(true); setError(''); setMode('home'); setCat('All');
    try {
      const items = await api(`/api/home?limit=${n}`);
      setRaw(items[0] || null);
      const cards = toCards(items);
      setResults(cards);
      setError(explain(items, cards));
    } catch (err) { setError(err.message); }
    setLoading(false);
  }

  useEffect(() => { loadHome(PAGE); }, []);

  function loadMore() {
    const n = Math.min(limit + PAGE, MAX);
    setLimit(n); loadHome(n);
  }

  async function runSearch(q) {
    setMode('search'); setCat('All'); setLoading(true); setError(''); setSelected(null);
    try {
      const items = await api('/api/search', { query: q });
      setRaw(items.find((i) => i.success !== false) || items[0] || null);
      const cards = toCards(items);
      setResults(cards);
      setError(explain(items, cards));
    } catch (err) { setError(err.message); }
    setLoading(false);
  }

  function search(e) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return loadHome(limit);
    runSearch(q);
  }
  function pickGenre(g) { setQuery(g); runSearch(g); }

  const counts = useMemo(() => {
    const c = {};
    results.forEach((r) => r.tags.forEach((t) => { c[t] = (c[t] || 0) + 1; }));
    return c;
  }, [results]);
  const tagList = Object.keys(counts).sort((x, y) => counts[y] - counts[x]).slice(0, 24);
  const shown = cat === 'All' ? results : results.filter((r) => r.tags.includes(cat));

  return (
    <main>
      {/* Top Banner Placement */}
      <div className="ad-container" style={{ margin: '20px 0' }}>
        <AdBanner />
      </div>
      <h1>🍎 Hongguo Drama Video Downloader</h1>
      <form onSubmit={search} className="bar">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a title or keyword, e.g. 重生" />
        <button disabled={loading}>{loading ? 'Loading…' : 'Search'}</button>
      </form>

      <div className="chips">
        <small>Genres (search):</small>
        {GENRES.map((g) => <button key={g} className="chip" onClick={() => pickGenre(g)}>{g}</button>)}
      </div>

      {error && <p className="err">{error}</p>}

      <h2 className="sec">{mode === 'home' ? `All dramas (${results.length})` : `Results for “${query}” (${results.length})`}</h2>
      {mode === 'search' && <button className="link" onClick={() => loadHome(limit)}>← Back to home</button>}

      {tagList.length > 0 && (
        <div className="chips">
          {['All', ...tagList].map((t) => (
            <button key={t} className={'chip' + (cat === t ? ' on' : '')} onClick={() => setCat(t)}>
              {t}{t !== 'All' && ` ${counts[t]}`}
            </button>
          ))}
        </div>
      )}

      <div className="grid">
        {shown.map((r) => (
          <article key={r.id} className="card" onClick={() => setSelected(r)}>
            <div className="thumb"><Cover src={r.cover} /></div>
            <h3>{r.title}</h3>
            <small>{r.episodes ? `${r.episodes} episodes` : `ID ${r.id}`}</small>
          </article>
        ))}
      </div>

      {mode === 'home' && results.length > 0 && limit < MAX && (
        <div className="more"><button onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : `Load more (+${PAGE})`}</button></div>
      )}
      {loading && !results.length && <p className="muted">Loading…</p>}

      {raw && (
        <details className="raw">
          <summary>Raw first result (for debugging field mapping)</summary>
          <pre>{JSON.stringify(raw, null, 2)}</pre>
        </details>
      )}

      {selected && <Detail series={selected} onClose={() => setSelected(null)} />}

      <footer>Only download content you own or are authorized to download. Respect Hongguo’s terms and copyright law.</footer>
    </main>
  );
}

// ---- detail view: cover, episodes, play, download ------------------------
const DONE = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];

function Detail({ series, onClose }) {
  const [info, setInfo] = useState(null);
  const [ready, setReady] = useState({});     // videoId -> download item (has videoUrl)
  const [pending, setPending] = useState({}); // videoId -> true while Apify works
  const [failed, setFailed] = useState({});   // videoId -> error text
  const [sel, setSel] = useState(() => new Set());
  const [playing, setPlaying] = useState(null); // { ep, item }
  const [error, setError] = useState('');
  const timers = useRef([]);

  useEffect(() => {
    api(`/api/series/${series.id}`)
      .then((r) => {
        const row = r.find((x) => x.success !== false) || r[0];
        if (!row || row.success === false)
          setError(row?.errorCode === 'FREE_TIER_MONTHLY_QUOTA_REACHED'
            ? 'Apify free-plan monthly quota for series details is used up (resets on the 1st, 00:00 UTC).'
            : row?.error || 'Could not load series details.');
        else setInfo(row);
      })
      .catch((e) => setError(e.message));
    return () => timers.current.forEach(clearInterval);
  }, [series.id]);

  const s = info?.series || {};
  const title = s.title || series.title;
  const cover = (info?.series && findCover(info.series)) || series.cover;
  const eps = useMemo(() => {
    const e = info?.episodes || [];
    if (e.length) return e;
    return s.firstVideoId ? [{ videoId: s.firstVideoId, episodeIndex: '1' }] : [];
  }, [info]);
  const label = (ep, n) => `Ep ${ep.episodeIndex ?? n + 1}`;

  function clearPending(ids) {
    setPending((p) => { const n = { ...p }; ids.forEach((i) => delete n[i]); return n; });
  }

  async function prepare(list) {
    const ids = list.map(String).filter((id) => !ready[id] && !pending[id]);
    if (!ids.length) return;
    setError('');
    setFailed((f) => { const n = { ...f }; ids.forEach((i) => delete n[i]); return n; });
    setPending((p) => ({ ...p, ...Object.fromEntries(ids.map((i) => [i, true])) }));
    try {
      const { runId } = await api('/api/download', { videoIds: ids });
      const t = setInterval(async () => {
        try {
          const st = await api(`/api/download/${runId}`);
          const ok = {}, bad = {};
          st.items.forEach((i) => {
            if (i.success && i.videoUrl) ok[String(i.videoId)] = i;
            else if (i.videoId) bad[String(i.videoId)] = i.error || 'failed';
          });
          setReady((r) => ({ ...r, ...ok }));
          if (st.done || DONE.includes(st.status)) {
            clearInterval(t);
            setFailed((f) => ({ ...f, ...bad }));
            clearPending(ids);
            const quota = st.items.find((i) => i.errorCode);
            if (quota) setError(quota.error || `Apify: ${quota.errorCode}`);
            else if (!Object.keys(ok).length && !Object.keys(bad).length) setError(`Run ${st.status} with no videos.`);
          }
        } catch (e) { clearInterval(t); setError(e.message); clearPending(ids); }
      }, 3000);
      timers.current.push(t);
    } catch (e) { setError(e.message); clearPending(ids); }
  }

  function prepareMany(ids) {
    const n = ids.filter((id) => !ready[id] && !pending[id]).length;
    if (!n) return;
    if (n > 5 && !window.confirm(`Prepare ${n} episodes? Apify charges about $${(n * 0.0035).toFixed(2)} (free plan: max 100 videos/month).`)) return;
    prepare(ids);
  }

  const toggle = (id) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const fileUrl = (item, ep, n) =>
    `/api/file?u=${encodeURIComponent(item.videoUrl)}&name=${encodeURIComponent(`${title} ${label(ep, n)}`)}`;
  const busy = Object.keys(pending).length;
  const nextReady = playing && eps.slice(eps.indexOf(playing.ep) + 1).find((e) => ready[String(e.videoId)]);
  const playNext = () => nextReady && setPlaying({ ep: nextReady, item: ready[String(nextReady.videoId)] });

  return (
    <div className="overlay" onClick={onClose}>
      <section className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose}>✕</button>

        {playing && (
          <div className="player">
            <video key={playing.item.videoUrl} src={playing.item.videoUrl} poster={findCover(playing.ep) || cover}
              controls autoPlay playsInline onEnded={playNext} />
            <p className="row">
              <strong>{title} · {label(playing.ep, eps.indexOf(playing.ep))}</strong>
              <a className="btn" href={fileUrl(playing.item, playing.ep, eps.indexOf(playing.ep))}>⬇ Download</a>
              {nextReady && <button className="mini" onClick={playNext}>Next ▶</button>}
              <button className="mini alt" onClick={() => setPlaying(null)}>Close player</button>
            </p>
            <small className="muted">{playing.item.definition} · {playing.item.codec}. If the picture is black (HEVC), download and open in VLC.</small>
          </div>
        )}

        <div className="head">
          <div className="thumb big"><Cover src={cover} /></div>
          <div>
            <h2>{title}</h2>
            <p className="muted">{s.synopsis || series.desc || ''}</p>
            <p className="muted">
              {info ? `${s.episodeCount || eps.length} episodes` : error ? '' : 'Loading details…'}
              {s.playCount ? ` · ${s.playCount} plays` : ''}
            </p>
          </div>
        </div>

        {eps.length > 0 && (
          <div className="actions">
            <button className="primary" onClick={() => prepareMany(eps.map((e) => String(e.videoId)))} disabled={busy > 0}>Prepare all ({eps.length})</button>
            <button className="alt" onClick={() => prepareMany([...sel])} disabled={!sel.size}>Prepare selected ({sel.size})</button>
            <button className="alt" onClick={() => setSel(new Set(eps.slice(0, 10).map((e) => String(e.videoId))))}>Select first 10</button>
            {busy > 0 && <small className="muted">Working on {busy}… (can take a minute)</small>}
          </div>
        )}
        {error && <p className="err">{error}</p>}

        <div className="epgrid">
          {eps.map((ep, n) => {
            const id = String(ep.videoId);
            const r = ready[id];
            return (
              <div key={id} className={'ep' + (sel.has(id) ? ' sel' : '')}>
                <div className="thumb" onClick={() => (r ? setPlaying({ ep, item: r }) : toggle(id))}>
                  <Cover src={findCover(ep) || cover} />
                </div>
                <span>{label(ep, n)}{ep.duration ? ` · ${Math.round(ep.duration)}s` : ''}</span>
                {r ? (
                  <div className="row">
                    <button className="mini" onClick={() => setPlaying({ ep, item: r })}>▶</button>
                    <a className="mini btn" href={fileUrl(r, ep, n)}>⬇</a>
                  </div>
                ) : pending[id] ? <small>Preparing…</small>
                  : failed[id] ? <small className="err" title={failed[id]}>Failed · <a href="#" onClick={(e) => { e.preventDefault(); prepare([id]); }}>retry</a></small>
                  : <button className="mini alt" onClick={() => prepare([id])}>Get video</button>}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
