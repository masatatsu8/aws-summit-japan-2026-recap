import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import {
  compareListMeta,
  listsApi,
  type ListItem,
  type ListMeta,
} from '../lib/lists';

const DATA = appData as unknown as AppData;
const sessionsBySlug = new Map(DATA.sessions.map((s) => [s.slug, s]));

export default function ListsPage() {
  const [lists, setLists] = useState<ListMeta[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [items, setItems] = useState<ListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 初期化
  useEffect(() => {
    void (async () => {
      try {
        const ls = await listsApi.listAll();
        setLists(ls);
        if (ls.length > 0 && selectedId == null) setSelectedId(ls[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 選択リストの items 取得
  useEffect(() => {
    if (selectedId == null) {
      setItems([]);
      return;
    }
    void (async () => {
      try {
        const detail = await listsApi.get(selectedId);
        setItems(detail.items);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [selectedId]);

  const selected = useMemo(
    () => lists?.find((l) => l.id === selectedId) ?? null,
    [lists, selectedId],
  );

  const refreshLists = async () => {
    const ls = await listsApi.listAll();
    setLists(ls);
  };

  const createList = async (name: string) => {
    const list = await listsApi.create(name);
    await refreshLists();
    setSelectedId(list.id);
  };

  const renameList = async (id: number, name: string) => {
    await listsApi.rename(id, name);
    await refreshLists();
  };

  const deleteList = async (id: number) => {
    if (!confirm('このリストを削除しますか? 中身も一緒に削除されます。')) return;
    await listsApi.delete(id);
    const ls = await listsApi.listAll();
    setLists(ls);
    setSelectedId(ls[0]?.id ?? null);
  };

  const removeItem = async (slug: string) => {
    if (selectedId == null) return;
    await listsApi.removeItem(selectedId, slug);
    setItems((prev) => prev.filter((it) => it.slug !== slug));
    refreshLists();
  };

  const updateNote = async (slug: string, note: string | null) => {
    if (selectedId == null) return;
    await listsApi.updateItemNote(selectedId, slug, note);
    setItems((prev) => prev.map((it) => (it.slug === slug ? { ...it, note } : it)));
  };

  return (
    <div className="lists-page">
      <aside className="lists-sidebar">
        <ListSidebar
          lists={lists}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={createList}
          onRename={renameList}
          onDelete={deleteList}
        />
      </aside>
      <section className="lists-main">
        {error && <div className="lists-error">{error}</div>}
        {selected ? (
          <>
            <div className="lists-main-head">
              <h1>
                {selected.isSystem && <span className="lists-sys">★ </span>}
                {selected.name}
              </h1>
              <span className="lists-main-count">{items.length} 件</span>
            </div>
            {items.length === 0 ? (
              <div className="lists-empty">
                {selected.systemKey === 'watch_later' ? (
                  <>
                    まだ「後で見る」のセッションはありません。
                    <Link to="/">ブラウズ</Link>のカードの ☆ ボタンで追加できます。
                  </>
                ) : (
                  <>
                    リストにアイテムがありません。
                    <Link to="/">ブラウズ</Link>のカード/詳細画面の「リスト ▾」から追加できます。
                  </>
                )}
              </div>
            ) : (
              <ul className="lists-items">
                {items.map((it) => (
                  <ItemCard key={it.id} item={it} onRemove={removeItem} onUpdateNote={updateNote} />
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="lists-empty">リストを選択してください。</div>
        )}
      </section>
    </div>
  );
}

function ListSidebar({
  lists,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  lists: ListMeta[] | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  if (!lists) return <div className="lists-empty">読み込み中…</div>;
  const sorted = lists.slice().sort(compareListMeta);

  return (
    <div className="lists-sidebar-inner">
      <h2 className="lists-sidebar-h">リスト</h2>
      <ul className="lists-sidebar-list">
        {sorted.map((l) => {
          const isEditing = editingId === l.id;
          return (
            <li
              key={l.id}
              className={`lists-sidebar-item ${l.id === selectedId ? 'lists-sidebar-item--selected' : ''}`}
            >
              {isEditing ? (
                <div className="lists-sidebar-edit">
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRename(l.id, editingName.trim() || l.name);
                        setEditingId(null);
                      } else if (e.key === 'Escape') {
                        setEditingId(null);
                      }
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="lists-sidebar-name-btn"
                  onClick={() => onSelect(l.id)}
                  onDoubleClick={() => {
                    if (l.isSystem) return;
                    setEditingId(l.id);
                    setEditingName(l.name);
                  }}
                  title={l.isSystem ? 'システムリスト (改名不可)' : 'ダブルクリックで改名'}
                >
                  {l.isSystem && <span className="lists-sys">★ </span>}
                  <span className="lists-sidebar-name">{l.name}</span>
                  <span className="lists-sidebar-count">{l.itemCount ?? 0}</span>
                </button>
              )}
              {!l.isSystem && !isEditing && (
                <button
                  type="button"
                  className="lists-sidebar-delete"
                  onClick={() => onDelete(l.id)}
                  title="削除"
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="lists-sidebar-foot">
        {creating ? (
          <div className="lists-sidebar-create">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = draft.trim();
                  if (v) onCreate(v);
                  setDraft('');
                  setCreating(false);
                } else if (e.key === 'Escape') {
                  setCreating(false);
                  setDraft('');
                }
              }}
              placeholder="リスト名"
            />
            <button
              type="button"
              onClick={() => {
                const v = draft.trim();
                if (v) onCreate(v);
                setDraft('');
                setCreating(false);
              }}
            >
              作成
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="lists-sidebar-create-btn"
            onClick={() => setCreating(true)}
          >
            + 新しいリスト
          </button>
        )}
      </div>
    </div>
  );
}

function ItemCard({
  item,
  onRemove,
  onUpdateNote,
}: {
  item: ListItem;
  onRemove: (slug: string) => void;
  onUpdateNote: (slug: string, note: string | null) => void;
}) {
  const sess = sessionsBySlug.get(item.slug);
  const [editingNote, setEditingNote] = useState(false);
  const [draft, setDraft] = useState(item.note ?? '');
  useEffect(() => setDraft(item.note ?? ''), [item.note]);

  return (
    <li className="lists-item-card">
      <div className="lists-item-head">
        <Link to={`/sessions/${item.slug}`} className="lists-item-link">
          {sess?.title ?? item.slug}
        </Link>
        <button type="button" className="lists-item-remove" onClick={() => onRemove(item.slug)}>
          ✕
        </button>
      </div>
      {sess && (
        <div className="lists-item-meta">
          <span className="lists-item-track">{sess.track}</span>
          {sess.durationMin != null && <span>{sess.durationMin}分</span>}
          {!sess.hasCaptions && (
            sess.status === 'captions-unavailable' ? (
              <span className="lists-item-badge" title="字幕 (VTT) 非公開のため要約なし">字幕なし</span>
            ) : (
              <span className="lists-item-badge">未公開</span>
            )
          )}
          {sess.tldr && <div className="lists-item-tldr">{sess.tldr}</div>}
        </div>
      )}
      <div className="lists-item-note">
        {editingNote ? (
          <div className="lists-item-note-edit">
            <textarea
              rows={2}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="メモを書く…"
            />
            <div className="lists-item-note-actions">
              <button
                type="button"
                onClick={() => {
                  onUpdateNote(item.slug, draft.trim() || null);
                  setEditingNote(false);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="lists-item-note-cancel"
                onClick={() => {
                  setDraft(item.note ?? '');
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
            className={`lists-item-note-view ${!item.note ? 'lists-item-note-view--empty' : ''}`}
            onClick={() => setEditingNote(true)}
          >
            {item.note ? item.note : '＋ メモを追加'}
          </button>
        )}
      </div>
    </li>
  );
}
