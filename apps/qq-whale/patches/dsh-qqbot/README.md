# dsh-qqbot 本地补丁

`chat-splitter.js` 用于 QQ Whale 的普通聊天出站路径。v3 保留模型主动分出的短消息，即使合计不到 40 字也分开发送；未分段的多句回复从 40 字起按完整句子分条，目标每条约 28 字，最多 4 条（300 字以上最多 5 条）。

字数是分组目标，不是截断上限。单个长句不在逗号处硬切，代码块、表格、列表和引用保持完整，链接与行内代码不截断。生成端的短句要求在 `workspace/AGENTS.md`：日常默认 1~2 个短句、通常共 10~40 字；用户要求详细解释时保留必要信息。

## 验证

仓库内纯函数测试不依赖服务器或已安装插件：

```bash
node --test apps/qq-whale/tests/chat-splitter.test.mjs
```

发送集成测试需要真实的 `@zaofan/dsh-qqbot@1.10.9`。在独立目录解包 npm 包后，执行：

```bash
python3 apps/qq-whale/bin/apply-chat-splitter.py /path/to/unpacked/package
python3 apps/qq-whale/bin/apply-chat-splitter.py /path/to/unpacked/package --check
QQBOT_OUTBOUND=/path/to/unpacked/package/dist/transport/outbound-buffer.js \
  node --test apps/qq-whale/tests/send-outbound.test.mjs
```

集成测试使用模拟 QQ 客户端和临时数据目录，不会发真实消息。不设置 `QQBOT_OUTBOUND` 时明确跳过集成测试；`QQBOT_SPLITTER` 可用于验证已安装的分段器。

## 安装与生效

`apply-chat-splitter.py` 校验固定版本及原始 `outbound-buffer.js` 的 SHA-256，备份原文件，然后安装分段器并接入现有发送循环。保留原有引用、目标解析、发送计数回调和 500ms 间隔；`normalizeChat=false` 可跳过聊天分条。重复安装及 `--check` 可核对完整性。

发现上游版本变化或未知本地修改时，脚本在写入前失败；已有线上补丁需先对照合并，不会直接覆盖。服务需使用非流式发送才能经过此分条路径。

部署时还需将本次 `workspace/AGENTS.md` 的聊天规则合入服务器现有工作区指令，保留私有人格和长期偏好。只修改 GitHub 源码不会自动更新线上指令或安装目录。

它不是上游包的一部分。插件升级或重装会覆盖安装目录里的补丁，升级前需要：

1. 对照上游版本重新审查补丁；
2. 运行纯函数测试与上述发送集成测试；
3. 确认 `outbound-buffer.js` 的接入点仍存在；
4. 通过 PR 审查后再部署。
