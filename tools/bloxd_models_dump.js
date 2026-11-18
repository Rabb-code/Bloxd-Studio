// bloxd.io のトップページを開いて、開発者ツールのコンソールに貼り付けて Enter。
// 公式の JavaScript ファイルを読んで、3D モデル(glb)と絵(png)を bloxd_models.zip にまとめてダウンロードします。
// ゲームの操作やアカウントには一切触れません。
(async () => {
  const log = (...a) => console.log('%c[dump]', 'color:#0a0', ...a);
  // 1) 読み込まれている JS を全部集める
  const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name)
    .filter(u => /bloxd\.io\/static\/js\/.*\.js(\?|$)/.test(u)))];
  const js = {};
  for (const u of urls) { try { js[u] = await (await fetch(u)).text(); } catch (e) {} }
  log('JS', Object.keys(js).length, 'files');

  // 2) モデルの一覧(./名前.glb → モジュール番号)を探す
  const maps = [];
  for (const t of Object.values(js)) for (const m of t.matchAll(/(\d+(?:e\d+)?):\(\w+,\w+,\w+\)=>\{var \w+=\{"\.\//g)) {
    const body = t.slice(m.index, t.indexOf('}', m.index + m[0].length));
    // 番号は「22e3」(= 22000)のように短く書かれることがあるので、数にしてから比べる
    const entries = [...body.matchAll(/"\.\/([^"]+\.(?:glb|png))":(\d+(?:e\d+)?)/g)].map(x => [x[1], String(Number(x[2]))]);
    if (entries.length) maps.push({ id: m[1], entries });
  }
  // 3) モジュール番号 → base64 のデータ
  const idx = {};
  for (const t of Object.values(js)) for (const m of t.matchAll(/[,{](\d+(?:e\d+)?):\w+=>\{\w+\.exports="data:[^,]*,/g)) {
    const st = m.index + m[0].length; idx[String(Number(m[1]))] = [t, st, t.indexOf('"', st)];
  }
  // 足りないモジュールが別のチャンクにある時のため、static/js の残りも探す
  const missing = () => maps.some(mp => mp.entries.some(([, id]) => !idx[id]));
  log('model lists', maps.map(m => m.id + ':' + m.entries.length).join(' '), 'missing?', missing());

  // 4) zip を作る(無圧縮)
  const crcT = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), files = [];
  const add = (name, bytes) => files.push([enc.encode(name), bytes]);
  const dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const dirName = mp => {
    const k = mp.entries.map(e => e[0]).join(' ');
    if (k.includes('Player/Player_Model')) return 'lifeform';
    if (k.includes('Spikes_Diamond')) return 'block';
    if (k.includes('Player_Atlas')) return 'player_textures';
    if (k.includes('AK-47.png')) return 'item_icons';
    if (k.includes('cape_cow_cream')) return 'capes';
    if (k.includes('allium.png')) return 'block_textures';
    if (k.includes('67/67_Atlas.png')) return 'lifeform_textures_' + mp.id;
    return 'other_' + mp.id;
  };
  let nModels = 0, nMiss = 0;
  for (const mp of maps) {
    const d = dirName(mp);
    for (const [k, mid] of mp.entries) {
      const x = idx[mid]; if (!x) { nMiss++; continue; }
      add(d + '/' + k, dec(x[0].slice(x[1], x[2]))); nModels++;
    }
  }
  // 調べる用に JS もそのまま入れる
  for (const [u, t] of Object.entries(js)) add('js/' + u.split('/').pop(), enc.encode(t));
  add('info.json', enc.encode(JSON.stringify({ date: new Date().toISOString(), urls, lists: maps.map(m => [m.id, m.entries.length]), nModels, nMiss }, null, 1)));

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
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bloxd_models.zip';
  document.body.appendChild(a); a.click();
  log('done:', nModels, 'models,', nMiss, 'missing,', (blob.size / 1048576).toFixed(1) + 'MB');
})();
