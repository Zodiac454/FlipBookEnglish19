"""Визуальный контроль скриншотов: композиция, а не пиксельная точность.

Проверяет на каждом снимке:
  • страница (или разворот) стоит по центру окна;
  • фон вокруг книги тёмный — книга читается как объект на столе;
  • верхняя панель не сливается со страницей (она темнее);
  • нижняя панель видна: акцентный цвет ползунка присутствует;
  • страница занимает разумную долю кадра (не «потерялась»).
"""

import sys
from pathlib import Path

from PIL import Image

TAIL = 0.03            # допуск центровки, доля ширины
MIN_PAGE_SHARE = 0.05  # минимум светлых пикселей
MAX_PAGE_SHARE = 0.75


def luma(pixel: tuple[int, int, int]) -> float:
    r, g, b = pixel
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def analyse(path: Path) -> dict:
    img = Image.open(path).convert("RGB")
    w, h = img.size
    px = img.load()

    # на увеличенных кадрах страница закрывает весь экран — проверки фона не применяем
    zoomed = any(k in path.name for k in ("zoom", "pinch"))

    step = max(1, w // 380)          # прореживание для скорости
    bright_x, bright_y, bright = [], [], 0
    total = 0
    border_luma = []

    for y in range(0, h, step):
        for x in range(0, w, step):
            p = px[x, y]
            total += 1
            if luma(p) > 150:
                bright += 1
                bright_x.append(x)
                bright_y.append(y)
            if x < 8 or x > w - 9 or y < 8 or y > h - 9:
                border_luma.append(luma(p))

    if not bright_x:
        return {"файл": path.name, "ошибка": "страница не найдена"}

    bcx = (min(bright_x) + max(bright_x)) / 2
    bcy = (min(bright_y) + max(bright_y)) / 2
    share = bright / total
    border = sum(border_luma) / max(1, len(border_luma))

    top_strip = sum(luma(px[x, max(2, h // 40)]) for x in range(0, w, max(1, w // 60))) / 60

    # нижняя панель: акцентная полоса ползунка или его белая ручка
    accent = 0
    for y in range(int(h * 0.90), h - 1):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            is_accent = r > 170 and 100 < g < 215 and b < 140
            if is_accent or luma((r, g, b)) > 215:
                accent += 1

    result = {
        "файл": path.name,
        "размер": f"{w}×{h}",
        "центровка (допуск %.0f%%) " % (TAIL * 100): "OK" if abs(bcx - w / 2) <= w * TAIL else f"СМЕЩЕНО на {bcx - w/2:+.0f}px",
        "вертикаль": "OK" if abs(bcy - h / 2) <= h * 0.32 else f"смещено на {bcy - h/2:+.0f}px",
        "доля страницы": f"{share*100:.0f}%" + ("" if MIN_PAGE_SHARE <= share <= MAX_PAGE_SHARE else "  ← ПОДОЗРИТЕЛЬНО"),
        "нижняя панель на месте": "да" if accent > 3 else "НЕ НАЙДЕНА",
        "верхняя панель": f"{top_strip:.0f}" + ("  ← СЛИВАЕТСЯ" if top_strip >= 120 else ""),
    }

    if zoomed:
        result["фон по краям"] = "не проверяем (кадр увеличен)"
    else:
        result["фон по краям"] = f"{border:.0f}" + ("  ← СВЕТЛЫЙ ФОН" if border >= 90 else "")

    return result


def main() -> None:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    files = sorted(p for p in folder.glob("*.png") if not p.name.startswith("mob-thumbs"))
    if not files:
        sys.exit(f"нет скриншотов в {folder}")

    failures = []
    for path in files:
        row = analyse(path)
        print(f"\n{row['файл']}  ({row.get('размер', '?')})")
        for key, value in row.items():
            if key in ("файл", "размер"):
                continue
            bad = isinstance(value, str) and ("ПОДОЗРИТЕЛЬНО" in value or "СМЕЩЕНО" in value
                                              or "СВЕТЛЫЙ" in value or "СЛИВАЕТСЯ" in value
                                              or "НЕ НАЙДЕНА" in value or "не найдена" in value)
            print(f"   {key:<28}{value}{'   ←' if bad else ''}")
            if bad:
                failures.append(f"{path.name}: {key}")

    print()
    if failures:
        print("ПРОБЛЕМЫ:")
        for f in failures:
            print("  •", f)
        sys.exit(1)
    print("ИТОГ: композиция всех снимков в норме")


if __name__ == "__main__":
    main()
