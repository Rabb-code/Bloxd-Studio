#!/usr/bin/env python3
"""
update_from_official.py
=======================
Bloxd 公式のファイル(bloxd_models_dump.js で作った bloxd_models.zip)から、
エディタのブロックの絵・表と official/ フォルダを作り直す道具。
公開のテクスチャの更新が止まったので、ゲームが更新されたらこれで追いつく。

使い方(エディタのフォルダで):
  python3 tools/update_from_official.py bloxd_models.zip [bloxd_models_plain.zip] [official_blockmeta.json] [block_ids.txt]

  - bloxd_models.zip        … 必須。bloxd.io のコンソールで bloxd_models_dump.js を動かして作る
  - bloxd_models_plain.zip  … あれば official/Player_Model.json を新しくする(bloxd_models_plain.js で作る)
  - official_blockmeta.json … あれば(おすすめ)公式のブロックの表そのもの。tools/official_tables.html で作る
                               (または node で tools/make_blockmeta_node.js)。
                               これがあると block_id_to_root.csv を公式の番号で全部作り直し、
                               ブロックの絵・形も公式の表から取る(下の 3 は要らない)
  - block_ids.txt           … あれば新しいブロックの番号を block_id_to_root.csv に足す(前のやり方)
                               (ワールドコード tools/block_ids_worldcode.js の出力。1行に「番号,名前」)

やること:
  1. textures.zip を作り直す(公式のブロックの絵 > 公式のアイテムの絵 > 前の textures.zip の順に優先)
     前の textures.zip は textures_old.zip として残す
  2. asset_master.csv に、公式の定義表にあって表に無いブロックを足す(前からある行は変えない)
  3. block_ids.txt があれば block_id_to_root.csv に新しい番号を足す
  4. official/(スキンの部品の一覧・着せかえの表・持ち物の絵)を新しくする
"""
import csv, io, json, math, os, re, shutil, sys, zipfile

HERE = os.getcwd()


def die(msg):
    print('エラー:', msg); sys.exit(1)


def find_main_js(z):
    names = [n for n in z.namelist() if n.startswith('js/') and '.main.' in n]
    if not names: die('bloxd_models.zip の中に js/…main….js がありません')
    return z.read(names[0]).decode('utf-8')


def obj_text(t, start):
    """t[start] が '{' の所から、対応する '}' までを返す(文字列の中の括弧は数えない)"""
    depth, i, q = 0, start, None
    while i < len(t):
        c = t[i]
        if q:
            if c == '\\': i += 2; continue
            if c == q: q = None
        elif c in '"\'`': q = c
        elif c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: return t[start:i + 1]
        i += 1
    return t[start:]


def parse_defs(t):
    """公式の定義表: 名前 → {tex:[...], per:[6], model, blockModel}"""
    defs = {}
    for m in re.finditer(r'(?:"([^"\\]+)"|([A-Za-z_$][\w$]*)):\{(?=displayName:\{translationKey:"item:|ttb:|textureInfo:)', t):
        name = m.group(1) or m.group(2)
        if name in defs: continue
        body = obj_text(t, m.end() - 1)
        d = {}
        a = re.search(r'textureInfo:"([^"]+)"', body)
        b = re.search(r'textureInfo:\["', body)
        if a: d['tex'] = [a.group(1)]
        elif b:  # 名前に [ ] が入ることがあるので、文字列の外の ] まで読む
            i, q, s, arr = b.end() - 1, None, '', []
            while i < len(body):
                c = body[i]
                if q:
                    if c == '"': arr.append(s); s = ''; q = None
                    else: s += c
                elif c == '"': q = c
                elif c == ']': break
                i += 1
            d['tex'] = arr
        if 'tex' not in d:  # 動く絵(溶岩・ポータル)は1枚目
            an = re.search(r'textureInfo:\{[^}]*?animTextures:\["([^"]+)"', body)
            if an: d['tex'] = [an.group(1)]
        p = re.search(r'texturePerSide:\[([\d,]+)\]', body)
        if p: d['per'] = [int(x) for x in p.group(1).split(',')]
        it = re.search(r'itemTexture:"([^"]+)"', body)
        if it: d['item'] = it.group(1)
        mo = re.search(r'\bmodel:"([^"]+)"', body)
        if mo: d['model'] = mo.group(1)
        bm = re.search(r'blockModel:"([^"]+)"', body)
        if bm: d['blockModel'] = bm.group(1)
        ms = re.search(r'modelScale:([\d.]+)', body)
        if ms: d['modelScale'] = float(ms.group(1))
        yo = re.search(r'customModelInfo:\{[^}]*?yOffset:(-?[\d.]+)(?:/([\d.]+))?', body)
        if yo: d['yOffset'] = float(yo.group(1)) / (float(yo.group(2)) if yo.group(2) else 1)
        if 'tex' in d or 'item' in d: defs[name] = d
    # ステップ33: 関数で作られるハーフ: sH("Maple Slab",{… model:"Slab", slabFullBlock:"…"}) など
    for m in re.finditer(r'\("([^"\\$]+)",\{(?=displayName:\{translationKey:"item:)', t):
        name = m.group(1)
        body = obj_text(t, m.end() - 1)
        stairs = name.endswith(' Stairs')
        if 'model:"Slab"' not in body and not stairs: continue
        d = defs.get(name, {})
        d['model'] = 'Stairs' if stairs else 'Slab'
        a = re.search(r'textureInfo:"([^"]+)"', body)
        b = re.search(r'textureInfo:\[([^\]]*)\]', body)
        if a: d['tex'] = [a.group(1)]
        elif b: d['tex'] = re.findall(r'"([^"]+)"', b.group(1))
        p = re.search(r'texturePerSide:\[([\d,]+)\]', body)
        if p: d['per'] = [int(x) for x in p.group(1).split(',')]
        f = re.search(r'slabFullBlock:"([^"]+)"', body)
        if f: d['slabFullBlock'] = f.group(1)
        defs[name] = d
    # 色の型のハーフ: F("$colour$ Chalk Slab","$colour$ Chalk","chalk_$colour$" または ["…side_$colour$","…_$colour$"], …)
    colours = ['Black', 'Blue', 'Brown', 'Cyan', 'Gray', 'Green', 'Light Blue', 'Light Gray', 'Lime', 'Magenta',
               'Orange', 'Pink', 'Purple', 'Red', 'White', 'Yellow']
    for m in re.finditer(r'\("(\$colour\$[^"]*Slab)","([^"]*)",(\[[^\]]*\]|"[^"]*")', t):
        texs = re.findall(r'"([^"]+)"', m.group(3))
        for c in colours:
            cs = c.lower().replace(' ', '_')
            name = m.group(1).replace('$colour$', c)
            if name in defs and defs[name].get('tex'): continue
            d = {'model': 'Slab', 'tex': [x.replace('$colour$', cs) for x in texs], 'slabFullBlock': m.group(2).replace('$colour$', c)}
            if len(texs) > 1: d['per'] = [0, 0, 1, 1, 0, 0]
            defs[name] = d
    # 色の型の階段: m("Concrete",(HH=>({… textureInfo:`${(0,kX.ve)(HH)}_concrete` …})))
    for m in re.finditer(r'\(0,\w+\.\w+\)\("([^"]+)",\(\w+=>', t):
        body = t[m.end():m.end() + 700]
        if 'Stairs' not in body[:200]: continue
        tx = re.search(r'textureInfo:`([^`]+)`', body)
        if not tx: continue
        for c in colours:
            cs = c.lower().replace(' ', '_')
            name = f'{c} {m.group(1)} Stairs'
            if name in defs: continue
            defs[name] = {'model': 'Stairs', 'tex': [re.sub(r'\$\{[^}]*\}', cs, tx.group(1))]}
    return defs


def load_blockmeta(path):
    """official_blockmeta.json → (番号の表 {id: 項目}, 元の名前ごとの定義 defs と同じ形)"""
    data = json.load(open(path, encoding='utf-8'))
    ids = {int(k): v for k, v in data['ids'].items()}
    defs = {}
    for i in sorted(ids):
        e = ids[i]
        root = e.get('r') or e['n']
        if root in defs: continue  # 元の名前の一番目(= 置いた時の基本の形)で決める
        d = {}
        t = e.get('t')
        if isinstance(t, str): d['tex'] = [t]
        elif isinstance(t, list) and t and isinstance(t[0], str):
            d['tex'] = [x if isinstance(x, str) else ((x.get('animTextures') or [''])[0] if isinstance(x, dict) else '') for x in t]
        if e.get('p'): d['per'] = e['p']
        if e.get('it'): d['item'] = e['it']
        if e.get('m'): d['model'] = e['m']
        if e.get('bm'): d['blockModel'] = e['bm']
        if 'ms' in e: d['modelScale'] = e['ms']
        if 'yo' in e: d['yOffset'] = e['yo']
        if e.get('sf'): d['slabFullBlock'] = e['sf']
        defs[root] = d
    return ids, defs


def split_full_name(e):
    full = e['n']; root = e.get('r') or full
    meta = full[len(root) + 1:] if full.startswith(root + '|') else ('|'.join(full.split('|')[1:]) if root == full and '|' in full else '')
    if root == full and '|' in full: root = full.split('|')[0]
    return full, root, meta


def faces(d):
    """[top, side, bottom, front] の絵の名前"""
    tex = d.get('tex') or [d.get('item') or '']
    per = d.get('per') or [0, 0, 0, 0, 0, 0]
    # 「white_glazed_terracotta[rot[4]]」のような回し方の印は外す(エディタは回さない)
    g = lambda i: re.sub(r'\[.*$', '', tex[per[i]] if per[i] < len(tex) else tex[0])
    return g(2), g(0), g(3), g(4)


def faces6(d):
    """6面の絵(+x, -x, 上, 下, +z, -z の順。公式の texturePerSide と同じ順)"""
    tex = d.get('tex') or [d.get('item') or '']
    per = d.get('per') or [0, 0, 0, 0, 0, 0]
    return [re.sub(r'\[.*$', '', tex[p] if p < len(tex) else tex[0]) for p in per]


# ---------- ブロックのモデル(ドア・ベッド・トゲ…) ----------
def _q2m(q):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def flatten_model(d):
    """ほどいたモデル(JSON)の部品の木をたどって、1つの三角形の集まりにする"""
    P, U, I = [], [], []
    def walk(i, fn):
        n = d['nodes'][i]
        t = n.get('t') or [0, 0, 0]; R = _q2m(n.get('r') or [0, 0, 0, 1]); s = n.get('s') or [1, 1, 1]
        # ステップ38: 公式はブロックのモデルの部品(メッシュ)の大きさを modelScale で置きかえる
        # (角 Antlers の部品は 10 倍が付いているが、ゲームでは 1 ブロックくらい)
        if n.get('mesh') is not None: s = [1, 1, 1]
        def ap(p, fn=fn, t=t, R=R, s=s):
            p = [p[0] * s[0], p[1] * s[1], p[2] * s[2]]
            return fn([sum(R[a][b] * p[b] for b in range(3)) + t[a] for a in range(3)])
        if n.get('mesh') is not None:
            for pr in d['meshes'][n['mesh']]:
                if not pr.get('pos') or not pr.get('uv') or not pr.get('idx'): continue
                base = len(P) // 3
                for k in range(0, len(pr['pos']), 3): P.extend(ap(pr['pos'][k:k + 3]))
                U.extend(pr['uv']); I.extend(base + v for v in pr['idx'])
        for c in n.get('children') or []: walk(c, ap)
    for r in d['scenes'][d.get('scene') or 0]['nodes']: walk(r, lambda p: p)
    return P, U, I


def normalize_model(P, kind, model_scale=None, y_offset=0.0):
    """公式と同じ大きさ・場所にする(0〜1 のマスの中の座標に)。
    公式: ブロックのモデルは 1/8 × modelScale 倍で、ブロックの真ん中に置き、customModelInfo.yOffset だけずらす。
    定義表に modelScale が無い物は、作り方で見分ける:
      8マス単位(ドア・はしご・看板など、座標が 2 より大きい)… 1/8 倍、真ん中
      ブロック単位で下が 0(たいまつ・ランタン・旗)……………… そのまま、下をそろえる
      それ以外(ベッド・机など、真ん中が原点)…………………… 横幅を1ブロックに、真ん中(下が床より下なら床まで上げる)
    はしご・ドアは薄い向き(z)をブロックの端(z=0)に寄せる。トラップドアは寝かせて下に置く。"""
    if not P: return P
    xs, ys, zs = list(P[0::3]), list(P[1::3]), list(P[2::3])
    if kind == 'trapdoor':  # 立っている板を寝かせる(y と z を入れかえる)
        ys, zs = zs, ys
    big = max(max(map(abs, xs)), max(map(abs, ys)), max(map(abs, zs)))
    cy = 0.5
    if model_scale:
        s = model_scale / 8.0
    elif big > 2:
        s = 1 / 8.0
    elif min(ys) >= -0.01:
        s = 1.0; cy = 0.0
    else:
        w = max(max(xs) - min(xs), max(zs) - min(zs)) or 1
        s = 1.0 / w
    out = []
    for x, y, z in zip(xs, ys, zs):
        out += [x * s + 0.5, y * s + cy + (y_offset or 0), z * s + 0.5]
    ymin = min(out[1::3])
    if kind == 'trapdoor' or (not model_scale and ymin < -0.01):
        for k in range(1, len(out), 3): out[k] -= ymin
    if kind in ('edge', 'door'):  # 薄い向きを z=0 の端へ
        zmin = min(out[2::3])
        for k in range(2, len(out), 3): out[k] -= zmin
    return out


def glb_image(z, name, folder='block'):
    """元の glb(<folder>/<name>.glb)の中の1枚目の絵"""
    nm = f'{folder}/{name}.glb'
    if nm not in z.namelist(): return None
    b = z.read(nm)
    import struct
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])
    if not j.get('images'): return None
    bv = j['bufferViews'][j['images'][0]['bufferView']]
    BIN = b[20 + jl + 8:]
    off = bv.get('byteOffset', 0)
    return BIN[off:off + bv['byteLength']]


def js_data_assets(z):
    """bloxd_models.zip の中の公式の JS から、直接「./名前.png → データ」を取り出す
    (前の bloxd_models_dump.js は「22e3」のような番号を見落としていたので、その分を補う)"""
    import base64
    js = [z.read(n).decode('utf-8', 'replace') for n in z.namelist() if n.startswith('js/') and n.endswith('.js')]
    num = lambda x: str(int(float(x)))
    data = {}
    for t in js:
        for m in re.finditer(r'[,{](\d+(?:e\d+)?):\w+=>\{\w+\.exports="data:[^,]*;base64,', t):
            st = m.end(); data[num(m.group(1))] = (t, st, t.find('"', st))
    out = {}
    for t in js:
        for m in re.finditer(r'(\d+(?:e\d+)?):\(\w+,\w+,\w+\)=>\{var \w+=\{"\./', t):
            body = t[m.start():t.find('}', m.end())]
            for e in re.finditer(r'"\./([^"]+\.png)":(\d+(?:e\d+)?)', body):
                d = data.get(num(e.group(2)))
                if d and e.group(1) not in out:
                    try: out[e.group(1)] = base64.b64decode(d[0][d[1]:d[2]])
                    except Exception: pass
    return out


def build_mobs(z, pz, main_js):
    """official/mobs.json(生き物の名前 → {model, tex})と official/mobs/ にモデル・絵を書く。
    モデルが無い生き物は、公式の JS の「"Spirit Wolf":SX(QH,"Wolf")」のような借り先、
    ゾンビ系(mO)はゾンビのモデル、それも無ければ名前の最後の言葉が同じ生き物"""
    zn = z.namelist(); pn = set(pz.namelist())
    folders = sorted({n.split('/')[1] for n in zn if n.startswith('lifeform/') and n.count('/') >= 2})
    has_model = {f for f in folders if f'lifeform/{f}/{f}_Model.json' in pn}
    js = '\n'.join(z.read(n).decode('utf-8', 'replace') for n in zn if n.startswith('js/') and n.endswith('.js'))
    borrow = dict(re.findall(r'"([A-Z][^"]+)":\w+\(\w+,"([A-Z][^"]+)"\)', js))
    zombie_like = set(re.findall(r'"([A-Z][^"]+)":mO\(\w+\)', js))
    os.makedirs('official/mobs', exist_ok=True)
    index, written = {}, set()
    for f in folders:
        if f == 'Player': continue
        m = f if f in has_model else borrow.get(f) if borrow.get(f) in has_model else None
        if not m and f in zombie_like: m = next((x for x in sorted(zombie_like) if x in has_model), None)
        if not m:
            last = f.split(' ')[-1]
            m = next((x for x in sorted(has_model) if x.split(' ')[-1] == last and x != 'Player'), None)
        if not m: continue
        var = sorted(n for n in zn if n.startswith(f'lifeform/{f}/variations/') and n.endswith('.png'))
        tex = next((n for n in var if '_default' in n), var[0] if var else None)
        if not tex and f'lifeform/{f}/{f}_Atlas.png' in zn: tex = f'lifeform/{f}/{f}_Atlas.png'
        if not tex: continue
        if m not in written:
            open(f'official/mobs/{m}.json', 'wb').write(pz.read(f'lifeform/{m}/{m}_Model.json')); written.add(m)
        open(f'official/mobs/{f}.png', 'wb').write(z.read(tex))
        index[f] = {'model': m, 'tex': f + '.png'}
    json.dump(index, open('official/mobs.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'official/mobs.json: 生き物 {len(index)} 種類(モデル {len(written)} 個)')


def build_block_tables(z, pz, defs, rows, pngs, meta_ids=None):
    """official/blocks.json(ブロックの名前 → 描き方)と official/blockmodels.json を作る。
    描き方: {"cube": [6面の絵]} / {"cross": 絵}(草花) / {"model": モデルの名前}"""
    plain_names = {}
    if pz:
        for nm in pz.namelist():
            if nm.startswith('block/') and nm.endswith('.json'): plain_names[nm[6:-5].lower()] = nm[6:-5]
    blocks, models, used_models = {}, {}, {}

    def model_for(name):
        return plain_names.get((name or '').lower())

    # モデルの名前 → それを使う公式の定義(modelScale・yOffset はここから取る)
    model_defs = {}
    for dn, dv in defs.items():
        bm = model_for(dv.get('blockModel'))
        if bm and (bm not in model_defs or 'modelScale' in dv): model_defs[bm] = dv

    def add_model(mname, kind, d=None):
        if mname in models: return True
        d = model_defs.get(mname) or d
        img = glb_image(z, mname)
        if img is None: return False
        mj = json.loads(pz.read(f'block/{mname}.json'))
        P, U, I = flatten_model(mj)
        if not I: return False
        P = normalize_model(P, kind, (d or {}).get('modelScale'), (d or {}).get('yOffset', 0.0))
        tex = 'bm__' + mname
        pngs[tex] = img
        models[mname] = {'pos': [round(v, 4) for v in P], 'uv': [round(v, 4) for v in U], 'idx': I, 'tex': tex}
        return True

    for r in rows:
        root = r['root_name']
        d = defs.get(root, {})
        m = d.get('model')
        kind = 'trapdoor' if m == 'trapdoor' else 'door' if m == 'door' else \
               'edge' if re.search(r' Ladder$|Directional Arrow$|Painting|^Board$|^Vines$', root) else 'center'
        mname = model_for(d.get('blockModel')) or model_for(r.get('final_model')) or model_for(r.get('model_file')) or model_for(root)
        if root.endswith(' Stairs') or m == 'Stairs':
            # ステップ34: 階段。絵は公式の定義 → 元のブロック(名前から " Stairs" を取った物)
            f6 = faces6(d) if d.get('tex') else None
            if not f6:
                for base in [root[:-7], root[:-7] + ' Block', root[:-7] + ' Wood Planks']:
                    bd = defs.get(base)
                    if bd and bd.get('tex'): f6 = faces6(bd); break
            if f6: blocks[root] = {'stairs': f6}
            continue
        if root.endswith(' Slab') or m == 'Slab':
            # ハーフ: 公式の定義の絵 → 元のブロック(slabFullBlock か、名前から " Slab" を取った物)の絵 → 表の絵
            f6 = faces6(d) if d.get('tex') else None
            if not f6:
                for base in [d.get('slabFullBlock'), root[:-5], root[:-5] + ' Block', root[:-5] + 's', root[:-5] + ' Planks', root[:-5] + ' Wood Planks']:
                    bd = defs.get(base or '')
                    if bd and bd.get('tex'): f6 = faces6(bd); break
            if not f6 and (r.get('final_top') or r.get('final_side')):
                top = r.get('final_top') or r.get('final_side'); side = r.get('final_side') or top; bot = r.get('final_bottom') or top
                f6 = [side, side, top, bot, side, side]
            if f6: blocks[root] = {'slab': f6}
            continue
        if m in ('fence', 'fenceGate') and d.get('tex'):
            # ステップ36: 柵・柵の門。つながる向きは番号の meta に入っている(置いた時に決まる)
            blocks[root] = {('fence' if m == 'fence' else 'gate'): faces6(d)}
            continue
        if m == 'CentreCross' and d.get('tex'):
            blocks[root] = {'cross': re.sub(r'\[.*$', '', d['tex'][0])}
        elif mname and pz and add_model(mname, kind, d):
            blocks[root] = {'model': mname}
        elif d.get('tex'):
            blocks[root] = {'cube': faces6(d)}
        elif r.get('asset_type') == '3d_model':
            # 公式の表で形が分からない3Dの物(植物の育つ途中など): 名前に近い絵があれば十字で
            guess = re.sub(r'[^a-z0-9]+', '_', root.lower()).strip('_')
            for g in (r.get('final_model') or '', guess, guess.replace('_plant', '')):
                g = re.sub(r'[^a-z0-9]+', '_', g.lower()).strip('_')
                if g in pngs: blocks[root] = {'cross': g}; break
    # ステップ36: 向きなどで形(モデル・箱)が変わる物 → official/blockvariants.json(番号の名前 → {bm / m / lz})
    variants = {}
    if meta_ids:
        root_bm = {}
        for i in sorted(meta_ids):
            e = meta_ids[i]; full, root, meta = split_full_name(e)
            if root not in root_bm: root_bm[root] = e.get('bm')
        for i in sorted(meta_ids):
            e = meta_ids[i]; full, root, meta = split_full_name(e)
            if full == root or root not in blocks: continue
            v = {}
            bm = e.get('bm')
            if bm and bm != root_bm.get(root):
                mname = model_for(bm)
                if mname and pz and add_model(mname, 'center', {'modelScale': e.get('ms'), 'yOffset': e.get('yo', 0.0)}):
                    v['bm'] = mname
            if e.get('m') == 'fenceGate' and e.get('lz'): v['lz'] = e['lz']
            yr = round((e.get('yro') or 0) / (math.pi / 2)) % 4
            if yr: v['yr'] = yr   # 向きの足し算(90 度の何回分。公式: 向き = yRotOffset + (rot - 1) × 90 度)
            if v: variants[full] = v
        # rotatableOffset(向きに合わせて壁の方へずらす)。はしご・つた・看板は端に寄せる作り方で合っているので、それ以外(角など)だけ
        for i in sorted(meta_ids):
            e = meta_ids[i]; full, root, meta = split_full_name(e)
            if full == root and root in blocks and 'model' in blocks[root] and e.get('roa') \
                    and not re.search(r' Ladder$|^Vines$|^Board$', root):
                blocks[root]['roa'] = e['roa']
        # 元の名前そのもの(rot1 など)の向きの足し算は blocks.json の方に
        for i in sorted(meta_ids):
            e = meta_ids[i]; full, root, meta = split_full_name(e)
            if full == root and root in blocks and e.get('yro'):
                yr = round(e['yro'] / (math.pi / 2)) % 4
                if yr: blocks[root]['yr'] = yr
    # ステップ37: 公式の柵の門の形(板に穴が2つ)。部品ごとにそのまま入れる(座標は門の真ん中が x=0,z=0、下が y=0)
    if pz and 'block/FenceGate.json' in pz.namelist():
        gj = json.loads(pz.read('block/FenceGate.json'))
        parts = {}
        for n in gj['nodes']:
            if n.get('mesh') is None: continue
            P, U, I = [], [], []
            for pr in gj['meshes'][n['mesh']]:
                base = len(P) // 3
                P += pr['pos']; U += pr['uv']; I += [base + i for i in pr['idx']]
            parts[n['name']] = {'pos': [round(v, 5) for v in P], 'uv': [round(v, 5) for v in U], 'idx': I}
        models['__FenceGate'] = {'parts': parts}
    os.makedirs('official', exist_ok=True)
    json.dump(variants, open('official/blockvariants.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    json.dump(blocks, open('official/blocks.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    # ステップ55: 材質の表 official/materials.json(元の名前 → { f: 液体, t: 透ける絵, l: 光の色 [赤,緑,青] 0〜15 })。
    #   official_blockmeta.json が古い作り方(fl・tt・lc が無い)の時は、前の materials.json をそのまま残す
    mats = {}
    for i in sorted(ids):
        e = ids[i]
        _full, root, _meta = split_full_name(e)
        m = mats.setdefault(root, {})
        if e.get('fl'): m['f'] = 1
        if e.get('tt'): m['t'] = 1
        if e.get('lc') and 'l' not in m: m['l'] = e['lc']
    mats = {k: v for k, v in mats.items() if v}
    if mats:
        json.dump(mats, open('official/materials.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        print(f'official/materials.json: {len(mats)} 個(液体 {sum(1 for v in mats.values() if v.get("f"))}・透ける {sum(1 for v in mats.values() if v.get("t"))}・光る {sum(1 for v in mats.values() if v.get("l"))})')
    json.dump(models, open('official/blockmodels.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    kinds = {}
    for v in blocks.values(): k = next(iter(v)); kinds[k] = kinds.get(k, 0) + 1
    print(f'official/blocks.json: {len(blocks)} 個 {kinds}、モデル {len(models)} 個、向きで変わる物 {len(variants)} 個')
    return blocks


def main():
    if len(sys.argv) < 2: die(__doc__)
    models_zip = sys.argv[1]
    plain_zip = next((a for a in sys.argv[2:] if a.endswith('.zip')), None)
    ids_txt = next((a for a in sys.argv[2:] if a.endswith('.txt')), None)
    meta_json = next((a for a in sys.argv[2:] if a.endswith('.json')), None)
    for f in ['asset_master.csv', 'block_id_to_root.csv', 'index.html']:
        if not os.path.exists(f): die(f'{f} がありません。エディタのフォルダで動かしてください')
    z = zipfile.ZipFile(models_zip)
    t = find_main_js(z)
    defs = parse_defs(t)
    print(f'公式の定義表: {len(defs)} 個')
    meta_ids = None
    if meta_json:
        meta_ids, mdefs = load_blockmeta(meta_json)
        for k, v in mdefs.items():
            d = defs.get(k, {}); d.update(v); defs[k] = d
        print(f'公式のブロックの表(official_blockmeta.json): 番号 {len(meta_ids)} 個、元の名前 {len(mdefs)} 個')

    # ---- 1. textures.zip ----
    pngs = {}
    def take(prefix):
        n = 0
        for nm in z.namelist():
            if nm.startswith(prefix) and nm.endswith('.png') and '/' not in nm[len(prefix):]:
                k = nm[len(prefix):-4]
                if k not in pngs: pngs[k] = z.read(nm); n += 1
        return n
    nb = take('block_textures/')
    ni = take('item_icons/')
    nold = 0
    if os.path.exists('textures.zip'):
        old = zipfile.ZipFile('textures.zip')
        for nm in old.namelist():
            if '__MACOSX' in nm or not nm.endswith('.png'): continue
            k = os.path.basename(nm)[:-4]
            if k not in pngs: pngs[k] = old.read(nm); nold += 1
        old.close()
        if not os.path.exists('textures_old.zip'): shutil.copy('textures.zip', 'textures_old.zip')

    # ---- 2. asset_master.csv ----
    with open('asset_master.csv', encoding='utf-8') as f:
        rd = csv.DictReader(f); cols = rd.fieldnames; rows = list(rd)
    have = {r['root_name'] for r in rows}
    added = []
    for name, d in defs.items():
        if name in have: continue
        top, side, bottom, front = faces(d)
        model = d.get('blockModel') or ''
        row = {c: '' for c in cols}
        row.update({'id': str(len(rows) + len(added) + 1), 'root_name': name,
                    'asset_type': 'model' if model else 'texture', 'confidence': 'official',
                    'tex_top': top, 'tex_side': side, 'tex_bottom': bottom, 'tex_front': front, 'tex_all': top,
                    'model_file': model, 'status': 'official',
                    'final_top': top, 'final_side': side, 'final_bottom': bottom, 'final_front': front, 'final_all': top,
                    'final_model': model})
        added.append(row)
    # ブロックの描き方の表(草花・モデル)。モデルの絵は textures.zip に bm__名前 で入れる
    pz = zipfile.ZipFile(plain_zip) if plain_zip else None
    if not pz: print('  (bloxd_models_plain.zip が無いので、ブロックのモデルは作りません)')
    blocks = build_block_tables(z, pz, defs, rows + added, pngs, meta_ids)
    # 草花・モデルは「隣の面を隠さない」(python がこの印を見る)
    nfix = 0
    for r in rows + added:
        b = blocks.get(r['root_name'])
        if b and ('cross' in b or 'model' in b or 'slab' in b or 'stairs' in b or 'fence' in b or 'gate' in b) and r.get('asset_type') != '3d_model':
            r['asset_type'] = '3d_model'; nfix += 1
    if added or nfix:
        if not os.path.exists('asset_master_old.csv'): shutil.copy('asset_master.csv', 'asset_master_old.csv')
        with open('asset_master.csv', 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows + added)
    print(f'asset_master.csv: {len(added)} 行を足した、{nfix} 行を「3Dモデル」に', [r['root_name'] for r in added[:8]], '…' if len(added) > 8 else '')

    with zipfile.ZipFile('textures.zip.tmp', 'w', zipfile.ZIP_DEFLATED) as out:
        for k in sorted(pngs): out.writestr(f'textures/{k}.png', pngs[k])
    os.replace('textures.zip.tmp', 'textures.zip')
    print(f'textures.zip: 公式のブロック {nb} 枚 + 公式のアイテム {ni} 枚 + 前の物 {nold} 枚 + モデルの絵 = {len(pngs)} 枚')
    # 絵が見つからない名前
    names = set()
    for r in rows + added:
        for k in ('final_top', 'final_side', 'final_bottom', 'final_front', 'final_all'):
            if r.get(k): names.add(r[k])
    missing = sorted(n for n in names if n not in pngs)
    if missing: print(f'  絵が無い名前 {len(missing)} 個:', missing[:20])

    # ---- 3. block_id_to_root.csv ----
    if meta_ids:
        # ステップ36: 公式の番号で全部作り直す(前の表は 3253 番から後がずれていた)
        with open('block_id_to_root.csv', encoding='utf-8') as f:
            rd = csv.DictReader(f); idcols = rd.fieldnames; old_rows = {r['id']: r for r in rd}
        new_rows, changed = [], 0
        for i in sorted(meta_ids):
            full, root, meta = split_full_name(meta_ids[i])
            o = old_rows.get(str(i))
            if o and o['full_name'] != full: changed += 1
            new_rows.append({'id': str(i), 'full_name': full, 'root_name': root, 'meta_suffix': meta})
        if not os.path.exists('block_id_to_root_old.csv'): shutil.copy('block_id_to_root.csv', 'block_id_to_root_old.csv')
        with open('block_id_to_root.csv', 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=idcols); w.writeheader(); w.writerows(new_rows)
        print(f'block_id_to_root.csv: 公式の番号で作り直した({len(new_rows)} 個。前と名前が違った番号 {changed} 個、新しい番号 {len(new_rows) - len(old_rows)} 個)')
    elif ids_txt:
        with open('block_id_to_root.csv', encoding='utf-8') as f:
            rd = csv.DictReader(f); idcols = rd.fieldnames; idrows = list(rd)
        known = {r['id'] for r in idrows}
        new = []
        for line in open(ids_txt, encoding='utf-8'):
            for part in re.split(r'[;\n]', line):
                m = re.match(r'\s*(\d+)\s*,\s*(.+?)\s*$', part)
                if not m or m.group(1) in known: continue
                full = m.group(2); root = full.split('|')[0]; meta = '|'.join(full.split('|')[1:])
                new.append({'id': m.group(1), 'full_name': full, 'root_name': root, 'meta_suffix': meta}); known.add(m.group(1))
        if new:
            shutil.copy('block_id_to_root.csv', 'block_id_to_root_old.csv')
            with open('block_id_to_root.csv', 'w', encoding='utf-8', newline='') as f:
                w = csv.DictWriter(f, fieldnames=idcols); w.writeheader()
                w.writerows(sorted(idrows + new, key=lambda r: int(r['id'])))
        print(f'block_id_to_root.csv: {len(new)} 個の番号を足した')

    # ---- 4. official/ ----
    os.makedirs('official/items', exist_ok=True)
    if 'player_textures/Player_Atlas.png' in z.namelist():
        open('official/Player_Atlas.png', 'wb').write(z.read('player_textures/Player_Atlas.png'))
    cos = {m.group(1): [int(m.group(2)), int(m.group(3)), int(m.group(4))]
           for m in re.finditer(r'(\w+):\{atlasIdx:(\d+),uOffset:(\d+),vOffset:(\d+)\}', t)}
    if cos: json.dump(cos, open('official/cosmetics.json', 'w'), separators=(',', ':'))
    items = {}
    for name, d in defs.items():
        tx = d.get('item') or (d.get('tex') or [None])[0]
        if tx and tx in pngs: items[name] = tx
    for tx in set(items.values()): open(f'official/items/{tx}.png', 'wb').write(pngs[tx])
    json.dump(items, open('official/items.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    # ステップ36: 着せかえの表(NPC の見た目・帽子などの3Dの付属品)
    if meta_json:
        cosx = json.load(open(meta_json, encoding='utf-8')).get('cosmetics') or {}
        if cosx:
            json.dump(cosx, open('official/cosmetic_extra.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
            glbs = sorted({a[0] for v in cosx.values() for a in v.get('att', [])})
            na = 0
            if plain_zip:
                pz2 = zipfile.ZipFile(plain_zip); pn = set(pz2.namelist()); zn = set(z.namelist())
                os.makedirs('official/attach', exist_ok=True)
                for g in glbs:
                    j = f'lifeform/Player/{g}.json'
                    png = next((c for c in (f'lifeform/Player/{g}.png', f'player_textures/{g}.png', f'player_textures/Player/{g}.png') if c in zn), None)
                    img = z.read(png) if png else glb_image(z, g, 'lifeform/Player')
                    if img is None:  # zip に入っていなかった絵は、公式の JS から直接
                        if 'jsa' not in locals(): jsa = js_data_assets(z)
                        img = next((v for k, v in jsa.items() if k == f'{g}.png' or k.endswith(f'/{g}.png')), None)
                    if img is None:  # 色違いだけある物(bee_set_3 など)は1つ目の色
                        alt = sorted(c for c in zn if c.startswith(f'lifeform/Player/{g}_') and c.endswith('.png'))
                        img = z.read(alt[0]) if alt else None
                    if j in pn and img:
                        open(f'official/attach/{g}.json', 'wb').write(pz2.read(j))
                        open(f'official/attach/{g}.png', 'wb').write(img); na += 1
            print(f'official/cosmetic_extra.json: 着せかえ {len(cosx)} 個、付属品のモデル {na}/{len(glbs)} 個')
    # ステップ37: 生き物(ゾンビ・ガーディアン・動物…)のモデルと、いつもの見た目(variations の 0 番)
    if plain_zip:
        build_mobs(z, zipfile.ZipFile(plain_zip), t)
    if plain_zip:
        pz = zipfile.ZipFile(plain_zip)
        if 'lifeform/Player/Player_Model.json' in pz.namelist():
            open('official/Player_Model.json', 'wb').write(pz.read('lifeform/Player/Player_Model.json'))
            print('official/Player_Model.json を新しくした')
    print(f'official/: 着せかえ {len(cos)} 個、持ち物 {len(items)} 個')
    print('おわり。ブラウザで Command+Shift+R してください。')


if __name__ == '__main__':
    main()
