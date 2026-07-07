/**
 * 結婚式写真・動画アップロード用 Web App バックエンド（チャンク分割対応版）
 *
 * 【できること】
 * - 写真・動画をゲストのスマホから直接、指定のGoogleドライブフォルダへ保存
 * - 大きな動画ファイルは自動でチャンク（分割）送信されるため、実質的にファイルサイズの上限なし
 * - ゲストのGoogleログインは不要（あなたのアカウント権限で書き込む）
 *
 * 【設定項目】
 * FOLDER_ID に、写真・動画を保存したいGoogleドライブのフォルダIDを入力してください。
 *
 * 【デプロイ方法】setup_guide.md を参照
 */

const FOLDER_ID = 'ここに保存先フォルダIDを貼り付け';
const TMP_SUBFOLDER_NAME = '_uploading_tmp'; // チャンクの一時保存用（自動作成されます）

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const data = JSON.parse(e.postData.contents);

    if (!data.uploadId || !data.fileName || typeof data.chunkIndex !== 'number') {
      return jsonOutput({ status: 'error', message: '不正なリクエストです' });
    }

    const destFolder = DriveApp.getFolderById(FOLDER_ID);

    // 一時フォルダの取得 or 作成（同時アクセスに備えてロックする）
    lock.waitLock(20000);
    const tmpFolder = getOrCreateTmpFolder(destFolder);
    lock.releaseLock();

    // このチャンクを一時ファイルとして保存（ファイル名: uploadId__chunkIndex）
    const chunkName = `${data.uploadId}__${pad(data.chunkIndex)}`;
    const chunkBytes = Utilities.base64Decode(data.data);
    const chunkBlob = Utilities.newBlob(chunkBytes, 'application/octet-stream', chunkName);
    tmpFolder.createFile(chunkBlob);

    // 最後のチャンクでなければここで終了
    if (!data.isLastChunk) {
      return jsonOutput({ status: 'success', progress: `chunk ${data.chunkIndex + 1}/${data.totalChunks}` });
    }

    // 最後のチャンクが届いたら、全チャンクを結合して最終ファイルとして保存
    lock.waitLock(20000);
    mergeChunksAndSave(tmpFolder, destFolder, data);
    lock.releaseLock();

    return jsonOutput({ status: 'success' });
  } catch (err) {
    try { lock.releaseLock(); } catch (e2) {}
    return jsonOutput({ status: 'error', message: err.toString() });
  }
}

function doGet(e) {
  return jsonOutput({ status: 'ok', message: 'このURLはPOST専用のエンドポイントです。' });
}

function getOrCreateTmpFolder(parentFolder) {
  const it = parentFolder.getFoldersByName(TMP_SUBFOLDER_NAME);
  if (it.hasNext()) return it.next();
  return parentFolder.createFolder(TMP_SUBFOLDER_NAME);
}

function mergeChunksAndSave(tmpFolder, destFolder, data) {
  const prefix = `${data.uploadId}__`;
  const files = [];
  const it = tmpFolder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(prefix) === 0) {
      files.push(f);
    }
  }
  // チャンク番号順に並び替え
  files.sort((a, b) => (a.getName() < b.getName() ? -1 : 1));

  if (files.length === 0) {
    throw new Error('チャンクが見つかりませんでした: ' + data.uploadId);
  }

  // 全チャンクのバイト列を結合
  let combined = [];
  files.forEach(f => {
    const bytes = f.getBlob().getBytes();
    combined = combined.concat(bytes);
  });

  const guestName = sanitizeName(data.guestName || '名無し');
  const timestamp = Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmmss');
  const finalName = `${guestName}_${timestamp}_${data.fileName}`;
  const finalBlob = Utilities.newBlob(combined, data.mimeType || 'application/octet-stream', finalName);
  destFolder.createFile(finalBlob);

  // 一時ファイルを削除
  files.forEach(f => f.setTrashed(true));
}

function pad(n) {
  return ('00000' + n).slice(-5);
}

function sanitizeName(name) {
  return name.toString().replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || '名無し';
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 【任意】送信途中で中断された古い一時チャンクを掃除する関数。
 * スクリプトエディタから手動で実行するか、時間主導型トリガーで1日1回程度実行してください
 * （トリガーの実行時間は少量なので日次クォータの心配はほぼありません）。
 */
function cleanupOldTempChunks() {
  const destFolder = DriveApp.getFolderById(FOLDER_ID);
  const tmpFolder = getOrCreateTmpFolder(destFolder);
  const cutoff = new Date().getTime() - 24 * 60 * 60 * 1000; // 24時間以上前
  const it = tmpFolder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getDateCreated().getTime() < cutoff) {
      f.setTrashed(true);
    }
  }
}
