// anim-scripts.js
// ============================================================
// 🎭 全体アニメ(エンティティアニメーションAPI)
//
// カメラのスクリプトと同じ隔離した場所(script-runner.js)で、スクリプトを動かす。
// スクリプトは api.animate({ who, seconds, frame(e, t, ctx) }) で、
//   「全員(プレイヤー・人形)の、毎コマの関節の値」を計算する。
// エディタはそれを受け取って、キーを減らし(形が変わらない所は省く)、
//   人ごとにふつうのポーズのブロックを作る(あとで手で直せる)。
// 作ったブロックは設定(gen)を覚えていて、右パネルで設定を変えるとその場で作り直す。
//   gen = { src, name, code, params, anchor(置いた時刻), view, focusId, group, sig }
//   同じ group のブロック = 1つの全体アニメ。グローバルのタブの「🎭 全体アニメ」の行に1本で出る。
// ============================================================

const ANIM_TOL_R = 0.5;    // キーを減らす時に許すずれ: 回転(度)
const ANIM_TOL_P = 0.01;   // 位置(ブロック)
let animGroupFocus = null; // 全体アニメの行から選んだ group(グローバルのタブ)

const _ANIM_WHO = `who: { type: 'choice', label: '動かす人', options: [['全員', 'all'], ['プレイヤーだけ', 'players'], ['選んでいる人だけ', 'me']], default: 'all' },`;
const _ANIM_SECONDS = (d) => `seconds: { type: 'number', label: '長さ', min: 0.5, max: 30, step: 0.5, default: ${d}, unit: '秒' },`;
const _ANIM_STAGGER = (d) => `stagger: { type: 'number', label: '人ごとの時間差', min: 0, max: 1, step: 0.05, default: ${d}, unit: '秒' },`;

const OFFICIAL_ANIM_SCRIPTS = [
  { id: 'wave', icon: '👋', label: 'みんなで手を振る', desc: '全員が手を上げて振る(足の動きはそのまま)', code: `api.info({ name: 'みんなで手を振る', description: '全員が手を上げて振ります。歩いている足はそのまま。' });
const p = api.params({
  ${_ANIM_SECONDS(4)}
  ${_ANIM_WHO}
  hand: { type: 'choice', label: '手', options: [['右手', 'R'], ['左手', 'L'], ['両手', 'both']], default: 'R' },
  speed: { type: 'number', label: '振る速さ', min: 0.5, max: 4, step: 0.1, default: 1.5, unit: '回/秒' },
  ${_ANIM_STAGGER(0.15)}
});
const M = api.math;
api.animate({
  who: p.who, types: ['humanoid'], seconds: p.seconds,
  frame(e, t, ctx) {
    const lt = t - ctx.index * p.stagger;      // この人の中の時刻
    if (lt < 0) return null;                    // まだ始まっていない人は、元の動きのまま
    const up = M.smoothstep(lt / 0.3) * M.smoothstep((ctx.seconds - t) / 0.3); // 上げる・下ろす
    const w = Math.sin(lt * p.speed * Math.PI * 2);
    const o = { head: [0, 0, 5 * up] };
    if (p.hand !== 'L') { o.armR = [10 * up, 0, (152 + 12 * w) * up]; }
    if (p.hand !== 'R') { o.armL = [10 * up, 0, (152 - 12 * w) * up]; }
    return o;
  },
});
` },
  { id: 'stadium', icon: '🌊', label: 'ウェーブ', desc: '端から順番に、両手を上げて跳ねる', code: `api.info({ name: 'ウェーブ', description: '端から順番に、両手を上げて跳ねます(スタジアムのウェーブ)。' });
const p = api.params({
  ${_ANIM_SECONDS(4)}
  ${_ANIM_WHO}
  dir: { type: 'choice', label: '向き', options: [['画面の左→右', 'lr'], ['右→左', 'rl'], ['手前→奥', 'nf'], ['奥→手前', 'fn']], default: 'lr' },
  each: { type: 'number', label: '1人の長さ', min: 0.3, max: 2, step: 0.1, default: 0.8, unit: '秒' },
  height: { type: 'number', label: '跳ねる高さ', min: 0, max: 1.5, step: 0.05, default: 0.3, unit: 'ブロック' },
});
const M = api.math, V = M.vec;
// 置いた時の視点から見た、左右・前後の並び
const R = M.right(api.view.yaw), F = M.forward(api.view.yaw, 0);
const axis = p.dir === 'lr' || p.dir === 'rl' ? R : F;
const sign = p.dir === 'rl' || p.dir === 'fn' ? -1 : 1;
const order = new Map();
const list = api.entities().filter(e => e.type === 'humanoid' && e.at(api.start));
const score = (e) => V.dot(e.at(api.start).pos, axis) * sign;
const lo = Math.min(...list.map(score)), hi = Math.max(...list.map(score));
for (const e of list) order.set(e.key, hi > lo ? (score(e) - lo) / (hi - lo) : 0);
api.animate({
  who: p.who, types: ['humanoid'], seconds: p.seconds,
  frame(e, t, ctx) {
    if (!order.has(e.key)) return null;
    const t0 = order.get(e.key) * Math.max(0, ctx.seconds - p.each); // この人の番が来る時刻
    const u = (t - t0) / p.each;
    if (u < 0 || u > 1) return null;            // 番の外は、元の動きのまま
    const b = Math.sin(Math.PI * u);            // 0 → 1 → 0
    return {
      root: { r: [0, 0, 0], p: [0, p.height * b, 0] },
      armR: [0, 0, 168 * b], armL: [0, 0, 168 * b],
      head: [-12 * b, 0, 0],
    };
  },
});
` },
  { id: 'jump', icon: '🦘', label: 'みんなでジャンプ', desc: '全員がその場で何回か跳ねる', code: `api.info({ name: 'みんなでジャンプ', description: '全員がその場で跳ねます。' });
const p = api.params({
  ${_ANIM_SECONDS(3)}
  ${_ANIM_WHO}
  count: { type: 'number', label: '回数', min: 1, max: 10, step: 1, default: 3, unit: '回' },
  height: { type: 'number', label: '高さ', min: 0.1, max: 3, step: 0.1, default: 0.8, unit: 'ブロック' },
  ${_ANIM_STAGGER(0)}
});
const M = api.math;
api.animate({
  who: p.who, types: ['humanoid'], seconds: p.seconds,
  frame(e, t, ctx) {
    const lt = t - ctx.index * p.stagger;
    if (lt < 0) return null;
    const period = ctx.seconds / p.count;
    if (lt >= period * p.count) return null;
    const ph = (lt % period) / period;
    // 0〜0.2: しゃがむ / 0.2〜0.8: 空中 / 0.8〜1: 着地してしゃがむ
    const air = ph > 0.2 && ph < 0.8 ? (ph - 0.2) / 0.6 : -1;
    const crouch = air < 0 ? Math.sin(Math.PI * (ph < 0.2 ? ph / 0.2 * 0.5 : 0.5 + (ph - 0.8) / 0.2 * 0.5)) : 0;
    const y = air >= 0 ? p.height * 4 * air * (1 - air) : -0.12 * crouch;
    const a = air >= 0 ? Math.sin(Math.PI * air) : 0;
    return {
      root: { r: [0, 0, 0], p: [0, y, 0] },
      legR: [35 * crouch, 0, 0], legL: [35 * crouch, 0, 0],
      armR: [-30 * crouch, 0, 40 * a], armL: [-30 * crouch, 0, 40 * a],
      body: [12 * crouch, 0, 0],
    };
  },
});
` },
  { id: 'look', icon: '👀', label: 'こっちを向く', desc: '全員が置いた時の視点(カメラ)の方を向く', code: `api.info({ name: 'こっちを向く', description: '全員が、置いた時の編集視点の方を向きます。' });
const p = api.params({
  ${_ANIM_SECONDS(3)}
  ${_ANIM_WHO}
  part: { type: 'choice', label: '向ける所', options: [['体ごと', 'body'], ['頭だけ', 'head']], default: 'body' },
  turn: { type: 'number', label: '向くまでの時間', min: 0.05, max: 2, step: 0.05, default: 0.4, unit: '秒' },
});
const M = api.math;
const eye = api.view.pos;
api.animate({
  who: p.who, types: ['humanoid'], seconds: p.seconds,
  frame(e, t, ctx) {
    const head = [ctx.at.pos[0], ctx.at.pos[1] + 1.6, ctx.at.pos[2]];
    const a = M.lookAt(head, eye);              // その人から見た、視点の向き(度)
    const w = M.smoothstep(t / p.turn) * M.smoothstep((ctx.seconds - t) / p.turn);
    const yaw = M.angleDiff(ctx.at.yaw, a.yaw);  // 今の向きからのずれ(左が +)
    const look = M.clamp(-a.pitch, -45, 45);     // 頭の上下(前へ倒すと +)
    if (p.part === 'head') return { head: [look * w, M.clamp(yaw, -75, 75) * w, 0] };
    return { root: { r: [0, yaw * w, 0], p: [0, 0, 0] }, head: [look * w, 0, 0] };
  },
});
` },
  { id: 'dance', icon: '💃', label: 'ばらばらダンス', desc: '全員がリズムに乗って、ちがう動きで踊る', code: `api.info({ name: 'ばらばらダンス', description: '全員がリズムに乗って踊ります。「そろえる」で同じ動きに。' });
const p = api.params({
  ${_ANIM_SECONDS(6)}
  ${_ANIM_WHO}
  bpm: { type: 'number', label: 'テンポ', min: 60, max: 200, step: 1, default: 120, unit: 'BPM' },
  energy: { type: 'number', label: '大きさ', min: 0.2, max: 1.5, step: 0.05, default: 1 },
  sync: { type: 'bool', label: 'みんな同じ動きにそろえる', default: false },
  seed: { type: 'number', label: '乱数のたね', min: 1, max: 99, step: 1, default: 1 },
});
const M = api.math;
api.animate({
  who: p.who, types: ['humanoid'], seconds: p.seconds,
  frame(e, t, ctx) {
    const s = (p.sync ? 0 : ctx.index * 17.3) + p.seed * 101;
    const beat = t * p.bpm / 60;
    const n = (k, f) => M.noise(beat * (f || 0.5), s + k * 7.1);
    const w = M.smoothstep(t / 0.3) * M.smoothstep((ctx.seconds - t) / 0.3) * p.energy;
    const bounce = Math.abs(Math.sin(Math.PI * beat));
    const side = Math.sin(Math.PI * beat);
    return {
      root: { r: [0, 25 * n(1) * w, 0], p: [0, (0.08 * bounce - 0.04) * w, 0] },
      body: [6 * n(2) * w, 15 * side * w, 10 * n(3) * w],
      head: [10 * n(4, 1) * w, -12 * side * w, -8 * n(5) * w],
      armR: [40 * n(6) * w, 0, (60 + 60 * n(7)) * w],
      armL: [40 * n(9) * w, 0, (60 + 60 * n(10)) * w],
      legR: [12 * (1 - bounce) * w, 0, 5 * w],
      legL: [12 * (1 - bounce) * w, 0, 5 * w],
    };
  },
});
` },
  { id: 'float', icon: '🎈', label: 'ふわっと浮く', desc: '全員が浮かんで回り、また降りる', code: `api.info({ name: 'ふわっと浮く', description: '全員が宙に浮かんでゆっくり回り、また降ります。' });
const p = api.params({
  ${_ANIM_SECONDS(4)}
  ${_ANIM_WHO}
  height: { type: 'number', label: '高さ', min: 0.3, max: 8, step: 0.1, default: 1.5, unit: 'ブロック' },
  turns: { type: 'number', label: '回る回数', min: 0, max: 5, step: 1, default: 1, unit: '回' },
  ${_ANIM_STAGGER(0.1)}
});
const M = api.math;
api.animate({
  who: p.who, types: ['humanoid'], seconds: p.seconds,
  frame(e, t, ctx) {
    const lt = t - ctx.index * p.stagger;
    if (lt < 0) return null;
    const len = ctx.seconds - ctx.index * p.stagger;
    const up = M.smoothstep(lt / 0.8) * M.smoothstep((len - lt) / 0.8);
    const bob = Math.sin(lt * 2.4) * 0.08 * up;
    return {
      root: { r: [0, 360 * p.turns * M.easeInOut(lt / len), 0], p: [0, p.height * up + bob, 0] },
      armR: [0, 0, 55 * up], armL: [0, 0, 55 * up],
      legR: [8 * up, 0, 6 * up], legL: [-4 * up, 0, 6 * up],
      head: [-10 * up, 0, 0],
    };
  },
});
` },
];

const ANIM_SCRIPT_TEMPLATE = `// 新しい全体アニメのスクリプト
// 毎コマ frame() が、人ごとに呼ばれます。返した関節の値(度)が、その人の動きになります。
// 返さなかった関節は、元の動き(自動アニメーション)のまま。null を返すと、そのコマはその人を動かしません。
api.info({ name: '新しい全体アニメ', description: 'うなずく' });
const p = api.params({
  seconds: { type: 'number', label: '長さ', min: 0.5, max: 30, step: 0.5, default: 3, unit: '秒' },
  speed: { type: 'number', label: '速さ', min: 0.5, max: 4, step: 0.1, default: 2, unit: '回/秒' },
});
api.animate({
  who: 'all',              // 'all' / 'players' / 'puppets' / 'me' / ['player:1', …] / (e) => true
  types: ['humanoid'],     // 人型だけ
  seconds: p.seconds,
  frame(e, t, ctx) {       // e: 人 / t: 始まりからの秒 / ctx: { tick, index, count, at:{pos,yaw}, state, seconds }
    const nod = Math.sin(t * p.speed * Math.PI * 2);
    return {
      head: [20 * Math.max(0, nod), 0, 0],               // 頭を前へ倒す(度)
      // root: { r: [0, 0, 0], p: [0, 0.5, 0] },          // 全体の回転(度)と位置のずれ(ブロック)
    };
  },
});
`;


// ============================================================
// 素材のキー
// ============================================================

function isAnimScriptKey(key) {
  const [a, b] = String(key).split(':');
  if (a === 'anim') return OFFICIAL_ANIM_SCRIPTS.some(x => x.id === b);
  if (a === 'custom') return customAssets.some(x => x.id === b && x.type === 'script' && x.cat === 'anim');
  return false;
}

function _animGroupBlocks(group) { return poseBlocks.filter(b => b.gen && b.gen.group === group); }
function animGroupSelected() {
  if (animGroupFocus == null || timelineTab !== 'global') return false;
  const b = poseGetSelected();
  return !!(b && b.gen && b.gen.group === animGroupFocus);
}


// ============================================================
// キーを減らす(毎コマの値 → 少ないキー)
// ============================================================

// arr: Float32Array(コマ数*6) の [a, a+n) コマ。残すキー [{ i(0〜n-1), curve:[x1,y1,x2,y2] }] を返す。
// キーの間は、速さのカーブ1本でつなぐ。等速 → なめらか/ゆっくり始まる/ゆっくり止まる → 自由なカーブ の順に試して、
// ずれが 回転 ANIM_TOL_R 度・位置 ANIM_TOL_P ブロック以内になる物を使う。
// 自由なカーブは x1=1/3, x2=2/3 にして(時間はまっすぐ)、y1・y2 を全部の値のずれが小さくなるように決める(最小二乗)。
// どれも合わなければ、一番ずれるコマにキーを足して2つに分ける。
const ANIM_CURVES = ['linear', 'smooth', 'easeIn', 'easeOut'];
function animReduceKeys(arr, a, n) {
  if (n <= 1) return [{ i: 0, curve: CURVE_PRESETS.linear.c.slice() }];
  const v = (i, c) => arr[(a + i) * 6 + c];
  const W = (c) => 1 / (c < 3 ? ANIM_TOL_R : ANIM_TOL_P);
  const curveAt = new Array(n).fill(null);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const errOf = (i0, i1, ease) => {
    let worst = 0, wi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const u = ease((i - i0) / (i1 - i0));
      let e = 0;
      for (let c = 0; c < 6; c++) {
        const a0 = v(i0, c), a1 = v(i1, c);
        const d = Math.abs(v(i, c) - (a0 + (a1 - a0) * u)) * W(c);
        if (d > e) e = d;
      }
      if (e > worst) { worst = e; wi = i; }
    }
    return { worst, wi };
  };
  // 自由なカーブ: u(x) = 3(1-x)²x·y1 + 3(1-x)x²·y2 + x³
  const freeFit = (i0, i1) => {
    let A = 0, B = 0, C = 0, D = 0, E = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const x = (i - i0) / (i1 - i0), b1 = 3 * (1 - x) * (1 - x) * x, b2 = 3 * (1 - x) * x * x, b3 = x * x * x;
      for (let c = 0; c < 6; c++) {
        const d = (v(i1, c) - v(i0, c)) * W(c);
        if (!d) continue;
        const r = (v(i, c) - v(i0, c)) * W(c) - d * b3;
        A += d * d * b1 * b1; B += d * d * b1 * b2; C += d * d * b2 * b2; D += d * b1 * r; E += d * b2 * r;
      }
    }
    const det = A * C - B * B;
    if (Math.abs(det) < 1e-12) return null;
    const y1 = Math.max(-2, Math.min(3, (D * C - B * E) / det)), y2 = Math.max(-2, Math.min(3, (A * E - B * D) / det));
    return [1 / 3, Math.round(y1 * 1000) / 1000, 2 / 3, Math.round(y2 * 1000) / 1000];
  };
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) { curveAt[i0] = CURVE_PRESETS.linear.c.slice(); continue; }
    let lin = null, ok = null;
    for (const id of ANIM_CURVES) {
      const cv = CURVE_PRESETS[id].c;
      const r = errOf(i0, i1, id === 'linear' ? (x) => x : (x) => scEase(cv, x));
      if (id === 'linear') lin = r;
      if (r.worst <= 1) { ok = cv.slice(); break; }
    }
    let split = lin.wi;
    if (!ok && i1 - i0 >= 3) {
      const cv = freeFit(i0, i1);
      const r = cv ? errOf(i0, i1, (x) => scEase(cv, x)) : null;
      if (r && r.worst <= 1) ok = cv;
      else if (r && r.wi > i0 && r.worst < lin.worst) split = r.wi; // 自由なカーブで一番ずれる所で分けると、キーが少なくてすむ
    }
    if (ok) { curveAt[i0] = ok; continue; }
    keep[split] = 1;
    stack.push([i0, split], [split, i1]);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ i, curve: curveAt[i] || CURVE_PRESETS.linear.c.slice() });
  // ずっと同じ値なら、キーは1つでいい
  if (out.length === 2) {
    let same = true;
    for (let c = 0; c < 6; c++) if (Math.abs(v(0, c) - v(n - 1, c)) * W(c) > 0.1) same = false;
    if (same) out.pop();
  }
  return out;
}

function _animGenSignature(b) {
  const str = JSON.stringify([b.endTick - b.startTick, b.tracks]);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function animGenEdited(b) { return !!(b.gen && b.gen.sig && b.gen.sig !== _animGenSignature(b)); }


// ============================================================
// 受け取った操作をチェックして、ポーズのブロックにする(取り消し1回ぶん)
// ============================================================

let _nextAnimGroup = 1;

// opts: { history:false, replaceGroup, gen:{…} } 戻り値: { created:[ブロック], people, keys, toasts, group, error }
function applyAnimOps(ops, opts) {
  opts = opts || {};
  if (!Array.isArray(ops) || ops.length > SCRIPT_MAX_OPS) return { error: '操作が多すぎます' };
  if (opts.history !== false) commitEdit();
  const before = _editorStateJson();
  const tps = scTps();
  const maxTick = scMaxTick();
  const ents = new Map(poseEntityList().map(e => [e.key, e]));
  // 作り直し: 前に作ったブロックを消す(同じ人には同じIDを使い直す)
  const reuse = new Map();
  if (opts.replaceGroup != null) {
    for (const b of _animGroupBlocks(opts.replaceGroup).sort((x, y) => x.startTick - y.startTick)) {
      if (!reuse.has(b.target)) reuse.set(b.target, []);
      reuse.get(b.target).push(b.id);
    }
    poseBlocks = poseBlocks.filter(b => !(b.gen && b.gen.group === opts.replaceGroup));
  }
  if (opts.gen && opts.gen.group == null) {
    for (const b of poseBlocks) if (b.gen && b.gen.group >= _nextAnimGroup) _nextAnimGroup = b.gen.group + 1;
  }
  const group = opts.gen ? (opts.gen.group != null ? opts.gen.group : _nextAnimGroup++) : null;
  const created = [], toasts = [];
  const people = new Set();
  let keyCount = 0;
  try {
    ops.forEach((op, i) => {
      const where = `${i + 1}番目の操作(${op && op.op})`;
      try {
        if (!op || typeof op !== 'object') throw new Error('形が正しくありません');
        if (op.op === 'toast') { toasts.push(String(op.text).slice(0, 200)); return; }
        if (op.op !== 'pose') throw new Error('全体アニメのスクリプトでは使えない操作です(カメラを作るのはカメラのスクリプトで)');
        const ent = ents.get(String(op.target));
        if (!ent) throw new Error(`${op.target} が見つかりません`);
        const start = Math.round(_num(op.start, NaN));
        const n = Math.round(_num(op.n, NaN));
        if (!(start >= 0) || !(n >= 1) || (maxTick > 0 && start + n > maxTick + 1)) throw new Error('時刻が正しくありません');
        const present = op.present;
        if (!present || present.length !== n) throw new Error('コマの数が合いません');
        const allowed = rigJoints(ent.type);
        const joints = {};
        for (const [j, arr] of Object.entries(op.joints || {})) {
          if (!allowed.includes(j)) continue; // その型に無い関節は使わない
          if (!arr || arr.length !== n * 6) throw new Error(`${j} の値の数が合いません`);
          const f = new Float32Array(n * 6);
          for (let k = 0; k < n * 6; k++) { const x = +arr[k]; f[k] = Number.isFinite(x) ? Math.max(-100000, Math.min(100000, x)) : 0; }
          joints[j] = f;
        }
        const names = Object.keys(joints);
        if (!names.length) return;
        // 動かすコマが続いている所ごとに、ブロックを1つ
        let k = 0;
        while (k < n) {
          if (!present[k]) { k++; continue; }
          let e = k;
          while (e < n && present[e]) e++;
          const len = e - k;
          const tracks = {};
          for (const j of names) {
            const arr = joints[j];
            tracks[j] = animReduceKeys(arr, k, len).map(({ i, curve }) => {
              const o = (k + i) * 6;
              const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 10000) / 10000;
              return { time: Math.round(i / tps * 10000) / 10000, r: [r2(arr[o]), r2(arr[o + 1]), r2(arr[o + 2])],
                       p: [r4(arr[o + 3]), r4(arr[o + 4]), r4(arr[o + 5])], curve };
            });
            keyCount += tracks[j].length;
          }
          const b = poseAddBlock(start + k, ent.key, { name: (op.name || (opts.gen && opts.gen.name) || '全体アニメ').slice(0, 60), tracks });
          b.startTick = start + k; b.endTick = start + e;
          const ids = reuse.get(ent.key);
          if (ids && ids.length) b.id = ids.shift();
          if (opts.gen) {
            b.gen = { src: opts.gen.src || null, name: opts.gen.name || '', code: String(opts.gen.code || ''), params: { ...(opts.gen.params || {}) },
                      anchor: Math.round(_num(opts.gen.anchor, start)), view: opts.gen.view || null,
                      focusId: opts.gen.focusId != null ? String(opts.gen.focusId) : null, group };
          }
          created.push(b);
          people.add(ent.key);
          k = e;
        }
      } catch (err) {
        throw new Error(`${where}: ${err.message}`);
      }
    });
  } catch (e) {
    _restoreEditorState(before);
    return { error: e.message };
  }
  for (const b of created) if (b.gen) b.gen.sig = _animGenSignature(b);
  if (opts.history !== false && _editorStateJson() !== before) _pushHistory(before);
  return { created, people: people.size, keys: keyCount, toasts, group };
}


// ============================================================
// 置く・作り直す
// ============================================================

async function addAnimScriptAt(key, tick, opts) {
  opts = opts || {};
  const entry = scriptEntry(key);
  if (!entry) return null;
  const params = opts.params || scriptParamValues(key);
  const view = currentScriptView();
  const focusId = currentFocusId();
  const slow = setTimeout(() => showToast(`⏳ 「${entry.name}」を計算しています…`), 450);
  const r = await runScriptSandboxed(entry.code, 'run', params, null, { start: tick, view, focusId, anim: true });
  clearTimeout(slow);
  if (r.type !== 'done') { _reportScriptProblem(entry, r); return null; }
  const a = applyAnimOps(r.ops, { gen: { src: key, name: entry.name, code: entry.code, params, anchor: tick, view, focusId } });
  if (a.error) { showToast('⚠ ' + entry.name + ': ' + a.error); return null; }
  if (r.logs.length) console.info(`[${entry.name}]`, r.logs.join('\n'));
  if (!a.created.length) {
    showToast(a.toasts.length ? a.toasts[a.toasts.length - 1] : `「${entry.name}」で動かせる人がいませんでした(その時刻に出ている人がいるか確かめてください)`);
    editorChanged();
    return a;
  }
  selectPose(a.created[0].id, { animGroup: a.group });
  showToast(a.toasts.length ? a.toasts[a.toasts.length - 1] : `🎭 「${entry.name}」を${a.people}人に付けました(キー${a.keys}個)`);
  return a;
}

const _animRegen = { running: false, next: null, commitWhenIdle: false, lastMessage: null, gesture: false, confirmed: false };

function queueAnimRegenerate(group, params, force) {
  const members = _animGroupBlocks(group);
  if (!members.length) return;
  if (!force && !_animRegen.confirmed && members.some(animGenEdited)) {
    if (!confirm('この全体アニメは、キーを手で直しています。作り直すと、手で直した所は元に戻ります。続けますか?')) {
      _animRegen.next = null;
      editorChanged();
      return;
    }
  }
  _animRegen.confirmed = true;
  _animRegen.next = { group, params };
  if (!_animRegen.running) _drainAnimRegenerate();
}
function endAnimRegenerateGesture() {
  _animRegen.gesture = false;
  _animRegen.confirmed = false;
  if (_animRegen.running || _animRegen.next) _animRegen.commitWhenIdle = true;
  else commitEdit();
}
async function _drainAnimRegenerate() {
  _animRegen.running = true;
  while (_animRegen.next) {
    const job = _animRegen.next;
    _animRegen.next = null;
    await _regenerateAnimGroup(job.group, job.params);
  }
  _animRegen.running = false;
  if (_animRegen.commitWhenIdle) { _animRegen.commitWhenIdle = false; commitEdit(); }
}
async function _regenerateAnimGroup(group, params) {
  const members = _animGroupBlocks(group).sort((a, b) => a.startTick - b.startTick);
  if (!members.length) return;
  const gen = members[0].gen;
  const sel = poseGetSelected();
  const selTarget = sel && sel.gen && sel.gen.group === group ? sel.target : null;
  const wasGroup = animGroupSelected();
  const r = await runScriptSandboxed(gen.code, 'run', params, null,
    { start: gen.anchor, view: gen.view || undefined, focusId: gen.focusId != null ? gen.focusId : undefined, anim: true });
  if (r.type !== 'done') {
    _animRegen.lastMessage = { group, kind: r.type === 'fail' ? 'warn' : 'error', text: (r.type === 'fail' ? '' : 'エラー' + (r.line ? `(${r.line}行目)` : '') + ': ') + r.message };
    editorChanged();
    return;
  }
  const a = applyAnimOps(r.ops, { history: false, replaceGroup: group,
    gen: { src: gen.src, name: gen.name, code: gen.code, params, anchor: gen.anchor, view: gen.view, focusId: gen.focusId, group } });
  _animRegen.lastMessage = a.error ? { group, kind: 'error', text: a.error } : (a.created.length ? null : { group, kind: 'warn', text: '動かせる人がいなくなりました' });
  // 選んでいたブロックが無くなったら、同じ人の新しいブロックを選ぶ
  if (selTarget && !poseGetSelected()) {
    const nb = a.created && (a.created.find(b => b.target === selTarget) || a.created[0]);
    if (nb) selectPose(nb.id, wasGroup ? { animGroup: group } : undefined);
    else { selectedPoseId = null; animGroupFocus = null; }
  }
  editorChanged();
}

function animDeleteGroup(group) {
  const members = _animGroupBlocks(group);
  if (!members.length) return;
  pushUndo();
  const ids = new Set(members.map(b => b.id));
  poseBlocks = poseBlocks.filter(b => !ids.has(b.id));
  if (ids.has(selectedPoseId)) selectedPoseId = null;
  if (ids.has(poseExpandedId)) poseExpandedId = null;
  animGroupFocus = null;
  showToast(`🗑 全体アニメ「${members[0].gen.name}」を消しました(${new Set(members.map(b => b.target)).size}人ぶん)`);
  editorChanged();
}


// ============================================================
// 右パネル: 全体アニメの設定 → その場で作り直す
// ============================================================

function renderAnimGenSection(title, body, b) {
  const gen = b.gen;
  const members = _animGroupBlocks(gen.group);
  const n = new Set(members.map(x => x.target)).size;
  const whole = animGroupSelected();
  title.innerText = whole ? `🎭 ${gen.name || '全体アニメ'}` : `🕺 ${b.name}`;
  body.appendChild(_el('div', 'panelSectionLabel', `🎭 全体アニメ「${gen.name || 'スクリプト'}」の設定(${n}人)`));
  const box = _el('div', 'scriptParams genParams');
  body.appendChild(box);
  const d = describeScriptCached(gen.code);
  if (!d) {
    box.appendChild(_el('div', 'panelHint', '設定を読み込み中…'));
    describeScript(gen.code).then(() => { if (editPanelOpenFor && editPanelOpenFor.kind === 'pose') refreshEditPanelIfOpen(); });
  } else if (!d.ok) {
    box.appendChild(_scriptMessage('error', 'スクリプトにエラーがあります: ' + d.message));
  } else {
    const params = gen.params || {};
    const keys = Object.keys(d.defs);
    if (!keys.length) box.appendChild(_el('div', 'panelHint', '設定項目はありません'));
    for (const k of keys) {
      box.appendChild(buildParamControl(k, d.defs[k], params[k] !== undefined ? params[k] : d.defs[k].default, {
        begin: () => { if (!_animRegen.gesture) { _animRegen.gesture = true; beginEdit(); } },
        change: (val) => {
          const g = poseBlocks.find(x => x.gen && x.gen.group === gen.group);
          if (!g) return;
          queueAnimRegenerate(gen.group, { ...(g.gen.params || {}), [k]: val });
        },
        commit: () => endAnimRegenerateGesture(),
      }));
    }
  }
  if (_animRegen.lastMessage && _animRegen.lastMessage.group === gen.group) box.appendChild(_scriptMessage(_animRegen.lastMessage.kind, _animRegen.lastMessage.text));

  const actions = _el('div', 'genActions');
  const mk = (text, tip, fn) => { const x = _el('button', 'btn btn-ghost btn-sm', text); x.type = 'button'; x.title = tip; x.addEventListener('click', fn); actions.appendChild(x); return x; };
  mk('↻ 作り直す', '今の設定で、もう一度スクリプトを動かす', () => { beginEdit(); queueAnimRegenerate(gen.group, gen.params || {}, true); endAnimRegenerateGesture(); });
  mk('</> コード', 'このアニメを作ったスクリプトを見る', () => openScriptEditor('agen:' + b.id));
  mk('✂ 切り離す', 'スクリプトとのつながりを切って、ふつうのポーズのブロックにする', () => {
    pushUndo();
    for (const x of poseBlocks) if (x.gen && x.gen.group === gen.group) delete x.gen;
    animGroupFocus = null;
    showToast('スクリプトから切り離しました(ふつうのポーズのブロックになりました)');
    editorChanged();
  });
  mk('🗑 全部消す', `${n}人ぶんのブロックを全部消す`, () => animDeleteGroup(gen.group));
  if (!whole) mk('🎭 全体を選ぶ', 'このアニメ全体を選ぶ(グローバルのタブ)', () => { selectPose(b.id, { animGroup: gen.group }); openEditPanel(b); });
  body.appendChild(actions);
  body.appendChild(_el('div', 'panelHint', members.some(animGenEdited)
    ? '⚠ キーを手で直しています。設定を変えたり作り直したりすると、手で直した所は元に戻ります。'
    : (whole ? '設定を変えると、全員ぶんがその場で作り直されます。1人ずつ直す時は、🕺ポーズのタブでその人のブロックを開きます。'
             : '設定を変えると、全員ぶんがその場で作り直されます。')));
}


// ============================================================
// タイムライン(グローバル): 「🎭 全体アニメ」の行。1つのアニメ = 1本
// ============================================================

function animGroups() {
  const m = new Map();
  for (const b of poseBlocks) {
    if (!b.gen || b.gen.group == null) continue;
    let g = m.get(b.gen.group);
    if (!g) { g = { group: b.gen.group, name: b.gen.name, blocks: [], start: Infinity, end: -Infinity }; m.set(b.gen.group, g); }
    g.blocks.push(b); g.start = Math.min(g.start, b.startTick); g.end = Math.max(g.end, b.endTick);
  }
  return [...m.values()].sort((a, b) => a.start - b.start);
}

function renderAnimTrackBlocks() {
  const lane = document.getElementById('timelineAnimLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const groups = animGroups();
  const rowEnds = [], rows = new Map();
  for (const g of groups) {
    let r = rowEnds.findIndex(end => end <= g.start);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = g.end; rows.set(g.group, r);
  }
  const h = Math.max(1, rowEnds.length) * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick();
  const selGroup = animGroupSelected() ? animGroupFocus : null;
  for (const g of groups) {
    const el = _el('div', 'tlBlock anim' + (g.group === selGroup ? ' selected' : ''));
    el.dataset.group = g.group;
    el.style.left = (g.start * ppt) + 'px';
    el.style.width = Math.max(6, (g.end - g.start) * ppt) + 'px';
    el.style.top = ((rows.get(g.group) || 0) * TL_ROW_H + 3) + 'px';
    const n = new Set(g.blocks.map(b => b.target)).size;
    el.appendChild(_el('div', 'tlBlockLabel', `🎭 ${g.name} · ${n}人`));
    // 人ごとのブロックの所を、うすい線で見せる
    for (const b of g.blocks) {
      const s = _el('div', 'tlAnimSpan');
      s.style.left = ((b.startTick - g.start) * ppt) + 'px';
      s.style.width = Math.max(2, (b.endTick - b.startTick) * ppt) + 'px';
      el.appendChild(s);
    }
    el.title = `全体アニメ「${g.name}」(${n}人) — ドラッグで時刻を動かす / ダブルクリックで設定 / Deleteで全部消す`;
    el.addEventListener('mousedown', (e) => _animGroupMouseDown(e, g));
    lane.appendChild(el);
  }
  if (!groups.length) lane.appendChild(_el('div', 'tlEmpty', '「🎭 全体アニメ」から追加'));
}

function _animGroupMouseDown(e, g) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  if (typeof stopPlayback === 'function') stopPlayback();
  const first = g.blocks.slice().sort((a, b) => a.startTick - b.startTick)[0];
  if (e.detail >= 2) {
    if (curTick < g.start || curTick >= g.end) seekTo(Math.max(g.start, Math.min(g.end - 1, tlTickFromClientX(e.clientX))));
    selectPose(first.id, { animGroup: g.group });
    openEditPanel(poseGet(first.id));
    return;
  }
  selectPose(first.id, { animGroup: g.group });
  // ドラッグで、全員ぶんのブロックをまとめて動かす(置いた時刻 anchor も)
  const orig = g.blocks.map(b => ({ b, s: b.startTick, e: b.endTick, a: b.gen.anchor }));
  const maxTick = scMaxTick();
  const x0 = e.clientX;
  let moved = false;
  beginEdit();
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    let dt = Math.round(dx / tlPxPerTick());
    dt = Math.max(-g.start, dt);
    if (maxTick > 0) dt = Math.min(maxTick - g.end, dt);
    for (const o of orig) { o.b.startTick = o.s + dt; o.b.endTick = o.e + dt; o.b.gen.anchor = o.a + dt; }
    editorChanged();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    commitEdit();
    editorChanged();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}


// ============================================================
// 素材一覧(🎭 全体アニメ)
// ============================================================

function renderAnimAssets(list, source) {
  if (source === 'official') {
    const grid = _div('assetGrid');
    for (const s of OFFICIAL_ANIM_SCRIPTS) grid.appendChild(_cameraScriptCard('anim:' + s.id, scriptEntry('anim:' + s.id), false));
    list.appendChild(grid);
    list.appendChild(_div('assetHint', 'クリックで再生ヘッドの時刻から、その時に出ている全員(プレイヤー・人形)に付きます。タイムラインへドラッグすると落とした時刻から。⚙ で長さ・動かす人など。置いた後も「🎭 全体アニメ」の行をダブルクリックすると、設定を変えて作り直せます。中身は小さなスクリプトなので、</> で見てコピーして直せます。'));
    return;
  }
  if (source !== 'custom') return;
  const top = _div('assetIo');
  const newBtn = _el('button', 'btn btn-primary btn-sm', '＋ 新しく書く');
  newBtn.type = 'button';
  newBtn.addEventListener('click', () => createCustomScript(ANIM_SCRIPT_TEMPLATE, '新しい全体アニメ', true, { cat: 'anim' }));
  const impBtn = _el('button', 'btn btn-ghost btn-sm', '⬆ 読み込む');
  impBtn.type = 'button'; impBtn.title = '.js ファイル(全体アニメのスクリプト)を読み込む';
  const file = document.createElement('input');
  file.type = 'file'; file.accept = '.js,text/javascript,application/javascript'; file.multiple = true; file.style.display = 'none';
  file.addEventListener('change', async () => {
    const files = Array.from(file.files || []);
    file.value = '';
    for (const f of files) {
      if (f.size > 512 * 1024) { showToast(`${f.name} は大きすぎます(512KBまで)`); continue; }
      await importScriptFile(await f.text(), f.name, 'anim');
    }
  });
  impBtn.addEventListener('click', () => file.click());
  top.appendChild(newBtn); top.appendChild(impBtn); top.appendChild(file);
  list.appendChild(top);
  const mine = customAssets.filter(c => c.type === 'script' && c.cat === 'anim');
  const grid = _div('assetGrid');
  for (const c of mine) grid.appendChild(_cameraScriptCard('custom:' + c.id, scriptEntry('custom:' + c.id), true));
  list.appendChild(grid);
}

function warmAnimScriptDescribe() {
  let pending = 0;
  for (const s of OFFICIAL_ANIM_SCRIPTS) {
    if (describeScriptCached(s.code)) continue;
    pending++;
    describeScript(s.code).then(() => { if (--pending === 0 && activeAssetCategoryId === 'anim') renderAssetList(); });
  }
}


// ============================================================
// エディタの横に出す、APIの説明
// ============================================================

const ANIM_API_DOCS_HTML = `
<h3>全体アニメ = スクリプト</h3>
<p>全員(プレイヤー・人形)の動きを、<b>毎コマ計算</b>するスクリプトです。エディタはその結果のキーを減らして、人ごとに<b>ふつうのポーズのブロック</b>を作ります(あとで手で直せます)。作ったアニメは設定を覚えていて、右パネルで設定を変えるとその場で作り直されます。</p>

<h4>動かす</h4>
<table>
<tr><td><code>api.animate({ who, types, start, seconds, name, frame })</code></td><td>人ごと・コマごとに <code>frame(e, t, ctx)</code> を呼ぶ。何回呼んでもいい</td></tr>
<tr><td><code>who</code></td><td><code>'all'</code>(全員)/ <code>'players'</code> / <code>'puppets'</code> / <code>'me'</code>(右下で選んでいる人)/ <code>['player:1', …]</code> / <code>(e) =&gt; true か false</code></td></tr>
<tr><td><code>types</code></td><td>型でしぼる。例: <code>['humanoid']</code>(人型だけ)</td></tr>
<tr><td><code>start</code> / <code>seconds</code></td><td>始まり(tick。省くと置いた時刻 <code>api.start</code>)/ 長さ(秒)</td></tr>
<tr><td><code>frame(e, t, ctx)</code></td><td>e: 人 / t: 始まりからの秒 / ctx: { tick, index(何人目), count(人数), at: { pos, yaw, … }, auto(自動アニメーションの形), state(その人用の入れ物。前のコマの値を覚えておける), seconds }</td></tr>
</table>
<p><b>返す値:</b> <code>{ 関節: [x, y, z] }</code> か <code>{ 関節: { r: [x, y, z], p: [x, y, z] } }</code>。r は回転(度)、p は位置のずれ(ブロック)。<br>
返さなかった関節は元の動き(自動アニメーション)のまま。<code>null</code> を返すと、そのコマはその人を動かしません(元の動きのまま)。<br>
その人が出ていないコマは呼ばれません。</p>
<p><b>関節(人型):</b> root(全体)・body(体)・head(頭)・armR / armL(腕)・legR / legL(脚)。腕・脚は Bloxd と同じ1本(ひじ・ひざは無い)<br>
x = 前へ(腕・脚は前へ振る、頭・体は前へ倒す)/ y = ひねり(左が +)/ z = 横へ(腕・脚は外へ開く)<br>
root の p は、その人の向きが基準(y が上)。</p>

<h4>人の情報</h4>
<table>
<tr><td><code>api.entities()</code></td><td>全員の { key, name, kind('player'|'puppet'), type('humanoid' など), isMe, at(tick) }</td></tr>
<tr><td><code>e.at(tick)</code></td><td>{ tick, pos(足元。ワールド座標), yaw(度) }。出ていなければ null</td></tr>
<tr><td><code>api.entity(key)</code></td><td>1人</td></tr>
</table>

<h4>リプレイの記録・出来事</h4>
<table>
<tr><td><code>ctx.auto</code> / <code>e.auto(tick)</code></td><td>自動アニメーション(歩く・走る・振る…)の形 { 関節: { r, p } }。混ぜると、ふつうの動きから技へ なめらかに入れる。置いた時刻から60秒まで。無い時は null</td></tr>
<tr><td><code>e.at(tick)</code> のほか</td><td>swinging(腕を振っている)・crouching・jumping・held(持ち物の名前)・speed(横の速さ ブロック/秒)</td></tr>
<tr><td><code>api.events({ type, key, from, to })</code></td><td>出来事の一覧(tick の順)。type: <code>'attack'</code>(腕を振り始めた。target = 前にいる一番近い人)/ <code>'hurt'</code>(ダメージ。by = 直前に近くで腕を振った人、amount)/ <code>'death'</code> / <code>'respawn'</code> / <code>'shot'</code>。key でしぼると、その人が攻めた・受けた物の両方</td></tr>
</table>

<h4>体の位置・IK</h4>
<table>
<tr><td><code>e.part(tick, 名前, pose?)</code></td><td>体の点のワールド座標。pose を省くとまっすぐ立った形。名前: feet・pelvis・belly・chest・back・neck・head・face・headTop・shoulderR/L・handR/L・hipR/L・kneeR/L(脚のまん中)・footR/L</td></tr>
<tr><td><code>api.toLocal(e, tick, ワールドの点)</code> / <code>api.toWorld(e, tick, 点)</code></td><td>その人の足元・向きから見た座標(+z が前・+y が上・+x が左)⇄ ワールド座標</td></tr>
<tr><td><code>api.body.point(pose, 名前)</code> / <code>api.body.fk(pose)</code></td><td>その形の時の体の点(その人の座標)/ 全部の点</td></tr>
<tr><td><code>api.ik(pose, 'armR'|'armL'|'legR'|'legL', 点)</code></td><td>手・足(1本)の先が点(その人の座標)の方を向くように、つけ根の角度を pose に書きこむ(届く距離なら先がその点に来る)。戻り値 { pose, error, reached }</td></tr>
</table>
<p>例: 相手の顔をなぐる → <code>const t = api.toLocal(me, ctx.tick, you.part(ctx.tick, 'face')); api.ik(pose, 'armR', t);</code></p>

<h4>カメラのスクリプトと同じ物</h4>
<p><code>api.info</code> / <code>api.params</code> / <code>api.start</code> / <code>api.tps</code> / <code>api.view</code>(置いた時の視点)/ <code>api.player()</code> / <code>api.world</code>(raycast・isSolid・groundY)/ <code>api.math</code>(vec・lookAt・angleDiff・noise・random・smoothstep・easeInOut など)/ <code>api.log</code> / <code>api.toast</code> / <code>api.fail</code></p>
<p class="note">キーを減らす時のずれは、回転 ${ANIM_TOL_R}度・位置 ${ANIM_TOL_P}ブロックまで。スクリプトは隔離された場所で動き、${SCRIPT_TIMEOUT_MS / 1000}秒で打ち切られます。</p>
`;
