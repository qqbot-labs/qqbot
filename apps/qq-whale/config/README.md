# 配置参考

这里保留可公开的结构和示例，不包含线上人格、真实账号或凭据：

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
