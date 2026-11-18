// shader-mod.js — ステップ52: 影MOD(シェーダーMOD)
// ============================================================
// だれでも、GLSL(WebGL1 の GLSL ES 1.0)を書いて、画面の見え方を自由に変えられる仕組み。
//   ・場面を、まず色の絵と奥行き(深さ)の絵に描く(地形・建築・人・モブ・パーティクル、全部)
//   ・影を使う MOD なら、太陽から見た奥行きの絵(影の地図)も描く(地形・建築・人・モブが影を落とす)
//   ・MOD の「パス」を順番に通す。パスは vec4 modPass(vec2 uv) を書く(前のパスの絵が uScene)
// MOD は 1つのファイル(.bloxdshader = JSON)。読み込み・書き出し・コードの編集・つまみ(設定)ができる。
// 書き出し(動画)にも同じ見え方で出る。使っている MOD はプロジェクトに保存される。
// ============================================================

const SHMOD_FORMAT = 'bloxd-shader-mod';
const SHMOD_LS_KEY = 'bloxdEditor.shaderMods';
const SHMOD_MAX_TEX = 4;        // MOD に入れられる絵の数
const SHMOD_MAX_LIGHTS = 16;    // 1コマで使う光の数(カメラに近い順)

let shmodLibrary = [];        // 自分で読み込んだ・作った MOD(ブラウザに覚える)
let shmodActive = null;       // { pack, values: {id: 値} } 使っている MOD
let shmodCompiled = null;     // { key, passes: [{prog, loc}], error }
let shmodError = null;        // 直前のコンパイルのエラー(画面に出す)
let shmodLastFrameMs = 0;

// ------------------------------------------------------------
// MOD の中身を確かめる・ととのえる
// ------------------------------------------------------------
function shmodNormalize(p) {
  if (!p || typeof p !== 'object') throw new Error('MOD のファイルではありません');
  if (p.format && p.format !== SHMOD_FORMAT) throw new Error('MOD のファイルではありません(format が ' + p.format + ')');
  const passes = Array.isArray(p.passes) ? p.passes : [];
  if (!passes.length) throw new Error('パス(passes)が1つもありません');
  const out = {
    format: SHMOD_FORMAT, version: 1,
    id: String(p.id || ('m' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
    name: String(p.name || '名前のない MOD').slice(0, 80),
    author: String(p.author || '').slice(0, 80),
    description: String(p.description || '').slice(0, 2000),
    builtin: !!p.builtin,
    antialias: p.antialias !== false,   // 最後に、ふちのギザギザをなめらかにする(FXAA)
    sun: { yaw: +((p.sun && p.sun.yaw) ?? 35), pitch: +((p.sun && p.sun.pitch) ?? 55) },
    shadow: {
      enabled: !!(p.shadow && p.shadow.enabled),
      size: Math.max(256, Math.min(8192, +((p.shadow && p.shadow.size) || 2048))),
      distance: Math.max(8, Math.min(1000, +((p.shadow && p.shadow.distance) || 80))),
    },
    options: (Array.isArray(p.options) ? p.options : []).filter(o => o && /^[A-Za-z_][A-Za-z0-9_]*$/.test(o.id || '')).map(o => ({
      id: o.id, label: String(o.label || o.id), type: ['slider', 'toggle', 'color'].includes(o.type) ? o.type : 'slider',
      min: +(o.min ?? 0), max: +(o.max ?? 1), step: +(o.step ?? 0.01),
      default: o.type === 'toggle' ? !!o.default : o.type === 'color' ? String(o.default || '#ffffff') : +(o.default ?? 0),
      bind: ['sunYaw', 'sunPitch'].includes(o.bind) ? o.bind : undefined,
    })),
    common: String(p.common || ''),
    vertex: String(p.vertex || ''),   // ステップ53: 形を動かす(vec3 modVertex(vec3 worldPos, vec3 blockPos, float mat))
    textures: (Array.isArray(p.textures) ? p.textures : []).filter(t => t && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.id || '') && /^data:image\//.test(t.data || '')).slice(0, SHMOD_MAX_TEX).map(t => ({
      id: t.id, name: String(t.name || t.id).slice(0, 80), data: t.data, wrap: t.wrap === 'clamp' ? 'clamp' : 'repeat', filter: t.filter === 'nearest' ? 'nearest' : 'linear',
    })),
    passes: passes.map((q, i) => ({ name: String((q && q.name) || ('パス' + (i + 1))), code: String((q && q.code) || '') })),
  };
  return out;
}

function shmodDefaults(pack) {
  const v = {};
  for (const o of pack.options) v[o.id] = o.default;
  return v;
}

// ------------------------------------------------------------
// 保存(ブラウザ)・プロジェクト
// ------------------------------------------------------------
function _shmodLsLoad() {
  try {
    const a = JSON.parse(localStorage.getItem(SHMOD_LS_KEY) || '[]');
    shmodLibrary = a.map(p => { try { return shmodNormalize(p); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { shmodLibrary = []; }
}
function _shmodLsSave() {
  try { localStorage.setItem(SHMOD_LS_KEY, JSON.stringify(shmodLibrary.filter(p => !p.builtin))); }
  catch (e) { if (typeof showToast === 'function') showToast('⚠ MOD をブラウザに覚えられませんでした(大きすぎるかも)'); }
}
function shmodAllPacks() { return [...SHMOD_BUILTINS, ...shmodLibrary]; }
function shmodFind(id) { return shmodAllPacks().find(p => p.id === id) || null; }

// プロジェクトに入れる(MOD の中身ごと。人に渡しても同じ見え方になる)
function shmodProjectData() {
  if (!shmodActive) return null;
  return { pack: shmodActive.pack, values: { ...shmodActive.values }, keys: JSON.parse(JSON.stringify(shmodActive.keys || {})) };
}
function shmodRestoreProject(d) {
  if (!d || !d.pack) { shmodSetActive(null); return; }
  try {
    let pack = shmodNormalize(d.pack);
    // ステップ54: 最初から入っている見本は、今の版の中身を使う(新しく足したつまみ・効果も出る。つまみの値とキーはそのまま)
    if (pack.builtin) { const cur = shmodFind(pack.id); if (cur) pack = cur; }
    shmodSetActive(pack, d.values, d.keys);
  } catch (e) { console.warn('[影MOD] プロジェクトの MOD を読めませんでした:', e); shmodSetActive(null); }
}

let _shmodVertexKey = '';   // 地形の描き方に入っている「形を動かす」コードの印
function shmodSetActive(pack, values, keys) {
  if (!pack) {
    shmodActive = null; _shmodFreeCompiled(); shmodError = null;
    _shmodApplyVertex(null);
    if (typeof renderShmodTrack === 'function') renderShmodTrack();
    return;
  }
  const v = { ...shmodDefaults(pack), ...(values || {}) };
  const k = {};
  for (const o of pack.options) if (keys && Array.isArray(keys[o.id]) && keys[o.id].length) k[o.id] = keys[o.id].map(q => ({ t: Math.round(+q.t), v: q.v })).sort((a, b) => a.t - b.t);
  shmodActive = { pack, values: v, keys: k };
  _shmodFreeCompiled();
  shmodError = null;
  _shmodApplyVertex(pack);
  if (typeof renderShmodTrack === 'function') renderShmodTrack();
}

// 形を動かすコードを、地形・形・建築の描き方に入れる(エラーなら入れずに shmodVertexError に)
let shmodVertexError = null;
function _shmodApplyVertex(pack) {
  const code = pack && pack.vertex && pack.vertex.trim() ? pack.vertex : '';
  const key = code ? code + '|' + pack.options.map(o => o.id + ':' + o.type).join(',') : '';
  if (key === _shmodVertexKey) return;
  if (typeof fcSetModVertex !== 'function' || typeof fcGl === 'undefined' || !fcGl) return;   // GL ができた後、描く時にもう一度
  _shmodVertexKey = key;
  shmodVertexError = null;
  try { fcSetModVertex(code ? { code, options: pack.options } : null); }
  catch (e) {
    shmodVertexError = shmodFormatError(pack, { pass: 'vertex', log: e && e.message ? e.message : String(e) });
    try { fcSetModVertex(null); } catch (e2) { /* 無視 */ }
    console.warn('[影MOD] 形を動かすコードを入れられませんでした:\n' + shmodVertexError);
  }
}

// ステップ53: つまみのキー(タイムライン)。keys[id] = [{t: コマ, v: 値}]
function _shmodInterp(o, ks, t) {
  if (t <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (t >= last.t) return last.v;
  let i = 1;
  while (i < ks.length && ks[i].t < t) i++;
  const a = ks[i - 1], b = ks[i];
  if (o.type === 'toggle') return t >= b.t ? b.v : a.v;
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  const e = f * f * (3 - 2 * f);   // なめらかに
  if (o.type === 'color') {
    const A = _shmodHex(a.v), B = _shmodHex(b.v);
    return '#' + [0, 1, 2].map(j => Math.round((A[j] + (B[j] - A[j]) * e) * 255).toString(16).padStart(2, '0')).join('');
  }
  return +a.v + (+b.v - +a.v) * e;
}
function shmodValuesAt(tick) {
  if (!shmodActive) return {};
  const v = { ...shmodActive.values }, K = shmodActive.keys || {};
  for (const o of shmodActive.pack.options) { const ks = K[o.id]; if (ks && ks.length) v[o.id] = _shmodInterp(o, ks, tick); }
  return v;
}
function shmodValuesNow() { return shmodValuesAt(typeof curTick !== 'undefined' ? curTick : 0); }
function shmodCurrentSun() { return shmodActive ? _shmodSunDir(shmodActive.pack, shmodValuesNow()) : [0.4, 0.8, 0.4]; }
// つまみを変えた: キーがあれば、今のコマのキーを作る・直す。無ければ全体の値
function shmodSetValue(id, val) {
  if (!shmodActive) return;
  const ks = shmodActive.keys[id];
  if (ks && ks.length) _shmodPutKey(id, val);
  else shmodActive.values[id] = val;
}
function _shmodPutKey(id, val) {
  const t = typeof curTick !== 'undefined' ? curTick : 0;
  const ks = shmodActive.keys[id] || (shmodActive.keys[id] = []);
  const k = ks.find(q => q.t === t);
  if (k) k.v = val; else { ks.push({ t, v: val }); ks.sort((a, b) => a.t - b.t); }
}
function shmodToggleKey(id) {
  if (!shmodActive) return;
  const t = typeof curTick !== 'undefined' ? curTick : 0;
  const ks = shmodActive.keys[id];
  const i = ks ? ks.findIndex(q => q.t === t) : -1;
  if (i >= 0) {
    // キーを消す。最後の1つなら、その値を全体の値にする
    if (ks.length === 1) shmodActive.values[id] = ks[0].v;
    ks.splice(i, 1);
    if (!ks.length) delete shmodActive.keys[id];
  } else _shmodPutKey(id, shmodValuesNow()[id]);
  if (typeof renderShmodTrack === 'function') renderShmodTrack();
}

// ------------------------------------------------------------
// GL の準備(使う時に1回)
// ------------------------------------------------------------
let _shmodGL = null;   // { depthExt, tri, fb: {scene, ping[2]}, shadow }
function _shmodInitGL(gl) {
  if (_shmodGL) return _shmodGL;
  const depthExt = gl.getExtension('WEBGL_depth_texture') || gl.getExtension('WEBKIT_WEBGL_depth_texture');
  gl.getExtension('OES_standard_derivatives');
  const tri = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, tri);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  _shmodGL = { depthExt, tri, scene: null, ping: [null, null], shadow: null };
  return _shmodGL;
}

function _shmodTex(gl, w, h, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function _shmodDepthTex(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
// 色+奥行きの描き先
function _shmodTarget(gl, old, w, h, withDepth) {
  if (old && old.w === w && old.h === h) return old;
  if (old) { gl.deleteFramebuffer(old.fbo); gl.deleteTexture(old.color); if (old.depth) gl.deleteTexture(old.depth); if (old.rb) gl.deleteRenderbuffer(old.rb); }
  const S = _shmodGL;
  const fbo = gl.createFramebuffer();
  const color = _shmodTex(gl, w, h, gl.LINEAR);
  let depth = null, rb = null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  if (withDepth) {
    if (S.depthExt) {
      depth = _shmodDepthTex(gl, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    } else {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
  }
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  return { fbo, color, depth, rb, w, h, ok };
}

// ------------------------------------------------------------
// パスのシェーダーを組み立てる
// ------------------------------------------------------------
// ふちのギザギザをなめらかにする(FXAA をかんたんにした物)。MOD の "antialias": false で止められる
const SHMOD_FXAA = `vec4 modPass(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 L = vec3(0.299, 0.587, 0.114);
  vec3 cM = modScene(uv).rgb;
  float lM = dot(cM, L);
  float lNW = dot(modScene(uv + vec2(-1.0, -1.0) * px).rgb, L), lNE = dot(modScene(uv + vec2(1.0, -1.0) * px).rgb, L);
  float lSW = dot(modScene(uv + vec2(-1.0, 1.0) * px).rgb, L), lSE = dot(modScene(uv + vec2(1.0, 1.0) * px).rgb, L);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * px;
  vec3 a = 0.5 * (modScene(uv + dir * (1.0 / 3.0 - 0.5)).rgb + modScene(uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (modScene(uv + dir * -0.5).rgb + modScene(uv + dir * 0.5).rgb);
  float lB = dot(b, L);
  return vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}
`;

const SHMOD_VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// MOD から使える物(この下に MOD のコードが続く)
let SHMOD_PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform sampler2D uScene;        // 前のパスの絵(1つ目のパスは場面の絵)
uniform sampler2D uSceneOrig;    // 場面の絵(MOD をかける前)
uniform sampler2D uDepth;        // 奥行き(0 = 近い, 1 = 空)
uniform sampler2D uShadowMap;    // 太陽から見た奥行き(影を使う MOD の時)
uniform vec2 uResolution;        // 絵の大きさ(ピクセル)
uniform float uTime;             // リプレイの中の時刻(秒)
uniform float uTick;             // リプレイの tick
uniform float uRealTime;         // 本当の時間(秒。ゆれる効果など)
uniform mat4 uViewProj;          // 世界 → 画面
uniform mat4 uInvViewProj;       // 画面 → 世界
uniform mat4 uShadowViewProj;    // 世界 → 影の地図
uniform vec3 uCamPos;            // カメラの位置(世界)
uniform vec3 uSunDir;            // 太陽の向き(太陽のある方。長さ 1)
uniform vec3 uOrigin;            // 世界の座標 = modWorldPos + uOrigin(ゲームの座標)
uniform float uShadowOn;         // 影の地図があるか
uniform vec2 uShadowTexel;       // 影の地図の 1ピクセル
uniform float uHasDepth;         // 奥行きが読めるか
__OPTIONS__
float modDepth(vec2 uv) { return texture2D(uDepth, uv).r; }
bool modIsSky(vec2 uv) { return uHasDepth > 0.5 && modDepth(uv) >= 0.999999; }
vec3 modWorldPosD(vec2 uv, float d) {
  vec4 w = uInvViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return w.xyz / w.w;
}
vec3 modWorldPos(vec2 uv) { return modWorldPosD(uv, modDepth(uv)); }
float modDistance(vec2 uv) { return length(modWorldPos(uv) - uCamPos); }
vec3 modNormal(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 p = modWorldPos(uv);
  vec3 r = modWorldPos(uv + vec2(px.x, 0.0)), l = modWorldPos(uv - vec2(px.x, 0.0));
  vec3 u = modWorldPos(uv + vec2(0.0, px.y)), d = modWorldPos(uv - vec2(0.0, px.y));
  vec3 dx = (length(r - p) < length(p - l)) ? r - p : p - l;
  vec3 dy = (length(u - p) < length(p - d)) ? u - p : p - d;
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, uCamPos - p) < 0.0) n = -n;
  return n;
}
// 影: 1 = 日なた, 0 = 影。soft = ぼかす広さ(ピクセル)
float modShadowSoft(vec3 wp, vec3 n, float soft) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 s = uShadowViewProj * vec4(wp + n * 0.04, 1.0);
  vec3 c = s.xyz / s.w * 0.5 + 0.5;
  if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float bias = 0.0006;
  float lit = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 o = vec2(float(i), float(j)) * uShadowTexel * soft;
    lit += (c.z - bias > texture2D(uShadowMap, c.xy + o).r) ? 0.0 : 1.0;
  }
  return lit / 9.0;
}
float modShadow(vec3 wp, vec3 n) { return modShadowSoft(wp, n, 1.0); }
vec4 modScene(vec2 uv) { return texture2D(uScene, uv); }
// ---- ステップ53
uniform sampler2D uMaterial;     // 材質の絵(r = 材質, g = 向き・角の明るさ, b = 不透明さ)
uniform sampler2D uMatDepth;     // 材質の絵の奥行き
uniform float uHasMaterial;
uniform sampler2D uPrevFrame;    // 1つ前のコマ(このパスの最後の結果)
uniform mat4 uPrevViewProj;      // 1つ前のコマの 世界 → 画面
uniform float uHasPrev;
uniform float uLightCount;       // 光るブロック(たいまつ・ランタン・溶岩など。カメラに近い順)
uniform vec4 uLightPos[16];      // xyz = 位置, w = 届く広さ
uniform vec4 uLightCol[16];      // rgb = 色, a = 強さ
uniform sampler2D uPass1;        // 1つ目・2つ目・3つ目のパスの結果(後のパスから使う)
uniform sampler2D uPass2;
uniform sampler2D uPass3;
__MATDEFS__
// 材質(MAT_*)。人やモブ・パーティクルの所は MAT_ENTITY、空は MAT_SKY
float modMaterial(vec2 uv) {
  float sd = modDepth(uv);
  if (uHasDepth > 0.5 && sd >= 0.999999) return MAT_SKY;
  if (uHasMaterial < 0.5) return MAT_SOLID;
  float md = texture2D(uMatDepth, uv).r;
  if (md > sd + 0.00002) return MAT_ENTITY;
  return floor(texture2D(uMaterial, uv).r * 255.0 + 0.5);
}
bool modIsMat(vec2 uv, float m) { return abs(modMaterial(uv) - m) < 0.5; }
float modSurfaceLight(vec2 uv) { return texture2D(uMaterial, uv).g; }
vec3 modViewDir(vec2 uv) { return normalize(modWorldPosD(uv, 1.0) - uCamPos); }
float modHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float modHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float modNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(modHash(i), modHash(i + vec2(1.0, 0.0)), f.x), mix(modHash(i + vec2(0.0, 1.0)), modHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float modFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * modNoise(p); p *= 2.03; a *= 0.5; } return s; }
vec3 modPointLights(vec3 p, vec3 n) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= uLightCount) break;
    vec3 d = uLightPos[i].xyz - p;
    float dist = length(d);
    float att = clamp(1.0 - dist / uLightPos[i].w, 0.0, 1.0);
    att *= att;
    s += uLightCol[i].rgb * uLightCol[i].a * att * (0.35 + 0.65 * max(dot(n, d / max(dist, 0.001)), 0.0));
  }
  return s;
}
vec4 modPrev(vec2 uv) { return texture2D(uPrevFrame, uv); }
// ---- ステップ54: 空の光(洞窟・屋根の下は暗い)
uniform sampler2D uSkyMap;       // 列ごとの、いちばん上のふさぐブロックの高さ
uniform vec4 uSkyMapRect;        // xy = 地図の左上(この場面の座標の x,z), z = 1マスが何ブロックか
uniform vec2 uSkyMapSize;        // 地図のマスの数
uniform float uHasSkyMap;
vec4 _modSkyTexel(vec2 xz) {
  vec2 c = floor((xz - uSkyMapRect.xy) / uSkyMapRect.z);
  if (c.x < 0.0 || c.y < 0.0 || c.x >= uSkyMapSize.x || c.y >= uSkyMapSize.y) return vec4(0.0);
  return texture2D(uSkyMap, (c + 0.5) / uSkyMapSize);
}
float _modSky16(vec2 hl) { return floor(hl.x * 255.0 + 0.5) * 256.0 + floor(hl.y * 255.0 + 0.5); }
// その列でいちばん上のふさぐブロックの、上の面の高さ(ブロックが無い列は -1000)
float modSurfaceTop(vec2 xz) {
  if (uHasSkyMap < 0.5) return -1000.0;
  float v = _modSky16(_modSkyTexel(xz).rg);
  return v < 0.5 ? -1000.0 : v - 32768.0 + 1.0;
}
// その列のいちばん上のかたまりの、下の面の高さ(下が空いていない列は -1000)。浮いた島・屋根・洞窟の天井
float modCeilingBottom(vec2 xz) {
  if (uHasSkyMap < 0.5) return -1000.0;
  float v = _modSky16(_modSkyTexel(xz).ba);
  return v < 0.5 ? -1000.0 : v - 32768.0;
}
// 空の光: 1 = 空が見える所, 0 = 深い洞窟。reach = 入り口から横に光が届く広さ(ブロック)
//   上をふさがれていても、近くに空が見える所があれば、近いほど明るい(洞窟の入り口・軒下)
float modSkyLightR(vec3 p, vec3 n, float reach) {
  if (uHasSkyMap < 0.5) return 1.0;
  vec3 q = p + n * 0.45;
  if (q.y >= modSurfaceTop(q.xz) - 0.02) return 1.0;
  // 天井が高いほど、横から入る光が遠くまで届く(高い所に浮いた島や屋根の下は、あまり暗くならない)
  float ceil0 = modCeilingBottom(q.xz);
  reach += max(ceil0 - q.y, 0.0) * 1.2;
  float best = 0.0;
  for (int i = 1; i <= 32; i++) {
    float fi = float(i);
    float r = reach * sqrt(fi / 32.0);
    float a = fi * 2.39996;
    vec2 xz = q.xz + vec2(cos(a), sin(a)) * r;
    if (q.y >= modSurfaceTop(xz) - 0.02) best = max(best, 1.0 - r / reach);
  }
  return best * best * (3.0 - 2.0 * best);
}
// ---- ステップ55: 光の広がり(ゲームと同じ考え方。壁は通らない・置く/壊すに合わせて変わる)
//   カメラのまわり 128×64×128 マスの光が入った絵。rgb = ブロックの光(たいまつなど), a = 空の光。どれも 明るさ/15
uniform sampler2D uLightVol;
uniform vec3 uLightVolOrigin;    // 絵の入っている箱の、小さい方の角(この場面の座標)
uniform float uHasLightVol;
// マス1つの値(c = 箱の中のマスの番号)
vec4 _modVolCell(vec3 c) {
  vec2 t = vec2(mod(c.y, 8.0), floor(c.y / 8.0));
  return texture2D(uLightVol, (t * 128.0 + c.xz + 0.5) / 1024.0);
}
// 位置 q の光(0〜1)。まわり8マスをなめらかにつなぐ(光をふさぐマスは数えない = 壁の向こうの光がにじまない)。
//   wgt = 箱の中なら 1、端に近いと 0 へ(箱の外は 0)
vec4 modLightVolume(vec3 q, out float wgt) {
  vec3 r = q - uLightVolOrigin;
  vec3 e = min(r, vec3(128.0, 64.0, 128.0) - r);
  wgt = uHasLightVol * clamp((min(e.x, min(e.y, e.z)) - 1.0) / 6.0, 0.0, 1.0);
  if (wgt <= 0.0) return vec4(0.0);
  vec3 g = clamp(r - 0.5, vec3(0.0), vec3(126.999, 62.999, 126.999));
  vec3 b = floor(g), f = g - b;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    vec3 o = vec3(mod(fi, 2.0), mod(floor(fi / 2.0), 2.0), floor(fi / 4.0));
    vec4 v = _modVolCell(b + o);
    vec3 w3 = mix(1.0 - f, f, o);
    float w = w3.x * w3.y * w3.z * step(v.a, 0.97);   // a = 1 は「ふさぐマス」の印
    acc += v * w; ws += w;
  }
  if (ws < 0.0001) return vec4(0.0);
  return acc / ws * (255.0 / 240.0);
}
// 光をまとめて読む: rgb = ブロックの光(たいまつ・溶岩・光るブロック。色つき), a = 空の光(1 = 空が見える, 0 = 洞窟の奥)。
//   壁は通らない。置く・壊すに合わせて変わる。カメラから遠い所は、前のやり方(modSkyLightR・modPointLights)になる
vec4 modLight(vec3 p, vec3 n) {
  float w;
  vec4 v = modLightVolume(p + n * 0.5, w);
  vec4 c = vec4(v.rgb * sqrt(max(max(v.r, v.g), max(v.b, 0.0001))) * 1.25, v.a * sqrt(v.a));
  if (w >= 1.0) return c;
  return mix(vec4(modPointLights(p, n), modSkyLightR(p, n, 10.0)), c, w);
}
float modSkyLight(vec3 p, vec3 n) { return modLight(p, n).a; }
vec3 modBlockLight(vec3 p, vec3 n) { return modLight(p, n).rgb; }
vec2 modPrevUV(vec3 wp) { vec4 c = uPrevViewProj * vec4(wp, 1.0); return c.xy / c.w * 0.5 + 0.5; }
`;
// 形を動かすコード(頂点)で使える物
const SHMOD_VERTEX_HELPERS = `
float modHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float modNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(modHash(i), modHash(i + vec2(1.0, 0.0)), f.x), mix(modHash(i + vec2(0.0, 1.0)), modHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

function _shmodOptionDecls(pack) {
  return pack.options.map(o => o.type === 'color' ? `uniform vec3 opt_${o.id};` : `uniform float opt_${o.id};`)
    .concat(pack.textures.map(t => `uniform sampler2D tex_${t.id};\nuniform vec2 tex_${t.id}_size;`)).join('\n');
}
// 何を使っているか(使っていない物は作らない)
function _shmodFeatures(pack) {
  const all = pack.common + '\n' + pack.passes.map(p => p.code).join('\n');
  return {
    material: /modMaterial|modIsMat|modSurfaceLight|uMaterial|uMatDepth/.test(all),
    prev: /uPrevFrame|modPrev|uPrevViewProj|uHasPrev/.test(all),
    lights: /modPointLights|uLightPos|uLightCol|uLightCount|modBlockLight|modLight\b/.test(all),
    sky: /modSkyLight|modSurfaceTop|modCeilingBottom|uSkyMap|modBlockLight|modLight\b/.test(all),
    vol: /modSkyLight\b|modBlockLight|modLightVolume|uLightVol|modLight\b/.test(all),
  };
}

function _shmodCompile(gl, pack) {
  const S = _shmodInitGL(gl);
  const prelude = SHMOD_PRELUDE.replace('__OPTIONS__', _shmodOptionDecls(pack)).replace('__MATDEFS__', SHMOD_MAT_DEFINES);
  const maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  if (12 + pack.textures.length > maxUnits) throw { pass: null, log: 'この端末では、絵を ' + Math.max(0, maxUnits - 12) + ' 枚までしか使えません' };
  const compileShader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw { glLog: log }; }
    return s;
  };
  const vs = compileShader(gl.VERTEX_SHADER, SHMOD_VS);
  const passes = [];
  const list = pack.antialias ? [...pack.passes, { name: '(ふちをなめらかに)', code: SHMOD_FXAA, internal: true }] : pack.passes;
  try {
    list.forEach((ps, pi) => {
      const ext = '#extension GL_OES_standard_derivatives : enable\n';
      // #line: エラーの行番号を、共通(1)・このパス(2)の中の行にそろえる
      const src = ext + prelude + '\n#line 1 1\n' + (ps.internal ? '' : pack.common) + '\n#line 1 2\n' + ps.code + '\nvoid main() { gl_FragColor = modPass(vUV); }\n';
      let fs;
      try { fs = compileShader(gl.FRAGMENT_SHADER, src); }
      catch (e) { throw { pass: pi, log: e.glLog || String(e) }; }
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw { pass: pi, log: gl.getProgramInfoLog(p) };
      const U = (n) => gl.getUniformLocation(p, n);
      const loc = {};
      for (const n of ['uScene', 'uSceneOrig', 'uDepth', 'uShadowMap', 'uResolution', 'uTime', 'uTick', 'uRealTime', 'uViewProj', 'uInvViewProj',
        'uShadowViewProj', 'uCamPos', 'uSunDir', 'uOrigin', 'uShadowOn', 'uShadowTexel', 'uHasDepth',
        'uMaterial', 'uMatDepth', 'uHasMaterial', 'uPrevFrame', 'uPrevViewProj', 'uHasPrev', 'uLightCount', 'uLightPos[0]', 'uLightCol[0]', 'uPass1', 'uPass2', 'uPass3',
        'uSkyMap', 'uSkyMapRect', 'uSkyMapSize', 'uHasSkyMap', 'uLightVol', 'uLightVolOrigin', 'uHasLightVol']) loc[n] = U(n);
      const opt = {}, tex = {};
      for (const o of pack.options) opt[o.id] = U('opt_' + o.id);
      for (const t of pack.textures) tex[t.id] = { s: U('tex_' + t.id), size: U('tex_' + t.id + '_size') };
      passes.push({ prog: p, loc, opt, tex });
    });
  } finally { gl.deleteShader(vs); }
  return { passes, features: _shmodFeatures(pack) };
}

function _shmodFreeCompiled() {
  if (shmodCompiled && fcGl) for (const p of shmodCompiled.passes || []) fcGl.deleteProgram(p.prog);
  shmodCompiled = null;
}

// エラーの文を、日本語の場所の名前に(「共通 5行目」など)
function shmodFormatError(pack, e) {
  if (!e) return '';
  const where = (src) => src === '1' ? '共通' : src === '3' ? '形を動かす' : (e.pass != null && pack.passes[e.pass] ? pack.passes[e.pass].name : 'パス');
  const lines = String(e.log || e.message || e).replace(/\0/g, '').replace(/^シェーダーのコンパイルに失敗しました:\s*/, '').split('\n').filter(l => l.trim()).map(l => {
    const m = /^(ERROR|WARNING):\s*(\d+):(\d+):\s*(.*)$/.exec(l.trim());
    if (!m) return l;
    return `${m[1] === 'ERROR' ? 'エラー' : '注意'}: ${where(m[2])} ${m[3]}行目: ${m[4]}`;
  });
  const head = e.pass === 'vertex' ? '「形を動かす」で:\n' : (e.pass != null && pack.passes[e.pass] ? `「${pack.passes[e.pass].name}」で:\n` : '');
  return head + lines.join('\n');
}

// 試しにコンパイル(エディタの「反映」)。エラーの文か null
function shmodTryCompile(pack) {
  if (!fcGl) return null;
  try { const c = _shmodCompile(fcGl, pack); for (const p of c.passes) fcGl.deleteProgram(p.prog); }
  catch (e) { return shmodFormatError(pack, e); }
  // 形を動かすコード(地形・形・建築の3つの頂点シェーダーで試す)
  if (pack.vertex && pack.vertex.trim()) {
    const save = fcModVertex;
    try {
      fcModVertex = { code: pack.vertex, options: pack.options };
      const src = fcModVertexSource();
      const srcs = [FC_VERTEX_SHADER_SRC, FC_INST_VERTEX_SHADER_SRC];
      if (typeof BD_VS !== 'undefined') srcs.push(BD_VS);
      for (const t of srcs) {
        const sh = fcGl.createShader(fcGl.VERTEX_SHADER);
        fcGl.shaderSource(sh, t.replace('__MODVERTEX__', src));
        fcGl.compileShader(sh);
        const ok = fcGl.getShaderParameter(sh, fcGl.COMPILE_STATUS), log = fcGl.getShaderInfoLog(sh);
        fcGl.deleteShader(sh);
        if (!ok) return shmodFormatError(pack, { pass: 'vertex', log });
      }
    } finally { fcModVertex = save; }
  }
  return null;
}

// ------------------------------------------------------------
// 行列
// ------------------------------------------------------------
function _shmodMul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function _shmodInv(m) {
  const a = m, o = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return o;
  det = 1 / det;
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return o;
}
function _shmodOrtho(l, r, b, t, n, f) {
  return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
}

// 太陽の向き(MOD の sun と、つまみの sunYaw・sunPitch)
function _shmodSunDir(pack, values) {
  let yaw = pack.sun.yaw, pitch = pack.sun.pitch;
  for (const o of pack.options) {
    if (o.bind === 'sunYaw') yaw = +values[o.id];
    if (o.bind === 'sunPitch') pitch = +values[o.id];
  }
  const y = yaw * Math.PI / 180, p = Math.max(1, Math.min(89.9, pitch)) * Math.PI / 180;
  return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
}

function _shmodHex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ------------------------------------------------------------
// 描く: drawContent(view, proj, x, y, w, h) は、今の描き先に場面(地形・人・パーティクル・建築)を描く関数
// ------------------------------------------------------------
function shmodIsOn() { return !!shmodActive; }

// ステップ53: 光るブロック(たいまつ・ランタン・溶岩など)の場所。地形が変わった時だけ集め直す
let _shmodLights = { ver: -1, list: [] };
function _shmodLightColor(p, mat) {
  // ステップ55: 公式の光の色(0〜15)があれば、それを使う
  const om = (typeof OFFBLK !== 'undefined' && OFFBLK.materials && p) ? OFFBLK.materials[p.root_name] : null;
  if (om && om.l) { const mx = Math.max(om.l[0], om.l[1], om.l[2], 1); return [om.l[0] / mx, om.l[1] / mx, om.l[2] / mx, mx / 14, Math.max(4, mx * 0.85)]; }
  const s = (((p && p.root_name) || '') + ' ' + ((p && p.texture) || '')).toLowerCase();
  if (mat === 6 || /lava|magma/.test(s)) return [1.0, 0.38, 0.1, 1.2, 10];
  if (/sea_?lantern|beacon|soul|blue/.test(s)) return [0.55, 0.85, 1.0, 1.0, 12];
  if (/glowstone|glow_?stone|lamp|shroomlight/.test(s)) return [1.0, 0.84, 0.55, 1.0, 13];
  if (/candle/.test(s)) return [1.0, 0.62, 0.3, 0.6, 6];
  return [1.0, 0.6, 0.28, 1.0, 11];   // たいまつ・ランタン・火
}
function _shmodCollectLights() {
  const FS = (typeof fcMeshFaces !== 'undefined') ? fcMeshFaces : null;
  if (!FS) return [];
  if (_shmodLights.ver === FS.ver) return _shmodLights.list;
  const pal = (typeof fcMeshPalette !== 'undefined') ? fcMeshPalette : [];
  const lc = pal.map(p => { const m = fcMaterialOf(p, null); return (m === 5 || m === 6) ? _shmodLightColor(p, m) : null; });
  const list = [];
  if (lc.some(Boolean)) {
    const D = FS.d, n = FS.length, seen = new Set();
    for (let i = 0; i < n && list.length < 50000; i++) {
      const o = i * 8;
      if (D[o + 3] < 0) continue;
      const c = lc[D[o + 4]];
      if (!c) continue;
      const k = _fcPosKey(D[o], D[o + 1], D[o + 2]);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push({ x: D[o] - worldOriginX + 0.5, y: D[o + 1] - worldOriginY + 0.5, z: D[o + 2] - worldOriginZ + 0.5, c, r0: D[o + 6], r1: D[o + 7] });
    }
  }
  _shmodLights = { ver: FS.ver, list };
  return list;
}
// ステップ54: 空の光の地図。列(x,z)ごとに、いちばん上の「ふさぐ」ブロックの高さを、絵(RGBA)にしまう
//   r,g = 高さ + 32768(16ビット), b = 255 ならブロックあり。ふさがない物: 水・葉・ガラス・草花、柵・ドアなどのモデル
//   地形が変わった時だけ作り直す(読みこみ中は 2秒に1回まで)
let _shmodSky = { ver: -1, at: 0, tex: null, rect: [0, 0, 1], w: 1, h: 1, ok: false };
function _shmodSkyMap(gl) {
  const FS = (typeof fcMeshFaces !== 'undefined') ? fcMeshFaces : null;
  if (!FS || !FS.length) return null;
  const now = performance.now();
  if (_shmodSky.ver !== FS.ver && (!_shmodSky.ok || now - _shmodSky.at > 2000)) {
    _shmodSky.ver = FS.ver; _shmodSky.at = now;
    try { _shmodBuildSkyMap(gl, FS); } catch (e) { console.warn('[影MOD] 空の光の地図を作れませんでした:', e); }
  }
  return _shmodSky.ok ? _shmodSky : null;
}
function _shmodBuildSkyMap(gl, FS) {
  const pal = (typeof fcMeshPalette !== 'undefined') ? fcMeshPalette : [];
  const rects = (typeof fcUVRectsRaw !== 'undefined') ? fcUVRectsRaw : null;
  const occ = pal.map(p => {
    if (!p) return false;
    const info = (typeof offPaletteInfo === 'function') ? offPaletteInfo(p, rects) : null;
    if (info && !['cube', 'slab', 'stairs'].includes(info.type)) return false;
    const m = fcMaterialOf(p, info);
    return !(m === 1 || m === 2 || m === 3 || m === 4);
  });
  const D = FS.d, n = FS.length;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    if (D[o + 3] < 0 || !occ[D[o + 4]]) continue;
    const x = D[o], z = D[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (x0 > x1) { _shmodSky.ok = false; return; }
  const maxT = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const step = Math.max(1, Math.ceil(Math.max(x1 - x0 + 1, z1 - z0 + 1) / maxT));
  const w = Math.floor((x1 - x0) / step) + 1, h = Math.floor((z1 - z0) / step) + 1;
  const NONE = -2147483648;
  const top = new Int32Array(w * h).fill(NONE), ceil = new Int32Array(w * h).fill(NONE);
  const oy = worldOriginY;
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    if (D[o + 3] < 0 || !occ[D[o + 4]]) continue;
    const c = Math.floor((D[o] - x0) / step) + Math.floor((D[o + 2] - z0) / step) * w;
    const y = D[o + 1] - oy;
    if (y > top[c]) top[c] = y;
    if (D[o + 3] === 3 && y > ceil[c]) ceil[c] = y;   // 下向きの面 = かたまりの下の面
  }
  // r,g = いちばん上 + 32768、b,a = いちばん上のかたまりの下の面 + 32768(0 = 無し)
  const px = new Uint8Array(w * h * 4);
  const enc = (v) => Math.max(1, Math.min(65535, v + 32768));
  for (let c = 0; c < w * h; c++) {
    if (top[c] === NONE) continue;
    const v = enc(top[c]);
    px[c * 4] = v >> 8; px[c * 4 + 1] = v & 255;
    if (ceil[c] !== NONE) { const u = enc(ceil[c]); px[c * 4 + 2] = u >> 8; px[c * 4 + 3] = u & 255; }
  }
  if (!_shmodSky.tex) _shmodSky.tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, _shmodSky.tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  _shmodSky.rect = [x0 - worldOriginX, z0 - worldOriginZ, step];
  _shmodSky.w = w; _shmodSky.h = h; _shmodSky.ok = true;
}

// カメラに近い順に、今のコマにある物を SHMOD_MAX_LIGHTS 個
function _shmodPickLights(cam, tickVal, maxDist) {
  const list = _shmodCollectLights();
  const best = [];
  const md2 = maxDist * maxDist;
  for (const L of list) {
    if (L.r0 > tickVal || L.r1 <= tickVal) continue;
    const dx = L.x - cam[0], dy = L.y - cam[1], dz = L.z - cam[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > md2) continue;
    if (best.length < SHMOD_MAX_LIGHTS) { best.push([d2, L]); best.sort((a, b) => a[0] - b[0]); }
    else if (d2 < best[best.length - 1][0]) { best[best.length - 1] = [d2, L]; best.sort((a, b) => a[0] - b[0]); }
  }
  const pos = new Float32Array(SHMOD_MAX_LIGHTS * 4), col = new Float32Array(SHMOD_MAX_LIGHTS * 4);
  best.forEach(([, L], i) => {
    pos[i * 4] = L.x; pos[i * 4 + 1] = L.y; pos[i * 4 + 2] = L.z; pos[i * 4 + 3] = L.c[4];
    col[i * 4] = L.c[0]; col[i * 4 + 1] = L.c[1]; col[i * 4 + 2] = L.c[2]; col[i * 4 + 3] = L.c[3];
  });
  return { n: best.length, pos, col };
}

// MOD の絵(画像)を GL の絵に(読み込みが終わるまでは 1×1 の灰色)
const _shmodTexCache = new Map();   // pack.id + '|' + tex.id + '|' + data.length -> { tex, w, h }
function _shmodUserTex(gl, pack, t) {
  const key = pack.id + '|' + t.id + '|' + t.data.length + '|' + t.wrap + t.filter;
  let e = _shmodTexCache.get(key);
  if (e) return e;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  e = { tex, w: 1, h: 1 };
  _shmodTexCache.set(key, e);
  const img = new Image();
  img.onload = () => {
    const pot = (n) => (n & (n - 1)) === 0;
    const isPot = pot(img.width) && pot(img.height);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const near = t.filter === 'nearest';
    const wrap = t.wrap === 'repeat' && isPot ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
    if (isPot && !near) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : gl.LINEAR);
    e.w = img.width; e.h = img.height;
  };
  img.src = t.data;
  return e;
}

// 前のコマ(大きさごとに2枚を入れかえる)と、写すだけの描き方
const _shmodHist = new Map();   // 'w×h' -> { t: [target, target], cur, vp }
let _shmodBlitProg = null;
function _shmodBlit(gl) {
  if (_shmodBlitProg) return _shmodBlitProg;
  const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, SHMOD_VS));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 vUV; uniform sampler2D uT; void main() { gl_FragColor = texture2D(uT, vUV); }'));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  _shmodBlitProg = { p, t: gl.getUniformLocation(p, 'uT') };
  return _shmodBlitProg;
}

function shmodDrawScene(gl, view, proj, x, y, w, h, tick, drawContent) {
  if (!shmodActive || w < 2 || h < 2) { drawContent(view, proj, x, y, w, h); return; }
  const pack = shmodActive.pack;
  const values = shmodValuesAt(tick);
  const S = _shmodInitGL(gl);
  _shmodApplyVertex(pack);
  if (!shmodCompiled) {
    try { shmodCompiled = _shmodCompile(gl, pack); shmodError = null; }
    catch (e) { shmodCompiled = { passes: [], failed: true }; shmodError = shmodFormatError(pack, e); console.warn('[影MOD] コンパイルできませんでした:\n' + shmodError); }
  }
  if (shmodCompiled.failed) { drawContent(view, proj, x, y, w, h); return; }
  const F = shmodCompiled.features || {};
  const t0 = performance.now();
  w = Math.round(w); h = Math.round(h);
  const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
  const sun = _shmodSunDir(pack, values);
  const invView = _shmodInv(view);
  const camPos = [invView[12], invView[13], invView[14]];
  const viewProj = _shmodMul(proj, view);
  gl.disable(gl.SCISSOR_TEST);

  // 1) 影の地図(太陽から見た奥行き)
  let shadowVP = new Float32Array(16), shadowOn = false, shadowSize = 1;
  if (pack.shadow.enabled && S.depthExt) {
    const size = Math.min(pack.shadow.size, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    S.shadow = _shmodTarget(gl, S.shadow, size, size, true);
    if (S.shadow.ok) {
      const D = pack.shadow.distance;
      const fwd = [-invView[8], -invView[9], -invView[10]];
      let c = [camPos[0] + fwd[0] * D * 0.35, camPos[1] + fwd[1] * D * 0.35, camPos[2] + fwd[2] * D * 0.35];
      // ゆれ(影のちらつき)を減らすため、影の地図の1ピクセルずつに合わせる
      const up = Math.abs(sun[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
      const lv0 = fcMat4LookAt([0, 0, 0], [-sun[0], -sun[1], -sun[2]], up);
      const texel = (2 * D) / size;
      const cl = [lv0[0] * c[0] + lv0[4] * c[1] + lv0[8] * c[2], lv0[1] * c[0] + lv0[5] * c[1] + lv0[9] * c[2], lv0[2] * c[0] + lv0[6] * c[1] + lv0[10] * c[2]];
      cl[0] = Math.round(cl[0] / texel) * texel; cl[1] = Math.round(cl[1] / texel) * texel;
      const inv0 = _shmodInv(lv0);
      c = [inv0[0] * cl[0] + inv0[4] * cl[1] + inv0[8] * cl[2], inv0[1] * cl[0] + inv0[5] * cl[1] + inv0[9] * cl[2], inv0[2] * cl[0] + inv0[6] * cl[1] + inv0[10] * cl[2]];
      const R = Math.max(300, D * 3);
      const eye = [c[0] + sun[0] * R, c[1] + sun[1] * R, c[2] + sun[2] * R];
      const sv = fcMat4LookAt(eye, c, up);
      const sp = _shmodOrtho(-D, D, -D, D, 1, R * 2);
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.shadow.fbo);
      gl.viewport(0, 0, size, size);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      window._shmodShadowPass = true;
      try { drawContent(sv, sp, 0, 0, size, size); } finally { window._shmodShadowPass = false; }
      shadowVP = _shmodMul(sp, sv); shadowOn = true; shadowSize = size;
    }
  }

  // 2) 場面
  S.scene = _shmodTarget(gl, S.scene, w, h, true);
  if (!S.scene.ok) { gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB); if (scissorOn) gl.enable(gl.SCISSOR_TEST); drawContent(view, proj, x, y, w, h); return; }
  gl.bindFramebuffer(gl.FRAMEBUFFER, S.scene.fbo);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0.4, 0.63, 0.9, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  drawContent(view, proj, 0, 0, w, h);

  // 2b) 材質の絵(地形・建築だけ。人やモブの所は、奥行きの差で分かる)
  let matOn = false;
  if (F.material && S.depthExt) {
    S.mat = _shmodTarget(gl, S.mat, w, h, true);
    if (S.mat.ok) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.mat.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(11 / 255, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      window._shmodMatPass = true;
      try {
        drawTerrainWithMatrices(view, proj, 0, 0, w, h);
        if (typeof renderBuilds === 'function') renderBuilds(gl, view, proj, tick);
      } finally { window._shmodMatPass = false; }
      matOn = true;
    }
  }

  // 2c) 光るブロック
  const tickVal = (typeof _fcCurTickVal === 'function') ? _fcCurTickVal() : tick;
  const lights = F.lights ? _shmodPickLights(camPos, tickVal, 96) : null;

  // 2c') 空の光の地図
  const sky = F.sky ? _shmodSkyMap(gl) : null;

  // 2c'') 光の広がり(カメラのまわりの光の絵)
  let vol = null;
  if (F.vol && typeof lgWindow === 'function') {
    try { vol = lgWindow(gl, camPos, [-invView[8], -invView[9], -invView[10]], tickVal); }
    catch (e) { console.warn('[影MOD] 光の絵を作れませんでした:', e); vol = null; }
  }

  // 2d) 前のコマ
  let hist = null;
  if (F.prev) {
    const hk = w + 'x' + h;
    hist = _shmodHist.get(hk);
    if (!hist) { hist = { t: [null, null], cur: 0, vp: null }; _shmodHist.set(hk, hist); }
    hist.t[0] = _shmodTarget(gl, hist.t[0], w, h, false);
    hist.t[1] = _shmodTarget(gl, hist.t[1], w, h, false);
  }

  // 3) パス
  const n = shmodCompiled.passes.length;
  if (!S.passT) S.passT = [];
  for (let i = 0; i < n - 1; i++) S.passT[i] = _shmodTarget(gl, S.passT[i], w, h, false);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  const tps = (typeof scTps === 'function') ? scTps() : 30;
  const invVP = _shmodInv(viewProj);
  let input = S.scene.color;
  for (let i = 0; i < n; i++) {
    const P = shmodCompiled.passes[i], L = P.loc;
    const last = i === n - 1;
    if (last && hist) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, hist.t[hist.cur].fbo);
      gl.viewport(0, 0, w, h);
    } else if (last) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
      gl.viewport(x, y, w, h);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.passT[i].fbo);
      gl.viewport(0, 0, w, h);
    }
    gl.useProgram(P.prog);
    const tex = (unit, t, l) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); if (l) gl.uniform1i(l, unit); };
    tex(0, input, L.uScene);
    tex(1, S.scene.color, L.uSceneOrig);
    tex(2, S.scene.depth || S.scene.color, L.uDepth);
    tex(3, shadowOn ? S.shadow.depth : S.scene.color, L.uShadowMap);
    tex(4, matOn ? S.mat.color : S.scene.color, L.uMaterial);
    tex(5, matOn ? S.mat.depth : (S.scene.depth || S.scene.color), L.uMatDepth);
    const prevT = hist ? hist.t[1 - hist.cur] : null;
    tex(6, prevT ? prevT.color : S.scene.color, L.uPrevFrame);
    for (let j = 0; j < 3; j++) tex(7 + j, (j < i && S.passT[j]) ? S.passT[j].color : S.scene.color, L['uPass' + (j + 1)]);
    pack.textures.forEach((t, j) => {
      const e = _shmodUserTex(gl, pack, t), q = P.tex[t.id];
      tex(12 + j, e.tex, q && q.s);
      if (q && q.size) gl.uniform2f(q.size, e.w, e.h);
    });
    gl.uniform2f(L.uResolution, w, h);
    gl.uniform1f(L.uTime, (tick + (typeof fcSubTick !== 'undefined' ? fcSubTick : 0)) / tps);
    gl.uniform1f(L.uTick, tickVal);
    gl.uniform1f(L.uRealTime, performance.now() / 1000);
    gl.uniformMatrix4fv(L.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(L.uInvViewProj, false, invVP);
    gl.uniformMatrix4fv(L.uShadowViewProj, false, shadowVP);
    gl.uniform3f(L.uCamPos, camPos[0], camPos[1], camPos[2]);
    gl.uniform3f(L.uSunDir, sun[0], sun[1], sun[2]);
    gl.uniform3f(L.uOrigin, typeof worldOriginX !== 'undefined' ? worldOriginX : 0, typeof worldOriginY !== 'undefined' ? worldOriginY : 0, typeof worldOriginZ !== 'undefined' ? worldOriginZ : 0);
    gl.uniform1f(L.uShadowOn, shadowOn ? 1 : 0);
    gl.uniform2f(L.uShadowTexel, 1 / shadowSize, 1 / shadowSize);
    gl.uniform1f(L.uHasDepth, S.scene.depth ? 1 : 0);
    gl.uniform1f(L.uHasMaterial, matOn ? 1 : 0);
    gl.uniform1f(L.uHasPrev, hist && hist.vp ? 1 : 0);
    gl.uniformMatrix4fv(L.uPrevViewProj, false, (hist && hist.vp) || viewProj);
    tex(11, vol ? vol.tex : S.scene.color, L.uLightVol);
    gl.uniform1f(L.uHasLightVol, vol ? 1 : 0);
    if (vol) gl.uniform3f(L.uLightVolOrigin, vol.origin[0], vol.origin[1], vol.origin[2]);
    tex(10, sky ? sky.tex : S.scene.color, L.uSkyMap);
    gl.uniform1f(L.uHasSkyMap, sky ? 1 : 0);
    if (sky) { gl.uniform4f(L.uSkyMapRect, sky.rect[0], sky.rect[1], sky.rect[2], 0); gl.uniform2f(L.uSkyMapSize, sky.w, sky.h); }
    gl.uniform1f(L.uLightCount, lights ? lights.n : 0);
    if (lights && L['uLightPos[0]']) { gl.uniform4fv(L['uLightPos[0]'], lights.pos); gl.uniform4fv(L['uLightCol[0]'], lights.col); }
    for (const o of pack.options) {
      const l = P.opt[o.id];
      if (!l) continue;
      const v = values[o.id];
      if (o.type === 'color') { const c = _shmodHex(v); gl.uniform3f(l, c[0], c[1], c[2]); }
      else gl.uniform1f(l, o.type === 'toggle' ? (v ? 1 : 0) : +v);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, S.tri);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!last) input = S.passT[i].color;
  }
  // 前のコマを使う時は、できた絵を残しておいて、それを画面に写す
  if (hist) {
    const B = _shmodBlit(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(x, y, w, h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h);
    gl.useProgram(B.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hist.t[hist.cur].color); gl.uniform1i(B.t, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.tri);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    hist.cur = 1 - hist.cur;
    hist.vp = viewProj;
  }
  gl.disableVertexAttribArray(0);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.DEPTH_TEST);
  if (!scissorOn) gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
  gl.viewport(x, y, w, h);
  // 次に描く物(カメラの箱・矢印など)のために、この枠の奥行きは空にしておく
  gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  if (!scissorOn) gl.disable(gl.SCISSOR_TEST);
  shmodLastFrameMs = performance.now() - t0;
}

// ------------------------------------------------------------
// 最初から入っている MOD(見本。書きかえる時は「自分用に複製」)
// ------------------------------------------------------------
const SHMOD_TEMPLATE_CODE = `// ここに書いた modPass が、画面の1ピクセルごとに呼ばれます。返した色が画面に出ます。
// 使える物(一部):
//   modScene(uv)        前のパスの色(1つ目のパスは場面の色)
//   modIsSky(uv)        空か
//   modWorldPos(uv)     そのピクセルの世界の位置    modNormal(uv)  面の向き
//   modShadow(p, n)     影の地図があれば 1 = 日なた / 0 = 影("shadow" を enabled にした時)
//   uSunDir 太陽の向き  uCamPos カメラの位置  uTime リプレイの時刻(秒)  uResolution 絵の大きさ
//   つまみ(設定)は opt_<id> という名前で使えます
vec4 modPass(vec2 uv) {
  vec4 c = modScene(uv);
  return c;
}
`;

const SHMOD_BUILTINS = [
  shmodNormalize({
    id: 'builtin:full', builtin: true, name: '本気の影(見本)', author: 'Bloxd Editor',
    description: '空(太陽・雲・夕焼け・星)・影・水の反射と波・風でゆれる草や葉・たいまつの光・光のにじみ・霧。全部の機能を使う見本です。つまみにキーを打つと、動画の中で昼から夕方に変えたりできます。',
    sun: { yaw: 40, pitch: 45 },
    shadow: { enabled: true, size: 2048, distance: 70 },
    options: [
      { id: 'sunYaw', label: '太陽の向き', type: 'slider', min: 0, max: 360, step: 1, default: 40, bind: 'sunYaw' },
      { id: 'sunPitch', label: '太陽の高さ', type: 'slider', min: -20, max: 89, step: 0.5, default: 45, bind: 'sunPitch' },
      { id: 'sun', label: '日の光', type: 'slider', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'torch', label: 'たいまつの光', type: 'slider', min: 0, max: 3, step: 0.01, default: 1.2 },
      { id: 'cave', label: '洞窟の暗さ', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.9 },
      { id: 'reflect', label: '水の反射', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.8 },
      { id: 'waves', label: '水の波', type: 'slider', min: 0, max: 3, step: 0.01, default: 1 },
      { id: 'wind', label: '風', type: 'slider', min: 0, max: 3, step: 0.01, default: 1 },
      { id: 'clouds', label: '雲', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.45 },
      { id: 'fog', label: '霧', type: 'slider', min: 0, max: 3, step: 0.01, default: 0.5 },
      { id: 'bloom', label: '光のにじみ', type: 'slider', min: 0, max: 2, step: 0.01, default: 0.4 },
      { id: 'exposure', label: '明るさ', type: 'slider', min: 0.5, max: 2, step: 0.01, default: 1.05 },
    ],
    vertex: `// 形を動かす: 草・葉は風でゆれる、水は波打つ(影も一緒に動く)
vec3 modVertex(vec3 p, vec3 block, float mat) {
  float t = uModTime;
  if (mat == MAT_PLANT || mat == MAT_LEAVES) {
    float top = mat == MAT_LEAVES ? 0.6 : clamp(p.y - block.y, 0.0, 1.0);
    float g = 0.6 + 0.4 * modNoise(p.xz * 0.15 + t * 0.3);   // 風の強い所・弱い所
    p.x += sin(t * 2.2 + p.x * 0.7 + p.z * 0.4) * 0.07 * opt_wind * top * g;
    p.z += cos(t * 1.8 + p.z * 0.9 + p.x * 0.3) * 0.05 * opt_wind * top * g;
  }
  if (mat == MAT_WATER && p.y - block.y > 0.5) {
    p.y += (sin(t * 1.6 + p.x * 0.8) * cos(t * 1.3 + p.z * 0.7)) * 0.05 * opt_waves - 0.06;
  }
  return p;
}
`,
    common: `// 空の色(反射でも使う)。disc = 0 にすると太陽の丸を入れない(霧の色に使う)
vec3 skyColorD(vec3 V, float disc) {
  float day = clamp(uSunDir.y * 3.0 + 0.15, 0.0, 1.0);
  float h = max(V.y, 0.0);
  vec3 top = mix(vec3(0.015, 0.02, 0.06), vec3(0.2, 0.42, 0.85), day);
  vec3 hor = mix(vec3(0.06, 0.06, 0.12), vec3(0.62, 0.76, 0.95), day);
  vec3 col = mix(hor, top, pow(h, 0.55));
  float sd = max(dot(V, uSunDir), 0.0);
  float dusk = clamp(1.0 - abs(uSunDir.y) * 3.0, 0.0, 1.0);
  col += vec3(1.0, 0.45, 0.18) * dusk * pow(sd, 3.0) * (1.0 - h) * 0.9;
  col += vec3(1.0, 0.95, 0.85) * pow(sd, 900.0) * 10.0 * step(-0.05, uSunDir.y) * disc;
  col += vec3(1.0, 0.8, 0.55) * pow(sd, 14.0) * 0.25 * day;
  if (V.y > 0.0) {
    vec2 cp = V.xz / (V.y + 0.12) * 1.4 + vec2(uTime * 0.015, uTime * 0.004);
    float cl = smoothstep(1.0 - opt_clouds, 1.05 - opt_clouds * 0.4, modFbm(cp));
    vec3 cc = mix(vec3(0.12, 0.12, 0.16), mix(vec3(1.0, 0.75, 0.6), vec3(1.0), clamp(uSunDir.y * 4.0, 0.0, 1.0)), day);
    col = mix(col, cc, cl * 0.9 * smoothstep(0.0, 0.25, V.y));
    float st = step(0.9975, modHash(floor(V.xz / (V.y + 0.35) * 260.0)));
    col += vec3(st) * clamp(1.0 - day * 1.6, 0.0, 1.0) * (1.0 - cl);
  }
  return col;
}
vec3 skyColor(vec3 V) { return skyColorD(V, 1.0); }
vec3 sunLightColor() {
  return mix(vec3(1.0, 0.5, 0.28), vec3(1.0, 0.96, 0.88), clamp(uSunDir.y * 2.5, 0.0, 1.0)) * clamp(uSunDir.y * 6.0 + 0.2, 0.0, 1.0);
}
`,
    passes: [
      { name: '空・光・影・水', code: `vec4 modPass(vec2 uv) {
  vec3 V = modViewDir(uv);
  if (modIsSky(uv)) return vec4(skyColor(V) * opt_exposure, 1.0);
  vec4 c = modScene(uv);
  vec3 p = modWorldPos(uv);
  vec3 n = modNormal(uv);
  float m = modMaterial(uv);
  float day = clamp(uSunDir.y * 3.0 + 0.15, 0.0, 1.0);
  float sh = modShadowSoft(p, n, 1.6);
  float facing = smoothstep(0.0, 0.3, dot(n, uSunDir));
  // 日なたで 元より少し明るく、影で 6割くらい(元の絵には向きの明るさ・角の暗さがもう入っている)
  vec3 amb = mix(vec3(0.08, 0.09, 0.16), vec3(0.54, 0.57, 0.64), day);
  // 空の光: 洞窟・屋根の下は 空からの光が届かない(入り口に近いほど明るい)
  vec4 lt = modLight(p, n);   // rgb = たいまつなどの光, a = 空の光
  float skyL = mix(1.0, lt.a, opt_cave);
  vec3 light = (amb + sunLightColor() * sh * facing * 0.58 * opt_sun) * skyL;
  // たいまつ・溶岩などの光(壁は通らない)。昼の外では弱く、暗い所・夜では目立つ
  light += lt.rgb * opt_torch * mix(1.6, 0.3, skyL * day);
  vec3 col = c.rgb * light;
  if (abs(m - MAT_LIGHT) < 0.5 || abs(m - MAT_LAVA) < 0.5) col = c.rgb * 1.5;
  if (abs(m - MAT_WATER) < 0.5) {
    float t = uTime;
    vec3 wn = normalize(vec3(sin(p.x * 1.7 + t * 1.4) * 0.06 * opt_waves + (modNoise(p.xz * 2.0 + t) - 0.5) * 0.08 * opt_waves, 1.0,
                             cos(p.z * 2.1 + t * 1.1) * 0.06 * opt_waves + (modNoise(p.zx * 2.0 - t) - 0.5) * 0.08 * opt_waves));
    vec3 R = reflect(V, wn);
    R.y = abs(R.y);
    float fr = 0.15 + 0.85 * pow(1.0 - max(dot(-V, wn), 0.0), 4.0);
    col = mix(col, skyColor(R) * (0.55 + 0.45 * sh), fr * opt_reflect);
    col += sunLightColor() * pow(max(dot(R, uSunDir), 0.0), 220.0) * sh * 3.0;
  }
  float d = length(p - uCamPos);
  col = mix(col, min(skyColorD(normalize(vec3(V.x, max(V.y, 0.02), V.z)), 0.0), vec3(1.0)), clamp(1.0 - exp(-d * opt_fog * 0.006), 0.0, 1.0));
  return vec4(col * opt_exposure, 1.0);
}
` },
      { name: '光のにじみ(横)', code: `vec4 modPass(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 s = vec3(0.0); float ws = 0.0;
  for (int i = -10; i <= 10; i++) {
    float w = exp(-float(i * i) / 40.0);
    vec3 c = modScene(uv + vec2(float(i) * px.x * 2.5, 0.0)).rgb;
    s += max(c - 0.82, 0.0) * w; ws += w;
  }
  return vec4(s / ws, 1.0);
}
` },
      { name: '光のにじみ(縦)・仕上げ', code: `vec4 modPass(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 g = vec3(0.0); float ws = 0.0;
  for (int i = -10; i <= 10; i++) {
    float w = exp(-float(i * i) / 40.0);
    g += modScene(uv + vec2(0.0, float(i) * px.y * 2.5)).rgb * w; ws += w;
  }
  // uScene = 2つ目のパスの結果(明るい所だけ横にぼかした物)、uPass1 = 1つ目のパスの結果(光と影をつけた絵)
  vec3 col = texture2D(uPass1, uv).rgb + g / ws * opt_bloom * 2.5;
  col = col / (1.0 + max(col - 1.0, 0.0) * 0.5);   // 明るすぎる所をおさえる
  return vec4(col, 1.0);
}
` },
    ],
  }),
  shmodNormalize({
    id: 'builtin:soft-shadow', builtin: true, name: 'やわらかい影(見本)', author: 'Bloxd Editor',
    description: '太陽の光と影・遠くの霧。影MOD の作り方の見本です。「自分用に複製」してから、コードを書きかえてみてください。',
    sun: { yaw: 35, pitch: 50 },
    shadow: { enabled: true, size: 2048, distance: 70 },
    options: [
      { id: 'sunYaw', label: '太陽の向き', type: 'slider', min: 0, max: 360, step: 1, default: 35, bind: 'sunYaw' },
      { id: 'sunPitch', label: '太陽の高さ', type: 'slider', min: 5, max: 89, step: 1, default: 50, bind: 'sunPitch' },
      { id: 'shadow', label: '影の濃さ', type: 'slider', min: 0, max: 0.9, step: 0.01, default: 0.45 },
      { id: 'cave', label: '洞窟の暗さ', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.9 },
      { id: 'soft', label: '影のぼかし', type: 'slider', min: 0.5, max: 4, step: 0.1, default: 1.5 },
      { id: 'sunColor', label: '光の色', type: 'color', default: '#fff3dc' },
      { id: 'bright', label: '明るさ', type: 'slider', min: 0.6, max: 1.6, step: 0.01, default: 1.08 },
      { id: 'fogOn', label: '霧', type: 'toggle', default: true },
      { id: 'fog', label: '霧の濃さ', type: 'slider', min: 0, max: 3, step: 0.01, default: 0.6 },
      { id: 'fogColor', label: '霧の色', type: 'color', default: '#a9c8ef' },
    ],
    passes: [{ name: '光と影', code: `vec4 modPass(vec2 uv) {
  vec4 c = modScene(uv);
  if (modIsSky(uv)) return c;
  vec3 p = modWorldPos(uv);
  vec3 n = modNormal(uv);
  // 太陽に向いている面だけ光が当たる。影の地図で、さえぎられている所は影
  float sh = modShadowSoft(p, n, opt_soft);
  float facing = smoothstep(0.0, 0.3, dot(n, uSunDir));
  float lit = sh * facing;
  vec3 light = mix(vec3(1.0 - opt_shadow), opt_sunColor, lit);
  // 洞窟・屋根の下は暗く(modSkyLight: 1 = 空が見える, 0 = 深い洞窟)
  light *= mix(1.0, modSkyLight(p, n), opt_cave);
  vec3 col = c.rgb * light * opt_bright;
  // 遠いほど霧の色に
  if (opt_fogOn > 0.5) {
    float d = length(p - uCamPos);
    float f = 1.0 - exp(-d * opt_fog * 0.01);
    col = mix(col, opt_fogColor, clamp(f, 0.0, 1.0));
  }
  return vec4(col, 1.0);
}
` }],
  }),
  shmodNormalize({
    id: 'builtin:cinema', builtin: true, name: '映画風(見本)', author: 'Bloxd Editor',
    description: '明るい所がにじむ光・色あい・まわりを暗く・上下の黒い帯。パスを2つ使う見本です(1つ目の結果を2つ目で使う)。',
    options: [
      { id: 'threshold', label: 'にじむ明るさ', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.62 },
      { id: 'glow', label: 'にじみの強さ', type: 'slider', min: 0, max: 2, step: 0.01, default: 0.7 },
      { id: 'sat', label: '色の濃さ', type: 'slider', min: 0, max: 2, step: 0.01, default: 1.15 },
      { id: 'contrast', label: 'コントラスト', type: 'slider', min: 0.5, max: 1.8, step: 0.01, default: 1.1 },
      { id: 'tint', label: '色あい', type: 'color', default: '#fff0e0' },
      { id: 'vignette', label: 'まわりを暗く', type: 'slider', min: 0, max: 1, step: 0.01, default: 0.45 },
      { id: 'bars', label: '上下の黒い帯', type: 'toggle', default: false },
    ],
    passes: [
      { name: '明るい所を横にぼかす', code: `vec4 modPass(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 s = vec3(0.0);
  float ws = 0.0;
  for (int i = -8; i <= 8; i++) {
    float w = exp(-float(i * i) / 24.0);
    vec3 c = modScene(uv + vec2(float(i) * px.x * 2.0, 0.0)).rgb;
    s += max(c - opt_threshold, 0.0) * w;
    ws += w;
  }
  return vec4(s / ws, 1.0);
}
` },
      { name: '縦にぼかして仕上げ', code: `vec4 modPass(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 g = vec3(0.0);
  float ws = 0.0;
  for (int i = -8; i <= 8; i++) {
    float w = exp(-float(i * i) / 24.0);
    g += modScene(uv + vec2(0.0, float(i) * px.y * 2.0)).rgb * w;
    ws += w;
  }
  g /= ws;
  vec3 col = texture2D(uSceneOrig, uv).rgb + g * opt_glow * 3.0;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, opt_sat);
  col = (col - 0.5) * opt_contrast + 0.5;
  col *= opt_tint;
  float v = smoothstep(0.85, 0.25, length(uv - 0.5));
  col *= mix(1.0, v, opt_vignette);
  if (opt_bars > 0.5 && (uv.y < 0.1 || uv.y > 0.9)) col = vec3(0.0);
  return vec4(col, 1.0);
}
` },
    ],
  }),
  shmodNormalize({
    id: 'builtin:template', builtin: true, name: '空っぽ(ひな形)', author: 'Bloxd Editor',
    description: '何もしない MOD です。ここから自分の MOD を作れます。',
    passes: [{ name: 'パス1', code: SHMOD_TEMPLATE_CODE }],
  }),
];

// ------------------------------------------------------------
// 画面(「…」メニューの「影MOD」)
// ------------------------------------------------------------
let _shmodView = 'main';    // 'main' | 'code'
let _shmodEdit = null;      // コードを編集中の MOD(写し)
let _shmodEditTab = 0;      // -1 = 設定(JSON), 0 = 共通, 1〜 = パス
let _shmodChangedTimer = null;
const SHMOD_VERTEX_TEMPLATE = `// 形を動かす(書かなければ動かしません)
// vec3 modVertex(vec3 worldPos, vec3 blockPos, float mat) {
//   if (mat == MAT_PLANT) worldPos.x += sin(uModTime * 2.0 + worldPos.z) * 0.05 * (worldPos.y - blockPos.y);
//   return worldPos;
// }
`;

// 絵のタブ: MOD に画像を入れる(パスで tex_<id> として読める)
function _shmodRenderTextures(body, p) {
  const E = (t, c, s) => { const e = document.createElement(t); if (c) e.className = c; if (s != null) e.textContent = s; return e; };
  body.appendChild(E('div', 'shmodHint', `画像を ${SHMOD_MAX_TEX} 枚まで入れられます。パスの中で texture2D(tex_<名前>, uv) で読めます(大きさは tex_<名前>_size)。ノイズの模様・色の表(LUT)・ゴミや傷の模様などに使えます。大きさが 2 の累乗(256・512…)だと、くり返し(repeat)ができます。`));
  for (const t of p.textures) {
    const r = E('div', 'shmodTexRow');
    const im = document.createElement('img'); im.src = t.data; im.className = 'shmodTexImg';
    r.appendChild(im);
    const col = E('div', 'shmodTexCol');
    const nm = E('div', 'shmodTitle', 'tex_' + t.id);
    col.appendChild(nm);
    const sel = (opts, cur, on) => { const s = document.createElement('select'); for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === cur) o.selected = true; s.appendChild(o); } s.addEventListener('change', () => on(s.value)); return s; };
    const line = E('div', 'shmodActs');
    line.appendChild(sel([['repeat', 'くり返す'], ['clamp', 'くり返さない']], t.wrap, (v) => { t.wrap = v; }));
    line.appendChild(sel([['linear', 'なめらか'], ['nearest', 'ドット']], t.filter, (v) => { t.filter = v; }));
    const del = E('button', 'btn btn-ghost btn-sm', '消す'); del.type = 'button';
    del.addEventListener('click', () => { p.textures = p.textures.filter(q => q !== t); shmodRender(); });
    line.appendChild(del);
    col.appendChild(line);
    r.appendChild(col);
    body.appendChild(r);
  }
  const acts = E('div', 'shmodActs');
  if (p.textures.length < SHMOD_MAX_TEX) {
    const add = E('button', 'btn btn-sm btn-ghost', '画像を足す'); add.type = 'button';
    add.addEventListener('click', () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
      inp.addEventListener('change', async () => {
        const f = inp.files[0]; if (!f) return;
        const data = await _shmodImageToDataUrl(f, 1024);
        let id = (f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || 'img').slice(0, 24);
        while (p.textures.some(q => q.id === id)) id += '_';
        p.textures.push({ id, name: f.name, data, wrap: 'repeat', filter: 'linear' });
        shmodRender();
      });
      inp.click();
    });
    acts.appendChild(add);
  }
  const ap = E('button', 'btn btn-sm btn-primary', '反映'); ap.type = 'button'; ap.addEventListener('click', () => _shmodApply());
  acts.appendChild(ap);
  const bk = E('button', 'btn btn-sm btn-ghost', 'もどる'); bk.type = 'button'; bk.addEventListener('click', () => { _shmodView = 'main'; _shmodEdit = null; shmodRender(); });
  acts.appendChild(bk);
  body.appendChild(acts);
  const err = E('pre', 'shmodErr'); err.id = 'shmodCodeErr'; err.style.display = 'none';
  body.appendChild(err);
}
// 大きい画像は縮めて PNG の文字に
function _shmodImageToDataUrl(file, maxSide) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (k >= 1 && file.size < 1.5e6) { resolve(fr.result); return; }
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function _shmodModal() {
  let m = document.getElementById('shmodModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'shmodModal';
  m.innerHTML = '<div id="shmodBox"><div id="shmodHead"><h2>影MOD(シェーダー)</h2><button id="shmodClose" type="button" aria-label="閉じる">✕</button></div><div id="shmodBody"></div></div>';
  document.body.appendChild(m);
  m.querySelector('#shmodClose').addEventListener('click', () => m.classList.remove('open'));
  // .bloxdshader を落とすと読み込む
  m.addEventListener('dragover', (e) => { e.preventDefault(); });
  m.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) shmodImportFile(f); });
  return m;
}

function openShaderModDialog() {
  _shmodModal().classList.add('open');
  _shmodView = 'main';
  shmodRender();
}

function _shmodChanged() {
  clearTimeout(_shmodChangedTimer);
  _shmodChangedTimer = setTimeout(() => { if (typeof editorChanged === 'function') editorChanged(); }, 400);
}

function shmodRender() {
  const body = document.getElementById('shmodBody');
  if (!body) return;
  body.innerHTML = '';
  const box = document.getElementById('shmodBox');
  if (box) box.classList.toggle('wide', _shmodView === 'code');
  if (_shmodView === 'code' && _shmodEdit) { _shmodRenderCode(body); return; }
  const E = (t, c, s) => { const e = document.createElement(t); if (c) e.className = c; if (s != null) e.textContent = s; return e; };

  body.appendChild(E('div', 'shmodHint', 'GLSL で画面の見え方を自由に作れます。地形・建築・人・モブ・パーティクルの全部と、動画の書き出しに効きます。.bloxdshader のファイルで人と交換できます(ここに落としても読み込めます)。'));
  // 一覧
  const list = E('div', 'shmodList');
  const row = (pack, label, sub) => {
    const on = pack ? (shmodActive && shmodActive.pack.id === pack.id) : !shmodActive;
    const b = E('button', 'shmodItem' + (on ? ' on' : ''));
    b.type = 'button';
    b.appendChild(E('div', 'shmodItemName', label));
    if (sub) b.appendChild(E('div', 'shmodItemSub', sub));
    b.addEventListener('click', () => {
      if (!pack) shmodSetActive(null);
      else if (!(shmodActive && shmodActive.pack.id === pack.id)) shmodSetActive(pack);
      _shmodChanged(); shmodRender();
    });
    list.appendChild(b);
  };
  row(null, 'なし(ふつうの見え方)', '');
  for (const p of shmodAllPacks()) row(p, p.name, (p.builtin ? '見本' : (p.author ? p.author + ' · ' : '') + '自分の MOD') + ' · パス ' + p.passes.length + (p.shadow.enabled ? ' · 影の地図' : ''));
  // プロジェクトの中の MOD が一覧に無い時(人のプロジェクトを開いた時)
  if (shmodActive && !shmodFind(shmodActive.pack.id)) row(shmodActive.pack, shmodActive.pack.name, 'プロジェクトの中の MOD(「自分用に複製」で一覧に入ります)');
  body.appendChild(list);

  const acts = E('div', 'shmodActs');
  const btn = (label, fn, cls) => { const b = E('button', 'btn btn-sm ' + (cls || 'btn-ghost'), label); b.type = 'button'; b.addEventListener('click', fn); acts.appendChild(b); return b; };
  btn('ファイルから読み込む', () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.bloxdshader,.json,application/json';
    inp.addEventListener('change', () => { if (inp.files[0]) shmodImportFile(inp.files[0]); });
    inp.click();
  });
  btn('新しく作る', () => { const p = shmodNormalize({ name: '自分の MOD', passes: [{ name: 'パス1', code: SHMOD_TEMPLATE_CODE }] }); shmodLibrary.push(p); _shmodLsSave(); shmodSetActive(p); _shmodChanged(); _shmodOpenCode(p); });
  body.appendChild(acts);

  if (!shmodActive) return;
  const pack = shmodActive.pack;
  const card = E('div', 'shmodCard');
  card.appendChild(E('div', 'shmodTitle', pack.name + (pack.author ? '  —  ' + pack.author : '')));
  if (pack.description) card.appendChild(E('div', 'shmodDesc', pack.description));
  if (shmodError) { const er = E('pre', 'shmodErr', 'この MOD はまだ動きません(ふつうの見え方で出しています)\n' + shmodError); card.appendChild(er); }
  if (shmodVertexError) { const er = E('pre', 'shmodErr', '形を動かすコードが動きません(形は動かさずに出しています)\n' + shmodVertexError); card.appendChild(er); }
  // つまみ(◆ = 今のコマにキーを打つ。キーがあるつまみは、動画の中で値が変わる)
  if (pack.options.length) card.appendChild(E('div', 'shmodHint', '◆ を押すと、今の時刻にキーを打てます。キーが2つ以上あると、その間で値がなめらかに変わります(キーはタイムラインの「影MOD」の行に出ます)。'));
  const now = shmodValuesNow();
  for (const o of pack.options) {
    const r = E('div', 'shmodOpt');
    r.dataset.opt = o.id;
    const ks = shmodActive.keys[o.id] || [];
    const atNow = ks.some(q => q.t === curTick);
    const kb = E('button', 'shmodKey' + (atNow ? ' on' : ks.length ? ' has' : ''), '◆');
    kb.type = 'button';
    kb.title = atNow ? 'このキーを消す' : ks.length ? `キー ${ks.length}個 · 今の時刻にキーを打つ` : '今の時刻にキーを打つ';
    kb.addEventListener('click', () => { shmodToggleKey(o.id); _shmodChanged(); shmodRender(); });
    r.appendChild(kb);
    r.appendChild(E('label', null, o.label));
    const v = now[o.id];
    if (o.type === 'toggle') {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!v;
      cb.addEventListener('change', () => { shmodSetValue(o.id, cb.checked); _shmodChanged(); _shmodRefreshKeys(); });
      r.appendChild(cb);
    } else if (o.type === 'color') {
      const ci = document.createElement('input'); ci.type = 'color'; ci.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff';
      ci.addEventListener('input', () => { shmodSetValue(o.id, ci.value); _shmodChanged(); _shmodRefreshKeys(); });
      r.appendChild(ci);
    } else {
      const sl = document.createElement('input'); sl.type = 'range'; sl.min = o.min; sl.max = o.max; sl.step = o.step; sl.value = v;
      const out = E('span', 'shmodVal', String(+(+v).toFixed(3)));
      sl.addEventListener('input', () => { shmodSetValue(o.id, +sl.value); out.textContent = String(+(+sl.value).toFixed(3)); _shmodChanged(); _shmodRefreshKeys(); });
      r.appendChild(sl); r.appendChild(out);
    }
    if (ks.length) {
      const nav = E('span', 'shmodKeyNav');
      const jump = (dir) => {
        const list = ks.map(q => q.t);
        const t = dir < 0 ? [...list].reverse().find(x => x < curTick) : list.find(x => x > curTick);
        if (t != null && typeof seekTo === 'function') { seekTo(t); shmodRender(); }
      };
      const pb = E('button', 'shmodKeyJump', '‹'); pb.type = 'button'; pb.title = '前のキーへ'; pb.addEventListener('click', () => jump(-1));
      const nb = E('button', 'shmodKeyJump', '›'); nb.type = 'button'; nb.title = '次のキーへ'; nb.addEventListener('click', () => jump(1));
      nav.appendChild(pb); nav.appendChild(nb);
      r.appendChild(nav);
    }
    card.appendChild(r);
  }
  if (pack.options.length) {
    const rs = E('button', 'btn btn-ghost btn-sm', 'つまみを元に戻す(キーも消す)'); rs.type = 'button';
    rs.addEventListener('click', () => { shmodActive.values = shmodDefaults(pack); shmodActive.keys = {}; _shmodChanged(); if (typeof renderShmodTrack === 'function') renderShmodTrack(); shmodRender(); });
    card.appendChild(rs);
  }
  const a2 = E('div', 'shmodActs');
  const b2 = (label, fn, cls) => { const b = E('button', 'btn btn-sm ' + (cls || 'btn-ghost'), label); b.type = 'button'; b.addEventListener('click', fn); a2.appendChild(b); return b; };
  const mine = !pack.builtin && !!shmodLibrary.find(p => p.id === pack.id);
  if (mine) b2('コードを編集', () => _shmodOpenCode(pack), 'btn-primary');
  b2('自分用に複製', () => {
    const p = shmodNormalize({ ...JSON.parse(JSON.stringify(pack)), id: undefined, builtin: false, name: pack.name.replace(/\s*[(（](見本|ひな形)[)）]/g, '').trim() + ' のコピー' });
    shmodLibrary.push(p); _shmodLsSave(); shmodSetActive(p, shmodActive.values, shmodActive.keys); _shmodChanged(); _shmodOpenCode(p);
  }, mine ? 'btn-ghost' : 'btn-primary');
  b2('ファイルに書き出す', () => shmodExportFile(pack));
  if (mine) b2('一覧から消す', () => {
    if (!confirm('「' + pack.name + '」を一覧から消しますか?')) return;
    shmodLibrary = shmodLibrary.filter(p => p.id !== pack.id); _shmodLsSave(); shmodSetActive(null); _shmodChanged(); shmodRender();
  });
  card.appendChild(a2);
  if (shmodLastFrameMs) card.appendChild(E('div', 'shmodHint', `1コマにかかる時間: 約 ${shmodLastFrameMs.toFixed(1)} ms(影の地図の大きさ ${pack.shadow.enabled ? pack.shadow.size : 'なし'})`));
  body.appendChild(card);
}

// キーの印と、タイムラインの行を直す(全部作り直さない)
function _shmodRefreshKeys() {
  if (typeof renderShmodTrack === 'function') renderShmodTrack();
  if (!shmodActive) return;
  for (const row of document.querySelectorAll('#shmodBody .shmodOpt[data-opt]')) {
    const id = row.dataset.opt, ks = shmodActive.keys[id] || [], kb = row.querySelector('.shmodKey');
    if (!kb) continue;
    const atNow = ks.some(q => q.t === curTick);
    kb.className = 'shmodKey' + (atNow ? ' on' : ks.length ? ' has' : '');
  }
}
// 再生・シークで時刻が変わったら、つまみの見た目を今の値に(さわっている最中は変えない)
let _shmodLastSyncTick = -1;
setInterval(() => {
  const m = document.getElementById('shmodModal');
  if (!m || !m.classList.contains('open') || _shmodView !== 'main' || !shmodActive) return;
  if (typeof curTick === 'undefined' || curTick === _shmodLastSyncTick) return;
  _shmodLastSyncTick = curTick;
  const box = document.getElementById('shmodBody');
  if (box && box.contains(document.activeElement) && /INPUT/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox') return;
  if (!Object.keys(shmodActive.keys).length) { _shmodRefreshKeys(); return; }
  const now = shmodValuesNow();
  for (const row of document.querySelectorAll('#shmodBody .shmodOpt[data-opt]')) {
    const o = shmodActive.pack.options.find(q => q.id === row.dataset.opt);
    if (!o) continue;
    const v = now[o.id];
    const inp = row.querySelector('input');
    if (!inp) continue;
    if (o.type === 'toggle') inp.checked = !!v;
    else if (o.type === 'color') inp.value = v;
    else { inp.value = v; const out = row.querySelector('.shmodVal'); if (out) out.textContent = String(+(+v).toFixed(3)); }
  }
  _shmodRefreshKeys();
}, 250);

// タイムラインの「影MOD」の行(使っている MOD の帯と、つまみのキー)
function renderShmodTrack() {
  const lane = document.getElementById('timelineShmodLane');
  if (!lane || typeof tlTotalWidth !== 'function') return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  if (!shmodActive) { const row = document.getElementById('timelineShmodRow'); if (row) row.classList.add('isEmpty'); return; }
  const ppt = tlPxPerTick(), max = (typeof scMaxTick === 'function') ? scMaxTick() : 0;
  const el = document.createElement('div');
  el.className = 'tlBlock shmod';
  el.style.left = '0px';
  el.style.width = Math.max(6, max * ppt) + 'px';
  el.style.top = '3px';
  const lab = document.createElement('div'); lab.className = 'tlBlockLabel'; lab.textContent = shmodActive.pack.name;
  el.appendChild(lab);
  el.addEventListener('click', (e) => { if (e.target === el || e.target === lab) openShaderModDialog(); });
  const ticks = new Map();
  for (const [id, ks] of Object.entries(shmodActive.keys)) for (const q of ks) { if (!ticks.has(q.t)) ticks.set(q.t, []); ticks.get(q.t).push(id); }
  for (const [t, ids] of ticks) {
    const k = document.createElement('div');
    k.className = 'tlKey shmodKeyMark';
    k.style.left = (t * ppt) + 'px';
    k.title = ids.map(id => (shmodActive.pack.options.find(o => o.id === id) || {}).label || id).join('・');
    k.addEventListener('mousedown', (e) => { e.stopPropagation(); if (typeof seekTo === 'function') seekTo(t); });
    el.appendChild(k);
  }
  lane.appendChild(el);
  const row = document.getElementById('timelineShmodRow');
  if (row) row.classList.remove('isEmpty');
}

function _shmodOpenCode(pack) {
  _shmodEdit = JSON.parse(JSON.stringify(pack));
  _shmodEditTab = 1;
  _shmodView = 'code';
  shmodRender();
}

// 設定(JSON のタブ)に出す・読む物
function _shmodSettingsJson(p) {
  return JSON.stringify({ name: p.name, author: p.author, description: p.description, antialias: p.antialias, sun: p.sun, shadow: p.shadow, options: p.options }, null, 2);
}

function _shmodRenderCode(body) {
  const E = (t, c, s) => { const e = document.createElement(t); if (c) e.className = c; if (s != null) e.textContent = s; return e; };
  const p = _shmodEdit;
  body.appendChild(E('div', 'shmodTitle', p.name + ' のコード'));
  const tabs = E('div', 'shmodTabs');
  const tab = (i, label) => {
    const b = E('button', 'shmodTab' + (_shmodEditTab === i ? ' on' : ''), label); b.type = 'button';
    b.addEventListener('click', () => { _shmodSaveTab(); _shmodEditTab = i; shmodRender(); });
    tabs.appendChild(b);
  };
  tab(-1, '設定(つまみ・影・太陽)');
  tab(-2, '形を動かす');
  tab(-3, '絵(' + p.textures.length + ')');
  tab(0, '共通');
  p.passes.forEach((ps, i) => tab(i + 1, ps.name));
  const add = E('button', 'shmodTab', '+ パス'); add.type = 'button';
  add.addEventListener('click', () => { _shmodSaveTab(); p.passes.push({ name: 'パス' + (p.passes.length + 1), code: SHMOD_TEMPLATE_CODE }); _shmodEditTab = p.passes.length; shmodRender(); });
  tabs.appendChild(add);
  body.appendChild(tabs);

  if (_shmodEditTab >= 1) {
    const ps = p.passes[_shmodEditTab - 1];
    const nr = E('div', 'shmodOpt');
    nr.appendChild(E('label', null, 'パスの名前'));
    const ni = document.createElement('input'); ni.type = 'text'; ni.value = ps.name; ni.id = 'shmodPassName';
    nr.appendChild(ni);
    if (p.passes.length > 1) {
      const del = E('button', 'btn btn-ghost btn-sm', 'このパスを消す'); del.type = 'button';
      del.addEventListener('click', () => { p.passes.splice(_shmodEditTab - 1, 1); _shmodEditTab = Math.min(_shmodEditTab, p.passes.length); shmodRender(); });
      nr.appendChild(del);
    }
    body.appendChild(nr);
  }
  if (_shmodEditTab === -3) { _shmodRenderTextures(body, p); return; }
  const ta = document.createElement('textarea');
  ta.id = 'shmodCode'; ta.className = 'shmodCode'; ta.spellcheck = false;
  ta.value = _shmodEditTab === -1 ? _shmodSettingsJson(p) : _shmodEditTab === -2 ? (p.vertex || SHMOD_VERTEX_TEMPLATE) : _shmodEditTab === 0 ? p.common : p.passes[_shmodEditTab - 1].code;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart, en = ta.selectionEnd; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en); ta.selectionStart = ta.selectionEnd = s + 2; }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); _shmodApply(); }
    e.stopPropagation();
  });
  body.appendChild(ta);
  body.appendChild(E('div', 'shmodHint', _shmodEditTab === -1
    ? 'antialias: false で、ふちをなめらかにするのを止めます。options の type: slider / toggle / color。bind に sunYaw・sunPitch を書くと、そのつまみで太陽が動きます。shadow.enabled を true にすると影の地図が使えます(size = 細かさ、distance = 届く広さ)。'
    : _shmodEditTab === -2 ? 'vec3 modVertex(vec3 worldPos, vec3 blockPos, float mat) を書くと、地形・草花・建築の形を動かせます(影も一緒に動きます)。mat は MAT_WATER・MAT_LEAVES・MAT_PLANT など。uModTime(秒)・uModSun・opt_<id>・modNoise が使えます。空にすると動かしません。'
    : _shmodEditTab === 0 ? 'ここに書いた関数は、全部のパスから使えます。' : 'vec4 modPass(vec2 uv) を書きます。⌘S / Ctrl+S でも反映できます。'));
  const err = E('pre', 'shmodErr'); err.id = 'shmodCodeErr'; err.style.display = 'none';
  body.appendChild(err);
  const acts = E('div', 'shmodActs');
  const b = (label, fn, cls) => { const x = E('button', 'btn btn-sm ' + (cls || 'btn-ghost'), label); x.type = 'button'; x.addEventListener('click', fn); acts.appendChild(x); };
  b('反映', () => _shmodApply(), 'btn-primary');
  b('もどる', () => { _shmodView = 'main'; _shmodEdit = null; shmodRender(); });
  body.appendChild(acts);
  setTimeout(() => ta.focus(), 0);
}

function _shmodSaveTab() {
  const p = _shmodEdit, ta = document.getElementById('shmodCode');
  if (!p || !ta || _shmodEditTab === -3) return true;
  if (_shmodEditTab === -1) {
    try {
      const j = JSON.parse(ta.value);
      Object.assign(p, { name: j.name ?? p.name, author: j.author ?? p.author, description: j.description ?? p.description, antialias: j.antialias ?? p.antialias, sun: j.sun ?? p.sun, shadow: j.shadow ?? p.shadow, options: j.options ?? p.options });
    } catch (e) { _shmodShowErr('設定の書き方がまちがっています(JSON): ' + e.message); return false; }
  } else if (_shmodEditTab === -2) p.vertex = ta.value.trim() === SHMOD_VERTEX_TEMPLATE.trim() ? '' : ta.value;
  else if (_shmodEditTab === 0) p.common = ta.value;
  else {
    const ps = p.passes[_shmodEditTab - 1];
    ps.code = ta.value;
    const ni = document.getElementById('shmodPassName'); if (ni && ni.value.trim()) ps.name = ni.value.trim();
  }
  return true;
}
function _shmodShowErr(t) {
  const e = document.getElementById('shmodCodeErr');
  if (!e) return;
  e.style.display = t ? '' : 'none';
  e.textContent = t || '';
}

function _shmodApply() {
  if (!_shmodSaveTab()) return;
  let pack;
  try { pack = shmodNormalize(_shmodEdit); } catch (e) { _shmodShowErr(e.message); return; }
  const err = shmodTryCompile(pack);
  if (err) { _shmodShowErr(err); return; }
  _shmodShowErr('');
  const i = shmodLibrary.findIndex(q => q.id === pack.id);
  if (i >= 0) shmodLibrary[i] = pack; else shmodLibrary.push(pack);
  _shmodLsSave();
  const same = shmodActive && shmodActive.pack.id === pack.id;
  shmodSetActive(pack, same ? shmodActive.values : null, same ? shmodActive.keys : null);
  _shmodEdit = JSON.parse(JSON.stringify(pack));
  _shmodChanged();
  if (typeof showToast === 'function') showToast('反映しました');
}

async function shmodImportFile(file) {
  try {
    const text = await file.text();
    const pack = shmodNormalize(JSON.parse(text));
    pack.builtin = false;
    // 同じ id がもうあれば、新しい id にする(上書きしない)
    if (shmodFind(pack.id)) pack.id = 'm' + Date.now().toString(36);
    shmodLibrary.push(pack); _shmodLsSave();
    shmodSetActive(pack); _shmodChanged();
    _shmodView = 'main';
    shmodRender();
    if (typeof showToast === 'function') showToast('「' + pack.name + '」を読み込みました');
  } catch (e) {
    if (typeof showToast === 'function') showToast('⚠ 読み込めませんでした: ' + e.message);
  }
}

function shmodExportFile(pack) {
  const o = { ...pack }; delete o.builtin;
  const blob = new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (pack.name || 'shader').replace(/[\\/:*?"<>|]/g, '_') + '.bloxdshader';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

_shmodLsLoad();
