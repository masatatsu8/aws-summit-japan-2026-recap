// 要約生成プロンプトのソースオブトゥルース。
//   - subagent モード (Claude Code 上で並列ディスパッチ): `buildSubagentPrompt(slug)` を使う
//   - API モード (scripts/summarize.mjs から直接 Messages API): `buildApiPrompt({...})` を使う
// どちらのモードでも、フォーマットの「お手本」は下の FICTIONAL_SAMPLE を共有する。
// FICTIONAL_SAMPLE は AWS Summit と無関係な架空のサンプルで、schema/summary.schema.json に準拠する。

/**
 * 架空のサンプル要約 — 出力フォーマット教示用。AWS Summit Japan のいかなる
 * セッションとも無関係で、内容はフィクション (登壇者/会社/数値/URL すべて架空)。
 * citations は startSec 昇順、固有名詞補正の見本も含む。
 */
export const FICTIONAL_SAMPLE = {
  slug: 'demo-fictional-001',
  title: 'Hello World と分散システム入門 — 架空のサンプルセッション',
  track: 'Demo Track',
  durationSec: 1500,
  captionLang: 'ja',
  hlsMaster: 'https://example.invalid/demo/index.m3u8',
  officialUrl: 'https://example.invalid/demo/session/demo-fictional-001',
  tldr:
    '架空のサンプル登壇者 Acme 社の Mio Yamada が、分散システム入門として CAP 定理とイベント駆動アーキテクチャの基礎を解説する架空セッション。Hello World レベルから始めて Saga パターンまでを 25 分で俯瞰し、最後に架空の社内事例として注文管理システムのリアーキテクチャを紹介する。',
  keyPoints: [
    'CAP 定理を「3 つから 2 つ選ぶ」ではなく「P 前提で C と A をどう振るか」と捉える',
    'イベント駆動はメッセージブローカーの at-least-once 配送を前提に冪等性を設計する',
    'Saga パターンの補償トランザクションは「失敗するまで補償しない」原則で簡潔に保つ',
    '架空 Acme 注文管理は同期 REST から非同期イベントに移行し p99 遅延を 40% 改善 (架空数値)',
    'Outbox パターンで DB トランザクションとイベント発行のアトミック性を担保',
    '初学者は単一プロセス内で先にイベントモデルを試作し、後でブローカーを差し込むのが早い',
  ],
  citations: [
    {
      label: 'セッション開始 / 自己紹介',
      timestamp: '00:08',
      startSec: 8,
      quote: '架空の Acme 社で SRE をやっている山田です。今日はあと 25 分でこのセッションを終えます。',
    },
    {
      label: 'CAP 定理の誤読',
      timestamp: '01:42',
      startSec: 102,
      quote: 'CAP 定理は「3 つから 2 つ選ぶ」ではないんです。 P は事実上前提なので C と A のどちらに振るかという話です。',
    },
    {
      label: 'AP と CP の選び分け',
      timestamp: '03:20',
      startSec: 200,
      quote: 'ショッピングカートは AP、決済は CP、というように業務ドメイン単位で選びます。',
    },
    {
      label: 'メッセージブローカーの at-least-once',
      timestamp: '05:55',
      startSec: 355,
      quote: 'at-least-once 前提で、コンシューマー側で冪等にします。 メッセージ ID で重複検知します。',
    },
    {
      label: 'Outbox パターンの紹介',
      timestamp: '08:30',
      startSec: 510,
      quote: 'DB のトランザクション内に outbox テーブルへ書いて、別プロセスがブローカーへ転送します。',
    },
    {
      label: 'Saga と補償トランザクション',
      timestamp: '11:12',
      startSec: 672,
      quote: 'Saga は失敗したときだけ補償します。 成功時に余計な後処理を入れると複雑度が爆発します。',
    },
    {
      label: '架空事例: 注文管理リアーキ',
      timestamp: '14:40',
      startSec: 880,
      quote: '架空ですが、Acme 社の注文管理を REST 同期からイベント駆動に置き換えました。',
    },
    {
      label: '架空数値: p99 改善',
      timestamp: '17:08',
      startSec: 1028,
      quote: '結果として p99 遅延が 40% 改善し、ピーク時のタイムアウト率が 0.8% から 0.1% に下がりました。',
    },
    {
      label: '初学者向けの段階導入',
      timestamp: '20:15',
      startSec: 1215,
      quote: 'まず単一プロセスで EventEmitter のような形でイベントモデルを試作し、後でブローカーを差し込むと早く動きます。',
    },
    {
      label: 'まとめ',
      timestamp: '23:48',
      startSec: 1428,
      quote: '分散システムは「同期で書きたい衝動を抑えること」が一番のスキルです。',
    },
  ],
  asrNote:
    '自動字幕で「サーガ」「アクセプター」など固有名詞が崩れたため Saga / Acceptor 等の英語表記に補正。 数値はすべて登壇者の発言どおりで改竄なし (本サンプル自体は架空)。',
};

const FICTIONAL_SAMPLE_JSON = JSON.stringify(FICTIONAL_SAMPLE, null, 2);

/** モード共通の役割定義 + 出力フォーマット仕様 (お手本付き)。 */
const SYSTEM_PROMPT_BASE = `あなたは AWS Summit Japan 2026 のオンデマンドセッション字幕 (自動生成) を要約する専門アシスタントです。
出力は schema/summary.schema.json に準拠する **単一の JSON オブジェクト** のみ。前置き・コードフェンス・説明文を一切付けないこと。

## 出力フォーマット (フィールド順固定)
\`slug\` / \`title\` / \`track\` / \`durationSec\` / \`captionLang\`="ja" / \`hlsMaster\` / \`officialUrl\` / \`tldr\`(2-4文) / \`keyPoints\`(5-8個) / \`citations\`(8-20個) / \`asrNote\`

## citations の重要ルール (厳守)
- **必ず \`startSec\` の昇順 (時系列順)** に並べる。論理順や重要度順で並べ替えない。
- \`startSec\` は文字起こしの \`[mm:ss]\` を \`mm*60+ss\` に変換した整数秒。時刻を改竄しない。
- 出力前に「startSec が単調に増加しているか」を自分で確認すること。
- 各 citation は \`{label, timestamp, startSec, quote}\` の形。
- \`quote\` は読みやすさのため句読点・助詞の軽微整形を許可。意味の改変は不可。

## 自動字幕の補正
機械生成のため固有名詞の誤認識が多い。文脈で正しい表記に補正:
- クロードコード → Claude Code
- 黒 / クラウド → Claude
- アンソロ → Anthropic
- その他カタカナ表記が怪しい固有名詞は文脈と一般的な業界用語から補正
補正したら \`asrNote\` に一言記す。

## お手本 (架空セッション・schema 準拠サンプル)
以下は AWS Summit と無関係な架空のサンプル。フォーマットと citation の粒度の参考にすること。
**内容を真似るのではなく、構造・粒度・フィールド順序・citation の書き方を真似ること。**

\`\`\`json
${FICTIONAL_SAMPLE_JSON}
\`\`\`
`;

/**
 * subagent モード用プロンプト (Claude Code 上で並列ディスパッチする際の Task 指示文)。
 * subagent は data/{catalog,transcripts}/* を Read し、data/summaries/{slug}.json を Write する。
 */
export function buildSubagentPrompt(slug) {
  return `${SYSTEM_PROMPT_BASE}

## あなたのタスク
セッション \`${slug}\` の文字起こしを要約し、\`data/summaries/${slug}.json\` に保存してください。

## 手順
1. メタデータ取得: \`data/catalog.json\` から \`slug == "${slug}"\` のエントリを Read し、title / track / hlsMaster / officialUrl / captions.ja.durationSec を取り出す
2. 文字起こし読み込み: \`data/transcripts/${slug}.ja.txt\` を Read (\`[mm:ss] テキスト\` 形式)
3. 上記フォーマットに沿って要約 JSON を組み立てる
4. \`data/summaries/${slug}.json\` に Write
5. 最後の応答は \`OK: data/summaries/${slug}.json (N citations, M keyPoints)\` 程度の短い 1 行
`;
}

/** 旧 API との互換のため `buildPrompt` 名でも export */
export const buildPrompt = buildSubagentPrompt;

/**
 * API モード用プロンプト (scripts/summarize.mjs から Messages API へ直接渡す)。
 * 戻り値: { systemPrompt, userPrompt }
 *
 * @param {object} args
 * @param {string} args.slug
 * @param {string} args.title
 * @param {string} [args.track]
 * @param {number} [args.durationSec]
 * @param {string} [args.hlsMaster]
 * @param {string} [args.officialUrl]
 * @param {string} args.transcript - [mm:ss] テキスト形式の文字起こし全文
 */
export function buildApiPrompt({ slug, title, track, durationSec, hlsMaster, officialUrl, transcript }) {
  const meta = [
    `- slug: ${slug}`,
    `- title: ${title}`,
    track ? `- track: ${track}` : null,
    durationSec ? `- durationSec: ${durationSec}` : null,
    hlsMaster ? `- hlsMaster: ${hlsMaster}` : null,
    officialUrl ? `- officialUrl: ${officialUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const userPrompt = `次のセッションを要約し、フォーマット仕様に従う単一の JSON オブジェクトのみを返してください。
コードフェンスや前置きは付けないでください。

# セッションメタデータ
${meta}

# 文字起こし ([mm:ss] テキスト形式)
${transcript}
`;

  return { systemPrompt: SYSTEM_PROMPT_BASE, userPrompt };
}

export { SYSTEM_PROMPT_BASE };
