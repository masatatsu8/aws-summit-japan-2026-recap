import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import { chatsApi, type ChatMessage, type ChatMeta } from '../lib/chats';
import { MarkdownRenderer } from '../lib/markdown';

type AskMode = 'full' | 'agent';
type SearchHit = { slug: string; title: string; track: string; score: number };
const MODE_STORAGE = 'aws-summit:askMode';
const SIDEBAR_WIDTH_STORAGE = 'aws-summit:askSidebarWidth';
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 560;
function loadMode(): AskMode {
  if (typeof window === 'undefined') return 'full';
  const v = window.localStorage.getItem(MODE_STORAGE);
  return v === 'agent' ? 'agent' : 'full';
}
function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH;
  const v = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE));
  return Number.isFinite(v) && v >= MIN_SIDEBAR_WIDTH && v <= MAX_SIDEBAR_WIDTH ? v : DEFAULT_SIDEBAR_WIDTH;
}

const DATA = appData as unknown as AppData;

export default function AskPage() {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  // 現在のチャット ID は URL search param で管理する。
  // (?chat=N) こうすることでブラウザの戻る/進むで AI 質問 → セッション詳細 → 戻る、 が
  // 直前のチャットに自然復元される。
  const [searchParams, setSearchParams] = useSearchParams();
  const currentId = useMemo(() => {
    const v = searchParams.get('chat');
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [searchParams]);
  const selectChat = useCallback(
    (id: number | null, opts?: { replace?: boolean }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id == null) next.delete('chat');
          else next.set('chat', String(id));
          return next;
        },
        { replace: opts?.replace ?? false },
      );
    },
    [setSearchParams],
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string>('');
  const [pendingSearchHits, setPendingSearchHits] = useState<SearchHit[] | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AskMode>(loadMode);
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  // メッセージ ID -> 検索ヒット (DB には保存しないので転送中のみ保持)
  const [searchHitsByMsgId, setSearchHitsByMsgId] = useState<Map<number, SearchHit[]>>(new Map());

  useEffect(() => {
    try { window.localStorage.setItem(MODE_STORAGE, mode); } catch { /* noop */ }
  }, [mode]);
  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE, String(sidebarWidth)); } catch { /* noop */ }
  }, [sidebarWidth]);

  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        const w = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startW + (ev.clientX - startX)));
        setSidebarWidth(w);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing-col');
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.classList.add('resizing-col');
    },
    [sidebarWidth],
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // 初期化: チャット一覧をロード。 URL に chat=N が無いときだけ最新を選ぶ。
  // (URL に既に chat= がある場合はそれを尊重する — back/forward 由来や直リンク)
  useEffect(() => {
    void (async () => {
      const list = await chatsApi.list();
      setChats(list);
      if (currentId == null && list.length > 0) {
        // 初期選択は履歴を増やさず replace で
        selectChat(list[0].id, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // セッション詳細から戻ったとき、 messages 内スクロール位置を復元するためのフラグ。
  // currentId が変わったときに「次の messages 適用で復元を試みる」と立てる。
  const restoreScrollOnceRef = useRef(false);

  // currentId 変更時にメッセージ取得
  useEffect(() => {
    if (currentId == null) {
      setMessages([]);
      return;
    }
    restoreScrollOnceRef.current = true;
    void (async () => {
      const d = await chatsApi.get(currentId);
      setMessages(d.messages);
    })();
  }, [currentId]);

  // messages 内コンテナのスクロール位置を sessionStorage に保存
  // (back で戻ってきたときに復元するため)
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || currentId == null) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          window.sessionStorage.setItem(`aws-summit:askScroll:${currentId}`, String(el.scrollTop));
        } catch { /* noop */ }
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
    };
  }, [currentId]);

  // スクロール制御:
  //   1. currentId 変更直後 (restoreScrollOnceRef === true) はセッションストレージから復元
  //      → AI 質問 → セッション詳細 → back のフローで読んでいた位置に戻る
  //   2. それ以外 (streaming 中の差分追加など) は「現在ユーザーが末尾近くにいるなら」末尾追従
  //      → 途中まで戻って読み返している最中に勝手に末尾に飛ばされないようにする
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (restoreScrollOnceRef.current && currentId != null) {
      restoreScrollOnceRef.current = false;
      try {
        const saved = window.sessionStorage.getItem(`aws-summit:askScroll:${currentId}`);
        if (saved != null) {
          const n = Number(saved);
          if (Number.isFinite(n)) {
            el.scrollTop = n;
            return;
          }
        }
      } catch { /* noop */ }
      // 復元値が無ければ末尾に
      el.scrollTop = el.scrollHeight;
      return;
    }
    // 末尾追従: ユーザーが末尾近く (~120px) を見ている場合だけスクロール
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, pendingUser, pendingAssistant, currentId]);

  const refreshChats = useCallback(async () => {
    setChats(await chatsApi.list());
  }, []);

  const newChat = useCallback(async () => {
    const c = await chatsApi.create('');
    await refreshChats();
    selectChat(c.id);
    setMessages([]);
    setInput('');
    inputRef.current?.focus();
  }, [refreshChats, selectChat]);

  const submit = useCallback(async () => {
    const q = input.trim();
    if (!q || streaming) return;
    setInput('');
    setStreaming(true);
    setPendingUser(q);
    setPendingAssistant('');
    setPendingSearchHits(null);
    // チャット未選択なら作成
    let chatId = currentId;
    if (chatId == null) {
      const c = await chatsApi.create('');
      chatId = c.id;
      selectChat(chatId);
      await refreshChats();
    }
    let turnSearchHits: SearchHit[] | null = null;
    try {
      for await (const ev of chatsApi.ask(chatId, q, mode)) {
        if (ev.event === 'user_message') {
          setMessages((m) => [...m, ev.data as unknown as ChatMessage]);
          setPendingUser(null);
        } else if (ev.event === 'search_results') {
          turnSearchHits = (ev.data.hits || []) as SearchHit[];
          setPendingSearchHits(turnSearchHits);
        } else if (ev.event === 'text') {
          setPendingAssistant((prev) => prev + String((ev.data as { text?: string }).text || ''));
        } else if (ev.event === 'assistant_message') {
          const msg = ev.data as unknown as ChatMessage;
          setMessages((m) => [...m, msg]);
          if (turnSearchHits && turnSearchHits.length > 0) {
            const hits = turnSearchHits;
            setSearchHitsByMsgId((prev) => new Map(prev).set(msg.id, hits));
          }
          setPendingAssistant('');
          setPendingSearchHits(null);
        } else if (ev.event === 'chat_renamed') {
          refreshChats();
        } else if (ev.event === 'error') {
          alert(`エラー: ${(ev.data as { message?: string }).message || 'unknown'}`);
        }
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
      setPendingUser(null);
      setPendingAssistant('');
      setPendingSearchHits(null);
    }
  }, [input, streaming, currentId, refreshChats, mode, pendingSearchHits, selectChat]);

  const deleteChat = useCallback(
    async (id: number) => {
      if (!confirm('このチャットを削除しますか?')) return;
      await chatsApi.delete(id);
      const list = await chatsApi.list();
      setChats(list);
      if (currentId === id) {
        selectChat(list[0]?.id ?? null, { replace: true });
        setMessages([]);
      }
    },
    [currentId, selectChat],
  );

  const renameChat = useCallback(
    async (id: number, title: string) => {
      await chatsApi.rename(id, title);
      await refreshChats();
    },
    [refreshChats],
  );

  return (
    <div
      className="ask-page"
      style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
    >
      <aside className="chat-sidebar">
        <button type="button" className="chat-new-btn" onClick={() => void newChat()}>
          + 新しいチャット
        </button>
        <ul className="chat-list">
          {chats.map((c) => (
            <ChatRow
              key={c.id}
              c={c}
              active={c.id === currentId}
              onSelect={() => selectChat(c.id)}
              onDelete={() => void deleteChat(c.id)}
              onRename={(title) => void renameChat(c.id, title)}
            />
          ))}
          {chats.length === 0 && <li className="chat-empty">まだチャットはありません</li>}
        </ul>
        <div className="chat-sidebar-foot">
          {DATA.sessions.length} セッション / {DATA.sessions.filter((s) => s.hasSummary).length} 要約済
        </div>
      </aside>
      <div
        className="chat-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="サイドバーの幅"
        title="ドラッグで幅を変更、ダブルクリックで初期幅にリセット"
        onMouseDown={onResizerMouseDown}
        onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      />
      <section className="chat-main">
        <div className="chat-messages" ref={messagesRef}>
          {messages.length === 0 && !pendingUser && (
            <div className="chat-welcome">
              <h2>AWS Summit Japan 2026 Recap — セッション案内 AI</h2>
              <p>
                セッションの内容について自然な日本語で質問できます。「Bedrock のセキュリティについて話してたセッションは？」
                「Iceberg をやってる事例ある？」のように聞いてみてください。
              </p>
              <ul>
                <li>回答はチャット履歴の文脈を踏まえます (直近 12 メッセージ)</li>
                <li>左サイドバーで過去のチャットに戻れます</li>
                <li>引用された <Link to="/">セッション名</Link> をクリックして詳細へ</li>
              </ul>
            </div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} searchHits={searchHitsByMsgId.get(m.id)} />
          ))}
          {pendingUser && (
            <MessageRow
              message={{
                id: -1,
                chatId: -1,
                role: 'user',
                content: pendingUser,
                createdAt: Date.now(),
              }}
            />
          )}
          {streaming && (pendingSearchHits || pendingAssistant) && (
            <MessageRow
              message={{
                id: -2,
                chatId: -1,
                role: 'assistant',
                content: pendingAssistant || ' ',
                createdAt: Date.now(),
              }}
              searchHits={pendingSearchHits ?? undefined}
              streaming
            />
          )}
        </div>
        <div className="chat-mode-row">
          <div className="chat-mode-toggle" role="group" aria-label="検索モード">
            <button
              type="button"
              className={`chat-mode-btn ${mode === 'full' ? 'chat-mode-btn--active' : ''}`}
              onClick={() => setMode('full')}
              title="全 133 セッションの要旨を常に systemPrompt に入れて回答 (動的エンリッチあり)"
            >
              全件知識
            </button>
            <button
              type="button"
              className={`chat-mode-btn ${mode === 'agent' ? 'chat-mode-btn--active' : ''}`}
              onClick={() => setMode('agent')}
              title="質問から関連セッションを検索 → 上位 8 件の citations だけを文脈に投入して回答"
            >
              エージェント検索
            </button>
          </div>
          <span className="chat-mode-hint">
            {mode === 'agent'
              ? '※ 質問から関連セッションを検索 → ヒットしたものの citations から回答'
              : '※ 全セッションの要旨 + 言及済みの詳細を文脈に常時保持'}
          </span>
        </div>
        <div className="chat-composer">
          <textarea
            ref={inputRef}
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="質問を入力 (⌘/Ctrl + Enter で送信)"
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={() => void submit()}
            disabled={streaming || !input.trim()}
          >
            {streaming ? '回答中…' : '送信'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChatRow({
  c,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  c: ChatMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  useEffect(() => setDraft(c.title), [c.title]);

  return (
    <li className={`chat-row ${active ? 'chat-row--active' : ''}`}>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim()) onRename(draft.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (draft.trim()) onRename(draft.trim());
              setEditing(false);
            } else if (e.key === 'Escape') {
              setDraft(c.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="chat-row-btn"
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          title={`${c.title || '(無題)'} — ${fmtRel(c.updatedAt)}`}
        >
          <span className="chat-row-title">{c.title || '(無題)'}</span>
          <span className="chat-row-meta">{c.messageCount ?? 0}件</span>
        </button>
      )}
      {!editing && (
        <button type="button" className="chat-row-del" onClick={onDelete} title="削除">
          ✕
        </button>
      )}
    </li>
  );
}

function MessageRow({
  message,
  streaming,
  searchHits,
}: {
  message: ChatMessage;
  streaming?: boolean;
  searchHits?: SearchHit[];
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg-bubble">
        {isUser ? (
          <div className="msg-user-text">{message.content}</div>
        ) : (
          <>
            {searchHits && searchHits.length > 0 && <SearchHitsView hits={searchHits} />}
            <div className="msg-assistant-text">
              <MarkdownRenderer text={message.content} />
              {streaming && <span className="cursor-blink">▍</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SearchHitsView({ hits }: { hits: SearchHit[] }) {
  return (
    <details className="msg-search">
      <summary>
        🔎 検索ヒット {hits.length} 件
        <span className="msg-search-top">
          {hits
            .slice(0, 3)
            .map((h) => h.slug)
            .join(', ')}
          {hits.length > 3 && ' ...'}
        </span>
      </summary>
      <ul className="msg-search-list">
        {hits.map((h) => (
          <li key={h.slug} className="msg-search-li">
            <Link to={`/sessions/${h.slug}`} className="msg-search-link">
              <span className="msg-search-score">{h.score.toFixed(1)}</span>
              <span className="msg-search-slug">{h.slug}</span>
              <span className="msg-search-title">{h.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function fmtRel(ms: number) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return `${Math.floor(sec / 86400)}日前`;
}

