#!/usr/bin/env node
// ../data/catalog.json + ../data/summaries/*.json を読み、アプリが import する 1ファイル
// src/data/app-data.json を生成する。検索用フィールドも含む。
//
// 実行: npm run build:index  (app/ ディレクトリで)

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..');
const CATALOG_PATH = join(REPO_ROOT, 'data/catalog.json');
const SUMMARIES_DIR = join(REPO_ROOT, 'data/summaries');
const SLIDES_URLS_PATH = join(REPO_ROOT, 'data/slides_urls.json');
const SLIDES_TEXT_DIR = join(REPO_ROOT, 'data/slides_text');
const OUT_DIR = join(APP_ROOT, 'src/data');
const OUT_PATH = join(OUT_DIR, 'app-data.json');
const SLIDES_OUT_PATH = join(OUT_DIR, 'slides-text.json');

if (!existsSync(CATALOG_PATH)) {
  console.error(`catalog.json が見つかりません: ${CATALOG_PATH}\n  先に \`node scripts/download.mjs\` を実行してください。`);
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

const summaries = {};
if (existsSync(SUMMARIES_DIR)) {
  for (const f of readdirSync(SUMMARIES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace(/\.json$/, '');
    try {
      summaries[slug] = JSON.parse(readFileSync(join(SUMMARIES_DIR, f), 'utf8'));
    } catch (e) {
      console.warn(`skip broken summary: ${f}: ${e.message}`);
    }
  }
}

const slidesUrls = existsSync(SLIDES_URLS_PATH)
  ? JSON.parse(readFileSync(SLIDES_URLS_PATH, 'utf8'))?.slides ?? {}
  : {};

// 検索用のスニペット (先頭 4000 文字程度)。Browse 検索のヒット範囲を拡張するために大きめに保持。
const slidesSnippet = {};
// フル検索用 (sidecar 用)。フロントには配信しない。
const slidesFull = {};
const SNIPPET_CHARS = 4000;
if (existsSync(SLIDES_TEXT_DIR)) {
  for (const f of readdirSync(SLIDES_TEXT_DIR)) {
    if (!f.endsWith('.txt')) continue;
    const slug = f.replace(/\.txt$/, '');
    try {
      const full = readFileSync(join(SLIDES_TEXT_DIR, f), 'utf8');
      slidesFull[slug] = full;
      slidesSnippet[slug] = full.slice(0, SNIPPET_CHARS);
    } catch {
      /* noop */
    }
  }
}

const sessions = catalog.map((c) => {
  const sum = summaries[c.slug];
  const slideMeta = slidesUrls[c.slug];
  const hasLocalSlides = Boolean(slidesFull[c.slug]);
  return {
    slug: c.slug,
    title: c.title,
    track: c.track,
    filterTags: c.filterTags,
    start: c.start,
    durationMin: c.durationMin,
    hlsMaster: c.hlsMaster,
    officialUrl: c.officialUrl,
    status: c.status,
    statusNote: c.statusNote,
    hasSummary: Boolean(sum),
    hasCaptions: Boolean(c.captions && c.captions.ja),
    hasSlides: hasLocalSlides,
    // ローカル配信 URL を優先 (sidecar が data/slides/*.pdf を配信)
    slidesUrl: hasLocalSlides ? `/api/slides/${c.slug}.pdf` : null,
    // 公式の Marketo URL も控えとして保持
    slidesOfficialUrl: slideMeta?.url ?? null,
    tldr: sum?.tldr,
    keyPoints: sum?.keyPoints,
    slidesSnippet: slidesSnippet[c.slug],
  };
});

mkdirSync(OUT_DIR, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  sessions,
  summaries,
};
writeFileSync(OUT_PATH, JSON.stringify(payload), 'utf8');

// サイドカー用の slidesFull (フロントには配信しない)
writeFileSync(SLIDES_OUT_PATH, JSON.stringify(slidesFull), 'utf8');

const okSummary = sessions.filter((s) => s.hasSummary).length;
const okCaptions = sessions.filter((s) => s.hasCaptions).length;
const okSlides = sessions.filter((s) => s.hasSlides).length;
console.log(`build-index: ${sessions.length} sessions / ${okSummary} summaries / ${okCaptions} captions / ${okSlides} slides`);
console.log(`  -> ${OUT_PATH}`);
console.log(`  -> ${SLIDES_OUT_PATH}`);
