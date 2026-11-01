"""ดาวน์โหลดโมเดล VBx x-vector (final.onnx ~58 MB) จาก inaSpeechSegmenter (MIT)."""
import os
import sys
import urllib.request

URL = ("https://github.com/ina-foss/inaSpeechSegmenter/releases/download/"
       "interspeech23/final.onnx")
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "final.onnx")


def main():
    if os.path.exists(DEST) and os.path.getsize(DEST) > 50_000_000:
        print("มีโมเดลอยู่แล้ว:", DEST)
        return
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    print("กำลังดาวน์โหลด final.onnx ...")
    tmp = DEST + ".part"

    def hook(n, bs, total):
        if total > 0:
            sys.stdout.write("\r  %3d%%" % min(100, n * bs * 100 // total))
            sys.stdout.flush()

    urllib.request.urlretrieve(URL, tmp, hook)
    os.replace(tmp, DEST)
    print("\nเสร็จแล้ว:", DEST)


if __name__ == "__main__":
    main()
