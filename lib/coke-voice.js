/**
 * 「小猫coke」的对话大脑。
 *
 * 设计参考 dsh-pet 的对话原理：
 *   1. system = 一段很短的人设 + 「你的名字是…」 + 当下时间背景（不必刻意报时）
 *   2. messages = 最近 N 轮历史 + 当前这句
 *   3. 配图可选：在 user 正文后附加一份表情包清单，让模型自己决定要不要挑一张，
 *      挑中就在回复末尾写 [图:名称]，宿主把它摘出来（文字必须留）
 *   4. 模型不可用时给一句**自然的短回复**兜底，而不是报错
 *
 * 人设走「自然猫猫」：短短一句、说人话、不提 AI。想换性格改 PERSONA 即可。
 */

/** 人设：照 dsh-pet 那种「短短一句、自然、不提 AI」的写法 */
export const PERSONA =
  '你是主人桌面上的一只猫，会和主人聊天。说话自然随意、短短一句（20 字以内），' +
  '说人话不啰嗦，不要解释你自己，不要提你是 AI。偶尔可以「喵」一下，但别每句都喵。';

/** 宠物名字（拼进 system，和 dsh-pet 一样单独一行） */
export const PET_NAME = '小猫coke';

/** 18 张表情包：名字 + 描述，模型靠描述挑图 */
export const STICKERS = [
  { file: 'coke-01.jpg', name: '石街怪人', desc: '石阶上土味雷人的插画怪人' },
  { file: 'coke-02.jpg', name: '忍界大战', desc: '两个黑衣男的背影，压迫感' },
  { file: 'coke-03.jpg', name: '神秘面具男', desc: '戴蝴蝶面具、眼神玩味' },
  { file: 'coke-04.jpg', name: '雄壮之躯', desc: '黑白漫画肌肉猛男，装狠' },
  { file: 'coke-05.jpg', name: '仙人模式', desc: '对比图式的中二设定感' },
  { file: 'coke-06.jpg', name: '痞颜', desc: '笑得特别痞的大头照' },
  { file: 'coke-07.jpg', name: '猫雷显现', desc: '白背心秀胸肌，得意' },
  { file: 'coke-08.jpg', name: '鲛肌融合', desc: '蓝脸鱼人，搞怪' },
  { file: 'coke-09.jpg', name: '猫毛显现', desc: '掀衣服露肚子，卖惨' },
  { file: 'coke-10.jpg', name: '朴昌范', desc: '正面大头照，面无表情' },
  { file: 'coke-11.jpg', name: '剧场版限定', desc: '叼牙签、装酷' },
  { file: 'coke-12.jpg', name: '无恐惧之人', desc: '戴眼镜的黑脸特写，凶狠' },
  { file: 'coke-13.jpg', name: '忍者少女', desc: '猫耳加胡须滤镜，卖萌' },
  { file: 'coke-14.jpg', name: '剧场版限定·背', desc: '裸背背影，抽象' },
  { file: 'coke-15.jpg', name: '萝莉道', desc: '女装 cos，反差' },
  { file: 'coke-16.jpg', name: '修罗道', desc: '圆脸大特写，无语' },
  { file: 'coke-17.jpg', name: '五条co', desc: '白发比手势，耍帅' },
  { file: 'coke-18.jpg', name: '招财小猫', desc: '年画娃娃，招财喜庆' },
];

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad2 = (n) => String(n).padStart(2, '0');

function timeSlotOf(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

/** 时间背景（照 dsh-pet 的写法：只当背景，不必刻意报时） */
export function timeContext(date = new Date()) {
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getDay();
  const hour = date.getHours();
  return (
    '【当下】现在是' +
    date.getFullYear() +
    '年' +
    (date.getMonth() + 1) +
    '月' +
    date.getDate() +
    '日' +
    WEEKDAYS[day] +
    ' ' +
    pad2(hour) +
    ':' +
    pad2(date.getMinutes()) +
    '，' +
    timeSlotOf(hour) +
    '。这只是背景，不必刻意报时，多数时候正常说话就好。'
  );
}

/** system = 人设 + 名字 + 时间（和 dsh-pet 的 composeSystemPrompt 一个结构） */
export function buildSystemPrompt(now = new Date()) {
  const lines = [PERSONA, '你的名字是“' + PET_NAME + '”。'];
  const time = timeContext(now);
  if (time) lines.push(time);
  return lines.join('\n');
}

/** 附在 user 正文后面的配图指令（和 dsh-pet 同款：可选、挑中写 [图:名称]） */
export function imageInstruction(limit = 10) {
  const pool = STICKERS.slice(0, Math.max(1, Number(limit) || 10));
  return (
    '\n\n[配图] 回复结尾可选附一张表情包给主人看，从下列清单里挑最贴合当前语境的：\n' +
    pool.map((s) => '- ' + s.name + '：' + s.desc).join('\n') +
    '\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。'
  );
}

const IMG_TAG = /\[图[:：]\s*([^\]]{1,30})\]\s*$/;

/** 从回复里把 [图:名称] 摘出来（必须在正文之后；没有正文就不算） */
export function extractSticker(text) {
  const raw = String(text || '').trim();
  const match = IMG_TAG.exec(raw);
  if (!match) return { text: raw, sticker: null };
  const name = match[1].trim();
  const hit = STICKERS.find((s) => s.name === name) || STICKERS.find((s) => name.includes(s.name));
  const body = raw.slice(0, match.index).trim();
  // 光有标记没有正文：当它没写过，整段保留
  if (!body) return { text: raw, sticker: null };
  // 写了不存在的名字：把标记摘掉（别让 [图:xxx] 露在气泡里），但不配图
  return { text: body, sticker: hit ? hit.file : null };
}

/** 去掉模型偶尔带上的引号 / 「你：」前缀 */
export function cleanText(text) {
  return String(text || '')
    .replace(/^\s*(你|我|小猫coke|coke)\s*[:：]\s*/i, '')
    .replace(/^["'“”「」\s]+|["'“”「」\s]+$/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// 兜底：模型不可用时也要有回答（自然短句，不带人设腔）
// ---------------------------------------------------------------------------
const FALLBACK = ['喵～', '在的', '喵喵喵', '我听着呢', '你说啥', '摸摸我'];

const FALLBACK_BY_INTENT = {
  greet: ['在的', '喵～', '我听着呢'],
  praise: ['嘿嘿，谢谢', '喵～', '那当然'],
  insult: ['哼，不理你', '喵？', '你才丑'],
  who: ['我是小猫coke', '桌面上的猫，喵'],
  skill: ['会陪你聊天，还会查余额', '点我看看就知道'],
  money: ['余额在下面那个按钮里', '问问「查余额」'],
  love: ['喵～抱抱', '我也喜欢你'],
  work: ['辛苦了，歇会儿', '摸摸，别熬太晚'],
  question: ['嗯……我想想', '不知道诶，喵', '你猜'],
  fallback: ['喵？', '嗯哼', '然后呢', '你说'],
};

const INTENTS = [
  ['greet', /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在|早|晚上好|早上好)/i],
  ['praise', /(帅|厉害|牛|强|6啊|6|猛|棒|好看|有型|酷|绝了|优秀)/],
  ['insult', /(傻|丑|滚|菜|垃圾|废物|有病|恶心|烦|闭嘴|弱|蠢)/],
  ['who', /(你是谁|你叫什么|你名字|哪只猫|什么猫|自我介绍)/],
  ['skill', /(会什么|能干嘛|能做什么|功能|你会|怎么用|干啥的)/],
  ['money', /(钱|余额|多少|贵|免费|收费)/],
  ['love', /(喜欢|爱你|老婆|老公|抱|亲|贴|想你了)/],
  ['work', /(代码|bug|报错|加班|工作|考试|考研|论文|作业|游戏|减肥|健身|吃饭|睡觉|穷)/i],
  ['question', /[?？]|(什么|怎么|为什么|哪|谁|多少|吗|呢)/],
];

export function detect(text) {
  for (const [name, re] of INTENTS) {
    if (re.test(text)) return name;
  }
  return 'fallback';
}

/** 兜底回答：一定非空、一定是一句自然的话 */
export function fallbackReply(input) {
  const intent = detect(input);
  const pool = FALLBACK_BY_INTENT[intent] || FALLBACK;
  return pool[Math.floor(Math.random() * pool.length)] || '喵～';
}

/** 表情包兜底（模型不挑图时偶尔随机给一张，纯属点缀） */
export function randomSticker(avoid) {
  const pool = STICKERS.filter((s) => s.file !== avoid);
  const list = pool.length ? pool : STICKERS;
  return list[Math.floor(Math.random() * list.length)].file;
}
