'use strict';
// 写真編集：画面と操作。画像処理は engine.js、お手本の解析は extract.js。

const E = Engine, X = Extract;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 保存 ----------
const KEY = 'shashin:v1';
function loadDb() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && Array.isArray(d.presets)) return d; } catch (e) { /* 初回 */ }
  return { presets: [] };
}
let db = loadDb();
function saveDb() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('保存できませんでした（容量がいっぱいかもしれません）'); }
}
const BUILT = BUILTIN.map(b => ({ ...b, builtin: true, params: E.normalize(b.params) }));
const allPresets = () => [...db.presets, ...BUILT];
const getPreset = id => allPresets().find(x => x.id === id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- 共通 ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function busy(text) {
  $('#busy').hidden = !text; $('#busyText').textContent = text || '';
}
function show(id) {
  for (const v of ['home', 'make', 'editor']) $('#' + v).hidden = v !== id;
  window.scrollTo(0, 0);
}
function openSheet(html, bind) {
  const sh = $('#sheet'); sh.innerHTML = html; sh.hidden = false; $('#sheetBack').hidden = false;
  if (bind) bind(sh);
}
function closeSheet() { $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = ''; }
$('#sheetBack').addEventListener('click', closeSheet);
function askName(title, def) {
  return new Promise(res => {
    openSheet(`<h3>${esc(title)}</h3><p class="sub">あとから変更できます</p>
      <input class="field" id="nameIn" maxlength="30" value="${esc(def)}">
      <div class="row2" style="margin-top:12px"><button class="btn" id="nameNo">キャンセル</button><button class="btn primary" id="nameOk">保存</button></div>`, sh => {
      const inp = $('#nameIn', sh);
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
      $('#nameNo', sh).onclick = () => { closeSheet(); res(null); };
      const ok = () => { const v = inp.value.trim() || def; closeSheet(); res(v); };
      $('#nameOk', sh).onclick = ok;
      inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
  });
}
function pickFiles(input, multiple) {
  return new Promise(res => {
    const el = $(input);
    el.value = '';
    el.onchange = () => res(multiple ? Array.from(el.files) : el.files[0] || null);
    el.click();
  });
}

// ---------- 画像 ----------
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => res(img);
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('この写真は読み込めませんでした')); };
    img.src = url;
  });
}
// img の一部（rect, 元画像の座標）を、長辺 maxSide・総画素 maxPx 以内に縮めて canvas に描く
function drawScaled(img, maxSide, maxPx, rect) {
  const r = rect || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  let s = Math.min(1, maxSide / Math.max(r.w, r.h));
  if (maxPx) s = Math.min(s, Math.sqrt(maxPx / (r.w * r.h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w * s)); c.height = Math.max(1, Math.round(r.h * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}
const pixelsOf = c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
// CPU で小さな画像にプリセットをかける（帯のサムネイル用）
function applySmall(src, params) {
  const d = pixelsOf(src), out = E.applyCPU(d.data, src.width, src.height, params);
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  c.getContext('2d').putImageData(new ImageData(out, src.width, src.height), 0, 0);
  return c;
}
function toBlob(canvas, q = 0.92) {
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('画像を作れませんでした')), 'image/jpeg', q));
}
const outName = name => (name || 'photo').replace(/\.[^.]+$/, '') + '_edit.jpg';
// 共有シート（iPhone では「画像を保存」で写真に入る）。使えなければダウンロード
async function shareFiles(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  for (const f of files) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    await sleep(300);
  }
  return true;
}

// ---------- GPU ----------
let R = null;
function renderer() {
  if (!R) R = new E.Renderer($('#cv'));
  return R;
}
$('#cv').addEventListener('webglcontextlost', e => e.preventDefault());
$('#cv').addEventListener('webglcontextrestored', () => {
  R = null;
  if (S.photo) { renderer().setImage(S.photo.prev, S.photo.prev.width, S.photo.prev.height); draw(); }
});
// 書き出し用の大きさ（GPU の上限と、iPhone のキャンバス上限 1600 万画素に収める）
const FULL_PX = 16e6;
async function renderFull(img, params) {
  const r = renderer();
  const src = drawScaled(img, r.maxTex, FULL_PX);
  await sleep(0);
  const out = r.renderFull(src, params);
  src.width = src.height = 0;
  return out;
}

// ============================================================
// ホーム
// ============================================================
function renderHome() {
  const el = $('#presetList');
  if (!db.presets.length) {
    el.className = '';
    el.innerHTML = '<div class="empty">まだありません。「お手本からプリセットを作る」で作るか、下のおすすめから使ってみてください。</div>';
  } else {
    el.className = 'preset-grid';
    el.innerHTML = db.presets.map(cardHtml).join('');
  }
  $('#builtinList').innerHTML = BUILT.map(cardHtml).join('');
  document.querySelectorAll('#home .preset-card').forEach(b => b.onclick = () => presetMenu(b.dataset.id));
  // おすすめのサムネイルは見本の風景にかけて作る（少しずつ）
  (async () => {
    for (const img of document.querySelectorAll('#builtinList img[data-id]')) {
      await sleep(0);
      img.src = sampleThumb(getPreset(img.dataset.id));
    }
  })();
}
const cardHtml = p => `<button class="preset-card" data-id="${p.id}">
    <img src="${p.thumb || ''}" ${p.builtin ? `data-id="${p.id}"` : ''} alt="">
    <div><b>${esc(p.name)}</b><small>${p.builtin ? esc(p.kind) : new Date(p.created).toLocaleDateString('ja-JP')}</small></div></button>`;

// サムネイル用の見本の風景（空・山・水・木・道・人）。著作物を使わないよう図形で描く
let sceneCanvas = null;
function sampleScene() {
  if (sceneCanvas) return sceneCanvas;
  const c = document.createElement('canvas'), W = 240, H = 180;
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  let g = x.createLinearGradient(0, 0, 0, 95);
  g.addColorStop(0, '#3f7cc4'); g.addColorStop(1, '#d9e6ee');
  x.fillStyle = g; x.fillRect(0, 0, W, 95);
  g = x.createRadialGradient(180, 55, 2, 180, 55, 60);
  g.addColorStop(0, 'rgba(255,248,220,1)'); g.addColorStop(0.25, 'rgba(255,225,160,.7)'); g.addColorStop(1, 'rgba(255,220,160,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, 120);
  x.fillStyle = '#7d8ea3';
  x.beginPath(); x.moveTo(0, 95); x.lineTo(40, 58); x.lineTo(80, 80); x.lineTo(130, 45); x.lineTo(190, 88); x.lineTo(W, 70); x.lineTo(W, 100); x.lineTo(0, 100); x.fill();
  g = x.createLinearGradient(0, 95, 0, 125);
  g.addColorStop(0, '#2f8f96'); g.addColorStop(1, '#1e5f73');
  x.fillStyle = g; x.fillRect(0, 95, W, 30);
  x.fillStyle = '#4d7a35'; x.fillRect(0, 122, W, 58);
  x.fillStyle = '#3a5f29';
  for (let i = 0; i < 9; i++) { x.beginPath(); x.arc(10 + i * 27, 124, 14, Math.PI, 0); x.fill(); }
  g = x.createLinearGradient(0, 125, 0, H);
  g.addColorStop(0, '#a4876a'); g.addColorStop(1, '#6f5440');
  x.fillStyle = g;
  x.beginPath(); x.moveTo(100, 125); x.lineTo(130, 125); x.lineTo(185, H); x.lineTo(55, H); x.fill();
  x.fillStyle = '#c8473a'; x.fillRect(150, 128, 18, 32);
  x.fillStyle = '#e2b08e'; x.beginPath(); x.arc(159, 121, 7, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#e9b33c'; x.fillRect(30, 140, 22, 16);
  x.fillStyle = '#141414'; x.fillRect(196, 112, 6, 60);
  sceneCanvas = c;
  return c;
}
const thumbCache = {};
function sampleThumb(p) {
  if (!thumbCache[p.id]) thumbCache[p.id] = applySmall(sampleScene(), p.params).toDataURL('image/jpeg', 0.85);
  return thumbCache[p.id];
}
function presetMenu(id) {
  const p = getPreset(id);
  if (!p) return;
  openSheet(`<h3>${esc(p.name)}</h3>${p.note ? `<p class="sub">${esc(p.note)}</p>` : ''}<div class="chips" style="margin:6px 0 14px">${describe(p.params).map(chip).join('')}</div>
    <div class="sheet-list">
      <button class="btn primary" data-a="edit">このプリセットで写真を編集</button>
      <button class="btn" data-a="batch">まとめて適用（複数枚）</button>
      ${p.builtin ? '' : `<button class="btn" data-a="rename">名前を変更</button>
      <button class="btn danger" data-a="del">削除</button>`}
    </div>`, sh => {
    sh.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      closeSheet();
      if (a === 'edit') {
        const f = await pickFiles('#filePhoto');
        if (f) openEditor(f, p.id);
      } else if (a === 'batch') {
        const fs = await pickFiles('#fileBatch', true);
        if (fs.length) batchApply(p, fs);
      } else if (a === 'rename') {
        const n = await askName('名前を変更', p.name);
        if (n) { p.name = n; saveDb(); renderHome(); }
      } else if (a === 'del') {
        if (confirm(`「${p.name}」を削除しますか？`)) { db.presets = db.presets.filter(x => x.id !== id); saveDb(); renderHome(); }
      }
    });
  });
}
$('#btnEdit').onclick = async () => {
  const f = await pickFiles('#filePhoto');
  if (f) openEditor(f, null);
};
$('#btnMake').onclick = () => { M.refs = []; M.result = null; renderMake(); show('make'); };
document.querySelectorAll('[data-go="home"]').forEach(b => b.onclick = () => { renderHome(); show('home'); });

async function batchApply(p, files) {
  const out = [];
  try {
    for (let i = 0; i < files.length; i++) {
      busy(`${i + 1} / ${files.length} 枚目を仕上げています…`);
      await sleep(30);
      const img = await loadImage(files[i]);
      const c = await renderFull(img, p.params);
      out.push(new File([await toBlob(c)], outName(files[i].name), { type: 'image/jpeg' }));
      c.width = c.height = 0;
      URL.revokeObjectURL(img.src);
    }
  } catch (e) {
    toast(e.message);
  }
  busy(null);
  if (!out.length) return;
  openSheet(`<h3>${out.length} 枚できました</h3><p class="sub">「画像を保存」を選ぶと写真アプリに入ります</p>
    <button class="btn primary wide" id="bSave">保存・共有</button>`, sh => {
    $('#bSave', sh).onclick = async () => { if (await shareFiles(out)) closeSheet(); };
  });
}

// プリセットの特徴を短い言葉に
const HUE_NAMES = [[15, '赤'], [45, 'オレンジ'], [70, '黄'], [100, '黄緑'], [150, '緑'], [195, '青緑'], [250, '青'], [290, '紫'], [345, 'マゼンタ'], [360, '赤']];
const hueName = h => HUE_NAMES.find(([m]) => h < m)[1];
const hueCss = h => `hsl(${h} 80% 55%)`;
function describe(p) {
  p = E.normalize(p);
  const out = [], add = (v, th, pos, neg) => { if (v >= th) out.push([pos]); else if (v <= -th) out.push([neg]); };
  // 実際にグレーを通したときの結果で判断する（スライダーとカーブの組み合わせでも正しく言えるように）
  const u = E.prepare(p), gray = y => { const c = E.pixel([y, y, y], u); return X.rgb2lab(c[0], c[1], c[2]); };
  add(p.exposure, 0.15, '明るめ', '暗め');
  add(p.contrast, 8, 'コントラスト強め', 'コントラスト弱め');
  const k = gray(0), w = gray(1);
  if (k[0] > 6) out.push(['黒を持ち上げ（フィルム風）']);
  else if (p.blacks <= -15) out.push(['黒を締める']);
  if (w[0] < 95) out.push(['白を抑えめ']);
  add(p.highlights, 12, 'ハイライト明るく', 'ハイライト抑えめ');
  add(p.shadows, 12, 'シャドウ明るく', 'シャドウ暗く');
  if (p.saturation <= -70) out.push(['モノクロ寄り']);
  else add(p.saturation + p.vibrance * 0.6, 8, '鮮やか', 'くすみカラー');
  // 暗部・中間・明部についた色
  const tone = (lab, name) => {
    const c = Math.hypot(lab[1], lab[2]);
    if (c < 3) return;
    const h = labHue(lab);
    out.push([`${name}に${hueName(h)}`, h]);
  };
  const sh = gray(0.12), md = gray(0.5), hi = gray(0.88);
  const mc = Math.hypot(md[1], md[2]);
  if (mc >= 3 && Math.hypot(sh[1] - md[1], sh[2] - md[2]) < 3 && Math.hypot(hi[1] - md[1], hi[2] - md[2]) < 3) {
    const h = labHue(md);
    out.push([h > 20 && h < 100 ? 'あたたかい色' : h > 160 && h < 290 ? '青みがかった色' : `全体に${hueName(h)}`, h]);
  } else { tone(sh, 'シャドウ'); tone(hi, 'ハイライト'); }
  E.BANDS.forEach((b, i) => {
    if (p.hslSat[i] <= -12) out.push([`${b.name}を抑えめ`]);
    else if (p.hslSat[i] >= 12) out.push([`${b.name}を強め`]);
  });
  if (p.vignette <= -10) out.push(['周辺を暗く']);
  if (p.grain >= 10) out.push(['粒子']);
  if (!out.length) out.push(['ほぼ無編集']);
  return out;
}
// Lab の a,b から、だいたいの色相（HSV の角度）を求める
function labHue(lab) {
  // a,b の向きの色を作って HSV にする
  const L = 60, a = lab[1], b = lab[2], n = Math.hypot(a, b) || 1;
  const fy = (L + 16) / 116, fx = fy + 40 * a / n / 500, fz = fy - 40 * b / n / 200;
  const inv = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
  const X0 = inv(fx) * 0.95047, Y0 = inv(fy), Z0 = inv(fz) * 1.08883;
  const r = 3.2406 * X0 - 1.5372 * Y0 - 0.4986 * Z0, g = -0.9689 * X0 + 1.8758 * Y0 + 0.0415 * Z0, bb = 0.0557 * X0 - 0.2040 * Y0 + 1.0570 * Z0;
  return E.hsv([r, g, bb].map(v => E.l2s(Math.max(0, v))))[0];
}
const chip = ([t, h]) => `<span class="chip">${h != null ? `<i style="background:${hueCss(h)}"></i>` : ''}${esc(t)}</span>`;

// ============================================================
// お手本からプリセットを作る
// ============================================================
const M = { refs: [], result: null };
const SVG_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const SVG_CROP = '<svg viewBox="0 0 24 24"><path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

function renderMake() {
  const el = $('#refList');
  el.innerHTML = M.refs.map((r, i) => `<div class="ref" data-i="${i}"><button class="ref-x" aria-label="外す">${SVG_X}</button><button class="ref-crop" aria-label="切り抜き">${SVG_CROP}</button></div>`).join('')
    + (M.refs.length < 5 ? `<button class="ref-add" id="refAdd"><span>${SVG_PLUS}お手本を追加</span></button>` : '');
  el.querySelectorAll('.ref').forEach(d => {
    const r = M.refs[+d.dataset.i];
    d.prepend(drawScaled(r.img, 300, 0, r.crop));
    $('.ref-x', d).onclick = () => { M.refs.splice(+d.dataset.i, 1); M.result = null; renderMake(); };
    $('.ref-crop', d).onclick = () => openCrop(r);
  });
  if ($('#refAdd')) $('#refAdd').onclick = addRefs;
  $('#btnAnalyze').disabled = !M.refs.length;
  renderResult();
}
async function addRefs() {
  const fs = await pickFiles('#fileRefs', true);
  for (const f of fs.slice(0, 5 - M.refs.length)) {
    try {
      const img = await loadImage(f);
      M.refs.push({ img, name: f.name, crop: autoCrop(img) });
    } catch (e) { toast(e.message); }
  }
  M.result = null;
  renderMake();
}
// スクショの上下左右にある「単色の帯」（余白・黒帯）を自動で外す
function autoCrop(img) {
  const c = drawScaled(img, 300), { data, width: w, height: h } = pixelsOf(c);
  const Y = i => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const flatRow = y => { let mn = 255, mx = 0; for (let x = 0; x < w; x++) { const v = Y((y * w + x) * 4); mn = Math.min(mn, v); mx = Math.max(mx, v); } return mx - mn < 10; };
  const flatCol = (x, y0, y1) => { let mn = 255, mx = 0; for (let y = y0; y < y1; y++) { const v = Y((y * w + x) * 4); mn = Math.min(mn, v); mx = Math.max(mx, v); } return mx - mn < 10; };
  let t = 0, b = h, l = 0, r = w;
  while (t < h / 2 && flatRow(t)) t++;
  while (b > t + h / 4 && flatRow(b - 1)) b--;
  while (l < w / 2 && flatCol(l, t, b)) l++;
  while (r > l + w / 4 && flatCol(r - 1, t, b)) r--;
  // 帯を外した辺は、境目のにじみを避けて少し内側まで切る
  const mx = Math.ceil(w * 0.01), my = Math.ceil(h * 0.01);
  if (t > 0) t += my; if (b < h) b -= my; if (l > 0) l += mx; if (r < w) r -= mx;
  const s = img.naturalWidth / w;
  return { x: Math.round(l * s), y: Math.round(t * s), w: Math.round((r - l) * s), h: Math.round((b - t) * s) };
}

$('#btnAnalyze').onclick = async () => {
  busy('雰囲気を読み取っています…');
  await sleep(50);
  try {
    const stats = M.refs.map(r => {
      const small = drawScaled(r.img, 400, 0, r.crop), d = pixelsOf(small);
      // 粒子は縮小すると消えるので、中央を等倍で切り出して測る
      const cw = Math.min(r.crop.w, 768), ch = Math.min(r.crop.h, 768);
      const hi = pixelsOf(drawScaled(r.img, 768, 0, { x: r.crop.x + ((r.crop.w - cw) >> 1), y: r.crop.y + ((r.crop.h - ch) >> 1), w: cw, h: ch }));
      return X.analyze(d.data, d.width, d.height, hi);
    });
    const params = X.estimate(stats);
    const t = drawScaled(M.refs[0].img, 320, 0, M.refs[0].crop);
    M.result = { params, thumb: t.toDataURL('image/jpeg', 0.8) };
  } catch (e) {
    console.error(e); toast('読み取れませんでした：' + e.message);
  }
  busy(null);
  renderResult();
  if (M.result) $('#makeResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
function renderResult() {
  const el = $('#makeResult');
  if (!M.result) { el.innerHTML = ''; return; }
  const n = db.presets.length + 1;
  el.innerHTML = `<div class="result">
    <h3>読み取れた雰囲気</h3>
    <div class="chips">${describe(M.result.params).map(chip).join('')}</div>
    <input class="field" id="mkName" maxlength="30" value="プリセット ${n}" aria-label="プリセットの名前">
    <button class="btn primary wide" id="mkApply">保存して写真に適用</button>
    <button class="btn wide" id="mkSave">保存だけする</button>
    <p class="note">お手本と自分の写真の「写っている物」が違うと、色の出方が変わることがあります。編集画面の「強さ」やスライダーで調整してください。</p>
  </div>`;
  const save = () => {
    const p = { id: uid(), name: $('#mkName').value.trim() || `プリセット ${n}`, params: M.result.params, thumb: M.result.thumb, created: Date.now() };
    db.presets.unshift(p); saveDb();
    return p;
  };
  $('#mkSave').onclick = () => { save(); toast('保存しました'); renderHome(); show('home'); };
  $('#mkApply').onclick = async () => {
    const f = await pickFiles('#filePhoto');
    if (!f) return;
    const p = save();
    renderHome();
    openEditor(f, p.id);
  };
}

// ---------- 切り抜き ----------
const CR = { ref: null, rect: null, scale: 1, ox: 0, oy: 0 };
function openCrop(ref) {
  CR.ref = ref; CR.rect = { ...ref.crop };
  $('#crop').hidden = false;
  requestAnimationFrame(layoutCrop);
}
function layoutCrop() {
  const st = $('#cropStage'), cv = $('#cropCv'), img = CR.ref.img;
  const W = st.clientWidth, H = st.clientHeight;
  const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const src = drawScaled(img, Math.max(w, h) * (window.devicePixelRatio || 1));
  cv.width = src.width; cv.height = src.height;
  cv.getContext('2d').drawImage(src, 0, 0);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  CR.ox = (W - w) / 2; CR.oy = (H - h) / 2; CR.scale = s;
  cv.style.left = CR.ox + 'px'; cv.style.top = CR.oy + 'px';
  drawCropBox();
}
function drawCropBox() {
  const b = $('#cropBox'), r = CR.rect, s = CR.scale;
  Object.assign(b.style, { left: CR.ox + r.x * s + 'px', top: CR.oy + r.y * s + 'px', width: r.w * s + 'px', height: r.h * s + 'px' });
}
(() => {
  let drag = null;
  $('#cropStage').addEventListener('pointerdown', e => {
    const h = e.target.dataset && e.target.dataset.h;
    const inBox = e.target === $('#cropBox');
    if (!h && !inBox) return;
    drag = { h: h || 'move', x: e.clientX, y: e.clientY, r: { ...CR.rect } };
    $('#cropStage').setPointerCapture(e.pointerId);
  });
  $('#cropStage').addEventListener('pointermove', e => {
    if (!drag) return;
    const img = CR.ref.img, W = img.naturalWidth, H = img.naturalHeight, min = Math.max(W, H) * 0.05;
    const dx = (e.clientX - drag.x) / CR.scale, dy = (e.clientY - drag.y) / CR.scale;
    let { x, y, w, h } = drag.r;
    if (drag.h === 'move') {
      x = Math.min(W - w, Math.max(0, x + dx)); y = Math.min(H - h, Math.max(0, y + dy));
    } else {
      let x1 = x + w, y1 = y + h;
      if (drag.h.includes('w')) x = Math.min(x1 - min, Math.max(0, x + dx));
      if (drag.h.includes('e')) x1 = Math.max(x + min, Math.min(W, x1 + dx));
      if (drag.h.includes('n')) y = Math.min(y1 - min, Math.max(0, y + dy));
      if (drag.h.includes('s')) y1 = Math.max(y + min, Math.min(H, y1 + dy));
      w = x1 - x; h = y1 - y;
    }
    CR.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    drawCropBox();
  });
  const end = () => { drag = null; };
  $('#cropStage').addEventListener('pointerup', end);
  $('#cropStage').addEventListener('pointercancel', end);
})();
$('#cropAll').onclick = () => { const i = CR.ref.img; CR.rect = { x: 0, y: 0, w: i.naturalWidth, h: i.naturalHeight }; drawCropBox(); };
$('#cropAuto').onclick = () => { CR.rect = autoCrop(CR.ref.img); drawCropBox(); };
$('#cropDone').onclick = () => { CR.ref.crop = CR.rect; $('#crop').hidden = true; M.result = null; renderMake(); };
window.addEventListener('resize', () => { if (!$('#crop').hidden) layoutCrop(); });

// ============================================================
// 編集
// ============================================================
const S = { photo: null, params: E.defaults(), strength: 100, presetId: null, tab: 'preset', band: 0, ch: 'm', orig: false, dirty: false };
const TABS = [['preset', 'プリセット'], ['light', 'ライト'], ['color', 'カラー'], ['hsl', 'HSL'], ['curve', 'カーブ'], ['fx', '効果']];
const fmtSigned = v => (v > 0 ? '+' : '') + v;
const LIGHT = [
  ['exposure', '露光量', -3, 3, 0.05, v => (v > 0 ? '+' : '') + v.toFixed(2)],
  ['contrast', 'コントラスト', -100, 100, 1],
  ['highlights', 'ハイライト', -100, 100, 1],
  ['shadows', 'シャドウ', -100, 100, 1],
  ['whites', '白レベル', -100, 100, 1],
  ['blacks', '黒レベル', -100, 100, 1],
];
const COLOR = [
  ['temp', '色温度', -100, 100, 1, null, 'linear-gradient(90deg,#4a8cff,#ddd,#ffb43a)'],
  ['tint', '色かぶり補正', -100, 100, 1, null, 'linear-gradient(90deg,#3fcf5e,#ddd,#e24ee0)'],
  ['vibrance', '自然な彩度', -100, 100, 1],
  ['saturation', '彩度', -100, 100, 1],
];
const RAINBOW = 'linear-gradient(90deg,#f33,#fa3,#ff3,#3f3,#3ff,#33f,#f3f,#f33)';
const FX = [
  ['shadowHue', 'シャドウの色', 0, 360, 1, v => `${v}° ${hueName(v)}`, RAINBOW],
  ['shadowSat', 'シャドウの色の量', 0, 100, 1, String],
  ['highHue', 'ハイライトの色', 0, 360, 1, v => `${v}° ${hueName(v)}`, RAINBOW],
  ['highSat', 'ハイライトの色の量', 0, 100, 1, String],
  ['balance', 'バランス', -100, 100, 1],
];
const FX2 = [
  ['vignette', '周辺光量', -100, 100, 1],
  ['grain', '粒子', 0, 100, 1, String],
];

async function openEditor(file, presetId) {
  busy('写真を読み込んでいます…');
  try {
    const img = await loadImage(file);
    if (S.photo) URL.revokeObjectURL(S.photo.img.src);
    const r = renderer();
    // プレビューは画面に十分な大きさ（長辺 2048px まで）
    const prev = drawScaled(img, Math.min(2048, r.maxTex));
    const tiny = drawScaled(img, 120);
    S.photo = { img, name: file.name, prev, tiny, hist: histogram(pixelsOf(drawScaled(img, 256))) };
    S.params = E.defaults(); S.strength = 100; S.presetId = null; S.dirty = false;
    const p = presetId && getPreset(presetId);
    if (p) { S.params = E.normalize(p.params); S.presetId = p.id; }
    S.tab = 'preset';
    show('editor');
    $('#edTitle').textContent = p ? p.name : '編集';
    r.setImage(prev, prev.width, prev.height);
    renderTabs(); renderPanel(); draw();
  } catch (e) {
    console.error(e); toast(e.message);
  }
  busy(null);
}
let raf = 0;
function draw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (S.photo) renderer().render(E.scale(S.params, S.strength / 100), !S.orig);
  });
}
function changed() { S.dirty = true; draw(); }

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([k, n]) => `<button class="tab${S.tab === k ? ' on' : ''}" data-t="${k}">${n}</button>`).join('');
  $('#tabs').querySelectorAll('.tab').forEach(b => b.onclick = () => { S.tab = b.dataset.t; renderTabs(); renderPanel(); });
}

// スライダー：[キー, 名前, 最小, 最大, 刻み, 表示, 背景]。get/set で値の置き場所を変えられる
function slider(def, get, set, base = 0) {
  const [k, name, min, max, step, fmt, track] = def;
  const f = fmt || fmtSigned;
  const d = document.createElement('div');
  d.className = 'sl';
  d.innerHTML = `<div class="sl-top"><span>${name}</span><span class="sl-val"></span></div><input type="range" min="${min}" max="${max}" step="${step}" aria-label="${name}">`;
  const inp = $('input', d), val = $('.sl-val', d);
  const paint = () => {
    const v = get();
    inp.value = v; val.textContent = f(+v);
    val.classList.toggle('on', +v !== base);
    if (track) { inp.style.setProperty('--track', track); return; }
    const a = (base - min) / (max - min) * 100, b = (v - min) / (max - min) * 100;
    inp.style.setProperty('--track', `linear-gradient(90deg,#3A3A40 ${Math.min(a, b)}%,${'#F5A524'} ${Math.min(a, b)}%,#F5A524 ${Math.max(a, b)}%,#3A3A40 ${Math.max(a, b)}%)`);
  };
  inp.oninput = () => { set(+inp.value); paint(); changed(); };
  // 名前をダブルタップで元に戻す
  let last = 0;
  $('.sl-top', d).addEventListener('pointerup', () => {
    const now = Date.now();
    if (now - last < 350) { set(base); paint(); changed(); }
    last = now;
  });
  d.dataset.k = k;
  paint();
  return d;
}
const paramSlider = (def, base) => slider(def, () => S.params[def[0]], v => { S.params[def[0]] = v; }, base != null ? base : E.defaults()[def[0]]);
const grp = (t) => { const h = document.createElement('div'); h.className = 'grp-h'; h.textContent = t; return h; };

function renderPanel() {
  const el = $('#panel');
  el.innerHTML = '';
  el.scrollTop = 0;
  if (S.tab === 'preset') panelPreset(el);
  else if (S.tab === 'light') LIGHT.forEach(d => el.append(paramSlider(d)));
  else if (S.tab === 'color') COLOR.forEach(d => el.append(paramSlider(d)));
  else if (S.tab === 'hsl') panelHsl(el);
  else if (S.tab === 'curve') panelCurve(el);
  else if (S.tab === 'fx') {
    el.append(grp('カラーグレーディング'));
    FX.forEach(d => el.append(paramSlider(d)));
    el.append(grp('効果'));
    FX2.forEach(d => el.append(paramSlider(d)));
  }
}

function panelPreset(el) {
  const strip = document.createElement('div');
  strip.className = 'strip';
  const items = [{ id: null, name: 'なし' }, ...allPresets()];
  strip.innerHTML = items.map(p => `<button class="pv${S.presetId === p.id ? ' on' : ''}" data-id="${p.id || ''}">${p.id ? '' : '<span class="pv-none"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg></span>'}<span>${esc(p.name)}</span></button>`).join('');
  el.append(strip);
  strip.querySelectorAll('.pv').forEach(b => {
    b.onclick = () => {
      const p = getPreset(b.dataset.id);
      if (S.dirty && !confirm('今の調整を置きかえますか？')) return;
      S.params = p ? E.normalize(p.params) : E.defaults();
      S.presetId = p ? p.id : null; S.strength = 100; S.dirty = false;
      $('#edTitle').textContent = p ? p.name : '編集';
      renderPanel(); draw();
    };
  });
  // サムネイルは少しずつ作る（画面が固まらないように）
  const btns = Array.from(strip.querySelectorAll('.pv')).filter(b => b.dataset.id);
  (async () => {
    for (const b of btns) {
      await sleep(0);
      if (!b.isConnected) return;
      b.prepend(applySmall(S.photo.tiny, getPreset(b.dataset.id).params));
    }
  })();
  el.append(slider(['strength', '強さ', 0, 150, 1, v => v + '%'], () => S.strength, v => { S.strength = v; }, 100));
  const bt = document.createElement('div');
  bt.className = 'panel-btns';
  bt.innerHTML = '<button class="btn" id="pSave">プリセットとして保存</button><button class="btn" id="pReset">すべてリセット</button>';
  el.append(bt);
  $('#pReset').onclick = () => {
    if (!confirm('すべての調整を元に戻しますか？')) return;
    S.params = E.defaults(); S.strength = 100; S.presetId = null; S.dirty = false;
    $('#edTitle').textContent = '編集'; renderPanel(); draw();
  };
  $('#pSave').onclick = async () => {
    const name = await askName('プリセットとして保存', `プリセット ${db.presets.length + 1}`);
    if (!name) return;
    const params = E.scale(S.params, S.strength / 100);
    const thumb = applySmall(drawScaled(S.photo.img, 320), params).toDataURL('image/jpeg', 0.8);
    const p = { id: uid(), name, params, thumb, created: Date.now() };
    db.presets.unshift(p); saveDb();
    S.params = E.normalize(params); S.strength = 100; S.presetId = p.id; S.dirty = false;
    $('#edTitle').textContent = name;
    renderPanel(); renderHome(); toast('保存しました');
  };
}

function panelHsl(el) {
  const bands = document.createElement('div');
  bands.className = 'bands';
  bands.innerHTML = E.BANDS.map((b, i) => `<button class="band${S.band === i ? ' on' : ''}" style="background:${b.color}" data-i="${i}" aria-label="${b.name}"></button>`).join('');
  el.append(bands);
  bands.querySelectorAll('.band').forEach(b => b.onclick = () => { S.band = +b.dataset.i; renderPanel(); });
  const i = S.band, nm = E.BANDS[i].name;
  const arr = k => ({ get: () => S.params[k][i], set: v => { S.params[k][i] = v; } });
  for (const [k, label] of [['hslHue', '色相'], ['hslSat', '彩度'], ['hslLum', '輝度']]) {
    const a = arr(k);
    el.append(slider([k, `${nm}の${label}`, -100, 100, 1], a.get, a.set, 0));
  }
}

// ---------- カーブ ----------
function histogram(d) {
  const h = new Array(64).fill(0);
  for (let i = 0; i < d.data.length; i += 4) h[Math.min(63, Math.floor((0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2]) / 4))]++;
  const m = Math.max(...h);
  return h.map(v => v / m);
}
function panelCurve(el) {
  const chs = document.createElement('div');
  chs.className = 'chs';
  chs.innerHTML = [['m', '全体'], ['r', 'レッド'], ['g', 'グリーン'], ['b', 'ブルー']].map(([c, n]) => `<button data-c="${c}" class="${S.ch === c ? 'on' : ''}">${n}</button>`).join('');
  el.append(chs);
  chs.querySelectorAll('button').forEach(b => b.onclick = () => { S.ch = b.dataset.c; renderPanel(); });
  const wrap = document.createElement('div');
  wrap.className = 'curve-wrap';
  const cv = document.createElement('canvas');
  cv.id = 'curveCv';
  const size = Math.min(el.clientWidth - 32, 170), dpr = window.devicePixelRatio || 1;
  cv.width = cv.height = size * dpr; cv.style.width = cv.style.height = size + 'px';
  wrap.append(cv); el.append(wrap);
  const bt = document.createElement('div');
  bt.className = 'panel-btns';
  bt.innerHTML = '<button class="btn" id="cvReset">このカーブをリセット</button>';
  el.append(bt);
  $('#cvReset').onclick = () => { S.params.curve[S.ch] = [[0, 0], [1, 1]]; paintCurve(cv); changed(); };
  const n = document.createElement('p'); n.className = 'note'; n.style.marginTop = '8px';
  n.textContent = 'タップで点を追加、点を枠の外へドラッグで削除';
  el.append(n);
  paintCurve(cv);
  bindCurve(cv);
}
const CH_COLOR = { m: '#ffffff', r: '#ff6b6b', g: '#5bd17c', b: '#6aa5ff' };
function paintCurve(cv) {
  const ctx = cv.getContext('2d'), W = cv.width, pad = W * 0.04, s = W - pad * 2;
  const X0 = x => pad + x * s, Y0 = y => pad + (1 - y) * s;
  ctx.clearRect(0, 0, W, W);
  // ヒストグラム
  const hist = S.photo.hist;
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  hist.forEach((v, i) => ctx.fillRect(X0(i / 64), Y0(v * 0.9), s / 64 + 0.5, v * 0.9 * s));
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.moveTo(X0(i / 4), Y0(0)); ctx.lineTo(X0(i / 4), Y0(1)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X0(0), Y0(i / 4)); ctx.lineTo(X0(1), Y0(i / 4)); ctx.stroke();
  }
  ctx.strokeRect(X0(0), Y0(1), s, s);
  ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X0(0), Y0(0)); ctx.lineTo(X0(1), Y0(1)); ctx.stroke(); ctx.setLineDash([]);
  // ほかのチャンネルを薄く、選択中を濃く
  for (const c of ['m', 'r', 'g', 'b']) {
    if (c === S.ch) continue;
    const pts = S.params.curve[c];
    if (pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 1) continue;
    drawCurveLine(ctx, pts, X0, Y0, CH_COLOR[c], 0.35, W);
  }
  drawCurveLine(ctx, S.params.curve[S.ch], X0, Y0, CH_COLOR[S.ch], 1, W);
  ctx.fillStyle = CH_COLOR[S.ch];
  for (const [x, y] of S.params.curve[S.ch]) { ctx.beginPath(); ctx.arc(X0(x), Y0(y), W * 0.022, 0, Math.PI * 2); ctx.fill(); }
}
function drawCurveLine(ctx, pts, X0, Y0, color, alpha, W) {
  const f = E.curveFn(pts);
  ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = W * 0.008;
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) { const x = i / 100, y = Math.min(1, Math.max(0, f(x))); i ? ctx.lineTo(X0(x), Y0(y)) : ctx.moveTo(X0(x), Y0(y)); }
  ctx.stroke(); ctx.globalAlpha = 1;
}
function bindCurve(cv) {
  let drag = -1;
  const pos = e => {
    const r = cv.getBoundingClientRect(), pad = r.width * 0.04, s = r.width - pad * 2;
    return [(e.clientX - r.left - pad) / s, 1 - (e.clientY - r.top - pad) / s, s];
  };
  cv.addEventListener('pointerdown', e => {
    const [x, y, s] = pos(e), pts = S.params.curve[S.ch];
    let best = -1, bd = 1e9;
    pts.forEach(([px, py], i) => { const d = Math.hypot((px - x) * s, (py - y) * s); if (d < bd) { bd = d; best = i; } });
    if (bd < 24) drag = best;
    else if (pts.length < 10 && x > 0.02 && x < 0.98) {
      const yy = Math.min(1, Math.max(0, E.curveFn(pts)(x)));
      pts.push([x, yy]); pts.sort((a, b) => a[0] - b[0]);
      drag = pts.findIndex(p => p[0] === x);
    }
    if (drag >= 0) { cv.setPointerCapture(e.pointerId); paintCurve(cv); changed(); }
  });
  cv.addEventListener('pointermove', e => {
    if (drag < 0) return;
    const [x, y] = pos(e), pts = S.params.curve[S.ch], last = pts.length - 1;
    const p = pts[drag];
    // 端の点は横に動かさない。途中の点は外に出したら消す
    if (drag > 0 && drag < last && (y < -0.12 || y > 1.12 || x < -0.08 || x > 1.08)) {
      pts.splice(drag, 1); drag = -1;
    } else {
      if (drag > 0 && drag < last) p[0] = Math.min(pts[drag + 1][0] - 0.02, Math.max(pts[drag - 1][0] + 0.02, x));
      p[1] = Math.min(1, Math.max(0, y));
      p[0] = Math.round(p[0] * 1000) / 1000; p[1] = Math.round(p[1] * 1000) / 1000;
    }
    paintCurve(cv); changed();
  });
  const end = () => { drag = -1; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

// ---------- 長押しで元の写真 ----------
(() => {
  const st = $('#stage'), tip = $('#stageTip');
  let timer = 0;
  const on = () => { S.orig = true; tip.textContent = '元の写真'; tip.classList.add('orig'); draw(); };
  const off = () => {
    clearTimeout(timer);
    if (!S.orig) return;
    S.orig = false; tip.textContent = '長押しで元の写真'; tip.classList.remove('orig'); draw();
  };
  st.addEventListener('pointerdown', () => { timer = setTimeout(on, 180); });
  st.addEventListener('pointerup', off);
  st.addEventListener('pointercancel', off);
  st.addEventListener('pointerleave', off);
  st.addEventListener('contextmenu', e => e.preventDefault());
})();

$('#edBack').onclick = () => {
  if (S.dirty && !confirm('書き出していない調整は消えます。戻りますか？')) return;
  renderHome(); show('home');
};
$('#edExport').onclick = async () => {
  if (!S.photo) return;
  busy('元のサイズで仕上げています…');
  await sleep(50);
  try {
    const params = E.scale(S.params, S.strength / 100);
    const c = await renderFull(S.photo.img, params);
    const blob = await toBlob(c);
    const file = new File([blob], outName(S.photo.name), { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const mp = (c.width * c.height / 1e6).toFixed(1);
    c.width = c.height = 0;
    busy(null);
    openSheet(`<h3>できました</h3><p class="sub">${mp}M 画素の JPEG。「画像を保存」を選ぶと写真アプリに入ります</p>
      <img class="out" src="${url}" alt="">
      <button class="btn primary wide" id="xSave">保存・共有</button>`, sh => {
      $('#xSave', sh).onclick = async () => { if (await shareFiles([file])) { S.dirty = false; closeSheet(); URL.revokeObjectURL(url); } };
    });
  } catch (e) {
    console.error(e); busy(null); toast('書き出せませんでした：' + e.message);
  }
};

// ---------- 起動 ----------
renderHome();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
