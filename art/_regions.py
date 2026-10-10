# -*- coding: utf-8 -*-
"""画一张身体几何图：部件框 + 各部件中心 + 现在的锚点。

为什么要它：部位判定的坐标必须**看着实际几何**来划。原来的 REGION_AT 是把
`model.json` 里 box 的 `x+w/2, y+h/2` 当中心算的，但那张表的数字和真实 box 对不上
（例如"手"落在 y=185，而两条手臂的中心其实在 y≈161）—— 用眼睛看一遍比再算一遍可靠。

输出：art\_regions-身体几何.png

在打包的 Python 里跑：
  python art\_regions.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', 'DeepSeekPet', 'resources', 'app')
WHALE = os.path.join(APP, 'web', 'whale')
OUT = os.path.join(HERE, '_regions-身体几何.png')

VIEW = (-12, -8, 268, 272)          # 画布范围（rig 单位），来自 model.json 的 view
SCALE = 3                            # 放大倍数
W = int((VIEW[2] - VIEW[0]) * SCALE)
H = int((VIEW[3] - VIEW[1]) * SCALE)

# 当前生效的锚点（抄自 pet-app.js 的 REGION_AT，只为对比，别当真相）
CURRENT = [
    ('head', 138.1, 115.1), ('head', 130.1, 74.7), ('head', 113.8, 38.6),
    ('body', 130.6, 171.2), ('body', 128, 188.9),
    ('hand', 108.2, 185.3), ('hand', 159.2, 183.2),
    ('fin', 67.3, 121.8), ('fin', 185.4, 123.2),
    ('tail', 65.8, 192.5),
    ('low', 129, 203),
    ('foot', 112, 248), ('foot', 144, 248),
]
COLOR = {
    'head': (230, 60, 90), 'body': (40, 140, 230), 'hand': (240, 150, 20),
    'fin': (150, 80, 220), 'tail': (30, 170, 120), 'low': (200, 60, 200),
    'foot': (110, 110, 110),
}


def px(x, y):
    """rig 坐标 → 图上的像素坐标。"""
    return ((x - VIEW[0]) * SCALE, (y - VIEW[1]) * SCALE)


def main():
    from PIL import Image, ImageDraw, ImageFont
    model = json.load(open(os.path.join(WHALE, 'model.json'), encoding='utf-8'))
    parts = model['parts']
    pivots = model['pivots']

    img = Image.new('RGB', (W, H), (250, 249, 252))
    d = ImageDraw.Draw(img, 'RGBA')
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 13)
        font_s = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 11)
    except OSError:
        font = font_s = ImageFont.load_default()

    # 地面
    d.line([px(-12, 256), px(268, 256)], fill=(150, 150, 160), width=2)
    d.text((6, px(0, 258)[1]), 'soles y=256', fill=(120, 120, 130), font=font_s)

    # 部件框
    for p in parts:
        x, y, w, h = p['box']
        x0, y0 = px(x, y)
        x1, y1 = px(x + w, y + h)
        d.rectangle([x0, y0, x1, y1], outline=(190, 190, 200), width=1)
        d.text((x0 + 2, y0 + 1), p['id'], fill=(150, 150, 165), font=font_s)
        cx, cy = px(x + w / 2, y + h / 2)
        d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=(120, 170, 120))

    # pivots
    for name, (x, y) in pivots.items():
        cx, cy = px(x, y)
        d.line([cx - 5, cy, cx + 5, cy], fill=(255, 120, 0), width=1)
        d.line([cx, cy - 5, cx, cy + 5], fill=(255, 120, 0), width=1)
        d.text((cx + 6, cy - 6), 'P:' + name, fill=(210, 100, 0), font=font_s)

    # 眼睛（用 feat.eyes 的 iris 框中心，换算到 rig 坐标：master/DS 减去 X0/FEET）
    units = model['units']
    ds, x0m, feet = units['DS'], units['X0'], units['FEET']
    for k, e in model['feat']['eyes'].items():
        ix0, iy0, ix1, iy1 = e['iris']
        mx, my = (ix0 + ix1) / 2, (iy0 + iy1) / 2
        rx, ry = mx * ds - x0m, feet - my * ds
        cx, cy = px(rx, ry)
        d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], outline=(0, 120, 220), width=2)
        d.text((cx + 9, cy - 6), k, fill=(0, 120, 220), font=font_s)

    # 当前锚点
    for name, x, y in CURRENT:
        cx, cy = px(x, y)
        c = COLOR[name]
        d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=c + (255,), outline=(255, 255, 255), width=1)
        d.text((cx + 7, cy + 3), name, fill=c, font=font)

    d.text((6, 6), 'rig space, 3x | gray boxes = model.json parts | green dot = part center | '
                   'orange cross = pivot | blue ring = eye iris | colored dot = current REGION_AT anchor',
           fill=(60, 60, 70), font=font_s)
    img.save(OUT)
    print('saved', OUT, img.size)

    # 顺手把"部件框图"的文字版也打出来，便于核对数字
    print('\n部件中心（rig 坐标）：')
    for p in sorted(parts, key=lambda q: q['box'][1]):
        x, y, w, h = p['box']
        print('  %-22s center=(%6.1f,%6.1f) box=(%.1f,%.1f,%.1f,%.1f)' % (p['id'], x + w / 2, y + h / 2, x, y, w, h))
    print('\npivots：')
    for k, v in pivots.items():
        print('  %-10s (%.1f,%.1f)' % (k, v[0], v[1]))
    print('\n眼睛（iris 中心 → rig）：')
    for k, e in model['feat']['eyes'].items():
        ix0, iy0, ix1, iy1 = e['iris']
        print('  %-6s (%.1f,%.1f)' % (k, (ix0 + ix1) / 2 * ds - x0m, feet - (iy0 + iy1) / 2 * ds))


if __name__ == '__main__':
    main()
