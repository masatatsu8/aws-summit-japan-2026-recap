#!/usr/bin/env node
// data/summaries/*.json をスキーマと突き合わせて検証
// 使い方: node scripts/validate-summaries.mjs [slug ...]
//        引数なし -> data/summaries/ 配下全件
//        引数あり -> 指定 slug のみ
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SUM = join(ROOT, 'data/summaries');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema/summary.schema.json'), 'utf8'));

const onlySlugs = process.argv.slice(2);

const errors = [];
const warns = [];

function check(slug, obj, transcriptDurationSec) {
  const issues = [];
  const req = schema.required;
  for (const k of req) {
    if (obj[k] === undefined || obj[k] === null) issues.push(`missing field: ${k}`);
  }
  if (obj.slug !== slug) issues.push(`slug mismatch: ${obj.slug} vs ${slug}`);
  if (obj.captionLang && !['ja', 'en'].includes(obj.captionLang)) {
    issues.push(`bad captionLang: ${obj.captionLang}`);
  }
  if (!Array.isArray(obj.keyPoints) || obj.keyPoints.length < 3) {
    issues.push(`keyPoints too few: ${obj.keyPoints?.length}`);
  }
  if (!Array.isArray(obj.citations) || obj.citations.length < 5) {
    issues.push(`citations too few: ${obj.citations?.length}`);
  } else {
    let prevSec = -1;
    for (const c of obj.citations) {
      if (typeof c.startSec !== 'number' || !Number.isInteger(c.startSec)) {
        issues.push(`citation startSec not int: ${JSON.stringify(c).slice(0, 80)}`);
        continue;
      }
      if (c.startSec < prevSec) {
        issues.push(`citations not in chronological order at ${c.timestamp}`);
      }
      prevSec = c.startSec;
      if (c.timestamp) {
        const m = String(c.timestamp).match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
          const expected = Number(m[1]) * 60 + Number(m[2]);
          if (expected !== c.startSec) {
            issues.push(`timestamp/startSec mismatch: ${c.timestamp} vs ${c.startSec}`);
          }
        }
      }
      if (transcriptDurationSec && c.startSec > transcriptDurationSec + 5) {
        issues.push(`startSec ${c.startSec} exceeds duration ${transcriptDurationSec}`);
      }
    }
  }
  return issues;
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'data/catalog.json'), 'utf8'));
const bySlug = Object.fromEntries(catalog.map((c) => [c.slug, c]));

const files = readdirSync(SUM).filter((f) => f.endsWith('.json'));
const targets = onlySlugs.length ? files.filter((f) => onlySlugs.includes(f.replace(/\.json$/, ''))) : files;

let okCount = 0;
for (const f of targets) {
  const slug = f.replace(/\.json$/, '');
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(SUM, f), 'utf8'));
  } catch (e) {
    errors.push({ slug, issues: [`JSON parse error: ${e.message}`] });
    continue;
  }
  const dur = bySlug[slug]?.captions?.ja?.durationSec ?? null;
  const issues = check(slug, obj, dur);
  if (issues.length) {
    errors.push({ slug, issues });
  } else {
    okCount++;
    console.log(`  [ok] ${slug}  (citations=${obj.citations.length}, keyPoints=${obj.keyPoints.length}, tldr=${obj.tldr.length}chars)`);
  }
}

console.log(`\nvalidated: ${targets.length}, ok: ${okCount}, errors: ${errors.length}`);
if (errors.length) {
  console.log('\n--- errors ---');
  for (const e of errors) {
    console.log(`  [ng] ${e.slug}`);
    for (const i of e.issues) console.log(`        - ${i}`);
  }
  process.exit(1);
}
