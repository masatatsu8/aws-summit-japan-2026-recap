#!/usr/bin/env node
// 要約 Workflow 完了後の最終ガード一括処理:
//   1) sort-citations (citations を startSec 昇順にソート)
//   2) validate-summaries (スキーマ準拠検証)
//   3) build-index (app/src/data/app-data.json 再生成)
import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`step failed: ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

run('node', ['scripts/sort-citations.mjs']);
run('node', ['scripts/validate-summaries.mjs']);
run('node', ['app/scripts/build-index.mjs']);
console.log('\nfinalize: ok');
