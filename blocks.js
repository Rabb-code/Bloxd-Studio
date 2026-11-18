// blocks.js
// ============================================================
// 🧱 ブロック(動かせるブロックのエンティティ)の使い方の画面
//   ・素材一覧の「🧱 ブロック」: リプレイ・テクスチャの全部のブロックの絵を並べる(リプレイにある物が先)。
//       クリック=今見ている所の地面に置く / 3D画面へドラッグ=落とした所 / タイムラインへドラッグ=その時刻
//   ・タイムラインの「グローバル」のタブに「🧱 ブロック」の行(ポーズのタブへ行かなくても動かせる)
//   ・右パネルはブロック用(絵・大きさ・動き・くっつく/向く/届く・長さ)
//   中身(データ)は、ポーズの人形の型 'block'(poses.js)と、絵の描画(blockfx.js)のまま。
// ============================================================

function isBlockKey(key) {
  if (!key || !String(key).startsWith('puppet:')) return false;
  const p = puppetGet(+String(key).slice(7));
  return !!(p && p.type === 'block');
}

// テクスチャの名前 → 画面に出す名前(例: "oak_planks.png" → "oak planks")
function blockTexLabel(name) {
  return String(name || 'ブロック').replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
}


// ============================================================
// 置く
// ============================================================

function isBlockAssetKey(key) { return /^btex:/.test(String(key)); }
function addBlockAsset(key, tick) { addBlockAt(tick, String(key).slice(5)); }

function addBlockAt(tick, texName) {
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = false;
  const { mx, my } = _poseDropPoint();
  pushUndo();
  const pup = poseAddPuppet(_posePuppetPlace(mx, my), 'block');
  if (texName) pup.texture = texName;
  pup.name = blockTexLabel(pup.texture) + ' ' + pup.id;
  const b = poseAddBlock(tick, 'puppet:' + pup.id, { name: pup.name, seconds: 3 });
  if (curTick < b.startTick || curTick >= b.endTick) seekTo(b.startTick);
  if (timelineTab !== 'pose') setTimelineTab('global');
  poseEntity = 'puppet:' + pup.id;
  poseSetJoint('root');
  selectPose(b.id);
  poseExpandedId = b.id;
  openEditPanel(b);
  showToast(`🧱 「${pup.name}」を置きました。矢印・リングで動かすと、その時刻にキーができます`);
  return b;
}


// ============================================================
// 素材一覧(🧱 ブロック)
// ============================================================

let _blockThumbObserver = null;
function _blockLazyThumb(el, name) {
  if (typeof IntersectionObserver === 'undefined') { el.style.backgroundImage = `url(${blockFxThumb(name)})`; return; }
  if (!_blockThumbObserver) {
    _blockThumbObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const t = en.target;
        const url = blockFxThumb(t.dataset.tex);
        if (url) t.style.backgroundImage = `url(${url})`;
        _blockThumbObserver.unobserve(t);
      }
    }, { root: document.getElementById('assetList'), rootMargin: '200px' });
  }
  el.dataset.tex = name;
  _blockThumbObserver.observe(el);
}

function renderBlockAssets(list, source) {
  if (source !== 'official') return;
  const names = (typeof blockFxTextureNames === 'function') ? blockFxTextureNames() : [];
  if (!names.length) { list.appendChild(_div('assetHint', 'ブロックの絵がまだ読み込まれていません')); return; }
  const used = new Set(((typeof fcMeshPalette !== 'undefined' && fcMeshPalette) || []).map(p => p && p.texture).filter(Boolean));
  const grid = _div('assetGrid');
  for (const n of names) {
    const inReplay = used.has(n);
    const card = _makeCard('btex:' + n, 'block', '', blockTexLabel(n), inReplay ? 'リプレイにあるブロック' : 'ブロック', null);
    card.dataset.tags = ['公式', inReplay ? 'リプレイにある' : 'ほかのブロック'].join(',');
    const th = card.querySelector('.assetThumb');
    th.classList.add('blockThumb');
    _blockLazyThumb(th, n);
    grid.appendChild(card);
  }
  list.appendChild(grid);
  list.appendChild(_div('assetHint', 'クリックで今見ている所の地面に、3D画面へドラッグすると落とした所に置きます。置いた後は、矢印・リングで動かす・四角の付いた線で大きさ。動かすとその時刻にキーができて、キーの間はなめらかに動きます。'));
}


// ============================================================
// タイムライン(グローバルのタブの「🧱 ブロック」の行)
// ============================================================

function renderBlockTrackBlocks() {
  const lane = document.getElementById('timelineBlockLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const mine = poseBlocks.filter(b => isBlockKey(b.target));
  const sorted = mine.slice().sort((a, c) => a.startTick - c.startTick);
  const rowEnds = [], rows = new Map();
  for (const b of sorted) {
    let r = rowEnds.findIndex(end => end <= b.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = b.endTick; rows.set(b.id, r);
  }
  const h = Math.max(1, rowEnds.length) * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick();
  for (const b of mine) {
    const pup = puppetGet(+b.target.slice(7));
    const el = document.createElement('div');
    const isSel = b.id === selectedPoseId;
    el.className = 'tlBlock blockEnt' + (isSel ? ' selected' : '');
    el.style.left = (b.startTick * ppt) + 'px';
    el.style.width = Math.max(6, (b.endTick - b.startTick) * ppt) + 'px';
    el.style.top = ((rows.get(b.id) || 0) * TL_ROW_H + 3) + 'px';
    const url = pup && pup.texture && typeof blockFxThumb === 'function' ? blockFxThumb(pup.texture) : '';
    if (url) { const th = _el('div', 'tlBlockThumb'); th.style.backgroundImage = `url(${url})`; el.appendChild(th); }
    const label = _el('div', 'tlBlockLabel' + (url ? ' withThumb' : ''), pup ? pup.name : b.name);
    el.appendChild(label);
    for (const t of poseKeyTimes(b)) {
      const at = _poseAbsTick(b, t);
      if (at < b.startTick - 1e-6 || at > b.endTick + 1e-6) continue;
      const d = document.createElement('div');
      const act = isSel && poseSelKey && poseSelKey.joint === '*' && Math.abs(poseSelKey.time - t) < 0.006;
      d.className = 'tlKey pose' + (act ? ' active' : '');
      d.style.left = ((at - b.startTick) * ppt) + 'px';
      d.title = `${t.toFixed(2)}秒のキー — クリックでその時刻へ / ドラッグで時刻を変える`;
      d.addEventListener('mousedown', (e) => _poseKeyMouseDown(e, b, '*', t));
      el.appendChild(d);
    }
    _addResizeHandles(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail >= 2) {
        e.stopPropagation(); e.preventDefault();
        tlDrag = null;
        if (curTick < b.startTick || curTick >= b.endTick) seekTo(Math.max(b.startTick, Math.min(b.endTick - 1, tlTickFromClientX(e.clientX))));
        selectPose(b.id);
        poseSetJoint('root');
        openEditPanel(b);
        return;
      }
      tlStartBlockDrag(e, 'pose', b);
    });
    lane.appendChild(el);
  }
  if (!mine.length) lane.appendChild(_el('div', 'tlEmpty', '「🧱 ブロック」から置く'));
}


// ============================================================
// 右パネル(ブロック用)
// ============================================================

function renderBlockEditFields(title, body, b, pup) {
  title.innerText = '🧱 ' + pup.name;
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };

  const nameRow = row('名前');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = pup.name;
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { pup.name = nameInput.value; b.name = nameInput.value; renderBlockTrackBlocks(); title.innerText = '🧱 ' + pup.name; });
  nameRow.appendChild(nameInput);

  sec('ブロックの絵');
  if (typeof renderBlockTexturePicker === 'function') renderBlockTexturePicker(body, pup);

  sec('大きさ(ブロック何個ぶん)');
  ['幅', '高さ', '奥行き'].forEach((label, i) => {
    const r = row(label);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = '0.05'; inp.max = '20'; inp.step = '0.05'; inp.value = pup.size[i];
    const v = _el('span', 'fieldValue', (+pup.size[i]).toFixed(2));
    bindEditUndo(inp);
    inp.addEventListener('input', () => { pup.size[i] = parseFloat(inp.value); v.innerText = pup.size[i].toFixed(2); });
    r.appendChild(inp); r.appendChild(v);
  });

  // 動き(全体のキー)
  sec('動き');
  const tr = b.tracks.root || [];
  body.appendChild(_el('div', 'poseStatus noKey', tr.length ? `キー ${tr.length}個 · 3Dで矢印・リング・四角の付いた線を動かすと、再生ヘッドの時刻にキーができます` : 'まだ動きません。3Dで矢印・リングを動かすと、再生ヘッドの時刻にキーができます'));
  const acts = _el('div', 'panelActions');
  const keyBtn = _el('button', 'btn btn-primary btn-sm', '◆ 今の位置・向き・大きさでキーを打つ (K)');
  keyBtn.addEventListener('click', () => { poseSetJoint('root'); poseRecordKeys(); });
  acts.appendChild(keyBtn);
  body.appendChild(acts);
  const seg = _poseSegAt(b, 'root', curTick);
  if (seg >= 0) {
    const cur = scCurvePresetId(tr[seg].curve);
    body.appendChild(_el('div', 'curveSegLabel', `◆${seg + 1} → ◆${seg + 2} の進み方(再生ヘッドの所)`));
    const cg = _el('div', 'settingsRadioGroup');
    for (const [id, p] of Object.entries(CURVE_PRESETS)) {
      const pill = _el('button', 'settingsRadioPill curvePill' + (cur === id ? ' active' : ''));
      pill.type = 'button';
      pill.appendChild(_curveIcon(p.c));
      pill.appendChild(document.createTextNode(p.label));
      pill.addEventListener('click', () => { if (cur === id) return; pushUndo(); tr[seg].curve = p.c.slice(); editorChanged(); });
      cg.appendChild(pill);
    }
    body.appendChild(cg);
  }

  if (typeof renderConsPanel === 'function') renderConsPanel(body, pup);

  sec('出ている時間');
  const durRow = row('長さ');
  const dur = document.createElement('input');
  dur.type = 'number'; dur.step = '0.1'; dur.min = '0.1'; dur.className = 'panelInput small';
  dur.value = ((b.endTick - b.startTick) / scTps()).toFixed(1);
  bindEditUndo(dur);
  dur.addEventListener('change', () => {
    const v = parseFloat(dur.value);
    if (!(v > 0)) return;
    const maxTick = scMaxTick();
    b.endTick = Math.max(b.startTick + 1, Math.round(b.startTick + v * scTps()));
    if (maxTick > 0) b.endTick = Math.min(b.endTick, maxTick);
    editorChanged();
  });
  durRow.appendChild(dur);
  durRow.appendChild(_el('span', 'fieldUnit', '秒'));
  body.appendChild(_el('div', 'panelHint', 'ブロックは、タイムラインのこの長さの間だけ出ます。3Dでクリックして選び、矢印で動かす・リングで回す・四角の付いた線で大きさ(Shiftで全部同じ割合)。Shift+矢印で置き場所ごと動かします。'));

  const del = _el('div', 'panelActions');
  const delBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 このブロックを削除');
  delBtn.addEventListener('click', () => { selectPose(b.id); poseSelKeyExplicit = false; deleteSelection(); });
  del.appendChild(delBtn);
  body.appendChild(del);
}
