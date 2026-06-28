#!/usr/bin/env node
// AWS Summit Japan 2026 — 再現セットアップオーケストレータ
//
// データ取得 → スライド取得 → 要約生成 → app-data.json 構築 を、各ステップごとに
// "何をするか / 推定コスト / 所要時間" を表示し対話確認しながら順に実行する。
//
// 実行:
//   node scripts/setup.mjs                    # 対話モード
//   node scripts/setup.mjs --yes              # 全ステップ自動 yes (非対話)
//   node scripts/setup.mjs --non-interactive  # --yes と同じ
//   node scripts/setup.mjs --skip-slides      # スライド DL をスキップ
//   node scripts/setup.mjs --skip-summarize   # 要約生成をスキップ
//
// 注意:
//   - すべてのデータは公開エンドポイント (CloudFront + AWS Cloud のページ) から取得する。
//   - 利用者は AWS Summit Japan の利用規約を確認した上で自己責任で実行すること。
//   - 生成される要約は AI による派生物であり、個人利用を超える再配布は想定しない。

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const NON_INTERACTIVE = FLAGS.has('--yes') || FLAGS.has('--non-interactive');
const SKIP_SLIDES = FLAGS.has('--skip-slides');
const SKIP_SUMMARIZE = FLAGS.has('--skip-summarize');

function color(s, c) {
  if (!process.stdout.isTTY) return s;
  const codes = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 };
  return `\x1b[${codes[c] || 0}m${s}\x1b[0m`;
}

function banner(title) {
  console.log();
  console.log(color('━'.repeat(60), 'cyan'));
  console.log(color(title, 'bold'));
  console.log(color('━'.repeat(60), 'cyan'));
}

async function ask(question, def = 'n') {
  if (NON_INTERACTIVE) {
    console.log(`${question} [auto: yes]`);
    return 'y';
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (a) => {
      rl.close();
      const ans = (a || def).trim().toLowerCase();
      resolve(ans);
    });
  });
}

function runStep(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...(opts.env || {}) },
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function existsPath(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function step1Download() {
  banner('[1/4] セッションカタログ + 字幕 (VTT) ダウンロード');
  console.log(`  対象      : 全 135 セッション (一部基調講演は HLS 403 でスキップ)`);
  console.log(`  サイズ目安: VTT/transcripts 合計 ~22 MB`);
  console.log(`  ソース    : 公開 CloudFront エンドポイント (認証不要)`);
  console.log(`  所要      : 3-5 分 (ネットワーク次第)`);
  console.log(`  出力      : data/catalog.json, data/vtt/*, data/transcripts/*`);
  const a = await ask('実行しますか? [y/N/skip]', 'n');
  if (a === 's' || a === 'skip') { console.log(color('  -> skip', 'dim')); return; }
  if (a !== 'y' && a !== 'yes') { console.log(color('  -> 中断', 'yellow')); process.exit(0); }
  await runStep('node', ['scripts/download.mjs']);
}

async function step2Slides() {
  banner('[2/4] スライド PDF + テキスト抽出');
  if (SKIP_SLIDES) { console.log(color('  --skip-slides 指定によりスキップ', 'dim')); return; }
  console.log(`  対象      : ~110 PDF (公式提供分)`);
  console.log(`  サイズ目安: ~700 MB ※ディスク容量を確認してください`);
  console.log(`  ソース    : pages.awscloud.com の公式配布ページ`);
  console.log(`  所要      : 5-10 分`);
  console.log(`  出力      : data/slides/*.pdf, data/slides_text/*.txt, data/slides_urls.json`);
  const a = await ask('実行しますか? [y/N/skip]', 'n');
  if (a === 's' || a === 'skip') { console.log(color('  -> skip', 'dim')); return; }
  if (a !== 'y' && a !== 'yes') { console.log(color('  -> 中断', 'yellow')); process.exit(0); }
  await runStep('node', ['scripts/fetch-slide-urls.mjs']);
  await runStep('node', ['scripts/download-and-extract-slides.mjs']);
}

async function step3Summarize() {
  banner('[3/4] AI 要約生成 (Anthropic Messages API)');
  if (SKIP_SUMMARIZE) { console.log(color('  --skip-summarize 指定によりスキップ', 'dim')); return; }
  if (!(await existsPath(join(ROOT, 'data/transcripts')))) {
    console.log(color('  data/transcripts が無いためスキップ (step 1 を先に実行してください)', 'yellow'));
    return;
  }
  console.log(`  対象      : 文字起こしがある全セッション (デフォ ~133)`);
  console.log(`  モデル    : ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'}`);
  console.log(`  必要環境  : ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? color('(設定済み)', 'green') : color('(未設定!)', 'red')}`);
  console.log(`  並列度    : 4 (--concurrency で変更可)`);
  console.log(`  推定コスト: 別途 \`node scripts/summarize.mjs --dry-run\` で表示`);
  console.log(`  所要      : 10-30 分 (並列度とレート制限による)`);
  console.log(`  出力      : data/summaries/*.json (1 セッション 1 ファイル)`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(color('  ANTHROPIC_API_KEY が未設定のためスキップ', 'red'));
    console.log(color('  .env に設定して再実行するか、--skip-summarize で明示スキップしてください', 'dim'));
    return;
  }

  // dry-run で実コスト見積もりを表示
  console.log(color('  → 推定コストを計算中...', 'dim'));
  try {
    await runStep('node', ['scripts/summarize.mjs', '--dry-run']);
  } catch (e) {
    console.log(color(`  dry-run 失敗: ${e.message}`, 'red'));
  }

  const a = await ask('上記コストで実行しますか? [y/N/skip]', 'n');
  if (a === 's' || a === 'skip') { console.log(color('  -> skip', 'dim')); return; }
  if (a !== 'y' && a !== 'yes') { console.log(color('  -> 中断', 'yellow')); process.exit(0); }
  await runStep('node', ['scripts/summarize.mjs']);
}

async function step4BuildIndex() {
  banner('[4/4] アプリ用検索インデックス構築');
  console.log(`  内容      : data/summaries/* と data/catalog.json を app/src/data/app-data.json に集約`);
  console.log(`  所要      : 数秒`);
  console.log(`  出力      : app/src/data/app-data.json, app/src/data/slides-text.json`);
  const a = await ask('実行しますか? [Y/n/skip]', 'y');
  if (a === 's' || a === 'skip') { console.log(color('  -> skip', 'dim')); return; }
  if (a === 'n' || a === 'no') { console.log(color('  -> 中断', 'yellow')); process.exit(0); }
  await runStep('node', ['app/scripts/build-index.mjs']);
}

async function main() {
  banner('AWS Summit Japan 2026 — セットアップオーケストレータ');
  console.log('  このスクリプトは 4 ステップを順に対話実行します。');
  console.log('  各ステップは個別に \`node scripts/...\` で手動実行も可能です。');
  console.log('  非対話モード: --yes / 個別スキップ: --skip-slides --skip-summarize');
  console.log();

  await step1Download();
  await step2Slides();
  await step3Summarize();
  await step4BuildIndex();

  banner('完了');
  console.log(color('  すべてのステップが終わりました。', 'green'));
  console.log('  アプリ起動: ' + color('cd app && npm install && npm run dev', 'cyan'));
}

main().catch((e) => {
  console.error(color(`\nセットアップ失敗: ${e.message}`, 'red'));
  process.exit(1);
});
