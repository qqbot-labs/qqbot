import assert from 'node:assert/strict';
import test from 'node:test';

const modulePath = process.env.QQBOT_OUTBOUND
  || '/home/qqwhale/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/dist/transport/outbound-buffer.js';
const { sendRichOutbound } = await import(modulePath);

const target = { scope: 'c2c', targetId: 'test-target' };

function mockBot() {
  const calls = [];
  return {
    calls,
    async sendMarkdown(_target, text) {
      calls.push(text);
      return { messageId: 'm' + calls.length };
    },
    async sendMedia() {
      throw new Error('unexpected media');
    },
    async recallByIndex() {
      return false;
    },
  };
}

async function send(text, normalizeChat = true) {
  const bot = mockBot();
  const started = Date.now();
  await sendRichOutbound(bot, target, text, 4500, '/home/qqwhale/whale/data', () => {},
    undefined, undefined, undefined, undefined, normalizeChat);
  return { calls: bot.calls, elapsed: Date.now() - started };
}

const longText = '今天这道题其实不难。先看受力分析，判断物体到底受几个力，再判断运动方向。你刚才把摩擦力方向写反了，所以整道题的符号都反了。'
  + '另外，题干里的角度是斜面倾角，不是速度方向，这两个很容易混。下次先画图再算，把每个力的方向标出来，会稳很多。'
  + '还有，最后一步代入公式之前，先检查单位是不是统一。';

test('短回复只发送一条消息', async () => {
  const { calls } = await send('好喵，收到！');
  assert.deepEqual(calls, ['好喵，收到！']);
});

test('长回复按顺序发送 2~4 条独立消息', async () => {
  const { calls, elapsed } = await send(longText);
  assert.ok(calls.length >= 2 && calls.length <= 4, `实际 ${calls.length} 条`);
  assert.equal(calls.map((part) => part.replace(/\s+/g, '')).join(''), longText.replace(/\s+/g, ''));
  assert.ok(elapsed >= (calls.length - 1) * 450, '消息之间应有发送间隔');
});

test('自然段与编号列表按语义分条', async () => {
  const text = '第一段先讲结论，这个方案可行，但需要先做备份。备份要放在独立目录，不能只留在当前机器上，否则机器出问题就一起没了。\n\n'
    + '第二段说风险，旧数据迁移时可能丢字段，必须逐项核对。尤其是历史版本的字段，迁移脚本要做兼容，不能想当然。\n\n'
    + '第三段讲时间，今晚先跑一次演练，明天再正式切换。演练要覆盖迁移、校验和回滚，不能只看迁移成功。\n\n'
    + '第四段是收尾，切换后保留回滚包，出问题十分钟内能恢复。恢复流程也要提前写好，别等出事再临时想办法。';
  const { calls } = await send(text);
  assert.ok(calls.length >= 2 && calls.length <= 4);
  assert.equal(calls.map((part) => part.replace(/\s+/g, '')).join(''), text.replace(/\s+/g, ''));
});

test('代码块保持一条消息', async () => {
  const text = '看这段代码：\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n它只是示例。';
  const { calls } = await send(text);
  assert.equal(calls.length, 1);
});

test('长链接完整保留，不截断 URL', async () => {
  const text = '参考这个链接：https://example.com/a/very/long/path?with=query&and=more 里面有详细说明。'
    + '看完再动手，别急着改配置，出问题不好回滚。先用测试环境验证一遍，再考虑上线。上线前记得把旧配置备份一份，'
    + '备份文件放到独立目录，别只留在当前机器上。';
  const { calls } = await send(text);
  assert.ok(calls.length >= 2);
  assert.ok(calls.some((part) => part.includes('https://example.com/a/very/long/path?with=query&and=more')));
});

test('非聊天文本（normalizeChat=false）不自动分条', async () => {
  const { calls } = await send(longText, false);
  assert.equal(calls.length, 1);
});
