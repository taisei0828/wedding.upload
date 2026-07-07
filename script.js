// ▼▼▼ ここに、Google Apps Scriptをデプロイして得られる「ウェブアプリURL」を貼り付けてください ▼▼▼
const SCRIPT_URL = "https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/exec";
// ▲▲▲ setup_guide.md の手順3を参照 ▲▲▲

const CHUNK_SIZE = 6 * 1024 * 1024;      // 1チャンクあたり6MB（Base64化しても余裕を持ってApps Scriptの上限内に収まるサイズ）
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 1ファイルあたりの上限（500MB）。大きすぎる動画をはじくための安全弁
const MAX_RETRIES = 4;                   // 混雑時の自動リトライ回数

const form = document.getElementById('uploadForm');
const fileInput = document.getElementById('fileInput');
const thumbsEl = document.getElementById('thumbs');
const countLine = document.getElementById('countLine');
const submitBtn = document.getElementById('submitBtn');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const messageBox = document.getElementById('messageBox');
const againBtn = document.getElementById('againBtn');
const guestNameInput = document.getElementById('guestName');

let selectedFiles = [];

fileInput.addEventListener('change', () => {
  const chosen = Array.from(fileInput.files);
  const tooBig = chosen.filter(f => f.size > MAX_FILE_SIZE);
  selectedFiles = chosen.filter(f => f.size <= MAX_FILE_SIZE);
  renderThumbs();
  updateSubmitState();
  if (tooBig.length > 0) {
    showMessage('error', `${tooBig.length}件のファイルは1件あたりの上限（500MB）を超えているため、選択から除外しました。`);
  } else {
    messageBox.classList.remove('show');
  }
});

guestNameInput.addEventListener('input', updateSubmitState);

function updateSubmitState(){
  submitBtn.disabled = !(guestNameInput.value.trim().length > 0 && selectedFiles.length > 0);
}

function formatSize(bytes){
  if(bytes < 1024*1024) return Math.round(bytes/1024) + 'KB';
  return (bytes/(1024*1024)).toFixed(1) + 'MB';
}

function renderThumbs(){
  thumbsEl.innerHTML = '';
  selectedFiles.forEach((file, idx) => {
    const div = document.createElement('div');
    const isVideo = file.type.startsWith('video/');
    div.className = 'thumb' + (isVideo ? ' video-tile' : '');
    div.dataset.idx = idx;

    if(isVideo){
      div.textContent = '🎥';
    }else{
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      div.appendChild(img);
    }

    const sizeTag = document.createElement('div');
    sizeTag.className = 'size-tag';
    sizeTag.textContent = formatSize(file.size);
    div.appendChild(sizeTag);

    const status = document.createElement('div');
    status.className = 'status';
    div.appendChild(status);

    thumbsEl.appendChild(div);
  });
  countLine.textContent = selectedFiles.length > 0 ? `${selectedFiles.length}件選択中` : '';
}

function blobToBase64(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function makeUploadId(){
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendChunkWithRetry(payload){
  let lastErr;
  for(let attempt = 0; attempt <= MAX_RETRIES; attempt++){
    try{
      const res = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Scriptのプリフライト回避のためtext/plainで送る
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if(json.status !== 'success'){
        throw new Error(json.message || 'アップロードに失敗しました');
      }
      return; // 成功
    }catch(err){
      lastErr = err;
      // 混雑（同時実行過多）などによる一時的な失敗を想定し、間隔をあけて再試行
      const waitMs = 800 * Math.pow(2, attempt) + Math.random() * 400;
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ファイルをチャンクに分割し、順番に送信する。onChunkProgress(chunkIndex, totalChunks) で進捗通知。
async function uploadOne(file, guestName, onChunkProgress){
  const uploadId = makeUploadId();
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  for(let i = 0; i < totalChunks; i++){
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunkBlob = file.slice(start, end);
    const base64 = await blobToBase64(chunkBlob);

    const payload = {
      uploadId: uploadId,
      guestName: guestName,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      chunkIndex: i,
      totalChunks: totalChunks,
      isLastChunk: (i === totalChunks - 1),
      data: base64
    };

    await sendChunkWithRetry(payload);
    if(onChunkProgress) onChunkProgress(i + 1, totalChunks);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if(SCRIPT_URL.includes('XXXXXXXX')){
    showMessage('error', 'まだGoogle Apps ScriptのURLが設定されていません。script.js内のSCRIPT_URLを設定してください。');
    return;
  }

  submitBtn.disabled = true;
  guestNameInput.disabled = true;
  fileInput.disabled = true;
  progressWrap.classList.add('show');
  messageBox.classList.remove('show');

  const guestName = guestNameInput.value.trim();
  const total = selectedFiles.length;
  let done = 0;
  let failed = [];

  for(let i = 0; i < total; i++){
    const thumbEl = thumbsEl.querySelector(`.thumb[data-idx="${i}"] .status`);
    if(thumbEl){ thumbEl.parentElement.classList.add('uploading'); thumbEl.textContent = '…'; }
    try{
      await uploadOne(selectedFiles[i], guestName, (chunkDone, chunkTotal) => {
        if(chunkTotal > 1){
          progressLabel.textContent = `送信中… (${i+1}/${total}件目 / データ ${chunkDone}/${chunkTotal})`;
        }
      });
      done++;
      if(thumbEl){
        thumbEl.parentElement.classList.remove('uploading');
        thumbEl.parentElement.classList.add('done');
        thumbEl.textContent = '✓';
      }
    }catch(err){
      failed.push(selectedFiles[i].name);
      if(thumbEl){
        thumbEl.parentElement.classList.remove('uploading');
        thumbEl.parentElement.classList.add('error');
        thumbEl.textContent = '×';
      }
    }
    const pct = Math.round(((i+1)/total)*100);
    progressFill.style.width = pct + '%';
    progressLabel.textContent = `送信中… (${i+1}/${total}枚)`;
  }

  progressWrap.classList.remove('show');

  if(failed.length === 0){
    showMessage('success', `${done}件の写真・動画を送信しました。ありがとうございます！`);
  }else{
    showMessage('error', `${done}件は送信できましたが、${failed.length}件の送信に失敗しました（通信環境をご確認の上、もう一度お試しください）。`);
  }

  againBtn.style.display = 'inline-block';
});

againBtn.addEventListener('click', () => {
  selectedFiles = [];
  fileInput.value = '';
  guestNameInput.value = '';
  guestNameInput.disabled = false;
  fileInput.disabled = false;
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
