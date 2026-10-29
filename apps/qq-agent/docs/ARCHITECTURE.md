# 选型与隔离

本期采用 Python/FastAPI + SQLite + 原生 HTML/JS 管理台，NapCat 为单一 QQ 消息通道，onebot-qzone 为独立空间 API。单机只有一个持久调度进程；进程文件锁拒绝重复启动。没有 Redis/MongoDB/向量库。

优先评估 OpenClaw 与候选插件后，本期没有运行 OpenClaw：Gu-Heping 插件 8b284477c87c2d72dd10618a4553eba00b1f4980 的 schema 默认启用 proactive，message-sender 直接发送，另有跨上下文缓存。原样启用不能满足每条发送经过统一门禁、人格不被插件维护、私聊检索事先隔离等约束。直接构建有限的模型调用与渠道适配层，比引入框架后替换其发送、记忆和调度更小。它不是具备任意工具/系统命令能力的 OpenClaw Agent；检索和生图明确不支持，图片理解通过配置模型完成。后续接框架必须先提供受限决策接口且不能访问控制面。

onebot-qzone 锁定 e2c6da0ffea8937adac690352647bb023c312759，MIT。检查其 server/actions/config/client/poller/hub 源码，复用 API 操作，加入独立受限 HTTP 入口。禁用上游轮询、启动写探测、原始日志与环境文件 Cookie 自动写回入口；只有 Python 调度发起只读轮询。扫码显式 headless=true。依赖修补仅更新允许范围内的安全版本，修改 package-lock 并保留原版本源码；记录生产 audit 结果。

运行隔离：控制台 qqagent 用户；空间 qqagent-qzone 用户；QQ 在容器内 UID 19340，挂载仅专用配置/账号缓存，不挂 Docker socket、SSH、宿主目录或机场配置。管理台只能通过 sudoers 中固定 systemctl 动作管理本项目两个服务。模型不注册 shell、文件工具或管理 API；外部输入不拥有管理身份。

人格只在管理 API 中变更，模型得到纯字符串副本。模型仅返回文本/有限 JSON 决策，没有写库或改配置能力；核心正文、成长与工程规则分开。公开空间模型请求不查询好友私聊记忆。模型供应商由主人指定，任意消息不能改变地址或凭据。

QQ 与空间 send_private_msg 的含义不同：Channels.send 的 QQ_ACTIONS 与 QZONE_ACTIONS 分表映射，入队强制动作与渠道匹配。空间 reply_comment 映射 send_comment 的 reply_comment_id/reply_uin，不能误路由到 QQ 私聊。

所有正式发送必须经过 Engine.dispatch/gate，校验人格显式启用、社交开关、好友授权/退订、主动暂停、全部停止、静默时段、配额和固定版本。先落发送账本再调用网络，未知结果不重发；重启取消旧 pending，sending 转 unknown。没有端到端 exactly-once 保证。

自主说说仅在主人录入可公开成长素材（friend 为空、kind=growth、label=fact）后评估，不从私聊自动提取公开内容。无素材跳过模型。长期记忆支持主人管理；自动记忆只保存含明确偏好/约定关键词的用户原句，标为待核实并保留事件来源；成长开关开启后保存偏好原句，不凭空总结或更改人格。
