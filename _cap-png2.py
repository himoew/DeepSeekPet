"""
临时对照图（**不提交**）：把积雪按**逐像素解析合成**画出来 —— 跟 `fx.js` 同一套几何与色标。

为什么不用 PIL 画椭圆/降采样：那一步会把"一枚 3px 笔触"的软边吞掉（试过，出来的是孤立亮点），
而这一版的关键恰恰是**几十枚低 alpha 笔触叠出来的一层**。所以这里对每个像素直接算：

    对每一枚笔触：r = hypot((x-cx)/rx, (y-cy)/ry)
    a(r) = 1.0                r <= .30
           1 - (r-.30)/.32*.58   r <= .62
           .42*(1-(r-.62)/.38)   r < 1
    再按 alpha 累加（source-over）→ 雪的覆盖率

她的形状来自 surface.json 的每列 top/bot（跟 `make-snow-surface.py` 同一份数据）。
跑法：node _cap-dump.cjs | Set-Content _cap-dump.json -Encoding UTF8; python _cap-png2.py
"""
import json
import math
from PIL import Image, ImageDraw

DUMP = json.load(open('_cap-dump.json', encoding='utf-8-sig'))
SURF = DUMP['surface']
CAPS = DUMP['caps']

SCALE = 2          # 出图放大
PAD = 10
X0, X1 = SURF['x0'], SURF['x1']
Y0, Y1 = -8, 268
W = X1 - X0 + PAD * 2
H = Y1 - Y0 + PAD * 2


def stamp_alpha(r):
    if r <= .30:
        return 1.0
    if r <= .62:
        return 1.0 - (r - .30) / .32 * (1.0 - .42)
    if r < 1.0:
        return .42 * (1.0 - (r - .62) / .38)
    return 0.0


def build(mode):
    """返回 (雪覆盖率, 阴影覆盖率)，都是 W×H 的 float 列表。"""
    snow = [0.0] * (W * H)
    shade = [0.0] * (W * H)

    def put(buf, x, y, a):
        if a <= 0 or x < 0 or y < 0 or x >= W or y >= H:
            return
        i = y * W + x
        buf[i] = buf[i] + a * (1.0 - buf[i])          # source-over

    if mode == 'new':
        for q in DUMP['new']:
            if q['shape'] == 'cap':
                cx, cy = q['lx'] - X0 + PAD, q['ly'] - Y0 + PAD
                rx, ry = q['len'] / 2 * q['sx'], q['len'] / 2 * .78
                op = q['op']
                for y in range(max(0, int(cy - ry) - 1), min(H, int(cy + ry) + 2)):
                    for x in range(max(0, int(cx - rx) - 1), min(W, int(cx + rx) + 2)):
                        r = math.hypot((x - cx) / rx, (y - cy) / ry)
                        a = stamp_alpha(r) * op
                        if a > .002:
                            put(snow, x, y, a)
            elif q['shape'] == 'band':
                x1, y1 = q['x1'] - X0 + PAD, q['y1'] - Y0 + PAD
                x2, y2 = q['x2'] - X0 + PAD, q['y2'] - Y0 + PAD
                buf = shade if str(q.get('col', '')).upper() == '#CFE0F2' else snow
                op, w = q['op'], max(1.0, q['w'])
                n = int(math.hypot(x2 - x1, y2 - y1) * 3) + 2
                for k in range(n + 1):
                    u = k / n
                    cx, cy = x1 + (x2 - x1) * u, y1 + (y2 - y1) * u
                    rad = w / 2
                    for y in range(max(0, int(cy - rad) - 1), min(H, int(cy + rad) + 2)):
                        for x in range(max(0, int(cx - rad) - 1), min(W, int(cx + rad) + 2)):
                            if math.hypot(x - cx, y - cy) <= rad:
                                # 一笔 = 一条线，同一笔画出来的地方取 max（不是叠 3 倍）
                                i2 = y * W + x
                                buf[i2] = max(buf[i2], min(1.0, op))
        return snow, shade

    # 老版：三个锚点各一枚大软片 + 一条把两顶连起来的圆头粗线（= 穿过脑袋的那条）
    for a in CAPS:
        amt = a[2]
        sc = .62 + .55 * amt
        ln = 26 * sc
        cx, cy = a[0] - X0 + PAD, a[1] + 26 * .28 * sc - Y0 + PAD
        rx = ry = ln / 2
        op = .35 + .5 * amt
        for y in range(max(0, int(cy - ry) - 1), min(H, int(cy + ry) + 2)):
            for x in range(max(0, int(cx - rx) - 1), min(W, int(cx + rx) + 2)):
                r = math.hypot((x - cx) / rx, (y - cy) / ry)
                a2 = stamp_alpha(r) * op
                if a2 > .002:
                    put(snow, x, y, a2)
    for i in range(1, len(CAPS)):
        p, q = CAPS[i - 1], CAPS[i]
        if min(p[2], q[2]) < .28:
            continue
        x1, y1 = p[0] - X0 + PAD, p[1] - Y0 + PAD
        x2, y2 = q[0] - X0 + PAD, q[1] - Y0 + PAD
        op = .3 + .35 * min(p[2], q[2])
        n = int(math.hypot(x2 - x1, y2 - y1) * 3) + 2
        for k in range(n + 1):
            u = k / n
            cx, cy = x1 + (x2 - x1) * u, y1 + (y2 - y1) * u
            for y in range(max(0, int(cy - 2)), min(H, int(cy + 2) + 1)):
                for x in range(max(0, int(cx - 2)), min(W, int(cx + 2) + 1)):
                    if math.hypot(x - cx, y - cy) <= 1.6:
                        put(snow, x, y, min(1.0, op))
    return snow, shade


def silhouette_mask():
    m = [[0] * W for _ in range(H)]
    for i, t in enumerate(SURF['top']):
        b = SURF['bot'][i]
        if t is None or b is None:
            continue
        x = SURF['x0'] + i * SURF['step'] - X0 + PAD
        for y in range(int(t) - Y0 + PAD, int(b) - Y0 + PAD + 1):
            if 0 <= y < H:
                for xx in (x, x + 1):
                    if 0 <= xx < W:
                        m[y][xx] = 1
    return m


BODY = (255, 217, 234)
EDGE = (224, 141, 179)
SKY = (27, 35, 48)
SNOW = (232, 241, 255)
SHADE = (207, 224, 242)


def render(snow, shade, sil):
    im = Image.new('RGB', (W, H), SKY)
    px = im.load()
    for y in range(H):
        for x in range(W):
            c = BODY if sil[y][x] else SKY
            a = snow[y * W + x]
            if a > 0:
                c = tuple(int(c[k] + (SNOW[k] - c[k]) * a) for k in range(3))
            s = shade[y * W + x]
            if s > 0:
                c = tuple(int(c[k] + (SHADE[k] - c[k]) * s) for k in range(3))
            px[x, y] = c
    return im


sil = silhouette_mask()

# 轮廓线（最容易看出"线有没有穿过去"）
sil_img = Image.new('L', (W, H), 0)
sd = ImageDraw.Draw(sil_img)
for y in range(H):
    for x in range(W):
        if sil[y][x]:
            sil_img.putpixel((x, y), 255)
edge = sil_img.filter(__import__('PIL.ImageFilter', fromlist=['ImageFilter']).FIND_EDGES).point(lambda v: 255 if v > 40 else 0)

old = render(*build('old'), sil)
new = render(*build('new'), sil)
for im in (old, new):
    px = im.load()
    ep = edge.load()
    for y in range(H):
        for x in range(W):
            if ep[x, y]:
                px[x, y] = EDGE

up = lambda im: im.resize((im.width * SCALE, im.height * SCALE), Image.LANCZOS)
real_w = int(W * .42)
panel = Image.new('RGB', (up(old).width * 2 + real_w * 2 + 44, up(old).height + 34), (16, 21, 28))
panel.paste(up(old), (0, 26))
panel.paste(up(new), (up(old).width + 16, 26))
panel.paste(old.resize((real_w, int(H * .42)), Image.LANCZOS), (up(old).width * 2 + 32, 26))
panel.paste(new.resize((real_w, int(H * .42)), Image.LANCZOS), (up(old).width * 2 + real_w + 48, 26))
d = ImageDraw.Draw(panel)
d.text((6, 8), 'OLD: a blob per anchor + a band between them (crosses her head)', fill=(255, 170, 170))
d.text((up(old).width + 22, 8), 'NEW: a layer stamped along her real top contour', fill=(170, 255, 200))
d.text((up(old).width * 2 + 38, 8), 'OLD @real size', fill=(255, 170, 170))
d.text((up(old).width * 2 + real_w + 54, 8), 'NEW @real size', fill=(170, 255, 200))
panel.save('_cap-compare.png')

sn, sh = build('new')
print('new: 雪峰值 %.2f / 阴影峰值 %.2f / 覆盖像素 %d' % (
    max(sn), max(sh), sum(1 for v in sn if v > .05)))
sn2, _ = build('old')
print('old: 雪峰值 %.2f / 覆盖像素 %d' % (max(sn2), sum(1 for v in sn2 if v > .05)))
