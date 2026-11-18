// constraints.js
// ============================================================
// 🔗 くっつく・向く・届く(人形・ブロックのエンティティに付けるルール)
//
//   くっつく(根元): 時間を決めて、体の部品・ほかの人形やブロック・地形の点にくっつく。
//       くっついている間は、相手と一緒に動いて一緒に回る(自分のキーの動きは、その上に乗る)。
//       はなすと、その時の場所に残る。「根元を合わせる」なら、クリックした点に根元(足元/下の面)が移る。
//   向く(ブロック): 上の面を、ある物の方へ向ける。「届く」なら、そこまで伸びる。
//       切り替えの時間をかけて、なめらかに向きを変える(糸を発射する感じも作れる)。
//
//   データ(人形 p.cons):
//     parent: [ {tick, to, snap} ]   to=null は「ここではなす」
//     aim:    [ {tick, to} ]         to=null は「ここで向くのをやめる」
//     reach: 届くまで伸ばすか / blend: 向きを切り替える時間(秒)
//     to = { kind:'part', key, joint, u:[x,y,z] }   体の部品の箱の中の点(-0.5〜0.5)
//          { kind:'world', pos:[x,y,z] }            地形などの決まった点(ローカル座標)
//
//   計算は毎フレームその場で行う(覚えておく状態が無いので、どこへ戻っても同じ)。
//   poseRigFor(key, frame) が、ルールを全部かけた組み立てを返す。描画・クリック・ギズモはこれを使う。
// ============================================================

const CONS_MAX_DEPTH = 6;

function consOf(p) { return p && p.cons && ((p.cons.parent && p.cons.parent.length) || (p.cons.aim && p.cons.aim.length)) ? p.cons : null; }
function _consEnsure(p) {
  if (!p.cons) p.cons = { parent: [], aim: [], reach: false, blend: 0.2, snap: true };
  return p.cons;
}
function _consPuppetOfKey(key) { return key && key.startsWith('puppet:') ? puppetGet(+key.slice(7)) : null; }


// ============================================================
// 行列の道具
// ============================================================

function _m4T(v) { return mat4Translate(v[0], v[1], v[2]); }

// 部品の箱の行列から、大きさを除いた「向き+点の位置」の行列
function _consFrameFromModel(m, u) {
  const c = (i) => { const l = Math.hypot(m[i], m[i + 1], m[i + 2]) || 1; return [m[i] / l, m[i + 1] / l, m[i + 2] / l]; };
  const x = c(0), y = c(4), z = c(8);
  const p = _m4Point(m, u || [0, 0, 0]);
  return new Float32Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, p[0], p[1], p[2], 1]);
}

// a の向きを b の向きに回す行列(どちらも長さ1)
function _consRotBetween(a, b) {
  let ax = fcVecCross(a, b);
  const s = Math.hypot(ax[0], ax[1], ax[2]), c = fcVecDot(a, b);
  if (s < 1e-8) {
    if (c > 0) return mat4Translate(0, 0, 0);
    ax = Math.abs(a[0]) < 0.9 ? fcVecNormalize(fcVecCross(a, [1, 0, 0])) : fcVecNormalize(fcVecCross(a, [0, 1, 0]));
  } else ax = [ax[0] / s, ax[1] / s, ax[2] / s];
  const ang = Math.atan2(s, c), C = Math.cos(ang), S = Math.sin(ang), t = 1 - C;
  const [x, y, z] = ax;
  return new Float32Array([
    t * x * x + C, t * x * y + S * z, t * x * z - S * y, 0,
    t * x * y - S * z, t * y * y + C, t * y * z + S * x, 0,
    t * x * z + S * y, t * y * z - S * x, t * z * z + C, 0,
    0, 0, 0, 1]);
}

// 組み立て全体を M で動かす
function _consApply(rig, M) {
  const o = { pre: {}, frame: {}, parent: {}, parts: null };
  for (const k of ['pre', 'frame', 'parent']) for (const j in rig[k]) o[k][j] = _m4Mul(M, rig[k][j]);
  o.parts = rig.parts.map(pt => ({ joint: pt.joint, model: _m4Mul(M, pt.model) }));
  return o;
}


// ============================================================
// くっつく先の位置・向き
// ============================================================

// to の、フレーム f での行列(向き+点の位置)。見えていなければ null
function consTargetFrame(to, f, depth) {
  if (!to) return null;
  if (to.kind === 'world') return _m4T(to.pos);
  if (to.kind === 'part') {
    const rig = poseRigFor(to.key, f, null, (depth || 0) + 1);
    if (!rig) return null;
    const part = rig.parts.find(q => q.joint === to.joint);
    return part ? _consFrameFromModel(part.model, to.u) : null;
  }
  return null;
}
function consTargetPoint(to, f, depth) {
  const m = consTargetFrame(to, f, depth);
  return m ? [m[12], m[13], m[14]] : null;
}

function _consEvIndex(evs, f) {
  let i = -1;
  for (let k = 0; k < evs.length; k++) if (evs[k].tick <= f) i = k;
  return i;
}

// 自分の(ルールをかける前の)足元の点
function _consOwnBottom(key, f) {
  const base = poseEntityBase(key, f);
  if (!base) return null;
  const rig = poseBuildRig(entityRigType(key), base, poseEntityPose(key, f));
  return _m4Point(rig.frame.root, [0, 0, 0]);
}

// 自分の(ルールをかける前の)部品の点の行列。from = { joint, u }
function _consOwnFrame(key, from, f) {
  const base = poseEntityBase(key, f);
  if (!base) return null;
  const rig = poseBuildRig(entityRigType(key), base, poseEntityPose(key, f));
  const part = rig.parts.find(q => q.joint === from.joint);
  return part ? _consFrameFromModel(part.model, from.u) : null;
}
function _consRotOnly(m) { const o = new Float32Array(m); o[12] = o[13] = o[14] = 0; return o; }
function _consTranspose(m) {
  return new Float32Array([m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1]);
}

// くっつくルールの行列(無ければ null)
function _consParentM(p, f, depth) {
  const evs = (p.cons && p.cons.parent) || [];
  const i = _consEvIndex(evs, f);
  return i < 0 ? null : _consParentK(p, i, f, depth);
}
function _consParentK(p, k, f, depth) {
  const ev = p.cons.parent[k];
  const span = _puppetSpan(p.id);
  const t0 = span ? Math.max(ev.tick, span[0]) : ev.tick;
  const prev = (t) => (k > 0 ? _consParentK(p, k - 1, t, depth) : null);
  const prev0 = prev(t0);
  if (!ev.to) return prev0; // はなした: その時の場所に残る
  const P = consTargetFrame(ev.to, f, depth), P0 = consTargetFrame(ev.to, t0, depth);
  if (!P || !P0) return prev0;
  const inv0 = _m4Inverse(P0);
  if (!inv0) return prev0;
  let M = _m4Mul(P, inv0);
  let rest = prev0;
  if (ev.snap && ev.from) {
    // 自分の点(from)を、相手の点に合わせる。align なら向きも相手にそろえる
    const W0 = _consOwnFrame('puppet:' + p.id, ev.from, t0);
    if (W0) {
      const W = prev0 ? _m4Mul(prev0, W0) : W0;
      const S = [W[12], W[13], W[14]];
      let K;
      if (ev.align) {
        const Rc = _m4Mul(_consRotOnly(P0), _consTranspose(_consRotOnly(W)));
        K = _m4Mul(_m4T([P0[12], P0[13], P0[14]]), Rc, _m4T([-S[0], -S[1], -S[2]]));
      } else K = _m4T([P0[12] - S[0], P0[13] - S[1], P0[14] - S[2]]);
      rest = rest ? _m4Mul(K, rest) : K;
    }
  } else if (ev.snap) {
    const b = _consOwnBottom('puppet:' + p.id, t0);
    if (b) {
      const B = prev0 ? _m4Point(prev0, b) : b;
      const d = [P0[12] - B[0], P0[13] - B[1], P0[14] - B[2]];
      rest = rest ? _m4Mul(_m4T(d), rest) : _m4T(d);
    }
  }
  return rest ? _m4Mul(M, rest) : M;
}

// 向ける先の点(切り替えの途中はなめらかに)。向かない時は null
function _consAimPoint(p, f, depth, natTop) {
  const evs = (p.cons && p.cons.aim) || [];
  const i = _consEvIndex(evs, f);
  if (i < 0) return null;
  const ev = evs[i];
  const pt = (e) => (e && e.to ? consTargetPoint(e.to, f, depth) : null);
  const now = pt(ev);
  const blend = Math.max(0, p.cons.blend || 0) * scTps();
  const u = blend > 0 ? (f - ev.tick) / blend : 1;
  if (u >= 1) return now;
  const from = (i > 0 ? pt(evs[i - 1]) : null) || natTop;
  const to = now || natTop;
  const e = 1 - Math.pow(1 - Math.max(0, u), 2);
  return [0, 1, 2].map(k => from[k] + (to[k] - from[k]) * e);
}


// ============================================================
// ルールをかけた組み立て
// ============================================================

// poseOverride: IK などで、ポーズだけ差しかえて組み立てたい時
function poseRigFor(key, f, poseOverride, depth) {
  const base = poseEntityBase(key, f);
  if (!base) return null;
  const type = entityRigType(key);
  const pose = poseOverride || poseEntityPose(key, f);
  const p = _consPuppetOfKey(key);
  depth = depth || 0;
  if (!consOf(p) || depth > CONS_MAX_DEPTH) return poseBuildRig(type, base, pose);
  const C = _consParentM(p, f, depth);
  const build = (pz) => { const r = poseBuildRig(type, base, pz); return C ? _consApply(r, C) : r; };
  let rig = build(pose);
  // 向く・届く
  if (p.cons.aim && p.cons.aim.length) {
    const len0 = _consLength(type, base, pose);
    const B0 = _m4Point(rig.frame.root, [0, 0, 0]);
    const up0 = _m4Dir(rig.frame.root, [0, 1, 0]);
    const natTop = [0, 1, 2].map(k => B0[k] + up0[k] * len0);
    const T = _consAimPoint(p, f, depth, natTop);
    if (T) {
      const dv = [T[0] - B0[0], T[1] - B0[1], T[2] - B0[2]];
      const dist = Math.hypot(dv[0], dv[1], dv[2]);
      if (p.cons.reach && dist > 1e-4 && len0 > 1e-6) {
        const pz = {};
        for (const j in pose) pz[j] = _jClone(pose[j]);
        const s = pz.root.s ? pz.root.s.slice() : [1, 1, 1];
        s[1] *= dist / len0;
        pz.root.s = s;
        rig = build(pz);
        const B1 = _m4Point(rig.frame.root, [0, 0, 0]);
        rig = _consApply(rig, _m4T([B0[0] - B1[0], B0[1] - B1[1], B0[2] - B1[2]]));
      }
      if (dist > 1e-4) {
        const up = _m4Dir(rig.frame.root, [0, 1, 0]);
        const R = _consRotBetween(up, [dv[0] / dist, dv[1] / dist, dv[2] / dist]);
        rig = _consApply(rig, _m4Mul(_m4T(B0), R, _m4T([-B0[0], -B0[1], -B0[2]])));
      }
    }
  }
  return rig;
}

// 足元から上の面までの長さ
function _consLength(type, base, pose) {
  if (type === 'block') return ((base.size && base.size[1]) || 1) * ((pose.root.s && pose.root.s[1]) || 1);
  return type === 'humanoid' ? 1.95 : 0.5;
}

// 人形 id が、くっつく先をたどって target にたどり着くか(輪になるのを防ぐ)
function consDependsOn(key, targetKey, depth) {
  if (key === targetKey) return true;
  if ((depth || 0) > CONS_MAX_DEPTH) return false;
  const p = _consPuppetOfKey(key);
  if (!p || !p.cons) return false;
  for (const ev of [...(p.cons.parent || []), ...(p.cons.aim || [])]) {
    if (ev.to && ev.to.kind === 'part' && consDependsOn(ev.to.key, targetKey, (depth || 0) + 1)) return true;
  }
  return false;
}


// ============================================================
// くっつける先を選ぶ(画面の点の先)
// ============================================================

// 箱(-0.5〜0.5)の中を線が通る区間 [入る, 出る]
function _consRayBox(inv, ray) {
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

// { to, pos, label }。selfKey(とそれにくっついている物)は選ばない
function consFindTarget(mx, my, selfKey) {
  const ray = _poseRay(mx, my);
  let ent = null;
  for (const e of poseEntityList()) {
    if (e.key === selfKey || (selfKey && consDependsOn(e.key, selfKey))) continue;
    const rig = poseRigFor(e.key, curTick);
    if (!rig) continue;
    const hit = _posePickPart(rig, ray);
    if (hit && (!ent || hit.t < ent.t)) ent = { key: e.key, joint: hit.joint, t: hit.t, rig, type: e.type };
  }
  const tv = _poseTickVal(curTick);
  const ground = (typeof pfRaycastLocal === 'function') ? pfRaycastLocal(ray.origin, ray.dir, 120, tv) : null;
  if (ent && (!ground || ent.t <= ground.dist + 0.05)) {
    const part = ent.rig.parts.find(q => q.joint === ent.joint);
    const inv = _m4Inverse(part.model);
    const hp = [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * ent.t);
    let u = inv ? _m4Point(inv, hp).map(v => Math.max(-0.5, Math.min(0.5, v))) : [0, 0, 0];
    // ひじ・ひざから先の、先の方をクリックした時は、手・足の先にぴったり付ける
    // (箱の中を線が通る区間の真ん中で見る。上から見て上の面に当たっても、先の方なら先に付く)
    const ik = (RIG_TYPES[ent.type].ik || []).find(c => c.upper === ent.joint);
    const tt = inv ? _consRayBox(inv, ray) : null;
    const um = tt ? _m4Point(inv, [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * (tt[0] + tt[1]) / 2)) : u;
    if (ik && um[1] < -0.1) u = [0, -0.5, 0];
    u = u.map(v => Math.round(v * 1000) / 1000);
    const to = { kind: 'part', key: ent.key, joint: ent.joint, u };
    return { to, label: consLabel(to), pos: _m4Point(part.model, u) };
  }
  if (ground) {
    const pos = ground.pos.map(v => Math.round(v * 100) / 100);
    const to = { kind: 'world', pos };
    return { to, label: consLabel(to), pos };
  }
  return null;
}

function consLabel(to) {
  if (!to) return 'なし';
  if (to.kind === 'world') return `地形の点 (${Math.round(to.pos[0] + worldOriginX)}, ${Math.round(to.pos[1] + worldOriginY)}, ${Math.round(to.pos[2] + worldOriginZ)})`;
  const type = entityRigType(to.key);
  const ik = (RIG_TYPES[type].ik || []).find(c => c.upper === to.joint);
  const tip = ik && to.u[1] <= -0.5 && Math.abs(to.u[0]) < 1e-6 && Math.abs(to.u[2]) < 1e-6;
  const jl = tip ? ik.label + 'の先' : (to.joint === 'root' ? (type === 'block' ? '' : '全体') : rigJointLabel(type, to.joint));
  return `${poseEntityName(to.key)}${jl ? 'の' + jl : ''}`;
}

// 再生ヘッドの時刻に、切り替えを入れる(同じ時刻なら置きかえる)
// extra: { from:{joint,u}, align } など(くっつく時の自分の点・向きをそろえるか)
function consSetEvent(p, kind, to, extra) {
  const c = _consEnsure(p);
  const evs = c[kind];
  const span = _puppetSpan(p.id);
  let f = Math.round(curTick);
  if (span && f <= span[0]) f = span[0];
  const ev = { tick: f, to };
  if (kind === 'parent') ev.snap = c.snap !== false;
  if (extra && to) Object.assign(ev, extra);
  const i = evs.findIndex(e => e.tick === f);
  if (i >= 0) evs[i] = ev; else evs.push(ev);
  evs.sort((a, b) => a.tick - b.tick);
}


// ============================================================
// 3Dの操作: 2回クリックでくっつける
//   ① 自分の点をクリック(ブロックは角・辺・面・真ん中の27点、人は手足の先・頭の上・胸・背中)
//   ② 相手の点をクリック(ほかのブロック・人の点、地形は0.5マスごとの点)。近くの点に吸いつく
//   自分の点が相手の点にぴったり移る。「向きもそろえる」なら、向きも相手と同じになる。
// ============================================================

let consPick = null;       // { id, kind:'parent'|'aim', step:1|2, from:{joint,u}, fromLabel }
let consPickHover = null;  // マウスの近くの点 { pos, label, to?, joint?, u? }
let consPickNear = [];     // ②で、マウスの近くに見せる相手の点
let consMouse = null;

const CONS_COLOR = { parent: [1, 0.6, 0.2], aim: [0.35, 0.9, 0.95] };
const CONS_SNAP_PX = 18;
const CONS_HUMAN_FRONT_Z = 0.5; // 人の体の箱で、顔の向いている側(z)

function _consSelected() {
  const p = _consPuppetOfKey(typeof poseEntity !== 'undefined' ? poseEntity : null);
  return p && _poseEditingOn() ? p : null;
}

// ブロックの点(-0.5/0/0.5 の組)の名前
function consBlockPointLabel(u) {
  const n = u.filter(v => Math.abs(v) > 0.25).length;
  const y = u[1] > 0.25 ? '上' : (u[1] < -0.25 ? '下' : '');
  if (n === 0) return '真ん中';
  if (n === 1) return y ? y + 'の面' : '横の面';
  if (n === 2) return y ? y + 'の辺' : '縦の辺';
  return y + 'の角';
}

// 種類ごとの「くっつけられる点」の一覧 { joint, u, label }
function _consPointSpecs(type) {
  const rt = RIG_TYPES[type];
  if (type === 'humanoid') {
    const out = (rt.ik || []).map(c => ({ joint: c.upper, u: [0, -0.5, 0], label: c.label + 'の先' }));
    out.push({ joint: 'head', u: [0, 0.5, 0], label: '頭の上' });
    out.push({ joint: 'body', u: [0, 0.2, CONS_HUMAN_FRONT_Z], label: '胸' });
    out.push({ joint: 'body', u: [0, 0.2, -CONS_HUMAN_FRONT_Z], label: '背中' });
    return out;
  }
  const out = [];
  const joint = (rt.parts[0] || { joint: 'root' }).joint;
  for (const x of [-0.5, 0, 0.5]) for (const y of [-0.5, 0, 0.5]) for (const z of [-0.5, 0, 0.5]) {
    out.push({ joint, u: [x, y, z], label: consBlockPointLabel([x, y, z]) });
  }
  return out;
}

// from {joint,u} の名前
function consPointLabel(type, from) {
  if (!from) return '';
  const s = _consPointSpecs(type).find(q => q.joint === from.joint && q.u.every((v, i) => Math.abs(v - from.u[i]) < 1e-3));
  return s ? s.label : rigJointLabel(type, from.joint);
}

// 今の組み立て rig での、key の点(位置つき)
function consSnapPoints(key, rig) {
  const out = [];
  for (const s of _consPointSpecs(entityRigType(key))) {
    const part = rig.parts.find(q => q.joint === s.joint);
    if (part) out.push({ key, joint: s.joint, u: s.u, label: s.label, pos: _m4Point(part.model, s.u) });
  }
  return out;
}

// 画面で一番近い点(px 以内)。画面で重なっている点(3px 以内)は、手前の点を選ぶ
function _consNearest(list, mx, my, px) {
  const { view, proj } = _fcEditViewProj();
  const cand = [];
  for (const q of list) {
    const s = projectToScreen(q.pos, view, proj, fcCanvas.width, fcCanvas.height);
    if (!s) continue;
    const d = Math.hypot(s.x - mx, s.y - my);
    if (d <= (px || CONS_SNAP_PX)) cand.push({ ...q, d, z: -(view[2] * q.pos[0] + view[6] * q.pos[1] + view[10] * q.pos[2] + view[14]) });
  }
  if (!cand.length) return null;
  const dmin = Math.min(...cand.map(q => q.d));
  return cand.filter(q => q.d <= dmin + 3).sort((a, b) => a.z - b.z)[0];
}

// 相手の点の候補(自分と、自分にくっついている物は除く)
function _consOtherPoints(selfKey) {
  const out = [];
  for (const e of poseEntityList()) {
    if (e.key === selfKey || (selfKey && consDependsOn(e.key, selfKey))) continue;
    const rig = poseRigFor(e.key, curTick);
    if (rig) out.push(...consSnapPoints(e.key, rig));
  }
  return out;
}

// ②の相手: 近くの点に吸いつく。無ければ、当たった所(地形は0.5マスごと)
function consSnapTarget(mx, my, selfKey, pts) {
  const near = _consNearest(pts || _consOtherPoints(selfKey), mx, my);
  if (near) {
    const to = { kind: 'part', key: near.key, joint: near.joint, u: near.u.slice() };
    return { to, pos: near.pos, label: `${poseEntityName(near.key)}の${near.label}`, snapped: true };
  }
  const hit = consFindTarget(mx, my, selfKey);
  if (hit && hit.to.kind === 'world') {
    const o = [worldOriginX, worldOriginY, worldOriginZ];
    const pos = hit.pos.map((v, i) => Math.round((v + o[i]) * 2) / 2 - o[i]);
    const to = { kind: 'world', pos };
    return { to, pos, label: consLabel(to), snapped: true };
  }
  return hit;
}

function consStartPick(id, kind) {
  const p = puppetGet(id);
  if (!p) return;
  const two = kind === 'parent' && !(p.cons && p.cons.snap === false);
  consPick = { id, kind, step: two ? 1 : 2 };
  consPickHover = null; consPickNear = [];
  showToast(two ? '🔗 ① 自分のくっつける点(橙の点)をクリック → ② 相手の点をクリック / Esc でやめる'
    : (kind === 'parent' ? '🔗 くっつける先をクリック / Esc でやめる' : '🎯 向ける先をクリック / Esc でやめる'));
  editorChanged();
}
function consCancelPick() {
  if (!consPick) return false;
  consPick = null; consPickHover = null; consPickNear = [];
  editorChanged();
  return true;
}

function _consFinishPick(mx, my) {
  const { id, kind, from } = consPick;
  consPick = null; consPickHover = null; consPickNear = [];
  const p = puppetGet(id);
  if (!p) return;
  const hit = consSnapTarget(mx, my, 'puppet:' + id);
  if (!hit) { showToast('くっつけられる物がありませんでした'); editorChanged(); return; }
  pushUndo();
  let extra = null;
  if (kind === 'parent' && from) {
    const mode = (p.cons && p.cons.align) || 'auto';
    const tgtBlock = hit.to.kind === 'part' && entityRigType(hit.to.key) === 'block';
    extra = { from: { joint: from.joint, u: from.u.slice() }, align: mode === 'on' || (mode === 'auto' && p.type === 'block' && tgtBlock) };
  }
  consSetEvent(p, kind, hit.to, extra);
  const sec = (curTick / scTps()).toFixed(1);
  showToast(kind === 'parent'
    ? `🔗 ${from ? '「' + consPointLabel(p.type, from) + '」を' : ''}「${hit.label}」にくっつけました(${sec}秒から)`
    : `🎯 「${hit.label}」の方へ向けました(${sec}秒から)`);
  editorChanged();
}

// poses.js の poseMouseDown の最初に呼ぶ。処理したら true
function consMouseDown(e, mx, my) {
  if (!consPick) return false;
  if (e.button === 2) { consCancelPick(); return true; }
  const p = puppetGet(consPick.id);
  if (!p) { consCancelPick(); return true; }
  if (consPick.step === 1) {
    const key = 'puppet:' + p.id;
    const rig = poseRigFor(key, curTick);
    const pt = rig ? _consNearest(consSnapPoints(key, rig), mx, my, 40) : null;
    if (!pt) { showToast('自分の点(橙の点)をクリックしてください'); return true; }
    consPick = { ...consPick, step: 2, from: { joint: pt.joint, u: pt.u.slice() }, fromLabel: pt.label };
    consPickHover = null;
    editorChanged();
    return true;
  }
  _consFinishPick(mx, my);
  return true;
}
// 前の「印をドラッグ」は無くなった(古い呼び出しのために残す)
function consDragMove(d, mx, my) {}
function consDragEnd(d) {}

function consHoverAt(mx, my) {
  if (!consPick) { consPickHover = null; consPickNear = []; return false; }
  consMouse = [mx, my];
  const key = 'puppet:' + consPick.id;
  if (consPick.step === 1) {
    const rig = poseRigFor(key, curTick);
    consPickHover = rig ? _consNearest(consSnapPoints(key, rig), mx, my, 40) : null;
  } else {
    const pts = _consOtherPoints(key);
    const { view, proj } = _fcEditViewProj();
    consPickNear = pts.filter(q => {
      const s = projectToScreen(q.pos, view, proj, fcCanvas.width, fcCanvas.height);
      return s && Math.hypot(s.x - mx, s.y - my) < 140;
    });
    consPickHover = consSnapTarget(mx, my, key, pts);
  }
  return 'crosshair';
}

function consContextHint() {
  if (!consPick) return null;
  const h = consPickHover;
  if (consPick.step === 1) return h ? `① 「${h.label}」をくっつける点にする(クリック) · Esc やめる` : '① 自分のくっつける点(橙の点)をクリック · Esc やめる';
  const verb = consPick.kind === 'parent' ? 'くっつけます' : '向けます';
  const head = consPick.fromLabel ? `② ${consPick.fromLabel}を → ` : '';
  return h ? `${head}「${h.label}」に${verb}(クリック) · Esc やめる` : `${head}相手の点をクリック · Esc やめる`;
}

// 今の組み立てで、自分の点の位置
function _consOwnPointNow(p, from) {
  const rig = poseRigFor('puppet:' + p.id, curTick);
  if (!rig) return null;
  if (!from) return _m4Point(rig.frame.root, [0, 0, 0]);
  const part = rig.parts.find(q => q.joint === from.joint);
  return part ? _m4Point(part.model, from.u) : null;
}

function _consDashed(gl, view, proj, a, b, col, W, H) {
  const seg = [];
  for (let k = 0; k < 10; k += 2) seg.push([0, 1, 2].map(n => a[n] + (b[n] - a[n]) * k / 10), [0, 1, 2].map(n => a[n] + (b[n] - a[n]) * (k + 1) / 10));
  _drawLineSegments(gl, view, proj, seg, col, W, H, 1.4);
}

// 3Dの点と、くっついている先への線
function renderConsGizmos(gl, view, proj, W, H) {
  const f = Math.round(curTick);
  if (consPick) {
    const p = puppetGet(consPick.id);
    if (!p) return;
    const col = CONS_COLOR[consPick.kind];
    const h = consPickHover;
    if (consPick.step === 1) {
      const rig = poseRigFor('puppet:' + p.id, curTick);
      if (!rig) return;
      for (const q of consSnapPoints('puppet:' + p.id, rig)) {
        const hot = h && h.joint === q.joint && h.u.every((v, i) => v === q.u[i]);
        _drawLineSegments(gl, view, proj, _poseCircleSegments(q.pos, hot ? 7 : 3.5, 10), hot ? [0.5, 1, 0.5] : col, W, H, hot ? 3 : 2.4);
      }
      return;
    }
    for (const q of consPickNear) _drawLineSegments(gl, view, proj, _poseCircleSegments(q.pos, 3, 8), [1, 1, 1], W, H, 1.8);
    const src = consPick.kind === 'parent' ? _consOwnPointNow(p, consPick.from)
      : (() => { const rig = poseRigFor('puppet:' + p.id, curTick); const pt = rig && rig.parts[0]; return pt ? _m4Point(pt.model, [0, 0.5, 0]) : null; })();
    if (src) _drawLineSegments(gl, view, proj, _poseCircleSegments(src, 6, 12), col, W, H, 3);
    if (h && h.pos) {
      _drawLineSegments(gl, view, proj, _poseCircleSegments(h.pos, 7, 12), [0.5, 1, 0.5], W, H, 3);
      if (src) _drawLineSegments(gl, view, proj, [src, h.pos], [0.5, 1, 0.5], W, H, 2);
    }
    return;
  }
  const p = _consSelected();
  if (!p || !p.cons) return;
  for (const kind of ['parent', 'aim']) {
    const evs = p.cons[kind] || [];
    const i = _consEvIndex(evs, f);
    const ev = i >= 0 ? evs[i] : null;
    const tp = ev && ev.to ? consTargetPoint(ev.to, f) : null;
    if (!tp) continue;
    const col = CONS_COLOR[kind];
    const src = kind === 'parent' ? _consOwnPointNow(p, ev.from)
      : (() => { const rig = poseRigFor('puppet:' + p.id, curTick); const pt = rig && rig.parts[0]; return pt ? _m4Point(pt.model, [0, 0.5, 0]) : null; })();
    if (src) _consDashed(gl, view, proj, src, tp, col, W, H);
    _drawLineSegments(gl, view, proj, _keyDiamondSegments(tp, 4), col, W, H, 2);
  }
}


// ============================================================
// 右のパネル
// ============================================================

function renderConsPanel(body, p) {
  const c = p.cons || { parent: [], aim: [], reach: false, blend: 0.2, snap: true };
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const span = _puppetSpan(p.id);
  const f = Math.round(curTick);

  const list = (kind, title, hint) => {
    const evs = c[kind] || [];
    const box = _el('div', 'consBox ' + kind);
    box.appendChild(_el('div', 'consTitle', title));
    const i = _consEvIndex(evs, f);
    if (!evs.length) box.appendChild(_el('div', 'consEv', hint));
    evs.forEach((ev, k) => {
      const line = _el('div', 'consEv' + (k === i ? ' now' : ''));
      const t = span && ev.tick <= span[0] ? '始め' : `${((ev.tick - (span ? span[0] : 0)) / scTps()).toFixed(1)}秒`;
      const fromL = kind === 'parent' && ev.from && ev.snap !== false ? consPointLabel(p.type, ev.from) + ' → ' : '';
      const what = ev.to ? (kind === 'parent' ? '🔗 ' : '🎯 ') + fromL + consLabel(ev.to) + (ev.align ? '(向きも)' : '') : (kind === 'parent' ? '✋ はなす' : '— 向くのをやめる');
      const txt = _el('span', 'consEvText', `${t}〜 ${what}`);
      txt.title = 'クリックでこの時刻へ';
      txt.addEventListener('click', () => seekTo(ev.tick));
      line.appendChild(txt);
      const x = _el('button', 'consEvDel', '✕'); x.type = 'button'; x.title = 'この切り替えを消す';
      x.addEventListener('click', () => { pushUndo(); evs.splice(k, 1); editorChanged(); });
      line.appendChild(x);
      box.appendChild(line);
    });
    const acts = _el('div', 'genActions');
    const pick = _el('button', 'btn btn-ghost btn-sm' + (consPick && consPick.id === p.id && consPick.kind === kind ? ' active' : ''),
      kind === 'parent' ? '🔗 くっつける (L)' : '🎯 向ける先を選ぶ');
    pick.title = kind === 'parent' ? '① 自分の点 → ② 相手の点 の順にクリック。再生ヘッドの時刻から切り替わります' : '再生ヘッドの時刻から切り替わります';
    pick.addEventListener('click', () => { if (consPick && consPick.id === p.id && consPick.kind === kind) consCancelPick(); else consStartPick(p.id, kind); });
    const off = _el('button', 'btn btn-ghost btn-sm', kind === 'parent' ? '✋ ここではなす' : '— ここでやめる');
    off.disabled = !(i >= 0 && evs[i].to);
    off.addEventListener('click', () => { pushUndo(); consSetEvent(p, kind, null); editorChanged(); });
    acts.appendChild(pick); acts.appendChild(off);
    box.appendChild(acts);
    body.appendChild(box);
    return box;
  };

  sec('🔗 くっつく・向く・届く');
  const pb = list('parent', '● くっつく', 'まだくっついていません。「くっつける」を押して、① 自分の点(角・辺・面・真ん中)→ ② 相手の点 の順にクリックします。');
  const snapRow = _el('label', 'scriptCheck');
  const snap = document.createElement('input');
  snap.type = 'checkbox'; snap.checked = c.snap !== false;
  snap.addEventListener('change', () => { pushUndo(); _consEnsure(p).snap = snap.checked; editorChanged(); });
  snapRow.appendChild(snap);
  snapRow.appendChild(document.createTextNode('点と点を合わせる(切ると、今の場所のままくっつく)'));
  pb.appendChild(snapRow);
  const alRow = _el('div', 'fieldRow');
  alRow.appendChild(_el('label', null, '向きもそろえる'));
  const alG = _el('div', 'settingsRadioGroup');
  const alCur = c.align || 'auto';
  for (const [val, text, tip] of [['auto', '自動', 'ブロックどうしの時だけ、向きもそろえる'], ['on', 'そろえる', 'くっつけた相手と同じ向きになる'], ['off', 'そろえない', '今の向きのまま']]) {
    const pill = _el('button', 'settingsRadioPill small' + (alCur === val ? ' active' : ''), text);
    pill.type = 'button'; pill.title = tip + '(次にくっつける時から)';
    pill.addEventListener('click', () => { if (alCur === val) return; pushUndo(); _consEnsure(p).align = val; editorChanged(); });
    alG.appendChild(pill);
  }
  alRow.appendChild(alG);
  pb.appendChild(alRow);

  if (p.type === 'block') {
    const ab = list('aim', '● 先: 向く・届く', 'まだ向いていません。「向ける先を選ぶ」を押して、向けたい物の点をクリックします。');
    const rRow = _el('label', 'scriptCheck');
    const rc = document.createElement('input');
    rc.type = 'checkbox'; rc.checked = !!c.reach;
    rc.addEventListener('change', () => { pushUndo(); _consEnsure(p).reach = rc.checked; editorChanged(); });
    rRow.appendChild(rc);
    rRow.appendChild(document.createTextNode('届くまで伸ばす'));
    ab.appendChild(rRow);
    const r = _el('div', 'fieldRow');
    r.appendChild(_el('label', null, '切り替えの時間'));
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = '0'; inp.max = '2'; inp.step = '0.05'; inp.value = c.blend != null ? c.blend : 0.2;
    const v = _el('span', 'fieldValue', (+inp.value) <= 0 ? 'すぐ' : (+inp.value).toFixed(2) + '秒');
    bindEditUndo(inp);
    inp.addEventListener('input', () => { _consEnsure(p).blend = parseFloat(inp.value); v.innerText = (+inp.value) <= 0 ? 'すぐ' : (+inp.value).toFixed(2) + '秒'; });
    r.appendChild(inp); r.appendChild(v);
    r.title = '向ける先を変えた時、新しい先へ動いていく時間(届くと組み合わせると、糸を発射する感じになる)';
    ab.appendChild(r);
  }
}
