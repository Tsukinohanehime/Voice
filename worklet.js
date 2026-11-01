/* worklet.js — รับเสียงจากไมค์ แล้วแปลงเป็น 16 kHz mono ส่งกลับไปยังหน้าเว็บแบบสตรีม */
class Capture16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.needFilter = this.ratio > 1.01;
    this.next = 0;          // ตำแหน่ง (หน่วยตัวอย่างขาเข้า) ของตัวอย่างขาออกถัดไป
    this.n = 0;             // ตัวนับตัวอย่างขาเข้าทั้งหมด
    this.last = 0;
    this.out = new Float32Array(1024);
    this.outN = 0;
    // Butterworth อันดับ 4 ที่ 7.2 kHz (biquad 2 ชั้น)
    const fc = 7200;
    this.bq = [0.5412, 1.3066].map(Q => {
      const w0 = 2 * Math.PI * fc / sampleRate, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Q);
      const a0 = 1 + al;
      return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0,
               a1: -2 * cw / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    });
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let v = ch[i];
      if (this.needFilter) {
        for (const q of this.bq) {
          const y = q.b0 * v + q.b1 * q.x1 + q.b2 * q.x2 - q.a1 * q.y1 - q.a2 * q.y2;
          q.x2 = q.x1; q.x1 = v; q.y2 = q.y1; q.y1 = y; v = y;
        }
      }
      while (this.next <= this.n) {
        const frac = this.next - (this.n - 1);
        this.out[this.outN++] = this.last + (v - this.last) * Math.min(1, Math.max(0, frac));
        this.next += this.ratio;
        if (this.outN >= 320) { // ~20 ms
          this.port.postMessage(this.out.slice(0, this.outN));
          this.outN = 0;
        }
      }
      this.last = v;
      this.n++;
    }
    return true;
  }
}
registerProcessor('capture16k', Capture16k);
