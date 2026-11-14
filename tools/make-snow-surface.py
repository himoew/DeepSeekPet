"""
算出"她身上能落雪/落雨的那条线"—— `whale/surface.json`（自动生成，别手改）。

## 为什么需要它

天气粒子原来用 `pet-core` 的**两个判定圆**（`hitPet`，本意是"点得到的范围"）当她的身体：
那是**以 x=128 对称的两个圆**，而她的画是 **3/4 侧身、整体不居中** —— 实测（2026-10-11）：

  · 圆覆盖的格子里 **23% 是空气**（在她头两侧、右侧、脚边）；
  · 真跑 180 秒雪，把落点换算回她的本地坐标：**73.5% 落在她身上之外** ——
    用户实测的原话就是"积雪效果是不同大小的白点，确实不好看"，根因在这儿。

所以按她**自己的美术资源**算一条真实的"顶面曲线"：把 25 张图层按 `model.json` 的 `box`
在**静止姿态**下拼起来（rig 单位，1 单位 = 1px），再取**每列最上面那个不透明像素**。
下落的东西（雪片、雨滴）总是先撞到它 —— 这就是"落到真实图像上"。

## 什么时候要重跑

**重导美术资源、改 `model.json` 的 `box` / `view`、换 `tex/*.png` 之后** ——
这个文件是**生成物**，不会自己跟着变（跟 `figure.js` 里 `FACE`/`HEAD` 那批常量同一个坑，
见 HANDOVER 第 1.24 节）。跑：

    python tools\\make-snow-surface.py            # 生成 surface.json
    python tools\\make-snow-surface.py --ascii    # 顺便在终端打一张剪影，肉眼核对

## 已知的取舍（都是故意的）

  · **静止姿态**：她走路/呼吸/歪头时图层会动，所以这条线会差几个单位（≤2px@S=0.42）。
    要更准就得每帧读她的 GPU 像素 —— 那是另一个量级的事，先不做。
  · **按列取顶面** = "从上往下第一个不透明像素"：落下的一颗粒子在这个列上一定先撞到它，
    所以对"下落"这件事它是**精确**的（哪怕她两腿之间是空的：那一列的顶面是她的头顶）。
  · `alpha > 32` 才算有内容：抗锯齿边缘（alpha 1~30）不参与，免得把轮廓算胖一圈。
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WHALE = os.path.join(HERE, '..', 'resources', 'app', 'web', 'whale')
OUT = os.path.join(WHALE, 'surface.json')

STEP = 2                 # 采样步长（rig 单位）：2 → 141 个数，够细又不占地方
ALPHA_MIN = 32           # 高于它才算"有内容"
ANCHOR_X = [128, 72, 186]  # 雪帽的三个位置：头顶 + 左鳍 / 右鳍那一带（y 从顶面取）
ANCHOR_LEN = 26          # 雪帽的基准直径（rig 单位；渲染时按她的体型倍率缩放）


def main():
    model = json.load(open(os.path.join(WHALE, 'model.json'), encoding='utf-8'))
    vx, vy, vx1, vy1 = model['view']
    W, H = int(round(vx1 - vx)), int(round(vy1 - vy))

    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    used, missing = 0, []
    for part in sorted(model['parts'], key=lambda p: p.get('z', 0)):
        path = os.path.join(WHALE, 'tex', part['tex'] + '.png')
        if not os.path.exists(path):
            missing.append(part['tex'])
            continue
        img = Image.open(path).convert('RGBA')
        x, y, w, h = part['box']
        size = (max(1, int(round(w))), max(1, int(round(h))))
        if img.size != size:
            img = img.resize(size, Image.LANCZOS)
        canvas.alpha_composite(img, (int(round(x - vx)), int(round(y - vy))))
        used += 1
    if missing:
        print('缺贴图的部件（已跳过）：%s' % ', '.join(missing))

    alpha = canvas.getchannel('A')
    px = alpha.load()

    xs = list(range(int(vx), int(vx1) + 1, STEP))
    top, bot = [], []
    for x in xs:
        col = x - vx
        t = b = None
        if 0 <= col < W:
            for row in range(H):
                if px[col, row] > ALPHA_MIN:
                    t = row + vy            # 换回 rig 单位
                    break
            for row in range(H - 1, -1, -1):
                if px[col, row] > ALPHA_MIN:
                    b = row + vy
                    break
        top.append(None if t is None else int(round(t)))
        bot.append(None if b is None else int(round(b)))

    covered = [t for t in top if t is not None]
    if not covered:
        print('！！一列都没有内容 —— 贴图路径/box 单位搞错了（零件框是 rig 单位，不是 master 像素）')
        return 1

    anchors = []
    for ax in ANCHOR_X:
        i = min(range(len(xs)), key=lambda k: abs(xs[k] - ax))
        if top[i] is None:
            print('警告：锚点 x=%d 那一列没有内容，跳过' % ax)
            continue
        anchors.append([xs[i], top[i]])

    data = {
        'note': '自动生成，别手改：跑 tools/make-snow-surface.py（重导美术/改 model.json 之后必须重跑）',
        'src': 'whale/model.json 的 parts[].box + whale/tex/*.png（静止姿态拼起来）',
        'view': model['view'],
        'x0': int(vx), 'x1': int(vx1), 'step': STEP,
        'alphaMin': ALPHA_MIN,
        'top': top,
        'bot': bot,
        'anchors': anchors,
        'anchorLen': ANCHOR_LEN,
        'coverage': {'columns': len(covered), 'total': len(top)},
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')

    print('拼了 %d 个部件 · 画布 %dx%d（rig 单位 x %d..%d, y %d..%d）' % (used, W, H, vx, vx1, vy, vy1))
    print('有内容的列 %d/%d（%.0f%%）· 顶面最高 %d、最低 %d' % (
        len(covered), len(top), len(covered) * 100.0 / len(top), min(covered), max(covered)))
    print('雪帽锚点（x, 顶面 y）：%s' % ' / '.join('(%d,%d)' % (a[0], a[1]) for a in anchors))
    print('写出 %s（%.1f KB）' % (os.path.relpath(OUT, HERE), os.path.getsize(OUT) / 1024.0))

    if '--ascii' in sys.argv:
        print('\n剪影预览（每格 4x8 单位；# = 有内容）：')
        for ry in range(int(vy), int(vy1), 8):
            line = ''
            for rx in range(int(vx), int(vx1), 4):
                hit = False
                for dx in range(4):
                    for dy in range(8):
                        c, r = rx - vx + dx, ry - vy + dy
                        if 0 <= c < W and 0 <= r < H and px[c, r] > ALPHA_MIN:
                            hit = True
                            break
                    if hit:
                        break
                line += '#' if hit else ' '
            print('%4d |%s|' % (ry, line))
    return 0


if __name__ == '__main__':
    sys.exit(main())
