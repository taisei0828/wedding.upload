# セットアップ手順（Cloudflare R2 + Workers版）

> Google Drive / Apps Script方式は廃止し、**Cloudflare R2（無料10GB）+ Cloudflare Workers** に全面的に作り替えました。`apps-script/` フォルダはもう使いません（参考用に残していますが、削除しても構いません）。

```
[ゲストのスマホ] → index.html（GitHub Pages）
                        ↓ 写真・動画をそのままバイナリで送信（fetch）
                   Cloudflare Worker（あなたが所有）
                        ↓ 自動保存（90MB以下は直接、超えたらマルチパート分割）
                   Cloudflare R2バケット
```

**このアーキテクチャの利点（Apps Script版との違い）**
- Base64変換が不要になり、通信量・処理が軽くなった（Apps Script版は+37%のデータ膨張があった）
- Google Driveのような「混みあうと処理が詰まる」不安定さがない（Cloudflareは高スループットのエッジネットワーク）
- 無料枠が広い：**10GBストレージ／月1,000,000回の書き込み／月1,000万回の読み込み／転送量（エグレス）は常に無料**（2026年7月時点の公式料金ページで確認済み）
- Workersの無料プランは1日100,000リクエストまで無料（今回のような個人利用では十分すぎる余裕があります）

---

## 手順1. Cloudflareダッシュボードから作業する

以下はすべて [dash.cloudflare.com](https://dash.cloudflare.com) にログインした状態で行います（既にアカウント登録済みとのことなので、そのまま進めてください）。

## 手順2. R2バケットを作成する

1. 左メニューから「R2 Object Storage」を開く。
2. 「Create bucket」をクリック。
3. バケット名を決める（例：`wedding-photos`）。ロケーションは自動（Automatic）のままでOK。
4. 「Create bucket」で作成完了。

## 手順3. Workerを作成する

1. 左メニューから「Workers & Pages」を開く。
2. 「Create」→「Create Worker」を選択。
3. Worker名を決める（例：`wedding-upload`）。この名前が最終的なURLの一部になります
   （`https://wedding-upload.（あなたのサブドメイン）.workers.dev`）。
4. 作成後、「Edit code」（コードエディタ）を開き、中身をすべて削除して
   `cloudflare-worker/worker.js` の内容を貼り付けます。
5. 右上の「Deploy」をクリックしてデプロイします。

## 手順4. R2バケットをWorkerに紐付ける（バインディング）

1. 作成したWorkerの管理画面で「Settings」タブ→「Bindings」（または「Variables」）を開く。
2. 「Add binding」→「R2 Bucket」を選択。
3. 変数名（Variable name）に **`PHOTO_BUCKET`** と入力（worker.js内のコードとこの名前を一致させる必要があります）。
4. バケットは手順2で作った `wedding-photos` を選択。
5. 保存して、必要であれば再デプロイします。

## 手順5. WorkerのURLを確認し、script.jsに設定する

1. Workerの管理画面上部に表示されている URL（`https://wedding-upload.xxxxx.workers.dev` の形式）をコピー。
2. `script.js` を開き、以下の行を書き換えます。

   ```js
   const WORKER_URL = "https://your-worker-name.your-subdomain.workers.dev";
   ```

   → コピーしたURLに置き換えます（末尾にスラッシュは付けません）。

## 手順6. GitHub Pagesに公開する

これまでと同じ手順です。`index.html` / `style.css` / `script.js` の3ファイルをリポジトリ直下に置き、GitHub Pagesを有効化してください（`cloudflare-worker/worker.js` はCloudflare側で使うファイルなので、リポジトリに含めても含めなくても構いません）。

## 手順7. 動作確認

1. 公開されたURLをスマホで開く。
2. 名前を入力し、写真を1〜2枚選んで送信。
3. Cloudflareダッシュボードの R2 → 該当バケット → オブジェクト一覧に、ファイルが保存されているか確認。
   ファイル名は「お名前_uploadId_元のファイル名」の形式になります。

---

## 大容量ファイルの目安

| ファイルサイズ | 挙動 |
|---|---|
| 〜90MB（ほとんどの写真・数十秒程度の動画） | 1リクエストでそのまま送信。最速・最短。 |
| 90MB〜2GB（長めの動画） | 8MBごとに自動分割し、R2のマルチパートアップロードAPIで結合保存。 |
| 2GB超 | 現在の設定では送信前にブロックされます（`script.js`の`MAX_FILE_SIZE`で調整可能）。 |

Cloudflare Workersの1リクエストあたりの受信データ量には100MBという上限があるため（無料・Proプラン共通）、90MBという閾値はそこに安全マージンを持たせた値です。マルチパート方式ならこの制限を回避でき、理論上は数GB〜のファイルでも送信できます。

**同時アップロードへの耐性**：Workersの無料プランは1日100,000リクエストまで無料で、上限に達しない限り同時アクセスによる「詰まり」はほぼ発生しません（Apps Scriptにあった「同時実行数30」のような小さな上限がありません）。

---

## 集めた写真・動画を後で取り出すには

R2にはGoogleドライブのような「フォルダをブラウザで見る」感覚のUIはありますが、まとめてZIPダウンロードのような機能は標準搭載されていません。実用的な方法は以下の通りです。

1. **少数だけ確認したい場合**：Cloudflareダッシュボードの R2 → バケット → オブジェクト一覧から、個別にファイルをクリックしてダウンロード。
2. **まとめて全部ダウンロードしたい場合（推奨）**：`rclone`（無料の同期ツール）を使い、R2をS3互換ストレージとして接続してPCに一括ダウンロードします。
   - R2の管理画面から「Manage R2 API Tokens」でAPIトークン（アクセスキー・シークレットキー）を発行
   - rcloneの設定でプロバイダーを「Cloudflare R2」として上記のキーを登録
   - `rclone copy remote:wedding-photos ./wedding-photos-backup` のようなコマンドで一括ダウンロード
   - 手順の詳細は [rclone公式のCloudflare R2連携ガイド](https://rclone.org/s3/#cloudflare-r2) を参照してください。
3. 全部ダウンロードした後、Googleフォトの共有アルバムにまとめてアップロードすれば、これまで案内していた「ゲストへの共有」フローに合流できます。

---

## セキュリティについて

- WorkerのURLを知っていれば誰でも送信できる設計です（ゲストのログイン不要という要件を満たすため）。閲覧・削除の機能は実装していないので、URLが広まっても中身を覗かれたり消されたりする心配はありません。
- より厳格にしたい場合は、Worker側で簡単な合言葉（例：送信時に決まった合言葉をヘッダーに含めないと保存しない）を追加することも可能です。必要であれば実装します。
