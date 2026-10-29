# 配置参考

这里保留可公开的结构和示例，不包含线上人格、真实账号或凭据：

- `chat-delivery.example.json`：分条目标、长句兜底、可关闭的条数上限与发送停顿。
- `proactive.example.json`：主动关心节奏、免打扰、目标占位符和文案示例。
- `vision-routing.json`：图片识别模型、回退模型和超时。
- `search-config.json` / `admin-routing.json`：联网搜索和管理员路由配置。

线上 DSH profile（含个人人格与聊天偏好）不随公开仓库发布，应在部署环境中单独维护。

部署到其他环境时要核对：

- `/home/qqwhale` 路径和 `qqwhale` 用户是否存在；
- `qqbot.env` 的权限与凭据；
- `WHALE_API_BASE` 指向的模型网关和模型目录是否可用；
- `qqwhale.service` 中的只读/可写路径白名单。

不要把 `qqbot.env`、`qzone-token`、`admin-password.txt` 或运行数据库复制进仓库。

主动闲置/发送/评估间隔设为 0 不拦截；免打扰起止相同即关闭。表情包总闸门关闭时不执行单轮或每日限额。`search-config.json` 的 `maxResponseBytes=0` 不设置本地响应大小上限。

QQ 专用 preset 内的 `@deepseek-ai/dsh-persona` 应设置 `complete: true`，由用户人格完整接管系统提示词，避免默认编程助手的身份和工作流混入日常聊天。工具权限与工具 schema 仍由运行时独立装配；工作区指令和渠道提醒继续经 pre-step 注入。
