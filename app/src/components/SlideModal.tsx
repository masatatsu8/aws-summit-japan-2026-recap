import { useEffect } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  slug: string;
  page?: number;
  title?: string;
  onClose: () => void;
};

/**
 * スライド PDF をモーダルウィンドウで表示する共通コンポーネント。
 * - `iframe` でブラウザ標準の PDF ビューワーに `/api/slides/{slug}.pdf#page=N` を渡す
 * - ESC キー / 外側クリックで閉じる
 * - 表示中は body スクロールを無効化
 */
export default function SlideModal({ slug, page = 1, title, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const src = `/api/slides/${encodeURIComponent(slug)}.pdf#page=${page}&view=FitH&toolbar=1`;
  const dlUrl = `/api/slides/${encodeURIComponent(slug)}.pdf`;
  return createPortal(
    <div className="slide-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="slide-modal" onClick={(e) => e.stopPropagation()}>
        <div className="slide-modal-head">
          <div className="slide-modal-title">
            <span className="slide-modal-page-badge">p.{page}</span>
            {title && <span className="slide-modal-name">{title}</span>}
            <span className="slide-modal-slug">{slug}</span>
          </div>
          <div className="slide-modal-actions">
            <a href={dlUrl} target="_blank" rel="noreferrer" className="slide-modal-open">
              新しいタブで開く ↗
            </a>
            <button type="button" onClick={onClose} className="slide-modal-close" aria-label="閉じる">
              ✕
            </button>
          </div>
        </div>
        <iframe src={src} className="slide-modal-iframe" title={`${slug} p.${page}`} />
      </div>
    </div>,
    document.body,
  );
}
