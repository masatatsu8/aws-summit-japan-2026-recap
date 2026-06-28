import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import appData from '../data/app-data.json';
import type { AppData } from '../types';
import Player from '../components/Player';
import AddToListButton from '../components/AddToListButton';
import SlideModal from '../components/SlideModal';
import { useSessionBookmarks } from '../lib/bookmarks';
import { captureFrame, screenshotsApi, type Screenshot } from '../lib/screenshots';

const DATA = appData as unknown as AppData;

export default function SessionPage() {
  const { slug } = useParams<{ slug: string }>();
  const [sp] = useSearchParams();
  const session = slug ? DATA.sessions.find((s) => s.slug === slug) : undefined;
  const summary = slug ? DATA.summaries[slug] : undefined;
  const [seek, setSeek] = useState<number | null>(null);
  const { byStartSec, toggle } = useSessionBookmarks(slug);
  const [currentSec, setCurrentSec] = useState(0);
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [slidesOpen, setSlidesOpen] = useState(false);

  useEffect(() => {
    if (!slug) return;
    void screenshotsApi.bySlug(slug).then(setShots).catch(() => setShots([]));
  }, [slug]);

  const handleCapture = useCallback(
    async (video: HTMLVideoElement) => {
      if (!slug) return;
      const { dataUrl, width, height } = captureFrame(video);
      const sec = Math.floor(video.currentTime);
      // 撮影時の active citation を「シーン名」として保存。currentSec 基準で再計算 (state は古い可能性)
      let title: string | null = null;
      if (summary) {
        for (const c of summary.citations) {
          if (c.startSec <= sec) title = c.label;
          else break;
        }
      }
      const added = await screenshotsApi.add({
        slug,
        startSec: sec,
        dataUrl,
        width,
        height,
        title,
      });
      setShots((prev) => [...prev, added].sort((a, b) => a.startSec - b.startSec));
    },
    [slug, summary],
  );

  const removeShot = useCallback(async (id: number) => {
    await screenshotsApi.delete(id);
    setShots((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleTimeUpdate = useCallback((sec: number) => {
    // 1秒単位に量子化して setState 回数を抑制
    const q = Math.floor(sec);
    setCurrentSec((prev) => (prev === q ? prev : q));
  }, []);

  const activeIdx = useMemo(() => {
    if (!summary) return -1;
    let idx = -1;
    for (let i = 0; i < summary.citations.length; i++) {
      if (summary.citations[i].startSec <= currentSec) idx = i;
      else break;
    }
    return idx;
  }, [summary, currentSec]);

  const activeLiRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (activeIdx < 0 || !activeLiRef.current) return;
    activeLiRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  useEffect(() => {
    const t = sp.get('t');
    if (t != null) {
      const n = Number(t);
      if (Number.isFinite(n) && n >= 0) setSeek(n);
    }
  }, [sp]);

  if (!session) {
    return (
      <div className="session-page">
        <p>セッションが見つかりません: {slug}</p>
        <Link to="/">検索に戻る</Link>
      </div>
    );
  }

  // 字幕付き (= 文字起こし / 要約あり) のセッションのみ完全に "playable" と扱う。
  // status === 'captions-unavailable' のセッションは hlsMaster は v1 にフォールバックされて
  // 視聴自体は可能だが、 字幕オーバーレイは出ない。
  const playable = session.hasCaptions;
  const audioOnly = session.status === 'captions-unavailable';

  return (
    <div className="session-page">
      <div className="session-header">
        <Link to="/" className="back-link">
          ← 検索に戻る
        </Link>
        <h1>{session.title}</h1>
        <div className="session-meta">
          <span>{session.track}</span>
          {session.start && <span>{new Date(session.start).toLocaleString('ja-JP')}</span>}
          {session.durationMin != null && <span>{session.durationMin}分</span>}
          {session.officialUrl && (
            <a href={session.officialUrl} target="_blank" rel="noreferrer">
              公式ページ ↗
            </a>
          )}
          {session.slidesUrl && (
            <button
              type="button"
              className="session-slides-link"
              onClick={() => setSlidesOpen(true)}
            >
              📄 資料 (PDF)
            </button>
          )}
          {slug && <AddToListButton slug={slug} />}
        </div>
      </div>

      <div className="session-body">
        <div className="session-player">
          {playable ? (
            <Player
              hlsMaster={session.hlsMaster}
              seekToSec={seek}
              onTimeUpdate={handleTimeUpdate}
              onCapture={handleCapture}
            />
          ) : audioOnly ? (
            <>
              <Player
                hlsMaster={session.hlsMaster}
                seekToSec={seek}
                onTimeUpdate={handleTimeUpdate}
                onCapture={handleCapture}
              />
              <div className="player-notice">
                ⚠ このセッションは字幕 (VTT) が配信されておらず、 自動文字起こしと AI 要約は生成できません。
                映像 + 同時通訳音声 (jpn / eng) のみ視聴可能です。
              </div>
            </>
          ) : (
            <div className="player-fallback">
              このセッションはまだオンデマンド公開されていません（HLS マスターが 403）。公式ページで状況をご確認ください。
            </div>
          )}
        </div>

        <div className="session-summary">
          {summary ? (
            <>
              <section className="summary-tldr">
                <h2>要旨</h2>
                <p>{summary.tldr}</p>
              </section>
              <section className="summary-keypoints">
                <h2>キーポイント</h2>
                <ul>
                  {summary.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </section>
              <section className="summary-citations">
                <h2>引用 (クリックで頭出し)</h2>
                <ol>
                  {summary.citations.map((c, i) => {
                    const bookmarked = byStartSec.has(c.startSec);
                    const active = i === activeIdx;
                    const cls = [
                      'citation-li',
                      bookmarked && 'citation-li--bookmarked',
                      active && 'citation-li--active',
                      playable && 'citation-li--clickable',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <li
                        key={i}
                        ref={active ? activeLiRef : undefined}
                        className={cls}
                        role={playable ? 'button' : undefined}
                        tabIndex={playable ? 0 : undefined}
                        onClick={() => playable && setSeek(c.startSec)}
                        onKeyDown={(e) => {
                          if (!playable) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSeek(c.startSec);
                          }
                        }}
                        title={
                          playable
                            ? `クリックで ${c.timestamp ?? formatSec(c.startSec)} から再生`
                            : '本編未公開のため頭出しできません'
                        }
                      >
                        <div className="citation-button">
                          <span className="citation-time">
                            {c.timestamp ?? formatSec(c.startSec)}
                          </span>
                          <span className="citation-label">{c.label}</span>
                        </div>
                        <button
                          type="button"
                          className={`citation-bookmark ${bookmarked ? 'citation-bookmark--on' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggle({ startSec: c.startSec, label: c.label, quote: c.quote });
                          }}
                          title={bookmarked ? 'ブックマークを外す' : 'この引用をブックマーク'}
                          aria-pressed={bookmarked}
                        >
                          {bookmarked ? '★' : '☆'}
                        </button>
                        {c.quote && <p className="citation-quote">「{c.quote}」</p>}
                      </li>
                    );
                  })}
                </ol>
              </section>
              {shots.length > 0 && (
                <section className="summary-shots">
                  <h2>スクショ ({shots.length})</h2>
                  <ul className="shots-grid">
                    {shots.map((s) => (
                      <li key={s.id} className="shot-thumb">
                        <button
                          type="button"
                          className="shot-seek-btn"
                          onClick={() => setSeek(s.startSec)}
                          title={s.title ? `${formatSec(s.startSec)} - ${s.title}` : `${formatSec(s.startSec)} へ頭出し`}
                        >
                          <img src={screenshotsApi.imageUrl(s.id)} alt={`screenshot ${s.startSec}s`} />
                          <span className="shot-thumb-time">{formatSec(s.startSec)}</span>
                        </button>
                        {s.title && <div className="shot-thumb-scene">{s.title}</div>}
                        <button
                          type="button"
                          className="shot-thumb-del"
                          onClick={() => void removeShot(s.id)}
                          title="削除"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {summary.asrNote && (
                <section className="summary-asrnote">
                  <h3>注記</h3>
                  <p>{summary.asrNote}</p>
                </section>
              )}
            </>
          ) : (
            <p className="summary-pending">このセッションの要約はまだ生成されていません。</p>
          )}
        </div>
      </div>
      {slidesOpen && slug && (
        <SlideModal slug={slug} title={session.title} onClose={() => setSlidesOpen(false)} />
      )}
    </div>
  );
}

function formatSec(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
