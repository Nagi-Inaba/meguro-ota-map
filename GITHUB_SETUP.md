# GitHub にリポジトリを作成してプッシュする手順

Git の初期化と初回コミットは済んでいます。あとは GitHub でリポジトリを作成し、リモートを追加してプッシュするだけです。

---

## 1. GitHub で新規リポジトリを作成

1. ブラウザで **https://github.com/new** を開く
2. **Repository name** に任意の名前を入力（例: `meguro-ota-map`）
3. **Public** を選択
4. **「Add a README file」などはチェックしない**（既にローカルにファイルがあるため）
5. **Create repository** をクリック

---

## 2. リモートを追加してプッシュ

GitHub でリポジトリを作成すると、画面に「…or push an existing repository from the command line」と表示されます。  
**あなたのユーザー名** と **リポジトリ名** に置き換えて、次のコマンドを **プロジェクトフォルダ（演説ルートapp）** で実行してください。

```bash
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

例（ユーザー名が `nagitaro`、リポジトリ名が `meguro-ota-map` の場合）:

```bash
git remote add origin https://github.com/nagitaro/meguro-ota-map.git
git push -u origin main
```

プッシュ時に GitHub のログインを求められたら、ユーザー名とパスワード（または Personal Access Token）を入力してください。

---

## 3. GitHub Pages で公開する場合（任意）

1. リポジトリの **Settings → Secrets and variables → Actions** で、**New repository secret** をクリック
2. Name: `MAPBOX_ACCESS_TOKEN`、Value: [Mapbox](https://account.mapbox.com/access-tokens/) で取得したトークン を設定
3. **Settings → Pages** で、Source を **GitHub Actions** に変更して保存
4. 数分後、**https://&lt;あなたのユーザー名&gt;.github.io/&lt;リポジトリ名&gt;/** で地図が表示されます

詳しくは [DEPLOY.md](DEPLOY.md) を参照してください。
