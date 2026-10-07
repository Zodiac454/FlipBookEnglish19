"""Сверяет скриншоты браузера с исходными страницами книги.

Берёт region с экрана, уменьшает исходную страницу до того же размера
и считает среднюю абсолютную разницу (MAD) по пикселям.
MAD < 18/255 — на экране действительно нужная страница.
"""

import json
import sys
from pathlib import Path

from PIL import Image

SHOTS = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
BOOK = Path(__file__).resolve().parent.parent
THRESHOLD = 18.0


def compare(shot_name: str, regions: list[tuple[str, tuple[int, int, int, int]]]) -> list[dict]:
    shot = Image.open(SHOTS / shot_name).convert("RGB")
    results = []
    for label, box in regions:
        crop = shot.crop(box)
        source = Image.open(BOOK / label).convert("RGB").resize(crop.size, Image.LANCZOS)
        a, b = crop.load(), source.load()
        total = 0
        pixels = crop.size[0] * crop.size[1]
        for y in range(crop.size[1]):
            for x in range(crop.size[0]):
                pa, pb = a[x, y], b[x, y]
                total += abs(pa[0] - pb[0]) + abs(pa[1] - pb[1]) + abs(pa[2] - pb[2])
        mad = total / (pixels * 3)
        results.append({
            "страница": label,
            "регион": box,
            "средняя разница (0-255)": round(mad, 1),
            "совпадает": mad < THRESHOLD,
        })
    return results


def content_box(shot_name: str, background_tolerance: int = 26) -> tuple[int, int, int, int]:
    """Границы светлого содержимого (страниц) на скриншоте."""
    img = Image.open(SHOTS / shot_name).convert("RGB")
    px = img.load()
    w, h = img.size
    # фон — цвет углов
    bg = px[2, h - 3]
    min_x, min_y, max_x, max_y = w, h, 0, 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > background_tolerance:
                min_x, min_y = min(min_x, x), min(min_y, y)
                max_x, max_y = max(max_x, x), max(max_y, y)
    return (min_x, min_y, max_x, max_y)


def main() -> None:
    state = json.loads((SHOTS / "state.json").read_text(encoding="utf-8"))["report"]

    cover = state["cover"]
    spread = state["spread"]

    cover_rect = next(r for r in cover["visibleRects"] if r["alt"] == "Страница 1")
    cover_box = (cover_rect["x"], cover["block"]["y"],
                 cover_rect["x"] + cover_rect["w"], cover["block"]["y"] + cover["block"]["h"])

    print("Обложка на экране:", cover_box,
          "| центр обложки:", cover_box[0] + cover_box[2] >> 1,
          "| центр разворота:", cover["block"]["x"] + cover["block"]["w"] // 2 + 0)
    print("Содержимое, найденное на картинке:", content_box("shot-01-cover.png"))
    print()

    pairs = []
    pairs += compare("shot-01-cover.png", [("pages/p001.webp", cover_box)])

    rects = sorted(spread["visibleRects"], key=lambda r: r["x"])
    if len(rects) >= 2:
        left, right = rects[0], rects[1]
        box_l = (left["x"], spread["block"]["y"], left["x"] + left["w"], spread["block"]["y"] + spread["block"]["h"])
        box_r = (right["x"], spread["block"]["y"], right["x"] + right["w"], spread["block"]["y"] + spread["block"]["h"])
        pairs += compare("shot-02-spread.png", [
            ("pages/p002.webp", box_l),
            ("pages/p003.webp", box_r),
        ])

    # последний разворот — страницы 40 и 41 (41-я жёсткая)
    end = state.get("end")
    if end and len(end["visibleRects"]) >= 2:
        end_rects = sorted(end["visibleRects"], key=lambda r: r["x"])
        left, right = end_rects[0], end_rects[1]
        top = end["block"]["y"]
        height = end["block"]["h"]
        pairs += compare("shot-03-end.png", [
            ("pages/p040.webp", (left["x"], top, left["x"] + left["w"], top + height)),
            ("pages/p041.webp", (right["x"], top, right["x"] + right["w"], top + height)),
        ])

    print(f"{'страница':<16}{'регион':<26}{'разница':>9}{'  итог':>8}")
    for row in pairs:
        print(f"{row['страница']:<16}{str(row['регион']):<26}{row['средняя разница (0-255)']:>9}"
              f"{'  OK' if row['совпадает'] else '  РАСХОЖДЕНИЕ':>8}")

    bad = [r for r in pairs if not r["совпадает"]]
    print()
    print("ИТОГ:", "все страницы совпадают с исходником" if not bad else f"проблемы: {bad}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
