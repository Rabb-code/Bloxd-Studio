// icons.js
// ============================================================
// アイコン: 画面の絵文字を、アイコンに置きかえる。
//   どの絵文字を何にするかは icons.csv(このフォルダ)で決める。書きかえて読み直すと変わる。
//   2列目: Google Material Symbols の名前 / そのページのリンク / png・svg の場所やURL / 空=絵文字のまま
//   Material Symbols は Google Fonts から、使う名前だけを読み込む(読み込めなかった時は絵文字のまま)。
//   画面の文字の中の絵文字を、見つけしだい置きかえる(MutationObserver)。
//   置きかえないところ: 文字の入力欄・選択肢(select)・プレビューのテキスト(動画に出る文字)・コードエディタ。
// ============================================================

const ICONS_DEFAULT_CSV = `# アイコンの表(画面の絵文字を、ここで決めたアイコンに置きかえる)
# 1列目: 画面に出ている絵文字 / 2列目: アイコン / 3列目: メモ(自由)
# 2列目に書けるもの:
#   ・Google Material Symbols の名前                          例: videocam
#   ・Google Material Symbols のページのリンク(そのまま貼る)  例: https://fonts.google.com/icons?selected=Material+Symbols+Outlined:videocam:FILL@0;wght@400;GRAD@0;opsz@24
#        Rounded / Sharp のリンクならその形、FILL@1 なら塗りつぶしになる
#   ・png / svg などの画像(このフォルダからの場所 or https のURL)  例: icons/camera.png
#   ・空にする / emoji と書く → 絵文字のまま
# 書きかえたら、ページを読み直す(Cmd+Shift+R)と変わります。
emoji,icon,memo
🎥,videocam,カメラ
📷,photo_camera,写真・今の視点
📝,text_fields,テキスト
💥,flare,パーティクル
✨,auto_awesome,エフェクト・キラキラ
🎵,music_note,音楽・音
🕺,accessibility_new,ポーズ
🎬,movie,書き出し・プレビュー
🎞,theaters,切り替えの演出・自動カット
🖼,picture_in_picture,小窓
⚙,settings,設定
💾,save,保存
📂,folder_open,開く
🗑,delete,削除
✕,close,閉じる・消す
＋,add,追加
✎,edit,名前を変える
⭐,star,カスタム・保存
★,star,お気に入り
⬆,upload,読み込む
⬇,download,書き出す(ファイル)
▶,play_arrow,再生
⏸,pause,停止
⏮,skip_previous,先頭へ
↶,undo,取り消し
↷,redo,やり直し
↺,restart_alt,戻す
↻,refresh,作り直す
✂,content_cut,分割
⚠,warning,注意
✅,check_circle,できた
✓,check,チェック
⚡,bolt,自動アニメーション
🧱,view_in_ar,ブロック
🧸,toys,人形
🎭,theater_comedy,全体アニメ
🌊,waves,ウェーブ
🦘,sports_gymnastics,ジャンプ
🎈,flight_takeoff,浮く
🧍,person,プレイヤー
🔗,link,くっつく
🎯,ads_click,選ぶ・向ける
✋,back_hand,はなす
📍,location_on,プレイヤーへ移動
🌐,public,公開・グローバル
👁,visibility,見る
👀,visibility,見る
🔍,search,探す・寄る
🔄,360,周りを回る
↔,swap_horiz,横から・伸ばす
⇄,swap_horiz,入れ替え
🏃,directions_run,走る・追いかける
🚶,directions_walk,歩く
👋,waving_hand,手を振る
🙌,celebration,バンザイ
💃,nightlife,ダンス
🙇,self_improvement,おじぎ
👉,arrow_right_alt,指さす
🪑,chair,座る
😴,bedtime,寝る
🙂,face,正面から
🛗,elevator,上へ昇る
⏳,hourglass_top,待つ
📖,menu_book,説明
🎲,casino,ランダム
🪟,window,ガラス
🎉,celebration,広がる
🏹,call_made,飛ぶ物
🌬,air,風切り音
💨,air,シュッ
🎻,graphic_eq,重低音
📈,trending_up,盛り上がり
👊,sports_mma,パンチ
🫧,bubble_chart,ポン
🔔,notifications,ピコン
🔇,volume_off,消音
`;

const iconMap = new Map(); // 絵文字 -> { kind:'ms', name, family, fill } | { kind:'img', src }
let _iconRegex = null;
let _iconFontsReady = new Set(); // 読み込めた Material Symbols の形('Outlined' など)

function _iconParseSpec(v) {
  v = String(v || '').trim();
  if (!v || v.toLowerCase() === 'emoji') return null;
  let m = v.match(/Material\+Symbols\+(Outlined|Rounded|Sharp):([a-z0-9_]+)/i);
  if (m) {
    const fill = /FILL@1/.test(v) ? 1 : 0;
    return { kind: 'ms', family: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), name: m[2].toLowerCase(), fill };
  }
  m = v.match(/[?&]icon\.query=([a-z0-9_]+)/i);
  if (m && /fonts\.google\.com/.test(v)) return { kind: 'ms', family: 'Outlined', name: m[1].toLowerCase(), fill: 0 };
  if (/\.(png|svg|webp|jpe?g|gif)(\?.*)?$/i.test(v) || /^(https?:|data:|\.?\/)/i.test(v)) return { kind: 'img', src: v };
  if (/^[a-z0-9_]+$/i.test(v)) return { kind: 'ms', family: 'Outlined', name: v.toLowerCase(), fill: 0 };
  return null;
}

function iconParseCsv(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',');
    const emoji = (cols[0] || '').trim().replace(/\uFE0F/g, '');
    if (!emoji || emoji === 'emoji') continue;
    out.set(emoji, _iconParseSpec(cols[1]));
  }
  return out;
}

function _iconBuildRegex() {
  const keys = [...iconMap.keys()].filter(k => iconMap.get(k) && _iconUsable(iconMap.get(k)));
  if (!keys.length) { _iconRegex = null; return; }
  keys.sort((a, b) => b.length - a.length);
  const esc = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  _iconRegex = new RegExp('(' + esc.join('|') + ')\uFE0F?', 'g');
}
function _iconUsable(spec) { return spec.kind === 'img' || _iconFontsReady.has(spec.family); }

// Google Fonts から、使う名前だけを読み込む
async function _iconLoadFonts() {
  const byFamily = new Map();
  for (const spec of iconMap.values()) {
    if (!spec || spec.kind !== 'ms') continue;
    if (!byFamily.has(spec.family)) byFamily.set(spec.family, new Set());
    byFamily.get(spec.family).add(spec.name);
  }
  const tasks = [];
  for (const [family, names] of byFamily) {
    const fam = 'Material Symbols ' + family;
    const list = [...names].sort();
    const longest = list.reduce((a, b) => (b.length > a.length ? b : a), '');
    const add = (url) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = url; document.head.appendChild(l); };
    const base = `https://fonts.googleapis.com/css2?family=Material+Symbols+${family}:opsz,wght,FILL,GRAD@24,400,0..1,0`;
    add(`${base}&icon_names=${list.join(',')}&display=block`);
    tasks.push((async () => {
      const ok = async (ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          try { await document.fonts.load(`24px "${fam}"`, list[0]); } catch (e) { /* 無視 */ }
          if (_iconFontWorks(fam, longest)) return true;
          await new Promise(r => setTimeout(r, 300));
        }
        return false;
      };
      if (await ok(4000)) { _iconFontsReady.add(family); return; }
      // 名前をしぼった読み込みができなかった時は、全部入りを読む
      add(`${base}&display=block`);
      if (await ok(8000)) _iconFontsReady.add(family);
    })());
  }
  await Promise.all(tasks);
}

// 本当にアイコンの形になるか。フォントが読めていれば、どんなに長い名前でも1文字ぶんの幅になる
// (読めていないと、名前の文字がそのまま並んで幅が広くなる)
function _iconFontWorks(fam, name) {
  try {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `24px "${fam}", monospace`;
    const w = c.measureText(name).width;
    c.font = '24px monospace';
    const plain = c.measureText(name).width;
    return w <= 24 * 1.35 && w < plain * 0.6;
  } catch (e) { return false; }
}

function iconNode(spec, emoji) {
  if (spec.kind === 'img') {
    const im = document.createElement('img');
    im.className = 'mi-img'; im.src = spec.src; im.alt = emoji; im.draggable = false;
    im.setAttribute('aria-hidden', 'true');
    im.onerror = () => { im.replaceWith(document.createTextNode(emoji)); };
    return im;
  }
  const s = document.createElement('span');
  s.className = 'mi mi-' + spec.family.toLowerCase() + (spec.fill ? ' mi-fill' : '');
  s.textContent = spec.name;
  s.dataset.emoji = emoji;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

const ICON_SKIP = 'textarea, input, select, option, script, style, #textOverlayLayer, .mi, [data-noicon], .CodeMirror, .scriptCode, #scriptEditor';

function _iconProcessText(node) {
  if (!_iconRegex || !node.nodeValue) return;
  _iconRegex.lastIndex = 0;
  if (!_iconRegex.test(node.nodeValue)) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(ICON_SKIP) || parent.isContentEditable) return;
  const text = node.nodeValue;
  const frag = document.createDocumentFragment();
  let last = 0;
  _iconRegex.lastIndex = 0;
  let m;
  while ((m = _iconRegex.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(iconNode(iconMap.get(m[1]), m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  node.replaceWith(frag);
}

function iconScan(root) {
  if (!_iconRegex || !root) return;
  if (root.nodeType === 3) { _iconProcessText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1 && root.closest && root.closest(ICON_SKIP)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) _iconProcessText(n);
}

let _iconObserver = null;
async function iconsInit() {
  if (iconsInit.done) return;
  iconsInit.done = true;
  for (const [k, v] of iconParseCsv(ICONS_DEFAULT_CSV)) iconMap.set(k, v);
  // フォルダの icons.csv があれば、そちらで上書きする
  try {
    const res = await fetch('icons.csv', { cache: 'no-store' });
    if (res.ok) {
      const user = iconParseCsv(await res.text());
      if (user.size) { iconMap.clear(); for (const [k, v] of user) iconMap.set(k, v); }
    }
  } catch (e) { /* 無ければ標準の表 */ }
  await _iconLoadFonts();
  _iconBuildRegex();
  if (!_iconRegex) return;
  iconScan(document.body);
  _iconObserver = new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.type === 'characterData') _iconProcessText(mu.target);
      else for (const n of mu.addedNodes) iconScan(n);
    }
  });
  _iconObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iconsInit);
else iconsInit();
