import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import { screenshotsApi, type Screenshot } from '../lib/screenshots';

const DATA = appData as unknown as AppData;
const sessionsBySlug = new Map(DATA.sessions.map((s) => [s.slug, s]));

type SortBy = 'recent' | 'session';

export default function ScreenshotsPage() {
  const [list, setList] = useState<Screenshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('recent');

  useEffect(() => {
    void (async () => {
      try {
        setList(await screenshotsApi.list());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => {
      const sess = sessionsBySlug.get(s.slug);
      return (
        s.slug.toLowerCase().includes(q) ||
        (s.note ?? '').toLowerCase().includes(q) ||
        (sess?.title ?? '').toLowerCase().includes(q)
      );
    });
  }, [list, query]);

  const groups = useMemo(() => {
    if (sortBy === 'session') {
      const m = new Map<string, Screenshot[]>();
      for (const s of filtered) {
        const k = s.slug;
        const arr = m.get(k) || [];
        arr.push(s);
        m.set(k, arr);
      }
      for (const arr of m.values()) arr.sort((a, b) => a.startSec - b.startSec);
      return [...m.entries()].sort((a, b) => {
        const sa = sessionsBySlug.get(a[0])?.title ?? a[0];
        const sb = sessionsBySlug.get(b[0])?.title ?? b[0];
        return sa.localeCompare(sb, 'ja');
      });
    }
    return [['', [...filtered].sort((a, b) => b.createdAt - a.createdAt)]] as Array<[string, Screenshot[]]>;
  }, [filtered, sortBy]);

  const remove = async (id: number) => {
    if (!confirm('このスクショを削除しますか?')) return;
    await screenshotsApi.delete(id);
    setList((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
  };

  const updateNote = async (id: number, note: string | null) => {
    const updated = await screenshotsApi.updateNote(id, note);
    setList((prev) => (prev ? prev.map((s) => (s.id === id ? updated : s)) : prev));
  };

  return (
    <div className="screenshots-page">
      <div className="screenshots-controls">
        <input
          className="screenshots-search"
          placeholder="スクショを検索 (セッション名 / slug / メモ)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="screenshots-control-row">
          <label className="screenshots-sort">
            並び:
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
              <option value="recent">最近撮影した順</option>
              <option value="session">セッション別</option>
            </select>
          </label>
          <span className="screenshots-stats">
            {list ? `${filtered.length} / ${list.length} 枚` : '読み込み中…'}
          </span>
        </div>
        {error && <div className="screenshots-error">{error}</div>}
      </div>

      {list && list.length === 0 && (
        <div className="screenshots-empty">
          まだスクショがありません。セッション詳細画面で動画を再生し、字幕バーの 📷 ボタンで取得できます。
        </div>
      )}

      <div className="screenshots-groups">
        {groups.map(([gKey, items]) => (
          <section key={gKey || '_all_'} className="screenshots-group">
            {sortBy === 'session' && gKey && (
              <h2 className="screenshots-group-h">
                <Link to={`/sessions/${gKey}`} className="screenshots-group-link">
                  {sessionsBySlug.get(gKey)?.title ?? gKey}
                </Link>
                <span className="screenshots-group-count">({items.length})</span>
              </h2>
            )}
            <ul className="screenshots-grid">
              {items.map((s) => (
                <ShotCard key={s.id} s={s} onRemove={remove} onUpdateNote={updateNote} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ShotCard({
  s,
  onRemove,
  onUpdateNote,
}: {
  s: Screenshot;
  onRemove: (id: number) => void;
  onUpdateNote: (id: number, note: string | null) => void;
}) {
  const sess = sessionsBySlug.get(s.slug);
  const mm = Math.floor(s.startSec / 60);
  const ss = s.startSec % 60;
  const time = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const [editingNote, setEditingNote] = useState(false);
  const [draft, setDraft] = useState(s.note ?? '');
  useEffect(() => setDraft(s.note ?? ''), [s.note]);

  return (
    <li className="shot-card">
      <Link
        to={`/sessions/${s.slug}?t=${s.startSec}`}
        className="shot-card-img-link"
        title={`${time} へ頭出し`}
      >
        <img src={screenshotsApi.imageUrl(s.id)} alt={`screenshot of ${s.slug} at ${time}`} />
        <span className="shot-card-time">{time}</span>
      </Link>
      <div className="shot-card-body">
        <div className="shot-card-title">{sess?.title ?? s.slug}</div>
        {s.title && <div className="shot-card-scene">🎬 {s.title}</div>}
        <div className="shot-card-meta">
          {sess?.track ?? s.slug}
          {s.width && s.height ? ` ・ ${s.width}×${s.height}` : ''}
        </div>
        {editingNote ? (
          <div className="shot-card-note-edit">
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="shot-card-note-actions">
              <button
                type="button"
                onClick={() => {
                  void onUpdateNote(s.id, draft.trim() || null);
                  setEditingNote(false);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="shot-card-note-cancel"
                onClick={() => {
                  setDraft(s.note ?? '');
                  setEditingNote(false);
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`shot-card-note-view ${!s.note ? 'shot-card-note-view--empty' : ''}`}
            onClick={() => setEditingNote(true)}
          >
            {s.note ? s.note : '＋ メモを追加'}
          </button>
        )}
        <div className="shot-card-foot">
          <span>{new Date(s.createdAt).toLocaleString('ja-JP')}</span>
          <a href={screenshotsApi.imageUrl(s.id)} download className="shot-card-dl">
            ⤓
          </a>
          <button type="button" className="shot-card-del" onClick={() => onRemove(s.id)}>
            ✕
          </button>
        </div>
      </div>
    </li>
  );
}
