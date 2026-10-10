# 桌宠素材 · 生图提示词（duck.ai 免费额度，约 50 张/天，最大 1k）

> 用法：一次生成**一整张多格图**（3×3 = 9 个方案），别一张一张要。
> 所有图都存到 `art/`，命名 `sheet-<字母>-<内容>.jpg`。
> 生成器：https://duck.ai/ → 左侧「新图像」→ 输入框出现「创建图像」→ 点「创建」。

## 风格锁（每条提示词都带上，保证同一套美术）

```
Art style: Japanese chibi anime mascot, super-deformed proportions (about 2.5 heads tall, big head,
tiny body), thick clean dark-navy outlines, flat cel shading with soft gradients only in the hair,
saturated deep blue + white + pastel accents, clean sticker look, no texture, no rendering noise,
no harsh shadows, no background scenery.
Character: the same character in every panel - a chibi girl with long wavy deep navy-blue hair
fading to light cyan at the tips, one large ahoge cowlick curl on top of the head, a white frilly
lace headband with a small blue ribbon bow, pointed fin-like ears at the sides of her head, a small
blue whale tail with a fluke behind her, big glossy blue eyes, pink blush, tiny smile.
```

## ★ 最强的一招：**把 `icon-source.png` 当参考图一起发**

duck.ai 支持附图（`input[type=file]` 可以 `setInputFiles` 直接喂）。**实测差别很大**：
纯文字描述出来的是"现代动漫插画"（细描边、大量气刷渐变、深藏蓝头发、纯白背景无表情）；
**附上我们的原图**之后出来的是**闭眼笑 ^_^、粗描边、纯平涂、头更大** —— 基本就是实装那一套。

推荐句式（开头必须点明参考图的地位）：

```
The attached image is my character and my ART STYLE reference. Copy that exact style: very thick
bold uniform dark-navy outlines, completely FLAT cel colors with only one simple two-tone fade at
the hair tips, simplified chunky shapes, huge head, tiny body, plain white background, no cast
shadow, no texture, clean sticker-like look.
Now draw a NEW single square sheet: a neat 3x3 grid of 9 equal panels ...
```

## ★ 配色锁（2026-10-10 用 `tools\palette-compare.py` 量出来的差距，写进提示词用）

实测（基准 = `web\whale\tex` 25 张实装贴图；生成图 = 上面那批）：

| 色带 | 实装 S / V | 生成图 | 差在哪 |
|---|---|---|---|
| 蓝（主色，占 70%） | 0.686 / **0.675** | 0.73 / **0.40** | 生成图**太暗**（深藏蓝 vs 亮宝蓝） |
| 青蓝（发梢亮部） | **0.627** / 0.980 | 0.38 / 0.90 | 生成图**发灰**（欠饱和） |
| 皮肤 | 0.146 / 0.992 | 0.21~0.33 / 0.87 | 生成图**偏红偏暗** |
| 白（围裙/头饰） | 0.027 / 0.992 | 0.01 / 0.97 | 基本一致 |

所以提示词里要**点名颜色**，别只说"blue"：

```
Her palette, exactly: the main hair and dress blue is a BRIGHT saturated royal blue
(mid-tone about #4A6FD0, shadow about #2B3F8F) - NOT a dark dull navy; the hair fades at the tips
to a BRIGHT SATURATED light cyan-blue (about #8FE3FF), never gray or washed out; the apron,
headband and socks are PURE WHITE; her skin is very pale pink-white (about #FDEFF2) with a light
blush; the outlines are a dark navy (about #1B2559) and stay thin-but-bold. Keep the whole image
bright and vivid, high chroma, no muddy or grayish tints.
```

**即使用了这段，也要再过一遍 `tools\match-palette.py`**（见下）——
生成模型的"暗部/亮部"习惯改不动，校色那一步才是最后 10%。

## ★ 打光锁（2026-10-10 用 `tools\tone-profile.py` 量出来的，比颜色差得更多）

看**蓝色像素的明度分布**（L2 暗部 / L3 中间调 / L4 亮部 / L5 高光，以及"高光比"=(L4+L5)/(L2+L3)）：

| 图 | L2 | L3 | L4 | L5 | 高光比 |
|---|---|---|---|---|---|
| 实装 `web\whale\tex\hair_back.png`（真头发贴图） | 5.2% | 16.5% | **52.9%** | **21.2%** | **3.42** |
| 实装 `web\icon-source.png` | 15.3% | 26.8% | **44.0%** | 13.7% | **1.37** |
| 生成（纯文字版 A2，已校色） | 10.1% | 20.1% | 46.0% | 13.9% | 1.98 |
| 生成（参考图版 B2，已校色） | 9.3% | **67.7%** | 5.2% | 7.7% | **0.17** |

结论：**我们的头发是"高调"的** —— 大面积亮蓝（L4+L5 占六到七成），深藏蓝只做小面积硬边暗部，
再压一条**硬边青色高光带**；生成的是**中间调糊成一坨**（B2 有 68% 落在 L3）。
`match-palette.py` 只能挪均值、**造不出高光带**，所以必须在提示词里点明打光。

```
LIGHTING AND TONE (the most important part): high-key and luminous. The big mass of her hair must be
BRIGHT light royal blue (value 0.70-0.80), the deep navy appears ONLY as a hard-edged shadow shape
(about 10% of the hair area, near the roots and under the bangs), plus a HARD-EDGED bright cyan-white
glossy highlight band running across the top of the hair (value 0.95 or more, with a clean crisp
edge). Bright areas dominate, dark areas are small accents. Absolutely no large dark-navy mass,
no muddy mid-tones, no soft shading. Only 2 flat tones plus 1 highlight band per material.
```

**验收标准**：`tone-profile.py` 量出来的**只算蓝**那一块，L4+L5 应在 **55%~75%**、高光比 **1.3~3.5**；
若 L3 超过一半、高光比 < 0.5，就是"糊了"，提示词里把 high-key 那三句再加重再出一张。


## 今日战果（2026-10-10，额度用完为止）

duck.ai 的生图模型是 **GPT Image 2**；额度是**全局**的（提示原文"已达到每日限额 · 24h 后重置"），
今天一共出了 **8 张**（开新对话也不重置）。

| 文件 | 内容 | 状态 |
|---|---|---|
| `sheet-a-outfits-9.jpg` | 服装海选 9 套 | 纯文字版（风格偏现代插画），**已被 A2 取代** |
| `sheet-a2-outfits-refstyle.jpg` (+`-graded`) | 服装海选 9 套（**挂了参考图**） | 风格接近实装，打光仍偏中间调 |
| **`sheet-a3-outfits-highkey-raw/-highkey.jpg`** | **新 9 套服装（参考图 + 打光锁）** | ★ **最佳**：层次指标与实装打平 |
| `sheet-b-maid-turnaround.jpg` | 原版女仆装模型表 | 纯文字版，下排串格 |
| **`sheet-b2-turnaround-raw/-graded.jpg`** | **模型表（参考图版）** | ★ 正/侧/背/三分之四 + 头特写 + **围裙大图（鲸鱼 logo）** |
| `sheet-c-torso-outfits-graded.jpg` | 上身+裙摆 9 套（替换部件用） | 已校色 |
| `sheet-d-poses-graded.jpg` | 9 个新动作 | 已校色，格子干净 |
| `sheet-e-expressions-graded.jpg` | 9 个表情特写 | ★ 用户评："脸部表情还行（但别用生成的头发）" |
| `_cmp-*.jpg` | 各张的**左原图 / 右校色**并排 | 验收用 |

**★ 确认有效的配方**（A3 那次）：**参考图（`web\icon-source.png`）+ 风格锁 + 配色锁 + 打光锁**。
量化验收（`tone-profile.py`，只看蓝色像素）：

| | L3 中间调 | L4 亮部 | L5 高光 | 高光比 |
|---|---|---|---|---|
| 实装 `hair_back.png` | 16.5% | 52.9% | 21.2% | 3.42 |
| A2（无打光锁） | 20.1% | 46.0% | 13.9% | 1.98 |
| **A3（有打光锁）** | 9.5% | 22.9% | **47.4%** | **3.43** ✓ |

**校色要分情况**：A3 这类（打光锁已把亮度顶上来的）**只做半量** `--boost 0.4`
（全量会过亮：蓝 V 0.780 → 超过实装 0.675）；A2/B2 那类（闷、中间调为主）用全量 `--boost 1.0`。

## 明天 / 换服务后直接用：待生成的提示词（三段锁已经写进去）

**F · 桌面道具 9 个**（把最后一段换成）：

```
Now draw a NEW single square sheet: a neat 3x3 grid of 9 equal panels separated by thin light-gray
dividers, plain white background, no text, no numbers, no watermark. There is NO character in any
panel - only ONE cute isolated object per panel, drawn in exactly that same style and palette, each
object centred and fully inside its own cell: (1) a small round glass fish tank with a tiny blue whale
swimming inside. (2) a small potted plant with a few leaves. (3) a yellow sticky note with a pin.
(4) a pet food bowl with fish-shaped cookies. (5) a glass of water. (6) a small open umbrella.
(7) a stack of two books. (8) a blue ball. (9) a round cushion.
```

**G · 第二只桌宠**（换配色，别的锁保留）：

```
Same art style, same chibi proportions and same lighting as the reference, but a DIFFERENT companion:
a chibi girl with short fluffy coral-orange hair, a small fox tail with a white tip, round animal ears,
amber eyes, wearing a light cream hoodie with a fish print. 2x2 grid of 4 panels: (1) front view full
body. (2) side view full body. (3) back view full body. (4) head close-up.
```

**H · 小世界家具 9 件**（同 F 的句式）：tiny bed / tiny desk lamp / tiny bookshelf / tiny rug /
tiny window with rain / tiny potted tree / tiny snack plate / tiny music player / tiny wall clock。

**A4 · 再海选 9 套服装**（同 A3，只换服装列表）：洛丽塔、水手泳装外搭、运动连帽衫+短裤、
和风振袖、护士、航天、蒸汽朋克、中式汉服、秋季风衣 —— 都在"高调打光 + 亮宝蓝 + 饱和青蓝"的锁下出。


```
## 出图流水线（每张都要走完）

1) 生成：duck.ai → 新图像 → 挂上 icon-source.png → 贴提示词（风格锁 + 配色锁 + 这一张的布局）
2) 取图：bcdp_script 读出 data:image，写盘成 art\sheet-xx-raw.jpg（别用会回显 base64 的方式）
3) 校色：python tools\match-palette.py art\sheet-xx-raw.jpg art\sheet-xx.jpg art\_cmp-xx.jpg
4) 验收：python tools\palette-compare.py DeepSeekPet\resources\app\web\whale\tex art\sheet-xx.jpg
         （看 ΔV(蓝) 是否接近 0、ΔS(青蓝) 是否接近 0）
```


## A. 服装海选 9 套（已生成 `sheet-a-outfits-9.jpg`）

3×3 网格，每格同一角色、同一姿势、不同衣服：冬季大衣+围巾耳罩 / 睡衣睡帽抱枕 / 黄色雨衣+伞 /
水手服 / 猫耳薄荷卫衣 / 鲸鱼纹浴衣+扇子 / 运动服 / 礼服+头冠 / 厨师围裙+帽。

## B. 原版女仆装·模型表（正/侧/背/三分之四 + 头特写 + 围裙图案）

```
A single square character model sheet, clean 2x3 grid of 6 panels with thin light-gray dividers,
plain flat white background, no text, no numbers, no watermark.
In all panels: the SAME chibi anime girl mascot wearing her DEFAULT outfit: a navy-blue maid dress
with a white frilled apron that has a tiny whale logo on the skirt front, puffy short sleeves with
white lace, a dark navy collar with a small blue gem, a white frilled hem, a long white frilly
headband with a small blue ribbon bow, white knee socks, navy mary-jane shoes with blue sparkles,
and a blue whale tail with a fluke behind her.
[风格锁 + 角色锁]
Panels: (1) front view, full body, arms at her sides, neutral. (2) side view facing right, full body.
(3) back view, full body (long hair and the whale tail visible). (4) three-quarter front view, full body.
(5) close-up of her head from the front (face, headband, fin ears, ahoge). (6) close-up of the apron
and skirt front showing the tiny whale logo. Keep proportions and colors identical in every panel.
```

## C. 上身+裙摆·9 套（**裁下来替换部件**用）

```
A single square image, 3x3 grid of 9 panels, thin light-gray dividers, plain flat white background,
no text. In EVERY panel: the same chibi mascot CROPPED FROM THE NECK DOWN TO THE HIPS (head not
visible, legs not visible below the knee), front view, arms at her sides, identical pose and identical
scale - a clothing reference for her upper body only. The 9 panels show 9 different torso-and-skirt
outfits: (1) navy maid dress with a white frilled apron. (2) navy duffel coat with a red-and-white
striped scarf. (3) light blue striped pajama top. (4) yellow raincoat. (5) white sailor blouse with a
navy pleated skirt and a red neckerchief. (6) oversized mint-green hoodie. (7) light blue yukata with a
white whale pattern and an obi sash. (8) blue and white track jacket. (9) navy dress with white frills.
Thick clean outlines, flat cel shading, same pose and same camera in every panel.
```

## D. 新动作 9 个（完整人物，原版服装，白底）

```
A single square image, 3x3 grid of 9 panels, thin light-gray dividers, plain flat white background,
no text. In every panel the SAME chibi mascot (original maid outfit) doing a different action:
(1) lying on her back asleep, eyes closed. (2) standing and stretching both arms up high.
(3) yawning with one hand over her mouth. (4) rubbing her eyes sleepily. (5) hugging a small blue ball
with both arms. (6) sitting on the floor with her knees up. (7) curled up asleep on her side.
(8) waving one hand. (9) holding a small cup with both hands. Same character, same colors,
same scale in every panel.
```

## E. 表情特写 9 个（大头正面，给表情系统当参考）

```
A single square image, 3x3 grid of 9 panels, thin light-gray dividers, plain flat white background,
no text. In every panel: a large head-and-shoulders close-up of the SAME chibi girl, front view,
identical head angle, identical size, identical hair and headband. The 9 panels show 9 different
facial expressions: (1) neutral, open eyes, tiny smile. (2) happy closed-eye smile. (3) winking with
one eye. (4) heart-shaped eyes, in love. (5) shy, blushing, looking away. (6) surprised, wide eyes,
open mouth. (7) angry pout with puffed cheeks. (8) sad, teary eyes. (9) sleepy, half-closed eyes.
```

## F. 桌面道具 9 个（同风格，白底，无角色）

```
A single square image, 3x3 grid of 9 panels, thin light-gray dividers, plain flat white background,
no text. Each panel contains ONE cute isolated prop drawn in the same chibi style (thick dark-navy
outlines, flat cel shading, blue + white + pastel): (1) a small round fish tank with a tiny whale
inside. (2) a small potted plant. (3) a yellow sticky note with a pin. (4) a pet food bowl with
fish-shaped cookies. (5) a glass of water. (6) a small open umbrella. (7) a stack of two books.
(8) a blue ball. (9) a round cushion. Nothing else in the panels, clean isolated objects.
```

## G. 第二只桌宠（同风格、不同配色与性格）4 格

```
A single square character sheet, 2x2 grid of 4 panels, thin dividers, plain flat white background.
Same art style and same chibi proportions as the first character, but a DIFFERENT companion:
a chibi girl with short fluffy coral-orange hair, a small fox-like tail with a white tip,
round animal ears, amber eyes, wearing a light cream hoodie with a fish print.
Panels: (1) front view full body. (2) side view full body. (3) back view full body.
(4) head close-up. Consistent design in all panels.
```

## H. 房间/桌面小世界 9 格（给"桌面小世界"当参考）

```
A single square image, 3x3 grid of 9 panels, thin dividers, plain white background: 9 cute tiny
desktop-scene props in the same chibi style - a tiny bed, a tiny desk lamp, a tiny bookshelf,
a tiny rug, a tiny window with rain, a tiny potted tree, a tiny snack plate, a tiny music player,
a tiny wall clock. Isolated objects, thick outlines, blue and white pastel palette.
```
