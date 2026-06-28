#!/usr/bin/env node
// AWS Summit Japan 2026 — スライド資料 URL マッピング生成
//
// 公開ページから (セッションID, PDF URL) を抽出し、 catalog の slug にマッピングして
// data/slides_urls.json を生成する。
//
// 実行:
//   node scripts/fetch-slide-urls.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CATALOG_PATH = join(ROOT, 'data/catalog.json');
const OUT_PATH = join(ROOT, 'data/slides_urls.json');

const PAGE_URL =
  'https://pages.awscloud.com/AWS-Summit-Japan-2026-Session-Materials-Download.html';

async function main() {
  if (!existsSync(CATALOG_PATH)) {
    console.error(`catalog.json not found at ${CATALOG_PATH}`);
    process.exit(1);
  }
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  // jpn-xxxNNN → XXXNNN / jpn-xxxNNN-s → XXXNNN-S (英 prefix + 数字 + 任意の -s)
  const idToSlug = new Map();
  for (const c of catalog) {
    // 末尾は数字 + 任意の `-S` (sponsored 等) を許容
    const m = c.slug.match(/^jpn-([a-z]+)(\d+(?:-[a-z]+)?)$/i);
    if (!m) continue;
    const sessionId = `${m[1].toUpperCase()}${m[2].toUpperCase()}`;
    idToSlug.set(sessionId, c.slug);
  }

  console.log(`fetching ${PAGE_URL}`);
  const r = await fetch(PAGE_URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  // PDF URL を全部抜く。ファイル名は変形パターンが多い:
  //   R03_0625_AIM201_v4.pdf         (基本)
  //   R01-03_0626_ARC446_v1.pdf      (R##-##)
  //   R02_0626_ DAT338_v1.pdf        (半角スペース)
  //   R01_0626_SEC337_V2.pdf         (大文字 V)
  //   R13_0625_4_AIM118_v1.pdf       (日付の後に余分番号)
  const urlRe = /https?:\/\/[^"'>]*?\/R\d+(?:-\d+)?_\d{4}(?:_\d+)?_\s*([A-Z]+\d+(?:-[A-Z]+)?)_[vV]\d+\.pdf/g;
  const found = new Map(); // sessionId -> url
  for (const m of html.matchAll(urlRe)) {
    const sessionId = m[1];
    // URL 内の半角スペースは encodeURI で %20 に
    const url = encodeURI(m[0].trim());
    const prev = found.get(sessionId);
    if (!prev) {
      found.set(sessionId, url);
    } else {
      const vNew = Number(url.match(/_[vV](\d+)\.pdf$/)?.[1] || 0);
      const vOld = Number(prev.match(/_[vV](\d+)\.pdf$/)?.[1] || 0);
      if (vNew > vOld) found.set(sessionId, url);
    }
  }

  console.log(`found ${found.size} PDF URLs from page`);

  const mapping = {};
  let matched = 0;
  let unmatched = [];
  for (const [sessionId, url] of found) {
    const slug = idToSlug.get(sessionId);
    if (slug) {
      mapping[slug] = { sessionId, url };
      matched++;
    } else {
      unmatched.push(sessionId);
    }
  }

  // catalog にあるが PDF が無いセッションを抜き出す
  const catalogSlugs = new Set(catalog.map((c) => c.slug));
  const slugsWithSlides = new Set(Object.keys(mapping));
  const noSlides = [...catalogSlugs].filter((s) => !slugsWithSlides.has(s));

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceUrl: PAGE_URL,
    totalPdfsOnPage: found.size,
    catalogTotal: catalog.length,
    matched,
    unmatched, // PDF が見つかったが catalog に該当無し
    noSlides, // catalog にあるが PDF 提供無し
    slides: mapping,
  };
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`matched : ${matched}`);
  console.log(`unmatched (no catalog session): ${unmatched.length}`);
  if (unmatched.length) console.log('  ' + unmatched.join(', '));
  console.log(`no slides (catalog has no PDF) : ${noSlides.length}`);
  if (noSlides.length <= 20) console.log('  ' + noSlides.join(', '));
  console.log(`-> ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
