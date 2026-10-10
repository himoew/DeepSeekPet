# -*- coding: utf-8 -*-
"""打光层次对比：把"高光层次"变成可比的数字。

## 为什么另写一个

`palette-compare.py` 看的是"同一个色带整体多艳/多亮"，会把头发里所有蓝像素揉成一个中位数 ——
**分层**（我们那种"深藏蓝底 + 亮宝蓝中间调 + 一条硬边青色高光带"）在那种口径下就看不出来。

这里改成看**明度直方图**：把角色像素按 V 分成 5 档

    L1 线稿/最暗 (0.00~0.20)   L2 暗部 (0.20~0.40)   L3 中间调 (0.40~0.60)
    L4 亮部 (0.60~0.80)        L5 高光 (0.80~1.00)

再分两个集合统计：**蓝色像素**（头发/裙子，H 200~260）与**全部角色像素**。
"层次"好不好看这两个量：

  · **档位分布**：五档是不是都有量（只有 2 档 = 平；3~4 档 = 有层次）；
  · **高光比** = L4+L5 ÷ L2+L3 —— 我们那种"大片亮蓝 + 一条高光带"这个比值明显高。

用法：
    python tools/tone-profile.py <图1> [图2 ...]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BINS = [(0.00, 0.20, "L1 最暗/线稿"), (0.20, 0.40, "L2 暗部"), (0.40, 0.60, "L3 中间调"),
        (0.60, 0.80, "L4 亮部"), (0.80, 1.01, "L5 高光")]


def char_pixels(path):
    im = Image.open(path)
    has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    im = im.convert("RGBA")
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3]
    mask = alpha > 0.85 if has_alpha else rgb.max(axis=-1) < 0.985
    return rgb[mask]


def hsv(rgb):
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    h = np.zeros_like(mx)
    m = mx == r
    h[m] = ((g - b) / d)[m] % 6
    m = (mx == g) & (mx != r)
    h[m] = ((b - r) / d)[m] + 2
    m = (mx == b) & (mx != r) & (mx != g)
    h[m] = ((r - g) / d)[m] + 4
    return h * 60.0, s, v


def profile(name, rgb, s, v):
    print(f"\n--- {name}（{len(rgb)} 像素）---")
    print(f"    {'档位':<14}{'占该集合':>9}")
    for lo, hi, label in BINS:
        m = (v >= lo) & (v < hi)
        print(f"    {label:<14}{m.mean()*100:8.1f}%")
    dark = ((v >= 0.20) & (v < 0.60)).sum()
    light = ((v >= 0.60)).sum()
    print(f"    高光比（L4+L5 ÷ L2+L3）= {light / max(1, dark):.2f}")


def report(path):
    rgb = char_pixels(path)
    if not len(rgb):
        print(f"{path}: 没有角色像素")
        return
    h, s, v = hsv(rgb)
    print(f"\n=== {Path(path).name} ===")
    profile("蓝色像素 H200~260 & S>0.25", rgb, s, v)
    blue = (h >= 200) & (h <= 260) & (s > 0.25)
    if blue.sum() > 50:
        profile("  └ 只算蓝", rgb[blue], s[blue], v[blue])
    profile("全部角色像素", rgb, s, v)


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
