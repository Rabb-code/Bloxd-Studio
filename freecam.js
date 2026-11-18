// freecam.js
// ============================================================
// 3D画面(地形の描画・視点の操作・カメラの操作・プレビュー)。
//
// 視点操作:
//   何も無い所をマウスで押したまま動かす(左でも右でも)と見回す。
//   WASDで移動、Q/Eで上下(押したまま見回している間は Space/Shift でも上下)。
//   ホイールで前後、見回している最中のホイールで移動速度、中ボタンドラッグで平行移動。
//   カメラの箱をクリックすると選択、矢印・リングをドラッグすると位置・向きを直せる。
//
// カメラ操作(キー。素材一覧・右パネルのボタンからも同じことができる):
//   F 今の視点でカメラを置く / K 再生ヘッドの時刻にキーを記録 / V カメラ視点 / Delete 削除
//   カメラはキーフレーム方式(entities3d.js)。「今見えている構図を、
//   再生ヘッドの時刻に記録する」が基本の考え方。
// ============================================================

// ステップ50: 地形の面は、数の並び(Int32Array、1面 = 8個: x,y,z,向き,パレット,大きさ,出る時刻,消える時刻)で持つ。
//   前は面ごとに JS の配列を作っていて、大きいワールドでメモリが足りなくなっていた(150万面で止めていた)
const FC_FACE_NEVER = 2147483647;
class FaceStore {
  constructor() { this.d = new Int32Array(8 * 4096); this.n = 0; this.dead = 0; this.ver = 0; }   // ver: 中身が変わるたびに増える(よそのキャッシュの印)
  get length() { return this.n; }
  get live() { return this.n - this.dead; }   // 消した面(向きが -1)を除いた数
  isDead(i) { return this.d[i * 8 + 3] < 0; }
  _grow(need) {
    if (need * 8 <= this.d.length) return;
    let c = this.d.length; while (c < need * 8) c *= 2;
    const nd = new Int32Array(c); nd.set(this.d.subarray(0, this.n * 8)); this.d = nd;
  }
  pushRaw(a) { const k = a.length >> 3; this._grow(this.n + k); this.d.set(a, this.n * 8); this.n += k; this.ver++; }
  push(f) {
    this._grow(this.n + 1);
    const o = this.n * 8, d = this.d;
    d[o] = f[0]; d[o + 1] = f[1]; d[o + 2] = f[2]; d[o + 3] = f[3]; d[o + 4] = f[4];
    d[o + 5] = f[5] || 1; d[o + 6] = f[6] || 0;
    d[o + 7] = (f.length > 7 && f[7] != null) ? Math.min(f[7], FC_FACE_NEVER) : FC_FACE_NEVER;
    this.n++; this.ver++;
  }
  // 1面を、前と同じ形の配列で([x,y,z,向き,パレット,大きさ,出る時刻,消える時刻 or null])
  get(i) {
    const o = i * 8, d = this.d;
    return [d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5] & 255, d[o + 6], d[o + 7] === FC_FACE_NEVER ? null : d[o + 7]];
  }
  *[Symbol.iterator]() { for (let i = 0; i < this.n; i++) if (this.d[i * 8 + 3] >= 0) yield this.get(i); }
  // keep(i) が true の面だけ残す(その場で詰める)。消えた数を返す
  compact(keep) {
    const d = this.d; let w = 0;
    for (let i = 0; i < this.n; i++) {
      if (!keep(i)) continue;
      if (w !== i) d.copyWithin(w * 8, i * 8, i * 8 + 8);
      w++;
    }
    const removed = this.n - w; this.n = w; this.dead = 0; this.ver++;
    for (let i = 0; i < w; i++) if (d[i * 8 + 3] < 0) this.dead++;
    return removed;
  }
}
let fcMeshFaces = new FaceStore(), fcMeshPalette = [];

let fcCanvas, fcGl, fcProgram, fcVbo, fcTexture;
// ステップ50: ふつうの四角いブロックの面は、1面 = 32バイトの「部品」1つで描く(GPU で4隅を作る。前は 6頂点 × 32バイト)
let fcInst = null, fcInstProgram = null, fcInstVbo = null, fcCornerVbo = null, fcInstCap = 0, fcInstGpuN = 0;
let fcInstLoc = {};
let fcAPosLoc, fcAUVLoc, fcABrightnessLoc, fcARevealTickLoc, fcAHideTickLoc;
const FC_VERTEX_FLOATS = 8; // x,y,z, u,v, 明るさ, 出る時刻, 消える時刻
let fcUViewLoc, fcUProjLoc, fcUTextureLoc, fcUCurrentTickLoc;
let fcVertexCount = 0;
let fcUVRectsRaw = null;   // texName -> [u0,v0,u1,v1] (アトラス内の位置)
const fcPaletteStrips = new Map(); // ステップ32: 色の帯の絵 → 色の数(アトラスでは 16×16 の格子に並べてある)
let fcAtlasCanvas = null;
let fcAtlasReadyPromise = null;
let fcActive = false;      // 初期化済みかどうか(1回きりの初期化フラグ)
let fcAnimId = null;
let fcLastFrameTime = 0;
let fcKeys = {};
let fcYaw = 0, fcPitch = 0;
let fcPos = [0, 20, 0]; // worldOriginX,Y,Zからの相対座標
let fcFovDeg = 70;

const FC_MOUSE_SENSITIVITY = 0.0025;


// ============================================================
// シェーダー
// ============================================================

// ステップ53: 影MOD の「形を動かす」(modVertex)を差しこむ所は __MODVERTEX__。材質(水・葉など)は明るさの数に 2×材質 を足して運ぶ
//   (形・建築)/ 部品の4バイト目の y に 4×材質 を足して運ぶ(四角い面)。材質の番号は shader-mod.js の MAT_* と同じ
const FC_MOD_VS_COMMON = `
  uniform vec3 uModOrigin;
  uniform float uModTime;
  uniform float uModRealTime;
  uniform vec3 uModSun;
  uniform float uPhase;   // ステップ55: 0 = 全部, 1 = 透けない物だけ, 2 = 水だけ(あとから重ねて描く)
`;
const FC_VERTEX_SHADER_SRC = `
  attribute vec3 aPos;
  attribute vec2 aUV;
  attribute float aBrightness;
  attribute float aRevealTick;
  attribute float aHideTick;
  attribute vec3 aBlock;
  uniform mat4 uView;
  uniform mat4 uProj;
  uniform float uCurrentTick;
  varying vec2 vUV;
  varying float vBrightness;
  varying float vMat;
` + FC_MOD_VS_COMMON + `
  __MODVERTEX__
  void main() {
    float mat = floor(aBrightness / 2.0);
    vMat = mat;
    vUV = aUV;
    vBrightness = aBrightness - mat * 2.0;
    bool water = mat > 0.5 && mat < 1.5;
    if (aRevealTick > uCurrentTick || aHideTick <= uCurrentTick || (uPhase > 0.5 && (uPhase < 1.5) == water)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // クリップ範囲外に飛ばして非表示にする
      return;
    }
    vec3 p = aPos;
#ifdef MOD_VERTEX
    p = modVertex(aPos + uModOrigin, aBlock + uModOrigin, mat) - uModOrigin;
#endif
    gl_Position = uProj * uView * vec4(p, 1.0);
  }
`;

const FC_FRAGMENT_SHADER_SRC = `
  precision mediump float;
  uniform sampler2D uTexture;
  uniform float uMatPass;
  uniform float uAlphaMul;   // ステップ55: 水を重ねて描く時の不透明さ(0 = ふつう)
  varying vec2 vUV;
  varying float vBrightness;
  varying float vMat;
  void main() {
    vec4 texColor = texture2D(uTexture, vUV);
    if (texColor.a < 0.1) discard;
    // ステップ53: 材質の絵(影MOD 用): r = 材質, g = 明るさ(向き・角の暗さ), b = 不透明さ
    if (uMatPass > 0.5) { gl_FragColor = vec4(vMat / 255.0, vBrightness, texColor.a, 1.0); return; }   // ステップ53b: ちょうどの数で入れる(+0.5 だと、GPU によっては 1つ上の番号になっていた)
    gl_FragColor = vec4(texColor.rgb / texColor.a * vBrightness, uAlphaMul > 0.0 ? min(texColor.a, uAlphaMul) : texColor.a);   // ステップ49e: 色に不透明度がかかっているので戻す
  }
`;

// ステップ50: 四角いブロックの面(1面 = 部品1つ)。4隅の位置と絵の位置は、向きごとの表(uOff・uCUV)から作る
// ステップ51: 角の暗さ(公式と同じ: ふさがり 0〜3 → 1・0.92・0.8・0.5。暗さの差が少ない方の対角線で三角形に分ける)
//   部品の4バイト目: x = 向き + 8×貼り方, y = 大きさ + 4×材質, z = 角の暗さ(2ビット×4), w = 隅の番号(6頂点に広げた時)
const FC_INST_VERTEX_SHADER_SRC = `
  attribute float aCorner;
  attribute vec3 aIPos;
  attribute vec4 aIRect;
  attribute vec2 aITicks;
  attribute vec4 aIMeta;
  uniform mat4 uView;
  uniform mat4 uProj;
  uniform float uCurrentTick;
  uniform vec4 uOff[24];
  uniform vec4 uCUV[24];
  uniform vec4 uAO;
  varying vec2 vUV;
  varying float vBrightness;
  varying float vMat;
` + FC_MOD_VS_COMMON + `
  __MODVERTEX__
  void main() {
    vUV = vec2(0.0);
    vBrightness = 0.0;
    float mat = floor(aIMeta.y / 4.0);
    vMat = mat;
    float mat0 = floor(aIMeta.y / 4.0);
    bool water = mat0 > 0.5 && mat0 < 1.5;
    if (aITicks.x > uCurrentTick || aITicks.y <= uCurrentTick || (uPhase > 0.5 && (uPhase < 1.5) == water)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float flag = step(7.5, aIMeta.x);
    float d = aIMeta.x - 8.0 * flag;
    float ao = aIMeta.z;
    float l0 = mod(ao, 4.0), l1 = mod(floor(ao / 4.0), 4.0), l2 = mod(floor(ao / 16.0), 4.0), l3 = floor(ao / 64.0);
    float k = aCorner;
    float oi;
    if (l0 + l2 > l1 + l3) oi = k < 0.5 ? 1.0 : (k < 1.5 ? 2.0 : (k < 2.5 ? 3.0 : (k < 3.5 ? 1.0 : (k < 4.5 ? 3.0 : 0.0))));
    else oi = k < 2.5 ? k : (k < 3.5 ? 0.0 : (k < 4.5 ? 2.0 : 3.0));
    float lv = oi < 0.5 ? l0 : (oi < 1.5 ? l1 : (oi < 2.5 ? l2 : l3));
    float aoMul = lv < 0.5 ? uAO.x : (lv < 1.5 ? uAO.y : (lv < 2.5 ? uAO.z : uAO.w));
    int idx = int(d * 4.0 + oi + 0.5);
    vec4 o = uOff[idx];
    vec4 c = uCUV[idx];
    vec2 cuv = flag > 0.5 ? c.xy : c.zw;
    float s = aIMeta.y - mat * 4.0;
    vec3 p = aIPos + vec3(o.x * s, o.y, o.z * s);
#ifdef MOD_VERTEX
    p = modVertex(p + uModOrigin, aIPos + uModOrigin, mat) - uModOrigin;
#endif
    gl_Position = uProj * uView * vec4(p, 1.0);
    vUV = aIRect.xy + cuv * (aIRect.zw - aIRect.xy);
    vBrightness = o.w * aoMul;
  }
`;

// ステップ53: 影MOD の形を動かすコード(shader-mod.js が入れる)。{ code, options:[{id,type}] } か null
let fcModVertex = null;
function fcModVertexSource() {
  if (!fcModVertex || !fcModVertex.code) return '';
  const decl = (fcModVertex.options || []).map(o => o.type === 'color' ? `uniform vec3 opt_${o.id};` : `uniform float opt_${o.id};`).join('\n');
  const helpers = (typeof SHMOD_VERTEX_HELPERS !== 'undefined') ? SHMOD_VERTEX_HELPERS : '';
  return '#define MOD_VERTEX 1\n' + decl + '\n' + SHMOD_MAT_DEFINES + helpers + '\n#line 1 3\n' + fcModVertex.code + '\n';
}
const SHMOD_MAT_DEFINES = `
#define MAT_SOLID 0.0
#define MAT_WATER 1.0
#define MAT_LEAVES 2.0
#define MAT_GLASS 3.0
#define MAT_PLANT 4.0
#define MAT_LIGHT 5.0
#define MAT_LAVA 6.0
#define MAT_ICE 7.0
#define MAT_SNOW 8.0
#define MAT_SAND 9.0
#define MAT_ENTITY 10.0
#define MAT_SKY 11.0
`;
// ブロックの材質(名前から決める)
function fcMaterialOf(p, info) {
  if (!p) return 0;
  const s = (((p.root_name || '') + ' ' + (p.texture || '')).toLowerCase());
  // ステップ55: 公式の表(official/materials.json)があれば、水・ガラス・光るブロックはそれで決める(名前の当てずっぽうをやめる)
  const mats = (typeof OFFBLK !== 'undefined' && OFFBLK.materials) || null;
  if (mats) {
    const m = mats[p.root_name];
    if (m) {
      if (m.f) return /lava/.test(s) ? 6 : 1;
      if (m.l && Math.max(m.l[0], m.l[1], m.l[2]) >= 8) return 5;
      if (m.t) return 3;
    }
  } else {
    if (/lava|magma/.test(s)) return 6;
    if (/water/.test(s) && !/watermelon/.test(s)) return 1;
    if (/torch|lantern|lamp|glowstone|candle|campfire|\bfire\b|jack o|shroomlight|beacon|glow_?stone|sea_?lantern/.test(s)) return 5;
    if (/glass/.test(s)) return 3;
  }
  if (/leaves|leaf/.test(s)) return 2;
  if (/(^|[^a-z])ice/.test(s)) return 7;
  if (/snow/.test(s)) return 8;
  if (/sand/.test(s) && !/stone/.test(s)) return 9;
  if (info && info.type === 'cross') return 4;
  if (/grass|flower|fern|sapling|bush|tulip|rose|vine|wheat|carrot|potato|mushroom|dandelion|poppy|daisy|reed|cane|kelp|seagrass/.test(s) && !/block|path/.test(s)) return 4;
  return 0;
}
function _fcMaterialOfOld(p, info) {
  const s = (((p.root_name || '') + ' ' + (p.texture || '')).toLowerCase());
  if (/lava|magma/.test(s)) return 6;
  if (/water/.test(s) && !/watermelon/.test(s)) return 1;
  if (/torch|lantern|lamp|glowstone|candle|campfire|\bfire\b|jack o|shroomlight|beacon|glow_?stone|sea_?lantern/.test(s)) return 5;
  if (/leaves|leaf/.test(s)) return 2;
  if (/glass/.test(s)) return 3;
  if (/(^|[^a-z])ice/.test(s)) return 7;
  if (/snow/.test(s)) return 8;
  if (/sand/.test(s) && !/stone/.test(s)) return 9;
  if (info && info.type === 'cross') return 4;
  if (/grass|flower|fern|sapling|bush|tulip|rose|vine|wheat|carrot|potato|mushroom|dandelion|poppy|daisy|reed|cane|kelp|seagrass/.test(s) && !/block|path/.test(s)) return 4;
  return 0;
}
// 形を動かすコードの uniform を入れる(地形・建築の描く前に)
function fcApplyModVertexUniforms(gl, L) {
  if (!L || !L.modOrigin) return;
  gl.uniform3f(L.modOrigin, worldOriginX, worldOriginY, worldOriginZ);
  const tps = (typeof scTps === 'function') ? scTps() : 30;
  gl.uniform1f(L.modTime, (curTick + fcSubTick) / tps);
  gl.uniform1f(L.modRealTime, performance.now() / 1000);
  const sun = (typeof shmodCurrentSun === 'function') ? shmodCurrentSun() : [0.4, 0.8, 0.4];
  gl.uniform3f(L.modSun, sun[0], sun[1], sun[2]);
  if (L.opts && typeof shmodValuesNow === 'function') {
    const v = shmodValuesNow();
    for (const o of (fcModVertex && fcModVertex.options) || []) {
      const l = L.opts[o.id];
      if (!l) continue;
      const x = v[o.id];
      if (o.type === 'color') { const c = _shmodHex(x); gl.uniform3f(l, c[0], c[1], c[2]); }
      else gl.uniform1f(l, o.type === 'toggle' ? (x ? 1 : 0) : +x);
    }
  }
}
function fcModVertexLocs(gl, p) {
  const U = (n) => gl.getUniformLocation(p, n);
  const opts = {};
  for (const o of (fcModVertex && fcModVertex.options) || []) opts[o.id] = U('opt_' + o.id);
  return { modOrigin: U('uModOrigin'), modTime: U('uModTime'), modRealTime: U('uModRealTime'), modSun: U('uModSun'), matPass: U('uMatPass'), phase: U('uPhase'), alphaMul: U('uAlphaMul'), opts };
}

function fcCompileShader(type, src) {
  const s = fcGl.createShader(type);
  fcGl.shaderSource(s, src);
  fcGl.compileShader(s);
  if (!fcGl.getShaderParameter(s, fcGl.COMPILE_STATUS)) {
    const info = fcGl.getShaderInfoLog(s);
    fcGl.deleteShader(s);
    throw new Error('シェーダーのコンパイルに失敗しました: ' + info);
  }
  return s;
}

function initFreecamGL() {
  fcCanvas = document.getElementById('freecamCanvas');
  fcGl = fcCanvas.getContext('webgl') || fcCanvas.getContext('experimental-webgl');
  if (!fcGl) {
    setStatusText('⚠️ このブラウザ/端末ではWebGLが使えません。別のブラウザ(Chrome/Firefox等)でお試しください。');
    return false;
  }
  if (FC_MIRROR_X) fcGl.frontFace(fcGl.CW);   // 左右を反対に映すので、表の面の回り方も反対
  _fcMakeShapeProgram();
  fcVbo = fcGl.createBuffer();
  fcShapeOrigVbo = fcGl.createBuffer();
  _fcInitInstanced();
  fcGl.enable(fcGl.DEPTH_TEST);
  fcGl.depthFunc(fcGl.LESS);

  setupFreecamControls();
  window.addEventListener('resize', () => { if (fcGl) resizeFreecamCanvas(); });
  return true;
}

// 形(草花・モデル)の描き方。影MOD の形を動かすコードが変わった時も作り直す
let fcShapeLoc = {};
function _fcMakeShapeProgram() {
  const gl = fcGl;
  const vs = fcCompileShader(gl.VERTEX_SHADER, FC_VERTEX_SHADER_SRC.replace('__MODVERTEX__', fcModVertexSource()));
  const fs = fcCompileShader(gl.FRAGMENT_SHADER, FC_FRAGMENT_SHADER_SRC);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('シェーダープログラムのリンクに失敗しました: ' + gl.getProgramInfoLog(p));
  if (fcProgram) gl.deleteProgram(fcProgram);
  fcProgram = p;
  fcAPosLoc = gl.getAttribLocation(p, 'aPos');
  fcAUVLoc = gl.getAttribLocation(p, 'aUV');
  fcABrightnessLoc = gl.getAttribLocation(p, 'aBrightness');
  fcARevealTickLoc = gl.getAttribLocation(p, 'aRevealTick');
  fcAHideTickLoc = gl.getAttribLocation(p, 'aHideTick');
  fcABlockLoc = gl.getAttribLocation(p, 'aBlock');
  fcUViewLoc = gl.getUniformLocation(p, 'uView');
  fcUProjLoc = gl.getUniformLocation(p, 'uProj');
  fcUTextureLoc = gl.getUniformLocation(p, 'uTexture');
  fcUCurrentTickLoc = gl.getUniformLocation(p, 'uCurrentTick');
  fcShapeLoc = fcModVertexLocs(gl, p);
}
let fcABlockLoc = -1, fcShapeOrigVbo = null, fcShapeOrigGpuN = 0, fcShapeOrigCap = 0;

// ステップ53: 影MOD の形を動かすコードを入れて、地形・形・建築の描き方を作り直す。エラーなら投げる(前の物はそのまま)
function fcSetModVertex(mv) {
  const prev = fcModVertex;
  fcModVertex = mv && mv.code ? mv : null;
  if (!fcGl) return;
  const keepShape = fcProgram, keepInst = fcInstProgram;
  try {
    fcProgram = null;
    _fcMakeShapeProgram();
    fcInstProgram = null;
    _fcMakeInstProgram();
    if (keepShape) fcGl.deleteProgram(keepShape);
    if (keepInst) fcGl.deleteProgram(keepInst);
    if (typeof bdResetProgram === 'function') bdResetProgram();
  } catch (e) {
    fcModVertex = prev;
    if (fcProgram && fcProgram !== keepShape) fcGl.deleteProgram(fcProgram);
    fcProgram = keepShape; fcInstProgram = keepInst;
    // 位置を取り直す(前の物)
    if (keepShape) { fcProgram = null; try { _fcMakeShapeProgram(); fcGl.deleteProgram(keepShape); } catch (e2) { fcProgram = keepShape; } }
    if (keepInst) { fcInstProgram = null; try { _fcMakeInstProgram(); fcGl.deleteProgram(keepInst); } catch (e2) { fcInstProgram = keepInst; } }
    throw e;
  }
}

function resizeFreecamCanvas() {
  const area = document.getElementById('freecamArea');
  const w = Math.max(1, area.clientWidth), h = Math.max(1, area.clientHeight);
  // 実際にサイズが変わった時だけ書き換える(毎回代入するとWebGLの描画バッファが
  // 毎フレーム作り直しになってしまうため)
  if (fcCanvas.width !== w || fcCanvas.height !== h) {
    fcCanvas.width = w;
    fcCanvas.height = h;
  }
}


// ============================================================
// テクスチャアトラス(実際のpngをまとめて1枚のWebGLテクスチャにする)
// zip内の全テクスチャを対象にする(どのパレットにも依存しないので、
// ストリーミングでパレットが後から増えても作り直さなくて良い)。
// ============================================================

function ensureFreecamAtlasReady() {
  if (!fcAtlasReadyPromise) {
    fcAtlasReadyPromise = buildFreecamTextureAtlas();
  }
  return fcAtlasReadyPromise;
}

async function buildFreecamTextureAtlas() {
  // ui.js: zipの展開(textureUrlsを埋める)。ステップ32: 公式のブロックの描き方の表も一緒に読む
  await Promise.all([ensureTexturesLoading(), typeof officialBlocksLoad === 'function' ? officialBlocksLoad() : null]);
  const names = Array.from(textureUrls.keys());

  // ステップ49d: マスのまわりに「のりしろ」(端の色をのばした2px)を付ける。遠くから見た時、ブロックの継ぎ目に
  // 隣のマスの色や透明が混ざって線が見えていた(透明なブロックでも、すき間のように見えていた)
  // ステップ49e: 遠くの絵を「ミップマップ」(縮めた絵)で描く。そのためにアトラスを 2 の累乗の大きさにして、
  //   1マス = 64px(絵 48px + まわりののりしろ 8px)にそろえる。縮めても隣のマスと混ざらない
  //   (64 → 32 → 16 … と半分にしても、マスの境目がずれない)。8×8 の絵はちょうど 6 倍
  const cell = 48, gut = 8, pitch = cell + gut * 2;
  const cols = 64;
  const rows = Math.max(1, Math.ceil(names.length / cols));
  const pot = (n) => { let p = 1; while (p < n) p *= 2; return p; };
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = cols * pitch;
  atlasCanvas.height = pot(rows * pitch);
  const actx = atlasCanvas.getContext('2d');
  actx.imageSmoothingEnabled = false;
  // ステップ32b: 下地は透明のまま(前は全体を灰色で塗っていたので、絵の透明な所が灰色になっていた)
  // 読み込めなかった絵のマスだけ灰色にする(下の onerror)
  actx.fillStyle = '#888';

  const uvRects = new Map();
  const promises = [];
  names.forEach((texName, i) => {
    const gx = (i % cols) * pitch + gut, gy = Math.floor(i / cols) * pitch + gut;
    const col = gx / cell, row = gy / cell;   // 下の描く処理は col * cell / row * cell を使う
    // 隣のセルの色がにじみ出ない(bleeding)よう、少しだけ内側にパディングする
    const padU = 0.5 / atlasCanvas.width, padV = 0.5 / atlasCanvas.height;
    uvRects.set(texName, [
      gx / atlasCanvas.width + padU, gy / atlasCanvas.height + padV,
      (gx + cell) / atlasCanvas.width - padU, (gy + cell) / atlasCanvas.height - padV,
    ]);
    const url = textureUrls.get(texName);
    promises.push(new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (img.height === 1 && img.width > 1 && img.width <= 256) {
          // ステップ32: 公式のモデルの「色の帯」(256×1 のパレット)は、押しつぶすと色が混ざるので
          // マスの中に 16×16 の格子で並べる(official-blocks.js が UV をその色のマスの真ん中に合わせる)
          const k = cell / 16;
          for (let i = 0; i < img.width; i++) actx.drawImage(img, i, 0, 1, 1, col * cell + (i % 16) * k, row * cell + Math.floor(i / 16) * k, k, k);
          fcPaletteStrips.set(texName, img.width);
        } else {
          actx.drawImage(img, col * cell, row * cell, cell, cell);
          // のりしろ: 絵の端の1列・1行を、まわりの gut にのばす(角も)
          const w = img.width, h = img.height, x = gx, y = gy;
          actx.drawImage(img, 0, 0, 1, h, x - gut, y, gut, cell);
          actx.drawImage(img, w - 1, 0, 1, h, x + cell, y, gut, cell);
          actx.drawImage(img, 0, 0, w, 1, x, y - gut, cell, gut);
          actx.drawImage(img, 0, h - 1, w, 1, x, y + cell, cell, gut);
          actx.drawImage(img, 0, 0, 1, 1, x - gut, y - gut, gut, gut);
          actx.drawImage(img, w - 1, 0, 1, 1, x + cell, y - gut, gut, gut);
          actx.drawImage(img, 0, h - 1, 1, 1, x - gut, y + cell, gut, gut);
          actx.drawImage(img, w - 1, h - 1, 1, 1, x + cell, y + cell, gut, gut);
        }
        resolve();
      };
      img.onerror = () => { actx.fillRect(col * cell, row * cell, cell, cell); resolve(); };
      img.src = url;
    }));
  });
  await Promise.all(promises);
  fcUVRectsRaw = uvRects;
  fcAtlasCanvas = atlasCanvas;
}

function fcUploadAtlasTexture() {
  fcTexture = fcGl.createTexture();
  fcGl.bindTexture(fcGl.TEXTURE_2D, fcTexture);
  // 透明な所のまわりが縮めた時に黒ずまないよう、色に不透明度をかけた形で送る(地形のシェーダーで戻す)
  fcGl.pixelStorei(fcGl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  fcGl.texImage2D(fcGl.TEXTURE_2D, 0, fcGl.RGBA, fcGl.RGBA, fcGl.UNSIGNED_BYTE, fcAtlasCanvas);
  fcGl.pixelStorei(fcGl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // ステップ49e: 遠くはミップマップ(なめらか)、近くは今までどおり点のまま(ドット絵)。斜めから見た地面は異方性フィルタで
  const isPot = (n) => (n & (n - 1)) === 0;
  if (isPot(fcAtlasCanvas.width) && isPot(fcAtlasCanvas.height)) {
    fcGl.generateMipmap(fcGl.TEXTURE_2D);
    fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_MIN_FILTER, fcGl.LINEAR_MIPMAP_LINEAR);
    const ext = fcGl.getExtension('EXT_texture_filter_anisotropic') || fcGl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (ext) fcGl.texParameterf(fcGl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, fcGl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  } else {
    fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_MIN_FILTER, fcGl.LINEAR);
  }

  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_MAG_FILTER, fcGl.NEAREST);
  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_WRAP_S, fcGl.CLAMP_TO_EDGE);
  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_WRAP_T, fcGl.CLAMP_TO_EDGE);
}


// ============================================================
// ジオメトリ(ストリーミングで届いた面を継ぎ足していく)
// ============================================================

function startFreecamStream() {
  fcMeshFaces = new FaceStore();
  fcMeshPalette = [];
  _fcResetBuilt();
  resetWorldOrigin();
  if (fcGl) _uploadFreecamVertexData(true);
}

// ============================================================
// ステップ50: 描くための入れ物(大きいワールドでも軽いように、数の並びで持つ)
// ============================================================

// 草花・モデルなどの形の頂点(1頂点 = 8個: x,y,z, u,v, 明るさ, 出る時刻, 消える時刻)。offPushShape が push で積む
class GrowF32 {
  constructor(n) { this.a = new Float32Array(n || 8 * 6 * 2048); this.length = 0; }
  push() {
    const k = arguments.length;
    if (this.length + k > this.a.length) {
      let c = this.a.length * 2; while (c < this.length + k) c *= 2;
      const na = new Float32Array(c); na.set(this.a.subarray(0, this.length)); this.a = na;
    }
    for (let i = 0; i < k; i++) this.a[this.length++] = arguments[i];
    return this.length;
  }
  view() { return this.a.subarray(0, this.length); }
}

// 四角いブロックの面の部品(1面 = 32バイト: 位置 3つ, 絵の場所 4つ(0〜1 を 0〜65535 で), 出る・消える時刻, 向き・大きさ・貼り方)
const FC_INST_BYTES = 32;
class InstBuf {
  constructor(cap) { this.n = 0; this.buf = null; this._alloc(cap || 65536); }
  _alloc(cap) {
    const buf = new ArrayBuffer(cap * FC_INST_BYTES);
    if (this.buf) new Uint8Array(buf).set(new Uint8Array(this.buf, 0, this.n * FC_INST_BYTES));
    this.buf = buf; this.cap = cap;
    this.f = new Float32Array(buf); this.u16 = new Uint16Array(buf); this.u8 = new Uint8Array(buf);
  }
  add(x, y, z, rect, r, h, dir, scale, flag, ao) {
    if (this.n >= this.cap) this._alloc(this.cap * 2);
    const i = this.n++, fo = i * 8, so = i * 16, bo = i * 32;
    const f = this.f, u = this.u16, q = (v) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));
    f[fo] = x; f[fo + 1] = y; f[fo + 2] = z;
    u[so + 6] = q(rect[0]); u[so + 7] = q(rect[1]); u[so + 8] = q(rect[2]); u[so + 9] = q(rect[3]);
    f[fo + 5] = r; f[fo + 6] = h;
    this.u8[bo + 28] = dir + (flag ? 8 : 0); this.u8[bo + 29] = scale; this.u8[bo + 30] = ao || 0; this.u8[bo + 31] = 0;
    return i;
  }
  // 別の入れ物の i 番を、時刻だけ変えて写す
  copyFrom(src, i, r, h) {
    if (this.n >= this.cap) this._alloc(this.cap * 2);
    const j = this.n++;
    this.u8.set(src.u8.subarray(i * 32, i * 32 + 32), j * 32);
    this.f[j * 8 + 5] = r; this.f[j * 8 + 6] = h;
    return j;
  }
  bytes() { return this.u8.subarray(0, this.n * FC_INST_BYTES); }
}

let fcInstBuf = new InstBuf(1024);   // 四角い面の部品(CPU 側)
let fcShapeBuf = new GrowF32();      // 形の頂点(CPU 側)
let fcShapeOrig = new GrowF32(3 * 6 * 2048);   // ステップ53: 形の頂点ごとの、ブロックの角の場所(3個ずつ)
let fcShapeGpuN = 0;                 // GPU に送った形の数(浮動小数点の数)
// 面の番号 -> 描いている物(fcFaceKind: 0 = 描いていない, 1 = 四角い面の部品, 2 = 形の頂点)
let fcFaceKind = new Uint8Array(4096), fcFaceRef = new Int32Array(4096), fcFaceCnt = new Int32Array(4096);
let fcBuiltN = 0, fcTerrainGen = 0;
let fcHasWater = false;   // ステップ55: 水のブロックがあるか(あれば、水だけ後から重ねて描く)
// 置いたブロックは「ポン」と出る演出の分だけ遅らせる。草花・モデルなどの形は、1つの場所に1回だけ出す
let fcShapeDone = new Set();

function _fcResetBuilt() {
  fcInstBuf = new InstBuf(Math.max(1024, Math.min(1 << 22, fcMeshFaces.length + 1024)));
  fcShapeBuf = new GrowF32();
  fcShapeOrig = new GrowF32(3 * 6 * 2048);
  fcShapeDone = new Set();
  fcBuiltN = 0;
  fcTerrainGen++;
}
function _fcEnsureFaceRefs(n) {
  if (n <= fcFaceKind.length) return;
  let c = fcFaceKind.length; while (c < n) c *= 2;
  const k = new Uint8Array(c), r = new Int32Array(c), q = new Int32Array(c);
  k.set(fcFaceKind); r.set(fcFaceRef); q.set(fcFaceCnt);
  fcFaceKind = k; fcFaceRef = r; fcFaceCnt = q;
}

// 面の番号 from から最後までを、描く物にする(from = 0 なら最初から作り直す)
function _fcBuildFrom(from) {
  if (!from) _fcResetBuilt();
  const n = fcMeshFaces.length, D = fcMeshFaces.d;
  _fcEnsureFaceRefs(n);
  if (fcBuiltN >= n) return;
  const rectsRaw = fcUVRectsRaw;
  const paletteUVRects = fcMeshPalette.map(p => (rectsRaw && rectsRaw.get(p.texture)) || [0, 0, 1, 1]);
  // 公式の描き方(official-blocks.js): 面ごとの絵・草花の十字・ドアなどのモデル
  const paletteInfo = fcMeshPalette.map(p => (typeof offPaletteInfo === 'function') ? offPaletteInfo(p, rectsRaw) : null);
  // 絵の決まっていないブロック(表に無い物)は、アトラス全体を貼らずに出さない
  if (fcMeshPalette.some(p => fcMaterialOf(p, null) === 1)) fcHasWater = true;
  const paletteSkip = fcMeshPalette.map((p, i) => !paletteInfo[i] && !!rectsRaw && !(p && rectsRaw.has(p.texture)));
  const paletteMat = fcMeshPalette.map((p, i) => fcMaterialOf(p, paletteInfo[i]));   // ステップ53: 材質
  const delays = (typeof blockFxRevealDelays === 'function') ? blockFxRevealDelays() : null;
  const delayTicks = new Set();
  if (delays) for (const k of delays.keys()) delayTicks.add(+k.slice(k.lastIndexOf(',') + 1));
  const ox = worldOriginX, oy = worldOriginY, oz = worldOriginZ;
  const IB = fcInstBuf;
  for (let i = fcBuiltN; i < n; i++) {
    const o = i * 8;
    const wx = D[o], wy = D[o + 1], wz = D[o + 2], dir = D[o + 3], pIdx = D[o + 4], scale = (D[o + 5] & 255) || 1;
    const ao = fcAOEnabled ? (D[o + 5] >> 8) & 255 : 0;   // ステップ51: 角の暗さ(python が入れる)
    let reveal = D[o + 6];
    const hide = D[o + 7] === FC_FACE_NEVER ? 1e9 : D[o + 7];
    if (delays && delayTicks.has(reveal)) { const dl = delays.get(wx + ',' + wy + ',' + wz + ',' + reveal); if (dl) reveal += dl; }
    fcFaceKind[i] = 0; fcFaceCnt[i] = 0;
    if (dir < 0) continue;   // 消した面
    const info = paletteInfo[pIdx];
    if (info && info.type !== 'cube') {  // 十字・モデル・箱の組・三角形(柵の門)
      const key = wx + ',' + wy + ',' + wz + ',' + reveal + ',' + hide;
      if (!fcShapeDone.has(key)) {
        fcShapeDone.add(key);
        const st = fcShapeBuf.length / FC_VERTEX_FLOATS;
        offPushShape(info, wx - ox, wy - oy, wz - oz, reveal, hide, fcShapeBuf);
        const cnt = fcShapeBuf.length / FC_VERTEX_FLOATS - st;
        // ステップ53: 材質(明るさに 2×材質)と、ブロックの角の場所(影MOD の形を動かす用)
        const m2 = paletteMat[pIdx] * 2, A = fcShapeBuf.a;
        for (let v = 0; v < cnt; v++) { A[(st + v) * 8 + 5] += m2; fcShapeOrig.push(wx - ox, wy - oy, wz - oz); }
        if (cnt) { fcFaceKind[i] = 2; fcFaceRef[i] = st; fcFaceCnt[i] = cnt; }
      }
      continue;
    }
    if (paletteSkip[pIdx]) continue;
    const rect = info ? info.rects[dir] : (paletteUVRects[pIdx] || [0, 0, 1, 1]);
    fcFaceKind[i] = 1;
    fcFaceRef[i] = IB.add(wx - ox, wy - oy, wz - oz, rect, reveal, hide, dir, scale + 4 * paletteMat[pIdx], info ? 1 : 0, ao);
  }
  fcBuiltN = n;
}

// GPU に送る(full: 全部送り直す。そうでなければ、増えた分だけ)
let fcVertexF32 = null;   // (前の名前。今は形の頂点だけ)
function _uploadFreecamVertexData(full) {
  fcVertexCount = fcShapeBuf.length / FC_VERTEX_FLOATS;
  fcVertexF32 = fcShapeBuf.a;
  if (fcGl && fcInstVbo) {
    const gl = fcGl;
    // 四角い面
    const n = fcInstBuf.n;
    gl.bindBuffer(gl.ARRAY_BUFFER, fcInstVbo);
    if (full || n > fcInstCap) {
      fcInstCap = full ? Math.max(1024, n + 4096) : Math.max(n + 4096, Math.ceil(fcInstCap * 1.5));
      gl.bufferData(gl.ARRAY_BUFFER, fcInstCap * _fcInstGpuBytes(), gl.DYNAMIC_DRAW);
      _fcInstUpload(fcInstBuf, 0, n);
    } else if (n > fcInstGpuN) {
      _fcInstUpload(fcInstBuf, fcInstGpuN, n);
    }
    fcInstGpuN = n;
    // 形
    const m = fcShapeBuf.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, fcVbo);
    if (full || m > fcShapeCap) {
      fcShapeCap = full ? Math.max(1024, m + 8192) : Math.max(m + 8192, Math.ceil(fcShapeCap * 1.5));
      gl.bufferData(gl.ARRAY_BUFFER, fcShapeCap * 4, gl.DYNAMIC_DRAW);
      if (m) gl.bufferSubData(gl.ARRAY_BUFFER, 0, fcShapeBuf.view());
    } else if (m > fcShapeGpuN) {
      gl.bufferSubData(gl.ARRAY_BUFFER, fcShapeGpuN * 4, fcShapeBuf.a.subarray(fcShapeGpuN, m));
    }
    fcShapeGpuN = m;
    // ステップ53: ブロックの角の場所(形と同じ数の頂点)
    const mo = fcShapeOrig.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, fcShapeOrigVbo);
    if (full || mo > fcShapeOrigCap) {
      fcShapeOrigCap = full ? Math.max(1024, mo + 3072) : Math.max(mo + 3072, Math.ceil(fcShapeOrigCap * 1.5));
      gl.bufferData(gl.ARRAY_BUFFER, fcShapeOrigCap * 4, gl.DYNAMIC_DRAW);
      if (mo) gl.bufferSubData(gl.ARRAY_BUFFER, 0, fcShapeOrig.view());
    } else if (mo > fcShapeOrigGpuN) {
      gl.bufferSubData(gl.ARRAY_BUFFER, fcShapeOrigGpuN * 4, fcShapeOrig.a.subarray(fcShapeOrigGpuN, mo));
    }
    fcShapeOrigGpuN = mo;
  }
  if (typeof bdOnTerrainUploaded === 'function') bdOnTerrainUploaded();
}
let fcShapeCap = 0;

// 四角い面の部品を GPU に送る(今つながっている入れ物の a 番から b 番の前まで)。
//   ふつうは部品のまま(1面 = 32バイト)。fcInstExpanded の時は、1面を6つの頂点に広げて送る(その時は頂点の32バイト目が隅の番号)
function _fcInstGpuBytes() { return fcInstExpanded ? FC_INST_BYTES * 6 : FC_INST_BYTES; }
function _fcInstUpload(src, a, b) {
  const gl = fcGl;
  if (b <= a) return;
  if (!fcInstExpanded) { gl.bufferSubData(gl.ARRAY_BUFFER, a * FC_INST_BYTES, src.u8.subarray(a * FC_INST_BYTES, b * FC_INST_BYTES)); return; }
  const STEP = 32768;
  const tmp = new Uint8Array(Math.min(STEP, b - a) * FC_INST_BYTES * 6);
  for (let s = a; s < b; s += STEP) {
    const e = Math.min(b, s + STEP);
    for (let i = s; i < e; i++) {
      const from = src.u8.subarray(i * 32, i * 32 + 32), base = (i - s) * 192;
      for (let k = 0; k < 6; k++) { tmp.set(from, base + k * 32); tmp[base + k * 32 + 31] = k; }
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, s * 192, tmp.subarray(0, (e - s) * 192));
  }
}

// newFaces: 今回新しく分かった面。Int32Array(8個ずつ) か、前の形の配列([[x,y,z,dirCode,paletteIdx,scale,revealTick,hideTick?],...])
// newPalette: 現時点での完全なパレット配列(毎回全体を受け取る想定)
function appendFreecamStreamFaces(newFaces, newPalette) {
  if (newPalette) fcMeshPalette = newPalette;
  if (!newFaces || !newFaces.length) return;
  if (newFaces instanceof Int32Array) {
    if (!worldOriginSet) setWorldOrigin(newFaces[0], newFaces[1], newFaces[2]);
    fcMeshFaces.pushRaw(newFaces);
  } else {
    if (!worldOriginSet) setWorldOrigin(newFaces[0][0], newFaces[0][1], newFaces[0][2]);
    for (const f of newFaces) fcMeshFaces.push(f);
  }
  _fcBuildFrom(fcBuiltN);
  _uploadFreecamVertexData(false);
}

// 場所を1つの数にする(x・z は ±52万、y は ±2048 まで)
function _fcPosKey(x, y, z) { return ((x + 524288) * 1048576 + (z + 524288)) * 4096 + (y + 2048); }

// 撤回。retractedPositions: [[x,y,z],...](その位置の全方向を消す。eP編集用)
// retractedFaces: [[x,y,z,dirCode],...](その面だけを消す。チャンク境界の暫定面の訂正用)
// ステップ50: 前は消すたびに地形を全部作り直していた(大きいワールドで1秒以上止まる)。
//   今は、その面に「消した」印を付けて、描く物の時刻だけを書きかえる(作り直さない)
function retractFreecamFaces(retractedPositions, retractedFaces) {
  const hasPositions = retractedPositions && retractedPositions.length;
  const hasFaces = retractedFaces && retractedFaces.length;
  if (!hasPositions && !hasFaces) return;
  const posSet = new Set(), faceMap = new Map();
  if (hasPositions) for (const p of retractedPositions) posSet.add(_fcPosKey(p[0], p[1], p[2]));
  if (hasFaces) for (const f of retractedFaces) { const k = _fcPosKey(f[0], f[1], f[2]); faceMap.set(k, (faceMap.get(k) || 0) | (1 << f[3])); }
  const FS = fcMeshFaces, D = FS.d, n = FS.length;
  const surv = new Map();      // 場所 -> そこに残る面の番号(草花などの形を、その面に引きつぐため)
  const shapeKilled = [];      // [面の番号, 場所]
  for (let i = 0; i < n; i++) {
    const o = i * 8, dir = D[o + 3];
    if (dir < 0) continue;
    const k = _fcPosKey(D[o], D[o + 1], D[o + 2]);
    let kill = false, viaPos = false;
    if (posSet.has(k)) { kill = true; viaPos = true; }
    else {
      const m = faceMap.get(k);
      if (m === undefined) continue;
      if (m & (1 << dir)) kill = true;
      else if (!surv.has(k)) surv.set(k, i);
    }
    if (!kill) continue;
    D[o + 3] = -1; FS.dead++; FS.ver++;
    if (i >= fcBuiltN) continue;
    if (fcFaceKind[i] === 2 && !viaPos) shapeKilled.push([i, k]);
    else _fcHideFaceForGood(i);
  }
  for (const [i, k] of shapeKilled) {
    const j = surv.get(k);
    if (j !== undefined && j < fcBuiltN && fcFaceKind[j] === 0 && D[j * 8 + 6] === D[i * 8 + 6] && D[j * 8 + 7] === D[i * 8 + 7]) {
      fcFaceKind[j] = 2; fcFaceRef[j] = fcFaceRef[i]; fcFaceCnt[j] = fcFaceCnt[i]; fcFaceKind[i] = 0;
    } else _fcHideFaceForGood(i);
  }
}
function _fcHideFaceForGood(i) {
  if (fcFaceKind[i] === 2) {
    const t = fcFaceTicks(i), o = i * 8, D = fcMeshFaces.d;
    if (t) fcShapeDone.delete(D[o] + ',' + D[o + 1] + ',' + D[o + 2] + ',' + t[0] + ',' + t[1]);
  }
  fcSetFaceTicks(i, 1e9, 0);
  fcFaceKind[i] = 0;
}

// ステップ50: 面1つの「出る・消える時刻」を読む・書く(建築で、その場所のリプレイのブロックを消すのに使う。build.js)
function fcFaceDrawn(i) { return i < fcBuiltN && fcFaceKind[i] !== 0; }
function fcFaceTicks(i) {
  const k = fcFaceKind[i], r = fcFaceRef[i];
  if (k === 1) return [fcInstBuf.f[r * 8 + 5], fcInstBuf.f[r * 8 + 6]];
  if (k === 2) return [fcShapeBuf.a[r * 8 + 6], fcShapeBuf.a[r * 8 + 7]];
  return null;
}
function fcSetFaceTicks(i, rv, hd) {
  const k = fcFaceKind[i], r = fcFaceRef[i], gl = fcGl;
  if (k === 1) {
    const f = fcInstBuf.f; f[r * 8 + 5] = rv; f[r * 8 + 6] = hd;
    if (gl && r < fcInstGpuN) {
      gl.bindBuffer(gl.ARRAY_BUFFER, fcInstVbo);
      const t = f.subarray(r * 8 + 5, r * 8 + 7);
      if (!fcInstExpanded) gl.bufferSubData(gl.ARRAY_BUFFER, r * FC_INST_BYTES + 20, t);
      else for (let k = 0; k < 6; k++) gl.bufferSubData(gl.ARRAY_BUFFER, r * 192 + k * 32 + 20, t);
    }
  } else if (k === 2) {
    const a = fcShapeBuf.a, n = fcFaceCnt[i];
    for (let v = 0; v < n; v++) { a[(r + v) * 8 + 6] = rv; a[(r + v) * 8 + 7] = hd; }
    if (gl && (r + n) * 8 <= fcShapeGpuN) { gl.bindBuffer(gl.ARRAY_BUFFER, fcVbo); gl.bufferSubData(gl.ARRAY_BUFFER, r * 8 * 4, a.subarray(r * 8, (r + n) * 8)); }
  }
}
// ステップ50c: 書きかえを貯めて、まとめて GPU に送る(1面ずつ送ると、地面に埋まった大きい建築で止まっていた)
let _fcDirtyInst = [], _fcDirtyShape = [];
function fcSetFaceTicksLazy(i, rv, hd) {
  const k = fcFaceKind[i], r = fcFaceRef[i];
  if (k === 1) {
    const f = fcInstBuf.f;
    if (f[r * 8 + 5] === rv && f[r * 8 + 6] === hd) return;
    f[r * 8 + 5] = rv; f[r * 8 + 6] = hd;
    if (r < fcInstGpuN) _fcDirtyInst.push(r);
  } else if (k === 2) {
    const a = fcShapeBuf.a, n = fcFaceCnt[i];
    if (a[r * 8 + 6] === rv && a[r * 8 + 7] === hd) return;
    for (let v = 0; v < n; v++) { a[(r + v) * 8 + 6] = rv; a[(r + v) * 8 + 7] = hd; }
    if ((r + n) * 8 <= fcShapeGpuN) _fcDirtyShape.push(r, n);
  }
}
// 近くの番号をつないだ区間ごとに送る(間が gap 以下ならつなぐ)
function _fcRuns(list, gap) {
  list.sort((a, b) => a - b);
  const runs = [];
  let s = list[0], e = list[0];
  for (let q = 1; q < list.length; q++) {
    const v = list[q];
    if (v <= e + gap) { if (v > e) e = v; }
    else { runs.push(s, e); s = e = v; }
  }
  runs.push(s, e);
  return runs;
}
function fcFlushFaceTicks() {
  const gl = fcGl;
  if (!gl) { _fcDirtyInst = []; _fcDirtyShape = []; return; }
  if (_fcDirtyInst.length) {
    gl.bindBuffer(gl.ARRAY_BUFFER, fcInstVbo);
    const runs = _fcRuns(_fcDirtyInst, 64);
    for (let q = 0; q < runs.length; q += 2) _fcInstUpload(fcInstBuf, runs[q], runs[q + 1] + 1);
    _fcDirtyInst = [];
  }
  if (_fcDirtyShape.length) {
    gl.bindBuffer(gl.ARRAY_BUFFER, fcVbo);
    const starts = [], ends = new Map();
    for (let q = 0; q < _fcDirtyShape.length; q += 2) { const st = _fcDirtyShape[q], e = st + _fcDirtyShape[q + 1] - 1; starts.push(st, e); }
    const runs = _fcRuns(starts, 256);
    for (let q = 0; q < runs.length; q += 2) {
      const a0 = runs[q] * 8, a1 = (runs[q + 1] + 1) * 8;
      gl.bufferSubData(gl.ARRAY_BUFFER, a0 * 4, fcShapeBuf.a.subarray(a0, a1));
    }
    _fcDirtyShape = [];
  }
}

// ステップ50c: チャンク(32マス)ごとの面の番号の一覧(建築で消す所をさがす時に、全部の面を見なくてすむように)
function fcChunkKeyOf(x, y, z) { return ((Math.floor(x / 32) + 32768) * 65536 + (Math.floor(z / 32) + 32768)) * 256 + (Math.floor(y / 32) + 128); }
let _fcChunkIdx = new Map(), _fcChunkIdxN = 0, _fcChunkIdxGen = -1;
function fcFacesInChunk(ck) {
  if (_fcChunkIdxGen !== fcTerrainGen || _fcChunkIdxN > fcMeshFaces.length) { _fcChunkIdx = new Map(); _fcChunkIdxN = 0; _fcChunkIdxGen = fcTerrainGen; }
  const D = fcMeshFaces.d, n = fcMeshFaces.length;
  for (let i = _fcChunkIdxN; i < n; i++) {
    const o = i * 8, k = fcChunkKeyOf(D[o], D[o + 1], D[o + 2]);
    const l = _fcChunkIdx.get(k);
    if (l) l.push(i); else _fcChunkIdx.set(k, [i]);
  }
  _fcChunkIdxN = n;
  return _fcChunkIdx.get(ck);
}

// 面1つを、時刻だけ変えて「別の入れ物」(建築で2つに分かれた残りの区間)に写す
function fcCopyFaceWithTicks(i, rv, hd, extraInst, extraShape) {
  const k = fcFaceKind[i], r = fcFaceRef[i];
  if (k === 1) extraInst.copyFrom(fcInstBuf, r, rv, hd);
  else if (k === 2) {
    const a = fcShapeBuf.a, n = fcFaceCnt[i];
    if (!extraShape.orig) extraShape.orig = new GrowF32(3 * 64);
    const O = fcShapeOrig.a;
    for (let v = 0; v < n; v++) { const b = (r + v) * 8; extraShape.push(a[b], a[b + 1], a[b + 2], a[b + 3], a[b + 4], a[b + 5], rv, hd); extraShape.orig.push(O[(r + v) * 3], O[(r + v) * 3 + 1], O[(r + v) * 3 + 2]); }
  }
}
let fcExtraInstVbo = null, fcExtraInstN = 0, fcExtraOrigVbo = null;
function fcSetExtraFaces(extraInst, extraShape) {
  const gl = fcGl;
  if (!gl) return;
  if (!fcExtraVbo) fcExtraVbo = gl.createBuffer();
  if (!fcExtraInstVbo) fcExtraInstVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fcExtraVbo);
  gl.bufferData(gl.ARRAY_BUFFER, extraShape.view(), gl.DYNAMIC_DRAW);
  fcExtraCount = extraShape.length / FC_VERTEX_FLOATS;
  if (!fcExtraOrigVbo) fcExtraOrigVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fcExtraOrigVbo);
  gl.bufferData(gl.ARRAY_BUFFER, extraShape.orig ? extraShape.orig.view() : new Float32Array(3 * Math.max(1, fcExtraCount)), gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, fcExtraInstVbo);
  gl.bufferData(gl.ARRAY_BUFFER, Math.max(1, extraInst.n) * _fcInstGpuBytes(), gl.DYNAMIC_DRAW);
  _fcInstUpload(extraInst, 0, extraInst.n);
  fcExtraInstN = extraInst.n;
}
let fcExtraVbo = null, fcExtraCount = 0;   // ステップ49b: 消す区間で2つに分かれた形の、残りの区間の頂点

// ステップ50: 四角い面を描く仕組みの準備(initFreecamGL から)
let fcInstExt = null, fcInstExpanded = false;
function _fcMakeInstProgram() {
  const gl = fcGl;
  const vs = fcCompileShader(gl.VERTEX_SHADER, FC_INST_VERTEX_SHADER_SRC.replace('__MODVERTEX__', fcModVertexSource()));
  const fs = fcCompileShader(gl.FRAGMENT_SHADER, FC_FRAGMENT_SHADER_SRC);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aCorner');
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('シェーダープログラムのリンクに失敗しました: ' + gl.getProgramInfoLog(p));
  if (fcInstProgram) gl.deleteProgram(fcInstProgram);
  fcInstProgram = p;
  fcInstLoc = {
    corner: gl.getAttribLocation(p, 'aCorner'), pos: gl.getAttribLocation(p, 'aIPos'), rect: gl.getAttribLocation(p, 'aIRect'),
    ticks: gl.getAttribLocation(p, 'aITicks'), meta: gl.getAttribLocation(p, 'aIMeta'),
    view: gl.getUniformLocation(p, 'uView'), proj: gl.getUniformLocation(p, 'uProj'), tick: gl.getUniformLocation(p, 'uCurrentTick'),
    tex: gl.getUniformLocation(p, 'uTexture'), off: gl.getUniformLocation(p, 'uOff[0]'), cuv: gl.getUniformLocation(p, 'uCUV[0]'),
    ao: gl.getUniformLocation(p, 'uAO'), mod: fcModVertexLocs(gl, p),
  };
  _fcSetCornerTables();
}
function _fcInitInstanced(fs) {
  const gl = fcGl;
  fcInstExt = gl.getExtension('ANGLE_instanced_arrays');
  // GPU の無いパソコン(ソフトウェアで描く SwiftShader)では、部品のまま描くととても遅いので、6頂点に広げて描く
  let soft = false;
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    soft = /swiftshader|llvmpipe|software/i.test(r);
  } catch (e) { /* わからなければ部品のまま */ }
  let force = null;
  try { force = localStorage.getItem('bloxdEditor.terrainDraw'); } catch (e) { /* なし */ }
  fcInstExpanded = !fcInstExt || (force ? force === 'expand' : soft);
  _fcMakeInstProgram();
  fcCornerVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fcCornerVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3, 4, 5]), gl.STATIC_DRAW);
  fcInstVbo = gl.createBuffer();
  fcInstCap = 0; fcInstGpuN = 0; fcShapeCap = 0; fcShapeGpuN = 0;
  // ステップ50b: 部品のまま描けるか、小さな絵に1面だけ描いて確かめる(描けなければ6頂点に広げる)
  if (!fcInstExpanded) {
    let ok = false;
    try { ok = _fcInstSelfTest(); } catch (e) { console.warn('[地形] 描き方のテストに失敗しました:', e); }
    if (!ok) { fcInstExpanded = true; console.warn('[地形] この端末では部品のまま描けないので、6頂点に広げて描きます'); }
  }
  console.info('[地形] 描き方:', fcInstExpanded ? '6頂点に広げる' : '部品(instanced)');
}

function _fcInstSelfTest() {
  const gl = fcGl, S = 8;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const white = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, white);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const done = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.deleteTexture(white); gl.deleteBuffer(buf);
  };
  // 1面(+z の面)。画面の真ん中を覆う
  const ib = new InstBuf(1);
  ib.add(-0.5, -0.5, -0.5, [0, 0, 1, 1], 0, 1e9, 4, 1, 0);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, ib.bytes(), gl.STATIC_DRAW);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { done(); return true; }   // 確かめられない時は部品のまま
  gl.viewport(0, 0, S, S);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const L = fcInstLoc, ext = fcInstExt;
  gl.useProgram(fcInstProgram);
  gl.uniformMatrix4fv(L.proj, false, I); gl.uniformMatrix4fv(L.view, false, I);
  gl.uniform1f(L.tick, 1); gl.uniform1i(L.tex, 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, white);
  gl.bindBuffer(gl.ARRAY_BUFFER, fcCornerVbo);
  gl.enableVertexAttribArray(L.corner);
  gl.vertexAttribPointer(L.corner, 1, gl.FLOAT, false, 4, 0);
  ext.vertexAttribDivisorANGLE(L.corner, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const il = [L.pos, L.rect, L.ticks, L.meta];
  for (const l of il) { gl.enableVertexAttribArray(l); ext.vertexAttribDivisorANGLE(l, 1); }
  gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, FC_INST_BYTES, 0);
  gl.vertexAttribPointer(L.rect, 4, gl.UNSIGNED_SHORT, true, FC_INST_BYTES, 12);
  gl.vertexAttribPointer(L.ticks, 2, gl.FLOAT, false, FC_INST_BYTES, 20);
  gl.vertexAttribPointer(L.meta, 4, gl.UNSIGNED_BYTE, false, FC_INST_BYTES, 28);
  ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, 1);
  for (const l of il) { ext.vertexAttribDivisorANGLE(l, 0); gl.disableVertexAttribArray(l); }
  gl.disableVertexAttribArray(L.corner);
  const px = new Uint8Array(4);
  gl.readPixels(S / 2, S / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.enable(gl.DEPTH_TEST);
  done();
  return px[3] > 0 && px[0] > 100;
}
// 向き(6) × 角(4) の表: 位置のずれ+明るさ、絵の隅(公式の貼り方 / 前の貼り方)
let fcAOEnabled = (() => { try { return localStorage.getItem('bloxdEditor.ao') !== 'off'; } catch (e) { return true; } })();
function fcSetAO(on) {
  fcAOEnabled = !!on;
  try { localStorage.setItem('bloxdEditor.ao', on ? 'on' : 'off'); } catch (e) { /* 覚えられなくても続ける */ }
  if (typeof _bdMeshCache !== 'undefined' && _bdMeshCache.clear) {
    for (const m of _bdMeshCache.values()) for (const k of ['vbo', 'ebuf']) if (m && m[k] && fcGl) { try { fcGl.deleteBuffer(m[k]); } catch (e) { /* 無視 */ } }
    _bdMeshCache.clear();
  }
  if (fcMeshFaces.length) rebuildFreecamVertexData();
}
const FC_AO_VALUES = [1, 0.92, 0.8, 0.5];   // 公式(noa の aoVals = [.92, .8, .5]、ふさがり無し = 1)
function _fcSetCornerTables() {
  const gl = fcGl;
  const cornerUV = FC_MIRROR_X ? [[1, 1], [0, 1], [0, 0], [1, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
  const off = new Float32Array(24 * 4), cuv = new Float32Array(24 * 4);
  for (let d = 0; d < 6; d++) for (let oi = 0; oi < 4; oi++) {
    const o = FACE_OFFSETS[d][oi], j = (d * 4 + oi) * 4;
    off[j] = o[0]; off[j + 1] = o[1]; off[j + 2] = o[2]; off[j + 3] = DIR_FACTOR[d];
    const iu = (typeof offFaceCornerUV === 'function') ? offFaceCornerUV(d, o) : cornerUV[oi];
    cuv[j] = iu[0]; cuv[j + 1] = iu[1]; cuv[j + 2] = cornerUV[oi][0]; cuv[j + 3] = cornerUV[oi][1];
  }
  gl.useProgram(fcInstProgram);
  gl.uniform4fv(fcInstLoc.off, off);
  gl.uniform4fv(fcInstLoc.cuv, cuv);
  gl.uniform4fv(fcInstLoc.ao, new Float32Array(FC_AO_VALUES));
}


// ============================================================
// カメラの数学(透視投影+視点行列。ライブラリを使わず自前で書いている)
// ============================================================

function fcVecSub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function fcVecCross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function fcVecDot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function fcVecNormalize(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

// ステップ41: 公式(Babylon.js)は左手系なので、同じ座標でもエディタ(右手系)とは左右が反対に見えていた。
//   画面の横だけを反対にして、公式と同じ見え方にする(座標のデータはそのまま)
const FC_MIRROR_X = true;
function fcMat4Perspective(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    (FC_MIRROR_X ? -f : f) / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function fcMat4LookAt(eye, center, upVec) {
  const zAxis = fcVecNormalize(fcVecSub(eye, center));
  const xAxis = fcVecNormalize(fcVecCross(upVec, zAxis));
  const yAxis = fcVecCross(zAxis, xAxis);
  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -fcVecDot(xAxis, eye), -fcVecDot(yAxis, eye), -fcVecDot(zAxis, eye), 1,
  ]);
}

// yaw/pitchから前方向・右方向・上方向を求める(Y-up、標準的なFPSカメラの式)
function fcGetCameraVectors(yaw, pitch) {
  const forward = fcVecNormalize([
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ]);
  const worldUp = [0, 1, 0];
  const r0 = fcVecNormalize(fcVecCross(forward, worldUp));
  const up = fcVecCross(r0, forward);
  // 画面の右(左右を反対に映しているので、右手系の右の反対)
  const right = FC_MIRROR_X ? [-r0[0], -r0[1], -r0[2]] : r0;
  return { forward, right, up };
}


// ============================================================
// シーンエディタ: 画面の状態
// ============================================================
// 主画面は「編集用の視点」か「タイムラインの今の位置のプレビュー」の
// どちらか。もう片方は右下の小窓(PinP)に出る(previewIsMainで切り替え)。
let previewIsMain = false;
let dragState = null;          // ギズモをドラッグ中の情報
const PINP_W = 256, PINP_H = 144, PINP_MARGIN = 16;   // ステップ48: 右上・16:9

// 視点操作
let navLook = false;           // マウスを押したまま動かして見回している最中
let pendingLook = null;        // 何も無い所を左ボタンで押した直後(動かせば見回し、動かさず離せば選択解除)
const LOOK_DRAG_THRESHOLD_PX = 4;
let navPan = false;            // 中ボタンで平行移動している最中
let mouseOverViewport = false;
let _fcSpeedShownUntil = 0;   // ステップ44: 速さを変えた時だけ左上に出す
let fcMoveSpeed = 12;          // 移動速度(ブロック/秒)。見回している最中のホイールで変える
const FC_MIN_SPEED = 1, FC_MAX_SPEED = 200;

// カメラ視点モード(選択したカメラの目線に入って構図を直す)
// { camId, saved:{pos,yaw,pitch,fov}, dirty }
//   dirty=false の間は、毎フレームそのカメラの(再生ヘッド時刻の)構図に追従する。
//   自分で動かすと dirty=true になり、Kで記録するまでその構図を保つ。
let pilot = null;

// Space/Shiftを「上昇/下降」として扱う状態か(それ以外ではSpace=再生)
function isFlightControlActive() { return navLook; }

function currentViewPose() { return { pos: fcPos.slice(), yaw: fcYaw, pitch: fcPitch }; }

// 現在のfcPos/fcYaw/fcPitch/fcFovDegから、編集視点のview/proj行列を作る
function _fcEditViewProj() {
  const aspect = fcCanvas.width / Math.max(1, fcCanvas.height);
  const proj = fcMat4Perspective(fcFovDeg * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const center = [fcPos[0] + forward[0], fcPos[1] + forward[1], fcPos[2] + forward[2]];
  return { view: fcMat4LookAt(fcPos, center, [0, 1, 0]), proj };
}

// 配置済みカメラの、指定tickにおける view/proj 行列
// ステップ55: コマの間(0〜1)。書き出しで 60コマ/秒 などにする時だけ 0 以外になる(export.js)。
//   カメラ・人やモブの位置・影MOD の時刻・文字の動きが、次の記録との間をつなぐ
let fcSubTick = 0;
function _camViewProj(cam, aspect, tick) {
  const pose = scPoseAtTick(cam, tick + fcSubTick);
  const proj = fcMat4Perspective(cam.fov * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(pose.yaw, pose.pitch);
  const center = [pose.pos[0] + forward[0], pose.pos[1] + forward[1], pose.pos[2] + forward[2]];
  return { view: fcMat4LookAt(pose.pos, center, [0, 1, 0]), proj };
}

function _fcCurTickVal() {
  if (timeline && timeline.frames.length && timeline.frames[curTick]) return timeline.frames[curTick].tick;
  return 0;
}

function _outputAspect() { return (typeof getOutputAspect === 'function') ? getOutputAspect() : 16 / 9; }

// 矩形の中に、指定した縦横比の枠をいっぱいに収める(余白は上下 or 左右)
function fitAspectRect(x, y, w, h, aspect) {
  let fw = w, fh = w / aspect;
  if (fh > h) { fh = h; fw = h * aspect; }
  return [x + (w - fw) / 2, y + (h - fh) / 2, fw, fh];
}

// プレビューを描く枠(WebGL座標=左下原点)。書き出す動画と同じ縦横比にしてある
// ので、プレビューで見えている範囲がそのまま書き出される範囲になる。
function previewRectGL(isMain) {
  const W = fcCanvas.width, H = fcCanvas.height;
  const base = isMain ? [0, 0, W, H] : [W - PINP_W - PINP_MARGIN, H - PINP_H - PINP_MARGIN, PINP_W, PINP_H];
  return fitAspectRect(base[0], base[1], base[2], base[3], _outputAspect());
}
// 同じ枠をCSS座標(左上原点)で返す(テキストの配置レイヤーを重ねる時に使う)
function previewRectCSS(isMain) {
  const [x, y, w, h] = previewRectGL(isMain);
  return { left: x, top: fcCanvas.height - (y + h), width: w, height: h };
}

// 同じ時刻に複数のカメラがある時は、奥の層を全面、手前の層を小窓で重ねる
function computeSubRects(vx, vy, vw, vh, n) {
  if (n <= 1) return [[vx, vy, vw, vh]];
  const rects = [[vx, vy, vw, vh]];
  const insetCount = n - 1;
  const insetW = Math.max(24, Math.min(vw * 0.32, (vw - (insetCount + 1) * 6) / insetCount));
  const insetH = insetW * (vh / vw);
  for (let i = 0; i < insetCount; i++) {
    const ix = vx + vw - (insetCount - i) * (insetW + 6);
    const iy = vy + vh - insetH - 6;
    rects.push([ix, iy, insetW, insetH]);
  }
  return rects;
}

function renderPreviewComposite(gl, isMain, tick) {
  if (typeof _poseDrawingPreview !== 'undefined') _poseDrawingPreview = true; // プレビューには選択の色を出さない
  try { _renderPreviewCompositeInner(gl, isMain, tick); }
  finally { if (typeof _poseDrawingPreview !== 'undefined') _poseDrawingPreview = false; }
}

function _renderPreviewCompositeInner(gl, isMain, tick) {
  const W = fcCanvas.width, H = fcCanvas.height;
  const base = isMain ? [0, 0, W, H] : [W - PINP_W - PINP_MARGIN, H - PINP_H - PINP_MARGIN, PINP_W, PINP_H];
  const [vx, vy, vw, vh] = previewRectGL(isMain);
  gl.enable(gl.SCISSOR_TEST);
  // 縦横比を合わせた余白(黒帯)
  gl.scissor(base[0], base[1], base[2], base[3]);
  gl.clearColor(0.02, 0.02, 0.03, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const active = scActiveCamerasAtTick(tick);
  if (active.length === 0) {
    // 表示するカメラが無い区間は、空であることが分かるように暗く塗っておく
    gl.scissor(vx, vy, vw, vh);
    gl.clearColor(0.07, 0.07, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    return;
  }
  // 表示位置が「自動」のカメラは、奥から順に 全画面→右上の小窓… と並べる。
  // 表示位置を決めたカメラ(cam.display)は、その位置・大きさで描く。
  const autoRects = computeSubRects(vx, vy, vw, vh, active.filter(c => !c.display).length);
  let autoIndex = 0;
  active.forEach((cam) => {
    let rx, ry, rw, rh;
    if (cam.display) {
      const d = scClampDisplay(cam.display);
      rw = d.w * vw; rh = d.w * vh;
      rx = vx + d.x * vw;
      ry = vy + vh - (d.y * vh + rh); // WebGLのyは下から
    } else {
      [rx, ry, rw, rh] = autoRects[autoIndex++];
    }
    // 1つのカメラを (x,y,w,h) に描く。切り替えの演出(transitions.js)は、前のカメラもこれで描く
    const drawCam = (c, poseTick, x, y, w, h) => {
      const { view, proj } = _camViewProj(c, w / h, poseTick);
      gl.scissor(x, y, w, h);
      gl.clearColor(0.4, 0.63, 0.9, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      fcDrawSceneMod(view, proj, x, y, w, h, tick);
    };
    if (typeof trRenderCameraRect === 'function') trRenderCameraRect(gl, cam, tick, [rx, ry, rw, rh], drawCam);
    else drawCam(cam, tick, rx, ry, rw, rh);
  });
  gl.disable(gl.SCISSOR_TEST);
}


// ============================================================
// カメラの操作(キーボード・素材一覧・右パネルから呼ばれる)
// ============================================================

function ensureEditView() { previewIsMain = false; }

// 選んでいるパーティクルのギズモの姿勢(無ければ null)
function _particleGizmoPose() { return (typeof pfGizmoPose === 'function') ? pfGizmoPose() : null; }

// F: 今見えている構図で、再生ヘッドの位置に新しいカメラを置く
function actionNewCamera() {
  if (!fcActive) return;
  addCameraAt(curTick, [{ time: 0, ...currentViewPose() }], {});
}

// カメラを追加する共通処理(F と 素材一覧 の両方から使う)。
// keys: [{time, pos, yaw, pitch}](time はブロック先頭からの秒数)
// opts: { seconds(長さ), name, toast }
function addCameraAt(tick, keys, opts) {
  opts = opts || {};
  if (pilot) exitPilot(false); // カメラ視点の構図のまま、新しいカメラにする
  pushUndo();
  const cam = scCreateCamera(keys[0], opts.fov || fcFovDeg, tick, opts.seconds);
  if (keys.length > 1) cam.keys = keys.map(_cloneKey);
  if (opts.name) cam.name = opts.name + ' ' + cam.id;
  selectCamera(cam.id, 0, false);
  showToast(opts.toast || `📷 ${scCamName(cam)}を置きました`);
  return cam;
}

// 選択中のカメラ(の再生ヘッド時刻の位置)が見える所へ、編集視点を動かす
function lookAtCameraFromOutside(cam) {
  if (!cam) return;
  if (pilot) exitPilot(false);
  previewIsMain = false;
  const pose = scPoseAtTick(cam, curTick);
  const { forward } = fcGetCameraVectors(pose.yaw, 0);
  fcPos = [pose.pos[0] - forward[0] * 7, pose.pos[1] + 3, pose.pos[2] - forward[2] * 7];
  const d = [pose.pos[0] - fcPos[0], pose.pos[1] - fcPos[1], pose.pos[2] - fcPos[2]];
  fcYaw = Math.atan2(d[0], d[2]);
  fcPitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
}

// Kを押した時に何が起きるか(ボタンのヒントと実際の動作で同じ判定を使う)
function planRecordKey(cam) {
  const s = scCamLocalSeconds(cam, curTick);
  // カメラ視点で静的ショットを直している時は、唯一のキーを更新する
  if (pilot && pilot.camId === cam.id && scCamIsStatic(cam)) return { mode: 'update', index: 0, s };
  const idx = cam.keys.findIndex(k => Math.abs(k.time - s) <= KEY_SNAP_SECONDS);
  if (idx >= 0) return { mode: 'update', index: idx, s };
  return { mode: 'add', s, convert: scCamIsStatic(cam) };
}

// K: 今見えている構図を、選択中カメラの「再生ヘッドの時刻」のキーとして記録する
function actionRecordKey() {
  const cam = scGetSelected();
  if (!cam) { actionNewCamera(); return; }
  ensureEditView();
  const plan = planRecordKey(cam);
  pushUndo();
  if (pilot && pilot.camId === cam.id) cam.fov = fcFovDeg;
  let index;
  if (plan.mode === 'update') {
    const k = cam.keys[plan.index];
    const p = currentViewPose();
    k.pos = p.pos; k.yaw = p.yaw; k.pitch = p.pitch;
    index = plan.index;
  } else {
    index = scSetKeyAt(cam, plan.s, currentViewPose()).index;
  }
  if (pilot) pilot.dirty = false;
  selectCamera(cam.id, index, true);
  if (plan.mode === 'update') showToast(`◆ ${scCamName(cam)}のポイント${index + 1}を今の構図に更新しました`);
  else if (plan.convert) showToast(`◆ ${plan.s.toFixed(1)}秒にキーを記録 — 動くショットになりました`);
  else showToast(`◆ ${plan.s.toFixed(1)}秒にキーを記録しました`);
}


// ============================================================
// カメラ視点モード(V)
// ============================================================

function togglePilot() { if (pilot) exitPilot(true); else enterPilot(); }

function enterPilot() {
  const cam = scGetSelected();
  if (!cam) { showToast('先にカメラを選んでください(画面の箱 or タイムラインのブロックをクリック)'); return; }
  previewIsMain = false;
  pilot = { camId: cam.id, saved: { pos: fcPos.slice(), yaw: fcYaw, pitch: fcPitch, fov: fcFovDeg }, dirty: false };
  syncPilotToCamera();
  editorChanged();
  showToast(`🎥 ${scCamName(cam)}の視点に入りました`);
}

function syncPilotToCamera() {
  const cam = scGetCamera(pilot.camId);
  if (!cam) { exitPilot(true); return; }
  const pose = scPoseAtTick(cam, curTick);
  fcPos = pose.pos.slice(); fcYaw = pose.yaw; fcPitch = pose.pitch;
  if (fcFovDeg !== cam.fov) { fcFovDeg = cam.fov; syncFovSliderUI(); }
}

function exitPilot(restoreView) {
  if (!pilot) return;
  const wasDirty = pilot.dirty;
  if (restoreView) {
    fcPos = pilot.saved.pos; fcYaw = pilot.saved.yaw; fcPitch = pilot.saved.pitch; fcFovDeg = pilot.saved.fov;
    syncFovSliderUI();
  }
  pilot = null;
  editorChanged();
  if (restoreView && wasDirty) showToast('記録していない構図の変更は破棄しました(Kで記録できます)');
}

// 視点を自分で動かした時に呼ぶ
function markViewMoved() {
  if (pilot) pilot.dirty = true;
  previewIsMain = false; // 動かしたら編集視点に戻す(プレビューは右下の小窓へ)
}

function syncFovSliderUI() {
  const s = document.getElementById('fovSlider'), v = document.getElementById('fovValue');
  if (s) s.value = Math.round(fcFovDeg);
  if (v) v.innerText = Math.round(fcFovDeg) + '°';
}


// ============================================================
// 移動・回転ギズモのドラッグ(キー1個ぶんの位置・向きを直接いじる)
// ============================================================

// point: ギズモの位置(再生ヘッドの時刻の姿勢のコピー)。
// whole=false(ふつう): 再生ヘッドの時刻のポイントを動かす。その時刻にポイントが
//   無ければ、実際に動かし始めた時に自動で作る(右パネルの数値編集と同じ考え方)。
// whole=true(Shift+ドラッグ): カメラ全体(全ポイント)をまとめて動かす・回す。
// particleId を渡すと、カメラではなくパーティクルの位置・向きを動かす
function beginGizmoDrag(part, point, mx, my, whole, particleId) {
  const cam = particleId ? null : scGetSelected();
  if (!cam && !particleId) return;
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  point = _clonePose(point);
  dragState = {
    part, point, camId: cam ? cam.id : null, particleId: particleId || null,
    whole: !!whole && !particleId, pending: true, startMouse: [mx, my],
    startPos: point.pos.slice(), startYaw: point.yaw, startPitch: point.pitch,
    startKeys: cam ? cam.keys.map(k => _clonePose(k)) : [],
  };
  if (part.kind === 'axis') {
    dragState.axisDir = _axisVec(part.axis);
    dragState.startT = scClosestTOnLine(ray, point.pos, dragState.axisDir);
  } else if (part.kind === 'plane') {
    dragState.planeHit0 = scRayPlaneIntersect(ray, point.pos, [0, 1, 0]);
  } else if (part.kind === 'ring' && part.ring === 'yaw') {
    const hit = scRayPlaneIntersect(ray, point.pos, [0, 1, 0]);
    dragState.angle0 = hit ? Math.atan2(hit[0] - point.pos[0], hit[2] - point.pos[2]) : 0;
  } else if (part.kind === 'ring' && part.ring === 'pitch') {
    const { forward, right } = fcGetCameraVectors(point.yaw, 0);
    dragState.ringNormal = right;
    dragState.forwardAxis = forward;
    const hit = scRayPlaneIntersect(ray, point.pos, right);
    if (hit) {
      const rel = [hit[0]-point.pos[0], hit[1]-point.pos[1], hit[2]-point.pos[2]];
      dragState.angle0 = Math.atan2(rel[1], rel[0]*forward[0] + rel[2]*forward[2]);
    } else {
      dragState.angle0 = 0;
    }
  }
}

// 実際に動き始めた時に、動かす対象(キー)を決める
function _gizmoDragTarget() {
  const d = dragState;
  if (d.particleId) { d.pending = false; return pfGet(d.particleId); }
  const cam = scGetCamera(d.camId);
  if (!cam) return null;
  if (d.pending) {
    d.pending = false;
    if (!d.whole) {
      const r = scEditPoseAtTick(cam, curTick, {});
      d.keyIndex = r.index;
      selectedKeyIndex = r.index; selectedKeyExplicit = true;
      if (r.created) {
        if (typeof timelineRenderBlocks === 'function') timelineRenderBlocks();
        showToast(`◆ ${r.seconds.toFixed(1)}秒にポイントを自動で作りました(Shift+ドラッグでカメラ全体を動かせます)`);
      }
    }
  }
  return cam;
}

// 全体移動: 動かしたぶんを全ポイントに足す。左右の回転は、ギズモの位置を中心に軌道ごと回す
function _applyWholeDelta(cam, point) {
  const d = dragState;
  const dp = [0, 1, 2].map(i => point.pos[i] - d.startPos[i]);
  const dyaw = point.yaw - d.startYaw, dpitch = point.pitch - d.startPitch;
  const c = Math.cos(dyaw), sn = Math.sin(dyaw);
  const limit = Math.PI / 2 - 0.05;
  cam.keys.forEach((k, i) => {
    const o = d.startKeys[i];
    let rx = o.pos[0] - d.startPos[0], rz = o.pos[2] - d.startPos[2];
    if (dyaw) { const nx = rx * c + rz * sn, nz = -rx * sn + rz * c; rx = nx; rz = nz; }
    k.pos = [d.startPos[0] + rx + dp[0], o.pos[1] + dp[1], d.startPos[2] + rz + dp[2]];
    k.yaw = o.yaw + dyaw;
    k.pitch = Math.max(-limit, Math.min(limit, o.pitch + dpitch));
  });
}

function applyGizmoDrag(mx, my) {
  if (!dragState) return;
  if (dragState.pending && Math.hypot(mx - dragState.startMouse[0], my - dragState.startMouse[1]) < 2) return;
  const cam = _gizmoDragTarget();
  if (!cam) { dragState = null; return; }
  const point = dragState.point;
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  const part = dragState.part;

  if (part.kind === 'axis') {
    const t = scClosestTOnLine(ray, dragState.startPos, dragState.axisDir);
    const delta = t - dragState.startT;
    point.pos = dragState.startPos.map((v, i) => v + dragState.axisDir[i] * delta);
  } else if (part.kind === 'plane') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, [0, 1, 0]);
    if (hit && dragState.planeHit0) {
      point.pos = [
        dragState.startPos[0] + (hit[0] - dragState.planeHit0[0]),
        dragState.startPos[1],
        dragState.startPos[2] + (hit[2] - dragState.planeHit0[2]),
      ];
    }
  } else if (part.kind === 'ring' && part.ring === 'yaw') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, [0, 1, 0]);
    if (hit) {
      const angle1 = Math.atan2(hit[0] - dragState.startPos[0], hit[2] - dragState.startPos[2]);
      const delta = Math.atan2(Math.sin(angle1 - dragState.angle0), Math.cos(angle1 - dragState.angle0));
      point.yaw = dragState.startYaw + delta;
    }
  } else if (part.kind === 'ring' && part.ring === 'pitch') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, dragState.ringNormal);
    if (hit) {
      const rel = [hit[0]-dragState.startPos[0], hit[1]-dragState.startPos[1], hit[2]-dragState.startPos[2]];
      const angle1 = Math.atan2(rel[1], rel[0]*dragState.forwardAxis[0] + rel[2]*dragState.forwardAxis[2]);
      const delta = Math.atan2(Math.sin(angle1 - dragState.angle0), Math.cos(angle1 - dragState.angle0));
      const limit = Math.PI / 2 - 0.05;
      // パーティクルは上下の向きに制限なし(カメラは真上・真下で止める)
      point.pitch = dragState.particleId ? Math.atan2(Math.sin(dragState.startPitch + delta), Math.cos(dragState.startPitch + delta))
        : Math.max(-limit, Math.min(limit, dragState.startPitch + delta));
    }
  }
  if (dragState.particleId) {
    cam.pos = point.pos.slice(); cam.yaw = point.yaw; cam.pitch = point.pitch; // cam = 動かしているパーティクル
    return;
  }
  if (dragState.whole) { _applyWholeDelta(cam, point); return; }
  const k = cam.keys[dragState.keyIndex];
  if (k) { k.pos = point.pos.slice(); k.yaw = point.yaw; k.pitch = point.pitch; }
}


// ============================================================
// マウス操作
//   右ドラッグ(またはAlt+左ドラッグ): 見回す。押している間はWASD/QE/Space/Shiftで移動、
//                                      ホイールで移動速度を変える
//   ホイール: 前後に移動 / 中ドラッグ: 平行移動
//   左クリック: カメラの選択・ギズモのドラッグだけ(勝手に飛行モードに入らない)
// ============================================================

let suppressContextMenuUntil = 0; // 右ドラッグを画面の外で離した時に、右クリックメニューを出さない

function setupFreecamControls() {
  fcCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if (navLook || performance.now() < suppressContextMenuUntil) e.preventDefault();
  });
  // 3D画面の上に重なっているボタン類の上にいる時も「3D画面の上」として扱う
  const area = document.getElementById('freecamArea');
  area.addEventListener('mouseenter', () => { mouseOverViewport = true; });
  area.addEventListener('mouseleave', () => { mouseOverViewport = false; gizmoHoverPart = null; });
  fcCanvas.addEventListener('mousedown', onViewportMouseDown);
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
  fcCanvas.addEventListener('wheel', onViewportWheel, { passive: false });
}

function _canvasMouse(e) {
  const rect = fcCanvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function onViewportMouseDown(e) {
  if (!fcActive) return;
  if (e.button === 2) { e.preventDefault(); startLook(); return; }
  if (e.button === 1) { e.preventDefault(); navPan = true; fcCanvas.style.cursor = 'move'; return; }
  if (e.button !== 0) return;
  e.preventDefault();
  fcCanvas.focus({ preventScroll: true }); // 入力欄からフォーカスを外して、キー操作が効くようにする
  // プレビューが主画面の時: 小窓(カメラ)を直接ドラッグして動かす・大きさを変える(pinp.js)
  if (previewIsMain && !pilot && typeof pinpMouseDown === 'function' && pinpMouseDown(e)) return;

  // カメラ視点・プレビュー表示中は、選べる物が無いので、そのまま見回しにする
  if (!previewIsMain && !pilot) {
    const [mx, my] = _canvasMouse(e);
    const { view, proj } = _fcEditViewProj();
    try {
      const active = scGetActivePoint();
      if (active) {
        const part = pickTransformGizmoPart(active, mx, my, view, proj, fcCanvas.width, fcCanvas.height);
        if (part) { beginEdit(); beginGizmoDrag(part, active, mx, my, e.shiftKey); return; }
      }
      const pActive = _particleGizmoPose();
      if (pActive) {
        const part = pickTransformGizmoPart(pActive, mx, my, view, proj, fcCanvas.width, fcCanvas.height);
        if (part) { beginEdit(); beginGizmoDrag(part, pActive, mx, my, false, selectedParticleId); return; }
      }
      // エンティティ(プレイヤー・人形)は1回のクリックで選んで、関節を動かせるようにする
      if (typeof poseMouseDown === 'function' && poseMouseDown(e, mx, my)) return;
      const picked = pickCameraGizmo(mx, my, view, proj, fcCanvas.width, fcCanvas.height, null);
      if (picked) {
        const cam = scGetCamera(picked.camId);
        if (cam && picked.kind === 'key') {
          // ◆: そのポイントの時刻へ再生ヘッドを動かして選ぶ(ギズモはそのポイントに出る)
          if (typeof stopPlayback === 'function') stopPlayback();
          seekTo(scKeyAbsTick(cam, cam.keys[picked.keyIndex]));
          selectCamera(picked.camId, picked.keyIndex, true);
        } else {
          selectCamera(picked.camId, null, false);
        }
        return;
      }
      const pp = (typeof pfPick === 'function') ? pfPick(mx, my, view, proj, fcCanvas.width, fcCanvas.height) : null;
      if (pp) {
        selectParticle(pp.id);
        if (e.detail >= 2) openEditPanel(pp); // ダブルクリックで設定を開く
        return;
      }
    } catch (err) {
      console.error('ギズモの選択処理でエラーが起きました:', err);
    }
  }
  // 何も無い所: 動かせば見回し、動かさずに離せば選択を外す
  pendingLook = { x: e.clientX, y: e.clientY };
}

function startLook() {
  pendingLook = null;
  navLook = true;
  fcCanvas.style.cursor = 'grabbing';
}

function onDocMouseMove(e) {
  if (typeof pinpDrag !== 'undefined' && pinpDrag) { pinpDragMove(e); return; }
  if (typeof poseDrag !== 'undefined' && poseDrag) {
    const [mx, my] = _canvasMouse(e);
    poseDragMove(mx, my);
    return;
  }
  if (dragState) {
    const [mx, my] = _canvasMouse(e);
    applyGizmoDrag(mx, my);
    return;
  }
  if (pendingLook) {
    if (Math.hypot(e.clientX - pendingLook.x, e.clientY - pendingLook.y) < LOOK_DRAG_THRESHOLD_PX) return;
    startLook();
  }
  if (navLook) {
    if (e.movementX || e.movementY) {
      fcYaw += (FC_MIRROR_X ? 1 : -1) * e.movementX * FC_MOUSE_SENSITIVITY;
      fcPitch -= e.movementY * FC_MOUSE_SENSITIVITY;
      const limit = Math.PI / 2 - 0.05;
      fcPitch = Math.max(-limit, Math.min(limit, fcPitch));
      markViewMoved();
    }
    return;
  }
  if (navPan) {
    if (e.movementX || e.movementY) {
      const { right, up } = fcGetCameraVectors(fcYaw, fcPitch);
      const k = 2 * 10 * Math.tan(fcFovDeg * Math.PI / 360) / Math.max(1, fcCanvas.height); // 10ブロック先の1px
      for (let i = 0; i < 3; i++) fcPos[i] += -right[i] * e.movementX * k + up[i] * e.movementY * k;
      markViewMoved();
    }
    return;
  }
  // マウスが乗っているギズモの部分を光らせる
  if (!pilot && previewIsMain && e.target === fcCanvas && typeof pinpHoverAt === 'function') {
    fcCanvas.style.cursor = pinpHoverAt(e) || 'default';
  } else if (typeof pinpHideOutline === 'function' && !(typeof pinpDrag !== 'undefined' && pinpDrag)) pinpHideOutline();
  if (mouseOverViewport && !pilot && !previewIsMain && e.target === fcCanvas) {
    const active = scGetActivePoint() || _particleGizmoPose();
    const hasParticles = typeof particleBlocks !== 'undefined' && particleBlocks.length > 0;
    let hover = null, overCam = false;
    if (active || sceneCameras.length || hasParticles) {
      const [mx, my] = _canvasMouse(e);
      const { view, proj } = _fcEditViewProj();
      if (active) hover = pickTransformGizmoPart(active, mx, my, view, proj, fcCanvas.width, fcCanvas.height);
      if (!hover) overCam = !!pickCameraGizmo(mx, my, view, proj, fcCanvas.width, fcCanvas.height, null)
        || (hasParticles && !!pfPick(mx, my, view, proj, fcCanvas.width, fcCanvas.height));
    }
    gizmoHoverPart = hover;
    let poseCursor = false;
    if (!hover && typeof poseHoverAt === 'function') { const [mx, my] = _canvasMouse(e); poseCursor = poseHoverAt(mx, my); }
    fcCanvas.style.cursor = hover ? 'grab' : (poseCursor || (overCam ? 'pointer' : 'default'));
  }
}

function onDocMouseUp(e) {
  if (e.button === 0 && typeof pinpDrag !== 'undefined' && pinpDrag) { pinpDragEnd(); return; }
  if (e.button === 0 && typeof poseDrag !== 'undefined' && poseDrag) poseDragEnd();
  if (e.button === 0 && dragState) {
    dragState = null;
    commitEdit();
    editorChanged();
  }
  if (e.button === 0 && pendingLook) {
    // 動かさずに離した = 何も無い所をクリックした
    pendingLook = null;
    if (!pilot && !previewIsMain && getSelectedItem()) clearSelection();
  }
  if (navLook && (e.button === 2 || e.button === 0)) {
    navLook = false;
    if (e.button === 2) suppressContextMenuUntil = performance.now() + 400;
  }
  if (e.button === 1) navPan = false;
  if (!navLook && !navPan && fcCanvas) fcCanvas.style.cursor = 'default';
}

function onViewportWheel(e) {
  e.preventDefault();
  if (navLook) {
    // 見回し中のホイール = 移動速度
    fcMoveSpeed = Math.max(FC_MIN_SPEED, Math.min(FC_MAX_SPEED, fcMoveSpeed * (e.deltaY < 0 ? 1.25 : 0.8)));
    _fcSpeedShownUntil = performance.now() + 1500;
    showToast(`移動速度: ${fcMoveSpeed.toFixed(fcMoveSpeed < 10 ? 1 : 0)}`);
    return;
  }
  // 通常のホイール = 前後に移動(トラックパッドの細かいスクロールにも比例させる)
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const amount = -(e.deltaY / 100) * Math.max(0.4, fcMoveSpeed * 0.15);
  for (let i = 0; i < 3; i++) fcPos[i] += forward[i] * amount;
  markViewMoved();
}

// 移動キーが押された時(editor-core.jsから呼ばれる)
function onMovementKeyPressed() { /* 実際の移動は毎フレームの freecamLoop で行う */ }

// ============================================================
// 右下の小窓・画面上の表示
// ============================================================

// 右下の小窓(PinP)をクリックすると、主画面と入れ替わる
function setupPinPInset() {
  const inset = document.getElementById('pinpInset');
  inset.addEventListener('click', () => {
    if (sceneCameras.length === 0) return;
    if (pilot) exitPilot(true);
    previewIsMain = !previewIsMain;
  });
}

// カメラが1つも無い間は小窓自体を出さない(見せるものが無いため)
function updatePinPVisibility() {
  document.getElementById('pinpInset').classList.toggle('show', sceneCameras.length > 0);
}

function currentModeLabel() {
  if (pilot) { const c = scGetCamera(pilot.camId); return `${c ? scCamName(c) : ''}の目線`; }
  if (previewIsMain) return 'できあがり';
  if (navLook) return '見回し中';
  return '自由に見る';
}

// 状況に応じた、画面下の操作ヒント
function currentContextHint() {
  if (navLook) return 'WASD 移動 · Q/E 上下 · ホイール 速さ';
  if (pilot) {
    const cam = scGetCamera(pilot.camId);
    let k = 'K 記録';
    if (cam) {
      const p = planRecordKey(cam);
      k = p.mode === 'update' ? `K ポイント${p.index + 1}を更新` : `K ${p.s.toFixed(1)}秒にキー`;
    }
    return `WASD・ドラッグで構図 · ${k} · V/Esc 戻る`;
  }
  if (previewIsMain) return '書き出される映像 · 視点を動かすと編集に戻る';
  const poseHint = (typeof poseContextHint === 'function') ? poseContextHint() : null;
  if (poseHint) return poseHint;
  const pSel = (typeof pfGetSelected === 'function') ? pfGetSelected() : null;
  if (pSel) {
    return `${pSel.name}: 矢印 移動 · リング 向き · ダブルクリック 設定`;
  }
  const cam = scGetSelected();
  const active = scGetActivePoint();
  if (cam && active && isNearEye(active.pos)) {
    return `${scCamName(cam)}の中にいます · S で下がる · V カメラ視点`;
  }
  if (cam) {
    const p = planRecordKey(cam);
    const k = p.mode === 'update' ? `K ポイント${p.index + 1}を更新` : `K ${p.s.toFixed(1)}秒にキー`;
    return `${scCamName(cam)}: 矢印・リング 動かす · Shift 全体 · ${k} · V カメラ視点`;
  }
  return 'ドラッグ 見回す · WASD 移動 · F カメラを置く';
}

let _lastHint = '', _lastHud = '';
function updateViewportOverlays() {
  const hint = currentContextHint();
  if (hint !== _lastHint) { document.getElementById('contextHint').innerText = hint; _lastHint = hint; }

  const wx = Math.round(fcPos[0] + worldOriginX), wy = Math.round(fcPos[1] + worldOriginY), wz = Math.round(fcPos[2] + worldOriginZ);
  // ステップ44: 左上は今の見え方だけ(速さ・座標は出さない。速さを変えた時だけ少し出す)
  const showSpeed = typeof _fcSpeedShownUntil !== 'undefined' && performance.now() < _fcSpeedShownUntil;
  const hud = currentModeLabel() + (showSpeed ? ` · 速さ ${fcMoveSpeed.toFixed(fcMoveSpeed < 10 ? 1 : 0)}` : '');
  if (hud !== _lastHud) {
    document.getElementById('viewHud').innerHTML = '<svg class="uiIco" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    document.getElementById('viewHud').appendChild(document.createTextNode(hud));
    _lastHud = hud;
  }

  const ch = document.getElementById('freecamCrosshair');
  if (ch) ch.style.display = (navLook || pilot) ? 'block' : 'none';
  if (typeof uiPoseToolbarSync === 'function') uiPoseToolbarSync();

  // カメラ視点モード: 書き出す縦横比の枠+三分割線
  const frame = document.getElementById('pilotFrame');
  if (frame) {
    if (pilot) {
      const [x, y, w, h] = fitAspectRect(0, 0, fcCanvas.width, fcCanvas.height, _outputAspect());
      frame.style.left = x + 'px'; frame.style.top = y + 'px';
      frame.style.width = w + 'px'; frame.style.height = h + 'px';
      frame.classList.add('show');
      const label = document.getElementById('pilotLabel');
      const text = currentModeLabel() + (pilot.dirty ? ' — 未記録の変更あり' : '');
      if (label.innerText !== text) label.innerText = text;
    } else {
      frame.classList.remove('show');
    }
  }
}


// ============================================================
// 描画ループ
// ============================================================

// ステップ52: 場面の中身(地形・人やモブ・パーティクル・置く壊す・建築)。影MOD を使っている時は shader-mod.js を通す
function fcDrawSceneContent(view, proj, x, y, w, h, tick) {
  // ステップ55: 水は半透明。先に透けない物と人・モブなどを描いて、最後に水を重ねる(水の中・向こうが見える)。
  //   影の地図を作る時は、水は描かない(水の下が全部影にならないように)
  const split = fcWaterSeeThrough && fcHasWater;
  drawTerrainWithMatrices(view, proj, x, y, w, h, split ? 1 : 0);
  renderHumanoids(fcGl, view, proj, _fcCurTickVal());
  if (typeof renderParticles === 'function') renderParticles(fcGl, view, proj, tick);
  if (typeof renderBlockFx === 'function') renderBlockFx(fcGl, view, proj, tick);
  if (split && !window._shmodShadowPass) { fcGl.viewport(x, y, w, h); drawTerrainWithMatrices(view, proj, x, y, w, h, 2); }
}
function fcDrawSceneMod(view, proj, x, y, w, h, tick) {
  if (typeof shmodIsOn === 'function' && shmodIsOn()) {
    shmodDrawScene(fcGl, view, proj, x, y, w, h, tick, (v, p, vx, vy, vw, vh) => fcDrawSceneContent(v, p, vx, vy, vw, vh, tick));
  } else fcDrawSceneContent(view, proj, x, y, w, h, tick);
}

function renderFreecam() {
  if (!fcGl) return;
  const hasCamera = sceneCameras.length > 0;
  const editVP = _fcEditViewProj();
  const tick = curTick;
  const W = fcCanvas.width, H = fcCanvas.height;

  fcGl.viewport(0, 0, W, H);
  fcGl.clearColor(0.4, 0.63, 0.9, 1); // 空っぽい水色
  fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);

  if (previewIsMain) {
    renderPreviewComposite(fcGl, true, tick);
  } else {
    fcDrawSceneMod(editVP.view, editVP.proj, 0, 0, W, H, tick);
    fcGl.viewport(0, 0, W, H);
    renderCameraGizmos(fcGl, editVP.view, editVP.proj, W, H, { hideCamId: pilot ? pilot.camId : null });
    if (!pilot && typeof renderParticleGizmos === 'function') renderParticleGizmos(fcGl, editVP.view, editVP.proj, W, H);
    if (!pilot && !navLook && typeof renderPoseGizmos === 'function') renderPoseGizmos(fcGl, editVP.view, editVP.proj, W, H);
    const active = scGetActivePoint() || _particleGizmoPose();
    if (active && !pilot && !navLook) {
      renderTransformGizmo(fcGl, editVP.view, editVP.proj, active, W, H, dragState ? dragState.part : null);
    }
  }

  // 右下の小窓(PinP): 主画面になっていない方を出す。見るだけで操作は不可
  if (hasCamera) {
    if (previewIsMain) {
      const vx = W - PINP_W - PINP_MARGIN, vy = H - PINP_H - PINP_MARGIN;   // ステップ48: 小窓は右上
      fcGl.enable(fcGl.SCISSOR_TEST);
      fcGl.scissor(vx, vy, PINP_W, PINP_H);
      fcGl.clearColor(0.4, 0.63, 0.9, 1);
      fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);
      const aspect = PINP_W / PINP_H;
      const proj = fcMat4Perspective(fcFovDeg * Math.PI / 180, aspect, 0.1, 3000);
      fcDrawSceneMod(editVP.view, proj, vx, vy, PINP_W, PINP_H, tick);
      fcGl.disable(fcGl.SCISSOR_TEST);
    } else {
      renderPreviewComposite(fcGl, false, tick);
    }
  }
  fcGl.viewport(0, 0, W, H);
}

// 地形の描画本体。view/proj行列とビューポート範囲を渡せば、編集視点・
// プレビュー・小窓のどこからでも同じ呼び方で使い回せる。
// ステップ55: phase = 0 全部(前と同じ) / 1 透けない物だけ / 2 水だけ(半透明で重ねる。人やモブを描いた後に呼ぶ)
const FC_WATER_ALPHA = 0.62;
let fcWaterSeeThrough = true;
function drawTerrainWithMatrices(viewMatrix, projMatrix, vx, vy, vw, vh, phase) {
  fcGl.viewport(vx, vy, vw, vh);
  if ((fcVertexCount === 0 && fcInstGpuN === 0) || !fcTexture) return;
  const gl = fcGl;
  phase = phase || 0;
  if (phase === 2 && !fcHasWater) return;
  const blendWas = gl.isEnabled(gl.BLEND);
  if (phase === 2) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); }
  try { _fcDrawTerrainPhase(viewMatrix, projMatrix, phase); }
  finally { if (phase === 2 && !blendWas) gl.disable(gl.BLEND); }
}
function _fcDrawTerrainPhase(viewMatrix, projMatrix, phase) {
  const gl = fcGl;

  let curTickVal = Infinity;
  if (timeline && timeline.frames.length && timeline.frames[curTick]) {
    curTickVal = timeline.frames[curTick].tick;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, fcTexture);

  // 1) 草花・モデルなどの形(三角形)
  if (fcVertexCount || (fcExtraVbo && fcExtraCount)) {
    gl.useProgram(fcProgram);
    gl.uniformMatrix4fv(fcUProjLoc, false, projMatrix);
    gl.uniformMatrix4fv(fcUViewLoc, false, viewMatrix);
    gl.uniform1f(fcUCurrentTickLoc, curTickVal);
    gl.uniform1i(fcUTextureLoc, 0);
    gl.uniform1f(fcShapeLoc.matPass, window._shmodMatPass ? 1 : 0);
    gl.uniform1f(fcShapeLoc.phase, phase);
    gl.uniform1f(fcShapeLoc.alphaMul, phase === 2 ? FC_WATER_ALPHA : 0);
    if (fcModVertex) fcApplyModVertexUniforms(gl, fcShapeLoc);
    const locs = [fcAPosLoc, fcAUVLoc, fcABrightnessLoc, fcARevealTickLoc, fcAHideTickLoc];
    if (fcABlockLoc >= 0) locs.push(fcABlockLoc);
    const bindTri = (buf, obuf) => {
      const stride = FC_VERTEX_FLOATS * 4;
      if (fcABlockLoc >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, obuf);
        gl.enableVertexAttribArray(fcABlockLoc);
        gl.vertexAttribPointer(fcABlockLoc, 3, gl.FLOAT, false, 12, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const l of locs) gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(fcAPosLoc, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(fcAUVLoc, 2, gl.FLOAT, false, stride, 12);
      gl.vertexAttribPointer(fcABrightnessLoc, 1, gl.FLOAT, false, stride, 20);
      gl.vertexAttribPointer(fcARevealTickLoc, 1, gl.FLOAT, false, stride, 24);
      gl.vertexAttribPointer(fcAHideTickLoc, 1, gl.FLOAT, false, stride, 28);
    };
    if (fcVertexCount) { bindTri(fcVbo, fcShapeOrigVbo); gl.drawArrays(gl.TRIANGLES, 0, fcVertexCount); }
    // ステップ49b: 建築で消す区間で分かれた面の残り
    if (fcExtraVbo && fcExtraCount) { bindTri(fcExtraVbo, fcExtraOrigVbo); gl.drawArrays(gl.TRIANGLES, 0, fcExtraCount); }
    for (const l of locs) gl.disableVertexAttribArray(l);
  }

  // 2) 四角いブロックの面(1面 = 部品1つ)
  if (fcInstGpuN || (fcExtraInstVbo && fcExtraInstN)) {
    const L = fcInstLoc, ext = fcInstExt;
    gl.useProgram(fcInstProgram);
    gl.uniformMatrix4fv(L.proj, false, projMatrix);
    gl.uniformMatrix4fv(L.view, false, viewMatrix);
    gl.uniform1f(L.tick, curTickVal);
    gl.uniform1i(L.tex, 0);
    gl.uniform1f(L.mod.matPass, window._shmodMatPass ? 1 : 0);
    gl.uniform1f(L.mod.phase, phase);
    gl.uniform1f(L.mod.alphaMul, phase === 2 ? FC_WATER_ALPHA : 0);
    if (fcModVertex) fcApplyModVertexUniforms(gl, L.mod);
    const il = [L.pos, L.rect, L.ticks, L.meta];
    const exp = fcInstExpanded, dv = exp ? 0 : 1;
    gl.enableVertexAttribArray(L.corner);
    if (!exp) {
      gl.bindBuffer(gl.ARRAY_BUFFER, fcCornerVbo);
      gl.vertexAttribPointer(L.corner, 1, gl.FLOAT, false, 4, 0);
      ext.vertexAttribDivisorANGLE(L.corner, 0);
    }
    const drawInst = (buf, n) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const l of il) { gl.enableVertexAttribArray(l); if (ext) ext.vertexAttribDivisorANGLE(l, dv); }
      gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, FC_INST_BYTES, 0);
      gl.vertexAttribPointer(L.rect, 4, gl.UNSIGNED_SHORT, true, FC_INST_BYTES, 12);
      gl.vertexAttribPointer(L.ticks, 2, gl.FLOAT, false, FC_INST_BYTES, 20);
      gl.vertexAttribPointer(L.meta, 4, gl.UNSIGNED_BYTE, false, FC_INST_BYTES, 28);
      if (exp) {   // 6頂点に広げてある: 隅の番号は頂点の32バイト目
        gl.vertexAttribPointer(L.corner, 1, gl.UNSIGNED_BYTE, false, FC_INST_BYTES, 31);
        gl.drawArrays(gl.TRIANGLES, 0, n * 6);
      } else ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, n);
    };
    if (fcInstGpuN) drawInst(fcInstVbo, fcInstGpuN);
    if (fcExtraInstVbo && fcExtraInstN) drawInst(fcExtraInstVbo, fcExtraInstN);
    // ほかの描く物(人・モブなど)のじゃまにならないように、元に戻す
    for (const l of il) { if (ext) ext.vertexAttribDivisorANGLE(l, 0); gl.disableVertexAttribArray(l); }
    gl.disableVertexAttribArray(L.corner);
  }
}


// 押されている移動キーに応じて視点を動かす
function applyMovementKeys(dt) {
  if (isTypingTarget(document.activeElement) || dragState) return;
  const flight = isFlightControlActive();
  // マウスがタイムライン等の上にある時は動かさない(編集中にうっかり視点が動かないように)
  if (!flight && !mouseOverViewport) return;
  const { forward, right } = fcGetCameraVectors(fcYaw, fcPitch);
  const d = fcMoveSpeed * dt;
  let moved = false;
  const move = (v, s) => { fcPos[0] += v[0]*s; fcPos[1] += v[1]*s; fcPos[2] += v[2]*s; moved = true; };
  if (fcKeys['KeyW']) move(forward, d);
  if (fcKeys['KeyS']) move(forward, -d);
  if (fcKeys['KeyD']) move(right, d);
  if (fcKeys['KeyA']) move(right, -d);
  if (fcKeys['KeyE']) move([0, 1, 0], d);
  if (fcKeys['KeyQ']) move([0, 1, 0], -d);
  if (flight && fcKeys['Space']) move([0, 1, 0], d);
  if (flight && (fcKeys['ShiftLeft'] || fcKeys['ShiftRight'])) move([0, 1, 0], -d);
  if (moved) markViewMoved();
}

function freecamLoop(now) {
  if (!fcActive) return;
  // 書き出し中は、書き出し(export.js)がキャンバスを使うので描かない
  if (typeof exportState !== 'undefined' && exportState) { fcAnimId = requestAnimationFrame(freecamLoop); return; }
  const dt = fcLastFrameTime ? Math.min(0.1, (now - fcLastFrameTime) / 1000) : 0;
  fcLastFrameTime = now;

  // タイムラインの高さを変えた時なども、キャンバスを実際の大きさに追従させる
  resizeFreecamCanvas();
  applyMovementKeys(dt);
  // カメラ視点モードで、自分で動かしていない間はカメラの構図に追従する
  if (pilot && !pilot.dirty) syncPilotToCamera();

  try {
    renderFreecam();
  } catch (err) {
    console.error('描画中にエラーが起きました(このフレームだけスキップします):', err);
  }
  updateViewportOverlays();
  if (timeline && timeline.frames.length && timeline.frames[curTick] && typeof updateFrameInfo === 'function') {
    updateFrameInfo(timeline.frames[curTick]);
  }
  if (typeof updateScrubUI === 'function') updateScrubUI();
  if (typeof updateTextOverlayLayerRect === 'function') updateTextOverlayLayerRect();

  fcAnimId = requestAnimationFrame(freecamLoop);
}


// ============================================================
// 初期化・操作(ui.js から呼ぶ)
// ============================================================

// リプレイの読み込みが始まったタイミングで1回だけ呼ぶ
async function initFreecamOnce() {
  if (fcActive) return; // 既に初期化済み(2つ目のファイルを読み込んだ場合など)
  if (!initFreecamGL()) return;
  fcActive = true;
  fcKeys = {};
  resizeFreecamCanvas();

  // 既に届いている面があれば、今ある分をすぐ作っておく
  if (fcMeshFaces.length) rebuildFreecamVertexData();

  try {
    await ensureFreecamAtlasReady();
    fcUploadAtlasTexture();
    // アトラスができる前に届いた面は、テクスチャの位置(UV)が決まらないまま
    // 頂点データになっている(=1マスにアトラス全体が貼られてしまう)ので、
    // アトラスができたこの時点で、今ある面を全部作り直す
    if (fcMeshFaces.length) rebuildFreecamVertexData();
    if (typeof offBlocksReport === 'function') offBlocksReport();
  } catch (e) {
    console.error('テクスチャアトラスの準備に失敗しました:', e);
    setStatusText('⚠️ テクスチャの準備に失敗しました: ' + e.message);
  }

  initEntities3D(fcGl);
  setupPinPInset();
  fcGoToPlayer();

  fcLastFrameTime = 0;
  if (fcAnimId) cancelAnimationFrame(fcAnimId);
  fcAnimId = requestAnimationFrame(freecamLoop);
}

// カメラをプレイヤーの現在位置あたりに移動する
function fcGoToPlayer() {
  if (timeline && timeline.frames.length && timeline.frames[curTick]) {
    const f = timeline.frames[curTick];
    if (pilot) exitPilot(false);
    fcPos = [f.position[0] - worldOriginX, f.position[1] - worldOriginY + 2, f.position[2] - worldOriginZ];
    markViewMoved();
  }
}

// 置く演出の設定が変わった時などに、今ある面の頂点データを全部作り直す
function rebuildFreecamVertexData() {
  _fcBuildFrom(0);
  _uploadFreecamVertexData(true);
}
