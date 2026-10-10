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

## ★ 即梦（jimeng.jianying.com）—— 已跑通的流程与结论（2026-10-10）

**结论：即梦是目前最好的渠道。** 1 积分/张（2K），中文提示词 + 挂参考图，一次出 1 张 2048² 的
**四宫格**（= 一张图里 4 套方案 → 0.25 积分/方案）。它对我们三段锁的服从度明显高于 GPT Image 2。

实测（同一套基准）：

| 指标 | 实装 | A3（GPT Image 2 调好） | **即梦 jimeng-01** |
|---|---|---|---|
| 主蓝 S | 0.686 | 0.705 | **0.693**（Δ+0.007） |
| 主蓝 V | 0.675 | 0.780 | **0.733**（Δ+0.06） |
| 发梢青蓝 S | 0.627 | 0.404 | **0.803**（比我们还饱和） |
| 白（围裙）S | 0.027 | 0.021 | **0.016** ✓ 纯白 |
| **高光比** | **3.42** | 3.43 | **3.42** ✓ |

### 操作步骤（逐步验证过的）

1. 左侧「创作」→ 底部栏最左 **「图片生成 ▾」** 选模式（**当前并不是 Agent 模式**；Agent 模式入口是另一个，不用它）；
2. 旁边 **「Seedream 4.6」** = 模型选择器；再右是 **比例/分辨率/张数**（点开：智能/1:1/3:4/16:9/4:3/9:16/2:3/3:2/21:9 + 高清 2K / 超清 4K + 1~8 张）；
   **我们的设置：1:1 + 高清 2K + 1 张 = 1 积分**（按钮上显示 `1/张`）；
3. 提示框左侧那个 **`+` 方块** = 上传参考图；底栏的 **`@`** = 引用「主体」库资产（把她的形象存成主体就能反复引用，值得试）；
4. 挂 **`art\ref-character-1024.png`**（我做的放大版），**只挂 1 张**；
5. 粘贴中文提示词（见下），点右下 **↑** 生成；
6. 出图是 **WebP**（2048²）—— `tools\match-palette.py` 用 Pillow 读，**WebP 原生支持**，流水线不用改。

### 两个要改的小地方

- **水印**：免费号出图左上角有「AI生成」水印 → 个人菜单里有 **「AI生成水印设置」**，先关掉；
- 上次操作时**重复挂了两张**同名参考图（合成 paste 事件触发了两次）—— 只留一张。

### 即梦用的中文提示词（已验证有效，直接抄）

```
2×2四宫格角色设定表，纯白背景，四格等大，浅灰线分隔，无文字无数字无水印。四格是同一个人换四套衣服、
正面站姿、同比例同景别：(1)米白针织开衫+红色贝雷帽 (2)藏蓝西装外套+格子裙校服 (3)黑白蕾丝女仆咖啡厅装
(4)浅蓝羽织配袴。角色：深蓝到浅青渐变及腰长发、头顶大呆毛、白蕾丝荷叶边发箍配蓝蝴蝶结、鳍状耳、
身后蓝色鲸鱼尾。配色：主蓝鲜亮宝蓝(中调#4A6FD0 暗部#2B3F8F 不要发闷深藏蓝)，发梢渐变饱和亮青蓝#8FE3FF
不许发灰，围裙发箍袜子纯白，皮肤极淡粉白#FDEFF2配淡腮红，描边深藏蓝#1B2559。打光(最重要)：整体高调明亮，
头发大面积亮宝蓝(明度0.7~0.8)，深藏蓝只作小面积硬边暗部约占一成集中在发根，头顶压一条硬边青白高光带
(明度0.95以上边缘干脆)，每块材质只有2个平涂色阶+1条高光带，禁止气刷渐变、禁止糊成一团的中间调。
```

**换内容只改最后一句**（"四格是同一个人换四套衣服…"）—— 道具/家具/动作/第二只都照这个结构写。

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

---

# ★ 春夏服装海选（2026-10-10 晚 · 即梦，用户："用原版正面照片参考生成不同样式的服装，春夏各一张，每张四格四套"）

**产出**（都在 `art/`，2048²，PNG）：

| 文件 | 内容 |
|---|---|
| `jimeng-04-spring-outfits.png` | **春装 4 套**：①浅粉针织开衫+白连衣裙 ②草帽+淡黄碎花衬衫+米白背带裙 ③白贝雷帽+樱粉水手领+浅灰百褶裙 ④白贝雷帽+米色风衣+浅蓝丝巾 |
| `jimeng-05-summer-outfits.png` | **夏装 4 套**：①白色短袖水手服+浅蓝百褶裙+红领结 ②草帽+浅蓝吊带裙+白开衫 ③白棒球帽+白T+蓝背带短裤 ④**白底蓝鲸鱼纹浴衣+团扇** |

即梦新会话名：「四宫格鲸色少女春装设定」。参考图挂的是 **`art\ref-character-1024.png`（只挂 1 张）**，
提示词 = 上面那套三段锁（风格/配色/打光），**只改最后一句的服装列表**。两次共花 2 积分。

## 春季提示词（原文，直接抄）

```
2×2四宫格角色设定表，纯白背景，四格等大，浅灰线分隔，无文字无数字无水印。四格是同一个人换四套春季服装、正面站姿、同比例同景别：(1)浅粉针织开衫+白色连衣裙+米色草编帽 (2)淡黄碎花衬衫+米白背带裙 (3)樱粉水手领上衣+浅灰百褶短裙 (4)米色风衣+白色贝雷帽+浅蓝丝巾。角色：深蓝到浅青渐变及腰长发、头顶大呆毛、白蕾丝荷叶边发箍配蓝蝴蝶结、鳍状耳、身后蓝色鲸鱼尾。配色：主蓝鲜亮宝蓝(中调#4A6FD0 暗部#2B3F8F 不要发闷深藏蓝)，发梢渐变饱和亮青蓝#8FE3FF不许发灰，围裙发箍袜子纯白，皮肤极淡粉白#FDEFF2配淡腮红，描边深藏蓝#1B2559。打光(最重要)：整体高调明亮，头发大面积亮宝蓝(明度0.7~0.8)，深藏蓝只作小面积硬边暗部约占一成集中在发根，头顶压一条硬边青白高光带(明度0.95以上边缘干脆)，每块材质只有2个平涂色阶+1条高光带，禁止气刷渐变、禁止糊成一团的中间调。
```

## 夏季提示词（原文）

```
2×2四宫格角色设定表，纯白背景，四格等大，浅灰线分隔，无文字无数字无水印。四格是同一个人换四套夏季服装、正面站姿、同比例同景别：(1)白色短袖水手服+浅蓝百褶裙+红色领结 (2)浅蓝吊带连衣裙+白色薄开衫+米色草帽 (3)白色T恤+蓝色背带短裤+白色棒球帽 (4)白底蓝鲸鱼纹浴衣+白色腰带+小团扇。角色：…（角色/配色/打光三段与春季完全相同，照抄）
```

## ★ 这次补上的四个操作事实（上次没记全，都是实测）

1. **新 UI 的入口变了**：`创作` 首页 → 输入框左下角有个 **模式下拉（默认「Agent 模式」）** → 选 **「图片生成」**；
   然后底栏是 `图片生成 ▾ | Seedream 4.6 | 1:1 | 2K | 1 | @ | ✦1/张 | ↑`。**1:1 + 2K + 1 张 = 1 积分**（和上次一致）。
   选完「图片生成」后 URL 会变成 `?type=image`。
2. **★ 水印已经关掉了**（这次顺手做的，以后不用再管）：详情页点「下载」会弹 **「AI生成水印设置」** 对话框 →
   打开「**导出内容去除AI生成水印**」→ 保存设置。之后导出不再有左上角「AI 生成」明水印，
   **但右下角仍有淡灰的「即梦AI」品牌角标**（对话框原文就写了会保留）—— 它在纯白背景上，
   按坐标把那块涂白即可，不用重生成。
3. **挂参考图的坑（这次又踩）**：页面里**没有 `input[type=file]`**，上传口是纯 div（`.reference-upload-*`）。
   只能合成 paste 事件：把图片读成 base64 → 在页面里拼 `File` + `DataTransfer` + `ClipboardEvent('paste')`。
   **但它会触发两次 → 挂上 2 张重复图**，必须点掉一张（删按钮 `[class*=remove-button-container]` 的第 2 个）。
   下次可以直接用 `bubbles:false` 试，可能就不重复了。
4. **下载选择器不稳**：详情页的「下载」在 DOM 里找不到稳定的 class（`text=下载` 会匹配到 4 个）。
   可靠办法是 `bcdp_download` 的 **`triggerScript`**：`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('下载')).click()`。
   存下来的文件**是 2048² 的 PNG**（不是 webp），`savePath` 记得写 `.png`。

## 下一步（用户定的流程）

正面服装好处理 → **坐下的服装要单独生成**：拿"选好的正面服装 + 原版坐姿"当参考，
让即梦出**四张坐姿图**（四格），再回来做抠图/对齐。见 `tools\fit-outfit.py` 的 `--sit` 参数
与 `art\_sit-skirt.py`（这次坐姿那只换布料的脚本）。

---

# ★ 坐姿四张（2026-10-10 晚 · 即梦，用户选的是春夏各自的**左下角那格**）

**参考图（都已备好，直接挂）**：

| 用途 | 文件 |
|---|---|
| 春装（粉水手领+浅灰百褶裙+白贝雷帽） | `art\ref-spring3-1024.png` |
| 夏装（白T+蓝背带短裤+白棒球帽） | `art\ref-summer3-1024.png` |
| **原版坐姿**（姿势照它） | `art\ref-original-sit-1024.png` |

切格脚本：`python art\_crop-panel.py art\jimeng-04-spring-outfits.png 2 art\ref-spring3-1024.png`
（格号 0=左上 1=右上 **2=左下** 3=右下）。

## ★ 实测结论：挂"坐姿参考图"时，即梦**只出单张，不听"四宫格"**

提示词里写了 2×2 四宫格也没用——模型优先照参考图的构图。所以想要 4 个候选，
**把底栏「张数」设成 4**（1 积分/张）或连点几次「再次生成」。攒够 4 张后由我拼成四宫格给用户挑。

另外三条实测：

- **参考图一次挂两张**（服装 + 坐姿）：页面没有 `file input`，只能合成 paste；
  一次 paste 会加 **2 张**重复图，要手动删掉多余的（`bubbles:false` 也挡不住）；
  UI 里两张缩略图叠在同一位置，DOM 里查 `[class*=reference-item]` 才数得准。
- **下载**：点「下载」后文件落在浏览器默认目录 `%USERPROFILE%\Downloads`，
  文件名形如 `jimeng-2026-10-10-<序号>-<提示词前若干字>.png`（PNG，2048²）。
  `bcdp_download` 抓这个 download 事件时好时坏 → **直接搬 `~/Downloads` 里最新那个更稳**。
- 详情页返回用左上角「←」（`history.back()` 会直接跳回创作首页）。

## 春季坐姿提示词（原文）

```
2×2四宫格角色设定表，纯白背景，四格等大，浅灰线分隔，无文字无数字无水印。四格是同一个人、同一个坐姿的四个版本（方便挑出最像的那一格），坐在地上、身体正面朝向观众、双腿弯曲伸向画面右侧、双脚在右下方、双手自然放在身前，坐姿严格照第二张参考图。服装严格照第一张参考图：樱粉色水手领长袖上衣+白色领结+浅灰色百褶短裙+白色贝雷帽+白袜+藏蓝小皮鞋，不要女仆装、不要围裙。角色：深蓝到浅青渐变及腰长发、头顶大呆毛、白蕾丝荷叶边发箍配蓝蝴蝶结、鳍状耳、身后蓝色鲸鱼尾。配色：主蓝鲜亮宝蓝(中调#4A6FD0 暗部#2B3F8F 不要发闷深藏蓝)，发梢渐变饱和亮青蓝#8FE3FF不许发灰，围裙发箍袜子纯白，皮肤极淡粉白#FDEFF2配淡腮红，描边深藏蓝#1B2559。打光(最重要)：整体高调明亮，头发大面积亮宝蓝(明度0.7~0.8)，深藏蓝只作小面积硬边暗部约占一成集中在发根，头顶压一条硬边青白高光带(明度0.95以上边缘干脆)，每块材质只有2个平涂色阶+1条高光带，禁止气刷渐变、禁止糊成一团的中间调。
```

## 夏季坐姿提示词（只换服装那一句）

```
…（前半与春季完全相同）…服装严格照第一张参考图：白色T恤+蓝色牛仔背带短裤+白色棒球帽+白袜+蓝白帆布鞋，不要女仆装、不要围裙。…（后半与春季完全相同）
```

## 已产出的坐姿候选

| 文件 | 说明 |
|---|---|
| `jimeng-06-spring-sit-01.png` | 春装坐姿 第 1 张（实测姿势与原版坐姿接近：身体朝观众、腿弯向画面右侧、鲸鱼尾在左下） |
| `jimeng-07-sit-single.png` | 春装坐姿 单张（用户自己出的第 1 次）——**最终用的就是这张** |
| `jimeng-08-sit-grid.png` | 春装坐姿 四宫格（用户第 2 次出的）：**右上/右下两格干净**，左上/左下串进了原版的鲸鱼围裙 |

---

# ★ 换装流水线 v3：第一套"生图来的真衣服"上线（2026-10-10 晚）

用户拍板：**删掉 `school-blue`（藏蓝校服），换成 `spring-pink`（樱粉水手服）**，
站立 + 坐姿都要换。已部署到 `D:\pet\DeepSeekPet` 并重启。

## 三个脚本的分工（都在 `art\`）

| 脚本 | 干什么 |
|---|---|
| `tools\fit-outfit.py` | 原流水线：对齐生成图 + 抠部件 + 拼预览（**v2 的判据有坑，见下**） |
| `art\_stand-outfit.py` | **v3 重抠站立部件**（torso_up / skirt / waist_bow_front），这次真正用的 |
| `art\_sit-outfit.py` | 坐姿：原版腿/轮廓不动，只把裙子布料换成这套衣服的 |
| `art\_crop-panel.py` | 从四宫格里裁出指定那一格当参考图（格号 0=左上 1=右上 2=左下 3=右下） |

## ★ v2 的坑：把**头发**当成了衣服（这次踩到，务必记住）

`fit-outfit.py` 判断"像衣服"用的是 `(饱和 > 0.18) | (很暗)`。她的头发是**高饱和蓝** →
判据成立；而长发正好盖在躯干两侧 → "最大连通块"取到的是 **头发 + 上衣糊成一团**，
`torso_up.png` 变成"粉块 + 白蕾丝碎片 + 藏蓝"。

v3 的改法（`_stand-outfit.py`）：先按**这套衣服的配色**把头发抠掉
（`hue 195~275 & sat > 0.30` 视为头发；这套是粉+浅灰，不冲突），
再取"**包含部件框中心**"的那块连通域（不是最大块），最后邻域扩散补洞。

## 另一个坑：`skirt.png` 有 77% 是透明的，而且透明区 RGB 是**近黑**

`make_part` 抠部件时会裁到画布外 → 那部分 RGB=(8,8,9)。所以坐姿换布料时
**不能**直接 `convert("RGB")` 整张拉伸（会把黑当布料铺满）——
必须先取**不透明区域的 bbox**、只取上面一段（上衣下摆+裙摆），再补洞。

## 注册一套新衣服要改**两处**

1. `resources\app\web\whale\model.json` 的 `schemes` 数组（页面据此列配色）；
2. `resources\app\dress.cjs` 的 `OUTFITS` 数组（换装页的卡片：id / label / note / scheme / preview）。
   当前：`outfit-01` = 樱粉水手服 → scheme `spring-pink`。
   "她穿哪套"记在 `D:\pet\DeepSeekPet\data\dress.json`（重启后还在）。

## 这一版**已知的毛边**（等用户实测）

* 站立：左肩/左臂有一小块多余碎片（整块搬运时把他自己的手臂也圈进去了）、左胯有一片白色荷叶边
  （`waist_bow_front` 那块，这套本来没有腰饰）；
* 坐姿：**剪影仍是原版那条**（只换了布料），不是百褶裙的剪影。
