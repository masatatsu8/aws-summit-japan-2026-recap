// filterTags 文字列のパースとハッシュタグ化
// 入力例: "トピック:Architecture,トピック:Artificial Intelligence,レベル:300 - Advanced,日付:6 月 25 日 (木),業界:Manufacturing & Industrial"

export type ParsedTags = {
  topic: string[]; // 例: ["Architecture", "Artificial Intelligence"]
  level: string[]; // 例: ["300 - Advanced"]
  date: string[]; // 例: ["6 月 25 日 (木)"]
  industry: string[]; // 例: ["Manufacturing & Industrial"]
  all: Array<{ kind: 'topic' | 'level' | 'date' | 'industry'; value: string; hash: string }>;
};

const KIND_MAP: Record<string, 'topic' | 'level' | 'date' | 'industry'> = {
  'トピック': 'topic',
  'レベル': 'level',
  '日付': 'date',
  '業界': 'industry',
};

export function parseFilterTags(raw: string | undefined | null): ParsedTags {
  const out: ParsedTags = { topic: [], level: [], date: [], industry: [], all: [] };
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    const kind = KIND_MAP[k];
    if (!kind) continue;
    out[kind].push(v);
    out.all.push({ kind, value: v, hash: hashify(v, kind) });
  }
  return out;
}

/** "Artificial Intelligence" → "AI", "300 - Advanced" → "Lv300" など短くする */
export function hashify(value: string, kind: 'topic' | 'level' | 'date' | 'industry'): string {
  if (kind === 'level') {
    const m = value.match(/^(\d+)/);
    if (m) return `Lv${m[1]}`;
    return value.replace(/\s+/g, '');
  }
  if (kind === 'date') {
    const m = value.match(/(\d+)\s*月\s*(\d+)\s*日/);
    if (m) return `${m[1]}/${m[2]}`;
    return value.replace(/\s+/g, '');
  }
  // topic / industry: スペース除去 + & 削除
  return value.replace(/\s*&\s*/g, '').replace(/\s+/g, '');
}

export type GroupKey = 'topic' | 'track' | 'date' | 'level' | 'industry';

export const GROUP_LABELS: Record<GroupKey, string> = {
  topic: 'トピック',
  track: 'トラック',
  date: '日付',
  level: 'レベル',
  industry: '業界',
};
