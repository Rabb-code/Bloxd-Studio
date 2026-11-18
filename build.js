// build.js — ステップ49: 建築(.bloxdschem を動画の中に置く)
// ============================================================
//   ・建築の素材(structures): .bloxdschem を読み込んだ物。{ id, name, size:[x,y,z], blocks:Int32Array(x,y,z,番号 の4つずつ) }
//       ブラウザ(IndexedDB の 'structures')に覚える。プロジェクトの保存にも入る。
//   ・建築のブロック(buildBlocks): タイムラインの「建築」の行の1本。
//       { id, kind:'build', name, assetId, startTick, endTick, pos:[x,y,z](ローカル・整数・いちばん小さい角), rot:0〜3(90度ずつ),
//         inAnim:{type, order, sec}, outAnim:{type, order, sec}, hideWorld }
//   ・描き方: リプレイの地形と同じ公式のブロックの形・絵(official-blocks.js)。建築の中で隠れる面は出さない。
//       出し方・消え方の動きはシェーダーで(ブロックごとの始まる時刻 = 並び順)。
//   ・hideWorld: 建築が出ている間、建築のブロックがある所のリプレイのブロックを消す(地形を作り直す)。
//   ・.bloxdschem の形(増田さんの解析コードと同じ): Avro { headers:fixed(4), name, x,y,z, sizeX,sizeY,sizeZ,
//       chunks:[{ x,y,z, blocks:bytes(LEB128 の「個数・番号」のくり返し) }] }。チャンクは 32×32×32、
//       i 番目は lx = i/1024, ly = (i/32)%32, lz = i%32。番号は公式の blockMetadata の番号(block_id_to_root.csv と同じ)。
// ============================================================

let buildBlocks = [];
let nextBuildBlockId = 1;
let selectedBuildId = null;
const structureAssets = new Map();   // id -> { id, name, size, blocks, added, builtin? }
let structureOrder = [];

const BUILD_IN_TYPES = [['pop', 'ポンと出る'], ['drop', '空から落ちる'], ['slide', '下からせり上がる'], ['grow', '育つ'], ['none', 'すぐ出る']];
const BUILD_OUT_TYPES = [['none', 'そのまま'], ['pop', '縮んで消える'], ['drop', '落ちて消える'], ['slide', '沈んで消える'], ['grow', 'しぼむ']];
const BUILD_ORDERS = [['bottom', '下から'], ['top', '上から'], ['center', '真ん中から'], ['random', 'ばらばら'], ['all', 'いっせいに']];
const BUILD_TYPE_ID = { none: 0, pop: 1, drop: 2, slide: 3, grow: 4 };
const BUILD_ORDER_ID = { bottom: 0, top: 1, center: 2, random: 3, all: 4 };

function buildGet(id) { return buildBlocks.find(b => b.id === id) || null; }
function buildGetSelected() { return selectedBuildId != null ? buildGet(selectedBuildId) : null; }
function isBuildAssetKey(key) { return /^build:/.test(String(key)); }


// ============================================================
// ブロックの番号 → 名前・絵(block_id_to_root.csv と asset_master.csv。python と同じ決め方)
// ============================================================

let _bdIdTable = null, _bdIdTablePromise = null;
function bdLoadIdTable() {
  if (_bdIdTablePromise) return _bdIdTablePromise;
  _bdIdTablePromise = (async () => {
    const [idCsv, amCsv] = await Promise.all([
      fetch('block_id_to_root.csv', { cache: 'no-cache' }).then(r => r.ok ? r.text() : '').catch(() => ''),
      fetch('asset_master.csv', { cache: 'no-cache' }).then(r => r.ok ? r.text() : '').catch(() => ''),
    ]);
    const asset = new Map();
    const amLines = amCsv.split(/\r?\n/);
    const head = (amLines[0] || '').split(',');
    const col = (n) => head.indexOf(n);
    const ci = { root: col('root_name'), type: col('asset_type') };
    const texCols = ['final_top', 'tex_top', 'final_all', 'tex_all', 'final_side', 'tex_side', 'fuzzy_2', 'fuzzy_3'].map(col);
    const mCols = ['final_model', 'model_file'].map(col);
    for (let i = 1; i < amLines.length; i++) {
      const f = amLines[i].split(',');
      if (f.length < 3) continue;
      let tex = '';
      for (const c of texCols) if (c >= 0 && f[c]) { tex = f[c]; break; }
      let model = '';
      for (const c of mCols) if (c >= 0 && f[c]) { model = f[c]; break; }
      asset.set(f[ci.root], { texture: tex, model, asset_type: f[ci.type] || '' });
    }
    const ids = new Map();
    const lines = idCsv.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(',');
      if (f.length < 3) continue;
      const id = +f[0];
      const root = f[2], meta = f.slice(3).join(',');
      const a = asset.get(root) || { texture: '', model: '', asset_type: '' };
      ids.set(id, { root_name: root, meta: meta || '', full: f[1], texture: a.texture, model: a.model, asset_type: a.asset_type });
    }
    _bdIdTable = ids;
    return ids;
  })();
  return _bdIdTablePromise;
}
// 番号の名前(素材の一覧・パネル用)
function bdBlockName(id) { const e = _bdIdTable && _bdIdTable.get(id); return e ? e.full : ('#' + id); }
function bdIdByName(name) {
  if (!_bdIdTable) return 0;
  for (const [id, e] of _bdIdTable) if (e.full === name) return id;
  return 0;
}


// ============================================================
// .bloxdschem を読む
// ============================================================

function _bdAvroReader(u8) {
  let i = 0;
  const long = () => {   // zigzag varint
    let shift = 0, result = 0, b;
    do {
      if (i >= u8.length) throw new Error('ファイルが途中で切れています');
      b = u8[i++];
      result += (b & 127) * Math.pow(2, shift);
      shift += 7;
    } while (b & 128);
    return (result % 2 === 1) ? -(result + 1) / 2 : result / 2;
  };
  return {
    long, int: long,
    fixed: (n) => { const v = u8.subarray(i, i + n); i += n; return v; },
    bytes: () => { const n = long(); if (n < 0 || i + n > u8.length) throw new Error('ファイルの中身がおかしいです'); const v = u8.subarray(i, i + n); i += n; return v; },
    string: () => { const n = long(); if (n < 0 || i + n > u8.length) throw new Error('ファイルの中身がおかしいです'); const v = new TextDecoder().decode(u8.subarray(i, i + n)); i += n; return v; },
    array: (fn) => { const out = []; for (;;) { let n = long(); if (n === 0) break; if (n < 0) { n = -n; long(); } for (let k = 0; k < n; k++) out.push(fn()); } return out; },
  };
}

function _bdLeb(bytes, st) {
  let shift = 0, value = 0;
  while (st.i < bytes.length) {
    const b = bytes[st.i++];
    value += (b & 127) * Math.pow(2, shift);
    if ((b & 128) !== 128) break;
    shift += 7;
  }
  return value;
}

// 戻り値: { name, origin, size, blocks:Int32Array }(空気・Unloaded は入れない)
function parseBloxdSchem(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const r = _bdAvroReader(u8);
  r.fixed(4);
  const name = r.string();
  const origin = [r.int(), r.int(), r.int()];
  const size = [r.int(), r.int(), r.int()];
  if (!(size[0] > 0 && size[1] > 0 && size[2] > 0) || size[0] * size[1] * size[2] > 4e8) throw new Error('建築の大きさが読めませんでした');
  const chunks = r.array(() => ({ x: r.int(), y: r.int(), z: r.int(), blocks: r.bytes() }));
  const out = [];
  for (const c of chunks) {
    const st = { i: 0 };
    let idx = 0;
    while (st.i < c.blocks.length) {
      const amount = _bdLeb(c.blocks, st), id = _bdLeb(c.blocks, st);
      if (id > 1) {
        for (let k = 0; k < amount; k++) {
          const i = idx + k;
          const x = c.x * 32 + Math.floor(i / 1024), y = c.y * 32 + (Math.floor(i / 32) % 32), z = c.z * 32 + (i % 32);
          if (x < size[0] && y < size[1] && z < size[2]) out.push(x, y, z, id);
        }
      }
      idx += amount;
    }
  }
  return { name, origin, size, blocks: Int32Array.from(out) };
}


// ============================================================
// 建築の素材(読み込み・保存・公式の見本)
// ============================================================

function _bdNewId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function structureRegister(s) {
  structureAssets.set(s.id, s);
  if (!structureOrder.includes(s.id)) structureOrder.push(s.id);
  _bdThumbCache.delete(s.id);
}

async function structureImportFile(file) {
  let parsed;
  try { parsed = parseBloxdSchem(await file.arrayBuffer()); }
  catch (e) { showToast('この .bloxdschem は読めませんでした(' + (e && e.message || e) + ')'); return null; }
  if (!parsed.blocks.length) { showToast('この建築にはブロックがありませんでした'); return null; }
  const id = _bdNewId();
  const name = (parsed.name || (file.name || '建築').replace(/\.[^.]+$/, '')).slice(0, 32);
  const s = { id, name, size: parsed.size, blocks: parsed.blocks, added: Date.now() };
  structureRegister(s);
  const ok = (typeof idbPut === 'function') && await idbPut('structures', { id, name, size: s.size, blocks: s.blocks.buffer.slice(0), added: s.added });
  if (!ok) showToast('ブラウザに保存できなかったので、この建築はページを開いている間だけ使えます(プロジェクトを保存すると一緒に入ります)');
  return id;
}

async function structureDelete(id) {
  structureAssets.delete(id);
  structureOrder = structureOrder.filter(x => x !== id);
  if (typeof idbDelete === 'function') await idbDelete('structures', id);
}

let _bdInitDone = false;
async function buildInit() {
  if (_bdInitDone) return;
  _bdInitDone = true;
  await bdLoadIdTable();
  _bdAddBuiltins();
  const list = (typeof idbAll === 'function') ? await idbAll('structures') : [];
  list.sort((a, b) => (a.added || 0) - (b.added || 0));
  for (const e of list) {
    if (structureAssets.has(e.id)) continue;
    structureRegister({ id: e.id, name: e.name, size: e.size, blocks: new Int32Array(e.blocks), added: e.added });
  }
  if (typeof renderAssetList === 'function' && typeof activeAssetCategoryId !== 'undefined' && activeAssetCategoryId === 'build') renderAssetList();
}

// 公式の見本(エディタに最初から入っている小さな建築)
function _bdAddBuiltins() {
  const log = bdIdByName('Maple Log'), leaves = bdIdByName('Maple Leaves'), planks = bdIdByName('Maple Wood Planks');
  const stone = bdIdByName('Cobblestone') || bdIdByName('Stone'), glass = bdIdByName('Glass'), pine = bdIdByName('Pine Log'), pineL = bdIdByName('Pine Leaves');
  const put = (arr, x, y, z, id) => { if (id) arr.push(x, y, z, id); };
  if (log && leaves) {
    const a = [];
    for (let y = 0; y < 5; y++) put(a, 2, y, 2, log);
    for (let y = 3; y < 7; y++) for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
      const r = y >= 5 ? 1 : 2;
      if (Math.abs(x - 2) > r || Math.abs(z - 2) > r) continue;
      if (x === 2 && z === 2 && y < 5) continue;
      if (r === 2 && Math.abs(x - 2) === 2 && Math.abs(z - 2) === 2 && ((x * 7 + z * 3 + y) % 3 === 0)) continue;
      put(a, x, y, z, leaves);
    }
    structureRegister({ id: 'builtin:tree', name: '木(カエデ)', size: [5, 7, 5], blocks: Int32Array.from(a), builtin: true });
  }
  if (pine && pineL) {
    const a = [];
    for (let y = 0; y < 8; y++) put(a, 3, y, 3, pine);
    for (let y = 2; y < 10; y++) {
      const r = Math.max(0, Math.floor((9 - y) / 2.5));
      for (let x = 3 - r; x <= 3 + r; x++) for (let z = 3 - r; z <= 3 + r; z++) {
        if (x === 3 && z === 3 && y < 8) continue;
        if (Math.abs(x - 3) + Math.abs(z - 3) > r + 1) continue;
        put(a, x, y, z, pineL);
      }
    }
    structureRegister({ id: 'builtin:pine', name: '木(マツ)', size: [7, 10, 7], blocks: Int32Array.from(a), builtin: true });
  }
  if (planks && stone && log) {
    const a = [], W = 7, D = 6, H = 4;
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) put(a, x, 0, z, stone);
    for (let y = 1; y <= H; y++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
      const edge = x === 0 || x === W - 1 || z === 0 || z === D - 1;
      if (!edge) continue;
      const corner = (x === 0 || x === W - 1) && (z === 0 || z === D - 1);
      if (!corner && z === 0 && x === 3 && y <= 2) continue;                       // 戸口
      if (!corner && y === 2 && (x === 1 || x === 5) && (z === 0 || z === D - 1) && glass) { put(a, x, y, z, glass); continue; }
      put(a, x, y, z, corner ? log : planks);
    }
    for (let k = 0; k < 3; k++) for (let x = k - 1; x <= W - k; x++) for (let z = -1; z < D + 1; z++) {
      if (x < 0 || x >= W + 1 || z < 0 || z >= D) continue;
      if (x === k - 1 || x === W - k || k === 2) put(a, Math.min(W - 1, Math.max(0, x)), H + 1 + k, z, planks);
    }
    structureRegister({ id: 'builtin:hut', name: '小屋', size: [W, H + 4, D], blocks: Int32Array.from(a), builtin: true });
  }
}


// ============================================================
// 形(頂点)を作る。rot は 90 度ずつ。結果は回した後の大きさの箱(0〜size)の中
// ============================================================

const _bdMeshCache = new Map();   // key -> { vbo, ebo?, n, size, ... }
const _BD_ROT_DIR = [4, 5, 2, 3, 1, 0];   // 90度回すと +x→+z, -x→-z, +z→-x, -z→+x

function _bdOpaqueInfo(info, pal) {
  return !!info && info.type === 'cube' && pal && pal.asset_type !== '3d_model' && pal.asset_type !== 'model';
}

function _bdRand(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function _bdOrderValue(order, x, y, z, size) {
  const [sx, sy, sz] = size;
  if (order === 'all') return 0;
  if (order === 'random') return _bdRand(x, y, z);
  if (order === 'center') {
    const cx = (sx - 1) / 2, cy = 0, cz = (sz - 1) / 2;
    const d = Math.hypot(x - cx, (y - cy) * 0.6, z - cz), m = Math.hypot(cx, (sy - 1) * 0.6, cz) || 1;
    return Math.min(1, d / m);
  }
  const t = sy > 1 ? y / (sy - 1) : 0;
  const v = Math.min(1, Math.max(0, t * 0.88 + _bdRand(x, y, z) * 0.12));
  return order === 'top' ? 1 - v : v;
}

function _bdBuildMesh(s, rot, inOrder, outOrder) {
  const [sx, sy, sz] = s.size;
  const bl = s.blocks, n = bl.length / 4;
  // 場所 → 番号(空気は 0)。大きい建築は Map
  const vol = sx * sy * sz;
  const dense = vol <= 32e6 ? new Uint16Array(vol) : null;
  const map = dense ? null : new Map();
  const at = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
    const k = (x * sy + y) * sz + z;
    return dense ? dense[k] : (map.get(k) || 0);
  };
  for (let i = 0; i < n; i++) {
    const k = (bl[i * 4] * sy + bl[i * 4 + 1]) * sz + bl[i * 4 + 2];
    if (dense) dense[k] = bl[i * 4 + 3]; else map.set(k, bl[i * 4 + 3]);
  }
  // 番号ごとの描き方
  const infos = new Map();
  const infoOf = (id) => {
    if (infos.has(id)) return infos.get(id);
    const pal = _bdIdTable && _bdIdTable.get(id);
    let info = null;
    if (pal && typeof offPaletteInfo === 'function' && typeof fcUVRectsRaw !== 'undefined' && fcUVRectsRaw) info = offPaletteInfo(pal, fcUVRectsRaw);
    let rect = null;
    if (!info && pal && fcUVRectsRaw && fcUVRectsRaw.has(pal.texture)) rect = fcUVRectsRaw.get(pal.texture);
    const v = { info, rect, opaque: info ? _bdOpaqueInfo(info, pal) : !!rect && pal && pal.asset_type !== '3d_model' && pal.asset_type !== 'model',
      mat: typeof fcMaterialOf === 'function' ? fcMaterialOf(pal, info) : 0 };
    infos.set(id, v);
    return v;
  };
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const order6 = [0, 1, 2, 0, 2, 3];
  const cornerUV = FC_MIRROR_X ? [[1, 1], [0, 1], [0, 0], [1, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
  const vtx = [];     // 8個ずつ(地形と同じ)
  const ext = [];     // 5個ずつ: ブロックの真ん中 xyz・出る順・消える順
  const R = rot & 3;
  // 回した後の位置(ブロックの角の点 px,pz は 0〜sx / 0〜sz)
  const rotP = (px, pz) => {
    let x = px, z = pz, w = sx, d = sz;
    for (let k = 0; k < R; k++) { const nx = d - z, nz = x; x = nx; z = nz; const t = w; w = d; d = t; }
    return [x, z];
  };
  const brMap = new Map(DIR_FACTOR.map((v, d) => [v, d]));
  const rotBr = (b) => {
    if (!R) return b;
    let d = brMap.get(b);
    if (d == null) return b;
    for (let k = 0; k < R; k++) d = _BD_ROT_DIR[d];
    return DIR_FACTOR[d];
  };
  // ステップ51: 角の暗さ(地形と同じ決まり。建築の中のブロックだけで決める)
  const occAt = (x, y, z) => {
    const id = at(x, y, z);
    if (!id) return 0;
    const pal = _bdIdTable && _bdIdTable.get(id);
    return pal && pal.asset_type !== '3d_model' && pal.asset_type !== 'model' ? 1 : 0;
  };
  const AXS = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
  const aoOn = typeof fcAOEnabled === 'undefined' || fcAOEnabled;
  const AOV = (typeof FC_AO_VALUES !== 'undefined') ? FC_AO_VALUES : [1, 0.92, 0.8, 0.5];
  const aoLevels = (x, y, z, d) => {
    const [axis, sign] = AXS[d];
    const P = [x, y, z]; P[axis] += sign;
    const uv = [0, 1, 2].filter(a => a !== axis);
    const lv = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const o = FACE_OFFSETS[d][c];
      const du = o[uv[0]] ? 1 : -1, dv = o[uv[1]] ? 1 : -1;
      const A = P.slice(); A[uv[0]] += du;
      const B = P.slice(); B[uv[1]] += dv;
      const C = P.slice(); C[uv[0]] += du; C[uv[1]] += dv;
      const s1 = occAt(A[0], A[1], A[2]), s2 = occAt(B[0], B[1], B[2]);
      lv[c] = (s1 && s2) ? 3 : s1 + s2 + occAt(C[0], C[1], C[2]);
    }
    return lv;
  };
  const orderFlip = [1, 2, 3, 1, 3, 0];
  const rotDir = (d) => { for (let k = 0; k < R; k++) d = _BD_ROT_DIR[d]; return d; };
  const blockStart = [];
  for (let i = 0; i < n; i++) {
    const x = bl[i * 4], y = bl[i * 4 + 1], z = bl[i * 4 + 2], id = bl[i * 4 + 3];
    const v = infoOf(id);
    if (!v.info && !v.rect) continue;
    const start = vtx.length;
    const isShape = !!(v.info && v.info.type !== 'cube');
    if (isShape) {
      offPushShape(v.info, x, y, z, 0, 1e9, vtx);
    } else {
      for (let d = 0; d < 6; d++) {
        const nid = at(x + NB[d][0], y + NB[d][1], z + NB[d][2]);
        if (nid && infoOf(nid).opaque && v.opaque) continue;
        if (nid && nid === id && !v.opaque) continue;   // 同じガラス・葉どうしの間の面も出さない
        const rect = v.info ? v.info.rects[d] : v.rect;
        const lv = aoOn ? aoLevels(x, y, z, d) : [0, 0, 0, 0];
        const ord = (lv[0] + lv[2] > lv[1] + lv[3]) ? orderFlip : order6;
        const br = DIR_FACTOR[rotDir(d)];   // 回した後の向きの明るさ(角の暗さを掛けるので、あとで付けかえない)
        for (const oi of ord) {
          const o = FACE_OFFSETS[d][oi];
          const [cu, cv] = v.info ? offFaceCornerUV(d, o) : cornerUV[oi];
          vtx.push(x + o[0], y + o[1], z + o[2], rect[0] + cu * (rect[2] - rect[0]), rect[1] + cv * (rect[3] - rect[1]), br * AOV[lv[oi]] + v.mat * 2, 0, 1e9);
        }
      }
    }
    if (vtx.length === start) continue;
    // 回す・ブロックの真ん中・並び順
    const [cx, cz] = rotP(x + 0.5, z + 0.5);
    const oIn = _bdOrderValue(inOrder, x, y, z, s.size), oOut = _bdOrderValue(outOrder, x, y, z, s.size);
    for (let k = start; k < vtx.length; k += 8) {
      if (R) { const [px, pz] = rotP(vtx[k], vtx[k + 2]); vtx[k] = px; vtx[k + 2] = pz; if (isShape) vtx[k + 5] = rotBr(vtx[k + 5]); }
      if (isShape && v.mat) vtx[k + 5] += v.mat * 2;   // ステップ53: 材質
      ext.push(cx, y + 0.5, cz, oIn, oOut);
    }
    blockStart.push(start);
  }
  const size = (R & 1) ? [sz, sy, sx] : [sx, sy, sz];
  return { vtx: new Float32Array(vtx), ext: new Float32Array(ext), count: vtx.length / 8, size, cells: _bdCells(s, R) };
}

// 回した後の、ブロックのある場所の一覧(元のブロックを消す・当たり判定用)
function _bdCells(s, R) {
  const [sx, , sz] = s.size;
  const bl = s.blocks, out = new Int32Array(bl.length / 4 * 3);
  for (let i = 0, j = 0; i < bl.length; i += 4, j += 3) {
    let x = bl[i], z = bl[i + 2], w = sx, d = sz;
    for (let k = 0; k < R; k++) { const nx = d - 1 - z, nz = x; x = nx; z = nz; const t = w; w = d; d = t; }
    out[j] = x; out[j + 1] = bl[i + 1]; out[j + 2] = z;
  }
  return out;
}

function bdMeshFor(b) {
  const s = structureAssets.get(b.assetId);
  if (!s || !fcGl || !fcUVRectsRaw || !_bdIdTable) return null;
  const key = b.assetId + '|' + (b.rot & 3) + '|' + b.inAnim.order + '|' + b.outAnim.order;
  let m = _bdMeshCache.get(key);
  if (m) return m;
  const data = _bdBuildMesh(s, b.rot, b.inAnim.order, b.outAnim.order);
  const gl = fcGl;
  m = { count: data.count, size: data.size, cells: data.cells, vbo: gl.createBuffer(), ebuf: gl.createBuffer() };
  gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo); gl.bufferData(gl.ARRAY_BUFFER, data.vtx, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, m.ebuf); gl.bufferData(gl.ARRAY_BUFFER, data.ext, gl.STATIC_DRAW);
  _bdMeshCache.set(key, m);
  // 古い物を少し捨てる
  if (_bdMeshCache.size > 24) { const k0 = _bdMeshCache.keys().next().value; const o = _bdMeshCache.get(k0); gl.deleteBuffer(o.vbo); gl.deleteBuffer(o.ebuf); _bdMeshCache.delete(k0); }
  return m;
}

// 回した後の大きさ(メッシュが無くても分かる)
function bdSize(b) {
  const s = structureAssets.get(b.assetId);
  if (!s) return [1, 1, 1];
  return (b.rot & 1) ? [s.size[2], s.size[1], s.size[0]] : s.size.slice();
}


// ============================================================
// 描画(シェーダーで、出し方・消え方の動き)
// ============================================================

const BD_VS = `
  attribute vec3 aPos; attribute vec2 aUV; attribute float aBrightness;
  attribute vec3 aCenter; attribute float aOrderIn; attribute float aOrderOut;
  uniform mat4 uView; uniform mat4 uProj; uniform vec3 uOrigin;
  uniform float uT; uniform float uLen;
  uniform vec4 uIn; uniform vec4 uOut;   // type, 全体の秒, 1ブロックの秒, 高さ
  varying vec2 vUV; varying float vBrightness; varying float vMat;
` + FC_MOD_VS_COMMON + `
  __MODVERTEX__
  float ease(float p) { return 1.0 - (1.0 - p) * (1.0 - p) * (1.0 - p); }
  float back(float p) { float c = 1.9; float q = p - 1.0; return 1.0 + (c + 1.0) * q * q * q + c * q * q; }
  // p: 0 = まだ無い, 1 = できあがり。戻り値 xyz = 大きさ、w = 上下のずれ。大きさが 0 なら出さない
  vec4 anim(float type, float p, float h) {
    if (p <= 0.0) return vec4(0.0);
    if (p >= 1.0 || type < 0.5) return vec4(1.0, 1.0, 1.0, 0.0);
    if (type < 1.5) { float s = back(p); return vec4(s, s, s, 0.0); }
    if (type < 2.5) { float q = p * p; return vec4(1.0, 1.0, 1.0, (1.0 - q) * h); }
    if (type < 3.5) { return vec4(1.0, 1.0, 1.0, -(1.0 - ease(p)) * 1.05); }
    float e = ease(p); return vec4(e, e, e, -(1.0 - e) * 0.5);
  }
  float prog(vec4 a, float order, float t) {
    float each = max(0.001, a.z);
    float start = order * max(0.0, a.y - each);
    return clamp((t - start) / each, 0.0, 1.0);
  }
  void main() {
    float pIn = uIn.x < 0.5 ? 1.0 : (uT < 0.0 ? 0.0 : prog(uIn, aOrderIn, uT));
    float tOut = uT - (uLen - uOut.y);
    float pOut = uOut.x < 0.5 ? 1.0 : (tOut <= 0.0 ? 1.0 : 1.0 - prog(uOut, aOrderOut, tOut));
    vec4 a = anim(uIn.x, pIn, uIn.w);
    vec4 b = anim(uOut.x, pOut, uOut.w);
    vec3 s = a.xyz * b.xyz;
    if (s.x <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
    else {
      vec3 p = aCenter + (aPos - aCenter) * s + vec3(0.0, a.w + b.w, 0.0);
      vec3 wp = p + uOrigin;
#ifdef MOD_VERTEX
      wp = modVertex(wp + uModOrigin, aCenter - vec3(0.5) + uOrigin + uModOrigin, floor(aBrightness / 2.0)) - uModOrigin;
#endif
      gl_Position = uProj * uView * vec4(wp, 1.0);
    }
    float mat = floor(aBrightness / 2.0);
    vUV = aUV; vBrightness = aBrightness - mat * 2.0; vMat = mat;
  }`;

let _bdProg = null;
function _bdProgram(gl) {
  if (_bdProg) return _bdProg;
  const vs = fcCompileShader(gl.VERTEX_SHADER, BD_VS.replace('__MODVERTEX__', typeof fcModVertexSource === 'function' ? fcModVertexSource() : ''));
  const fs = fcCompileShader(gl.FRAGMENT_SHADER, FC_FRAGMENT_SHADER_SRC);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('建築のシェーダーを作れませんでした: ' + gl.getProgramInfoLog(p));
  const A = (n) => gl.getAttribLocation(p, n), U = (n) => gl.getUniformLocation(p, n);
  _bdProg = { p, aPos: A('aPos'), aUV: A('aUV'), aBr: A('aBrightness'), aCenter: A('aCenter'), aOIn: A('aOrderIn'), aOOut: A('aOrderOut'),
    uView: U('uView'), uProj: U('uProj'), uOrigin: U('uOrigin'), uT: U('uT'), uLen: U('uLen'), uIn: U('uIn'), uOut: U('uOut'), uTex: U('uTexture'),
    mod: typeof fcModVertexLocs === 'function' ? fcModVertexLocs(gl, p) : null };
  return _bdProg;
}
// ステップ53: 影MOD の形を動かすコードが変わった時(freecam.js の fcSetModVertex から)
function bdResetProgram() { if (_bdProg && fcGl) fcGl.deleteProgram(_bdProg.p); _bdProg = null; }

// out = 消え方(落ちる時は下へ)
function _bdAnimVec(a, out) {
  const t = BUILD_TYPE_ID[a.type] || 0;
  const sec = Math.max(0.05, a.sec || 1);
  const each = Math.min(sec, a.type === 'drop' ? 0.6 : 0.35);
  return [t, sec, each, (a.height || 10) * (out ? -1 : 1)];
}

function bdVisibleAt(b, frame) { return frame >= b.startTick && frame < b.endTick; }

function renderBuilds(gl, view, proj, frame) {
  _bdHideSync();
  if (!buildBlocks.length || !fcTexture) return;
  let P;
  try { P = _bdProgram(gl); } catch (e) { console.warn(e); return; }
  const tps = scTps();
  let used = false;
  for (const b of buildBlocks) {
    if (!bdVisibleAt(b, frame)) continue;
    const m = bdMeshFor(b);
    if (!m || !m.count) continue;
    if (!used) {
      used = true;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.uView, false, view);
      gl.uniformMatrix4fv(P.uProj, false, proj);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fcTexture);
      gl.uniform1i(P.uTex, 0);
      gl.enable(gl.DEPTH_TEST);
      if (P.mod) { gl.uniform1f(P.mod.matPass, window._shmodMatPass ? 1 : 0); if (typeof fcModVertex !== 'undefined' && fcModVertex) fcApplyModVertexUniforms(gl, P.mod); }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.enableVertexAttribArray(P.aPos); gl.vertexAttribPointer(P.aPos, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(P.aUV); gl.vertexAttribPointer(P.aUV, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(P.aBr); gl.vertexAttribPointer(P.aBr, 1, gl.FLOAT, false, 32, 20);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.ebuf);
    gl.enableVertexAttribArray(P.aCenter); gl.vertexAttribPointer(P.aCenter, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(P.aOIn); gl.vertexAttribPointer(P.aOIn, 1, gl.FLOAT, false, 20, 12);
    gl.enableVertexAttribArray(P.aOOut); gl.vertexAttribPointer(P.aOOut, 1, gl.FLOAT, false, 20, 16);
    gl.uniform3f(P.uOrigin, b.pos[0], b.pos[1], b.pos[2]);
    gl.uniform1f(P.uT, (frame - b.startTick) / tps);
    gl.uniform1f(P.uLen, (b.endTick - b.startTick) / tps);
    gl.uniform4fv(P.uIn, _bdAnimVec(b.inAnim));
    gl.uniform4fv(P.uOut, _bdAnimVec(b.outAnim, true));
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }
  if (used) {
    gl.disableVertexAttribArray(P.aCenter); gl.disableVertexAttribArray(P.aOIn); gl.disableVertexAttribArray(P.aOOut);
  }
}

// 地形の描き方(blockfx.js の renderBlockFx)の後に、建築も描く(編集視点・プレビュー・書き出しの全部)
if (typeof renderBlockFx === 'function') {
  const _bdOrigRenderBlockFx = renderBlockFx;
  renderBlockFx = function (gl, view, proj, frame) {
    _bdOrigRenderBlockFx(gl, view, proj, frame);
    try { renderBuilds(gl, view, proj, frame); } catch (e) { console.warn('[建築] 描けませんでした:', e); }
  };
}

// 選んでいる建築の枠(3D の編集視点)
function renderBuildGizmos(gl, view, proj, W, H) {
  const b = buildGetSelected();
  if (!b) return;
  const sz = bdSize(b), p = b.pos;
  const c = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]].map(v => [p[0] + v[0] * sz[0], p[1] + v[1] * sz[1], p[2] + v[2] * sz[2]]);
  const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const on = bdVisibleAt(b, curTick);
  _drawLineSegments(gl, view, proj, E.flatMap(([a, d]) => [c[a], c[d]]), on ? [1, 0.62, 0.25] : [0.6, 0.55, 0.5], W, H, (buildDrag ? 3 : 2));
}


// ============================================================
// 建築がある所の、リプレイのブロックを消す(freecam.js の _pushFaceVertices が使う)
// ============================================================

let _bdHideSig = '[]', _bdHideMap = null, _bdHideTimer = null;
function _bdTickVal(frame) { return (typeof _pfTickVal === 'function') ? _pfTickVal(frame) : frame; }

// ステップ50c: 場所は1つの数(_fcPosKey)。建築の形(回した後のマス)は覚えておく。触るチャンクの一覧も返す
const _bdCellsCache = new Map();
function _bdCellsCached(s, R) {
  const k = s.id + '|' + R;
  let c = _bdCellsCache.get(k);
  if (!c || c.src !== s.blocks) { c = { src: s.blocks, cells: _bdCells(s, R) }; _bdCellsCache.set(k, c); }
  return c.cells;
}
function _bdComputeHide() {
  const m = new Map(), chunks = new Set();
  for (const b of buildBlocks) {
    if (!b.hideWorld || b.id === _bdSkipId) continue;
    const s = structureAssets.get(b.assetId);
    if (!s) continue;
    const cells = _bdCellsCached(s, b.rot & 3);
    const iv = [_bdTickVal(b.startTick), _bdTickVal(b.endTick)];
    const ox = b.pos[0] + worldOriginX, oy = b.pos[1] + worldOriginY, oz = b.pos[2] + worldOriginZ;
    for (let j = 0; j < cells.length; j += 3) {
      const x = cells[j] + ox, y = cells[j + 1] + oy, z = cells[j + 2] + oz;
      const k = _fcPosKey(x, y, z);
      const l = m.get(k);
      if (l) l.push(iv); else { m.set(k, [iv]); chunks.add(fcChunkKeyOf(x, y, z)); }
    }
  }
  return { m, chunks };
}

// [出る, 消える] から、隠す区間を引いた区間の列
function _bdSubtract(reveal, hide, hs) {
  let out = [[reveal, hide]];
  for (const [a, b] of hs) {
    const nx = [];
    for (const [s, e] of out) {
      if (b <= s || a >= e) { nx.push([s, e]); continue; }
      if (a > s) nx.push([s, a]);
      if (b < e) nx.push([b, e]);
    }
    out = nx;
  }
  return out;
}

// ステップ49b: 地形を作り直さずに、その場所の面の「出る・消える時刻」を直接書きかえる(軽い)
//   2つに分かれる面は、残りの区間を別の小さな入れ物(freecam.js の fcSetExtraFaces)に入れる
// ステップ50: 地形の面は数の並びで持つようになったので、建築の範囲の中の面だけを毎回さがす(全部の場所の表は作らない)
let _bdPatched = new Map();      // 面の番号 -> [元の出る時刻, 元の消える時刻]
let _bdPatchGen = -1;
let _bdNeedApply = false, _bdLastApply = 0;

function bdApplyHide() {
  if (!fcGl || typeof fcMeshFaces === 'undefined' || typeof fcFaceTicks !== 'function') return;
  _bdNeedApply = false;
  _bdLastApply = performance.now();
  if (_bdPatchGen !== fcTerrainGen) { _bdPatched = new Map(); _bdPatchGen = fcTerrainGen; }
  const { m: H, chunks } = _bdComputeHide();
  _bdHideMap = H.size ? H : null;
  // ステップ50c: 地形の面を全部さがさず、建築が触るチャンクの面だけを見る(freecam.js のチャンクごとの面の一覧)
  const want = new Map();   // 面の番号 -> 消す区間
  if (H.size) {
    const D = fcMeshFaces.d;
    for (const ck of chunks) {
      const list = fcFacesInChunk(ck);
      if (!list) continue;
      for (let q = 0; q < list.length; q++) {
        const i = list[q];
        if (!fcFaceDrawn(i)) continue;
        const o = i * 8, hs = H.get(_fcPosKey(D[o], D[o + 1], D[o + 2]));
        if (hs) want.set(i, hs);
      }
    }
  }
  // もう消さなくていい面は元に戻す(変わる所だけ書く。GPU へはまとめて送る)
  for (const [i, o] of _bdPatched) if (!want.has(i)) { fcSetFaceTicksLazy(i, o[0], o[1]); _bdPatched.delete(i); }
  // 消す面
  const extraInst = new InstBuf(64), extraShape = new GrowF32(8 * 64);
  for (const [i, hs] of want) {
    let o = _bdPatched.get(i);
    if (!o) { o = fcFaceTicks(i); if (!o) continue; _bdPatched.set(i, o); }
    const ivs = _bdSubtract(o[0], o[1], hs);
    if (!ivs.length) fcSetFaceTicksLazy(i, 1e9, 0);
    else {
      fcSetFaceTicksLazy(i, ivs[0][0], ivs[0][1]);
      for (let j = 1; j < ivs.length; j++) fcCopyFaceWithTicks(i, ivs[j][0], ivs[j][1], extraInst, extraShape);
    }
  }
  fcFlushFaceTicks();
  fcSetExtraFaces(extraInst, extraShape);
}

// freecam.js: 地形の頂点を送り直した時(作り直し・続きが届いた時)。消す所があればかけ直す
function bdOnTerrainUploaded() { if (_bdHideSig !== '[]') _bdNeedApply = true; }

// 毎コマ: 消す所が変わったら、かけ直す
// ステップ50d: 動かしている最中は確定させない(増田さん)。
//   3Dでドラッグ中の建築は「消す」から外す(つかんだ時に1回だけ元に戻す)。離した時に1回だけ消し直す。
//   タイムラインで長さ・時刻を動かしている間は何もしない(離した時に1回だけ)
let _bdSkipId = null;
function _bdHideSync() {
  if (typeof tlDrag !== 'undefined' && tlDrag) return;
  _bdSkipId = (buildDrag && !buildDrag.pending) ? buildDrag.id : null;
  const sig = JSON.stringify(buildBlocks.filter(b => b.hideWorld && b.id !== _bdSkipId).map(b => [b.assetId, b.pos, b.rot & 3, b.startTick, b.endTick]));
  if (sig !== _bdHideSig) { _bdHideSig = sig; _bdNeedApply = true; }
  if (!_bdNeedApply) return;
  try { bdApplyHide(); } catch (e) { console.warn('[建築] 元のブロックを消せませんでした:', e); _bdNeedApply = false; }
}


// ============================================================
// 作る・分ける・複製・消す
// ============================================================

function buildAddBlock(tick, assetId, props) {
  props = props || {};
  const s = structureAssets.get(assetId);
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(tick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.round((props.seconds || 8) * scTps());
  if (maxTick > 0) end = Math.min(end, maxTick);
  const b = {
    id: nextBuildBlockId++, kind: 'build', name: props.name || (s ? s.name : '建築'), assetId,
    startTick: start, endTick: Math.max(start + 1, end),
    pos: (props.pos || [0, 0, 0]).map(Math.round), rot: props.rot || 0,
    inAnim: props.inAnim || { type: 'none', order: 'bottom', sec: Math.min(3, Math.max(0.6, ((s && s.blocks.length / 4) || 40) / 60)) },
    outAnim: props.outAnim || { type: 'none', order: 'top', sec: 1 },
    hideWorld: props.hideWorld !== false,
  };
  buildBlocks.push(b);
  return b;
}

function buildDeleteBlock(id) { buildBlocks = buildBlocks.filter(b => b.id !== id); }
function buildSplitBlock(b, tick) {
  if (tick <= b.startTick || tick >= b.endTick) return null;
  const r = JSON.parse(JSON.stringify(b));
  r.id = nextBuildBlockId++;
  r.startTick = tick;
  r.inAnim = { ...r.inAnim, type: 'none' };      // 右側は最初からある
  b.outAnim = { ...b.outAnim, type: 'none' };
  b.endTick = tick;
  buildBlocks.push(r);
  return r;
}
function buildDuplicateBlock(b) {
  const d = JSON.parse(JSON.stringify(b));
  d.id = nextBuildBlockId++;
  const sz = bdSize(b);
  d.pos = [b.pos[0] + sz[0] + 1, b.pos[1], b.pos[2]];   // 横に並べる(同じ時刻)
  buildBlocks.push(d);
  return d;
}

function selectBuild(id) {
  if (typeof clearSelection === 'function') { const keep = id; clearSelection(); selectedBuildId = keep; }
  else selectedBuildId = id;
  if (typeof setTimelineTab === 'function') setTimelineTab('global');
  editorChanged();
}

// 置く場所: ドロップした所(か画面の真ん中)の先の地面。建築の下のまん中がそこに来る
function _bdPlacement(assetId) {
  const s = structureAssets.get(assetId);
  const size = s ? s.size : [1, 1, 1];
  let mx = fcCanvas.width / 2, my = fcCanvas.height / 2;
  const dp = (typeof pfDropClientPoint !== 'undefined') ? pfDropClientPoint : null;
  if (dp) { const r = fcCanvas.getBoundingClientRect(); mx = dp.x - r.left; my = dp.y - r.top; }
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  const hit = (typeof pfRaycastLocal === 'function') ? pfRaycastLocal(ray.origin, ray.dir, 120, _bdTickVal(curTick)) : null;
  const p = hit ? hit.pos : [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * 12);
  return [Math.floor(p[0] - size[0] / 2 + 0.5), Math.floor(p[1] + 0.001), Math.floor(p[2] - size[2] / 2 + 0.5)];
}

function addBuildAsset(key, tick) {
  const assetId = String(key).slice(6);
  if (!structureAssets.has(assetId)) { showToast('この建築が見つかりませんでした'); return; }
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = false;
  pushUndo();
  const b = buildAddBlock(tick, assetId, { pos: _bdPlacement(assetId) });
  if (curTick < b.startTick || curTick >= b.endTick) seekTo(b.startTick);
  selectBuild(b.id);
  showToast(`「${b.name}」を置きました(ドラッグで動かす・Shift で上下)`);
}


// ============================================================
// 3D の操作: クリックで選ぶ・ドラッグで動かす(水平。Shift で上下)
// ============================================================

let buildDrag = null;

function _bdRayBox(ray, b) {
  const sz = bdSize(b), lo = b.pos, hi = [b.pos[0] + sz[0], b.pos[1] + sz[1], b.pos[2] + sz[2]];
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = ray.dir[i], o = ray.origin[i];
    if (Math.abs(d) < 1e-9) { if (o < lo[i] || o > hi[i]) return null; continue; }
    let a = (lo[i] - o) / d, c = (hi[i] - o) / d;
    if (a > c) { const t = a; a = c; c = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}

function _bdPick(mx, my) {
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  let best = null, bestT = Infinity;
  for (const b of buildBlocks) {
    if (!bdVisibleAt(b, curTick) && b.id !== selectedBuildId) continue;
    const t = _bdRayBox(ray, b);
    if (t != null && t < bestT) { bestT = t; best = b; }
  }
  return best ? { b: best, t: bestT, ray } : null;
}

function buildMouseDown(e, mx, my) {
  const hit = _bdPick(mx, my);
  if (!hit) return false;
  const b = hit.b;
  if (selectedBuildId !== b.id) selectBuild(b.id);
  const p = [0, 1, 2].map(i => hit.ray.origin[i] + hit.ray.dir[i] * hit.t);
  beginEdit();
  buildDrag = { id: b.id, start: b.pos.slice(), grab: p, vertical: !!e.shiftKey, startMouse: [mx, my], pending: true };
  poseDrag = { build: true };   // freecam.js のマウスの動き・離すは poseDragMove / poseDragEnd に来る
  return true;
}

function buildDragMove(mx, my) {
  const d = buildDrag, b = d && buildGet(d.id);
  if (!b) return;
  if (d.pending && Math.hypot(mx - d.startMouse[0], my - d.startMouse[1]) < 3) return;
  d.pending = false;
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  let n;
  if (d.vertical) { const { forward } = fcGetCameraVectors(fcYaw, fcPitch); const l = Math.hypot(forward[0], forward[2]) || 1; n = [forward[0] / l, 0, forward[2] / l]; }
  else n = [0, 1, 0];
  const hit = scRayPlaneIntersect(ray, d.grab, n);
  if (!hit) return;
  const w = [0, 1, 2].map(i => hit[i] - d.grab[i]);
  if (d.vertical) b.pos = [d.start[0], Math.round(d.start[1] + w[1]), d.start[2]];
  else b.pos = [Math.round(d.start[0] + w[0]), d.start[1], Math.round(d.start[2] + w[2])];
}

function buildDragEnd() {
  buildDrag = null;
  commitEdit();
  editorChanged();
}

function buildHoverAt(mx, my) { return _bdPick(mx, my) ? 'grab' : false; }

function buildContextHint() {
  const b = buildGetSelected();
  if (!b) return null;
  if (buildDrag && !buildDrag.pending) return buildDrag.vertical ? `${b.name}: 上下に動かしています` : `${b.name}: 水平に動かしています(Shift で上下)`;
  return `${b.name}: ドラッグで動かす · Shift+ドラッグで上下 · 右のパネルで向き・出し方`;
}

// freecam.js の mousedown は poseMouseDown を呼ぶ。人・ギズモが先、何も無ければ建築
if (typeof poseMouseDown === 'function') {
  const _bdOrigPoseMouseDown = poseMouseDown;
  poseMouseDown = function (e, mx, my) {
    if (_bdOrigPoseMouseDown(e, mx, my)) return true;
    if ((typeof previewIsMain !== 'undefined' && previewIsMain) || (typeof pilot !== 'undefined' && pilot)) return false;
    return buildMouseDown(e, mx, my);
  };
}
// 3D の上の、選んでいる建築の枠・下のヒント
if (typeof renderPoseGizmos === 'function') {
  const _bdOrigRenderPoseGizmos = renderPoseGizmos;
  renderPoseGizmos = function (gl, view, proj, W, H) {
    _bdOrigRenderPoseGizmos(gl, view, proj, W, H);
    try { renderBuildGizmos(gl, view, proj, W, H); } catch (e) { /* 枠が描けなくても続ける */ }
  };
}
if (typeof poseContextHint === 'function') {
  const _bdOrigPoseContextHint = poseContextHint;
  poseContextHint = function () { return _bdOrigPoseContextHint() || buildContextHint(); };
}
if (typeof poseHoverAt === 'function') {
  const _bdOrigPoseHoverAt = poseHoverAt;
  poseHoverAt = function (mx, my) {
    const r = _bdOrigPoseHoverAt(mx, my);
    if (r) return r;
    if ((typeof previewIsMain !== 'undefined' && previewIsMain) || (typeof pilot !== 'undefined' && pilot)) return false;
    return buildHoverAt(mx, my);
  };
}


// ============================================================
// タイムライン「建築」の行
// ============================================================

function renderBuildTrackBlocks() {
  const lane = document.getElementById('timelineBuildLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const sorted = buildBlocks.slice().sort((a, c) => a.startTick - c.startTick);
  const rowEnds = [], rows = new Map();
  for (const b of sorted) {
    let r = rowEnds.findIndex(end => end <= b.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = b.endTick; rows.set(b.id, r);
  }
  const h = Math.max(1, rowEnds.length) * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick(), tps = scTps();
  for (const b of buildBlocks) {
    const el = document.createElement('div');
    el.className = 'tlBlock build' + (b.id === selectedBuildId ? ' selected' : '');
    el.style.left = (b.startTick * ppt) + 'px';
    const w = Math.max(6, (b.endTick - b.startTick) * ppt);
    el.style.width = w + 'px';
    el.style.top = ((rows.get(b.id) || 0) * TL_ROW_H + 3) + 'px';
    // 出し方・消え方の長さ
    if (b.inAnim.type !== 'none') { const f = _el('div', 'tlBuildAnim in'); f.style.width = Math.min(w, b.inAnim.sec * tps * ppt) + 'px'; el.appendChild(f); }
    if (b.outAnim.type !== 'none') { const f = _el('div', 'tlBuildAnim out'); f.style.width = Math.min(w, b.outAnim.sec * tps * ppt) + 'px'; el.appendChild(f); }
    el.appendChild(_el('div', 'tlBlockLabel', b.name));
    _addResizeHandles(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail >= 2) {
        e.stopPropagation(); e.preventDefault();
        tlDrag = null;
        selectBuild(b.id);
        openEditPanel(b);
        return;
      }
      tlStartBlockDrag(e, 'build', b);
    });
    lane.appendChild(el);
  }
  if (!buildBlocks.length) lane.appendChild(_el('div', 'tlEmpty', 'ここに落とすと建築を置きます'));
}


// ============================================================
// 右のパネル
// ============================================================

function renderBuildEditFields(title, body, b) {
  title.innerText = b.name;
  const s = structureAssets.get(b.assetId);
  const sub = document.getElementById('editPanelSub');
  const sz = bdSize(b);
  if (sub) sub.textContent = `建築 · ${sz[0]}×${sz[1]}×${sz[2]} · ブロック ${s ? (s.blocks.length / 4).toLocaleString() : '?'}個`;
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };
  const pills = (list, cur, onPick) => {
    const g = _el('div', 'settingsRadioGroup');
    for (const [id, label] of list) {
      const p = _el('button', 'settingsRadioPill small' + (cur === id ? ' active' : ''), label);
      p.type = 'button';
      p.addEventListener('click', () => { if (cur === id) return; pushUndo(); onPick(id); editorChanged(); });
      g.appendChild(p);
    }
    body.appendChild(g);
  };
  const slider = (label, min, max, step, val, unit, onInput) => {
    const r = row(label);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
    const v = _el('span', 'fieldValue', val + unit);
    bindEditUndo(inp);
    inp.addEventListener('input', () => { const x = parseFloat(inp.value); onInput(x); v.innerText = x + unit; renderBuildTrackBlocks(); });
    r.appendChild(inp); r.appendChild(v);
  };

  const nameRow = row('名前');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = b.name;
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { b.name = nameInput.value; renderBuildTrackBlocks(); });
  nameRow.appendChild(nameInput);

  sec('置く場所と向き');
  const posRow = _el('div', 'fieldRow');
  posRow.appendChild(_el('label', null, '位置'));
  ['X', 'Y', 'Z'].forEach((ax, i) => {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '1'; inp.className = 'panelInput small'; inp.title = ax;
    inp.value = Math.round(b.pos[i] + [worldOriginX, worldOriginY, worldOriginZ][i]);
    bindEditUndo(inp);
    inp.addEventListener('change', () => { const v = parseInt(inp.value, 10); if (isFinite(v)) { b.pos[i] = v - [worldOriginX, worldOriginY, worldOriginZ][i]; editorChanged(); } });
    posRow.appendChild(inp);
  });
  body.appendChild(posRow);
  const rotRow = _el('div', 'genActions');
  const rb = (label, d) => {
    const x = _el('button', 'btn btn-ghost btn-sm', label);
    x.addEventListener('click', () => {
      pushUndo();
      // 真ん中を中心に回す(四角でない建築も、だいたい同じ所に)
      const a = bdSize(b);
      b.rot = (b.rot + d + 4) & 3;
      const c = bdSize(b);
      b.pos = [b.pos[0] + Math.round((a[0] - c[0]) / 2), b.pos[1], b.pos[2] + Math.round((a[2] - c[2]) / 2)];
      editorChanged();
    });
    rotRow.appendChild(x);
  };
  rb('左へ90°回す', 3); rb('右へ90°回す', 1);
  body.appendChild(rotRow);
  const look = _el('button', 'btn btn-ghost btn-sm', 'この建築が見える所へ移動');
  look.addEventListener('click', () => {
    const c = [b.pos[0] + sz[0] / 2, b.pos[1] + sz[1] / 2, b.pos[2] + sz[2] / 2];
    const r = Math.max(sz[0], sz[1], sz[2]) * 1.4 + 4;
    fcPos = [c[0] + r * 0.6, c[1] + r * 0.5, c[2] + r * 0.6];
    const d = [c[0] - fcPos[0], c[1] - fcPos[1], c[2] - fcPos[2]];
    fcYaw = Math.atan2(d[0], d[2]); fcPitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
    if (typeof markViewMoved === 'function') markViewMoved();
  });
  body.appendChild(look);

  sec('出し方');
  pills(BUILD_IN_TYPES, b.inAnim.type, (id) => { b.inAnim.type = id; });
  if (b.inAnim.type !== 'none') {
    pills(BUILD_ORDERS, b.inAnim.order, (id) => { b.inAnim.order = id; });
    slider('かける時間', 0.2, 20, 0.1, b.inAnim.sec, '秒', (x) => { b.inAnim.sec = x; });
    if (b.inAnim.type === 'drop') slider('落ちる高さ', 2, 60, 1, b.inAnim.height || 10, 'ブロック', (x) => { b.inAnim.height = x; });
  }

  sec('消え方');
  pills(BUILD_OUT_TYPES, b.outAnim.type, (id) => { b.outAnim.type = id; });
  if (b.outAnim.type !== 'none') {
    pills(BUILD_ORDERS, b.outAnim.order, (id) => { b.outAnim.order = id; });
    slider('かける時間', 0.2, 20, 0.1, b.outAnim.sec, '秒', (x) => { b.outAnim.sec = x; });
    if (b.outAnim.type === 'drop') slider('落ちる深さ', 2, 60, 1, b.outAnim.height || 10, 'ブロック', (x) => { b.outAnim.height = x; });
  }

  sec('そのほか');
  const hw = _el('label', 'scriptCheck');
  const hc = document.createElement('input');
  hc.type = 'checkbox'; hc.checked = !!b.hideWorld;
  hc.addEventListener('change', () => { pushUndo(); b.hideWorld = hc.checked; editorChanged(); });
  hw.appendChild(hc); hw.appendChild(document.createTextNode('置いた所の、リプレイのブロックを消す'));
  body.appendChild(hw);
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
  durRow.appendChild(dur); durRow.appendChild(_el('span', 'fieldUnit', '秒'));

  const actions = _el('div', 'panelActions');
  const del = _el('button', 'btn btn-ghost btn-sm dangerBtn', 'この建築を消す');
  del.addEventListener('click', () => { selectBuild(b.id); deleteSelection(); });
  actions.appendChild(del);
  body.appendChild(actions);
}


// ============================================================
// 素材の一覧「建築」
// ============================================================

const _bdThumbCache = new Map();
let _bdTexImgs = new Map();
function _bdTexImage(name) {
  if (_bdTexImgs.has(name)) return _bdTexImgs.get(name);
  const url = (typeof textureUrls !== 'undefined' && textureUrls) ? textureUrls.get(name) : null;
  if (!url) { _bdTexImgs.set(name, null); return null; }
  const img = new Image();
  const p = new Promise((res) => { img.onload = () => res(img); img.onerror = () => res(null); });
  img.src = url;
  _bdTexImgs.set(name, p);
  return p;
}

// 上から見た図(いちばん上のブロックの、上の面の絵)
async function _bdThumb(s) {
  if (_bdThumbCache.has(s.id)) return _bdThumbCache.get(s.id);
  const pr = (async () => {
    const [sx, , sz] = s.size;
    const W = 160, H = 96;
    const cell = Math.max(1, Math.min(16, Math.floor(Math.min(W / sx, H / sz))));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const top = new Map();
    const bl = s.blocks;
    for (let i = 0; i < bl.length; i += 4) {
      const k = bl[i] + ',' + bl[i + 2], cur = top.get(k);
      if (!cur || bl[i + 1] > cur[0]) top.set(k, [bl[i + 1], bl[i + 3]]);
    }
    const ox = Math.floor((W - sx * cell) / 2), oz = Math.floor((H - sz * cell) / 2);
    const sy = s.size[1] || 1;
    for (const [k, [y, id]] of top) {
      const [x, z] = k.split(',').map(Number);
      const e = _bdIdTable && _bdIdTable.get(id);
      let tex = e && e.texture;
      const ob = e && typeof OFFBLK !== 'undefined' && OFFBLK.blocks ? OFFBLK.blocks[e.root_name] : null;
      if (ob && ob.cube) tex = ob.cube[2] || tex;
      const img = tex ? await _bdTexImage(tex) : null;
      if (img) ctx.drawImage(img, ox + x * cell, oz + z * cell, cell, cell);
      else { ctx.fillStyle = '#777'; ctx.fillRect(ox + x * cell, oz + z * cell, cell, cell); }
      // 低い所は暗く
      const dark = 0.45 * (1 - (y + 1) / sy);
      if (dark > 0.02) { ctx.fillStyle = `rgba(0,0,0,${dark.toFixed(3)})`; ctx.fillRect(ox + x * cell, oz + z * cell, cell, cell); }
    }
    return cv.toDataURL();
  })();
  _bdThumbCache.set(s.id, pr);
  return pr;
}

function renderBuildAssets(list, source) {
  if (!_bdInitDone) buildInit();
  const ids = structureOrder.filter(id => { const s = structureAssets.get(id); return s && (source === 'official' ? s.builtin : !s.builtin); });
  if (source === 'custom') {
    const tools = _div('assetTools');
    const btn = _el('button', 'btn btn-ghost btn-sm', '.bloxdschem を読み込む');
    btn.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.bloxdschem'; inp.multiple = true;
      inp.addEventListener('change', async () => {
        let n = 0;
        for (const f of Array.from(inp.files || [])) if (await structureImportFile(f)) n++;
        if (n) showToast(`建築を ${n} 個読み込みました。3D画面へドラッグして置けます`);
        renderAssetList();
      });
      inp.click();
    });
    tools.appendChild(btn);
    list.appendChild(tools);
  }
  const grid = _div('assetGrid');
  for (const id of ids) {
    const s = structureAssets.get(id);
    const card = _makeCard('build:' + id, 'build', '', s.name, `${s.size[0]}×${s.size[1]}×${s.size[2]} · ${(s.blocks.length / 4).toLocaleString()}個`, null);
    const nb = s.blocks.length / 4;
    card.dataset.tags = [source === 'official' ? '公式' : 'カスタム', nb < 300 ? '小さい' : nb < 5000 ? '中くらい' : '大きい'].join(',');
    const th = card.querySelector('.assetThumb');
    th.classList.add('buildThumb');
    _bdThumb(s).then(url => { th.style.backgroundImage = `url(${url})`; });
    if (!s.builtin) {
      const btns = _div('assetCardBtns');
      const del = _el('button', 'assetCardBtn', '✕');
      del.type = 'button'; del.title = 'この建築を一覧から消す';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (buildBlocks.some(b => b.assetId === id)) { showToast('タイムラインで使っている建築は消せません'); return; }
        await structureDelete(id);
        renderAssetList();
      });
      btns.appendChild(del);
      card.appendChild(btns);
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
}

// .bloxdschem を 3D 画面・タイムラインにそのまま落としても読み込む
function setupBuildFileDrop() {
  const isSchem = (e) => e.dataTransfer && Array.from(e.dataTransfer.items || []).some(it => it.kind === 'file');
  for (const el of [document.getElementById('freecamArea'), document.getElementById('timelineScroll')]) {
    if (!el || el._bdDrop) continue;
    el._bdDrop = true;
    el.addEventListener('dragover', (e) => { if (isSchem(e)) e.preventDefault(); });
    el.addEventListener('drop', async (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /\.bloxdschem$/i.test(f.name));
      if (!files.length) return;
      e.preventDefault(); e.stopPropagation();
      await buildInit();
      for (const f of files) {
        const id = await structureImportFile(f);
        if (!id) continue;
        if (typeof pfDropClientPoint !== 'undefined') pfDropClientPoint = { x: e.clientX, y: e.clientY };
        try { addBuildAsset('build:' + id, el.id === 'timelineScroll' ? tlTickFromClientX(e.clientX) : curTick); }
        finally { if (typeof pfDropClientPoint !== 'undefined') pfDropClientPoint = null; }
      }
      if (typeof renderAssetList === 'function') renderAssetList();
    }, true);
  }
}

// プロジェクトの保存に入れる / 開く時に戻す
function buildMediaForProject(state) {
  const ids = new Set((state.buildBlocks || []).map(b => b.assetId).filter(id => !String(id).startsWith('builtin:')));
  return [...ids].map(id => {
    const s = structureAssets.get(id);
    return s ? { id, name: s.name, size: s.size, data: _b64FromBytes(s.blocks.buffer) } : null;
  }).filter(Boolean);
}
async function buildRestoreMedia(list) {
  for (const m of list || []) {
    if (structureAssets.has(m.id)) continue;
    const blocks = new Int32Array(_bytesFromB64(m.data));
    structureRegister({ id: m.id, name: m.name, size: m.size, blocks, added: Date.now() });
    if (typeof idbPut === 'function') idbPut('structures', { id: m.id, name: m.name, size: m.size, blocks: blocks.buffer.slice(0), added: Date.now() });
  }
}
