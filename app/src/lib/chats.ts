export type ChatMeta = {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
};

export type ChatMessage = {
  id: number;
  chatId: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
};

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}`);
  return (await res.json()) as T;
}

export const chatsApi = {
  list: () => http<ChatMeta[]>('GET', '/api/chats'),
  get: (id: number) => http<ChatMeta & { messages: ChatMessage[] }>('GET', `/api/chats/${id}`),
  create: (title = '') => http<ChatMeta>('POST', '/api/chats', { title }),
  rename: (id: number, title: string) => http<ChatMeta>('PATCH', `/api/chats/${id}`, { title }),
  delete: (id: number) => http<{ id: number; removed: number }>('DELETE', `/api/chats/${id}`),
  /** SSE で質問。ジェネレータで event ストリームを返す。 */
  async *ask(
    chatId: number,
    question: string,
    mode: 'full' | 'agent' = 'full',
  ): AsyncGenerator<{ event: string; data: { [k: string]: unknown } }> {
    const res = await fetch(`/api/chats/${chatId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\n\n/);
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const ev = parseSseBlock(part);
        if (ev) yield ev;
      }
    }
  },
};

function parseSseBlock(block: string): { event: string; data: { [k: string]: unknown } } | null {
  const lines = block.split('\n');
  let event = '';
  let dataStr = '';
  for (const l of lines) {
    if (l.startsWith('event:')) event = l.slice(6).trim();
    else if (l.startsWith('data:')) dataStr += l.slice(5).trim();
  }
  if (!event || !dataStr) return null;
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}
