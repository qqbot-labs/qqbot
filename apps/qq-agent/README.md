# QQ Agent 统一管理台

一个自托管的 QQ 机器人管理台：统一管理私聊权限、人格、模型、记忆、QQ 空间桥接和运行状态。后端只监听回环地址，公开访问应通过自己的 HTTPS 反向代理。

## 组成

- `qqagent/`：FastAPI 管理台、调度器和 QQ/NapCat 适配器。
- `bridge/`：QQ 空间浏览器桥接。
- `deploy/`：NapCat、QZone、systemd 和 nginx 部署参考。
- `tests/`：后端与桥接测试。
- `docs/`：架构和产品说明。

## 本地运行

```bash
uv sync --locked
uv run python -m qqagent --port 13800
```

首次启动会在数据目录生成仅供本机读取的管理密码文件。不要把它提交到 Git，也不要在日志或聊天中输出。

## 测试

```bash
uv run python -m pytest -q
node --experimental-strip-types --test tests/qzone_http.test.mjs
uv run python scripts/run-browser-acceptance.py
```

## 配置

管理台、模型网关、NapCat 和 QQ 空间凭据通过管理台或服务器本地凭据文件配置。仓库只保留结构、示例和占位符。

公开部署前至少确认：

- 反向代理终止 TLS，后端仍只监听 `127.0.0.1`。
- 管理密码、模型 API Key、QQ Cookie、二维码和原始平台响应不进入 Git。
- 私聊白名单和主动行为默认关闭，按实际需求逐步启用。
- NapCat/QQ 版本固定，升级前先备份并重新验收。

架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

