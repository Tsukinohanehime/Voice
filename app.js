/* app.js — ห้องฝึกเสียง: ควบคุมไมค์, วาดภาพ, วิเคราะห์เสียงที่อัด, สมุดบันทึก, คลังเสียง */
(() => {
'use strict';
const SR = 16000;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = DSP.clamp;
const fmt0 = v => (isFinite(v) ? Math.round(v).toString() : '—');
const fmt1 = v => (isFinite(v) ? v.toFixed(1) : '—');
const pct = v => (isFinite(v) ? Math.round(v * 100) + '%' : '—');
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const BLUE = '#4a86e8', PINK = '#ea62a4', GREY = '#d9d3e6';

/* สระอ้างอิง [F1, F2] — ค่าเฉลี่ยชาย/หญิง (Peterson & Barney 1952, ภาษาอังกฤษ ใช้เทียบทิศทางเท่านั้น) */
const VOW = {
  i: { th: 'อี', m: [270, 2290], f: [310, 2790] },
  e: { th: 'เอ', m: [530, 1840], f: [610, 2330] },
  a: { th: 'อา', m: [730, 1090], f: [850, 1220] },
  o: { th: 'โอ', m: [570, 840], f: [590, 920] },
  u: { th: 'อู', m: [300, 870], f: [370, 950] },
};

/** ตำแหน่งระหว่างค่าเฉลี่ยชาย (0) → หญิง (1) ของสระ (ปริภูมิล็อก) */
function vowelPos(F1, F2, only) {
  const p = [Math.log(F1), Math.log(F2)];
  let best = null;
  for (const k of only ? [only] : Object.keys(VOW)) {
    const v = VOW[k], m = v.m.map(Math.log), f = v.f.map(Math.log);
    const d = [f[0] - m[0], f[1] - m[1]], L2 = d[0] * d[0] + d[1] * d[1];
    const t = ((p[0] - m[0]) * d[0] + (p[1] - m[1]) * d[1]) / L2, tc = clamp(t, 0, 1);
    const q = [m[0] + d[0] * tc, m[1] + d[1] * tc];
    const dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || dist < best.dist) best = { k, t, dist };
  }
  return best;
}
function lerpColor(t) { // ฟ้า → เทาอ่อน → ชมพู
  t = clamp(t, 0, 1);
  const a = t < 0.5 ? [74, 134, 232] : [217, 211, 230], b = t < 0.5 ? [217, 211, 230] : [234, 98, 164], u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * u)).join(',')})`;
}

/* พาเลตสเปกโตรแกรม */
const LUT = (() => {
  const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), u = x - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * u;
  }
  return out;
})();

/* ---------- สถานะ ---------- */
const st = {
  mic: false, stream: null, ctx: null, node: null,
  ring: new Float32Array(SR * 4), ringW: 0, noise: null,
  recording: false, recChunks: [], recSamples: 0, recStart: 0, recTimer: null,
  f0q: [], fq: [], lastVoicedT: 0, lastFmtT: 0, fmtNow: null, f0Now: 0,
  pitchHist: [], vh: [], fh: [], hh: [], trail: [],
  specRef: -20, paused: false, lastTick: 0, lastEst: 0,
  hit: { since: 0, armed: true, count: 0 },
  rec: null,      // ผลวิเคราะห์ล่าสุด
  ref: null,      // เสียงอ้างอิง
  aiOk: false,
  settings: { lo: 170, hi: 220 },
};

/* ---------- แคนวาส ---------- */
function fit(cv) {
  const d = DPR(), w = Math.round(cv.clientWidth * d), h = Math.round(parseInt(cv.getAttribute('height'), 10) * d);
  if (!w) return false;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; cv._resized = true; } else cv._resized = false;
  return true;
}
const CSSBG = () => getComputedStyle(document.documentElement).getPropertyValue('--cv-bg').trim() || '#12101a';

/* ---------- ไมค์ ---------- */
async function openMic() {
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: $('#optAgc').checked, channelCount: 1 },
    });
    st.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await st.ctx.audioWorklet.addModule('worklet.js');
    const src = st.ctx.createMediaStreamSource(st.stream);
    st.node = new AudioWorkletNode(st.ctx, 'capture16k');
    st.node.port.onmessage = (e) => onChunk(e.data);
    const mute = st.ctx.createGain(); mute.gain.value = 0;
    src.connect(st.node); st.node.connect(mute); mute.connect(st.ctx.destination);
    if (st.ctx.state === 'suspended') await st.ctx.resume();
    st.mic = true; st.ringW = 0; st.noise = null;
    $('#btnMic').textContent = '⏹ ปิดไมค์'; $('#btnRec').disabled = false;
    $('#micMsg').textContent = 'ไมค์เปิดอยู่ พูดได้เลย — ลองลากเสียง “อา” ยาว ๆ ดูค่าด้านบน';
  } catch (err) {
    console.error(err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    $('#micMsg').textContent = denied
      ? 'เบราว์เซอร์ไม่อนุญาตให้ใช้ไมค์ — กดรูปกุญแจข้างช่องที่อยู่เว็บ แล้วอนุญาตไมโครโฟน (ต้องเปิดผ่าน http://localhost)'
      : 'เปิดไมค์ไม่สำเร็จ: ' + (err && err.message ? err.message : err);
  }
}
async function closeMic() {
  if (st.recording) stopRec();
  st.mic = false;
  try { st.stream && st.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { st.node && (st.node.port.onmessage = null, st.node.disconnect()); } catch (e) {}
  try { st.ctx && await st.ctx.close(); } catch (e) {}
  st.stream = st.ctx = st.node = null;
  $('#btnMic').textContent = '🎙 เปิดไมค์'; $('#btnRec').disabled = true;
  $('#micMsg').textContent = 'ปิดไมค์แล้ว';
}
function onChunk(d) {
  const R = st.ring, L = R.length;
  for (let i = 0; i < d.length; i++) R[(st.ringW + i) % L] = d[i];
  st.ringW += d.length;
  if (st.recording) {
    st.recChunks.push(d); st.recSamples += d.length;
    if (st.recSamples >= SR * 180) stopRec();
  }
}
function lastN(n) {
  const out = new Float32Array(n), L = st.ring.length, s = st.ringW - n;
  for (let i = 0; i < n; i++) out[i] = st.ring[(s + i) % L];
  return out;
}

/* ---------- อัดเสียง ---------- */
function startRec() {
  if (!st.mic) return;
  st.recChunks = []; st.recSamples = 0; st.recording = true; st.recStart = performance.now();
  $('#btnRec').textContent = '■ หยุดอัด'; $('#btnRec').classList.add('on');
  st.recTimer = setInterval(() => {
    const s = st.recSamples / SR;
    $('#recTime').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }, 200);
}
function stopRec() {
  if (!st.recording) return;
  st.recording = false; clearInterval(st.recTimer);
  $('#btnRec').textContent = '● เริ่มอัด'; $('#btnRec').classList.remove('on'); $('#recTime').textContent = '';
  const sig = new Float32Array(st.recSamples); let o = 0;
  for (const c of st.recChunks) { sig.set(c, o); o += c.length; }
  st.recChunks = [];
  if (sig.length < SR * 1.5) { $('#micMsg').textContent = 'อัดสั้นเกินไป (ควรอย่างน้อย 3 วินาที ยิ่งยาวยิ่งแม่น)'; return; }
  switchTab('rec');
  analyze(sig, 'อัดเมื่อ ' + new Date().toLocaleTimeString('th-TH'));
}

/* ---------- แท็บ ---------- */
function switchTab(name) {
  $$('.tab').forEach(t => { const on = t.dataset.tab === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
  $$('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
  if (name === 'me') { renderDiary(); renderLib(); }
  if (name === 'rec' && st.rec) { drawRecSpec(); drawRecVowel(); }
  window.scrollTo({ top: 0 });
}

/* ================= วงจรสด ================= */
function loop(ts) {
  requestAnimationFrame(loop);
  if (ts - st.lastTick < 25) return;
  st.lastTick = ts;
  try { if (st.mic && st.ringW >= 2000) tick(performance.now()); drawLive(performance.now()); } catch (e) { console.error(e); }
}
function tick(now) {
  const buf = lastN(1280);
  const rms = DSP.rms(buf, 880, 1280);
  st.noise = st.noise == null ? rms : Math.min(0.02, rms < st.noise ? rms : st.noise + (rms - st.noise) * 0.003);
  const gate = Math.max(0.006, st.noise * 2.5);
  $('#volBar').style.width = Math.round(clamp((20 * Math.log10(rms + 1e-5) + 60) / 50, 0, 1) * 100) + '%';

  let f0 = 0, conf = 0;
  if (rms > gate) { const y = DSP.yin(buf, 1280 - 742, SR, { W: 512 }); f0 = y.f0; conf = y.conf; }
  const voiced = f0 > 0 && conf > 0.8;
  st.f0q.push(voiced ? f0 : 0); if (st.f0q.length > 3) st.f0q.shift();
  const vals = st.f0q.filter(v => v > 0);
  const f0s = voiced && vals.length >= 2 ? DSP.median(vals) : 0;
  st.f0Now = f0s;
  st.pitchHist.push({ t: now, f0: f0s });
  while (st.pitchHist.length && now - st.pitchHist[0].t > 10500) st.pitchHist.shift();

  if (f0s > 0) {
    st.lastVoicedT = now;
    st.vh.push({ t: now, f0: f0s, st: DSP.hz2st(f0s) });
    const p = DSP.pickF123(DSP.formants(buf, 880, 400, SR));
    if (p) {
      st.fq.push(p); if (st.fq.length > 5) st.fq.shift();
      st.lastFmtT = now;
      const m = [0, 1, 2].map(k => DSP.median(st.fq.map(v => v[k])));
      st.fmtNow = m;
      st.fh.push({ t: now, F: m });
      st.trail.push({ t: now, F1: m[0], F2: m[1] }); if (st.trail.length > 30) st.trail.shift();
    }
    const hh = DSP.h1h2(buf, 256, 1024, SR, f0s);
    if (isFinite(hh)) st.hh.push({ t: now, v: hh });
  }
  for (const a of [st.vh, st.fh, st.hh]) while (a.length && now - a[0].t > 8000) a.shift();
  if (now - st.lastVoicedT > 500) { st.fq = []; st.fmtNow = null; }
  if (now - st.lastFmtT > 400) st.fmtNow = null;

  // ช่องแสดงค่า
  $('#roF0').textContent = f0s > 0 ? fmt0(f0s) : '—';
  const fm = st.fmtNow;
  $('#roF1').textContent = fm ? fmt0(fm[0]) : '—';
  $('#roF2').textContent = fm ? fmt0(fm[1]) : '—';
  $('#roF3').textContent = fm ? fmt0(fm[2]) : '—';

  // ในเป้า 10 วินาที
  const lo = st.settings.lo, hi = st.settings.hi;
  const vv = st.pitchHist.filter(p => p.f0 > 0);
  $('#inTarget').textContent = vv.length > 10 ? Math.round(100 * vv.filter(p => p.f0 >= lo && p.f0 <= hi).length / vv.length) + '%' : '—';

  // สเปกโตรแกรม
  if (!st.paused) specColumn(buf, f0s, fm);

  // ฝึกสระ
  hitUpdate(now);

  // ประมาณการสด
  if (now - st.lastEst > 500) {
    st.lastEst = now;
    const f0v = st.vh.map(v => v.f0), sts = st.vh.map(v => v.st);
    let sd = NaN;
    if (sts.length > 25) { const m = sts.reduce((a, b) => a + b, 0) / sts.length; sd = Math.sqrt(sts.reduce((a, b) => a + (b - m) * (b - m), 0) / sts.length); }
    let vtl = NaN;
    if (st.fh.length >= 10) vtl = DSP.vtl(...[0, 1, 2].map(k => DSP.median(st.fh.map(v => v.F[k]))));
    const est = DSP.acousticEstimate({
      f0Median: f0v.length > 15 ? DSP.median(f0v) : NaN, vtl, intonationSd: sd,
      h1h2: st.hh.length >= 10 ? DSP.median(st.hh.map(v => v.v)) : NaN,
    });
    showEstimate(est, $('#liveGaugeDot'), $('#liveVerdict'), $('#liveParts'));
  }
}

function showEstimate(est, dot, verdict, parts) {
  $$('b[data-p]', parts).forEach(b => { const v = est.parts[b.dataset.p]; b.textContent = v === undefined ? '—' : pct(v); });
  if (!isFinite(est.score) || est.coverage < 0.4) { dot.classList.remove('on'); verdict.textContent = verdict.id === 'liveVerdict' ? 'พูดต่อเนื่องสัก 3–4 ประโยค แล้วค่าจะขึ้น' : 'วัดค่าได้ไม่พอ (เสียงสั้นหรือเบาเกินไป)'; return; }
  dot.classList.add('on'); dot.style.left = (est.score * 100).toFixed(1) + '%';
  const s = est.score;
  verdict.textContent = (s < 0.3 ? 'ตอนนี้ยังอยู่ฝั่งเสียงทุ้ม' : s < 0.45 ? 'ค่อนไปทางเสียงทุ้ม' : s < 0.6 ? 'อยู่ช่วงกลาง ๆ' : s < 0.75 ? 'ค่อนไปทางเสียงสว่าง' : 'อยู่ฝั่งเสียงสูง/สว่างชัดเจน') + ' (' + Math.round(s * 100) + '%)';
  verdict.textContent += est.coverage < 0.99 ? ' · ยังมีบางค่าที่วัดไม่ได้' : '';
}

/* ---------- วาดภาพสด ---------- */
const spec = { cv: null, ctx: null };
function specColumn(buf, f0, fm) {
  const cv = $('#cvSpec');
  if (!fit(cv)) return;
  const c = cv.getContext('2d');
  if (cv._resized) { c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height); }
  const maxHz = +$('#specRange').value, range = +$('#specContrast').value;
  const n = 512, db = DSP.spectrumDb(buf, 1280 - n, n);
  const maxBin = Math.round(maxHz / (SR / n));
  let mx = -1e9; for (let k = 1; k < maxBin; k++) if (db[k] > mx) mx = db[k];
  st.specRef = Math.max(mx, st.specRef - 0.03);
  const colPx = Math.max(2, Math.round(cv.width / 420)), H = cv.height;
  c.drawImage(cv, -colPx, 0);
  const img = c.createImageData(colPx, H), d = img.data;
  for (let y = 0; y < H; y++) {
    const bin = clamp(Math.floor((1 - y / H) * maxBin), 1, maxBin - 1);
    const v = clamp((db[bin] - (st.specRef - range)) / range, 0, 1), li = Math.round(v * 255) * 3;
    for (let x = 0; x < colPx; x++) { const o = (y * colPx + x) * 4; d[o] = LUT[li]; d[o + 1] = LUT[li + 1]; d[o + 2] = LUT[li + 2]; d[o + 3] = 255; }
  }
  if ($('#specOverlay').checked) {
    const dot = (hz, rgb) => {
      if (!(hz > 0) || hz > maxHz) return; const y = Math.round((1 - hz / maxHz) * H), r = Math.max(2, Math.round(H / 120));
      for (let yy = y - r; yy <= y + r; yy++) { if (yy < 0 || yy >= H) continue; for (let x = 0; x < colPx; x++) { const o = (yy * colPx + x) * 4; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; } }
    };
    dot(f0, [255, 105, 180]); if (fm) fm.forEach(v => dot(v, [90, 190, 255]));
  }
  c.putImageData(img, cv.width - colPx, 0);
}
function drawLive(now) {
  drawPitch(now); drawVowelLive();
}
function drawPitch(now) {
  const cv = $('#cvPitch'); if (!fit(cv)) return;
  const c = cv.getContext('2d'), W = cv.width, H = cv.height, d = DPR();
  c.fillStyle = CSSBG(); c.fillRect(0, 0, W, H);
  const fmin = 70, fmax = 350, Y = f => H * (1 - (Math.log(f) - Math.log(fmin)) / (Math.log(fmax) - Math.log(fmin)));
  const band = (a, b, col) => { c.fillStyle = col; c.fillRect(0, Y(b), W, Y(a) - Y(b)); };
  band(80, 155, 'rgba(74,134,232,.22)'); band(155, 185, 'rgba(200,200,215,.18)'); band(185, 300, 'rgba(234,98,164,.22)');
  c.font = (11 * d) + 'px sans-serif'; c.fillStyle = 'rgba(255,255,255,.55)'; c.textBaseline = 'middle';
  [100, 150, 200, 250, 300].forEach(f => { c.fillText(f, 4 * d, Y(f)); c.fillRect(30 * d, Y(f), W, 0.5 * d); });
  const lo = st.settings.lo, hi = st.settings.hi;
  c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 1.5 * d; c.setLineDash([6 * d, 4 * d]);
  c.strokeRect(1, Y(hi), W - 2, Y(lo) - Y(hi)); c.setLineDash([]);
  const T = 10000, X = t => W * (1 - (now - t) / T);
  c.lineWidth = 3 * d; c.lineCap = 'round'; c.strokeStyle = '#fff'; c.beginPath();
  let pen = false;
  for (const p of st.pitchHist) {
    if (p.f0 > 0 && p.f0 >= fmin && p.f0 <= fmax) { const x = X(p.t), y = Y(p.f0); pen ? c.lineTo(x, y) : c.moveTo(x, y); pen = true; } else pen = false;
  }
  c.stroke();
}

/* แผนภูมิสระ */
function vowelBox(cv, pad) { return { x0: pad.l, y0: pad.t, w: cv.width - pad.l - pad.r, h: cv.height - pad.t - pad.b }; }
function vowelXY(b, F1, F2) { return [b.x0 + (3000 - clamp(F2, 500, 3000)) / 2500 * b.w, b.y0 + (clamp(F1, 200, 1000) - 200) / 800 * b.h]; }
function drawVowelBase(cv, targetKey) {
  const c = cv.getContext('2d'), d = DPR(), W = cv.width, H = cv.height;
  const pad = { l: 34 * d, r: 10 * d, t: 12 * d, b: 26 * d }, b = vowelBox(cv, pad);
  c.fillStyle = CSSBG(); c.fillRect(0, 0, W, H);
  c.font = (11 * d) + 'px sans-serif'; c.fillStyle = 'rgba(255,255,255,.5)'; c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
  c.textAlign = 'center'; c.textBaseline = 'top';
  [3000, 2500, 2000, 1500, 1000, 500].forEach(f => { const [x] = vowelXY(b, 200, f); c.beginPath(); c.moveTo(x, b.y0); c.lineTo(x, b.y0 + b.h); c.stroke(); c.fillText(f, x, b.y0 + b.h + 4 * d); });
  c.textAlign = 'right'; c.textBaseline = 'middle';
  [300, 500, 700, 900].forEach(f => { const [, y] = vowelXY(b, f, 500); c.beginPath(); c.moveTo(b.x0, y); c.lineTo(b.x0 + b.w, y); c.stroke(); c.fillText(f, b.x0 - 4 * d, y); });
  c.textAlign = 'left'; c.fillText('F1 ↓ · F2 ←', b.x0 + 6 * d, b.y0 + 10 * d);
  for (const k of Object.keys(VOW)) {
    const v = VOW[k], [mx, my] = vowelXY(b, ...v.m), [fx, fy] = vowelXY(b, ...v.f);
    c.strokeStyle = 'rgba(255,255,255,.28)'; c.beginPath(); c.moveTo(mx, my); c.lineTo(fx, fy); c.stroke();
    c.fillStyle = BLUE; c.beginPath(); c.arc(mx, my, 4 * d, 0, 7); c.fill();
    c.fillStyle = PINK; c.beginPath(); c.arc(fx, fy, 4 * d, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.font = (13 * d) + 'px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'bottom'; c.fillText(v.th, (mx + fx) / 2, Math.min(my, fy) - 5 * d);
    c.font = (11 * d) + 'px sans-serif';
    if (k === targetKey) { c.strokeStyle = '#fff'; c.lineWidth = 2 * d; c.beginPath(); c.arc(fx, fy, 11 * d, 0, 7); c.stroke(); c.lineWidth = 1; }
  }
  return b;
}
function drawVowelLive() {
  const cv = $('#cvVowel'); if (!fit(cv)) return;
  const c = cv.getContext('2d'), d = DPR(), b = drawVowelBase(cv, $('#hitVowel').value);
  const now = performance.now();
  st.trail.forEach(p => {
    const age = now - p.t; if (age > 2500) return; const [x, y] = vowelXY(b, p.F1, p.F2);
    c.fillStyle = `rgba(255,255,255,${0.7 * (1 - age / 2500)})`; c.beginPath(); c.arc(x, y, 4 * d, 0, 7); c.fill();
  });
  if (st.fmtNow) { const [x, y] = vowelXY(b, st.fmtNow[0], st.fmtNow[1]); c.fillStyle = '#ffe14d'; c.strokeStyle = '#000'; c.lineWidth = 1.5 * d; c.beginPath(); c.arc(x, y, 7 * d, 0, 7); c.fill(); c.stroke(); }
}

/* ---------- ฝึกสระ ---------- */
function hitUpdate(now) {
  const needle = $('#hitNeedle'), key = $('#hitVowel').value, h = st.hit;
  if (!st.fmtNow) { needle.classList.remove('on'); h.since = 0; return; }
  const p = vowelPos(st.fmtNow[0], st.fmtNow[1], key), t = p.t;
  needle.classList.add('on'); needle.style.left = clamp((t + 0.25) / 1.5, 0, 1) * 100 + '%';
  if (t > 0.5) {
    if (!h.since) h.since = now;
    if (h.armed && now - h.since > 500) { h.count++; h.armed = false; $('#hitCount').textContent = h.count; }
    $('#hitHint').textContent = 'ดีมาก! อยู่ฝั่งหญิงแล้ว ลองรักษาไว้';
  } else {
    h.since = 0; if (t < 0.4) h.armed = true;
    $('#hitHint').textContent = 'ปรับเสียงก้อง (ยกลิ้นไปข้างหน้า ยิ้มเบา ๆ) ให้เข็มขยับไปทางชมพู';
  }
}

/* ================= วิเคราะห์เสียงที่อัด ================= */
const rs = { dbMat: null, nCols: 0, bins: 0, hopS: 0.01, sel: null };

async function analyze(sig, label) {
  const token = (st.rec = { sig, label, token: Math.random() }).token; rs.sel = null; rs.dbMat = null;
  $('#results').hidden = false;
  $('#progressWrap').hidden = false; $('#progressBar').style.width = '0%';
  $('#recStatus').textContent = 'กำลังวิเคราะห์ … ' + label + ' (' + fmt1(sig.length / SR) + ' วินาที)';
  ['#btnPlayRec', '#btnSaveRec'].forEach(s => $(s).disabled = true);
  $('#aiDot').classList.remove('on'); $('#aiVerdict').textContent = 'AI กำลังฟัง …';
  const sum = await DSP.analyzeRecording(sig, SR, p => { $('#progressBar').style.width = Math.round(p * 100) + '%'; });
  if (st.rec.token !== token) return;
  st.rec.sum = sum; st.rec.est = DSP.acousticEstimate(sum);
  $('#progressWrap').hidden = true;
  $('#recStatus').textContent = label + ' · ยาว ' + fmt1(sig.length / SR) + ' วินาที · มีเสียงพูด ' + fmt1(sum.voicedSeconds) + ' วินาที';
  ['#btnPlayRec', '#btnSaveRec'].forEach(s => $(s).disabled = false);
  computeSpecMatrix(sig);
  renderRecResults();
  scoreAI(sig, token);
}

function renderRecResults() {
  const { sum, est } = st.rec;
  showEstimate(est, $('#acDot'), $('#acVerdict'), $('#recParts'));
  const M = (label, val, unit) => `<div class="metric"><small>${label}</small><b>${val}</b>${unit ? `<em>${unit}</em>` : ''}</div>`;
  $('#metrics').innerHTML =
    M('ระดับเสียงกลาง (median)', fmt0(sum.f0Median), 'Hz') +
    M('ช่วงระดับเสียง (10–90%)', fmt0(sum.f0P10) + '–' + fmt0(sum.f0P90), 'Hz') +
    M('ท่วงทำนอง (SD)', fmt1(sum.intonationSd), 'semitone') +
    M('ความยาวช่องเสียงเทียบเท่า', fmt1(sum.vtl), 'cm') +
    M('F1 / F2 / F3 กลาง', fmt0(sum.F1) + ' / ' + fmt0(sum.F2) + ' / ' + fmt0(sum.F3), 'Hz') +
    M('H1–H2 (ความโปร่งเบา)', fmt1(sum.h1h2), 'dB') +
    M('จังหวะพูด (ประมาณ)', fmt1(sum.syllableRate), 'พยางค์/วิ') +
    M('เวลามีเสียงพูด', fmt1(sum.voicedSeconds), 'วินาที');
  drawRecSpec(); drawRecVowel(); renderSegGrid(); renderCoach(); renderCompare();
}

/* ---- AI (รันในเบราว์เซอร์) ---- */
const AI_MSG = {
  short: 'มีเสียงพูดสั้นเกินไปสำหรับ AI (ควรมีเสียงพูดอย่างน้อย 3–5 วินาที)',
  nan: 'AI ประมวลผลเสียงนี้ไม่ได้ ลองอัดใหม่',
  load: 'โหลดโมเดล AI ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วกดปุ่มอีกครั้ง',
};
function setAiChip(text, cls) { const c = $('#aiChip'); c.textContent = text; c.classList.remove('good', 'bad'); if (cls) c.classList.add(cls); }
async function refreshAiChip() {
  if (AI.isReady()) return setAiChip('AI: พร้อม (ทำงานในเครื่อง)', 'good');
  if (await AI.cached()) return setAiChip('AI: พร้อม (โมเดลเก็บไว้ในเครื่องแล้ว)', 'good');
  setAiChip('AI: ยังไม่ได้ดาวน์โหลดโมเดล (58 MB ครั้งเดียว)');
}
function showAI(res) {
  const verdict = $('#aiVerdict'), dot = $('#aiDot');
  if (res.ok) {
    dot.classList.add('on'); dot.style.left = (res.score * 100).toFixed(1) + '%';
    const s = res.score;
    verdict.textContent = (s >= 0.8 ? 'ส่วนใหญ่ฟังเป็นเสียงหญิง' : s >= 0.55 ? 'ค่อนไปทางเสียงหญิง' : s >= 0.35 ? 'กลาง ๆ — AI ลังเลระหว่างสองฝั่ง' : s >= 0.15 ? 'ค่อนไปทางเสียงชาย' : 'ส่วนใหญ่ยังฟังเป็นเสียงชาย')
      + ` · ${Math.round(s * 100)}% ของช่วงเสียง (${res.n_windows} ช่วง, ความมั่นใจเฉลี่ย ${Math.round(res.mean_prob * 100)}%)`;
  } else { dot.classList.remove('on'); verdict.textContent = AI_MSG[res.reason] || AI_MSG.short; }
}
async function runAI(token) {
  const r = st.rec, verdict = $('#aiVerdict'), btn = $('#btnAi'); btn.hidden = true;
  let res;
  try {
    if (!AI.isReady()) {
      const cached = await AI.cached();
      verdict.textContent = cached ? 'กำลังเปิดโมเดล AI …' : 'กำลังดาวน์โหลดโมเดล AI … 0%';
      setAiChip(cached ? 'AI: กำลังเปิดโมเดล …' : 'AI: กำลังดาวน์โหลด …');
      await AI.load(p => { if (!cached) { verdict.textContent = 'กำลังดาวน์โหลดโมเดล AI … ' + Math.round(p * 100) + '%'; setAiChip('AI: ดาวน์โหลด ' + Math.round(p * 100) + '%'); } });
    }
    await refreshAiChip();
    verdict.textContent = 'AI กำลังฟัง … 0%';
    res = await AI.score(r.sig, p => { if (st.rec && st.rec.token === token) verdict.textContent = 'AI กำลังฟัง … ' + Math.round(p * 100) + '%'; });
  } catch (e) {
    console.error(e); res = { ok: false, reason: 'load' }; btn.hidden = false; btn.textContent = 'ลองอีกครั้ง'; await refreshAiChip();
  }
  if (!st.rec || st.rec.token !== token) return;
  st.rec.ai = res; showAI(res); renderCoach(); renderCompare(); drawRecSpec(); autoDiary();
}
async function scoreAI(sig, token) {
  const btn = $('#btnAi'); btn.hidden = true;
  if (AI.isReady() || await AI.cached()) return runAI(token);
  // ยังไม่มีโมเดล: ให้ผู้ใช้เลือกเอง (ไม่ดึงข้อมูลมือถือโดยไม่ถาม)
  $('#aiDot').classList.remove('on');
  $('#aiVerdict').textContent = 'ยังไม่ได้ดาวน์โหลดโมเดล AI (58 MB ดาวน์โหลดครั้งเดียว ใช้ออฟไลน์ได้หลังจากนั้น)';
  btn.hidden = false; btn.textContent = 'ดาวน์โหลดโมเดลและให้ AI ฟัง';
  autoDiary();
}

/* ---- สเปกโตรแกรมของเสียงที่อัด ---- */
function computeSpecMatrix(sig) {
  const n = 512, bins = Math.round(5500 / (SR / n));
  const hop = Math.max(160, Math.ceil((sig.length - n) / 4000));
  const nCols = Math.max(1, Math.floor((sig.length - n) / hop) + 1);
  const mat = new Float32Array(nCols * bins), tmp = new Float32Array(n / 2);
  for (let i = 0; i < nCols; i++) { DSP.spectrumDb(sig, i * hop, n, tmp); mat.set(tmp.subarray(0, bins), i * bins); }
  let mx = -1e9; for (let i = 0; i < mat.length; i++) if (mat[i] > mx) mx = mat[i];
  Object.assign(rs, { dbMat: mat, nCols, bins, hopS: hop / SR, mx, off: null, offRange: null, n });
}
function drawRecSpec() {
  const cv = $('#cvRec'); if (!st.rec || !rs.dbMat || !fit(cv)) return;
  const c = cv.getContext('2d'), d = DPR(), W = cv.width, H = cv.height, stripH = Math.round(16 * d), Hs = H - stripH;
  const range = +$('#recContrast').value;
  if (!rs.off || rs.offRange !== range) {
    const off = document.createElement('canvas'); off.width = rs.nCols; off.height = rs.bins;
    const oc = off.getContext('2d'), img = oc.createImageData(rs.nCols, rs.bins), dd = img.data;
    for (let x = 0; x < rs.nCols; x++) for (let b = 0; b < rs.bins; b++) {
      const v = clamp((rs.dbMat[x * rs.bins + b] - (rs.mx - range)) / range, 0, 1), li = Math.round(v * 255) * 3, o = ((rs.bins - 1 - b) * rs.nCols + x) * 4;
      dd[o] = LUT[li]; dd[o + 1] = LUT[li + 1]; dd[o + 2] = LUT[li + 2]; dd[o + 3] = 255;
    }
    oc.putImageData(img, 0, 0); rs.off = off; rs.offRange = range;
  }
  c.fillStyle = CSSBG(); c.fillRect(0, 0, W, H);
  c.imageSmoothingEnabled = true; c.drawImage(rs.off, 0, 0, W, Hs);
  const dur = st.rec.sig.length / SR, X = t => t / dur * W, Y = f => (1 - f / 5500) * Hs;
  const { track } = st.rec.sum;
  if ($('#recOverlay').checked) {
    const r = Math.max(1.5 * d, 1), step = Math.max(1, Math.floor(track.f0.length / 1500));
    for (let i = 0; i < track.f0.length; i += step) {
      const x = X(i * track.hop);
      if (track.f0[i] > 0 && track.f0[i] < 5500) { c.fillStyle = '#ff69b4'; c.fillRect(x, Y(track.f0[i]) - r, r * 2, r * 2); }
      if (track.F1[i] > 0) { c.fillStyle = '#5abeff'; [track.F1[i], track.F2[i], track.F3[i]].forEach(f => c.fillRect(x, Y(f) - r, r * 2, r * 2)); }
    }
  }
  if (rs.sel) { c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(X(rs.sel[0]), 0, X(rs.sel[1]) - X(rs.sel[0]), Hs); c.strokeStyle = '#fff'; c.lineWidth = d; c.strokeRect(X(rs.sel[0]), 0, X(rs.sel[1]) - X(rs.sel[0]), Hs); }
  // แกนเวลา
  c.font = (11 * d) + 'px sans-serif'; c.fillStyle = 'rgba(255,255,255,.75)'; c.textAlign = 'left'; c.textBaseline = 'top';
  const tick = dur > 60 ? 10 : dur > 25 ? 5 : dur > 10 ? 2 : 1;
  for (let t = 0; t <= dur; t += tick) { c.fillRect(X(t), 0, d, 6 * d); c.fillText(t + ' s', X(t) + 3 * d, 2 * d); }
  [1000, 2000, 3000, 4000, 5000].forEach(f => { c.fillStyle = 'rgba(255,255,255,.3)'; c.fillRect(0, Y(f), 5 * d, d); c.fillText((f / 1000) + 'k', 7 * d, Y(f) - 5 * d); });
  // แถบ AI
  const ai = st.rec.ai;
  c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(0, Hs, W, stripH);
  if (ai && ai.ok) ai.segments.forEach(s => { c.globalAlpha = 0.85; c.fillStyle = lerpColor(s.p); c.fillRect(X(s.start), Hs + 2 * d, Math.max(1, X(s.end) - X(s.start)), stripH - 4 * d); }), c.globalAlpha = 1;
}
function playSlice(sig, a, b) {
  const ctx = playSlice.ctx || (playSlice.ctx = new (window.AudioContext || window.webkitAudioContext)());
  ctx.resume();
  const i0 = Math.max(0, Math.floor(a * SR)), i1 = Math.min(sig.length, Math.ceil(b * SR));
  if (i1 - i0 < 100) return;
  const buf = ctx.createBuffer(1, i1 - i0, SR); buf.getChannelData(0).set(sig.subarray(i0, i1));
  if (playSlice.src) try { playSlice.src.stop(); } catch (e) {}
  const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); s.start(); playSlice.src = s;
}
function drawRecVowel() {
  const cv = $('#cvVowelRec'); if (!st.rec || !st.rec.sum || !fit(cv)) return;
  const c = cv.getContext('2d'), d = DPR(), b = drawVowelBase(cv, null), { track, segments } = st.rec.sum;
  c.fillStyle = 'rgba(255,255,255,.25)';
  for (let i = 0; i < track.F1.length; i += 2) if (track.F1[i] > 0) { const [x, y] = vowelXY(b, track.F1[i], track.F2[i]); c.fillRect(x - d, y - d, 2 * d, 2 * d); }
  segments.forEach(s => {
    if (!(s.F1 > 0 && s.F2 > 0)) return; const p = vowelPos(s.F1, s.F2), [x, y] = vowelXY(b, s.F1, s.F2);
    c.fillStyle = lerpColor(p.t); c.strokeStyle = '#000'; c.lineWidth = d; c.beginPath(); c.arc(x, y, 5 * d, 0, 7); c.fill(); c.stroke();
  });
  const m = st.rec.sum;
  if (m.F1 > 0) { const [x, y] = vowelXY(b, m.F1, m.F2); c.fillStyle = '#ffe14d'; c.strokeStyle = '#000'; c.beginPath(); c.arc(x, y, 8 * d, 0, 7); c.fill(); c.stroke(); }
}
function renderSegGrid() {
  const g = $('#segGrid'), { segments } = st.rec.sum;
  if (!segments.length) { g.innerHTML = '<p class="hint">ไม่พบช่วงที่ออกเสียงชัดพอ</p>'; return; }
  g.innerHTML = '';
  segments.forEach((s, i) => {
    const has = s.F1 > 0 && s.F2 > 0, p = has ? vowelPos(s.F1, s.F2) : null;
    const el = document.createElement('button'); el.className = 'seg';
    el.style.borderLeftColor = p ? lerpColor(p.t) : 'var(--line)';
    el.title = 'กดเพื่อฟังช่วงนี้';
    el.innerHTML = `<b>${s.start.toFixed(1)}–${s.end.toFixed(1)} s</b><small>F0 ${fmt0(s.f0)} Hz</small><small>${has ? `F1 ${fmt0(s.F1)} · F2 ${fmt0(s.F2)}` : 'วัด formant ไม่ได้'}</small>${p ? `<small>ใกล้ “${VOW[p.k].th}” · ${Math.round(clamp(p.t, 0, 1) * 100)}% ทางหญิง</small>` : ''}`;
    el.onclick = () => { rs.sel = [s.start, s.end]; playSlice(st.rec.sig, s.start - 0.05, s.end + 0.05); drawRecSpec(); };
    g.appendChild(el);
  });
}

/* ---- ข้อแนะนำ ---- */
function renderCoach() {
  const el = $('#coach'), { sum, est, ai } = st.rec, tips = [];
  const lo = st.settings.lo, hi = st.settings.hi;
  if (!isFinite(sum.f0Median) || sum.voicedSeconds < 2) { el.innerHTML = '<p class="hint">เสียงพูดสั้นไป ลองอัดให้ยาวขึ้น (10–30 วินาที) จะได้ข้อแนะนำที่แม่นกว่า</p>'; return; }
  const P = est.parts;
  const names = { pitch: 'ระดับเสียง', resonance: 'เสียงก้อง', intonation: 'ท่วงทำนอง' };
  const weakest = Object.keys(names).filter(k => P[k] !== undefined).sort((a, b) => P[a] - P[b])[0];
  if (sum.f0Median < lo) tips.push(['ระดับเสียงต่ำกว่าเป้าหมายเล็กน้อย', `ค่ากลางตอนนี้ ${fmt0(sum.f0Median)} Hz เป้าหมายคือ ${lo}–${hi} Hz ลองเริ่มประโยคจากโน้ตที่สูงขึ้นนิดเดียว ไม่ต้องบีบคอ ถ้าตึงให้กลับมาที่ระดับสบายก่อน`]);
  else if (sum.f0Median > hi + 25) tips.push(['ระดับเสียงสูงกว่าเป้าหมายพอสมควร', `ค่ากลาง ${fmt0(sum.f0Median)} Hz ถ้ารู้สึกตึงหรือเหนื่อย ลดลงมาที่ระดับสบายก่อน เสียงที่ผ่อนคลายสำคัญกว่าเสียงสูง`]);
  else tips.push(['ระดับเสียงอยู่ในเป้าหมาย', `ค่ากลาง ${fmt0(sum.f0Median)} Hz (เป้า ${lo}–${hi} Hz) ทำได้ดี รักษาความผ่อนคลายไว้`]);
  if (weakest === 'resonance' && isFinite(sum.vtl)) tips.push(['จุดที่ปรับได้มากที่สุด: เสียงก้อง', `ความยาวช่องเสียงเทียบเท่า ≈ ${fmt1(sum.vtl)} cm (ยิ่งสั้นเสียงยิ่งสว่าง) ลองยิ้มบาง ๆ ให้มุมปากยืดออกข้าง ๆ ดันลิ้นไปข้างหน้าเล็กน้อย และอย่ากดกล่องเสียงลงต่ำ แล้วดูจุดบนแผนภูมิสระว่าขยับไปทางซ้ายบนหรือไม่`, 'blue']);
  if (weakest === 'intonation') tips.push(['จุดที่ปรับได้มากที่สุด: ท่วงทำนอง', `ความผันของระดับเสียง ≈ ${fmt1(sum.intonationSd)} semitone ภาษาไทยมีวรรณยุกต์อยู่แล้ว ไม่ต้องเล่นเสียงขึ้นลงเยอะ ให้ลองเน้นจังหวะ ยืดสระ และลงท้าย “คะ/นะคะ” ให้เบาและโปร่งขึ้น`, 'blue']);
  if (weakest === 'pitch' && sum.f0Median >= lo) tips.push(['จุดที่ปรับได้มากที่สุด: ระดับเสียง', 'ลองแตะระดับเสียงเป้าหมายตอนต้นประโยคให้สม่ำเสมอ ดูกราฟระดับเสียงในแท็บ “ฝึกสด”', 'blue']);
  if (ai && ai.ok && est.score >= 0.6 && ai.score < 0.35) tips.push(['AI กับตัวเลขอะคูสติกไม่ตรงกัน', 'ตัวเลขดูดี แต่ AI ยังฟังเป็นเสียงทุ้ม แปลว่าอาจขาดคุณภาพเสียงบางอย่างที่ตัวเลขจับไม่ได้ ลองอัดใหม่ในห้องเงียบ ๆ และเทียบกับเสียงอ้างอิง', 'blue']);
  if (sum.nFormantFrames < 15) tips.push(['วัด formant ได้น้อย', 'อาจเพราะเสียงเบา มีเสียงรบกวน หรือเสียงสูงมากจนจับยาก ลองอัดใหม่โดยพูดดังพอและอยู่ห่างไมค์ประมาณหนึ่งฝ่ามือ', 'blue']);
  el.innerHTML = tips.map(([h, t, c]) => `<div class="tip ${c || ''}"><b>${h}</b>${t}</div>`).join('') + '<p class="fine">ข้อแนะนำเป็นแนวทางทั่วไป ถ้าเจ็บคอหรือเสียงแหบ ให้หยุดและปรึกษาผู้เชี่ยวชาญ</p>';
}

/* ---- เทียบเสียงอ้างอิง ---- */
function summaryOf(r) {
  const s = r.sum;
  return { ai: r.ai && r.ai.ok ? r.ai.score : NaN, acoustic: r.est.score, f0: s.f0Median, p10: s.f0P10, p90: s.f0P90, sd: s.intonationSd, vtl: s.vtl, F1: s.F1, F2: s.F2, F3: s.F3, h1h2: s.h1h2, rate: s.syllableRate, voiced: s.voicedSeconds };
}
function renderCompare() {
  const t = $('#cmpTable'); if (!st.rec || !st.rec.sum) return;
  const a = summaryOf(st.rec), b = st.ref && st.ref.summary;
  const rows = [
    ['AI ฟังเสียง', 'ai', pct, 1], ['ประมาณการอะคูสติก', 'acoustic', pct, 1], ['ระดับเสียงกลาง (Hz)', 'f0', fmt0, 1],
    ['ช่วงระดับเสียง 10% (Hz)', 'p10', fmt0], ['ช่วงระดับเสียง 90% (Hz)', 'p90', fmt0], ['ท่วงทำนอง SD (st)', 'sd', fmt1, 1],
    ['ความยาวช่องเสียง (cm)', 'vtl', fmt1, -1], ['F1 (Hz)', 'F1', fmt0], ['F2 (Hz)', 'F2', fmt0, 1], ['F3 (Hz)', 'F3', fmt0, 1],
    ['H1–H2 (dB)', 'h1h2', fmt1], ['จังหวะพูด (พยางค์/วิ)', 'rate', fmt1], ['เวลามีเสียงพูด (วิ)', 'voiced', fmt1],
  ];
  t.innerHTML = '<tr><th>ตัวชี้วัด</th><th class="num">เสียงนี้</th><th class="num">เสียงอ้างอิง</th><th class="num">ต่าง</th></tr>' + rows.map(([n, k, f, dir]) => {
    let diff = '';
    if (b && isFinite(a[k]) && isFinite(b[k])) {
      const dv = a[k] - b[k], good = dir ? dv * dir > 0 : null, txt = (k === 'ai' || k === 'acoustic') ? (dv >= 0 ? '+' : '') + Math.round(dv * 100) + ' จุด' : (dv >= 0 ? '+' : '') + f(dv);
      diff = `<span class="${good === null ? '' : good ? 'good' : 'bad'}">${txt}</span>`;
    }
    return `<tr><td>${n}</td><td class="num">${f(a[k])}</td><td class="num">${b ? f(b[k]) : '—'}</td><td class="num">${diff}</td></tr>`;
  }).join('');
}

/* ================= WAV / ไฟล์ ================= */
function toWav(sig) {
  const n = sig.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, clamp(sig[i], -1, 1) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}
async function fromWav(blob) {
  const ab = await blob.arrayBuffer(), i16 = new Int16Array(ab, 44, (ab.byteLength - 44) >> 1), out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}
async function loadFile(file) {
  $('#recStatus').textContent = 'กำลังอ่านไฟล์ …'; switchTab('rec');
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const ab = await ac.decodeAudioData(await file.arrayBuffer()); ac.close();
    const mono = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < ab.length; i++) mono[i] += d[i] / ab.numberOfChannels; }
    const sig = DSP.resample(mono, ab.sampleRate, SR);
    if (sig.length > SR * 180) { $('#recStatus').textContent = 'ไฟล์ยาวเกิน 3 นาที ใช้ช่วงแรก 3 นาที'; }
    analyze(sig.subarray(0, SR * 180), 'ไฟล์ ' + file.name);
  } catch (e) { $('#recStatus').textContent = 'อ่านไฟล์เสียงนี้ไม่ได้ (' + e.message + ')'; }
}

/* ================= IndexedDB: คลังเสียง ================= */
const idb = {
  db: null,
  open() {
    return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => {
      const r = indexedDB.open('tvl', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('rec', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => res(this.db = r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('rec', mode), q = fn(t.objectStore('rec')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); },
  put(o) { return this.tx('readwrite', s => s.put(o)); }, all() { return this.tx('readonly', s => s.getAll()); },
  get(id) { return this.tx('readonly', s => s.get(id)); }, del(id) { return this.tx('readwrite', s => s.delete(id)); },
};
async function saveCurrent() {
  if (!st.rec || !st.rec.sum) return;
  const def = 'เสียง ' + new Date().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  const name = prompt('ตั้งชื่อเสียงนี้', def); if (name === null) return;
  await idb.put({ name: name || def, t: Date.now(), duration: st.rec.sig.length / SR, blob: toWav(st.rec.sig), summary: summaryOf(st.rec) });
  $('#recStatus').textContent = 'เก็บลงคลังแล้ว'; refreshRefSelect();
}
async function refreshRefSelect() {
  const sel = $('#refSelect'), cur = sel.value, all = (await idb.all()).sort((a, b) => b.t - a.t);
  sel.innerHTML = '<option value="">— เลือกเสียงจากคลัง —</option>' + all.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  sel.value = cur;
}
async function renderLib() {
  const all = (await idb.all()).sort((a, b) => b.t - a.t), t = $('#libTable');
  if (!all.length) { t.innerHTML = '<tr><td class="hint">ยังไม่มีเสียงในคลัง — ไปที่ “วิเคราะห์เสียงที่อัด” แล้วกด “เก็บลงคลัง”</td></tr>'; return; }
  t.innerHTML = '<tr><th>ชื่อ</th><th>เมื่อ</th><th class="num">ยาว</th><th class="num">AI</th><th class="num">อะคูสติก</th><th></th></tr>' + all.map(r =>
    `<tr data-id="${r.id}"><td>${r.name}</td><td>${new Date(r.t).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</td><td class="num">${fmt1(r.duration)} วิ</td><td class="num">${pct(r.summary.ai)}</td><td class="num">${pct(r.summary.acoustic)}</td>
    <td><button data-a="play">▶</button> <button data-a="ref">ใช้เทียบ</button> <button data-a="re">วิเคราะห์ใหม่</button> <button data-a="ren">ชื่อ</button> <button data-a="del">ลบ</button></td></tr>`).join('');
  $$('tr[data-id]', t).forEach(tr => $$('button', tr).forEach(b => b.onclick = async () => {
    const id = +tr.dataset.id, rec = await idb.get(id), a = b.dataset.a;
    if (a === 'play') playSlice(await fromWav(rec.blob), 0, rec.duration);
    if (a === 'ref') { st.ref = rec; await refreshRefSelect(); $('#refSelect').value = id; switchTab('rec'); if (st.rec && st.rec.sum) renderCompare(); else $('#recStatus').textContent = 'เลือก “' + rec.name + '” เป็นเสียงอ้างอิงแล้ว อัดหรืออัปโหลดเสียงใหม่เพื่อเทียบ'; }
    if (a === 're') { switchTab('rec'); analyze(await fromWav(rec.blob), 'จากคลัง: ' + rec.name); }
    if (a === 'ren') { const n = prompt('ชื่อใหม่', rec.name); if (n) { rec.name = n; await idb.put(rec); renderLib(); refreshRefSelect(); } }
    if (a === 'del' && confirm('ลบ “' + rec.name + '” ออกจากคลัง?')) { await idb.del(id); if (st.ref && st.ref.id === id) st.ref = null; renderLib(); refreshRefSelect(); }
  }));
}

/* ================= สมุดบันทึก ================= */
const DIARY_KEY = 'tvl.diary.v1', SET_KEY = 'tvl.settings.v1';
const diary = { get() { try { return JSON.parse(localStorage.getItem(DIARY_KEY)) || []; } catch (e) { return []; } }, set(v) { try { localStorage.setItem(DIARY_KEY, JSON.stringify(v)); } catch (e) {} } };
function autoDiary() {
  const r = st.rec; if (!r || r.logged || !r.sum || r.sum.voicedSeconds < 3) return; r.logged = true;
  const s = summaryOf(r), d = diary.get();
  d.push({ t: Date.now(), acoustic: isFinite(s.acoustic) ? s.acoustic : null, ai: isFinite(s.ai) ? s.ai : null, f0: isFinite(s.f0) ? s.f0 : null, vtl: isFinite(s.vtl) ? s.vtl : null, sd: isFinite(s.sd) ? s.sd : null });
  diary.set(d);
}
function renderDiary() {
  const d = diary.get(), t = $('#diaryTable'), cv = $('#cvDiary');
  $('#diaryCount').textContent = d.length ? 'บันทึกแล้ว ' + d.length + ' ครั้ง' : 'ยังไม่มีบันทึก — วิเคราะห์เสียงที่อัดสักครั้งก่อน';
  t.innerHTML = d.length ? '<tr><th>เวลา</th><th class="num">อะคูสติก</th><th class="num">AI</th><th class="num">F0</th><th class="num">ช่องเสียง</th><th class="num">ท่วงทำนอง</th></tr>' +
    d.slice(-40).reverse().map(e => `<tr><td>${new Date(e.t).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</td><td class="num">${pct(e.acoustic ?? NaN)}</td><td class="num">${pct(e.ai ?? NaN)}</td><td class="num">${fmt0(e.f0 ?? NaN)}</td><td class="num">${fmt1(e.vtl ?? NaN)}</td><td class="num">${fmt1(e.sd ?? NaN)}</td></tr>`).join('') : '';
  if (!fit(cv)) return;
  const c = cv.getContext('2d'), W = cv.width, H = cv.height, dp = DPR(), pad = 28 * dp;
  c.fillStyle = CSSBG(); c.fillRect(0, 0, W, H);
  c.font = (11 * dp) + 'px sans-serif'; c.fillStyle = 'rgba(255,255,255,.5)'; c.textBaseline = 'middle';
  [0, .25, .5, .75, 1].forEach(v => { const y = pad / 2 + (1 - v) * (H - pad); c.fillRect(pad, y, W - pad - 6 * dp, 0.5 * dp); c.fillText(Math.round(v * 100), 2 * dp, y); });
  if (d.length < 1) return;
  const X = i => pad + (d.length === 1 ? 0.5 : i / (d.length - 1)) * (W - pad - 12 * dp), Y = v => pad / 2 + (1 - v) * (H - pad);
  [['acoustic', BLUE], ['ai', PINK]].forEach(([k, col]) => {
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2 * dp; c.beginPath(); let pen = false;
    d.forEach((e, i) => { if (e[k] == null) { pen = false; return; } const x = X(i), y = Y(e[k]); pen ? c.lineTo(x, y) : c.moveTo(x, y); pen = true; });
    c.stroke(); d.forEach((e, i) => { if (e[k] != null) { c.beginPath(); c.arc(X(i), Y(e[k]), 3.5 * dp, 0, 7); c.fill(); } });
  });
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

/* ================= ประโยคฝึก / ข้อมูลประกอบ ================= */
const PHRASES = {
  'ทักทาย': ['สวัสดีค่ะ วันนี้อากาศดีนะคะ', 'ขอบคุณมากนะคะ', 'ยินดีที่ได้รู้จักค่ะ', 'ไม่เป็นไรค่ะ ไม่ต้องรีบนะคะ'],
  'ร้านกาแฟ': ['ขอลาเต้เย็นหนึ่งแก้วค่ะ', 'หวานน้อยนะคะ', 'รบกวนขอน้ำเปล่าอีกแก้วได้ไหมคะ', 'คิดเงินด้วยค่ะ'],
  'โทรศัพท์/ที่ทำงาน': ['สวัสดีค่ะ ยินดีให้บริการค่ะ', 'รอสักครู่นะคะ เดี๋ยวตรวจสอบให้ค่ะ', 'ขออนุญาตทวนอีกครั้งนะคะ', 'ขอบคุณที่โทรมาค่ะ'],
  'ลงท้ายประโยค': ['จริงเหรอคะ', 'ใช่ไหมคะ', 'ไปด้วยกันนะคะ', 'ได้เลยค่ะ'],
  'อ่านยาว ๆ': ['วันนี้ฉันตื่นเช้า ชงกาแฟร้อนหนึ่งแก้ว แล้วนั่งมองแสงแดดอ่อน ๆ ที่ส่องเข้ามาทางหน้าต่างค่ะ', 'เมื่อวานฝนตกทั้งวัน ฉันเลยอยู่บ้านอ่านหนังสือเล่มโปรดจนจบทั้งเล่มเลยนะคะ'],
  'ลากสระ': ['อี — อา — อู   (ลากยาวอย่างละ 3 วินาที ระดับเสียงคงที่)', 'มา มี มู มา มี มู', 'นา นี นู นา นี นู'],
};
const PHRASE_HINT = { 'ลงท้ายประโยค': 'คะ (เสียงตรี) ใช้ท้ายคำถาม · ค่ะ (เสียงโท) ใช้ท้ายประโยคบอกเล่า — ลองให้เบาและโปร่ง ไม่ต้องกดลง', 'ลากสระ': 'ดูแผนภูมิสระในแท็บ “ฝึกสด” ไปพร้อมกัน' };
function renderPhrases(cat) {
  $('#phraseCats').innerHTML = Object.keys(PHRASES).map(k => `<button class="cat ${k === cat ? 'on' : ''}" data-c="${k}">${k}</button>`).join('');
  $$('#phraseCats .cat').forEach(b => b.onclick = () => renderPhrases(b.dataset.c));
  $('#phraseList').innerHTML = (PHRASE_HINT[cat] ? `<li><small>${PHRASE_HINT[cat]}</small></li>` : '') + PHRASES[cat].map(p => `<li><span>${p}</span></li>`).join('');
}
const INFO = {
  F0: 'F0 (ระดับเสียงพื้นฐาน) คือความถี่ที่สายเสียงสั่น ยิ่งสูงเสียงยิ่งแหลม ช่วงทั่วไปโดยประมาณ: เสียงชาย ~85–155 Hz, เสียงหญิง ~165–255 Hz ระดับเสียงอย่างเดียวไม่พอให้ฟังสว่าง ต้องมีเสียงก้องประกอบ',
  F1: 'F1 สัมพันธ์กับการอ้าปากและตำแหน่งขากรรไกร อ้าปากมากขึ้น F1 จะสูงขึ้น ช่องเสียงสั้นลงก็ทำให้ F1 สูงขึ้นเล็กน้อย',
  F2: 'F2 สัมพันธ์กับตำแหน่งลิ้นหน้า–หลัง ลิ้นไปข้างหน้า F2 สูง เสียงสว่าง การยิ้มเบา ๆ ช่วยยก F2 ได้ ตัวนี้มีผลต่อความสว่างมากที่สุดตัวหนึ่ง',
  F3: 'F3 ปรับตรง ๆ ยากกว่า มักสูงขึ้นเมื่อช่องเสียงสั้นลง (กล่องเสียงสูงขึ้น/ริมฝีปากยืด) ใช้ดูภาพรวมของเสียงก้อง',
};

/* ================= เริ่มต้น ================= */
function init() {
  // แท็บ
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  // ไมค์
  $('#btnMic').onclick = () => (st.mic ? closeMic() : openMic());
  $('#btnRec').onclick = () => (st.recording ? stopRec() : startRec());
  $('#optAgc').onchange = async () => { if (st.mic) { await closeMic(); await openMic(); } };
  // ข้อมูล F0–F3
  $$('.ro').forEach(b => b.onclick = () => { const box = $('#infoBox'), same = b.classList.contains('on'); $$('.ro').forEach(x => x.classList.remove('on')); if (same) { box.hidden = true; return; } b.classList.add('on'); box.hidden = false; box.textContent = INFO[b.dataset.info]; });
  // เป้าหมาย
  try { Object.assign(st.settings, JSON.parse(localStorage.getItem(SET_KEY)) || {}); } catch (e) {}
  $('#tgtLo').value = st.settings.lo; $('#tgtHi').value = st.settings.hi;
  const saveSet = () => { st.settings.lo = clamp(+$('#tgtLo').value || 170, 60, 500); st.settings.hi = clamp(+$('#tgtHi').value || 220, st.settings.lo + 5, 600); try { localStorage.setItem(SET_KEY, JSON.stringify(st.settings)); } catch (e) {} };
  $('#tgtLo').onchange = $('#tgtHi').onchange = saveSet; saveSet();
  $('#btnTone').onclick = () => {
    const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = (st.settings.lo + st.settings.hi) / 2; g.gain.setValueAtTime(0, ac.currentTime); g.gain.linearRampToValueAtTime(0.18, ac.currentTime + 0.05); g.gain.linearRampToValueAtTime(0, ac.currentTime + 1.6);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 1.7); o.onended = () => ac.close();
  };
  // สเปกโตรแกรม
  $('#btnPause').onclick = () => { st.paused = !st.paused; $('#btnPause').textContent = st.paused ? '▶ เล่นต่อ' : '⏸ หยุดภาพ'; };
  $('#specRange').onchange = () => { const cv = $('#cvSpec'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); st.specRef = -20; };
  $('#recContrast').oninput = drawRecSpec; $('#recOverlay').onchange = drawRecSpec;
  $('#cvRec').classList.add('click');
  $('#cvRec').onclick = (e) => {
    if (!st.rec) return; const r = e.target.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * (st.rec.sig.length / SR);
    const seg = st.rec.sum.segments.find(s => t >= s.start - 0.05 && t <= s.end + 0.05);
    rs.sel = seg ? [seg.start, seg.end] : [Math.max(0, t - 0.4), t + 0.6]; playSlice(st.rec.sig, rs.sel[0], rs.sel[1]); drawRecSpec();
  };
  $('#hitReset').onclick = () => { st.hit.count = 0; $('#hitCount').textContent = '0'; };
  $('#hitVowel').onchange = () => { st.hit.armed = true; st.hit.since = 0; };
  // เสียงที่อัด
  $('#fileIn').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  $('#btnPlayRec').onclick = () => { if (st.rec) { rs.sel = null; playSlice(st.rec.sig, 0, st.rec.sig.length / SR); drawRecSpec(); } };
  $('#btnSaveRec').onclick = saveCurrent;
  $('#refSelect').onchange = async (e) => { st.ref = e.target.value ? await idb.get(+e.target.value) : null; renderCompare(); };
  // สมุด
  $('#btnCsv').onclick = () => { const d = diary.get(); download('voice-diary.csv', '﻿เวลา,อะคูสติก,AI,F0,ช่องเสียง(cm),ท่วงทำนอง(st)\n' + d.map(e => [new Date(e.t).toISOString(), e.acoustic ?? '', e.ai ?? '', e.f0 ?? '', e.vtl ?? '', e.sd ?? ''].join(',')).join('\n'), 'text/csv'); };
  $('#btnBackup').onclick = () => download('voice-backup.json', JSON.stringify({ v: 1, diary: diary.get(), settings: st.settings }), 'application/json');
  $('#importIn').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const j = JSON.parse(await f.text()); if (!Array.isArray(j.diary)) throw 0; if (confirm('นำเข้า ' + j.diary.length + ' รายการ? (จะแทนที่สมุดปัจจุบัน)')) { diary.set(j.diary); renderDiary(); } } catch (err) { alert('ไฟล์สำรองไม่ถูกต้อง'); } };
  $('#btnClearDiary').onclick = () => { if (confirm('ล้างสมุดบันทึกทั้งหมด? (คลังเสียงไม่ถูกลบ)')) { diary.set([]); renderDiary(); } };
  renderPhrases('ทักทาย'); refreshRefSelect().catch(() => {});
  // AI
  // PWA: ลงทะเบียน service worker + ปุ่มติดตั้ง
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; $('#btnInstall').hidden = true; };
  window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone) $('#iosHint').hidden = false;
  if (!window.isSecureContext) $('#micMsg').textContent = 'หน้านี้ต้องเปิดผ่าน https:// (หรือ localhost) เบราว์เซอร์ถึงจะยอมให้ใช้ไมค์';
  refreshAiChip(); $('#btnAi').onclick = () => { if (st.rec) runAI(st.rec.token); };
  window.addEventListener('resize', () => { if (st.rec) { drawRecSpec(); drawRecVowel(); } renderDiary(); });
  requestAnimationFrame(loop);
}
window.__tvl = { st, rs, analyze, vowelPos, switchTab };
init();
})();
