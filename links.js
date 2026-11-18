// links.js
// ============================================================
// 🔗 つなぐ(ロープ・鎖・糸)
//   ブロックのエンティティ(人形の型 'block')の両はし A・B を、
//     ・エンティティの体の面(手の先・頭など。プレイヤーも人形も)
//     ・別のロープ/鎖の上の点(はし・途中)
//     ・地形の面(最初からあるブロック)
//   にくっつける。毎フレーム、両はしの位置から形を作る。
//
//   データ(人形 p.link):
//     ends: { a: [ {tick, to, pos?}, ... ], b: [...] }   時間ごとの「くっつく先」。to=null ははなれている
//        to = { kind:'part',  key, joint, u:[x,y,z] }    体の部品の箱の中の点(-0.5〜0.5)
//             { kind:'rope',  id, t }                   別のロープの上(0=はしA 〜 1=はしB)
//             { kind:'world', pos:[x,y,z] }             地形などの決まった点
//     look: 'rope' | 'chain' | 'blocks'   見た目
//     thick: 太さ(鎖は輪の幅)
//     lenMode: 'auto'(両はしの距離×(1+たるみ)) | 'fixed'(長さを決める)
//     slack, length, lenKeys:[{tick,k}](長さの倍率を時間で変える)
//     motion: 'physics'(ゆれる・落ちる) | 'shape'(形だけ。ゆれない)
//     gravity, stretch(伸び), damping(止まりやすさ), wind, windDir, collide(地形に当たる)
//     shootSec: 途中でくっつける時、はしが飛んでいく時間(0=すぐ)
//
//   形は、ロープの出ている範囲の始めから順番に計算して、フレームごとに覚えておく(戻って見ても同じ形)。
// ============================================================

const LINK_GRAVITY = 16;        // ブロック/秒²
const LINK_SUBSTEPS = 4;
const LINK_ITER = 10;

const LINK_LOOKS = [['rope', '🧵 ロープ・糸'], ['chain', '⛓ 鎖'], ['blocks', '🧱 ブロックを並べる']];
const LINK_SLACK_PRESETS = [['ピン', 0], ['少し', 0.05], ['ふつう', 0.15], ['たっぷり', 0.4], ['だらーん', 1]];

function linkDefaults() {
  return {
    ends: { a: [{ tick: 0, to: null }], b: [{ tick: 0, to: null }] },
    look: 'rope', thick: 0.12,
    lenMode: 'auto', slack: 0.15, length: 5, lenKeys: [],
    motion: 'physics', gravity: 1, stretch: 0.05, damping: 0.25, wind: 0, windDir: 0, collide: true,
    shootSec: 0.2,
  };
}

function linkOf(p) { return p && p.type === 'block' && p.link ? p.link : null; }
function linkIsRopeKey(key) { return !!(key && key.startsWith('puppet:') && linkOf(puppetGet(+key.slice(7)))); }

// ブロックをロープにする。はしは、今のブロックの下の真ん中と上の真ん中(地形の点)から始める
function linkCreate(p, preset) {
  const L = linkDefaults();
  Object.assign(L, preset || {});
  const h = 3;
  const b0 = p.base.pos;
  const a = [b0[0], b0[1] + h, b0[2]];
  const b = [b0[0] + Math.sin(p.base.yaw) * h, b0[1] + h, b0[2] + Math.cos(p.base.yaw) * h];
  L.ends = { a: [{ tick: 0, to: { kind: 'world', pos: a } }], b: [{ tick: 0, to: { kind: 'world', pos: b } }] };
  p.link = L;
  return L;
}


// ============================================================
// はしの位置
// ============================================================

// その時刻に効いている、くっつく先の番号
function _linkEvIndex(evs, f) {
  let i = 0;
  for (let k = 1; k < evs.length; k++) if (evs[k].tick <= f) i = k;
  return i;
}

// くっつく先の、今の位置(見えていなければ null)
function linkAnchorPos(to, f, depth) {
  if (!to) return null;
  depth = depth || 0;
  if (to.kind === 'world') return to.pos.slice();
  if (to.kind === 'part') {
    if (linkIsRopeKey(to.key)) return null;
    const base = poseEntityBase(to.key, f);
    if (!base) return null;
    const type = entityRigType(to.key);
    const rig = poseBuildRig(type, base, poseEntityPose(to.key, f));
    const part = rig.parts.find(q => q.joint === to.joint);
    return part ? _m4Point(part.model, to.u) : null;
  }
  if (to.kind === 'rope') {
    if (depth > 4) return null;
    const q = puppetGet(to.id);
    if (!linkOf(q)) return null;
    const st = linkState(q, f, depth + 1);
    return st ? linkAlong(st.pts, to.t) : null;
  }
  return null;
}

// 線の上の、長さの割合 t の点
function linkAlong(pts, t) {
  const n = pts.length / 3;
  let total = 0;
  const seg = [];
  for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(pts[i * 3 + 3] - pts[i * 3], pts[i * 3 + 4] - pts[i * 3 + 1], pts[i * 3 + 5] - pts[i * 3 + 2]);
    seg.push(l); total += l;
  }
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < n - 1; i++) {
    if (want <= seg[i] || i === n - 2) {
      const u = seg[i] > 1e-9 ? Math.min(1, want / seg[i]) : 0;
      return [0, 1, 2].map(k => pts[i * 3 + k] + (pts[i * 3 + 3 + k] - pts[i * 3 + k]) * u);
    }
    want -= seg[i];
  }
  return [pts[0], pts[1], pts[2]];
}

// 長さの倍率(キーの間はなめらかにつなぐ)
function _linkLenMul(L, f) {
  const ks = L.lenKeys || [];
  if (!ks.length) return 1;
  if (f <= ks[0].tick) return ks[0].k;
  const last = ks[ks.length - 1];
  if (f >= last.tick) return last.k;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (f >= a.tick && f <= b.tick) {
      const x = (f - a.tick) / ((b.tick - a.tick) || 1);
      return a.k + (b.k - a.k) * x * x * (3 - 2 * x);
    }
  }
  return last.k;
}


// ============================================================
// 形: 垂れ下がり(カテナリー曲線)
// ============================================================

// A から B へ、長さ L で垂れ下がった形の点 n 個(長さで等間隔)
function linkCatenary(A, B, L, n) {
  const out = new Float64Array(n * 3);
  const dx = B[0] - A[0], dz = B[2] - A[2], v = B[1] - A[1];
  const H = Math.hypot(dx, dz);
  const D = Math.hypot(H, v);
  const put = (i, p) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; };
  if (L <= D + 1e-4) { // ピンと張っている
    for (let i = 0; i < n; i++) { const u = i / (n - 1); put(i, [A[0] + dx * u, A[1] + v * u, A[2] + dz * u]); }
    return out;
  }
  if (H < 0.03) { // ほぼ真上下: 下に折れて垂れる
    const low = (A[1] + B[1] - L) / 2;
    const l1 = A[1] - low;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1) * L;
      const y = s <= l1 ? A[1] - s : low + (s - l1);
      const u = i / (n - 1);
      const bulge = Math.sin(u * Math.PI) * 0.04;
      put(i, [A[0] + dx * u + bulge, y, A[2] + dz * u]);
    }
    return out;
  }
  // sinh(x)/x = r を解く(x = H/2a)
  const r = Math.sqrt(L * L - v * v) / H;
  let lo = 1e-6, hi = 1;
  while (Math.sinh(hi) / hi < r && hi < 60) hi *= 2;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (Math.sinh(mid) / mid < r) lo = mid; else hi = mid; }
  const x = (lo + hi) / 2;
  const a = H / (2 * x);
  const m = H / 2 - a * Math.atanh(Math.max(-0.999999, Math.min(0.999999, v / L)));
  const c = A[1] - a * Math.cosh(m / a);
  const s0 = Math.sinh(-m / a);
  const ux = dx / H, uz = dz / H;
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1) * L;
    const xh = m + a * Math.asinh(s / a + s0);
    put(i, [A[0] + ux * xh, a * Math.cosh((xh - m) / a) + c, A[2] + uz * xh]);
  }
  return out;
}


// ============================================================
// 計算(ロープの出ている範囲の始めから順番に。フレームごとに覚えておく)
// ============================================================

const _linkCache = new Map();
const _linkBusy = new Set();
let _linkDepSig = null, _linkDepAt = -1e9;

// 形が変わる元(ポーズ・人形・自動アニメーション・リプレイ)が変わったら、覚えた形を捨てる
function _linkCheckDeps() {
  const now = performance.now();
  if (now - _linkDepAt < 4) return;
  _linkDepAt = now;
  const sig = JSON.stringify([
    typeof poseBlocks !== 'undefined' ? poseBlocks : 0, typeof puppets !== 'undefined' ? puppets : 0,
    typeof autoAnim !== 'undefined' ? autoAnim : 0,
    (typeof timeline !== 'undefined' && timeline && timeline.frames) ? timeline.frames.length : 0,
    (typeof allTimelines !== 'undefined' && allTimelines && allTimelines.entities) ? Object.keys(allTimelines.entities).length : 0,
    (typeof fcMeshFaces !== 'undefined' && fcMeshFaces) ? fcMeshFaces.ver : 0,
  ]);
  if (sig !== _linkDepSig) { _linkDepSig = sig; _linkCache.clear(); }
}

// フレーム f のロープの形 { pts(ローカル座標の点の並び), ends:{a,b} }。出ていなければ null
function linkState(p, f, depth) {
  const L = linkOf(p);
  if (!L) return null;
  const span = _puppetSpan(p.id);
  f = Math.round(f);
  if (!span || f < span[0] || f >= span[1]) return null;
  if (!depth) _linkCheckDeps();
  let c = _linkCache.get(p.id);
  if (!c || c.start !== span[0]) { c = { start: span[0], frames: [], live: null }; _linkCache.set(p.id, c); }
  const idx = f - c.start;
  if (c.frames[idx]) return c.frames[idx];
  if (_linkBusy.has(p.id)) return c.frames[c.frames.length - 1] || null; // つながりが輪になっている時
  _linkBusy.add(p.id);
  try { while (c.frames.length <= idx) _linkStep(p, L, c, depth || 0); }
  finally { _linkBusy.delete(p.id); }
  return c.frames[idx];
}

function _linkPointCount(len) { return Math.max(10, Math.min(36, Math.ceil(len / 0.35) + 1)); }

function _linkStep(p, L, c, depth) {
  const f = c.start + c.frames.length;
  const tps = scTps();
  const live = c.live;
  // ---- はしの行き先 ----
  const tgt = {};
  for (const end of ['a', 'b']) {
    const evs = L.ends[end];
    const i = _linkEvIndex(evs, f);
    const ev = evs[i];
    let pos = linkAnchorPos(ev.to, f, depth);
    let shooting = false;
    if (live && live.evIdx[end] !== i) live.shootFrom[end] = live.endPos[end].slice();
    if (pos && live && i > 0 && L.shootSec > 0.001) {
      const u = (f - ev.tick) / (L.shootSec * tps);
      if (u < 1) {
        const e = 1 - Math.pow(1 - Math.max(0, u), 2);
        const from = live.shootFrom[end] || live.endPos[end];
        pos = [0, 1, 2].map(k => from[k] + (pos[k] - from[k]) * e);
        shooting = true;
      }
    }
    tgt[end] = { pos, pinned: !!pos, shooting, i };
  }
  // はなれているはしの位置(最初からはなれている時は、決めておいた点。無ければブロックの置き場所)
  const endNow = (end) => {
    if (tgt[end].pos) return tgt[end].pos;
    if (live) return live.endPos[end];
    const ev = L.ends[end][tgt[end].i];
    if (ev.pos) return ev.pos.slice();
    const b0 = p.base.pos;
    return end === 'a' ? [b0[0], b0[1] + 2, b0[2]] : [b0[0] + 2, b0[1] + 2, b0[2]];
  };
  const A = endNow('a'), B = endNow('b');
  const D = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);

  // ---- 長さ ----
  const mul = _linkLenMul(L, f);
  const both = tgt.a.pinned && tgt.b.pinned;
  const anyShoot = tgt.a.shooting || tgt.b.shooting;
  let base;
  if (L.lenMode === 'fixed') base = L.length;
  else if (both && !anyShoot) base = D * (1 + L.slack);
  else base = live ? live.restBase : D * (1 + L.slack);
  let want = anyShoot ? Math.max(0.05, D) : base * mul;
  want = Math.max(0.05, want);
  let rest = live ? live.rest + (want - live.rest) * Math.min(1, 14 / tps) : want;
  if (anyShoot) rest = want;

  let st;
  if (!live) {
    const n = _linkPointCount(rest);
    const pts = linkCatenary(A, B, rest, n);
    c.live = st = { n, cur: pts, prev: Float64Array.from(pts), endPos: { a: A.slice(), b: B.slice() }, shootFrom: { a: null, b: null },
                    evIdx: { a: tgt.a.i, b: tgt.b.i }, rest, restBase: base };
  } else {
    st = live;
    if (L.motion === 'shape') {
      st.cur = linkCatenary(A, B, rest, st.n);
      st.prev = Float64Array.from(st.cur);
    } else {
      _linkPhysics(L, st, tgt, A, B, rest, f, tps);
    }
    st.endPos = { a: [st.cur[0], st.cur[1], st.cur[2]], b: [st.cur[st.n * 3 - 3], st.cur[st.n * 3 - 2], st.cur[st.n * 3 - 1]] };
    if (tgt.a.pinned) st.endPos.a = A.slice();
    if (tgt.b.pinned) st.endPos.b = B.slice();
    st.evIdx = { a: tgt.a.i, b: tgt.b.i };
    st.rest = rest;
    st.restBase = base;
  }
  c.frames.push({ pts: Float32Array.from(st.cur), ends: { a: st.endPos.a.slice(), b: st.endPos.b.slice() }, rest });
}

// ゆれる(物理): 点を少しずつ動かして、となり同士の距離を保つ
function _linkPhysics(L, st, tgt, A, B, rest, f, tps) {
  const n = st.n, cur = st.cur, prev = st.prev;
  const S = LINK_SUBSTEPS, dt = 1 / tps / S;
  const g = LINK_GRAVITY * (L.gravity != null ? L.gravity : 1);
  const keep = 1 - (0.002 + Math.max(0, Math.min(1, L.damping)) * 0.08);
  const segRest = rest / (n - 1);
  const stiff = 1 - Math.max(0, Math.min(0.95, L.stretch || 0));
  const wd = (L.windDir || 0) * Math.PI / 180;
  const A0 = st.endPos.a, B0 = st.endPos.b;
  for (let s = 1; s <= S; s++) {
    const u = s / S;
    const time = (f - 1 + u) / tps;
    const wind = (L.wind || 0) * 10, dt2 = dt * dt, gy = -g * dt2;
    const wx = Math.sin(wd) * dt2, wz = Math.cos(wd) * dt2;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const w = wind ? wind * (0.65 + 0.35 * Math.sin(time * 1.9 + i * 0.45)) : 0;
      let x = cur[o];     cur[o] = x + (x - prev[o]) * keep + wx * w;         prev[o] = x;
      x = cur[o + 1];     cur[o + 1] = x + (x - prev[o + 1]) * keep + gy;     prev[o + 1] = x;
      x = cur[o + 2];     cur[o + 2] = x + (x - prev[o + 2]) * keep + wz * w; prev[o + 2] = x;
    }
    const pinA = tgt.a.pinned ? [0, 1, 2].map(k => A0[k] + (A[k] - A0[k]) * u) : null;
    const pinB = tgt.b.pinned ? [0, 1, 2].map(k => B0[k] + (B[k] - B0[k]) * u) : null;
    const pin = () => {
      if (pinA) { cur[0] = pinA[0]; cur[1] = pinA[1]; cur[2] = pinA[2]; }
      if (pinB) { const o = (n - 1) * 3; cur[o] = pinB[0]; cur[o + 1] = pinB[1]; cur[o + 2] = pinB[2]; }
    };
    pin();
    for (let it = 0; it < LINK_ITER; it++) {
      for (let i = 0; i < n - 1; i++) {
        const o = i * 3, q = o + 3;
        const dx = cur[q] - cur[o], dy = cur[q + 1] - cur[o + 1], dz = cur[q + 2] - cur[o + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= segRest * segRest || d2 < 1e-18) continue;
        const d = Math.sqrt(d2); // ロープは縮む向きには突っぱらない(たるむ)
        const wa = (i === 0 && pinA) ? 0 : 1, wb = (i === n - 2 && pinB) ? 0 : 1;
        if (!wa && !wb) continue;
        const corr = (d - segRest) / d * stiff / (wa + wb);
        cur[o] += dx * corr * wa; cur[o + 1] += dy * corr * wa; cur[o + 2] += dz * corr * wa;
        cur[q] -= dx * corr * wb; cur[q + 1] -= dy * corr * wb; cur[q + 2] -= dz * corr * wb;
      }
      pin();
    }
  }
  // 地形に当たる: 中に入った点を外に出す(少しすべりにくくする)
  if (L.collide && typeof pfIsSolidLocal === 'function') {
    const tv = _poseTickVal(f);
    for (let i = 0; i < n; i++) {
      if ((i === 0 && tgt.a.pinned) || (i === n - 1 && tgt.b.pinned)) continue;
      const o = i * 3;
      const p = [cur[o], cur[o + 1], cur[o + 2]];
      if (!pfIsSolidLocal(p, tv)) continue;
      const pp = [prev[o], prev[o + 1], prev[o + 2]];
      if (!pfIsSolidLocal([p[0], pp[1], p[2]], tv)) { cur[o + 1] = pp[1]; }
      else if (!pfIsSolidLocal(pp, tv)) { cur[o] = pp[0]; cur[o + 1] = pp[1]; cur[o + 2] = pp[2]; }
      else cur[o + 1] = Math.floor(p[1] + worldOriginY) + 1.001 - worldOriginY;
      // すべりにくさ
      prev[o] = cur[o] + (prev[o] - cur[o]) * 0.5; prev[o + 2] = cur[o + 2] + (prev[o + 2] - cur[o + 2]) * 0.5;
      prev[o + 1] = cur[o + 1];
    }
  }
}


// ============================================================
// 描く
// ============================================================

// なめらかに点を増やす(Catmull-Rom)
function _linkSmooth(pts, per) {
  const n = pts.length / 3;
  const P = (i) => { i = Math.max(0, Math.min(n - 1, i)); return [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]; };
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(P(n - 1));
  return out;
}

// 線の長さで等間隔に並べた点と向き
function _linkResample(list, step) {
  const out = [];
  let acc = 0, want = step / 2;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (want <= acc + l && l > 1e-9) {
      const u = (want - acc) / l;
      out.push({ p: [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * u), d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l] });
      want += step;
    }
    acc += l;
  }
  return out;
}

// 中心 c、y軸を d の向きにした箱の行列(大きさ sx, sy(長さ), sz)。roll で d のまわりに回す
function _linkBoxModel(c, d, sx, sy, sz, roll) {
  let side = Math.abs(d[1]) < 0.95 ? fcVecNormalize(fcVecCross(d, [0, 1, 0])) : fcVecNormalize(fcVecCross(d, [1, 0, 0]));
  let nrm = fcVecCross(side, d);
  if (roll) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const s2 = [0, 1, 2].map(k => side[k] * cr + nrm[k] * sr);
    nrm = [0, 1, 2].map(k => -side[k] * sr + nrm[k] * cr);
    side = s2;
  }
  return new Float32Array([side[0] * sx, side[1] * sx, side[2] * sx, 0, d[0] * sy, d[1] * sy, d[2] * sy, 0,
    nrm[0] * sz, nrm[1] * sz, nrm[2] * sz, 0, c[0], c[1], c[2], 1]);
}

// ロープの箱の行列の一覧
function linkModels(p, st) {
  const L = p.link;
  const th = Math.max(0.02, L.thick || 0.12);
  const out = [];
  if (L.look === 'chain') {
    const w = th, len = th * 1.7, wire = Math.max(0.02, th * 0.26);
    const pts = _linkResample(_linkSmooth(st.pts, 3), len * 0.78);
    pts.forEach((q, i) => {
      const roll = (i % 2) * Math.PI / 2;
      const side = Math.abs(q.d[1]) < 0.95 ? fcVecNormalize(fcVecCross(q.d, [0, 1, 0])) : fcVecNormalize(fcVecCross(q.d, [1, 0, 0]));
      const nrm = fcVecCross(side, q.d);
      const sd = [0, 1, 2].map(k => side[k] * Math.cos(roll) + nrm[k] * Math.sin(roll));
      // 輪 = 長い辺2本 + 短い辺2本
      for (const sgn of [-1, 1]) {
        out.push(_linkBoxModel([0, 1, 2].map(k => q.p[k] + sd[k] * sgn * (w - wire) / 2), q.d, wire, len, wire, roll));
        out.push(_linkBoxModel([0, 1, 2].map(k => q.p[k] + q.d[k] * sgn * (len - wire) / 2), q.d, w, wire, wire, roll));
      }
    });
  } else if (L.look === 'blocks') {
    for (const q of _linkResample(_linkSmooth(st.pts, 3), th)) out.push(_linkBoxModel(q.p, q.d, th, th, th, 0));
  } else {
    const list = _linkSmooth(st.pts, 3);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (l < 1e-6) continue;
      const d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l];
      out.push(_linkBoxModel([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d, th, l + th * 0.6, th, 0));
    }
  }
  return out;
}


// ============================================================
// 3Dの操作: ロープを選ぶ・はしの印・くっつける先を選ぶ
// ============================================================

let linkPick = null;   // { id, end } くっつける先を選んでいる所
let linkHoverEnd = null;

function _linkSelected() {
  if (typeof poseEntity === 'undefined' || !poseEntity || !poseEntity.startsWith('puppet:')) return null;
  const p = puppetGet(+poseEntity.slice(7));
  return linkOf(p) ? p : null;
}

// 画面の点の近くのロープ(一番近い)。{ id, t, d }
function linkPickRope(mx, my, view, proj, skipId) {
  let best = null;
  for (const p of puppets) {
    if (!linkOf(p) || p.id === skipId) continue;
    const st = linkState(p, curTick);
    if (!st) continue;
    const n = st.pts.length / 3;
    const P = (i) => [st.pts[i * 3], st.pts[i * 3 + 1], st.pts[i * 3 + 2]];
    let total = 0; const lens = [];
    for (let i = 0; i < n - 1; i++) { const a = P(i), b = P(i + 1); const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); lens.push(l); total += l; }
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      const s1 = projectToScreen(P(i), view, proj, fcCanvas.width, fcCanvas.height);
      const s2 = projectToScreen(P(i + 1), view, proj, fcCanvas.width, fcCanvas.height);
      if (s1 && s2) {
        const dx = s2.x - s1.x, dy = s2.y - s1.y, ll = dx * dx + dy * dy;
        const u = ll > 0 ? Math.max(0, Math.min(1, ((mx - s1.x) * dx + (my - s1.y) * dy) / ll)) : 0;
        const d = Math.hypot(mx - (s1.x + dx * u), my - (s1.y + dy * u));
        if (d < 9 && (!best || d < best.d)) best = { id: p.id, t: total > 0 ? (acc + lens[i] * u) / total : 0, d };
      }
      acc += lens[i];
    }
  }
  return best;
}

// はしの印(選んでいるロープだけ)
function _linkEndMarks(p) {
  const st = linkState(p, curTick);
  return st ? [{ end: 'a', pos: st.ends.a }, { end: 'b', pos: st.ends.b }] : [];
}
function _linkPickEnd(p, mx, my, view, proj) {
  let best = null;
  for (const m of _linkEndMarks(p)) {
    const s = projectToScreen(m.pos, view, proj, fcCanvas.width, fcCanvas.height);
    if (!s) continue;
    const d = Math.hypot(s.x - mx, s.y - my);
    if (d < 12 && (!best || d < best.d)) best = { ...m, d };
  }
  return best;
}

// 画面の点の先の「くっつける先」を探す。{ to, pos, label }
function linkFindTarget(mx, my, selfId) {
  const { view, proj } = _fcEditViewProj();
  const ray = _poseRay(mx, my);
  const rope = linkPickRope(mx, my, view, proj, selfId);
  // エンティティの体
  let ent = null;
  for (const e of poseEntityList()) {
    if (linkIsRopeKey(e.key)) continue;
    const base = poseEntityBase(e.key, curTick);
    if (!base) continue;
    const rig = poseBuildRig(e.type, base, poseEntityPose(e.key, curTick));
    const hit = _posePickPart(rig, ray);
    if (hit && (!ent || hit.t < ent.t)) ent = { key: e.key, joint: hit.joint, t: hit.t, rig, type: e.type };
  }
  const tv = _poseTickVal(curTick);
  const ground = (typeof pfRaycastLocal === 'function') ? pfRaycastLocal(ray.origin, ray.dir, 120, tv) : null;
  if (rope && (!ent || rope.d < 5)) {
    const q = puppetGet(rope.id);
    const t = rope.t < 0.06 ? 0 : rope.t > 0.94 ? 1 : Math.round(rope.t * 100) / 100;
    return { to: { kind: 'rope', id: rope.id, t }, label: _linkLabel({ kind: 'rope', id: rope.id, t }), pos: null, name: q.name };
  }
  if (ent && (!ground || ent.t <= ground.dist + 0.05)) {
    const part = ent.rig.parts.find(q => q.joint === ent.joint);
    const inv = _m4Inverse(part.model);
    const hp = [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * ent.t);
    let u = inv ? _m4Point(inv, hp).map(v => Math.max(-0.5, Math.min(0.5, v))) : [0, 0, 0];
    // ひじ・ひざから先の、先の方をクリックした時は、手・足の先にぴったり付ける
    // (箱の中を線が通る区間の真ん中で見る。上から見て上の面に当たっても、先の方なら先に付く)
    const T = RIG_TYPES[ent.type];
    const ik = (T.ik || []).find(c => c.lower === ent.joint);
    const tt = inv ? _linkRayBox(inv, ray) : null;
    const um = tt ? _m4Point(inv, [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * (tt[0] + tt[1]) / 2)) : u;
    if (ik && um[1] < -0.1) u = [0, -0.5, 0];
    u = u.map(v => Math.round(v * 1000) / 1000);
    const to = { kind: 'part', key: ent.key, joint: ent.joint, u };
    return { to, label: _linkLabel(to), pos: hp };
  }
  if (ground) {
    const pos = ground.pos.map(v => Math.round(v * 100) / 100);
    const to = { kind: 'world', pos };
    return { to, label: _linkLabel(to), pos };
  }
  return null;
}

// 箱(-0.5〜0.5)の中を線が通る区間 [入る, 出る]
function _linkRayBox(inv, ray) {
  const o = _m4Point(inv, ray.origin);
  const d = [inv[0] * ray.dir[0] + inv[4] * ray.dir[1] + inv[8] * ray.dir[2],
             inv[1] * ray.dir[0] + inv[5] * ray.dir[1] + inv[9] * ray.dir[2],
             inv[2] * ray.dir[0] + inv[6] * ray.dir[1] + inv[10] * ray.dir[2]];
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < -0.5 || o[i] > 0.5) return null; continue; }
    let a = (-0.5 - o[i]) / d[i], c = (0.5 - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
  }
  return t0 <= t1 ? [Math.max(0, t0), t1] : null;
}

function _linkLabel(to) {
  if (!to) return 'はなれている';
  if (to.kind === 'world') return `地形の点 (${Math.round(to.pos[0] + worldOriginX)}, ${Math.round(to.pos[1] + worldOriginY)}, ${Math.round(to.pos[2] + worldOriginZ)})`;
  if (to.kind === 'rope') {
    const q = puppetGet(to.id);
    const where = to.t <= 0 ? 'はしA' : to.t >= 1 ? 'はしB' : `途中(${Math.round(to.t * 100)}%)`;
    return `${q ? q.name : 'ロープ'}の${where}`;
  }
  const type = entityRigType(to.key);
  const ik = (RIG_TYPES[type].ik || []).find(c => c.lower === to.joint);
  const jl = ik && to.u[1] <= -0.5 && Math.abs(to.u[0]) < 1e-6 && Math.abs(to.u[2]) < 1e-6 ? ik.label + 'の先' : rigJointLabel(type, to.joint);
  return `${poseEntityName(to.key)}の${jl}`;
}

// くっつける先を、再生ヘッドの時刻から変える(始めの時刻なら最初の設定を変える)
function linkSetEnd(p, end, to, pos) {
  const L = p.link;
  const span = _puppetSpan(p.id);
  const f = Math.round(curTick);
  const evs = L.ends[end];
  const ev = { tick: f, to };
  if (!to) ev.pos = pos || null;
  if (!span || f <= span[0]) { evs[0] = { ...ev, tick: 0 }; }
  else {
    const i = evs.findIndex((e, k) => k > 0 && e.tick === f);
    if (i >= 0) evs[i] = ev; else evs.push(ev);
    evs.sort((x, y) => x.tick - y.tick);
    if (evs[0].tick !== 0 && evs.length) evs[0].tick = 0;
  }
}

function linkStartPick(id, end) {
  linkPick = { id, end };
  showToast(`🎯 はし${end.toUpperCase()}を、くっつける先(体・ロープ・地形)をクリック / Esc でやめる`);
  editorChanged();
}
function linkCancelPick() { if (!linkPick) return false; linkPick = null; editorChanged(); return true; }

function _linkApplyPick(mx, my) {
  const p = puppetGet(linkPick.id);
  const end = linkPick.end;
  linkPick = null;
  if (!linkOf(p)) return;
  const hit = linkFindTarget(mx, my, p.id);
  if (!hit) { showToast('くっつけられる物がありませんでした'); editorChanged(); return; }
  if (hit.to.kind === 'rope' && _linkDependsOn(hit.to.id, p.id)) { showToast('つながりが輪になるので、そこにはくっつけられません'); editorChanged(); return; }
  pushUndo();
  linkSetEnd(p, end, hit.to);
  showToast(`🔗 はし${end.toUpperCase()}を「${hit.label}」にくっつけました(${(curTick / scTps()).toFixed(1)}秒から)`);
  editorChanged();
}

// ロープ id が、ロープ target に(くっつき先をたどって)つながっているか
function _linkDependsOn(id, target, depth) {
  if (id === target) return true;
  if ((depth || 0) > 6) return false;
  const q = puppetGet(id);
  if (!linkOf(q)) return false;
  for (const end of ['a', 'b']) for (const ev of q.link.ends[end]) {
    if (ev.to && ev.to.kind === 'rope' && _linkDependsOn(ev.to.id, target, (depth || 0) + 1)) return true;
  }
  return false;
}

// poses.js の poseMouseDown の最初に呼ぶ。処理したら true
function linkMouseDown(e, mx, my) {
  if (linkPick) { _linkApplyPick(mx, my); return true; }
  const { view, proj } = _fcEditViewProj();
  const sel = _poseEditingOn() ? _linkSelected() : null;
  if (sel) {
    const m = _linkPickEnd(sel, mx, my, view, proj);
    if (m) {
      // はしの印: ドラッグして落とした所にくっつける。動かさずに離したら、次のクリックで選ぶ
      poseDrag = { link: true, id: sel.id, end: m.end, startMouse: [mx, my], pending: true, cur: [mx, my] };
      return true;
    }
  }
  const rope = linkPickRope(mx, my, view, proj, null);
  if (rope) {
    // エンティティの方が手前ならそちらを選ぶ
    const ent = _posePickEntity(_poseRay(mx, my));
    const q = puppetGet(rope.id);
    if (!ent || ent.key === 'puppet:' + rope.id || rope.d < 4) { poseSelectEntity('puppet:' + q.id, 'root', false); return true; }
  }
  return false;
}

function linkDragMove(d, mx, my) {
  d.cur = [mx, my];
  if (d.pending && Math.hypot(mx - d.startMouse[0], my - d.startMouse[1]) >= 3) d.pending = false;
  d.hover = d.pending ? null : linkFindTarget(mx, my, d.id);
}
function linkDragEnd(d) {
  if (d.pending) { linkStartPick(d.id, d.end); return; }
  linkPick = { id: d.id, end: d.end };
  _linkApplyPick(d.cur[0], d.cur[1]);
}

// 3Dの印(ロープを選んでいる時: はしA=橙・はしB=水色、くっつく先の線)
function renderLinkGizmos(gl, view, proj, W, H) {
  const sel = _poseEditingOn() ? _linkSelected() : null;
  const d = (typeof poseDrag !== 'undefined' && poseDrag && poseDrag.link) ? poseDrag : null;
  if (sel) {
    const st = linkState(sel, curTick);
    if (st) {
      const n = st.pts.length / 3;
      const line = [];
      for (let i = 0; i < n - 1; i++) line.push([st.pts[i * 3], st.pts[i * 3 + 1], st.pts[i * 3 + 2]], [st.pts[i * 3 + 3], st.pts[i * 3 + 4], st.pts[i * 3 + 5]]);
      _drawLineSegments(gl, view, proj, line, [1, 0.86, 0.3], W, H, 1.4);
      for (const m of _linkEndMarks(sel)) {
        const col = m.end === 'a' ? [1, 0.6, 0.2] : [0.35, 0.9, 0.95];
        const hot = linkHoverEnd === m.end || (d && d.end === m.end) || (linkPick && linkPick.id === sel.id && linkPick.end === m.end);
        _drawLineSegments(gl, view, proj, _poseCircleSegments(m.pos, hot ? 10 : 7.5), col, W, H, hot ? 3.4 : 2.6);
        _drawLineSegments(gl, view, proj, _keyDiamondSegments(m.pos, 2.5), col, W, H, 2);
      }
    }
  }
  // ドラッグ中: 落とす先の印
  if (d && d.hover && !d.pending) {
    const pos = d.hover.pos || (d.hover.to.kind === 'rope' ? linkAnchorPos(d.hover.to, curTick) : null);
    if (pos) _drawLineSegments(gl, view, proj, _poseCircleSegments(pos, 6), [0.5, 1, 0.5], W, H, 3);
  }
}

// マウスカーソル
function linkHoverAt(mx, my) {
  linkHoverEnd = null;
  if (linkPick) return 'crosshair';
  const { view, proj } = _fcEditViewProj();
  const sel = _poseEditingOn() ? _linkSelected() : null;
  if (sel) { const m = _linkPickEnd(sel, mx, my, view, proj); if (m) { linkHoverEnd = m.end; return 'grab'; } }
  return linkPickRope(mx, my, view, proj, null) ? 'pointer' : false;
}

function linkContextHint() {
  if (linkPick) {
    return `🎯 はし${linkPick.end.toUpperCase()}のくっつける先をクリック: 体(手・足の先の方をクリックすると先にぴったり)・別のロープ・地形 / Esc: やめる`;
  }
  const d = (typeof poseDrag !== 'undefined' && poseDrag && poseDrag.link) ? poseDrag : null;
  if (d) return d.hover ? `離すと「${d.hover.label}」にくっつきます` : 'くっつける先の上で離す';
  const sel = _poseEditingOn() ? _linkSelected() : null;
  if (sel) return `${sel.name}: はしの○(橙=A・水色=B)をドラッグして、体・ロープ・地形の上で離すとくっつく / クリックだけなら次にクリックした所へ / 設定は右のパネル`;
  return null;
}


// ============================================================
// 右のパネル(ブロックのエンティティの「つなぐ」)
// ============================================================

function renderLinkPanel(body, p) {
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };
  const pills = (items, cur, onPick) => {
    const g = _el('div', 'settingsRadioGroup');
    for (const [id, label] of items) {
      const b = _el('button', 'settingsRadioPill small' + (cur === id ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { if (cur === id) return; pushUndo(); onPick(id); editorChanged(); });
      g.appendChild(b);
    }
    body.appendChild(g);
  };
  const slider = (label, min, max, step, get, set, fmt) => {
    const r = row(label);
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const v = _el('span', 'fieldValue', fmt(get()));
    bindEditUndo(inp);
    inp.addEventListener('input', () => { set(parseFloat(inp.value)); v.innerText = fmt(get()); });
    r.appendChild(inp); r.appendChild(v);
    return inp;
  };

  sec('🔗 つなぐ(ロープ・鎖・糸)');
  if (!p.link) {
    body.appendChild(_el('div', 'panelHint', '両はしを、体(手の先など)・別のロープ・地形にくっつけると、間がロープや鎖になって、動きに合わせて伸び縮み・たるみ・ゆれます。'));
    const acts = _el('div', 'panelActions');
    const on = _el('button', 'btn btn-primary btn-sm', '🔗 このブロックをロープ・鎖にする');
    on.addEventListener('click', () => { pushUndo(); linkCreate(p); editorChanged(); showToast('🔗 ロープにしました。はしの○をドラッグして、くっつける先の上で離してください'); });
    acts.appendChild(on);
    body.appendChild(acts);
    return;
  }
  const L = p.link;

  // はし
  for (const end of ['a', 'b']) {
    const evs = L.ends[end];
    const box = _el('div', 'linkEnd' + (end === 'a' ? ' endA' : ' endB'));
    box.appendChild(_el('div', 'linkEndTitle', end === 'a' ? '● はしA' : '● はしB'));
    const span = _puppetSpan(p.id);
    const i = _linkEvIndex(evs, Math.round(curTick));
    evs.forEach((ev, k) => {
      const line = _el('div', 'linkEv' + (k === i ? ' now' : ''));
      const t = k === 0 ? '始め' : `${((ev.tick - (span ? span[0] : 0)) / scTps()).toFixed(1)}秒`;
      const txt = _el('span', 'linkEvText', `${t}〜 ${ev.to ? '🔗 ' + _linkLabel(ev.to) : '✋ はなれている'}`);
      txt.title = 'クリックでこの時刻へ';
      txt.addEventListener('click', () => { if (k > 0) seekTo(ev.tick); else if (span) seekTo(span[0]); });
      line.appendChild(txt);
      if (k > 0) {
        const x = _el('button', 'linkEvDel', '✕'); x.type = 'button'; x.title = 'この切り替えを消す';
        x.addEventListener('click', () => { pushUndo(); evs.splice(k, 1); editorChanged(); });
        line.appendChild(x);
      }
      box.appendChild(line);
    });
    const acts = _el('div', 'genActions');
    const pick = _el('button', 'btn btn-ghost btn-sm' + (linkPick && linkPick.id === p.id && linkPick.end === end ? ' active' : ''), '🎯 くっつける先を選ぶ');
    pick.title = '再生ヘッドの時刻から、くっつく先が変わります(始めの時刻なら最初から)';
    pick.addEventListener('click', () => linkStartPick(p.id, end));
    const free = _el('button', 'btn btn-ghost btn-sm', '✋ ここではなす');
    free.title = '再生ヘッドの時刻で、このはしをはなします(ゆれる設定なら落ちる)';
    free.addEventListener('click', () => {
      const st = linkState(p, curTick);
      pushUndo();
      linkSetEnd(p, end, null, st ? st.ends[end].slice() : null);
      editorChanged();
    });
    acts.appendChild(pick); acts.appendChild(free);
    box.appendChild(acts);
    body.appendChild(box);
  }
  const sh = slider('飛んでいく時間', 0, 1.5, 0.05, () => L.shootSec, v => { L.shootSec = v; }, v => v <= 0 ? 'すぐ' : v.toFixed(2) + '秒');
  sh.title = '途中でくっつける時、はしがくっつく先まで飛んでいく時間(糸を発射する感じ)';

  sec('見た目');
  pills(LINK_LOOKS, L.look, id => { L.look = id; });
  slider(L.look === 'chain' ? '輪の大きさ' : '太さ', 0.03, 1.5, 0.01, () => L.thick, v => { L.thick = v; }, v => v.toFixed(2));

  sec('たるみ・長さ');
  pills([['auto', '両はしの距離に合わせる'], ['fixed', '長さを決める']], L.lenMode, id => {
    if (id === 'fixed') { const st = linkState(p, curTick); if (st) L.length = Math.round(st.rest * 100) / 100; }
    L.lenMode = id;
  });
  if (L.lenMode === 'auto') {
    const g = _el('div', 'settingsRadioGroup');
    for (const [label, v] of LINK_SLACK_PRESETS) {
      const b = _el('button', 'settingsRadioPill small' + (Math.abs(L.slack - v) < 1e-6 ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { pushUndo(); L.slack = v; editorChanged(); });
      g.appendChild(b);
    }
    body.appendChild(g);
    slider('たるみ', 0, 2, 0.01, () => L.slack, v => { L.slack = v; }, v => '+' + Math.round(v * 100) + '%');
  } else {
    slider('長さ', 0.2, 60, 0.1, () => L.length, v => { L.length = v; }, v => v.toFixed(1) + 'ブロック');
    body.appendChild(_el('div', 'panelHint', '両はしが近づくとたるみ、離れるとピンと張ります(ゆれる設定なら少し伸びる)。'));
  }
  // 長さの倍率(時間で変える: 巻き取る・伸ばす)
  const f = Math.round(curTick);
  const ks = L.lenKeys || (L.lenKeys = []);
  const mr = slider('長さの倍率', 0.05, 3, 0.01, () => _linkLenMul(L, f), v => {
    let k = ks.find(q => Math.abs(q.tick - f) <= 1);
    if (!k) { k = { tick: f, k: v }; ks.push(k); ks.sort((a, b) => a.tick - b.tick); }
    k.k = v;
  }, v => '×' + v.toFixed(2));
  mr.title = '動かすと、再生ヘッドの時刻に長さのキーができます(巻き取る・伸ばす動きが作れる)';
  if (ks.length) {
    const list = _el('div', 'linkKeys');
    ks.forEach((k, idx) => {
      const chip = _el('span', 'linkKey' + (Math.abs(k.tick - f) <= 1 ? ' now' : ''), `◆ ${(k.tick / scTps()).toFixed(1)}s ×${k.k.toFixed(2)}`);
      chip.addEventListener('click', () => seekTo(k.tick));
      const x = _el('button', 'linkEvDel', '✕'); x.type = 'button';
      x.addEventListener('click', (e) => { e.stopPropagation(); pushUndo(); ks.splice(idx, 1); editorChanged(); });
      chip.appendChild(x);
      list.appendChild(chip);
    });
    body.appendChild(list);
  }

  sec('動き');
  pills([['physics', '〰 ゆれる(重さで垂れる・落ちる)'], ['shape', '形だけ(ゆれない)']], L.motion, id => { L.motion = id; });
  if (L.motion === 'physics') {
    slider('重さ', 0, 3, 0.05, () => L.gravity, v => { L.gravity = v; }, v => '×' + v.toFixed(2));
    slider('伸び(ゴム)', 0, 0.9, 0.01, () => L.stretch, v => { L.stretch = v; }, v => Math.round(v * 100) + '%');
    slider('ゆれの止まりやすさ', 0, 1, 0.01, () => L.damping, v => { L.damping = v; }, v => Math.round(v * 100) + '%');
    slider('風', 0, 2, 0.05, () => L.wind, v => { L.wind = v; }, v => v <= 0 ? 'なし' : v.toFixed(2));
    if (L.wind > 0) slider('風の向き', 0, 359, 1, () => L.windDir, v => { L.windDir = v; }, v => Math.round(v) + '°');
    const cRow = _el('label', 'scriptCheck');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!L.collide;
    cb.addEventListener('change', () => { pushUndo(); L.collide = cb.checked; editorChanged(); });
    cRow.appendChild(cb); cRow.appendChild(document.createTextNode('地形に当たる(ブロックの上に乗る)'));
    body.appendChild(cRow);
  }

  const acts = _el('div', 'panelActions');
  const off = _el('button', 'btn btn-ghost btn-sm', '🧱 つなぐのをやめて、ふつうのブロックに戻す');
  off.addEventListener('click', () => { pushUndo(); delete p.link; if (linkPick && linkPick.id === p.id) linkPick = null; editorChanged(); });
  acts.appendChild(off);
  body.appendChild(acts);
}
