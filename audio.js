// audio.js
// ============================================================
// 🎵 音(BGM・効果音)
//   音源(audioAssets): 読み込んだ音声ファイル(ブラウザの IndexedDB に保存)と、公式の効果音(その場で作る)。
//   音のブロック(audioClips): タイムラインの「🎵 音」の行に並べる。
//     { id, kind:'audio', assetId, startTick, endTick, offsetSec(音源のどこから鳴らすか),
//       volume(1=100%), fadeIn, fadeOut(秒), mute }
//   再生中は Web Audio で、再生ヘッドに合わせて鳴らす(シーク・編集したら鳴らし直す)。
//   書き出しの時も同じ鳴らし方で、録画用の出口(MediaStreamDestination)へ流す。
// ============================================================

let audioClips = [];
let nextAudioClipId = 1;
let selectedAudioId = null;

// id -> { id, name, official, bytes(ArrayBuffer|null), buffer(AudioBuffer|null), duration, peaks(Float32Array), ready }
const audioAssets = new Map();
let audioAssetOrder = []; // 素材一覧(カスタム)に並べる順

const AUDIO_PEAKS = 2000;

let _audioCtx = null;
function audioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function audioGet(id) { return audioClips.find(c => c.id === id) || null; }
function audioGetSelected() { return selectedAudioId != null ? audioGet(selectedAudioId) : null; }
function audioAssetName(id) { const a = audioAssets.get(id); return a ? a.name : '(音源なし)'; }


// ============================================================
// 音源: 波形の概要(タイムラインに描く)
// ============================================================

function _audioPeaks(buf) {
  const n = Math.min(AUDIO_PEAKS, Math.max(1, Math.floor(buf.length / 64)));
  const out = new Float32Array(n);
  const step = buf.length / n;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = Math.floor(i * step), b = Math.min(d.length, Math.floor((i + 1) * step));
      for (let k = a; k < b; k += 4) { const v = Math.abs(d[k]); if (v > m) m = v; }
      if (m > out[i]) out[i] = m;
    }
  }
  return out;
}

function _audioRegisterBuffer(id, name, buffer, official, bytes) {
  const a = { id, name, official: !!official, bytes: bytes || null, buffer, duration: buffer.duration, peaks: _audioPeaks(buffer), ready: true };
  audioAssets.set(id, a);
  return a;
}

// 音声ファイルのバイト列 → 音源(デコードできなければ null)
async function audioDecodeBytes(id, name, bytes) {
  try {
    const buf = await audioCtx().decodeAudioData(bytes.slice(0));
    return _audioRegisterBuffer(id, name, buf, false, bytes);
  } catch (e) {
    return null;
  }
}


// ============================================================
// 保存(IndexedDB。使えない環境では、ページを開いている間だけ)
// ============================================================

const AUDIO_DB = 'bloxdEditor', AUDIO_DB_VER = 3;   // ステップ49: 建築(structures)を足した
let _idbPromise = null;
function editorDb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(AUDIO_DB, AUDIO_DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('structures')) db.createObjectStore('structures', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return _idbPromise;
}
async function idbPut(store, value) {
  const db = await editorDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}
async function idbGet(store, key) {
  const db = await editorDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function idbAll(store) {
  const db = await editorDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}
async function idbDelete(store, key) {
  const db = await editorDb();
  if (!db) return;
  return new Promise((resolve) => {
    try { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); }
    catch (e) { resolve(); }
  });
}

let _audioInitDone = false;
async function audioInit() {
  if (_audioInitDone) return;
  _audioInitDone = true;
  await _audioLoadOfficialList();
  const list = await idbAll('audio');
  list.sort((a, b) => (a.added || 0) - (b.added || 0));
  for (const e of list) {
    if (audioAssets.has(e.id)) continue;
    const a = await audioDecodeBytes(e.id, e.name, e.bytes);
    if (a) audioAssetOrder.push(e.id);
  }
  if (typeof renderAssetList === 'function' && typeof activeAssetCategoryId !== 'undefined' && activeAssetCategoryId === 'music') renderAssetList();
  if (typeof renderAudioTrackBlocks === 'function') renderAudioTrackBlocks();
}

// 音声ファイルを読み込んで音源に足す。戻り値: ID(失敗したら null)
async function audioImportFile(file) {
  if (!file) return null;
  const bytes = await file.arrayBuffer();
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const name = (file.name || '音').replace(/\.[^.]+$/, '').slice(0, 24) || '音';
  const a = await audioDecodeBytes(id, name, bytes);
  if (!a) { showToast('この音声ファイルは読み込めませんでした(mp3 / wav / ogg / m4a などを使ってください)'); return null; }
  audioAssetOrder.push(id);
  const ok = await idbPut('audio', { id, name, bytes, added: Date.now() });
  if (!ok) showToast('ブラウザに保存できなかったので、この音はページを開いている間だけ使えます(プロジェクトを保存すると一緒に入ります)');
  return id;
}

async function audioDeleteAsset(id) {
  audioAssetOrder = audioAssetOrder.filter(x => x !== id);
  await idbDelete('audio', id);
}


// ============================================================
// 公式の音(sounds/ フォルダの音声ファイル。一覧は sounds/sounds.csv)
//   1行に「file,name,tags,credit」。credit(作った人・サイト。例: 魔王魂)は一覧とパネルに出す。
//   一覧に出すだけで、聞く・置く時に初めて読み込む。
// ============================================================

let OFFICIAL_SOUNDS = []; // [{ id:'snd:ファイル名', file, name, tags:[], credit }]

async function _audioLoadOfficialList() {
  try {
    const res = await fetch('sounds/sounds.csv', { cache: 'no-store' });
    if (!res.ok) return;
    const out = [];
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [file, name, tags, credit] = line.split(',').map(x => (x || '').trim());
      if (!file || file === 'file') continue;
      const id = 'snd:' + file;
      out.push({ id, file, name: name || file.replace(/\.[^.]+$/, ''), tags: (tags || '').split(/[・/]/).map(t => t.trim()).filter(Boolean), credit: credit || '' });
      if (!audioAssets.has(id)) audioAssets.set(id, { id, name: name || file, official: true, file, credit: credit || '', bytes: null, buffer: null, duration: 0, peaks: null, ready: false });
    }
    OFFICIAL_SOUNDS = out;
  } catch (e) { /* 無ければ公式の音は無し */ }
}

// 音源を使えるようにする(公式の音は、ここで初めて読み込む)。使えれば音源、だめなら null
async function audioEnsure(id) {
  const a = audioAssets.get(id);
  if (!a) return null;
  if (a.buffer) return a;
  if (!a.file) return null;
  try {
    const res = await fetch('sounds/' + a.file);
    if (!res.ok) throw new Error(res.status);
    const buf = await audioCtx().decodeAudioData(await res.arrayBuffer());
    a.buffer = buf; a.duration = buf.duration; a.peaks = _audioPeaks(buf); a.ready = true;
    return a;
  } catch (e) {
    showToast(`「${a.name}」を読み込めませんでした(sounds/${a.file})`);
    return null;
  }
}

// ============================================================
// 音のブロック
// ============================================================

function audioAddClip(tick, assetId, props) {
  const a = audioAssets.get(assetId);
  if (!a) return null;
  const tps = scTps();
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(tick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.max(1, Math.round(a.duration * tps));
  if (maxTick > 0) end = Math.min(end, maxTick);
  const c = { id: nextAudioClipId++, kind: 'audio', assetId, startTick: start, endTick: Math.max(start + 1, end),
              offsetSec: 0, volume: 1, fadeIn: 0, fadeOut: 0, mute: false, ...(props || {}) };
  audioClips.push(c);
  return c;
}
function audioDeleteClip(id) { audioClips = audioClips.filter(c => c.id !== id); }
function audioSplitClip(c, tick) {
  if (tick <= c.startTick || tick >= c.endTick) return null;
  const right = { ...c, id: nextAudioClipId++, startTick: tick, offsetSec: c.offsetSec + (tick - c.startTick) / scTps(), fadeIn: 0 };
  c.endTick = tick; c.fadeOut = 0;
  audioClips.push(right);
  return right;
}
function audioDuplicateClip(c) {
  const len = c.endTick - c.startTick;
  const maxTick = scMaxTick();
  let start = c.endTick;
  if (maxTick > 0 && start + len > maxTick) start = Math.max(0, maxTick - len);
  const dup = { ...c, id: nextAudioClipId++, startTick: start, endTick: start + len };
  audioClips.push(dup);
  return dup;
}
// 音源の長さを超えないようにする(右端の最大)
function audioMaxEndTick(c) {
  const a = audioAssets.get(c.assetId);
  if (!a) return c.endTick;
  return c.startTick + Math.max(1, Math.round((a.duration - c.offsetSec) * scTps()));
}

// 素材一覧から: 再生ヘッドの位置に置いて、パネルを開く
function addAudioAt(tick, assetId) {
  pushUndo();
  const c = audioAddClip(tick, assetId);
  if (!c) { showToast('音源がまだ読み込めていません'); return null; }
  selectAudio(c.id);
  openEditPanel(c);
  showToast(`🎵 「${audioAssetName(assetId)}」を置きました。端をドラッグで長さ、ダブルクリックで音量・フェード`);
  return c;
}


// ============================================================
// 鳴らす(再生・書き出し)
// ============================================================

let _audioLive = []; // 今鳴らしている { src, gain }
let _audioLiveDest = null;

// 1つのブロックを、ctx の時刻 when0 を「タイムラインの fromSec」として鳴らす
function _audioScheduleClip(ctx, dest, c, when0, fromSec) {
  const a = audioAssets.get(c.assetId);
  if (!a || !a.buffer || c.mute || !(c.volume > 0)) return null;
  const tps = scTps();
  const s = c.startTick / tps, e = c.endTick / tps;
  if (e <= fromSec) return null;
  const into = Math.max(0, fromSec - s);
  const dur = (e - s) - into;
  const off = c.offsetSec + into;
  if (off >= a.buffer.duration || dur <= 0) return null;
  const at = when0 + Math.max(0, s - fromSec);
  const src = ctx.createBufferSource();
  src.buffer = a.buffer;
  const g = ctx.createGain();
  // 音量とフェード(ブロックの中の時刻 x での音量)
  const len = e - s, fi = Math.min(c.fadeIn || 0, len), fo = Math.min(c.fadeOut || 0, len);
  const volAt = (x) => {
    let v = c.volume;
    if (fi > 0 && x < fi) v *= x / fi;
    if (fo > 0 && x > len - fo) v *= Math.max(0, (len - x) / fo);
    return v;
  };
  g.gain.setValueAtTime(volAt(into), at);
  if (fi > 0 && into < fi) g.gain.linearRampToValueAtTime(volAt(fi), at + (fi - into));
  if (fo > 0) {
    const foStart = len - fo;
    if (into < foStart) g.gain.setValueAtTime(volAt(foStart), at + (foStart - into));
    g.gain.linearRampToValueAtTime(0, at + dur);
  }
  src.connect(g); g.connect(dest);
  src.start(at, off, dur);
  return { src, gain: g };
}

function audioStopAll() {
  for (const n of _audioLive) { try { n.src.stop(); } catch (e) { /* もう止まっている */ } try { n.gain.disconnect(); } catch (e) { /* 無視 */ } }
  _audioLive = [];
}

// 再生ヘッドの位置から鳴らす(dest を渡すと、そこへ流す: 書き出し用)
function audioPlayFrom(tick, dest, delaySec) {
  audioStopAll();
  if (!audioClips.length) return null;
  const ctx = audioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const when0 = ctx.currentTime + (delaySec != null ? delaySec : 0.03);
  const fromSec = tick / scTps();
  _audioLiveDest = dest || null;
  for (const c of audioClips) {
    const n = _audioScheduleClip(ctx, dest || ctx.destination, c, when0, fromSec);
    if (n) _audioLive.push(n);
  }
  return when0;
}

// 再生中にシーク・編集した時は、鳴らし直す
let _audioResyncTimer = null;
function audioResync() {
  if (typeof playing === 'undefined' || !playing || (typeof exportState !== 'undefined' && exportState)) return;
  clearTimeout(_audioResyncTimer);
  _audioResyncTimer = setTimeout(() => { if (playing) audioPlayFrom(curTick); }, 30);
}


// ============================================================
// タイムラインの「🎵 音」の行
// ============================================================

function _audioAssignRows() {
  const sorted = audioClips.slice().sort((a, b) => a.startTick - b.startTick);
  const rowEnds = [];
  const rows = new Map();
  for (const c of sorted) {
    let r = rowEnds.findIndex(end => end <= c.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = c.endTick;
    rows.set(c.id, r);
  }
  return { rows, count: Math.max(1, rowEnds.length) };
}

function renderAudioTrackBlocks() {
  const lane = document.getElementById('timelineAudioLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const { rows, count } = _audioAssignRows();
  const h = count * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick();
  for (const c of audioClips) {
    const el = document.createElement('div');
    el.className = 'tlBlock audio' + (c.id === selectedAudioId ? ' selected' : '') + (c.mute ? ' muted' : '');
    el.style.left = (c.startTick * ppt) + 'px';
    const w = Math.max(6, (c.endTick - c.startTick) * ppt);
    el.style.width = w + 'px';
    el.style.top = ((rows.get(c.id) || 0) * TL_ROW_H + 3) + 'px';
    el.appendChild(_audioWaveCanvas(c, w, TL_ROW_H - 6));
    const label = document.createElement('div');
    label.className = 'tlBlockLabel';
    label.innerText = (c.mute ? '🔇 ' : '🎵 ') + audioAssetName(c.assetId);
    el.appendChild(label);
    // フェードの三角
    const tps = scTps();
    if (c.fadeIn > 0) { const f = _el('div', 'tlFade in'); f.style.width = Math.min(w, c.fadeIn * tps * ppt) + 'px'; el.appendChild(f); }
    if (c.fadeOut > 0) { const f = _el('div', 'tlFade out'); f.style.width = Math.min(w, c.fadeOut * tps * ppt) + 'px'; el.appendChild(f); }
    _addResizeHandles(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail >= 2) {
        e.stopPropagation(); e.preventDefault();
        tlDrag = null;
        selectAudio(c.id);
        openEditPanel(c);
        return;
      }
      tlStartBlockDrag(e, 'audio', c);
    });
    lane.appendChild(el);
  }
  if (!audioClips.length) {
    const empty = document.createElement('div');
    empty.className = 'tlEmpty';
    empty.innerText = '「🎵 音楽」から追加 / 音声ファイルをここへドロップ';
    lane.appendChild(empty);
  }
}

function _audioWaveCanvas(c, w, h) {
  const cv = document.createElement('canvas');
  cv.className = 'tlWave';
  const W = Math.max(1, Math.min(4000, Math.round(w))), H = Math.max(1, Math.round(h));
  cv.width = W; cv.height = H;
  const a = audioAssets.get(c.assetId);
  if (!a || !a.peaks) return cv;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.28)';
  const tps = scTps();
  const len = (c.endTick - c.startTick) / tps;
  for (let x = 0; x < W; x++) {
    const sec = c.offsetSec + (x / W) * len;
    const i = Math.floor(sec / a.duration * a.peaks.length);
    const v = i >= 0 && i < a.peaks.length ? a.peaks[i] * c.volume : 0;
    const bh = Math.max(1, Math.min(1, v) * (H - 4));
    g.fillRect(x, (H - bh) / 2, 1, bh);
  }
  return cv;
}

// 音声ファイルを、タイムラインの音の行へドロップして読み込む
function setupAudioDrop() {
  const row = document.getElementById('timelineAudioRow');
  if (!row || row._audioDrop) return;
  row._audioDrop = true;
  row.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); row.classList.add('dropHot'); }
  });
  row.addEventListener('dragleave', () => row.classList.remove('dropHot'));
  row.addEventListener('drop', async (e) => {
    row.classList.remove('dropHot');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /^audio\//.test(f.type) || /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    const tick = tlTickFromClientX(e.clientX);
    for (const f of files) {
      const id = await audioImportFile(f);
      if (id) addAudioAt(tick, id);
    }
    if (typeof renderAssetList === 'function') renderAssetList();
  });
}


// ============================================================
// 右のパネル
// ============================================================

function renderAudioEditFields(title, body, c) {
  title.innerText = '🎵 ' + audioAssetName(c.assetId);
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };
  const slider = (label, min, max, step, get, set, fmt) => {
    const r = row(label);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const v = _el('span', 'fieldValue', fmt(get()));
    bindEditUndo(inp);
    inp.addEventListener('input', () => { set(parseFloat(inp.value)); v.innerText = fmt(get()); renderAudioTrackBlocks(); audioResync(); });
    r.appendChild(inp); r.appendChild(v);
    return inp;
  };
  const a = audioAssets.get(c.assetId);
  const tps = scTps();
  body.appendChild(_el('div', 'poseStatus noKey', `${audioAssetName(c.assetId)} · 音源 ${a ? a.duration.toFixed(1) : '?'}秒 · ブロック ${((c.endTick - c.startTick) / tps).toFixed(1)}秒`));
  if (a && a.credit) body.appendChild(_el('div', 'audioCredit', '♪ 音: ' + a.credit + '(動画の説明などに名前を書いてください)'));

  sec('音量・フェード');
  slider('音量', 0, 2, 0.01, () => c.volume, v => { c.volume = v; }, v => Math.round(v * 100) + '%');
  slider('フェードイン', 0, 5, 0.05, () => c.fadeIn, v => { c.fadeIn = v; }, v => v <= 0 ? 'なし' : v.toFixed(2) + '秒');
  slider('フェードアウト', 0, 5, 0.05, () => c.fadeOut, v => { c.fadeOut = v; }, v => v <= 0 ? 'なし' : v.toFixed(2) + '秒');
  const mRow = _el('label', 'scriptCheck');
  const mute = document.createElement('input');
  mute.type = 'checkbox'; mute.checked = !!c.mute;
  mute.addEventListener('change', () => { pushUndo(); c.mute = mute.checked; editorChanged(); audioResync(); });
  mRow.appendChild(mute); mRow.appendChild(document.createTextNode('消音(ミュート)'));
  body.appendChild(mRow);

  sec('どこから鳴らすか');
  const oRow = row('音源の開始位置');
  const off = document.createElement('input');
  off.type = 'number'; off.step = '0.1'; off.min = '0'; off.className = 'panelInput small'; off.value = c.offsetSec.toFixed(2);
  bindEditUndo(off);
  off.addEventListener('change', () => {
    const v = parseFloat(off.value);
    if (!(v >= 0) || !a) return;
    c.offsetSec = Math.min(v, Math.max(0, a.duration - 0.05));
    c.endTick = Math.min(c.endTick, audioMaxEndTick(c));
    editorChanged(); audioResync();
  });
  oRow.appendChild(off); oRow.appendChild(_el('span', 'fieldUnit', '秒'));
  const acts = _el('div', 'genActions');
  const full = _el('button', 'btn btn-ghost btn-sm', '↔ 音源の最後まで伸ばす');
  full.addEventListener('click', () => {
    pushUndo();
    const maxTick = scMaxTick();
    c.endTick = audioMaxEndTick(c);
    if (maxTick > 0) c.endTick = Math.min(c.endTick, maxTick);
    editorChanged();
  });
  acts.appendChild(full);
  body.appendChild(acts);
  body.appendChild(_el('div', 'panelHint', 'ブロックの左端をドラッグすると音の頭を、右端で終わりを詰められます。再生ヘッドで分割(B)もできます。音声ファイルは、左の素材一覧の「🎵 音楽」の「音声ファイルを読み込む」か、タイムラインの音の行へドロップで読み込めます。'));

  const del = _el('div', 'panelActions');
  const delBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 この音を削除');
  delBtn.addEventListener('click', () => { selectAudio(c.id); deleteSelection(); });
  del.appendChild(delBtn);
  body.appendChild(del);
}


// ============================================================
// 素材一覧(🎵 音楽)
// ============================================================

async function _audioPreview(id) {
  const a = await audioEnsure(id);
  if (!a || !a.buffer) return;
  audioStopPreview();
  const ctx = audioCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = a.buffer;
  const g = ctx.createGain(); g.gain.value = 0.8;
  src.connect(g); g.connect(ctx.destination);
  src.start(ctx.currentTime + 0.01, 0, Math.min(a.duration, 8));
  _audioPreviewNode = src;
}
let _audioPreviewNode = null;
function audioStopPreview() { if (_audioPreviewNode) { try { _audioPreviewNode.stop(); } catch (e) { /* 無視 */ } _audioPreviewNode = null; } }

function renderAudioAssets(list, source) {
  if (source === 'public') { _renderPublic(list, ASSET_CATEGORIES.find(c => c.id === 'music')); return; }
  const grid = _div('assetGrid');
  const items = source === 'official'
    ? OFFICIAL_SOUNDS.map(s => ({ id: s.id, icon: '🎵', label: s.name, desc: (s.credit ? '♪ ' + s.credit : '公式の音'), tags: s.tags }))
    : audioAssetOrder.map(id => audioAssets.get(id)).filter(Boolean).map(a => ({ id: a.id, icon: '🎵', label: a.name, desc: `${a.duration.toFixed(1)}秒` }));
  if (source === 'custom') {
    const box = _div('');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-primary btn-sm pfUploadBtn';
    btn.innerText = '🎵 音声ファイルを読み込む';
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*,.mp3,.wav,.ogg,.m4a'; inp.multiple = true; inp.style.display = 'none';
    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', async () => {
      for (const f of Array.from(inp.files || [])) await audioImportFile(f);
      renderAssetList();
    });
    box.appendChild(btn); box.appendChild(inp);
    list.appendChild(box);
  }
  if (!items.length) {
    list.appendChild(_div('assetHint', 'BGMや効果音のファイル(mp3 / wav / ogg / m4a)を読み込むと、ここに並びます。ブラウザに保存されるので、次に開いた時も使えます。'));
    return;
  }
  for (const it of items) {
    const card = _makeCard('audio:' + it.id, 'music', it.icon, it.label, it.desc, null);
    if (it.tags) card.dataset.tags = ['公式', ...it.tags].join(',');
    _cardButton(card, '▶', '試しに聞く', () => _audioPreview(it.id));
    if (source === 'custom') {
      card.classList.add('custom');
      _cardButton(card, '✕', 'この音源を一覧から消す', async () => { await audioDeleteAsset(it.id); renderAssetList(); showToast(`「${it.label}」を一覧から消しました`); });
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
  list.appendChild(_div('assetHint', 'クリックで再生ヘッドの位置に置きます。タイムラインへドラッグしても置けます。▶で試しに聞けます。'));
}

function isAudioAssetKey(key) { return /^audio:/.test(String(key)); }
async function addAudioAsset(key, tick) {
  const id = String(key).slice(6);
  const a = await audioEnsure(id);
  if (a) addAudioAt(tick, id);
}
