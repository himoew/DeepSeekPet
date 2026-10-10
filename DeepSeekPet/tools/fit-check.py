# -*- coding: utf-8 -*-
r"""对位体检：生成图和我们模型到底差多少（给"能不能用"一条门槛线）。

量的东西（都对着 `tools\model-render.py` 出来的模型正面图）：

  · **IoU**：生成角色与模型角色的轮廓交并比（1 = 完全重合）；
  · **头身比**：头高 ÷ 总高（两边各算一次，看差多少）；
  · **腰线**：最窄处 ÷ 总高；
  · **裙摆宽**：最宽处 ÷ 总高；
  · **脚底/中心**：对齐后的平移量（用来判断是不是"只是整体位移"）。

用法：
    python tools\fit-check.py <生成图整格> [更多图...]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WHALE = ROOT / "resources/app/web/whale"
ART = ROOT.parent / "art"


def render_model(scale=3.0):
    import json
    model = json.loads((WHALE / "model.json").read_text(encoding="utf-8"))
    vx, vy, vw, vh = model["view"]
    canvas = Image.new("RGBA", (int(vw * scale), int(vh * scale)), (0, 0, 0, 0))
    for p in sorted(model["parts"], key=lambda p: p.get("z", 0)):
        src = WHALE / "tex" / f"{p['tex']}.png"
        if not src.exists():
            continue
        x, y, w, h = p["box"]
        im = Image.open(src).convert("RGBA").resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        canvas.alpha_composite(im, (int((x - vx) * scale), int((y - vy) * scale)))
    return canvas


def fg(im, thr=18, inset=0.0):
    """抠前景。`inset` 先按比例内缩（四宫格图有浅灰边框，不内缩会把边框当角色 → 得到一整个方块）。"""
    if inset:
        m = int(min(im.size) * inset)
        im = im.crop((m, m, im.width - m, im.height - m))
    a = np.asarray(im.convert("RGBA")).astype(np.int16)
    if (a[..., 3] < 250).any():
        return a[..., 3] > 100
    return (255 - a[..., :3].min(axis=-1)) > thr


def bbox(m):
    ys, xs = np.where(m)
    return (xs.min(), ys.min(), xs.max(), ys.max()) if len(xs) else None


def landmarks(m):
    """稳的地标：总高归一化后看"最宽处位置 / 腰线 / 下半身最宽"。

    ⚠️ 原来那个"头身比"用宽度阈值找头，遇到她的发型（头发是最宽的部分）会误判 —— 弃用。
    """
    ys = np.where(m.any(axis=1))[0]
    y0, y1 = ys.min(), ys.max()
    H = y1 - y0 + 1
    widths = m.sum(axis=1).astype(float)[y0:y1 + 1]
    widest = int(np.argmax(widths)) / H                       # 最宽处（一般是头发或裙摆）
    lo, hi = int(H * 0.35), int(H * 0.75)                     # 腰线只在躯干段找最窄
    waist = (lo + int(np.argmin(widths[lo:hi]))) / H if hi > lo else float("nan")
    lower = widths[int(H * 0.55):].max() / m.shape[1]        # 下半身最宽 ÷ 总宽
    return {"最宽处": round(widest, 3), "腰线": round(float(waist), 3), "下身宽": round(float(lower), 3)}


def denoise_frame(mask):
    """丢掉"几乎整行/整列都被填满"的像素 —— 四宫格那种细边框线就是这个特征。

    角色在任何一行也不会横跨 92% 的画面（她的头发最宽也就七八成），所以这条很安全。
    """
    m = mask.copy()
    H, W = m.shape
    rows = m.sum(axis=1) > 0.92 * W
    cols = m.sum(axis=0) > 0.92 * H
    if rows.any():
        m[rows, :] = False
    if cols.any():
        m[:, cols] = False
    return m


def check(path, model, model_mask, inset=0.08):
    gen = Image.open(path).convert("RGBA")
    if inset:                                     # 四宫格整格：先内缩掉浅灰边框
        m = int(min(gen.size) * inset)
        gen = gen.crop((m, m, gen.width - m, gen.height - m))
    gm = denoise_frame(fg(gen))
    gb, mb = bbox(gm), bbox(model_mask)
    if not gb or not mb:
        return {"file": Path(path).name, "err": "抠不出前景"}
    # 按高度等比缩放 + 底边对齐 + 水平居中（与 fit-outfit.py 同一套）
    gh = gb[3] - gb[1] + 1
    mh = mb[3] - mb[1] + 1
    s = mh / gh
    g2 = gen.resize((max(1, int(gen.width * s)), max(1, int(gen.height * s))), Image.LANCZOS)
    g2m = denoise_frame(fg(g2))
    b2 = bbox(g2m)
    dx = (mb[0] + mb[2]) / 2 - (b2[0] + b2[2]) / 2
    dy = mb[3] - b2[3]
    """
    ⚠️ **粘贴必须用"角色 mask"当 alpha**：生成图是 RGB，`convert('RGBA')` 之后 alpha 全是 255，
    直接 `paste(g2, pos, g2)` 会把**整块矩形（含白底）**贴上去 —— 于是"前景"变成一个大方块，
    IoU 和地标全废（这一版就是这么踩的）。
    """
    g2rgba = g2.convert("RGBA")
    g2rgba.putalpha(Image.fromarray((g2m * 255).astype("uint8")))
    placed = Image.new("RGBA", model.size, (0, 0, 0, 0))
    placed.paste(g2rgba, (int(round(dx)), int(round(dy))), g2rgba)
    pm = np.asarray(placed)[..., 3] > 100
    inter = (pm & model_mask).sum()
    union = (pm | model_mask).sum()
    lm, lg = landmarks(model_mask), landmarks(pm)
    out = {"file": Path(path).name, "scale": round(float(s), 3), "IoU": round(float(inter / max(1, union)), 3)}
    for k in lm:
        out[f"{k}(模)"] = lm[k]
        out[f"{k}(生)"] = lg[k]
        out[f"{k}差"] = round(lg[k] - lm[k], 3)
    white = Image.new("RGBA", model.size, (255, 255, 255, 255))
    ghost = placed.copy()
    ghost.putalpha(ghost.getchannel("A").point(lambda v: int(v * 0.45)))
    white.alpha_composite(model)
    white.alpha_composite(ghost)
    white.convert("RGB").save(ART / f"_check-{Path(path).stem}.jpg", quality=92)
    return out


if __name__ == "__main__":
    model = render_model()
    mm = fg(model)
    for p in sys.argv[1:]:
        print(check(p, model, mm))
