"""Сравнение вариантов кодирования страниц: что видно, а что режется.

Считаем ошибку относительно исходной картинки из PDF (та же геометрия),
чтобы мерить именно потери кодирования, а не ресемплинг.
"""
import io
import subprocess
import sys
from pathlib import Path

import pymupdf
from PIL import Image

PDF = Path(r"C:\Users\kelio\OneDrive\Desktop\Английский\The_Cake_of_English_Tenses_FINAL_41_pages.pdf")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
TARGET_W, TARGET_H = 1400, 2010          # пропорции страницы книги (700x1005)

VARIANTS = [
    ("тек. сборка: q80",                  TARGET_W, TARGET_H, ["-quality", "80"]),
    ("q88",                                TARGET_W, TARGET_H, ["-quality", "88"]),
    ("q92",                                TARGET_W, TARGET_H, ["-quality", "92"]),
    ("q92, preset text",                   TARGET_W, TARGET_H, ["-quality", "92", "-preset", "text"]),
    ("q92, preset picture",                TARGET_W, TARGET_H, ["-quality", "92", "-preset", "picture"]),
    ("q95",                                TARGET_W, TARGET_H, ["-quality", "95"]),
    ("без апскейла (родной размер), q92",   None, None, ["-quality", "92"]),
]


def mad(a: Image.Image, b: Image.Image) -> float:
    a = a.convert("RGB")
    b = b.convert("RGB").resize(a.size, Image.LANCZOS)
    pa, pb = a.load(), b.load()
    total = 0
    for y in range(a.size[1]):
        for x in range(0, a.size[0], 2):
            ca, cb = pa[x, y], pb[x, y]
            total += abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
    return total / ((a.size[0] // 2) * a.size[1] * 3)


def main() -> None:
    doc = pymupdf.open(PDF)
    pages = [1, 2, 6]
    raw = {}
    for n in pages:
        info = doc.extract_image(doc[n - 1].get_images(full=True)[0][0])
        raw[n] = info["image"]

    print(f"{'вариант':<36}{'вес, КБ':>9}{'ошибка к исходнику':>20}")
    for label, w, h, opts in VARIANTS:
        sizes, errs = [], []
        for n in pages:
            src = Image.open(io.BytesIO(raw[n]))
            out = OUT / f"probe-{abs(hash(label)) % 10000}.webp"
            args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0"]
            if w:
                args += ["-vf", f"scale={w}:{h}:flags=lanczos"]
            args += ["-c:v", "libwebp", *opts, "-compression_level", "6", str(out)]
            subprocess.run(args, input=raw[n], check=True)
            sizes.append(out.stat().st_size)
            decoded = Image.open(out)
            reference = src if not w else src.resize((w, h), Image.LANCZOS)
            errs.append(mad(reference, decoded))
            out.unlink()

        print(f"{label:<36}{sum(sizes)/len(sizes)/1024:>9.1f}{sum(errs)/len(errs):>20.2f}")
        total = sum(sizes) / len(sizes) * 41 / 1048576
        print(f"{'   → вся книга':<36}{total * 1024:>9.0f} КБ ≈ {total:.1f} МБ")


if __name__ == "__main__":
    main()
