// 編集パラメータと画像処理。
// 同じ計算を GPU（シェーダー）と CPU（プリセット推定・テスト用）の両方に持つ。片方を変えたらもう片方も直すこと。
(function (G) {
'use strict';

const LW = [0.2126, 0.7152, 0.0722];
// HSL の8色（Lightroom と同じ並び）。中心の色相は HSV の角度
const BANDS = [
  { key: 'red', name: 'レッド', hue: 0, color: '#e5484d' },
  { key: 'orange', name: 'オレンジ', hue: 30, color: '#f08c2e' },
  { key: 'yellow', name: 'イエロー', hue: 60, color: '#e8c72e' },
  { key: 'green', name: 'グリーン', hue: 120, color: '#46a758' },
  { key: 'aqua', name: 'アクア', hue: 180, color: '#2bb5b5' },
  { key: 'blue', name: 'ブルー', hue: 225, color: '#3e7bfa' },
  { key: 'purple', name: 'パープル', hue: 270, color: '#8e4ec6' },
  { key: 'magenta', name: 'マゼンタ', hue: 315, color: '#d6409f' },
];
const CEN = BANDS.map(b => b.hue);
const SPAN_L = CEN.map((c, i) => ((c - CEN[(i + 7) % 8]) + 360) % 360);
const SPAN_R = CEN.map((c, i) => ((CEN[(i + 1) % 8] - c) + 360) % 360);

const ID_CURVE = () => [[0, 0], [1, 1]];
function defaults() {
  return {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temp: 0, tint: 0, vibrance: 0, saturation: 0,
    hslHue: [0, 0, 0, 0, 0, 0, 0, 0], hslSat: [0, 0, 0, 0, 0, 0, 0, 0], hslLum: [0, 0, 0, 0, 0, 0, 0, 0],
    shadowHue: 210, shadowSat: 0, highHue: 40, highSat: 0, balance: 0,
    curve: { m: ID_CURVE(), r: ID_CURVE(), g: ID_CURVE(), b: ID_CURVE() },
    vignette: 0, grain: 0,
  };
}
const SCALARS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'shadowSat', 'highSat', 'balance', 'vignette', 'grain'];

// 古い保存データや欠けた項目を補う
function normalize(p) {
  const d = defaults(), o = Object.assign(d, JSON.parse(JSON.stringify(p || {})));
  o.curve = Object.assign(defaults().curve, o.curve || {});
  return o;
}

// 強さ t（0〜1）で効き具合を弱める。色相などの「向き」はそのまま
function scale(p, t) {
  const o = normalize(p);
  for (const k of SCALARS) o[k] *= t;
  for (const k of ['hslHue', 'hslSat', 'hslLum']) o[k] = o[k].map(v => v * t);
  for (const c of ['m', 'r', 'g', 'b']) o.curve[c] = o.curve[c].map(([x, y]) => [x, x + (y - x) * t]);
  return o;
}

function isDefault(p) {
  return JSON.stringify(normalize(p)) === JSON.stringify(defaults());
}

// ---------- トーンカーブ（単調な3次補間） ----------
function curveFn(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0]);
  const n = P.length;
  if (n < 2) return x => x;
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
// R,G,B それぞれ「全体カーブ → 色別カーブ」を合成した 256 段の表
function buildLut(curve) {
  const fm = curveFn(curve.m), fc = [curveFn(curve.r), curveFn(curve.g), curveFn(curve.b)];
  const lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = fm(i / 255);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.min(1, Math.max(0, fc[c](Math.min(1, Math.max(0, v)))));
  }
  return lut;
}

function curveFns(curve) {
  const fm = curveFn(curve.m);
  return [curve.r, curve.g, curve.b].map(pts => { const f = curveFn(pts); return x => Math.min(1, Math.max(0, f(Math.min(1, Math.max(0, fm(Math.min(1, Math.max(0, x)))))))); });
}

function hueVec(h) {
  // その色相の純色から輝度を引いた「色だけの向き」（長さ1）
  const k = n => { const x = (n + h / 60) % 6; return 1 - Math.max(0, Math.min(x, 4 - x, 1)); };
  const c = [k(5), k(3), k(1)];
  const y = c[0] * LW[0] + c[1] * LW[1] + c[2] * LW[2];
  const v = c.map(x => x - y), l = Math.hypot(v[0], v[1], v[2]) || 1;
  return v.map(x => x / l);
}

// スライダーの値をシェーダーに渡す形へ
// fast: 表を作らずカーブ関数を直接使う（推定で何千回も呼ぶため）
function prepare(p, fast) {
  p = normalize(p);
  const t = p.temp / 100, ti = p.tint / 100;
  const m = [Math.exp(0.32 * t), Math.exp(-0.22 * ti), Math.exp(-0.32 * t)];
  const n = m[0] * LW[0] + m[1] * LW[1] + m[2] * LW[2], e = Math.pow(2, p.exposure);
  const sv = hueVec(p.shadowHue), hv = hueVec(p.highHue);
  const ss = p.shadowSat / 100 * 0.25, hs = p.highSat / 100 * 0.25;
  return {
    wb: m.map(v => v / n * e),
    contrast: p.contrast / 100 * 0.55,
    high: p.highlights / 100 * 0.22,
    shadow: p.shadows / 100 * 0.18,
    white: p.whites / 100 * 0.18,
    black: p.blacks / 100 * 0.12,
    hslH: p.hslHue.map(v => v / 100 * 30 * Math.PI / 180),
    hslS: p.hslSat.map(v => v / 100),
    hslL: p.hslLum.map(v => v / 100 * 0.4),
    sat: p.saturation / 100, vib: p.vibrance / 100,
    tintS: sv.map(v => v * ss), tintH: hv.map(v => v * hs),
    mid: 0.5 - p.balance / 100 * 0.3,
    vig: p.vignette / 100, grain: p.grain / 100,
    lut: fast ? null : buildLut(p.curve),
    cf: fast ? curveFns(p.curve) : null,
  };
}

// ---------- CPU 版（シェーダーと同じ計算） ----------
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const s2l = x => x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
const l2s = x => x <= 0.0031308 ? Math.max(0, x) * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
const luma = c => c[0] * LW[0] + c[1] * LW[1] + c[2] * LW[2];

function toneY(y, u) {
  if (y >= 0 && y <= 1) y = y - u.contrast * Math.sin(2 * Math.PI * y) / (2 * Math.PI);
  y += u.high * sstep(0.3, 0.85, y);
  y += y < 0.7 ? u.shadow * 9.64 * Math.max(0, y) * (1 - y / 0.7) * (1 - y / 0.7) : 0;
  y += u.white * sstep(0.55, 1.0, y);
  y += u.black * (1 - sstep(0.0, 0.45, y));
  return y;
}
function hsv(c) {
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn;
  const s = mx > 1e-5 ? d / mx : 0;
  let h = 0;
  if (d > 1e-5) {
    if (mx === c[0]) h = (((c[1] - c[2]) / d) % 6 + 6) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h *= 60;
  }
  return [h, s];
}
function bandWeights(h) {
  const w = new Array(8);
  for (let i = 0; i < 8; i++) {
    let dd = h - CEN[i];
    dd -= 360 * Math.floor((dd + 180) / 360);
    w[i] = Math.max(0, dd >= 0 ? 1 - dd / SPAN_R[i] : 1 + dd / SPAN_L[i]);
  }
  return w;
}
const lutAt = (lut, ch, v) => {
  const x = Math.min(1, Math.max(0, v)) * 255, i = Math.min(254, Math.floor(x)), f = x - i;
  return lut[i * 3 + ch] * (1 - f) + lut[(i + 1) * 3 + ch] * f;
};
const R3 = 1 / Math.sqrt(3);

// 1画素を処理（入出力は 0〜1 の sRGB）。pos = [u, v]（画像内の位置 0〜1）, aspect は横/縦
function pixel(rgb, u, pos, aspect, grainRes) {
  let c = [s2l(rgb[0]) * u.wb[0], s2l(rgb[1]) * u.wb[1], s2l(rgb[2]) * u.wb[2]];
  c = c.map(l2s);
  // 明るさ（色を保ったまま輝度だけ動かす）
  const Y = luma(c), y = toneY(Y, u);
  const r = sstep(0.0, 0.06, Y), q = y / Math.max(Y, 1e-5);
  c = c.map(v => (v + (y - Y)) * (1 - r) + v * q * r);
  // トーンカーブ
  c = u.cf ? [u.cf[0](c[0]), u.cf[1](c[1]), u.cf[2](c[2])] : [lutAt(u.lut, 0, c[0]), lutAt(u.lut, 1, c[1]), lutAt(u.lut, 2, c[2])];
  // HSL
  let [h, s] = hsv(c);
  const w = bandWeights(h);
  let dh = 0, ds = 0, dl = 0;
  for (let i = 0; i < 8; i++) { dh += w[i] * u.hslH[i]; ds += w[i] * u.hslS[i]; dl += w[i] * u.hslL[i]; }
  const sw = sstep(0.0, 0.1, s);
  if (dh !== 0) {
    const Y0 = luma(c), a = dh * sw, co = Math.cos(a), si = Math.sin(a), kv = (c[0] + c[1] + c[2]) * R3 * R3 * (1 - co);
    const x = [(c[2] - c[1]) * R3, (c[0] - c[2]) * R3, (c[1] - c[0]) * R3];
    c = [c[0] * co + x[0] * si + kv, c[1] * co + x[1] * si + kv, c[2] * co + x[2] * si + kv];
    const d = Y0 - luma(c); c = c.map(v => v + d);
  }
  let Y1 = luma(c);
  c = c.map(v => Y1 + (v - Y1) * (1 + ds * sw));
  c = c.map(v => v * (1 + dl * s));
  // 自然な彩度・彩度
  s = hsv(c)[1]; Y1 = luma(c);
  const f = (1 + u.sat) * (1 + u.vib * (1 - 0.6 * s));
  c = c.map(v => Y1 + (v - Y1) * f);
  // カラーグレーディング（シャドウ・ハイライトに色を足す）
  const Yc = Math.min(1, Math.max(0, luma(c)));
  const t = sstep(u.mid - 0.4, u.mid + 0.4, Yc), ws = (1 - t) * sstep(-0.05, 0.15, Yc);
  c = c.map((v, i) => v + ws * u.tintS[i] + t * u.tintH[i]);
  if (pos) {
    const px = (pos[0] - 0.5) * aspect, py = pos[1] - 0.5;
    const rr = Math.hypot(px, py) / Math.hypot(aspect * 0.5, 0.5), mk = sstep(0.25, 1.0, rr);
    if (u.vig < 0) c = c.map(v => v * (1 + u.vig * 0.8 * mk));
    else c = c.map(v => v + (1 - v) * u.vig * 0.6 * mk);
    if (u.grain > 0) {
      const gx = pos[0] * grainRes[0], gy = pos[1] * grainRes[1];
      const n = vnoise(gx, gy) + vnoise(gx * 1.7 + 13.1, gy * 1.7 + 13.1) - 1;
      const Yg = Math.min(1, Math.max(0, luma(c)));
      c = c.map(v => v + n * u.grain * 0.14 * (0.3 + 2.8 * Yg * (1 - Yg)));
    }
  }
  return c.map(v => Math.min(1, Math.max(0, v)));
}
const fract = x => x - Math.floor(x);
const hash = (x, y) => fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
function grainRes(w, h) {
  const L = Math.max(w, h);
  return [w / L * 1300, h / L * 1300];
}

// RGBA の配列をまとめて CPU で処理（テスト・小さいサムネイル用）
function applyCPU(data, w, h, p) {
  const u = prepare(p), out = new Uint8ClampedArray(data.length), gr = grainRes(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const c = pixel([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255], u, [(x + 0.5) / w, (y + 0.5) / h], w / h, gr);
    out[i] = Math.round(c[0] * 255); out[i + 1] = Math.round(c[1] * 255); out[i + 2] = Math.round(c[2] * 255); out[i + 3] = 255;
  }
  return out;
}

// ---------- GPU 版 ----------
const VS = `
attribute vec2 aPos;
uniform vec4 uRect;
varying vec2 vUv;
void main() {
  vUv = mix(uRect.xy, uRect.zw, aPos);
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;
const FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImg;
uniform sampler2D uLut;
uniform float uOn;
uniform vec3 uWb;
uniform float uContrast, uHigh, uShadow, uWhite, uBlack;
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform float uCen[8];
uniform float uSpanL[8];
uniform float uSpanR[8];
uniform float uSat, uVib, uMid, uVig, uGrain, uAspect;
uniform vec3 uTintS, uTintH;
uniform vec2 uGrainRes;
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
const float PI = 3.14159265;

vec3 s2l(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 l2s(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p) { return fract(sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec2 hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  float s = mx > 1e-5 ? d / mx : 0.0;
  float h = 0.0;
  if (d > 1e-5) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
  }
  return vec2(h, s);
}
float lutAt(float v, int ch) {
  vec3 t = texture2D(uLut, vec2(clamp(v, 0.0, 1.0) * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).rgb;
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}

void main() {
  vec3 c = texture2D(uImg, vUv).rgb;
  if (uOn < 0.5) { gl_FragColor = vec4(c, 1.0); return; }
  c = l2s(s2l(c) * uWb);
  // 明るさ
  float Y = dot(c, LW), y = Y;
  if (y >= 0.0 && y <= 1.0) y = y - uContrast * sin(2.0 * PI * y) / (2.0 * PI);
  y += uHigh * smoothstep(0.3, 0.85, y);
  if (y < 0.7) y += uShadow * 9.64 * max(0.0, y) * (1.0 - y / 0.7) * (1.0 - y / 0.7);
  y += uWhite * smoothstep(0.55, 1.0, y);
  y += uBlack * (1.0 - smoothstep(0.0, 0.45, y));
  float r = smoothstep(0.0, 0.06, Y);
  c = mix(c + (y - Y), c * (y / max(Y, 1e-5)), r);
  // トーンカーブ
  c = vec3(lutAt(c.r, 0), lutAt(c.g, 1), lutAt(c.b, 2));
  // HSL
  vec2 hs = hsv(c);
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    float dd = hs.x - uCen[i];
    dd -= 360.0 * floor((dd + 180.0) / 360.0);
    float w = max(0.0, dd >= 0.0 ? 1.0 - dd / uSpanR[i] : 1.0 + dd / uSpanL[i]);
    dh += w * uHslH[i]; ds += w * uHslS[i]; dl += w * uHslL[i];
  }
  float sw = smoothstep(0.0, 0.1, hs.y);
  if (dh != 0.0) {
    float Y0 = dot(c, LW), a = dh * sw, co = cos(a), si = sin(a);
    float R3 = 0.57735027;
    float kv = (c.r + c.g + c.b) * R3 * R3 * (1.0 - co);
    vec3 x = vec3(c.b - c.g, c.r - c.b, c.g - c.r) * R3;
    c = c * co + x * si + kv;
    c += Y0 - dot(c, LW);
  }
  float Y1 = dot(c, LW);
  c = Y1 + (c - Y1) * (1.0 + ds * sw);
  c *= 1.0 + dl * hs.y;
  // 自然な彩度・彩度
  float s2 = hsv(c).y;
  Y1 = dot(c, LW);
  c = Y1 + (c - Y1) * ((1.0 + uSat) * (1.0 + uVib * (1.0 - 0.6 * s2)));
  // カラーグレーディング
  float Yc = clamp(dot(c, LW), 0.0, 1.0);
  float t = smoothstep(uMid - 0.4, uMid + 0.4, Yc), ws = (1.0 - t) * smoothstep(-0.05, 0.15, Yc);
  c += ws * uTintS + t * uTintH;
  // 周辺光量
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float mk = smoothstep(0.25, 1.0, length(p) / length(vec2(uAspect * 0.5, 0.5)));
  if (uVig < 0.0) c *= 1.0 + uVig * 0.8 * mk;
  else c += (1.0 - c) * uVig * 0.6 * mk;
  // 粒子
  if (uGrain > 0.0) {
    vec2 g = vUv * uGrainRes;
    float n = vnoise(g) + vnoise(g * 1.7 + 13.1) - 1.0;
    float Yg = clamp(dot(c, LW), 0.0, 1.0);
    c += n * uGrain * 0.14 * (0.3 + 2.8 * Yg * (1.0 - Yg));
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('この端末では GPU 描画が使えません');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    this.pr = pr;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.U = {};
    for (const n of ['uImg', 'uLut', 'uOn', 'uWb', 'uContrast', 'uHigh', 'uShadow', 'uWhite', 'uBlack', 'uHslH', 'uHslS', 'uHslL', 'uCen', 'uSpanL', 'uSpanR', 'uSat', 'uVib', 'uMid', 'uVig', 'uGrain', 'uAspect', 'uTintS', 'uTintH', 'uGrainRes', 'uRect'])
      this.U[n] = gl.getUniformLocation(pr, n);
    gl.uniform1i(this.U.uImg, 0); gl.uniform1i(this.U.uLut, 1);
    gl.uniform1fv(this.U.uCen, CEN); gl.uniform1fv(this.U.uSpanL, SPAN_L); gl.uniform1fv(this.U.uSpanR, SPAN_R);
    this.lutTex = this.tex();
    this.imgTex = this.tex();
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.w = 0; this.h = 0;
  }
  tex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // 画像（canvas / img / ImageBitmap）をプレビュー用にセット
  setImage(src, w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
  }
  uniforms(p, on, w, h) {
    const gl = this.gl, U = this.U, u = prepare(p);
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(u.lut[i * 3 + c] * 255);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(U.uOn, on ? 1 : 0);
    gl.uniform3fv(U.uWb, u.wb);
    gl.uniform1f(U.uContrast, u.contrast); gl.uniform1f(U.uHigh, u.high); gl.uniform1f(U.uShadow, u.shadow);
    gl.uniform1f(U.uWhite, u.white); gl.uniform1f(U.uBlack, u.black);
    gl.uniform1fv(U.uHslH, u.hslH); gl.uniform1fv(U.uHslS, u.hslS); gl.uniform1fv(U.uHslL, u.hslL);
    gl.uniform1f(U.uSat, u.sat); gl.uniform1f(U.uVib, u.vib); gl.uniform1f(U.uMid, u.mid);
    gl.uniform3fv(U.uTintS, u.tintS); gl.uniform3fv(U.uTintH, u.tintH);
    gl.uniform1f(U.uVig, u.vig); gl.uniform1f(U.uGrain, u.grain);
    gl.uniform1f(U.uAspect, w / h);
    gl.uniform2fv(U.uGrainRes, grainRes(w, h));
  }
  render(p, on = true) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    this.uniforms(p, on, this.w, this.h);
    gl.uniform4f(this.U.uRect, 0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // 元サイズで書き出し。src は向きを直した canvas。タイルごとに描いて 2D canvas に貼る
  renderFull(src, p) {
    const gl = this.gl, W = src.width, H = src.height, T = 1024;
    const t = this.tex();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    const fbTex = this.tex();
    gl.bindTexture(gl.TEXTURE_2D, fbTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, T, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    this.uniforms(p, true, W, H);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    const buf = new Uint8Array(T * T * 4);
    for (let y0 = 0; y0 < H; y0 += T) for (let x0 = 0; x0 < W; x0 += T) {
      const w = Math.min(T, W - x0), h = Math.min(T, H - y0);
      gl.viewport(0, 0, w, h);
      gl.uniform4f(this.U.uRect, x0 / W, y0 / H, (x0 + w) / W, (y0 + h) / H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const img = ctx.createImageData(w, h);
      for (let r = 0; r < h; r++) img.data.set(buf.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
      ctx.putImageData(img, x0, y0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(fbTex); gl.deleteTexture(t);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    return out;
  }
}

const Engine = { LW, BANDS, defaults, normalize, scale, isDefault, curveFn, buildLut, prepare, pixel, applyCPU, grainRes, hsv, bandWeights, s2l, l2s, Renderer };
G.Engine = Engine;
if (typeof module !== 'undefined') module.exports = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
