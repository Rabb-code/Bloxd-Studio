// light-grid.js — ステップ55: 光の広がり(ゲームと同じ考え方)
//   地形のマスごとに「空の光」(0〜15)と「ブロックの光」(赤・緑・青 0〜15)を持つ。
//   ・空の光: 上に何も無いマスは 15。そこから横・下・上へ、1マスごとに 1 ずつ弱くなりながら広がる。壁は通らない。
//   ・ブロックの光: たいまつ・溶岩など(公式の表 official/materials.json の光の色)から、1マスごとに 1 ずつ弱くなる。
//   ・置く・壊す(リプレイの記録)に合わせて、今の時刻の光に直す(変わった所のまわりだけ計算し直す)。
//   影MOD は、カメラのまわり 128×64×128 マスの光を 1枚の絵(uLightVol)として受け取る(modLight・modSkyLight・modBlockLight)。
//   地形の面(fcMeshFaces)から作るので、中身の分からない地面の中は「光が届かない所」になる(表面でふさがれている)。

const LG_W = 128, LG_H = 64, LG_TILES = 8, LG_TEX = 1024;
const LG_DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
let lgState = null;
const _lgWins = new Map();   // "x,y,z" -> { tex, buf, stamp, ox, oy, oz, used }

function _lgCk(x, y, z) { return (((x >> 5) + 32768) * 65536 + ((z >> 5) + 32768)) * 256 + ((y >> 5) + 128); }
function _lgIdx(x, y, z) { return ((x & 31) << 10) | ((y & 31) << 5) | (z & 31); }
function _lgGet(L, x, y, z) {
  const k = _lgCk(x, y, z);
  if (k === L.lck) return L.lc;
  const c = L.chunks.get(k) || null;
  L.lck = k; L.lc = c;
  return c;
}
function _lgMake(L, x, y, z) {
  let c = _lgGet(L, x, y, z);
  if (!c) { c = { s: new Uint8Array(32768), b: null }; L.chunks.set(_lgCk(x, y, z), c); L.lc = c; }
  return c;
}
function _lgOcc(L, x, y, z) { const c = _lgGet(L, x, y, z); return c !== null && c.s[_lgIdx(x, y, z)] === 255; }
// 空の光(ふさぐマスは -1)
function _lgSky(L, x, y, z) {
  const cx = x - L.x0, cz = z - L.z0;
  if (cx < 0 || cz < 0 || cx >= L.w || cz >= L.h) return 15;
  if (y > L.top[cx + cz * L.w]) return 15;
  if (y < L.yMin) return -1;   // 世界の底より下には広げない
  const c = _lgGet(L, x, y, z);
  if (!c) return 0;
  const v = c.s[_lgIdx(x, y, z)];
  return v === 255 ? -1 : v;
}
function _lgBlk(L, x, y, z) { const c = _lgGet(L, x, y, z); return (c && c.b) ? c.b[_lgIdx(x, y, z)] : 0; }
function _lgBlkMax(L, x, y, z, r, g, b) {
  const c = _lgMake(L, x, y, z);
  if (!c.b) c.b = new Uint16Array(32768);
  const i = _lgIdx(x, y, z), v = c.b[i];
  const cr = (v >> 8) & 15, cg = (v >> 4) & 15, cb = v & 15;
  if (r <= cr && g <= cg && b <= cb) return false;
  c.b[i] = (Math.max(r, cr) << 8) | (Math.max(g, cg) << 4) | Math.max(b, cb);
  return true;
}
function _lgIn(B, x, y, z) { return x >= B[0] && y >= B[1] && z >= B[2] && x <= B[3] && y <= B[4] && z <= B[5]; }

// 空の光を広げる(q = [x,y,z, x,y,z, …] の始まりのマス。B があれば、その箱の中だけ書く)
function _lgSkyBfs(L, q, B) {
  const yLo = L.yMin - 2, yHi = L.yMax + 2;
  for (let h = 0; h < q.length; h += 3) {
    const x = q[h], y = q[h + 1], z = q[h + 2];
    const nl = _lgSky(L, x, y, z) - 1;
    if (nl < 1) continue;
    for (let d = 0; d < 18; d += 3) {
      const nx = x + LG_DIRS[d], ny = y + LG_DIRS[d + 1], nz = z + LG_DIRS[d + 2];
      if (ny < yLo || ny > yHi) continue;
      if (B && !_lgIn(B, nx, ny, nz)) continue;
      const cur = _lgSky(L, nx, ny, nz);
      if (cur < 0 || cur >= nl) continue;
      _lgMake(L, nx, ny, nz).s[_lgIdx(nx, ny, nz)] = nl;
      q.push(nx, ny, nz);
    }
  }
}
// 列の高さの差から、空の光の始まり(となりの列の空に面している、屋根・がけの下のマス)を入れる
function _lgSkySeeds(L, q, cx0, cz0, cx1, cz1, yLo, yHi) {
  const w = L.w, h = L.h, top = L.top;
  cx0 = Math.max(0, cx0); cz0 = Math.max(0, cz0); cx1 = Math.min(w - 1, cx1); cz1 = Math.min(h - 1, cz1);
  for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
    const tc = top[cx + cz * w];
    if (tc === -32768) continue;
    let tn = tc;
    if (cx > 0) tn = Math.min(tn, top[cx - 1 + cz * w]);
    if (cx < w - 1) tn = Math.min(tn, top[cx + 1 + cz * w]);
    if (cz > 0) tn = Math.min(tn, top[cx + (cz - 1) * w]);
    if (cz < h - 1) tn = Math.min(tn, top[cx + (cz + 1) * w]);
    if (tn >= tc - 1) continue;
    const x = cx + L.x0, z = cz + L.z0;
    const a = Math.max(tn === -32768 ? L.yMin : tn + 1, yLo), b = Math.min(tc - 1, yHi);
    for (let y = a; y <= b; y++) {
      // となりの列のうち、この高さで空が見える列があるか
      const open = (cx > 0 && y > top[cx - 1 + cz * w]) || (cx < w - 1 && y > top[cx + 1 + cz * w]) ||
        (cz > 0 && y > top[cx + (cz - 1) * w]) || (cz < h - 1 && y > top[cx + (cz + 1) * w]);
      if (!open) continue;
      const cur = _lgSky(L, x, y, z);
      if (cur < 0 || cur >= 14) continue;
      _lgMake(L, x, y, z).s[_lgIdx(x, y, z)] = 14;
      q.push(x, y, z);
    }
  }
}
// ブロックの光を広げる
function _lgBlkBfs(L, q, B) {
  for (let h = 0; h < q.length; h += 3) {
    const x = q[h], y = q[h + 1], z = q[h + 2];
    const v = _lgBlk(L, x, y, z);
    const r = Math.max(0, ((v >> 8) & 15) - 1), g = Math.max(0, ((v >> 4) & 15) - 1), b = Math.max(0, (v & 15) - 1);
    if (!(r | g | b)) continue;
    for (let d = 0; d < 18; d += 3) {
      const nx = x + LG_DIRS[d], ny = y + LG_DIRS[d + 1], nz = z + LG_DIRS[d + 2];
      if (B && !_lgIn(B, nx, ny, nz)) continue;
      if (_lgOcc(L, nx, ny, nz)) continue;
      if (_lgBlkMax(L, nx, ny, nz, r, g, b)) q.push(nx, ny, nz);
    }
  }
}
// 光るブロック1つ(ふさぐブロックなら、まわりのマスから始める)
function _lgSeedLight(L, q, x, y, z, r, g, b, B) {
  if (!_lgOcc(L, x, y, z)) {
    if ((!B || _lgIn(B, x, y, z)) && _lgBlkMax(L, x, y, z, r, g, b)) q.push(x, y, z);
    else if (B && !_lgIn(B, x, y, z)) q.push(x, y, z);   // 箱の外の光: 値はそのまま、中へ広げる
    return;
  }
  for (let d = 0; d < 18; d += 3) {
    const nx = x + LG_DIRS[d], ny = y + LG_DIRS[d + 1], nz = z + LG_DIRS[d + 2];
    if (B && !_lgIn(B, nx, ny, nz)) continue;
    if (_lgOcc(L, nx, ny, nz)) continue;
    if (_lgBlkMax(L, nx, ny, nz, Math.max(0, r - 1), Math.max(0, g - 1), Math.max(0, b - 1))) q.push(nx, ny, nz);
  }
}

// パレット(や番号の表の1行)が、光をふさぐか・光るか
function _lgPalInfo(p) {
  if (!p) return { o: false, l: null };
  const rects = (typeof fcUVRectsRaw !== 'undefined') ? fcUVRectsRaw : null;
  const info = (typeof offPaletteInfo === 'function') ? offPaletteInfo(p, rects) : null;
  const mats = (typeof OFFBLK !== 'undefined' && OFFBLK.materials) || null;
  const m = mats ? mats[p.root_name] : null;
  let l = null;
  if (m && m.l && (m.l[0] | m.l[1] | m.l[2])) l = m.l;
  else if (!mats) {   // 表が無い時は、名前で
    const mat = fcMaterialOf(p, info);
    if (mat === 6) l = [14, 8, 2]; else if (mat === 5) l = [14, 14, 12];
  }
  let o = true;
  if (info && !['cube', 'slab', 'stairs'].includes(info.type)) o = false;
  else if (!info && (p.asset_type === '3d_model' || p.asset_type === 'model')) o = false;
  else { const mat = fcMaterialOf(p, info); if (mat === 1 || mat === 2 || mat === 3 || mat === 4 || mat === 6) o = false; }
  if (m && (m.f || m.t)) o = false;
  return { o, l };
}

function _lgTopScan(L, x, z, from) {
  for (let y = from; y >= L.yMin; y--) if (_lgOcc(L, x, y, z)) return y;
  return -32768;
}
// マス1つの中身を入れる(ふさぐか・光るか)。列のいちばん上も直す。戻り値 = 変わる前のいちばん上
function _lgSetCell(L, x, y, z, occ, light) {
  const cx = x - L.x0, cz = z - L.z0;
  const inb = cx >= 0 && cz >= 0 && cx < L.w && cz < L.h && y >= L.yMin && y <= L.yMax;
  const k = _fcPosKey(x, y, z);
  if (light) L.lights.set(k, [x, y, z, light[0], light[1], light[2]]); else L.lights.delete(k);
  if (!inb) return -32768;
  const ti = cx + cz * L.w, old = L.top[ti];
  const c = occ ? _lgMake(L, x, y, z) : _lgGet(L, x, y, z);
  if (c) {
    const i = _lgIdx(x, y, z), was = c.s[i] === 255;
    if (occ && !was) { c.s[i] = 255; if (c.b) c.b[i] = 0; if (y > old) L.top[ti] = y; }
    else if (!occ && was) { c.s[i] = 0; if (y === old) L.top[ti] = _lgTopScan(L, x, z, y - 1); }
  }
  return old;
}

function _lgDynId(d, tickVal) {
  let id = d.init;
  for (let i = 0; i < d.t.length && d.t[i] <= tickVal; i++) id = d.v[i];
  return id;
}
function _lgIdInfo(L, id) {
  let e = L.idInfo.get(id);
  if (e) return e;
  const t = (typeof _bdIdTable !== 'undefined') ? _bdIdTable : null;
  e = (id && t && t.get(id)) ? _lgPalInfo(t.get(id)) : { o: false, l: null };
  if (t) L.idInfo.set(id, e);
  return e;
}

// 全部作る
function _lgBuild(tickVal) {
  const FS = fcMeshFaces, pal = fcMeshPalette || [];
  const L = { ok: false, chunks: new Map(), lc: null, lck: NaN, top: null, x0: 0, z0: 0, w: 0, h: 0, yMin: 0, yMax: 0,
    dyn: [], lights: new Map(), idInfo: new Map(), tick: null, stamp: (lgState ? lgState.stamp : 0) + 1, fullStamp: 0, boxes: [] };
  L.fullStamp = L.stamp;
  const pi = pal.map(_lgPalInfo);
  // 置く・壊すがあった場所(時刻で中身が変わる)
  const dynKey = new Map();
  const evs = (typeof _bfxEdits === 'function') ? _bfxEdits() : [];
  for (const e of evs) {
    if (!e.pos) continue;
    const k = _fcPosKey(e.pos[0], e.pos[1], e.pos[2]);
    let d = dynKey.get(k);
    if (!d) { d = { x: e.pos[0], y: e.pos[1], z: e.pos[2], t: [], v: [], init: e.from || 0, cur: -1 }; dynKey.set(k, d); L.dyn.push(d); }
    d.t.push(e.tick); d.v.push(e.to || 0);
  }
  const D = FS.d, n = FS.length;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    if (D[o + 3] < 0) continue;
    const x = D[o], y = D[o + 1], z = D[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (const d of L.dyn) { if (d.x < x0) x0 = d.x; if (d.x > x1) x1 = d.x; if (d.z < z0) z0 = d.z; if (d.z > z1) z1 = d.z; if (d.y < y0) y0 = d.y; if (d.y > y1) y1 = d.y; }
  if (x0 > x1) return L;
  L.x0 = x0; L.z0 = z0; L.w = x1 - x0 + 1; L.h = z1 - z0 + 1; L.yMin = y0; L.yMax = y1;
  if (L.w * L.h > 16e6) return L;   // 広すぎる時は作らない(前の「上から見た地図」のやり方になる)
  L.top = new Int16Array(L.w * L.h).fill(-32768);
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    if (D[o + 3] < 0) continue;
    const q = pi[D[o + 4]];
    if (!q || (!q.o && !q.l)) continue;
    const x = D[o], y = D[o + 1], z = D[o + 2];
    if (dynKey.size && dynKey.has(_fcPosKey(x, y, z))) continue;
    if (q.o) {
      _lgMake(L, x, y, z).s[_lgIdx(x, y, z)] = 255;
      const ti = (x - x0) + (z - z0) * L.w;
      if (y > L.top[ti]) L.top[ti] = y;
    }
    if (q.l) L.lights.set(_fcPosKey(x, y, z), [x, y, z, q.l[0], q.l[1], q.l[2]]);
  }
  for (const d of L.dyn) { const id = _lgDynId(d, tickVal); d.cur = id; const e = _lgIdInfo(L, id); _lgSetCell(L, d.x, d.y, d.z, e.o, e.l); }
  L.tick = tickVal;
  L.ok = true;
  _lgRelightAll(L);
  return L;
}
function _lgRelightAll(L) {
  for (const c of L.chunks.values()) {
    const s = c.s;
    for (let i = 0; i < 32768; i++) if (s[i] !== 255) s[i] = 0;
    if (c.b) c.b.fill(0);
  }
  let q = [];
  _lgSkySeeds(L, q, 0, 0, L.w - 1, L.h - 1, L.yMin, L.yMax);
  _lgSkyBfs(L, q, null);
  q = [];
  for (const v of L.lights.values()) _lgSeedLight(L, q, v[0], v[1], v[2], v[3], v[4], v[5], null);
  _lgBlkBfs(L, q, null);
  L.stamp++; L.fullStamp = L.stamp; L.boxes = [];
}
// 箱の中だけ計算し直す(箱の外の光は正しいとして、外から入る光も入れる)
function _lgRelightBox(L, B) {
  for (let x = B[0]; x <= B[3]; x++) for (let z = B[2]; z <= B[5]; z++) for (let y = B[1]; y <= B[4]; y++) {
    const c = _lgGet(L, x, y, z);
    if (!c) { y |= 31; continue; }
    const i = _lgIdx(x, y, z);
    if (c.s[i] !== 255) c.s[i] = 0;
    if (c.b) c.b[i] = 0;
  }
  const qs = [], qb = [];
  _lgSkySeeds(L, qs, B[0] - L.x0, B[2] - L.z0, B[3] - L.x0, B[5] - L.z0, B[1], B[4]);
  // 箱のすぐ外のマス(6つの面)から入る光
  const shell = (x, y, z) => {
    if (_lgSky(L, x, y, z) > 1) qs.push(x, y, z);
    if (_lgBlk(L, x, y, z)) qb.push(x, y, z);
  };
  for (let y = B[1]; y <= B[4]; y++) for (let z = B[2]; z <= B[5]; z++) { shell(B[0] - 1, y, z); shell(B[3] + 1, y, z); }
  for (let y = B[1]; y <= B[4]; y++) for (let x = B[0]; x <= B[3]; x++) { shell(x, y, B[2] - 1); shell(x, y, B[5] + 1); }
  for (let x = B[0]; x <= B[3]; x++) for (let z = B[2]; z <= B[5]; z++) { shell(x, B[1] - 1, z); shell(x, B[4] + 1, z); }
  _lgSkyBfs(L, qs, B);
  for (const v of L.lights.values()) {
    if (v[0] < B[0] - 1 || v[0] > B[3] + 1 || v[1] < B[1] - 1 || v[1] > B[4] + 1 || v[2] < B[2] - 1 || v[2] > B[5] + 1) continue;
    _lgSeedLight(L, qb, v[0], v[1], v[2], v[3], v[4], v[5], B);
  }
  _lgBlkBfs(L, qb, B);
  L.stamp++;
  L.boxes.push({ stamp: L.stamp, B });
  if (L.boxes.length > 64) { L.fullStamp = L.stamp; L.boxes = []; }
}
// 今の時刻に合わせる(置く・壊すで変わった所だけ)
function _lgSync(L, tickVal) {
  if (L.tick === tickVal) return;
  L.tick = tickVal;
  const ch = [];
  for (const d of L.dyn) { const id = _lgDynId(d, tickVal); if (id !== d.cur) ch.push(d, id); }
  if (!ch.length) return;
  const many = ch.length > 80;
  for (let i = 0; i < ch.length; i += 2) {
    const d = ch[i], id = ch[i + 1], a = _lgIdInfo(L, d.cur), b = _lgIdInfo(L, id);
    d.cur = id;
    const same = a.o === b.o && String(a.l) === String(b.l);
    if (same) continue;
    const old = _lgSetCell(L, d.x, d.y, d.z, b.o, b.l);
    if (many) continue;
    const cx = d.x - L.x0, cz = d.z - L.z0;
    const now = (cx >= 0 && cz >= 0 && cx < L.w && cz < L.h) ? L.top[cx + cz * L.w] : -32768;
    let lo = d.y;
    if (a.o !== b.o && (d.y >= old || d.y >= now)) { const m = Math.min(old, now); lo = Math.min(lo, m === -32768 ? L.yMin : m); }
    _lgRelightBox(L, [d.x - 16, Math.max(lo - 16, L.yMin), d.z - 16, d.x + 16, Math.min(d.y + 16, L.yMax + 1), d.z + 16]);
  }
  if (many) _lgRelightAll(L);
}

// 光の入れ物を用意する(地形が変わったら作り直す。読みこみ中は 2秒に1回まで)
function lgEnsure(tickVal) {
  if (typeof fcMeshFaces === 'undefined' || !fcMeshFaces.length) return null;
  if (typeof bdLoadIdTable === 'function' && typeof _bdIdTable !== 'undefined' && !_bdIdTable) bdLoadIdTable();
  const evLen = (typeof _bfxEdits === 'function') ? _bfxEdits().length : 0;
  const idOk = (typeof _bdIdTable !== 'undefined') && !!_bdIdTable;
  const matOk = (typeof OFFBLK !== 'undefined') && !!OFFBLK.materials;
  const sig = fcMeshFaces.ver + '|' + evLen + '|' + idOk + '|' + matOk + '|' + (fcUVRectsRaw ? 1 : 0);
  const now = performance.now();
  // 読みこみの途中は、作り直しを 15秒に1回までにする(大きいワールドで何度も止まらないように)
  const loading = (typeof streamingDone !== 'undefined') && !streamingDone;
  if (!lgState || (lgState.sig !== sig && now - lgState.at > (loading ? 15000 : 1500))) {
    let L;
    try { L = _lgBuild(tickVal); } catch (e) { console.warn('[光] 光の計算に失敗しました:', e); L = { ok: false, stamp: 0 }; }
    L.sig = sig; L.at = performance.now(); L.ms = L.at - now;
    lgState = L;
  }
  if (!lgState.ok) return null;
  _lgSync(lgState, tickVal);
  return lgState;
}
// 作り直させる(設定が変わった時など)
function lgReset() { lgState = null; }

// 窓の絵の中の、箱 B(世界の座標)の所を入れ直す
function _lgFillWindow(L, W, B) {
  const x0 = Math.max(B[0], W.ox), y0 = Math.max(B[1], W.oy), z0 = Math.max(B[2], W.oz);
  const x1 = Math.min(B[3], W.ox + LG_W - 1), y1 = Math.min(B[4], W.oy + LG_H - 1), z1 = Math.min(B[5], W.oz + LG_W - 1);
  if (x0 > x1 || y0 > y1 || z0 > z1) return false;
  const buf = W.buf;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const cx = x - L.x0, cz = z - L.z0;
    const top = (cx >= 0 && cz >= 0 && cx < L.w && cz < L.h) ? L.top[cx + cz * L.w] : -32768;
    for (let y = y0; y <= y1; y++) {
      const c = _lgGet(L, x, y, z);
      let sky = y > top ? 15 : 0, blk = 0, occ = false;
      if (c) {
        const i = _lgIdx(x, y, z), sv = c.s[i];
        if (sv === 255) occ = true;
        else {
          if (y <= top) sky = sv;
          if (c.b) blk = c.b[i];
        }
      }
      const s = y - W.oy;
      const o = (((s >> 3) * LG_W + (z - W.oz)) * LG_TEX + (s & 7) * LG_W + (x - W.ox)) * 4;
      // 明るさ × 16(0〜240)。光をふさぐマスは a = 255(影MOD の読む所で、数えないマスの印)
      buf[o] = ((blk >> 8) & 15) * 16; buf[o + 1] = ((blk >> 4) & 15) * 16; buf[o + 2] = (blk & 15) * 16; buf[o + 3] = occ ? 255 : sky * 16;
    }
  }
  return true;
}

// カメラのまわりの光の絵。cam・fwd は場面の座標(世界 − worldOrigin)。戻り値 { tex, origin:[x,y,z](場面の座標) } か null
function lgWindow(gl, cam, fwd, tickVal) {
  const L = lgEnsure(tickVal);
  if (!L) return null;
  const fl = Math.hypot(fwd[0], fwd[2]) || 1;
  const snap = (v) => Math.round(v / 16) * 16;
  const ox = snap(cam[0] + worldOriginX + fwd[0] / fl * 40) - LG_W / 2;
  const oy = snap(cam[1] + worldOriginY) - LG_H / 2;
  const oz = snap(cam[2] + worldOriginZ + fwd[2] / fl * 40) - LG_W / 2;
  const key = ox + ',' + oy + ',' + oz;
  let W = _lgWins.get(key);
  if (!W) {
    if (_lgWins.size >= 4) {   // いちばん前に使った窓を使い回す
      let ok = null, ot = Infinity;
      for (const [k, v] of _lgWins) if (v.used < ot) { ot = v.used; ok = k; }
      W = _lgWins.get(ok); _lgWins.delete(ok);
    } else {
      W = { tex: gl.createTexture(), buf: new Uint8Array(LG_TEX * LG_TEX * 4) };
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, W.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    W.ox = ox; W.oy = oy; W.oz = oz; W.stamp = -1; W.src = null;
    _lgWins.set(key, W);
  }
  W.used = performance.now();
  if (W.stamp !== L.stamp || W.src !== L) {
    let dirty = false;
    if (W.src !== L || W.stamp < L.fullStamp) dirty = _lgFillWindow(L, W, [ox, oy, oz, ox + LG_W - 1, oy + LG_H - 1, oz + LG_W - 1]);
    else for (const b of L.boxes) if (b.stamp > W.stamp && _lgFillWindow(L, W, [b.B[0] - 1, b.B[1] - 1, b.B[2] - 1, b.B[3] + 1, b.B[4] + 1, b.B[5] + 1])) dirty = true;
    W.stamp = L.stamp; W.src = L;
    if (dirty) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, W.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LG_TEX, LG_TEX, 0, gl.RGBA, gl.UNSIGNED_BYTE, W.buf);
    }
  }
  return { tex: W.tex, origin: [ox - worldOriginX, oy - worldOriginY, oz - worldOriginZ] };
}
