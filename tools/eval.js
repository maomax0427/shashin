// プリセット推定の精度を測る。
//   node tools/eval.js <dir>          … 精度の評価
//   node tools/eval.js <dir> --calib  … 無編集写真の基準値（extract.js の NAT）を出力
// <dir> には meta.json（[{name,w,h}]）と <name>.rgba（RGBA の生データ）を置く。
// 評価方法：無編集写真 A に既知の編集をかけてお手本を作り、そこから推定したプリセットを
// 別の写真 B にかけたときと、本物の編集を B にかけたときの色差（ΔE）を比べる。
const fs = require('fs'), path = require('path');
const E = require('../engine.js'), X = require('../extract.js');

const dir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
// 評価を速くするため半分に縮小
const half = (d, w, h) => {
  const W = w >> 1, H = h >> 1, o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) o[(y * W + x) * 4 + c] = d[((2 * y) * w + 2 * x) * 4 + c];
  return { data: o, w: W, h: H };
};
const imgs = meta.map(m => ({ name: m.name, ...half(new Uint8ClampedArray(fs.readFileSync(path.join(dir, m.name + '.rgba'))), m.w, m.h) }));
const stats = imgs.map(im => X.analyze(im.data, im.w, im.h));
// tau=0.8 のように指定すると推定の係数を変えて試せる
for (const a of process.argv.slice(3).join(' ').split(/\s+/)) { const m = a.match(/^(\w+)=([\d.]+)$/); if (m) X.K[m[1]] = +m[2]; }
const r3 = v => Math.round(v * 1000) / 1000;

if (process.argv.includes('--calib')) {
  const full = meta.map(m => X.analyze(new Uint8ClampedArray(fs.readFileSync(path.join(dir, m.name + '.rgba'))), m.w, m.h));
  const n = X.buildNat(full);
  console.log(JSON.stringify(n, (k, v) => typeof v === 'number' ? r3(v) : v));
  process.exit(0);
}

const LOOKS = {
  なし: {},
  フィルム風: { contrast: -20, blacks: 10, curve: { m: [[0, 0.08], [1, 0.95]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0.04], [1, 1]] }, saturation: -20, shadowHue: 200, shadowSat: 25, highHue: 40, highSat: 20, temp: 8 },
  明るくふんわり: { exposure: 0.5, contrast: -25, highlights: -30, shadows: 40, vibrance: 20, temp: -10, saturation: -5 },
  ムーディー: { exposure: -0.4, contrast: 30, saturation: -30, shadowHue: 190, shadowSat: 35, highHue: 35, highSat: 25, hslSat: [0, 0, 0, -50, -20, 0, 0, 0], vignette: -30 },
  あたたかビンテージ: { temp: 35, tint: 8, contrast: -10, curve: { m: [[0, 0.1], [0.5, 0.52], [1, 0.92]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] }, saturation: -15 },
  ビビッド: { contrast: 25, vibrance: 40, saturation: 15, whites: 20, blacks: -20, temp: -5 },
  モノクロ寄り: { saturation: -85, contrast: 20 },
};
function dE(a, b) {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4 * 3) {
    const la = X.rgb2lab(a[i] / 255, a[i + 1] / 255, a[i + 2] / 255), lb = X.rgb2lab(b[i] / 255, b[i + 1] / 255, b[i + 2] / 255);
    s += Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]); n++;
  }
  return s / n;
}

const verbose = process.argv.includes('-v');
// refs=3 のように指定すると、お手本を複数枚（別の写真に同じ編集）入れた場合を試す
const nref = +(process.argv.join(' ').match(/refs=(\d)/) || [0, 1])[1];
let tot = 0, totBase = 0, cnt = 0;
for (const [name, look] of Object.entries(LOOKS)) {
  let e = 0, b = 0, c = 0;
  const truth = imgs.map(im => E.applyCPU(im.data, im.w, im.h, look));
  for (let i = 0; i < imgs.length; i++) {
    const ids = Array.from({ length: nref }, (_, r) => (i + r * 4) % imgs.length);
    Object.assign(X.NAT, X.buildNat(stats.filter((_, j) => !ids.includes(j))));
    const est = X.estimate(ids.map(id => X.analyze(truth[id], imgs[id].w, imgs[id].h)));
    if (verbose && i < 3) console.log(name, imgs[i].name, JSON.stringify(est));
    for (let j = 0; j < imgs.length; j++) {
      if (ids.includes(j)) continue;
      const out = E.applyCPU(imgs[j].data, imgs[j].w, imgs[j].h, est);
      e += dE(out, truth[j]); b += dE(imgs[j].data, truth[j]); c++;
    }
  }
  console.log(`${name.padEnd(10, '　')}  推定後 ΔE ${(e / c).toFixed(2)}  （何もしない場合 ${(b / c).toFixed(2)}）`);
  tot += e / c; totBase += b / c; cnt++;
}
console.log(`平均  推定後 ${(tot / cnt).toFixed(2)}  何もしない ${(totBase / cnt).toFixed(2)}`);
