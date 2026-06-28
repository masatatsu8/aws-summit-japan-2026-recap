#!/usr/bin/env node
// CI 用: scripts/summarize-prompt.mjs に埋め込まれている架空サンプルが
// schema/summary.schema.json の必須フィールドを満たし、citations が startSec 昇順で
// あることを検証する (公開リポジトリの最小ガード)。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FICTIONAL_SAMPLE } from './summarize-prompt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema/summary.schema.json'), 'utf8'));

const errors = [];

function check(cond, msg) {
  if (!cond) errors.push(msg);
}

// (1) 必須フィールド
for (const k of schema.required) {
  check(FICTIONAL_SAMPLE[k] !== undefined && FICTIONAL_SAMPLE[k] !== null, `missing required field: ${k}`);
}

// (2) captionLang
check(['ja', 'en'].includes(FICTIONAL_SAMPLE.captionLang), `invalid captionLang: ${FICTIONAL_SAMPLE.captionLang}`);

// (3) keyPoints
check(Array.isArray(FICTIONAL_SAMPLE.keyPoints), 'keyPoints must be array');
check(FICTIONAL_SAMPLE.keyPoints.length >= 5 && FICTIONAL_SAMPLE.keyPoints.length <= 8, `keyPoints out of range: ${FICTIONAL_SAMPLE.keyPoints.length}`);

// (4) citations: 各要素の必須フィールド + startSec 昇順
check(Array.isArray(FICTIONAL_SAMPLE.citations), 'citations must be array');
check(FICTIONAL_SAMPLE.citations.length >= 8 && FICTIONAL_SAMPLE.citations.length <= 20, `citations out of range: ${FICTIONAL_SAMPLE.citations.length}`);
for (let i = 0; i < FICTIONAL_SAMPLE.citations.length; i++) {
  const c = FICTIONAL_SAMPLE.citations[i];
  check(typeof c.label === 'string' && c.label.length > 0, `citation[${i}].label missing`);
  check(Number.isInteger(c.startSec) && c.startSec >= 0, `citation[${i}].startSec invalid: ${c.startSec}`);
  if (i > 0) {
    check(c.startSec > FICTIONAL_SAMPLE.citations[i - 1].startSec, `citation[${i}].startSec not strictly ascending (${c.startSec} <= ${FICTIONAL_SAMPLE.citations[i - 1].startSec})`);
  }
}

// (5) slug が架空サンプル形式であること (実 AWS Summit slug "jpn-*" であってはならない)
check(!FICTIONAL_SAMPLE.slug.startsWith('jpn-'), `slug must not look like a real AWS Summit slug: ${FICTIONAL_SAMPLE.slug}`);

if (errors.length > 0) {
  console.error('FICTIONAL_SAMPLE validation failed:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}

console.log(`FICTIONAL_SAMPLE OK: ${FICTIONAL_SAMPLE.citations.length} citations, ${FICTIONAL_SAMPLE.keyPoints.length} keyPoints, slug=${FICTIONAL_SAMPLE.slug}`);
