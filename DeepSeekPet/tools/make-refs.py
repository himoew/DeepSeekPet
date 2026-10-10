# -*- coding: utf-8 -*-
r"""给生图平台准备参考图（人物参考 + 部件参考）。

原图 `web\icon-source.png` 只有 240x216 —— 即梦这类平台的人物/风格参考编码器喜欢更大的图，
所以我把它放大居中铺到 1024 方图上（只放大、不重绘，颜色与比例一点都不变）。

另外把 25 张实装部件贴图拼成一张"部件总览"：它同时是
  · 给平台的**风格参考**（我们的描边粗细、平涂方式、配色，一目了然）；
  · 也是我们自己画部件时的对照表。

用法：python tools/make-refs.py
输出：art\ref-character-1024.png · art\ref-parts-overview.png
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "resources/app/web"
OUT = ROOT.parent / "art"


def character_ref():
    src = Image.open(WEB / "icon-source.png").convert("RGBA")
    canvas = Image.new("RGBA", (1024, 1024), (255, 255, 255, 255))
    # 放大到画布的 88% 高，居中（LANCZOS：不要用最近邻，边缘会出锯齿）
    scale = (1024 * 0.88) / src.height
    w, h = int(src.width * scale), int(src.height * scale)
    big = src.resize((w, h), Image.LANCZOS)
    canvas.paste(big, ((1024 - w) // 2, (1024 - h) // 2), big)
    dst = OUT / "ref-character-1024.png"
    canvas.convert("RGB").save(dst, quality=95)
    return dst


def parts_overview(cols=5, cell=220):
    tex = sorted((WEB / "whale/tex").glob("*.png"))
    rows = (len(tex) + cols - 1) // cols
    canvas = Image.new("RGBA", (cols * cell, rows * cell), (255, 255, 255, 255))
    for i, p in enumerate(tex):
        im = Image.open(p).convert("RGBA")
        s = min((cell - 16) / im.width, (cell - 16) / im.height)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
        x = (i % cols) * cell + (cell - im.width) // 2
        y = (i // cols) * cell + (cell - im.height) // 2
        canvas.paste(im, (x, y), im)
    dst = OUT / "ref-parts-overview.png"
    canvas.convert("RGB").save(dst, quality=95)
    return dst


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for p in (character_ref(), parts_overview()):
        im = Image.open(p)
        print(f"{p.name}  {im.width}x{im.height}  {p.stat().st_size // 1024}KB")
