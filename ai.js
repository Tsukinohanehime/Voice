/* ai.js — คะแนน AI ฟังเสียง (Voice Femininity Percentage) ที่รันในเบราว์เซอร์
 * พอร์ตจาก inaSpeechSegmenter (Doukhan และคณะ, Interspeech 2023, MIT) และ VBx (BUT, Apache-2.0)
 *   เสียง 16 kHz -> ฟีเจอร์ log-mel 64 แบนด์ (Kaldi/VBx) -> x-vector ResNet (onnxruntime-web)
 *   -> MLP 4 ชั้น -> สัดส่วนช่วงเวลาที่ถูกจำแนกเป็นเสียงหญิง
 * ตัวตรวจจับเสียงพูดใช้พลังงานเสียง (ไม่ใช่ CNN เดิม) */
(function (root) {
  'use strict';
  const DSP_ = root.DSP || (typeof require !== 'undefined' ? require('./dsp.js') : null);
  const AI = {};
  const SR = 16000, STEP = 24, WINLEN = 144, MIN_WIN = 100, VAD_RATIO = 0.62, NMEL = 64;
  const MODEL_URL = 'models/final.onnx', MLP_URL = 'models/vfp_mlp.bin', CACHE = 'tvl-model-v1';
  const MODEL_BYTES = 60669003;

  /* ---------- ฟีเจอร์ ---------- */
  const mel = x => 1127 * Math.log(1 + x / 700), melInv = x => (Math.exp(x / 1127) - 1) * 700;
  let FB = null, WIN = null;
  function init() {
    if (FB) return;
    const nfft = 512, fs = 16000, nbin = nfft / 2 + 1, fbin = new Float64Array(nbin);
    for (let i = 0; i < nbin; i++) fbin[i] = mel(i * fs / nfft);
    const lo = mel(20), hi = mel(7600), cbin = [];
    for (let i = 0; i < NMEL + 2; i++) cbin.push(lo + (hi - lo) * i / (NMEL + 1));
    const cind = cbin.map(c => Math.floor(melInv(c) / fs * nfft) + 1);
    FB = new Float64Array(nbin * NMEL);
    for (let i = 0; i < NMEL; i++) {
      for (let k = cind[i]; k < Math.min(cind[i + 1], nbin); k++) FB[k * NMEL + i] = (cbin[i] - fbin[k]) / (cbin[i] - cbin[i + 1]);
      for (let k = cind[i + 1]; k < Math.min(cind[i + 2], nbin); k++) FB[k * NMEL + i] = (cbin[i + 2] - fbin[k]) / (cbin[i + 2] - cbin[i + 1]);
    }
    WIN = new Float64Array(400);
    for (let n = 0; n < 400; n++) WIN[n] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * n / 399), 0.85);
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  /** คืน {data: Float32Array[N*64] (เฟรม×มิติ), N} */
  AI.features = function (sig, opt) {
    init();
    const n = sig.length, useDither = !(opt && opt.dither === false), rnd = mulberry32(3), x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.trunc(sig[i] * 32768) + (useDither ? 8 * (rnd() * 2 - 1) : 0);
    const pad = new Float64Array(120 + n + 200);
    for (let i = 0; i < 120; i++) pad[i] = x[119 - i];
    pad.set(x, 120);
    for (let j = 0; j < 200; j++) pad[120 + n + j] = x[n - 1 - j];
    const N = Math.floor((pad.length - 400) / 160) + 1, feat = new Float64Array(N * NMEL);
    const re = new Float64Array(512), im = new Float64Array(512), fr = new Float64Array(400);
    for (let f = 0; f < N; f++) {
      const o = f * 160; let mean = 0;
      for (let i = 0; i < 400; i++) { fr[i] = pad[o + i]; mean += fr[i]; }
      mean /= 400; for (let i = 0; i < 400; i++) fr[i] -= mean;
      re.fill(0); im.fill(0);
      re[0] = (fr[0] - 0.97 * fr[0]) * WIN[0];
      for (let i = 1; i < 400; i++) re[i] = (fr[i] - 0.97 * fr[i - 1]) * WIN[i];
      DSP_.fft(re, im);
      for (let k = 0; k < 257; k++) re[k] = re[k] * re[k] + im[k] * im[k];
      for (let m = 0; m < NMEL; m++) {
        let s = 0; for (let k = 0; k < 257; k++) s += re[k] * FB[k * NMEL + m];
        feat[f * NMEL + m] = Math.log(Math.max(1, s));
      }
    }
    // CMVN แบบ Kaldi (หน้าต่าง 300 เฟรม ลบค่าเฉลี่ยอย่างเดียว)
    const LC = 150, RC = 149, winLen = Math.min(N, LC + RC + 1), out = new Float32Array(N * NMEL);
    const cum = new Float64Array((N + 1) * NMEL);
    for (let i = 0; i < N; i++) for (let m = 0; m < NMEL; m++) cum[(i + 1) * NMEL + m] = cum[i * NMEL + m] + feat[i * NMEL + m];
    for (let i = 0; i < N; i++) {
      const ws = Math.max(Math.min(i - LC, N - winLen), 0);
      for (let m = 0; m < NMEL; m++) out[i * NMEL + m] = feat[i * NMEL + m] - (cum[(ws + winLen) * NMEL + m] - cum[ws * NMEL + m]) / winLen;
    }
    return { data: out, N };
  };

  /* ---------- ตัวตรวจจับเสียงพูด (พลังงาน) ---------- */
  function dilate(a, k) { const c = k >> 1, n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) { for (let d = 0; d < k; d++) { const j = i - d + c; if (j >= 0 && j < n && a[j]) { o[i] = 1; break; } } } return o; }
  function erode(a, k) { const c = k >> 1, n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) { let ok = 1; for (let d = 0; d < k; d++) { const j = i + d - c; if (j < 0 || j >= n || !a[j]) { ok = 0; break; } } o[i] = ok; } return o; }
  AI.energyVad = function (sig) {
    const hop = 160, win = 400;
    if (sig.length < win) return new Uint8Array(0);
    const n = Math.floor((sig.length - win) / hop) + 1, e = new Float64Array(n);
    for (let f = 0; f < n; f++) { let s = 0; for (let i = 0; i < win; i++) { const v = sig[f * hop + i]; s += v * v; } e[f] = 10 * Math.log10(s / win + 1e-10); }
    const peak = DSP_.percentile(e, 0.95), floor = DSP_.percentile(e, 0.1), thr = Math.max(floor + 10, peak - 28);
    let m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = e[i] > thr ? 1 : 0;
    m = erode(dilate(m, 15), 15);   // closing
    m = dilate(erode(m, 10), 10);   // opening
    return m;
  };

  /* ---------- MLP ---------- */
  let MLP = null;
  AI.setMlp = function (buf) {
    const f = new Float32Array(buf), L = []; let o = 0; const take = n => { const a = f.subarray(o, o + n); o += n; return a; };
    const dims = [[256, 512], [512, 512], [512, 512], [512, 512]];
    MLP = { layers: dims.map(([i, j]) => ({ i, j, W: take(i * j), b: take(j), g: take(j), be: take(j), mu: take(j), va: take(j) })), Wo: take(512), bo: take(1)[0] };
  };
  function mlp(x) {
    let h = x;
    for (const L of MLP.layers) {
      const y = new Float32Array(L.j);
      for (let a = 0; a < L.i; a++) { const v = h[a]; if (v === 0) continue; const row = a * L.j; for (let b = 0; b < L.j; b++) y[b] += v * L.W[row + b]; }
      for (let b = 0; b < L.j; b++) { let v = (y[b] + L.b[b] - L.mu[b]) / Math.sqrt(L.va[b] + 1e-3) * L.g[b] + L.be[b]; y[b] = v > 0 ? v : 0; }
      h = y;
    }
    let z = MLP.bo; for (let k = 0; k < 512; k++) z += h[k] * MLP.Wo[k];
    return 1 / (1 + Math.exp(-z));
  }

  /* ---------- วางหน้าต่างและให้คะแนน ---------- */
  const pyRound = x => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };
  function windows(nF) {
    if (nF < MIN_WIN) return [];
    if (nF < WINLEN) return [[0, nF]];
    const w = []; for (let s = 0; s + WINLEN <= nF; s += STEP) w.push([s, s + WINLEN]);
    if (w[w.length - 1][1] < nF && nF - w[w.length - 1][1] >= 10) w.push([nF - WINLEN, nF]);
    return w;
  }
  AI._mlp = mlp;
  /** embed(featChunkTransposed[64*T], T) -> Promise<Float32Array(256)> */
  AI.scoreWith = async function (sig, embed, onProgress) {
    const duration = sig.length / SR, vad = AI.energyVad(sig);
    let sp = 0; for (const v of vad) sp += v; const speechSeconds = sp / 100;
    if (speechSeconds < 1.0) return { ok: false, reason: 'short', duration, speech_seconds: speechSeconds };
    const F = AI.features(sig), nF = Math.min(F.N, vad.length), wins = windows(nF);
    if (!wins.length) return { ok: false, reason: 'short', duration, speech_seconds: speechSeconds };
    const ratios = wins.map(([a, b]) => { let s = 0; for (let i = a; i < b; i++) s += vad[i]; return s / (b - a); });
    const keep = ratios.map(r => r >= VAD_RATIO), need = pyRound(0.5 * wins.length);
    if (keep.filter(Boolean).length < need) { const idx = ratios.map((r, i) => [r, i]).sort((p, q) => q[0] - p[0]).slice(0, need); idx.forEach(([, i]) => keep[i] = true); }
    const sel = wins.map((_, i) => i).filter(i => keep[i]), probs = [], used = [];
    for (let q = 0; q < sel.length; q++) {
      const [a, b] = wins[sel[q]], T = b - a, tr = new Float32Array(NMEL * T);
      for (let t = 0; t < T; t++) for (let m = 0; m < NMEL; m++) tr[m * T + t] = F.data[(a + t) * NMEL + m];
      const emb = await embed(tr, T);
      let bad = false; for (let k = 0; k < emb.length; k++) { emb[k] *= 10; if (!isFinite(emb[k])) bad = true; }
      if (!bad) { probs.push(mlp(emb)); used.push(sel[q]); }
      if (onProgress) onProgress((q + 1) / sel.length);
    }
    if (!used.length) return { ok: false, reason: 'nan', duration, speech_seconds: speechSeconds };
    const cov = new Uint8Array(nF), fem = new Uint8Array(nF);
    used.forEach((wi, k) => { const [a, b] = wins[wi]; for (let i = a; i < b; i++) { cov[i] = 1; if (probs[k] >= 0.5) fem[i] = 1; } });
    let c = 0, f = 0; for (let i = 0; i < nF; i++) { c += cov[i]; f += fem[i]; }
    return { ok: true, score: f / Math.max(c, 1), mean_prob: probs.reduce((a, b) => a + b, 0) / probs.length, n_windows: used.length, duration, speech_seconds: speechSeconds,
      segments: used.map((wi, k) => ({ start: wins[wi][0] / 100, end: wins[wi][1] / 100, p: probs[k] })) };
  };

  /* ---------- โหลดโมเดล + onnxruntime-web (เฉพาะในเบราว์เซอร์) ---------- */
  let session = null, loading = null;
  AI.isReady = () => !!session;
  AI.cached = async () => { try { return !!(await (await caches.open(CACHE)).match(MODEL_URL)); } catch (e) { return false; } };
  AI.load = function (onProgress) {
    if (session) return Promise.resolve(true);
    if (loading) return loading;
    loading = (async () => {
      if (typeof ort === 'undefined') throw new Error('no-ort');
      ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'error';
      let cache = null; try { cache = await caches.open(CACHE); } catch (e) {}
      let resp = cache && await cache.match(MODEL_URL), buf;
      if (resp) { buf = await resp.arrayBuffer(); if (onProgress) onProgress(1); }
      else {
        const r = await fetch(MODEL_URL); if (!r.ok) throw new Error('model-fetch');
        const total = +r.headers.get('content-length') || MODEL_BYTES, reader = r.body.getReader(), parts = []; let got = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; if (onProgress) onProgress(Math.min(1, got / total)); }
        const all = new Uint8Array(got); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } buf = all.buffer;
        if (got < 50e6) throw new Error('model-short');
        if (cache) { try { await cache.put(MODEL_URL, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) {} }
      }
      if (!MLP) AI.setMlp(await (await fetch(MLP_URL)).arrayBuffer());
      session = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return true;
    })().catch(e => { loading = null; throw e; });
    return loading;
  };
  AI.score = function (sig, onProgress) {
    const inName = session.inputNames[0], outName = session.outputNames[0];
    return AI.scoreWith(sig, async (tr, T) => { await new Promise(r => setTimeout(r, 0)); const out = await session.run({ [inName]: new ort.Tensor('float32', tr, [1, NMEL, T]) }); return Float32Array.from(out[outName].data); }, onProgress);
  };

  root.AI = AI;
  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
})(typeof window !== 'undefined' ? window : globalThis);
