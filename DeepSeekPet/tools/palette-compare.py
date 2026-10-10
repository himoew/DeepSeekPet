# -*- coding: utf-8 -*-
"""分色带比色：实装贴图 vs 生成图。

`analyze-palette.py` 看的是"整张图多艳"，但两边构图完全不同（实装贴图是单个部件、透明底；
生成图是九宫格、白底），整图均值会被构图稀释。真正要比的是**同一类颜色**：

    深蓝（头发/裙子主色） · 青蓝（发梢渐变） · 白（围裙/头饰） · 皮肤 · 线稿

于是这里按**色相分带**统计：每一带给出"占多少像素、S 中位数、V 中位数"。
两边同带的 S/V 差多少，就是"我们更鲜艳"到底差在哪。

用法：
    python tools/palette-compare.py <基准图或目录> <图1> [图2 ...]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 色相分带（H 用 0~360），顺序即输出顺序
BANDS = [
    ("线稿(很暗)", None, None),      # 特殊：V < 0.18
    ("皮肤(暖)", 5, 55),
    ("青蓝(发梢)", 165, 200),
    ("蓝(主色)", 200, 250),
    ("紫蓝(暗部)", 250, 285),
    ("白/浅灰", None, None),          # 特殊：S < 0.12 且 V > 0.75
]


def pixels(path):
    im = Image.open(path)
    has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    im = im.convert("RGBA")
    a = np.asarray(im).astype(np.float32) / 255.0
    rgb, alpha = a[..., :3], a[..., 3]
    if has_alpha:
        mask = alpha > 0.85
    else:
        mx = rgb.max(axis=-1)
        mask = mx < 0.985                      # 白底去掉
    rgb = rgb[mask]
    return rgb


def hsv(rgb):
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.zeros_like(mx)
    d = np.maximum(mx - mn, 1e-6)
    m = (mx == r)
    h[m] = ((g - b) / d)[m] % 6
    m = (mx == g) & (mx != r)
    h[m] = ((b - r) / d)[m] + 2
    m = (mx == b) & (mx != r) & (mx != g)
    h[m] = ((r - g) / d)[m] + 4
    return s, v, h * 60


def stats(rgb):
    s, v, h = hsv(rgb)
    out = {}
    total = max(1, len(rgb))
    for name, lo, hi in BANDS:
        if name.startswith("线稿"):
            m = v < 0.18
        elif name.startswith("白"):
            m = (s < 0.12) & (v > 0.75)
        else:
            m = (h >= lo) & (h < hi) & (s > 0.12)
        n = int(m.sum())
        out[name] = (n / total, float(np.median(s[m])) if n else 0.0, float(np.median(v[m])) if n else 0.0)
    return out


def gather(paths):
    """把多张基准图合起来统计（实装贴图是按部件分的，合起来才是"她的配色"）。"""
    chunks = [pixels(p) for p in paths]
    chunks = [c for c in chunks if len(c)]
    return np.concatenate(chunks, axis=0) if chunks else np.zeros((0, 3), np.float32)


if __name__ == "__main__":
    base_arg, *others = sys.argv[1:]
    base_path = Path(base_arg)
    base_files = sorted(base_path.glob("*.png")) if base_path.is_dir() else [base_path]
    ref = stats(gather(base_files))
    print(f"基准：{base_path}  （{len(base_files)} 张，合成一套配色）")
    print(f"{'色带':<12}{'占比':>7}{'基准S':>8}{'基准V':>8}")
    for k, (share, s, v) in ref.items():
        print(f"{k:<12}{share*100:6.1f}%{s:8.3f}{v:8.3f}")
    for p in others:
        st = stats(pixels(p))
        print(f"\n对比：{Path(p).name}")
        print(f"{'色带':<12}{'占比':>7}{'S':>8}{'V':>8}   {'ΔS':>7}{'ΔV':>7}")
        for k, (share, s, v) in st.items():
            rs, rv = ref[k][1], ref[k][2]
            print(f"{k:<12}{share*100:6.1f}%{s:8.3f}{v:8.3f}   {s-rs:+7.3f}{v-rv:+7.3f}")
