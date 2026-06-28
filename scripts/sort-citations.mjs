#!/usr/bin/env node
// data/summaries/*.json の citations を startSec 昇順にソート (時系列順違反の最終ガード)
// 使い方: node scripts/sort-citations.mjs [slug ...]   (省略時は data/summaries/*.json 全件)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SUM = join(ROOT, 'data/summaries');

const onlySlugs = process.argv.slice(2);
const files = readdirSync(SUM).filter((f) => f.endsWith('.json'));
const targets = onlySlugs.length ? files.filter((f) => onlySlugs.includes(f.replace(/\.json$/, ''))) : files;

let fixedCount = 0;
for (const f of targets) {
  const path = join(SUM, f);
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(obj.citations)) continue;
  const before = obj.citations.map((c) => c.startSec).join(',');
  obj.citations.sort((a, b) => a.startSec - b.startSec);
  const after = obj.citations.map((c) => c.startSec).join(',');
  if (before !== after) {
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fixedCount++;
    console.log(`  [fix] ${f.replace(/\.json$/, '')}`);
  }
}
console.log(`sorted: ${fixedCount} / checked: ${targets.length}`);
