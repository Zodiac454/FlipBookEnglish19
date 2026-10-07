"""Проверка точности: совпадают ли страницы книги в вебе с тем, что нарисовано в PDF.

Для каждой проверяемой страницы рендерит ровно ту область PDF, куда вставлена
картинка, и сравнивает с готовым webp-ассетом (средняя абсолютная разница).
"""

import sys
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT.parent / "The_Cake_of_English_Tenses_FINAL_41_pages.pdf"
PDF_RECT = pymupdf.Rect(14.17323, 14.17323, 581.1024, 827.7166)
ASSET_W, ASSET_H = 1400, 2010
THRESHOLD = 6.0


def mad(a: Image.Image, b: Image.Image) -> float:
    a, b = a.convert("RGB"), b.convert("RGB")
    pa, pb = a.load(), b.load()
    total = 0
    for y in range(a.size[1]):
        for x in range(a.size[0]):
            ca, cb = pa[x, y], pb[x, y]
            total += abs(ca[0] - cb[0]) + abs(ca[1] - cb[1]) + abs(ca[2] - cb[2])
    return total / (a.size[0] * a.size[1] * 3)


def main() -> None:
    pages = [1, 2, 3, 6, 21, 41]
    doc = pymupdf.open(PDF)
    scale = ASSET_W / PDF_RECT.width
    bad = []

    print(f"{'страница':<10}{'размер PDF-области':<22}{'разница (0-255)':>16}")
    for n in pages:
        page = doc[n - 1]
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=PDF_RECT)
        rendered = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        if rendered.size != (ASSET_W, ASSET_H):
            rendered = rendered.resize((ASSET_W, ASSET_H), Image.LANCZOS)
        asset = Image.open(ROOT / "pages" / f"p{n:03d}.webp")
        asset.load()
        value = mad(rendered, asset)
        ok = value < THRESHOLD
        if not ok:
            bad.append((n, round(value, 1)))
        print(f"{n:<10}{f'{pix.width}x{pix.height}':<22}{value:>16.2f}  {'OK' if ok else 'РАСХОЖДЕНИЕ'}")

    print()
    print("ИТОГ:", "страницы в вебе совпадают с PDF" if not bad else f"расхождения: {bad}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
