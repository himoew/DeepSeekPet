# -*- coding: utf-8 -*-
"""校色：把生成图拉向实装配色（`web/whale/tex` 那套）。

## 为什么需要

`palette-compare.py` 量出来的差距是**两处**，都在 HSV 里，而不是"整体饱和度"：

  1. **主蓝太暗**：实装 S0.686/V0.675（亮宝蓝），生成图 S0.73/**V0.40**（深藏蓝）→ 需要**提亮**；
  2. **亮部（发梢渐变）发灰**：实装 S0.627，生成图 S0.38 → 需要**补饱和**；
  3. 皮肤：实装 S0.146/V0.992（极淡），生成图 S0.21~0.33/V0.87 → 需要**降饱和 + 提亮**。

## 怎么改（按色相平滑插值，不是硬切色带）

色相中心点各自有一组 (S 增益, V 增益)：蓝 H225 → V×1.45、S×1.05；青蓝 H185 → S×1.55；
皮肤 H30 → S×0.55、V×1.05；其余不动。中心点之间线性插值（色相环上绕回来），
所以不会在色带边界切出硬边。

**线稿要保住**：深藏蓝线稿的色相也在 225° 附近，直接乘 V 会把线稿一起提亮（变灰）。
于是 V 增益乘一个 `smoothstep(V, 0.18, 0.36)` 的权重 —— 只有**亮于 0.18 的蓝**才被提亮，
线稿（V≈0.13）原样不动。

用法：
    python tools/match-palette.py <输入图> <输出图> [--boost 1.0]

`--boost` 缩放所有增益（0.5 = 只做一半，1.6 = 更猛），用来微调手感。
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 色相中心点（度）→ (S 增益, V 增益)。数值来自 palette-compare.py 的实测差距。
CENTS = [(30.0, 0.50, 1.06), (185.0, 1.70, 1.02), (225.0, 1.02, 1.60), (285.0, 1.00, 1.05), (360.0 + 30.0, 0.50, 1.06)]


def smoothstep(x, a, b):
    t = np.clip((x - a) / max(1e-6, b - a), 0, 1)
    return t * t * (3 - 2 * t)


def gains(hue):
    """按色相给每个像素插值出 (S 增益, V 增益)。"""
    hs = np.array([c[0] for c in CENTS], dtype=np.float32)
    gs = np.array([c[1] for c in CENTS], dtype=np.float32)
    gv = np.array([c[2] for c in CENTS], dtype=np.float32)
    hh = hue.astype(np.float32)
    hh = np.where(hh < CENTS[0][0], hh + 360.0, hh)      # 绕回色相环
    s_gain = np.interp(hh, hs, gs).astype(np.float32)
    v_gain = np.interp(hh, hs, gv).astype(np.float32)
    return s_gain, v_gain


def rgb_to_hsv(rgb):
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


def hsv_to_rgb(h, s, v):
    h = (h % 360.0) / 60.0
    i = np.floor(h)
    f = h - i
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    i = i.astype(np.int32) % 6
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1)


def match(src_path, dst_path, boost=1.0, compare_path=None):
    im = Image.open(src_path).convert("RGB")
    arr = np.asarray(im).astype(np.float32) / 255.0
    h, s, v = rgb_to_hsv(arr)
    sg, vg = gains(h)
    # 增益按 boost 缩放（1 = 实测值）
    sg = 1.0 + (sg - 1.0) * boost
    vg = 1.0 + (vg - 1.0) * boost
    # 线稿保护：只有亮过 0.18 的像素才吃 V 增益
    w = smoothstep(v, 0.18, 0.36)
    v2 = np.clip(v * (1.0 + (vg - 1.0) * w), 0.0, 1.0)
    # 白保护：本来就是白/近白（S 很小）的像素**不该被染色** ——
    # 不保护的话围裙、头饰、白袜会被 S 增益染成淡蓝（实装里它们是纯白）。
    sw = smoothstep(s, 0.10, 0.28)
    s2 = np.clip(s * (1.0 + (sg - 1.0) * sw), 0.0, 1.0)
    out = hsv_to_rgb(h, s2, v2)
    out8 = (np.clip(out, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    Image.fromarray(out8).save(dst_path, quality=95)
    if compare_path:                      # 左右并排（原图 | 校色后），方便肉眼验收
        w0, h0 = im.size
        canvas = Image.new("RGB", (w0 * 2 + 16, h0), (255, 255, 255))
        canvas.paste(im, (0, 0))
        canvas.paste(Image.fromarray(out8), (w0 + 16, 0))
        canvas.save(compare_path, quality=92)
    return dst_path


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    boost = 1.0
    for a in sys.argv[1:]:
        if a.startswith("--boost"):
            boost = float(a.split("=")[1]) if "=" in a else boost
    if len(args) < 2:
        print(__doc__)
        raise SystemExit(1)
    src, dst = args[0], args[1]
    cmp_path = args[2] if len(args) > 2 else None
    match(src, dst, boost=boost, compare_path=cmp_path)
    print(f"OK boost={boost} -> {Path(dst).name}" + (f" （并排对比：{Path(cmp_path).name}）" if cmp_path else ""))
