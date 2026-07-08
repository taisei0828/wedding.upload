/**
 * 結婚式写真・動画アップロード用 Cloudflare Worker
 *
 * 【役割】
 * ゲストのブラウザから送られてきた写真・動画を、バインドされたR2バケットに保存する。
 * - 90MB以下のファイル: 1回のリクエストでそのままストリーム保存（高速・シンプル）
 * - 90MBを超える動画: R2のマルチパートアップロードAPIで分割保存
 *
 * 【デプロイ方法】setup_guide.md を参照。
 * ダッシュボードで新規Workerを作成 → このコードを貼り付け → Settings > Bindings で
 * R2バケットを "PHOTO_BUCKET" という変数名でバインド → デプロイ。
 *
 * 【エンドポイント】
 * POST /chunk    … 写真・動画の実データ（バイナリ）を送る。ヘッダーでメタ情報を渡す。
 * POST /complete … マルチパートアップロードの最終確定（JSON）。
 * POST /abort    … マルチパートアップロードの中断（JSON）。
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // 必要であれば 'https://xxxxx.github.io' のように絞り込み可能
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/chunk') {
        return await handleChunk(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/complete') {
        return await handleComplete(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/abort') {
        return await handleAbort(request, env);
      }
      return jsonResponse({ status: 'error', message: 'not found' }, 404);
    } catch (err) {
      return jsonResponse({ status: 'error', message: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function sanitizeName(name) {
  return (name || '')
    .toString()
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 40) || 'guest';
}

function buildKey(guestName, uploadId, fileName) {
  const g = sanitizeName(guestName);
  const f = sanitizeName(fileName) || 'file';
  return `${g}_${uploadId}_${f}`;
}

/**
 * 写真・動画の実バイナリを受け取って保存する。
 * totalChunks === 1 の場合は単純put、それ以外はマルチパートアップロードのパートとして処理する。
 */
async function handleChunk(request, env) {
  const h = request.headers;
  const uploadId = h.get('X-Upload-Id');
  const guestName = safeDecode(h.get('X-Guest-Name'));
  const fileName = safeDecode(h.get('X-File-Name')) || 'file';
  const mimeType = h.get('X-Mime-Type') || 'application/octet-stream';
  const totalChunks = parseInt(h.get('X-Total-Chunks') || '1', 10);
  const partNumber = parseInt(h.get('X-Part-Number') || '1', 10); // 1始まり
  const r2UploadId = h.get('X-R2-Upload-Id') || null;

  if (!uploadId || !fileName) {
    return jsonResponse({ status: 'error', message: 'invalid request (uploadId/fileName missing)' }, 400);
  }

  const key = buildKey(guestName, uploadId, fileName);

  // ケース1: 単一リクエストで完結（写真・小〜中サイズの動画）
  if (totalChunks === 1) {
    await env.PHOTO_BUCKET.put(key, request.body, {
      httpMetadata: { contentType: mimeType },
    });
    return jsonResponse({ status: 'success', key });
  }

  // ケース2: マルチパートアップロード（大きな動画）
  let multipart;
  if (partNumber === 1 && !r2UploadId) {
    multipart = await env.PHOTO_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: mimeType },
    });
  } else {
    if (!r2UploadId) {
      return jsonResponse({ status: 'error', message: 'missing X-R2-Upload-Id for non-first part' }, 400);
    }
    multipart = await env.PHOTO_BUCKET.resumeMultipartUpload(key, r2UploadId);
  }

  const uploadedPart = await multipart.uploadPart(partNumber, request.body);

  return jsonResponse({
    status: 'success',
    key,
    r2UploadId: multipart.uploadId,
    partNumber: uploadedPart.partNumber,
    etag: uploadedPart.etag,
  });
}

/** マルチパートアップロードの完了処理（全パートのetagを受け取って結合を確定させる） */
async function handleComplete(request, env) {
  const body = await request.json();
  const { key, r2UploadId, parts } = body || {};
  if (!key || !r2UploadId || !Array.isArray(parts) || parts.length === 0) {
    return jsonResponse({ status: 'error', message: 'invalid complete request' }, 400);
  }
  const multipart = await env.PHOTO_BUCKET.resumeMultipartUpload(key, r2UploadId);
  await multipart.complete(parts);
  return jsonResponse({ status: 'success' });
}

/** マルチパートアップロードの中断（ゲストがアップロードを中断した場合の後始末） */
async function handleAbort(request, env) {
  const body = await request.json();
  const { key, r2UploadId } = body || {};
  if (!key || !r2UploadId) {
    return jsonResponse({ status: 'error', message: 'invalid abort request' }, 400);
  }
  try {
    const multipart = await env.PHOTO_BUCKET.resumeMultipartUpload(key, r2UploadId);
    await multipart.abort();
  } catch (e) {
    // 既に完了/存在しない場合などは無視して良い
  }
  return jsonResponse({ status: 'success' });
}

function safeDecode(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}
