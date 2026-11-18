// script-runner.js
// ============================================================
// カメラスクリプト(生成型)の実行環境。
//
// ユーザーが書いた(または他の人から受け取った)JavaScriptを、ページから
// 切り離された場所で動かし、「カメラを足す・直す・消す」などの“操作の一覧”
// だけを受け取って、エディタに反映する(Ctrl+Z 1回で全部元に戻せる)。
//
// 隔離のしかた:
//   ページ ─ <iframe sandbox="allow-scripts">(別オリジン扱い・通信禁止のCSP)
//            └ Web Worker(ここでスクリプトを実行)
//   - スクリプトからは、このページの中身・保存データ・ネットワークに一切触れない
//   - 無限ループしても画面は固まらない。時間切れになったら iframe ごと捨てる
//   - 受け取った操作は、ページ側で全部チェックしてから反映する
//
// スクリプトに渡す材料(スナップショット)は実行のたびに作る:
//   プレイヤー全員の動き(全tick)、地形のブロック、今のカメラ・テキスト、再生ヘッドなど。
// 座標は Bloxd のワールド座標(画面左上に出ているのと同じ)、角度は「度」。
// ============================================================

const SCRIPT_TIMEOUT_MS = 15000;          // 実行の制限時間
const SCRIPT_DESCRIBE_TIMEOUT_MS = 4000;  // 設定項目を調べるだけの時の制限時間
const SCRIPT_MAX_OPS = 20000;
const SCRIPT_MAX_KEYS = 5000;


// ============================================================
// Worker の中で動くコード(この関数の中身だけが文字列として Worker に渡る。
// 外側の変数は一切使えないので、必要な計算はこの中に全部書いてある)
// ============================================================

function __cameraScriptWorkerMain() {
  const DEG = Math.PI / 180;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const STOP_DESCRIBE = { __stopDescribe: true };

  const CURVES = {
    linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3], smooth: [0.42, 0, 0.58, 1],
    easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1],
  };

  // ---------------- 数学 ----------------
  const vec = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 向き(度)→ 前向きのベクトル。yaw=0 が +Z、yaw=90 が +X
  function forward(yawDeg, pitchDeg) {
    const y = yawDeg * DEG, p = (pitchDeg || 0) * DEG;
    return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
  }
  // ステップ41: 画面を公式と同じ左右に映すので、右は (cos, 0, -sin)(人の右手の側・画面の右)
  function right(yawDeg) { const y = yawDeg * DEG; return [Math.cos(y), 0, -Math.sin(y)]; }
  function lookAt(from, to) {
    const d = vec.sub(to, from);
    return { yaw: Math.atan2(d[0], d[2]) / DEG, pitch: clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])) / DEG, -88, 88) };
  }
  function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeInOut(u) { u = clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  // なめらかな揺れ(-1〜1)。t が 1 増えるごとに1回くらい揺れる
  function noise(t, seed) {
    const h = (i) => { const x = Math.sin((i + (seed || 0) * 131.7) * 127.1) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
    const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  }
  // 決まった順で出る乱数(seed が同じなら毎回同じ結果)
  function random(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // 速さのカーブ(エディタの scEase と同じ)
  function bez(p1, p2, t) { const u = 1 - t; return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t; }
  function ease(c, x) {
    if (!c) return x;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 40; i++) { const v = bez(c[0], c[2], t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return bez(c[1], c[3], t);
  }
  function cr(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  // カメラのキー(秒・度)から、ある秒数の姿勢を出す(エディタと同じ補間)
  function evalKeys(ks, time) {
    const cp = (k) => ({ pos: k.pos.slice(), yaw: k.yaw, pitch: k.pitch });
    if (ks.length === 1 || time <= ks[0].time) return cp(ks[0]);
    if (time >= ks[ks.length - 1].time) return cp(ks[ks.length - 1]);
    let i = 0;
    while (i < ks.length - 2 && time > ks[i + 1].time) i++;
    const a = ks[i], b = ks[i + 1];
    const t = ease(a.curve, clamp((time - a.time) / ((b.time - a.time) || 1), 0, 1));
    const P = (j) => ks[clamp(j, 0, ks.length - 1)].pos;
    const pos = [0, 1, 2].map(c => cr(P(i - 1)[c], P(i)[c], P(i + 1)[c], P(i + 2)[c], t));
    return { pos, yaw: a.yaw + angleDiff(a.yaw, b.yaw) * t, pitch: a.pitch + (b.pitch - a.pitch) * t };
  }

  // ---------------- 地形 ----------------
  let solid = null;   // "x,y,z" → 出現するtick
  let columns = null; // "x,z" → そこにあるブロックのy(昇順)
  function buildWorld(blocks) {
    solid = new Map(); columns = new Map();
    for (let i = 0; i < blocks.length; i += 5) {
      const x = blocks[i], y = blocks[i + 1], z = blocks[i + 2], r = blocks[i + 3], h = blocks[i + 4];
      solid.set(x + ',' + y + ',' + z, [r, h]);
      const ck = x + ',' + z;
      let col = columns.get(ck);
      if (!col) { col = []; columns.set(ck, col); }
      col.push(y);
    }
    for (const col of columns.values()) col.sort((a, b) => a - b);
  }
  function isSolidBlock(bx, by, bz, tick) {
    const v = solid.get(bx + ',' + by + ',' + bz);
    if (v === undefined) return false;
    if (tick == null) return v[1] >= 2147483647;
    return v[0] <= tick && tick < v[1];
  }
  // from → to の線分で最初にぶつかるブロック(3D DDA)
  function raycast(from, to, opts) {
    const tick = opts && opts.tick;
    const d = vec.sub(to, from);
    const maxDist = vec.len(d);
    if (maxDist < 1e-9) return null;
    const dir = vec.scale(d, 1 / maxDist);
    let x = Math.floor(from[0]), y = Math.floor(from[1]), z = Math.floor(from[2]);
    const step = dir.map(v => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tDelta = dir.map(v => (v !== 0 ? Math.abs(1 / v) : Infinity));
    const cell = [x, y, z];
    const tMax = [0, 1, 2].map(i => {
      if (dir[i] === 0) return Infinity;
      const edge = step[i] > 0 ? cell[i] + 1 : cell[i];
      return (edge - from[i]) / dir[i];
    });
    let t = 0, normal = [0, 0, 0];
    if (opts && opts.ignoreStart) { /* 出発点のブロックは見ない */ }
    else if (isSolidBlock(x, y, z, tick)) return { pos: from.slice(), block: [x, y, z], normal: [0, 0, 0], dist: 0 };
    for (let n = 0; n < 4096; n++) {
      const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      t = tMax[axis];
      if (t > maxDist) return null;
      if (axis === 0) x += step[0]; else if (axis === 1) y += step[1]; else z += step[2];
      tMax[axis] += tDelta[axis];
      normal = [0, 0, 0]; normal[axis] = -step[axis];
      if (isSolidBlock(x, y, z, tick)) return { pos: vec.add(from, vec.scale(dir, t)), block: [x, y, z], normal, dist: t };
    }
    return null;
  }
  // (x,z) の列で、fromY 以下にある一番上のブロックの上面の高さ(無ければ null)
  function groundY(x, z, fromY, tick) {
    const col = columns.get(Math.floor(x) + ',' + Math.floor(z));
    if (!col) return null;
    for (let i = col.length - 1; i >= 0; i--) {
      const y = col[i];
      if (fromY != null && y > fromY) continue;
      if (isSolidBlock(Math.floor(x), y, Math.floor(z), tick)) return y + 1;
    }
    return null;
  }

  // ---------------- 実行 ----------------
  self.onmessage = async (ev) => {
    const { mode, code, params, snapshot: S } = ev.data;
    const ops = [];
    const logs = [];
    let defs = null, info = null, newId = 0;
    const out = (type, extra) => postMessage(Object.assign({ type, ops, logs, defs, info }, extra || {}));
    const fail = (message) => { const e = new Error(message); e.__userFail = true; throw e; };
    const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })());
    const pushOp = (op) => { if (ops.length >= 20000) fail('操作が多すぎます(20000個まで)'); ops.push(op); };

    try {
      if (mode === 'run') buildWorld(S.blocks);

      // プレイヤー
      const entities = S.entities || [];
      const findEntity = (id) => entities.find(e => String(e.id) === String(id));
      function makePlayer(e) {
        const n = e.count;
        return {
          id: e.id, name: e.name, isMe: e.isMe, ticks: n,
          at(tick) {
            if (!n) return null;
            const i = clamp(Math.round(tick), 0, n - 1);
            const pos = [e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2]];
            return {
              tick: i, pos, head: [pos[0], pos[1] + 1.5, pos[2]],
              yaw: e.rot[i * 2 + 1] / DEG, pitch: e.rot[i * 2] / DEG,
              pose: e.pose[i], held: e.held[i], jumping: !!e.jump[i], crouching: !!e.crouch[i],
            };
          },
        };
      }
      // ---- 仕上げの道具(壁よけ・手ぶれ)。キーの配列を受け取って、新しいキーの配列を返す ----
      function resolveKeys(keys) {
        if (!Array.isArray(keys) || !keys.length) fail('キーの配列が空です');
        return keys.map(function (k) {
          const o = { time: +k.time || 0, pos: k.pos.slice(), yaw: k.yaw, pitch: k.pitch };
          const c = typeof k.curve === 'string' ? CURVES[k.curve] : k.curve;
          if (c) o.curve = c;
          if (k.lookAt) { const a = lookAt(k.pos, k.lookAt); o.yaw = a.yaw; o.pitch = a.pitch; }
          if (o.yaw == null) o.yaw = 0;
          if (o.pitch == null) o.pitch = 0;
          return o;
        }).sort(function (a, b) { return a.time - b.time; });
      }
      function sampleTimes(len, step) {
        const n = Math.max(1, Math.round(len / step));
        const out = [];
        for (let i = 0; i <= n; i++) out.push(len * i / n);
        return out;
      }
      const startTick = S.start != null ? S.start : S.playhead;
      const fx = {
        resolve: resolveKeys,
        // 見る相手(ふつうはプレイヤーの頭)との間にブロックがある所だけ、カメラを相手の側へ寄せる
        avoidWalls(keys, o) {
          o = o || {};
          const ks = resolveKeys(keys);
          const start = o.start != null ? o.start : startTick;
          const len = o.seconds != null ? o.seconds : ks[ks.length - 1].time;
          const pl = o.target ? null : api.player(o.playerId);
          const target = o.target || function (t) { return pl.at(start + t * S.tps).head; };
          const margin = o.margin != null ? o.margin : 0.6, minDist = o.minDist != null ? o.minDist : 1.5;
          const aim = o.aim !== false;
          let moved = 0;
          const out = sampleTimes(len, o.step || 0.25).map(function (t) {
            const tick = start + t * S.tps;
            const pose = evalKeys(ks, t);
            const tg = target(t);
            // 相手(プレイヤーの頭)がブロックに埋まっている時は判断できないので、そのまま
            if (isSolidBlock(Math.floor(tg[0]), Math.floor(tg[1]), Math.floor(tg[2]), tick)) return { time: t, pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch };
            const hit = raycast(tg, pose.pos, { tick: tick, ignoreStart: true });
            if (!hit) return { time: t, pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch };
            moved++;
            // 1) 壁の手前まで寄せる(近づきすぎない時)  2) だめなら上へ逃げる(壁越しに見下ろす)
            // 3) それもだめなら、できるだけ寄せる
            let pos = null;
            const pull = hit.dist - margin;
            if (pull >= minDist) pos = vec.add(tg, vec.scale(vec.norm(vec.sub(pose.pos, tg)), pull));
            if (!pos) {
              for (const dh of [1.5, 3, 4.5, 6, 8, 11]) {
                const up = [pose.pos[0], pose.pos[1] + dh, pose.pos[2]];
                if (!raycast(tg, up, { tick: tick, ignoreStart: true })) { pos = up; break; }
              }
            }
            if (!pos) pos = vec.add(tg, vec.scale(vec.norm(vec.sub(pose.pos, tg)), Math.max(0.4, pull)));
            const a = aim ? lookAt(pos, tg) : pose;
            return { time: t, pos: pos, yaw: a.yaw, pitch: a.pitch };
          });
          if (!moved) return ks;
          // 動かさなかった所が続く時は、途中のキーを省く(固定カメラが無駄にキーだらけにならないように)
          const same = (a, b) => a && b && vec.dist(a.pos, b.pos) < 1e-6 && Math.abs(a.yaw - b.yaw) < 1e-6 && Math.abs(a.pitch - b.pitch) < 1e-6;
          return out.filter(function (k, i) { return i === 0 || i === out.length - 1 || !(same(k, out[i - 1]) && same(k, out[i + 1])); });
        },
        // 手で持って撮ったような揺れ
        handheld(keys, o) {
          o = o || {};
          const ks = resolveKeys(keys);
          const amount = o.amount != null ? o.amount : 0.12, turn = o.turn != null ? o.turn : 0.8;
          const speed = o.speed || 0.8, seed = o.seed || 1;
          if (!amount && !turn) return ks;
          const len = o.seconds != null ? o.seconds : ks[ks.length - 1].time;
          return sampleTimes(len, o.step || 0.1).map(function (t) {
            const pose = evalKeys(ks, t), u = t * speed;
            return {
              time: t,
              pos: [pose.pos[0] + noise(u, seed) * amount, pose.pos[1] + noise(u, seed + 11) * amount * 0.6, pose.pos[2] + noise(u, seed + 23) * amount],
              yaw: pose.yaw + noise(u * 1.3, seed + 37) * turn,
              pitch: pose.pitch + noise(u * 1.1, seed + 51) * turn * 0.7,
            };
          });
        },
        // よく使う仕上げをまとめて: { seconds, avoid: true/false, shake: 0〜1 }
        finish(keys, o) {
          o = o || {};
          let ks = resolveKeys(keys);
          if (o.avoid) ks = fx.avoidWalls(ks, o);
          if (o.shake > 0) ks = fx.handheld(ks, { seconds: o.seconds, amount: o.shake * 0.3, turn: o.shake * 2.5, seed: o.seed || 1 });
          return ks;
        },
      };

      const cams = (S.cameras || []).map(c => Object.assign({}, c, { poseAt(tick) { return evalKeys(c.keys, (tick - c.start) / S.tps); } }));

      const api = {
        version: 1,
        tps: S.tps, totalTicks: S.totalTicks, playhead: S.playhead, start: startTick,
        toTick: (sec) => sec * S.tps, toSec: (tick) => tick / S.tps,
        view: S.view,
        info(o) { info = { name: o && o.name ? String(o.name) : null, description: o && o.description ? String(o.description) : null }; },
        params(d) {
          defs = d || {};
          if (mode === 'describe') throw STOP_DESCRIBE;
          const v = {};
          for (const k of Object.keys(defs)) v[k] = (params && k in params) ? params[k] : defs[k].default;
          return v;
        },
        players: () => entities.map(e => ({ id: e.id, name: e.name, isMe: e.isMe })),
        player(id) {
          const e = id == null ? (findEntity(S.focusId) || entities[0]) : findEntity(id);
          if (!e) fail(id == null ? 'プレイヤーの情報がありません' : `プレイヤー ${id} が見つかりません`);
          return makePlayer(e);
        },
        world: {
          isSolid: (x, y, z, tick) => isSolidBlock(Math.floor(x), Math.floor(y), Math.floor(z), tick),
          raycast, groundY,
        },
        math: { vec, clamp, lerp: (a, b, t) => a + (b - a) * t, forward, right, lookAt, angleDiff, smoothstep, easeInOut, noise, random, DEG },
        cameras: () => cams,
        camera: (id) => cams.find(c => String(c.id) === String(id)) || null,
        selectedCamera: () => cams.find(c => c.id === S.selectedCameraId) || null,
        texts: () => S.texts || [],
        addCamera(spec) { const id = 'new' + (++newId); pushOp({ op: 'addCamera', id, spec }); return id; },
        updateCamera(id, patch) { pushOp({ op: 'updateCamera', id, patch }); },
        removeCamera(id) { pushOp({ op: 'removeCamera', id }); },
        addText(spec) { pushOp({ op: 'addText', spec }); },
        select(id) { pushOp({ op: 'select', id }); },
        seek(tick) { pushOp({ op: 'seek', tick }); },
        log(...a) { if (logs.length < 500) logs.push(a.map(fmt).join(' ')); },
        toast(msg) { pushOp({ op: 'toast', text: String(msg) }); },
        progress(p) { postMessage({ type: 'progress', value: clamp(+p || 0, 0, 1) }); },
        fail,
        curves: CURVES,
        evalKeys,
        fx,
        // ---- エンティティアニメーション(anim-scripts.js) ----
        entities: () => animEntities(),
        entity: (key) => animEntities().find(e => e.key === String(key)) || null,
        animate: (spec) => animate(spec),
        events: (f) => animEvents(f),
        toLocal: (e, tick, w) => toLocal(e, tick, w),
        toWorld: (e, tick, l) => toWorld(e, tick, l),
        body: { fk: (pose) => { const f = fk(pose); const o = {}; for (const k of Object.keys(PARTS)) o[k] = partLocal(null, k, f); return o; }, point: (pose, name) => partLocal(pose || {}, name), parts: () => Object.keys(PARTS) },
        ik: (pose, limb, target, opts) => ik(pose, limb, target, opts),
      };

      // ---- 人型の組み立て(エディタの poseBuildRig と同じ計算)。座標はその人の足元が原点、+z が前、+y が上 ----
      const MT = {
        mul(a, b) { const o = new Array(16); for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k]; o[col * 4 + row] = s; } return o; },
        T: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
        RX: (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; },
        RY: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
        RZ: (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
        pt: (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]],
      };
      const RIG = (S.anim && S.anim.rig) || null;
      const jrot = (sign, r) => MT.mul(MT.mul(MT.RY(sign[1] * r[1] * DEG), MT.RZ(sign[2] * r[2] * DEG)), MT.RX(sign[0] * r[0] * DEG));
      const jv = (v) => (v == null ? { r: [0, 0, 0], p: [0, 0, 0] } : Array.isArray(v) ? { r: v, p: [0, 0, 0] } : { r: v.r || [0, 0, 0], p: v.p || [0, 0, 0] });
      function fk(pose) {
        if (!RIG) fail('組み立ての情報がありません');
        pose = pose || {};
        const root = jv(pose.root), pv = RIG.rootPivot, f = {};
        f.root = MT.mul(MT.mul(MT.T(root.p[0], root.p[1] + pv, root.p[2]), jrot(RIG.rootSign, root.r)), MT.T(0, -pv, 0));
        for (const b of RIG.bones) {
          const v = jv(pose[b.joint]);
          f[b.joint] = MT.mul(MT.mul(f[b.parent], MT.T(b.at[0] + v.p[0], b.at[1] + v.p[1], b.at[2] + v.p[2])), jrot(b.sign, v.r));
        }
        return f;
      }
      // 体の点: 関節と、その関節から見た位置
      const PARTS = {
        // ステップ31: Bloxd 公式の Player_Model の寸法
        feet: ['root', [0, 0, 0]], pelvis: ['body', [0, 0, 0]], belly: ['body', [0, 0.25, 0.125]], chest: ['body', [0, 0.5, 0.125]], back: ['body', [0, 0.5, -0.125]],
        neck: ['head', [0, 0, 0]], head: ['head', [0, 0.28, 0]], face: ['head', [0, 0.28, 0.28]], headTop: ['head', [0, 0.5625, 0]],
        shoulderR: ['armR', [0, 0, 0]], shoulderL: ['armL', [0, 0, 0]],
        handR: ['armR', [-0.0625, -0.703, 0]], handL: ['armL', [0.0625, -0.703, 0]],
        hipR: ['legR', [0, 0, 0]], hipL: ['legL', [0, 0, 0]], kneeR: ['legR', [0, -0.375, 0]], kneeL: ['legL', [0, -0.375, 0]],
        footR: ['legR', [0, -0.75, 0]], footL: ['legL', [0, -0.75, 0]],
      };
      function partLocal(pose, name, frames) {
        const d = PARTS[name];
        if (!d) fail('体の点 "' + name + '" はありません(' + Object.keys(PARTS).join(', ') + ')');
        return MT.pt((frames || fk(pose))[d[0]], d[1]);
      }
      // その人の足元・向きから見た座標 ⇄ ワールド座標
      function baseOf(e, tick) { const a = e.at(tick); if (!a) return null; return a; }
      function toLocal(e, tick, w) {
        const a = baseOf(e, tick); if (!a) return null;
        const y = a.yaw * DEG, d = [w[0] - a.pos[0], w[1] - a.pos[1], w[2] - a.pos[2]];
        return [d[0] * Math.cos(y) - d[2] * Math.sin(y), d[1], d[0] * Math.sin(y) + d[2] * Math.cos(y)];
      }
      function toWorld(e, tick, l) {
        const a = baseOf(e, tick); if (!a) return null;
        const y = a.yaw * DEG;
        return [a.pos[0] + l[0] * Math.cos(y) + l[2] * Math.sin(y), a.pos[1] + l[1], a.pos[2] - l[0] * Math.sin(y) + l[2] * Math.cos(y)];
      }
      // IK: 手・足(1本)の先を target(その人の座標)の方へ向ける。つけ根の x・z を決める(ひねり y はそのまま)
      //   届かない所・近すぎる所は、その方向の、先が届く所を狙う
      const LIMBS = { armR: ['armR', 'handR', 'shoulderR'], armL: ['armL', 'handL', 'shoulderL'], legR: ['legR', 'footR', 'hipR'], legL: ['legL', 'footL', 'hipL'] };
      function ik(pose, limb, target, opts) {
        const L = LIMBS[limb];
        if (!L) fail('ik の手足は armR / armL / legR / legL です');
        opts = opts || {};
        const [up, tip, rootName] = L;
        const u0 = jv(pose[up]);
        const q = [u0.r[0], u0.r[2]];
        const set = (qq) => { pose[up] = { r: [qq[0], u0.r[1], qq[1]], p: u0.p.slice() }; };
        const tipAt = (qq) => { set(qq); return partLocal(pose, tip); };
        const base = partLocal(pose, rootName);
        const len = vec.dist(base, tipAt(q));
        const want = vec.dist(base, target);
        const aim = want > 1e-6 ? vec.add(base, vec.scale(vec.sub(target, base), len / want)) : target;
        let err = Infinity;
        for (let it = 0; it < (opts.iterations || 30); it++) {
          const p0 = tipAt(q);
          const e = vec.sub(aim, p0);
          err = vec.len(e);
          if (err < 0.003) break;
          const J = [0, 1].map(k => { const qq = q.slice(); qq[k] += 0.6; return vec.scale(vec.sub(tipAt(qq), p0), 1 / 0.6); });
          const a = vec.dot(J[0], J[0]) + 1e-5, b = vec.dot(J[0], J[1]), c = vec.dot(J[1], J[1]) + 1e-5;
          const gx = vec.dot(J[0], e), gz = vec.dot(J[1], e);
          const det = a * c - b * b;
          if (Math.abs(det) < 1e-14) break;
          let dx = (c * gx - b * gz) / det, dz = (a * gz - b * gx) / det;
          const mx = Math.max(Math.abs(dx), Math.abs(dz));
          if (mx > 25) { dx *= 25 / mx; dz *= 25 / mx; }
          q[0] = ((q[0] + dx + 180) % 360 + 360) % 360 - 180;
          q[1] = ((q[1] + dz + 180) % 360 + 360) % 360 - 180;
        }
        set(q);
        return { pose, error: Math.abs(want - len) + err, reached: err < 0.02 && Math.abs(want - len) < 0.03 };
      }

      // エンティティ(プレイヤー・人形)。at(tick) = 足元の位置(ワールド座標)・向き(度)・リプレイの記録。出ていない時は null
      let _animEnts = null;
      function animEntities() {
        if (_animEnts) return _animEnts;
        const A = S.anim || { entities: [], heldNames: [] };
        _animEnts = A.entities.map(function (d) {
          const P = (i) => [d.pos[i * 3], d.pos[i * 3 + 1], d.pos[i * 3 + 2]];
          const e = {
            key: d.key, name: d.name, kind: d.kind, type: d.type, isMe: !!d.isMe,
            at(tick) {
              const i = Math.round(tick);
              if (i < 0 || i >= d.present.length || !d.present[i]) return null;
              const a = d.present[i - 1] ? i - 1 : i, b = d.present[i + 1] ? i + 1 : i;
              const pa = P(a), pb = P(b);
              const speed = b > a ? Math.hypot(pb[0] - pa[0], pb[2] - pa[2]) / ((b - a) / S.tps) : 0;
              return { tick: i, pos: P(i), yaw: d.yaw[i],
                       swinging: !!(d.swing && d.swing[i]), crouching: !!(d.crouch && d.crouch[i]), jumping: !!(d.jump && d.jump[i]),
                       held: d.held && d.held[i] >= 0 ? A.heldNames[d.held[i]] : null, speed };
            },
            // 体の点のワールド座標(pose を省くと、まっすぐ立った形)
            part(tick, name, pose) { const l = partLocal(pose || {}, name); return toWorld(e, tick, l); },
            // 自動アニメーション(歩く・走る・振る…)の形 { 関節: { r, p } }。無い時(人型でない・範囲の外・オフ)は null
            auto(tick) {
              const i = Math.round(tick) - A.autoStart;
              if (!d.auto || i < 0 || i >= A.autoLen || !d.present[Math.round(tick)]) return null;
              const J = A.autoJoints, o = {};
              J.forEach((j, k) => { const b = (i * J.length + k) * 6; o[j] = { r: [d.auto[b], d.auto[b + 1], d.auto[b + 2]], p: [d.auto[b + 3], d.auto[b + 4], d.auto[b + 5]] }; });
              return o;
            },
          };
          return e;
        });
        return _animEnts;
      }
      function animEvents(f) {
        const all = (S.anim && S.anim.events) || [];
        f = f || {};
        return all.filter(ev => (!f.type || (Array.isArray(f.type) ? f.type.includes(ev.type) : ev.type === f.type)) &&
          (!f.key || ev.key === f.key || ev.by === f.key || ev.target === f.key) &&
          (f.from == null || ev.tick >= f.from) && (f.to == null || ev.tick <= f.to)).map(ev => Object.assign({}, ev));
      }
      // 毎コマ frame(e, t, ctx) を呼んで、関節の値を集める(エディタ側でキーを減らしてポーズのブロックにする)
      let animSamples = 0;
      function animate(spec) {
        spec = spec || {};
        if (typeof spec.frame !== 'function') fail('api.animate には frame(e, t, ctx) を書いてください');
        const total = (S.anim && S.anim.n) || S.totalTicks;
        let list = animEntities().slice();
        const who = spec.who == null ? 'all' : spec.who;
        if (Array.isArray(who)) { const ks = who.map(String); list = list.filter(e => ks.includes(e.key)); }
        else if (typeof who === 'function') list = list.filter(e => who(e));
        else if (who === 'players') list = list.filter(e => e.kind === 'player');
        else if (who === 'puppets') list = list.filter(e => e.kind === 'puppet');
        else if (who === 'me') list = list.filter(e => e.key === 'player:' + S.focusId);
        else if (typeof who === 'string' && who !== 'all') list = list.filter(e => e.key === who);
        if (spec.types) list = list.filter(e => spec.types.includes(e.type));
        const start = clamp(Math.round(spec.start != null ? spec.start : startTick), 0, Math.max(0, total - 1));
        const len = Math.max(1, Math.min(total - start, Math.round((spec.seconds != null ? +spec.seconds : 3) * S.tps)));
        const name = spec.name != null ? String(spec.name) : null;
        list.forEach(function (e, index) {
          const joints = {};
          const present = new Uint8Array(len);
          const state = {};
          let any = false;
          for (let k = 0; k < len; k++) {
            const tick = start + k;
            const at = e.at(tick);
            if (!at) continue; // 出ていない時は動かせない
            const r = spec.frame(e, k / S.tps, { tick, index, count: list.length, at, state, seconds: len / S.tps, auto: e.auto ? e.auto(tick) : null });
            if (!r) continue;   // null を返したコマは、元の動きのまま
            present[k] = 1; any = true;
            for (const j of Object.keys(r)) {
              let v = r[j];
              if (v == null) continue;
              if (Array.isArray(v)) v = { r: v };
              let arr = joints[j];
              if (!arr) {
                animSamples += len * 6;
                if (animSamples > 4000000) fail('動かす量が多すぎます(人数・長さ・関節の数を減らしてください)');
                arr = joints[j] = new Float32Array(len * 6);
              }
              const rr = v.r || [0, 0, 0], pp = v.p || [0, 0, 0];
              for (let n = 0; n < 3; n++) { arr[k * 6 + n] = +rr[n] || 0; arr[k * 6 + 3 + n] = +pp[n] || 0; }
            }
          }
          if (any) pushOp({ op: 'pose', target: e.key, start, n: len, name, joints, present });
        });
      }
      const fn = new AsyncFunction('api', '"use strict";\n' + code);
      await fn(api);
      out('done');
    } catch (err) {
      if (err === STOP_DESCRIBE) { out('done'); return; }
      if (err && err.__userFail) { out('fail', { message: err.message }); return; }
      // 行番号(関数の頭の2行+"use strict"の1行ぶんずらす)
      let line = null;
      const m = err && err.stack && /<anonymous>:(\d+):(\d+)/.exec(err.stack);
      if (m) line = Math.max(1, parseInt(m[1], 10) - 3);
      out('error', { message: (err && err.message) || String(err), line });
    }
  };
}


// ============================================================
// 隔離した場所での実行
// ============================================================

const SANDBOX_HTML = `<!DOCTYPE html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:">
<script>
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  try {
    const url = URL.createObjectURL(new Blob([e.data.src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (m) => parent.postMessage(m.data, '*');
    w.onerror = (err) => { err.preventDefault(); parent.postMessage({ type: 'error', message: err.message || 'スクリプトの読み込みに失敗しました', line: null, ops: [], logs: [] }, '*'); };
    w.postMessage(e.data.payload);
  } catch (err) {
    parent.postMessage({ type: 'error', message: 'スクリプトを動かす準備に失敗しました: ' + err, line: null, ops: [], logs: [] }, '*');
  }
});
parent.postMessage({ type: 'sandboxReady' }, '*');
<\/script>`;

const WORKER_SRC = `(${__cameraScriptWorkerMain.toString()})();`;

let _scriptRunSeq = 0;

// 戻り値: Promise<{ type:'done'|'fail'|'error'|'timeout', ops, logs, defs, info, message, line }>
// extra(作り直しの時に、最初に置いた時と同じ条件で動かすため):
//   start … api.start(カメラを置く時刻。省略すると再生ヘッド)
//   view … api.view(置いた時の編集視点) / focusId … api.player() の人
//   excludeGroup … このグループのカメラは api.cameras() に入れない(作り直すと消える物なので)
function runScriptSandboxed(code, mode, params, onProgress, extra) {
  const snapshot = buildScriptSnapshot(mode, extra);
  const timeoutMs = mode === 'describe' ? SCRIPT_DESCRIBE_TIMEOUT_MS : SCRIPT_TIMEOUT_MS;
  const seq = ++_scriptRunSeq;
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = SANDBOX_HTML;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      frame.remove(); // Worker ごと止まる
      resolve(Object.assign({ ops: [], logs: [], defs: null, info: null }, result));
    };
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
      const d = e.data;
      if (d.type === 'sandboxReady') {
        frame.contentWindow.postMessage({ src: WORKER_SRC, payload: { mode, code, params, snapshot } }, '*');
      } else if (d.type === 'progress') {
        if (onProgress) onProgress(+d.value || 0);
      } else if (d.type === 'done' || d.type === 'fail' || d.type === 'error') {
        finish({
          type: d.type,
          ops: Array.isArray(d.ops) ? d.ops : [],
          logs: Array.isArray(d.logs) ? d.logs.map(String) : [],
          defs: d.defs && typeof d.defs === 'object' ? d.defs : null,
          info: d.info && typeof d.info === 'object' ? d.info : null,
          message: d.message != null ? String(d.message) : null,
          line: Number.isFinite(d.line) ? d.line : null,
        });
      }
    };
    const timer = setTimeout(() => finish({ type: 'timeout', message: `${timeoutMs / 1000}秒たっても終わらなかったので止めました(無限ループになっていませんか?)` }), timeoutMs);
    window.addEventListener('message', onMsg);
    document.body.appendChild(frame);
    void seq;
  });
}


// ============================================================
// スクリプトに渡す材料(スナップショット)
// ============================================================

let _scriptBlocksCache = { faces: null, len: -1, data: null };

// 地形: 面のデータから「ブロックがある場所」を取り出す([x,y,z,出現tick] の並び)
function _scriptWorldBlocks() {
  const faces = (typeof fcMeshFaces !== 'undefined') ? fcMeshFaces : { d: new Int32Array(0), length: 0, ver: 0 };
  const c = _scriptBlocksCache;
  if (c.faces === faces && c.len === faces.ver && c.data) return c.data;
  // 位置 -> [出る時刻, 消える時刻](壊されたブロックは消える時刻がある。無ければ 2^31-1)
  const NEVER = 2147483647;
  const map = new Map();
  // ステップ50: 面は数の並び(8個ずつ)。場所は1つの数にする
  const D = faces.d, nf = faces.length || 0;
  for (let i = 0; i < nf; i++) {
    const o = i * 8;
    if (D[o + 3] < 0) continue;   // 消した面
    const s = Math.max(1, (D[o + 5] & 255) || 1);
    const r = D[o + 6] || 0;
    const h = Math.min(NEVER, D[o + 7]);
    for (let dx = 0; dx < s; dx++) for (let dz = 0; dz < s; dz++) {
      const k = _fcPosKey(D[o] + dx, D[o + 1], D[o + 2] + dz);
      const prev = map.get(k);
      if (prev === undefined) map.set(k, [r, h]);
      else { prev[0] = Math.min(prev[0], r); prev[1] = Math.max(prev[1], h); }
    }
  }
  const data = new Int32Array(map.size * 5);
  let i = 0;
  for (const [k, v] of map) {
    const y = (k % 4096) - 2048, t = (k - (y + 2048)) / 4096;
    const z = (t % 1048576) - 524288, x = Math.floor(t / 1048576) - 524288;
    data[i++] = x; data[i++] = y; data[i++] = z; data[i++] = v[0]; data[i++] = v[1];
  }
  _scriptBlocksCache = { faces, len: faces.ver, data };
  return data;
}

function _scriptEntities() {
  if (typeof allTimelines === 'undefined' || !allTimelines) return [];
  const out = [];
  for (const [eid, ent] of Object.entries(allTimelines.entities)) {
    const fr = ent.frames || [];
    const n = fr.length;
    const pos = new Float64Array(n * 3), rot = new Float64Array(n * 2);
    const pose = new Array(n), held = new Array(n), jump = new Uint8Array(n), crouch = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const f = fr[i] || {};
      const p = f.position || [0, 0, 0], r = f.rotation || [0, 0];
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      rot[i * 2] = r[0] || 0; rot[i * 2 + 1] = r.length > 1 ? r[1] : 0;
      pose[i] = f.pose == null ? null : String(f.pose);
      held[i] = f.heldItemName == null ? null : String(f.heldItemName);
      jump[i] = f.jumping ? 1 : 0; crouch[i] = f.crouching ? 1 : 0;
    }
    out.push({ id: eid, name: ent.displayName || ent.name || ('ID ' + eid), isMe: eid === allTimelines.localPlayerEntityId,
               count: n, pos, rot, pose, held, jump, crouch });
  }
  return out;
}

const _r2d = (r) => r * 180 / Math.PI;

// エンティティアニメーション用: 全員(プレイヤー・人形)の、コマごとの
//   足元(ワールド座標)・向き(度)・リプレイの記録(腕を振った・しゃがみ・ジャンプ・持ち物)と、
//   リプレイの出来事(攻撃・ダメージ・倒れる・復活・撃つ)。tick は全部コマの番号
const SCRIPT_AUTO_WINDOW_SEC = 60; // 自動アニメーションの形を渡すのは、置いた時刻からこの秒数まで
function _scriptAnimEntities(start) {
  const n = scMaxTick() + 1;
  const J = rigJoints('humanoid');
  const a0 = Math.max(0, Math.min(n - 1, Math.round(start || 0)));
  const aLen = Math.max(0, Math.min(n - a0, Math.round(SCRIPT_AUTO_WINDOW_SEC * scTps())));
  const out = [];
  const heldNames = [], heldIdx = new Map();
  const heldId = (s) => { if (s == null) return -1; if (!heldIdx.has(s)) { heldIdx.set(s, heldNames.length); heldNames.push(s); } return heldIdx.get(s); };
  for (const e of poseEntityList()) {
    const pos = new Float32Array(n * 3), yaw = new Float32Array(n), present = new Uint8Array(n);
    const swing = new Uint8Array(n), crouch = new Uint8Array(n), jump = new Uint8Array(n), held = new Int16Array(n).fill(-1);
    const ent = e.key.startsWith('player:') && typeof allTimelines !== 'undefined' && allTimelines ? allTimelines.entities[e.key.slice(7)] : null;
    for (let i = 0; i < n; i++) {
      const b = poseEntityBase(e.key, i);
      if (!b) continue;
      present[i] = 1;
      pos[i * 3] = b.pos[0] + worldOriginX; pos[i * 3 + 1] = b.pos[1] + worldOriginY; pos[i * 3 + 2] = b.pos[2] + worldOriginZ;
      yaw[i] = _r2d(b.yaw);
      if (ent) {
        const f = nearestFrameAtOrBefore(ent.frames, _poseTickVal(i));
        if (f) { swing[i] = f.armSwinging ? 1 : 0; crouch[i] = f.crouching ? 1 : 0; jump[i] = f.jumping ? 1 : 0; held[i] = heldId(f.heldItemName); }
      }
    }
    // 自動アニメーションの形(人型だけ・置いた時刻から決まった秒数まで)。関節は J の順に r,p の6個ずつ
    let auto = null;
    if (e.type === 'humanoid' && typeof autoAnimPose === 'function' && aLen > 0) {
      auto = new Float32Array(aLen * J.length * 6);
      for (let i = 0; i < aLen; i++) {
        if (!present[a0 + i]) continue;
        const ap = autoAnimPose(e.key, a0 + i);
        if (!ap) continue;
        J.forEach((j, k) => { const v = ap[j]; if (!v) return; const o = (i * J.length + k) * 6; auto[o] = v.r[0]; auto[o + 1] = v.r[1]; auto[o + 2] = v.r[2]; auto[o + 3] = v.p[0]; auto[o + 4] = v.p[1]; auto[o + 5] = v.p[2]; });
      }
    }
    out.push({ key: e.key, name: e.name, kind: e.key.startsWith('puppet:') ? 'puppet' : 'player', type: e.type,
               isMe: typeof allTimelines !== 'undefined' && allTimelines && e.key === 'player:' + allTimelines.localPlayerEntityId,
               pos, yaw, present, swing, crouch, jump, held, auto });
  }
  return { n, entities: out, heldNames, autoStart: a0, autoLen: aLen, autoJoints: J, events: _scriptAnimEvents(out, n),
           rig: { bones: RIG_TYPES.humanoid.bones.map(b => ({ joint: b.joint, parent: b.parent, at: b.at, sign: b.sign })),
                  rootPivot: RIG_TYPES.humanoid.rootPivot, rootSign: RIG_TYPES.humanoid.rootSign } };
}

// リプレイの tick → コマの番号
function _scriptFrameOfTick(tick) {
  const fr = timeline && timeline.frames;
  if (!fr || !fr.length) return Math.round(tick);
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].tick < tick) lo = m + 1; else hi = m; }
  return lo;
}

// 出来事の一覧 [{ type, key, tick, by?, target? }](tick の順)
//   attack: 腕を振り始めた(target = その時に前にいる一番近い人。4.5ブロックまで)
//   hurt: ダメージを受けた(by = 直前に腕を振った近くの人)/ death / respawn / shot
function _scriptAnimEvents(ents, n) {
  const evs = [];
  const P = (e, i) => [e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2]];
  const near = (a, i, maxD, needFront) => {
    let best = null, bd = maxD;
    for (const b of ents) {
      if (b === a || !b.present[i]) continue;
      const pa = P(a, i), pb = P(b, i);
      const d = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]);
      if (d > bd) continue;
      if (needFront) {
        const y = a.yaw[i] * Math.PI / 180;
        if (((pb[0] - pa[0]) * Math.sin(y) + (pb[2] - pa[2]) * Math.cos(y)) / (d || 1) < 0.3) continue;
      }
      best = b; bd = d;
    }
    return best;
  };
  for (const e of ents) {
    for (let i = 1; i < n; i++) {
      if (e.swing[i] && !e.swing[i - 1] && e.present[i]) {
        const t = near(e, i, 4.5, true);
        evs.push({ type: 'attack', key: e.key, tick: i, target: t ? t.key : null });
      }
    }
  }
  const raw = (typeof allTimelines !== 'undefined' && allTimelines && allTimelines.events) || [];
  const byKey = new Map(ents.map(e => [e.key, e]));
  for (const ev of raw) {
    let type = null, eid = null;
    if (ev.type === 'lifeformHealth' && ev.from != null && ev.to != null) {
      eid = ev.entityId;
      if (ev.to < ev.from - 1e-6 && ev.to > 0.001) type = 'hurt';
      else if (ev.from <= 0.001 && ev.to > 0.001) type = 'respawn';
      else if (ev.to <= 0.001 && ev.from > 0.001) type = 'death';
    } else if (ev.type === 'playerKilled') { eid = ev.dead; type = 'death'; }
    else if (ev.type === 'bullet') { eid = ev.entityId; type = 'shot'; }
    if (!type) continue;
    const key = 'player:' + eid;
    const me = byKey.get(key);
    if (!me) continue;
    const i = Math.min(n - 1, _scriptFrameOfTick(ev.tick));
    const o = { type, key, tick: i, amount: ev.from != null && ev.to != null ? +(ev.from - ev.to).toFixed(3) : null };
    if (type === 'hurt' || type === 'death') {
      // 直前(0.5秒以内)に、近くで腕を振った人
      let by = null, bt = -1;
      for (const a of evs) if (a.type === 'attack' && a.key !== key && a.tick <= i + 1 && a.tick >= i - 10 && a.tick > bt) {
        const ae = byKey.get(a.key);
        const pa = P(ae, a.tick), pm = P(me, Math.min(n - 1, a.tick));
        if (Math.hypot(pa[0] - pm[0], pa[2] - pm[2]) < 6) { by = a.key; bt = a.tick; }
      }
      o.by = by;
    }
    evs.push(o);
  }
  // 同じ人の同じ出来事が同じコマに重なったら1つに
  const seen = new Set();
  return evs.filter(e => { const k = e.type + e.key + e.tick; if (seen.has(k)) return false; seen.add(k); return true; })
            .sort((a, b) => a.tick - b.tick);
}

function _scriptCameras() {
  const o = [worldOriginX, worldOriginY, worldOriginZ];
  return sceneCameras.map(c => ({
    id: c.id, name: scCamName(c), start: c.startTick, end: c.endTick, layer: c.layer, fov: c.fov,
    display: c.display ? { ...c.display } : null,
    keys: c.keys.map(k => {
      const kk = { time: k.time, pos: [k.pos[0] + o[0], k.pos[1] + o[1], k.pos[2] + o[2]], yaw: _r2d(k.yaw), pitch: _r2d(k.pitch) };
      if (k.curve) kk.curve = k.curve.slice();
      return kk;
    }),
  }));
}

function currentScriptView() {
  return { pos: [fcPos[0] + worldOriginX, fcPos[1] + worldOriginY, fcPos[2] + worldOriginZ], yaw: _r2d(fcYaw), pitch: _r2d(fcPitch), fov: fcFovDeg };
}
function currentFocusId() {
  const focus = document.getElementById('entitySelect');
  return focus ? focus.value : null;
}

function buildScriptSnapshot(mode, extra) {
  extra = extra || {};
  const base = {
    tps: scTps(), totalTicks: scMaxTick() + 1, playhead: curTick,
    start: extra.start != null ? extra.start : curTick,
    focusId: extra.focusId != null ? extra.focusId : currentFocusId(),
    selectedCameraId: (typeof selectedCameraId !== 'undefined') ? selectedCameraId : null,
    view: extra.view || currentScriptView(),
  };
  if (mode === 'describe') return { ...base, entities: [], cameras: [], texts: [], blocks: new Int32Array(0) };
  return {
    ...base,
    anim: extra.anim ? _scriptAnimEntities(extra.start != null ? extra.start : curTick) : null,
    entities: _scriptEntities(),
    cameras: _scriptCameras().filter(c => extra.excludeGroup == null || !(scGetCamera(c.id) && scGetCamera(c.id).gen && scGetCamera(c.id).gen.group === extra.excludeGroup)),
    texts: (typeof textBlocks !== 'undefined' ? textBlocks : []).map(t => ({ id: t.id, content: t.content, start: t.startTick, end: t.endTick })),
    blocks: _scriptWorldBlocks(),
  };
}


// ============================================================
// 受け取った操作をチェックして反映する(取り消し1回ぶん)
// ============================================================

function _num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function _vec3(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const a = [Number(v[0]), Number(v[1]), Number(v[2])];
  return a.every(Number.isFinite) ? a : null;
}

// スクリプトのキー(ワールド座標・度)→ エディタのキー(ローカル座標・ラジアン)
function _scriptKeyToEditor(k, i) {
  if (!k || typeof k !== 'object') throw new Error(`キー${i + 1}が正しくありません`);
  const pos = _vec3(k.pos);
  if (!pos) throw new Error(`キー${i + 1}の pos は [x, y, z] の数で指定してください`);
  let yaw = _num(k.yaw, null), pitch = _num(k.pitch, null);
  const target = _vec3(k.lookAt);
  if (target) {
    const d = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
    yaw = Math.atan2(d[0], d[2]) * 180 / Math.PI;
    pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI;
  }
  if (yaw == null) yaw = 0;
  if (pitch == null) pitch = 0;
  const out = {
    time: Math.max(0, _num(k.time, 0)),
    pos: [pos[0] - worldOriginX, pos[1] - worldOriginY, pos[2] - worldOriginZ],
    yaw: yaw * Math.PI / 180,
    pitch: Math.max(-88, Math.min(88, pitch)) * Math.PI / 180,
  };
  let c = k.curve;
  if (typeof c === 'string') c = CURVE_PRESETS[c] ? CURVE_PRESETS[c].c : null;
  if (Array.isArray(c) && c.length === 4 && c.every(v => Number.isFinite(Number(v)))) {
    const cc = c.map(Number);
    cc[0] = Math.max(0, Math.min(1, cc[0])); cc[2] = Math.max(0, Math.min(1, cc[2]));
    if (scCurvePresetId(cc) !== 'linear') out.curve = cc;
  }
  return out;
}

function _scriptKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('keys に1つ以上のキーを入れてください');
  if (keys.length > SCRIPT_MAX_KEYS) throw new Error(`キーが多すぎます(${SCRIPT_MAX_KEYS}個まで)`);
  const out = keys.map(_scriptKeyToEditor);
  out.sort((a, b) => a.time - b.time);
  return out;
}

function _scriptDisplay(d) {
  if (d == null) return null;
  if (typeof d !== 'object') return null;
  return scClampDisplay({ x: _num(d.x, 0), y: _num(d.y, 0), w: _num(d.w, 1) });
}

function _fitCamToKeys(cam) {
  const tps = scTps();
  const last = cam.keys[cam.keys.length - 1].time;
  const maxTick = scMaxTick();
  const need = Math.ceil(cam.startTick + last * tps) + (cam.keys.length > 1 ? 0 : 1);
  if (need > cam.endTick) cam.endTick = maxTick > 0 ? Math.min(maxTick, need) : need;
  if (cam.endTick <= cam.startTick) cam.endTick = cam.startTick + 1;
}

// 戻り値: { summary, error }
// opts:
//   history: false … 取り消しの履歴に積まない(呼ぶ側が beginEdit/commitEdit で管理する時)
//   gen: { src, name, code, params, anchor, group } … 作ったカメラに「どのスクリプトの、どの設定で
//        作ったか」を覚えさせる(右パネルで設定を変えると作り直せるようにするため)
//   replaceGroup: このグループのカメラを消してから反映する(作り直し)
// 戻り値: { summary, toasts, created:[カメラ], error }
let _nextGenGroup = 1;
function applyScriptOps(ops, opts) {
  opts = opts || {};
  if (ops.length > SCRIPT_MAX_OPS) return { error: '操作が多すぎます' };
  if (!ops.length && opts.replaceGroup == null) return { summary: '変更はありませんでした', created: [] };
  if (opts.history !== false) commitEdit();
  const before = _editorStateJson();
  const created = [];
  // 作り直し: 前に作ったカメラを消す(層・表示位置は引き継ぐ)
  let inheritLayer = null, inheritDisplay = null, reuseIds = [];
  if (opts.replaceGroup != null) {
    const old = sceneCameras.filter(c => c.gen && c.gen.group === opts.replaceGroup).sort((a, b) => a.startTick - b.startTick);
    reuseIds = old.map(c => c.id); // 同じIDを使い直す(選択・右パネルがそのまま続くように)
    if (old.length) {
      inheritLayer = Math.min(...old.map(c => c.layer));
      inheritDisplay = old[0].display ? { ...old[0].display } : null;
    }
    sceneCameras = sceneCameras.filter(c => !(c.gen && c.gen.group === opts.replaceGroup));
  }
  if (opts.gen && opts.gen.group == null) {
    for (const c of sceneCameras) if (c.gen && c.gen.group >= _nextGenGroup) _nextGenGroup = c.gen.group + 1;
  }
  const group = opts.gen ? (opts.gen.group != null ? opts.gen.group : _nextGenGroup++) : null;
  const tps = scTps();
  const maxTick = scMaxTick();
  const idMap = new Map(); // スクリプト内のID → カメラ
  const count = { add: 0, update: 0, remove: 0, text: 0 };
  const toasts = [];
  let selectId = null, seekTick = null;
  const findCam = (id) => {
    if (idMap.has(String(id))) return idMap.get(String(id));
    return sceneCameras.find(c => String(c.id) === String(id)) || null;
  };
  try {
    ops.forEach((op, i) => {
      const where = `${i + 1}番目の操作(${op && op.op})`;
      try {
        if (!op || typeof op !== 'object') throw new Error('形が正しくありません');
        if (op.op === 'addCamera') {
          const s = op.spec || {};
          const keys = _scriptKeys(s.keys);
          const start = Math.max(0, Math.min(Math.max(0, maxTick - 1), Math.round(_num(s.start, curTick))));
          let end = s.end != null ? Math.round(_num(s.end, start + tps * DEFAULT_BLOCK_SECONDS))
            : Math.round(start + tps * Math.max(0.05, _num(s.seconds, Math.max(DEFAULT_BLOCK_SECONDS, keys[keys.length - 1].time))));
          if (maxTick > 0) end = Math.min(end, maxTick);
          const cam = scCreateCamera(keys[0], Math.max(10, Math.min(120, _num(s.fov, fcFovDeg))), start, 1);
          cam.keys = keys;
          cam.endTick = Math.max(start + 1, end);
          if (s.name != null) cam.name = String(s.name).slice(0, 60);
          cam.display = _scriptDisplay(s.display);
          cam.layer = scFindFreeLayerFrom(Math.max(0, Math.round(_num(s.layer, 0))), cam.startTick, cam.endTick, cam.id);
          if (reuseIds.length) cam.id = reuseIds.shift();
          if (s.layer === undefined && inheritLayer != null) cam.layer = scFindFreeLayerFrom(inheritLayer, cam.startTick, cam.endTick, cam.id);
          if (s.display === undefined && inheritDisplay && !created.length) cam.display = inheritDisplay;
          if (opts.gen) {
            cam.gen = { src: opts.gen.src || null, name: opts.gen.name || '', code: String(opts.gen.code || ''),
                        params: { ...(opts.gen.params || {}) }, anchor: Math.round(_num(opts.gen.anchor, cam.startTick)), group,
                        view: opts.gen.view || null, focusId: opts.gen.focusId != null ? String(opts.gen.focusId) : null };
          }
          created.push(cam);
          idMap.set(String(op.id), cam);
          count.add++;
        } else if (op.op === 'updateCamera') {
          const cam = findCam(op.id);
          if (!cam) throw new Error(`カメラ ${op.id} が見つかりません`);
          const p = op.patch || {};
          if (p.keys !== undefined) { cam.keys = _scriptKeys(p.keys); }
          if (p.start !== undefined) {
            const ns = Math.max(0, Math.round(_num(p.start, cam.startTick)));
            const len = cam.endTick - cam.startTick;
            cam.startTick = ns;
            if (p.end === undefined) cam.endTick = ns + len;
          }
          if (p.end !== undefined) cam.endTick = Math.max(cam.startTick + 1, Math.round(_num(p.end, cam.endTick)));
          if (maxTick > 0) cam.endTick = Math.min(cam.endTick, maxTick);
          if (p.name !== undefined) cam.name = String(p.name).slice(0, 60);
          if (p.fov !== undefined) cam.fov = Math.max(10, Math.min(120, _num(p.fov, cam.fov)));
          if (p.display !== undefined) cam.display = _scriptDisplay(p.display);
          if (p.keys !== undefined && p.end === undefined) _fitCamToKeys(cam);
          if (p.layer !== undefined) cam.layer = Math.max(0, Math.round(_num(p.layer, cam.layer)));
          cam.layer = scFindFreeLayerFrom(cam.layer, cam.startTick, cam.endTick, cam.id);
          count.update++;
        } else if (op.op === 'removeCamera') {
          const cam = findCam(op.id);
          if (!cam) throw new Error(`カメラ ${op.id} が見つかりません`);
          sceneCameras = sceneCameras.filter(c => c !== cam);
          count.remove++;
        } else if (op.op === 'addText') {
          const s = op.spec || {};
          const props = {};
          for (const k of TEXT_STYLE_KEYS) if (s[k] !== undefined) props[k] = s[k];
          props.content = s.content != null ? String(s.content).slice(0, 500) : 'テキスト';
          if (s.x !== undefined) props.x = Math.max(0, Math.min(1, _num(s.x, 0.5)));
          if (s.y !== undefined) props.y = Math.max(0, Math.min(1, _num(s.y, 0.82)));
          if (s.seconds !== undefined) props.seconds = Math.max(0.05, _num(s.seconds, 2));
          const start = Math.round(_num(s.start, curTick));
          const b = ctAddTextBlock(start, props);
          if (s.end !== undefined) b.endTick = Math.max(b.startTick + 1, Math.min(maxTick || Infinity, Math.round(_num(s.end, b.endTick))));
          count.text++;
        } else if (op.op === 'select') {
          selectId = op.id;
        } else if (op.op === 'seek') {
          seekTick = _num(op.tick, null);
        } else if (op.op === 'toast') {
          toasts.push(String(op.text).slice(0, 200));
        } else {
          throw new Error('知らない操作です');
        }
      } catch (e) {
        throw new Error(`${where}: ${e.message}`);
      }
    });
  } catch (e) {
    _restoreEditorState(before); // 途中で失敗したら、何も反映しない
    return { error: e.message };
  }
  scCompactLayers();
  for (const c of created) if (c.gen) c.gen.sig = scGenSignature(c);
  // 取り消し1回ぶんとして履歴に積む(実行前の状態を保存)
  if (opts.history !== false && _editorStateJson() !== before) _pushHistory(before);
  if (selectId != null) {
    const c = findCam(selectId);
    if (c) { selectedCameraId = c.id; selectedKeyIndex = 0; selectedKeyExplicit = false; if (typeof selectedTextBlockId !== 'undefined') selectedTextBlockId = null; }
  }
  if (opts.selectFirst && selectId == null && created.length && !(opts.replaceGroup != null && scGetSelected())) {
    selectedCameraId = created[0].id; selectedKeyIndex = 0; selectedKeyExplicit = false;
    if (typeof selectedTextBlockId !== 'undefined') selectedTextBlockId = null;
  }
  if (!scGetSelected()) { selectedCameraId = null; selectedKeyIndex = null; selectedKeyExplicit = false; }
  if (typeof pilot !== 'undefined' && pilot && !scGetCamera(pilot.camId)) exitPilot(true);
  if (seekTick != null) seekTo(seekTick);
  if (typeof previewIsMain !== 'undefined' && sceneCameras.length === 0) previewIsMain = false;
  editorChanged();
  const parts = [];
  if (count.add) parts.push(`カメラを${count.add}台追加`);
  if (count.update) parts.push(`${count.update}台を変更`);
  if (count.remove) parts.push(`${count.remove}台を削除`);
  if (count.text) parts.push(`テキストを${count.text}個追加`);
  return { summary: parts.length ? parts.join('・') + 'しました' : '変更はありませんでした', toasts, created, group };
}

// スクリプトで作った直後のキーの「指紋」。手で直されたかどうかを見分けるのに使う
function scGenSignature(cam) {
  const str = JSON.stringify([cam.startTick, cam.endTick, cam.keys]);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function scGenEdited(cam) { return !!(cam.gen && cam.gen.sig && cam.gen.sig !== scGenSignature(cam)); }


// 設定項目の読み取り(api.params の所まで動かす)は、同じコードなら結果を使い回す
const _describeCache = new Map();
async function describeScript(code) {
  if (_describeCache.has(code)) return _describeCache.get(code);
  const r = await runScriptSandboxed(code, 'describe', {});
  const out = { ok: r.type === 'done', defs: r.defs || {}, info: r.info || null, message: r.message, line: r.line };
  if (_describeCache.size > 200) _describeCache.clear();
  _describeCache.set(code, out);
  return out;
}
function describeScriptCached(code) { return _describeCache.get(code) || null; }
