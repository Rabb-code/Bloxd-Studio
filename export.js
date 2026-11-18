// export.js
// ============================================================
// 🎬 書き出し(動画ファイルにする)
//   プレビューと同じ合成(カメラ・小窓・切り替えの演出)を、書き出す解像度で1フレームずつ描いて、
//   テキストを2Dで重ね、音(audio.js)と一緒に MediaRecorder で録画する。
//   録画は実際の時間で進む(20秒の動画なら20秒かかる)。書き出し中はタブを開いたままにする。
//   形式: mp4 が録れるブラウザ(新しい Chrome など)は mp4、それ以外は webm。
// ============================================================

let exportState = null; // 書き出し中 { cancel, ... }

const EXPORT_FPS = 30;
// 音あり・音なしで、使える形式の候補(上から順に試す)
const EXPORT_MIME_CANDIDATES = {
  audio: [
    ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'], ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm', 'webm'],
  ],
  video: [
    ['video/mp4;codecs=avc1.640028', 'mp4'], ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp8', 'webm'], ['video/webm;codecs=vp9', 'webm'], ['video/webm', 'webm'],
  ],
};

function _exportCandidates(withAudio) {
  if (typeof MediaRecorder === 'undefined') return [];
  return EXPORT_MIME_CANDIDATES[withAudio ? 'audio' : 'video'].filter(([m]) => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
}
function exportPickMime(withAudio) {
  const c = _exportCandidates(!!withAudio);
  return c.length ? { mime: c[0][0], ext: c[0][1] } : null;
}

// 実際に作れる録画機(候補を順に試す)。{ rec, mime, ext }
function _exportMakeRecorder(stream, withAudio, bps) {
  for (const [mime, ext] of _exportCandidates(withAudio)) {
    try {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps, ...(withAudio ? { audioBitsPerSecond: 192000 } : {}) });
      return { rec, mime, ext };
    } catch (e) { /* 次の候補 */ }
  }
  return null;
}

// 書き出す範囲(tick)
function exportRange(mode) {
  const max = scMaxTick();
  if (mode === 'all' || !sceneCameras.length) return [0, max];
  let s = Infinity, e = -Infinity;
  for (const c of sceneCameras) { s = Math.min(s, c.startTick); e = Math.max(e, c.endTick); }
  return [Math.max(0, s), Math.min(max, e)];
}


// ============================================================
// テキストを2Dのキャンバスに描く(プレビューのDOMと同じ見た目にする)
// ============================================================

function ctDrawTextToCanvas(g, block, W, H, anim) {
  const k = H / TEXT_REFERENCE_HEIGHT;
  const font = TEXT_FONTS[block.font] || TEXT_FONTS.gothic;
  const fs = Math.max(4, block.fontSize * k);
  const alpha = (block.opacity / 100) * anim.opacity;
  if (alpha <= 0.002) return;
  const text = anim.chars === Infinity ? block.content : Array.from(block.content).slice(0, anim.chars).join('');
  const lines = String(text).split('\n');
  g.save();
  g.globalAlpha = alpha;
  g.font = `${block.italic ? 'italic ' : ''}${block.weight} ${fs}px ${font.css}`;
  try { g.letterSpacing = (block.letterSpacing / 100 * fs) + 'px'; } catch (e) { /* 古いブラウザ */ }
  const lh = fs * block.lineHeight;
  const tw = Math.max(1, ...lines.map(l => g.measureText(l).width));
  const bgA = block.bgOpacity / 100;
  const padY = bgA > 0 ? block.bgPadding * k * 0.6 : 2 * k, padX = bgA > 0 ? block.bgPadding * k : 4 * k;
  const boxW = tw + padX * 2, boxH = lines.length * lh + padY * 2;
  g.translate(block.x * W + anim.dx * H, block.y * H + anim.dy * H);
  g.rotate((block.rotation || 0) * Math.PI / 180);
  g.scale(anim.scale, anim.scale);
  if (bgA > 0) {
    g.fillStyle = _hexToRgba(block.bgColor, bgA);
    const r = Math.min(block.bgRadius * k, boxW / 2, boxH / 2);
    g.beginPath();
    if (g.roundRect) g.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, r); else g.rect(-boxW / 2, -boxH / 2, boxW, boxH);
    g.fill();
  }
  const sc = block.shadowColor;
  const shadows = {
    none: [],
    soft: [[0, 2 * k, 6 * k, _hexToRgba(sc, 0.65)]],
    hard: [[3 * k, 3 * k, 0, _hexToRgba(sc, 0.9)]],
    glow: [[0, 0, 8 * k, _hexToRgba(sc, 0.95)], [0, 0, 18 * k, _hexToRgba(sc, 0.7)]],
  }[block.shadow] || [];
  g.textBaseline = 'middle';
  g.textAlign = block.align === 'left' ? 'left' : block.align === 'right' ? 'right' : 'center';
  const x0 = block.align === 'left' ? -boxW / 2 + padX : block.align === 'right' ? boxW / 2 - padX : 0;
  const sw = block.strokeWidth > 0 ? block.strokeWidth * k * 2 : 0;
  lines.forEach((line, i) => {
    const y = -boxH / 2 + padY + lh * (i + 0.5);
    const paint = () => {
      if (sw > 0) { g.lineWidth = sw; g.lineJoin = 'round'; g.strokeStyle = block.strokeColor; g.strokeText(line, x0, y); }
      g.fillStyle = block.color; g.fillText(line, x0, y);
    };
    // 影は、影だけの絵を先に描いてから、文字を上に描く
    for (const [sx, sy, blur, col] of shadows) {
      g.save();
      g.shadowOffsetX = sx; g.shadowOffsetY = sy; g.shadowBlur = blur; g.shadowColor = col;
      paint();
      g.restore();
    }
    paint();
  });
  g.restore();
}


// ============================================================
// 書き出しの画面
// ============================================================

function exportInit() {
  // ステップ44: 上のバーの右はし(ui の #exportSlot)
  const slot = document.getElementById('exportSlot');
  if (!slot || document.getElementById('exportBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'exportBtn'; btn.type = 'button';
  btn.innerHTML = '<svg class="uiIco" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>書き出し';
  btn.title = '動画ファイルに書き出す';
  btn.addEventListener('click', openExportDialog);
  slot.appendChild(btn);
}

function _exportModal() {
  let m = document.getElementById('exportModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'exportModal';
  m.innerHTML = '<div id="exportBox"><div id="exportHead"><h2>🎬 動画を書き出す</h2><button id="exportClose" type="button">✕</button></div><div id="exportBody"></div></div>';
  document.body.appendChild(m);
  m.querySelector('#exportClose').addEventListener('click', () => { if (exportState) exportCancel(); else m.classList.remove('open'); });
  return m;
}

let _exportOpts = { range: 'cams', audio: true, fps: 30 };

function openExportDialog() {
  if (typeof stopPlayback === 'function') stopPlayback();
  const m = _exportModal();
  m.classList.add('open');
  _renderExportSetup();
}

function _renderExportSetup() {
  const body = document.getElementById('exportBody');
  body.innerHTML = '';
  const pick = exportPickMime(true) || exportPickMime(false);
  const tps = scTps();
  const pills = (label, items, cur, onPick) => {
    const r = _el('div', 'fieldRow column');
    r.appendChild(_el('label', null, label));
    const g = _el('div', 'settingsRadioGroup');
    for (const [id, name] of items) {
      const p = _el('button', 'settingsRadioPill' + (id === cur ? ' active' : ''), name);
      p.type = 'button';
      p.addEventListener('click', () => { onPick(id); _renderExportSetup(); });
      g.appendChild(p);
    }
    r.appendChild(g);
    body.appendChild(r);
  };
  if (!sceneCameras.length) {
    body.appendChild(_el('div', 'exportWarn', '⚠ カメラがまだありません。書き出す映像は、置いたカメラの映像です。左の素材一覧の「🎥 カメラ」から置いてください。'));
    return;
  }
  if (!pick) {
    body.appendChild(_el('div', 'exportWarn', '⚠ このブラウザは動画の録画(MediaRecorder)に対応していません。Chrome / Edge / Firefox の新しい版で開いてください。'));
    return;
  }
  const [s, e] = exportRange(_exportOpts.range);
  pills('範囲', [['cams', `カメラのある所(${(s / tps).toFixed(1)}〜${(e / tps).toFixed(1)}秒)`], ['all', 'リプレイ全部']], _exportOpts.range, id => { _exportOpts.range = id; });
  pills('解像度', Object.entries(EXPORT_RESOLUTION_PRESETS).map(([id, p]) => [id, p.label]), exportResolutionId, id => { exportResolutionId = id; });
  // ステップ55: なめらかさ(1コマずつ作る書き出しの時だけ)
  if (_exportOfflineAvailable()) pills('なめらかさ', [['30', '30コマ/秒'], ['60', '60コマ/秒(なめらか)']], String(_exportOpts.fps || 30), id => { _exportOpts.fps = +id; });
  pills('画質', Object.entries(EXPORT_QUALITY_PRESETS).map(([id, p]) => [id, p.label]), exportQualityId, id => { exportQualityId = id; });
  const hasAudio = typeof audioClips !== 'undefined' && audioClips.some(c => !c.mute);
  const aRow = _el('label', 'scriptCheck');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = hasAudio && _exportOpts.audio; cb.disabled = !hasAudio;
  cb.addEventListener('change', () => { _exportOpts.audio = cb.checked; });
  aRow.appendChild(cb);
  aRow.appendChild(document.createTextNode(hasAudio ? '音(BGM・効果音)を入れる' : '音(タイムラインに音がありません)'));
  body.appendChild(aRow);
  const len = (e - s) / tps;
  body.appendChild(_el('div', 'panelHint', _exportOfflineAvailable()
    ? `長さ ${len.toFixed(1)}秒。1コマずつ作るので、コマが抜けません(重い場面では、動画の長さより時間がかかることがあります)。書き出し中は、このタブを開いたままにしてください。`
    : `長さ ${len.toFixed(1)}秒 · 形式 ${pick.ext.toUpperCase()} · 30fps。書き出しは実際の時間で進みます(約${Math.ceil(len)}秒かかります)。書き出し中は、このタブを開いたままにしてください。`));
  const acts = _el('div', 'panelActions');
  const go = _el('button', 'btn btn-primary', '🎬 書き出しを始める');
  go.addEventListener('click', () => exportStart());
  acts.appendChild(go);
  body.appendChild(acts);
}


// ============================================================
// 書き出し本体
// ============================================================

async function exportStart() {
  if (exportState) return;
  const pick = exportPickMime(false) || exportPickMime(true);
  if (!pick) return;
  const [startTick, endTick] = exportRange(_exportOpts.range);
  if (endTick - startTick < 1) { showToast('書き出す範囲がありません'); return; }
  const [W, H] = (EXPORT_RESOLUTION_PRESETS[exportResolutionId] || EXPORT_RESOLUTION_PRESETS.hd1080).size;
  const bps = (EXPORT_QUALITY_PRESETS[exportQualityId] || EXPORT_QUALITY_PRESETS.high).bitsPerSecond;
  const tps = scTps();
  const body = document.getElementById('exportBody');
  body.innerHTML = '';
  // ステップ51: 使えるブラウザでは、1コマずつ作る(コマが抜けない)
  if (_exportOfflineAvailable()) {
    const withAudio = _exportOpts.audio && typeof audioClips !== 'undefined' && audioClips.some(c => !c.mute);
    let done = false;
    try { done = await _exportOffline({ startTick, endTick, W, H, bps, tps, body, withAudio, fps: _exportOpts.fps }); }
    catch (e) { console.error('[書き出し] 1コマずつの書き出しに失敗しました。録画のやり方で書き出します:', e); exportState = null; body.innerHTML = ''; }
    if (done) return;
  }
  const status = _el('div', 'exportStatus', '準備しています…');
  const barWrap = _el('div', 'exportBar'); const bar = _el('div', 'exportBarFill'); barWrap.appendChild(bar);
  const cancel = _el('button', 'btn btn-ghost btn-sm', '中止');
  cancel.addEventListener('click', exportCancel);
  body.appendChild(status); body.appendChild(barWrap); body.appendChild(cancel);

  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* 無視 */ }

  const saved = { tick: curTick, previewIsMain, w: fcCanvas.width, h: fcCanvas.height, sel: selectedTextBlockId };
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  const vstream = out.captureStream(EXPORT_FPS);
  const tracks = [...vstream.getVideoTracks()];
  let dest = null, silence = null;
  const withAudio = _exportOpts.audio && typeof audioClips !== 'undefined' && audioClips.some(c => !c.mute);
  if (withAudio) {
    // 音の時計が止まっている(ブラウザが音を止めている)と、録画が進まないので、先に動かす
    const ctx = audioCtx();
    try { await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* 無視 */ }
    if (ctx.state === 'running') {
      dest = ctx.createMediaStreamDestination();
      tracks.push(...dest.stream.getAudioTracks());
      // 音が鳴っていない所でも、無音を流し続ける(音が途切れると、録画が進まないブラウザがある)
      silence = ctx.createConstantSource(); silence.offset.value = 0; silence.connect(dest); silence.start();
    } else {
      showToast('⚠ ブラウザが音を止めているので、音なしで書き出します');
    }
  }
  const stream = new MediaStream(tracks);
  const chunks = [];
  const made = _exportMakeRecorder(stream, !!dest, bps);
  if (!made) {
    for (const t of tracks) t.stop();
    body.innerHTML = '';
    body.appendChild(_el('div', 'exportWarn', '⚠ このブラウザでは、この形式の録画ができませんでした。Chrome / Edge の新しい版で試してください。'));
    return;
  }
  const rec = made.rec;
  pick.mime = made.mime; pick.ext = made.ext;
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };

  exportState = { cancel: false, rec, startTick, endTick, W, H };
  fcCanvas.width = W; fcCanvas.height = H;
  previewIsMain = true;
  selectedTextBlockId = null; // 書き出しでは、選んでいるテキストも動きを付けて出す

  const drawFrame = (tick) => {
    curTick = tick;
    renderPreviewComposite(fcGl, true, tick);
    g.drawImage(fcCanvas, 0, 0, W, H);
    for (const b of ctActiveTextBlocksAtTick(tick)) ctDrawTextToCanvas(g, b, W, H, ctAnimState(b, tick, true));
  };
  drawFrame(startTick);
  status.innerText = '録画の準備をしています…';
  // 録画が本当に始まるまで待つ(動画の圧縮の準備に時間がかかるブラウザがある)
  await new Promise((resolve) => {
    rec.onstart = resolve;
    setTimeout(resolve, 6000);
    rec.start(250);
  });
  for (let i = 0; i < 3; i++) { await new Promise(r => requestAnimationFrame(r)); drawFrame(startTick); }
  // 音は少し先の時刻から鳴らし、映像の時計をそれに合わせる
  let t0 = performance.now() + 120;
  if (dest) {
    const ctx = audioCtx();
    const when0 = audioPlayFrom(startTick, dest, 0.12);
    t0 = performance.now() + (when0 - ctx.currentTime) * 1000;
  }
  const total = (endTick - startTick) / tps;

  await new Promise((resolve) => {
    const step = () => {
      if (exportState.cancel) { resolve(); return; }
      const now = performance.now();
      const el = Math.max(0, (now - t0) / 1000);
      const tick = Math.min(endTick - 1, startTick + Math.floor(el * tps));
      try { drawFrame(tick); } catch (err) { console.error('書き出しの描画でエラー:', err); }
      const p = Math.min(1, el / total);
      bar.style.width = (p * 100).toFixed(1) + '%';
      status.innerText = `書き出し中… ${el.toFixed(1)} / ${total.toFixed(1)}秒(タブを開いたままにしてください)`;
      if (el >= total) { resolve(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  const cancelled = exportState.cancel;
  await new Promise((resolve) => { rec.onstop = resolve; try { rec.stop(); } catch (e) { resolve(); } });
  if (typeof audioStopAll === 'function') audioStopAll();
  if (silence) { try { silence.stop(); silence.disconnect(); } catch (e) { /* 無視 */ } }
  for (const t of tracks) t.stop();
  // 元に戻す
  curTick = saved.tick; previewIsMain = saved.previewIsMain; selectedTextBlockId = saved.sel;
  fcCanvas.width = saved.w; fcCanvas.height = saved.h;
  exportState = null;
  if (typeof editorChanged === 'function') editorChanged();

  if (cancelled) { document.getElementById('exportModal').classList.remove('open'); showToast('書き出しを中止しました'); return; }
  let blob = new Blob(chunks, { type: pick.mime.split(';')[0] });
  if (pick.ext === 'webm') blob = await _fixWebmDuration(blob, total * 1000);
  _exportShowResult(blob, pick.ext, total);
}

// MediaRecorder の webm には長さが書かれていない(シークできない)ので、Segment > Info に Duration を足す
async function _fixWebmDuration(blob, durationMs) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const readVint = (p, keepMarker) => {
      const b0 = buf[p];
      let len = 1, mask = 0x80;
      while (len <= 8 && !(b0 & mask)) { len++; mask >>= 1; }
      if (len > 8) return null;
      let v = keepMarker ? b0 : (b0 & (mask - 1));
      let unknown = (b0 & (mask - 1)) === mask - 1;
      for (let i = 1; i < len; i++) { v = v * 256 + buf[p + i]; if (buf[p + i] !== 0xff) unknown = false; }
      return { v, len, unknown };
    };
    const el = (p) => {
      const id = readVint(p, true); if (!id) return null;
      const sz = readVint(p + id.len, false); if (!sz) return null;
      return { id: id.v, start: p, dataStart: p + id.len + sz.len, size: sz.unknown ? Infinity : sz.v };
    };
    let p = 0;
    const ebml = el(p); if (!ebml || ebml.id !== 0x1A45DFA3) return blob;
    p = ebml.dataStart + ebml.size;
    const seg = el(p); if (!seg || seg.id !== 0x18538067) return blob;
    p = seg.dataStart;
    while (p < buf.length) {
      const e = el(p); if (!e || !isFinite(e.size)) return blob;
      if (e.id === 0x1549A966) { // Info
        // 中に Duration があれば何もしない
        let q = e.dataStart;
        while (q < e.dataStart + e.size) { const c = el(q); if (!c) break; if (c.id === 0x4489) return blob; q = c.dataStart + c.size; }
        const dur = new Uint8Array(11);
        dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
        new DataView(dur.buffer).setFloat64(3, durationMs);
        const newSize = e.size + dur.length;
        const head = new Uint8Array(4 + 8);
        head.set([0x15, 0x49, 0xA9, 0x66], 0);
        head[4] = 0x01; // 8バイトの大きさ
        let n = newSize;
        for (let i = 11; i >= 5; i--) { head[i] = n % 256; n = Math.floor(n / 256); }
        return new Blob([buf.subarray(0, e.start), head, buf.subarray(e.dataStart, e.dataStart + e.size), dur, buf.subarray(e.dataStart + e.size)], { type: blob.type });
      }
      p = e.dataStart + e.size;
    }
  } catch (err) { console.warn('webm の長さを書けませんでした:', err); }
  return blob;
}

function exportCancel() { if (exportState) exportState.cancel = true; }

let _exportLastUrl = null;
function _exportShowResult(blob, ext, seconds) {
  if (_exportLastUrl) URL.revokeObjectURL(_exportLastUrl);
  const url = URL.createObjectURL(blob);
  _exportLastUrl = url;
  window._lastExportBlob = blob;
  const base = ((typeof currentReplayInfo !== 'undefined' && currentReplayInfo && currentReplayInfo.name) || 'bloxd').replace(/\.[^.]+$/, '');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const name = `${base}_${stamp}.${ext}`;
  const body = document.getElementById('exportBody');
  body.innerHTML = '';
  body.appendChild(_el('div', 'exportStatus', `✅ できました(${seconds.toFixed(1)}秒 · ${(blob.size / 1024 / 1024).toFixed(1)}MB)`));
  const v = document.createElement('video');
  v.className = 'exportVideo'; v.src = url; v.controls = true;
  body.appendChild(v);
  const acts = _el('div', 'panelActions');
  const a = document.createElement('a');
  a.className = 'btn btn-primary'; a.href = url; a.download = name; a.innerText = '⬇ ' + name + ' を保存';
  acts.appendChild(a);
  const again = _el('button', 'btn btn-ghost btn-sm', 'もう一度書き出す');
  again.addEventListener('click', _renderExportSetup);
  acts.appendChild(again);
  body.appendChild(acts);
  a.click();
}

// ============================================================
// ステップ51: 1コマずつ作る書き出し(WebCodecs)
//   前は実際の時間で録画していたので、描くのが間に合わないコマが抜けてカクカクしていた(増田さん)。
//   今は全部のコマを順番に描いて、動画の圧縮(VideoEncoder)に渡す。時間がかかっても、コマは抜けない。
//   音は OfflineAudioContext で先に全部作ってから圧縮する。入れ物(mp4 / webm)は lib/ の mp4-muxer・webm-muxer(MIT)。
//   使えないブラウザでは、前の録画のやり方に戻す。
// ============================================================

function _exportOfflineAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' &&
    (typeof Mp4Muxer !== 'undefined' || typeof WebMMuxer !== 'undefined');
}

// 使える映像・音の圧縮の組み合わせをさがす。{ kind:'mp4'|'webm', vcfg, acfg|null, vcodec, acodec }
async function _exportPickOffline(W, H, bps, withAudio, FPS) {
  const big = W * H > 1920 * 1088;
  const tries = [];
  if (typeof Mp4Muxer !== 'undefined') {
    for (const c of (big ? ['avc1.640033', 'avc1.4d0033'] : ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'])) tries.push(['mp4', c, 'avc']);
  }
  if (typeof WebMMuxer !== 'undefined') { tries.push(['webm', 'vp09.00.40.08', 'V_VP9']); tries.push(['webm', 'vp8', 'V_VP8']); }
  for (const [kind, codec, mcodec] of tries) {
    const vcfg = { codec, width: W, height: H, bitrate: bps, framerate: FPS, latencyMode: 'quality' };
    if (kind === 'mp4') vcfg.avc = { format: 'avc' };
    let ok = false;
    try { ok = (await VideoEncoder.isConfigSupported(vcfg)).supported; } catch (e) { ok = false; }
    if (!ok) continue;
    let acfg = null, acodec = null;
    if (withAudio && typeof AudioEncoder !== 'undefined') {
      const acands = kind === 'mp4' ? [['mp4a.40.2', 'aac'], ['opus', 'opus']] : [['opus', 'A_OPUS']];
      for (const [ac, mc] of acands) {
        const cfg = { codec: ac, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
        let aok = false;
        try { aok = (await AudioEncoder.isConfigSupported(cfg)).supported; } catch (e) { aok = false; }
        if (aok) { acfg = cfg; acodec = mc; break; }
      }
      if (!acfg) continue;   // 音を入れたいのに音を圧縮できない組み合わせは使わない
    }
    return { kind, vcfg, acfg, vcodec: mcodec, acodec };
  }
  return null;
}

// 音を全部先に作る(OfflineAudioContext)。AudioBuffer か null
async function _exportRenderAudio(startTick, seconds) {
  if (typeof audioClips === 'undefined' || !audioClips.some(c => !c.mute)) return null;
  const sr = 48000, len = Math.max(1, Math.ceil(seconds * sr));
  const octx = new OfflineAudioContext(2, len, sr);
  let n = 0;
  for (const c of audioClips) if (_audioScheduleClip(octx, octx.destination, c, 0, startTick / scTps())) n++;
  if (!n) return null;
  return await octx.startRendering();
}

async function _exportOffline(opts) {
  const { startTick, endTick, W, H, tps, body, withAudio } = opts;
  // ステップ55: 60コマ/秒(コマの間は、カメラ・人やモブの位置をなめらかにつなぐ)
  const FPS = opts.fps === 60 ? 60 : 30;
  const bps = Math.round(opts.bps * (FPS === 60 ? 1.5 : 1));
  const pick = await _exportPickOffline(W, H, bps, withAudio, FPS);
  if (!pick) return false;   // 前のやり方へ

  const status = _el('div', 'exportStatus', '準備しています…');
  const barWrap = _el('div', 'exportBar'); const bar = _el('div', 'exportBarFill'); barWrap.appendChild(bar);
  const cancel = _el('button', 'btn btn-ghost btn-sm', '中止');
  cancel.addEventListener('click', exportCancel);
  body.appendChild(status); body.appendChild(barWrap); body.appendChild(cancel);
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* 無視 */ }

  const total = (endTick - startTick) / tps;
  const nFrames = Math.max(1, Math.round(total * FPS));
  const saved = { tick: curTick, previewIsMain, w: fcCanvas.width, h: fcCanvas.height, sel: selectedTextBlockId };
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');

  // 音
  let audioBuf = null;
  if (pick.acfg) {
    status.innerText = '音を作っています…';
    try { audioBuf = await _exportRenderAudio(startTick, total); } catch (e) { console.warn('[書き出し] 音を作れませんでした:', e); audioBuf = null; }
  }

  // 入れ物
  let muxer, target;
  const audioOpt = audioBuf ? { codec: pick.acodec, numberOfChannels: 2, sampleRate: 48000 } : undefined;
  if (pick.kind === 'mp4') {
    target = new Mp4Muxer.ArrayBufferTarget();
    muxer = new Mp4Muxer.Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: FPS }, audio: audioOpt, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  } else {
    target = new WebMMuxer.ArrayBufferTarget();
    muxer = new WebMMuxer.Muxer({ target, video: { codec: pick.vcodec, width: W, height: H, frameRate: FPS }, audio: audioOpt, firstTimestampBehavior: 'offset' });
  }
  let encErr = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  venc.configure(pick.vcfg);

  exportState = { cancel: false, startTick, endTick, W, H, offline: true };
  fcCanvas.width = W; fcCanvas.height = H;
  previewIsMain = true;
  selectedTextBlockId = null;
  // sub = コマの間のどこか(0〜1)。リプレイは 1秒に tps 回の記録なので、その間はカメラ・人の位置・文字の動きをつなぐ
  const drawFrame = (tick, sub) => {
    curTick = tick;
    fcSubTick = sub || 0;
    try { renderPreviewComposite(fcGl, true, tick); } finally { fcSubTick = 0; }
    g.drawImage(fcCanvas, 0, 0, W, H);
    for (const b of ctActiveTextBlocksAtTick(tick)) ctDrawTextToCanvas(g, b, W, H, ctAnimState(b, tick + (sub || 0), true));
  };

  const t0 = performance.now();
  let lastUi = 0;
  try {
    for (let i = 0; i < nFrames; i++) {
      if (exportState.cancel || encErr) break;
      const ft = Math.min(endTick - 1, startTick + i * tps / FPS + 1e-6);
      const tick = Math.floor(ft);
      const sub = ft - tick;
      drawFrame(tick, sub < 0.01 || tick >= endTick - 1 ? 0 : sub);
      const vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      // 圧縮が追いつくのを待つ(たまりすぎるとメモリを使う)
      while (venc.encodeQueueSize > 6 && !encErr) await new Promise(r => setTimeout(r, 1));
      const now = performance.now();
      if (now - lastUi > 150) {
        lastUi = now;
        const p = (i + 1) / nFrames;
        bar.style.width = (p * 100).toFixed(1) + '%';
        const el = (now - t0) / 1000, left = p > 0.02 ? el / p - el : 0;
        status.innerText = `書き出し中… ${i + 1} / ${nFrames} コマ` + (left > 1 ? `(あと約${Math.ceil(left)}秒)` : '');
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (!exportState.cancel && !encErr) { status.innerText = '仕上げています…'; await venc.flush(); }
    // 音を圧縮して入れる
    if (audioBuf && !exportState.cancel && !encErr) {
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encErr = e; } });
      aenc.configure(pick.acfg);
      const N = audioBuf.length, CH = 2, STEP = 4800;
      const L = audioBuf.getChannelData(0), R = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : L;
      for (let s = 0; s < N && !encErr; s += STEP) {
        const n = Math.min(STEP, N - s);
        const data = new Float32Array(n * CH);
        data.set(L.subarray(s, s + n), 0); data.set(R.subarray(s, s + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: CH, timestamp: Math.round(s * 1e6 / 48000), data });
        aenc.encode(ad); ad.close();
        while (aenc.encodeQueueSize > 20 && !encErr) await new Promise(r => setTimeout(r, 1));
      }
      if (!encErr) await aenc.flush();
      aenc.close();
    }
  } finally {
    try { venc.close(); } catch (e) { /* 閉じてある */ }
    curTick = saved.tick; previewIsMain = saved.previewIsMain; selectedTextBlockId = saved.sel;
    fcCanvas.width = saved.w; fcCanvas.height = saved.h;
  }
  const cancelled = exportState.cancel;
  exportState = null;
  if (typeof editorChanged === 'function') editorChanged();
  if (cancelled) { document.getElementById('exportModal').classList.remove('open'); showToast('書き出しを中止しました'); return true; }
  if (encErr) {
    console.error('[書き出し] 圧縮でエラー:', encErr);
    body.innerHTML = '';
    body.appendChild(_el('div', 'exportWarn', '⚠ 動画の圧縮でエラーが起きました: ' + (encErr.message || encErr)));
    return true;
  }
  muxer.finalize();
  const blob = new Blob([target.buffer], { type: pick.kind === 'mp4' ? 'video/mp4' : 'video/webm' });
  _exportShowResult(blob, pick.kind, total);
  return true;
}
