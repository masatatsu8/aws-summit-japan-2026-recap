// Lists / list_items API client + hooks

import { useCallback, useEffect, useState } from 'react';

export type ListMeta = {
  id: number;
  name: string;
  isSystem: boolean;
  systemKey: string | null;
  createdAt: number;
  itemCount?: number;
};

export type ListItem = {
  id: number;
  listId: number;
  slug: string;
  note: string | null;
  addedAt: number;
};

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const listsApi = {
  listAll: () => http<ListMeta[]>('GET', '/api/lists'),
  get: (id: number) => http<ListMeta & { items: ListItem[] }>('GET', `/api/lists/${id}`),
  create: (name: string) => http<ListMeta>('POST', '/api/lists', { name }),
  rename: (id: number, name: string) => http<ListMeta>('PATCH', `/api/lists/${id}`, { name }),
  delete: (id: number) => http<{ id: number; removed: number }>('DELETE', `/api/lists/${id}`),
  addItem: (listId: number, slug: string, note?: string | null) =>
    http<ListItem>('POST', `/api/lists/${listId}/items`, { slug, note: note ?? null }),
  removeItem: (listId: number, slug: string) =>
    http<{ removed: number }>('DELETE', `/api/lists/${listId}/items/${encodeURIComponent(slug)}`),
  updateItemNote: (listId: number, slug: string, note: string | null) =>
    http<{ note: string | null }>('PATCH', `/api/lists/${listId}/items/${encodeURIComponent(slug)}`, { note }),
  toggleWatchLater: (slug: string) =>
    http<{ inWatchLater: boolean }>('POST', `/api/quick/watch-later/${encodeURIComponent(slug)}`),
  getWatchLaterState: (slug: string) =>
    http<{ inWatchLater: boolean }>('GET', `/api/quick/watch-later/${encodeURIComponent(slug)}`),
  memberships: (slug: string) =>
    http<{ slug: string; listIds: number[] }>('GET', `/api/slug-memberships/${encodeURIComponent(slug)}`),
};

/** リスト一覧を取得 + 簡易キャッシュ。同じセッションで再利用するため軽量。 */
export function useAllLists() {
  const [lists, setLists] = useState<ListMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setLists(await listsApi.listAll());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { lists, error, refresh, setLists };
}

/** あるセッション(slug) が属するリスト ID 集合 + トグル操作 */
export function useSlugMemberships(slug: string | undefined) {
  const [listIds, setListIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const r = await listsApi.memberships(slug);
      setListIds(new Set(r.listIds));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isInList = useCallback((listId: number) => listIds.has(listId), [listIds]);

  const addToList = useCallback(
    async (listId: number) => {
      if (!slug) return;
      await listsApi.addItem(listId, slug, null);
      setListIds((prev) => new Set(prev).add(listId));
    },
    [slug],
  );

  const removeFromList = useCallback(
    async (listId: number) => {
      if (!slug) return;
      await listsApi.removeItem(listId, slug);
      setListIds((prev) => {
        const next = new Set(prev);
        next.delete(listId);
        return next;
      });
    },
    [slug],
  );

  const toggleList = useCallback(
    async (listId: number) => {
      if (listIds.has(listId)) return removeFromList(listId);
      return addToList(listId);
    },
    [listIds, addToList, removeFromList],
  );

  return { listIds, loading, refresh, isInList, addToList, removeFromList, toggleList };
}

/** "後で見る" の現在状態 + トグル (専用フック) */
export function useWatchLater(slug: string | undefined) {
  const [inWatchLater, setInWatchLater] = useState<boolean | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    void listsApi.getWatchLaterState(slug).then((r) => {
      if (!cancelled) setInWatchLater(r.inWatchLater);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const toggle = useCallback(async () => {
    if (!slug) return;
    const r = await listsApi.toggleWatchLater(slug);
    setInWatchLater(r.inWatchLater);
  }, [slug]);

  return { inWatchLater, toggle };
}

/** Browse 画面用: 全 watch_later の slug を一括取得して memo */
export function useWatchLaterSlugs() {
  const [slugs, setSlugs] = useState<Set<string>>(new Set());
  const [watchLaterId, setWatchLaterId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const lists = await listsApi.listAll();
    const wl = lists.find((l) => l.systemKey === 'watch_later');
    if (!wl) return;
    setWatchLaterId(wl.id);
    const detail = await listsApi.get(wl.id);
    setSlugs(new Set(detail.items.map((it) => it.slug)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (slug: string) => {
      const r = await listsApi.toggleWatchLater(slug);
      setSlugs((prev) => {
        const next = new Set(prev);
        if (r.inWatchLater) next.add(slug);
        else next.delete(slug);
        return next;
      });
    },
    [],
  );

  return { slugs, watchLaterId, toggle, refresh };
}

/** ヘルパー: createdAt UNIX ms をローカル日時に */
export function fmtDate(ms: number) {
  return new Date(ms).toLocaleString('ja-JP');
}

/** ヘルパー: lists からシステムリストを最初に並べる比較関数 */
export function compareListMeta(a: ListMeta, b: ListMeta) {
  if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
  return a.createdAt - b.createdAt;
}

