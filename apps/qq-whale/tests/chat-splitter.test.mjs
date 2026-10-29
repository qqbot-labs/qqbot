import assert from 'node:assert/strict';
import test from 'node:test';

const modulePath = process.env.QQBOT_SPLITTER
  || new URL('../patches/dsh-qqbot/chat-splitter.js', import.meta.url).href;
const { splitChatMessages } = await import(modulePath);

const stripSpace = (value) => value.replace(/\s+/g, '');

test('短回复保持一条消息', () => {
  assert.deepEqual(splitChatMessages('好喵，收到！'), ['好喵，收到！']);
});

test('模型写出的两条短消息不受总字数门槛影响', () => {
  assert.deepEqual(splitChatMessages('今天这么忙啊。\n\n来，陪你歇会儿。'), [
    '今天这么忙啊。', '来，陪你歇会儿。',
  ]);
  assert.deepEqual(splitChatMessages('好啊\n\n等你'), ['好啊', '等你']);
});

test('40 到 65 字的多句回复也能自然分条', () => {
  const sentences = ['今天的事先放一放吧，忙了一天也够累了。', '我刚好也闲着，陪你随便聊会儿，想说什么都行。'];
  const text = sentences.join('');
  assert.ok(text.length >= 40 && text.length < 65);
  assert.deepEqual(splitChatMessages(text), sentences);
});

test('空行不拆开引号内的原话', () => {
  const text = '他说“今天不想动。\n\n明天再说。”';
  assert.deepEqual(splitChatMessages(text), [text]);
});

test('超过消息条数预算时保留全部内容', () => {
  const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}天还是想和你说声早安。`).join('\n\n');
  const parts = splitChatMessages(text);
  assert.ok(parts.length <= 4);
  assert.equal(parts.map(stripSpace).join(''), stripSpace(text));
});

test('前导元思考不会发给用户，普通正文保持不变', () => {
  const reply = '周六还要上课啊。\n\n那确实挺累的。';
  assert.deepEqual(splitChatMessages('用户说周六要上课。回复应该简短，一条即可。\n\n' + reply), [
    '周六还要上课啊。', '那确实挺累的。',
  ]);
  assert.deepEqual(splitChatMessages('这个回答要简短吗？'), ['这个回答要简短吗？']);
});

test('长回复按完整句子拆成 2~4 条', () => {
  const text = '今天这道题其实不难。先看受力分析，判断物体到底受几个力，再判断运动方向。你刚才把摩擦力方向写反了，所以整道题的符号都反了。'
    + '另外，题干里的角度是斜面倾角，不是速度方向，这两个很容易混。下次先画图再算，把每个力的方向标出来，会稳很多。'
    + '还有，最后一步代入公式之前，先检查单位是不是统一。';
  const parts = splitChatMessages(text);
  assert.ok(parts.length >= 2 && parts.length <= 4, `实际 ${parts.length} 条`);
  assert.equal(parts.map(stripSpace).join(''), stripSpace(text));
  for (const part of parts.slice(0, -1)) {
    assert.match(part, /[。！？!?…]$/, '非最后一条应以完整句末标点结束');
  }
});

test('多个自然段按语义分组', () => {
  const text = '第一段先讲结论，这个方案可行，但需要先做备份。备份要放在独立目录，不能只留在当前机器上，否则机器出问题就一起没了。\n\n'
    + '第二段说风险，旧数据迁移时可能丢字段，必须逐项核对。尤其是历史版本的字段，迁移脚本要做兼容，不能想当然。\n\n'
    + '第三段讲时间，今晚先跑一次演练，明天再正式切换。演练要覆盖迁移、校验和回滚，不能只看迁移成功。\n\n'
    + '第四段是收尾，切换后保留回滚包，出问题十分钟内能恢复。恢复流程也要提前写好，别等出事再临时想办法。';
  const parts = splitChatMessages(text);
  assert.ok(parts.length >= 2 && parts.length <= 4);
  assert.equal(parts.map(stripSpace).join(''), stripSpace(text));
});

test('代码块和表格保持完整', () => {
  const code = '看这段代码：\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n它只是示例。';
  assert.deepEqual(splitChatMessages(code), [code]);
  const table = '对比：\n\n| 项目 | 值 |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n\n以上。';
  assert.deepEqual(splitChatMessages(table), [table]);
});

test('链接和行内代码不会被截断', () => {
  const text = '参考这个链接：https://example.com/a/very/long/path?with=query&and=more 里面有详细说明。'
    + '看完再动手，别急着改配置，出问题不好回滚。先用测试环境验证一遍，再考虑上线。上线前记得把旧配置备份一份，'
    + '备份文件放到独立目录，别只留在当前机器上。命令是 `npm run build -- --watch`，不要漏参数。';
  const parts = splitChatMessages(text);
  assert.ok(parts.length >= 2);
  assert.ok(parts.some((part) => part.includes('https://example.com/a/very/long/path?with=query&and=more')));
  assert.ok(parts.some((part) => part.includes('`npm run build -- --watch`')));
});

test('没有句末标点的长句不从中间硬拆', () => {
  const text = '这是一段没有句号的超长文字，里面全是逗号，用来测试不会从句子中间硬拆的情况，因为它本来就是一个完整的长句，'
    + '拆开就会破坏语义和阅读节奏，所以应该保持一条消息，哪怕它看起来已经有点长了，也不应该为了分段而破坏完整性。';
  assert.deepEqual(splitChatMessages(text), [text]);
});

test('带编号列表的长回复保持完整', () => {
  const text = '先接住你这句“撑不住了”——能说出这句话，说明你已经硬扛很久了。这不是你能力不够，是负荷真的超过了单个人能长期承受的量。教师这行有个特点：课上不完、学生问题一堆、责任边界又模糊。所以靠“再努力一点”是填不满的，只能靠取舍和设边界。\n\n'
    + '**几个可以马上调整的方向：**\n\n'
    + '1. **分清“必须我做”和“可以打折做”**。作业不必全批全改，可以抽批、互批、讲评典型错题；答疑不必随时在线，设固定答疑时间。\n\n'
    + '2. **课上不完，就允许讲不完**。抓核心知识点，砍掉“讲了更好但不讲也不影响”的内容。教学是长期工程，不是每节课都要完美。\n\n'
    + '3. **把“学生问题”装进容器里**。固定答疑时间、常见问题文档、家长沟通模板，都能把零散问题集中处理。\n\n'
    + '最后想说，你已经做得很好了。先把自己从“必须全部扛住”的位置上放下来，今晚早点睡，明天再一件一件来。';
  const parts = splitChatMessages(text);
  assert.deepEqual(parts, [text]);
});

test('随机组合不丢字、不超四条、不重复', () => {
  const sentences = [
    '今天先把最要紧的那件事做完。',
    '剩下的任务可以往后排一排，不用一次全扛。',
    '如果需要我帮忙，直接把问题发过来。',
    '先喝口水，缓一缓再继续。',
    '这个方案总体可行，但上线前要备份。',
    '旧数据里可能还有历史字段，迁移时要核对。',
    '回滚包放在独立目录，出问题能马上恢复。',
  ];
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 100; i += 1) {
    const count = 2 + Math.floor(random() * 7);
    const text = Array.from({ length: count }, () => sentences[Math.floor(random() * sentences.length)]).join('');
    const parts = splitChatMessages(text);
    assert.ok(parts.length >= 1 && parts.length <= 4);
    assert.equal(parts.map(stripSpace).join(''), stripSpace(text));
    // 输入允许同一句出现多次；上面的全文比较验证没有额外重复或丢失。
  }
});
