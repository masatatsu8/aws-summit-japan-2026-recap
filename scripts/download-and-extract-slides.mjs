#!/usr/bin/env node
// AWS Summit Japan 2026 — スライド PDF のダウンロード + テキスト抽出
//
// 前提: scripts/fetch-slide-urls.mjs で data/slides_urls.json を生成済み
//
// 生成物:
//   data/slides/{slug}.pdf
//   data/slides_text/{slug}.txt   (pdf-parse でテキスト抽出)
//
// 実行: node scripts/download-and-extract-slides.mjs
//       node scripts/download-and-extract-slides.mjs jpn-xxxNNN   (指定 slug のみ)

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SLIDES_DIR = join(ROOT, 'data/slides');
const TEXT_DIR = join(ROOT, 'data/slides_text');
const URLS_PATH = join(ROOT, 'data/slides_urls.json');

mkdirSync(SLIDES_DIR, { recursive: true });
mkdirSync(TEXT_DIR, { recursive: true });

const CONCURRENCY = 4;
const onlySlugs = process.argv.slice(2);

async function pMap(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchPdf(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return { skipped: 'already-on-disk' };
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) throw new Error(`PDF too small (${buf.length} bytes)`);
  writeFileSync(dest, buf);
  return { downloaded: buf.length };
}

async function extractText(pdfPath, textPath) {
  if (existsSync(textPath) && statSync(textPath).size > 0) return { skipped: 'already-extracted' };
  const buf = readFileSync(pdfPath);
  const parser = new PDFParse({ data: buf });
  const data = await parser.getText();
  // ページごとに改ページ印を入れて結合
  const text = (data.pages || [])
    .map((p) => `[p${p.num}]\n${p.text || ''}`)
    .join('\n\n');
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  writeFileSync(textPath, clean, 'utf8');
  return { chars: clean.length, pages: data.total };
}

async function main() {
  if (!existsSync(URLS_PATH)) {
    console.error(`slides_urls.json not found. run scripts/fetch-slide-urls.mjs first.`);
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(URLS_PATH, 'utf8'));
  let entries = Object.entries(meta.slides);
  if (onlySlugs.length) entries = entries.filter(([slug]) => onlySlugs.includes(slug));

  console.log(`processing ${entries.length} slides...`);

  let dl = 0;
  let dlSkip = 0;
  let ex = 0;
  let exSkip = 0;
  const errors = [];

  await pMap(entries, async ([slug, { url }]) => {
    const pdfPath = join(SLIDES_DIR, `${slug}.pdf`);
    const txtPath = join(TEXT_DIR, `${slug}.txt`);
    try {
      const d = await fetchPdf(url, pdfPath);
      if (d.skipped) dlSkip++;
      else dl++;
      const e = await extractText(pdfPath, txtPath);
      if (e.skipped) exSkip++;
      else ex++;
      const tail = e.chars != null ? ` (${e.pages}p, ${e.chars}chars)` : '';
      console.log(`  [ok] ${slug}${tail}`);
    } catch (err) {
      errors.push({ slug, error: String(err?.message || err) });
      console.error(`  [err] ${slug}: ${err.message}`);
    }
  });

  console.log(`\ndownload: ${dl} new / ${dlSkip} cached`);
  console.log(`extract : ${ex} new / ${exSkip} cached`);
  console.log(`errors  : ${errors.length}`);
  if (errors.length) {
    for (const e of errors) console.log(`  - ${e.slug}: ${e.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
