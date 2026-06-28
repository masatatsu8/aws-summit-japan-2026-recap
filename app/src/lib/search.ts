import MiniSearch from 'minisearch';
import type { AppData, Summary } from '../types';

export type SearchHit = {
  slug: string;
  title: string;
  track: string;
  tldr?: string;
  start: string;
  durationMin: number | null;
  hasSummary: boolean;
  hasCaptions: boolean;
  status: string;
  score: number;
};

export function buildIndex(data: AppData) {
  const docs = data.sessions.map((s) => ({
    id: s.slug,
    title: s.title,
    track: s.track,
    tldr: s.tldr ?? '',
    keyPoints: (s.keyPoints ?? []).join(' \n '),
    citationLabels: (data.summaries[s.slug]?.citations ?? []).map((c) => c.label).join(' \n '),
    citationQuotes: (data.summaries[s.slug]?.citations ?? []).map((c) => c.quote ?? '').join(' \n '),
  }));

  const ms = new MiniSearch({
    fields: ['title', 'tldr', 'keyPoints', 'citationLabels', 'citationQuotes', 'track'],
    storeFields: ['title', 'track'],
    searchOptions: {
      boost: { title: 3, keyPoints: 2, tldr: 1.5, citationLabels: 1.2 },
      prefix: true,
      fuzzy: 0.15,
      combineWith: 'AND',
    },
    tokenize: (text) => {
      // 日本語向け簡易トークナイズ: 空白・句読点で分割 + 2-gram もエミュレート
      const base = text
        .toLowerCase()
        .split(/[\s、。・「」『』()（）\[\]【】,.!?！？:：;；/\\|]+/)
        .filter(Boolean);
      const ngrams: string[] = [];
      for (const w of base) {
        if (w.length >= 4 && /[぀-ヿ一-鿿]/.test(w)) {
          // 4文字以上の日本語語は 2-gram を足す
          for (let i = 0; i < w.length - 1; i++) ngrams.push(w.slice(i, i + 2));
        }
      }
      return [...base, ...ngrams];
    },
  });
  ms.addAll(docs);
  return ms;
}

export function search(ms: MiniSearch, data: AppData, query: string, limit = 50): SearchHit[] {
  const q = query.trim();
  if (!q) {
    // 空クエリ: 開催日順で全件返す (最初の表示)
    return data.sessions
      .slice()
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
      .slice(0, limit)
      .map((s) => ({
        slug: s.slug,
        title: s.title,
        track: s.track,
        tldr: s.tldr,
        start: s.start,
        durationMin: s.durationMin,
        hasSummary: s.hasSummary,
        hasCaptions: s.hasCaptions,
        status: s.status,
        score: 0,
      }));
  }
  const results = ms.search(q).slice(0, limit);
  const bySlug = new Map(data.sessions.map((s) => [s.slug, s]));
  return results
    .map((r) => {
      const s = bySlug.get(String(r.id));
      if (!s) return null;
      return {
        slug: s.slug,
        title: s.title,
        track: s.track,
        tldr: s.tldr,
        start: s.start,
        durationMin: s.durationMin,
        hasSummary: s.hasSummary,
        hasCaptions: s.hasCaptions,
        status: s.status,
        score: r.score,
      } as SearchHit;
    })
    .filter((x): x is SearchHit => x !== null);
}

export function getSummary(data: AppData, slug: string): Summary | undefined {
  return data.summaries[slug];
}

export function getSession(data: AppData, slug: string) {
  return data.sessions.find((s) => s.slug === slug);
}
