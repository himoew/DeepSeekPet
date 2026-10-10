#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
换装贴图体检 -- 在启动桌宠之前，就看出一套新衣服会在哪些地方出问题。

用法（在 DeepSeekPet 目录下）：
    python tools/check-outfit.py spring-pink
    python tools/check-outfit.py schemes/spring-pink

## 它查什么、为什么查这些

这一套美术的每个部件贴图都会被【整张拉伸进 model.json 的 box】（uvBox 默认整张 0..1），
再被骨骼网格（web/rig/rig.js）按网格顶点变形。所以：

  1. 画布尺寸必须和原版逐像素相同（不同 = 整体缩放，一定错位）；
  2. 内容在图里的取景（alpha 包围盒）必须和原版几乎一致（差几像素就会在关节/接缝处露馅）；
  3. 实心像素覆盖率必须和原版同级 -- 这条最关键：原版 25 张是从【同一张母图】切下来的，
     "被上层盖住的地方"也画满了（上衣里有肩、坐姿那张里有腿/袜/鞋）。抠图/新画常常只画
     "看得见的部分"，缺的那一片在她一动（抬手、坐下、转身）时就露出来，看着就是"接缝、对不上"；
  4. 半透明虚边要少：贴图带 mipmap（generateMipmap + LINEAR_MIPMAP_LINEAR），
     桌宠在桌面上很小，软边会和透明底混成灰边/白边，像"贴上去的"；
  5. 整套 25 张 tex + 25 张 feat 一张都不能少：缺一张，这套配色整包加载失败（或那个部件静默不画）。

本脚本按"改过的部件 / 没改的部件"分组打印上面 1~4，并用 6x6 网格指出【缺在哪一块】
（左上/中/右下...），省得对着几百张图猜。
"""
import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：pip install pillow")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(os.path.dirname(HERE), "resources", "app")
WHALE = os.path.join(APP, "web", "whale")
BASE = os.path.join(WHALE, "tex")

SOLID = 250          # alpha >= 250 算"实心"
VIS = 120            # alpha > 120 算"看得见"
DIRS = [["左上", "上", "右上"], ["左", "中", "右"], ["左下", "下", "右下"]]


def load_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def probe(path):
    """返回 (尺寸, 可见包围盒, 实心像素数, 软边像素数, 6x6 覆盖率, 实际格式)"""
    with Image.open(path) as im:
        fmt = im.format
        im = im.convert("RGBA")
        w, h = im.size
        bb = im.getchannel("A").getbbox()
        g = [[0] * 6 for _ in range(6)]
        solid = soft = 0
        for y in range(h):
            gr = (y * 6) // h
            for x in range(w):
                v = im.getpixel((x, y))[3]
                if v >= SOLID:
                    solid += 1
                elif v > 0:
                    soft += 1
                if v > VIS:
                    g[gr][(x * 6) // w] += 1
    return (w, h), bb, solid, soft, g, fmt


def grid_report(base_g, new_g, w, h):
    """按格面积归一，指出缺得最多 / 多得最多的方位"""
    cw, ch = max(1, w // 6), max(1, h // 6)
    cell = cw * ch
    miss, extra = [], []
    for r in range(6):
        for c in range(6):
            d = new_g[r][c] - base_g[r][c]
            (miss if d < 0 else extra).append((d, r, c))
    out = []
    miss.sort()
    extra.sort(reverse=True)
    for tag, lst in (("缺", miss[:2]), ("多", extra[:2])):
        for d, r, c in lst:
            pct = abs(d) / cell * 100
            if pct > 4:
                out.append("%s%s(%d,%d) %.0f%%" % (tag, DIRS[r // 2][c // 2], r + 1, c + 1, pct))
    return "，".join(out[:3])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 1
    target = args[0]
    root = os.path.join(WHALE, "schemes", target) if not os.path.isdir(target) else target
    if not os.path.isdir(root):
        print("找不到目录：%s" % root)
        return 1
    model = load_json(os.path.join(WHALE, "model.json"))
    parts = model["parts"]
    feat_names = list(model["feat"]["sprites"].keys())
    for k in ("eyeL", "eyeR"):
        feat_names += ["%s_%s" % (k, n) for n in ("lash", "ball", "iris")]

    print("=" * 76)
    print("换装体检：%s" % root)
    print("=" * 76)

    # 0. 文件齐全性
    missing = [p["tex"] for p in parts if not os.path.exists(os.path.join(root, "tex", p["tex"] + ".png"))]
    missing += ["feat/" + n for n in feat_names if not os.path.exists(os.path.join(root, "feat", n + ".png"))]
    print("\n[0] 文件齐全性：%s" % ("全部齐（25 部件 + 25 表情）" if not missing else "缺 %d 个" % len(missing)))
    for m in missing[:20]:
        print("      缺 %s" % m)

    # 1~4 逐部件
    rows = []
    for p in parts:
        pid = p["id"]
        fa = os.path.join(BASE, p["tex"] + ".png")
        fb = os.path.join(root, "tex", p["tex"] + ".png")
        if not (os.path.exists(fa) and os.path.exists(fb)):
            continue
        A, B = probe(fa), probe(fb)
        changed = open(fa, "rb").read() != open(fb, "rb").read()
        if B[5] not in ("PNG", None):
            verdict = "[X] 其实不是 PNG（%s 改了后缀？）" % B[5]
        elif A[0] != B[0]:
            verdict = "[X] 画布尺寸不同（会被拉伸，必然错位）"
        elif B[2] == 0 and A[2]:
            verdict = "[i] 整片透明（是这套衣服故意没有的部件？原版这里有内容，露出来的会是下面那层）"
        elif A[1] and B[1] and max(abs(B[1][i] - A[1][i]) for i in range(4)) > 4:
            verdict = "[X] 取景偏了 %s px" % (tuple(B[1][i] - A[1][i] for i in range(4)),)
        elif A[2] and B[2] / A[2] < 0.90:
            verdict = "[X] 实心内容只有原版的 %.0f%%（被盖住/关节那块没画）" % (B[2] / A[2] * 100)
        elif A[2] and B[2] / A[2] > 1.15:
            verdict = "[!] 实心内容比原版多 %.0f%%（可能叠出重影）" % (B[2] / A[2] * 100)
        else:
            verdict = "ok"
        soft_a = A[3] / max(1, A[2] + A[3]) * 100
        soft_b = B[3] / max(1, B[2] + B[3]) * 100
        if verdict == "ok" and soft_b - soft_a > 6:
            verdict = "[!] 半透明虚边 %.0f%%（原版 %.0f%%；缩小时发灰、像贴上去的）" % (soft_b, soft_a)
        rows.append((pid, A, B, verdict, changed, grid_report(A[4], B[4], A[0][0], A[0][1])))

    print("\n[1~4] 逐部件（★ 标记 = 你改过的那几张）")
    print("  %-21s %-11s %-11s %-7s %s" % ("部件", "原版 px", "这套 px", "实心比", "判读"))
    for pid, A, B, verdict, changed, grid in rows:
        print("  %s %-19s %-11s %-11s %-7s %s" % (
            "*" if changed else " ", pid, "%dx%d" % A[0], "%dx%d" % B[0],
            ("%.2f" % (B[2] / A[2])) if A[2] else "-", verdict))
        if grid:
            print("        - 网格差异：%s" % grid)

    changed_list = [r[0] for r in rows if r[4]]
    bad = [r for r in rows if r[3].startswith("[X]")]
    info = [r for r in rows if r[3].startswith("[i]")]
    print("\n[5] 你改过的部件：%d 个 -> %s" % (len(changed_list), "、".join(changed_list) or "（一个都没改）"))
    print("[6] 会直接出问题：%d 个" % len(bad))
    for pid, A, B, verdict, changed, grid in bad:
        print("      %-20s %s" % (pid, verdict))
    if info:
        print("[7] 整片透明的部件（有意为之就忽略）：%d 个 -> %s" % (len(info), "、".join(r[0] for r in info)))
    if not bad and not missing:
        print("      没有硬错。剩下的差别只能靠真机看：坐下 / 抬手 / 转身时有没有露空、接缝、重影。")
    print("\n（口径：实心 = alpha>=250；取景 = alpha 包围盒；网格 = 6x6 分块覆盖率）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
