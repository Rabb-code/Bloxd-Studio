// blockmeta_core.js
// ============================================================
// 公式の JS(bloxd_models.zip の js/ の中身)から、ブロックの表(blockMetadata)を取り出す。読むだけ。
//   公式のブロックの番号は「定義の並び順」で決まる(公式のコードにも
//   「ブロックは最後に足すだけ」という確認がある)。だから最新の JS から作った表は、
//   前のリプレイにも新しいリプレイにもそのまま使える。
// node でもブラウザ(official_tables.html の Worker)でも同じコードで動く。
//   makeModuleMap(files, acorn)  … { ファイル名: ソース } → モジュール番号 → ソースの場所
//   runBlockMetadata(files, map) … 公式のモジュールを動かして blockMetadata を返す
//   compactBlockMeta(j)          … エディタで使う所だけの表にする
//   runCosmetics / compactCosmetics … 着せかえの表(NPC・付属品)
// ============================================================
(function (root) {
  function makeModuleMap(files, acorn) {
    const out = {};
    for (const f of Object.keys(files)) {
      const src = files[f];
      let ast;
      try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }); } catch (e) { continue; }
      const isMain = /\.main\./.test(f);
      const addObj = (obj) => {
        for (const p of obj.properties) {
          if (!p.key) continue;
          const k = p.key.type === 'Literal' ? p.key.value : p.key.name;
          out[k] = { f, s: p.value.start, e: p.value.end };
        }
      };
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12) return;
        if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.declarations) {
          for (const d of node.declaration.declarations)
            if (d.id && d.id.name === 'modules' && d.init && d.init.type === 'ObjectExpression') addObj(d.init);
        }
        if (isMain && node.type === 'VariableDeclarator' && node.init && node.init.type === 'ArrayExpression' && node.init.elements.length > 1000) {
          node.init.elements.forEach((el, i) => { if (el) out[i] = { f, s: el.start, e: el.end }; });
          return;
        }
        for (const k in node) {
          const v = node[k];
          if (Array.isArray(v)) v.forEach(c => walk(c, depth + 1));
          else if (v && typeof v.type === 'string') walk(v, depth + 1);
        }
      };
      walk(ast, 0);
    }
    return out;
  }

  // 公式のモジュールの中から、blockMetadata を出しているモジュールを探す
  function findBlockMetadataModule(files, map) {
    for (const k of Object.keys(map)) {
      const m = map[k];
      const s = files[m.f].slice(m.s, Math.min(m.e, m.s + 400));
      const mm = /blockMetadata:\(\)=>(\w+)\.(\w+)/.exec(s);
      if (mm) {
        // そのモジュールの中で mm[1] = OH(番号) を探す
        const full = files[m.f].slice(m.s, m.e);
        const r = new RegExp('\\b' + mm[1] + '=\\w+\\((\\d+)\\)').exec(full);
        if (r) return { id: +r[1], key: mm[2] };
      }
    }
    return null;
  }

  function runBlockMetadata(files, map) {
    const cache = {};
    const stub = (name) => {
      const f = function () { return stub(name + '()'); };
      return new Proxy(f, {
        get: (t, k) => {
          if (k === Symbol.toPrimitive) return () => 0;
          if (k === 'then' || typeof k === 'symbol') return undefined;
          return stub(name + '.' + String(k));
        },
        construct: () => stub('new ' + name), apply: () => stub(name + '()'),
      });
    };
    const G = (typeof globalThis !== 'undefined') ? globalThis : self;
    if (!G.window) G.window = G;
    if (!G.document) G.document = stub('document');
    if (!G.localStorage) G.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    function req(id) {
      if (cache[id]) return cache[id].exports;
      const m = map[id];
      if (!m) return stub('mod' + id);
      const mod = { exports: {}, id }; cache[id] = mod;
      const fn = (0, eval)('(' + files[m.f].slice(m.s, m.e) + ')');
      fn(mod, mod.exports, req);
      return mod.exports;
    }
    req.d = (e, defs) => { for (const k in defs) if (!Object.prototype.hasOwnProperty.call(e, k)) Object.defineProperty(e, k, { enumerable: true, get: defs[k] }); };
    req.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    req.r = (e) => { Object.defineProperty(e, '__esModule', { value: true }); };
    req.n = (m) => { const g = m && m.__esModule ? () => m.default : () => m; req.d(g, { a: g }); return g; };
    req.e = () => Promise.resolve(); req.p = '/'; req.g = G; req.nmd = (m) => m; req.hmd = (m) => m;
    const where = findBlockMetadataModule(files, map);
    if (!where) throw new Error('公式の JS の中に blockMetadata が見つかりません');
    const j = req(where.id)[where.key];
    if (!j || typeof j !== 'object') throw new Error('blockMetadata が読めませんでした');
    runBlockMetadata.lastReq = req;  // 着せかえの表もこれで動かす
    return j;
  }

  // エディタで使う所だけ: 番号 → {n:名前, r:元の名前, m:形, t:絵, p:面ごと, bm:モデル, ms, yo, lz:箱}
  function compactBlockMeta(j) {
    const ids = {};
    // ステップ55: 材質(液体・光の色)。公式の項目の名前は版ごとに変わる(短くされている)ので、中身から探す:
    //   液体 = Water と Lava で true、Stone では true でない項目 / 光の色 = Yellow Torch で [15,15,3] の項目
    const byName = (n) => Object.keys(j).map(k => j[k]).find(b => b && b.name === n);
    const bW = byName('Water'), bL = byName('Lava'), bS = byName('Stone'), bT = byName('Yellow Torch');
    let fluidKey = null, lightKey = null;
    if (bW && bL && bS) for (const k of Object.keys(bW)) if (bW[k] === true && bL[k] === true && bS[k] !== true && k !== 'stackable') { fluidKey = k; break; }
    if (bT) for (const k of Object.keys(bT)) { const v = bT[k]; if (Array.isArray(v) && v.length === 3 && v[0] === 15 && v[1] === 15 && v[2] === 3) { lightKey = k; break; } }
    for (const k of Object.keys(j)) {
      const b = j[k];
      if (!b || typeof b.id !== 'number' || String(b.id) !== k) continue;
      const e = { n: b.name };
      const rn = b.meta && b.meta.rootName; if (rn && rn !== b.name) e.r = rn;
      if (b.model) e.m = b.model;
      let t = b.textureInfo;
      if (t && typeof t === 'object' && !Array.isArray(t)) t = t.animTextures ? t.animTextures[0] : undefined; // 動く絵は1枚目
      if (Array.isArray(t) && typeof t[0] === 'number') t = undefined; // 色だけ(水)
      if (t !== undefined) e.t = t;
      if (b.texturePerSide) e.p = b.texturePerSide;
      if (b.blockModel) e.bm = b.blockModel;
      if (typeof b.modelScale === 'number') e.ms = b.modelScale;
      if (b.customModelInfo && typeof b.customModelInfo.yOffset === 'number') e.yo = b.customModelInfo.yOffset;
      // 向きの足し算(公式: 向き = yRotOffset + (rot の番号 - 1) × 90 度)。松明の壁の物は π
      if (b.customModelInfo && typeof b.customModelInfo.yRotOffset === 'number' && b.customModelInfo.yRotOffset) e.yro = b.customModelInfo.yRotOffset;
      if (b.customModelInfo && typeof b.customModelInfo.xRotOffset === 'number' && b.customModelInfo.xRotOffset) e.xro = b.customModelInfo.xRotOffset;
      if (b.model === 'rotatableOffset') e.roa = (typeof b.rotatableOffsetAmt === 'number') ? b.rotatableOffsetAmt : 0.4375;
      if (Array.isArray(b.Lz) && b.Lz.length % 6 === 0) e.lz = b.Lz.map(v => Math.round(v * 10000) / 10000);
      if (b.itemTexture) e.it = b.itemTexture;
      if (b.slabFullBlock) e.sf = b.slabFullBlock;
      if (fluidKey && b[fluidKey] === true) e.fl = 1;
      if (b.transTex) e.tt = 1;
      if (lightKey && Array.isArray(b[lightKey]) && b[lightKey].length === 3 && (b[lightKey][0] || b[lightKey][1] || b[lightKey][2])) e.lc = b[lightKey];
      ids[b.id] = e;
    }
    return { format: 1, made: new Date().toISOString(), ids };
  }

  // ステップ36: 着せかえの表(NPC の見た目・帽子などの3Dの付属品)。
  //   公式の着せかえの表 = { hat:{名前:{…}}, head:{…}, body:{…}, … } を出しているモジュールを探して動かす
  function runCosmetics(files, map, req) {
    for (const k of Object.keys(map)) {
      const m = map[k];
      const src = files[m.f].slice(m.s, m.e);
      if (src.indexOf('cosmeticPack:"npc"') < 0) continue;
      let ex; try { ex = req(+k); } catch (e) { continue; }
      for (const key of Object.keys(ex || {})) {
        let v; try { v = ex[key]; } catch (e) { continue; }
        if (v && typeof v === 'object' && v.head && v.body && v.legs && typeof v.head === 'object') return v;
      }
    }
    return null;
  }

  // エディタで使う所だけ: 名前 → {s:場所, tex:アトラスの名前, pt:ほかの場所の上書き, full:体ごとのモデル, np:関節の位置, att:[[glb, node, dest]]}
  function compactCosmetics(slots) {
    const out = {};
    if (!slots) return out;
    for (const slot of Object.keys(slots)) {
      const tbl = slots[slot]; if (!tbl || typeof tbl !== 'object') continue;
      for (const name of Object.keys(tbl)) {
        const c = tbl[name]; if (!c || typeof c !== 'object') continue;
        const e = {};
        if (c.texture && c.texture !== name) e.tex = c.texture;
        if (c.personTextures) e.pt = c.personTextures;
        if (c.personModel && c.personModel.fullBody) { e.full = 1; e.np = c.personModel.nodePositions || {}; }
        if (c.personModel && c.personModel.height) e.h = c.personModel.height;
        if (Array.isArray(c.attachments) && c.attachments.length)
          e.att = c.attachments.filter(a => a && a.modelGlb).map(a => [a.modelGlb, a.modelNode || '', a.destNode || a.modelNode || '']);
        if (Object.keys(e).length) { e.s = slot; out[name] = e; }
      }
    }
    return out;
  }

  const api = { makeModuleMap, runBlockMetadata, compactBlockMeta, findBlockMetadataModule, runCosmetics, compactCosmetics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlockMetaCore = api;
})(typeof self !== 'undefined' ? self : this);
