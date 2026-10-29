# dsh-qqbot 聊天补丁

v4 保留模型写出的独立短消息，按完整句子处理较长聊天，并可在超长逗号串的语义转折处分条。链接、行内代码、引号和括号内部不切，代码块、列表和表格保留结构。不截断正文，不设置默认本地消息条数上限。

`chat-delivery.json` 的全部参数在管理台“QQ 与安全 → 聊天分条与节奏”可调整：`shortLimit`、`targetChars`、`longSentenceChars`、`minMessageChars`、`maxMessages`、`messageDelayMs`、`typingMsPerChar`。字数用于分组；`maxMessages=0` 不限条数，`longSentenceChars=0` 关闭逗号串兜底。示例见 `config/chat-delivery.example.json`。

普通 QQ 回复和主动关心使用同一份分条实现与配置。不会把换行重新替换成逗号。自然消息使用配置的停顿；传输层硬分块保留短间隔，不按几千字模拟打字。`normalizeChat=false` 保留非聊天文本原样。

## 安装与验证

只支持已审查的 `@zaofan/dsh-qqbot@1.10.9` 原始包及摘要锁定的线上 v3 变体。安装器验证所有接入点，保存原文件，支持重复安装与完整性检查；未知本地修改会在写入前失败。

```sh
python3 apps/qq-whale/bin/harden-plugin.py /path/to/plugin
python3 apps/qq-whale/bin/apply-chat-splitter.py /path/to/plugin
python3 apps/qq-whale/bin/harden-plugin.py /path/to/plugin --check
python3 apps/qq-whale/bin/apply-chat-splitter.py /path/to/plugin --check
QQBOT_OUTBOUND=/path/to/plugin/dist/transport/outbound-buffer.js \
  node --test apps/qq-whale/tests/*.test.mjs
python3 -m unittest discover -s apps/whale-admin/tests -v
```

集成测试调用真实插件的发送函数，QQ 客户端使用夹具，不发真实消息；不提供 `QQBOT_OUTBOUND` 时发送测试明确跳过。CI 会解包固定 npm 版本并实际运行发送集成测试。生产使用非流式发送，并在 `ExecStartPre` 同时检查权限补丁和分条补丁。

部署还需同步 `bin/chat-format.mjs`、`patches/dsh-qqbot/`、工作区指令及私有 profile 内的格式规则。人格、每轮注入、长期偏好不能再包含“禁止空行分条”或强制凑字数的旧要求。私人人格不复制进公开仓库。

QQ 平台的被动回复窗口、每条入站的回复额度和主动能力由平台控制。不要用重发、假消息 ID 或未知结果重试冒充发送成功。上游升级可能覆盖补丁，必须重新审查并验证后部署。
