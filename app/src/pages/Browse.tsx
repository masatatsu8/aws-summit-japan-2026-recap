import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import { parseFilterTags, GROUP_LABELS, type GroupKey, type ParsedTags } from '../lib/tags';
import { useWatchLaterSlugs } from '../lib/lists';
import SlideModal from '../components/SlideModal';

const DATA = appData as unknown as AppData;

type EnrichedSession = AppData['sessions'][number] & {
  tags: ParsedTags;
  searchText: string;
};

const ENRICHED: EnrichedSession[] = DATA.sessions.map((s) => {
  const tags = parseFilterTags(s.filterTags);
  const searchText = [
    s.title,
    s.track,
    s.tldr ?? '',
    (s.keyPoints ?? []).join(' '),
    s.filterTags ?? '',
    s.slidesSnippet ?? '',
    ...tags.all.map((t) => t.hash + ' ' + t.value),
  ]
    .join(' ')
    .toLowerCase();
  return { ...s, tags, searchText };
});

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,，、。;；]+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);
}

export default function BrowsePage() {
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupKey>('topic');
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const { slugs: watchLaterSlugs, toggle: toggleWatchLater } = useWatchLaterSlugs();
  const [slideModal, setSlideModal] = useState<{ slug: string; title: string } | null>(null);

  const filtered = useMemo(() => {
    const tokens = tokenize(query);
    return ENRICHED.filter((s) => {
      for (const t of tokens) if (!s.searchText.includes(t)) return false;
      if (activeTags.size > 0) {
        const sessTags = new Set(s.tags.all.map((x) => `${x.kind}:${x.value}`));
        for (const need of activeTags) if (!sessTags.has(need)) return false;
      }
      return true;
    });
  }, [query, activeTags]);

  const groups = useMemo(() => groupSessions(filtered, groupBy), [filtered, groupBy]);

  const toggleTag = (kind: string, value: string) => {
    const key = `${kind}:${value}`;
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearTags = () => setActiveTags(new Set());

  return (
    <div className="browse-page">
      <div className="browse-controls">
        <input
          className="browse-search"
          placeholder="キーワード or #タグ (例: 'Bedrock セキュリティ' / '#AI #Financial')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="browse-control-row">
          <label className="browse-group-label">
            グループ:
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupKey)}>
              {(Object.keys(GROUP_LABELS) as GroupKey[]).map((k) => (
                <option key={k} value={k}>
                  {GROUP_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {activeTags.size > 0 && (
            <button className="browse-clear-tags" onClick={clearTags}>
              タグ絞り込み {activeTags.size} 件をクリア
            </button>
          )}
        </div>
        {activeTags.size > 0 && (
          <div className="browse-active-tags">
            {[...activeTags].map((k) => {
              const [kind, value] = k.split(':');
              return (
                <button key={k} className="tag-chip tag-chip--active" onClick={() => toggleTag(kind, value)}>
                  ✕ {value}
                </button>
              );
            })}
          </div>
        )}
        <div className="browse-stats">
          {filtered.length} / {DATA.sessions.length} セッション
        </div>
      </div>

      <div className="browse-groups">
        {groups.map(([groupName, items]) => (
          <section key={groupName} className="browse-group">
            <h2 className="browse-group-h">
              {groupName} <span className="browse-group-count">({items.length})</span>
            </h2>
            <ul className="browse-cards">
              {items.map((s) => (
                <SessionCard
                  key={s.slug}
                  s={s}
                  onTagClick={toggleTag}
                  activeTags={activeTags}
                  inWatchLater={watchLaterSlugs.has(s.slug)}
                  onToggleWatchLater={() => void toggleWatchLater(s.slug)}
                  onOpenSlides={() => setSlideModal({ slug: s.slug, title: s.title })}
                />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="browse-empty">該当なし</p>}
      </div>
      {slideModal && (
        <SlideModal
          slug={slideModal.slug}
          title={slideModal.title}
          onClose={() => setSlideModal(null)}
        />
      )}
    </div>
  );
}

function SessionCard({
  s,
  onTagClick,
  activeTags,
  inWatchLater,
  onToggleWatchLater,
  onOpenSlides,
}: {
  s: EnrichedSession;
  onTagClick: (kind: string, value: string) => void;
  activeTags: Set<string>;
  inWatchLater: boolean;
  onToggleWatchLater: () => void;
  onOpenSlides: () => void;
}) {
  return (
    <li className={`browse-card ${!s.hasCaptions ? 'browse-card--no-captions' : ''}`}>
      <button
        type="button"
        className={`browse-card-watchlater ${inWatchLater ? 'browse-card-watchlater--on' : ''}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleWatchLater();
        }}
        title={inWatchLater ? '「後で見る」から外す' : '「後で見る」に追加'}
      >
        {inWatchLater ? '★' : '☆'}
      </button>
      <Link to={`/sessions/${s.slug}`} className="browse-card-link">
        <div className="browse-card-meta">
          <span className="browse-card-track">{s.track}</span>
          {s.start && <span className="browse-card-date">{formatDate(s.start)}</span>}
          {s.durationMin != null && <span className="browse-card-dur">{s.durationMin}分</span>}
          {!s.hasCaptions && (
            s.status === 'captions-unavailable' ? (
              <span className="browse-card-badge browse-card-badge--ng" title="字幕 (VTT) 非公開のため要約なし。 視聴のみ可能">字幕なし</span>
            ) : (
              <span className="browse-card-badge browse-card-badge--ng">未公開</span>
            )
          )}
          {s.hasSlides && (
            <button
              type="button"
              className="browse-card-slides"
              title="スライド資料をモーダルで開く"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenSlides();
              }}
            >
              📄
            </button>
          )}
        </div>
        <div className="browse-card-title">{s.title}</div>
        {s.tldr && <div className="browse-card-tldr">{s.tldr}</div>}
      </Link>
      {s.tags.all.length > 0 && (
        <div className="browse-card-tags">
          {s.tags.all.map((t) => {
            const key = `${t.kind}:${t.value}`;
            const active = activeTags.has(key);
            return (
              <button
                key={key}
                className={`tag-chip ${active ? 'tag-chip--active' : ''} tag-chip--${t.kind}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick(t.kind, t.value);
                }}
                title={`${t.kind}: ${t.value} で絞り込み`}
              >
                #{t.hash}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

function groupSessions(sessions: EnrichedSession[], groupBy: GroupKey): Array<[string, EnrichedSession[]]> {
  const buckets = new Map<string, EnrichedSession[]>();
  for (const s of sessions) {
    const keys = keysFor(s, groupBy);
    for (const k of keys) {
      const list = buckets.get(k) || [];
      list.push(s);
      buckets.set(k, list);
    }
  }
  // sort groups: トピックや業界は名前順 / トラックは数値順
  return [...buckets.entries()].sort((a, b) => sortGroup(a[0], b[0], groupBy));
}

function keysFor(s: EnrichedSession, groupBy: GroupKey): string[] {
  if (groupBy === 'track') return [s.track || '(no track)'];
  if (groupBy === 'topic') return s.tags.topic.length ? s.tags.topic : ['(no topic)'];
  if (groupBy === 'date') return s.tags.date.length ? s.tags.date : ['(no date)'];
  if (groupBy === 'level') return s.tags.level.length ? s.tags.level : ['(no level)'];
  if (groupBy === 'industry') return s.tags.industry.length ? s.tags.industry : ['(no industry)'];
  return ['(other)'];
}

function sortGroup(a: string, b: string, groupBy: GroupKey): number {
  if (groupBy === 'track') {
    const an = trackNum(a);
    const bn = trackNum(b);
    if (an !== bn) return an - bn;
  }
  if (groupBy === 'level') {
    const am = a.match(/^(\d+)/);
    const bm = b.match(/^(\d+)/);
    if (am && bm) return Number(am[1]) - Number(bm[1]);
  }
  return a.localeCompare(b, 'ja');
}

function trackNum(name: string): number {
  if (/Keynote/.test(name)) return 0;
  const m = name.match(/Track\s*(\d+)/);
  return m ? Number(m[1]) : 999;
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso.slice(0, 10);
  }
}
