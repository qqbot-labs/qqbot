# QQBot Monorepo

公开的 QQBot 双栈源码仓库，用于共同维护两套机器人运行栈：

- `apps/qq-agent/`：QQ Agent 统一管理台、NapCat/QQ 接入与 QQ 空间桥接（Python）。
- `apps/qq-whale/`：QQ Whale 陪伴机器人、视觉与主动关心（Node.js）。
- `apps/whale-admin/`：QQ Whale 私有管理台与本地控制 broker（Python 标准库）。
- `deploy/`：systemd 与 nginx 配置模板，不包含真实域名、IP 或密钥。

默认正式分支：`main`。`main` 要求通过 Pull Request、至少一位其他协作者审核和 Code Owner 审核后合并；禁止强推和删除正式分支。

## 安全边界

仓库只保存可审查的源码、示例配置和部署模板。以下内容不进入 Git：

- QQ AppSecret、模型 API Key、管理密码、Cookie、Token。
- `data/`、`logs/`、`backups/`、聊天记录、图片库、SQLite 数据库。
- `node_modules/`、`.venv/`、浏览器运行时、安装包、构建产物和测试缓存。

线上人格、个人聊天偏好和真实部署配置不在公开仓库中。

## 快速检查

QQ Agent：

```bash
cd apps/qq-agent
uv sync --locked
uv run python -m pytest -q
```

QQ Whale / 管理台：

```bash
cd apps/qq-whale
node --test tests/chat-splitter.test.mjs tests/send-outbound.test.mjs

cd ../whale-admin
python3 -m py_compile server.py domain.py integrations.py proactive.py workspace.py
```

发送集成测试需通过 `QQBOT_OUTBOUND` 指定已打补丁的插件，否则明确跳过。安装及完整验证步骤见 [聊天分条补丁](apps/qq-whale/patches/dsh-qqbot/README.md)。

## 协作

开始任务、提交 PR、审查、合并和同步的固定流程见 [docs/COLLABORATION.md](docs/COLLABORATION.md)。

核心约定：

1. 从最新 `main` 创建 `feat/*` 或 `fix/*` 分支。
2. 本地测试通过后推送分支并创建 PR。
3. PR Reviewer 指定 `@xiaodianshiuwu`。
4. 未获得对方明确审核通过，不得合并到 `main`。
5. 合并后只用 `--ff-only` 同步本机，禁止覆盖未提交修改。
