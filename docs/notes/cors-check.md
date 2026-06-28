# CORS / HLS 再生可否の実機検証メモ

**結論: アプリ内 `hls.js` で直再生 OK。フォールバック実装は不要。**

検証日: 2026-06-27
対象 CDN: AWS Summit Japan 2026 の公開 CloudFront ディストリビューション
  (具体的なホスト名は `scripts/download.mjs` の `CDN_BASE` 定数を参照)

## 確認した 3 アセット

| アセット | レスポンスヘッダ抜粋 |
|---|---|
| HLS マスター m3u8 | `access-control-allow-origin: *` / `accept-ranges: bytes` / OPTIONS preflight も 200 |
| Variant playlist (`index_1.m3u8`) | マスターと同オリジン・同ヘッダ構成 |
| メディアセグメント (`*.ts`) | `access-control-allow-origin: *` / `accept-ranges: bytes` / `content-type: video/MP2T` |

## 検証コマンド (再現用)

`{slug}` には実際のセッション識別子を入れる (`data/catalog.json` の `hlsMaster` から抜ける)。

```bash
# HLS マスター URL を取得
SLUG="jpn-xxxNNN"   # 自分の data/catalog.json から有効な slug を選ぶ
MASTER=$(node -e "
const c = require('./data/catalog.json');
const e = c.find(x => x.slug === '$SLUG');
console.log(e?.hlsMaster);
")

# 1. マスター: CORS ヘッダ確認
curl -i -H "Origin: http://localhost:5173" "$MASTER"

# 2. プリフライト
curl -i -X OPTIONS \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: range" \
  "$MASTER"

# 3. メディアセグメント (実際の .ts URL は variant playlist から拾う)
```

## 実装上の含意

- `hls.js` でマスター m3u8 を `loadSource` し、`video.currentTime = startSec` で頭出しできる
- video 要素には `crossOrigin="anonymous"` を付ける (字幕やキャプチャ系で安全側)
- 認証不要のため、開発時もデプロイ後も同じ URL で動く
- ただし基調講演など、マスター m3u8 自体が 403 のセッションは再生不可
  → 一覧で「未公開」表示にする (`data/catalog.json` の `status` フィールドで判定)
