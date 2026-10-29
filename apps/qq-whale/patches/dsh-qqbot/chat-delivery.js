import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatConfig } from './chat-splitter.js';

export function readChatConfig(root = process.env.WHALE_ROOT || '/home/qqwhale/whale') {
  try {
    return chatConfig(JSON.parse(readFileSync(join(root, 'etc/chat-delivery.json'), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('聊天分条配置无法读取，请检查 chat-delivery.json');
    return chatConfig();
  }
}

export function messageDelay(text, config) {
  return config.messageDelayMs + [...text].length * config.typingMsPerChar;
}
