# 目黒区・大田区 町丁別世帯数地図

国土地理院の境界データ（Shapefile）と Excel の世帯数データを使い、Mapbox で目黒区・大田区の町丁エリアと合計世帯数を表示する地図です。

## 必要なもの

- Node.js 18+
- [Mapbox](https://www.mapbox.com/) のアクセストークン（無料で取得可能）

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. GML と Excel からデータを生成

```bash
npm run build
```

- `geojson/meguro-chome-areas.json` … 目黒区の町丁ポリゴン（GML から変換）
- `geojson/chome-households.json` … 町丁ごとの座標・合計世帯数・共同住宅世帯数（Excel と CommPt をマージ）
- `geojson/meguro-shapefile-areas.json` … 境界データ（Shapefile）から変換した町丁ポリゴン（`npm run build:shapefile` で生成。`A002005212020DDSWC13110-JGD2011/` に r2ka13110.\* が必要）

### 3. トークン・API キーの設定

1. `config.js.example` を `config.js` にコピー
2. **MAPBOX_ACCESS_TOKEN** … 地図表示用。[Mapbox](https://www.mapbox.com/) で取得
3. **GOOGLE_MAPS_API_KEY** … 演説スポットのジオコーディング用。[Google Cloud](https://console.cloud.google.com/) で Geocoding API を有効にし、API キーを発行

```bash
cp config.js.example config.js
# config.js を編集して MAPBOX_ACCESS_TOKEN と GOOGLE_MAPS_API_KEY を設定
```

### 4. 地図の表示

ローカルで HTTP サーバーを起動して開いてください（ファイルを直接開くと CORS で GeoJSON が読めません）。

```bash
npx serve .
```

ブラウザで http://localhost:3000 を開きます。

## 機能

- **町丁ポリゴン**: 目黒区の町丁境界を色付きで表示
- **合計世帯数**: 各町丁の代表位置に合計世帯数を表示（最低条件）
- **円グラフ表示**（理想）: チェックボックスで「円グラフ表示」をオンにすると、共同住宅 3～5階建 / 6～10階建 の内訳を円グラフで表示し、ラベルに合計世帯数を表示
- **クリック**: 町丁をクリックするとポップアップで町丁名・合計世帯数・共同住宅世帯数を表示

## フォルダ構成

- `A002005212020DDSWC13110-JGD2011/` … 境界データ（Shapefile）目黒区 13110、r2ka13110.shp 等
- `A002005212020DDSWC13111-JGD2011/` … 境界データ（Shapefile）大田区 13111、r2ka13111.shp 等
- `megurobilding.xlsx` … 目黒区の町名・共同住宅世帯数・合計世帯数の Excel
- `otabilding.xlsx` … 大田区の町名・共同住宅世帯数・合計世帯数の Excel
- `scripts/` … Shapefile 変換・Excel マージ用スクリプト
- `geojson/` … 変換結果の GeoJSON / JSON（**公開時はこのフォルダ一式をアップロード**）
- `index.html` … Mapbox 地図ページ
- `config.js` … Mapbox トークン（要自前作成。`.gitignore` で除外）

## スクリプト

- `npm run build:gml` … GML から目黒区町丁ポリゴンと CommPt を生成
- `npm run build:excel` … Excel と CommPt をマージして chome-households.json を生成
- `npm run build:excel:ota` … 大田区 Excel から chome-households-ota.json を生成
- `npm run build:shapefile` … 目黒区 Shapefile から meguro-shapefile-areas.json を生成
- `npm run build:shapefile:ota` … 大田区 Shapefile から ota-shapefile-areas.json を生成
- `npm run build:speech-spots` … 演説スポット CSV を **Google Geocoding API** でジオコーディングして speech-spots.json を生成（config.js に GOOGLE_MAPS_API_KEY が必要。**先に build:shapefile / build:shapefile:ota を実行すること**）
- `npm run build` … build:gml と build:excel を実行

---

## インターネット公開

**[DEPLOY.md](DEPLOY.md)** に手順があります。

### GitHub Pages で公開する場合（推奨）

1. このプロジェクトを GitHub にプッシュ（`geojson/` フォルダもコミット。`config.js` は **コミットしない**）。
2. リポジトリ **Settings → Secrets and variables → Actions** で、シークレット `MAPBOX_ACCESS_TOKEN` を追加（値は [Mapbox](https://account.mapbox.com/access-tokens/) で取得したトークン）。
3. **Settings → Pages** で Source を **GitHub Actions** に設定。
4. `main` にプッシュすると自動デプロイされ、`https://<username>.github.io/<リポジトリ名>/` で表示されます。

※ トークンには Mapbox で「URL 制限」を設定することを推奨。Netlify / Vercel などは [DEPLOY.md](DEPLOY.md) を参照。
