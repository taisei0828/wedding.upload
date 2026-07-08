// ▼▼▼ Cloudflare Workerをデプロイして得られるURLを貼り付けてください（例: https://xxxx.workers.dev） ▼▼▼
const WORKER_URL = "https://edding-upload.o-taisei-0828.workers.dev";
// ▲▲▲ setup_guide.md の手順を参照 ▲▲▲

const SINGLE_PUT_LIMIT = 90 * 1024 * 1024; // 90MB。これ以下は1リクエストでそのまま送る（Cloudflareの1リクエスト100MB上限に余裕を持たせた値）
const CHUNK_SIZE = 8 * 1024 * 1024;        // マルチパート時の1パートサイズ（R2の規定で5MB以上必須）
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 1ファイルあたりの上限（2GB）。安全弁
const MAX_RETRIES = 4;                     // 混雑時の自動リトライ回数
const UPLOAD_CONCURRENCY = 3;              // 同時に何件並行してアップロードするか
const RENDER_CHUNK = 12;                   // サムネイルを1フレームで何件ずつ描画するか

const form = document.getElementById('uploadForm');
const fileInput = document.getElementById('fileInput');
const thumbsEl = document.getElementById('thumbs');
const countLine = document.getElementById('countLine');
const submitBtn = document.getElementById('submitBtn');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const cancelBtn = document.getElementById('cancelBtn');
const messageBox = document.getElementById('messageBox');
const againBtn = document.getElementById('againBtn');
const guestNameInput = document.getElementById('guestName');

// queue: { id, file, status: 'pending'|'uploading'|'done'|'error'|'canceled', controller }
let queue = [];
const elById = new Map();
let cancelRequested = false;

fileInput.addEventListener('change', () => {
  const chosen = Array.from(fileInput.files);
  fileInput.value = '';

  const tooBig = chosen.filter(f => f.size > MAX_FILE_SIZE);
  const ok = chosen.filter(f => f.size <= MAX_FILE_SIZE);

  const newItems = ok.map(file => ({ id: makeId(), file, status: 'pending', controller: null }));
  queue = queue.concat(newItems); // 累積追加
  appendThumbsInChunks(newItems);
  updateCountLine();
  updateSubmitState();

  if (tooBig.length > 0) {
    showMessage('error', `${tooBig.length}件のファイルは1件あたりの上限（2GB）を超えているため、追加されませんでした。`);
  }
});

guestNameInput.addEventListener('input', updateSubmitState);

function makeId(){
  return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function updateSubmitState(){
  const pendingCount = queue.filter(q => q.status === 'pending' || q.status === 'error' || q.status === 'canceled').length;
  submitBtn.disabled = !(guestNameInput.value.trim().length > 0 && pendingCount > 0);
}

function updateCountLine(){
  const activeCount = queue.filter(q => q.status !== 'canceled').length;
  countLine.textContent = activeCount > 0 ? `${activeCount}件選択中` : '';
}

function formatSize(bytes){
  if(bytes < 1024*1024) return Math.round(bytes/1024) + 'KB';
  return (bytes/(1024*1024)).toFixed(1) + 'MB';
}

function appendThumbsInChunks(items){
  let i = 0;
  function step(){
    const slice = items.slice(i, i + RENDER_CHUNK);
    slice.forEach(renderThumb);
    i += RENDER_CHUNK;
    if(i < items.length) requestAnimationFrame(step);
  }
  if(items.length > 0) requestAnimationFrame(step);
}

function renderThumb(item){
  const div = document.createElement('div');
  const isVideo = item.file.type.startsWith('video/');
  div.className = 'thumb' + (isVideo ? ' video-tile' : '');
  div.dataset.id = item.id;

  if(isVideo){
    const label = document.createElement('span');
    label.textContent = '🎥';
    div.appendChild(label);
  }else{
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = URL.createObjectURL(item.file);
    div.appendChild(img);
  }

  const sizeTag = document.createElement('div');
  sizeTag.className = 'size-tag';
  sizeTag.textContent = formatSize(item.file.size);
  div.appendChild(sizeTag);

  const status = document.createElement('div');
  status.className = 'status';
  div.appendChild(status);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => removeItem(item.id));
  div.appendChild(removeBtn);

  thumbsEl.appendChild(div);
  elById.set(item.id, { root: div, status });
}

function removeItem(id){
  const item = queue.find(q => q.id === id);
  if(!item || item.status === 'uploading' || item.status === 'done') return;
  queue = queue.filter(q => q.id !== id);
  const dom = elById.get(id);
  if(dom){ dom.root.remove(); elById.delete(id); }
  updateCountLine();
  updateSubmitState();
}

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

function makeUploadId(){
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ネットワーク不調・サーバー混雑時に自動リトライしてfetchする
async function fetchWithRetry(url, options){
  let lastErr;
  for(let attempt = 0; attempt <= MAX_RETRIES; attempt++){
    if(options.signal && options.signal.aborted) throw new DOMException('aborted', 'AbortError');
    try{
      const res = await fetch(url, options);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if(data.status !== 'success') throw new Error(data.message || 'アップロードに失敗しました');
      return data;
    }catch(err){
      if(err.name === 'AbortError') throw err;
      lastErr = err;
      const waitMs = 800 * Math.pow(2, attempt) + Math.random() * 400;
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function commonHeaders(guestName, file, uploadId){
  return {
    'X-Upload-Id': uploadId,
    'X-Guest-Name': encodeURIComponent(guestName),
    'X-File-Name': encodeURIComponent(file.name),
    'X-Mime-Type': file.type || 'application/octet-stream',
  };
}

async function uploadItem(item, guestName){
  const file = item.file;
  const controller = new AbortController();
  item.controller = controller;
  const uploadId = makeUploadId();

  if(file.size <= SINGLE_PUT_LIMIT){
    // 単発アップロード：ファイルをそのままバイナリで送信（Base64変換なし）
    await fetchWithRetry(WORKER_URL + '/chunk', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...commonHeaders(guestName, file, uploadId),
        'X-Total-Chunks': '1',
        'X-Part-Number': '1',
      },
      body: file,
    });
    return;
  }

  // マルチパートアップロード（大きな動画）
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let r2UploadId = null;
  let key = null;
  const parts = [];

  for(let i = 0; i < totalChunks; i++){
    if(cancelRequested) throw new DOMException('aborted', 'AbortError');
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunkBlob = file.slice(start, end);

    const headers = {
      ...commonHeaders(guestName, file, uploadId),
      'X-Total-Chunks': String(totalChunks),
      'X-Part-Number': String(i + 1),
    };
    if(r2UploadId) headers['X-R2-Upload-Id'] = r2UploadId;

    const data = await fetchWithRetry(WORKER_URL + '/chunk', {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: chunkBlob,
    });

    r2UploadId = data.r2UploadId;
    key = data.key;
    parts.push({ partNumber: data.partNumber, etag: data.etag });
  }

  // 完了処理（全パートを結合して1つのファイルにする）
  await fetchWithRetry(WORKER_URL + '/complete', {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, r2UploadId, parts }),
  });
}

function runQueueWithConcurrency(items, guestName, concurrency, onEachDone){
  return new Promise(resolve => {
    let idx = 0, active = 0, doneCount = 0;
    const failed = [];

    function tryStart(){
      if(cancelRequested){ finishIfIdle(); return; }
      while(active < concurrency && idx < items.length){
        const item = items[idx++];
        active++;
        item.status = 'uploading';
        setThumbState(item.id, 'uploading', '…');
        uploadItem(item, guestName)
          .then(() => {
            item.status = 'done';
            setThumbState(item.id, 'done', '✓');
            doneCount++;
          })
          .catch(err => {
            if(err.name === 'AbortError'){
              item.status = 'canceled';
              setThumbState(item.id, 'error', '中断');
            }else{
              item.status = 'error';
              setThumbState(item.id, 'error', '×');
              failed.push(item.file.name);
            }
          })
          .finally(() => {
            active--;
            onEachDone(doneCount, items.length);
            tryStart();
            finishIfIdle();
          });
      }
    }

    function finishIfIdle(){
      if(idx >= items.length && active === 0){ resolve({ doneCount, failed }); }
    }

    tryStart();
  });
}

function setThumbState(id, cls, label){
  const dom = elById.get(id);
  if(!dom) return;
  dom.root.classList.remove('uploading', 'done', 'error');
  dom.root.classList.add(cls);
  dom.status.textContent = label;
}

cancelBtn.addEventListener('click', () => {
  cancelRequested = true;
  queue.forEach(item => {
    if(item.status === 'uploading' && item.controller){
      item.controller.abort();
    }
  });
  cancelBtn.disabled = true;
  cancelBtn.textContent = '中断しています…';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if(WORKER_URL.includes('your-worker-name')){
    showMessage('error', 'まだCloudflare WorkerのURLが設定されていません。script.js内のWORKER_URLを設定してください。');
    return;
  }

  const targets = queue.filter(q => q.status === 'pending' || q.status === 'error' || q.status === 'canceled');
  if(targets.length === 0) return;

  cancelRequested = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'アップロードを中断する';

  submitBtn.disabled = true;
  guestNameInput.disabled = true;
  fileInput.disabled = true;
  progressWrap.classList.add('show');
  messageBox.classList.remove('show');

  const guestName = guestNameInput.value.trim();

  const { doneCount, failed } = await runQueueWithConcurrency(targets, guestName, UPLOAD_CONCURRENCY, (done, total) => {
    const pct = Math.round((done/total)*100);
    progressFill.style.width = pct + '%';
    progressLabel.textContent = `送信中… (完了 ${done}/${total}件)`;
  });

  progressWrap.classList.remove('show');

  if(cancelRequested){
    showMessage('error', `送信を中断しました。${doneCount}件は送信済みです。`);
  }else if(failed.length === 0){
    showMessage('success', `${doneCount}件の写真・動画を送信しました。ありがとうございます！`);
  }else{
    showMessage('error', `${doneCount}件は送信できましたが、${failed.length}件の送信に失敗しました（下の「もう一度送る」から再送してください）。`);
  }

  guestNameInput.disabled = false;
  fileInput.disabled = false;
  updateSubmitState();
  againBtn.style.display = 'inline-block';
});

againBtn.addEventListener('click', () => {
  queue = [];
  elById.clear();
  fileInput.value = '';
  guestNameInput.value = '';
  thumbsEl.innerHTML = '';
  countLine.textContent = '';
  messageBox.classList.remove('show');
  againBtn.style.display = 'none';
  updateSubmitState();
});

function showMessage(type, text){
  messageBox.className = 'message show ' + type;
  messageBox.textContent = text;
}
