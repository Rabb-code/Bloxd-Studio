// motion-path.js — ステップ43: 動きの道(モーションパス)
//
//   ・選んでいるエンティティ(プレイヤー・人形・ブロック)の「全体(root)」が通る道を、3Dに線で出す。
//       線の上の小さな点は 0.25 秒ごと(点の間が広い所 = 速い所)。再生ヘッドより前はうすい色。
//   ・全体のキーは道の上の◆。◆をドラッグすると、そのキーの位置が動く(ふつう = 水平に、Shift = 上下に)。
//   ・道の線をクリック = その時刻へ移動。線をつかんで引っぱる = その時刻に全体のキーを作って動かす。
//   ・ポーズのブロックの「道をなめらかに」(b.smoothPath): 全体の位置を、キーを通る曲線(Catmull-Rom)でつなぐ。
//       速さのカーブ(等速・なめらか…)は、曲線の上の「進んだ長さ」に効く(等速なら曲線の上を同じ速さで進む)。
//   データ: ポーズのブロックに smoothPath(true/false)が増えるだけ。前のプロジェクトは false(まっすぐ)のまま。

let mpShow = (() => { try { return localStorage.getItem('bloxdEditor.motionPath') !== '0'; } catch (e) { return true; } })();
function mpSetShow(v) {
  mpShow = !!v;
  try { localStorage.setItem('bloxdEditor.motionPath', mpShow ? '1' : '0'); } catch (e) { /* 保存できなくても続ける */ }
}

const MP_MAX_SAMPLES = 400;
const MP_DOT_SEC = 0.25;
const MP_COLOR_FUTURE = [1.0, 0.82, 0.28];
const MP_COLOR_PAST = [0.62, 0.58, 0.42];
const MP_KEY_PX = 6;


// ============================================================
// なめらかな道(全体の位置だけ)
// ============================================================

// 区間 i の曲線の上で、長さの割合 u(0〜1)の所
function _mpSegPoint(ps, i, u) {
  const N = 16;
  const pts = [], len = [0];
  for (let n = 0; n <= N; n++) {
    pts.push(catmullRomPos(ps, i, n / N));
    if (n) len.push(len[n - 1] + Math.hypot(pts[n][0] - pts[n - 1][0], pts[n][1] - pts[n - 1][1], pts[n][2] - pts[n - 1][2]));
  }
  const L = len[N];
  if (L < 1e-6) return ps[i].slice();
  const want = Math.max(0, Math.min(1, u)) * L;
  let n = 1;
  while (n < N && len[n] < want) n++;
  const f = (want - len[n - 1]) / ((len[n] - len[n - 1]) || 1);
  // 細かい区間の中は、曲線の式で求め直す(折れ線にならないように)
  return catmullRomPos(ps, i, (n - 1 + f) / N);
}

// 全体のキーの列から、s 秒の位置(なめらかな道)
function mpSmoothRootP(track, s) {
  if (!track || track.length < 3) return null;   // キー2つ以下はまっすぐと同じ
  const last = track[track.length - 1];
  if (s <= track[0].time) return track[0].p.slice();
  if (s >= last.time) return last.p.slice();
  let i = 0;
  while (i < track.length - 2 && s > track[i + 1].time) i++;
  const a = track[i], c = track[i + 1];
  const x = Math.max(0, Math.min(1, (s - a.time) / ((c.time - a.time) || 1)));
  return _mpSegPoint(track.map(k => k.p), i, scEase(a.curve || null, x));
}

// poses.js の poseBlockPose / poseEntityPose から呼ぶ: なめらかな道のブロックなら、全体の位置を差しかえる
function mpApplySmooth(b, pose, s) {
  if (!b || !b.smoothPath || !pose.root) return;
  const p = mpSmoothRootP(b.tracks.root, s);
  if (p) pose.root.p = p;
}


// ============================================================
// 道の点(キャッシュ)
// ============================================================

let _mpCache = null;

function _mpRange(key) {
  const maxTick = scMaxTick();
  const b = poseBlockAtTick(key, curTick);
  if (b) return { s: b.startTick, e: b.endTick - 1, b };
  if (key.startsWith('puppet:')) {
    const sp = _puppetSpan(+key.slice(7));
    if (sp) return { s: sp[0], e: sp[1] - 1, b: null };
  }
  const w = Math.round(2 * scTps());
  return { s: Math.max(0, curTick - w), e: Math.min(maxTick, curTick + w), b: null };
}

function _mpSig(key, rg) {
  const blocks = poseBlocks.filter(b => b.target === key);
  const pup = key.startsWith('puppet:') ? puppetGet(+key.slice(7)) : null;
  return key + '|' + rg.s + '|' + rg.e + '|' + JSON.stringify(blocks) + '|' + JSON.stringify(pup) +
    '|' + (typeof autoAnim !== 'undefined' ? JSON.stringify(autoAnim) : '');
}

function _mpRootPoint(key, f) {
  const rig = poseRigFor(key, f);
  return rig ? _m4Point(rig.pre.root, [0, 0, 0]) : null;
}

// 道の点の列 [{ tick, pos|null }]。設定が変わった時・ドラッグ中だけ作り直す
function mpSamples(key) {
  const rg = _mpRange(key);
  const sig = _mpSig(key, rg);
  const now = performance.now();
  if (_mpCache && _mpCache.sig === sig && !(poseDrag && now - _mpCache.at > 30) && now - _mpCache.at < 1500) return _mpCache;
  const step = Math.max(1, Math.ceil((rg.e - rg.s + 1) / MP_MAX_SAMPLES));
  const pts = [];
  for (let f = rg.s; f <= rg.e; f += step) pts.push({ tick: f, pos: _mpRootPoint(key, f) });
  if (pts.length && pts[pts.length - 1].tick !== rg.e) pts.push({ tick: rg.e, pos: _mpRootPoint(key, rg.e) });
  // 全体のキー(◆)
  const keys = [];
  const b = rg.b;
  if (b && b.tracks.root) {
    b.tracks.root.forEach((k, index) => {
      if (b.loopLen > 0 && k.time > b.loopLen + 1e-6) return;
      const t = Math.round(_poseAbsTick(b, k.time));
      if (t < b.startTick || t >= b.endTick) return;
      const pos = _mpRootPoint(key, t);
      if (pos) keys.push({ index, tick: t, pos, ref: k });
    });
  }
  _mpCache = { sig, at: now, key, pts, keys, b, step };
  return _mpCache;
}

function _mpActive() {
  return mpShow && typeof _poseEditingOn === 'function' && _poseEditingOn() && poseEntity &&
    !(typeof consPick !== 'undefined' && consPick);
}


// ============================================================
// 描画(renderPoseGizmos から)
// ============================================================

function renderMotionPath(gl, view, proj, W, H) {
  if (!_mpActive()) return;
  const c = mpSamples(poseEntity);
  const past = [], fut = [], dots = [];
  const dotEvery = Math.max(1, Math.round(MP_DOT_SEC * scTps() / c.step));
  for (let i = 0; i < c.pts.length; i++) {
    const a = c.pts[i];
    if (!a.pos) continue;
    if (i % dotEvery === 0) dots.push(a);
    const n = c.pts[i + 1];
    if (!n || !n.pos) continue;
    if (Math.hypot(n.pos[0] - a.pos[0], n.pos[1] - a.pos[1], n.pos[2] - a.pos[2]) > 8 * c.step) continue; // 瞬間移動はつながない
    (n.tick <= curTick ? past : fut).push(a.pos, n.pos);
  }
  if (past.length) _drawLineSegments(gl, view, proj, past, MP_COLOR_PAST, W, H, 2);
  if (fut.length) _drawLineSegments(gl, view, proj, fut, MP_COLOR_FUTURE, W, H, 2.4);
  const dp = [], df = [];
  for (const d of dots) (d.tick <= curTick ? dp : df).push(..._poseCircleSegments(d.pos, 2.2, 6));
  if (dp.length) _drawLineSegments(gl, view, proj, dp, MP_COLOR_PAST, W, H, 1.6);
  if (df.length) _drawLineSegments(gl, view, proj, df, MP_COLOR_FUTURE, W, H, 1.8);
  const sel = poseSelKey && poseSelKey.joint === 'root' && c.b && selectedPoseId === c.b.id ? poseSelKey.index : -1;
  for (const k of c.keys) {
    const hot = k.index === sel || (poseDrag && poseDrag.mp && poseDrag.ref === k.ref) || (_mpHover && _mpHover.ref === k.ref);
    _drawLineSegments(gl, view, proj, _keyDiamondSegments(k.pos, hot ? MP_KEY_PX * 1.4 : MP_KEY_PX),
      hot ? [1, 0.6, 0.2] : [1, 1, 1], W, H, hot ? 3 : 2.2);
  }
}


// ============================================================
// 操作
// ============================================================

let _mpHover = null;

// マウスの近くの ◆ か線。{ kind:'key', ref, index, tick, pos } / { kind:'line', tick, pos }
function _mpPick(mx, my) {
  if (!_mpActive()) return null;
  const { view, proj } = _fcEditViewProj();
  const W = fcCanvas.width, H = fcCanvas.height;
  const c = mpSamples(poseEntity);
  let best = null, bestD = 9;
  for (const k of c.keys) {
    const sp = projectToScreen(k.pos, view, proj, W, H);
    if (!sp) continue;
    const d = Math.hypot(sp.x - mx, sp.y - my);
    if (d < bestD) { bestD = d; best = { kind: 'key', ref: k.ref, index: k.index, tick: k.tick, pos: k.pos, d }; }
  }
  if (best) return best;
  bestD = 6;
  for (let i = 0; i + 1 < c.pts.length; i++) {
    const a = c.pts[i], n = c.pts[i + 1];
    if (!a.pos || !n.pos) continue;
    const sa = projectToScreen(a.pos, view, proj, W, H), sn = projectToScreen(n.pos, view, proj, W, H);
    if (!sa || !sn) continue;
    const vx = sn.x - sa.x, vy = sn.y - sa.y, l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((mx - sa.x) * vx + (my - sa.y) * vy) / l2)) : 0;
    const d = Math.hypot(sa.x + vx * t - mx, sa.y + vy * t - my);
    if (d < bestD) {
      bestD = d;
      const tick = Math.round(a.tick + (n.tick - a.tick) * t);
      best = { kind: 'line', tick, pos: [0, 1, 2].map(q => a.pos[q] + (n.pos[q] - a.pos[q]) * t), d };
    }
  }
  return best;
}

function mpHoverAt(mx, my) {
  _mpHover = _mpPick(mx, my);
  return _mpHover ? 'grab' : false;
}

// keyOnlyBefore: 指定した時は、その距離より近い◆だけ(ギズモ・関節の印の方が近ければ何もしない)
function mpMouseDown(e, mx, my, keyOnlyBefore) {
  const hit = _mpPick(mx, my);
  if (!hit) return false;
  if (keyOnlyBefore !== undefined && (hit.kind !== 'key' || hit.d >= keyOnlyBefore)) return false;
  beginEdit();
  if (hit.tick !== curTick) seekTo(hit.tick);
  poseSetJoints(['root']);
  if (hit.kind === 'key' && _mpCache && _mpCache.b) {
    selectedPoseId = _mpCache.b.id;
    poseSelKey = { joint: 'root', index: hit.index };
    poseSelKeyExplicit = true;
  }
  poseDrag = { mp: true, kind: hit.kind, ref: hit.kind === 'key' ? hit.ref : null, tick: hit.tick, key: poseEntity,
    planeP: hit.pos.slice(), vertical: !!e.shiftKey, pending: true, startMouse: [mx, my] };
  editorChanged();
  return true;
}

function _mpPlaneNormal(vertical) {
  if (!vertical) return [0, 1, 0];
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const n = [forward[0], 0, forward[2]];
  const l = Math.hypot(n[0], n[2]);
  return l > 1e-4 ? [n[0] / l, 0, n[2] / l] : [0, 0, 1];
}

function mpDragMove(d, mx, my) {
  if (d.pending) {
    if (Math.hypot(mx - d.startMouse[0], my - d.startMouse[1]) < 3) return;
    d.pending = false;
    if (!d.ref) {
      // 線を引っぱった: その時刻に全体のキーを作る(ブロックが無ければ作る)
      const eb = poseEnsureBlockAt(d.key, d.tick);
      const k = poseEditJointKey(eb.b, 'root', d.tick);
      d.ref = k.key;
      selectedPoseId = eb.b.id;
      poseSelKey = { joint: 'root', index: k.index };
      poseExpandedId = eb.b.id;
      if (eb.created) showToast('🕺 ポーズのブロックを自動で作りました');
      else if (k.created) showToast('◆ 全体のキーを道の上に作りました');
      renderPoseTrackBlocks();
    }
    const rig = poseRigFor(d.key, d.tick);
    if (!rig) { d.ref = null; return; }
    const par = rig.parent.root;
    d.axes = [_m4Dir(par, [1, 0, 0]), _m4Dir(par, [0, 1, 0]), _m4Dir(par, [0, 0, 1])];
    d.p0 = d.ref.p.slice();
    d.n = _mpPlaneNormal(d.vertical);
    d.hit0 = scRayPlaneIntersect(_poseRay(d.startMouse[0], d.startMouse[1]), d.planeP, d.n) || d.planeP.slice();
  }
  if (!d.ref) return;
  const hit = scRayPlaneIntersect(_poseRay(mx, my), d.planeP, d.n);
  if (!hit) return;
  const w = [0, 1, 2].map(i => hit[i] - d.hit0[i]);
  if (d.vertical) { w[0] = 0; w[2] = 0; } else w[1] = 0;
  d.ref.p = [0, 1, 2].map(i => Math.round((d.p0[i] + fcVecDot(w, d.axes[i])) * 1000) / 1000);
}

function mpDragEnd(d) {
  commitEdit();
  editorChanged();
}

function mpContextHint() {
  if (!_mpActive()) return null;
  if (poseDrag && poseDrag.mp) return poseDrag.vertical ? '動きの道: 上下に動かしています' : '動きの道: 水平に動かしています(Shift で上下)';
  if (_mpHover) return _mpHover.kind === 'key' ? '◆ ドラッグ=キーを動かす(Shift 上下)' : '道: クリック=その時刻へ・引っぱる=キーを作る';
  return null;
}


// ============================================================
// 右パネル(ポーズのブロック)
// ============================================================

function renderMotionPathPanel(body, b) {
  body.appendChild(_el('div', 'panelSectionLabel', '動きの道'));
  const mk = (label, checked, onChange) => {
    const row = _el('label', 'scriptCheck');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    row.appendChild(cb);
    row.appendChild(document.createTextNode(label));
    body.appendChild(row);
    return cb;
  };
  mk('3Dに道を出す', mpShow, (v) => { mpSetShow(v); editorChanged(); });
  mk('道をなめらかに(キーを曲線でつなぐ)', !!b.smoothPath, (v) => { pushUndo(); b.smoothPath = v; editorChanged(); });
  body.appendChild(_el('div', 'panelHint', '道の◆をドラッグでキーを動かす(Shift で上下)。道の線を引っぱると、その時刻にキーができます。点は0.25秒ごと(間が広い所が速い所)。'));
}
