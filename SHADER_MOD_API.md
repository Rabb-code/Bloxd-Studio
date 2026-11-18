# 影MOD(シェーダーMOD)の作り方

影MOD は、画面の見え方を自分で作れる仕組みです。GLSL(WebGL1 の GLSL ES 1.0)で書きます。
地形・建築・人・モブ・パーティクルの全部と、動画の書き出しにかかります。

- 開き方: 上の「…」メニュー →「影MOD(シェーダー)」
- 1つの MOD = 1つのファイル(`.bloxdshader`。中身は JSON)。人にあげたり、もらったりできます。
- 使っている MOD は、プロジェクトに中身ごと保存されます(プロジェクトを開いた人も同じ見え方になります)。

## しくみ

1. まず場面をふつうに描いて、「色の絵」と「奥行きの絵」を作ります。
2. `shadow.enabled` が true なら、太陽から見た「影の地図」も作ります(地形・建築・人・モブが影を落とします)。
3. MOD の「パス」を順番に通します。パスは画面の1ピクセルごとに `vec4 modPass(vec2 uv)` が呼ばれ、返した色が出ます。
   2つ目のパスの `uScene` は、1つ目のパスの結果です。最後のパスの結果が画面に出ます。
4. 最後に、ふちのギザギザをなめらかにします(止めるには `"antialias": false`)。

## ファイルの形

```json
{
  "format": "bloxd-shader-mod",
  "name": "MOD の名前",
  "author": "作った人",
  "description": "説明",
  "antialias": true,
  "sun": { "yaw": 35, "pitch": 50 },
  "shadow": { "enabled": true, "size": 2048, "distance": 70 },
  "options": [
    { "id": "shadow", "label": "影の濃さ", "type": "slider", "min": 0, "max": 1, "step": 0.01, "default": 0.5 },
    { "id": "fogOn", "label": "霧", "type": "toggle", "default": true },
    { "id": "tint", "label": "色あい", "type": "color", "default": "#ffe0c0" },
    { "id": "sunYaw", "label": "太陽の向き", "type": "slider", "min": 0, "max": 360, "default": 35, "bind": "sunYaw" }
  ],
  "common": "// 全部のパスから使える関数",
  "passes": [
    { "name": "パス1", "code": "vec4 modPass(vec2 uv) { return modScene(uv); }" }
  ]
}
```

- `sun`: 太陽の向き(yaw = 横の角度、pitch = 高さ。度)。
- `shadow`: 影の地図。`size` = 細かさ(ピクセル。大きいほどきれいで重い)、`distance` = 影が届く広さ(ブロック)。
- `options`: 画面に出るつまみ。コードでは `opt_<id>` という名前で使えます。
  - `slider` → `float`、`toggle` → `float`(1.0 か 0.0)、`color` → `vec3`(0〜1)
  - `"bind": "sunYaw"` / `"sunPitch"` を付けると、そのつまみで太陽が動きます。

## パスの中で使える物

| 名前 | 中身 |
|---|---|
| `modScene(uv)` | 前のパスの色(1つ目のパスは場面の色) |
| `uSceneOrig` | 場面の色(MOD をかける前)。`texture2D(uSceneOrig, uv)` |
| `modIsSky(uv)` | 空なら true |
| `modDepth(uv)` | 奥行き(0〜1。1 = 空) |
| `modWorldPos(uv)` | そのピクセルの世界の位置(ゲームの座標 = これ + `uOrigin`) |
| `modDistance(uv)` | カメラからの距離 |
| `modNormal(uv)` | 面の向き(長さ 1) |
| `modShadow(p, n)` | 影の地図で 1 = 日なた / 0 = 影(影の地図が無い時は 1) |
| `modShadowSoft(p, n, soft)` | ぼかした影(soft = ぼかす広さ) |
| `uSunDir` | 太陽のある方の向き |
| `uCamPos` | カメラの位置 |
| `uTime` / `uTick` | リプレイの中の時刻(秒) / tick |
| `uRealTime` | 本当の時間(秒) |
| `uResolution` | 絵の大きさ(ピクセル) |
| `uViewProj` / `uInvViewProj` | 世界 ↔ 画面の行列 |
| `uShadowMap` / `uShadowViewProj` | 影の地図と、その行列(自分で影を作りたい時) |

## ステップ53 で増えた物

### ブロックの種類(材質)

`modMaterial(uv)` で、そのピクセルの材質が分かります(使うと、地形と建築をもう一度「材質の絵」に描くので少し重くなります)。

| 名前 | 中身 |
|---|---|
| `MAT_SOLID` | ふつうのブロック |
| `MAT_WATER` | 水 |
| `MAT_LEAVES` | 葉 |
| `MAT_GLASS` | ガラス |
| `MAT_PLANT` | 草・花など |
| `MAT_LIGHT` | たいまつ・ランタン・グロウストーンなど光るブロック |
| `MAT_LAVA` | 溶岩 |
| `MAT_ICE` / `MAT_SNOW` / `MAT_SAND` | 氷 / 雪 / 砂 |
| `MAT_ENTITY` | 人・モブ・パーティクルなど |
| `MAT_SKY` | 空 |

- `modIsMat(uv, MAT_WATER)` … その材質か
- `modSurfaceLight(uv)` … 向きと角の暗さの明るさ(0〜1)

### 形を動かす(`"vertex"`)

コードの「形を動かす」タブ(ファイルでは `"vertex"`)に書きます。地形・草花・建築の頂点ごとに呼ばれます。影も一緒に動きます。

```glsl
vec3 modVertex(vec3 worldPos, vec3 blockPos, float mat) {
  if (mat == MAT_PLANT) worldPos.x += sin(uModTime * 2.0 + worldPos.z) * 0.05 * (worldPos.y - blockPos.y);
  return worldPos;
}
```

- `worldPos` = 頂点の世界の位置、`blockPos` = そのブロックの角(いちばん小さい角)、`mat` = 材質
- 使える物: `uModTime`(リプレイの時刻・秒)、`uModRealTime`、`uModSun`(太陽の向き)、`opt_<id>`(つまみ)、`modNoise(vec2)`、`modHash(vec2)`、`MAT_*`

### 空

- `modViewDir(uv)` … カメラからそのピクセルへの向き(空を描く・反射に使う)
- 空のピクセルは `modIsSky(uv)`。そこで好きな色を返すと、空になります(雲・星・夕焼けなど)
- 雲などに: `modNoise(vec2)`、`modFbm(vec2)`(重ねたノイズ)、`modHash(vec2)`、`modHash3(vec3)`

### 光るブロックの光

- `modPointLights(p, n)` … カメラに近い光るブロック(最大 16 個)からの光の色の合計
- `modLight(p, n)` … 光をまとめて読む(ステップ55)。rgb = ブロックの光(たいまつ・溶岩・光るブロック。公式の光の色)、a = 空の光(1 = 空が見える、0 = 光の届かない洞窟の奥)。光は1マスごとに弱くなりながら広がり、壁は通らない。置く・壊すに合わせて変わる。カメラのまわり 128×64×128 マスの中だけ。外は下の前のやり方になる
- `modSkyLight(p, n)` = `modLight(p, n).a`、`modBlockLight(p, n)` = `modLight(p, n).rgb`
- `modLightVolume(q, out w)` … 光の絵をそのまま読む(0〜1、w = 光の絵の中なら 1)。`uLightVol`・`uLightVolOrigin`・`uHasLightVol`
- `modSkyLightR(p, n, reach)` … 前のやり方(上から見た地図。壁を見ない)
- `modSurfaceTop(xz)` … その列のいちばん上のふさぐブロックの上の面の高さ / `modCeilingBottom(xz)` … いちばん上のかたまりの下の面の高さ(無い時は -1000)。水・葉・ガラス・草花・柵などはふさがない物として数える
- 自分で計算する時: `uLightCount`、`uLightPos[i]`(xyz = 位置, w = 届く広さ)、`uLightCol[i]`(rgb = 色, a = 強さ)

### 前のコマ

- `modPrev(uv)` / `uPrevFrame` … 1つ前のコマの、最後のパスの結果
- `uPrevViewProj`、`modPrevUV(worldPos)` … 1つ前のコマで、その場所が画面のどこにあったか(動きのぶれ・残像に)
- `uHasPrev` … 前のコマがあるか(最初のコマ・大きさが変わった時は 0)

### ほかのパスの結果

- `uPass1`・`uPass2`・`uPass3` … 1つ目・2つ目・3つ目のパスの結果(後ろのパスから読めます)

### 絵(`"textures"`)

コードの「絵」タブで画像を入れます(4枚まで)。パスで `texture2D(tex_<名前>, uv)`、大きさは `tex_<名前>_size`。

```json
"textures": [ { "id": "noise", "name": "noise.png", "data": "data:image/png;base64,...", "wrap": "repeat", "filter": "linear" } ]
```

### つまみのキー(タイムライン)

つまみの左の ◆ で、今の時刻にキーを打てます。キーが2つ以上あると、その間で値がなめらかに変わります(ON/OFF は切りかわるだけ)。
キーはタイムラインの「影MOD」の行に出ます(押すとその時刻へ)。キーはプロジェクトに保存されます(MOD のファイルには入りません)。

## 見本

一覧の「本気の影(見本)」(全部の機能を使う見本)「やわらかい影(見本)」「映画風(見本)」「空っぽ(ひな形)」を「自分用に複製」すると、コードを書きかえられます。

- コードを書いたら「反映」(⌘S / Ctrl+S)。まちがいがあると、どのパスの何行目かが出ます(その間はふつうの見え方)。
- 「設定(つまみ・影・太陽)」のタブで、つまみ・影・太陽を JSON で書きかえられます。
