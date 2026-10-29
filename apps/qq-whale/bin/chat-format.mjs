// The proactive worker and QQ outbound use the same formatter and configuration.
import { readFileSync } from 'node:fs';
import { splitChatMessages } from '../patches/dsh-qqbot/chat-splitter.js';
import { readChatConfig, messageDelay } from '../patches/dsh-qqbot/chat-delivery.js';
const config = readChatConfig();
const text = JSON.parse(readFileSync(0, 'utf8')).text;
let messages = splitChatMessages(text, config);
let delays = messages.map((m) => messageDelay(m, config));
if (messages.some((m) => m.length > 4500)) {
  const { chunkMarkdownText } = await import(process.env.QQBOT_CHUNKER
    || '/home/qqwhale/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/dist/transport/chunker.js');
  const groups = messages;
  messages = [];delays = [];
  for (const group of groups) {
    const chunks = chunkMarkdownText(group, 4500);
    messages.push(...chunks);
    delays.push(...chunks.map(m => chunks.length > 1 ? 500 : messageDelay(m, config)));
  }
}
process.stdout.write(JSON.stringify({ messages, delays: delays }));
