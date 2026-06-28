import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import { buildIndex, search, type SearchHit } from '../lib/search';

const DATA = appData as unknown as AppData;

export default function SearchPage() {
  const [q, setQ] = useState('');
  const ms = useMemo(() => buildIndex(DATA), []);
  const [hits, setHits] = useState<SearchHit[]>(() => search(ms, DATA, ''));

  useEffect(() => {
    const id = setTimeout(() => setHits(search(ms, DATA, q)), 80);
    return () => clearTimeout(id);
  }, [q, ms]);

  const total = DATA.sessions.length;
  const summarized = DATA.sessions.filter((s) => s.hasSummary).length;
  const noCaptions = DATA.sessions.filter((s) => !s.hasCaptions).length;

  return (
    <div className="search-page">
      <div className="search-box">
        <input
          autoFocus
          placeholder="例: Bedrock / agentic / セキュリティ / Iceberg ..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="search-stats">
          {total} セッション / {summarized} 要約済 / {noCaptions} 未公開 (403)
        </div>
      </div>

      <ul className="hits">
        {hits.map((h) => (
          <li key={h.slug} className={`hit ${!h.hasCaptions ? 'hit--no-captions' : ''}`}>
            <Link to={`/sessions/${h.slug}`} className="hit-link">
              <div className="hit-meta">
                <span className="hit-track">{h.track}</span>
                {h.start && <span className="hit-date">{formatDate(h.start)}</span>}
                {h.durationMin != null && <span className="hit-dur">{h.durationMin}分</span>}
                {!h.hasCaptions && (
                  h.status === 'captions-unavailable' ? (
                    <span className="hit-badge hit-badge--ng" title="字幕 (VTT) 非公開のため要約なし">字幕なし</span>
                  ) : (
                    <span className="hit-badge hit-badge--ng">未公開</span>
                  )
                )}
                {h.hasCaptions && !h.hasSummary && <span className="hit-badge hit-badge--wip">要約待ち</span>}
              </div>
              <div className="hit-title">{h.title}</div>
              {h.tldr && <div className="hit-tldr">{h.tldr}</div>}
            </Link>
          </li>
        ))}
        {hits.length === 0 && q && <li className="hit-empty">「{q}」にヒットするセッションはありません</li>}
      </ul>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso.slice(0, 10);
  }
}
