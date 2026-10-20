// お手本写真からプリセット（スライダーの値）を推定する。
// 「普通に撮った写真ならこういう明るさ・色の分布になる」という基準（NAT）と比べて、
// その差を生む編集をエンジンの計算そのものを使って探す。
(function (G) {
'use strict';
const E = G.Engine || (typeof require !== 'undefined' ? require('./engine.js') : null);

// 分位点（暗い方から何%の位置か）
const P = [0.005, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.995];
const HW = [0.005, 0.012, 0.02, 0.04, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.04, 0.02, 0.012, 0.005];

// 無編集の写真の平均的な統計とばらつき（node tools/eval.js <dir> --calib で求めた値）。
// ばらつき（Sd）より小さい差は「写っている物の違い」とみなして無視する。
const NAT = {"lumQ":[0.046,0.075,0.12,0.174,0.25,0.341,0.404,0.452,0.495,0.548,0.626,0.776,0.822,0.857,0.916],"lumSd":[0.039,0.031,0.022,0.045,0.094,0.122,0.115,0.094,0.113,0.155,0.127,0.101,0.114,0.103,0.067],"cast":[[-0.261,0],[-0.454,0.293],[-0.913,1.834],[-1.753,3.902],[-0.677,6.049],[-1.515,2.65],[-6.253,8.196],[-6.584,0.262],[-5.888,5.423],[-3.245,0.162],[-3.122,2.723],[-1.684,-4.336],[-1.213,-3.343],[-0.562,-1.921],[-0.542,-0.492]],"castSd":[[0.962,2.522],[0.673,3.16],[2.102,6.911],[1.9,7.051],[3.503,10.789],[7.125,11.833],[6.979,9.179],[8.125,16.05],[7.344,16.47],[2.833,25.823],[3.225,11.353],[1.979,10.773],[1.281,9.098],[0.983,5.237],[1.074,2.311]],"c50":19.873,"c90":37.796,"cSd":0.37,"band":[null,{"c":22.775,"cSd":0.163,"dh":3.792,"dhSd":3.786},{"c":28.883,"cSd":0.128,"dh":17.56,"dhSd":6.17},{"c":19.764,"cSd":0.356,"dh":-15.789,"dhSd":14.715},{"c":18.069,"cSd":0.021,"dh":16.957,"dhSd":1.781},{"c":18.05,"cSd":0.539,"dh":-14.559,"dhSd":5.358},null,null],"vig":1.065,"vigSd":0.058,"grain":0.004};
// 推定の効き具合（tools/eval.js で調整）
const K = {
  tau: 2,        // ばらつきの何倍までを無視するか
  beta: 1,       // 色かぶりをどこまで寄せるか
  lambda: 12,    // スライダーを大きく動かすことへのペナルティ
  tauSat: 1,     // 彩度だけ別の閾値（写真ごとの差が大きいので評価上は 0.5〜2 でほぼ同じ。反応しやすい方を採用）
  satDamp: 1,
  hslDamp: 0.5,
};
// ばらつき t より小さい差は 0 に、大きい差はほぼそのまま残す
let tauN = 1;
const soft = (d, t) => { t *= tauN; return Math.abs(d) <= t ? 0 : d * (1 - (t / d) ** 2); };

function rgb2lab(r, g, b) {
  r = E.s2l(r); g = E.s2l(g); b = E.s2l(b);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const median = a => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

// data: RGBA（縮小済み・長辺 400px 程度）、hi: 粒子を測るための等倍の切り抜き（任意）
function analyze(data, w, h, hi) {
  const n = w * h, Y = new Float32Array(n), L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n);
  const H = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    Y[i] = E.LW[0] * r + E.LW[1] * g + E.LW[2] * b;
    const lab = rgb2lab(r, g, b);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2]; C[i] = Math.hypot(lab[1], lab[2]);
    const hs = E.hsv([r, g, b]); H[i] = hs[0]; S[i] = hs[1];
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => Y[a] - Y[b]);
  const lumQ = P.map(q => Y[order[Math.min(n - 1, Math.round(q * (n - 1)))]]);
  // 各明るさで「色の薄い画素」の色 = 本来グレーのはずの所についた色
  const cast = P.map((q, k) => {
    const i0 = Math.max(0, Math.floor((q - HW[k]) * n)), i1 = Math.min(n, Math.ceil((q + HW[k]) * n));
    const idx = order.slice(i0, i1).sort((a, b) => C[a] - C[b]);
    const sel = idx.slice(0, Math.max(1, Math.round(idx.length * 0.35)));
    return [median(sel.map(i => A[i])), median(sel.map(i => B[i]))];
  });
  const mids = [];
  for (let i = 0; i < n; i++) if (L[i] > 15 && L[i] < 90) mids.push(C[i]);
  mids.sort((a, b) => a - b);
  const c50 = mids.length ? quant(mids, 0.5) : 0, c90 = mids.length ? quant(mids, 0.9) : 0;
  // 色ごとの鮮やかさと色相のずれ
  const band = E.BANDS.map(() => ({ c: [], dh: [] }));
  let colored = 0;
  for (let i = 0; i < n; i++) {
    if (C[i] < 10 || S[i] < 0.15 || L[i] < 15 || L[i] > 92) continue;
    colored++;
    const w8 = E.bandWeights(H[i]);
    let k = 0; for (let j = 1; j < 8; j++) if (w8[j] > w8[k]) k = j;
    let dd = H[i] - E.BANDS[k].hue; dd -= 360 * Math.floor((dd + 180) / 360);
    band[k].c.push(C[i]); band[k].dh.push(dd);
  }
  const bands = band.map(b => ({ frac: colored ? b.c.length / n : 0, c: median(b.c), dh: median(b.dh) }));
  return { lumQ, cast, c50, c90, bands, vig: vignette(Y, w, h), grain: hi ? grainSigma(hi.data, hi.width, hi.height) : null };
}

// 周辺が中心よりどれだけ暗いか（8方向で測り、いちばん暗くない方向を採る＝写っている物のせいにしにくい）
function vignette(Y, w, h) {
  const asp = w / h, diag = Math.hypot(asp * 0.5, 0.5);
  const out = new Array(8).fill(0), outN = new Array(8).fill(0), inn = new Array(8).fill(0), innN = new Array(8).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = ((x + 0.5) / w - 0.5) * asp, py = (y + 0.5) / h - 0.5;
    const r = Math.hypot(px, py) / diag;
    const s = Math.min(7, Math.floor((Math.atan2(py, px) + Math.PI) / (Math.PI / 4)));
    const v = Y[y * w + x];
    if (r > 0.85) { out[s] += v; outN[s]++; } else if (r > 0.4 && r < 0.6) { inn[s] += v; innN[s]++; }
  }
  let best = 0;
  for (let s = 0; s < 8; s++) if (outN[s] && innN[s]) best = Math.max(best, (out[s] / outN[s]) / Math.max(1e-3, inn[s] / innN[s]));
  return best || 1;
}

// 平らな所のザラつき（細かい凹凸の大きさ）
function grainSigma(data, w, h) {
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Y[i] = (E.LW[0] * data[i * 4] + E.LW[1] * data[i * 4 + 1] + E.LW[2] * data[i * 4 + 2]) / 255;
  const B = 16, patches = [];
  for (let by = 1; by + B < h - 1; by += B) for (let bx = 1; bx + B < w - 1; bx += B) {
    let sr = 0, sr2 = 0, m = 0, sy = 0, cnt = 0;
    for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
      const i = y * w + x;
      const blur = (Y[i - 1] + Y[i + 1] + Y[i - w] + Y[i + w] + Y[i - w - 1] + Y[i - w + 1] + Y[i + w - 1] + Y[i + w + 1] + Y[i]) / 9;
      const r = Y[i] - blur; sr += r; sr2 += r * r; sy += Y[i]; cnt++;
    }
    m = sy / cnt;
    // 低周波の変化（グラデーション）を測る
    const g = Math.abs(Y[by * w + bx] - Y[(by + B - 1) * w + bx + B - 1]) + Math.abs(Y[by * w + bx + B - 1] - Y[(by + B - 1) * w + bx]);
    if (m > 0.15 && m < 0.85) patches.push({ s: Math.sqrt(Math.max(0, sr2 / cnt - (sr / cnt) ** 2)), g });
  }
  if (!patches.length) return null;
  patches.sort((a, b) => a.s - b.s);
  // ザラつきが小さい方から 3 割（＝模様のない平らな所）の中央値
  return median(patches.slice(0, Math.max(1, Math.round(patches.length * 0.3))).map(p => p.s));
}

// 複数枚の統計を平均
function mergeStats(list) {
  const avg = f => list.reduce((s, x) => s + f(x), 0) / list.length;
  const gs = list.map(s => s.grain).filter(v => v != null);
  return {
    lumQ: P.map((_, k) => avg(s => s.lumQ[k])),
    cast: P.map((_, k) => [avg(s => s.cast[k][0]), avg(s => s.cast[k][1])]),
    c50: avg(s => s.c50), c90: avg(s => s.c90),
    bands: E.BANDS.map((_, k) => {
      const ws = list.map(s => s.bands[k].frac), W = ws.reduce((a, b) => a + b, 0);
      return { frac: W / list.length, c: W ? list.reduce((a, s) => a + s.bands[k].c * s.bands[k].frac, 0) / W : 0, dh: W ? list.reduce((a, s) => a + s.bands[k].dh * s.bands[k].frac, 0) / W : 0 };
    }),
    vig: avg(s => s.vig),
    grain: gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : null,
  };
}

// ---------- 明るさと色かぶりの当てはめ ----------
// θ（すべて -1〜1 程度）→ プリセット
const KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'sa', 'sb', 'ha', 'hb', 'r0', 'g0', 'b0', 'r1', 'g1', 'b1'];
function toParams(th) {
  const p = E.defaults();
  p.exposure = th[0];
  ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint'].forEach((k, i) => { p[k] = th[i + 1] * 100; });
  const sh = cart2hs(th[8], th[9]), hh = cart2hs(th[10], th[11]);
  p.shadowHue = sh[0]; p.shadowSat = sh[1]; p.highHue = hh[0]; p.highSat = hh[1];
  p.curve.r = [[0, th[12]], [1, 1 - th[15]]];
  p.curve.g = [[0, th[13]], [1, 1 - th[16]]];
  p.curve.b = [[0, th[14]], [1, 1 - th[17]]];
  return p;
}
// 色相を平面の (x, y) で持つと当てはめが滑らかになる
function cart2hs(x, y) { return [((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360, Math.min(100, Math.hypot(x, y) * 100)]; }
const LIM = [[-2, 2], ...Array(7).fill([-1, 1]), ...Array(4).fill([-1, 1]), ...Array(6).fill([0, 0.4])];
const REG = [1, 1, 1.5, 1.5, 1.5, 1.5, 1, 1.5, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0];
// カーブの端点は「3色そろって持ち上げる（フェード）」は安く、「色ごとにずらす」は高くつける。
// 色味はなるべくカラーグレーディング側で表すため
const endPenalty = (a, b, c) => { const m = (a + b + c) / 3; return 2 * m * m + 12 * ((a - m) ** 2 + (b - m) ** 2 + (c - m) ** 2); };

function fitTone(st) {
  const xs = NAT.lumQ;
  const tgt = P.map((q, k) => {
    const y = xs[k] + soft(st.lumQ[k] - xs[k], K.tau * NAT.lumSd[k]);
    const L = rgb2lab(y, y, y)[0];
    return [L, soft(st.cast[k][0] - NAT.cast[k][0], K.tau * NAT.castSd[k][0]) * K.beta, soft(st.cast[k][1] - NAT.cast[k][1], K.tau * NAT.castSd[k][1]) * K.beta];
  });
  const lab0 = xs.map(x => rgb2lab(x, x, x));
  // 目標が無編集とほぼ同じなら何もしない
  if (tgt.every((t, k) => Math.abs(t[0] - lab0[k][0]) < 0.3 && Math.abs(t[1]) < 0.3 && Math.abs(t[2]) < 0.3)) return E.defaults();
  const loss = th => {
    for (let j = 0; j < th.length; j++) if (th[j] < LIM[j][0] || th[j] > LIM[j][1]) return 1e9;
    const u = E.prepare(toParams(th), true);
    let e = 0;
    for (let k = 0; k < xs.length; k++) {
      const c = E.pixel([xs[k], xs[k], xs[k]], u);
      const lab = rgb2lab(c[0], c[1], c[2]);
      const w = k === 0 || k === xs.length - 1 ? 2 : 1;
      e += w * ((lab[0] - tgt[k][0]) ** 2 + (lab[1] - tgt[k][1]) ** 2 + (lab[2] - tgt[k][2]) ** 2);
    }
    e /= xs.length;
    for (let j = 0; j < th.length; j++) e += K.lambda * REG[j] * th[j] * th[j];
    e += K.lambda * (endPenalty(th[12], th[13], th[14]) + endPenalty(th[15], th[16], th[17]));
    return e;
  };
  let best = new Array(KEYS.length).fill(0), bl = loss(best);
  for (let rep = 0; rep < 2; rep++) {
    const r = nelderMead(loss, best, rep === 0 ? 0.15 : 0.04, 2500);
    if (r.f < bl) { best = r.x; bl = r.f; }
  }
  return toParams(best);
}

function nelderMead(f, x0, step, maxIt) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += (x[i] + step > 1 && step > 0 ? -step : step); pts.push(x); }
  let fs = pts.map(f);
  for (let it = 0; it < maxIt; it++) {
    const ord = fs.map((v, i) => i).sort((a, b) => fs[a] - fs[b]);
    pts = ord.map(i => pts[i]); fs = ord.map(i => fs[i]);
    if (Math.abs(fs[n] - fs[0]) < 1e-7 * (1 + Math.abs(fs[0]))) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const at = t => c.map((v, j) => v + t * (pts[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < fs[0]) {
      const xe = at(-2), fe = f(xe);
      if (fe < fr) { pts[n] = xe; fs[n] = fe; } else { pts[n] = xr; fs[n] = fr; }
    } else if (fr < fs[n - 1]) { pts[n] = xr; fs[n] = fr; }
    else {
      const xc = fr < fs[n] ? at(-0.5) : at(0.5), fc = f(xc);
      if (fc < Math.min(fr, fs[n])) { pts[n] = xc; fs[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); fs[i] = f(pts[i]); }
      }
    }
  }
  let b = 0; for (let i = 1; i <= n; i++) if (fs[i] < fs[b]) b = i;
  return { x: pts[b], f: fs[b] };
}

// ---------- 全体 ----------
function estimate(statsList) {
  const st = mergeStats(statsList);
  // 枚数が多いほど平均のばらつきは小さくなる
  tauN = 1 / Math.sqrt(statsList.length);
  const p = fitTone(st);
  // 彩度：基準に対する倍率（対数で比べる）
  const la = Math.log(Math.max(1, st.c50) / NAT.c50), lb = Math.log(Math.max(1, st.c90) / NAT.c90);
  const ls = soft((la + lb) / 2, K.tauSat * NAT.cSd);
  p.saturation = clamp((Math.exp(ls) - 1) * 100 * K.satDamp, -100, 80);
  // 色ごとの鮮やかさ・色相のずれ（弱めに）
  st.bands.forEach((b, k) => {
    const nb = NAT.band[k];
    if (b.frac < 0.03 || !nb) return;
    const lr = Math.log(Math.max(1, b.c) / nb.c) - ls;
    p.hslSat[k] = clamp(soft(lr, K.tau * nb.cSd) * 100 * K.hslDamp, -40, 40);
    p.hslHue[k] = clamp(soft(b.dh - nb.dh, K.tau * nb.dhSd) / 30 * 100 * K.hslDamp, -40, 40);
  });
  // 周辺光量：測った比になる量を探す
  const vr = NAT.vig + soft(st.vig - NAT.vig, K.tau * NAT.vigSd);
  if (vr < NAT.vig) {
    const ratio = Math.max(0.3, vr / NAT.vig);
    const mk = r => { const t = Math.min(1, Math.max(0, (r - 0.25) / 0.75)); return t * t * (3 - 2 * t); };
    const mo = mk(0.92), mi = mk(0.5);
    // (1 + v*0.8*mo) / (1 + v*0.8*mi) = ratio を v について解く
    const vv = (ratio - 1) / (0.8 * (mo - ratio * mi));
    p.vignette = clamp(vv * 100, -80, 0);
  }
  // 粒子
  if (st.grain != null && st.grain > NAT.grain * 1.6) p.grain = clamp((st.grain - NAT.grain) * 2200, 0, 70);
  return roundParams(p);
}

// 無編集写真の統計の一覧から NAT を作る（較正用）
function buildNat(list) {
  const med = a => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // 中央値からの絶対偏差の中央値 ×1.48 ＝ 外れ値に強い標準偏差
  const sd = a => { const m = med(a); return 1.4826 * med(a.map(v => Math.abs(v - m))); };
  const lc = list.map(s => (Math.log(Math.max(1, s.c50)) + Math.log(Math.max(1, s.c90))) / 2);
  return {
    lumQ: P.map((_, k) => med(list.map(s => s.lumQ[k]))),
    lumSd: P.map((_, k) => sd(list.map(s => s.lumQ[k]))),
    cast: P.map((_, k) => [0, 1].map(j => med(list.map(s => s.cast[k][j])))),
    castSd: P.map((_, k) => [0, 1].map(j => sd(list.map(s => s.cast[k][j])))),
    c50: med(list.map(s => s.c50)), c90: med(list.map(s => s.c90)), cSd: sd(lc),
    band: E.BANDS.map((_, k) => {
      const ok = list.filter(s => s.bands[k].frac > 0.03);
      if (ok.length < 3) return null;
      const g = ok.map(s => Math.log(Math.max(1, s.bands[k].c)) - (Math.log(Math.max(1, s.c50)) + Math.log(Math.max(1, s.c90))) / 2);
      return { c: Math.exp(med(ok.map(s => Math.log(Math.max(1, s.bands[k].c))))), cSd: sd(g), dh: med(ok.map(s => s.bands[k].dh)), dhSd: sd(ok.map(s => s.bands[k].dh)) };
    }),
    vig: med(list.map(s => s.vig)), vigSd: sd(list.map(s => s.vig)),
    grain: 0.004,
  };
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function roundParams(p) {
  const r = (v, d = 0) => { const m = 10 ** d; return Math.round(v * m) / m; };
  for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'shadowHue', 'shadowSat', 'highHue', 'highSat', 'balance', 'vignette', 'grain']) p[k] = r(p[k]);
  p.exposure = r(p.exposure, 2);
  for (const k of ['hslHue', 'hslSat', 'hslLum']) p[k] = p[k].map(v => r(v));
  for (const c of ['m', 'r', 'g', 'b']) p.curve[c] = p.curve[c].map(([x, y]) => [r(x, 3), r(y, 3)]);
  return p;
}

const Extract = { P, NAT, K, analyze, mergeStats, estimate, fitTone, rgb2lab, buildNat };
G.Extract = Extract;
if (typeof module !== 'undefined') module.exports = Extract;
})(typeof globalThis !== 'undefined' ? globalThis : this);
