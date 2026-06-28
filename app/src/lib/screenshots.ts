export type Screenshot = {
  id: number;
  slug: string;
  startSec: number;
  filename: string;
  width: number | null;
  height: number | null;
  note: string | null;
  title: string | null;
  createdAt: number;
};

export type NewScreenshot = {
  slug: string;
  startSec: number;
  dataUrl: string;
  width?: number;
  height?: number;
  note?: string | null;
  title?: string | null;
};

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${url}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const screenshotsApi = {
  list: () => http<Screenshot[]>('GET', '/api/screenshots'),
  bySlug: (slug: string) => http<Screenshot[]>('GET', `/api/screenshots/by-slug/${encodeURIComponent(slug)}`),
  add: (s: NewScreenshot) => http<Screenshot>('POST', '/api/screenshots', s),
  delete: (id: number) => http<{ id: number; removed: number }>('DELETE', `/api/screenshots/${id}`),
  updateNote: (id: number, note: string | null) =>
    http<Screenshot>('PATCH', `/api/screenshots/${id}`, { note }),
  imageUrl: (id: number) => `/api/screenshots/${id}/image`,
};

/** video 要素から現在のフレームを PNG dataUrl で取得 */
export function captureFrame(video: HTMLVideoElement): { dataUrl: string; width: number; height: number } {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  };
}
