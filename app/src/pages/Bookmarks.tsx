import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import { bookmarksApi, type Bookmark } from '../lib/bookmarks';

const DATA = appData as unknown as AppData;
const sessionsBySlug = new Map(DATA.sessions.map((s) => [s.slug, s]));

type SortBy = 'recent' | 'session';

export default function BookmarksPage() {
  const [list, setList] = useState<Bookmark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('recent');

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setError(null);
    try {
      setList(await bookmarksApi.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const filtered = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => {
      const sess = sessionsBySlug.get(b.slug);
      return (
        b.label.toLowerCase().includes(q) ||
        (b.quote ?? '').toLowerCase().includes(q) ||
        (b.note ?? '').toLowerCase().includes(q) ||
        (sess?.title ?? '').toLowerCase().includes(q) ||
        b.slug.toLowerCase().includes(q)
      );
    });
  }, [list, query]);

  const groups = useMemo(() => {
    if (sortBy === 'session') {
      const m = new Map<string, Bookmark[]>();
      for (const b of filtered) {
        const k = b.slug;
        const arr = m.get(k) || [];
        arr.push(b);
        m.set(k, arr);
      }
      // session 内は startSec 昇順
      for (const arr of m.values()) arr.sort((a, b) => a.startSec - b.startSec);
      return [...m.entries()].sort((a, b) => {
        const sa = sessionsBySlug.get(a[0])?.title ?? a[0];
        const sb = sessionsBySlug.get(b[0])?.title ?? b[0];
        return sa.localeCompare(sb, 'ja');
      });
    }
    // recent: createdAt 降順、グループなし
    return [['', [...filtered].sort((a, b) => b.createdAt - a.createdAt)]] as Array<[
      string,
      Bookmark[],
    ]>;
  }, [filtered, sortBy]);

  const remove = async (id: number) => {
    if (!confirm('このブックマークを削除しますか？')) return;
    await bookmarksApi.remove(id);
    setList((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
  };

  const updateNote = async (id: number, note: string | null) => {
    const updated = await bookmarksApi.updateNote(id, note);
    setList((prev) => (prev ? prev.map((b) => (b.id === id ? updated : b)) : prev));
  };

  return (
    <div className="bookmarks-page">
      <div className="bookmarks-controls">
        <input
          className="bookmarks-search"
          placeholder="ブックマークを検索 (タイトル / ラベル / 引用 / メモ)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="bookmarks-control-row">
          <label className="bookmarks-sort">
            並び:
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
              <option value="recent">最近追加した順</option>
              <option value="session">セッション別</option>
            </select>
          </label>
          <span className="bookmarks-stats">
            {list ? `${filtered.length} / ${list.length} 件` : '読み込み中…'}
          </span>
        </div>
        {error && <div className="bookmarks-error">エラー: {error}</div>}
      </div>

      {list && list.length === 0 && (
        <div className="bookmarks-empty">
          まだブックマークがありません。<Link to="/">ブラウズ</Link>から気になるセッションを開いて、各引用の ☆ ボタンで保存できます。
        </div>
      )}

      <div className="bookmarks-groups">
        {groups.map(([groupKey, items]) => (
          <section key={groupKey || '_all_'} className="bookmarks-group">
            {sortBy === 'session' && groupKey && (
              <h2 className="bookmarks-group-h">
                <Link to={`/sessions/${groupKey}`} className="bookmarks-group-link">
                  {sessionsBySlug.get(groupKey)?.title ?? groupKey}
                </Link>
                <span className="bookmarks-group-count">({items.length})</span>
              </h2>
            )}
            <ul className="bookmarks-list">
              {items.map((b) => (
                <BookmarkCard key={b.id} b={b} onRemove={remove} onUpdateNote={updateNote} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function BookmarkCard({
  b,
  onRemove,
  onUpdateNote,
}: {
  b: Bookmark;
  onRemove: (id: number) => void;
  onUpdateNote: (id: number, note: string | null) => void;
}) {
  const sess = sessionsBySlug.get(b.slug);
  const mm = Math.floor(b.startSec / 60);
  const ss = b.startSec % 60;
  const time = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const [editingNote, setEditingNote] = useState(false);
  const [draft, setDraft] = useState(b.note ?? '');
  useEffect(() => setDraft(b.note ?? ''), [b.note]);

  return (
    <li className="bookmark-card">
      <div className="bookmark-card-head">
        <Link to={`/sessions/${b.slug}?t=${b.startSec}`} className="bookmark-time-link">
          <span className="bookmark-time">{time}</span>
          <span className="bookmark-label">{b.label}</span>
        </Link>
        <button type="button" className="bookmark-delete" onClick={() => onRemove(b.id)} title="削除">
          ✕
        </button>
      </div>
      {sess && (
        <div className="bookmark-session">
          <Link to={`/sessions/${b.slug}`} className="bookmark-session-link">
            {sess.title}
          </Link>
          <span className="bookmark-session-meta">
            {sess.track}
            {sess.durationMin != null && ` ・ ${sess.durationMin}分`}
          </span>
        </div>
      )}
      {b.quote && <p className="bookmark-quote">「{b.quote}」</p>}
      <div className="bookmark-note">
        {editingNote ? (
          <div className="bookmark-note-edit">
            <textarea
              rows={3}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              placeholder="メモを書く…"
            />
            <div className="bookmark-note-actions">
              <button
                type="button"
                onClick={() => {
                  void onUpdateNote(b.id, draft.trim() || null);
                  setEditingNote(false);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="bookmark-note-cancel"
                onClick={() => {
                  setDraft(b.note ?? '');
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
            className={`bookmark-note-view ${!b.note ? 'bookmark-note-view--empty' : ''}`}
            onClick={() => setEditingNote(true)}
            title="クリックして編集"
          >
            {b.note ? b.note : '＋ メモを追加'}
          </button>
        )}
      </div>
      <div className="bookmark-card-foot">
        追加 {new Date(b.createdAt).toLocaleString('ja-JP')}
      </div>
    </li>
  );
}
