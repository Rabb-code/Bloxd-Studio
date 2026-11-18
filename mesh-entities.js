// mesh-entities.js
// ============================================================
// ステップ37: ワールドコードが置いた「Mesh|…」のエンティティを描く
//   Mesh|Box|{"width","height","depth","diffuseColor":[r,g,b],"emissiveColor","texture","faceUV"} … 箱(ステップ39)
//      公式: 大きさ1の箱を幅・高さ・奥行きに伸ばす。下の端がエンティティの位置。色の箱か、ブロックの絵の箱
//   Mesh|BloxdBlock|{"blockName":"Red Baked Clay","size":0.2,…}  … 浮かんでいる小さいブロック(地形と同じ絵)
//   Mesh|Leaderboard|{"title":"Foraging","scoreLabel":"Level","width":1.48,"height":2.48,…} … ランキングの板
//      (順位の中身はリプレイに入っていないので、題名と「Level」だけ書く)
//   Mesh|ParticleEmitter|{…}  … キラキラなどの粒。公式の設定(数・寿命・速さ・大きさ・色の変わり方・重力)で、
//      時刻から決まる乱数で作る(再生ヘッドをどこに動かしても同じ絵)
//   Mesh|Person|… は人(official-models.js)
// ============================================================

const MESHENT = { gl: null, prog: null, loc: null, cubes: new Map(), boxes: new Map(), boards: new Map(), glint: null, white: null, pbuf: null, failed: false };

const _ME_VS = `
  attribute vec3 aPos; attribute vec2 aUV; attribute vec4 aCol;
  uniform mat4 uView, uProj, uModel;
  varying vec2 vUV; varying vec4 vCol;
  void main() { gl_Position = uProj * uView * uModel * vec4(aPos, 1.0); vUV = aUV; vCol = aCol; }`;
const _ME_FS = `
  precision mediump float;
  uniform sampler2D uTex; uniform float uCut;
  varying vec2 vUV; varying vec4 vCol;
  void main() { vec4 c = texture2D(uTex, vUV) * vCol; if (c.a < uCut) discard; gl_FragColor = c; }`;

function _meInit(gl) {
  if (MESHENT.gl === gl) return !MESHENT.failed;
  MESHENT.gl = gl; MESHENT.cubes.clear(); MESHENT.boxes.clear(); MESHENT.boards.clear(); MESHENT.glint = null; MESHENT.white = null;
  try {
    const vs = ent3dCompileShader(gl, gl.VERTEX_SHADER, _ME_VS), fs = ent3dCompileShader(gl, gl.FRAGMENT_SHADER, _ME_FS);
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    MESHENT.prog = p;
    MESHENT.loc = {
      aPos: gl.getAttribLocation(p, 'aPos'), aUV: gl.getAttribLocation(p, 'aUV'), aCol: gl.getAttribLocation(p, 'aCol'),
      uView: gl.getUniformLocation(p, 'uView'), uProj: gl.getUniformLocation(p, 'uProj'), uModel: gl.getUniformLocation(p, 'uModel'),
      uTex: gl.getUniformLocation(p, 'uTex'), uCut: gl.getUniformLocation(p, 'uCut'),
    };
    MESHENT.pbuf = gl.createBuffer();
    MESHENT.failed = false;
  } catch (e) { MESHENT.failed = true; console.warn('[Mesh エンティティ] 準備で失敗:', e); }
  return !MESHENT.failed;
}

function _meOpts(name) {
  const i = name.indexOf('|', 5);
  if (i < 0) return {};
  try { return JSON.parse(name.slice(i + 1)) || {}; } catch (e) { return {}; }
}

// 頂点の列(x,y,z,u,v,r,g,b,a)を描く
function _meDraw(gl, data, model, tex, cut, mode) {
  const L = MESHENT.loc;
  gl.bindBuffer(gl.ARRAY_BUFFER, MESHENT.pbuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(L.aPos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(L.aUV); gl.vertexAttribPointer(L.aUV, 2, gl.FLOAT, false, 36, 12);
  gl.enableVertexAttribArray(L.aCol); gl.vertexAttribPointer(L.aCol, 4, gl.FLOAT, false, 36, 20);
  gl.uniformMatrix4fv(L.uModel, false, model);
  gl.uniform1f(L.uCut, cut);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(L.uTex, 0);
  gl.drawArrays(mode || gl.TRIANGLES, 0, data.length / 9);
  gl.disableVertexAttribArray(L.aCol);
}

// ---------- 小さいブロック ----------
function _meCubeData(blockName) {
  if (MESHENT.cubes.has(blockName)) return MESHENT.cubes.get(blockName);
  let rects = null;
  if (typeof OFFBLK !== 'undefined' && OFFBLK.ready && typeof fcUVRectsRaw !== 'undefined' && fcUVRectsRaw) {
    const b = OFFBLK.blocks[blockName];
    const names = b && (b.cube || b.slab || b.stairs || b.fence || b.gate);
    if (names) rects = names.map(n => fcUVRectsRaw.get(n) || null);
    if (rects && rects.every(r => !r)) rects = null;
  }
  if (!rects) return null;   // 絵がまだ(地形の絵ができてから)
  const fb = rects.find(r => r);
  const out = [];
  for (let d = 0; d < 6; d++) {
    const r = rects[d] || fb, br = DIR_FACTOR[d];
    for (const oi of [0, 1, 2, 0, 2, 3]) {
      const o = FACE_OFFSETS[d][oi];
      const [cu, cv] = offFaceCornerUV(d, o);
      out.push(o[0] - 0.5, o[1] - 0.5, o[2] - 0.5, r[0] + cu * (r[2] - r[0]), r[1] + cv * (r[3] - r[1]), br, br, br, 1);
    }
  }
  const data = new Float32Array(out);
  MESHENT.cubes.set(blockName, data);
  return data;
}

// ---------- 箱(Mesh|Box) ----------
// 公式の CreateBox の面の順(faceUV の順): 0 +z, 1 -z, 2 +x, 3 -x, 4 上, 5 下 → エディタの面の番号(+x,-x,上,下,+z,-z)
const _ME_BOX_FACE = { 4: 0, 5: 1, 2: 2, 3: 3, 0: 4, 1: 5 };   // エディタの面 → 公式の面
function _meWhite(gl) {
  if (MESHENT.white) return MESHENT.white;
  const c = document.createElement('canvas'); c.width = c.height = 2;
  const k = c.getContext('2d'); k.fillStyle = '#fff'; k.fillRect(0, 0, 2, 2);
  MESHENT.white = _offTex(gl, c);
  return MESHENT.white;
}
function _meBoxData(o) {
  const key = JSON.stringify([o.diffuseColor, o.emissiveColor, o.texture, o.faceUV]);
  if (MESHENT.boxes.has(key)) return MESHENT.boxes.get(key);
  let rects = null, col = null;
  if (Array.isArray(o.diffuseColor)) col = o.diffuseColor.map(v => (+v || 0) / 255);
  else if (o.texture) {
    if (typeof fcUVRectsRaw === 'undefined' || !fcUVRectsRaw) return null;       // 地形の絵がまだ
    const b = (typeof OFFBLK !== 'undefined' && OFFBLK.ready) ? OFFBLK.blocks[o.texture] : null;
    const names = b && (b.cube || b.slab || b.stairs || b.fence || b.gate);
    if (names) rects = names.map(n => fcUVRectsRaw.get(n) || null);
    const one = fcUVRectsRaw.get(o.texture) || fcUVRectsRaw.get(String(o.texture).toLowerCase().replace(/ /g, '_'));
    if (!rects || rects.every(r => !r)) rects = one ? [one, one, one, one, one, one] : null;
  }
  if (!col && !rects) col = [0.8, 0.8, 0.8];
  const em = Array.isArray(o.emissiveColor) ? o.emissiveColor.map(v => (+v || 0) / 255) : [0, 0, 0];
  const out = [];
  for (let d = 0; d < 6; d++) {
    const br = DIR_FACTOR[d];
    let r = rects ? (rects[d] || rects.find(x => x)) : [0, 0, 1, 1];
    const fu = Array.isArray(o.faceUV) && o.faceUV[_ME_BOX_FACE[d]];
    let sub = fu ? [fu[0] + 0.01, fu[1] + 0.01, fu[2] - 0.01, fu[3] - 0.01] : [0, 0, 1, 1];
    for (const oi of [0, 1, 2, 0, 2, 3]) {
      const fo = FACE_OFFSETS[d][oi];
      let [cu, cv] = offFaceCornerUV(d, fo);
      cu = sub[0] + cu * (sub[2] - sub[0]); cv = sub[1] + cv * (sub[3] - sub[1]);
      const c = col ? [0, 1, 2].map(i => Math.min(1, col[i] * br + em[i])) : [Math.min(1, br * 1.1), Math.min(1, br * 1.1), Math.min(1, br * 1.1)];
      out.push(fo[0] - 0.5, fo[1] - 0.5, fo[2] - 0.5, r[0] + cu * (r[2] - r[0]), r[1] + cv * (r[3] - r[1]), c[0], c[1], c[2], 1);
    }
  }
  const v = { data: new Float32Array(out), textured: !col };
  MESHENT.boxes.set(key, v);
  return v;
}
// エンティティの回転。公式(meshRotation)は setRotationEuler(x, y + π, z)(y → x → z の順)。
//   y に 180 度足してあるので、x・z の傾きの向きは見た目が逆になる(ステップ39b で直した)
function _meRotMatrix(rot) {
  const r = rot || [0, 0, 0];
  return _m4Mul(mat4RotateY((r[1] || 0) + Math.PI), mat4RotateX(r[0] || 0), _m4Rz(r[2] || 0));
}

// ---------- ランキングの板(公式の描き方を写した物) ----------
//   板: 幅 2.5 × 高さ 3.75(× size。width・height があればそれ)。下の端がエンティティの位置。両面とも読める向き
//   絵: 横 1024 の中に「TOP 10 / ALL TIME」・題名・RANK / PLAYER / 点の名前・10 行。中身はリプレイの項目29(leaderboardTop)
const _ME_LB = { bg: '#22283b', white: '#e7e7e7', gray: '#c7c7c7', yellow: '#f3f351', top: 10, below: 11, gap: 1.5 };
const _meNum = new Intl.NumberFormat('en', { maximumSignificantDigits: 15 });
function _meLbSize(o) {
  const pos = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : d;
  const k = pos(o.size, 1);
  return [pos(o.width, pos(2.5 * k, 2.5)), pos(o.height, pos(3.75 * k, 3.75))];
}
function _meLbData(eid, tickVal) {
  const ent = allTimelines && allTimelines.entities[eid];
  if (!ent) return null;
  if (!ent._lb) ent._lb = ent.frames.filter(f => f.leaderboardTop);
  let best = null;
  for (const f of ent._lb) { if (f.tick <= tickVal) best = f; else break; }
  if (!best && ent._lb.length) best = ent._lb[0];
  if (!best) return null;
  try { return { key: best.tick, data: JSON.parse(best.leaderboardTop) }; } catch (e) { return null; }
}
function _meLbDraw(k, o, data, kH) {
  const C = _ME_LB;
  k.fillStyle = C.bg; k.fillRect(0, 0, 1024, kH);
  k.textBaseline = 'middle';
  const T = (text, x, y, size, color, maxw, align) => {
    k.font = `bold ${size}px 'Jetbrains Mono', ui-monospace, monospace`; k.fillStyle = color; k.textAlign = align || 'left';
    let t = String(text).replace(/[\r\n\t]/g, ' ');
    if (k.measureText(t).width > maxw) { while (t.length > 0 && k.measureText(t + '\u2026').width > maxw) t = t.slice(0, -1); t += '\u2026'; }
    k.fillText(t, x, y);
  };
  const line = (y) => { k.fillStyle = C.white; k.globalAlpha = 0.15; k.fillRect(24, y, 976, 2); k.globalAlpha = 1; };
  const entries = (data && Array.isArray(data.entries) ? data.entries : []).slice(0, C.top).filter(e => e && isFinite(e.rank) && isFinite(e.value));
  const ready = data && data.status === 'ready' && entries.length > 0;
  // 同じ点の人は同じ順位(公式の tG と同じ)
  const ranks = []; let off = false;
  entries.forEach((e, i) => { const same = i > 0 && e.value === entries[i - 1].value; if (!same) off = i === 0 && e.rank !== 1; ranks.push(same && !off ? ranks[i - 1] : e.rank); });
  k.font = "bold 34px 'Jetbrains Mono', ui-monospace, monospace";
  const rw = Math.min(280, Math.max(0, ...(ready ? ranks : []).map(r => k.measureText(_meNum.format(r)).width)));
  const narrow = rw <= 80, rx = narrow ? 80 : 32 + rw, px = narrow ? 148 : rx + 28, pw = 660 - px;
  T(`TOP ${C.top}  /  ALL TIME`, 24, 52, 28, C.gray, 976);
  T(String(o.title != null ? o.title : 'Leaderboard').slice(0, 64), 24, 108, 52, C.white, 976);
  T('RANK', 32, 174, 28, C.gray, px - 40);
  T('PLAYER', px, 174, 28, C.gray, pw);
  T(String(o.scoreLabel != null ? o.scoreLabel : 'Score').slice(0, 24), 992, 174, 28, C.gray, 304, 'right');
  line(202);
  const rowH = (kH - 232) / (C.top + C.gap + C.below), endTop = 208 + C.top * rowH;
  if (ready) {
    entries.forEach((e, i) => {
      const y = 208 + (i + 0.5) * rowH;
      k.fillStyle = C.white; k.globalAlpha = i % 2 === 0 ? 0.035 : 0; k.fillRect(24, y - rowH / 2 + 1, 976, rowH - 2); k.globalAlpha = 1;
      T(_meNum.format(ranks[i]), rx, y, 34, C.white, narrow ? 80 : rw, narrow ? 'center' : 'right');
      T(String(e.name).slice(0, 64), px, y, 34, C.white, pw);
      k.font = "bold 34px 'Jetbrains Mono', ui-monospace, monospace";
      const v = _meNum.format(e.value);
      T(k.measureText(v).width > 304 ? Number(e.value).toExponential(6) : v, 992, y, 34, C.white, 304, 'right');
    });
  } else {
    const err = data && data.status === 'error', rd = data && data.status === 'ready';
    const y = (208 + endTop) / 2;
    T(err ? "Couldn't load leaderboard" : rd ? 'No scores yet' : 'Loading leaderboard\u2026', 512, y - 28, 40, C.white, 960, 'center');
    T(err ? 'Trying again shortly' : rd ? 'Be the first on the board!' : 'Fetching the top players', 512, y + 27, 30, C.gray, 960, 'center');
  }
  line(endTop + C.gap * rowH / 2);   // 自分の順位はリプレイでは出さない(公式も、見ている人の順位が無い時は線だけ)
}
function _meBoardTex(gl, eid, o, tickVal) {
  const d = _meLbData(eid, tickVal);
  const key = eid + '|' + (d ? d.key : 'none');
  if (MESHENT.boards.has(key)) return MESHENT.boards.get(key);
  const [w, h] = _meLbSize(o);
  const ratio = h / w, kH = Math.max(1536, 1024 * ratio), kW = Math.max(1024, 1536 / ratio);
  const c = document.createElement('canvas');
  c.width = 1024; c.height = Math.max(1, Math.round(1024 * ratio));
  const k = c.getContext('2d');
  k.fillStyle = _ME_LB.bg; k.fillRect(0, 0, c.width, c.height);
  k.scale(c.width / kW, c.height / kH); k.translate((kW - 1024) / 2, 0);
  _meLbDraw(k, o, d && d.data, kH);
  const v = { tex: _offTex(gl, c), w, h };
  // 古い時刻の絵は捨てる(同じ板の物)
  for (const kk of [...MESHENT.boards.keys()]) if (kk.startsWith(eid + '|')) { const old = MESHENT.boards.get(kk); gl.deleteTexture(old.tex); MESHENT.boards.delete(kk); }
  MESHENT.boards.set(key, v);
  return v;
}

// ---------- 粒 ----------
function _meGlintTex(gl) {
  if (MESHENT.glint) return MESHENT.glint;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const k = c.getContext('2d');
  const g = k.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  k.fillStyle = g; k.fillRect(0, 0, 32, 32);
  k.fillStyle = 'rgba(255,255,255,0.9)'; k.fillRect(15, 2, 2, 28); k.fillRect(2, 15, 28, 2);   // 十字の光
  MESHENT.glint = _offTex(gl, c);
  return MESHENT.glint;
}
function _meHash(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function _meGrad(grads, f) {
  if (!grads || !grads.length) return [255, 255, 255, 1];
  let a = grads[0], b = grads[grads.length - 1];
  for (let i = 0; i + 1 < grads.length; i++) if (f >= grads[i].timeFraction && f <= grads[i + 1].timeFraction) { a = grads[i]; b = grads[i + 1]; break; }
  const span = Math.max(1e-6, b.timeFraction - a.timeFraction), t = Math.min(1, Math.max(0, (f - a.timeFraction) / span));
  const ca = a.minColor || a.color || [255, 255, 255, 1], cb = b.minColor || b.color || [255, 255, 255, 1];
  return [0, 1, 2, 3].map(i => ca[i] + (cb[i] - ca[i]) * t);
}
function _meParticles(o, seed, tSec, center, right, up, out) {
  const rate = Math.min(400, Math.max(0, +o.emitRate || 0)); if (!rate) return;
  const lmin = +o.minLifeTime || 1, lmax = +o.maxLifeTime || lmin;
  const pmin = +o.minEmitPower || 0, pmax = +o.maxEmitPower || pmin;
  const smin = +o.minSize || 0.1, smax = +o.maxSize || smin;
  const d1 = o.dir1 || [0, 1, 0], d2 = o.dir2 || d1, gv = o.gravity || [0, 0, 0];
  const W = +o.width || 0, H = +o.height || 0, D = +o.depth || 0;
  const i0 = Math.max(0, Math.floor((tSec - lmax) * rate)), i1 = Math.floor(tSec * rate);
  for (let i = i0; i <= i1; i++) {
    const r = (k) => _meHash(seed + i * 7 + k, i * 13 + k * 31);
    const life = lmin + (lmax - lmin) * r(1);
    const age = tSec - i / rate;
    if (age < 0 || age > life) continue;
    const pw = pmin + (pmax - pmin) * r(2);
    const dir = [0, 1, 2].map(j => d1[j] + (d2[j] - d1[j]) * r(3 + j));
    const p = [center[0] + (r(6) - 0.5) * W + dir[0] * pw * age + 0.5 * gv[0] * age * age,
               center[1] + (r(7) - 0.5) * H + dir[1] * pw * age + 0.5 * gv[1] * age * age,
               center[2] + (r(8) - 0.5) * D + dir[2] * pw * age + 0.5 * gv[2] * age * age];
    const sz = (smin + (smax - smin) * r(9)) * 0.5;
    const c = _meGrad(o.colorGradients, age / life);
    const col = [c[0] / 255, c[1] / 255, c[2] / 255, Math.min(1, Math.max(0, c[3]))];
    const q = [[-1, -1, 0, 1], [1, -1, 1, 1], [1, 1, 1, 0], [-1, -1, 0, 1], [1, 1, 1, 0], [-1, 1, 0, 0]];
    for (const [a, b, u, v] of q) out.push(p[0] + (right[0] * a + up[0] * b) * sz, p[1] + (right[1] * a + up[1] * b) * sz, p[2] + (right[2] * a + up[2] * b) * sz, u, v, col[0], col[1], col[2], col[3]);
  }
}

// ---------- まとめて描く(poses.js の人を描く所から呼ぶ) ----------
// list: [{ eid, name, base }]  base = poseEntityBase の結果(pos はワールドの原点から)
function meshEntitiesDraw(gl, viewMatrix, projMatrix, list, tickVal) {
  if (!list.length || !_meInit(gl)) return;
  const L = MESHENT.loc;
  gl.useProgram(MESHENT.prog);
  gl.uniformMatrix4fv(L.uView, false, viewMatrix);
  gl.uniformMatrix4fv(L.uProj, false, projMatrix);
  const cull = gl.isEnabled(gl.CULL_FACE); if (cull) gl.disable(gl.CULL_FACE);
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const tSec = (tickVal || 0) / tps;
  const parts = [];
  for (const it of list) {
    const o = _meOpts(it.name), b = it.base;
    if (it.name.startsWith('Mesh|Box|')) {
      const bx = _meBoxData(o);
      if (!bx || (bx.textured && (typeof fcTexture === 'undefined' || !fcTexture))) continue;
      const w = Math.abs(+o.width || 1), h = Math.abs(+o.height || 1), d = Math.abs(+o.depth || 1);
      const off = Array.isArray(o.meshOffset) ? o.meshOffset : [0, 0, 0];
      const M = _m4Mul(mat4Translate(b.pos[0] + (+off[0] || 0), b.pos[1] + h / 2 + (+off[1] || 0), b.pos[2] + (+off[2] || 0)), _meRotMatrix(it.rot), _m4S(w, h, d));
      _meDraw(gl, bx.data, M, bx.textured ? fcTexture : _meWhite(gl), 0.05);
    } else if (it.name.startsWith('Mesh|BloxdBlock|')) {
      const data = _meCubeData(o.blockName);
      if (!data || typeof fcTexture === 'undefined' || !fcTexture) continue;
      const s = Math.max(0.01, +o.size || 1);
      _meDraw(gl, data, _m4Mul(mat4Translate(b.pos[0], b.pos[1], b.pos[2]), _meRotMatrix(it.rot), _m4S(s, s, s)), fcTexture, 0.05);
    } else if (it.name.startsWith('Mesh|Leaderboard|')) {
      const bd = _meBoardTex(gl, it.eid, o, tickVal || 0);
      const hw = bd.w / 2, hh = bd.h / 2;
      // 板の下の端がエンティティの位置(掲示板の枠の真ん中にちょうど入る高さ)
      const H2 = bd.h;
      // 表と裏の2枚(どちらから見ても字が正しい向き。公式の DOUBLESIDE + backUVs と同じ)
      const quad = new Float32Array([
        -hw, 0, 0.002, 0, 1, 1, 1, 1, 1,   hw, 0, 0.002, 1, 1, 1, 1, 1, 1,   hw, H2, 0.002, 1, 0, 1, 1, 1, 1,
        -hw, 0, 0.002, 0, 1, 1, 1, 1, 1,   hw, H2, 0.002, 1, 0, 1, 1, 1, 1,  -hw, H2, 0.002, 0, 0, 1, 1, 1, 1,
         hw, 0, -0.002, 0, 1, 1, 1, 1, 1, -hw, 0, -0.002, 1, 1, 1, 1, 1, 1, -hw, H2, -0.002, 1, 0, 1, 1, 1, 1,
         hw, 0, -0.002, 0, 1, 1, 1, 1, 1, -hw, H2, -0.002, 1, 0, 1, 1, 1, 1,   hw, H2, -0.002, 0, 0, 1, 1, 1, 1]);
      // ステップ41: 画面を公式と同じ左右に映すので、字の左右も合わせる(u を反対に)
      if (typeof FC_MIRROR_X !== 'undefined' && FC_MIRROR_X) for (let q = 3; q < quad.length; q += 9) quad[q] = 1 - quad[q];
      const off = Array.isArray(o.meshOffset) ? o.meshOffset : [0, 0, 0];
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      _meDraw(gl, quad, _m4Mul(modelMatrixYaw(b.pos[0], b.pos[1], b.pos[2], b.yaw), mat4Translate(off[0] || 0, off[1] || 0, off[2] || 0)), bd.tex, 0.02);
      gl.disable(gl.CULL_FACE);
    } else if (it.name.startsWith('Mesh|ParticleEmitter|')) {
      parts.push({ o, b, seed: +it.eid || 0 });
    }
  }
  if (parts.length) {
    // カメラの右・上(ビュー行列の行)に向けた板にする
    const V = viewMatrix, right = [V[0], V[4], V[8]], up = [V[1], V[5], V[9]];
    const add = [], alpha = [];
    for (const p of parts) _meParticles(p.o, p.seed, tSec, p.b.pos, right, up, (p.o.blendMode === 2 || p.o.blendMode === 1) ? add : alpha);
    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const tex = _meGlintTex(gl);
    const wasBlend = gl.isEnabled(gl.BLEND);
    gl.enable(gl.BLEND); gl.depthMask(false);
    if (alpha.length) { gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); _meDraw(gl, new Float32Array(alpha), I, tex, 0.01); }
    if (add.length) { gl.blendFunc(gl.SRC_ALPHA, gl.ONE); _meDraw(gl, new Float32Array(add), I, tex, 0.01); }
    gl.depthMask(true); if (!wasBlend) gl.disable(gl.BLEND);
  }
  if (cull) gl.enable(gl.CULL_FACE);
}
