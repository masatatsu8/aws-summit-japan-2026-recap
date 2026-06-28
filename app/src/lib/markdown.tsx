// 軽量マークダウンレンダラ
// 対応: 段落 (空行区切り) / `**bold**` / `*italic*` / `- リスト` / 水平線 (---)
// + 既存の [CITE:slug=... start=...] / [SESSION:slug=...] タグをチップ化
// セキュリティ: 入力文字列はそのまま React のテキストノードとして配置されるので XSS は無し。

import { Fragment, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import SlideModal from '../components/SlideModal';

const DATA = appData as unknown as AppData;
const SESSIONS_BY_SLUG = new Map(DATA.sessions.map((s) => [s.slug, s]));

/** トップレベル: ブロックをレンダリング */
export function MarkdownRenderer({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b)}</Fragment>
      ))}
    </>
  );
}

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'list'; items: string[] }
  | { type: 'hr' }
  | { type: 'h'; level: number; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

/** マークダウンテーブルが 1 行に詰め込まれて来た場合、 `|...|...||` の `||` 間に改行を入れる */
function preprocessTables(text: string): string {
  // パイプの並びが「閉じ | + 開き |」になっている場合に改行を入れる
  // 例: "|セル1|セル2||---|---||a|b|" → "|セル1|セル2|\n|---|---|\n|a|b|"
  // ヘッダ + セパレータ + 行のパターンを検出した時だけ適用
  if (!/\|[\s\-:]+\|[\s\-:|]+\|/.test(text)) return text;
  return text.replace(/\|(?=\|[\-:\s|]+\|)/g, '|\n').replace(/\|(?=\|[^|\n]+\|)/g, (match, _, idx, full) => {
    // ヘッダ/セパレータの後で出現する `||` だけ改行する (誤検出を避ける heuristic)
    const before = full.slice(Math.max(0, idx - 200), idx);
    if (/\|[\s\-:|]+\|$/.test(before)) return '|\n';
    return match;
  });
}

const TABLE_ROW_RE = /^\|.*\|$/;
const TABLE_SEP_RE = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;

function splitPipeRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function parseBlocks(text: string): Block[] {
  text = preprocessTables(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      i++;
      continue;
    }
    if (/^-{3,}$/.test(trimmed) || /^_{3,}$/.test(trimmed)) {
      flush();
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    // 見出し (# 〜 ####)
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flush();
      blocks.push({ type: 'h', level: hMatch[1].length, text: hMatch[2] });
      i++;
      continue;
    }
    // テーブル: ヘッダ行 + セパレータ行 + 0 行以上のデータ行
    if (TABLE_ROW_RE.test(trimmed) && lines[i + 1] && TABLE_SEP_RE.test(lines[i + 1].trim())) {
      flush();
      const headers = splitPipeRow(trimmed);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j].trim())) {
        rows.push(splitPipeRow(lines[j].trim()));
        j++;
      }
      blocks.push({ type: 'table', headers, rows });
      i = j;
      continue;
    }
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      if (cur?.type !== 'list') {
        flush();
        cur = { type: 'list', items: [] };
      }
      cur.items.push(listMatch[1]);
      i++;
      continue;
    }
    // 通常段落 (行は join するが、改行は <br> として保持しない: スペース結合)
    if (cur?.type !== 'p') {
      flush();
      cur = { type: 'p', lines: [] };
    }
    cur.lines.push(line);
    i++;
  }
  flush();
  return blocks;
}

function renderBlock(block: Block): ReactNode {
  if (block.type === 'hr') return <hr className="md-hr" />;
  if (block.type === 'h') {
    const inner = renderInline(block.text);
    if (block.level <= 2) return <h2 className="md-h2">{inner}</h2>;
    if (block.level === 3) return <h3 className="md-h3">{inner}</h3>;
    return <h4 className="md-h4">{inner}</h4>;
  }
  if (block.type === 'table') {
    return (
      <div className="md-table-wrap">
        <table className="md-table">
          <thead>
            <tr>
              {block.headers.map((h, i) => (
                <th key={i}>{renderInline(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{renderInline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === 'list') {
    return (
      <ul className="md-ul">
        {block.items.map((it, i) => (
          <li key={i}>{renderInline(it)}</li>
        ))}
      </ul>
    );
  }
  // p: 行を結合して空白で繋ぐ (改行 1 つは段落内の継続行扱い)
  const text = block.lines.join(' ').replace(/\s+/g, ' ').trim();
  return <p className="md-p">{renderInline(text)}</p>;
}

/** インライン要素: **bold** / *italic* / [CITE:..] / [SESSION:..] */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 1パスで全パターンを切り出す: bold/italic は ** と * のみ、引用タグは [CITE:..] / [SESSION:..]
  const tokens = tokenize(text);
  let citeCounter = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'text') out.push(t.value);
    else if (t.kind === 'bold') out.push(<strong key={`b${i}`}>{renderInline(t.value)}</strong>);
    else if (t.kind === 'italic') out.push(<em key={`i${i}`}>{renderInline(t.value)}</em>);
    else if (t.kind === 'cite')
      out.push(<CiteChip key={`c${i}-${citeCounter++}`} slug={t.slug} startSec={t.startSec} />);
    else if (t.kind === 'session')
      out.push(<SessionTitleLink key={`s${i}`} slug={t.slug} />);
    else if (t.kind === 'slide')
      out.push(<SlideChip key={`sl${i}-${citeCounter++}`} slug={t.slug} page={t.page} />);
  }
  return out;
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'cite'; slug: string; startSec: number }
  | { kind: 'session'; slug: string }
  | { kind: 'slide'; slug: string; page: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf) {
      tokens.push({ kind: 'text', value: buf });
      buf = '';
    }
  };
  while (i < text.length) {
    // [CITE:slug=... start=N]
    if (text.startsWith('[CITE:', i)) {
      const close = text.indexOf(']', i);
      if (close > 0) {
        const body = text.slice(i + 6, close).trim();
        const pairs = parsePairs(body);
        const slug = pairs.slug || '';
        const startSec = Number(pairs.start || 0);
        if (slug) {
          flush();
          tokens.push({ kind: 'cite', slug, startSec });
          i = close + 1;
          continue;
        }
      }
    }
    // [SESSION:slug=...]
    if (text.startsWith('[SESSION:', i)) {
      const close = text.indexOf(']', i);
      if (close > 0) {
        const body = text.slice(i + 9, close).trim();
        const pairs = parsePairs(body);
        const slug = pairs.slug || '';
        if (slug) {
          flush();
          tokens.push({ kind: 'session', slug });
          i = close + 1;
          continue;
        }
      }
    }
    // [SLIDE:slug=... page=N]
    if (text.startsWith('[SLIDE:', i)) {
      const close = text.indexOf(']', i);
      if (close > 0) {
        const body = text.slice(i + 7, close).trim();
        const pairs = parsePairs(body);
        const slug = pairs.slug || '';
        const page = Number(pairs.page || 0);
        if (slug && page > 0) {
          flush();
          tokens.push({ kind: 'slide', slug, page });
          i = close + 1;
          continue;
        }
      }
    }
    // **bold**
    if (text.startsWith('**', i)) {
      const close = text.indexOf('**', i + 2);
      if (close > i + 2) {
        const inner = text.slice(i + 2, close);
        // 改行を含む bold は誤検出を避けるため許可しない
        if (!inner.includes('\n')) {
          flush();
          tokens.push({ kind: 'bold', value: inner });
          i = close + 2;
          continue;
        }
      }
    }
    // *italic*
    if (text[i] === '*' && text[i + 1] !== ' ' && text[i + 1] !== '*') {
      const close = text.indexOf('*', i + 1);
      if (close > i + 1) {
        const inner = text.slice(i + 1, close);
        if (!inner.includes('\n')) {
          flush();
          tokens.push({ kind: 'italic', value: inner });
          i = close + 1;
          continue;
        }
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return tokens;
}

function parsePairs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(/\s+/)) {
    const [k, ...v] = part.split('=');
    if (!k) continue;
    out[k] = v.join('=');
  }
  return out;
}

// ---- inline 要素 ----------------------------------------------------------
function CiteChip({ slug, startSec }: { slug: string; startSec: number }) {
  const nav = useNavigate();
  const s = SESSIONS_BY_SLUG.get(slug);
  const mm = Math.floor(startSec / 60);
  const ss = startSec % 60;
  const label = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return (
    <button
      type="button"
      className="cite-chip"
      title={s ? `${s.title} の ${label} へ` : `${slug} の ${label}`}
      onClick={() => nav(`/sessions/${slug}?t=${startSec}`)}
    >
      <span className="cite-chip-slug">{slug}</span>
      <span className="cite-chip-time">{label}</span>
    </button>
  );
}

function SessionTitleLink({ slug }: { slug: string }) {
  const s = SESSIONS_BY_SLUG.get(slug);
  if (!s) return <code>{slug}</code>;
  return (
    <Link to={`/sessions/${slug}`} className="session-link">
      {s.title}
    </Link>
  );
}

function SlideChip({ slug, page }: { slug: string; page: number }) {
  const [open, setOpen] = useState(false);
  const s = SESSIONS_BY_SLUG.get(slug);
  if (!s?.hasSlides) {
    // PDF が無いセッションの参照は無効。fallback としてセッションリンク。
    return <SessionTitleLink slug={slug} />;
  }
  return (
    <>
      <button
        type="button"
        className="slide-chip"
        onClick={() => setOpen(true)}
        title={`${s.title} のスライド ${page} ページ目を開く`}
      >
        <span className="slide-chip-slug">{slug}</span>
        <span className="slide-chip-page">📄 p.{page}</span>
      </button>
      {open && <SlideModal slug={slug} page={page} title={s.title} onClose={() => setOpen(false)} />}
    </>
  );
}

