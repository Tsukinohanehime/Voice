/* dsp.js — การประมวลผลเสียงล้วน ๆ (ไม่พึ่งไลบรารี) ใช้ได้ทั้งในเบราว์เซอร์และ Node
 * - YIN (ระดับเสียง F0)      - Burg LPC + รากพหุนาม (formant F1–F3)
 * - FFT / STFT / H1–H2       - ความยาวช่องเสียงเทียบเท่า (VTL)
 */
(function (root) {
  'use strict';
  const DSP = {};
  const TWO_PI = Math.PI * 2;
  DSP.LPC_ORDER = 12;

  /* ---------- helpers ---------- */
  DSP.median = function (arr) {
    if (!arr.length) return NaN;
    const a = Array.prototype.slice.call(arr).sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  DSP.percentile = function (arr, p) {
    if (!arr.length) return NaN;
    const a = Array.prototype.slice.call(arr).sort((x, y) => x - y);
    const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  };
  DSP.rms = function (x, s, e) {
    s = s || 0; e = e === undefined ? x.length : e;
    let sum = 0;
    for (let i = s; i < e; i++) sum += x[i] * x[i];
    return Math.sqrt(sum / Math.max(1, e - s));
  };
  DSP.hz2st = (f) => 12 * Math.log2(f / 100);
  DSP.clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const winCache = {};
  DSP.window = function (type, n) {
    const key = type + n;
    if (winCache[key]) return winCache[key];
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = type === 'hann'
        ? 0.5 - 0.5 * Math.cos(TWO_PI * i / (n - 1))
        : 0.54 - 0.46 * Math.cos(TWO_PI * i / (n - 1));
    }
    return (winCache[key] = w);
  };

  /* ---------- FFT (radix-2, in place) ---------- */
  const fftTables = {};
  function tables(n) {
    if (fftTables[n]) return fftTables[n];
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(TWO_PI * i / n); sin[i] = Math.sin(TWO_PI * i / n); }
    const rev = new Uint32Array(n);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }
    return (fftTables[n] = { cos, sin, rev });
  }
  DSP.fft = function (re, im) {
    const n = re.length, t = tables(n);
    for (let i = 0; i < n; i++) {
      const j = t.rev[i];
      if (j > i) { let a = re[i]; re[i] = re[j]; re[j] = a; a = im[i]; im[i] = im[j]; im[j] = a; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = t.cos[k], wi = -t.sin[k];
          const a = i + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };

  /** magnitude spectrum in dB of one windowed frame (length n = power of 2) */
  DSP.spectrumDb = function (x, start, n, out) {
    const w = DSP.window('hann', n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (x[start + i] || 0) * w[i];
    DSP.fft(re, im);
    out = out || new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) out[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
    return out;
  };

  /* ---------- YIN pitch ---------- */
  /** x: Float array at sample rate sr, uses x[start .. start+W+tauMax]. returns {f0, conf} (f0=0 if unvoiced) */
  DSP.yin = function (x, start, sr, opt) {
    opt = opt || {};
    const fmin = opt.fmin || 70, fmax = opt.fmax || 480, thr = opt.thresh || 0.15;
    const tauMin = Math.max(2, Math.floor(sr / fmax)), tauMax = Math.ceil(sr / fmin);
    const W = opt.W || Math.round(sr * 0.032);
    if (start + W + tauMax >= x.length) return { f0: 0, conf: 0 };
    const d = new Float64Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const diff = x[start + j] - x[start + j + tau]; s += diff * diff; }
      d[tau] = s;
    }
    const cm = new Float64Array(tauMax + 1);
    cm[0] = 1; let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = tauMin; t < tauMax; t++) {
      if (cm[t] < thr) { while (t + 1 < tauMax && cm[t + 1] < cm[t]) t++; tau = t; break; }
    }
    if (tau < 0) return { f0: 0, conf: 0 };
    // parabolic interpolation
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const s0 = cm[tau - 1], s1 = cm[tau], s2 = cm[tau + 1];
      const den = s0 + s2 - 2 * s1;
      if (den !== 0) better = tau + (s0 - s2) / (2 * den);
    }
    return { f0: sr / better, conf: DSP.clamp(1 - cm[tau], 0, 1) };
  };

  /* ---------- Burg LPC ---------- */
  DSP.burgLPC = function (x, order) {
    const N = x.length;
    let f = Float64Array.from(x), b = Float64Array.from(x);
    let a = new Float64Array(order + 1); a[0] = 1;
    let energy = 0;
    for (let i = 0; i < N; i++) energy += x[i] * x[i];
    if (!(energy > 1e-12)) return null;
    for (let m = 1; m <= order; m++) {
      let num = 0, den = 0;
      for (let n = m; n < N; n++) { num += f[n] * b[n - 1]; den += f[n] * f[n] + b[n - 1] * b[n - 1]; }
      if (!(den > 0)) break;
      const k = -2 * num / den;
      const na = new Float64Array(order + 1);
      for (let i = 0; i <= m; i++) na[i] = a[i] + k * (m - i >= 0 ? a[m - i] : 0);
      a = na;
      const nf = new Float64Array(N), nb = new Float64Array(N);
      for (let n = m; n < N; n++) { nf[n] = f[n] + k * b[n - 1]; nb[n] = b[n - 1] + k * f[n]; }
      f = nf; b = nb;
    }
    return a;
  };

  /* ---------- polynomial roots (Durand–Kerner), coefficients a[0..N] with a[0]=1 ---------- */
  DSP.polyRoots = function (a) {
    const N = a.length - 1;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { const ang = TWO_PI * i / N + 0.4, r = 0.9; re[i] = r * Math.cos(ang); im[i] = r * Math.sin(ang); }
    for (let it = 0; it < 80; it++) {
      let maxd = 0;
      for (let i = 0; i < N; i++) {
        // p(z) = z^N + a1 z^(N-1) + ... + aN  (monic)
        let pr = 1, pi = 0;
        for (let k = 1; k <= N; k++) {
          const nr = pr * re[i] - pi * im[i] + a[k], ni = pr * im[i] + pi * re[i];
          pr = nr; pi = ni;
        }
        let dr = 1, di = 0;
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const xr = re[i] - re[j], xi = im[i] - im[j];
          const nr = dr * xr - di * xi, ni = dr * xi + di * xr;
          dr = nr; di = ni;
        }
        const den = dr * dr + di * di || 1e-30;
        const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
        re[i] -= qr; im[i] -= qi;
        maxd = Math.max(maxd, Math.abs(qr) + Math.abs(qi));
      }
      if (maxd < 1e-9) break;
    }
    return { re, im };
  };

  /** formants of one 16 kHz-ish frame; returns array of {f, bw} sorted by f (candidates) */
  DSP.formants = function (x, start, len, sr, order) {
    order = order || DSP.LPC_ORDER;
    const fr = new Float64Array(len), w = DSP.window('hamming', len);
    // pre-emphasis then window
    for (let i = 0; i < len; i++) {
      const cur = x[start + i] || 0, prev = i > 0 ? (x[start + i - 1] || 0) : cur;
      fr[i] = (cur - 0.97 * prev) * w[i];
    }
    const a = DSP.burgLPC(fr, order);
    if (!a) return [];
    const r = DSP.polyRoots(a), out = [];
    for (let i = 0; i < r.re.length; i++) {
      if (r.im[i] <= 0.001) continue;
      const mag = Math.hypot(r.re[i], r.im[i]);
      if (mag >= 1 || mag < 0.5) continue;
      const f = Math.atan2(r.im[i], r.re[i]) * sr / TWO_PI;
      const bw = -Math.log(mag) * sr / Math.PI;
      if (f > 150 && f < sr / 2 - 150 && bw < 450) out.push({ f, bw });
    }
    out.sort((p, q) => p.f - q.f);
    return out;
  };

  /** pick plausible F1–F3 from candidates (null if not plausible) */
  DSP.pickF123 = function (cands) {
    if (cands.length < 3) return null;
    const f = cands.map(c => c.f);
    let F1 = null, F2 = null, F3 = null, i = 0;
    while (i < f.length && f[i] < 180) i++;
    if (i + 2 >= f.length) return null;
    F1 = f[i]; F2 = f[i + 1]; F3 = f[i + 2];
    if (F1 > 1100 || F2 > 3300 || F2 < 500 || F3 < 1600 || F3 > 4600) return null;
    if (F2 - F1 < 150 || F3 - F2 < 150) return null;
    return [F1, F2, F3];
  };

  /* ---------- H1–H2 (dB) ---------- */
  DSP.h1h2 = function (x, start, n, sr, f0) {
    if (!f0) return NaN;
    const spec = DSP.spectrumDb(x, start, n);
    const binHz = sr / n;
    const peak = (f) => {
      const c = Math.round(f / binHz), r = Math.max(1, Math.round(0.08 * f / binHz));
      let m = -1e9;
      for (let k = Math.max(1, c - r); k <= Math.min(n / 2 - 1, c + r); k++) if (spec[k] > m) m = spec[k];
      return m;
    };
    return peak(f0) - peak(2 * f0);
  };

  /* ---------- vocal tract length from F1–F3 (uniform tube) ---------- */
  DSP.vtl = function (F1, F2, F3) {
    const c = 35000; // cm/s
    const L = [c / (4 * F1), 3 * c / (4 * F2), 5 * c / (4 * F3)];
    return (L[0] + L[1] + L[2]) / 3;
  };

  /* ---------- resample to 16 kHz (offline, for decoded files) ---------- */
  DSP.resample = function (x, srIn, srOut) {
    if (srIn === srOut) return Float32Array.from(x);
    let y = x;
    if (srIn > srOut) { // 4th-order Butterworth low-pass at 0.45*srOut
      const fc = 0.45 * srOut;
      y = biquadChain(x, srIn, fc);
    }
    const ratio = srIn / srOut, n = Math.floor((y.length - 1) / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio, k = Math.floor(p), fr = p - k;
      out[i] = y[k] + (y[k + 1] - y[k]) * fr;
    }
    return out;
  };
  function biquadCoef(fs, fc, Q) {
    const w0 = TWO_PI * fc / fs, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Q);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function biquadChain(x, fs, fc) {
    let y = Float32Array.from(x);
    [0.5412, 1.3066].forEach(Q => {
      const [b0, b1, b2, a1, a2] = biquadCoef(fs, fc, Q);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const xi = y[i], yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
      }
    });
    return y;
  }
  DSP.biquadCoef = biquadCoef;

  /* ---------- whole-recording analysis (frame tracks + segments + metrics) ---------- */
  DSP.analyzeRecording = async function (x, sr, onProgress) {
    const hop = Math.round(sr * 0.010), nF = Math.floor((x.length - Math.round(sr * 0.075)) / hop);
    const fLen = Math.round(sr * 0.025), W = Math.round(sr * 0.032);
    const tr = { hop: hop / sr, f0: new Float32Array(nF), conf: new Float32Array(nF), rms: new Float32Array(nF),
      F1: new Float32Array(nF), F2: new Float32Array(nF), F3: new Float32Array(nF), h1h2: new Float32Array(nF) };
    // noise gate from the quietest/loudest frames
    for (let i = 0; i < nF; i++) tr.rms[i] = DSP.rms(x, i * hop, i * hop + fLen);
    const loud = DSP.percentile(tr.rms, 0.95), quiet = DSP.percentile(tr.rms, 0.1);
    const gate = Math.max(0.003, loud * 0.06, Math.min(quiet * 3, loud * 0.3));
    for (let i = 0; i < nF; i++) {
      tr.F1[i] = tr.F2[i] = tr.F3[i] = NaN; tr.h1h2[i] = NaN; tr.f0[i] = 0;
      if (tr.rms[i] > gate) {
        const y = DSP.yin(x, i * hop, sr, { W });
        tr.f0[i] = y.f0; tr.conf[i] = y.conf;
        if (y.f0 && y.conf > 0.8) {
          const c = DSP.formants(x, i * hop + Math.round(sr * 0.01), fLen, sr, DSP.LPC_ORDER);
          const p = DSP.pickF123(c);
          if (p) { tr.F1[i] = p[0]; tr.F2[i] = p[1]; tr.F3[i] = p[2]; }
          tr.h1h2[i] = DSP.h1h2(x, i * hop, 1024, sr, y.f0);
        } else tr.f0[i] = 0;
      }
      if (onProgress && i % 150 === 0) { onProgress(i / nF); await new Promise(r => setTimeout(r, 0)); }
    }
    return DSP.summarize(tr, x, sr);
  };

  DSP.summarize = function (tr, x, sr) {
    const nF = tr.f0.length, dt = tr.hop;
    // clean f0 with a 5-frame median
    const f0s = new Float32Array(nF);
    for (let i = 0; i < nF; i++) {
      const w = []; for (let j = Math.max(0, i - 2); j <= Math.min(nF - 1, i + 2); j++) if (tr.f0[j] > 0) w.push(tr.f0[j]);
      f0s[i] = tr.f0[i] > 0 && w.length >= 3 ? DSP.median(w) : 0;
    }
    tr.f0 = f0s;
    // voiced segments
    const segs = []; let s = -1, gap = 0; const maxGap = Math.round(0.12 / dt);
    for (let i = 0; i < nF; i++) {
      if (f0s[i] > 0) { if (s < 0) s = i; gap = 0; }
      else if (s >= 0 && ++gap > maxGap) { segs.push([s, i - gap]); s = -1; gap = 0; }
    }
    if (s >= 0) segs.push([s, nF - 1 - gap]);
    const out = [];
    for (const [a, b] of segs) {
      if ((b - a + 1) * dt < 0.12) continue;
      const pick = (arr) => { const v = []; for (let i = a; i <= b; i++) if (arr[i] > 0) v.push(arr[i]); return v; };
      const f0v = pick(f0s), f1 = pick(tr.F1), f2 = pick(tr.F2), f3 = pick(tr.F3);
      out.push({ start: a * dt, end: (b + 1) * dt, f0: DSP.median(f0v),
        F1: f1.length >= 3 ? DSP.median(f1) : NaN, F2: f2.length >= 3 ? DSP.median(f2) : NaN,
        F3: f3.length >= 3 ? DSP.median(f3) : NaN });
    }
    const voicedF0 = []; for (let i = 0; i < nF; i++) if (f0s[i] > 0) voicedF0.push(f0s[i]);
    const voicedSec = voicedF0.length * dt;
    const st = voicedF0.map(DSP.hz2st), stMed = DSP.median(st);
    let sd = NaN;
    if (st.length > 5) { let m = 0; st.forEach(v => m += v); m /= st.length; let q = 0; st.forEach(v => q += (v - m) * (v - m)); sd = Math.sqrt(q / st.length); }
    const f1 = [], f2 = [], f3 = [], hh = [];
    for (let i = 0; i < nF; i++) { if (tr.F1[i] > 0) { f1.push(tr.F1[i]); f2.push(tr.F2[i]); f3.push(tr.F3[i]); } if (isFinite(tr.h1h2[i]) && f0s[i] > 0) hh.push(tr.h1h2[i]); }
    const mF1 = DSP.median(f1), mF2 = DSP.median(f2), mF3 = DSP.median(f3);
    // syllable rate: peaks of the smoothed energy envelope inside voiced stretches
    let peaks = 0; const env = new Float32Array(nF);
    for (let i = 0; i < nF; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - 3); j <= Math.min(nF - 1, i + 3); j++) { a += tr.rms[j]; c++; } env[i] = a / c; }
    const thr = DSP.percentile(env, 0.5);
    for (let i = 2; i < nF - 2; i++) if (env[i] > thr && env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > env[i - 2] && env[i] >= env[i + 2] && f0s[i] > 0) { peaks++; i += 8; }
    return {
      track: tr, segments: out, duration: x.length / sr, voicedSeconds: voicedSec,
      f0Median: DSP.median(voicedF0), f0P10: DSP.percentile(voicedF0, 0.1), f0P90: DSP.percentile(voicedF0, 0.9),
      intonationSd: sd, F1: mF1, F2: mF2, F3: mF3, nFormantFrames: f1.length,
      vtl: f1.length >= 10 ? DSP.vtl(mF1, mF2, mF3) : NaN,
      h1h2: hh.length >= 10 ? DSP.median(hh) : NaN,
      syllableRate: voicedSec > 0.5 ? peaks / (nF * dt) : NaN
    };
  };

  /* ---------- acoustic feminization estimate (heuristic, 0..1) ---------- */
  DSP.acousticEstimate = function (m) {
    const c = DSP.clamp, parts = {}; let wsum = 0, acc = 0;
    const add = (k, v, w) => { if (isFinite(v)) { parts[k] = v; acc += v * w; wsum += w; } };
    add('pitch', c((m.f0Median - 100) / 100, 0, 1), 0.4);
    add('resonance', c((17.0 - m.vtl) / 2.5, 0, 1), 0.4);
    add('intonation', c((m.intonationSd - 1.0) / 2.5, 0, 1), 0.1);
    add('weight', c(m.h1h2 / 8, 0, 1), 0.1);
    return { score: wsum > 0 ? acc / wsum : NaN, parts, coverage: wsum };
  };

  root.DSP = DSP;
  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;
})(typeof window !== 'undefined' ? window : globalThis);
