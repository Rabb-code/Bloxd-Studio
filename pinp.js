// pinp.js
// ============================================================
// 🖼 プレビューの上で、カメラの小窓(ピクチャー・イン・ピクチャー)を直接動かす
//   プレビューが主画面の時、小窓(全画面でないカメラ)の上に枠が出る。
//     中をドラッグ: 動かす / 角をドラッグ: 大きさを変える(反対の角は動かない)
//   動かすと、そのカメラの表示位置(cam.display)になる(「自動」だったカメラも、その位置に決まる)。
// ============================================================

let pinpDrag = null;
let _pinpHover = null; // { camId, corner }

// 今の時刻の、カメラごとの四角(WebGLの座標。freecam.js の合成と同じ並べ方)
function previewCameraRects(tick) {
  const [vx, vy, vw, vh] = previewRectGL(true);
  const active = scActiveCamerasAtTick(tick);
  const autoRects = computeSubRects(vx, vy, vw, vh, active.filter(c => !c.display).length);
  let ai = 0;
  return active.map((cam) => {
    let r;
    if (cam.display) {
      const d = scClampDisplay(cam.display);
      const rw = d.w * vw, rh = d.w * vh;
      r = [vx + d.x * vw, vy + vh - (d.y * vh + rh), rw, rh];
    } else r = autoRects[ai++];
    return { cam, rect: r };
  });
}

// 画面(CSS)の座標の四角 { left, top, width, height }
function _pinpCss(r) { return { left: r[0], top: fcCanvas.height - (r[1] + r[3]), width: r[2], height: r[3] }; }

// マウスの下の小窓(手前の層から)。{ cam, css, corner('tl'|'tr'|'bl'|'br'|null) }
function _pinpHit(mx, my) {
  const [vx, vy, vw, vh] = previewRectGL(true);
  const list = previewCameraRects(curTick).filter(x => x.rect[2] < vw - 1 || x.rect[3] < vh - 1);
  for (let i = list.length - 1; i >= 0; i--) {
    const c = _pinpCss(list[i].rect);
    const near = 12;
    const corners = { tl: [c.left, c.top], tr: [c.left + c.width, c.top], bl: [c.left, c.top + c.height], br: [c.left + c.width, c.top + c.height] };
    for (const [k, p] of Object.entries(corners)) if (Math.hypot(mx - p[0], my - p[1]) <= near) return { cam: list[i].cam, css: c, corner: k };
    if (mx >= c.left && mx <= c.left + c.width && my >= c.top && my <= c.top + c.height) return { cam: list[i].cam, css: c, corner: null };
  }
  return null;
}

function _pinpBase() {
  const [vx, vy, vw, vh] = previewRectGL(true);
  return { left: vx, top: fcCanvas.height - (vy + vh), width: vw, height: vh };
}

// freecam.js の mousedown から(プレビューが主画面の時)。処理したら true
function pinpMouseDown(e) {
  const [mx, my] = _canvasMouse(e);
  const hit = _pinpHit(mx, my);
  if (!hit) return false;
  beginEdit();
  const b = _pinpBase();
  pinpDrag = { camId: hit.cam.id, corner: hit.corner, start: [mx, my], css: { ...hit.css }, base: b, moved: false };
  if (selectedCameraId !== hit.cam.id) selectCamera(hit.cam.id, null, false);
  return true;
}

function pinpDragMove(e) {
  const d = pinpDrag;
  const cam = scGetCamera(d.camId);
  if (!cam) { pinpDrag = null; return; }
  const [mx, my] = _canvasMouse(e);
  const dx = mx - d.start[0], dy = my - d.start[1];
  if (!d.moved && Math.hypot(dx, dy) < 3) return;
  d.moved = true;
  const b = d.base, c = d.css;
  let left = c.left, top = c.top, w = c.width;
  if (!d.corner) {
    left += dx; top += dy;
  } else {
    // 反対の角を止めて、横の動きで大きさを決める(縦横比はそのまま)
    const fixX = d.corner.includes('l') ? c.left + c.width : c.left;
    const fixY = d.corner.includes('t') ? c.top + c.height : c.top;
    const nx = d.corner.includes('l') ? Math.min(fixX - 20, c.left + dx) : Math.max(fixX + 20, c.left + c.width + dx);
    w = Math.abs(fixX - nx);
    const h = w * (b.height / b.width);
    left = d.corner.includes('l') ? fixX - w : fixX;
    top = d.corner.includes('t') ? fixY - h : fixY;
  }
  let disp = { x: (left - b.left) / b.width, y: (top - b.top) / b.height, w: w / b.width };
  // 端にぴったり吸着(Altで解除)
  if (!e.altKey) {
    const m = 0.03;
    for (const [k, edge] of [['x', 0], ['y', 0]]) {
      if (Math.abs(disp[k] - edge) < 0.015) disp[k] = edge;
      if (Math.abs(disp[k] - m) < 0.015) disp[k] = m;
      if (Math.abs(disp[k] + disp.w - 1) < 0.015) disp[k] = 1 - disp.w;
      if (Math.abs(disp[k] + disp.w - (1 - m)) < 0.015) disp[k] = 1 - m - disp.w;
    }
  }
  cam.display = scClampDisplay(disp);
  _pinpShowOutline(cam, null);
}

function pinpDragEnd() {
  const d = pinpDrag;
  pinpDrag = null;
  if (!d) return;
  commitEdit();
  editorChanged();
  if (d.moved) showToast('🖼 小窓の位置を決めました(カメラのパネルの「表示位置」でも直せます)');
}

// マウスが乗った小窓に枠を出す。戻り値: カーソルの形(無ければ null)
function pinpHoverAt(e) {
  const [mx, my] = _canvasMouse(e);
  const hit = _pinpHit(mx, my);
  _pinpShowOutline(hit ? hit.cam : null, hit ? hit.corner : null);
  if (!hit) return null;
  return hit.corner ? (hit.corner === 'tl' || hit.corner === 'br' ? 'nwse-resize' : 'nesw-resize') : 'move';
}

function _pinpShowOutline(cam, corner) {
  let el = document.getElementById('pinpOutline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pinpOutline';
    for (const k of ['tl', 'tr', 'bl', 'br']) { const h = document.createElement('div'); h.className = 'pinpCorner ' + k; el.appendChild(h); }
    document.getElementById('freecamArea').appendChild(el);
  }
  if (!cam || !previewIsMain || pilot) { el.style.display = 'none'; return; }
  const item = previewCameraRects(curTick).find(x => x.cam === cam);
  if (!item) { el.style.display = 'none'; return; }
  const c = _pinpCss(item.rect);
  el.style.display = 'block';
  el.style.left = c.left + 'px'; el.style.top = c.top + 'px';
  el.style.width = c.width + 'px'; el.style.height = c.height + 'px';
  el.dataset.corner = corner || '';
}
function pinpHideOutline() { const el = document.getElementById('pinpOutline'); if (el) el.style.display = 'none'; }
