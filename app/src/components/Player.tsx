import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

type Props = {
  hlsMaster: string;
  seekToSec: number | null;
  onTimeUpdate?: (sec: number) => void;
  onCapture?: (video: HTMLVideoElement) => void | Promise<void>;
};

/**
 * HLS プレイヤー + カスタム字幕表示。
 * - Chrome/Firefox/Edge: hls.js (subtitleDisplay=false でネイティブの字幕オーバーレイを無効化)
 * - Safari: ネイティブ video[src]
 * - 字幕は video の下のエリアに表示。サイズはユーザーが選択 (localStorage で保存)。
 */
const CAPTION_SIZES = [
  { key: 'sm', label: 'S', px: 13 },
  { key: 'md', label: 'M', px: 16 },
  { key: 'lg', label: 'L', px: 20 },
  { key: 'xl', label: 'XL', px: 26 },
  { key: '2xl', label: '2XL', px: 34 },
] as const;
type CaptionSizeKey = (typeof CAPTION_SIZES)[number]['key'];
const CAPTION_SIZE_STORAGE = 'aws-summit:captionSize';

function loadCaptionSize(): CaptionSizeKey {
  if (typeof window === 'undefined') return 'lg';
  const v = window.localStorage.getItem(CAPTION_SIZE_STORAGE);
  if (v && CAPTION_SIZES.some((s) => s.key === v)) return v as CaptionSizeKey;
  return 'lg';
}

export default function Player({ hlsMaster, seekToSec, onTimeUpdate, onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const readyRef = useRef(false);
  const [captionText, setCaptionText] = useState('');
  const [captionSize, setCaptionSize] = useState<CaptionSizeKey>(loadCaptionSize);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(CAPTION_SIZE_STORAGE, captionSize);
    } catch {
      /* noop */
    }
  }, [captionSize]);

  const captionPx = CAPTION_SIZES.find((s) => s.key === captionSize)?.px ?? 20;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    readyRef.current = false;
    setCaptionText('');

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      // ネイティブの字幕オーバーレイは出さない (アプリ側で描画する)
      // (hls.js v1 の subtitleDisplay は型定義に含まれていないため後段で抑止する)
      hlsRef.current = hls;
      hls.loadSource(hlsMaster);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        readyRef.current = true;
        const tracks = hls.subtitleTracks || [];
        const ja = tracks.findIndex(
          (t) => /jpn|ja/i.test(String(t.lang || '')) || /Japanese/i.test(String(t.name || '')),
        );
        if (ja >= 0) hls.subtitleTrack = ja;
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else {
      video.src = hlsMaster;
      const onLoaded = () => {
        readyRef.current = true;
      };
      video.addEventListener('loadedmetadata', onLoaded);
      return () => video.removeEventListener('loadedmetadata', onLoaded);
    }
  }, [hlsMaster]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const trackList = video.textTracks;
    const handlersByTrack = new Map<TextTrack, () => void>();

    const isJapanese = (tt: TextTrack) =>
      /^ja|jpn/i.test(tt.language || '') || /Japanese|日本/i.test(tt.label || '');

    const wire = () => {
      let activeJa: TextTrack | null = null;
      for (let i = 0; i < trackList.length; i++) {
        const tt = trackList[i];
        if (tt.kind === 'subtitles' || tt.kind === 'captions') {
          if (isJapanese(tt)) {
            if (tt.mode !== 'hidden') tt.mode = 'hidden';
            activeJa = tt;
          } else {
            if (tt.mode !== 'disabled') tt.mode = 'disabled';
          }
        }
      }
      if (!activeJa) {
        for (let i = 0; i < trackList.length; i++) {
          const tt = trackList[i];
          if (tt.kind === 'subtitles' || tt.kind === 'captions') {
            if (tt.mode !== 'hidden') tt.mode = 'hidden';
            activeJa = tt;
            break;
          }
        }
      }
      if (!activeJa) return;

      if (!handlersByTrack.has(activeJa)) {
        const tt = activeJa;
        const h = () => {
          const cues = tt.activeCues;
          if (!cues || cues.length === 0) {
            setCaptionText('');
            return;
          }
          const text = [...(cues as unknown as TextTrackCue[])]
            .map((c) => (c as unknown as VTTCue).text || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          setCaptionText(text);
        };
        tt.addEventListener('cuechange', h);
        handlersByTrack.set(tt, h);
      }
    };

    wire();
    trackList.addEventListener('addtrack', wire);
    trackList.addEventListener('change', wire);

    return () => {
      trackList.removeEventListener('addtrack', wire);
      trackList.removeEventListener('change', wire);
      for (const [tt, h] of handlersByTrack) tt.removeEventListener('cuechange', h);
    };
  }, [hlsMaster]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onTimeUpdate) return;
    const h = () => onTimeUpdate(video.currentTime);
    video.addEventListener('timeupdate', h);
    video.addEventListener('seeked', h);
    return () => {
      video.removeEventListener('timeupdate', h);
      video.removeEventListener('seeked', h);
    };
  }, [onTimeUpdate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || seekToSec == null) return;
    const apply = () => {
      try {
        video.currentTime = seekToSec;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* noop */
      }
    };
    if (readyRef.current && (video.readyState >= 1 || video.duration > 0)) {
      apply();
    } else {
      const onReady = () => {
        readyRef.current = true;
        apply();
        video.removeEventListener('loadedmetadata', onReady);
      };
      video.addEventListener('loadedmetadata', onReady);
      return () => video.removeEventListener('loadedmetadata', onReady);
    }
  }, [seekToSec]);

  return (
    <div className="player-wrap">
      <div className="player-video-area">
        <video ref={videoRef} controls crossOrigin="anonymous" playsInline className="player" />
        {flashing && (
          <>
            <div className="player-flash" aria-hidden="true" />
            <div className="player-flash-ring" aria-hidden="true">📸 captured</div>
          </>
        )}
      </div>
      <div className="player-caption-bar">
        <div
          className="player-caption"
          style={{ fontSize: `${captionPx}px` }}
          aria-live="polite"
          aria-atomic="true"
        >
          {captionText || ' '}
        </div>
        <div className="player-caption-size" role="group" aria-label="字幕サイズ">
          <span className="player-caption-size-label">字幕</span>
          {CAPTION_SIZES.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`caption-size-btn ${captionSize === s.key ? 'caption-size-btn--active' : ''}`}
              onClick={() => setCaptionSize(s.key)}
              title={`字幕サイズ ${s.label} (${s.px}px)`}
            >
              {s.label}
            </button>
          ))}
          {onCapture && (
            <button
              type="button"
              className="player-capture-btn"
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                setFlashing(true);
                window.setTimeout(() => setFlashing(false), 360);
                void onCapture(v);
              }}
              title="現在のフレームをスクリーンショットとして保存"
            >
              📷
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
