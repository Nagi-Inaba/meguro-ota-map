# インターネット公開手順

目黒区・大田区 町丁別世帯数地図を GitHub Pages / Netlify / Vercel などで公開する手順です。

---

## クイックスタート（GitHub Pages）

1. **GitHub にリポジトリを作成**し、このプロジェクトをプッシュ（`index.html`、`geojson/` フォルダ一式、`config.js.example` など。`config.js` は **コミットしない**）。
2. リポジトリ **Settings → Secrets and variables → Actions** で **New repository secret** を押し、名前 `MAPBOX_ACCESS_TOKEN`、値に [Mapbox](https://account.mapbox.com/access-tokens/) で取得したトークンを設定。
3. **Settings → Pages** で、Source を **GitHub Actions** に変更して保存。
4. `main` ブランチにプッシュすると、`.github/workflows/deploy.yml` が動き、数分後に **https://&lt;username&gt;.github.io/&lt;リポジトリ名&gt;/** で地図が表示されます。

※ トークンには Mapbox ダッシュボードで「URL 制限」を設定することを推奨（例: `https://*.github.io/*`）。

---

## 公開に必要なファイル

静的サイトとして配信するため、次のファイル・フォルダをアップロードします。

| パス | 説明 |
|------|------|
| `index.html` | 地図ページ |
| `config.js` | Mapbox トークン（**必ず自前で作成**。リポジトリには含めない） |
| `geojson/` | 地図データ（目黒区・大田区の境界・世帯数・演説スポットなど） |

`node_modules/` や `scripts/`、Excel・Shapefile の元データは**公開サーバーには不要**です（ローカルでビルド済みの `geojson/*.json` だけあれば動作します）。

---

## 1. Mapbox トークンの準備

1. [Mapbox](https://www.mapbox.com/) でアカウントを作成し、[Access tokens](https://account.mapbox.com/access-tokens/) でトークンを取得します。
2. **公開用**の場合、トークンに「URL 制限」を設定することを推奨します。  
   （例: `https://your-username.github.io/*` や `https://your-site.netlify.app/*`）
3. リポジトリのルートで `config.js.example` を `config.js` にコピーし、`MAPBOX_ACCESS_TOKEN` に取得したトークンを記入します。

```bash
cp config.js.example config.js
# config.js を編集して MAPBOX_ACCESS_TOKEN を設定
```

- `config.js` は `.gitignore` に含まれているため、**Git にはコミットしない**でください。
- 公開サイトでは、デプロイ先の「環境変数」や「シークレット」でトークンを渡し、ビルド時に `config.js` を生成する方法も使えます（下記参照）。

---

## 2. GitHub Pages で公開する場合

### 方法 A: 手動で config.js を用意してデプロイ

1. 上記のとおり `config.js` をローカルで作成し、トークンを記入する。
2. **注意**: `config.js` をリポジトリに含めるとトークンが公開されます。  
   - トークンに「URL 制限」（例: `https://<username>.github.io/*`）を必ず設定する。  
   - または、**方法 B** のように環境変数でトークンを渡す運用にする。
3. 公開するブランチのルートに次のファイルを置く:
   - `index.html`
   - `config.js`（トークン設定済み）
   - `geojson/` フォルダ一式
4. リポジトリの **Settings → Pages** で、ソースを「Deploy from a branch」、ブランチを選び、ルート（`/`）で保存する。
5. 数分後に `https://<username>.github.io/<repo>/` で表示されます。

### 方法 B: GitHub Actions で環境変数から config.js を生成

1. リポジトリの **Settings → Secrets and variables → Actions** で、`MAPBOX_ACCESS_TOKEN` というシークレットを追加する。
2. 次のワークフローを `.github/workflows/deploy.yml` として保存する。

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Create config.js
        run: |
          echo "var MAPBOX_ACCESS_TOKEN = '${{ secrets.MAPBOX_ACCESS_TOKEN }}';" > config.js
      - name: Copy geojson
        run: |
          mkdir -p geojson
          # 必要に応じてビルドスクリプトを実行するか、既存の geojson をコミットしておく
      - name: Setup Pages
        uses: actions/configure-pages@v4
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
```

3. リポジトリの **Settings → Pages** で、ソースを「GitHub Actions」に設定する。
4. `main` にプッシュすると、`config.js` が自動生成され、GitHub Pages にデプロイされます。  
   **トークンはリポジトリに含まれません。**

---

## 3. Netlify で公開する場合

1. [Netlify](https://www.netlify.com/) にログインし、**Add new site → Import an existing project** でリポジトリを接続する。
2. ビルド設定:
   - **Build command**: 空欄のまま（静的サイト）
   - **Publish directory**: `/` または `.`
3. **Site settings → Environment variables** で `MAPBOX_ACCESS_TOKEN` を追加する。
4. ビルド時に `config.js` を生成するため、**Build command** に次を設定する例:

   ```bash
   echo "var MAPBOX_ACCESS_TOKEN = \"$MAPBOX_ACCESS_TOKEN\";" > config.js
   ```

   または、**Build command** は空のままにして、`netlify.toml` でビルドフックを定義してもよい。
5. **geojson/** はリポジトリにコミットしておくか、ビルドコマンドで `npm run build:shapefile` 等を実行して生成する。
6. デプロイ後、表示される URL で地図を確認する。

---

## 4. Vercel で公開する場合

1. [Vercel](https://vercel.com/) にログインし、**Add New → Project** でリポジトリをインポートする。
2. **Environment Variables** に `MAPBOX_ACCESS_TOKEN` を追加する。
3. ビルド時に `config.js` を作る場合、**Build Command** に次を設定する:

   ```bash
   echo "var MAPBOX_ACCESS_TOKEN = \"$MAPBOX_ACCESS_TOKEN\";" > config.js
   ```

4. **Output Directory** は空（ルートをそのまま公開）でよい。
5. デプロイ後、表示される URL で地図を確認する。

---

## 5. その他の静的ホスティング（FTP 等）

- 次のものをアップロードする:
  - `index.html`
  - `config.js`（ローカルで作成し、トークンを記入）
  - `geojson/` フォルダ一式
- ブラウザで `index.html` の URL を開くと地図が表示されます。
- **必ず HTTPS で配信**してください（Mapbox の利用規約・ブラウザの制限のため）。

---

## チェックリスト

- [ ] Mapbox でトークンを取得し、必要なら URL 制限を設定した
- [ ] `config.js` を用意し、`MAPBOX_ACCESS_TOKEN` を設定した（または CI/デプロイで生成する）
- [ ] `geojson/` に必要な JSON が含まれている（ローカルで `npm run build:shapefile` 等を実行済み）
- [ ] 公開 URL で地図が表示されることを確認した
- [ ] `config.js` にトークンを直書きする場合、リポジトリにコミットしていない（.gitignore 済み）
