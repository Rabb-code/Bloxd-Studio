// autoanim.js
// ============================================================
// ⚡自動アニメーション。リプレイの記録だけから、人の手足の動きを自動で作る。
//
// 使う記録(エンティティごと・毎tick):
//   位置 → 歩く・走る(進んだ距離に合わせて足を振るので、足がすべらない)、
//          ジャンプ(足の下にブロックがあるか)、着地の沈み込み、瞬間移動(復活など)
//   向き・cameraPitch → 頭の向き。体は少し遅れて付いてくる
//   armSwinging → 攻撃の振り(持っている物で振り方を変える)
//   heldItemName → 持ち方。弓・クロスボウは「|meta|chargingN」「Charged」で引き具合
// 使う出来事(events。python側の build_2d_map.py が渡す):
//   lifeformHealth → ダメージでのけぞる / playerKilled → 倒れる(復活で元に戻る)
//   bullet → 銃を撃った反動 / camera(録画した本人) → 弓を引いている
//
// 設定は3つだけ(スタイル・動きの大きさ・なめらかさ)+オン/オフ。
// 手で付けたポーズのブロックがある所は、キーのある関節だけ手付けが勝つ(poses.js)。
//
// 計算の流れ:
//   _aaAnalyze(eid): 記録を1tickずつの表にして、速さ・空中か・体の向き・出来事を先に計算しておく
//                    (設定・記録が変わった時だけやり直す)
//   autoAnimPose(key, frameIndex): その時刻の手足の角度を、表から式で出す(毎フレーム)
// ============================================================

const LS_AUTOANIM = 'bloxdEditor.autoAnim.v1';
const AUTOANIM_STYLES = {
  normal: { label: 'ふつう', amp: 1.0, swingSec: 0.34, windup: 1.0, follow: 1.0, bob: 1.0, land: 1.0, hurt: 1.0 },
  anime:  { label: 'アニメ風', amp: 1.3, swingSec: 0.28, windup: 1.45, follow: 1.45, bob: 1.6, land: 1.8, hurt: 1.6 },
  real:   { label: 'リアル', amp: 0.78, swingSec: 0.4, windup: 0.75, follow: 0.65, bob: 0.6, land: 0.7, hurt: 0.7 },
};

let autoAnim = (() => {
  const d = { enabled: true, style: 'normal', amount: 1, smooth: 0.5 };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(LS_AUTOANIM) || '{}')) }; } catch (e) { return d; }
})();
let _aaVersion = 1;

function setAutoAnim(patch) {
  Object.assign(autoAnim, patch);
  _aaVersion++;
  try { localStorage.setItem(LS_AUTOANIM, JSON.stringify(autoAnim)); } catch (e) { /* 保存できなくても続ける */ }
}

// 持っている物の種類(振り方・構え方を決める)
function _aaItemKind(name) {
  if (!name) return 'none';
  const n = String(name).split('|')[0].toLowerCase();
  if (/crossbow/.test(n)) return 'crossbow';
  if (/bow/.test(n)) return 'bow';
  if (/mp40|ak-?47|rifle|pistol|gun|shotgun|smg|sniper|deagle|uzi|m4|minigun|revolver|glock/.test(n)) return 'gun';
  if (/spear|trident|lance|halberd/.test(n)) return 'spear';
  if (/mace|hammer|club/.test(n)) return 'mace';
  if (/sword|katana|blade|knife|dagger|saber|scythe|axe/.test(n)) return 'sword';
  if (/helmet|chestplate|leggings|boots/.test(n)) return 'armour';
  return 'item';
}
// 弓・クロスボウの引き具合(0=引いていない 1〜4=引いている途中 5=装填済み)
function _aaChargeStage(name) {
  const s = String(name || '');
  const m = /\|meta\|charging(\d)/.exec(s);
  if (m) return Math.min(4, +m[1]);
  if (/charged/i.test(s)) return 5;
  return 0;
}

// エンティティの型(poses.js の entityRigType から呼ばれる): 矢などは「飛ぶ物」
function autoAnimRigTypeForName(name) {
  if (!name) return null;
  if (/arrow|bolt|projectile|snowball|egg|pearl|fireball|bullet|trident_thrown/i.test(name)) return 'projectile';
  if (/^item$|dropped|item_entity/i.test(name)) return 'item';
  return null;
}


// ============================================================
// 記録の下ごしらえ(エンティティごとに1回)
// ============================================================

const _aaCache = new Map();

function _aaEventsFor(eid) {
  const evs = (allTimelines && allTimelines.events) || [];
  const out = { hurts: [], deaths: [], respawns: [], shots: [], charging: [] };
  for (const e of evs) {
    if (e.type === 'lifeformHealth' && e.entityId === eid && e.from != null && e.to != null) {
      if (e.to < e.from - 1e-6 && e.to > 0.001) out.hurts.push(e.tick);
      if (e.from <= 0.001 && e.to > 0.001) out.respawns.push(e.tick);
      if (e.to <= 0.001 && e.from > 0.001) out.deaths.push(e.tick);
    } else if (e.type === 'playerKilled' && e.dead === eid) {
      out.deaths.push(e.tick);
    } else if (e.type === 'bullet' && e.entityId === eid) {
      out.shots.push(e.tick);
    } else if (e.type === 'camera' && e.entityId === eid) {
      out.charging.push({ tick: e.tick, on: !!(e.charging || e.aiming) });
    }
  }
  out.deaths = [...new Set(out.deaths)].sort((a, b) => a - b);
  return out;
}

function _aaAnalyze(eid) {
  const ent = allTimelines && allTimelines.entities[eid];
  if (!ent || !ent.frames.length) return null;
  const evCount = (allTimelines.events || []).length;
  const faces = (typeof fcMeshFaces !== 'undefined') ? fcMeshFaces.ver : 0;
  const sig = ent.frames.length + '|' + evCount + '|' + faces + '|' + _aaVersion;
  const hit = _aaCache.get(eid);
  if (hit && hit.sig === sig) return hit;

  const tps = scTps();
  const fr = ent.frames;
  const t0 = fr[0].tick, N = fr[fr.length - 1].tick - t0 + 1;
  const A = (n) => new Float32Array(n);
  const x = A(N), y = A(N), z = A(N), yaw = A(N), pitch = A(N), jump = A(N), swingOn = new Uint8Array(N);
  const item = new Array(N), stage = new Uint8Array(N);
  // 1tickずつの表にする(記録の無いtickは、その前の値)
  let fi = 0, prevYaw = null, unwrap = 0;
  for (let i = 0; i < N; i++) {
    while (fi + 1 < fr.length && fr[fi + 1].tick <= t0 + i) fi++;
    const f = fr[fi];
    const p = f.position || [0, 0, 0];
    x[i] = p[0] - worldOriginX; y[i] = p[1] - worldOriginY; z[i] = p[2] - worldOriginZ;
    let yw = (f.rotation && f.rotation.length > 1) ? f.rotation[1] : 0;
    if (prevYaw != null) {
      let d = yw + unwrap - prevYaw;
      while (d > Math.PI) { unwrap -= Math.PI * 2; d -= Math.PI * 2; }
      while (d < -Math.PI) { unwrap += Math.PI * 2; d += Math.PI * 2; }
    }
    yaw[i] = yw + unwrap; prevYaw = yaw[i];
    pitch[i] = +f.cameraPitch || 0;
    jump[i] = f.jumping ? 1 : 0;
    swingOn[i] = f.armSwinging ? 1 : 0;
    item[i] = f.heldItemName || null;
    stage[i] = _aaChargeStage(item[i]);
  }
  // 瞬間移動(1tickで3ブロック以上): 速さの計算に使わない
  const tele = new Uint8Array(N);
  for (let i = 1; i < N; i++) if (Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1], z[i] - z[i - 1]) > 3) tele[i] = 1;
  // 速さ(前後2tickの差)。前・横の成分は、体の向き基準
  const vf = A(N), vs = A(N), vy = A(N), hs = A(N);
  for (let i = 0; i < N; i++) {
    let a = Math.max(0, i - 2), b = Math.min(N - 1, i + 2);
    for (let k = a + 1; k <= i; k++) if (tele[k]) a = k;
    for (let k = i + 1; k <= b; k++) if (tele[k]) { b = k - 1; break; }
    if (b <= a) continue;
    const dt = (b - a) / tps;
    const dx = (x[b] - x[a]) / dt, dz = (z[b] - z[a]) / dt;
    vy[i] = (y[b] - y[a]) / dt;
    const sy = Math.sin(yaw[i]), cy = Math.cos(yaw[i]);
    vf[i] = dx * sy + dz * cy;          // 前向きの速さ
    vs[i] = dx * cy - dz * sy;          // 横向き(左が+)
    hs[i] = Math.hypot(dx, dz);
  }
  // なめらかにする(設定の「なめらかさ」で幅が変わる)
  const sm = autoAnim.smooth;
  const ema = (src, tau) => {
    const out = A(N), k = 1 - Math.exp(-1 / (tps * Math.max(0.01, tau)));
    let v = src[0];
    for (let i = 0; i < N; i++) { if (tele[i]) v = src[i]; v += (src[i] - v) * k; out[i] = v; }
    // 逆向きにもかけて、遅れを消す
    let w = out[N - 1];
    for (let i = N - 1; i >= 0; i--) { w += (out[i] - w) * k; out[i] = w; if (tele[i]) w = out[i]; }
    return out;
  };
  const hsS = ema(hs, 0.04 + 0.12 * sm), vfS = ema(vf, 0.04 + 0.12 * sm), vsS = ema(vs, 0.04 + 0.12 * sm);
  // 空中か(足の下にブロックが無い、またはジャンプ中)
  const airRaw = A(N);
  for (let i = 0; i < N; i++) {
    const tv = t0 + i;
    const g = (typeof pfIsSolidLocal === 'function')
      ? (pfIsSolidLocal([x[i], y[i] - 0.08, z[i]], tv) || pfIsSolidLocal([x[i] + 0.25, y[i] - 0.08, z[i]], tv) ||
         pfIsSolidLocal([x[i] - 0.25, y[i] - 0.08, z[i]], tv) || pfIsSolidLocal([x[i], y[i] - 0.08, z[i] + 0.25], tv) ||
         pfIsSolidLocal([x[i], y[i] - 0.08, z[i] - 0.25], tv))
      : true;
    const movingY = Math.abs(vy[i]) > 1.2;
    airRaw[i] = (!g && (movingY || jump[i])) || (jump[i] && vy[i] > 0.5) ? 1 : 0;
  }
  const air = ema(airRaw, 0.03 + 0.06 * sm);
  // 着地(空中に0.12秒以上いた後に地面に付いた瞬間)
  const lands = [];
  let airStart = -1;
  for (let i = 1; i < N; i++) {
    if (airRaw[i] && !airRaw[i - 1]) airStart = i;
    if (!airRaw[i] && airRaw[i - 1] && airStart >= 0 && (i - airStart) / tps > 0.12) lands.push({ tick: t0 + i, fall: Math.max(0, -vy[i - 1]) });
  }
  // 歩いた距離(前向きは+、後ろ向きは-)。足の振りの位相に使う
  const dist = A(N);
  for (let i = 1; i < N; i++) {
    const step = tele[i] ? 0 : Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
    const dir = vfS[i] < -0.3 && Math.abs(vfS[i]) > Math.abs(vsS[i]) * 0.5 ? -1 : 1;
    dist[i] = dist[i - 1] + (airRaw[i] ? step * 0.3 : step) * dir;
  }
  // 体の向きは、頭(見ている方向)に少し遅れて付いてくる
  const bodyYaw = ema(yaw, 0.08 + 0.3 * sm);
  // 腕を振った瞬間(false→true)
  const swings = [];
  for (let i = 0; i < N; i++) if (swingOn[i] && (i === 0 || !swingOn[i - 1])) swings.push(t0 + i);
  const ev = _aaEventsFor(eid);
  // 録画した本人は、弓を引いている時の情報がカメラにもある
  const chargeCam = new Uint8Array(N);
  if (ev.charging.length) {
    let on = false, k = 0;
    for (let i = 0; i < N; i++) {
      while (k < ev.charging.length && ev.charging[k].tick <= t0 + i) { on = ev.charging[k].on; k++; }
      chargeCam[i] = on ? 1 : 0;
    }
  }
  const res = { sig, t0, N, x, y, z, yaw, pitch, hs: hsS, vf: vfS, vs: vsS, vy, air, dist, bodyYaw, item, stage, chargeCam, tele,
    swings, lands, ...ev };
  _aaCache.set(eid, res);
  return res;
}


// ============================================================
// 形の計算
// ============================================================

function _aaClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function _aaSmoothstep(u) { u = _aaClamp(u, 0, 1); return u * u * (3 - 2 * u); }
// 出来事の後の強さ: すぐ上がって、ゆっくり戻る
function _aaEnv(dt, attack, decay) {
  if (dt < 0) return 0;
  if (dt < attack) return dt / attack;
  return Math.exp(-(dt - attack) / decay);
}
// 直前(maxSec以内)の出来事のtick
function _aaLast(list, tick, maxTicks) {
  let best = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const v = typeof list[i] === 'object' ? list[i].tick : list[i];
    if (v <= tick) { if (tick - v <= maxTicks) best = list[i]; break; }
  }
  return best;
}
// 直前の出来事のうち、一番強く効いている物の強さ(続けて当たった時に、最初の分が消えないように)
function _aaEnvMax(list, tick, maxTicks, fn) {
  let best = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const v = typeof list[i] === 'object' ? list[i].tick : list[i];
    if (v > tick) continue;
    if (tick - v > maxTicks) break;
    best = Math.max(best, fn(list[i], (tick - v) / scTps()));
  }
  return best;
}

// キーの並び [[u, value], …] を、なめらかにつないだ値
function _aaCurve(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (u <= b[0]) return a[1] + (b[1] - a[1]) * _aaSmoothstep((u - a[0]) / ((b[0] - a[0]) || 1));
  }
  return keys[keys.length - 1][1];
}

// 攻撃の振り(u=0〜1)。持っている物ごとに、関節に足す角度 { joint: [x,y,z] } と全体の位置
function _aaSwingOffsets(kind, u, S) {
  const w = S.windup, f = S.follow;
  const o = {};
  if (kind === 'none' || kind === 'item' || kind === 'armour') {
    // パンチ: 後ろに引いてから、まっすぐ前へ
    o.armR = [_aaCurve([[0, 0], [0.18, -25 * w], [0.42, 95], [0.7, 70], [1, 0]], u), 0, _aaCurve([[0, 0], [0.42, -8], [1, 0]], u)];
    o.body = [_aaCurve([[0, 0], [0.42, 6 * f], [1, 0]], u), _aaCurve([[0, 0], [0.18, 18 * w], [0.42, -22 * f], [1, 0]], u), 0];
  } else if (kind === 'spear') {
    // 突き: 引いてから、前へ大きく突き出す
    o.armR = [_aaCurve([[0, 30], [0.2, 50], [0.45, 95], [1, 30]], u), 0, _aaCurve([[0, 0], [0.45, -10], [1, 0]], u)];
    o.armL = [_aaCurve([[0, 20], [0.45, 60], [1, 20]], u), 0, 0];
    o.body = [_aaCurve([[0, 0], [0.2, -6 * w], [0.45, 14 * f], [1, 0]], u), _aaCurve([[0, 0], [0.2, 20 * w], [0.45, -15 * f], [1, 0]], u), 0];
    o.rootP = [0, 0, _aaCurve([[0, 0], [0.45, 0.12 * f], [1, 0]], u)];
  } else if (kind === 'mace') {
    // たたきつけ: 頭の上まで振り上げて、下へ
    o.armR = [_aaCurve([[0, 10], [0.3, 170 * Math.min(1.1, w)], [0.52, 25], [0.75, 5], [1, 10]], u), 0, _aaCurve([[0, 0], [0.3, 10], [1, 0]], u)];
    o.body = [_aaCurve([[0, 0], [0.3, -12 * w], [0.55, 22 * f], [1, 0]], u), 0, 0];
    o.rootP = [0, _aaCurve([[0, 0], [0.55, -0.08 * f], [1, 0]], u), 0];
  } else if (kind === 'sword') {
    // 斜めに切る: 右上に振りかぶって、左下へ
    o.armR = [_aaCurve([[0, 15], [0.25, 140 * Math.min(1.1, w)], [0.5, 40], [0.8, 20], [1, 15]], u), _aaCurve([[0, 0], [0.25, -20], [0.5, 30], [1, 0]], u),
              _aaCurve([[0, 0], [0.25, 45 * w], [0.5, -35 * f], [1, 0]], u)];
    o.body = [_aaCurve([[0, 0], [0.5, 8 * f], [1, 0]], u), _aaCurve([[0, 0], [0.25, 22 * w], [0.5, -30 * f], [1, 0]], u), 0];
  } else {
    // その他(道具・弓・銃で殴る): 軽く振る
    o.armR = [_aaCurve([[0, 20], [0.25, 90 * w], [0.5, 20], [1, 20]], u), 0, 0];
    o.body = [0, _aaCurve([[0, 0], [0.25, 10 * w], [0.5, -12 * f], [1, 0]], u), 0];
  }
  return o;
}

function _aaAdd(pose, joint, v, k) {
  const r = pose[joint].r;
  r[0] += v[0] * k; r[1] += v[1] * k; r[2] += v[2] * k;
}

// エンティティの、指定したフレームの自動のポーズ(使えない時は null)
function autoAnimPose(key, frameIndex) {
  if (!autoAnim.enabled || !key || !key.startsWith('player:')) return null;
  const eid = key.slice(7);
  const type = entityRigType(key);
  const tick = _poseTickVal(frameIndex);
  if (type === 'projectile') return _aaProjectilePose(eid, tick);
  if (type !== 'humanoid') return null;
  const a = _aaAnalyze(eid);
  if (!a) return null;
  const i = Math.max(0, Math.min(a.N - 1, Math.round(tick - a.t0)));
  const tps = scTps();
  const S = AUTOANIM_STYLES[autoAnim.style] || AUTOANIM_STYLES.normal;
  const K = autoAnim.amount * S.amp; // 動きの大きさ
  const pose = poseZero('humanoid');
  const time = tick / tps;

  // ---- 倒れている(倒されてから復活まで) ----
  const death = _aaLast(a.deaths, tick, 1e9);
  if (death != null) {
    // 復活: HPが0から戻った時、または倒れた後の瞬間移動
    let resp = a.respawns.find(r => r > death);
    if (resp == null) for (let k = Math.max(0, death - a.t0 + 2); k < a.N; k++) if (a.tele[k]) { resp = k + a.t0; break; }
    const alive = resp != null && tick >= resp;
    if (!alive) {
      const dt = (tick - death) / tps;
      const u = _aaClamp(dt / 0.55, 0, 1);
      const fall = u < 1 ? 1 - Math.pow(1 - u, 3) : 1;
      const bounce = u >= 1 ? Math.exp(-(dt - 0.55) / 0.12) * Math.sin((dt - 0.55) * 30) * 4 * S.follow : 0;
      pose.root.r = [-90 * fall + bounce, 0, 8 * fall];
      pose.root.p = [0, -0.77 * fall, -0.25 * fall];
      pose.armR.r = [30 * fall, 0, 40 * fall]; pose.armL.r = [20 * fall, 0, 55 * fall];
      pose.head.r = [-20 * fall, 15 * fall, 0];
      pose.legR.r = [10 * fall, 0, 8 * fall]; pose.legL.r = [-5 * fall, 0, 14 * fall];

      return pose;
    }
  }

  // ---- 歩く・走る ----
  const hs = a.hs[i];
  const air = _aaClamp(a.air[i], 0, 1);
  const move = _aaSmoothstep(hs / 1.6) * (1 - air * 0.85);
  const run = _aaClamp((hs - 4.2) / 3, 0, 1);
  const stride = 2.4 + 0.7 * run;
  const ph = a.dist[i] / stride * Math.PI * 2;
  const sw = Math.sin(ph), cw = Math.cos(ph);
  const side = hs > 0.3 ? _aaClamp(Math.abs(a.vs[i]) / hs, 0, 1) : 0;
  const sideSign = a.vs[i] >= 0 ? 1 : -1;
  const L = (30 + 18 * run) * (1 - 0.6 * side), Kn = 40 + 45 * run, Ar = (26 + 30 * run) * (1 - 0.3 * side);
  const kM = K * move;
  pose.legR.r[0] += sw * L * kM; pose.legL.r[0] -= sw * L * kM;
  pose.legR.r[2] += sw * 16 * side * sideSign * kM; pose.legL.r[2] -= sw * 16 * side * sideSign * kM;

  pose.armR.r[0] -= sw * Ar * kM; pose.armL.r[0] += sw * Ar * kM;
  pose.armR.r[2] += 4 * kM; pose.armL.r[2] += 4 * kM;

  pose.body.r[0] += (4 + 11 * run) * kM;
  pose.body.r[1] -= sw * (5 + 5 * run) * kM;
  pose.head.r[0] -= (3 + 8 * run) * kM;
  pose.root.p[1] -= Math.abs(sw) * 0.05 * S.bob * (1 + run) * kM;

  // ---- 立っている時の呼吸 ----
  const idle = (1 - move) * (1 - air);
  pose.body.r[0] += Math.sin(time * Math.PI * 2 / 3.4) * 1.6 * idle * K;
  pose.armR.r[2] += (3 + Math.sin(time * Math.PI * 2 / 3.4) * 1.5) * idle * K;
  pose.armL.r[2] += (3 + Math.sin(time * Math.PI * 2 / 3.4) * 1.5) * idle * K;

  // ---- ジャンプ(上がる時は脚をたたむ、落ちる時は手を広げる) ----
  if (air > 0.01) {
    const up = _aaClamp(a.vy[i] / 5, -1, 1);
    const ka = air * K;
    if (up > 0) {
      pose.legR.r[0] += 38 * up * ka;
      pose.legL.r[0] -= 8 * up * ka;
      pose.armR.r[0] += 25 * up * ka; pose.armL.r[0] -= 15 * up * ka; pose.armR.r[2] += 20 * up * ka; pose.armL.r[2] += 20 * up * ka;
    } else {
      const dn = -up;
      pose.legR.r[0] += 12 * dn * ka; pose.legL.r[0] -= 8 * dn * ka;
      pose.armR.r[2] += 45 * dn * ka; pose.armL.r[2] += 45 * dn * ka; pose.armR.r[0] += 10 * dn * ka; pose.armL.r[0] += 10 * dn * ka;
      pose.head.r[0] += 8 * dn * ka;
    }
  }
  // ---- 着地の沈み込み ----
  const landE = _aaEnvMax(a.lands, tick, Math.round(tps * 0.8),
    (l, dt) => _aaEnv(dt, 0.04, 0.1 + 0.1 * autoAnim.smooth) * _aaClamp(0.5 + l.fall / 10, 0.5, 1.5));
  if (landE > 0) {
    const e = landE * S.land * K;
    pose.root.p[1] -= 0.14 * e;

    pose.body.r[0] += 14 * e; pose.armR.r[2] += 12 * e; pose.armL.r[2] += 12 * e;
  }

  // ---- 持ち方(弓・クロスボウ・銃・手に持った物) ----
  const kind = _aaItemKind(a.item[i]);
  const stage = a.stage[i] || (a.chargeCam[i] && (kind === 'bow' || kind === 'crossbow') ? 3 : 0);
  if ((kind === 'bow' || kind === 'crossbow') && stage > 0) {
    // 弓を引く: 左手で弓を前に、右手で弦を引く(段階が進むほど引く)
    const pull = stage === 5 ? 0.6 : _aaClamp(stage / 4, 0.3, 1);
    pose.armL.r = [88, -8, -4];
    pose.armR.r = [86, 20 * pull, -5];
    pose.body.r[1] -= 18 * pull; pose.head.r[1] += 18 * pull;
  } else if (kind === 'gun') {
    // 銃を構える: 両手を前に
    pose.armR.r = [82, 0, -4];
    pose.armL.r = [72, 25, -18];
    pose.body.r[1] -= 8; pose.head.r[1] += 8;
    const shotE = _aaEnvMax(a.shots, tick, Math.round(tps * 0.3), (s0, dt) => _aaEnv(dt, 0.015, 0.06));
    if (shotE > 0) {
      const e = shotE * K;
      pose.armR.r[0] += 12 * e; pose.armL.r[0] += 9 * e; pose.body.r[0] -= 4 * e; pose.head.r[0] -= 3 * e;
    }
  } else if (kind !== 'none' && kind !== 'armour') {
    pose.armR.r[0] += 16 * (1 - 0.5 * move);
  }

  // ---- 攻撃の振り ----
  const swingTicks = Math.round(tps * S.swingSec);
  const sw0 = _aaLast(a.swings, tick, swingTicks);
  if (sw0 != null && !(stage > 0 && stage < 5)) {
    const u = (tick - sw0) / swingTicks;
    const off = _aaSwingOffsets(kind, u, S);
    // 振る腕は、歩きの振りを弱める
    const damp = _aaSmoothstep(1 - Math.abs(u - 0.4) * 1.6);
    pose.armR.r[0] *= 1 - 0.8 * damp; pose.armR.r[2] *= 1 - 0.8 * damp;
    for (const j in off) {
      if (j === 'rootP') { for (let c = 0; c < 3; c++) pose.root.p[c] += off.rootP[c] * K; continue; }
      _aaAdd(pose, j, off[j], K);
    }
  }

  // ---- ダメージでのけぞる ----
  const hurtE = _aaEnvMax(a.hurts, tick, Math.round(tps * 0.7), (h, dt) => _aaEnv(dt, 0.03, 0.12 + 0.12 * autoAnim.smooth));
  if (hurtE > 0) {
    const e = hurtE * S.hurt * K;
    pose.body.r[0] -= 20 * e; pose.head.r[0] -= 14 * e; pose.root.r[0] -= 8 * e;
    pose.armR.r[2] += 22 * e; pose.armL.r[2] += 22 * e; pose.armR.r[0] += 10 * e; pose.armL.r[0] += 10 * e;

    pose.root.p[2] -= 0.08 * e; pose.root.p[1] += (S.hurt > 1.2 ? 0.08 : 0) * e;
  }

  // ---- 頭と体の向き ----
  const P = _aaClamp(a.pitch[i] / _D2R, -80, 80);
  pose.head.r[0] += P * 0.78;
  pose.body.r[0] += P * 0.14 * (1 - move);
  const lag = _aaClamp((a.bodyYaw[i] - a.yaw[i]) / _D2R, -55, 55) * (1 - 0.6 * move);
  pose.root.r[1] += lag;
  pose.head.r[1] -= lag;

  // ---- ステップ42: 公式のポーズ(項目12 pose: sitting / sleeping / riding / driving / gliding / zombie) ----
  _aaApplyOfficialPose(eid, tick, pose, P);

  return pose;
}

// 公式(chunk 8 のプレイヤーの動き)と同じ形にする。公式の角度(ラジアン)→ エディタの関節(度)
//   腕・脚は「前へ」がエディタでは +(公式は -)、体は「前へかたむく」がどちらも +、頭の上下はどちらも +
//   sleeping: 頭 0・体 -π/2(後ろへ = あお向け)・脚 -π/2(前へ)・腕 0 → 腰の高さで横になる
//   sitting / riding: 脚 -1.5(前へ)、腕 0
//   driving: 脚 -1.5、頭 π/20、腕は (0, ±π/2, ∓π/4) = 前へ 45 度くらい(ハンドル)
//   gliding: 体と脚 = 見ている上下 + 1.5(体は前へ、脚は後ろへ = うつぶせ)、頭 = -見ている上下、腕は (-π/4, ±π/2, 0) = 横へ 45 度
//   zombie: 腕 -1.5(前へ)
const AA_R2D = 180 / Math.PI;
function _aaApplyOfficialPose(eid, tick, pose, pitchDeg) {
  const ent = allTimelines && allTimelines.entities[eid];
  const f = ent && (typeof entityFrameAt === 'function' ? entityFrameAt(ent, tick) : nearestFrameAtOrBefore(ent.frames, tick));
  const kind = f && f.pose;
  if (!kind || kind === 'standing') return;
  const legsFwd = 1.5 * AA_R2D;   // 約 86 度
  const set = (j, r) => { pose[j].r = r.slice(); };
  if (kind === 'sleeping') {
    set('head', [0, 0, 0]); set('body', [-90, 0, 0]);
    set('legR', [90, 0, 0]); set('legL', [90, 0, 0]);
    set('armR', [0, 0, 0]); set('armL', [0, 0, 0]);
    pose.root.r = [0, 0, 0]; pose.root.p = [0, 0, 0];
  } else if (kind === 'sitting' || kind === 'riding') {
    set('legR', [legsFwd, 0, kind === 'riding' ? 8 : 0]); set('legL', [legsFwd, 0, kind === 'riding' ? 8 : 0]);
    set('armR', [0, 0, 0]); set('armL', [0, 0, 0]);
    pose.body.r[0] = 0; pose.root.p = [0, 0, 0];
  } else if (kind === 'driving') {
    set('legR', [legsFwd, 0, 0]); set('legL', [legsFwd, 0, 0]);
    set('armR', [45, 0, 0]); set('armL', [45, 0, 0]);
    pose.head.r[0] = 180 / 20; pose.body.r[0] = 0; pose.root.p = [0, 0, 0];
  } else if (kind === 'gliding') {
    const P = pitchDeg || 0;
    set('body', [legsFwd + P, 0, 0]);
    set('legR', [-(legsFwd + P), 0, 0]); set('legL', [-(legsFwd + P), 0, 0]);
    set('head', [-P, 0, 0]);
    set('armR', [0, 0, 45]); set('armL', [0, 0, 45]);
    pose.root.p = [0, 0, 0];
  } else if (kind === 'zombie') {
    set('armR', [legsFwd, 0, 0]); set('armL', [legsFwd, 0, 0]);
  }
}

// 矢など: 飛んでいる向きに向ける
function _aaProjectilePose(eid, tick) {
  const ent = allTimelines.entities[eid];
  const fr = ent && ent.frames;
  if (!fr || fr.length < 2) return null;
  let k = 0;
  while (k + 1 < fr.length && fr[k + 1].tick <= tick) k++;
  const a = fr[Math.max(0, k - 1)], b = fr[Math.min(fr.length - 1, Math.max(k, 1))];
  if (!a.position || !b.position) return null;
  const d = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-4) return null;
  const base = (b.rotation && b.rotation.length > 1) ? b.rotation[1] : 0;
  const pose = poseZero('projectile');
  pose.root.r = [-Math.asin(d[1] / len) / _D2R, (Math.atan2(d[0], d[2]) - base) / _D2R, 0];
  return pose;
}


// ============================================================
// 設定の画面(タイムラインの「ポーズ」タブの右側)
// ============================================================

function renderAutoAnimControls(bar) {
  const box = _el('div', 'aaBox');
  const toggle = _el('button', 'aaToggle' + (autoAnim.enabled ? ' active' : ''), autoAnim.enabled ? '⚡ 自動アニメ ON' : '⚡ 自動アニメ OFF');
  toggle.type = 'button';
  toggle.title = 'リプレイの記録から、歩く・走る・ジャンプ・攻撃・ダメージ・倒れる動きを自動で付けます(手で付けたポーズが優先)';
  toggle.addEventListener('click', () => { setAutoAnim({ enabled: !autoAnim.enabled }); renderTimelineTabs(); });
  box.appendChild(toggle);
  if (autoAnim.enabled) {
    const sel = document.createElement('select');
    sel.className = 'aaSelect';
    sel.title = 'スタイル';
    for (const [id, s] of Object.entries(AUTOANIM_STYLES)) {
      const o = document.createElement('option'); o.value = id; o.innerText = s.label; sel.appendChild(o);
    }
    sel.value = autoAnim.style;
    sel.addEventListener('change', () => { setAutoAnim({ style: sel.value }); sel.blur(); });
    box.appendChild(sel);
    const range = (label, key, min, max, step, fmt) => {
      const l = _el('label', 'aaRange');
      l.appendChild(_el('span', null, label));
      const r = document.createElement('input');
      r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = autoAnim[key];
      const v = _el('span', 'aaVal', fmt(autoAnim[key]));
      r.addEventListener('input', () => { setAutoAnim({ [key]: parseFloat(r.value) }); v.innerText = fmt(autoAnim[key]); });
      l.appendChild(r); l.appendChild(v);
      box.appendChild(l);
    };
    range('大きさ', 'amount', 0, 2, 0.05, (x) => Math.round(x * 100) + '%');
    range('なめらかさ', 'smooth', 0, 1, 0.05, (x) => Math.round(x * 100) + '%');
  }
  bar.appendChild(box);
}
