// poses.js
// ============================================================
// 🕺ポーズ(エンティティの関節ごとのアニメーション)。
//
// タイムラインは「グローバル」(カメラ・テキスト・パーティクル)と「ポーズ」の
// 2つのタブに分かれる。ポーズのタブでは、エンティティ(プレイヤー・人形)を
// 1体選んで、その1体だけのブロックと、関節ごとのキーの行を編集する。
//
// エンティティの作り(関節)は「型」(RIG_TYPES)として登録してある。
//   humanoid(人型): 関節6個 = 体・頭・右腕・左腕・右脚・左脚(腕・脚は Bloxd と同じ1本。ひじ・ひざは無い)
//   item(アイテム): 関節0個(全体の位置と向きだけ)
//   動物などを足す時は、RIG_TYPES に型を1つ足して、entityRigType() で使い分ける。
// どの型にも「全体(root)」があり、関節の数には数えない。
//
// 関節ごとに、回転 r=[x,y,z](度)と位置のずれ p=[x,y,z](ブロック。親の向きが基準)を持つ。
//   x = 前へ(腕・脚は前へ振る、頭・体は前へ倒す、ひじ・ひざは曲げる 0〜160)
//   y = ひねり(左を向く方が +) / z = 横へ(腕・脚は外へ開く、頭・体は左へ傾く方が +)
//
// ポーズのブロック:
//   { id, kind:'pose', name, target:'player:<eid>'|'puppet:<id>', startTick, endTick,
//     offsetSec, loopLen(0=くり返さない), tracks:{ 関節: [{ time, r, p, curve? }] } }
//   キーは関節ごとに別々。キーの間はカメラと同じ速さのカーブ(curve)でつなぐ。
//   loopLen>0 の時は 0〜loopLen 秒をくり返す。
// 人形(puppets): { id, name, type, base:{pos,yaw} }。自分のブロックがある間だけ出る。
// ============================================================

let poseBlocks = [];
let nextPoseBlockId = 1;
let selectedPoseId = null;
let puppets = [];
let nextPuppetId = 1;

let timelineTab = 'global';     // 'global' | 'pose'
let poseEntity = null;          // ポーズのタブで選んでいるエンティティ('player:1' など)
let poseSelJoint = 'root';      // ギズモを出す関節(最後に選んだ関節)
let poseSelJoints = ['root'];   // 選んでいる関節(Shift+クリックで複数)
let poseSelKey = null;          // 選んでいるキー { joint, index } / { joint:'*', time }(ブロックの行の◆)
let poseSelKeyExplicit = false;
let poseExpandedId = null;      // 関節の行を開いているブロック

const POSE_KEY_SNAP = 0.1;
const POSE_DEFAULT_SECONDS = 3;
const POSE_JOINT_ROW_H = 24, POSE_JOINT_ROW_EXPANDED_H = 96;


// ============================================================
// 型(関節の作り)
// ============================================================

// bones: { joint, label, parent, at(親から見た関節の位置), sign(回し方の符号 [x,y,z]), bend(曲げるだけ) }
// parts: 描く箱 { joint, box(関節から見た中心), size }
const RIG_TYPES = {
  // ステップ31: 関節の位置・部品の大きさを Bloxd 公式の Player_Model に合わせた(official-models.js が公式の形で描く)
  //   TorsoNode(0,0.75,0) → Head(0,0.6875,0)・RightArm(-0.3125,0.5625,0)・LeftArm(0.3125,0.5625,0)、
  //   RightLeg(-0.125,0.75,0)・LeftLeg(0.125,0.75,0)。parts はクリック・くっつく点に使う箱(公式の形を囲む大きさ)
  humanoid: {
    label: '人型', rootPivot: 0.75, rootSign: [1, 1, -1],
    bones: [
      { joint: 'body',   label: '体',     parent: 'root', at: [0, 0.75, 0],        sign: [1, 1, -1] },
      { joint: 'head',   label: '頭',     parent: 'body', at: [0, 0.6875, 0],      sign: [1, 1, -1] },
      { joint: 'armR',   label: '右腕',   parent: 'body', at: [-0.3125, 0.5625, 0], sign: [-1, -1, -1] },
      { joint: 'armL',   label: '左腕',   parent: 'body', at: [0.3125, 0.5625, 0],  sign: [-1, 1, 1] },
      { joint: 'legR',   label: '右脚',   parent: 'root', at: [-0.125, 0.75, 0],    sign: [-1, -1, -1] },
      { joint: 'legL',   label: '左脚',   parent: 'root', at: [0.125, 0.75, 0],     sign: [-1, 1, 1] },
    ],
    parts: [
      { joint: 'body',   box: [0, 0.34375, 0],      size: [0.5, 0.6875, 0.25] },
      { joint: 'head',   box: [0, 0.28125, 0],      size: [0.5625, 0.5625, 0.5625] },
      { joint: 'armR',   box: [-0.0625, -0.289, 0], size: [0.25, 0.828, 0.25] },
      { joint: 'armL',   box: [0.0625, -0.289, 0],  size: [0.25, 0.828, 0.25] },
      { joint: 'legR',   box: [0, -0.375, 0],       size: [0.25, 0.75, 0.25] },
      { joint: 'legL',   box: [0, -0.375, 0],       size: [0.25, 0.75, 0.25] },
    ],
    // 手・足の先(end は upper の関節から見た位置)をつかむと、腕・脚がそちらを向く(ひじ・ひざは無い。Bloxd と同じ1本)
    ik: [
      { id: 'handR', label: '右手', upper: 'armR', end: [-0.0625, -0.703, 0] },
      { id: 'handL', label: '左手', upper: 'armL', end: [0.0625, -0.703, 0] },
      { id: 'footR', label: '右足', upper: 'legR', end: [0, -0.75, 0] },
      { id: 'footL', label: '左足', upper: 'legL', end: [0, -0.75, 0] },
    ],
    // まとめて選ぶボタン
    groups: [
      ['全部', ['body', 'head', 'armR', 'armL', 'legR', 'legL']],
      ['上半身', ['body', 'head', 'armR', 'armL']], ['下半身', ['legR', 'legL']], ['両腕', ['armR', 'armL']],
    ],
  },
  item: {
    label: 'アイテム', rootPivot: 0.25, rootSign: [1, 1, -1],
    bones: [],
    parts: [{ joint: 'root', box: [0, 0.25, 0], size: [0.5, 0.5, 0.5] }],
  },
  // ブロックのエンティティ: 関節0。大きさ(幅・高さ・奥行き)をキーで変えられる(全体の s)
  block: {
    label: 'ブロック', rootPivot: 0.5, rootSign: [1, 1, -1], scalable: true,
    bones: [],
    parts: [{ joint: 'root', box: [0, 0.5, 0], size: [1, 1, 1] }],
  },
  // ステップ39: ワールドコードが置いた物(Mesh|Box・BloxdBlock・Leaderboard・ParticleEmitter)。関節なし。描くのは mesh-entities.js
  mesh: {
    label: 'もの', rootPivot: 0, rootSign: [1, 1, -1],
    bones: [],
    parts: [],
  },
  projectile: {
    label: '飛ぶ物', rootPivot: 0.05, rootSign: [1, 1, -1],
    bones: [],
    parts: [{ joint: 'root', box: [0, 0.05, 0], size: [0.07, 0.07, 0.7] }],
  },
};

// 前の形(ひじ・ひざがあった頃)のキーを捨てる(保存したプロジェクト・自動保存を開いた時)
function poseDropRemovedJoints(blocks) {
  for (const b of blocks || []) {
    if (!b.tracks) continue;
    const ok = rigJoints(entityRigType(b.target));
    for (const j of Object.keys(b.tracks)) if (!ok.includes(j)) delete b.tracks[j];
  }
}
function rigJoints(type) { return ['root', ...RIG_TYPES[type].bones.map(b => b.joint)]; }
function rigJointCount(type) { return RIG_TYPES[type].bones.length; } // 全体(root)は数えない
function rigBone(type, joint) { return RIG_TYPES[type].bones.find(b => b.joint === joint) || null; }
function rigJointLabel(type, joint) {
  if (joint === 'root') return '全体';
  const b = rigBone(type, joint);
  return b ? b.label : joint;
}
function _rigSign(type, joint) { return joint === 'root' ? RIG_TYPES[type].rootSign : rigBone(type, joint).sign; }
function _rigBend(type, joint) { const b = joint === 'root' ? null : rigBone(type, joint); return !!(b && b.bend); }


// ============================================================
// エンティティ(リプレイのプレイヤー・人形)
// ============================================================

// エンティティの型。今はプレイヤーも人形も人型。
// (アイテム・動物などのエンティティが来たら、ここで見分ける)
function entityRigType(key) {
  if (!key) return 'humanoid';
  if (key.startsWith('puppet:')) { const p = puppetGet(+key.slice(7)); return p ? p.type : 'humanoid'; }
  const e = allTimelines && allTimelines.entities[key.slice(7)];
  if (e && e.name && e.name.startsWith('Mesh|') && !e.name.startsWith('Mesh|Person|')) return 'mesh';
  const t = (e && typeof autoAnimRigTypeForName === 'function') ? autoAnimRigTypeForName(e.name) : null;
  return t || 'humanoid';
}

function puppetGet(id) { return puppets.find(p => p.id === id) || null; }

function poseEntityName(key) {
  if (!key) return '';
  if (key.startsWith('puppet:')) { const p = puppetGet(+key.slice(7)); return p ? p.name : '人形'; }
  const eid = key.slice(7);
  const e = allTimelines && allTimelines.entities[eid];
  return e ? (e.displayName || poseMeshShortName(e.name) || e.name || eid) : eid;
}

// ステップ39: 「Mesh|Box|{…}」のような長い名前 → 短い名前(一覧・タイムライン用)
const POSE_MESH_KINDS = { Box: ['📦', '箱'], BloxdBlock: ['🧱', 'ブロック'], Leaderboard: ['📋', 'ランキング板'], ParticleEmitter: ['✨', 'キラキラ'], Person: ['🧑', 'NPC'] };
function poseMeshShortName(name) {
  if (!name || !name.startsWith('Mesh|')) return null;
  const kind = name.split('|')[1] || '';
  let o = {}; try { o = JSON.parse(name.slice(6 + kind.length)) || {}; } catch (e) { /* 読めなくてもよい */ }
  const k = POSE_MESH_KINDS[kind] || ['🔷', kind];
  const extra = o.title || o.blockName || o.texture || (o.textures && o.textures.head) || '';
  return `${kind}(${k[1]}${extra ? ' ' + extra : ''})`;
}
function poseMeshIcon(name) {
  if (!name || !name.startsWith('Mesh|')) return null;
  const k = POSE_MESH_KINDS[name.split('|')[1]];
  return k ? k[0] : '🔷';
}

function poseEntityList() {
  const out = [];
  if (allTimelines && allTimelines.entities) {
    for (const [eid, info] of Object.entries(allTimelines.entities)) {
      const icon = poseMeshIcon(info.name) || ((typeof autoAnimRigTypeForName === 'function' && autoAnimRigTypeForName(info.name) === 'projectile') ? '🏹' : '🧍');
      out.push({ key: 'player:' + eid, name: info.displayName || poseMeshShortName(info.name) || info.name || eid, icon });
    }
  }
  for (const p of puppets) out.push({ key: 'puppet:' + p.id, name: p.name, icon: p.type === 'block' ? '🧱' : '🧸' });
  for (const e of out) { e.type = entityRigType(e.key); e.joints = rigJointCount(e.type); }
  return out;
}

// 人形が出ている範囲(自分のブロックの最初〜最後)
function _puppetSpan(id) {
  let s = Infinity, e = -Infinity;
  for (const b of poseBlocks) if (b.target === 'puppet:' + id) { s = Math.min(s, b.startTick); e = Math.max(e, b.endTick); }
  return s < e ? [s, e] : null;
}

function _poseTickVal(frameIndex) {
  if (timeline && timeline.frames && timeline.frames.length) {
    const f = timeline.frames[Math.max(0, Math.min(timeline.frames.length - 1, Math.round(frameIndex)))];
    if (f) return f.tick;
  }
  return frameIndex;
}

// エンティティの足元の位置(ローカル座標)と向き。今見えていなければ null
function poseEntityBase(key, tick) {
  if (!key) return null;
  if (key.startsWith('puppet:')) {
    const p = puppetGet(+key.slice(7));
    const span = p && _puppetSpan(p.id);
    if (!p || !span || tick < span[0] || tick >= span[1]) return null;
    return { pos: p.base.pos, yaw: p.base.yaw, size: p.size || null };
  }
  const ent = allTimelines && allTimelines.entities[key.slice(7)];
  if (!ent) return null;
  const tv = _poseTickVal(tick);
  const f = entityFrameAt(ent, tv);   // ステップ40: 途中で入った・抜けた人は、いない時は出さない
  if (!f || !f.position) return null;
  let px = f.position[0], py = f.position[1], pz = f.position[2];
  let yaw = (f.rotation && f.rotation.length > 1) ? f.rotation[1] : 0;
  // ステップ55: コマの間(書き出しの 60コマ/秒 など)は、次の記録との間をつなぐ(ワープのように遠い時はつながない)
  const sub = (typeof fcSubTick !== 'undefined') ? fcSubTick : 0;
  if (sub > 0) {
    const g = entityFrameAt(ent, tv + 1);
    if (g && g !== f && g.position) {
      const dx = g.position[0] - px, dy = g.position[1] - py, dz = g.position[2] - pz;
      if (dx * dx + dy * dy + dz * dz < 16) {
        px += dx * sub; py += dy * sub; pz += dz * sub;
        const y2 = (g.rotation && g.rotation.length > 1) ? g.rotation[1] : yaw;
        let dyaw = (y2 - yaw) % (Math.PI * 2);
        if (dyaw > Math.PI) dyaw -= Math.PI * 2; else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
        yaw += dyaw * sub;
      }
    }
  }
  return { pos: [px - worldOriginX, py - worldOriginY, pz - worldOriginZ], yaw };
}


// ============================================================
// ポーズ(関節ごとの値)と、キーの計算
// ============================================================

function poseZero(type) {
  const o = {};
  for (const j of rigJoints(type)) o[j] = { r: [0, 0, 0], p: [0, 0, 0] };
  return o;
}
// 関節の値: r=回転(度) p=位置のずれ s=大きさ(全体だけ。無ければ 1)
function _jClone(v) { const o = { r: v.r.slice(), p: v.p.slice() }; if (v.s) o.s = v.s.slice(); return o; }
function _jLerp(a, b, t) {
  const o = { r: [0, 1, 2].map(i => a.r[i] + (b.r[i] - a.r[i]) * t), p: [0, 1, 2].map(i => a.p[i] + (b.p[i] - a.p[i]) * t) };
  if (a.s || b.s) { const sa = a.s || [1, 1, 1], sb = b.s || [1, 1, 1]; o.s = [0, 1, 2].map(i => sa[i] + (sb[i] - sa[i]) * t); }
  return o;
}

const _POSE_ZERO_J = { r: [0, 0, 0], p: [0, 0, 0] };

// 関節1つぶんのキーの列から、s秒の値
function _trackEval(track, s) {
  if (!track || !track.length) return _jClone(_POSE_ZERO_J);
  if (track.length === 1 || s <= track[0].time) return _jClone(track[0]);
  const last = track[track.length - 1];
  if (s >= last.time) return _jClone(last);
  let i = 0;
  while (i < track.length - 2 && s > track[i + 1].time) i++;
  const a = track[i], c = track[i + 1];
  const x = Math.max(0, Math.min(1, (s - a.time) / ((c.time - a.time) || 1)));
  return _jLerp(a, c, scEase(a.curve || null, x));
}

function poseGet(id) { return poseBlocks.find(b => b.id === id) || null; }
function poseGetSelected() { return selectedPoseId != null ? poseGet(selectedPoseId) : null; }

// ブロックの中の時刻(秒)。くり返す時は 0〜loopLen に折り返す
function poseLocalSec(b, tick) {
  let s = b.offsetSec + (tick - b.startTick) / scTps();
  if (b.loopLen > 0.01) s = ((s % b.loopLen) + b.loopLen) % b.loopLen;
  return s;
}

function poseBlockPose(b, tick) {
  const type = entityRigType(b.target);
  const s = poseLocalSec(b, tick);
  const out = {};
  for (const j of rigJoints(type)) out[j] = _trackEval(b.tracks[j], s);
  if (typeof mpApplySmooth === 'function') mpApplySmooth(b, out, s);   // ステップ43: なめらかな道
  return out;
}

// エンティティの、指定したフレームのブロック(重なっていたら後から置いた方)
function poseBlockAtTick(key, tick) {
  let hit = null;
  for (const b of poseBlocks) if (b.target === key && tick >= b.startTick && tick < b.endTick) hit = b;
  return hit;
}

// エンティティの、指定したフレームのポーズ。
// 下地は自動アニメーション(autoanim.js)。ポーズのブロックがある所は、キーのある関節だけ手付けが勝つ。
// ブロックの始めから、キーの形そのままで出す(0秒のキーを動かすと、すぐその形が見える)
function poseEntityPose(key, tick) {
  const auto = (typeof autoAnimPose === 'function') ? autoAnimPose(key, tick) : null;
  const pose = auto || poseZero(entityRigType(key));
  const b = poseBlockAtTick(key, tick);
  if (!b) return pose;
  const s = poseLocalSec(b, tick);
  for (const j in pose) if (b.tracks[j] && b.tracks[j].length) pose[j] = _trackEval(b.tracks[j], s);
  if (b.tracks.root && b.tracks.root.length && typeof mpApplySmooth === 'function') mpApplySmooth(b, pose, s);
  return pose;
}

// 手付けのキーが無い時の、その関節の値(自動アニメーションの値。無ければ 0)
function _poseUnderlying(target, joint, tick) {
  const auto = (typeof autoAnimPose === 'function') ? autoAnimPose(target, tick) : null;
  return auto && auto[joint] ? _jClone(auto[joint]) : _jClone(_POSE_ZERO_J);
}


// ============================================================
// ブロックの作成・分割・複製
// ============================================================

function poseAddBlock(tick, target, props) {
  props = props || {};
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(tick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.round((props.seconds || POSE_DEFAULT_SECONDS) * scTps());
  if (maxTick > 0) end = Math.min(end, maxTick);
  const id = nextPoseBlockId++;
  const b = {
    id, kind: 'pose', name: props.name || ('ポーズ' + id), target,
    startTick: start, endTick: Math.max(start + 1, end), offsetSec: 0,
    loopLen: props.loopLen || 0,
    tracks: JSON.parse(JSON.stringify(props.tracks || {})),
  };
  poseBlocks.push(b);
  return b;
}

function poseDeleteBlock(id) { poseBlocks = poseBlocks.filter(b => b.id !== id); if (poseExpandedId === id) poseExpandedId = null; }

function poseSplitBlock(b, tick) {
  if (tick <= b.startTick || tick >= b.endTick) return null;
  const right = JSON.parse(JSON.stringify(b));
  right.id = nextPoseBlockId++;
  right.startTick = tick;
  right.offsetSec = b.offsetSec + (tick - b.startTick) / scTps();
  b.endTick = tick;
  poseBlocks.push(right);
  return right;
}

function poseDuplicateBlock(b) {
  const len = b.endTick - b.startTick;
  const maxTick = scMaxTick();
  let start = b.endTick;
  if (maxTick > 0 && start + len > maxTick) start = Math.max(0, maxTick - len);
  const dup = JSON.parse(JSON.stringify(b));
  dup.id = nextPoseBlockId++;
  dup.startTick = start; dup.endTick = start + len;
  poseBlocks.push(dup);
  return dup;
}

// 関節のキーを、再生ヘッドの時刻に用意する(無ければ今の値で作る)。戻り値: { key, index, created }
function poseEditJointKey(b, joint, tick) {
  const s = poseLocalSec(b, tick);
  if (!b.tracks[joint]) b.tracks[joint] = [];
  const tr = b.tracks[joint];
  let i = tr.findIndex(k => Math.abs(k.time - s) <= POSE_KEY_SNAP);
  if (i >= 0) return { key: tr[i], index: i, created: false, seconds: s };
  // その関節の最初のキーを、ブロックの始め以外に作る時は、始めに「初期状態」のキーも自動で置く
  // (キー1つだけでは動かないので、1回動かすだけで 初期状態→動かした形 のアニメーションになる)
  let startKeyAdded = false;
  const startSec = b.loopLen > 0 ? 0 : b.offsetSec;
  const firstKey = !tr.length;
  if (firstKey && Math.abs(s - startSec) > POSE_KEY_SNAP) {
    const u = _poseUnderlying(b.target, joint, b.startTick);
    tr.push({ time: startSec, r: u.r, p: u.p, ...(u.s ? { s: u.s } : {}), curve: CURVE_PRESETS.smooth.c.slice() });
    startKeyAdded = true;
  }
  // 最初のキーは、今見えている形(自動アニメーション)から始める(つかんだ瞬間に形が飛ばない)
  const v = firstKey && !startKeyAdded ? _poseUnderlying(b.target, joint, tick) : _trackEval(tr, s);
  // ステップ43: なめらかな道の時は、今見えている(曲線の上の)位置からキーを作る
  if (joint === 'root' && b.smoothPath && typeof mpSmoothRootP === 'function') { const sp = mpSmoothRootP(tr, s); if (sp) v.p = sp; }
  const key = { time: s, r: v.r, p: v.p, curve: CURVE_PRESETS.smooth.c.slice() };
  if (v.s) key.s = v.s;
  let prev = null;
  for (const k of tr) if (k.time < s) prev = k;
  if (prev && prev.curve) key.curve = prev.curve.slice();
  tr.push(key);
  tr.sort((a, c) => a.time - c.time);
  return { key, index: tr.indexOf(key), created: true, seconds: s, startKeyAdded };
}

// 3Dで動かし始めた時: 再生ヘッドにブロックが無ければ作る
function poseEnsureBlockAt(key, tick) {
  let b = poseBlockAtTick(key, tick);
  if (b) return { b, created: false };
  b = poseAddBlock(tick, key, { name: 'ポーズ' + nextPoseBlockId });
  b.smoothPath = true;   // ステップ43: 手で作るブロックは、道をなめらかに
  return { b, created: true };
}

// ブロックのキーの時刻(全部の関節をまとめた、重ならない一覧)
function poseKeyTimes(b) {
  const set = new Map();
  for (const j in b.tracks) for (const k of b.tracks[j]) set.set(Math.round(k.time * 100) / 100, k.time);
  return [...set.values()].sort((a, c) => a - c);
}


// ============================================================
// 組み立て(関節ごとの行列)
// ============================================================

function _m4Rz(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
function _m4S(x, y, z) { return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]); }
function _m4Mul(...ms) { let r = ms[0]; for (let i = 1; i < ms.length; i++) r = mat4Multiply(r, ms[i]); return r; }
function _m4Point(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function _m4Dir(m, d) {
  const v = [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function _m4Inverse(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

const _D2R = Math.PI / 180;
// 関節の回転 = Ry * Rz * Rx
function _jointRot(sign, r) {
  return _m4Mul(mat4RotateY(sign[1] * r[1] * _D2R), _m4Rz(sign[2] * r[2] * _D2R), mat4RotateX(sign[0] * r[0] * _D2R));
}

// 戻り値: { pre:{関節:回転の手前の行列}, frame:{関節:行列}, parent:{関節:親の行列}, parts:[{joint, model}] }
function poseBuildRig(type, base, pose) {
  const T = RIG_TYPES[type];
  const pre = {}, frame = {}, parent = {};
  // ステップ41: 画面を左右反対に映すので、体も左右を反対にして、人の見た目(右手が右)は前のままにする
  const world = (typeof FC_MIRROR_X !== 'undefined' && FC_MIRROR_X)
    ? _m4Mul(modelMatrixYaw(base.pos[0], base.pos[1], base.pos[2], base.yaw), _m4S(-1, 1, 1))
    : modelMatrixYaw(base.pos[0], base.pos[1], base.pos[2], base.yaw);
  const rp = pose.root.p;
  // 大きさ: エンティティの大きさ(ブロックの幅・高さ・奥行き)×キーの大きさ
  const bs = base.size || [1, 1, 1], ks = pose.root.s || [1, 1, 1];
  const k = [bs[0] * ks[0], bs[1] * ks[1], bs[2] * ks[2]];
  const pivot = T.rootPivot * k[1];
  parent.root = world;
  pre.root = _m4Mul(world, mat4Translate(rp[0], rp[1] + pivot, rp[2]));
  frame.root = _m4Mul(pre.root, _jointRot(T.rootSign, pose.root.r), mat4Translate(0, -pivot, 0));
  for (const bn of T.bones) {
    const v = pose[bn.joint], par = frame[bn.parent];
    parent[bn.joint] = par;
    pre[bn.joint] = _m4Mul(par, mat4Translate(bn.at[0] + v.p[0], bn.at[1] + v.p[1], bn.at[2] + v.p[2]));
    frame[bn.joint] = _m4Mul(pre[bn.joint], _jointRot(bn.sign, v.r));
  }
  const parts = T.parts.map(pt => ({
    joint: pt.joint,
    model: _m4Mul(frame[pt.joint], mat4Translate(pt.box[0] * k[0], pt.box[1] * k[1], pt.box[2] * k[2]), _m4S(pt.size[0] * k[0], pt.size[1] * k[1], pt.size[2] * k[2])),
  }));
  return { pre, frame, parent, parts };
}


// ============================================================
// 描画(entities3d.js の renderHumanoids から呼ばれる)
// ============================================================

let _poseCubeData = null;
function _poseCube() {
  if (_poseCubeData) return _poseCubeData;
  const v = [];
  const order = [0, 1, 2, 0, 2, 3];
  for (let d = 0; d < 6; d++) {
    for (const oi of order) {
      const o = FACE_OFFSETS[d][oi];
      const uv = ENT3D_CORNER_UV[oi];
      v.push(o[0] - 0.5, o[1] - 0.5, o[2] - 0.5, DIR_FACTOR[d], uv[0], uv[1]);
    }
  }
  _poseCubeData = new Float32Array(v);
  return _poseCubeData;
}

const POSE_TINT_PLAYER = [0.6, 0.6, 0.62], POSE_TINT_LOCAL = [0.85, 0.85, 0.9];
const POSE_TINT_PUPPET = [0.62, 0.74, 0.9];
const POSE_TINT_SEL = [0.95, 0.72, 0.35];
let _poseDrawingPreview = false;

// ポーズを編集している画面か(ポーズのタブ・編集視点)
// ブロックは「グローバル」のタブのままでも動かせる(blocks.js)
let blockFocus = false;

function _poseEditingOn() {
  const tabOk = timelineTab === 'pose' || (blockFocus && typeof isBlockKey === 'function' && isBlockKey(poseEntity));
  return tabOk && !!poseEntity &&
    (typeof previewIsMain === 'undefined' || !previewIsMain) && (typeof pilot === 'undefined' || !pilot) && !_poseDrawingPreview;
}

const POSE_TINT_SEL_OFFICIAL = [1.25, 0.85, 0.45]; // 公式の見た目で選んでいる関節(スキンの色に橙をかける)

function renderPosedHumanoids(gl, viewMatrix, projMatrix, tickVal) {
  _poseRestoreBoxState(gl, viewMatrix, projMatrix);
  _renderPosedHumanoidsInner(gl, viewMatrix, projMatrix, tickVal);
}

// 箱の人形を描くための状態(公式の見た目で描いた後にも戻す)
function _poseRestoreBoxState(gl, viewMatrix, projMatrix) {
  gl.useProgram(ent3dProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, ent3dVbo);
  gl.bufferData(gl.ARRAY_BUFFER, _poseCube(), gl.STATIC_DRAW);
  const stride = 24;
  gl.enableVertexAttribArray(ent3dAPosLoc);
  gl.vertexAttribPointer(ent3dAPosLoc, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(ent3dABrightnessLoc);
  gl.vertexAttribPointer(ent3dABrightnessLoc, 1, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(ent3dAUVLoc);
  gl.vertexAttribPointer(ent3dAUVLoc, 2, gl.FLOAT, false, stride, 16);
  gl.uniformMatrix4fv(ent3dUViewLoc, false, viewMatrix);
  gl.uniformMatrix4fv(ent3dUProjLoc, false, projMatrix);
  if (humanoidTextureGL) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, humanoidTextureGL);
    gl.uniform1i(ent3dUTextureLoc, 0);
    gl.uniform1f(ent3dUUseTextureLoc, 1.0);
  } else {
    gl.uniform1f(ent3dUUseTextureLoc, 0.0);
  }
}

function _renderPosedHumanoidsInner(gl, viewMatrix, projMatrix, tickVal) {
  const frameIdx = curTick;
  const editing = _poseEditingOn();
  const draw = (key, base, tint) => {
    const type = entityRigType(key);
    const rig = poseRigFor(key, frameIdx);
    if (!rig) return;
    const isSel = editing && key === poseEntity;
    // ステップ31: 公式のモデル・スキンで描く(official/ が無ければ下の箱)
    if (typeof officialCanDraw === 'function' && officialCanDraw(gl, type)) {
      const rootSel = isSel && poseJointSelected('root');
      let ok = true;
      try {
        officialDrawHumanoid(gl, viewMatrix, projMatrix, key, rig, frameIdx,
          j => (isSel && (rootSel || poseJointSelected(j))) ? POSE_TINT_SEL_OFFICIAL : null);
      } catch (e) { ok = false; officialGiveUp('描画', e); }
      _poseRestoreBoxState(gl, viewMatrix, projMatrix);
      if (ok) return;   // 失敗した時は、この下の箱で描く
    }
    for (const p of rig.parts) {
      gl.uniformMatrix4fv(ent3dUModelLoc, false, p.model);
      let c = humanoidTextureGL ? [1, 1, 1] : tint;
      if (isSel && (poseJointSelected(p.joint) || poseJointSelected('root'))) c = POSE_TINT_SEL;
      gl.uniform3f(ent3dUTintLoc, c[0], c[1], c[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 36);
    }
  };
  const meshList = [];
  if (allTimelines && allTimelines.entities) {
    for (const eid in allTimelines.entities) {
      // ステップ36: 「Mesh|…」はワールドコードが置いた物(粒の出る所・ランキングの板・ブロック)。人は「Mesh|Person|」だけ
      // ステップ37: 人以外の Mesh は mesh-entities.js で描く
      const nm = allTimelines.entities[eid].name || '';
      if (nm.startsWith('Mesh|') && !nm.startsWith('Mesh|Person|')) {
        const b = poseEntityBase('player:' + eid, frameIdx);
        if (b) {
          const f = nearestFrameAtOrBefore(allTimelines.entities[eid].frames, _poseTickVal(frameIdx));
          meshList.push({ eid, name: nm, base: b, rot: (f && f.rotation) || [0, b.yaw, 0] });
        }
        continue;
      }
      const key = 'player:' + eid;
      const base = poseEntityBase(key, frameIdx);
      if (base) draw(key, base, eid === allTimelines.localPlayerEntityId ? POSE_TINT_LOCAL : POSE_TINT_PLAYER);
    }
  }
  if (meshList.length && typeof meshEntitiesDraw === 'function') {
    try { meshEntitiesDraw(gl, viewMatrix, projMatrix, meshList, _poseTickVal(frameIdx)); }
    catch (e) { console.warn('[Mesh エンティティ] 描けませんでした:', e); }
    _poseRestoreBoxState(gl, viewMatrix, projMatrix);
  }
  for (const p of puppets) {
    if (p.type === 'block') continue; // ブロックは地形と同じ絵で blockfx.js が描く
    const key = 'puppet:' + p.id;
    const base = poseEntityBase(key, frameIdx);
    if (base) draw(key, base, POSE_TINT_PUPPET);
  }
}


// ============================================================
// 3Dの操作: クリックでエンティティと関節を選び、矢印・リングで動かす
// ============================================================

let poseDrag = null;
let poseHover = null;

function _poseRay(mx, my) { return scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg); }

// 選んでいるエンティティの、今の組み立て(見えていなければ null)
function _poseCurrentRig() {
  if (!poseEntity) return null;
  const base = poseEntityBase(poseEntity, curTick);
  if (!base) return null;
  const type = entityRigType(poseEntity);
  const pose = poseEntityPose(poseEntity, curTick);
  return { key: poseEntity, type, base, pose, rig: poseRigFor(poseEntity, curTick, pose) };
}

// リングの軸(ワールドの向き)。回転の順番 Ry*Rz*Rx に合わせる
function _poseAxes(r, joint) {
  const pre = r.rig.pre[joint];
  const v = r.pose[joint].r, s = _rigSign(r.type, joint);
  const ry = mat4RotateY(s[1] * v[1] * _D2R);
  const out = { x: _m4Dir(_m4Mul(pre, ry, _m4Rz(s[2] * v[2] * _D2R)), [1, 0, 0]) };
  if (!_rigBend(r.type, joint)) {
    out.y = _m4Dir(pre, [0, 1, 0]);
    out.z = _m4Dir(_m4Mul(pre, ry), [0, 0, 1]);
  }
  return out;
}

function _poseRingPoints(c, axis, r) {
  const u = Math.abs(axis[1]) < 0.9 ? fcVecNormalize(fcVecCross(axis, [0, 1, 0])) : fcVecNormalize(fcVecCross(axis, [1, 0, 0]));
  const v = fcVecCross(axis, u);
  const pts = []; let prev = null;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40 * Math.PI * 2;
    const p = [0, 1, 2].map(k => c[k] + (u[k] * Math.cos(t) + v[k] * Math.sin(t)) * r);
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return { pts, u, v };
}

const POSE_RING_COLOR = { x: [0.92, 0.3, 0.3], y: [0.35, 0.85, 0.42], z: [0.35, 0.58, 0.95] };

// ステップ48: 道具(3Dの上の帯)。move = 矢印(と大きさ)だけ・rotate = リングだけ・ik = 手足の先の○だけ
let poseTool = (() => { try { return localStorage.getItem('bloxdEditor.poseTool') || 'rotate'; } catch (e) { return 'rotate'; } })();
function setPoseTool(t) {
  poseTool = t;
  try { localStorage.setItem('bloxdEditor.poseTool', t); } catch (e) { /* 保存できなくても続ける */ }
  if (typeof editorChanged === 'function') editorChanged();
}
// その型で使える道具(手足の無い型の「手足」は「回す」)
function poseToolFor(type) {
  if (poseTool === 'ik' && !((RIG_TYPES[type] || {}).ik || []).length) return 'rotate';
  return poseTool;
}

// 選んでいる関節のギズモ: リング(回す)+矢印(動かす)
function _poseGizmoParts(r) {
  const tool = poseToolFor(r.type);
  if (tool === 'ik') return [];
  return _poseGizmoPartsAll(r).filter(p => tool === 'rotate' ? p.kind === 'ring' : p.kind !== 'ring');
}
function _poseGizmoPartsAll(r) {
  const j = poseSelJoint;
  if (!r.rig.pre[j]) return [];
  const c = _m4Point(r.rig.pre[j], [0, 0, 0]);
  const axes = _poseAxes(r, j);
  const rad = 42 * worldUnitsPerPixelAt(c);
  const parts = [];
  for (const k of ['x', 'y', 'z']) {
    if (!axes[k]) continue;
    const ring = _poseRingPoints(c, axes[k], rad * (k === 'y' ? 1.15 : k === 'z' ? 1.0 : 0.85));
    parts.push({ kind: 'ring', comp: k, axis: axes[k], center: c, pts: ring.pts, u: ring.u, v: ring.v, color: POSE_RING_COLOR[k] });
  }
  const s = gizmoScaleAt(c) * (j === 'root' ? 0.8 : 0.5);
  for (const ax of ['x', 'y', 'z']) parts.push({ kind: 'axis', axis: ax, center: c, pts: gizmoAxisPoints(c, ax, s), color: GIZMO_AXIS_COLOR[ax] });
  // 大きさを変えられる型(ブロック): エンティティの向きに合わせた3本の線+先の四角
  if (j === 'root' && RIG_TYPES[r.type].scalable) {
    const len = 60 * worldUnitsPerPixelAt(c);
    const q = 5 * worldUnitsPerPixelAt(c);
    const { right, up } = fcGetCameraVectors(fcYaw, fcPitch);
    ['x', 'y', 'z'].forEach((ax, i) => {
      const dir = _m4Dir(r.rig.frame.root, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
      const e = [0, 1, 2].map(n => c[n] - dir[n] * len); // 移動の矢印と重ならないよう、反対側に出す
      const P = (a, b) => [0, 1, 2].map(n => e[n] + right[n] * a * q + up[n] * b * q);
      const sq = [P(-1, -1), P(1, -1), P(1, -1), P(1, 1), P(1, 1), P(-1, 1), P(-1, 1), P(-1, -1)];
      parts.push({ kind: 'scale', axis: ax, index: i, center: c, dir: dir.map(v => -v), len, pts: [c, e, ...sq],
                   color: GIZMO_AXIS_COLOR[ax].map(v => v * 0.75 + 0.25) });
    });
  }
  return parts;
}

function renderPoseGizmos(gl, viewMatrix, projMatrix, W, H) {
  if (typeof renderConsGizmos === 'function') renderConsGizmos(gl, viewMatrix, projMatrix, W, H);
  if (!_poseEditingOn() || (typeof consPick !== 'undefined' && consPick)) return; // くっつける点を選んでいる間は、ギズモを出さない
  if (typeof renderMotionPath === 'function') renderMotionPath(gl, viewMatrix, projMatrix, W, H);   // ステップ43
  const r = _poseCurrentRig();
  if (!r) return;
  // ブロックなど関節の無い物は、形が分かるように枠を出す
  if (!RIG_TYPES[r.type].bones.length) {
    for (const part of r.rig.parts) {
      const C = (x, y, z) => _m4Point(part.model, [x * 0.5, y * 0.5, z * 0.5]);
      const c = [C(-1,-1,-1), C(1,-1,-1), C(1,1,-1), C(-1,1,-1), C(-1,-1,1), C(1,-1,1), C(1,1,1), C(-1,1,1)];
      const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
      _drawLineSegments(gl, viewMatrix, projMatrix, E.flatMap(([a, b]) => [c[a], c[b]]), [1, 0.86, 0.3], W, H, 1.6);
    }
  }
  for (const j of rigJoints(r.type)) {
    const p = _m4Point(r.rig.pre[j], [0, 0, 0]);
    const hot = poseJointSelected(j);
    _drawLineSegments(gl, viewMatrix, projMatrix, _keyDiamondSegments(p, j === poseSelJoint ? 6.5 : hot ? 5.5 : 4), hot ? [1, 0.86, 0.3] : [0.97, 0.95, 0.9], W, H, hot ? 2.6 : 1.8);
  }
  // IK: 手・足の先の○
  for (const h of _poseIkHandles(r)) {
    const act = (poseDrag && poseDrag.ik && poseDrag.ik.id === h.chain.id) || poseIkHover === h.chain.id;
    _drawLineSegments(gl, viewMatrix, projMatrix, _poseCircleSegments(h.pos, act ? 9 : 7), act ? [0.6, 1, 1] : [0.35, 0.9, 0.95], W, H, act ? 3.2 : 2.4);
  }
  for (const part of _poseGizmoParts(r)) {
    const same = (x) => x && x.kind === part.kind && x.comp === part.comp && x.axis === part.axis;
    const active = poseDrag ? same(poseDrag.part) : same(poseHover);
    const col = active ? part.color.map(v => v + (1 - v) * 0.6) : part.color;
    _drawLineSegments(gl, viewMatrix, projMatrix, part.pts, col, W, H, active ? 5 : 3);
  }
}

function _posePickGizmo(r, mx, my, view, proj) {
  let best = null, bestD = 11;
  for (const part of _poseGizmoParts(r)) {
    const d = _polylineScreenDist(part.pts, mx, my, view, proj, fcCanvas.width, fcCanvas.height) + (part.kind === 'ring' ? 2 : 0);
    if (d < bestD) { bestD = d; best = part; }
  }
  if (best) best.d = bestD;
  return best;
}

function _posePickMarker(r, mx, my, view, proj) {
  let best = null, bestD = 8;
  for (const j of rigJoints(r.type)) {
    const sp = projectToScreen(_m4Point(r.rig.pre[j], [0, 0, 0]), view, proj, fcCanvas.width, fcCanvas.height);
    if (!sp) continue;
    const d = Math.hypot(sp.x - mx, sp.y - my);
    if (d < bestD) { bestD = d; best = { joint: j, d }; }
  }
  return best;
}

// 線が、どの部品(箱)に当たるか
function _posePickPart(rig, ray) {
  let best = null, bestT = Infinity;
  for (const p of rig.parts) {
    const inv = _m4Inverse(p.model);
    if (!inv) continue;
    const o = _m4Point(inv, ray.origin);
    const d = [inv[0] * ray.dir[0] + inv[4] * ray.dir[1] + inv[8] * ray.dir[2],
               inv[1] * ray.dir[0] + inv[5] * ray.dir[1] + inv[9] * ray.dir[2],
               inv[2] * ray.dir[0] + inv[6] * ray.dir[1] + inv[10] * ray.dir[2]];
    let t0 = -Infinity, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < -0.5 || o[i] > 0.5) { t0 = Infinity; break; } continue; }
      let a = (-0.5 - o[i]) / d[i], c = (0.5 - o[i]) / d[i];
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    }
    if (t0 <= t1 && t1 > 0 && t0 < bestT) { bestT = Math.max(0, t0); best = p.joint; }
  }
  return best == null ? null : { joint: best, t: bestT };
}

// 画面の点の先にいるエンティティ(一番手前)
function _posePickEntity(ray) {
  let best = null;
  for (const e of poseEntityList()) {
    const rig = poseRigFor(e.key, curTick);
    if (!rig) continue;
    const hit = _posePickPart(rig, ray);
    if (hit && (!best || hit.t < best.t)) best = { key: e.key, joint: hit.joint, t: hit.t };
  }
  return best;
}

// タブの切り替え(ポーズのタブでは、選んだエンティティだけの行を出す)
function setTimelineTab(tab) {
  if (timelineTab === tab) return;
  timelineTab = tab;
  const panel = document.getElementById('timelinePanel');
  if (panel) panel.classList.toggle('tabPose', tab === 'pose');
  renderTimelineTabs();
  renderPoseTrackBlocks();
}

// 関節の選び方。additive=true(Shift)なら足す/外す。最後に選んだ関節がギズモの中心(poseSelJoint)
function poseSetJoint(j, additive) {
  if (additive) {
    const i = poseSelJoints.indexOf(j);
    if (i >= 0 && poseSelJoints.length > 1) {
      poseSelJoints.splice(i, 1);
      if (poseSelJoint === j) poseSelJoint = poseSelJoints[poseSelJoints.length - 1];
      return;
    }
    if (i < 0) poseSelJoints.push(j);
    poseSelJoint = j;
    return;
  }
  poseSelJoint = j;
  poseSelJoints = [j];
}
function poseSetJoints(list) {
  if (!list.length) return;
  poseSelJoints = list.slice();
  poseSelJoint = list[0];
}
function poseJointSelected(j) { return poseSelJoints.includes(j); }

// エンティティを選ぶ(ポーズのタブにして、再生ヘッドの所のブロックも選ぶ)
function poseSelectEntity(key, joint, additive) {
  const same = poseEntity === key;
  poseEntity = key;
  const joints = rigJoints(entityRigType(key));
  if (joint) poseSetJoint(joint, additive && same);
  if (!joints.includes(poseSelJoint)) poseSetJoint('root');
  poseSelJoints = poseSelJoints.filter(j => joints.includes(j));
  if (!poseSelJoints.length) poseSetJoint('root');
  const stayGlobal = typeof isBlockKey === 'function' && isBlockKey(key) && timelineTab !== 'pose';
  const b = poseBlockAtTick(key, curTick);
  if (b) {
    if (selectedPoseId !== b.id) selectPose(b.id);
    poseExpandedId = b.id;
  } else if (typeof clearSelection === 'function') {
    clearSelection();
  }
  if (stayGlobal) blockFocus = true;
  else { blockFocus = false; setTimelineTab('pose'); }
  renderTimelineTabs();
  editorChanged();
}


// ============================================================
// IK(手・足の先をつかんで引っぱると、腕・脚が自動で曲がる)
// ============================================================

// 画面に出す、手・足の先の丸い印
function _poseIkHandles(r) {
  const T = RIG_TYPES[r.type];
  if (poseToolFor(r.type) !== 'ik') return [];   // ステップ48: 手足の道具の時だけ
  return (T.ik || []).map(c => ({ chain: c, pos: _m4Point(r.rig.frame[c.upper], c.end) }));
}

function _posePickIk(r, mx, my, view, proj) {
  let best = null, bestD = 11;
  for (const h of _poseIkHandles(r)) {
    const sp = projectToScreen(h.pos, view, proj, fcCanvas.width, fcCanvas.height);
    if (!sp) continue;
    const d = Math.hypot(sp.x - mx, sp.y - my);
    if (d < bestD) { bestD = d; best = { ...h, d }; }
  }
  return best;
}

function _poseCircleSegments(c, px, n) {
  const { right, up } = fcGetCameraVectors(fcYaw, fcPitch);
  const s = px * worldUnitsPerPixelAt(c);
  const pts = []; let prev = null;
  for (let i = 0; i <= (n || 16); i++) {
    const a = i / (n || 16) * Math.PI * 2;
    const p = [0, 1, 2].map(k => c[k] + (right[k] * Math.cos(a) + up[k] * Math.sin(a)) * s);
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return pts;
}

// 腕・脚(1本)のつけ根の角度を、先が target の方を向くように決める。
//   前後 x と横 z を、先が target(届かない時は、その方向の届く所)に近づくように少しずつ直す(ガウス・ニュートン法)。ひねり(y)は今のまま。
function poseSolveIK(r, chain, target) {
  const pose = {};
  for (const j in r.pose) pose[j] = _jClone(r.pose[j]);
  const rig0 = poseRigFor(r.key, curTick, pose);
  const pivot = _m4Point(rig0.pre[chain.upper], [0, 0, 0]);
  const L = Math.hypot(chain.end[0], chain.end[1], chain.end[2]);
  const toT = [0, 1, 2].map(i => target[i] - pivot[i]);
  const dist = Math.hypot(toT[0], toT[1], toT[2]) || 1e-6;
  const T = [0, 1, 2].map(i => pivot[i] + toT[i] / dist * L);
  const end = (pp) => _m4Point(poseRigFor(r.key, curTick, pp).frame[chain.upper], chain.end);
  const up = pose[chain.upper];
  for (let it = 0; it < 14; it++) {
    const e = end(pose);
    const err = [0, 1, 2].map(i => T[i] - e[i]);
    if (Math.hypot(err[0], err[1], err[2]) < 1e-4) break;
    const h = 0.5;
    const col = (ci) => {
      const save = up.r[ci];
      up.r[ci] = save + h;
      const e2 = end(pose);
      up.r[ci] = save;
      return [0, 1, 2].map(i => (e2[i] - e[i]) / h);
    };
    const jx = col(0), jz = col(2);
    const a = fcVecDot(jx, jx) + 1e-6, b = fcVecDot(jx, jz), c = fcVecDot(jz, jz) + 1e-6;
    const gx = fcVecDot(jx, err), gz = fcVecDot(jz, err);
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) break;
    let dx = (c * gx - b * gz) / det, dz = (a * gz - b * gx) / det;
    const m = Math.max(Math.abs(dx), Math.abs(dz));
    if (m > 30) { dx *= 30 / m; dz *= 30 / m; } // 1回に回しすぎない
    up.r[0] = ((up.r[0] + dx + 180) % 360 + 360) % 360 - 180;
    up.r[2] = ((up.r[2] + dz + 180) % 360 + 360) % 360 - 180;
  }
  return { upper: up.r.map(v => Math.round(v * 10) / 10) };
}


// ============================================================
// 3Dのマウス操作
// ============================================================

// freecam.js の mousedown から呼ぶ。処理したら true。
// 3Dでは1回のクリックで、エンティティ(と関節)を選んで編集できる状態になる。
// Shift+クリックで関節を足す/外す(まとめ選択)。
function poseMouseDown(e, mx, my) {
  if ((typeof previewIsMain !== 'undefined' && previewIsMain) || (typeof pilot !== 'undefined' && pilot)) return false;
  if (typeof consMouseDown === 'function' && consMouseDown(e, mx, my)) return true;
  const { view, proj } = _fcEditViewProj();
  if (_poseEditingOn()) {
    const r = _poseCurrentRig();
    if (r) {
      // 一番近い物を選ぶ(手足の先の印・関節の◇印・リング/矢印)
      const ik = _posePickIk(r, mx, my, view, proj);
      const mark = _posePickMarker(r, mx, my, view, proj);
      const part = _posePickGizmo(r, mx, my, view, proj);
      const dIk = ik ? ik.d - 1 : Infinity; // 手足の先の印を少し優先
      const dMark = mark && (e.shiftKey || mark.joint !== poseSelJoint) ? mark.d : Infinity;
      const dPart = part ? part.d : Infinity;
      // Shift+クリックは関節を足す/外すのが先(人形の全体を Shift+ドラッグで動かす時だけはギズモが先)
      // ステップ43: 動きの道の◆(ギズモ・印より近い時)。Shift+クリックの関節選びより先
      if (typeof mpMouseDown === 'function' && mpMouseDown(e, mx, my, Math.min(dIk, dMark, dPart))) return true;
      const puppetMove = e.shiftKey && part && poseSelJoint === 'root' && r.key.startsWith('puppet:');
      if (e.shiftKey && !puppetMove) {
        if (mark && mark.d <= 8) { poseSetJoint(mark.joint, true); editorChanged(); return true; }
        const limb = _posePickPart(r.rig, _poseRay(mx, my));
        if (limb) { poseSetJoint(limb.joint, true); editorChanged(); return true; }
      }
      if (dIk <= dMark && dIk <= dPart && ik) { _poseBeginIkDrag(r, ik, mx, my); return true; }
      if (dMark <= dPart && mark) { poseSetJoint(mark.joint, e.shiftKey); editorChanged(); return true; }
      if (part) { _poseBeginDrag(r, part, mx, my, e.shiftKey); return true; }
    }
  }
  if (typeof mpMouseDown === 'function' && mpMouseDown(e, mx, my)) return true;   // ステップ43: 動きの道
  const hit = _posePickEntity(_poseRay(mx, my));
  if (hit) { poseSelectEntity(hit.key, hit.joint, e.shiftKey); return true; }
  return false;
}

function _poseAngleOnRing(part, hit) {
  const h = [hit[0] - part.center[0], hit[1] - part.center[1], hit[2] - part.center[2]];
  return Math.atan2(fcVecDot(h, part.v), fcVecDot(h, part.u));
}

// ドラッグの始めに、動かす関節のキーを用意する(ブロックが無ければ作る)
function _poseDragPrepareKeys(d, joints) {
  const eb = poseEnsureBlockAt(d.key, curTick);
  let anyStart = false, anyCreated = false;
  d.keys = {};
  for (const j of joints) {
    const k = poseEditJointKey(eb.b, j, curTick);
    d.keys[j] = { ref: k.key, start: { r: k.key.r.slice(), p: k.key.p.slice(), s: k.key.s ? k.key.s.slice() : null } };
    if (k.startKeyAdded) anyStart = true;
    if (k.created) anyCreated = true;
    if (j === d.joint) poseSelKey = { joint: j, index: k.index };
  }
  poseSelKeyExplicit = false;
  poseExpandedId = eb.b.id;
  selectedPoseId = eb.b.id;
  const names = joints.map(j => rigJointLabel(d.type, j)).join('・');
  if (eb.created) showToast('🕺 ポーズのブロックを自動で作りました');
  else if (anyStart) showToast(`◆ ${names}: ブロックの始めに初期状態のキーも置きました(初期状態→この形 に動きます)`);
  else if (anyCreated) showToast(`◆ ${names}にキーを自動で作りました`);
  renderPoseTrackBlocks();
}

function _poseBeginDrag(r, part, mx, my, shift) {
  beginEdit();
  const ray = _poseRay(mx, my);
  const d = { part, joint: poseSelJoint, joints: poseSelJoints.slice(), key: r.key, type: r.type, pending: true, startMouse: [mx, my],
    shift: !!shift && r.key.startsWith('puppet:') && poseSelJoint === 'root' };
  if (part.kind === 'ring') {
    const hit = scRayPlaneIntersect(ray, part.center, part.axis);
    d.angle0 = hit ? _poseAngleOnRing(part, hit) : 0;
  } else if (part.kind === 'scale') {
    d.shift = false;
    d.uniform = !!shift; // Shift: 縦横奥行きを同じ割合で
    d.t0 = scClosestTOnLine(ray, part.center, part.dir);
  } else {
    d.axisDir = _axisVec(part.axis);
    d.t0 = scClosestTOnLine(ray, part.center, d.axisDir);
    // 位置のずれは親の向きが基準。関節ごとに、親の軸(ワールド)を覚えておく
    d.parentAxes = {};
    for (const j of d.joints) {
      const par = r.rig.parent[j];
      d.parentAxes[j] = [_m4Dir(par, [1, 0, 0]), _m4Dir(par, [0, 1, 0]), _m4Dir(par, [0, 0, 1])];
    }
  }
  poseDrag = d;
}

function _poseBeginIkDrag(r, ik, mx, my) {
  beginEdit();
  const ray = _poseRay(mx, my);
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const hit = scRayPlaneIntersect(ray, ik.pos, forward) || ik.pos.slice();
  poseSetJoints([ik.chain.upper]);
  poseSelJoint = ik.chain.upper;
  poseDrag = { ik: ik.chain, planeN: forward, planeP: ik.pos.slice(), grabOffset: [0, 1, 2].map(i => ik.pos[i] - hit[i]),
    joint: ik.chain.upper, joints: [ik.chain.upper], key: r.key, type: r.type, pending: true, startMouse: [mx, my] };
  editorChanged();
}

function poseDragMove(mx, my) {
  const d = poseDrag;
  if (!d) return;
  if (d.cons) { consDragMove(d, mx, my); return; }
  if (d.mp) { mpDragMove(d, mx, my); return; }
  if (d.build) { buildDragMove(mx, my); return; }   // ステップ49: 建築
  if (d.pending && Math.hypot(mx - d.startMouse[0], my - d.startMouse[1]) < 2) return;
  if (d.pending) {
    d.pending = false;
    if (d.shift) {
      const pp = puppetGet(+d.key.slice(7));
      d.puppet = pp;
      d.startBase = { pos: pp.base.pos.slice(), yaw: pp.base.yaw };
    } else {
      _poseDragPrepareKeys(d, d.joints);
    }
  }
  const ray = _poseRay(mx, my);
  if (d.ik) {
    const hit = scRayPlaneIntersect(ray, d.planeP, d.planeN);
    if (!hit) return;
    const target = [0, 1, 2].map(i => hit[i] + d.grabOffset[i]);
    const r = _poseCurrentRig();
    if (!r) return;
    const sol = poseSolveIK(r, d.ik, target);
    d.keys[d.ik.upper].ref.r = sol.upper;
    return;
  }
  const part = d.part;
  if (part.kind === 'scale') {
    const t = scClosestTOnLine(ray, part.center, part.dir) - d.t0;
    const f = Math.max(0.05, 1 + t / part.len);
    const k = d.keys.root;
    const s0 = k.start.s || [1, 1, 1];
    const ns = s0.slice();
    if (d.uniform) for (let i = 0; i < 3; i++) ns[i] = s0[i] * f;
    else ns[part.index] = s0[part.index] * f;
    k.ref.s = ns.map(v => Math.round(Math.max(0.02, v) * 1000) / 1000);
    return;
  }
  if (part.kind === 'ring') {
    const hit = scRayPlaneIntersect(ray, part.center, part.axis);
    if (!hit) return;
    let delta = _poseAngleOnRing(part, hit) - d.angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)) / _D2R;
    if (d.shift) { if (part.comp === 'y') d.puppet.base.yaw = d.startBase.yaw + delta * _D2R; return; }
    const ci = { x: 0, y: 1, z: 2 }[part.comp];
    // 選んでいる関節は全部、同じ向きに同じだけ回す(曲げるだけの関節は、前後の回転の時だけ)
    for (const j of d.joints) {
      const sg = _rigSign(d.type, j)[ci];
      if (!sg) continue;
      let v = d.keys[j].start.r[ci] + delta * sg;
      if (_rigBend(d.type, j)) v = Math.max(0, Math.min(160, v));
      else v = ((v + 180) % 360 + 360) % 360 - 180;
      d.keys[j].ref.r[ci] = Math.round(v * 10) / 10;
    }
  } else {
    const t = scClosestTOnLine(ray, part.center, d.axisDir) - d.t0;
    const w = d.axisDir.map(x => x * t);
    if (d.shift) { d.puppet.base.pos = [0, 1, 2].map(i => d.startBase.pos[i] + w[i]); return; }
    for (const j of d.joints) {
      const ax = d.parentAxes[j];
      d.keys[j].ref.p = [0, 1, 2].map(i => Math.round((d.keys[j].start.p[i] + fcVecDot(w, ax[i])) * 1000) / 1000);
    }
  }
}

function poseDragEnd() {
  if (!poseDrag) return;
  const d = poseDrag;
  poseDrag = null;
  if (d.cons) { consDragEnd(d); editorChanged(); return; }
  if (d.mp) { mpDragEnd(d); return; }
  if (d.build) { buildDragEnd(); return; }
  commitEdit();
  editorChanged();
}

// K: 選んでいる関節の今の形を、再生ヘッドの時刻のキーとして打つ
function poseRecordKeys() {
  if (!poseEntity || !poseEntityBase(poseEntity, curTick)) { showToast('キーを打つエンティティが、今の時刻に出ていません'); return; }
  pushUndo();
  const d = { key: poseEntity, type: entityRigType(poseEntity), joint: poseSelJoint };
  _poseDragPrepareKeys(d, poseSelJoints);
  showToast(`◆ ${poseSelJoints.map(j => rigJointLabel(d.type, j)).join('・')}に、${poseLocalSec(poseGetSelected(), curTick).toFixed(1)}秒のキーを打ちました`);
  editorChanged();
}

// マウスカーソルの形(乗っている物)。何も無ければ false
function poseHoverAt(mx, my) {
  poseHover = null; poseIkHover = null; if (typeof _mpHover !== "undefined") _mpHover = null;
  if ((typeof previewIsMain !== 'undefined' && previewIsMain) || (typeof pilot !== 'undefined' && pilot)) return false;
  const lc = (typeof consHoverAt === 'function') ? consHoverAt(mx, my) : false;
  if (lc) return lc;
  const { view, proj } = _fcEditViewProj();
  if (_poseEditingOn()) {
    const r = _poseCurrentRig();
    if (r) {
      const ik = _posePickIk(r, mx, my, view, proj);
      const mark = _posePickMarker(r, mx, my, view, proj);
      const part = _posePickGizmo(r, mx, my, view, proj);
      const dIk = ik ? ik.d - 1 : Infinity;
      const dMark = mark && mark.joint !== poseSelJoint ? mark.d : Infinity;
      const dPart = part ? part.d : Infinity;
      if (ik && dIk <= dMark && dIk <= dPart) { poseIkHover = ik.chain.id; return 'grab'; }
      if (mark && dMark <= dPart) return 'pointer';
      if (part) { poseHover = part; return 'grab'; }
    }
  }
  if (typeof mpHoverAt === 'function') { const m = mpHoverAt(mx, my); if (m) return m; }
  return _posePickEntity(_poseRay(mx, my)) ? 'pointer' : false;
}
let poseIkHover = null;

function poseContextHint() {
  const lh = (typeof consContextHint === 'function') ? consContextHint() : null;
  if (lh) return lh;
  if (!_poseEditingOn()) return null;
  { const mh = (typeof mpContextHint === 'function') ? mpContextHint() : null; if (mh) return mh; }
  const type = entityRigType(poseEntity);
  const name = poseEntityName(poseEntity);
  if (!poseEntityBase(poseEntity, curTick)) return `${name}は今の時刻には出ていません`;
  const jl = poseSelJoints.map(j => rigJointLabel(type, j)).join('・');
  // ステップ48: 道具ごとの短い説明
  const tool = poseToolFor(type);
  if (tool === 'ik') return `${name}: 手足の先の ○ を引っぱると、腕・脚が付いてくる`;
  if (tool === 'move') return `${name}の${jl}: 矢印をドラッグで動かす` + (RIG_TYPES[type].scalable && poseSelJoint === 'root' ? ' · □ で大きさ' : '');
  return `${name}の${jl}: リングをドラッグで回す`;
}


// ============================================================
// 置く(素材一覧から)
// ============================================================

function _posePlayerAtScreen(mx, my) {
  const hit = _posePickEntity(_poseRay(mx, my));
  return hit && hit.key.startsWith('player:') ? hit.key : null;
}

function _poseDropPoint() {
  let mx = fcCanvas.width / 2, my = fcCanvas.height / 2;
  const p = (typeof pfDropClientPoint !== 'undefined') ? pfDropClientPoint : null;
  if (p) { const r = fcCanvas.getBoundingClientRect(); mx = p.x - r.left; my = p.y - r.top; }
  return { mx, my, dropped: !!p };
}

// 人形の置き場所: 画面の点の先の、真下の地面の上。顔は今の視点の方へ
function _posePuppetPlace(mx, my) {
  const ray = _poseRay(mx, my);
  const hit = (typeof pfRaycastLocal === 'function') ? pfRaycastLocal(ray.origin, ray.dir, 80, _poseTickVal(curTick)) : null;
  const pos = hit ? hit.pos.slice() : [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * 6);
  const top = Math.floor(pos[1] + worldOriginY);
  for (let y = top; y > top - 40; y--) {
    if (pfIsSolidLocal([pos[0], y - worldOriginY - 0.5, pos[2]], _poseTickVal(curTick))) { pos[1] = y - worldOriginY; break; }
  }
  return { pos, yaw: Math.atan2(fcPos[0] - pos[0], fcPos[2] - pos[2]) };
}

function poseAddPuppet(base, type) {
  const id = nextPuppetId++;
  const p = { id, name: (type === 'block' ? 'ブロック' : '人形') + id, type: type || 'humanoid', base: { pos: base.pos.slice(), yaw: base.yaw } };
  if (type === 'block') {
    p.size = [1, 1, 1];
    const names = (typeof blockFxTextureNames === 'function') ? blockFxTextureNames() : [];
    p.texture = names.find(n => /stone|planks|brick/i.test(n)) || names[0] || null;
  }
  puppets.push(p);
  return p;
}

function _poseShownPlayerKey() {
  const sel = document.getElementById('entitySelect');
  const v = (sel && sel.value) || (allTimelines && allTimelines.localPlayerEntityId);
  return v ? 'player:' + v : null;
}

// preset: { label, tracks, loopLen, seconds, puppet? }
function addPoseAt(tick, preset) {
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = false;
  const { mx, my, dropped } = _poseDropPoint();
  let target = null;
  if (!preset.puppet) {
    if (dropped) target = _posePlayerAtScreen(mx, my);
    else target = (timelineTab === 'pose' && poseEntity) ? poseEntity : _poseShownPlayerKey();
  }
  pushUndo();
  if (!target) {
    const pup = poseAddPuppet(_posePuppetPlace(mx, my), preset.rigType || 'humanoid');
    target = 'puppet:' + pup.id;
  }
  const b = poseAddBlock(tick, target, { name: preset.label, tracks: preset.tracks, loopLen: preset.loopLen, seconds: preset.seconds });
  if (curTick < b.startTick || curTick >= b.endTick) seekTo(b.startTick);
  selectPose(b.id);
  poseExpandedId = b.id;
  poseSetJoint('root');
  openEditPanel(b);
  showToast(`🕺 ${preset.label}を${poseEntityName(target)}に付けました。3Dで手足をクリックして動かせます`);
  return b;
}


// ============================================================
// タイムライン: タブ・エンティティの行・関節の行
// ============================================================

function renderTimelineTabs() {
  // ステップ45: タブ(グローバル/ポーズ)はやめて、タイムラインは1本の一覧。人は「人」の行にまとめる
  const bar = document.getElementById('timelineTabs');
  if (bar) bar.innerHTML = '';
}

function _poseAbsTick(b, t) { return b.startTick + (t - b.offsetSec) * scTps(); }

// ステップ45: 「人」の行。ポーズのブロックがある人+選んでいる人を1人1行。選んでいる人のブロックを開くと、その下に関節の行
function _posePeopleKeys() {
  const list = poseEntityList();
  const order = new Map(list.map((e, i) => [e.key, i]));
  const set = new Set();
  for (const b of poseBlocks) if (!b.gen && order.has(b.target) && !(typeof isBlockKey === 'function' && isBlockKey(b.target))) set.add(b.target);
  if (poseEntity && order.has(poseEntity)) set.add(poseEntity);
  return { keys: [...set].sort((a, c) => order.get(a) - order.get(c)), list };
}

function _poseBuildBlockEl(b, top, ppt) {
  const el = document.createElement('div');
  const isSel = b.id === selectedPoseId;
  el.className = 'tlBlock pose' + (isSel ? ' selected' : '') + (b.id === poseExpandedId ? ' open' : '') + (b.gen ? ' gen' : '');
  el.style.left = (b.startTick * ppt) + 'px';
  el.style.width = Math.max(6, (b.endTick - b.startTick) * ppt) + 'px';
  el.style.top = top + 'px';
  const label = document.createElement('div');
  label.className = 'tlBlockLabel';
  label.innerText = b.name + (b.loopLen > 0 ? ` · くり返し${b.loopLen.toFixed(1)}秒` : '');
  el.appendChild(label);
  // ◆ = どれかの関節にキーがある時刻(ドラッグすると、その時刻の全部の関節のキーが動く)
  for (const t of poseKeyTimes(b)) {
    const at = _poseAbsTick(b, t);
    if (at < b.startTick - 1e-6 || at > b.endTick + 1e-6) continue;
    const d = document.createElement('div');
    const act = isSel && poseSelKey && poseSelKey.joint === '*' && Math.abs(poseSelKey.time - t) < 0.006;
    d.className = 'tlKey pose' + (act ? ' active' : '');
    d.style.left = ((at - b.startTick) * ppt) + 'px';
    d.title = `${t.toFixed(2)}秒のキー(全部の関節) — ドラッグでまとめて動かす / クリックで選んでその時刻へ`;
    d.addEventListener('mousedown', (e) => _poseKeyMouseDown(e, b, '*', t));
    el.appendChild(d);
  }
  _addResizeHandles(el);
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.detail >= 2) {
      e.stopPropagation(); e.preventDefault();
      tlDrag = null;
      if (curTick < b.startTick || curTick >= b.endTick) {
        if (typeof stopPlayback === 'function') stopPlayback();
        seekTo(Math.max(b.startTick, Math.min(b.endTick - 1, tlTickFromClientX(e.clientX))));
      }
      selectPose(b.id);
      poseExpandedId = b.id;
      openEditPanel(b);
      renderPoseTrackBlocks();
      return;
    }
    tlStartBlockDrag(e, 'pose', b);
  });
  return el;
}

function renderPoseTrackBlocks() {
  const box = document.getElementById('timelinePeopleRows');
  if (!box) return;
  box.innerHTML = '';
  const width = tlTotalWidth();
  const ppt = tlPxPerTick();
  const { keys, list } = _posePeopleKeys();
  const info = new Map(list.map(e => [e.key, e]));

  // 「人」のまとめの行: 人を選ぶ
  const g = _el('div', 'tlRow tlGroupRow');
  const gh = _el('div', 'tlHeader');
  gh.appendChild(_el('span', 'tlDot person'));
  gh.appendChild(_el('span', null, '人'));
  if (keys.length) gh.appendChild(_el('span', 'tlHeaderSub', String(keys.length)));
  const gl = _el('div', 'tlLane');
  gl.style.width = width + 'px';
  const pick = _el('div', 'tlPeoplePick');
  const sel = document.createElement('select');
  sel.className = 'tlEntitySelect';
  sel.title = '動かす人・人形・ブロックを選ぶ';
  const o0 = document.createElement('option'); o0.value = ''; o0.innerText = '＋ 動かす人を選ぶ'; sel.appendChild(o0);
  for (const e of list) {
    const o = document.createElement('option');
    o.value = e.key; o.innerText = e.name + '(' + RIG_TYPES[e.type].label + ')';
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { if (sel.value) poseSelectEntity(sel.value); sel.blur(); });
  pick.appendChild(sel);
  if (!keys.length) pick.appendChild(_el('span', 'tlPeopleNote', '3Dで人をクリックしても選べます'));
  gl.appendChild(pick);
  g.appendChild(gh); g.appendChild(gl);
  box.appendChild(g);

  for (const key of keys) {
    const mine = poseBlocks.filter(b => b.target === key);
    // 重なるブロックは段を分ける
    const sorted = mine.slice().sort((a, c) => a.startTick - c.startTick);
    const rowEnds = [], rows = new Map();
    for (const b of sorted) {
      let r = rowEnds.findIndex(end => end <= b.startTick);
      if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
      rowEnds[r] = b.endTick; rows.set(b.id, r);
    }
    const h = Math.max(1, rowEnds.length) * TL_ROW_H;
    const isSel = key === poseEntity;
    const row = _el('div', 'tlRow tlPersonRow' + (isSel ? ' selected' : ''));
    row.dataset.key = key;
    row.style.height = h + 'px';
    const header = _el('div', 'tlHeader');
    const nm = _el('span', 'tlPersonName', (info.get(key) || {}).name || key);
    header.appendChild(nm);
    header.title = 'クリックでこの人を選ぶ';
    header.addEventListener('mousedown', (e) => { e.stopPropagation(); if (poseEntity !== key) poseSelectEntity(key); });
    const lane = _el('div', 'tlLane');
    lane.style.width = width + 'px';
    lane.style.height = h + 'px';
    for (const b of mine) lane.appendChild(_poseBuildBlockEl(b, (rows.get(b.id) || 0) * TL_ROW_H + 3, ppt));
    if (isSel && !mine.length) lane.appendChild(_el('div', 'tlEmpty', '3Dで体を動かすと、ここにポーズができます'));
    row.appendChild(header); row.appendChild(lane);
    box.appendChild(row);
    if (isSel) _poseRenderJointRows(box, key, width, ppt);
  }
}

// 関節の行(ブロックをダブルクリックすると全部出る)
function _poseRenderJointRows(jointRows, key, width, ppt) {
  const b = poseExpandedId != null ? poseGet(poseExpandedId) : null;
  if (!b || b.target !== key) return;
  const type = entityRigType(b.target);
  for (const j of rigJoints(type)) {
    const expanded = j === poseSelJoint;
    const row = _el('div', 'tlRow tlJointRow' + (expanded ? ' expanded' : '') + (poseJointSelected(j) ? ' selected' : ''));
    row.dataset.joint = j;
    row.style.height = (expanded ? POSE_JOINT_ROW_EXPANDED_H : POSE_JOINT_ROW_H) + 'px';
    const header = _el('div', 'tlHeader');
    const tr = b.tracks[j] || [];
    header.appendChild(_el('span', null, rigJointLabel(type, j)));
    header.appendChild(_el('span', 'tlHeaderSub', tr.length ? `◆${tr.length}` : ''));
    header.style.cursor = 'pointer';
    header.addEventListener('mousedown', (e) => { e.stopPropagation(); poseSetJoint(j, e.shiftKey); editorChanged(); });
    const jl = _el('div', 'tlLane');
    jl.style.width = width + 'px';
    const zone = _el('div', 'tlJointZone');
    zone.style.left = (b.startTick * ppt) + 'px';
    const zw = Math.max(6, (b.endTick - b.startTick) * ppt);
    zone.style.width = zw + 'px';
    if (expanded) zone.appendChild(_poseCurveGraph(b, j, zw, POSE_JOINT_ROW_EXPANDED_H));
    tr.forEach((k, i) => {
      const at = _poseAbsTick(b, k.time);
      if (at < b.startTick - 1e-6 || at > b.endTick + 1e-6) return;
      const d = document.createElement('div');
      const act = b.id === selectedPoseId && poseSelKey && poseSelKey.joint === j && poseSelKey.index === i;
      d.className = 'tlKey pose joint' + (act ? ' active' : '');
      d.style.left = ((at - b.startTick) * ppt) + 'px';
      d.title = `${rigJointLabel(type, j)} ${k.time.toFixed(2)}秒 — ドラッグで時刻を変える / クリックで選ぶ(Deleteで削除)`;
      d.addEventListener('mousedown', (e) => _poseKeyMouseDown(e, b, j, i));
      zone.appendChild(d);
    });
    jl.appendChild(zone);
    row.appendChild(header); row.appendChild(jl);
    jointRows.appendChild(row);
  }
}

// ◆のドラッグ。joint='*' はブロックの行の◆(その時刻の全部の関節のキー)
function _poseKeyMouseDown(e, b, joint, which) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  beginEdit();
  const tps = scTps();
  const startX = e.clientX;
  const keys = joint === '*'
    ? Object.values(b.tracks).flat().filter(k => Math.abs(k.time - which) < 0.006)
    : [b.tracks[joint][which]];
  const t0 = keys[0].time;
  // 同じ関節の隣のキー(一緒に動かさない物)を追い越さない範囲
  let lo = -Infinity, hi = Infinity;
  for (const tr of Object.values(b.tracks)) {
    for (let i = 0; i < tr.length; i++) {
      if (!keys.includes(tr[i])) continue;
      if (tr[i - 1] && !keys.includes(tr[i - 1])) lo = Math.max(lo, tr[i - 1].time + 0.05);
      if (tr[i + 1] && !keys.includes(tr[i + 1])) hi = Math.min(hi, tr[i + 1].time - 0.05);
    }
  }
  let moved = false;
  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    let t = t0 + dx / tlPxPerTick() / tps;
    const sn = tlSnap(_poseAbsTick(b, t), tlSnapCandidates({ kind: 'pose', id: b.id }, false), ev);
    t = Math.max(lo, Math.min(hi, b.offsetSec + (sn.tick - b.startTick) / tps));
    for (const k of keys) k.time = t;
    seekTo(_poseAbsTick(b, t));
    renderPoseTrackBlocks();
    if (typeof renderBlockTrackBlocks === 'function') renderBlockTrackBlocks();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) {
      if (typeof stopPlayback === 'function') stopPlayback();
      seekTo(_poseAbsTick(b, t0));
    }
    selectPose(b.id);
    poseExpandedId = b.id;
    if (joint === '*') poseSelKey = { joint: '*', time: keys[0].time };
    else { poseSetJoint(joint, false); poseSelKey = { joint, index: b.tracks[joint].indexOf(keys[0]) }; }
    poseSelKeyExplicit = true;
    commitEdit();
    editorChanged();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 関節の速さのカーブのグラフ(カメラと同じ見た目・操作)
function _poseCurveGraph(b, joint, widthPx, rowH) {
  const wrap = _el('div', 'tlCurveGraph');
  wrap.style.top = '4px';
  const H = rowH - 22;
  wrap.style.height = H + 'px';
  const tr = b.tracks[joint] || [];
  if (tr.length < 2) {
    wrap.appendChild(_el('div', 'tlCurveEmpty', 'この関節のキーが2つ以上になると、ここで動きの速さを調整できます'));
    return wrap;
  }
  const svg = _svg('svg', { width: widthPx, height: H });
  wrap.appendChild(svg);
  _poseDrawCurve(svg, b, joint);
  return wrap;
}

function _poseSegGeom(b, tr, i, H) {
  const ppt = tlPxPerTick();
  const x0 = (_poseAbsTick(b, tr[i].time) - b.startTick) * ppt, x1 = (_poseAbsTick(b, tr[i + 1].time) - b.startTick) * ppt;
  return { x0, x1, w: x1 - x0, yb: H - 4, H: H - 8 };
}

function _poseDrawCurve(svg, b, joint) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const H = parseFloat(svg.getAttribute('height'));
  const tr = b.tracks[joint];
  const segAt = _poseSegAt(b, joint, curTick);
  for (let i = 0; i < tr.length - 1; i++) {
    const g = _poseSegGeom(b, tr, i, H);
    if (g.w <= 1) continue;
    const c = scKeyCurve(tr[i]);
    const P = (nx, ny) => [g.x0 + nx * g.w, g.yb - ny * g.H];
    const [ax, ay] = P(0, 0), [bx, by] = P(1, 1), [h1x, h1y] = P(c[0], c[1]), [h2x, h2y] = P(c[2], c[3]);
    svg.appendChild(_svg('rect', { x: g.x0, y: 2, width: g.w, height: H - 4, class: 'tlCurveSeg' + (i === segAt ? ' hot' : '') }));
    svg.appendChild(_svg('path', { d: `M${ax},${ay} C${h1x},${h1y} ${h2x},${h2y} ${bx},${by} L${bx},${ay} Z`, class: 'tlCurveFill pose' }));
    svg.appendChild(_svg('path', { d: `M${ax},${ay} C${h1x},${h1y} ${h2x},${h2y} ${bx},${by}`, class: 'tlCurveLine pose' }));
    const pid = scCurvePresetId(tr[i].curve);
    if (g.w > 74) {
      const t = _svg('text', { x: g.x0 + 5, y: 12, class: 'tlCurveLabel' });
      t.textContent = pid ? CURVE_PRESETS[pid].label : 'カスタム';
      svg.appendChild(t);
    }
    svg.appendChild(_svg('line', { x1: ax, y1: ay, x2: h1x, y2: h1y, class: 'tlCurveArm' }));
    svg.appendChild(_svg('line', { x1: bx, y1: by, x2: h2x, y2: h2y, class: 'tlCurveArm' }));
    for (const which of [0, 1]) {
      const [hx, hy] = which ? [h2x, h2y] : [h1x, h1y];
      const h = _svg('circle', { cx: hx, cy: hy, r: 5, class: 'tlCurveHandle' });
      h.addEventListener('mousedown', (e) => _posePointerCurve(e, svg, b, joint, i, which));
      svg.appendChild(h);
    }
  }
}

function _poseSegAt(b, joint, tick) {
  const tr = b.tracks[joint] || [];
  if (tr.length < 2) return -1;
  const s = poseLocalSec(b, tick);
  let i = 0;
  while (i < tr.length - 2 && s >= tr[i + 1].time) i++;
  return i;
}

function _posePointerCurve(e, svg, b, joint, seg, which) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  beginEdit();
  const H = parseFloat(svg.getAttribute('height'));
  const tr = b.tracks[joint];
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const g = _poseSegGeom(b, tr, seg, H);
    const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left - g.x0) / g.w));
    const ny = Math.max(0, Math.min(1, (rect.top + g.yb - ev.clientY) / g.H));
    const c = scKeyCurve(tr[seg]).slice();
    if (which === 0) { c[0] = nx; c[1] = ny; } else { c[2] = nx; c[3] = ny; }
    if (ev.shiftKey) { if (which === 0) { c[2] = 1 - nx; c[3] = 1 - ny; } else { c[0] = 1 - nx; c[1] = 1 - ny; } }
    tr[seg].curve = c;
    _poseDrawCurve(svg, b, joint);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    commitEdit();
    editorChanged();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 選んでいるキーを消す(Delete)。消したら true
function poseDeleteSelectedKey() {
  const b = poseGetSelected();
  if (!b || !poseSelKeyExplicit || !poseSelKey) return false;
  if (poseSelKey.joint === '*') {
    for (const j in b.tracks) b.tracks[j] = b.tracks[j].filter(k => Math.abs(k.time - poseSelKey.time) >= 0.006);
  } else {
    const tr = b.tracks[poseSelKey.joint];
    if (!tr || !tr[poseSelKey.index]) return false;
    tr.splice(poseSelKey.index, 1);
  }
  poseSelKey = null; poseSelKeyExplicit = false;
  return true;
}


// ============================================================
// 右の編集パネル
// ============================================================

function renderPoseEditFields(title, body, b) {
  // ブロックは、ブロック用のパネル(blocks.js)
  { const bp = b.target.startsWith('puppet:') ? puppetGet(+b.target.slice(7)) : null;
    if (bp && bp.type === 'block' && typeof renderBlockEditFields === 'function') { renderBlockEditFields(title, body, b, bp); return; } }
  // 全体アニメ(スクリプト)で作ったブロック: 設定を変えると作り直せる。行から選んだ時は、その設定だけ
  if (b.gen && typeof renderAnimGenSection === 'function') {
    renderAnimGenSection(title, body, b);
    if (typeof animGroupSelected === 'function' && animGroupSelected()) return;
  }
  const type = entityRigType(b.target);
  // ステップ48: 見出し = 動かす人の名前、その下に ブロックの名前と時刻
  if (!b.gen) {
    title.innerText = poseEntityName(b.target);
    const sub = document.getElementById('editPanelSub');
    if (sub) sub.textContent = `${RIG_TYPES[type].label} · ${b.name}(${(b.startTick / scTps()).toFixed(1)}〜${(b.endTick / scTps()).toFixed(1)}秒)`;
  }
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };

  const nameRow = row('名前');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = b.name;
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { b.name = nameInput.value; renderPoseTrackBlocks(); });
  nameRow.appendChild(nameInput);


  // ブロックのエンティティ: 絵と、もとの大きさ
  const pup = b.target.startsWith('puppet:') ? puppetGet(+b.target.slice(7)) : null;
  if (pup && pup.type === 'block') {
    sec('ブロックの絵');
    if (typeof renderBlockTexturePicker === 'function') renderBlockTexturePicker(body, pup);
  }
  if (pup && typeof renderConsPanel === 'function') renderConsPanel(body, pup);
  if (pup && pup.type === 'block') {
    sec('もとの大きさ(ブロック)');
    ['幅', '高さ', '奥行き'].forEach((label, i) => {
      const r = row(label);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = '0.1'; inp.max = '20'; inp.step = '0.1'; inp.value = pup.size[i];
      const v = _el('span', 'fieldValue', pup.size[i].toFixed(1));
      bindEditUndo(inp);
      inp.addEventListener('input', () => { pup.size[i] = parseFloat(inp.value); v.innerText = pup.size[i].toFixed(1); });
      r.appendChild(inp); r.appendChild(v);
    });
    body.appendChild(_el('div', 'panelHint', '時間で大きさを変える時は、3Dで全体を選んで、四角の付いた線(大きさのハンドル)をドラッグします(Shiftで縦横奥行きを同じ割合で)。再生ヘッドの時刻にキーができます。'));
  }

  // 関節(ステップ46: 人型は人の形の図で選ぶ)
  sec('動かす関節');
  if (type === 'humanoid' && typeof uiBodyPicker === 'function') {
    const counts = {};
    for (const j of rigJoints(type)) counts[j] = (b.tracks[j] || []).length;
    body.appendChild(uiBodyPicker(type, (j, add) => { poseSetJoint(j, add); editorChanged(); }, counts));
  }
  const group = _el('div', 'settingsRadioGroup' + (type === 'humanoid' ? ' hiddenPills' : ''));
  for (const j of rigJoints(type)) {
    const n = (b.tracks[j] || []).length;
    const pill = _el('button', 'settingsRadioPill small' + (poseJointSelected(j) ? ' active' : ''), rigJointLabel(type, j) + (n ? ` ◆${n}` : ''));
    pill.type = 'button';
    pill.addEventListener('click', (e) => { poseSetJoint(j, e.shiftKey); editorChanged(); });
    group.appendChild(pill);
  }
  body.appendChild(group);
  const groups = RIG_TYPES[type].groups || [];
  if (groups.length) {
    const gRow = _el('div', 'fieldRow column');
    gRow.appendChild(_el('label', null, 'まとめて選ぶ'));
    const gg = _el('div', 'settingsRadioGroup');
    for (const [label, list] of groups) {
      const same = list.length === poseSelJoints.length && list.every(j => poseJointSelected(j));
      const pill = _el('button', 'settingsRadioPill small' + (same ? ' active' : ''), label);
      pill.type = 'button';
      pill.addEventListener('click', () => { poseSetJoints(list); editorChanged(); });
      gg.appendChild(pill);
    }
    gRow.appendChild(gg);
    body.appendChild(gRow);
  }
  const keyRow = _el('div', 'panelActions');
  const keyBtn = _el('button', 'btn btn-primary btn-sm', '◆ 選んでいる関節にキーを打つ (K)');
  keyBtn.addEventListener('click', () => poseRecordKeys());
  keyRow.appendChild(keyBtn);
  body.appendChild(keyRow);

  // 速さのカーブ(選んでいる関節の、再生ヘッドがある区間)
  sec(`次のキーまでの進み方(${rigJointLabel(type, poseSelJoint)})`);
  const seg = _poseSegAt(b, poseSelJoint, curTick);
  if (seg < 0) {
    body.appendChild(_el('div', 'panelHint', 'この関節のキーが2つ以上になると、キーの間の進み方(ゆっくり始まる・なめらかに止まる等)を選べます。'));
  } else {
    const tr = b.tracks[poseSelJoint];
    const cur = scCurvePresetId(tr[seg].curve);
    body.appendChild(_el('div', 'curveSegLabel', `◆${seg + 1} → ◆${seg + 2} の区間(再生ヘッドの位置)`));
    const cg = _el('div', 'settingsRadioGroup');
    for (const [id, p] of Object.entries(CURVE_PRESETS)) {
      const pill = _el('button', 'settingsRadioPill curvePill' + (cur === id ? ' active' : ''));
      pill.type = 'button';
      pill.appendChild(_curveIcon(p.c));
      pill.appendChild(document.createTextNode(p.label));
      pill.addEventListener('click', () => { if (cur === id) return; pushUndo(); tr[seg].curve = p.c.slice(); editorChanged(); });
      cg.appendChild(pill);
    }
    body.appendChild(cg);
    const acts = _el('div', 'genActions');
    const allJ = _el('button', 'btn btn-ghost btn-sm', 'この関節の全区間に');
    allJ.addEventListener('click', () => { pushUndo(); const c = scKeyCurve(tr[seg]); tr.forEach(k => { k.curve = c.slice(); }); editorChanged(); });
    const allB = _el('button', 'btn btn-ghost btn-sm', '全部の関節に');
    allB.addEventListener('click', () => { pushUndo(); const c = scKeyCurve(tr[seg]); for (const t of Object.values(b.tracks)) t.forEach(k => { k.curve = c.slice(); }); editorChanged(); showToast('全部の関節のキーに同じカーブを使いました'); });
    acts.appendChild(allJ); acts.appendChild(allB);
    body.appendChild(acts);
  }

  const resetRow = _el('div', 'panelActions');
  const reset = _el('button', 'btn btn-ghost btn-sm', 'この時刻で、まっすぐに戻す');
  reset.addEventListener('click', () => {
    if (curTick < b.startTick || curTick >= b.endTick) { showToast('再生ヘッドをこのブロックの上に合わせてください'); return; }
    pushUndo();
    for (const j of poseSelJoints) { const k = poseEditJointKey(b, j, curTick).key; k.r = [0, 0, 0]; k.p = [0, 0, 0]; delete k.s; }
    editorChanged();
  });
  resetRow.appendChild(reset);
  body.appendChild(resetRow);

  // ステップ45: 自動アニメーションの設定(前はタイムラインのタブの行にあった)。全員に効く
  if (typeof renderAutoAnimControls === 'function' && RIG_TYPES[type].bones.length) {
    sec('自動アニメーション(全員)');
    const holder = _el('div', 'aaPanel');
    renderAutoAnimControls(holder);
    holder.addEventListener('click', () => setTimeout(() => { if (typeof refreshEditPanelIfOpen === 'function') refreshEditPanelIfOpen(); }, 0));
    body.appendChild(holder);
  }
  if (typeof renderMotionPathPanel === 'function') renderMotionPathPanel(body, b);   // ステップ43

  // くり返し・長さ
  sec('くり返しと長さ');
  const loopRow = _el('label', 'scriptCheck');
  const loop = document.createElement('input');
  loop.type = 'checkbox'; loop.checked = b.loopLen > 0;
  loop.addEventListener('change', () => {
    pushUndo();
    const last = Math.max(0, ...poseKeyTimes(b));
    b.loopLen = loop.checked ? Math.max(0.2, last || 1) : 0;
    editorChanged();
  });
  loopRow.appendChild(loop);
  loopRow.appendChild(document.createTextNode('くり返す'));
  body.appendChild(loopRow);
  if (b.loopLen > 0) {
    const lr = row('1回の長さ');
    const li = document.createElement('input');
    li.type = 'number'; li.step = '0.05'; li.min = '0.1'; li.className = 'panelInput small'; li.value = b.loopLen.toFixed(2);
    bindEditUndo(li);
    li.addEventListener('change', () => { const v = parseFloat(li.value); if (v > 0.05) { b.loopLen = v; editorChanged(); } });
    lr.appendChild(li); lr.appendChild(_el('span', 'fieldUnit', '秒'));
  }
  const durRow = row('ブロックの長さ');
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
  durRow.appendChild(dur);
  durRow.appendChild(_el('span', 'fieldUnit', '秒'));

  body.appendChild(_el('div', 'panelHint', '3Dで体をクリックすると、その関節にリング(赤=前後・緑=ひねり・青=横)と矢印(位置)が出ます。' +
    '手足の先の水色の○をドラッグすると、腕・脚が自動で曲がって先が付いてきます(IK)。Shift+クリックで関節をまとめて選ぶと、一緒に回せます。' +
    'ドラッグすると、動かした関節だけの◆キーが再生ヘッドの時刻にできます。その関節の最初のキーなら、ブロックの始めに初期状態のキーも自動で置くので、1回動かすだけで動きになります。キーは関節ごとの行に並びます(ブロックをダブルクリックで全部の行が開く)。' +
    (b.target.startsWith('puppet:') ? '人形は、全体を Shift+ドラッグで置き場所ごと動かせます。' : '')));

  const actions = _el('div', 'panelActions');
  const save = _el('button', 'btn btn-ghost btn-sm', '素材に保存');
  save.addEventListener('click', () => savePoseAsCustom(b));
  actions.appendChild(save);
  const delBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', 'このブロックを消す');
  delBtn.addEventListener('click', () => { selectPose(b.id); poseSelKeyExplicit = false; deleteSelection(); });
  actions.appendChild(delBtn);
  body.appendChild(actions);
}


// ============================================================
// 公式のポーズ・カスタム
// ============================================================

// 公式のポーズは「全身のポーズの並び」で書いて、関節ごとのキーに変える(0のままの関節はキーを作らない)
function _poseTracksFromFrames(frames) {
  const tracks = {};
  for (const j of rigJoints('humanoid')) {
    const used = frames.some(f => (f.pose[j] && f.pose[j].some(v => v)) || (j === 'root' && f.pose.rootPos && f.pose.rootPos.some(v => v)));
    if (!used) continue;
    tracks[j] = frames.map(f => ({
      time: f.time,
      r: (f.pose[j] || [0, 0, 0]).slice(),
      p: j === 'root' ? (f.pose.rootPos || [0, 0, 0]).slice() : [0, 0, 0],
      curve: CURVE_PRESETS.smooth.c.slice(),
    }));
  }
  return tracks;
}
function _preset(o) {
  const last = o.frames[o.frames.length - 1].time;
  return { id: o.id, icon: o.icon, label: o.label, desc: o.desc, puppet: !!o.puppet, seconds: o.seconds,
           loopLen: o.loop ? last : 0, tracks: _poseTracksFromFrames(o.frames) };
}

const OFFICIAL_POSES = [
  _preset({ id: 'puppet', icon: '🧸', label: '人形を出す', desc: 'まっすぐ立った人形', puppet: true, seconds: 3, frames: [{ time: 0, pose: {} }] }),
  _preset({ id: 'wave', icon: '👋', label: '手を振る', desc: '右手を上げて振る', loop: true, seconds: 3, frames: [
    { time: 0, pose: { armR: [10, 0, 140], head: [0, 0, 5] } },
    { time: 0.35, pose: { armR: [10, 0, 165], head: [0, 0, 5] } },
    { time: 0.7, pose: { armR: [10, 0, 140], head: [0, 0, 5] } },
  ] }),
  _preset({ id: 'walk', icon: '🚶', label: '歩く', desc: '手足を交互に振る', loop: true, seconds: 4, frames: [
    { time: 0, pose: { legR: [28, 0, 0], legL: [-28, 0, 0], armR: [-25, 0, 3], armL: [25, 0, 3] } },
    { time: 0.5, pose: { legR: [-28, 0, 0], legL: [28, 0, 0], armR: [25, 0, 3], armL: [-25, 0, 3] } },
    { time: 1, pose: { legR: [28, 0, 0], legL: [-28, 0, 0], armR: [-25, 0, 3], armL: [25, 0, 3] } },
  ] }),
  _preset({ id: 'run', icon: '🏃', label: '走る', desc: '前かがみで大きく振る', loop: true, seconds: 4, frames: [
    { time: 0, pose: { body: [14, 0, 0], head: [-10, 0, 0], legR: [55, 0, 0], legL: [-40, 0, 0], armR: [-50, 0, 5], armL: [55, 0, 5], rootPos: [0, 0.08, 0] } },
    { time: 0.3, pose: { body: [14, 0, 0], head: [-10, 0, 0], legR: [-40, 0, 0], legL: [55, 0, 0], armR: [55, 0, 5], armL: [-50, 0, 5], rootPos: [0, 0.08, 0] } },
    { time: 0.6, pose: { body: [14, 0, 0], head: [-10, 0, 0], legR: [55, 0, 0], legL: [-40, 0, 0], armR: [-50, 0, 5], armL: [55, 0, 5], rootPos: [0, 0.08, 0] } },
  ] }),
  _preset({ id: 'cheer', icon: '🙌', label: 'バンザイ', desc: '両手を上げて跳ねる', loop: true, seconds: 3, frames: [
    { time: 0, pose: { armR: [0, 0, 165], armL: [0, 0, 165], legR: [15, 0, 0], legL: [15, 0, 0], rootPos: [0, -0.06, 0] } },
    { time: 0.3, pose: { armR: [0, 0, 170], armL: [0, 0, 170], head: [-15, 0, 0], rootPos: [0, 0.45, 0] } },
    { time: 0.6, pose: { armR: [0, 0, 165], armL: [0, 0, 165], legR: [15, 0, 0], legL: [15, 0, 0], rootPos: [0, -0.06, 0] } },
  ] }),
  _preset({ id: 'dance', icon: '💃', label: 'ダンス', desc: '体をゆらして踊る', loop: true, seconds: 4, frames: [
    { time: 0, pose: { body: [0, 15, 10], head: [0, -10, -8], armR: [30, 0, 100], armL: [-10, 0, 30], legR: [12, 0, 0] } },
    { time: 0.5, pose: { body: [0, -15, -10], head: [0, 10, 8], armL: [30, 0, 100], armR: [-10, 0, 30], legL: [12, 0, 0] } },
    { time: 1, pose: { body: [0, 15, 10], head: [0, -10, -8], armR: [30, 0, 100], armL: [-10, 0, 30], legR: [12, 0, 0] } },
  ] }),
  _preset({ id: 'bow', icon: '🙇', label: 'おじぎ', desc: 'ゆっくり頭を下げる', seconds: 2, frames: [
    { time: 0, pose: {} },
    { time: 0.5, pose: { body: [45, 0, 0], head: [10, 0, 0], armR: [8, 0, 0], armL: [8, 0, 0] } },
    { time: 1.2, pose: { body: [45, 0, 0], head: [10, 0, 0], armR: [8, 0, 0], armL: [8, 0, 0] } },
    { time: 1.8, pose: {} },
  ] }),
  _preset({ id: 'point', icon: '👉', label: '指さす', desc: '右手で前を指す', seconds: 2, frames: [
    { time: 0, pose: { armR: [90, -10, 0], head: [0, -8, 0], body: [0, -8, 0] } }] }),
  _preset({ id: 'sit', icon: '🪑', label: '座る', desc: '地面に座る', seconds: 3, frames: [
    { time: 0, pose: { legR: [85, 0, 4], legL: [85, 0, 4], armR: [-25, 0, 8], armL: [-25, 0, 8], body: [-8, 0, 0], rootPos: [0, -0.52, 0] } }] }),
  _preset({ id: 'sleep', icon: '😴', label: '寝る', desc: 'あお向けに寝ころぶ', seconds: 3, frames: [
    { time: 0, pose: { root: [-90, 0, 0], armR: [0, 0, 25], armL: [0, 0, 25], rootPos: [0, -0.77, 0] } }] }),
];

const LS_CUSTOM_POSES = 'bloxdEditor.customPoses.v1';
let customPoses = (() => {
  let list;
  try { list = JSON.parse(localStorage.getItem(LS_CUSTOM_POSES) || '[]'); } catch (e) { list = []; }
  // ステップ13の形(全身のキーの並び keys)で保存された物は、関節ごとのキーに直す
  return list.map(c => {
    if (c.tracks || !c.keys) return c;
    const last = c.keys.length ? c.keys[c.keys.length - 1].time : 0;
    return { id: c.id, icon: c.icon || '⭐', label: c.label, desc: c.desc, seconds: c.seconds,
             loopLen: c.loop ? last : 0, tracks: _poseTracksFromFrames(c.keys) };
  });
})();
function _saveCustomPoses() { try { localStorage.setItem(LS_CUSTOM_POSES, JSON.stringify(customPoses)); } catch (e) { /* 保存できなくても続ける */ } }

function savePoseAsCustom(b) {
  // くり返さない時は、ブロックの先頭(offsetSec)を0にそろえて保存する
  const shift = b.loopLen > 0 ? 0 : b.offsetSec;
  const tracks = {};
  for (const [j, tr] of Object.entries(b.tracks)) {
    if (!tr.length) continue;
    tracks[j] = tr.map(k => {
      const o = { time: +(k.time - shift).toFixed(3), r: k.r.slice(), p: k.p.slice() };
      if (k.curve) o.curve = k.curve.slice();
      return o;
    });
  }
  const n = Object.values(tracks).reduce((a, t) => a + t.length, 0);
  customPoses.push({
    id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: b.name, icon: '⭐', loopLen: b.loopLen, seconds: +((b.endTick - b.startTick) / scTps()).toFixed(2), tracks,
    desc: `関節${Object.keys(tracks).length}つ・キー${n}個` + (b.loopLen > 0 ? '・くり返し' : ''),
  });
  _saveCustomPoses();
  activeAssetCategoryId = 'pose'; activeAssetSource = 'custom'; assetListCollapsed = false;
  renderAssetRail(); renderAssetList();
  showToast(`⭐ 「${b.name}」をカスタム素材に保存しました`);
}

function isPoseAssetKey(key) { return /^(pose|cpose):/.test(String(key)); }
function addPoseAsset(key, tick) {
  const [kind, id] = String(key).split(':');
  const preset = kind === 'pose' ? OFFICIAL_POSES.find(p => p.id === id) : customPoses.find(p => p.id === id);
  if (preset) addPoseAt(tick, preset);
}

function renderPoseAssets(list, source) {
  if (source === 'public') { _renderPublic(list, ASSET_CATEGORIES.find(c => c.id === 'pose')); return; }
  const grid = _div('assetGrid');
  const items = source === 'official' ? OFFICIAL_POSES : customPoses;
  if (!items.length) {
    const empty = _div('assetSoon');
    empty.innerHTML = '<b>まだカスタムのポーズはありません</b>';
    const p = document.createElement('p');
    p.innerText = 'ポーズのブロックをダブルクリックして「⭐ このポーズの動きをカスタムに保存」で作れます。';
    empty.appendChild(p);
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const key = (source === 'official' ? 'pose:' : 'cpose:') + item.id;
    const card = _makeCard(key, 'pose', item.icon, item.label, item.desc || '', null);
    if (source === 'custom') {
      card.classList.add('custom');
      _cardButton(card, '✕', 'この素材を削除', () => {
        customPoses = customPoses.filter(x => x.id !== item.id);
        _saveCustomPoses();
        renderAssetList();
        showToast(`「${item.label}」を削除しました`);
      });
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
  list.appendChild(_div('assetHint', 'クリックすると、ポーズのタブで選んでいるエンティティ(選んでいなければ右下で選んでいるプレイヤー)に付きます。3D画面のプレイヤーの上にドラッグするとその人に、地面にドラッグするとそこに人形が出ます。'));
}
