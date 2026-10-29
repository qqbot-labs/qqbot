# 部署配置说明

本目录是现有 VPS 的 systemd 与 nginx 配置参考，便于审查服务边界和运行方式。

- `systemd/`：QQ Agent、大肥鱼（QQ Whale）、管理台 broker、主动关心定时器和备份/监控单元。
- `nginx/`：`qqbot.example.com` 与 `whale.example.com` 的反向代理配置。

这些文件含固定路径、域名和运行用户，部署到其他机器前必须核对并替换。不要在这里写入真实密钥；凭据应通过服务器上的 `EnvironmentFile` 或权限受限文件提供。

修改部署文件时只改与当前任务相关的单元，不要批量重启或影响 VPS 上的其他服务。
