# Lamplit Post

连接多个 IM 平台与 agent 的共享通信服务。Post 管理平台身份、消息记录、接纳与唤醒规则；agent 的推理与执行会话属于消费者。

## Language

**IM 账号（Account）**：Post 管理的一个具体平台身份，例如 QQ Bot App 或 Matrix 用户账号。同一账号可以被授权给一个或多个 agent 绑定。
_Avoid_: Agent、登录凭证

**IM 会话（Conversation）**：某个 IM 账号可访问的私聊、群聊或房间，是消息的来源与发送目标。它不决定消费者如何划分 agent session。
_Avoid_: Agent session、工作区

**Agent 绑定（Agent binding）**：一个 agent 消费者与可访问的 IM 账号、会话、接纳规则及唤醒规则之间的授权关系。多个 IM 来源可以绑定到消费者的同一个 agent session。
_Avoid_: 每平台一个 agent、平台登录身份

**消息接纳（Admission）**：决定某条消息是否允许向指定 agent 提供正文、附件及上下文的策略判断。Post 观测或归档消息本身不代表接纳；agent 读取历史、访问媒体或发送消息仍须具备相应授权。接纳与是否立即唤醒是不同决定。
_Avoid_: 已唤醒、已授权执行动作

**唤醒规则（Wake policy）**：根据私聊、原生提及、回复关系及明确配置的文本别名，决定是否向绑定的消费者提交一次唤醒投递的规则。消费者仍拥有实际执行队列与 agent session。
_Avoid_: 自动回复、模型执行完成

**原生提及（Native mention）**：由平台结构化消息字段证实的提及事实。文本别名命中不是原生提及。
_Avoid_: 文本里出现名字、执行授权

**已观测历史（Observed history）**：Post 实际接收到的消息及已取得平台发送确认的消息记录。归档范围可以大于某个 agent 的授权范围；记录存在不授予 agent 正文、媒体、历史读取或发送权限。它不代表接入前或停机期间完整的平台聊天历史。
_Avoid_: 完整平台历史、Agent session log

**媒体资产（Asset）**：Post 管理的图片、音频、视频或文件内容及其稳定引用。平台临时下载链接本身不是持久媒体资产。由 agent 的外部工具生成的音频也是普通媒体资产；生成方式不增加访问权限。
_Avoid_: 临时 URL、本地 agent 文件路径

**消息投递（Delivery）**：Post 向一个 agent 消费者传递已接纳消息及唤醒原因的过程。消费者确认持久接收不表示 agent 已执行或已回复。
_Avoid_: 消息已发到 IM、模型回合完成

**发送结果未知（Outcome unknown）**：无法确认一次平台发送是否已生效的结果。缺少本地确认记录不证明消息没有发出。
_Avoid_: 未发送、可以盲目重发

**平台凭证（Platform credential）**：Post 连接 IM 账号所需的秘密，例如 AppSecret 或 Matrix access token。它不向 agent 消费者授予 Post API 访问权。
_Avoid_: Agent token、管理员登录凭证

**Agent token**：识别并授权一个 agent 消费者访问其绑定范围的 Post 凭证。它不充当平台凭证的加密密钥。
_Avoid_: 平台 token、加密主密钥
