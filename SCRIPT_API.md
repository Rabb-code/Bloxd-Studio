# カメラスクリプト API(バージョン 1)

Bloxd Replay Editor の **カメラの素材は、どれも小さな JavaScript(カメラスクリプト)** です。
素材を置くと、その場でスクリプトが動いて **カメラとキーが作られます**。Ctrl+Z 1回で元に戻せます。

作ったカメラは「どのスクリプトの、どの設定で作ったか」を覚えています。
カメラをダブルクリックした右パネルで設定を変えると、**その場で作り直されます**(同じ置いた時刻・同じプレイヤー・置いた時の視点で)。
手でポイントを直した後に作り直す時は、確認が出ます。「✂ 切り離す」で、ふつうのカメラにできます。

- 置き場所: 左の素材一覧 → 🎥 カメラ(公式 / カスタム / 公開)
- 書く: カスタム → 「＋ 新しく書く」。公式の素材は `</>` から中身を見て「コピーして編集」できます
- 保存: ⚙ で設定を変えて「⭐ 保存」、またはカメラの右パネルの「⭐ このカメラをカスタムに保存」(動きを再現するスクリプトが作られます)
- 渡す: カスタムのカードの「⬇」で .js を書き出す。もらった側は「⬆ 読み込む」

## 安全のしくみ

スクリプトは、ページから切り離された場所(別オリジンの sandbox iframe の中の Web Worker)で動きます。

- ネットワーク(fetch / XMLHttpRequest / WebSocket / importScripts)は使えません
- エディタのページ・DOM・保存データ(localStorage 等)には触れません
- 15秒で終わらなければ打ち切られます(無限ループでも画面は固まりません)
- スクリプトが出した命令は、エディタ側で全部チェックしてから反映します。1つでもおかしな命令があれば何も反映しません

そのため、他の人が書いたスクリプトでも安心して試せます。

## 単位と座標

| もの | 単位 |
|---|---|
| 位置 `pos` | Bloxd のワールド座標 `[x, y, z]`(画面左上に出ている座標と同じ) |
| 向き `yaw` / `pitch` | 度。`yaw = 0` が +Z 方向、`yaw = 90` が +X 方向。`pitch` は上が + (−88〜88) |
| `tick` | リプレイのコマ番号。`api.tps` コマ = 1秒 |
| キーの `time` | カメラブロックの先頭からの **秒** |

## 書き方の基本

カメラは `api.start`(素材を置いた時刻)から始めます。

```js
api.info({ name: '真上から見る', description: '置いた所に、真上から見下ろすカメラを置く' });

const p = api.params({
  height:  { type: 'number', label: '高さ', min: 5, max: 40, step: 1, default: 18, unit: 'ブロック' },
  seconds: { type: 'number', label: '長さ', min: 1, max: 20, step: 0.5, default: 3, unit: '秒' },
});

const f = api.player().at(api.start);
api.addCamera({
  start: api.start,
  seconds: p.seconds,
  name: '真上',
  keys: [{ time: 0, pos: [f.head[0], f.head[1] + p.height, f.head[2] + 0.1], lookAt: f.head }],
});
```

- スクリプトは関数の中身として実行されます。一番外側で `return` や `await` が使えます
- `api.info` と `api.params` は、スクリプトの **最初の方** に書いてください。
  エディタは ⚙ や右パネルに設定項目を出すため、`api.params` の所まで(隔離した場所で)スクリプトを動かして項目を読み取ります
- 1回で何台カメラを作っても構いません(例: 公式の「自動カット割り」)。作り直す時は、まとめて作り直されます
- 作り直しても同じ結果になるよう、`Math.random()` ではなく `api.math.random(seed)` を使ってください

## 情報・設定

| API | 説明 |
|---|---|
| `api.version` | この API のバージョン(今は `1`) |
| `api.info({ name, description })` | スクリプトの名前と説明(読み込んだ時の名前・説明に使われます) |
| `api.params(defs)` | 設定項目を定義し、今の値のオブジェクトを返す(下を参照) |
| `api.tps` | 1秒あたりのコマ数 |
| `api.totalTicks` | リプレイ全体のコマ数 |
| `api.start` | **カメラを置く時刻**(tick)。素材を落とした時刻。作り直す時も同じ |
| `api.playhead` | 今の再生ヘッドの tick(作り直す時は `api.start` と違うことがあります) |
| `api.toTick(秒)` / `api.toSec(tick)` | 秒 ⇄ tick |
| `api.view` | 置いた時の編集視点 `{ pos, yaw, pitch, fov }` |

### 設定項目の種類

```js
api.params({
  dist:  { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 6, unit: 'ブロック' }, // スライダー
  aim:   { type: 'bool',   label: 'プレイヤーの方を向く', default: true },                         // チェック
  mode:  { type: 'choice', label: '動き方', options: [['なめらか', 'smooth'], ['等速', 'linear']], default: 'smooth' }, // ボタン
  title: { type: 'text',   label: '文字', default: 'スタート!' },                                   // 文字入力
});
```

設定した値は、スクリプトごとにブラウザに保存されます。

## プレイヤー

| API | 説明 |
|---|---|
| `api.players()` | 全員の `{ id, name, isMe }` |
| `api.player(id?)` | プレイヤーを取得。省略すると右下で選んでいる人 |
| `player.id` / `player.name` / `player.isMe` / `player.ticks` | 基本情報 |
| `player.at(tick)` | その時刻の状態(範囲外は端に寄せる) |

`player.at(tick)` が返すもの:

| 項目 | 説明 |
|---|---|
| `pos` | 足元の位置 |
| `head` | 目の位置(足元 + 1.5) |
| `yaw` / `pitch` | 向き(度) |
| `pose` | 姿勢の名前(例: `'walk'`) |
| `held` | 持っているアイテムの名前(無ければ `null`) |
| `jumping` / `crouching` | ジャンプ中・しゃがみ中か |

## 地形

リプレイから分かる、**表面が見えているブロック**を使います(埋もれて見えないブロックは入っていません)。
`tick` を渡すと、その時点で建っているブロックだけを見ます(建築の途中を正しく扱えます)。

| API | 説明 |
|---|---|
| `api.world.raycast(from, to, { tick, ignoreStart })` | `from` から `to` への線分で最初にぶつかるブロック。`{ pos, block, normal, dist }` か `null` |
| `api.world.isSolid(x, y, z, tick?)` | そこにブロックがあるか |
| `api.world.groundY(x, z, fromY?, tick?)` | その列で `fromY` 以下の一番上のブロックの上面の高さ(無ければ `null`) |

`ignoreStart: true` で出発点のブロックを無視します。プレイヤーの頭が草や水の中にある時などに使います。

## カメラを読む

| API | 説明 |
|---|---|
| `api.cameras()` | 全カメラ |
| `api.camera(id)` | IDで1台 |
| `api.selectedCamera()` | 選んでいるカメラ(無ければ `null`) |
| `cam.poseAt(tick)` | その時刻の `{ pos, yaw, pitch }`(エディタと同じ補間・速さのカーブ込み) |

カメラのオブジェクト: `{ id, name, start, end, layer, fov, display, keys }`

- `start` / `end`: tick。`layer`: 重なり順(大きいほど手前)
- `display`: 画面の中の表示位置 `{ x, y, w }`(0〜1の割合)。`null` は自動
- `keys`: `[{ time, pos, yaw, pitch, curve? }]`

## 作る・直す

| API | 説明 |
|---|---|
| `api.addCamera(spec)` | カメラを追加。戻り値のIDは、同じスクリプトの中で `updateCamera` などに使えます |
| `api.updateCamera(id, patch)` | 書いた所だけ変える(`keys` は全部入れ替え) |
| `api.removeCamera(id)` | 削除 |
| `api.addText(spec)` | テキストを追加 |
| `api.select(id)` | 実行後に選んでおくカメラ |
| `api.seek(tick)` | 実行後の再生ヘッドの位置 |

### `addCamera` / `updateCamera` の項目

| 項目 | 説明 |
|---|---|
| `start` | 始まりの tick(`addCamera` で省略すると再生ヘッド) |
| `end` か `seconds` | 終わりの tick か、長さ(秒) |
| `name` | 名前 |
| `fov` | 画角(度) |
| `layer` | 重なり順。同じ層で時間が重なると、自動で上の層にずれます |
| `display` | 表示位置 `{ x, y, w }` か `null` |
| `keys` | キーの配列(1つ以上) |

### キー

```js
{ time: 1.5, pos: [x, y, z], yaw: 90, pitch: -10 }
{ time: 1.5, pos: [x, y, z], lookAt: [x, y, z] }         // その点を向く
{ time: 0,   pos: [x, y, z], lookAt: head, curve: 'smooth' } // 次のキーまでの速さ
```

`curve` は `'linear'`(等速)/ `'smooth'`(なめらか)/ `'easeIn'`(ゆっくり始まる)/ `'easeOut'`(ゆっくり止まる)、
または `[x1, y1, x2, y2]`(CSS の cubic-bezier と同じ)。

### `addText` の項目

`start`, `seconds` か `end`, `content`, `x`, `y`(0〜1)に加えて、見た目の項目が使えます:
`font`('gothic' / 'rounded' / 'mincho' / 'pixel' / 'display'), `fontSize`, `weight`, `italic`, `color`, `opacity`, `align`,
`letterSpacing`, `lineHeight`, `strokeWidth`, `strokeColor`, `shadow`('none' / 'soft' / 'hard' / 'glow'), `shadowColor`,
`bgOpacity`, `bgColor`, `bgPadding`, `bgRadius`, `rotation`, `animIn`, `animInSec`, `animOut`, `animOutSec`。

## 仕上げの道具(api.fx)

キーの配列を受け取って、新しいキーの配列を返します。`addCamera` の直前に通すのがおすすめです。

| API | 説明 |
|---|---|
| `api.fx.finish(keys, { seconds, avoid, shake })` | 下の2つをまとめて。`avoid: true` で壁よけ、`shake: 0〜1` で手ぶれ |
| `api.fx.avoidWalls(keys, { seconds, margin, minDist, step, aim, target, start })` | 見る相手(ふつうはプレイヤーの頭)との間にブロックがある時だけ、カメラを相手の側へ寄せる。寄せすぎになる時は上へ逃げる |
| `api.fx.handheld(keys, { seconds, amount, turn, speed, seed, step })` | 手で持って撮ったような揺れ |
| `api.fx.resolve(keys)` | `lookAt` や `curve: 'smooth'` を、yaw・pitch・数の配列に直す |

```js
const keys = [{ time: 0, pos: eye, lookAt: f.head }];
api.addCamera({ start: api.start, seconds: p.seconds, keys: api.fx.finish(keys, { seconds: p.seconds, avoid: true, shake: 0.2 }) });
```

## べんりな道具

| API | 説明 |
|---|---|
| `api.math.vec.add / sub / scale / dot / cross / len / dist / norm / lerp` | 3次元ベクトル(配列 `[x, y, z]`) |
| `api.math.lookAt(from, to)` | `from` から `to` を向く `{ yaw, pitch }` |
| `api.math.forward(yaw, pitch?)` | 向き → 前向きのベクトル |
| `api.math.right(yaw)` | 向き → 右向きのベクトル(水平) |
| `api.math.angleDiff(a, b)` | a から b への一番近い回り方の角度差(−180〜180) |
| `api.math.noise(t, seed)` | なめらかな揺れ(−1〜1) |
| `api.math.random(seed)` | 毎回同じ順で数が出る乱数を作る(`const r = api.math.random(1); r()`) |
| `api.math.clamp / lerp / smoothstep / easeInOut` | よく使う計算 |
| `api.curves` | 速さのカーブのひな形 |
| `api.evalKeys(keys, 秒)` | キーの配列の補間(`poseAt` と同じ計算) |

## その他

| API | 説明 |
|---|---|
| `api.log(...)` | 右パネルの結果の欄に表示 |
| `api.toast(文)` | 画面上に通知 |
| `api.fail(文)` | 理由を表示して止める(何も変えない) |
| `api.progress(0〜1)` | 進み具合のバー |

## 例: プレイヤーの周りを半周しながら近づく

```js
api.info({ name: '回りながら寄る', description: '半周しながら、プレイヤーに近づく' });
const p = api.params({
  seconds: { type: 'number', label: '長さ', min: 1, max: 20, step: 0.5, default: 5, unit: '秒' },
  from:    { type: 'number', label: '始めの距離', min: 2, max: 30, step: 0.5, default: 12, unit: 'ブロック' },
  to:      { type: 'number', label: '終わりの距離', min: 1, max: 30, step: 0.5, default: 4, unit: 'ブロック' },
});
const me = api.player(), M = api.math;
const f0 = me.at(api.start);
const keys = [];
const n = Math.round(p.seconds / 0.5);
for (let i = 0; i <= n; i++) {
  const t = p.seconds * i / n, u = M.easeInOut(i / n);
  const h = me.at(api.start + api.toTick(t)).head;
  const a = (f0.yaw + 180 + u * 180) * M.DEG;
  const d = p.from + (p.to - p.from) * u;
  keys.push({ time: t, pos: [h[0] + Math.sin(a) * d, h[1] + 2, h[2] + Math.cos(a) * d], lookAt: h });
}
api.addCamera({ start: api.start, seconds: p.seconds, name: '回りながら寄る',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: true }) });
```

## 前のバージョンからの変更

- 「🧩 スクリプト」の項目は無くなり、カメラの素材そのものがスクリプトになりました
- 置く時刻は `api.start` を使ってください(`api.playhead` は作り直す時に今の再生ヘッドになります)
- 前に保存したカスタム(⚙ の設定・カメラの動き・スクリプト)は、自動でカメラのスクリプトにそろえられます

## 制限

- 1回の実行で出せる命令は 20000 個まで、1台のカメラのキーは 5000 個まで
- 実行時間は 15 秒まで
- `api.log` は 500 行まで

---

# 🎭 全体アニメのスクリプト(エンティティアニメーションAPI・ステップ27)

全員(プレイヤー・人形)の動きを**毎コマ計算**するスクリプトです。カメラのスクリプトと同じ隔離した場所で動き、同じ `api`(info・params・start・tps・view・player・world・math・log・toast・fail)が使えます。

エディタは結果を受け取って、**キーを減らし**、人ごとに**ふつうのポーズのブロック**を作ります(あとで手で直せます)。作ったブロックは設定を覚えていて、右パネルで設定を変えると全員ぶんがその場で作り直されます。

## api.animate(spec)

```js
api.animate({
  who: 'all',            // 'all' / 'players' / 'puppets' / 'me'(右下で選んでいる人)/ ['player:1', …] / (e) => true
  types: ['humanoid'],   // 型でしぼる(省くと全部)
  start: api.start,      // 始まり(tick)
  seconds: 3,            // 長さ(秒)
  name: '名前',          // ブロックの名前(省くとスクリプトの名前)
  frame(e, t, ctx) {     // 人ごと・コマごとに呼ばれる
    return { head: [20, 0, 0], root: { r: [0, 0, 0], p: [0, 0.5, 0] } };
  },
});
```

- `e` … `{ key, name, kind:'player'|'puppet', type, isMe, at(tick) }`
- `t` … 始まりからの秒
- `ctx` … `{ tick, index(何人目), count(人数), at:{ tick, pos(足元・ワールド座標), yaw(度) }, state(その人用の入れ物), seconds }`
- 返す値 … `{ 関節: [x, y, z] }`(回転・度)か `{ 関節: { r:[…], p:[…] } }`(p は位置のずれ・ブロック)。
  - 返さなかった関節は元の動き(自動アニメーション)のまま。
  - `null` を返したコマは、その人を動かさない(元の動きのまま)。動かすコマが続いている所ごとに、ブロックが1つできる。
  - その人が出ていないコマは呼ばれない。
  - その型に無い関節は使われない。
- 関節(人型): root・body・head・armR/armL・legR/legL(腕・脚は Bloxd と同じ1本。ステップ30でひじ・ひざを無くした)。x=前へ / y=ひねり(左が+)/ z=横へ。root の p はその人の向きが基準。
- `api.entities()` / `api.entity(key)` … 全員の情報(上の `e` と同じ形)。

## リプレイの記録・出来事(ステップ28)

- `e.at(tick)` … `{ tick, pos, yaw, swinging, crouching, jumping, held, speed }`(swinging = 腕を振っている、held = 持ち物の名前、speed = 横の速さ ブロック/秒)
- `ctx.auto` / `e.auto(tick)` … 自動アニメーション(歩く・走る・腕を振る…)の形 `{ 関節: { r, p } }`(ステップ29)。自分の動きと混ぜると、ふつうの動きから技へ なめらかに入って、また戻れる。置いた時刻から60秒まで・人型だけ。無い時は null。手で付けたポーズのブロックは入らない
- `api.events({ type, key, from, to })` … 出来事の一覧(tick の順・コマの番号)
  - `attack` … 腕を振り始めた。`target` = その時に前(4.5ブロック以内)にいる一番近い人
  - `hurt` … ダメージを受けた。`by` = 直前(0.5秒以内)に近くで腕を振った人、`amount` = 減った体力
  - `death` / `respawn` / `shot`(銃を撃った)
  - `key` でしぼると、その人が出した物・受けた物の両方(`by`・`target` も見る)

## 体の位置・IK(ステップ28)

座標は「その人の座標」= 足元が原点、+z が前(向いている方)、+y が上、+x が左。エディタの組み立てと同じ計算です。

- `e.part(tick, name, pose?)` … 体の点のワールド座標。pose を省くとまっすぐ立った形。
  name: feet・pelvis・belly・chest・back・neck・head・face・headTop・shoulderR/L・handR/L・hipR/L・kneeR/L(脚のまん中)・footR/L
- `api.toLocal(e, tick, worldPoint)` / `api.toWorld(e, tick, localPoint)` … その人の座標 ⇄ ワールド座標
- `api.body.point(pose, name)` / `api.body.fk(pose)` … その形の時の体の点(その人の座標)/ 全部の点
- `api.ik(pose, limb, point)` … limb = 'armR' / 'armL' / 'legR' / 'legL'。手・足(1本)の先が point(その人の座標)の方を向くように、つけ根(x・z)の角度を pose に書きこむ(ひねり y はそのまま)。届く距離なら先がその点に来る。戻り値 `{ pose, error, reached }`。pose の root(回転・位置のずれ)や body の角度も計算に入る。

```js
// 相手の顔をなぐる
const pose = { root: { r: [0, 0, 0], p: [0, 0, 0.6] } };            // 0.6 踏みこむ
const face = you.part(ctx.tick, 'face');                            // 相手の顔(ワールド座標)
api.ik(pose, 'armR', api.toLocal(me, ctx.tick, face));              // 右手の先を顔へ
return pose;
```

## キーの減らし方

キーの間は速さのカーブ1本でつなぎます。等速 → なめらか/ゆっくり始まる/ゆっくり止まる → 自由なカーブ(x1=1/3, x2=2/3 にして y1・y2 を最小二乗で決める)の順に試し、ずれが回転 0.5度・位置 0.01ブロック以内になる物を使います。合わなければ一番ずれるコマにキーを足して分けます。
