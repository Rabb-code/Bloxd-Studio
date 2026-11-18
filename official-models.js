// official-models.js
// ============================================================
// 公式の見た目で人を描く(ステップ31)
//   - official/Player_Model.json … Bloxd の Player_Model.glb を、公式の Draco デコーダーでほどいた物
//     (部品の木: Root → TorsoNode → Head / LeftArm / RightArm、Root → LeftLeg / RightLeg)
//   - official/Player_Atlas.png … 32×32 マスの部品の一覧。1マス(64×64)が「その部品だけのスキン」
//   - official/cosmetics.json  … 着せかえの名前 → [atlasIdx, 列, 行]
//   - official/items.json + official/items/*.png … 持ち物の名前 → 絵
//   - official/cosmetic_extra.json(ステップ36)… 着せかえの名前 → NPC の見た目・3Dの付属品(帽子・頭・体ごとのモデル)
//   - official/attach/<名前>.json + .png …… 付属品のモデル(公式の glb をほどいた物)と絵
//   - official/mobs.json + official/mobs/(ステップ37)… 生き物(ゾンビ・ガーディアン・動物)の名前 → モデルといつもの見た目
// スキンは公式と同じく、下から 肌 → 目 → まゆ → ズボン → 靴 → 服 → 髪 の7枚を重ねて1枚にする。
// 関節の動きはエディタの組み立て(poseBuildRig の rig.frame)をそのまま使う。
// official/ が無い時は、前の箱の人形で描く。
// ============================================================

const OFFICIAL = {
  ready: false, failed: false, model: null, atlas: null, cos: null, items: null,
  gl: null, prog: null, loc: null, joints: null, quad: null,
  extra: {},           // 着せかえの名前 → {s, tex, pt, full, np, att}
  mobs: {},            // 生き物の名前 → {model, tex}
  mobModels: new Map(), // モデルの名前 → { ok, lists:{関節:[{g, local}]}, pivot:{関節:[x,y,z]}, humanoid }
  mobTex: new Map(),   // 生き物の名前 → tex
  attach: new Map(),   // 付属品の名前 → { ok, nodes:{部品の名前:[{g, local}]}, tex }(読み込み中は ok:false)
  skins: new Map(),    // 着せかえの指紋 → { canvas, tex }
  itemTex: new Map(),  // 絵の名前 → tex(読み込み中は null)
};

// エディタの関節 → 公式の部品の名前
const OFF_JOINT_NODE = { body: 'TorsoNode', head: 'Head', armR: 'RightArm', armL: 'LeftArm', legR: 'RightLeg', legL: 'LeftLeg' };
const OFF_SKIN_LAYERS = ['skin', 'eyes', 'eyebrows', 'legs', 'shoes', 'body', 'head']; // 下 → 上
const OFF_ATLAS_GRID = 32;
// 着せかえが無い人(人形など)は、公式の「default」キャラ
const OFF_DEFAULT_COS = { hat: 'hat_none', head: 'head_1_2', eyebrows: 'eyebrows_1_2', skin: 'skin_0_12', back: 'back_none',
  body: 'body_4_3', legs: 'legs_0_1', shoes: 'shoes_0_1', eyes: 'eyes_0_0' };

async function officialLoad() {
  try {
    const [model, cos, items, extra] = await Promise.all([
      fetch('official/Player_Model.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('Player_Model.json ' + r.status); return r.json(); }),
      fetch('official/cosmetics.json', { cache: 'no-cache' }).then(r => r.json()),
      fetch('official/items.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('official/cosmetic_extra.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    OFFICIAL.extra = extra || {};
    OFFICIAL.mobs = await fetch('official/mobs.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    const atlas = new Image();
    atlas.src = 'official/Player_Atlas.png';
    await atlas.decode();
    Object.assign(OFFICIAL, { model, cos, items, atlas });
    OFFICIAL.ready = true;
  } catch (e) {
    OFFICIAL.failed = true;
    console.warn('official/ が読めなかったので、前の箱の人形で描きます:', e.message);
  }
}
officialLoad();

const OFF_VS = `
  attribute vec3 aPos; attribute vec3 aNor; attribute vec2 aUV;
  uniform mat4 uView, uProj, uModel;
  varying vec2 vUV; varying float vB;
  void main() {
    gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
    vUV = aUV;
    vec3 n = normalize((uModel * vec4(aNor, 0.0)).xyz);   // mat3(mat4) は WebGL1 の GLSL では使えない環境がある
    vB = 0.78 + 0.22 * n.y - 0.12 * abs(n.x);   // 上の面は明るく、下と横は少し暗く(地形の明るさと近い)
  }`;
const OFF_FS = `
  precision mediump float;
  uniform sampler2D uTex; uniform vec3 uTint;
  varying vec2 vUV; varying float vB;
  void main() {
    vec4 c = texture2D(uTex, vUV);
    if (c.a < 0.05) discard;                     // 公式の alphaCutoff 0.05
    gl_FragColor = vec4(c.rgb * uTint * vB, 1.0);
  }`;

function _offInitGL(gl) {
  if (OFFICIAL.gl === gl) return true;
  if (!OFFICIAL.ready) return false;
  const vs = ent3dCompileShader(gl, gl.VERTEX_SHADER, OFF_VS), fs = ent3dCompileShader(gl, gl.FRAGMENT_SHADER, OFF_FS);
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); OFFICIAL.failed = true; return false; }
  OFFICIAL.prog = p;
  OFFICIAL.loc = {
    aPos: gl.getAttribLocation(p, 'aPos'), aNor: gl.getAttribLocation(p, 'aNor'), aUV: gl.getAttribLocation(p, 'aUV'),
    uView: gl.getUniformLocation(p, 'uView'), uProj: gl.getUniformLocation(p, 'uProj'), uModel: gl.getUniformLocation(p, 'uModel'),
    uTex: gl.getUniformLocation(p, 'uTex'), uTint: gl.getUniformLocation(p, 'uTint'),
  };
  const buf = (arr, target, T) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, new T(arr), gl.STATIC_DRAW); return b; };
  const M = OFFICIAL.model;
  const gpu = M.meshes.map(prims => prims.filter(pr => pr.mat !== 1).map(pr => ({
    pos: buf(pr.pos, gl.ARRAY_BUFFER, Float32Array), nor: buf(pr.nor, gl.ARRAY_BUFFER, Float32Array),
    uv: buf(pr.uv, gl.ARRAY_BUFFER, Float32Array), idx: buf(pr.idx, gl.ELEMENT_ARRAY_BUFFER, Uint16Array), n: pr.idx.length,
  })));
  // 関節ごとに、その部品の中の形(メッシュ)を集める。ほかの関節の部品・よろい(|Armour)には入らない
  const byName = {}; M.nodes.forEach((n, i) => { if (n.name && !(n.name in byName)) byName[n.name] = i; });
  const jointNodes = new Set(Object.values(OFF_JOINT_NODE));
  const joints = {};
  for (const [joint, nodeName] of Object.entries(OFF_JOINT_NODE)) {
    const list = [];
    const walk = (i, m) => {
      const n = M.nodes[i];
      if (n.name && n.name.includes('|Armour')) return;
      if (n.mesh != null) for (const g of gpu[n.mesh]) list.push({ g, local: m });
      for (const c of (n.children || [])) {
        const cn = M.nodes[c];
        if (jointNodes.has(cn.name)) continue;
        walk(c, _m4Mul(m, _offTRS(cn)));
      }
    };
    if (byName[nodeName] != null) walk(byName[nodeName], new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
    joints[joint] = list;
  }
  OFFICIAL.joints = joints;
  // 持ち物の板: 絵の右 = 前(+z)、絵の上 = 上(+y)。柄(左下)のあたりが原点
  OFFICIAL.quad = {
    pos: buf([0, -.2, -.2, 0, .8, -.2, 0, .8, .8, 0, -.2, .8], gl.ARRAY_BUFFER, Float32Array),
    nor: buf([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], gl.ARRAY_BUFFER, Float32Array),
    uv: buf([0, 1, 0, 0, 1, 0, 1, 1], gl.ARRAY_BUFFER, Float32Array),
    idx: buf([0, 1, 2, 0, 2, 3], gl.ELEMENT_ARRAY_BUFFER, Uint16Array), n: 6,
  };
  OFFICIAL.skins.clear(); OFFICIAL.itemTex.clear();
  OFFICIAL.gl = gl;
  return true;
}

function _offTRS(n) {
  const t = n.t || [0, 0, 0], [x, y, z, w] = n.r || [0, 0, 0, 1], [sx, sy, sz] = n.s || [1, 1, 1];
  return new Float32Array([
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0], t[1], t[2], 1]);
}

function _offTex(gl, src) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// 着せかえ(リプレイの cosmetics)→ 7枚を重ねた 64×64 のスキン(canvas)
function officialComposeSkin(cos) {
  const A = OFFICIAL.atlas, T = A.width / OFF_ATLAS_GRID;
  const c = document.createElement('canvas'); c.width = c.height = T;
  const k = c.getContext('2d'); k.imageSmoothingEnabled = false;
  for (const part of OFF_SKIN_LAYERS) {
    const name = (cos && cos[part]) || '';
    // 名前そのもののマスを先に使う。公式の texture は色の番号を取った名前(head_7_4 → head_7)のことが多く、
    // それはアトラスに無い。名前のマスが無い時だけ texture の名前(NPC など)を使う
    const alias = OFFICIAL.extra[name] && OFFICIAL.extra[name].tex;
    const e = OFFICIAL.cos[name] || (alias && OFFICIAL.cos[alias]) || OFFICIAL.cos[part + '_none'];
    if (!e) continue;
    k.drawImage(A, e[1] * T, e[2] * T, T, T, 0, 0, T, T);
  }
  return c;
}

function _offSkinTex(gl, cos) {
  const c = cos || OFF_DEFAULT_COS;
  const sig = OFF_SKIN_LAYERS.map(p => c[p] || '').join('|');
  let s = OFFICIAL.skins.get(sig);
  if (!s) { const canvas = officialComposeSkin(c); s = { canvas, tex: _offTex(gl, canvas) }; OFFICIAL.skins.set(sig, s); }
  return s.tex;
}

function _offItemTex(gl, itemName) {
  if (!itemName || !OFFICIAL.items) return null;
  const tx = OFFICIAL.items[String(itemName).split('|')[0]];
  if (!tx) return null;
  if (OFFICIAL.itemTex.has(tx)) return OFFICIAL.itemTex.get(tx);
  OFFICIAL.itemTex.set(tx, null);
  const im = new Image();
  im.onload = () => { if (OFFICIAL.gl === gl) OFFICIAL.itemTex.set(tx, _offTex(gl, im)); };
  im.src = 'official/items/' + encodeURIComponent(tx) + '.png';
  return null;
}

// その時刻の着せかえ・持ち物(リプレイのプレイヤーだけ)
function _offEntityLook(key, frameIdx) {
  if (!key || !key.startsWith('player:') || !allTimelines || !allTimelines.entities) return { cos: null, held: null };
  const ent = allTimelines.entities[key.slice(7)];
  if (!ent || !ent.frames || !ent.frames.length) return { cos: null, held: null };
  const f = nearestFrameAtOrBefore(ent.frames, frameIdx);
  if (!ent._cos) for (const fr of ent.frames) if (fr.cosmetics) { ent._cos = fr.cosmetics; break; }
  const cos = (f && f.cosmetics) || ent._cos || _offNpcCos(ent);
  return { cos: _offResolveCos(cos), held: f ? f.heldItemName : null };
}

// ステップ36: NPC(名前が「Mesh|Person|{…"textures":{"head":"portal_mage"}}」の人)の着せかえ
function _offNpcCos(ent) {
  if (ent._npcCos !== undefined) return ent._npcCos;
  ent._npcCos = null;
  const n = ent.name || '';
  if (n.startsWith('Mesh|Person|')) {
    try {
      const opts = JSON.parse(n.slice(12));
      // 書いていない場所は「無し」(公式の NPC は頭のマス1枚に体全部が描いてある)
      if (opts && opts.textures && typeof opts.textures === 'object') {
        const base = {}; for (const k of Object.keys(OFF_DEFAULT_COS)) base[k] = k + '_none';
        ent._npcCos = Object.assign(base, opts.textures);
      }
    } catch (e) { /* 読めない時は人形のまま */ }
  }
  return ent._npcCos;
}

// 公式の personTextures(この着せかえを着るとほかの場所を何にするか。体ごとのモデルの NPC は肌などを消す)
function _offResolveCos(cos) {
  if (!cos) return null;
  const X = OFFICIAL.extra;
  let out = null;
  for (const slot of Object.keys(cos)) {
    const ex = X[cos[slot]];
    if (ex && ex.pt) { out = out || Object.assign({}, cos); for (const k of Object.keys(ex.pt)) if (k !== slot) out[k] = ex.pt[k]; }
  }
  return out || cos;
}

// 付属品の部品 → エディタの関節
const OFF_DEST_JOINT = { TorsoNode: 'body', BodyMesh: 'body', HeadMesh: 'head', ArmLeftMesh: 'armL', ArmRightMesh: 'armR', LegLeftMesh: 'legL', LegRightMesh: 'legR' };
const OFF_ATT_JOINT_NODES = new Set(['TorsoNode', 'HeadMesh', 'ArmLeftMesh', 'ArmRightMesh', 'LegLeftMesh', 'LegRightMesh']);
// エディタの関節の位置(親から。体と脚は足元から、頭と腕は体から)。公式の Player_Model と同じ
const OFF_STD_PIVOT = { body: [0, 0.75, 0], head: [0, 0.6875, 0], armL: [0.3125, 0.5625, 0], armR: [-0.3125, 0.5625, 0], legL: [0.125, 0.75, 0], legR: [-0.125, 0.75, 0] };
const OFF_NP_NODE = { body: 'TorsoNode', head: 'HeadMesh', armL: 'ArmLeftMesh', armR: 'ArmRightMesh', legL: 'LegLeftMesh', legR: 'LegRightMesh' };

// 付属品のモデルを読む(1回だけ。読み終わるまでは描かない)
function _offAttach(gl, name) {
  let a = OFFICIAL.attach.get(name);
  if (a) return a.ok ? a : null;
  a = { ok: false }; OFFICIAL.attach.set(name, a);
  const base = 'official/attach/' + encodeURIComponent(name);
  Promise.all([
    fetch(base + '.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ng; im.src = base + '.png'; }),
  ]).then(([M, im]) => {
    if (OFFICIAL.gl !== gl) return;
    const buf = (arr, target, T) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, new T(arr), gl.STATIC_DRAW); return b; };
    const gpu = M.meshes.map(prims => prims.map(pr => ({
      pos: buf(pr.pos, gl.ARRAY_BUFFER, Float32Array), nor: buf(pr.nor, gl.ARRAY_BUFFER, Float32Array),
      uv: buf(pr.uv, gl.ARRAY_BUFFER, Float32Array), idx: buf(pr.idx, gl.ELEMENT_ARRAY_BUFFER, Uint16Array), n: pr.idx.length,
    })));
    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const nodes = {};
    M.nodes.forEach((n0) => {
      if (!n0.name || nodes[n0.name]) return;
      const list = [];
      const walk = (n, m) => {
        if (n.mesh != null && gpu[n.mesh]) for (const g of gpu[n.mesh]) list.push({ g, local: m });
        for (const c of (n.children || [])) { const cn = M.nodes[c]; if (OFF_ATT_JOINT_NODES.has(cn.name)) continue; walk(cn, _m4Mul(m, _offTRS(cn))); }
      };
      // 関節の部品(HeadMesh など)の形は、その関節から見た座標。BodyMesh などはその部品の位置を足す
      walk(n0, OFF_ATT_JOINT_NODES.has(n0.name) ? I : _offTRS(n0));
      nodes[n0.name] = list;
    });
    Object.assign(a, { ok: true, nodes, tex: _offTex(gl, im) });
  }).catch(() => { a.fail = true; });
  return null;
}

// ============================================================
// ステップ37: 生き物(ゾンビ・ガーディアン・動物…)
//   人型(頭・両腕・両脚がある)の生き物は、エディタの人型の関節で動かす。
//   公式のモデルの関節の位置がエディタと違う所は、その差だけずらす(体ごとのモデルの NPC と同じやり方)
//   4本足などは、今は動かさずに、向きだけ合わせて出す
// ============================================================
const OFF_MOB_JOINTS = {
  body: ['TorsoNode', 'UpperBody'], head: ['Head', 'HeadMesh'],
  armL: ['LeftArm', 'ArmLeftMesh', 'LeftArmMesh'], armR: ['RightArm', 'ArmRightMesh', 'RightArmMesh'],
  legL: ['LeftLeg', 'LegLeftMesh', 'LeftLegMesh'], legR: ['RightLeg', 'LegRightMesh', 'RightLegMesh'],
};
// エディタの人型の関節の位置(足元から。止まっている時)
const OFF_STD_WORLD = { body: [0, 0.75, 0], head: [0, 1.4375, 0], armL: [0.3125, 1.3125, 0], armR: [-0.3125, 1.3125, 0], legL: [0.125, 0.75, 0], legR: [-0.125, 0.75, 0] };

function _offMobName(key) {
  if (!key || !key.startsWith('player:') || !allTimelines || !allTimelines.entities) return null;
  const ent = allTimelines.entities[key.slice(7)];
  const n = ent && ent.name;
  return (n && OFFICIAL.mobs && OFFICIAL.mobs[n]) ? n : null;
}

function _offMobModel(gl, mname) {
  let a = OFFICIAL.mobModels.get(mname);
  if (a) return a.ok ? a : null;
  a = { ok: false }; OFFICIAL.mobModels.set(mname, a);
  fetch('official/mobs/' + encodeURIComponent(mname) + '.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(M => {
    if (OFFICIAL.gl !== gl) return;
    const buf = (arr, target, T) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, new T(arr), gl.STATIC_DRAW); return b; };
    const gpu = M.meshes.map(prims => prims.map(pr => ({
      pos: buf(pr.pos, gl.ARRAY_BUFFER, Float32Array), nor: buf(pr.nor, gl.ARRAY_BUFFER, Float32Array),
      uv: buf(pr.uv, gl.ARRAY_BUFFER, Float32Array), idx: buf(pr.idx, gl.ELEMENT_ARRAY_BUFFER, Uint16Array), n: pr.idx.length,
    })));
    const N = M.nodes, parent = new Array(N.length).fill(-1);
    N.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
    const depth = (i) => { let d = 0; while (parent[i] >= 0) { i = parent[i]; d++; } return d; };
    // 関節ごとに、候補の名前のうち一番上(親の方)の部品
    const jointOf = new Map();
    for (const [j, names] of Object.entries(OFF_MOB_JOINTS)) {
      let best = -1;
      N.forEach((n, i) => { if (names.includes(n.name) && (best < 0 || depth(i) < depth(best))) best = i; });
      if (best >= 0) jointOf.set(best, j);
    }
    const found = new Set(jointOf.values());
    const humanoid = ['head', 'armL', 'armR', 'legL', 'legR'].every(j => found.has(j));
    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const lists = { root: [] }, pivot = {};
    const walk = (i, joint, local, world) => {
      const n = N[i];
      const trs = _offTRS(n);
      const w = _m4Mul(world, trs);
      let lj = joint, lm;
      if (humanoid && jointOf.has(i)) {
        lj = jointOf.get(i); pivot[lj] = [w[12], w[13], w[14]];
        const r = _offTRS({ r: n.r, s: n.s }); lm = r;     // 関節の部品の位置は関節そのもの(回り・大きさだけ残す)
      } else lm = _m4Mul(local, trs);
      if (n.mesh != null && gpu[n.mesh] && !(n.name || '').includes('|Armour')) {
        (lists[lj] = lists[lj] || []).push(...gpu[n.mesh].map(g => ({ g, local: lm })));
      }
      for (const c of (n.children || [])) walk(c, lj, lm, w);
    };
    const roots = (M.scenes && M.scenes[M.scene || 0] && M.scenes[M.scene || 0].nodes) || N.map((n, i) => i).filter(i => parent[i] < 0);
    for (const r of roots) walk(r, 'root', I, I);
    Object.assign(a, { ok: true, lists, pivot, humanoid });
  }).catch(() => { a.fail = true; });
  return null;
}

function _offMobTex(gl, name) {
  if (OFFICIAL.mobTex.has(name)) return OFFICIAL.mobTex.get(name);
  OFFICIAL.mobTex.set(name, null);
  const im = new Image();
  im.onload = () => { if (OFFICIAL.gl === gl) OFFICIAL.mobTex.set(name, _offTex(gl, im)); };
  im.src = 'official/mobs/' + encodeURIComponent(OFFICIAL.mobs[name].tex);
  return null;
}

// 生き物を描く。まだ読み込み中なら何も描かない(true を返す = 人の形は描かない)
function _offDrawMob(gl, L, name, rig, tintFor, drawG) {
  const info = OFFICIAL.mobs[name];
  const A = _offMobModel(gl, info.model), tex = _offMobTex(gl, name);
  if (!A || !tex) return true;
  const R = rig.frame.root;
  const cull = gl.isEnabled(gl.CULL_FACE); if (cull) gl.disable(gl.CULL_FACE);
  for (const [joint, list] of Object.entries(A.lists)) {
    let M;
    if (joint === 'root' || !A.humanoid) M = R;
    else {
      const frame = rig.frame[joint]; if (!frame) continue;
      const pv = A.pivot[joint] || OFF_STD_WORLD[joint], sd = OFF_STD_WORLD[joint];
      const d = [pv[0] - sd[0], pv[1] - sd[1], pv[2] - sd[2]];
      M = _m4Mul(mat4Translate(R[0] * d[0] + R[4] * d[1] + R[8] * d[2], R[1] * d[0] + R[5] * d[1] + R[9] * d[2], R[2] * d[0] + R[6] * d[1] + R[10] * d[2]), frame);
    }
    const c = (tintFor && tintFor(joint === 'root' ? 'body' : joint)) || [1, 1, 1];
    gl.uniform3f(L.uTint, c[0], c[1], c[2]);
    for (const it of list) drawG(it.g, _m4Mul(M, it.local), tex);
  }
  if (cull) gl.enable(gl.CULL_FACE);
  return true;
}

// 体ごとのモデルの NPC: 公式の関節の位置(nodePositions)とエディタの関節の位置の差(体の向きの座標で)
function _offFullBodyShift(np, joint) {
  const d = [0, 0, 0];
  const add = (node, std, sgn) => { const v = np[node]; if (!v) return; for (let i = 0; i < 3; i++) d[i] += sgn * (v[i] - std[i]); };
  if (joint === 'body' || joint === 'head' || joint === 'armL' || joint === 'armR') add('TorsoNode', OFF_STD_PIVOT.body, 1);
  if (joint !== 'body') add(OFF_NP_NODE[joint], OFF_STD_PIVOT[joint], 1);
  return d;
}

// 公式の見た目で描けるか(official/ が読めて、人型の時)
// 準備で失敗したら、理由をコンソールに出して、それからは前の箱の人形で描く
function officialCanDraw(gl, type) {
  if (type !== 'humanoid' || !OFFICIAL.ready || OFFICIAL.failed) return false;
  try { return _offInitGL(gl); }
  catch (e) { officialGiveUp('準備', e); return false; }
}

function officialGiveUp(where, e) {
  if (OFFICIAL.failed) return;
  OFFICIAL.failed = true;
  console.error(`[公式モデル] ${where}で失敗したので、箱の人形に戻します:`, e);
  if (typeof setStatusText === 'function') setStatusText(`⚠️ 公式モデルを描けませんでした(${e && e.message ? e.message : e})。箱の人形で表示しています`);
}

// rig = poseRigFor(...) の組み立て。tintFor(joint) は選択の色([r,g,b])
function officialDrawHumanoid(gl, viewMatrix, projMatrix, key, rig, frameIdx, tintFor) {
  const L = OFFICIAL.loc;
  gl.useProgram(OFFICIAL.prog);
  gl.uniformMatrix4fv(L.uView, false, viewMatrix);
  gl.uniformMatrix4fv(L.uProj, false, projMatrix);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(L.uTex, 0);
  gl.enableVertexAttribArray(L.aPos); gl.enableVertexAttribArray(L.aNor); gl.enableVertexAttribArray(L.aUV);
  // ステップ37: 生き物(名前が公式の生き物の表にある物)
  const mob = _offMobName(key);
  if (mob) {
    const drawM = (g, model, tex) => {
      gl.uniformMatrix4fv(L.uModel, false, model);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.nor); gl.vertexAttribPointer(L.aNor, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.uv); gl.vertexAttribPointer(L.aUV, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawElements(gl.TRIANGLES, g.n, gl.UNSIGNED_SHORT, 0);
    };
    _offDrawMob(gl, L, mob, rig, tintFor, drawM);
    gl.disableVertexAttribArray(L.aNor);
    return;
  }
  const look = _offEntityLook(key, frameIdx);
  // プロジェクト設定でスキンを読み込んでいれば、それを全員に貼る(公式と同じ 64×64 の並び)
  const skin = (typeof humanoidTextureGL !== 'undefined' && humanoidTextureGL) ? humanoidTextureGL : _offSkinTex(gl, look.cos);
  const drawG = (g, model, tex) => {
    gl.uniformMatrix4fv(L.uModel, false, model);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.pos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.nor); gl.vertexAttribPointer(L.aNor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.uv); gl.vertexAttribPointer(L.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawElements(gl.TRIANGLES, g.n, gl.UNSIGNED_SHORT, 0);
  };
  // 着せかえの3Dの付属品・体ごとのモデル(ステップ36)
  const cos = look.cos || OFF_DEFAULT_COS;
  let full = null; const atts = [];
  for (const slot of Object.keys(cos)) {
    const ex = OFFICIAL.extra[cos[slot]]; if (!ex) continue;
    if (ex.full) full = ex;
    if (ex.att) for (const a of ex.att) atts.push(a);
  }
  if (!full) {
    for (const [joint, list] of Object.entries(OFFICIAL.joints)) {
      const frame = rig.frame[joint]; if (!frame) continue;
      const c = (tintFor && tintFor(joint)) || [1, 1, 1];
      gl.uniform3f(L.uTint, c[0], c[1], c[2]);
      for (const it of list) drawG(it.g, _m4Mul(frame, it.local), skin);
    }
  }
  if (atts.length) {
    const cull = gl.isEnabled(gl.CULL_FACE); if (cull) gl.disable(gl.CULL_FACE);  // 公式の付属品は両面
    const R = rig.frame.root;
    for (const [glb, node, dest] of atts) {
      const A = _offAttach(gl, glb); if (!A) continue;
      const list = A.nodes[node]; const joint = OFF_DEST_JOINT[dest] || OFF_DEST_JOINT[node];
      const frame = joint && rig.frame[joint]; if (!list || !frame) continue;
      let M = frame;
      if (full && full.np && R) {
        const d = _offFullBodyShift(full.np, joint);
        const dx = R[0] * d[0] + R[4] * d[1] + R[8] * d[2], dy = R[1] * d[0] + R[5] * d[1] + R[9] * d[2], dz = R[2] * d[0] + R[6] * d[1] + R[10] * d[2];
        M = _m4Mul(mat4Translate(dx, dy, dz), frame);
      }
      const c = (tintFor && tintFor(joint)) || [1, 1, 1];
      gl.uniform3f(L.uTint, c[0], c[1], c[2]);
      for (const it of list) drawG(it.g, _m4Mul(M, it.local), A.tex);
    }
    if (cull) gl.enable(gl.CULL_FACE);
  }
  // 持ち物(右手)
  const it = _offItemTex(gl, look.held);
  if (it && rig.frame.armR) {
    const c = (tintFor && tintFor('armR')) || [1, 1, 1];
    gl.uniform3f(L.uTint, c[0], c[1], c[2]);
    const m = _m4Mul(rig.frame.armR, mat4Translate(-0.06, -0.64, 0.02), mat4RotateX(1.08), _m4S(0.6, 0.6, 0.6));
    drawG(OFFICIAL.quad, m, it);
  }
  gl.disableVertexAttribArray(L.aNor);
}
