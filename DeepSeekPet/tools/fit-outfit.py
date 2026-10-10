# -*- coding: utf-8 -*-
r"""生图 → 能穿的服装（v2：新轮廓 + 坐姿 + 睡姿精灵）。

## v1 的问题（2026-10-10 用户实测）

v1 用**原贴图 alpha 当轮廓**去采生成图（"同轮廓换色"）→ 结果：
  · 原 `skirt.png` 的轮廓里含**白围裙**、裙摆也更宽，而生成的新裙子更小 → 轮廓没被填满，
    空出来的地方采到生成图的**白底** → 用户看到"裙子旁边一片白涂色"；
  · 只换了站立那两张 (`skirt` / `waist_bow_front`)，而 `figure.js` 坐下时会切到
    `skirt_sit` / `waist_bow_sit_front`（第 555-557 行）→ **一坐下/晕倒就变回原版**。

## v2 怎么做

1. **掩模 = `膨胀(原alpha, R) ∩ 生成图前景`** —— 允许新衣服比原来"胖一点/瘦一点"，
   但不会跨出部件该在的区域；轮廓就是**新衣服自己的轮廓**。
2. **缝隙填补**：掩模里有洞（被判定成背景的像素）就用地道的邻域平均**迭代补**进去，
   这样不会留下白点/白边。
3. **三张姿势图分工**：
   · 站姿（正面站）：躯干 / 裙子 / 腰饰 / 领结 / 头饰 / 腿（袜子鞋）；袖子用同轮廓采样；
   · 坐姿（坐地）：`skirt_sit`（裙子铺地）—— 用同法抠；没有对应部件的（如校服没围裙）
     就输出**全透明**，这样坐下时不会再露原版；
   · 睡姿（趴/蜷缩）：抠成**整身透明精灵** `sleep.png`，由页面在睡着时淡入（见 pet-app.js）。

用法：
    python tools\fit-outfit.py --id school-blue --label 藏蓝校服 \
        --stand art\pose-0.png --sit art\pose-2.png --sleep art\pose-3.png
（只给 `--stand` 也能跑：那样坐姿/睡姿沿用原版，只换站姿。）
"""
import argparse
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
WHALE = ROOT / "resources/app/web/whale"
ART = ROOT.parent / "art"
SCALE = 3.0

# 站立要换的部件（只换"生成图里位置可靠"的大部件；小部件留着原版反而干净）
NEW_SHAPE_PARTS = ["torso_up", "skirt", "waist_bow_front"]
"""
为什么**不再**换 bow / headdress / 袖 / 腿（v2 的教训）：
那些部件在 `model.json` 里的 box 很小、又和别的部件重叠（比如 arm_near 的框正好压在裙子上），
而生成图的姿势一换，那个框里采到的就是**别的内容** → 出现蓝色补丁/锯齿（用户预览里能看到）。
留着原版：白袜、藏蓝鞋、蓝蝴蝶结、白蕾丝发箍本来就跟这套校服差不多，看着是干净的。
"""
# 坐姿要覆盖的部件（没有对应形状的会被写成全透明）
SIT_PARTS = ["skirt_sit", "waist_bow_sit_front"]


# ---------- 基础图像工具 ----------

def fg_mask(im, inset=0.0, thr=18):
    """前景（白底图的角色）。`inset` 先按比例内缩，丢掉四宫格的浅灰边框。"""
    if inset:
        m = int(min(im.size) * inset)
        im = im.crop((m, m, im.width - m, im.height - m))
    a = np.asarray(im.convert("RGBA")).astype(np.int16)
    if (a[..., 3] < 250).any():
        return a[..., 3] > 100, im
    return (255 - a[..., :3].min(axis=-1)) > thr, im


def bbox(mask):
    ys, xs = np.where(mask)
    return (xs.min(), ys.min(), xs.max(), ys.max()) if len(xs) else None


def dilate(mask_img, r):
    """把 alpha 膨胀 r 像素（用 MaxFilter；r 必须是奇数）。"""
    if r < 1:
        return mask_img
    return mask_img.filter(ImageFilter.MaxFilter(int(r) + 1 if int(r) % 2 == 0 else int(r)))


def inpaint(rgb, mask, rounds=14):
    """把 mask 里的洞用地道邻域平均填掉（迭代扩散；用于防止白点/白边）。"""
    out = rgb.astype(np.float32).copy()
    filled = mask.copy()
    for _ in range(rounds):
        if filled.all():
            break
        # 8 邻域已知像素的平均
        acc = np.zeros_like(out)
        cnt = np.zeros(filled.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                s = np.roll(np.roll(out, dy, axis=0), dx, axis=1)
                f = np.roll(np.roll(filled, dy, axis=0), dx, axis=1)
                acc += s * f[..., None]
                cnt += f
        new = (cnt > 0) & (~filled)
        if not new.any():
            break
        out[new] = (acc[new] / cnt[new][..., None])
        filled |= new
    return out.astype(np.uint8)


def model_render(model):
    vx, vy, vw, vh = model["view"]
    canvas = Image.new("RGBA", (int(vw * SCALE), int(vh * SCALE)), (0, 0, 0, 0))
    for p in sorted(model["parts"], key=lambda p: p.get("z", 0)):
        src = WHALE / "tex" / f"{p['tex']}.png"
        if not src.exists():
            continue
        x, y, w, h = p["box"]
        im = Image.open(src).convert("RGBA").resize((max(1, int(w * SCALE)), max(1, int(h * SCALE))), Image.LANCZOS)
        canvas.alpha_composite(im, (int((x - vx) * SCALE), int((y - vy) * SCALE)))
    return canvas


def align_to_model(gen_path, base, inset=0.08):
    """把生成图（整格）等比缩放 + 底边对齐 + 水平居中，套到模型坐标上。"""
    gen = Image.open(gen_path).convert("RGBA")
    gm, gen = fg_mask(gen, inset=inset)
    gb, mb = bbox(gm), bbox(np.asarray(base)[..., 3] > 40)
    if not gb or not mb:
        raise SystemExit(f"对齐失败：{gen_path} 抠不出角色")
    s = (mb[3] - mb[1] + 1) / (gb[3] - gb[1] + 1)
    g2 = gen.resize((max(1, int(gen.width * s)), max(1, int(gen.height * s))), Image.LANCZOS)
    m2, _ = fg_mask(g2)
    b2 = bbox(m2)
    dx = (mb[0] + mb[2]) / 2 - (b2[0] + b2[2]) / 2
    dy = mb[3] - b2[3]
    out = Image.new("RGBA", base.size, (255, 255, 255, 255))
    out.paste(g2, (int(round(dx)), int(round(dy))))
    return out, s, (dx, dy)


def part_box_in_base(p, model):
    vx, vy, _, _ = model["view"]
    x, y, w, h = p["box"]
    return (int((x - vx) * SCALE), int((y - vy) * SCALE), int(w * SCALE), int(h * SCALE))


# ---------- 主流程 ----------

def largest_blobs(m, keep_ratio=0.2):
    """保留面积 ≥ 最大连通块 `keep_ratio` 的所有连通块（顺手去掉零散噪点）。"""
    from collections import deque
    H, W = m.shape
    seen = np.zeros_like(m, bool)
    blobs = []
    for y0, x0 in zip(*np.where(m)):
        if seen[y0, x0]:
            continue
        q = deque([(y0, x0)])
        seen[y0, x0] = True
        pix = []
        while q:
            y, x = q.popleft()
            pix.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        blobs.append(pix)
    if not blobs:
        return m
    biggest = max(len(b) for b in blobs)
    out = np.zeros_like(m, bool)
    for b in blobs:
        if len(b) >= biggest * keep_ratio:
            for y, x in b:
                out[y, x] = True
    return out


def make_part(orig_path, box_xywh, aligned, grow=1.16):
    """把一个部件的新贴图做出来（v5：**整块搬运**）。

    ## 为什么最后选了"整块搬运"

    前四版都在做"逐像素采样"（按我们的轮廓去生成图上取色），踩了一路：
    v1 白围裙/白涂色 → v2 串进尾巴的蓝色 → v3 平均扩散糊成一团 → v4 最近邻仍留涂抹。
    根因是**生成图的姿势和我们不一样**，按几何框取色必然取到别的东西。

    v5 换成：在"该部件框稍微放大一点"的范围里，取 **前景 ∩ 像衣服** 的最大连通块，
    把这块**整块裁下来、缩放进我们部件的贴图尺寸**。
       · 内容一定是**连贯的一整块衣服**（不会拼贴、不会串色）；
       · 形状 = 生成图里那件衣服自己的轮廓（新轮廓 ✓）；
       · 位置/坐标由我们的 box 决定（骨骼动画照旧 ✓）。
    风险是"裁歪"（框里混进别的部件），所以先放大框取块、再只留够大的连通块。
    """
    orig = Image.open(orig_path).convert("RGBA")
    ox, oy, ow, oh = box_xywh
    gx, gy = int(ow * (grow - 1) / 2), int(oh * (grow - 1) / 2)
    x0, y0 = max(0, ox - gx), max(0, oy - gy)
    crop = aligned.crop((x0, y0, ox + ow + gx, oy + oh + gy))
    a = np.asarray(crop.convert("RGB")).astype(np.float32) / 255.0
    mx, mn = a.max(axis=-1), a.min(axis=-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    fg = (255 - (a * 255).astype(np.int16).min(axis=-1)) > 18
    # ★ **排掉"青色"**（2026-10-10 用户实测坐姿：胸口/裙边冒出青块）：
    # 她的发梢和尾巴是**饱和青蓝**（色相 160~205），衣服是**藏蓝/格子蓝**（色相 210~235）。
    # 不排掉的话，"前景 ∩ 像衣服"就会把旁边的头发梢/尾巴当衣服搬进部件里。
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    hue = np.zeros_like(mx)
    m1 = mx == r
    hue[m1] = ((g - b) / d)[m1] % 6
    m2 = (mx == g) & (mx != r)
    hue[m2] = ((b - r) / d)[m2] + 2
    m3 = (mx == b) & (mx != r) & (mx != g)
    hue[m3] = ((r - g) / d)[m3] + 4
    hue *= 60.0
    cyan = (hue > 160) & (hue < 205) & (sat > 0.25)
    garment = ((sat > 0.18) | (mx < 0.5)) & ~cyan
    m = largest_blobs(fg & garment)
    if m.sum() < 40:
        return None
    ys, xs = np.where(m)
    patch = crop.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)).convert("RGBA")
    patch.putalpha(Image.fromarray((m[ys.min():ys.max() + 1, xs.min():xs.max() + 1] * 255).astype("uint8")))
    return patch.resize(orig.size, Image.LANCZOS)


def garment_crop(aligned, model, names=("torso_up", "skirt", "waist_bow_front"), margin=0.14):
    """从**对齐后的生成图**里裁"衣服那一块"当换装页缩略图（≤512 方图）。

    ⚠️ 不再用"把 25 个部件按坐标拼出来的渲染图"：那张图会把她的头发、半截腿、错位的裙摆
    叠在一起 —— 用户实测原话："多张图重叠在一起，直接放个服装图都行，不需要人出镜"。
    现在直接取生成图里的衣服区域（头以上不要、膝盖以下不要），干净、就是这套衣服本身。
    """
    vx, vy, _, _ = model["view"]
    boxes = []
    for p in model["parts"]:
        if p["tex"] in names:
            x, y, w, h = p["box"]
            boxes.append(((x - vx) * SCALE, (y - vy) * SCALE, (x - vx + w) * SCALE, (y - vy + h) * SCALE))
    if not boxes:
        return aligned.convert("RGB").resize((512, 512), Image.LANCZOS)
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    box = (int(max(0, x0 - mx)), int(max(0, y0 - my)), int(min(aligned.width, x1 + mx)), int(min(aligned.height, y1 + my)))
    crop = aligned.crop(box)
    side = max(crop.size)
    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255))
    canvas.alpha_composite(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    return canvas.convert("RGB").resize((512, 512), Image.LANCZOS)


def outfit_crop(im, side_ratio=0.62):

    """衣服特写方图（换装页缩略图）——脸是运行时画的，整身图会"没脸"，所以取躯干。"""
    a = np.asarray(im.convert("RGBA"))[..., 3]
    ys, xs = np.where(a > 40)
    if not len(xs):
        return im.convert("RGB")
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    hh = y1 - y0 + 1
    cy = int(y0 + hh * 0.62)
    side = int(max(x1 - x0, hh * side_ratio) * 1.05)
    cx = (x0 + x1) // 2
    crop = Image.new("RGBA", (side, side), (255, 255, 255, 255))
    crop.alpha_composite(im.crop((int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2))))
    return crop.convert("RGB").resize((512, 512), Image.LANCZOS)


def cut_sprite(path, inset=0.08):
    """把生成图里的角色抠成**透明精灵**（趴睡用）。"""
    im = Image.open(path).convert("RGBA")
    m, im = fg_mask(im, inset=inset)
    ys, xs = np.where(m)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pad = int(max(x1 - x0, y1 - y0) * 0.04)
    crop = im.crop((max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)))
    mm, _ = fg_mask(crop)
    rgb = np.asarray(crop.convert("RGB"))
    rgb2 = inpaint(rgb, mm, rounds=6)
    return Image.fromarray(np.dstack([rgb2, (mm * 255).astype(np.uint8)]), "RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--stand", required=True)
    ap.add_argument("--sit")
    args = ap.parse_args()

    model = json.loads((WHALE / "model.json").read_text(encoding="utf-8"))
    by_tex = {p["tex"]: p for p in model["parts"]}
    base = model_render(model)
    out_dir = WHALE / "schemes" / args.id
    tex_dir = out_dir / "tex"
    tex_dir.mkdir(parents=True, exist_ok=True)

    log = {"id": args.id, "replaced": [], "transparent": []}

    # --- 站姿 ---
    aligned, s, off = align_to_model(args.stand, base)
    log["stand_scale"], log["stand_offset"] = round(float(s), 3), [round(float(off[0])), round(float(off[1]))]
    for name in NEW_SHAPE_PARTS:
        if name not in by_tex:
            continue
        orig_path = WHALE / "tex" / f"{name}.png"
        if not orig_path.exists():
            continue
        part = make_part(orig_path, part_box_in_base(by_tex[name], model), aligned)
        if part is None:
            shutil.copyfile(orig_path, tex_dir / f"{name}.png")
            continue
        part.save(tex_dir / f"{name}.png")
        log["replaced"].append(name)
    # 其余部件照抄基础目录
    for p in model["parts"]:
        dst = tex_dir / f"{p['tex']}.png"
        if dst.exists():
            continue
        src = WHALE / "tex" / f"{p['tex']}.png"
        if src.exists():
            shutil.copyfile(src, dst)

    # --- 坐姿：裙摆 + 腰饰 ---
    if args.sit:
        sit_img, _, _ = align_to_model(args.sit, base)
        for name in SIT_PARTS:
            if name not in by_tex:
                continue
            orig_path = WHALE / "tex" / f"{name}.png"
            """
            ★★ **坐姿部件：只换"布料像素"，腿/袜子/鞋保留原版**（2026-10-10 用户实测"腿没了"之后改）。
            关键事实：**原画里 `skirt_sit.png` 这张本身就画着她的腿、白袜和鞋** ——
            所以 `figure.js` 坐下时会把独立的 `leg_front/leg_back` 淡出（第 556 行），
            全靠这张图给出坐姿的下半身。所以：
              · **不能**整张换（腿会被涂成格子 → 用户看到"腿没了"）；
              · **也不能**从坐姿生成图采样（会把尾巴的青色搬进来 → 上一版的问题）。
            现在：以原版 `skirt_sit` 为底，**只把"布料像素"（蓝/深色）换成对应站姿那张的花纹**，
            肤色/白袜/鞋/阴影一律照原样保留。
            """
            stand_src = tex_dir / f"{name.replace('_sit', '')}.png"
            part = None
            if orig_path.exists() and stand_src.exists():
                base_part = Image.open(orig_path).convert("RGBA")
                newc = Image.open(stand_src).convert("RGBA").resize(base_part.size, Image.LANCZOS)
                ba = np.asarray(base_part).astype(np.float32) / 255.0
                rgb, al = ba[..., :3], ba[..., 3]
                mxx, mnn = rgb.max(axis=-1), rgb.min(axis=-1)
                sat_b = np.where(mxx > 0, (mxx - mnn) / np.maximum(mxx, 1e-6), 0)
                rr, gg, bb = rgb[..., 0], rgb[..., 1], rgb[..., 2]
                dd = np.maximum(mxx - mnn, 1e-6)
                hh = np.zeros_like(mxx)
                q1 = mxx == rr
                hh[q1] = ((gg - bb) / dd)[q1] % 6
                q2 = (mxx == gg) & (mxx != rr)
                hh[q2] = ((bb - rr) / dd)[q2] + 2
                q3 = (mxx == bb) & (mxx != rr) & (mxx != gg)
                hh[q3] = ((rr - gg) / dd)[q3] + 4
                hh *= 60.0
                fabric = ((hh > 190) & (hh < 260) & (sat_b > 0.18)) | (mxx < 0.42)   # 蓝/深色 = 布料
                out = np.asarray(newc).astype(np.uint8).copy()
                out[..., :3] = np.where(fabric[..., None], out[..., :3], np.asarray(base_part)[..., :3])
                out[..., 3] = (al * 255).astype(np.uint8)                            # 轮廓照原版（腿/袜都在）
                part = Image.fromarray(out, "RGBA")
            if part is None:
                # 生成图里没有对应形状（比如校服没有围裙）→ 给一张**全透明**，
                # 坐下时就不会露出原版那条围裙
                orig = Image.open(orig_path).convert("RGBA")
                Image.new("RGBA", orig.size, (0, 0, 0, 0)).save(tex_dir / f"{name}.png")
                log["transparent"].append(name)
            else:
                part.save(tex_dir / f"{name}.png")
                log["replaced"].append(name)

    # --- 睡姿精灵 + 毯子位预留 ---

    # --- feat 整套照抄（少一张 loadScheme 会整批失败）---
    feat_dst = out_dir / "feat"
    feat_dst.mkdir(parents=True, exist_ok=True)
    for f in sorted((WHALE / "feat").glob("*.png")):
        shutil.copyfile(f, feat_dst / f.name)

    # --- 预览 + 换装页缩略图 ---
    prev = Image.new("RGBA", base.size, (0, 0, 0, 0))
    for p in sorted(model["parts"], key=lambda p: p.get("z", 0)):
        src = tex_dir / f"{p['tex']}.png"
        if not src.exists():
            src = WHALE / "tex" / f"{p['tex']}.png"
        if not src.exists():
            continue
        vx, vy, _, _ = model["view"]
        x, y, w, h = p["box"]
        im = Image.open(src).convert("RGBA").resize((max(1, int(w * SCALE)), max(1, int(h * SCALE))), Image.LANCZOS)
        prev.alpha_composite(im, (int((x - vx) * SCALE), int((y - vy) * SCALE)))
    white = Image.new("RGBA", prev.size, (255, 255, 255, 255))
    white.alpha_composite(prev)
    white.convert("RGB").save(ART / f"_outfit-{args.id}.jpg", quality=95)
    garment_crop(aligned, model).save(out_dir / "preview.png")

    log["tex_files"] = len(list(tex_dir.glob("*.png")))
    log["feat_files"] = len(list(feat_dst.glob("*.png")))
    print(json.dumps(log, ensure_ascii=False))


if __name__ == "__main__":
    main()
