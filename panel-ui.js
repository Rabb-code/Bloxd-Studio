// panel-ui.js — ステップ46: 右のパネルを見やすく
//   ・まとまり(.panelSectionLabel の見出し)ごとに、開け閉めできるようにする(開け閉めは覚えておく)
//   ・パネル・タイムラインの文字の先頭の絵文字を消す(アイコンは別に付ける)
//   ・人型の関節を、人の形の図で選ぶ(uiBodyPicker。poses.js から使う)

// 先頭の絵文字(と後ろの空白)。◆(キー)・✕(消す)・▶ などの記号は残す
const _UI_EMOJI_HEAD = /^(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B06}\u{2B50}\u{231A}-\u{23FF}\u{2702}\u{2728}\u{2194}\u{21BA}\u{21BB}\u{2B06}\u{1F5D1}]️?‍?)+\s*/u;

function uiStripEmoji(root) {
  if (!root) return;
  const els = root.querySelectorAll('button, label, .panelSectionLabel, .tlBlockLabel, .poseStatus, .assetCardTitle, h2, h3, span, div.consTitle');
  for (const el of els) {
    const tn = el.firstChild;
    if (!tn || tn.nodeType !== 3) continue;
    const t = tn.nodeValue;
    if (!_UI_EMOJI_HEAD.test(t)) continue;
    const rest = t.replace(_UI_EMOJI_HEAD, '');
    if (!rest.trim() && el.childNodes.length === 1) continue;   // 絵文字だけのボタンは消さない
    tn.nodeValue = rest;
  }
}

// 開け閉めの状態(パネルの種類|見出し → true=開く)
const _uiSecOpen = (() => { try { return JSON.parse(localStorage.getItem('bloxdEditor.panelSections') || '{}'); } catch (e) { return {}; } })();
function _uiSaveSecOpen() { try { localStorage.setItem('bloxdEditor.panelSections', JSON.stringify(_uiSecOpen)); } catch (e) { /* 保存できなくても続ける */ } }
const _UI_CHEVRON = '<svg class="uiIco pSecChev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

function uiPanelEnhance(body, kind) {
  if (!body) return;
  const labels = Array.from(body.children).filter(c => c.classList && c.classList.contains('panelSectionLabel'));
  labels.forEach((lab, idx) => {
    const text = (lab.textContent || '').replace(_UI_EMOJI_HEAD, '').trim();
    const base = text.replace(/[((].*$/, '').trim() || text;
    const key = (kind || '') + '|' + base;
    const open = key in _uiSecOpen ? _uiSecOpen[key] : idx < 2;
    const sec = document.createElement('section');
    sec.className = 'pSec' + (open ? ' open' : '');
    const head = document.createElement('button');
    head.type = 'button'; head.className = 'pSecHead';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.innerHTML = _UI_CHEVRON + '<span></span>';
    head.lastChild.textContent = text;
    const inner = document.createElement('div');
    inner.className = 'pSecBody';
    // 次の見出しまでを、このまとまりに入れる
    let n = lab.nextSibling;
    while (n && !(n.classList && n.classList.contains('panelSectionLabel'))) { const nx = n.nextSibling; inner.appendChild(n); n = nx; }
    lab.replaceWith(sec);
    sec.appendChild(head); sec.appendChild(inner);
    head.addEventListener('click', () => {
      const o = !sec.classList.contains('open');
      sec.classList.toggle('open', o); head.setAttribute('aria-expanded', o ? 'true' : 'false');
      _uiSecOpen[key] = o; _uiSaveSecOpen();
    });
  });
  uiStripEmoji(body);
  const title = document.getElementById('editPanelTitle');
  if (title && title.firstChild && title.firstChild.nodeType === 3) title.firstChild.nodeValue = title.firstChild.nodeValue.replace(_UI_EMOJI_HEAD, '');
}

// 人の形の図で関節を選ぶ。joints = { 関節: キーの数 }。onPick(関節, shift)
function uiBodyPicker(type, onPick, keyCounts) {
  const box = document.createElement('div');
  box.className = 'bodyPick';
  const fig = document.createElement('div');
  fig.className = 'bodyFig';
  const mk = (j, area) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bp ' + area + (poseJointSelected(j) ? ' on' : '');
    const n = (keyCounts && keyCounts[j]) || 0;
    const label = rigJointLabel(type, j);
    b.title = label + (n ? `(キー ${n}個)` : '') + ' — Shift+クリックで足す';
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', poseJointSelected(j) ? 'true' : 'false');
    if (n) { const d = document.createElement('span'); d.className = 'bpKey'; b.appendChild(d); }
    b.addEventListener('click', (e) => onPick(j, e.shiftKey));
    fig.appendChild(b);
  };
  mk('head', 'head'); mk('armR', 'armR'); mk('body', 'body'); mk('armL', 'armL'); mk('legR', 'legR'); mk('legL', 'legL');
  box.appendChild(fig);
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'bpRoot' + (poseJointSelected('root') ? ' on' : '');
  const rn = (keyCounts && keyCounts.root) || 0;
  root.textContent = '全体(位置・向き)' + (rn ? ` ◆${rn}` : '');
  root.addEventListener('click', (e) => onPick('root', e.shiftKey));
  box.appendChild(root);
  const cap = document.createElement('div');
  cap.className = 'bpCap';
  const names = poseSelJoints.map(j => rigJointLabel(type, j)).join('・');
  cap.innerHTML = '<b></b> を選んでいます · Shift で足す';
  cap.firstChild.textContent = names;
  box.appendChild(cap);
  return box;
}
