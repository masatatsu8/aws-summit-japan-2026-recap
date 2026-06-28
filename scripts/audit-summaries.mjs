#!/usr/bin/env node
// data/summaries/*.json の整合性監査:
// 1. ファイル名の slug と内部 slug が一致するか
// 2. その slug は data/catalog.json に存在するか (download 完了後に有効)
// 3. 重複 (内部 slug が同じファイルが複数) を検出
// 4. summaries.size と catalog.size の差分・想定外余剰
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SUM = join(ROOT, 'data/summaries');
const CAT = join(ROOT, 'data/catalog.json');

const catalog = existsSync(CAT) ? JSON.parse(readFileSync(CAT, 'utf8')) : [];
const catSlugs = new Set(catalog.map((c) => c.slug));

const files = readdirSync(SUM).filter((f) => f.endsWith('.json'));
const byInternalSlug = new Map();
const mismatch = [];
const broken = [];
const orphan = [];

for (const f of files) {
  const fileSlug = f.replace(/\.json$/, '');
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(SUM, f), 'utf8'));
  } catch (e) {
    broken.push({ fileSlug, error: e.message });
    continue;
  }
  if (obj.slug !== fileSlug) mismatch.push({ fileSlug, internalSlug: obj.slug });
  if (catalog.length > 0 && !catSlugs.has(fileSlug)) orphan.push({ fileSlug, internalSlug: obj.slug });
  const list = byInternalSlug.get(obj.slug) || [];
  list.push(fileSlug);
  byInternalSlug.set(obj.slug, list);
}

const dupes = [...byInternalSlug.entries()].filter(([, fs]) => fs.length > 1);

console.log(`files: ${files.length}, catalog: ${catalog.length}`);
console.log(`\n[mismatch] file name vs internal slug (${mismatch.length}):`);
for (const m of mismatch) console.log(`  ${m.fileSlug}.json  ->  internal slug=${m.internalSlug}`);
console.log(`\n[broken JSON] (${broken.length}):`);
for (const b of broken) console.log(`  ${b.fileSlug}.json  ${b.error}`);
console.log(`\n[orphan: slug not in catalog] (${orphan.length}):`);
for (const o of orphan) console.log(`  ${o.fileSlug}.json (internal=${o.internalSlug})`);
console.log(`\n[duplicate internal slug] (${dupes.length}):`);
for (const [s, fs] of dupes) console.log(`  ${s} appears in: ${fs.join(', ')}`);

if (catalog.length > 0) {
  const summarized = new Set();
  for (const f of files) summarized.add(f.replace(/\.json$/, ''));
  const missing = [...catSlugs].filter((s) => !summarized.has(s));
  const noCaptions = catalog.filter((c) => !(c.captions && c.captions.ja)).map((c) => c.slug);
  const missingWithCaptions = missing.filter((s) => !noCaptions.includes(s));
  console.log(`\n[missing summaries (had captions)] (${missingWithCaptions.length}):`);
  for (const s of missingWithCaptions) console.log(`  ${s}`);
}
