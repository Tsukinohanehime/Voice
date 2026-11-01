# ห้องฝึกเสียง (PWA)

แอปฝึกเสียงที่ติดตั้งลงมือถือ/คอมได้ ทำงานออฟไลน์ได้ ไม่มีเซิร์ฟเวอร์ ไม่ส่งเสียงออกนอกเครื่อง
(วิเคราะห์ pitch / formant / สเปกโตรแกรม / ผัง vowel / คะแนน AI ในเบราว์เซอร์ทั้งหมด)

## ใช้บนเครื่องตัวเอง (ทดสอบ)
    cd pwa && python3 -m http.server 8000
เปิด http://localhost:8000  (localhost ใช้ไมค์และ service worker ได้)

## ติดตั้งใช้บนมือถือ — ต้องเป็น HTTPS
อัปโหลดทั้งโฟลเดอร์นี้ขึ้นโฮสต์ static ฟรี เช่น GitHub Pages / Cloudflare Pages / Netlify
(ไฟล์โมเดล models/final.onnx = 58 MB; GitHub Pages รับได้ เพราะไฟล์ < 100 MB)

- Android/Chrome: เปิดเว็บ → ปุ่ม "ติดตั้งแอป" หรือเมนู ⋮ → Install app
- iPhone/Safari: ปุ่มแชร์ → Add to Home Screen (ต้องใช้ Safari)
- ครั้งแรกกดปุ่ม "ดาวน์โหลดโมเดล AI" (58 MB ครั้งเดียว) หลังจากนั้นใช้ออฟไลน์ได้

## อัปเดตแอป
แก้ไฟล์แล้วเปลี่ยน `VERSION` ใน sw.js (เช่น tvl-shell-v4) เพื่อให้เครื่องที่ติดตั้งแล้วโหลดของใหม่

## ข้อมูล
บันทึกเสียง/ไดอารี่เก็บใน IndexedDB/localStorage ของเบราว์เซอร์นั้น ๆ (ล้างข้อมูลเว็บ = หาย)
คะแนน AI: Voice Femininity Percentage (Doukhan et al., MIT) — เป็นค่าประมาณ ไม่ใช่การวินิจฉัย

## โมเดล (zip ฉบับย่อไม่รวม final.onnx)
รัน `python3 get_model.py` ในโฟลเดอร์นี้ 1 ครั้ง เพื่อโหลด models/final.onnx (58 MB, MIT) ก่อนอัปโหลดขึ้นโฮสต์
