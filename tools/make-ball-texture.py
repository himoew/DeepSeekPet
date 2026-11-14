"""
把用户给的球贴图抠成一张能直接用的 PNG（透明背景、居中、正方形）。

**为什么要抠**：原图是白底 + 一点接触阴影，直接贴会带一个白方块。
**为什么不用"从角落 flood fill"**：白底是平滑渐变，容差填充碰到渐变就停了，
第一版 91% 的像素都被当成球，等于没抠（实测）。所以改成按"离纯白多远"分类。

坑（都踩过，改的时候注意）：
  - 裁剪框会**越界**（球几乎占满整张图），越界时必须给 rgb 和 alpha **同时**补同样的边，
    否则 `putalpha` 会因为尺寸不一致直接抛 "images do not match"；
  - 不要用"球面形状/圆"去挖 mask：球面本身是浅灰的，形状法会把球面挖掉；
    球的深色像素里又混着底部接触阴影，估出来的圆半径会偏大（实测 r=190 而图只有 350 宽）。
"""
import sys

import numpy as np
from PIL import Image, ImageFilter

# 离纯白多近算背景：白底≈255、浅灰渐变≈235、接触阴影≈200 上下
WHITE_NEAR = 26
# 一定算"内容"的暗度（球的深色缝线）
DARK = 150
SIZE = 256
# 边缘内缩（像素）：按行填充会在球的左右两侧留一条很细的背景边，缩掉它
INSET = 2


def largest_component(mask):
    """mask 里最大的四连通块（球 + 缝线整体；噪点被丢掉）。"""
    from collections import deque
    h, w = mask.shape
    seen = np.zeros_like(mask, bool)
    best, best_n = np.zeros_like(mask, bool), 0
    for sy in range(h):
        row = np.nonzero(mask[sy])[0]
        for sx in row:
            if seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            comp = []
            while q:
                y, x = q.popleft()
                comp.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(comp) > best_n:
                best_n = len(comp)
                best = np.zeros_like(mask, bool)
                ys = [p[0] for p in comp]
                xs = [p[1] for p in comp]
                best[ys, xs] = True
    return best


def main(src, dst):
    im = Image.open(src).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    h, w, _ = a.shape

    # 1) 内容 = 不是"接近白"的像素；再并上深色像素（球面最亮处可能被误判成背景）
    near_white = (255 - a).max(axis=2) <= WHITE_NEAR
    dark = a.sum(axis=2) < DARK * 3
    ball = largest_component(~near_white | dark)

    ys, xs = np.nonzero(ball)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()

    # 2) **拟合"球"这个圆**，再按圆取 mask。
    #    为什么非要拟合：球的底下有一团接触阴影（比如 (0,260) 处是 rgb(87,87,87)），
    #    它不是"接近白"，任何颜色分类都会把它算成球 —— 按行填充就会在左侧留下一条背景边
    #    （第一版就是这样）。球的**顶边**是干净的半圆（上面没有阴影），用它拟合最稳。
    top_pts = []
    for x in range(x0, x1 + 1):
        col = np.nonzero(ball[:, x])[0]
        if len(col):
            top_pts.append((x, col.min()))
    pts = np.array([p for p in top_pts if p[0] > x0 + 8 and p[0] < x1 - 8], float)
    # 圆方程 (x-cx)^2 + (y-cy)^2 = r^2 展开成线性最小二乘：x^2+y^2 = 2cx*x + 2cy*y + (r^2-cx^2-cy^2)
    A = np.c_[pts[:, 0], pts[:, 1], np.ones(len(pts))]
    b = (pts ** 2).sum(axis=1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = sol[0] / 2, sol[1] / 2
    r_fit = float(np.sqrt(sol[2] + cx * cx + cy * cy))
    # 拟合只用顶边，半径略收一点（顶边是"最外缘"，直接当半径会连阴影一起框进来）
    r = r_fit * 0.995
    print(f'fitted circle center=({cx:.1f},{cy:.1f}) r={r_fit:.1f} -> 采用 r={r:.1f}')

    half = r + 2
    x0c, y0c = int(round(cx - half)), int(round(cy - half))
    x1c, y1c = int(round(cx + half)), int(round(cy + half))

    # 4) 越界时在**同一块画布**里平移（保证 rgb 与 alpha 尺寸永远一致）
    pad_l, pad_t = max(0, -x0c), max(0, -y0c)
    pad_r, pad_b = max(0, x1c - w), max(0, y1c - h)
    S = (x1c - x0c) + 0
    S = max(S, (y1c - y0c))
    x0s, y0s = x0c + pad_l, y0c + pad_t
    x1s, y1s = min(w, x1c + pad_l), min(h, y1c + pad_t)

    rgb = Image.new('RGB', (S, S), (250, 250, 250))
    rgb.paste(im.crop((x0s, y0s, x1s, y1s)), (pad_l, pad_t))

    # 5) 圆形 mask（在这个裁剪坐标系里画圆），边缘给 1.2px 过渡
    yy, xx = np.mgrid[0:S, 0:S]
    d = np.hypot(xx - (cx - x0c), yy - (cy - y0c))
    alpha_np = np.clip(r - d + 0.6, 0, 1) * 255
    al = Image.fromarray(alpha_np.astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(0.6))

    out = rgb.convert('RGBA')
    out.putalpha(al)
    out = out.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(dst)
    print(f'crop=({x0c},{y0c})-({x1c},{y1c}) S={S} -> {dst} {out.size}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
