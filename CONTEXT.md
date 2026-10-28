# Lamplit Post

连接多个 IM 平台与 agent 的通信服务，各 agent 独占自己的账号。Post 管理平台身份、消息记录、接纳与唤醒规则；agent 的推理与执行会话属于消费者。

## Language

**IM 账号（Account）**：Post 管理的一个具体平台身份，例如 QQ Bot App 或 Matrix 用户账号。每个配置账号恰好属于一个 agent，由 bindings.account_ids 关联唯一确定。同一所有者可有多个绑定及多个账号（含同平台），不支持跨 agent 共享或保留账号转移。
_Avoid_: Agent、登录凭证

**账号连接（Account connection）**：Post 使用平台凭证与 IM 账号建立的连接。取得凭证或保存账号不代表连接已就绪；账号连接就绪也不代表 agent 已获准访问任何聊天。
_Avoid_: 聊天授权、消费者连接

**IM 会话（Conversation）**：某个 IM 账号可访问的私聊、群聊或房间，是消息的来源与发送目标。会话名称可用于精确选择当前已授权、已接纳的会话；名称不授予权限，也不是别名，身份仍由平台标识决定；消息中的名称是捕获时的显示元数据，不是路由或授权凭证；它不决定消费者如何划分 agent session。
_Avoid_: Agent session、工作区

**聊天发现（Conversation discovery）**：列出账号当前可供选择的聊天候选。候选的来源和完整性由平台决定；发现或观测聊天不授予 agent 访问权限。
_Avoid_: 聊天授权、完整通讯录

**会话名称（Conversation name）**：供 agent 精确选择已接纳会话的当前名称，保存在一个字段中，可由管理员修改；非空名称不会被后续平台昵称覆盖。没有可用名称时保存稳定、可编辑的生成标签，例如「QQ 私聊 1」，不冒充联系人昵称。既有非空名称原样保留，即使形似 ID。名称不授予权限；重名必须消歧或由管理员改名，内部身份独立固定。消息快照记录捕获时名称，可能与当前名称不同。
_Avoid_: 身份凭证、联系人真实姓名、会话别名

**消费者连接（Consumer connection）**：一个 agent 消费者独立的消息接收地址与接收密钥。该 agent 的所有 IM 绑定共用这一连接，连接可以没有任何聊天授权。
_Avoid_: 平台账号、聊天绑定、所有 agent 共用的连接

**接收密钥（Receiver secret）**：消费者用于验证 Post 消息投递的秘密，属于该 agent 的消费者连接。它与 Agent token 和平台凭证相互独立。
_Avoid_: Agent token、平台凭证、全局共享密钥

**Agent 绑定（Agent binding）**：一个 agent 消费者与可访问的 IM 账号、会话、接纳规则及唤醒规则之间的授权关系。绑定可以关联尚未授予聊天权限的账号，account_ids 同时保留账号所有权，清空聊天不会释放账号；多个 IM 来源可以使用同一个消费者连接与 agent session。
_Avoid_: 每平台一个 agent、平台登录身份

**消息接纳（Admission）**：决定某条消息是否允许向指定 agent 提供正文、附件及上下文的策略判断。Post 观测或归档消息本身不代表接纳；agent 读取历史、访问媒体或发送消息仍须具备相应授权。接纳与是否立即唤醒是不同决定。
_Avoid_: 已唤醒、已授权执行动作

**唤醒规则（Wake policy）**：根据私聊、原生提及、回复关系及明确配置的文本别名，决定是否向绑定的消费者提交一次唤醒投递的规则。消费者仍拥有实际执行队列与 agent session。
_Avoid_: 自动回复、模型执行完成

**原生提及（Native mention）**：由平台结构化消息字段证实的提及事实。发送时可用准确成员名称选择原生 ID：QQ 限本授权会话已观测发言者，不代表当前成员名册；Matrix 使用已加入成员。名称不授予权限，接受后的发送固定原生目标，归档仍只保留原生 ID。文本别名命中不是原生提及。
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
