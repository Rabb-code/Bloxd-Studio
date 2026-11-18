// transitions.js
// ============================================================
// 🎞 切り替えの演出(トランジション)
//   カメラのブロックごとに cam.trans = { in:{type,sec}|null, out:{type,sec}|null }
//     入り(in): このカメラが始まる時、前のカメラ(同じ表示位置で、ちょうどここで終わるカメラ)から切り替える
//        fade(クロスフェード)/ black(黒をはさむ)/ white(白をはさむ・フラッシュ)/ wipeL(左から)/ wipeU(上から)/ circle(円で開く)
//        前のカメラが無い時は、黒から切り替える(動画の始まりのフェードイン)
//     終わり(out): このカメラが終わる時に、黒/白へ消えていく
//   プレビューと書き出しは同じ freecam.js の合成(_renderPreviewCompositeInner)でこれを使う。
// ============================================================

const TRANS_IN_TYPES = [['none', 'なし'], ['fade', 'クロスフェード'], ['black', '黒をはさむ'], ['white', '白(フラッシュ)'],
  ['wipeL', 'ワイプ(左から)'], ['wipeU', 'ワイプ(上から)'], ['circle', '円で開く']];
const TRANS_OUT_TYPES = [['none', 'なし'], ['black', '黒へ消える'], ['white', '白へ消える']];

function _trSameDisplay(a, b) {
  return (!a && !b) || (a && b && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.w - b.w) < 1e-3);
}

// 入りの切り替えで、前に映っていたカメラ(無ければ null)
function trOutgoingCamera(cam) {
  let best = null;
  for (const c of sceneCameras) {
    if (c === cam || c.startTick >= cam.startTick || Math.abs(c.endTick - cam.startTick) > 1) continue;
    if (!_trSameDisplay(c.display, cam.display)) continue;
    if (!best || Math.abs(c.layer - cam.layer) < Math.abs(best.layer - cam.layer)) best = c;
  }
  return best;
}

// 入りの切り替えの途中なら { type, u(0〜1), from }
function trInState(cam, tick) {
  const t = cam.trans && cam.trans.in;
  if (!t || !t.type || t.type === 'none' || !(t.sec > 0)) return null;
  const dur = t.sec * scTps();
  if (tick < cam.startTick || tick >= cam.startTick + dur) return null;
  return { type: t.type, u: (tick - cam.startTick) / dur, from: trOutgoingCamera(cam) };
}
// 終わりの切り替えの途中なら { type, u(0〜1) }
function trOutState(cam, tick) {
  const t = cam.trans && cam.trans.out;
  if (!t || !t.type || t.type === 'none' || !(t.sec > 0)) return null;
  const dur = t.sec * scTps();
  if (tick >= cam.endTick || tick < cam.endTick - dur) return null;
  return { type: t.type, u: Math.min(1, (tick - (cam.endTick - dur) + 1) / dur) };
}


// ============================================================
// WebGL: 前のカメラを絵(テクスチャ)に描いて、重ねる
// ============================================================

const TR_VS = `
  attribute vec2 aPos;
  varying vec2 vUV;
  void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;
const TR_FS = `
  precision mediump float;
  uniform sampler2D uTex;
  uniform float uUseTex;
  uniform vec4 uColor;
  uniform int uMode;
  uniform float uU;
  uniform float uAspect;
  varying vec2 vUV;
  void main() {
    if (uMode == 1 && vUV.x < uU) discard;                 // ワイプ(左から): 左側は新しいカメラ
    if (uMode == 2 && vUV.y > 1.0 - uU) discard;           // ワイプ(上から)
    if (uMode == 3) {                                      // 円で開く: 円の中は新しいカメラ
      vec2 d = (vUV - 0.5) * vec2(uAspect, 1.0);
      float maxR = 0.5 * length(vec2(uAspect, 1.0));
      if (length(d) < uU * maxR) discard;
    }
    vec4 c = uUseTex > 0.5 ? vec4(texture2D(uTex, vUV).rgb, 1.0) : vec4(uColor.rgb, 1.0);
    gl_FragColor = vec4(c.rgb, uColor.a);
  }
`;

let _tr = null;
function _trInit(gl) {
  if (_tr) return _tr;
  const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('切り替えのシェーダー: ' + gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, TR_VS));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, TR_FS));
  gl.linkProgram(prog);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  _tr = { prog, vbo, fbo: null, tex: null, depth: null, w: 0, h: 0,
    loc: { pos: gl.getAttribLocation(prog, 'aPos'), tex: gl.getUniformLocation(prog, 'uTex'), useTex: gl.getUniformLocation(prog, 'uUseTex'),
           color: gl.getUniformLocation(prog, 'uColor'), mode: gl.getUniformLocation(prog, 'uMode'), u: gl.getUniformLocation(prog, 'uU'),
           aspect: gl.getUniformLocation(prog, 'uAspect') } };
  return _tr;
}

function _trEnsureFbo(gl, w, h) {
  const t = _trInit(gl);
  if (t.fbo && t.w === w && t.h === h) return t;
  if (t.fbo) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); gl.deleteRenderbuffer(t.depth); }
  t.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  t.depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
  t.fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  t.w = w; t.h = h;
  return t;
}

// 前のカメラを、テクスチャに描く(drawScene(x,y,w,h) は今の描き先に1カメラぶん描く関数)
function trRenderToTexture(gl, w, h, drawScene) {
  const t = _trEnsureFbo(gl, w, h);
  const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
  gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, w, h);
  try { drawScene(0, 0, w, h); }
  finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (scissorOn) gl.enable(gl.SCISSOR_TEST);
  }
  return t.tex;
}

// 四角(rx,ry,rw,rh)に重ねて描く。mode: 0=全体(alpha) 1=ワイプ左 2=ワイプ上 3=円
function trDrawQuad(gl, rect, opts) {
  const t = _trInit(gl);
  const [rx, ry, rw, rh] = rect;
  gl.viewport(rx, ry, rw, rh);
  gl.scissor(rx, ry, rw, rh);
  gl.useProgram(t.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, t.vbo);
  gl.enableVertexAttribArray(t.loc.pos);
  gl.vertexAttribPointer(t.loc.pos, 2, gl.FLOAT, false, 8, 0);
  if (opts.tex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.tex);
    gl.uniform1i(t.loc.tex, 0);
  }
  gl.uniform1f(t.loc.useTex, opts.tex ? 1 : 0);
  const c = opts.color || [0, 0, 0];
  gl.uniform4f(t.loc.color, c[0], c[1], c[2], opts.alpha != null ? opts.alpha : 1);
  gl.uniform1i(t.loc.mode, opts.mode || 0);
  gl.uniform1f(t.loc.u, opts.u || 0);
  gl.uniform1f(t.loc.aspect, rw / Math.max(1, rh));
  const depthOn = gl.isEnabled(gl.DEPTH_TEST), blendOn = gl.isEnabled(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  if (depthOn) gl.enable(gl.DEPTH_TEST);
  if (!blendOn) gl.disable(gl.BLEND);
  gl.disableVertexAttribArray(t.loc.pos);
}

// 1つのカメラの四角を、切り替えの演出つきで描く(freecam.js の合成から呼ぶ)
//   drawCam(c, tickForPose, x, y, w, h): c を描く関数
function trRenderCameraRect(gl, cam, tick, rect, drawCam) {
  const [rx, ry, rw, rh] = rect.map(v => Math.round(v));
  const R = [rx, ry, Math.max(1, rw), Math.max(1, rh)];
  const tin = trInState(cam, tick), tout = trOutState(cam, tick);
  const COLOR = { black: [0, 0, 0], white: [1, 1, 1] };
  const holdTick = (c) => Math.min(tick, c.endTick - 1); // 前のカメラは、最後の構図のまま(世界は動き続ける)
  if (tin && (tin.type === 'black' || tin.type === 'white')) {
    const col = COLOR[tin.type];
    if (tin.u < 0.5) {
      if (tin.from) drawCam(tin.from, holdTick(tin.from), ...R);
      trDrawQuad(gl, R, { color: col, alpha: tin.from ? Math.min(1, tin.u * 2) : 1 });
    } else {
      drawCam(cam, tick, ...R);
      trDrawQuad(gl, R, { color: col, alpha: Math.min(1, (1 - tin.u) * 2) });
    }
  } else if (tin) {
    let tex = null;
    if (tin.from) tex = trRenderToTexture(gl, R[2], R[3], (x, y, w, h) => drawCam(tin.from, holdTick(tin.from), x, y, w, h));
    gl.scissor(...R);
    drawCam(cam, tick, ...R);
    const mode = { fade: 0, wipeL: 1, wipeU: 2, circle: 3 }[tin.type] || 0;
    const e = 1 - Math.pow(1 - tin.u, 2);
    trDrawQuad(gl, R, { tex, color: [0, 0, 0], alpha: mode === 0 ? 1 - tin.u : 1, mode, u: e });
  } else {
    drawCam(cam, tick, ...R);
  }
  if (tout) trDrawQuad(gl, R, { color: COLOR[tout.type] || [0, 0, 0], alpha: tout.u });
}


// ============================================================
// カメラのパネルの「切り替えの演出」
// ============================================================

function renderTransitionFields(body, cam) {
  body.appendChild(_el('div', 'panelSectionLabel', '切り替えの演出(トランジション)'));
  const part = (which, label, types, defSec) => {
    const cur = (cam.trans && cam.trans[which]) || null;
    const curType = cur ? cur.type : 'none';
    const r = _el('div', 'fieldRow column');
    r.appendChild(_el('label', null, label));
    const g = _el('div', 'settingsRadioGroup');
    for (const [id, name] of types) {
      const pill = _el('button', 'settingsRadioPill small' + (curType === id ? ' active' : ''), name);
      pill.type = 'button';
      pill.addEventListener('click', () => {
        if (curType === id) return;
        pushUndo();
        if (!cam.trans) cam.trans = { in: null, out: null };
        cam.trans[which] = id === 'none' ? null : { type: id, sec: cur ? cur.sec : defSec };
        _showCameraInPreview(cam);
        seekTo(which === 'in' ? cam.startTick : Math.max(cam.startTick, cam.endTick - Math.round(defSec * scTps())));
        editorChanged();
      });
      g.appendChild(pill);
    }
    r.appendChild(g);
    body.appendChild(r);
    if (cur) {
      const sr = _el('div', 'fieldRow');
      sr.appendChild(_el('label', null, '長さ'));
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = '0.1'; inp.max = '3'; inp.step = '0.05'; inp.value = cur.sec;
      const v = _el('span', 'fieldValue', cur.sec.toFixed(2) + '秒');
      bindEditUndo(inp);
      inp.addEventListener('input', () => { cur.sec = parseFloat(inp.value); v.innerText = cur.sec.toFixed(2) + '秒'; timelineRenderBlocks(); });
      sr.appendChild(inp); sr.appendChild(v);
      body.appendChild(sr);
    }
  };
  part('in', '始まり(前のカメラから)', TRANS_IN_TYPES, 0.5);
  part('out', '終わり', TRANS_OUT_TYPES, 0.6);
  const prev = trOutgoingCamera(cam);
  body.appendChild(_el('div', 'panelHint', prev
    ? `始まりの演出は「${scCamName(prev)}」(ちょうどここで終わるカメラ)から切り替わります。`
    : 'このカメラの直前で終わるカメラが無いので、始まりの演出は黒から切り替わります(動画の始まりのフェードインなど)。カメラ同士をつなげると、前のカメラから切り替わります。'));
}
