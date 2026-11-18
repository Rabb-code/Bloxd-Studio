// official-blocks.js
// ============================================================
// 公式の形でブロックを描く(ステップ32)
//   - official/blocks.json      … ブロックの名前 → 描き方
//        {"cube":[+x,-x,上,下,+z,-z の絵]} / {"cross": 絵}(草花)/ {"model": モデルの名前}
//   - official/blockmodels.json … 公式のブロックのモデル(ドア・ベッド・トゲ…)。
//        ゲームと同じく「横幅が1ブロック」に縮めて、0〜1 のマスの中に置いてある。絵は textures.zip の bm__名前
// 地形と同じ頂点の列(freecam.js の _pushFaceVertices)に流すので、置く・壊すの演出もそのまま効く。
// 表が無い時・表に無いブロックは、前と同じ(パレットの絵1枚の箱)。
// ============================================================

const OFFBLK = { ready: false, blocks: null, models: null, variants: {}, materials: null };

async function officialBlocksLoad() {
  try {
    const [b, m, v] = await Promise.all([
      fetch('official/blocks.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('blocks.json ' + r.status); return r.json(); }),
      fetch('official/blockmodels.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      // ステップ36: 向きなどで形が変わる物(壁のランタン・柵の門の開け閉め…)。番号の名前 → {bm, lz}
      fetch('official/blockvariants.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    OFFBLK.blocks = b; OFFBLK.models = m; OFFBLK.variants = v || {}; OFFBLK.ready = true;
    // ステップ55: 公式の材質の表(元の名前 → { f: 液体, t: 透ける絵, l: 光の色 [赤,緑,青] 0〜15 })。無ければ名前で決める
    try { const r = await fetch('official/materials.json', { cache: 'no-cache' }); if (r.ok) OFFBLK.materials = await r.json(); } catch (e2) { /* 無くても動く */ }
  } catch (e) {
    console.warn('official/blocks.json が読めなかったので、ブロックは前の描き方にします:', e.message);
  }
}

// 面の角ごとの UV(絵の上 = ブロックの上。横から見て左右が反対にならない向き)
function offFaceCornerUV(dirCode, o) {
  const uv = _offFaceCornerUV0(dirCode, o);
  // ステップ41: 画面を左右反対に映す(公式と同じ見え方)ので、面の絵も左右を反対にして、字などが逆に見えないようにする
  if (typeof FC_MIRROR_X !== 'undefined' && FC_MIRROR_X) uv[0] = 1 - uv[0];
  return uv;
}
function _offFaceCornerUV0(dirCode, o) {
  const [x, y, z] = o;
  switch (dirCode) {
    case 0: return [1 - z, 1 - y]; // +x
    case 1: return [z, 1 - y];     // -x
    case 2: return [x, z];         // 上
    case 3: return [x, 1 - z];     // 下
    case 4: return [x, 1 - y];     // +z
    default: return [1 - x, 1 - y]; // -z
  }
}

// パレットの1つ → 描き方(UV の場所まで決めた物)。rects は fcUVRectsRaw
function offPaletteInfo(p, rects) {
  if (!OFFBLK.ready || !p || !p.root_name || !rects) return null;
  const b = OFFBLK.blocks[p.root_name];
  if (!b) return null;
  const R = (name) => rects.get(name) || null;
  const rot = (() => { const m = /rot(\d)/.exec(p.meta || ''); return m ? (+m[1] - 1) & 3 : 0; })();
  const variant = OFFBLK.variants[p.root_name + (p.meta ? '|' + p.meta : '')] || null;
  if (b.fence || b.gate) {
    // ステップ36: 柵・柵の門。つながる向き(n/e/s/w)や開け閉めは番号の meta に入っている
    const rs = (b.fence || b.gate).map(n => R(n));
    if (rs.every(r => !r)) return null;
    const fb = rs.find(r => r);
    const top = /^_.* Top$/.test(p.root_name); // 1.5 ブロックの高さの上の半分(公式は別のブロック)
    if (b.gate) {
      const tris = offGateTris(p.meta || '', top);
      if (tris) return { type: 'tris', tris, rect: rs[0] || fb };
    }
    return { type: 'boxes', boxes: offFenceBoxes(p.meta || '', top), rects: rs.map(r => r || fb), posUV: true };
  }
  if (b.cube) {
    const rs = b.cube.map(n => R(n));
    if (rs.every(r => !r)) return null;
    const fb = rs.find(r => r);
    return { type: 'cube', rects: rs.map(r => r || fb) };
  }
  if (b.slab) {
    // ステップ33: ハーフ。形は公式の当たり判定と同じ(main.js の mX: bot / top / side1〜4、1/8 単位)
    const rs = b.slab.map(n => R(n));
    if (rs.every(r => !r)) return null;
    const fb = rs.find(r => r);
    const meta = p.meta || '';
    const m = /rot(\d)/.exec(meta), k = m ? +m[1] : 1;
    const box = /\|top/.test(meta) ? [0, 0.5, 0, 1, 1, 1]
      : /\|side/.test(meta) ? [[0, 0, 0, 1, 1, 0.5], [0, 0, 0, 0.5, 1, 1], [0, 0, 0.5, 1, 1, 1], [0.5, 0, 0, 1, 1, 1]][(k - 1) & 3]
      : [0, 0, 0, 1, 0.5, 1];
    return { type: 'boxes', boxes: [box], rects: rs.map(r => r || fb) };
  }
  if (b.stairs) {
    // ステップ34: 階段。形は公式の当たり判定と同じ(main.js の階段の表。1/8 単位)
    const rs = b.stairs.map(n => R(n));
    if (rs.every(r => !r)) return null;
    const fb = rs.find(r => r);
    return { type: 'boxes', boxes: offStairsBoxes(p.meta || ''), rects: rs.map(r => r || fb), posUV: true };
  }
  if (b.cross) {
    const r = R(b.cross);
    return r ? { type: 'cross', rect: r } : null;
  }
  if (b.model) {
    const m = OFFBLK.models[(variant && variant.bm) || b.model] || OFFBLK.models[b.model];
    const r = m && R(m.tex);
    const strip = (m && typeof fcPaletteStrips !== 'undefined' && fcPaletteStrips.get(m.tex)) || 0;
    // ステップ38: 公式の向きの足し算(松明の壁の物は 180 度など)。rot と同じ回り方で足す
    const yr = (variant && variant.yr) || (!variant && b.yr) || 0;
    // 公式の rotatableOffset: rot1 は z を、rot2 は x を減らす、rot3 は z を、rot4 は x を増やす
    const ro = b.roa || 0, sh = [[0, -ro], [-ro, 0], [0, ro], [ro, 0]][rot];
    return (m && r) ? { type: 'model', model: m, rect: r, rot: (rot + yr) & 3, strip, shift: ro ? sh : null } : null;
  }
  return null;
}

// 階段の箱(0〜1)。meta = "meta|rot2|top|innerLeft" など(何も無い = rot1 の下向き)
//   公式: 下の板 [0,0,0,8,4,8] + 奥の段 [0,4,0,8,8,4]。角は innerLeft/innerRight(段を1つ足す)・outerLeft/outerRight(段が半分)。
//   向き rot k は (k-1) 回、(x0,y0,z0,x1,y1,z1) → (z0,y0,8-x1,z1,y1,8-x0)。上向き(top)は上下を逆に
const OFF_STAIRS = {
  '': [[0, 0, 0, 8, 4, 8], [0, 4, 0, 8, 8, 4]],
  innerLeft: [[0, 0, 0, 8, 4, 8], [0, 4, 0, 8, 8, 4], [4, 4, 4, 8, 8, 8]],
  innerRight: [[0, 0, 0, 8, 4, 8], [0, 4, 0, 8, 8, 4], [0, 4, 4, 4, 8, 8]],
  outerLeft: [[0, 0, 0, 8, 4, 8], [4, 4, 0, 8, 8, 4]],
  outerRight: [[0, 0, 0, 8, 4, 8], [0, 4, 0, 4, 8, 4]],
};
function offStairsBoxes(meta) {
  const m = /rot(\d)/.exec(meta), k = m ? ((+m[1] - 1) & 3) : 0;
  const top = /\|top/.test(meta);
  const c = /(innerLeft|innerRight|outerLeft|outerRight)/.exec(meta);
  return OFF_STAIRS[c ? c[1] : ''].map(b0 => {
    let [x0, y0, z0, x1, y1, z1] = b0;
    for (let i = 0; i < k; i++) [x0, z0, x1, z1] = [z0, 8 - x1, z1, 8 - x0];
    if (top) [y0, y1] = [8 - y1, 8 - y0];
    return [x0 / 8, y0 / 8, z0 / 8, x1 / 8, y1 / 8, z1 / 8];
  });
}

// 柵(公式の block/Fence.json と同じ寸法。柵は 1.5 ブロックの高さで、上の半分は「_… Top」という別のブロック)
//   下: 柱 0.375〜0.625(高さ 1)+ 向きごとに板 1 枚(y 0.4375〜0.75、厚さ 0.125)
//   上: 柱(高さ 0.5)+ 向きごとに板 1 枚(y -0.0625〜0.3125。下のブロックに少しはみ出す)
function offFenceBoxes(meta, top) {
  const dirs = (/meta\|([nesw]+)/.exec(meta) || [, ''])[1];
  const out = [[0.375, 0, 0.375, 0.625, top ? 0.5 : 1, 0.625]];
  const [y0, y1] = top ? [-0.0625, 0.3125] : [0.4375, 0.75];
  const arm = { n: [0.4375, 0, 0.5625, 0.375], s: [0.4375, 0.625, 0.5625, 1], e: [0.625, 0.4375, 1, 0.5625], w: [0, 0.4375, 0.375, 0.5625] };
  for (const d of dirs) { const a = arm[d]; if (a) out.push([a[0], y0, a[1], a[2], y1, a[3]]); }
  return out;
}

// 柵の門(公式の block/FenceGate.json の形。板に四角い穴が2つ、左右の2枚)
//   閉じている: そのまま(rot で回す)。開いている: 左右の板を、端のちょうつがいで 90 度回す
//   (公式の当たり判定: rot1 で開くと、板は両端で z の小さい方へ向く)
function offGateTris(meta, top) {
  const G = OFFBLK.models && OFFBLK.models.__FenceGate; if (!G || !G.parts) return null;
  const m = /rot(\d)/.exec(meta), k = m ? ((+m[1] - 1) & 3) : 0;
  const open = /\|open/.test(meta);
  const names = top ? ['TopLeft', 'TopRight'] : ['BottomLeft', 'BottomRight'];
  const out = []; // [x,y,z,u,v] × 3 ずつ
  names.forEach((nm, side) => {
    const pt = G.parts[nm]; if (!pt) return;
    const P = pt.pos, U = pt.uv;
    const place = (i) => {
      let x = P[i * 3], y = P[i * 3 + 1] - (top ? 1 : 0), z = P[i * 3 + 2];
      if (open) {
        if (side === 0) { const dx = x + 0.5, dz = z; x = -0.5 + dz; z = -dx; }   // 左: ちょうつがい x=-0.5
        else { const dx = x - 0.5, dz = z; x = 0.5 - dz; z = dx; }                 // 右: ちょうつがい x=+0.5
      }
      for (let r = 0; r < k; r++) { const t = x; x = z; z = -t; }
      return [x + 0.5, y, z + 0.5, Math.min(Math.max(U[i * 2], 0), 1), Math.min(Math.max(U[i * 2 + 1], 0), 1)];
    };
    for (const i of pt.idx) out.push(place(i));
  });
  return out;
}

// 1つのブロック(草花・モデル)の三角形を積む。bx,by,bz はローカル座標のブロックの角
function offPushShape(info, bx, by, bz, revealTick, hideTick, out) {
  if (info.type === 'boxes') {
    // 箱の一部(ハーフなど)。6面とも、面いっぱいに絵を1枚貼る(公式のハーフ専用の横の絵は 8×8 で、ふちまで描いてある)
    for (const bxs of info.boxes) {
      const [x0, y0, z0, x1, y1, z1] = bxs;
      for (let d = 0; d < 6; d++) {
        const r = info.rects[d], br = DIR_FACTOR[d];
        for (const oi of [0, 1, 2, 0, 2, 3]) {
          const o = FACE_OFFSETS[d][oi];
          const px = o[0] ? x1 : x0, py = o[1] ? y1 : y0, pz = o[2] ? z1 : z0;
          // 階段は場所で絵を切り取る(段の面に絵がつながって見える)。ハーフは面いっぱいに1枚
          // (柵の上の板のように、マスの外へ少しはみ出す所は、絵の端の色を使う)
          const cl = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
          const [cu, cv] = offFaceCornerUV(d, info.posUV ? [cl(px), cl(py), cl(pz)] : o);
          out.push(bx + px, by + py, bz + pz,
            r[0] + cu * (r[2] - r[0]), r[1] + cv * (r[3] - r[1]), br, revealTick, hideTick);
        }
      }
    }
    return;
  }
  const rc = info.rect, du = rc[2] - rc[0], dv = rc[3] - rc[1];
  if (info.type === 'tris') {
    // 公式の形の三角形(柵の門)。明るさは三角形の向きで
    const T = info.tris;
    for (let t = 0; t + 2 < T.length; t += 3) {
      const A = T[t], B = T[t + 1], C = T[t + 2];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const nx = Math.abs(uy * vz - uz * vy), ny = uz * vx - ux * vz, nz = Math.abs(ux * vy - uy * vx);
      const br = (Math.abs(ny) >= nx && Math.abs(ny) >= nz) ? (ny > 0 ? DIR_FACTOR[2] : DIR_FACTOR[3]) : (nx >= nz ? DIR_FACTOR[0] : DIR_FACTOR[4]);
      for (const q of [A, B, C]) out.push(bx + q[0], by + q[1], bz + q[2], rc[0] + q[3] * du, rc[1] + q[4] * dv, br, revealTick, hideTick);
    }
    return;
  }
  if (info.type === 'cross') {
    // 対角線の板2枚(公式の CentreCross)
    const q = [[[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]], [[1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 1, 0]]];
    const uv = [[0, 1], [1, 1], [1, 0], [0, 0]];
    for (const quad of q) for (const i of [0, 1, 2, 0, 2, 3]) {
      const c = quad[i];
      out.push(bx + c[0], by + c[1], bz + c[2], rc[0] + uv[i][0] * du, rc[1] + uv[i][1] * dv, 0.85, revealTick, hideTick);
    }
    return;
  }
  const m = info.model, P = m.pos, U = m.uv, I = m.idx;
  // 向き: rot ごとに 90 度ずつ(ブロックの真ん中で回す。公式の当たり判定の回し方と同じ (x,z)→(z,-x))
  const rotP = (x, z) => {
    let X = x - 0.5, Z = z - 0.5;
    for (let k = 0; k < info.rot; k++) { const t = X; X = Z; Z = -t; }
    return [X + 0.5, Z + 0.5];
  };
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    // 明るさ: 三角形の向きで、地形の面と同じ明るさの決まり(DIR_FACTOR)
    // (x は下で鏡写しにするので、ここでも反対にして向きを出す)
    const ux = -(P[b] - P[a]), uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = -(P[c] - P[a]), vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = Math.abs(uy * vz - uz * vy), ny = uz * vx - ux * vz, nz = Math.abs(ux * vy - uy * vx);
    const br = (Math.abs(ny) >= nx && Math.abs(ny) >= nz) ? (ny > 0 ? DIR_FACTOR[2] : DIR_FACTOR[3]) : (nx >= nz ? DIR_FACTOR[0] : DIR_FACTOR[4]);
    for (const vi of [I[t], I[t + 1], I[t + 2]]) {
      // ステップ38: 公式(Babylon.js)は glb を読む時に左右(x)を鏡写しにする(__root__ を y で 180 度 + z を -1 倍)。
      //   ブロックのモデルはそのまま使われるので、ここでも x を反対にする(掲示板の端の部品の枠が外側に来る)
      const [x, z] = rotP(1 - P[vi * 3], P[vi * 3 + 2]);
      let u = Math.min(Math.max(U[vi * 2], 0), 1), v = Math.min(Math.max(U[vi * 2 + 1], 0), 1);
      if (info.strip) { // 色の帯 → 16×16 の格子のその色のマスの真ん中
        const ci = Math.min(info.strip - 1, Math.floor(u * info.strip));
        u = ((ci % 16) + 0.5) / 16; v = (Math.floor(ci / 16) + 0.5) / 16;
      }
      const sx = info.shift ? info.shift[0] : 0, sz = info.shift ? info.shift[1] : 0;
      out.push(bx + x + sx, by + P[vi * 3 + 1], bz + z + sz, rc[0] + u * du, rc[1] + v * dv, br, revealTick, hideTick);
    }
  }
}

// 何で描けたかを数えてコンソールに出す(うまく出ない時の手がかり)。コンソールで offBlocksReport() と打っても出る
function offBlocksReport() {
  const pal = (typeof fcMeshPalette !== 'undefined' && fcMeshPalette) || [];
  const rects = (typeof fcUVRectsRaw !== 'undefined') ? fcUVRectsRaw : null;
  const n = { cube: 0, boxes: 0, cross: 0, model: 0, old: 0, none: 0 }, old = [], none = [];
  for (const p of pal) {
    const info = offPaletteInfo(p, rects);
    if (info) n[info.type === 'tris' ? 'boxes' : info.type]++;
    else if (p && p.texture && rects && rects.has(p.texture)) { n.old++; if (old.length < 15) old.push(p.root_name); }
    else { n.none++; if (none.length < 15 && p && p.root_name) none.push(p.root_name); }
  }
  console.info(`[公式ブロック] 表: ${OFFBLK.ready ? '読めた' : '読めていない'}(${OFFBLK.blocks ? Object.keys(OFFBLK.blocks).length : 0} 個・モデル ${OFFBLK.models ? Object.keys(OFFBLK.models).length : 0} 個)、` +
    `絵: ${rects ? rects.size : 0} 枚(モデルの絵 ${rects ? [...rects.keys()].filter(k => k.startsWith('bm__')).length : 0} 枚)`);
  console.info(`[公式ブロック] 今のリプレイ: 箱 ${n.cube}・ハーフ ${n.boxes}・十字 ${n.cross}・モデル ${n.model}・前の描き方 ${n.old}・絵が無いので出さない ${n.none}`, { 前の描き方: old, 出さない: none });
  return n;
}
