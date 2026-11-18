// bloxd.io のトップページを開いて、開発者ツールのコンソールに貼り付けて Enter。
// 公式の 3D モデル(Draco 圧縮の glb)を、公式の Draco デコーダーでほどいて、
// ふつうの数字(JSON)にして bloxd_models_plain.zip にまとめてダウンロードします。
// ゲームの操作やアカウントには一切触れません。
(async () => {
  const log = (...a) => console.log('%c[plain]', 'color:#08f', ...a);
  // 1) JS を集める
  const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name)
    .filter(u => /bloxd\.io\/static\/js\/.*\.js(\?|$)/.test(u)))];
  const js = {};
  for (const u of urls) { try { js[u] = await (await fetch(u)).text(); } catch (e) {} }
  const maps = [];
  for (const t of Object.values(js)) for (const m of t.matchAll(/(\d+):\(\w+,\w+,\w+\)=>\{var \w+=\{"\.\//g)) {
    const body = t.slice(m.index, t.indexOf('}', m.index + m[0].length));
    const entries = [...body.matchAll(/"\.\/([^"]+\.glb)":(\d+)/g)].map(x => [x[1], x[2]]);
    if (entries.length) maps.push({ id: m[1], entries });
  }
  const idx = {};
  for (const t of Object.values(js)) for (const m of t.matchAll(/[,{](\d+):\w+=>\{\w+\.exports="data:[^,]*,/g)) {
    const st = m.index + m[0].length; idx[m[1]] = [t, st, t.indexOf('"', st)];
  }
  // 2) 公式の Draco デコーダー
  const src = await (await fetch('/static/draco_wasm_wrapper_gltf_v2_1.js')).text();
  const wasm = await (await fetch('/static/draco_decoder_gltf_v2_1.wasm')).arrayBuffer();
  const Factory = (0, eval)(src + ';DracoDecoderModule');
  const D = await Factory({ wasmBinary: wasm });
  log('draco ready');

  const r5 = v => Math.round(v * 100000) / 100000;
  function decodeGlb(bin) {
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bin.subarray(20, 20 + jl)));
    const BIN = bin.subarray(20 + jl + 8);
    const acc = (i) => { // 圧縮されていない accessor
      const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
      const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
      const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
      const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
      return Array.from(new T(BIN.buffer.slice(BIN.byteOffset + off, BIN.byteOffset + off + a.count * n * T.BYTES_PER_ELEMENT)));
    };
    const meshes = (json.meshes || []).map(m => m.primitives.map(p => {
      const ex = p.extensions && p.extensions.KHR_draco_mesh_compression;
      if (!ex) {
        return { mat: p.material, pos: acc(p.attributes.POSITION).map(r5),
          uv: p.attributes.TEXCOORD_0 != null ? acc(p.attributes.TEXCOORD_0).map(r5) : null,
          nor: p.attributes.NORMAL != null ? acc(p.attributes.NORMAL).map(r5) : null,
          idx: p.indices != null ? acc(p.indices) : null };
      }
      const bv = json.bufferViews[ex.bufferView];
      const data = BIN.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      const dec = new D.Decoder(), buf = new D.DecoderBuffer();
      buf.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
      const mesh = new D.Mesh(); const st = dec.DecodeBufferToMesh(buf, mesh);
      if (!st.ok()) throw new Error(st.error_msg());
      const get = (uid, n) => {
        if (uid == null) return null;
        const a = dec.GetAttributeByUniqueId(mesh, uid), arr = new D.DracoFloat32Array();
        dec.GetAttributeFloatForAllPoints(mesh, a, arr);
        const o = new Array(mesh.num_points() * n); for (let i = 0; i < o.length; i++) o[i] = r5(arr.GetValue(i));
        D.destroy(arr); return o;
      };
      const out = { mat: p.material, pos: get(ex.attributes.POSITION, 3), uv: get(ex.attributes.TEXCOORD_0, 2), nor: get(ex.attributes.NORMAL, 3) };
      const extra = {}; // ほかの属性(色など)
      for (const [k, uid] of Object.entries(ex.attributes)) if (!['POSITION', 'TEXCOORD_0', 'NORMAL'].includes(k)) {
        const a = json.accessors[p.attributes[k]]; extra[k] = get(uid, { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]);
      }
      if (Object.keys(extra).length) out.extra = extra;
      const nf = mesh.num_faces(), ia = new D.DracoInt32Array(), ix = new Array(nf * 3);
      for (let f = 0; f < nf; f++) { dec.GetFaceFromMesh(mesh, f, ia); ix[f * 3] = ia.GetValue(0); ix[f * 3 + 1] = ia.GetValue(1); ix[f * 3 + 2] = ia.GetValue(2); }
      out.idx = ix;
      D.destroy(ia); D.destroy(mesh); D.destroy(buf); D.destroy(dec);
      return out;
    }));
    return {
      nodes: (json.nodes || []).map(n => ({ name: n.name, t: n.translation, r: n.rotation, s: n.scale, children: n.children, mesh: n.mesh })),
      scenes: json.scenes, scene: json.scene, materials: json.materials, meshes,
      animations: json.animations ? json.animations.map(a => a.name) : undefined,
    };
  }

  // 3) zip(無圧縮)
  const crcT = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), files = [];
  const add = (name, bytes) => files.push([enc.encode(name), bytes]);
  const dirName = mp => {
    const k = mp.entries.map(e => e[0]).join(' ');
    if (k.includes('Player/Player_Model')) return 'lifeform';
    if (k.includes('Spikes_Diamond')) return 'block';
    return 'other_' + mp.id;
  };
  let ok = 0, bad = [];
  const done = new Set();
  for (const mp of maps) {
    const d = dirName(mp);
    for (const [k, mid] of mp.entries) {
      if (done.has(d + '/' + k)) continue; done.add(d + '/' + k);
      const x = idx[mid]; if (!x) { bad.push(k + ' (no data)'); continue; }
      try {
        const bin = Uint8Array.from(atob(x[0].slice(x[1], x[2])), c => c.charCodeAt(0));
        add(d + '/' + k.replace(/\.glb$/, '.json'), enc.encode(JSON.stringify(decodeGlb(bin))));
        ok++;
      } catch (e) { bad.push(k + ' ' + e.message); }
      if (ok % 100 === 0) log(ok, '...');
    }
  }
  add('info.json', enc.encode(JSON.stringify({ date: new Date().toISOString(), ok, bad }, null, 1)));
  const parts = [], cent = []; let off = 0;
  for (const [nm, b] of files) {
    const c = crc(b);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint32(14, c, true); h.setUint32(18, b.length, true); h.setUint32(22, b.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, b);
    const d = new DataView(new ArrayBuffer(46));
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
    d.setUint32(16, c, true); d.setUint32(20, b.length, true); d.setUint32(24, b.length, true); d.setUint16(28, nm.length, true); d.setUint32(42, off, true);
    cent.push(new Uint8Array(d.buffer), nm);
    off += 30 + nm.length + b.length;
  }
  let cs = 0; for (const x of cent) cs += x.length;
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cs, true); e.setUint32(16, off, true);
  const blob = new Blob([...parts, ...cent, new Uint8Array(e.buffer)], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bloxd_models_plain.zip';
  document.body.appendChild(a); a.click();
  log('done:', ok, 'models,', bad.length, 'failed,', (blob.size / 1048576).toFixed(1) + 'MB');
})();
