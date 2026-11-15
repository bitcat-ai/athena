# Athena 数据库设计

状态：**方案与可执行 schema 草案，尚未接入应用**。源码基线为 `09e8937d7c5147bc156a043fb043ba2ac4d67ab4` 及 2026-11-15 核对时的工作区改动。

本设计为“AI 与真实网页交互”提供可靠的本机记录存储，重点是任务、动作、证据和历史资料的数据完整性。它不改变网页工具协议、控制权和审批边界，也不新增账户、云同步或远端业务后台。操作片段及配图继续留待后续补充。

## 1. 当前事实与需要解决的问题

| 当前位置 | 保存内容 | 当前一致性边界 |
| --- | --- | --- |
| `workspace.json` | 设置、对话、消息、图片、操作录制、引导记录 | 单文件临时写入后 rename；流式更新会重写整个聚合 |
| `usage.json` | 独立用量、累计基线、质量标记、价格快照 | 与消息单独提交；重启时运行中记录转 interrupted/partial |
| `learning/learning.json` | 有依据的行为规范和业务知识 | 独立写入；加载异常存在回退默认内容的路径 |
| `repositories/mappings.json` | 网站/模块到前后端仓库的确认映射 | 独立写入；与源码传输和发布状态不同 |
| `knowledge/入口哈希.json` | 已读取文档、来源、版本、失败和 partial | 每个入口一个快照，检索前需处理身份与缓存边界 |
| `agent-browser/ab-UUID.json` | 网页执行会话及分发日志 | 与聊天记录独立保存，不代表仍有效的页面会话 |
| `requirements/…/PRD-UUID.md` | 需求和页面预览证据 | 独立文件；需检查实际字节数及哈希 |
| `feishu/credentials.enc`、`inbox/*.enc` | 凭据、绑定和入站消息 | 专门的 safeStorage 加密文件；不能明文搬进新库 |

`Store` 与 `UsageStore` 在非文件不存在的加载错误下报错保留原文件，`Learning` 和仓库映射有默认值回退路径。这些行为不能统称为“损坏后自动恢复”。当前运行中的网页对象、草稿及待发送队列也并不都持久化。

需要改进的具体问题：

1. 用户消息、助手轮次和用量开始/结束不能原子提交，异常时可能不同步。
2. 消息顺序、父子归属、去重和删除保留规则分散在代码里，缺少统一约束。
3. 小幅流式变化重写大 JSON；列表、日志和图片不能充分按需读取。
4. 升级、导入、备份与恢复需要可核对的版本、来源和失败边界。

## 2. 选型与运行边界

### 2.1 推荐 SQLite，而非新增数据库服务

每个现有 Local profile 使用一个 `userData/athena.sqlite3`。数据库放在本机磁盘，不放在网络共享或多机同步目录中共同写入。SQLite 提供事务、关系约束和索引，符合当前单机桌面应用的目标；它不会自动提供多用户服务、加密或云同步。[官方适用场景](https://www.sqlite.org/whentouse.html)

本机纯内存探测已确认：Electron **45.1.0**、Node **24.22.1**、SQLite **3.53.4**，内置 `node:sqlite` 可用。先使用这个已安装能力，不为设计添加 ORM 或原生依赖。Node 24.22.1 的 SQLite API 仍为 Release candidate，最终安装包必须再次验证，不能用系统 Node 或系统 sqlite3 的版本代替。[版本化 API](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html)

### 2.2 单一所有者与线程模型

一个专用 Node worker 拥有写连接、prepared statements、短事务队列及迁移流程。Electron 主进程仍负责权限和业务编排，通过有限的领域命令调用 worker；渲染进程只走现有 IPC，不传任意 SQL、数据库路径或连接对象。

`DatabaseSync` 的方法同步执行，在外面套 `async` 不会使它脱离主事件循环。先采用一个 worker，不同时引入 worker 与 utility process 两套层级。实施时需要验证 worker 打包路径、关闭等待、错误传播和失败后的只读处理。

### 2.3 每个连接的明确设置

| 设置 | 方案值 | 原因 |
| --- | --- | --- |
| `foreign_keys` | `ON`，开始事务前设置并读回 | 防止连接漏开外键；事务内修改无效 |
| `journal_mode` | `WAL`，本机磁盘 | 允许读写并行，仍只有一个写事务 |
| `synchronous` | `FULL` | 优先保护已确认提交的耐久性；通过合并小写入降低频率 |
| `busy_timeout` | 5000 ms 起点 | 有界等待锁；超时返回明确失败，不重放外部操作 |
| `trusted_schema` | `OFF` | 避免把数据库 schema 当作任意扩展代码执行环境 |

SQLite 官方记录了旧版本 WAL-reset 竞争问题；本方案验证使用的 3.53.4 已跨过 3.51.3 修复门槛。系统 sqlite3 3.51.0 不作为并发 WAL 验收依据。以上设置仍需在最终构建与真实负载下验证，不提供未测量的吞吐量承诺。[WAL 说明](https://www.sqlite.org/wal.html)

## 3. 哪些数据进入数据库

### 3.1 持久记录

首阶段把现有历史记录按原语义映射到数据库：对话、消息、工具记录、网页执行证据、用量、录制、记忆、仓库映射、知识快照和产物元数据。入站飞书消息以专门加密负载迁移，凭据文件保持原位置和钥匙串身份。

消息图片目前单张不超过 5 MiB、每条最多 4 张、合计不超过 10 MiB。v1 使用受限 BLOB 表保存，避免立即引入另一个附件文件事务协议，也避免继续以 Base64 嵌入整个会话 JSON。列表查询不加载图片；打开对应消息时按需读取。图片实际格式与字节头仍复用应用入口校验。

PRD、下载与沙箱产物继续作为文件，数据库保存路径、归属、准备状态、字节数和哈希。不能把任意项目文件自动搬入数据库，或因删除对话而删除用户项目中的文件。

### 3.2 只保留在运行时

不持久化为可执行对象：Chrome/CDP 连接、当前 tab/frame 活句柄、ElementRef 验证 Map、surfaceEpoch、Agent 控制许可、共享邀请与控制权、当前 observation/recovery 对象、待批准请求、进程对象及队列中的函数闭包。

这些对象可以在历史证据 JSON 中保留标识和值，但恢复后只能用于阅读。恢复数据库不能恢复它们的执行有效期、用户批准或业务副作用。草稿和排队意图的跨重启保存是另一个产品行为变更：未来若加入，应恢复成等待用户确认的草稿，不能序列化闭包或自动发出任务；不把它伪装成首阶段无损替换已经提供的能力。

### 3.3 不归本数据库所有

Chrome profile、各 CLI 的原生会话与认证、macOS 钥匙串、实际项目仓库、Docker 卷和沙箱守护进程自身的状态继续由相应组件管理。数据库只保存必要的历史关联，不接管或重写这些系统。

## 4. 表结构与归属关系

完整字段、类型、CHECK、外键和索引以 [schema.sql](database/schema.sql) 为准。草案共 21 张表，均为 STRICT；状态与布尔值另有约束，JSON 用 TEXT 承载并校验语法及根类型。需要以现有 JavaScript Number 接口读回的整数约束在安全整数范围内；版本号另使用正整数范围，不静默把超界值改成零或不精确的 Number。

| 表 | 主键/业务键 | 内容及关系 |
| --- | --- | --- |
| `schema_migrations` | `version` | schema 版本、脚本校验和、应用时间；与 user_version 同事务提交 |
| `import_sources` | `source_key` | 不可变源快照的哈希、大小、记录数及导入时间；避免重复/漂移导入 |
| `workspaces` | `id`；`path` 唯一 | 任务目录值；不等于整个本机档案或云账户 |
| `app_state` | `id=1` | 当前目录引用、设置、引导、记忆开关及用量时间范围 |
| `conversations` | `id`；`history_order` 唯一 | workspace 归属、标题、Agent、原生会话键、原列表顺序、归档与配置快照 |
| `messages` | `id`；`conversation_id+ordinal` | 消息正文与顺序；details 保存可变历史上下文 |
| `tool_calls` | `message_id+call_id` | 单轮调用、结果与耗时；不同轮可有相同 call ID |
| `execution_events` | `message_id+event_id` | 页面操作、观察、核对、恢复和产物事件；按 ordinal 排序 |
| `message_images` | `message_id+image_id` | 受限图片 BLOB；随所属消息删除 |
| `usage_records` | 原 `UsageRecord.id` | 独立计量与价格快照；可选 message FK 删除后置空，记录保留 |
| `recordings` | `id`；`history_order` 唯一 | 独立录制，保留原列表顺序，不强行归属于某一对话 |
| `recording_steps` | `recording_id+id` | 动作、历史目标及来源；ordinal 保留真实顺序 |
| `web_sessions` | 原网页 session ID | 网页分发日志汇总；可选 message FK，保留历史来源键 |
| `web_dispatches` | `session_id+dispatch_id` | 会话内工具分发和脱敏回执；页面键仅为历史线索 |
| `learned_items` | `id`；`ordinal`；kind+scope+title 唯一 | 规范与知识、原数组顺序、来源、启停状态和修订次数 |
| `repository_mappings` | `id`；origin+module 唯一 | 经确认的网站与业务模块映射 |
| `repository_components` | `mapping_id+component` | 前端/后端仓库、目录和分支；映射内部的组成项 |
| `knowledge_indexes` | `authority_key+root_url` | 知识索引身份域、入口、partial 与失败清单 |
| `knowledge_documents` | authority+root+url | 某索引快照内的正文、版本与哈希；不跨身份合并 |
| `artifacts` | `id` | 文件元数据；pending/ready/missing 与 managed/external 归属 |
| `feishu_inbox` | 原 appId:messageId 哈希键 | 加密消息负载、处理状态和可选本轮消息关联 |

### 4.1 显式列与 JSON 的分工

参与关联、筛选、排序和去重的字段拆成列；不稳定的历史快照保留为 JSON。写入层规定每个字段只有一个权威位置，不能同时在列和 JSON 中维护两份可变真值：

- `app_state.settings_json` 不重复保存被列接管的 workspace/workspaceMode；其余既有设置与未知扩展字段保留。
- `conversations.metadata_json` 保存模型选择、工具指纹、历史 session ID、Skill 使用与任务能力选择等未拆列字段。
- `messages.details_json` 保存 displayText、context、mentions、plan、model、failure、phase、requests，以及原 webSessionId 历史键；tools、execution、images 由子表接管。
- `execution_events.evidence_json` 保存 summary/evidence、plan、artifact 等剩余历史字段；不会创建可再次执行的 Observation 对象。
- `web_sessions.summary_json`、`web_dispatches.details_json` 保存未拆列的原始摘要与脱敏回执字段。

JSON 校验只证明结构合法，业务字段、精确身份和凭据过滤仍由受控写入命令验证。SQLite 的 CHECK(NULL) 会放行，草案因此对必填列使用 NOT NULL，并对必要的可空组合显式判断。[约束语义](https://www.sqlite.org/lang_createtable.html#constraints)

### 4.2 不能被迁移改变的语义

- 保留原 Conversation、ChatMessage、Recording、LearnedItem 和用量 ID；不把所有历史 ID 强制改成 UUID。
- 旧对话没有 workspace 时使用 `legacy-unscoped`，保持旧选择规则，不擅自归入当前目录。
- 旧对话没有 agent 时保存 NULL，在领域读取边界仍按 Codex 解释；不迁移为用户当前默认 CLI。
- 未知 token 字段为 SQL NULL，显式零保留为 0；基线、最后累计值、mixed-model、partial、issues 和定价快照一并保留。
- 录制来源 human/agent、预览来源 user/agent、参与者身份和控制权不能合并为一个字段。
- 字符串时间或损坏对象不能静默“修复”为当前时间、空内容或成功状态。
- 对话与录制按原数组顺序恢复；记忆 rule 按原 items 顺序进入上下文预算。相同时间或系统时钟回退不能改变默认录制选择或规则优先次序。

## 5. 完整性与删除策略

| 规则 | 数据库措施 | 仍由应用负责的部分 |
| --- | --- | --- |
| 消息属于真实对话 | messages → conversations 外键 | 当前会话可写、未归档及任务许可 |
| 同一父对象内顺序唯一 | message/tool/event/step ordinal 唯一键 | 只分配不回收旧序号；同毫秒事件仍保持顺序 |
| 飞书路由选择确定 | workspace+remoteChat+history_order 部分索引；history_order 保留原数组顺序 | 按原顺序选择首个未归档匹配项，继续做身份绑定与群内 @ 校验 |
| 图片不超预算 | 单张 CHECK、总数/总字节触发器，替换旧主键时也核对新总量 | PNG/JPEG/WebP 字节头、信任边界与 UI 草稿校验 |
| 记忆有依据 | basis/evidence/source 条件 CHECK | 依据是否真来自用户原话或宿主记录 |
| 映射组成有效 | component 枚举、映射外键、复合主键 | 每个映射至少一个 component，须在聚合事务提交前检查 |
| 知识不跨身份混用 | authority+root 复合主键和逐列 NOT NULL 外键 | 当前认证身份、权限重新核对和缓存时效 |
| 文件就绪有证据 | ready 必须有 bytes 与 sha256 | 文件是否存在、哈希是否匹配、路径和归属是否可信 |
| 用量不重复计量 | record ID 主键及可选 message 唯一关联 | 累计快照差分、回退与模型切换的业务处理 |

删除对话时，消息及其 tools/events/images 级联删除；用量、网页独立日志和产物元数据的可选 message FK 置空，保留原历史键。录制、记忆、仓库映射、知识快照和 CLI 自身历史不级联删除。文件产物不因数据库行变化自动 unlink，需按其归属与用户选择单独处理。

归档保留全部记录，只改变可见性和可继续执行状态。活动任务不能归档或删除的约束依然由主进程持有，数据库不能从“某行 status 看起来结束”推导当前进程已停止。

同一飞书会话可能在旧对话归档后建立新对话，再由用户恢复旧对话。不能给“所有未归档对话的 remoteChatId”直接加唯一约束而使原恢复功能失效。v1 以 history_order 保留现有数组首次匹配语义；若未来要引入显式路由选择，应作为单独产品行为变更。

## 6. 事务与写入协议

### 6.1 需要一起提交的事实

| 领域动作 | 一个事务内提交 | 事务外执行 |
| --- | --- | --- |
| 接受一轮任务 | 用户消息、助手消息、顺序及对话更新时间、usage 开始记录 | CLI 准备、模型请求和网页操作 |
| 流式批次 | 正文增量结果、相应 tools/events 与 revision | 等待后续模型数据 |
| 轮次结算 | 消息终态、phase/失败说明、结束事件与已知用量结算 | UI 通知和远端回传 |
| 归档/恢复/删除 | 对话标记及数据库内部归属处理 | 取消队列、关闭原生会话等宿主操作 |
| 写入仓库映射 | 映射与所有 component | 用户确认、Git 网络操作 |
| 替换知识快照 | 指定身份域下完整索引及文档集合 | 飞书读取和网络分页 |
| 导入一组旧记录 | 目标记录、来源 manifest 和版本标记 | 读取及核对只读源快照 |

不在事务中等待网络、用户审批、文件下载或 Git 推送。SQLite 提交成功只证明本地记录提交，不证明网页业务动作成功。外部操作的未知结果继续由网页恢复屏障处理。

### 6.2 流式与迟到事件

正文可以在短时间窗口内合并写入；终态、重要动作前后的耐久记录及退出前 flush 必须等待确认。窗口的具体值由后续负载测试确定，不把当前 500 ms debounce 当成数据不丢失保证。

消息使用 revision 和状态前置条件更新，例如 `WHERE id=? AND revision=? AND status='streaming'`。影响行数为 0 表示冲突或已结束，返回当前状态，不覆盖更新的记录。主进程同时校验任务 generation、session 和 abort；数据库版本号不能替代停止授权。

领域写入使用明确的 INSERT、UPDATE 或经过校验的 UPSERT，不用 INSERT OR REPLACE 替换会产生关联删除的业务对象。图片 INSERT 触发器仍会排除旧主键的原字节后检查新总量，避免替换路径绕过预算；这不意味着 REPLACE 可以作为其他对象的通用更新方式。

### 6.3 文件与消息边界

外部文件采用 pending → 写入临时文件并核验 → 受控发布文件 → ready 的流程。发生中断时，按元数据、实际文件及哈希重新核对，缺失标为 missing，不把“路径字符串存在”当作文件已生成。对于用户目录里的 external 文件，自动清理不拥有删除权限。

入站飞书去重仍沿用 `SHA-256(appId:messageId)`。数据库 envelope v1 的加密明文结构为 `{appId, message, kind}`，不重复保存 status；旧 InboxItem 的 status 映射到数据库 state 列。主进程解密后须核对字段、当前绑定和 dedup_key，状态列不能单独授权执行。worker 不持有钥匙串密钥。旧 `.enc` 的转换必须在原应用密钥身份下执行，不通过外部迁移脚本改写钥匙串；收到未知结果时不自动回传或重试任务。

## 7. 索引与查询方案

对话列表按现有界面规则读取，原数组顺序通过 history_order 保留，按更新时间显示的列表使用单独索引；消息按 conversation+ordinal 分页；tools/events/images 按 message 加载；录制步骤按 recording+ordinal 读取；网页日志按 session 和时间定位；用量按日期、Agent、模型过滤。索引已列入 SQL 草案，子外键查询路径也有相应索引。

录制默认列表按 history_order 降序，记忆 rule 按 ordinal 升序进入预算；knowledge 依次按网站适用优先、updated_at 降序、ordinal 升序排列，以保留原稳定排序的并列顺序。

首阶段保留现有中文子串搜索语义，可使用参数化 LIKE，并转义用户输入中的 `%`、`_` 与转义符。前导通配符不会天然得到普通 B-tree 的全文加速，不宣称当前索引已经优化全文检索。FTS5 分词或 trigram 方案应在确有规模需求并验证中文行为后另行引入。

页面截图流、mousemove 高频事件、实时 DOM 和每次图像帧不逐帧落库。数据库保存有意义的历史动作与证据，不把捕获流变成无限增长的事件数据库。运行日志的保留策略应按具体数据类别与用户选择制定，不能套用“删聊天就删全部”的捷径。

## 8. 旧文件迁移与切换

### 8.1 迁移前提

停止产生新写入并关闭旧持久化所有者；确认没有另一实例持有同一档案。读取旧源时区分缺失、空文件、损坏和权限错误；有既有源却读取失败时禁止创建空库并覆盖配置。保存文件清单、SHA-256、字节数及只读副本，原文件不修改、不删除。

预检至少报告：重复全局消息 ID、父子归属错误、同父顺序冲突、相同来源的重复用量、全局记忆业务键冲突、非法 JSON/状态/图片，以及无法解释的历史关联。存在多个飞书路由候选时保留原数组顺序，不合并或删除历史。不能靠重命名 ID、丢弃重复行、补零或伪造父实体让导入“通过”。

### 8.2 来源映射

| 旧来源 | 新对象 | 处理方式 |
| --- | --- | --- |
| workspace settings / onboarding | workspaces、app_state | 保留可解释字段和缺省语义；不创建实际项目目录 |
| conversations / messages | conversations、messages 及子表 | 对话数组按 N-1-index 转 history_order，新对话递增；消息等子数组按原序转 ordinal；原 ID 不变 |
| messages.images | message_images | 按既有图片校验解码为 BLOB；失败不跳过 |
| usage.json | usage_records + app_state 用量时间范围 | 可解析关联填 message_id；孤立记录保留 id，关联为空 |
| recordings | recordings、recording_steps | 顶层按 N-1-index 转 history_order，新录制递增；步骤按原序转 ordinal，保留分段和 actor |
| agent-browser 日志 | web_sessions、web_dispatches | 保留日志会话身份；缺失的聊天父引用不伪造 |
| learning.json | learned_items | 原 items 顺序转 ordinal，新条目追加递增；保留依据、来源、启停与修订次数，不重算授权 |
| mappings.json | repository_mappings/components | 保留已确认映射；冲突先报告 |
| knowledge 索引 | knowledge_indexes/documents | 原文件没有明确身份域时隔离为 legacy-unknown，不参与正常检索；按当前身份重新索引 |
| PRD 与产物 | artifacts + 原文件 | 只登记经过核对的文件；历史文件缺失保留缺失事实 |
| feishu inbox | feishu_inbox | 原应用解密校验并重新封装加密负载；凭据继续原方案 |

### 8.3 候选库与幂等

在新的候选路径创建库，先应用 schema，再以事务导入记录和 source manifest。同一 source_key、同一 hash 的重复导入返回已处理；同 key 不同 hash 必须停止并要求重新确定快照，不能 UPSERT 静默覆盖。不同字段、序号和身份冲突整体回滚，不部分吞掉错误。

检查 `integrity_check`、`foreign_key_check`，再核对数量、ID 集合、顺序、原文/图片哈希、NULL 与 0、归档、来源、用量质量和独立保留语义。数据库检查不能替代这些业务核对。

### 8.4 切换和回退

验证后关闭候选库及旧写入者，发布一个明确的存储版本标记并启用单一数据库写入路径。不开启长期 JSON+SQLite 双写；旧 JSON 作为迁移前快照封存。切换前失败可放弃候选库继续使用未改变的原数据。

新库已接受后续写入后，不能直接回到旧 JSON，否则会丢失新记录。降级需要已验证的逆向导出或恢复数据库备份；旧应用发现数据库存储标记/不支持的版本应拒绝写入。实现完成前必须准备这一门槛，不能只在新版应用里检查 user_version。

## 9. 重启、备份与恢复

### 9.1 重启不重放

在一个恢复事务中将未完成助手消息标记 error，运行中工具标记结果未知，用量运行态改为 interrupted/partial，入站 pending/running 改为 unknown，并补充恢复事件。这里的 SQL 是拟议行为；与当前飞书一律标 failed 的细微展示差异需在实现中显式映射，不能假装没有状态模型变化。

不自动执行排队函数、批准请求、重新提交表单或回传飞书。保存的历史键不恢复 tab/frame/element 引用、控制许可、共享邀请或原生进程；重新连接后先观察和核对。

### 9.2 可验证的备份包

协调写队列后，用 Backup API 写到新的临时目标，完成校验后再发布；不覆盖唯一备份。活动 WAL 可能含尚未 checkpoint 的已提交数据，不能只复制 `.sqlite3` 主文件。`integrity_check` 和 `foreign_key_check` 都需要运行。[备份 API](https://www.sqlite.org/backup.html)

备份包包括数据库快照、schema/应用版本、文件清单及其哈希；对由应用管理的 PRD 等文件按清单复制和检查。external 文件只记录位置与缺失状态，除非用户授权纳入备份。数据库内消息图片由数据库快照一并保存。

原钥匙串保护的凭据可作为不解密的加密文件保存，但不能承诺跨 Mac 直接恢复认证。Chrome profile、CLI 原生会话、项目仓库与 Docker 卷不自动包含在数据库备份内，必须在备份说明中明确范围。

### 9.3 恢复流程

先关闭全部目标库连接，在临时位置验证备份、版本、关系及附件，再以可回退方式替换。高于当前支持版本的数据库拒绝写入，缺失附件标为 missing 并报告。不得通过删除 WAL、创建空库或自动 VACUUM 来掩盖损坏。

SQLite 默认不加密整库。数据库、WAL、备份及临时文件使用本机私有目录和受限文件权限；入站密文与凭据继续专门加密。加密、授权、备份完整性与关系约束是不同层次的问题。

## 10. 分阶段实施与验证结果

| 阶段 | 工作 | 进入下一阶段的条件 |
| --- | --- | --- |
| 本轮：设计 | schema、读写/删除契约、来源映射、恢复与备份设计 | 设计与隔离检查通过；不切换真实数据 |
| 存储组件 | worker、有限领域命令、连接配置、关闭/错误传播 | 单元与实际 Electron/打包加载验证；无任意 SQL IPC |
| 迁移器 | 源快照、预检、候选库、计数/哈希/语义核对 | 合成、损坏、重复及可授权副本场景通过；原源未变 |
| 应用接入 | 逐个替换 Store/Usage/记录等调用链 | 原生会话归属、停止、归档、删除、用量与录制回归通过 |
| 发布 | 备份、版本门槛、切换/回退、安装包 | 指定构建的实际迁移和恢复验收，随后单独发布 |

本轮用项目自带 Electron 运行 [verify-design.mjs](database/verify-design.mjs)，在新临时目录和合成数据上完成 **21 项检查**：连接设置与 schema 事务、外键/顺序/JSON、旧无作用域记录、归档恢复与确定路由、消息+用量回滚、NULL 用量、安全整数边界、调用去重、图片预算及 REPLACE 反例、记忆依据、录制与记忆顺序、映射组成、知识身份域、产物/inbox约束、乐观并发、重启未知态、删除保留、导入幂等、WAL 读写锁、备份及文件清单、未来版本拒绝与完整性检查。

复现命令：

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron docs/database/verify-design.mjs
```

验证脚本不打开 Athena 界面，不访问 userData，不解密真实凭据，不修改旧 JSON；其合成 cipher BLOB 只测试数据库承载与去重，不证明加解密或完整迁移器已实现。尚未验证实际存量迁移、worker 打包、长期负载、真实磁盘故障、整应用恢复及跨设备认证恢复。

## 11. 文档关系

- [官方依据与研究](database/research.md)：选型、NULL、事务、WAL、备份及 Node 版本约束。
- [ADR-0005](adr/0005-local-sqlite-persistence.md)：拟议决策和取舍，状态 proposed。
- [SQL 草案](database/schema.sql)：唯一的字段、约束与索引定义。
- [设计检查](database/verify-design.mjs)：可重跑的合成场景验证。
- [验证记录](database/validation.json)：本轮运行时、schema SHA-256 和检查结果；不是应用接入验收。
- 现有技术方案、架构设计及 E-R 材料继续描述当前网页交互实现；数据库方案以“拟议、未接入”补充链接衔接，不把设计写成已上线能力。

## 12. 后续展示位置

### 12.1 数据库与本地文件关系配图

### 12.2 迁移、恢复与网页核对操作片段

## 13. 设计附件

设计交付包含 `schema.sql`、`verify-design.mjs` 和 `validation.json`。SQL 是拟议建表方案，检查脚本只使用新的临时目录及合成数据，验证记录绑定该 SQL 的 SHA-256；这些文件均未接入 Athena 启动或安装流程。在线文档在本节附上对应文件，仓库内以 `docs/database/` 目录为准。

