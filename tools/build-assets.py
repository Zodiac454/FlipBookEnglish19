"""Извлекает страницы из PDF и делает веб-ассеты для флипбука.

Источник: The_Cake_of_English_Tenses_FINAL_41_pages.pdf
Каждая страница PDF — одна встроенная PNG-картинка, нарисованная
в один и тот же прямоугольник 566.93 x 813.54 pt (соотношение 0.6969),
то есть PDF приводит все страницы к одной пропорции.
Поэтому картинки берём в родном разрешении и приводим к тем же
пропорциям — так книга в браузере выглядит ровно как PDF,
ничего не обрезается и не появляются белые поля.

Использование:
    py -3 tools/build-assets.py            # всё
    py -3 tools/build-assets.py --extract  # только PNG из PDF
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT.parent / "The_Cake_of_English_Tenses_FINAL_41_pages.pdf"
RAW = ROOT / "tools" / "_raw_pages"
PAGES = ROOT / "pages"
THUMBS = ROOT / "thumbs"

PDF_PAGE_W = 566.9291          # прямоугольник вывода картинки в PDF, pt
PDF_PAGE_H = 813.5433

PAGE_WIDTH = 1400              # ширина большой страницы, px
# Высоту берём из пропорций страницы книги (700x1005 в assets/app.js), а не из PDF:
# тогда object-fit: cover не обрезает ни одного пикселя.
PAGE_HEIGHT = PAGE_WIDTH * 1005 // 700          # 2010
PAGE_QUALITY = 92              # WebP quality: на 80 были заметны артефакты на тексте
THUMB_WIDTH = 300              # миниатюры в панели разворотов
THUMB_HEIGHT = THUMB_WIDTH * PAGE_HEIGHT // PAGE_WIDTH
THUMB_QUALITY = 82


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    winget = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    hits = list(winget.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"))
    if hits:
        return str(hits[0])
    sys.exit("ffmpeg не найден")


def extract() -> list[Path]:
    if not PDF.exists():
        sys.exit(f"Нет PDF: {PDF}")
    RAW.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(PDF)
    out: list[Path] = []
    for index, page in enumerate(doc, start=1):
        images = page.get_images(full=True)
        if len(images) != 1:
            sys.exit(f"Стр. {index}: ожидалась 1 картинка, найдено {len(images)}")
        info = doc.extract_image(images[0][0])
        target = RAW / f"p{index:03d}.{info['ext']}"
        target.write_bytes(info["image"])
        out.append(target)
    print(f"Извлечено {len(out)} страниц -> {RAW}")
    return out


def convert(ffmpeg: str, raw: list[Path]) -> None:
    for folder in (PAGES, THUMBS):
        folder.mkdir(parents=True, exist_ok=True)
    for index, source in enumerate(sorted(raw), start=1):
        name = f"p{index:03d}.webp"
        run(ffmpeg, source, PAGES / name, f"scale={PAGE_WIDTH}:{PAGE_HEIGHT}", PAGE_QUALITY)
        run(ffmpeg, source, THUMBS / name, f"scale={THUMB_WIDTH}:{THUMB_HEIGHT}", THUMB_QUALITY)
    print(f"Готово: {len(raw)} страниц в {PAGES}, миниатюры в {THUMBS}")


def run(ffmpeg: str, source: Path, target: Path, scale: str, quality: int) -> None:
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source),
            "-vf", f"{scale}:flags=lanczos",
            "-c:v", "libwebp", "-quality", str(quality), "-compression_level", "6",
            str(target),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extract", action="store_true", help="только извлечь PNG из PDF")
    args = parser.parse_args()

    raw = extract()
    if args.extract:
        return
    convert(find_ffmpeg(), raw)

    total = sum(f.stat().st_size for f in PAGES.glob("*.webp"))
    thumbs = sum(f.stat().st_size for f in THUMBS.glob("*.webp"))
    print(f"Вес страниц: {total/1048576:.1f} МБ, миниатюр: {thumbs/1024:.0f} КБ")
    print(json.dumps({
        "pages": len(list(PAGES.glob('*.webp'))),
        "page_size": f"{PAGE_WIDTH}x{PAGE_HEIGHT}",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
