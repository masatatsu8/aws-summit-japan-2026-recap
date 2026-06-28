export type Citation = {
  label: string;
  timestamp?: string;
  startSec: number;
  quote?: string;
};

export type Summary = {
  slug: string;
  title: string;
  track?: string;
  speaker?: string;
  durationSec?: number;
  captionLang?: 'ja' | 'en';
  hlsMaster?: string;
  officialUrl?: string;
  tldr: string;
  keyPoints: string[];
  citations: Citation[];
  asrNote?: string;
};

export type CatalogEntry = {
  slug: string;
  title: string;
  track: string;
  description: string;
  filterTags: string;
  start: string;
  end: string;
  durationMin: number | null;
  officialUrl: string;
  hlsMaster: string;
  captions: {
    ja?: { vttFile: string; transcriptFile: string; cueCount: number; durationSec: number };
    en?: { vttFile: string; transcriptFile: string; cueCount: number; durationSec: number };
  };
  status: string;
  statusNote?: string;
};

/** ビルド時に build-index.mjs が出力するアプリ用 1ファイルデータ */
export type AppData = {
  generatedAt: string;
  sessions: Array<{
    slug: string;
    title: string;
    track: string;
    filterTags: string;
    start: string;
    durationMin: number | null;
    hlsMaster: string;
    officialUrl: string;
    status: string;
    statusNote?: string;
    hasSummary: boolean;
    hasCaptions: boolean;
    hasSlides: boolean;
    slidesUrl: string | null;
    slidesOfficialUrl?: string | null;
    tldr?: string;
    keyPoints?: string[];
    slidesSnippet?: string;
  }>;
  /** slug -> 詳細要約 (Citation 含む) */
  summaries: Record<string, Summary>;
};
