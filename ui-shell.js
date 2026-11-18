// ui-shell.js — ステップ44: 新しい画面の枠
//   上のバー(リプレイの名前・「編集 / できあがり」の切りかえ・保存の状態・「…」メニュー・書き出し)
//   index.html の #appBar を動かす。書き出しのボタンは export.js が #exportSlot に入れる。

const UI_SVG = {
  open: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17h.01"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  shader: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 000 16z" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
function uiIcon(name, size) {
  const s = size || 16;
  return `<svg class="uiIco" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_SVG[name] || ''}</svg>`;
}

const _UI_MENU = [
  { id: 'open', icon: 'open', label: 'プロジェクトを開く', key: '⌘O', run: () => typeof projectOpenDialog === 'function' && projectOpenDialog() },
  { id: 'save', icon: 'save', label: 'ファイルに保存', key: '⌘S', run: () => typeof projectSaveToFile === 'function' && projectSaveToFile() },
  { sep: true },
  { id: 'settings', icon: 'settings', label: 'プロジェクトの設定', run: () => { const b = document.getElementById('projectSettingsBtn'); if (b) b.click(); } },
  { id: 'help', icon: 'help', label: '操作のしかた', key: '?', run: () => typeof toggleHelp === 'function' && toggleHelp(true) },
  { id: 'shmod', icon: 'shader', label: '影MOD(シェーダー)', run: () => typeof openShaderModDialog === 'function' && openShaderModDialog() },
  { sep: true },
  { id: 'theme', icon: 'sun', label: '明るい色にする', run: () => uiSetTheme(document.body.classList.contains('light') ? 'dark' : 'light') },
];

// ステップ48: 明るい色 / 暗い色(ブラウザに覚える)
function uiSetTheme(t) {
  document.body.classList.toggle('light', t === 'light');
  try { localStorage.setItem('bloxdEditor.theme', t); } catch (e) { /* 保存できなくても続ける */ }
  const b = document.querySelector('#appMenu button[data-item="theme"] span:not(.k)');
  if (b) b.textContent = t === 'light' ? '暗い色にする' : '明るい色にする';
}

function _uiCloseMenu() {
  const m = document.getElementById('appMenu'), b = document.getElementById('appMenuBtn');
  if (m) m.classList.remove('open');
  if (b) { b.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); }
}

function _uiBuildMenu() {
  const m = document.getElementById('appMenu'), b = document.getElementById('appMenuBtn');
  if (!m || !b || m.dataset.built) return;
  m.dataset.built = '1';
  for (const it of _UI_MENU) {
    if (it.sep) { m.appendChild(document.createElement('hr')); continue; }
    const btn = document.createElement('button');
    btn.type = 'button'; btn.setAttribute('role', 'menuitem'); btn.dataset.item = it.id;
    btn.innerHTML = uiIcon(it.icon) + '<span></span>' + (it.key ? '<span class="k"></span>' : '');
    btn.children[1].textContent = it.label;
    if (it.key) btn.children[2].textContent = it.key;
    btn.addEventListener('click', () => { _uiCloseMenu(); it.run(); });
    m.appendChild(btn);
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !m.classList.contains('open');
    m.classList.toggle('open', open); b.classList.toggle('open', open); b.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest || !e.target.closest('.menuWrap')) _uiCloseMenu(); });
}

// 「編集 / できあがり」
function _uiBuildViewMode() {
  const seg = document.getElementById('viewModeSeg');
  if (!seg || seg.dataset.built) return;
  seg.dataset.built = '1';
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    if (btn.dataset.mode === 'preview') {
      if (typeof sceneCameras === 'undefined' || !sceneCameras.length) {
        if (typeof showToast === 'function') showToast('カメラを置くと、できあがりの映像を見られます(F キーで今の視点に置けます)');
        return;
      }
      if (typeof pilot !== 'undefined' && pilot && typeof exitPilot === 'function') exitPilot(true);
      previewIsMain = true;
    } else {
      previewIsMain = false;
    }
    _uiSyncViewMode();
  });
}
function _uiSyncViewMode() {
  const seg = document.getElementById('viewModeSeg');
  if (!seg || typeof previewIsMain === 'undefined') return;
  const pv = !!previewIsMain;
  for (const b of seg.querySelectorAll('button[data-mode]')) {
    const on = (b.dataset.mode === 'preview') === pv;
    if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
  }
}

// リプレイの名前(ファイル名の日時から)
function _uiReplayTitle() {
  const r = typeof currentReplayInfo !== 'undefined' ? currentReplayInfo : null;
  if (!r || !r.name) return null;
  const m = r.name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})[_:](\d{2})/);
  if (m) return { title: `${+m[2]}月${+m[3]}日 ${m[4]}:${m[5]} のリプレイ`, sub: r.name };
  return { title: r.name.replace(/\.bloxdreplay$/i, ''), sub: '' };
}

let _uiLastSaved = undefined, _uiSavedAt = null;
function _uiTick() {
  _uiSyncViewMode();
  const t = _uiReplayTitle();
  const te = document.getElementById('appTitle'), se = document.getElementById('appSub');
  if (t && te && te.textContent !== t.title) { te.textContent = t.title; te.title = t.sub; }
  if (se && typeof timeline !== 'undefined' && timeline && timeline.frames && typeof allTimelines !== 'undefined' && allTimelines) {
    const tps = allTimelines.ticksPerSecond || 30;
    const sec = Math.max(0, timeline.frames.length - 1) / tps;
    const txt = '長さ ' + Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
    if (se.textContent !== txt) se.textContent = txt;
  }
  // 保存の状態
  const ss = document.getElementById('saveState');
  if (ss && typeof _projectLastSaved !== 'undefined') {
    if (_projectLastSaved !== _uiLastSaved) {
      if (_uiLastSaved !== undefined && _projectLastSaved) _uiSavedAt = new Date();
      _uiLastSaved = _projectLastSaved;
    }
    let txt = '';
    if (typeof _projectAutosaveArmed !== 'undefined' && !_projectAutosaveArmed) txt = '';
    else if (_uiSavedAt) txt = '保存しました ' + _uiSavedAt.getHours() + ':' + String(_uiSavedAt.getMinutes()).padStart(2, '0');
    else txt = '自動で保存します';
    if (ss.dataset.t !== txt) { ss.dataset.t = txt; ss.innerHTML = txt ? uiIcon('check', 14) : ''; if (txt) ss.appendChild(document.createTextNode(txt)); }
  }
  // 読み込みが終わったら、左上の読み込みの表示は消す
  const ls = document.getElementById('loadStatus');
  if (ls) ls.classList.toggle('done', /完了/.test(ls.textContent || ''));
}

// ステップ48: 人を動かす道具の帯。freecam.js の updateViewportOverlays から毎コマ呼ぶ(変わった時だけ書きかえる)
let _uiToolSig = '';
function uiPoseToolbarSync() {
  const bar = document.getElementById('poseToolbar');
  if (!bar) return;
  const on = typeof _poseEditingOn === 'function' && _poseEditingOn() && !(typeof consPick !== 'undefined' && consPick) &&
    typeof poseEntityBase === 'function' && !!poseEntityBase(poseEntity, curTick);
  const type = on ? entityRigType(poseEntity) : '';
  const tool = on && typeof poseToolFor === 'function' ? poseToolFor(type) : '';
  const hasIk = on && ((RIG_TYPES[type] || {}).ik || []).length > 0;
  const attach = on && typeof _consSelected === 'function' && !!_consSelected();
  const sig = [on, tool, hasIk, attach].join('|');
  if (sig === _uiToolSig) return;
  _uiToolSig = sig;
  bar.classList.toggle('show', on);
  bar.classList.toggle('noAttach', !attach);
  const area = document.getElementById('freecamArea');
  if (area) area.classList.toggle('toolbarOn', on);
  for (const b of bar.querySelectorAll('button[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === tool);
    b.setAttribute('aria-pressed', b.dataset.tool === tool ? 'true' : 'false');
    if (b.dataset.tool === 'ik') b.disabled = !hasIk;
  }
}
function _uiBuildPoseToolbar() {
  const bar = document.getElementById('poseToolbar');
  if (!bar || bar.dataset.built) return;
  bar.dataset.built = '1';
  bar.addEventListener('mousedown', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool && typeof setPoseTool === 'function') setPoseTool(b.dataset.tool);
    else if (b.dataset.act === 'key' && typeof poseRecordKeys === 'function') poseRecordKeys();
    else if (b.dataset.act === 'attach') {
      const lp = typeof _consSelected === 'function' ? _consSelected() : null;
      if (lp) { if (consPick && consPick.id === lp.id) consCancelPick(); else consStartPick(lp.id, 'parent'); }
    }
    b.blur();
    _uiToolSig = '';
    uiPoseToolbarSync();
  });
}

function uiShellInit() {
  _uiBuildPoseToolbar();
  _uiBuildMenu();
  _uiBuildViewMode();
  { let t = 'dark'; try { t = localStorage.getItem('bloxdEditor.theme') || 'dark'; } catch (e) { /* なければ暗い色 */ } uiSetTheme(t); }
  setInterval(_uiTick, 400);
  _uiTick();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', uiShellInit);
else uiShellInit();
