// blockfx.js
// ============================================================
// 🧱ブロックの演出。
//   1. 置く・壊すの自動演出(リプレイの記録 blockEdit から)
//        置いた: その場で「ポン」と大きくなって出る(少し大きくなってから戻る)
//        壊した: ブロックが8つのカケラ(ブロックの絵のその部分)に割れて散る
//      地形の面には「出る時刻・消える時刻」がある(python の _finalize_edits)。
//      置いたブロックの面は、ポンの演出が終わってから出す(blockFxRevealDelays)。
//   2. ブロックのエンティティ(人形の型 'block')を、地形と同じ絵で描く
//      (位置・向き・大きさは poses.js のキーで動かす)
// どちらも、地形のテクスチャアトラス(fcTexture)をそのまま使う。
// ============================================================

const BLOCKFX_POP_SEC = 0.22;
const BLOCKFX_BREAK_SEC = 0.75;

function blockFxEnabled() { return !(typeof autoAnim !== 'undefined' && autoAnim.blockFx === false); }

function _bfxEdits() {
  const evs = (typeof allTimelines !== 'undefined' && allTimelines && allTimelines.events) || [];
  if (_bfxEdits.cache && _bfxEdits.cache.len === evs.length) return _bfxEdits.cache.list;
  const list = evs.filter(e => e.type === 'blockEdit');
  _bfxEdits.cache = { len: evs.length, list };
  return list;
}

// 置いたブロックの面を、何tick遅らせて出すか("x,y,z,出る時刻" -> tick数)
function blockFxRevealDelays() {
  if (!blockFxEnabled()) return null;
  const list = _bfxEdits();
  if (!list.length) return null;
  const tps = (typeof scTps === 'function') ? scTps() : 30;
  const d = Math.ceil(BLOCKFX_POP_SEC * tps);
  const m = new Map();
  for (const e of list) if (e.to != null) m.set(e.pos[0] + ',' + e.pos[1] + ',' + e.pos[2] + ',' + e.tick, d);
  return m;
}

// パレットの番号 / テクスチャの名前 → アトラスの中の位置 [u0,v0,u1,v1]
function blockFxTexRect(paletteIdx, texName) {
  const name = texName != null ? texName : (fcMeshPalette[paletteIdx] && fcMeshPalette[paletteIdx].texture);
  return (fcUVRectsRaw && name && fcUVRectsRaw.get(name)) || [0, 0, 1, 1];
}


// ============================================================
// 描画(絵の付いた箱)
// ============================================================

const BFX_VS = `
  attribute vec3 aPos;
  attribute vec2 aUV;
  attribute float aBright;
  uniform mat4 uView, uProj, uModel;
  uniform vec4 uRect;
  varying vec2 vUV;
  varying float vBright;
  void main() {
    gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
    vUV = uRect.xy + aUV * (uRect.zw - uRect.xy);
    vBright = aBright;
  }
`;
const BFX_FS = `
  precision mediump float;
  uniform sampler2D uTex;
  uniform vec3 uTint;
  uniform float uAlpha;
  varying vec2 vUV;
  varying float vBright;
  void main() {
    vec4 c = texture2D(uTex, vUV);
    if (c.a < 0.1) discard;
    gl_FragColor = vec4(c.rgb * vBright * uTint, c.a * uAlpha);
  }
`;

let bfxProg = null, bfxVbo = null, bfxLoc = null;

function _bfxInit(gl) {
  if (bfxProg) return;
  const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('ブロック演出のシェーダー: ' + gl.getShaderInfoLog(s)); return s; };
  bfxProg = gl.createProgram();
  gl.attachShader(bfxProg, mk(gl.VERTEX_SHADER, BFX_VS));
  gl.attachShader(bfxProg, mk(gl.FRAGMENT_SHADER, BFX_FS));
  gl.linkProgram(bfxProg);
  bfxLoc = {
    pos: gl.getAttribLocation(bfxProg, 'aPos'), uv: gl.getAttribLocation(bfxProg, 'aUV'), br: gl.getAttribLocation(bfxProg, 'aBright'),
    view: gl.getUniformLocation(bfxProg, 'uView'), proj: gl.getUniformLocation(bfxProg, 'uProj'), model: gl.getUniformLocation(bfxProg, 'uModel'),
    rect: gl.getUniformLocation(bfxProg, 'uRect'), tex: gl.getUniformLocation(bfxProg, 'uTex'), tint: gl.getUniformLocation(bfxProg, 'uTint'),
    alpha: gl.getUniformLocation(bfxProg, 'uAlpha'),
  };
  // 中心が原点の 1x1x1 の箱(面ごとに絵の全体を貼る。明るさは地形と同じ)
  const v = [];
  const order = [0, 1, 2, 0, 2, 3];
  const cornerUV = [[0, 1], [1, 1], [1, 0], [0, 0]];
  for (let d = 0; d < 6; d++) for (const oi of order) {
    const o = FACE_OFFSETS[d][oi];
    v.push(o[0] - 0.5, o[1] - 0.5, o[2] - 0.5, cornerUV[oi][0], cornerUV[oi][1], DIR_FACTOR[d]);
  }
  bfxVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bfxVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
}

function _bfxBegin(gl, view, proj) {
  _bfxInit(gl);
  gl.useProgram(bfxProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, bfxVbo);
  gl.enableVertexAttribArray(bfxLoc.pos); gl.vertexAttribPointer(bfxLoc.pos, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(bfxLoc.uv); gl.vertexAttribPointer(bfxLoc.uv, 2, gl.FLOAT, false, 24, 12);
  gl.enableVertexAttribArray(bfxLoc.br); gl.vertexAttribPointer(bfxLoc.br, 1, gl.FLOAT, false, 24, 20);
  gl.uniformMatrix4fv(bfxLoc.view, false, view);
  gl.uniformMatrix4fv(bfxLoc.proj, false, proj);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fcTexture);
  gl.uniform1i(bfxLoc.tex, 0);
  gl.uniform3f(bfxLoc.tint, 1, 1, 1);
  gl.uniform1f(bfxLoc.alpha, 1);
}

function _bfxEnd(gl) {
  gl.disableVertexAttribArray(bfxLoc.uv);
  gl.disableVertexAttribArray(bfxLoc.br);
}

function _bfxDraw(gl, model, rect, tint) {
  gl.uniformMatrix4fv(bfxLoc.model, false, model);
  gl.uniform4f(bfxLoc.rect, rect[0], rect[1], rect[2], rect[3]);
  if (tint) gl.uniform3f(bfxLoc.tint, tint[0], tint[1], tint[2]);
  gl.drawArrays(gl.TRIANGLES, 0, 36);
  if (tint) gl.uniform3f(bfxLoc.tint, 1, 1, 1);
}

function _bfxRand(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }
function _bfxBackOut(u) { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); }

// 編集視点・プレビュー・小窓から呼ぶ
function renderBlockFx(gl, view, proj, frameIdx) {
  if (typeof fcTexture === 'undefined' || !fcTexture) return;
  const tickVal = (typeof _poseTickVal === 'function') ? _poseTickVal(frameIdx) : frameIdx;
  const tps = scTps();
  const edits = blockFxEnabled() ? _bfxEdits() : [];
  const blocks = (typeof puppets !== 'undefined') ? puppets.filter(p => p.type === 'block') : [];
  if (!edits.length && !blocks.length) return;
  let begun = false;
  const begin = () => { if (!begun) { _bfxBegin(gl, view, proj); begun = true; } };

  // ---- 置く・壊す ----
  const popT = BLOCKFX_POP_SEC * tps, brkT = BLOCKFX_BREAK_SEC * tps;
  for (const e of edits) {
    const dt = tickVal - e.tick;
    if (dt < 0 || dt > Math.max(popT, brkT)) continue;
    const c = [e.pos[0] - worldOriginX + 0.5, e.pos[1] - worldOriginY + 0.5, e.pos[2] - worldOriginZ + 0.5];
    // 置いた: ポン
    if (e.to != null && dt < popT) {
      begin();
      const s = Math.max(0.01, _bfxBackOut(dt / popT));
      _bfxDraw(gl, _m4Mul(mat4Translate(c[0], c[1], c[2]), _m4S(s, s, s)), blockFxTexRect(e.to));
    }
    // 壊した: 8つのカケラ
    if (e.from != null && dt < brkT) {
      begin();
      const r = blockFxTexRect(e.from);
      const t = dt / tps;
      const seed = e.pos[0] * 73.1 + e.pos[1] * 19.7 + e.pos[2] * 5.3 + e.tick;
      let k = 0;
      for (const ox of [-1, 1]) for (const oy of [-1, 1]) for (const oz of [-1, 1]) {
        const rn = (n) => _bfxRand(seed + k * 7.7 + n);
        const v = [ox * (1.8 + 2 * rn(1)), 2.5 + 3 * rn(2) + (oy > 0 ? 1.5 : 0), oz * (1.8 + 2 * rn(3))];
        const p = [c[0] + ox * 0.25 + v[0] * t, Math.max(e.pos[1] - worldOriginY + 0.12, c[1] + oy * 0.25 + v[1] * t - 9 * t * t), c[2] + oz * 0.25 + v[2] * t];
        const life = dt / brkT;
        const s = 0.5 * (life < 0.55 ? 1 : Math.max(0, 1 - (life - 0.55) / 0.45));
        const ang = (4 + 6 * rn(4)) * t * (rn(5) < 0.5 ? -1 : 1);
        // カケラの絵: ブロックの絵の4分の1
        const sub = [r[0] + (r[2] - r[0]) * (ox > 0 ? 0.5 : 0), r[1] + (r[3] - r[1]) * (oy > 0 ? 0 : 0.5)];
        const sr = [sub[0], sub[1], sub[0] + (r[2] - r[0]) * 0.5, sub[1] + (r[3] - r[1]) * 0.5];
        _bfxDraw(gl, _m4Mul(mat4Translate(p[0], p[1], p[2]), mat4RotateY(ang), mat4RotateX(ang * 0.7), _m4S(s, s, s)), sr);
        k++;
      }
    }
  }

  // ---- ブロックのエンティティ ----
  const editing = (typeof _poseEditingOn === 'function') && _poseEditingOn();
  for (const p of blocks) {
    const key = 'puppet:' + p.id;
    const base = poseEntityBase(key, frameIdx);
    if (!base) continue;
    const sel = editing && poseEntity === key;
    const rig = (typeof poseRigFor === 'function') ? poseRigFor(key, frameIdx) : poseBuildRig('block', base, poseEntityPose(key, frameIdx));
    if (!rig) continue;
    begin();
    for (const part of rig.parts) _bfxDraw(gl, part.model, blockFxTexRect(null, p.texture), sel ? [1.15, 1.02, 0.8] : null);
  }
  if (begun) _bfxEnd(gl);
}


// ============================================================
// ブロックの絵を選ぶ(ブロックのエンティティの右パネル)
// ============================================================

// アトラスから、テクスチャ1つぶんの小さな絵(dataURL)を作る
const _bfxThumbCache = new Map();
function blockFxThumb(texName) {
  if (_bfxThumbCache.has(texName)) return _bfxThumbCache.get(texName);
  let url = '';
  const r = fcUVRectsRaw && fcUVRectsRaw.get(texName);
  if (r && fcAtlasCanvas) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const W = fcAtlasCanvas.width, H = fcAtlasCanvas.height;
    g.drawImage(fcAtlasCanvas, r[0] * W, r[1] * H, (r[2] - r[0]) * W, (r[3] - r[1]) * H, 0, 0, 32, 32);
    url = c.toDataURL();
  }
  _bfxThumbCache.set(texName, url);
  return url;
}

// テクスチャの名前の一覧(リプレイに出てくる物を先に)
function blockFxTextureNames() {
  const all = fcUVRectsRaw ? [...fcUVRectsRaw.keys()] : [];
  let used = [...new Set((fcMeshPalette || []).map(p => p && p.texture).filter(Boolean))];
  if (all.length) used = used.filter(n => fcUVRectsRaw.has(n)); // 絵が無い名前は出さない
  return [...used, ...all.filter(n => !used.includes(n))];
}

function renderBlockTexturePicker(body, puppet) {
  const wrap = _el('div', 'bfxPicker');
  const search = document.createElement('input');
  search.type = 'text'; search.className = 'panelInput'; search.placeholder = 'ブロックの名前で探す(例: stone, planks)';
  wrap.appendChild(search);
  const grid = _el('div', 'bfxGrid');
  wrap.appendChild(grid);
  const draw = () => {
    grid.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const names = blockFxTextureNames().filter(n => !q || n.toLowerCase().includes(q)).slice(0, 60);
    if (!names.length) grid.appendChild(_el('div', 'panelHint', q ? '見つかりませんでした' : 'テクスチャがまだ読み込まれていません'));
    for (const n of names) {
      const b = _el('button', 'bfxTile' + (n === puppet.texture ? ' active' : ''));
      b.type = 'button'; b.title = n;
      const url = blockFxThumb(n);
      if (url) b.style.backgroundImage = `url(${url})`;
      b.addEventListener('click', () => { if (puppet.texture === n) return; pushUndo(); puppet.texture = n; draw(); });
      grid.appendChild(b);
    }
  };
  search.addEventListener('input', draw);
  draw();
  body.appendChild(wrap);
}
