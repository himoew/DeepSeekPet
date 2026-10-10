# -*- coding: utf-8 -*-
"""比色：把生成图和实装原图（icon-source.png / web 里的贴图）按同一口径量一遍。

## 为什么不用肉眼

"我们的更鲜艳"这种判断必须落到数字上才能校：同一张图里背景是白的、线是深色的、
主体是蓝的 —— 直接算全图平均饱和度会被白底和背景稀释，所以这里：

  1. **只算"角色像素"**：有 alpha 的按 alpha>200；没有 alpha 的按"不是白/灰背景"
     （饱和度 > 0.12 或明度 < 0.92）；
  2. 给出**中位数**而不是均值（抗抗锯齿像素和零散噪点）；
  3. 分档给出：整体 S/V 中位数、最鲜艳的 10% 像素的 S（"够不够艳"看这个）、
     以及主色（调色板量化后的前 6 色）。

用法：
    python tools/analyze-palette.py <图1> [图2 ...]
"""
import sys
import colorsys
from pathlib import Path

import numpy as np
from PIL import Image


def char_pixels(path):
    """返回角色像素的 RGB 数组（float 0~1）与"是不是用了 alpha"标记。"""
    im = Image.open(path)
    use_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    im = im.convert("RGBA")
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3]
    if use_alpha:
        mask = alpha > 0.8
    else:
        mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
        mask = (sat > 0.12) | (mx < 0.92)
    # 丢掉线稿那种几乎纯黑的像素（它不是"颜色"，会把统计压暗）
    keep = mask & (rgb.max(axis=-1) > 0.10)
    return rgb[keep], use_alpha


def hsv(rgb):
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return s, v


def top_colors(path, n=6):
    im = Image.open(path).convert("RGB")
    q = im.quantize(colors=n, method=Image.MEDIANCUT)
    pal = np.array(q.getpalette()[: n * 3], dtype=np.float32).reshape(-1, 3) / 255.0
    counts = np.bincount(np.asarray(q).ravel(), minlength=n)
    order = np.argsort(-counts)
    out = []
    for i in order:
        r, g, b = pal[i]
        h, s, v = colorsys.rgb_to_hsv(float(r), float(g), float(b))
        out.append((f"#{int(r*255):02X}{int(g*255):02X}{int(b*255):02X}", s, v, h * 360, counts[i] / counts.sum()))
    return out


def report(path):
    rgb, used_alpha = char_pixels(path)
    if rgb.size == 0:
        print(f"{path}: 没有角色像素")
        return
    s, v = hsv(rgb)
    s10 = np.percentile(s, 90)
    print(f"\n=== {Path(path).name}  ({len(rgb)} 角色像素{'，有 alpha' if used_alpha else '，按白底抠'}) ===")
    print(f"  饱和度 S：中位数 {np.median(s):.3f} · 均值 {s.mean():.3f} · 最艳 10% = {s10:.3f}")
    print(f"  明度   V：中位数 {np.median(v):.3f} · 均值 {v.mean():.3f}")
    for hexs, ss, vv, hh, share in top_colors(path):
        print(f"  主色 {hexs}  S={ss:.2f} V={vv:.2f} H={hh:5.0f}° 占 {share*100:4.1f}%")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        root = Path(__file__).resolve().parent.parent
        args = [str(root / "DeepSeekPet/resources/app/web/icon-source.png")]
    for p in args:
        report(p)
