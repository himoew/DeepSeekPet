# -*- coding: utf-8 -*-
r"""把实装部件按 `model.json` 的 box 拼成"模型正面图"。

## 为什么要它

`web\whale\tex\*.png` 是 25 张**分部件贴图**，每张在 `model.json` 里有一个
`box: [x, y, w, h]`（模型坐标系里的位置与大小），运行时由 WebGL 按 `grid` 网格变形后合成。
所以在 Python 里"按 box 贴上去"就能得到**她的正面原图**（静止姿态下变形接近恒等）。

这张图是后面所有对齐工作的**基准尺**：

  · 生成的四宫格里，她的头/身体位置与模型并不重合 → 需要先算"缩放 + 平移"把它套上来；
  · 套准之后，才能按每个部件的 box + 该部件的 alpha 当**遮罩**，从生成图里"抠"出新衣服的那一层。

用法：
    python tools\model-render.py            # 输出 art\_model-front.png（透明）+ _model-front-white.png
    python tools\model-render.py --scale 4  # 放大倍数（默认 3）
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WHALE = ROOT / "resources/app/web/whale"
OUT = ROOT.parent / "art"


def render(scale=3.0):
    model = json.loads((WHALE / "model.json").read_text(encoding="utf-8"))
    vx, vy, vw, vh = model["view"]
    W, H = int(vw * scale), int(vh * scale)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    drawn, missing = [], []
    for p in sorted(model["parts"], key=lambda p: p.get("z", 0)):
        src = WHALE / "tex" / f"{p['tex']}.png"
        if not src.exists():
            missing.append(p["tex"])
            continue
        x, y, w, h = p["box"]
        im = Image.open(src).convert("RGBA").resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        canvas.alpha_composite(im, (int((x - vx) * scale), int((y - vy) * scale)))
        drawn.append(p["tex"])
    return canvas, drawn, missing


if __name__ == "__main__":
    scale = 3.0
    if "--scale" in sys.argv:
        scale = float(sys.argv[sys.argv.index("--scale") + 1])
    OUT.mkdir(parents=True, exist_ok=True)
    canvas, drawn, missing = render(scale)
    p1 = OUT / "_model-front.png"
    canvas.save(p1)
    white = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
    white.alpha_composite(canvas)
    p2 = OUT / "_model-front-white.png"
    white.convert("RGB").save(p2, quality=95)
    # ★ 顺便给"原版"生成换装页的缩略图：**只裁衣服那一块**（用户："直接放个服装图都行，不需要人出镜"）
    import numpy as np
    src = Image.open(WHALE / "tex" / "torso_up.png").convert("RGBA")   # 只为确认文件在（可读性）
    base = Image.open(ROOT / "resources/app/web/icon-source.png").convert("RGBA")
    a = np.asarray(base)[..., 3] if base.mode == "RGBA" else None
    rgb = np.asarray(base.convert("RGB")).astype(np.int16)
    mask = (255 - rgb.min(axis=-1)) > 18
    ys, xs = np.where(mask)
    if len(xs):
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        hh = y1 - y0 + 1
        # 衣服在角色包围盒的 54%~94% 那一段（头以下、膝盖以上；42% 那版把脸也带进来了）
        box = (int(x0 + (x1 - x0) * 0.26), int(y0 + hh * 0.54), int(x1 - (x1 - x0) * 0.26), int(y0 + hh * 0.94))
        crop = base.crop(box)
        side = max(crop.size)
        pv = Image.new("RGBA", (side, side), (255, 255, 255, 255))
        pv.alpha_composite(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        pv.convert("RGB").resize((512, 512), Image.LANCZOS).save(WHALE / "preview.png")
        print("换装页缩略图（原版·衣服特写）: web/whale/preview.png")
    print(p1.name, p2.name)
