# dsh-qqbot 本地补丁

`chat-splitter.js` 是大肥鱼对 `@zaofan/dsh-qqbot` 出站路径的本地增强，用于把较长回复按自然段/句子拆成 2~5 条 QQ 消息。

它不是上游包的一部分。插件升级或重装会覆盖安装目录里的补丁，升级前需要：

1. 对照上游版本重新审查补丁；
2. 运行 `apps/qq-whale/tests/chat-splitter.test.mjs` 和 `send-outbound.test.mjs`；
3. 确认 `outbound-buffer.js` 的接入点仍存在；
4. 通过 PR 审查后再部署。
