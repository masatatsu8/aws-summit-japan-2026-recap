// Bookmarks API client + React hooks

import { useCallback, useEffect, useState } from 'react';

export type Bookmark = {
  id: number;
  slug: string;
  startSec: number;
  label: string;
  quote: string | null;
  note: string | null;
  createdAt: number;
};

export type NewBookmark = {
  slug: string;
  startSec: number;
  label: string;
  quote?: string | null;
  note?: string | null;
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

export const bookmarksApi = {
  list: () => http<Bookmark[]>('GET', '/api/bookmarks'),
  listBySlug: (slug: string) => http<Bookmark[]>('GET', `/api/bookmarks/by-slug/${encodeURIComponent(slug)}`),
  add: (b: NewBookmark) => http<Bookmark>('POST', '/api/bookmarks', b),
  remove: (id: number) => http<{ id: number; removed: number }>('DELETE', `/api/bookmarks/${id}`),
  updateNote: (id: number, note: string | null) =>
    http<Bookmark>('PATCH', `/api/bookmarks/${id}`, { note }),
};

/** セッション詳細画面で使う: 該当 slug の既存ブックマーク Map<startSec, Bookmark> */
export function useSessionBookmarks(slug: string | undefined) {
  const [byStartSec, setByStartSec] = useState<Map<number, Bookmark>>(new Map());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const list = await bookmarksApi.listBySlug(slug);
      setByStartSec(new Map(list.map((b) => [b.startSec, b])));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (cite: { startSec: number; label: string; quote?: string | null }) => {
      if (!slug) return;
      const existing = byStartSec.get(cite.startSec);
      if (existing) {
        await bookmarksApi.remove(existing.id);
        setByStartSec((prev) => {
          const next = new Map(prev);
          next.delete(cite.startSec);
          return next;
        });
      } else {
        const added = await bookmarksApi.add({
          slug,
          startSec: cite.startSec,
          label: cite.label,
          quote: cite.quote ?? null,
        });
        setByStartSec((prev) => {
          const next = new Map(prev);
          next.set(added.startSec, added);
          return next;
        });
      }
    },
    [slug, byStartSec],
  );

  return { byStartSec, loading, refresh, toggle };
}
