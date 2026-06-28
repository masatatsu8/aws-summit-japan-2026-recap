#!/usr/bin/env node
// AWS Summit 2026 — AI 質問応答サイドカー (no-tools 版)
//
// 設計:
//   - Claude Agent SDK の MCP tool 統合は tool_use ID 重複バグに遭遇したため、
//     セッション要約データを system prompt に全埋め込みする方針に変更。
//   - 全 133 セッションの slug / title / track / tldr / keyPoints と各 citation の
//     {slug, startSec, label} だけを埋め込む。長い quote/transcript は埋めない。
//   - Claude は回答内に `[CITE:slug=... start=...]` `[SESSION:slug=...]` を埋め込み、
//     フロントがそれをクリック可能なチップに変換する。
//   - 認証: Claude Code (`claude /login`) のサブスク認証を継承するためローカル個人利用前提。
//
// 起動: app/ から `node server/sidecar.mjs`

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync, mkdirSync, unlinkSync, statSync, createReadStream } from 'node:fs';
import { bookmarks, lists, listItems, chats, chatMessages, screenshots, dbPath } from './db.mjs';

// ---- .env ローダー (Node 22.8 では --env-file-if-exists が無いため自前) -----
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
// 探索順: ./app/.env -> ../../.env (repo root) -> プロセス起動時の CWD/.env
loadEnvFile('.env');
loadEnvFile(join(process.cwd(), '..', '.env'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..');
const DATA_PATH = join(APP_ROOT, 'src/data/app-data.json');
const SLIDES_TEXT_PATH = join(APP_ROOT, 'src/data/slides-text.json');
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || join(REPO_ROOT, 'data/screenshots');
mkdirSync(SCREENSHOTS_DIR, { recursive: true });
const SLIDES_DIR = process.env.SLIDES_DIR || join(REPO_ROOT, 'data/slides');

const PORT = Number(process.env.SIDECAR_PORT || 3001);
/** バックエンド: 'agent' = Claude Code SDK (ローカル個人サブスク認証) / 'api' = Anthropic API (ANTHROPIC_API_KEY) */
const LLM_BACKEND = (process.env.LLM_BACKEND || 'agent').toLowerCase() === 'api' ? 'api' : 'agent';
const MODEL = process.env.ASK_MODEL || 'claude-sonnet-4-6';

// CORS allowlist (CSRF/cross-origin 攻撃防止)。デフォルトは Vite dev server のみ許可。
// 複数オリジンは ALLOWED_ORIGINS=http://a,http://b で指定可。
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// path traversal 防止: resolve 後にベースディレクトリ配下であることを確認
function safeResolve(baseDir, ...parts) {
  const baseResolved = resolve(baseDir);
  const target = resolve(baseResolved, ...parts);
  if (target !== baseResolved && !target.startsWith(baseResolved + sep)) {
    throw new Error('path escapes base directory');
  }
  return target;
}

let apiClient = null;
if (LLM_BACKEND === 'api') {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[fatal] LLM_BACKEND=api requires ANTHROPIC_API_KEY (set in .env)');
    process.exit(1);
  }
  apiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const PRICING_PER_1M = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
function estimateCost(usage, model) {
  const p = PRICING_PER_1M[model] || PRICING_PER_1M['claude-sonnet-4-6'];
  const inT = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  const outT = usage?.output_tokens || 0;
  return (inT * p.input + outT * p.output) / 1_000_000;
}

// ---- App data load ---------------------------------------------------------
const appData = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
const slidesText = (() => {
  try {
    return JSON.parse(readFileSync(SLIDES_TEXT_PATH, 'utf8'));
  } catch {
    return {};
  }
})();
console.log(
  `sidecar loaded: ${appData.sessions.length} sessions, ${Object.keys(appData.summaries).length} summaries, ${Object.keys(slidesText).length} slide texts`,
);

// ---- Build session catalog (compact) for system prompt ---------------------
// rate limit を考慮し、tldr + keyPoints のみ。citations は埋め込まない。
function buildSessionCatalog() {
  const lines = [];
  for (const s of appData.sessions) {
    const sum = appData.summaries[s.slug];
    if (!sum) continue;
    const tags = (s.filterTags || '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.startsWith('トピック:') || t.startsWith('レベル:'))
      .join(' ');
    lines.push(`### ${s.slug} | ${s.track || ''} | ${tags}`);
    lines.push(`T: ${s.title}`);
    lines.push(`要旨: ${sum.tldr}`);
    for (const k of sum.keyPoints.slice(0, 4)) {
      lines.push(`- ${k.length > 140 ? k.slice(0, 140) + '…' : k}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const SESSION_CATALOG = buildSessionCatalog();
console.log(`session catalog: ${SESSION_CATALOG.length} chars (≈${Math.round(SESSION_CATALOG.length / 4)} tokens)`);

const SYSTEM_PROMPT = `あなたは AWS Summit Japan 2026 オンデマンドの "セッション案内アシスタント" です。
全 ${Object.keys(appData.summaries).length} セッションの要旨(tldr)と主要キーポイントを下に埋め込みます。
回答は **この埋め込みデータの範囲だけ** で行い、データ外の情報を補わないでください。

## 振る舞い
- 簡潔な日本語で 3〜6 文程度を基本にする。長すぎる説明はしない。
- 紹介するセッションには **必ず以下のタグ** を回答テキスト内で利用する:
  - 該当文の直後: \`[SESSION:slug=jpn-xxx]\` (Webアプリ側でクリック可能リンクに変換される)
- 動画の具体的な時刻(mm:ss)はこのプロンプトに含めていない。時刻を勝手に作らないこと。引用が必要なら "詳細はセッションページで [SESSION:slug=...] を参照" と案内する。
- ヒットしない / 曖昧な質問は、近そうなセッションを 1〜2 件示し「他の角度はありますか」と聞き返す。
- 回答末尾に "**関連セッション**" の見出しで、紹介した slug を 1 行ずつ:
  \`- [SESSION:slug=jpn-xxx] タイトル (短縮可)\`
- マークダウン見出し(##)は使わない。\`**関連セッション**\` のみ太字 OK。
- コード生成・ファイル編集・ツール起動は行わない。あなたは案内アシスタントです。

## 出力例 (架空のサンプル — 実セッションとは無関係)
"分散システムの入門としては Saga パターンの基礎が紹介されています [SESSION:slug=demo-fictional-001]。基本ポートフォリオの組み立てとしては別アプローチが触れられているセッションもあります [SESSION:slug=demo-fictional-002]。詳細な時刻ごとの引用はそれぞれのセッションページでご確認ください。

**関連セッション**
- [SESSION:slug=demo-fictional-001] (架空) Hello World と分散システム入門
- [SESSION:slug=demo-fictional-002] (架空) 別アプローチの紹介セッション"

---

# セッションカタログ (全 ${Object.keys(appData.summaries).length} 件)

${SESSION_CATALOG}`;

// ---- HTTP server -----------------------------------------------------------
const server = createServer((req, res) => {
  // CORS: 明示 allowlist のみ許可。未登録オリジンには Allow-Origin を付けない (ブラウザがブロック)。
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    // preflight: allowlist 外なら 403、許可済みなら 204
    res.writeHead(origin && ALLOWED_ORIGINS.has(origin) ? 204 : 403);
    res.end();
    return;
  }

  // CSRF 緩和: 変更系メソッド (POST/PATCH/DELETE) は Origin/Referer が allowlist 内であることを要求。
  // (GET/OPTIONS は副作用なし、ヘルスチェック等で外部から叩かれてもよいので緩く扱う。)
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const sourceOrigin = origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
    if (!sourceOrigin || !ALLOWED_ORIGINS.has(sourceOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        sessions: appData.sessions.length,
        summaries: Object.keys(appData.summaries).length,
        promptChars: SYSTEM_PROMPT.length,
        backend: LLM_BACKEND,
        model: MODEL,
        dbPath,
        bookmarkCount: bookmarks.list().length,
      }),
    );
    return;
  }

  // ---- Chats API ----
  if (req.url?.startsWith('/api/chats')) {
    handleChats(req, res);
    return;
  }
  // ---- Screenshots API ----
  if (req.url?.startsWith('/api/screenshots')) {
    handleScreenshots(req, res);
    return;
  }
  // ---- Slides (PDF) 配信 ----
  if (req.url?.startsWith('/api/slides/')) {
    handleSlides(req, res);
    return;
  }
  // ---- Bookmarks API ----
  if (req.url?.startsWith('/api/bookmarks')) {
    handleBookmarks(req, res);
    return;
  }
  // ---- Lists API ----
  if (
    req.url?.startsWith('/api/lists') ||
    req.url?.startsWith('/api/quick/') ||
    req.url?.startsWith('/api/slug-memberships/')
  ) {
    handleLists(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ask') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const question = String(parsed.question || '').trim();
      const resume = parsed.sessionId;
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'question required' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        for await (const message of query({
          prompt: question,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            // 案内アシスタント用途のためツール実行は一切不要。
            // 空 allowlist + default permissionMode で fail-closed にし、
            // SDK 更新で新ツールが追加されても自動的に拒否される。
            allowedTools: [],
            permissionMode: 'default',
            settingSources: [],
            persistSession: false,
            includePartialMessages: false,
            maxTurns: 2,
            model: MODEL,
            resume,
          },
        })) {
          if (message.type === 'system' && message.subtype === 'init') {
            send('init', { sessionId: message.session_id });
          } else if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'text') {
                send('text', { text: block.text });
              } else if (block.type === 'tool_use') {
                send('tool_use', { name: block.name, input: block.input });
              }
            }
          } else if (message.type === 'result') {
            send('result', {
              subtype: message.subtype,
              result: typeof message.result === 'string' ? message.result.slice(0, 200) : undefined,
              totalCostUsd: message.total_cost_usd,
              numTurns: message.num_turns,
            });
          }
        }
        send('done', {});
      } catch (e) {
        console.error('ask error:', e);
        send('error', { message: String(e?.message || e) });
      } finally {
        res.end();
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ---- Bookmarks ハンドラ ----------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleBookmarks(req, res) {
  const url = req.url || '';
  const method = req.method || 'GET';
  try {
    // GET /api/bookmarks -> list
    if (method === 'GET' && url === '/api/bookmarks') {
      return sendJson(res, 200, bookmarks.list());
    }
    // GET /api/bookmarks/by-slug/{slug}
    if (method === 'GET' && url.startsWith('/api/bookmarks/by-slug/')) {
      const slug = decodeURIComponent(url.slice('/api/bookmarks/by-slug/'.length));
      return sendJson(res, 200, bookmarks.listBySlug(slug));
    }
    // POST /api/bookmarks  { slug, startSec, label, quote?, note? }
    if (method === 'POST' && url === '/api/bookmarks') {
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      if (!p.slug || typeof p.startSec !== 'number' || !p.label) {
        return sendJson(res, 400, { error: 'slug / startSec / label required' });
      }
      const existing = bookmarks.getByKey(p.slug, p.startSec);
      if (existing) return sendJson(res, 200, existing);
      const added = bookmarks.add({
        slug: String(p.slug),
        startSec: Math.floor(p.startSec),
        label: String(p.label),
        quote: p.quote ? String(p.quote) : null,
        note: p.note ? String(p.note) : null,
      });
      return sendJson(res, 201, added);
    }
    // DELETE /api/bookmarks/{id}
    const delM = url.match(/^\/api\/bookmarks\/(\d+)$/);
    if (method === 'DELETE' && delM) {
      const id = Number(delM[1]);
      const removed = bookmarks.delete(id);
      return sendJson(res, removed ? 200 : 404, { id, removed });
    }
    // PATCH /api/bookmarks/{id}  { note }
    if (method === 'PATCH' && delM) {
      const id = Number(delM[1]);
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      if (p.note === undefined) return sendJson(res, 400, { error: 'note required' });
      const updated = bookmarks.updateNote(id, p.note === null ? null : String(p.note));
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, bookmarks.getById(id));
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('bookmarks error:', e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
}

// ---- Lists ハンドラ --------------------------------------------------------
async function handleLists(req, res) {
  const url = req.url || '';
  const method = req.method || 'GET';
  try {
    // /api/quick/watch-later/:slug (POST: toggle, GET: check)
    const quick = url.match(/^\/api\/quick\/watch-later\/([^/]+)$/);
    if (quick) {
      const slug = decodeURIComponent(quick[1]);
      const watchLater = lists.getBySystemKey('watch_later');
      if (!watchLater) return sendJson(res, 500, { error: 'watch_later list missing' });
      if (method === 'GET') {
        const memberships = listItems.membershipsOf(slug);
        return sendJson(res, 200, { inWatchLater: memberships.includes(watchLater.id) });
      }
      if (method === 'POST') {
        const memberships = listItems.membershipsOf(slug);
        if (memberships.includes(watchLater.id)) {
          listItems.remove(watchLater.id, slug);
          return sendJson(res, 200, { inWatchLater: false });
        }
        listItems.add(watchLater.id, slug, null);
        return sendJson(res, 200, { inWatchLater: true });
      }
    }

    // /api/slug-memberships/:slug → このセッションが属するリスト id 一覧
    const memb = url.match(/^\/api\/slug-memberships\/([^/]+)$/);
    if (memb && method === 'GET') {
      const slug = decodeURIComponent(memb[1]);
      return sendJson(res, 200, { slug, listIds: listItems.membershipsOf(slug) });
    }

    // /api/lists (GET: 全件 / POST: 作成)
    if (url === '/api/lists' && method === 'GET') return sendJson(res, 200, lists.listAll());
    if (url === '/api/lists' && method === 'POST') {
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const name = String(p.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name required' });
      return sendJson(res, 201, lists.create(name));
    }

    // /api/lists/:id (GET: 詳細 / PATCH: 改名 / DELETE: 削除)
    const listM = url.match(/^\/api\/lists\/(\d+)$/);
    if (listM) {
      const id = Number(listM[1]);
      const list = lists.getById(id);
      if (!list) return sendJson(res, 404, { error: 'list not found' });
      if (method === 'GET') {
        return sendJson(res, 200, { ...list, items: listItems.byList(id) });
      }
      if (method === 'PATCH') {
        if (list.isSystem) return sendJson(res, 400, { error: 'cannot rename system list' });
        const body = await readBody(req);
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON' });
        }
        const name = String(p.name || '').trim();
        if (!name) return sendJson(res, 400, { error: 'name required' });
        lists.rename(id, name);
        return sendJson(res, 200, lists.getById(id));
      }
      if (method === 'DELETE') {
        if (list.isSystem) return sendJson(res, 400, { error: 'cannot delete system list' });
        lists.delete(id);
        return sendJson(res, 200, { id, removed: 1 });
      }
    }

    // /api/lists/:id/items (POST: 追加)
    const itemsAdd = url.match(/^\/api\/lists\/(\d+)\/items$/);
    if (itemsAdd && method === 'POST') {
      const id = Number(itemsAdd[1]);
      const list = lists.getById(id);
      if (!list) return sendJson(res, 404, { error: 'list not found' });
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const slug = String(p.slug || '').trim();
      if (!slug) return sendJson(res, 400, { error: 'slug required' });
      const item = listItems.add(id, slug, p.note ? String(p.note) : null);
      return sendJson(res, 201, item);
    }

    // /api/lists/:id/items/:slug (DELETE / PATCH)
    const itemRef = url.match(/^\/api\/lists\/(\d+)\/items\/([^/]+)$/);
    if (itemRef) {
      const id = Number(itemRef[1]);
      const slug = decodeURIComponent(itemRef[2]);
      if (method === 'DELETE') {
        const removed = listItems.remove(id, slug);
        return sendJson(res, removed ? 200 : 404, { id, slug, removed });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON' });
        }
        if (p.note === undefined) return sendJson(res, 400, { error: 'note required' });
        const updated = listItems.updateNote(id, slug, p.note === null ? null : String(p.note));
        if (!updated) return sendJson(res, 404, { error: 'item not found' });
        return sendJson(res, 200, { id, slug, note: p.note });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('lists error:', e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
}

// ---- Chats ハンドラ --------------------------------------------------------
const MAX_CONTEXT_MESSAGES = 12; // 直近 N 件まで文脈に含める
const MAX_ENRICH_SLUGS = 6;      // 動的に詳細を埋め込む最大セッション数

function buildChatPrompt(pastMessages, question) {
  if (pastMessages.length === 0) return question;
  const lines = ['# これまでの会話 (古い順、最後があなたの直前の応答)'];
  for (const m of pastMessages) {
    const speaker = m.role === 'user' ? 'ユーザー' : 'アシスタント';
    lines.push(`\n## ${speaker}\n${m.content}`);
  }
  lines.push('\n# 今回の質問');
  lines.push(question);
  return lines.join('\n');
}

/** 質問 + 過去メッセージから「言及済みのセッション slug」を抽出する。
 *  優先度: 質問内で明示された slug > 直近の assistant 回答で言及した slug > それ以前
 */
function collectReferencedSlugs(question, pastMessages) {
  const ranked = []; // 出現順、後で dedupe
  const sessionRe = /\[SESSION:slug=([a-zA-Z0-9_-]+)/g;
  const inlineSlugRe = /\b(jpn-[a-z0-9-]+)\b/g;

  // (a) 質問内の slug を最優先
  for (const m of String(question).matchAll(inlineSlugRe)) ranked.push(m[1]);

  // (b) 直近 assistant メッセージ → 古い順に降りていく
  const assistants = pastMessages.filter((m) => m.role === 'assistant').reverse();
  for (const a of assistants) {
    for (const m of String(a.content).matchAll(sessionRe)) ranked.push(m[1]);
    for (const m of String(a.content).matchAll(inlineSlugRe)) ranked.push(m[1]);
  }

  const seen = new Set();
  const out = [];
  for (const s of ranked) {
    if (seen.has(s)) continue;
    if (!appData.summaries[s]) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_ENRICH_SLUGS) break;
  }
  return out;
}

/** 言及されたセッションを詳細展開してプロンプト末尾に付ける */
function buildEnrichedSystemPrompt(slugs) {
  if (slugs.length === 0) return SYSTEM_PROMPT;
  const blocks = [];
  for (const slug of slugs) {
    const sum = appData.summaries[slug];
    const sess = sessionsBySlug.get(slug);
    if (!sum) continue;
    const lines = [`### ${slug} — ${sum.title}`];
    if (sess?.track) lines.push(`track: ${sess.track}`);
    lines.push(`tldr: ${sum.tldr}`);
    lines.push(`keyPoints:`);
    for (const k of sum.keyPoints) lines.push(`- ${k}`);
    lines.push(`citations (時刻 + ラベル + 引用文。startSec は秒、ユーザーへの引用に使える):`);
    for (const c of sum.citations) {
      const t = c.timestamp || `${String(Math.floor(c.startSec / 60)).padStart(2, '0')}:${String(c.startSec % 60).padStart(2, '0')}`;
      const q = c.quote ? ` :: "${c.quote.replace(/"/g, '”')}"` : '';
      lines.push(`- [${t} start=${c.startSec}] ${c.label}${q}`);
    }
    if (sum.asrNote) lines.push(`asrNote: ${sum.asrNote}`);
    const slide = slidesText[slug];
    if (slide) {
      lines.push(`slidesText (PDF):`);
      lines.push(slide.slice(0, 6000));
    }
    blocks.push(lines.join('\n'));
  }
  return (
    SYSTEM_PROMPT +
    `\n\n# 会話中に言及されたセッションの詳細 (動的展開)\n` +
    `このセクションには ${slugs.length} 件のセッションの citations を時刻 (\`start=N\`、秒) 付きで含めています。\n` +
    `フォローアップ質問への回答では、ここの citation 行 \`- [mm:ss start=N] ラベル :: "発言"\` を活用し、\n` +
    `**回答テキストに必ず \`[CITE:slug=jpn-xxx start=N]\` 形式の引用タグを埋めてください** ` +
    `(N は citation 行の \`start=\` 値そのまま、改竄禁止)。\n` +
    `また、quote の発言を回答に短く引用してもよい (引用符 \`「...」\`)。\n\n` +
    `### スライド (PDF) 引用について\n` +
    `各セッションには \`slidesText (PDF)\` 欄にスライド本文を \`[pN]\` のページマーカー付きで含めています。\n` +
    `**ユーザーが明示的にお願いしていなくても**、 紹介するセッションについて以下を行ってください:\n` +
    `- 数値・図表・社名・キーワード・構成図など、スライドに該当ページがあるトピックには ` +
    `**\`[SLIDE:slug=jpn-xxx page=N]\` 形式のスライド引用タグ** を必ず添える (N は \`[pN]\` のページ番号)。\n` +
    `- 動画 \`[CITE:...]\` と スライド \`[SLIDE:...]\` の両方に該当があれば **続けて並べてよい** ` +
    `(例: 「…と説明されています [SLIDE:slug=jpn-xxxNNN page=15] [CITE:slug=jpn-xxxNNN start=632]」)。\n` +
    `- スライド本文を持たないセッション (\`slidesText\` 欄なし) は CITE のみで構いません。\n\n${blocks.join('\n\n')}`
  );
}

// セッション slug → メタへの逆引き (build 時1回)
const sessionsBySlug = new Map(appData.sessions.map((s) => [s.slug, s]));

// ---- 簡易検索 (エージェント検索モード用) -----------------------------------
function tokenizeForSearch(s) {
  const base = (s || '')
    .toLowerCase()
    .split(/[\s、。・「」『』()（）\[\]【】,.!?！？:：;；/\\|]+/)
    .filter(Boolean);
  const ngrams = [];
  for (const w of base) {
    if (w.length >= 4 && /[぀-ヿ一-鿿]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) ngrams.push(w.slice(i, i + 2));
    }
  }
  return new Set([...base, ...ngrams]);
}

const SEARCH_INDEX = appData.sessions
  .filter((s) => appData.summaries[s.slug])
  .map((s) => {
    const sum = appData.summaries[s.slug];
    const slideText = slidesText[s.slug] || '';
    const text = [
      s.title,
      s.track,
      s.filterTags,
      sum.tldr,
      sum.keyPoints.join(' '),
      sum.citations.map((c) => `${c.label} ${c.quote ?? ''}`).join(' '),
      // スライド本文も検索対象。大きいが ngram は構造的に共有されるので OK
      slideText,
    ]
      .filter(Boolean)
      .join(' ');
    return { slug: s.slug, tokens: tokenizeForSearch(text), title: s.title.toLowerCase() };
  });

function searchSessions(qText, limit = 8) {
  const qt = tokenizeForSearch(qText);
  if (qt.size === 0) return [];
  const scored = SEARCH_INDEX.map(({ slug, tokens, title }) => {
    let score = 0;
    for (const t of qt) {
      if (!tokens.has(t)) continue;
      if (/^[a-z0-9][a-z0-9.-]{2,}$/.test(t)) {
        // 英数字長語 (iceberg, bedrock, kubernetes 等の固有名詞) を強く評価
        score += 3 + t.length / 4;
      } else if (t.length >= 2 && /[぀-ヿ一-鿿]/.test(t)) {
        // 日本語 ngram は低スコアの足し合わせ
        score += 0.4;
      } else if (t.length >= 4) {
        score += 1 + t.length / 8;
      } else {
        score += 0.6;
      }
    }
    if (qt.has(title)) score *= 1.5;
    return { slug, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0).slice(0, limit);
}

/** エージェント検索モード用の "短い" base prompt + 検索結果 N 件の citations 全展開 */
function buildAgentSystemPrompt(searchHits) {
  const blocks = [];
  for (const hit of searchHits) {
    const sum = appData.summaries[hit.slug];
    const sess = sessionsBySlug.get(hit.slug);
    if (!sum) continue;
    const lines = [`### ${hit.slug} — ${sum.title}`];
    if (sess?.track) lines.push(`track: ${sess.track}`);
    lines.push(`tldr: ${sum.tldr}`);
    lines.push(`keyPoints:`);
    for (const k of sum.keyPoints) lines.push(`- ${k}`);
    lines.push(`citations (時刻 + ラベル + 引用):`);
    for (const c of sum.citations) {
      const t = c.timestamp || `${String(Math.floor(c.startSec / 60)).padStart(2, '0')}:${String(c.startSec % 60).padStart(2, '0')}`;
      const q = c.quote ? ` :: "${c.quote.replace(/"/g, '”')}"` : '';
      lines.push(`- [${t} start=${c.startSec}] ${c.label}${q}`);
    }
    if (sum.asrNote) lines.push(`asrNote: ${sum.asrNote}`);
    // スライドテキスト本文 (先頭 6000 文字程度に抑える、 全文だとプロンプト過大)
    const slide = slidesText[hit.slug];
    if (slide) {
      lines.push(`slidesText (PDF):`);
      lines.push(slide.slice(0, 6000));
    }
    blocks.push(lines.join('\n'));
  }

  return `あなたは AWS Summit Japan 2026 オンデマンドの "セッション案内アシスタント" (エージェント検索モード) です。
ユーザーの質問を受けて、ローカルで全文検索した上位 ${searchHits.length} 件の関連セッションの詳細を以下に渡しています。
各セッションには (1) tldr/keyPoints (2) 動画字幕 citations (時刻付き) (3) PDF スライド本文 (\`[pN]\` のページマーカー付き) が含まれます。
回答は **この検索結果の範囲だけ** で行ってください。データ外の情報を補わないこと。

## 振る舞い
- 簡潔な日本語で 3-6 文程度。長すぎる説明はしない。
- セッションを紹介する文には \`[SESSION:slug=jpn-xxx]\` をその直後に置く。
- **引用タグの方針 (デフォルト両方)**: 紹介するセッションについて、ユーザーが特に指定していなくても以下の 2 種類を **積極的に併用** してください:
  - **\`[CITE:slug=jpn-xxx start=N]\`** — 動画の特定発言を引用する場合 (N は citation 行の \`start=\` 値そのまま)。
  - **\`[SLIDE:slug=jpn-xxx page=N]\`** — スライド (PDF) の特定ページを参照する場合 (N は slidesText 内の \`[pN]\` ページ番号)。**数値・図表・社名・固有名詞・キーワード・構成図** は字幕に出ないことが多いので、スライド側に該当があれば \`[SLIDE:...]\` を優先する。
  - スライド本文 (slidesText) と citations の両方に同じトピックがある場合は、**両方の引用を続けて並べる** (例: 「…という結果でした [SLIDE:slug=jpn-xxxNNN page=15] [CITE:slug=jpn-xxxNNN start=632]」)。スライドだけ・字幕だけのどちらかにしか情報が無いときはその一方のみで OK。
  - スライド (PDF) を持たないセッション (slidesText 欄なし) の場合は CITE のみで構わない。
- 短い引用 (「...」) を回答に織り交ぜると説得力が増す。
- 検索結果が ユーザーの意図と少しずれている時は、その旨も添える。
- 最後に \`**関連セッション**\` の見出しで、紹介した slug を 1 行ずつ:
  \`- [SESSION:slug=jpn-xxx] タイトル\`

## 検索ヒット (上位 ${searchHits.length} 件)

${blocks.join('\n\n')}
`;
}

/** Claude Code Agent SDK (subscription) で実行 — answerText を返す */
async function runAgentSdk({ send, systemPrompt, prompt }) {
  let answerText = '';
  for await (const message of query({
    prompt,
    options: {
      systemPrompt,
      // 案内アシスタント用途のためツール実行は一切不要。
      allowedTools: [],
      permissionMode: 'default',
      settingSources: [],
      persistSession: false,
      includePartialMessages: false,
      maxTurns: 2,
      model: MODEL,
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      send('init', { sessionId: message.session_id, backend: 'agent' });
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          answerText += block.text;
          send('text', { text: block.text });
        } else if (block.type === 'tool_use') {
          send('tool_use', { name: block.name, input: block.input });
        }
      }
    } else if (message.type === 'result') {
      send('result', {
        subtype: message.subtype,
        totalCostUsd: message.total_cost_usd,
        numTurns: message.num_turns,
        backend: 'agent',
      });
    }
  }
  return answerText;
}

/** Anthropic Messages API (API key) で実行 — answerText を返す */
async function runAnthropicApi({ send, systemPrompt, prompt }) {
  send('init', { sessionId: `api-${Date.now()}`, backend: 'api' });
  let answerText = '';
  const stream = apiClient.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const t = event.delta.text || '';
      if (t) {
        answerText += t;
        send('text', { text: t });
      }
    } else if (event.type === 'message_stop') {
      // finalMessage で usage 取得
    }
  }
  const final = await stream.finalMessage();
  send('result', {
    subtype: final.stop_reason === 'end_turn' ? 'success' : final.stop_reason || 'success',
    totalCostUsd: estimateCost(final.usage, MODEL),
    numTurns: 1,
    backend: 'api',
    usage: final.usage,
  });
  return answerText;
}

async function streamAsk(res, { chatId, question, mode }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 過去メッセージ
  const past = chatMessages.byChat(chatId).slice(-MAX_CONTEXT_MESSAGES);
  // ユーザー質問を保存
  const userMsg = chatMessages.add(chatId, 'user', question);
  send('user_message', userMsg);

  const prompt = buildChatPrompt(past, question);
  let systemPromptUsed = SYSTEM_PROMPT;
  if (mode === 'agent') {
    const hits = searchSessions(question, 8);
    // 過去会話で言及された slug も補足的に上位に混ぜる (会話継続性のため)
    const refSlugs = collectReferencedSlugs(question, past);
    const merged = [];
    const seen = new Set();
    for (const s of refSlugs) {
      if (!seen.has(s) && appData.summaries[s]) {
        merged.push({ slug: s, score: 0 });
        seen.add(s);
      }
    }
    for (const h of hits) {
      if (!seen.has(h.slug)) {
        merged.push(h);
        seen.add(h.slug);
      }
    }
    const top = merged.slice(0, 8);
    systemPromptUsed = buildAgentSystemPrompt(top);
    send('search_results', {
      mode: 'agent',
      hits: top.map((h) => {
        const sum = appData.summaries[h.slug];
        const sess = sessionsBySlug.get(h.slug);
        return {
          slug: h.slug,
          title: sess?.title ?? sum?.title ?? h.slug,
          track: sess?.track ?? '',
          score: Number((h.score || 0).toFixed(2)),
        };
      }),
      promptChars: systemPromptUsed.length,
    });
  } else {
    const referencedSlugs = collectReferencedSlugs(question, past);
    systemPromptUsed = buildEnrichedSystemPrompt(referencedSlugs);
    if (referencedSlugs.length > 0) {
      send('context_enriched', { slugs: referencedSlugs, promptChars: systemPromptUsed.length });
    }
  }
  let answerText = '';
  try {
    if (LLM_BACKEND === 'api') {
      answerText = await runAnthropicApi({ send, systemPrompt: systemPromptUsed, prompt });
    } else {
      answerText = await runAgentSdk({ send, systemPrompt: systemPromptUsed, prompt });
    }
  } catch (e) {
    console.error('chat ask error:', e);
    send('error', { message: String(e?.message || e) });
  }

  // assistant 応答を保存
  let assistantMsg = null;
  if (answerText.trim()) {
    assistantMsg = chatMessages.add(chatId, 'assistant', answerText);
    send('assistant_message', assistantMsg);
  }

  // 初回回答後にタイトル自動付け (短く: 質問の先頭 40 文字、改行除去)
  const chat = chats.get(chatId);
  if (chat && !chat.title) {
    const title = question.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (title) {
      chats.rename(chatId, title);
      send('chat_renamed', { id: chatId, title });
    }
  }

  send('done', {});
  res.end();
}

async function handleChats(req, res) {
  const url = req.url || '';
  const method = req.method || 'GET';
  try {
    // GET /api/chats
    if (url === '/api/chats' && method === 'GET') {
      return sendJson(res, 200, chats.listAll());
    }
    // POST /api/chats
    if (url === '/api/chats' && method === 'POST') {
      const body = await readBody(req);
      let p = {};
      try {
        if (body) p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const title = p.title ? String(p.title) : '';
      return sendJson(res, 201, chats.create(title));
    }
    // /api/chats/:id (GET/PATCH/DELETE)
    const idM = url.match(/^\/api\/chats\/(\d+)$/);
    if (idM) {
      const id = Number(idM[1]);
      const chat = chats.get(id);
      if (!chat) return sendJson(res, 404, { error: 'chat not found' });
      if (method === 'GET') {
        return sendJson(res, 200, { ...chat, messages: chatMessages.byChat(id) });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON' });
        }
        if (p.title == null) return sendJson(res, 400, { error: 'title required' });
        chats.rename(id, String(p.title));
        return sendJson(res, 200, chats.get(id));
      }
      if (method === 'DELETE') {
        chats.delete(id);
        return sendJson(res, 200, { id, removed: 1 });
      }
    }
    // POST /api/chats/:id/ask
    const askM = url.match(/^\/api\/chats\/(\d+)\/ask$/);
    if (askM && method === 'POST') {
      const id = Number(askM[1]);
      const chat = chats.get(id);
      if (!chat) return sendJson(res, 404, { error: 'chat not found' });
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const question = String(p.question || '').trim();
      if (!question) return sendJson(res, 400, { error: 'question required' });
      const mode = p.mode === 'agent' ? 'agent' : 'full';
      await streamAsk(res, { chatId: id, question, mode });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('chats error:', e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
}

// ---- Slides (PDF) ハンドラ -------------------------------------------------
function handleSlides(req, res) {
  const url = req.url || '';
  // /api/slides/{slug}.pdf  or  /api/slides/{slug}
  const m = url.match(/^\/api\/slides\/([^/?#]+?)(?:\.pdf)?(?:\?.*)?$/);
  if (!m) return sendJson(res, 404, { error: 'not found' });
  const slug = decodeURIComponent(m[1]);
  // slug 制約 (path traversal 防止の第 1 層): 英数 + _ - のみ、長さ上限 64、`.` 不可
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  // 第 2 層: resolve 後に SLIDES_DIR 配下であることを確認
  let path;
  try {
    path = safeResolve(SLIDES_DIR, `${slug}.pdf`);
  } catch {
    return sendJson(res, 400, { error: 'invalid path' });
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return sendJson(res, 404, { error: 'pdf not found' });
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${slug}.pdf"`,
    'Cache-Control': 'private, max-age=86400',
  });
  createReadStream(path).pipe(res);
}

// ---- Screenshots ハンドラ --------------------------------------------------
async function handleScreenshots(req, res) {
  const url = req.url || '';
  const method = req.method || 'GET';
  try {
    // GET /api/screenshots
    if (url === '/api/screenshots' && method === 'GET') {
      return sendJson(res, 200, screenshots.list());
    }
    // POST /api/screenshots  { slug, startSec, dataUrl, width, height, note? }
    if (url === '/api/screenshots' && method === 'POST') {
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON' });
      }
      const slug = String(p.slug || '').trim();
      const startSec = Math.floor(Number(p.startSec));
      const dataUrl = String(p.dataUrl || '');
      if (!slug || !Number.isFinite(startSec) || !dataUrl.startsWith('data:image/')) {
        return sendJson(res, 400, { error: 'slug / startSec / dataUrl (image) required' });
      }
      const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
      if (!m) return sendJson(res, 400, { error: 'unsupported image data url' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 10 * 1024 * 1024) {
        return sendJson(res, 413, { error: 'image too large (>10MB)' });
      }
      // slug は path 構成要素になるため厳格に制限 (path traversal 防止)
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(slug)) {
        return sendJson(res, 400, { error: 'invalid slug' });
      }
      const ts = Date.now();
      const filename = `${slug}-${startSec}-${ts}.${ext}`;
      let savePath;
      try {
        savePath = safeResolve(SCREENSHOTS_DIR, filename);
      } catch {
        return sendJson(res, 400, { error: 'invalid path' });
      }
      writeFileSync(savePath, buf);
      const rec = screenshots.add({
        slug,
        startSec,
        filename,
        width: p.width ? Math.floor(Number(p.width)) : null,
        height: p.height ? Math.floor(Number(p.height)) : null,
        note: p.note ? String(p.note) : null,
        title: p.title ? String(p.title) : null,
      });
      return sendJson(res, 201, rec);
    }
    // GET /api/screenshots/by-slug/:slug
    const bySlugM = url.match(/^\/api\/screenshots\/by-slug\/([^/]+)$/);
    if (bySlugM && method === 'GET') {
      const slug = decodeURIComponent(bySlugM[1]);
      return sendJson(res, 200, screenshots.bySlug(slug));
    }
    // /api/screenshots/:id (DELETE / PATCH)
    const idM = url.match(/^\/api\/screenshots\/(\d+)$/);
    if (idM) {
      const id = Number(idM[1]);
      const rec = screenshots.getById(id);
      if (!rec) return sendJson(res, 404, { error: 'not found' });
      if (method === 'DELETE') {
        try {
          // DB に格納された filename を信頼しすぎず、 path traversal 検証してから削除
          const p = safeResolve(SCREENSHOTS_DIR, rec.filename);
          unlinkSync(p);
        } catch { /* noop */ }
        screenshots.delete(id);
        return sendJson(res, 200, { id, removed: 1 });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        let p;
        try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        if (p.note === undefined) return sendJson(res, 400, { error: 'note required' });
        screenshots.updateNote(id, p.note === null ? null : String(p.note));
        return sendJson(res, 200, screenshots.getById(id));
      }
    }
    // GET /api/screenshots/:id/image  → 画像本体
    const imgM = url.match(/^\/api\/screenshots\/(\d+)\/image$/);
    if (imgM && method === 'GET') {
      const id = Number(imgM[1]);
      const rec = screenshots.getById(id);
      if (!rec) return sendJson(res, 404, { error: 'not found' });
      let path;
      try {
        path = safeResolve(SCREENSHOTS_DIR, rec.filename);
      } catch {
        return sendJson(res, 400, { error: 'invalid path' });
      }
      try {
        const buf = readFileSync(path);
        const ext = rec.filename.split('.').pop().toLowerCase();
        const ct = ext === 'png' ? 'image/png'
          : ext === 'webp' ? 'image/webp'
          : 'image/jpeg';
        res.writeHead(200, {
          'Content-Type': ct,
          'Cache-Control': 'private, max-age=3600',
          'Content-Length': buf.length,
        });
        res.end(buf);
        return;
      } catch (e) {
        return sendJson(res, 410, { error: 'file missing on disk', detail: String(e?.message || e) });
      }
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('screenshots error:', e);
    sendJson(res, 500, { error: String(e?.message || e) });
  }
}

server.listen(PORT, () => {
  console.log(`sidecar listening on http://localhost:${PORT}`);
  console.log(`bookmarks db: ${dbPath}`);
  console.log(`screenshots dir: ${SCREENSHOTS_DIR}`);
});
