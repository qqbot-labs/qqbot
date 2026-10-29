# 双人协作流程

仓库：`https://github.com/qqbot-labs/qqbot`

正式分支：`main`

## 角色

- `@yumi-0412`：本机开发、修改、测试、提交开发分支和创建 PR。
- `@xiaodianshiuwu`：另一位协作者，使用独立 GitHub 账号审查 PR、提出修改意见并决定是否合并。
- `main` 只接受经过审查的 PR。即使本地测试通过，也不得由开发者自行合并。

## 开始一个开发任务

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
```

分支命名：

- `feat/...`：新功能
- `fix/...`：缺陷修复
- `chore/...`：维护、文档或部署配置

开始前先检查：

```bash
git status --short
```

工作区必须干净，或先把未完成修改提交到独立分支。不要用 `reset --hard`、强制推送或覆盖未提交文件来处理冲突。

## 开发与提交

1. 在开发分支内完成代码、配置、测试和文档。
2. 运行受影响模块的检查；提交说明写清行为变化和验证结果。
3. 只暂存本任务的文件，提交前检查 `git diff --cached`。
4. 推送分支：

```bash
git push -u origin HEAD
```

## 创建 PR

```bash
gh pr create \
  --base main \
  --head "$(git branch --show-current)" \
  --reviewer xiaodianshiuwu \
  --title "feat: ..." \
  --body-file .github/pull_request_template.md
```

PR 必须包含：

- 功能或修复说明
- 修改模块
- 对现有功能、配置、部署或数据的影响
- 实际运行的测试与结果
- 已知问题和需要重点审查的部分
- 安全确认：没有提交密钥、Cookie、聊天数据或数据库

创建后等待 `@xiaodianshiuwu` 审查。开发者不得自行合并，也不得绕过审查直接更新 `main`。

## 处理审查意见

在原分支继续提交，PR 会自动更新：

```bash
git add <files>
git commit -m "fix: address review feedback"
git push
```

如果审查意见涉及设计取舍，先在 PR 中说明并达成一致，不要静默改变需求。

## 合并条件

只有满足以下条件才允许合并：

1. `@xiaodianshiuwu` 明确表示审核通过。
2. 所有必须的检查通过。
3. 没有未解决的阻塞性评论。
4. PR 的目标分支是 `main`，且变更范围与本任务一致。

合并由审查者执行，或由审查者明确授权后执行。合并后不要删除仍在使用的开发分支，除非确认已合并且无后续工作。

## 分支保护

仓库为公开仓库，`main` 已启用 GitHub 分支保护：

- 必须通过 Pull Request 合并。
- 至少一位其他协作者审核通过。
- 需要 Code Owner 审核。
- 新提交会使已有审核失效，需要重新审核。
- 禁止强制推送和删除 `main`。
- 管理员同样受保护规则约束。

这些是平台强制规则，不再只依赖团队约定。若管理员需要紧急处理，应先记录原因并在事后补开 PR 复核。

## 合并后同步本机

先检查工作区：

```bash
git status --short
```

如果有未提交修改，先提交到开发分支或妥善保存，不要直接拉取覆盖。

然后执行：

```bash
./scripts/sync-main.sh
```

脚本只执行安全的快进同步：

```bash
git switch main
git fetch origin main
git merge --ff-only origin/main
```

同步后确认：

```bash
git log -1 --oneline
git status --short --branch
```

如项目依赖或运行环境有变化，按 README 重新安装依赖并运行对应测试。

## 冲突处理

- 先在开发分支执行 `git fetch origin main`，再合并或变基到最新 `main`。
- 解决冲突后重新运行受影响测试，并重新请求审查。
- 不使用 `git push --force` 覆盖共享分支；如确有必要，先与审查者确认。
- 不把 `.env`、凭据、数据库、日志或聊天记录加入冲突解决范围。

## 安全

- 服务器上的真实凭据只放在 `EnvironmentFile` 或权限受限的凭据文件中。
- 仓库中的配置只保留占位符和结构。
- 发现误提交密钥时，立即停止推送，撤销凭据并在私有渠道处理；不要只删除文件后继续使用同一密钥。
