# -*- coding: utf-8 -*-
"""一次性：把 lines.cjs 里五个"按部位"的台词桶整批重写（15 个部位 x 5 个桶）。

为什么用脚本改而不是手改：五个桶一共 75 组、约 170 条，手改必然漏项；
而且**桶的键必须和部位名一模一样**（少一个那个部位就静默说通用台词），
这里由 `AREAS` 生成键，不可能漏。

跑法（用打包的 Python）：
  python art\_rewrite-lines.py
"""
import io

PATH = 'DeepSeekPet/resources/app/lines.cjs'

AREAS = ['ahoge', 'hair', 'eyes', 'cheek', 'chin', 'neck', 'chest',
         'belly', 'waist', 'skirt', 'hand', 'fin', 'tail', 'thigh', 'foot']

T = {
 'pokeArea': {
  'ahoge': [('呆毛是天线,戳了会收到奇怪频道。', ['surprised']), ('呜!那根会弹回来的。', ['shake']), ('轻一点……它今天很没精神。', ['sad'])],
  'hair': [('别揉我头发——刚梳好的!', ['angry']), ('唔,发型要塌了。', ['shy']), ('敲脑袋会变笨的,我认真的。', ['surprised'])],
  'eyes': [('喂!眼睛不能按的!', ['surprised']), ('眨、眨个不停了……', ['shy'])],
  'cheek': [('脸要变形了啦!', ['angry']), ('唔……软的也不是给你捏的。', ['shy'])],
  'chin': [('差一点就戳到嘴了。', ['surprised']), ('下巴很敏感的,笨蛋。', ['angry'])],
  'neck': [('那里……痒!', ['shy']), ('（脖子一缩）别闹。', ['surprised'])],
  'chest': [('不许戳那里!', ['angry']), ('（赶紧用鳍挡住）', ['shy'])],
  'belly': [('哈——痒痒痒!', ['happy']), ('肚子是软肋,你找到弱点了。', ['surprised']), ('噗,不许戳。', ['angry'])],
  'waist': [('腰、腰不行!我在撑着!', ['shy']), ('（扭了一下）手拿开啦。', ['shake'])],
  'skirt': [('裙子压着呢,不许动。', ['shy']), ('再戳我就坐下不起来了。', ['angry'])],
  'hand': [('手也不许戳!', ['angry']), ('指头会麻的……', ['surprised'])],
  'fin': [('鳍!那是鳍!', ['shake']), ('痒痒的,别碰。', ['shy']), ('（鳍抖了一下）', ['surprised'])],
  'tail': [('尾巴不能拽!', ['angry']), ('呀——甩你一身水。', ['shake']), ('那是我自己玩的。', ['shy'])],
  'thigh': [('大腿也要戳?过分。', ['angry']), ('唔,痒……', ['shy'])],
  'foot': [('脚底最怕痒了!', ['shy']), ('唔,别戳我脚。', ['surprised'])],
 },
 'petArea': {
  'ahoge': [('呆毛被摸得服服帖帖……', ['love']), ('唔,天线要收起来了。', ['sleepy'])],
  'hair': [('唔……头好舒服。', ['love']), ('再摸一会儿嘛。', ['happy']), ('（眯起眼睛）就这里。', ['sleepy']), ('头发乱了也不要紧。', ['love'])],
  'eyes': [('唔……眼睛要闭上了。', ['sleepy']), ('（睫毛在手心下动了动）', ['shy'])],
  'cheek': [('脸、脸被你捂住了……', ['shy']), ('（蹭了蹭你的手）', ['love'])],
  'chin': [('（下巴抬起来让你摸）', ['love']), ('唔,那里好痒。', ['happy'])],
  'neck': [('唔……脖子痒痒的。', ['shy']), ('（缩了缩脖子）', ['surprised'])],
  'chest': [('胸口……不、不许摸。', ['shy']), ('（把鳍抱得更紧了）', ['surprised'])],
  'belly': [('啊哈,好痒。', ['happy']), ('肚子不许摸!', ['angry']), ('呼噜呼噜……', ['love'])],
  'waist': [('腰、腰好麻……', ['sleepy']), ('（扭来扭去）别摸了啦。', ['shake'])],
  'skirt': [('裙子下面是秘密。', ['shy']), ('（把裙摆压住）', ['sit'])],
  'hand': [('手、手给你牵。', ['shy']), ('（把手搭过来）', ['love'])],
  'fin': [('鳍是拿来游泳的。', ['nod']), ('唔……轻一点。', ['shy']), ('这样游得更快哦。', ['happy'])],
  'tail': [('尾巴会自己甩的。', ['look']), ('别、别拉那里……', ['shy']), ('唔,有点喜欢。', ['love'])],
  'thigh': [('腿坐麻了……', ['sleepy']), ('唔,别摸腿啦。', ['surprised'])],
  'foot': [('脚、脚麻了……', ['sleepy']), ('别挠脚心啦。', ['surprised'])],
 },
 'grabArea': {
  'ahoge': [('呆毛被拎起来了——!', ['surprised']), ('呜,那是我唯一的天线。', ['angry'])],
  'hair': [('唔!头、头发!', ['surprised']), ('头发会掉的……轻点。', ['sad'])],
  'eyes': [('眼、眼睛!看不见了啦!', ['surprised'])],
  'cheek': [('脸、脸要变形了!', ['surprised'])],
  'chin': [('下巴!下巴要掉了!', ['surprised'])],
  'neck': [('唔!后颈被捏住了。', ['surprised'])],
  'chest': [('别、别拎那里……', ['shy'])],
  'belly': [('哇——腰要断了。', ['surprised']), ('轻点拎我。', ['shy'])],
  'waist': [('腰、腰真的会断!', ['surprised'])],
  'skirt': [('裙、裙子要掉了!', ['shy']), ('别拎裙子啦。', ['surprised'])],
  'hand': [('手要被拉长了啦!', ['surprised']), ('（被拎着手晃来晃去）', ['dizzy'])],
  'fin': [('鳍!别抓鳍!', ['surprised']), ('那里不是把手。', ['angry'])],
  'tail': [('尾巴不是提手!', ['angry']), ('呀——倒过来了。', ['dizzy'])],
  'thigh': [('腿、腿被拎起来了!', ['surprised'])],
  'foot': [('倒、倒过来了!', ['dizzy']), ('脚不是提手!', ['angry'])],
 },
 'holdArea': {
  'ahoge': [('呆毛真的要断了……', ['sad'])],
  'hair': [('放我下来啦……', ['shy'])],
  'eyes': [('眼睛……看不见了。', ['dizzy'])],
  'cheek': [('脸、脸好酸。', ['sad'])],
  'chin': [('下巴要掉了……', ['sad'])],
  'neck': [('后颈被你捏着呢。', ['sad'])],
  'chest': [('胸口被你拎着,好别扭。', ['shy'])],
  'belly': [('你还要拎多久呀。', ['sad'])],
  'waist': [('腰真的会断的。', ['sad'])],
  'skirt': [('我、我自己走。', ['shy'])],
  'hand': [('手真的会酸的。', ['sad'])],
  'fin': [('鳍要断了……', ['sad'])],
  'tail': [('我认输了,放我下来。', ['shy'])],
  'thigh': [('腿麻了……放我下来。', ['sad'])],
  'foot': [('晕……放我下来。', ['dizzy'])],
 },
 'dropArea': {
  'ahoge': [('呆毛得救了……', ['happy'])],
  'hair': [('呼,脖子得救了。', ['happy'])],
  'eyes': [('终于能睁眼了……', ['happy'])],
  'cheek': [('脸回来了……', ['nod'])],
  'chin': [('下巴酸死了。', ['sad'])],
  'neck': [('脖子终于松了。', ['happy'])],
  'chest': [('胸口松开了……', ['nod'])],
  'belly': [('落地了……', ['nod'])],
  'waist': [('腰回来了……', ['nod'])],
  'skirt': [('裙子皱掉了啦。', ['shy'])],
  'hand': [('手终于自由了。', ['happy'])],
  'fin': [('鳍都麻了。', ['sleepy'])],
  'tail': [('尾巴回来了。', ['happy'])],
  'thigh': [('腿站直了……', ['nod'])],
  'foot': [('站、站不稳……', ['dizzy'])],
 },
}

PETTING = {
 'start': {
  'all': [('唔……?', ['surprised']), ('嗯?怎么了。', ['surprised']), ('（转过头来）', ['look'])],
  'hair': [('唔,摸头呀。', ['shy'])],
  'cheek': [('脸、脸不可以捏。', ['shy'])],
  'tail': [('尾巴!别摸那里……', ['surprised'])],
 },
 'good': {
  'all': [('呼噜呼噜……', ['love']), ('唔……舒服。', ['love']), ('（眯起眼睛）', ['sleepy'])],
  'hair': [('再摸一会儿……', ['love']), ('就这里最好。', ['happy'])],
  'belly': [('哈哈,好痒……', ['happy'])],
 },
 'over': {
  'all': [('够了啦,手拿开。', ['angry']), ('（扭了一下）', ['shake'])],
  'ahoge': [('呆毛要被你摸秃了!', ['angry'])],
  'eyes': [('眼睛不能一直按啦。', ['surprised'])],
  'belly': [('别摸肚子啦!', ['angry']), ('痒得受不了了。', ['surprised'])],
  'fin': [('鳍不能一直摸。', ['shake']), ('（抖了抖鳍）', ['shy'])],
  'tail': [('尾巴要炸了!', ['angry']), ('不、不许摸尾巴。', ['surprised'])],
  'skirt': [('那里不行。', ['shy'])],
 },
}


def fmt(lines, indent):
    out = []
    for text, actions in lines:
        acts = ', '.join("'%s'" % a for a in actions)
        out.append("%s{ text: '%s', actions: [%s] }," % (indent, text, acts))
    return '\n'.join(out)


def area_block(body, indent):
    """15 个部位一组，键由 AREAS 生成（不可能漏项）。"""
    parts = []
    for area in AREAS:
        if area not in body:
            raise SystemExit('缺部位: %s' % area)
        parts.append('%s%s: [\n%s\n%s],' % (indent, area, fmt(body[area], indent + '  '), indent))
    return '\n'.join(parts)


def stage_block(stage, indent):
    parts = []
    for key in ['all'] + [k for k in PETTING[stage] if k != 'all']:
        parts.append('%s%s: [\n%s\n%s],' % (indent, key, fmt(PETTING[stage][key], indent + '  '), indent))
    return '\n'.join(parts)


def splice(src, open_marker, close_marker, new_body):
    """把 [open_marker 之后, close_marker 之前] 换成 new_body（两个标记都保留）。"""
    i = src.index(open_marker) + len(open_marker)
    j = src.index(close_marker, i)
    return src[:i] + '\n' + new_body + src[j:]


def main():
    src = io.open(PATH, encoding='utf-8').read()
    before = len(src)

    src = splice(src, 'pokeArea: {\n', '\n  },\n', area_block(T['pokeArea'], '    '))
    src = splice(src, 'petArea: {\n', '\n  },\n', area_block(T['petArea'], '    '))
    src = splice(src, 'grabArea: {\n', '\n  },\n', area_block(T['grabArea'], '    '))
    src = splice(src, 'holdArea: {\n', '\n  },\n', area_block(T['holdArea'], '    '))
    src = splice(src, 'dropArea: {\n', '\n  },\n', area_block(T['dropArea'], '    '))
    # 抚摸三段：`    start: {` / `    good: {` / `    over: {` 在整个文件里各只出现一次，
    # 但**不能用"下一个 stage 的开头"当收尾标记**（那会把 `    },\n` 和 `all: [` 的换行吃掉），
    # 所以三段各自切到 `      all: [` 为止（那一行原样保留）。
    for stage in ('start', 'good', 'over'):
        marker = "    %s: {\n" % stage
        i = src.index(marker) + len(marker)
        j = src.index('      all: [', i)
        src = src[:i] + stage_block(stage, '      ') + '\n' + src[j:]

    io.open(PATH, 'w', encoding='utf-8', newline='\n').write(src)
    print('rewritten %s (%d -> %d bytes)' % (PATH, before, len(src)))


if __name__ == '__main__':
    main()
