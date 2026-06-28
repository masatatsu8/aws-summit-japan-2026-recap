#!/usr/bin/env node
// AWS Summit Japan 2026 — 文字起こし -> 参照情報付き要約 生成スクリプト (Anthropic API 直叩き)
//
// data/transcripts/{slug}.ja.txt ([mm:ss] 付き) を読み、Claude (Anthropic Messages API) で
// schema/summary.schema.json に沿った要約 JSON を生成し data/summaries/{slug}.json に保存する。
//
// 前提:
//   - 先に `node scripts/download.mjs` で文字起こしを生成しておく
//   - 環境変数 ANTHROPIC_API_KEY を設定する
//   - 依存: @anthropic-ai/sdk (`npm install` 済みであること)
//
// 機能:
//   - 並列 (デフォルト 4) でセッションを処理
//   - 指数バックオフ + ジッタによる自動リトライ (429 / 5xx)
//   - レジューム: 既存 data/summaries/{slug}.json はスキップ (`--force` で上書き)
//   - コスト集計: モデル単価から実測 (input/output token × USD) を表示
//   - 進捗表示: done/total/failed/cost をリアルタイム
//
// 実行:
//   node scripts/summarize.mjs                 # 文字起こしがある全セッション
//   node scripts/summarize.mjs jpn-xxxNNN      # 指定スラッグのみ
//   node scripts/summarize.mjs --concurrency 8 # 並列度変更
//   node scripts/summarize.mjs --force         # 既存ファイルを上書き
//   node scripts/summarize.mjs --dry-run       # 推定コストだけ表示して終了

import { readFile, writeFile, readdir, mkdir, access, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiPrompt } from './summarize-prompt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const SUMMARIES = join(ROOT, 'data/summaries');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_RETRIES = Number(process.env.SUMMARIZE_MAX_RETRIES || 4);

// 1M tokens あたりの単価 (USD)。 https://docs.claude.com/ja/docs/about-claude/pricing
const PRICING_PER_1M = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function args() {
  const a = process.argv.slice(2);
  const flags = new Set(a.filter((x) => x.startsWith('--')));
  const slugs = a.filter((x) => !x.startsWith('--') && !/^\d+$/.test(x));
  const concIdx = a.indexOf('--concurrency');
  const concurrency = concIdx >= 0 ? Number(a[concIdx + 1]) : Number(process.env.SUMMARIZE_CONCURRENCY || 4);
  return {
    slugs,
    force: flags.has('--force'),
    dryRun: flags.has('--dry-run'),
    concurrency: Math.max(1, Math.min(16, concurrency || 4)),
  };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function estimateCost(usage) {
  const p = PRICING_PER_1M[MODEL] || PRICING_PER_1M['claude-sonnet-4-6'];
  const inTok =
    (usage?.input_tokens || 0) +
    (usage?.cache_creation_input_tokens || 0) +
    (usage?.cache_read_input_tokens || 0);
  const outTok = usage?.output_tokens || 0;
  return (inTok * p.input + outTok * p.output) / 1_000_000;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) {
    throw new Error('JSON object not found in response');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callWithRetry(client, params, slug) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const transient = status === 429 || (status >= 500 && status < 600);
      if (!transient || attempt === MAX_RETRIES) throw e;
      // 指数バックオフ + ジッタ (1s, 2s, 4s, 8s + 0-500ms)
      const base = 1000 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 500);
      const wait = base + jitter;
      console.log(`[retry] ${slug} attempt=${attempt + 1}/${MAX_RETRIES} status=${status} wait=${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function summarizeOne(client, slug, meta, transcript) {
  const { systemPrompt, userPrompt } = buildApiPrompt({
    slug,
    title: meta.title || slug,
    track: meta.track,
    durationSec: meta.captions?.ja?.durationSec,
    hlsMaster: meta.hlsMaster,
    officialUrl: meta.officialUrl,
    transcript,
  });

  const res = await callWithRetry(
    client,
    {
      model: MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    },
    slug,
  );

  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const summary = extractJson(text);

  // モデルが取りこぼした可能性のあるメタを補完
  const full = {
    slug,
    title: summary.title || meta.title || slug,
    track: summary.track || meta.track,
    durationSec: summary.durationSec || meta.captions?.ja?.durationSec || null,
    captionLang: summary.captionLang || 'ja',
    hlsMaster: summary.hlsMaster || meta.hlsMaster,
    officialUrl: summary.officialUrl || meta.officialUrl,
    tldr: summary.tldr,
    keyPoints: summary.keyPoints,
    citations: summary.citations,
    asrNote: summary.asrNote || '',
  };

  // citations が startSec 昇順であることを検証 (モデルが間違えても自動ソートはせず、警告のみ)
  let outOfOrder = 0;
  for (let i = 1; i < full.citations.length; i++) {
    if (full.citations[i].startSec < full.citations[i - 1].startSec) outOfOrder++;
  }
  return { full, usage: res.usage, outOfOrder };
}

// ---- 並列ランナー (シンプルなワーカープール) ----
async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const results = [];
  const errors = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push(await worker(item));
      } catch (e) {
        errors.push({ item, error: e });
      }
    }
  });
  await Promise.all(workers);
  return { results, errors };
}

function estimateTranscriptTokens(text) {
  // 日本語 4 chars ≈ 1 token のラフ概算
  return Math.ceil(text.length / 4);
}

async function main() {
  const opts = args();
  await mkdir(SUMMARIES, { recursive: true });

  const catalogPath = join(DATA, 'catalog.json');
  if (!(await exists(catalogPath))) {
    console.error(`[fatal] catalog.json が見つかりません: ${catalogPath}`);
    console.error('        先に \`node scripts/download.mjs\` を実行してください。');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !opts.dryRun) {
    console.error('[fatal] ANTHROPIC_API_KEY が未設定です。 .env か環境変数で設定してください。');
    process.exit(1);
  }

  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const bySlug = Object.fromEntries(catalog.map((c) => [c.slug, c]));

  const transcriptDir = join(DATA, 'transcripts');
  const all = (await readdir(transcriptDir)).filter((f) => f.endsWith('.ja.txt'));

  // 対象の決定 (slug フィルタ + レジューム)
  const targets = [];
  let skipped = 0;
  for (const f of all) {
    const slug = f.replace(/\.ja\.txt$/, '');
    if (opts.slugs.length && !opts.slugs.includes(slug)) continue;
    const outPath = join(SUMMARIES, `${slug}.json`);
    if (!opts.force && (await exists(outPath))) {
      skipped++;
      continue;
    }
    targets.push({ slug, file: f });
  }

  if (targets.length === 0) {
    console.log(`対象 0 件 (既存スキップ ${skipped} 件)。--force で上書きできます。`);
    return;
  }

  // 推定コスト
  let totalInputChars = 0;
  for (const t of targets) {
    const s = await stat(join(transcriptDir, t.file));
    totalInputChars += s.size;
  }
  const p = PRICING_PER_1M[MODEL] || PRICING_PER_1M['claude-sonnet-4-6'];
  const approxInputTok = Math.ceil(totalInputChars / 4) + targets.length * 1000; // + system prompt
  const approxOutputTok = targets.length * 2500; // 平均出力サイズ概算
  const estCost = (approxInputTok * p.input + approxOutputTok * p.output) / 1_000_000;

  console.log('---');
  console.log(`要約対象     : ${targets.length} セッション (既存スキップ ${skipped})`);
  console.log(`モデル       : ${MODEL}`);
  console.log(`並列度       : ${opts.concurrency}`);
  console.log(`推定 input   : ~${approxInputTok.toLocaleString()} tokens`);
  console.log(`推定 output  : ~${approxOutputTok.toLocaleString()} tokens`);
  console.log(`推定コスト   : ~$${estCost.toFixed(2)} USD`);
  console.log('---');

  if (opts.dryRun) {
    console.log('--dry-run のため実行しません。');
    return;
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  let done = 0;
  let failed = 0;
  let totalCost = 0;
  const startedAt = Date.now();

  const { errors } = await runPool(targets, opts.concurrency, async ({ slug, file }) => {
    const meta = bySlug[slug] || { title: slug };
    const transcript = await readFile(join(transcriptDir, file), 'utf8');
    try {
      const { full, usage, outOfOrder } = await summarizeOne(client, slug, meta, transcript);
      await writeFile(join(SUMMARIES, `${slug}.json`), JSON.stringify(full, null, 2), 'utf8');
      const cost = estimateCost(usage);
      totalCost += cost;
      done++;
      const tag = outOfOrder > 0 ? ` (citations out-of-order: ${outOfOrder})` : '';
      console.log(
        `[ok] ${slug}  citations=${full.citations?.length || 0} keyPoints=${full.keyPoints?.length || 0} cost=$${cost.toFixed(3)}${tag}  [${done}/${targets.length} fail=${failed} total=$${totalCost.toFixed(2)}]`,
      );
    } catch (e) {
      failed++;
      console.error(`[err] ${slug}: ${e.message}  [${done}/${targets.length} fail=${failed}]`);
      throw e;
    }
  });

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log('---');
  console.log(`完了: ${done}/${targets.length} 成功 / ${failed} 失敗 / 所要 ${elapsedSec}s / 実コスト ~$${totalCost.toFixed(2)}`);
  if (errors.length) {
    console.log('失敗したセッション:');
    for (const e of errors) console.log(`  - ${e.item.slug}: ${e.error.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
