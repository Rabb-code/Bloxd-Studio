// project.js
// ============================================================
// 💾 プロジェクトの保存・読み込み・自動保存
//   保存(.bloxdproj): 編集した物全部(カメラ・テキスト・パーティクル・ポーズ・人形・音)+設定+視点、
//     使っている音声ファイル・写真も中に入れる(別のパソコンでも開ける)。リプレイ本体は入れない。
//   開く: リプレイを読み込んだ後に開く(別のリプレイ用なら、確認してから開く)。Undoで戻せる。
//   自動保存: 変わったら数秒後にブラウザ(IndexedDB)へ。同じリプレイを次に開いた時、続きを開けるか聞く。
// ============================================================

const PROJECT_FORMAT = 'bloxd-replay-editor-project';
const PROJECT_VERSION = 1;
const PROJECT_AUTOSAVE_MS = 3000;

function projectReplayKey() {
  const r = typeof currentReplayInfo !== 'undefined' ? currentReplayInfo : null;
  return r ? `${r.name}|${r.size}` : 'unknown';
}

function _b64FromBytes(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function _bytesFromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

// 中身が空(何も置いていない)か
function _projectIsEmpty(state) {
  return !['sceneCameras', 'textBlocks', 'particleBlocks', 'poseBlocks', 'puppets', 'audioClips', 'buildBlocks'].some(k => state[k] && state[k].length);
}

function projectSnapshot(includeMedia) {
  const o = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt: new Date().toISOString(),
    replay: { ...(currentReplayInfo || {}), ticks: scMaxTick() },
    state: JSON.parse(_editorStateJson()),
    settings: {
      exportQualityId, exportResolutionId,
      autoAnim: (typeof autoAnim !== 'undefined') ? { ...autoAnim } : null,
      shaderMod: (typeof shmodProjectData === 'function') ? shmodProjectData() : null,   // ステップ52: 影MOD(中身ごと)
    },
    view: { pos: fcPos.slice(), yaw: fcYaw, pitch: fcPitch, fov: fcFovDeg },
  };
  if (includeMedia) {
    const audioIds = new Set((o.state.audioClips || []).map(c => c.assetId).filter(id => /^a/.test(String(id)))); // 読み込んだ音だけ(公式の音は sounds/ にある)
    const photoIds = new Set((o.state.particleBlocks || []).map(b => b.imageId).filter(id => id && !String(id).startsWith('builtin:')));
    o.media = {
      audio: [...audioIds].map(id => { const a = audioAssets.get(id); return a && a.bytes ? { id, name: a.name, data: _b64FromBytes(a.bytes) } : null; }).filter(Boolean),
      photos: [...photoIds].map(id => { const im = particleImages.get(id); return im && im.dataUrl ? { id, name: im.name, dataUrl: im.dataUrl } : null; }).filter(Boolean),
      structures: (typeof buildMediaForProject === 'function') ? buildMediaForProject(o.state) : [],   // ステップ49: 建築
    };
  }
  return o;
}

// ファイルに保存(ダウンロード)
function projectSaveToFile() {
  const o = projectSnapshot(true);
  const blob = new Blob([JSON.stringify(o)], { type: 'application/json' });
  const base = ((currentReplayInfo && currentReplayInfo.name) || 'bloxd').replace(/\.[^.]+$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = base + '.bloxdproj';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  window._lastProjectBlob = blob;
  _projectAutosaveNow();
  showToast(`💾 「${a.download}」に保存しました(音・写真も入っています)`);
}

// ファイルを選んで開く
function projectOpenDialog() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.bloxdproj,.json,application/json';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    let o;
    try { o = JSON.parse(await f.text()); } catch (e) { showToast('このファイルは開けませんでした(プロジェクトのファイルではないようです)'); return; }
    projectOpenObject(o);
  });
  inp.click();
}

async function projectOpenObject(o, opts) {
  opts = opts || {};
  if (!o || o.format !== PROJECT_FORMAT || !o.state) { showToast('このファイルは開けませんでした(プロジェクトのファイルではないようです)'); return false; }
  const r = o.replay || {};
  const same = currentReplayInfo && r.name === currentReplayInfo.name && r.size === currentReplayInfo.size;
  if (!same && !opts.force) {
    _projectConfirm(`このプロジェクトは別のリプレイ(${r.name || '不明'})用です。今のリプレイ(${currentReplayInfo ? currentReplayInfo.name : '不明'})でそのまま開きますか?\n(位置や時刻がずれることがあります)`,
      '開く', () => projectOpenObject(o, { ...opts, force: true }));
    return false;
  }
  // 音・写真を先に戻す
  const media = o.media || {};
  for (const m of media.audio || []) {
    if (audioAssets.has(m.id)) continue;
    const bytes = _bytesFromB64(m.data);
    const a = await audioDecodeBytes(m.id, m.name, bytes);
    if (a) { audioAssetOrder.push(m.id); idbPut('audio', { id: m.id, name: m.name, bytes, added: Date.now() }); }
  }
  for (const p of media.photos || []) {
    if (particleImages.has(p.id)) continue;
    _pfRegisterDataUrl(p.id, p.name, p.dataUrl);
    particleImageOrder.push(p.id);
  }
  if ((media.photos || []).length) _pfLsSave();
  if (typeof buildRestoreMedia === 'function') await buildRestoreMedia(media.structures);
  if (!opts.noUndo) pushUndo();
  if (typeof closeEditPanel === 'function') closeEditPanel();
  _restoreEditorState(JSON.stringify(o.state));
  const s = o.settings || {};
  if (s.exportQualityId && EXPORT_QUALITY_PRESETS[s.exportQualityId]) exportQualityId = s.exportQualityId;
  if (s.exportResolutionId && EXPORT_RESOLUTION_PRESETS[s.exportResolutionId]) exportResolutionId = s.exportResolutionId;
  if (s.autoAnim && typeof setAutoAnim === 'function') setAutoAnim(s.autoAnim);
  if (typeof shmodRestoreProject === 'function') shmodRestoreProject(s.shaderMod);
  if (o.view && o.view.pos) {
    fcPos = o.view.pos.slice(); fcYaw = o.view.yaw; fcPitch = o.view.pitch;
    if (o.view.fov) { fcFovDeg = o.view.fov; const sl = document.getElementById('fovSlider'); if (sl) { sl.value = fcFovDeg; document.getElementById('fovValue').innerText = fcFovDeg + '°'; } }
  }
  previewIsMain = false;
  editorChanged();
  if (typeof renderTimelineTabs === 'function') renderTimelineTabs();
  if (typeof renderAssetList === 'function') renderAssetList();
  _projectAutosaveArmed = true;
  if (!opts.quiet) showToast('📂 プロジェクトを開きました(Ctrl+Z で開く前に戻せます)');
  return true;
}


// ============================================================
// 自動保存(ブラウザの中)
// ============================================================

let _projectAutosaveArmed = false;
let _projectLastSaved = null;
let _projectTimer = null;

async function _projectAutosaveNow() {
  if (!_projectAutosaveArmed || (typeof exportState !== 'undefined' && exportState)) return;
  const o = projectSnapshot(false);
  const json = JSON.stringify(o.state);
  if (json === _projectLastSaved) return;
  _projectLastSaved = json;
  await idbPut('projects', { key: projectReplayKey(), savedAt: o.savedAt, project: o });
}

function projectInit() {
  // ステップ44: 保存・開くは上のバーの「…」メニュー(ui-shell.js)。ボタンはもう作らない
  const del = null;
  if (del && !document.getElementById('saveBtn')) {
    const sep = document.createElement('div'); sep.className = 'tbSep';
    const save = document.createElement('button');
    save.id = 'saveBtn'; save.className = 'tbBtn'; save.innerText = '💾 保存';
    save.title = 'プロジェクトをファイルに保存 (Ctrl/Cmd+S)。自動でブラウザにも保存しています';
    save.addEventListener('click', projectSaveToFile);
    const open = document.createElement('button');
    open.id = 'openBtn'; open.className = 'tbBtn'; open.innerText = '📂 開く';
    open.title = '保存したプロジェクトを開く (Ctrl/Cmd+O)';
    open.addEventListener('click', projectOpenDialog);
    del.after(sep, save, open);
  }
  clearInterval(_projectTimer);
  _projectTimer = setInterval(_projectAutosaveNow, PROJECT_AUTOSAVE_MS);
  window.addEventListener('beforeunload', () => { _projectAutosaveNow(); });
  // 同じリプレイの、前回の作業があるか
  idbGet('projects', projectReplayKey()).then((rec) => {
    if (!rec || !rec.project || _projectIsEmpty(rec.project.state)) { _projectAutosaveArmed = true; return; }
    _projectShowRestoreBar(rec);
  });
}

function _projectShowRestoreBar(rec) {
  const box = document.createElement('div');
  box.id = 'restoreBar';
  box.className = 'glass';
  const d = new Date(rec.savedAt);
  const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  box.appendChild(_el('span', null, `💾 このリプレイの、前回の作業があります(${when})`));
  const yes = _el('button', 'btn btn-primary btn-sm', '続きを開く');
  const no = _el('button', 'btn btn-ghost btn-sm', 'いらない');
  const close = () => { box.remove(); _projectAutosaveArmed = true; };
  yes.addEventListener('click', async () => { box.remove(); await projectOpenObject(rec.project, { force: true, noUndo: true, quiet: true }); showToast('📂 前回の作業を開きました'); _projectAutosaveArmed = true; });
  no.addEventListener('click', close);
  box.appendChild(yes); box.appendChild(no);
  (document.getElementById('freecamArea') || document.body).appendChild(box);
}

function _projectConfirm(message, okLabel, onOk) {
  let m = document.getElementById('projectModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'projectModal';
    m.innerHTML = '<div id="projectBox"><div id="projectHead"><h2>📂 プロジェクトを開く</h2><button id="projectClose" type="button">✕</button></div><div id="projectBody"></div></div>';
    document.body.appendChild(m);
    m.querySelector('#projectClose').addEventListener('click', () => m.classList.remove('open'));
  }
  const body = m.querySelector('#projectBody');
  body.innerHTML = '';
  const p = _el('div', 'exportStatus', message);
  p.style.whiteSpace = 'pre-wrap';
  body.appendChild(p);
  const acts = _el('div', 'panelActions');
  const ok = _el('button', 'btn btn-primary', okLabel);
  ok.addEventListener('click', () => { m.classList.remove('open'); onOk(); });
  const cancel = _el('button', 'btn btn-ghost btn-sm', 'やめる');
  cancel.addEventListener('click', () => m.classList.remove('open'));
  acts.appendChild(ok); acts.appendChild(cancel);
  body.appendChild(acts);
  m.classList.add('open');
}
