#!/usr/bin/env node
// AWS Summit Japan 2026 — オンデマンド字幕(VTT)ダウンローダー & カタログ生成
//
// 機能:
//   1. 公開CMS(events.json)から全セッションのメタデータを取得し catalog.json を生成
//   2. 各セッションのHLSマスターm3u8から字幕トラック(JA/EN)を検出
//   3. 字幕プレイリストのVTTセグメントを取得・結合
//   4. data/vtt/{slug}.{lang}.vtt (生VTT) と
//      data/transcripts/{slug}.{lang}.txt (タイムスタンプ付き整形テキスト) を保存
//
// 認証不要: 字幕アセットはCloudFront上で公開配信されています。
// 実行: Node 18+ (グローバル fetch 使用)
//   node scripts/download.mjs            # 全セッション
//   node scripts/download.mjs jpn-xxxNNN jpn-xxxMMM      # 指定スラッグのみ
//
// 注意: 一部セッション (例: 基調講演など)はマスターm3u8が 403 を返す場合があり、
//        その場合はスキップして catalog.json の status に記録します。

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const VTT_DIR = join(DATA, 'vtt');
const TRANSCRIPT_DIR = join(DATA, 'transcripts');

const EVENT_ID = 'aws-summittyo26';
const EVENTS_JSON = `https://site-assets.corrivium.live/cms/events/${EVENT_ID}/root/prod/events.json`;
const CDN_BASE = `https://dz2ooo85w8eqv.cloudfront.net/${EVENT_ID}/outputs`;

const CONCURRENCY = 6;

// events.json 側でメタデータ登録漏れがあるセッションへの補完。
// AWS CMS のフィードでトピックタグ等が欠落しているとき、 ローカルで明示補完して
// Browse 画面の "NO TOPIC" カテゴリ落ちを防ぐ。
// 補完は events.json の値を上書きせず、 欠落しているプレフィックスだけを追加する。
const KNOWN_TAG_PATCHES = {
  // 2026-06-28 確認: events.json で「トピック:」が抜けているが、 タイトル / 内容から
  // 明らかに AI セッション (slug 接頭辞 aim も AI/ML 系トラック)。
  'jpn-aim229': ['トピック:Artificial Intelligence'],
};

function applyTagPatch(slug, rawTags) {
  const patches = KNOWN_TAG_PATCHES[slug];
  if (!patches || patches.length === 0) return rawTags;
  const existing = (rawTags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const additions = patches.filter((p) => {
    // 同じプレフィックス系がすでにあれば足さない (events.json 側が後から修正された場合の保護)
    const prefix = p.split(':')[0] + ':';
    return !existing.some((e) => e.startsWith(prefix));
  });
  if (additions.length === 0) return rawTags;
  return [...additions, ...existing].join(',');
}

// ---- ユーティリティ ----------------------------------------------------------

function hlsBase(slug, variant = 'v2') {
  return `${CDN_BASE}/${slug}/hls/${variant}/`;
}

function secToTimestamp(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function vttTimeToSec(t) {
  // 00:01:23.456 -> 83
  const [hh, mm, ss] = t.split(':');
  return Math.round(Number(hh) * 3600 + Number(mm) * 60 + parseFloat(ss));
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} for ${url}`);
    e.status = r.status;
    throw e;
  }
  return r.text();
}

// 同時実行数を制限して並列処理
async function pMap(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- 字幕の解析 --------------------------------------------------------------

// マスターm3u8から字幕(SUBTITLES)トラックを抽出
function parseSubtitleTracks(masterText) {
  const tracks = [];
  for (const line of masterText.split('\n')) {
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=SUBTITLES')) {
      const uri = line.match(/URI="([^"]+)"/);
      const lang = line.match(/LANGUAGE="([^"]+)"/);
      const name = line.match(/NAME="([^"]+)"/);
      if (uri) tracks.push({ uri: uri[1], lang: lang ? lang[1] : 'und', name: name ? name[1] : '' });
    }
  }
  return tracks;
}

// 言語コード(jpn/eng等)を JA/EN に正規化
function langCode(lang, name) {
  const l = (lang || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (l.startsWith('ja') || l === 'jpn' || n.includes('japan')) return 'ja';
  if (l.startsWith('en') || l === 'eng' || n.includes('english')) return 'en';
  return l.slice(0, 2) || 'xx';
}

// 字幕プレイリスト(m3u8)からVTTセグメントを取得・結合
async function fetchCaptionVtt(base, playlistUri) {
  const playlistUrl = new URL(playlistUri, base).href;
  const pl = await fetchText(playlistUrl);
  const segs = pl.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const parts = [];
  for (const seg of segs) {
    const segUrl = new URL(seg, playlistUrl).href;
    parts.push(await fetchText(segUrl));
  }
  return parts.join('\n');
}

// 結合VTT -> キュー配列 [{sec, text}]
function vttToCues(vtt) {
  const cues = [];
  for (const block of vtt.split(/\n\n+/)) {
    const m = block.match(/(\d\d:\d\d:\d\d\.\d+)\s*-->\s*(\d\d:\d\d:\d\d\.\d+)/);
    if (!m) continue;
    const text = block
      .split('\n')
      .filter((l) => !/-->/.test(l) && !/^WEBVTT/.test(l) && !/^X-TIMESTAMP/.test(l) && l.trim())
      .join(' ')
      .trim();
    if (!text) continue;
    cues.push({ sec: vttTimeToSec(m[1]), text });
  }
  return cues;
}

// キュー配列 -> "[mm:ss] テキスト" 形式の整形文字起こし
function cuesToTranscript(cues) {
  return cues.map((c) => `[${secToTimestamp(c.sec)}] ${c.text}`).join('\n');
}

// ---- メイン ------------------------------------------------------------------

async function main() {
  const onlySlugs = process.argv.slice(2);

  await mkdir(VTT_DIR, { recursive: true });
  await mkdir(TRANSCRIPT_DIR, { recursive: true });

  console.log('CMSカタログ(events.json)を取得中...');
  const events = await (await fetch(EVENTS_JSON)).json();
  const sessions = events.upcoming || []; // on-demand公開後も upcoming に全件入っている
  console.log(`  ${sessions.length} セッションを検出`);

  const catalog = [];

  const targets = onlySlugs.length
    ? sessions.filter((s) => onlySlugs.includes(s.sessionEventId))
    : sessions;

  await pMap(targets, async (s) => {
    const slug = s.sessionEventId || s.crvmEventId;
    const meta = {
      slug,
      title: s.eventtitle || s.crvmEventName || '',
      track: s.customCategory || '',
      description: s.description || '',
      filterTags: applyTagPatch(slug, s.filterTags || ''),
      start: s.eventStart || '',
      end: s.eventEnd || '',
      durationMin:
        s.eventStart && s.eventEnd
          ? Math.round((new Date(s.eventEnd) - new Date(s.eventStart)) / 60000)
          : null,
      officialUrl: `https://summitjapan.awslivestream.com/${slug}`,
      hlsMaster: `${hlsBase(slug)}index.m3u8`,
      captions: {}, // lang -> { vttFile, transcriptFile, cues }
      status: 'ok',
    };

    try {
      const master = await fetchText(meta.hlsMaster);
      const tracks = parseSubtitleTracks(master);
      if (tracks.length === 0) meta.status = 'no-captions';

      for (const t of tracks) {
        const lang = langCode(t.lang, t.name);
        try {
          const vtt = await fetchCaptionVtt(hlsBase(slug), t.uri);
          const cues = vttToCues(vtt);
          const transcript = cuesToTranscript(cues);

          const vttFile = `vtt/${slug}.${lang}.vtt`;
          const txtFile = `transcripts/${slug}.${lang}.txt`;
          await writeFile(join(DATA, vttFile), vtt, 'utf8');
          await writeFile(join(DATA, txtFile), transcript, 'utf8');

          meta.captions[lang] = {
            vttFile,
            transcriptFile: txtFile,
            cueCount: cues.length,
            durationSec: cues.length ? cues[cues.length - 1].sec : 0,
          };
        } catch (e) {
          meta.captions[lang] = { error: String(e.message || e) };
        }
      }
      console.log(`  [ok] ${slug} (${Object.keys(meta.captions).join(',') || 'none'})`);
    } catch (e) {
      // v2 が 403 のとき、 v1 (音声差し替えのみ・字幕なし) が公開されていることがある。
      // 字幕は取れないが、 視聴のためにマスター m3u8 を v1 に差し替えて status を区別する。
      if (e.status === 403) {
        try {
          const v1Url = `${hlsBase(slug, 'v1')}index.m3u8`;
          await fetchText(v1Url);
          meta.hlsMaster = v1Url;
          meta.status = 'captions-unavailable';
          meta.statusNote =
            '字幕 (VTT) は配信側で公開されておらず取得不可。 v1 パスで音声差し替え (jpn / eng 通訳音声) のみ視聴可能。';
          console.log(`  [audio-only] ${slug} -> v1 fallback (字幕なし)`);
        } catch (e2) {
          meta.status = 'forbidden-403';
          console.log(`  [skip] ${slug} -> ${meta.status} (v1 fallback も失敗)`);
        }
      } else {
        meta.status = `error: ${e.message}`;
        console.log(`  [skip] ${slug} -> ${meta.status}`);
      }
    }

    catalog.push(meta);
  });

  // カタログを track/slug 順に整列
  catalog.sort((a, b) => (a.track + a.slug).localeCompare(b.track + b.slug, 'ja'));

  await writeFile(join(DATA, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');

  const okCount = catalog.filter((c) => Object.keys(c.captions).length).length;
  console.log(`\n完了: ${catalog.length}件中 ${okCount}件で字幕取得。`);
  console.log(`  data/catalog.json / data/vtt/ / data/transcripts/ を出力しました。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
