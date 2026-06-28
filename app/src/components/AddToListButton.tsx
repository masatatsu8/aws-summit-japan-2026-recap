import { useEffect, useRef, useState } from 'react';
import { compareListMeta, listsApi, useAllLists, useSlugMemberships } from '../lib/lists';

type Props = {
  slug: string;
  /** "後で見る" の状態が変わったら親に通知 (Browse カードのトグル等で利用) */
  onWatchLaterChange?: (inWatchLater: boolean) => void;
};

/**
 * セッションに対する「リストに追加 ▾」ドロップダウン。
 * - 各リストをチェックボックス的にトグル
 * - 「後で見る」はシステムリストとして最上段
 * - 「+ 新しいリスト」で名前入力 → 新規作成 + 追加
 */
export default function AddToListButton({ slug, onWatchLaterChange }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const { lists, refresh: refreshLists } = useAllLists();
  const { listIds, toggleList, refresh: refreshMembership } = useSlugMemberships(slug);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const watchLater = lists?.find((l) => l.systemKey === 'watch_later');
  const inWatchLater = watchLater ? listIds.has(watchLater.id) : false;
  const totalActive = listIds.size;

  const handleToggle = async (listId: number, isWatchLater: boolean) => {
    await toggleList(listId);
    refreshLists();
    if (isWatchLater) onWatchLaterChange?.(!listIds.has(listId));
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const list = await listsApi.create(name);
    await listsApi.addItem(list.id, slug, null);
    setNewName('');
    setCreating(false);
    refreshLists();
    refreshMembership();
  };

  return (
    <div className="addtolist" ref={popoverRef}>
      <button
        type="button"
        className={`addtolist-trigger ${totalActive > 0 ? 'addtolist-trigger--has' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {inWatchLater ? '★ 後で見る' : '☆ 後で見る'}
        <span className="addtolist-divider">|</span>
        リスト{totalActive > 0 ? ` (${totalActive})` : ''} ▾
      </button>
      {open && (
        <div className="addtolist-popover">
          <ul className="addtolist-list">
            {lists?.slice().sort(compareListMeta).map((l) => {
              const checked = listIds.has(l.id);
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    className={`addtolist-item ${checked ? 'addtolist-item--checked' : ''}`}
                    onClick={() => void handleToggle(l.id, l.systemKey === 'watch_later')}
                  >
                    <span className="addtolist-check">{checked ? '✓' : ' '}</span>
                    <span className="addtolist-name">
                      {l.isSystem && <span className="addtolist-sys">★</span>}
                      {l.name}
                    </span>
                    <span className="addtolist-count">{l.itemCount ?? ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="addtolist-create">
            {creating ? (
              <div className="addtolist-create-form">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate();
                    else if (e.key === 'Escape') {
                      setCreating(false);
                      setNewName('');
                    }
                  }}
                  placeholder="リスト名"
                />
                <button type="button" onClick={() => void handleCreate()}>
                  作成
                </button>
              </div>
            ) : (
              <button type="button" className="addtolist-create-btn" onClick={() => setCreating(true)}>
                + 新しいリスト
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
