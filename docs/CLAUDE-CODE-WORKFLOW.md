# Claude Code subagent ワークフロー (代替ルート)

[Claude Code](https://docs.claude.com/ja/docs/claude-code/overview) のサブスクリプションを持っている人向けの、
Anthropic API キーを使わずに要約を生成する代替ルート。

---

## 何が違うか

| 項目 | Anthropic API ルート (デフォルト) | Claude Code subagent ルート |
|---|---|---|
| 必要なもの | `ANTHROPIC_API_KEY` | Claude Code CLI + `claude /login` 済み |
| コスト | 従量課金 (~$5-15 USD / 133 件) | サブスクリプション内 (定額) |
| 起動方法 | `npm run setup` / `node scripts/summarize.mjs` | Claude Code セッションから手動ディスパッチ |
| 並列度 | API のレート制限まで (デフォルト 4) | Claude Code が Task tool でハンドリング |
| 再現性 | 高 (スクリプト化済み) | やや低 (Claude Code 環境依存) |

---

## 手順

### 1. 文字起こしまで先に取得

Anthropic API キー無しでも、字幕とスライドの取得は可能:

```bash
node scripts/download.mjs                       # 字幕 + カタログ
node scripts/fetch-slide-urls.mjs               # スライド URL マップ
node scripts/download-and-extract-slides.mjs    # PDF + テキスト
```

または `npm run setup -- --skip-summarize` で要約だけスキップしながら他のステップを実行。

### 2. プロンプトテンプレートを使って Claude Code から要約

`scripts/summarize-prompt.mjs` がプロンプトテンプレート (`buildSubagentPrompt(slug)`) を export しています。

Claude Code セッション内で、以下のような手順で並列ディスパッチします:

```javascript
// 例: Claude Code 上で実行する一括ディスパッチコード
import { buildSubagentPrompt } from './scripts/summarize-prompt.mjs';
import { readdirSync, existsSync } from 'node:fs';

const slugs = readdirSync('data/transcripts')
  .filter(f => f.endsWith('.ja.txt'))
  .map(f => f.replace(/\.ja\.txt$/, ''))
  .filter(slug => !existsSync(`data/summaries/${slug}.json`));   // レジューム

// 各 slug について Task tool で subagent を起動
// (具体的なディスパッチコードは利用者の Claude Code 環境による)
for (const slug of slugs) {
  const prompt = buildSubagentPrompt(slug);
  // → Task ツールで `subagent_type: "general-purpose"` 等で並列起動
}
```

`buildSubagentPrompt(slug)` が返すプロンプトには:

- 役割 (要約専門アシスタント)
- 出力フォーマット仕様
- 架空のサンプル要約 JSON (フォーマット教示)
- 自動字幕の補正ガイド
- タスク指示 (`data/transcripts/{slug}.ja.txt` を Read、 `data/summaries/{slug}.json` に Write)

が含まれています。subagent が `Read` / `Write` ツールで自律的にファイル入出力します。

### 3. 検証と app-data 構築

```bash
node scripts/finalize.mjs
# → sort-citations → validate-summaries → app/scripts/build-index.mjs を一括実行
```

---

## 制約・既知の問題

- **Claude Code 環境依存**: Task ツールの API は Claude Code のバージョンで変わることがあります。
  本ドキュメントは 2026-06 時点の挙動を前提にしています。
- **subagent の並列度制御**: Claude Code 側の同時実行上限に従います。レート制限が出たら
  ディスパッチ間隔を調整してください。
- **Anthropic API ルートとの混在**: 同じ `data/summaries/` を読み書きするため、両ルートを
  同時実行しないでください。

---

## なぜこのルートを提供しているか

- 大量の要約 (133 件) を生成するときに、Claude Code サブスクの定額枠で処理できると経済的
- 開発者向け: Claude Code の Task tool でディスパッチする経験を残しておきたい

ただし「公開リポの標準パス」は **Anthropic API ルート** です (CI 自動化しやすく、コストが透明なため)。
