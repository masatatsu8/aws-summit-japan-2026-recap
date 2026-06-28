// ブックマーク用 SQLite (Node 22+ 標準 `node:sqlite`) レイヤー
//
// DB ファイル: <repo-root>/data/bookmarks.db (環境変数 BOOKMARKS_DB で上書き可)
// テーブル: bookmarks (id / slug / start_sec / label / quote / note / created_at)
//   UNIQUE(slug, start_sec): 同じ引用は1回しか保存できない (toggle 用)
//
// 注意: `node:sqlite` は experimental (Node 22)。起動時に `--experimental-sqlite` が必要。
//       package.json の "sidecar" スクリプトに含めている。

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DEFAULT_DB = join(REPO_ROOT, 'data/bookmarks.db');
const DB_PATH = process.env.BOOKMARKS_DB || DEFAULT_DB;

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,
    start_sec   INTEGER NOT NULL,
    label       TEXT NOT NULL,
    quote       TEXT,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(slug, start_sec)
  );
  CREATE INDEX IF NOT EXISTS idx_bookmarks_slug ON bookmarks(slug);
  CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at DESC);

  CREATE TABLE IF NOT EXISTS lists (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    is_system    INTEGER NOT NULL DEFAULT 0,
    system_key   TEXT UNIQUE,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id      INTEGER NOT NULL,
    slug         TEXT NOT NULL,
    note         TEXT,
    added_at     INTEGER NOT NULL,
    UNIQUE(list_id, slug),
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);
  CREATE INDEX IF NOT EXISTS idx_list_items_slug ON list_items(slug);

  CREATE TABLE IF NOT EXISTS chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    role        TEXT NOT NULL,    -- 'user' | 'assistant'
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON chat_messages(chat_id, created_at);

  CREATE TABLE IF NOT EXISTS screenshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL,
    start_sec   INTEGER NOT NULL,
    filename    TEXT NOT NULL,    -- data/screenshots/ 配下の相対パス
    width       INTEGER,
    height      INTEGER,
    note        TEXT,
    title       TEXT,             -- 撮影時のシーンタイトル (active citation の label)
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_screenshots_slug ON screenshots(slug);
  CREATE INDEX IF NOT EXISTS idx_screenshots_created ON screenshots(created_at DESC);
`);

// 既存 DB に title カラムが無ければ追加 (migration)
{
  const cols = db.prepare(`PRAGMA table_info(screenshots)`).all();
  if (!cols.some((c) => c.name === 'title')) {
    db.exec(`ALTER TABLE screenshots ADD COLUMN title TEXT`);
  }
}

// 「後で見る」を最初の起動で投入 (system_key='watch_later')
{
  const row = db.prepare(`SELECT id FROM lists WHERE system_key = 'watch_later'`).get();
  if (!row) {
    db.prepare(
      `INSERT INTO lists (name, is_system, system_key, created_at) VALUES (?, 1, 'watch_later', ?)`,
    ).run('後で見る', Date.now());
  }
}

// Node 22 の node:sqlite では StatementSync の長期保持で finalize エラーが起きるため、
// 毎回 prepare する。SQLite 自体が prepare をキャッシュするので性能は問題ない。
const COL = `id, slug, start_sec AS startSec, label, quote, note, created_at AS createdAt`;

export const bookmarks = {
  list: () => db.prepare(`SELECT ${COL} FROM bookmarks ORDER BY created_at DESC`).all(),
  listBySlug: (slug) =>
    db
      .prepare(`SELECT ${COL} FROM bookmarks WHERE slug = ? ORDER BY start_sec ASC`)
      .all(slug),
  getByKey: (slug, startSec) =>
    db
      .prepare(`SELECT ${COL} FROM bookmarks WHERE slug = ? AND start_sec = ?`)
      .get(slug, startSec),
  getById: (id) => db.prepare(`SELECT ${COL} FROM bookmarks WHERE id = ?`).get(id),
  add: ({ slug, startSec, label, quote, note }) => {
    const info = db
      .prepare(
        `INSERT INTO bookmarks (slug, start_sec, label, quote, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(slug, startSec, label, quote ?? null, note ?? null, Date.now());
    return db.prepare(`SELECT ${COL} FROM bookmarks WHERE id = ?`).get(info.lastInsertRowid);
  },
  delete: (id) => Number(db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id).changes),
  updateNote: (id, note) =>
    Number(
      db.prepare(`UPDATE bookmarks SET note = ? WHERE id = ?`).run(note ?? null, id).changes,
    ),
};

// ---- Lists ----------------------------------------------------------------
const LIST_COL = `id, name, is_system AS isSystem, system_key AS systemKey, created_at AS createdAt`;
const ITEM_COL = `id, list_id AS listId, slug, note, added_at AS addedAt`;

function rowToList(row) {
  if (!row) return null;
  return { ...row, isSystem: Boolean(row.isSystem) };
}

export const lists = {
  /** 全リスト + 各リストのアイテム数 */
  listAll: () => {
    const rows = db
      .prepare(
        `SELECT ${LIST_COL},
                (SELECT COUNT(*) FROM list_items WHERE list_id = lists.id) AS itemCount
         FROM lists
         ORDER BY is_system DESC, created_at ASC`,
      )
      .all();
    return rows.map((r) => ({ ...rowToList(r), itemCount: Number(r.itemCount) }));
  },
  getById: (id) => rowToList(db.prepare(`SELECT ${LIST_COL} FROM lists WHERE id = ?`).get(id)),
  getBySystemKey: (key) =>
    rowToList(db.prepare(`SELECT ${LIST_COL} FROM lists WHERE system_key = ?`).get(key)),
  create: (name) => {
    const info = db
      .prepare(`INSERT INTO lists (name, is_system, system_key, created_at) VALUES (?, 0, NULL, ?)`)
      .run(name, Date.now());
    return rowToList(db.prepare(`SELECT ${LIST_COL} FROM lists WHERE id = ?`).get(info.lastInsertRowid));
  },
  rename: (id, name) =>
    Number(db.prepare(`UPDATE lists SET name = ? WHERE id = ? AND is_system = 0`).run(name, id).changes),
  delete: (id) =>
    Number(db.prepare(`DELETE FROM lists WHERE id = ? AND is_system = 0`).run(id).changes),
};

export const listItems = {
  byList: (listId) =>
    db
      .prepare(`SELECT ${ITEM_COL} FROM list_items WHERE list_id = ? ORDER BY added_at DESC`)
      .all(listId),
  byBookmarkExists: (slug) =>
    db.prepare(`SELECT list_id AS listId FROM list_items WHERE slug = ?`).all(slug),
  add: (listId, slug, note) => {
    try {
      const info = db
        .prepare(`INSERT INTO list_items (list_id, slug, note, added_at) VALUES (?, ?, ?, ?)`)
        .run(listId, slug, note ?? null, Date.now());
      return db.prepare(`SELECT ${ITEM_COL} FROM list_items WHERE id = ?`).get(info.lastInsertRowid);
    } catch (e) {
      // UNIQUE 違反なら既存を返す (idempotent)
      if (String(e.message || '').includes('UNIQUE')) {
        return db
          .prepare(`SELECT ${ITEM_COL} FROM list_items WHERE list_id = ? AND slug = ?`)
          .get(listId, slug);
      }
      throw e;
    }
  },
  remove: (listId, slug) =>
    Number(
      db
        .prepare(`DELETE FROM list_items WHERE list_id = ? AND slug = ?`)
        .run(listId, slug).changes,
    ),
  updateNote: (listId, slug, note) =>
    Number(
      db
        .prepare(`UPDATE list_items SET note = ? WHERE list_id = ? AND slug = ?`)
        .run(note ?? null, listId, slug).changes,
    ),
  membershipsOf: (slug) =>
    db
      .prepare(
        `SELECT list_id AS listId FROM list_items WHERE slug = ?`,
      )
      .all(slug)
      .map((r) => Number(r.listId)),
};

// ---- Chats ----------------------------------------------------------------
const CHAT_COL = `id, title, created_at AS createdAt, updated_at AS updatedAt`;
const MSG_COL = `id, chat_id AS chatId, role, content, created_at AS createdAt`;

export const chats = {
  listAll: () => {
    return db
      .prepare(
        `SELECT ${CHAT_COL},
                (SELECT COUNT(*) FROM chat_messages WHERE chat_id = chats.id) AS messageCount
         FROM chats ORDER BY updated_at DESC`,
      )
      .all()
      .map((r) => ({ ...r, messageCount: Number(r.messageCount) }));
  },
  get: (id) => db.prepare(`SELECT ${CHAT_COL} FROM chats WHERE id = ?`).get(id),
  create: (title = '') => {
    const now = Date.now();
    const info = db
      .prepare(`INSERT INTO chats (title, created_at, updated_at) VALUES (?, ?, ?)`)
      .run(title, now, now);
    return db.prepare(`SELECT ${CHAT_COL} FROM chats WHERE id = ?`).get(info.lastInsertRowid);
  },
  rename: (id, title) =>
    Number(
      db
        .prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`)
        .run(title, Date.now(), id).changes,
    ),
  touch: (id) =>
    db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(Date.now(), id),
  delete: (id) => Number(db.prepare(`DELETE FROM chats WHERE id = ?`).run(id).changes),
};

export const chatMessages = {
  byChat: (chatId) =>
    db
      .prepare(`SELECT ${MSG_COL} FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC`)
      .all(chatId),
  add: (chatId, role, content) => {
    const info = db
      .prepare(
        `INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(chatId, role, content, Date.now());
    chats.touch(chatId);
    return db.prepare(`SELECT ${MSG_COL} FROM chat_messages WHERE id = ?`).get(info.lastInsertRowid);
  },
};

// ---- Screenshots ----------------------------------------------------------
const SHOT_COL = `id, slug, start_sec AS startSec, filename, width, height, note, title, created_at AS createdAt`;

export const screenshots = {
  list: () => db.prepare(`SELECT ${SHOT_COL} FROM screenshots ORDER BY created_at DESC`).all(),
  bySlug: (slug) =>
    db
      .prepare(`SELECT ${SHOT_COL} FROM screenshots WHERE slug = ? ORDER BY start_sec ASC, created_at ASC`)
      .all(slug),
  getById: (id) => db.prepare(`SELECT ${SHOT_COL} FROM screenshots WHERE id = ?`).get(id),
  add: ({ slug, startSec, filename, width, height, note, title }) => {
    const info = db
      .prepare(
        `INSERT INTO screenshots (slug, start_sec, filename, width, height, note, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slug,
        startSec,
        filename,
        width ?? null,
        height ?? null,
        note ?? null,
        title ?? null,
        Date.now(),
      );
    return db.prepare(`SELECT ${SHOT_COL} FROM screenshots WHERE id = ?`).get(info.lastInsertRowid);
  },
  delete: (id) => Number(db.prepare(`DELETE FROM screenshots WHERE id = ?`).run(id).changes),
  updateNote: (id, note) =>
    Number(
      db.prepare(`UPDATE screenshots SET note = ? WHERE id = ?`).run(note ?? null, id).changes,
    ),
};

export const dbPath = DB_PATH;
