# Athena 本地数据库设计：官方依据与实施约束

核对日期：2026-11-15。源码基线：`09e8937d7c5147bc156a043fb043ba2ac4d67ab4` 及当时工作区改动。

本文是设计研究，不是数据库已经接入应用的证明。范围是本机数据完整性、存储边界与迁移安全；不新增账户、云同步或远端业务服务，不读取或修改实际用户数据。

## 1. 当前事实与选型结论

当前 `Store`、`UsageStore`、`Learning`、`RepositoryService` 分别保存 `workspace.json`、`usage.json`、`learning.json`、`mappings.json`，使用各自的临时文件与 rename 路径。它们没有形成跨文件事务；不同模块的加载失败策略也不相同。见 [Store](../../src/main/store.ts)、[UsageStore](../../src/main/usage.ts)、[Learning](../../src/main/learning.ts)、[RepositoryService](../../src/main/repository-service.ts)。

| 方案 | 对当前 Athena 的意义 | 设计判断 |
| --- | --- | --- |
| 保留 JSON | 最少运行时变化，适合小型配置、导出交换和原始迁移备份；关系约束、局部更新及跨文件一致性需应用自行实现。 | 继续用于有意保留的边界数据，不应仅为“统一格式”把所有文件搬入数据库。 |
| 嵌入式 SQLite | 不新增常驻数据库服务器，可在本机应用内提供事务、关系约束和索引。 | 优先候选，适合当前单机桌面应用的持久业务记录。 |
| 远端关系数据库 | 适用于多个客户端共同维护中心数据，另需服务端身份、运维与网络故障设计。 | 当前没有这些明确需求，不作为本次设计默认方案。 |

上述选型是针对本项目的设计推断。SQLite 官方将本地应用/设备存储和桌面应用文件格式列为适用场景，并将多客户端中心数据与高写并发场景交给 client/server 数据库讨论；不能由此得出未经本项目测试的性能倍数。[SQLite 适用场景](https://www.sqlite.org/whentouse.html)

根任务已用本项目 Electron 二进制，在 `ELECTRON_RUN_AS_NODE=1` 模式中执行纯内存探测，报告：**Electron 45.1.0、Node 24.22.1、SQLite 3.53.4，`node:sqlite` 的 `DatabaseSync` 可用**。这证明该开发二进制具备候选驱动能力，不证明应用已集成、打包后可用或数据迁移通过。`package.json` 声明和 esbuild 的 `target: node22` 也不能单独证明 Electron 实际运行时能力。

## 2. 类型、NULL、JSON 与关联约束

### STRICT 不是完整领域校验

`STRICT` 自 SQLite 3.37.0 起可按表启用，只允许 `INT`、`INTEGER`、`REAL`、`TEXT`、`BLOB`、`ANY` 这组类型名。可无损转换的输入仍可能被转换，所以它不等同于 TypeScript 的原始输入类型校验。状态枚举、时间范围、非空字符串等仍需 `NOT NULL`/`CHECK` 和应用入口校验；不要在 STRICT DDL 中写 `BOOLEAN`、`DATETIME` 或 `JSON` 类型。[STRICT Tables](https://www.sqlite.org/stricttables.html)

### 必须显式处理 NULL

- `CHECK` 结果为 SQL NULL 时不会违反约束；`CHECK (count >= 0)` 不会禁止 NULL。必填列另加 `NOT NULL`，未知用量等真正可空字段则保留 NULL 语义。
- `UNIQUE` 将不同 NULL 视为不同值。可空字段参与业务去重时，应先明确缺省值的领域含义，再选择非空规范化键或分开的部分唯一索引。
- 普通非 STRICT 表的某些主键形式仍可能允许 NULL。新设计的文本主键应显式 `NOT NULL`，不要依赖历史兼容行为。

这些都属于 SQLite 定义的约束语义，不是测试偶发现象。[CREATE TABLE：约束](https://www.sqlite.org/lang_createtable.html#constraints)

### 外键要按每个连接核对

每个连接在事务开始前设置并读回 `PRAGMA foreign_keys = ON`；事务中切换该值无效。父关联键必须是匹配的主键或 UNIQUE 键；子侧关联字段通常需要索引。复合外键中任一子列为 NULL 可使该行无需匹配父行，因此必填关系应逐列非空，可选复合关系要防止只填一半。[SQLite Foreign Keys](https://www.sqlite.org/foreignkeys.html)

### JSON 只承担明确的可扩展负载

SQLite JSON 通常保存在 TEXT/BLOB 中。使用 TEXT 草案时可用 `json_valid()` 验证语法，再检查根类型。`json_valid(NULL)` 返回 SQL NULL；`json_extract` 对缺失路径或 JSON null 也会返回 SQL NULL。不能把 `CHECK (json_extract(payload, '$.type') = 'expected')` 当作必填字段校验。需要区分缺失与 JSON null 时使用 `json_type`，必填条件用非空列及明确的 NULL 判断。[JSON 函数](https://www.sqlite.org/json1.html)

**设计建议：**需要关联、过滤、排序和去重的关键字段使用显式列；工具参数、历史页面片段等变动较大的快照可以作为有版本的 JSON 负载。数据库记录保存历史证据，不恢复浏览器 ref、控制令牌或原审批的执行有效性。

## 3. 事务、并发与持久性

SQLite 允许多个读事务，但同一数据库同时只有一个写事务。`BEGIN IMMEDIATE` 会立即争取写事务，遇到其他写者可能返回 `SQLITE_BUSY`；普通读事务升级为写事务也可能失败。事务嵌套使用 SAVEPOINT；遇到约束或 I/O 错误不能假定整批操作已自动回滚，应按驱动状态显式结束事务。[Transaction](https://www.sqlite.org/lang_transaction.html)

**设计建议：**数据库由一个明确的写入所有者管理，使用短事务和有界任务队列。流式文字可以批量提交；完成状态、相应执行事件和用量结算等需要共同成立的事实应在同一数据库事务中提交。网络、模型调用、文件下载和用户审批不放在长事务中等待；重试需要稳定请求键，不能直接重放外部副作用。

WAL 可允许读写并行，但不增加同时写事务数量，且要求所有连接位于同一主机，不适合放在网络共享文件系统上。WAL 下多个 ATTACH 数据库只能各自保证事务原子性，不能作为一组原子提交。长读事务还可能阻止 checkpoint 完成并导致 WAL 增长。[WAL 工作方式](https://www.sqlite.org/wal.html)

`synchronous=FULL` 在 WAL 下为每次提交增加同步；`NORMAL` 保持一致性，但断电或系统崩溃后可能丢失已提交事务。对要求已确认数据耐久的业务记录，方案可优先选择 WAL + FULL，再通过批量写入控制频率。若选择 rollback journal 且需要更强断电耐久性，应评估 EXTRA，不能把所有 journal 模式的 FULL 语义写成相同。[synchronous 语义](https://www.sqlite.org/pragma.html#pragma_synchronous)

### WAL 版本门槛

官方记录的 WAL-reset bug 影响 3.7.0–3.51.2，在两个以上线程/进程连接同时写入或 checkpoint 的特定竞争下可能损坏数据库；3.51.3 及之后版本修复，部分旧分支另有回移。根任务实测的 3.53.4 已跨过该修复版本。系统命令行显示的 SQLite 版本不能代替最终应用实际链接版本的验证。[WAL-reset 说明](https://www.sqlite.org/wal.html#walreset)、[3.51.3 发布记录](https://www.sqlite.org/releaselog/3_51_3.html)

## 4. 备份、外部文件与恢复

运行中的 WAL 数据库状态涉及主库、`-wal` 与 `-shm`。`-wal` 可能包含已提交但尚未 checkpoint 到主库的数据；`-shm` 是可重建的协调索引。不能把活动主 `.db` 文件直接复制成“完整备份”，也不能分别在不同时点复制主库和日志后随意拼接。[WAL 文件格式](https://www.sqlite.org/walformat.html)、[SQLite 损坏风险](https://www.sqlite.org/howtocorrupt.html)

在线备份优先采用 SQLite Backup API。它在成功完成后提供一致数据库快照；频繁并发写入可能导致重启备份工作，所以应用仍需有完成/失败状态和合理的写入协调。备份文件已出现不代表备份成功。[Online Backup API](https://www.sqlite.org/backup.html)

`VACUUM INTO` 是另一种一致快照方式，可得到压缩副本；若执行过程中意外中断，输出仍可能不完整。使用新临时目标，成功结束并检查后再发布成备份；不能以目标文件存在作为完成条件。[VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)

**设计建议：**SQLite 事务不能同时原子提交外部截图、PRD 和附件文件。若保留外部文件，采用稳定文件标识与内容哈希，区分准备中和已就绪记录，并定义中断后的缺失文件/孤立文件检查。完整备份应协调业务写入，保存数据库快照与附件清单，并验证清单中的文件；数据库备份不等于完整工作区备份。恢复前关闭所有使用目标库的连接，恢复到临时位置并检查，避免替换仍被打开的库。

## 5. Node / Electron 接入位置

Node **24.22.1** 官方 API 明确 `DatabaseSync` 与 prepared statement 的方法同步执行，模块稳定性标记为 **1.2：Release candidate**。构造选项中外键默认开启，但仍应显式配置并读回；`timeout` 默认为 0，需要方案明确锁等待策略。API 版本必须与实际运行时对应，不能照抄最新 Node 主版本的类名与行为，也不把候选 API 描述成永久兼容承诺。[Node 24.22.1 SQLite](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html)

**设计建议：**不要因接口外面套了 `async` 就把同步数据库操作留在 Electron 主事件循环。先采用单个专用 worker 承担连接、查询、写队列和迁移，主进程只发送有限业务命令并处理响应；禁止渲染页面提交任意 SQL。worker 的创建、消息传输及错误退出是 Node 官方能力，但本项目实际打包、关闭等待及崩溃传播仍需验证。[Node Worker Threads](https://nodejs.org/download/release/v24.22.1/docs/api/worker_threads.html)

如果后续明确需要进程级故障隔离，可使用 Electron `utilityProcess`。它是带 Node 和 MessagePort 的子进程能力，代价是独立进程生命周期与 IPC；不是设计阶段必须同时引入的第二套执行层。选择 worker 或 utility process 都不应让渲染层直接打开业务库。[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)

Node 24.22.1 的 `sqlite.backup()` 返回 Promise 并封装 SQLite Backup API；目标已存在时会覆盖。正式方案应使用新临时目标、完成校验和受控发布，不直接覆盖唯一备份。[Node backup](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)

## 6. 版本迁移与实施门槛

`PRAGMA user_version` 是留给应用管理的整数，SQLite 不替应用解释它；不要用 SQLite 内部的 `schema_version` 代替业务迁移版本。版本号、迁移记录及本轮 DDL/数据变更应形成可核对的提交边界。发现高于当前程序支持的版本时，应停止写入并明确兼容问题，而不是把它当新库重建。[user_version](https://www.sqlite.org/pragma.html#pragma_user_version)

**设计建议：**原 JSON 迁移采用只读源快照 → 新临时数据库 → 显式字段转换 → 数量/标识/语义核对 → 完整性检查 → 决定切换。源文件保持原样；无法解释的数据进入错误报告，不填造成功状态、零费用或伪造父实体。数据库 `integrity_check` 不覆盖外键问题，还应单独执行 `foreign_key_check`；两者也不替代业务级的状态、金额和记录数核对。[SQLite 检查命令](https://www.sqlite.org/pragma.html#pragma_integrity_check)

设计验证应使用本项目实际 Electron 内置运行时和合成临时数据，至少覆盖：必填/非法枚举/重复键、跨归属关联、NULL 未知值、事务回滚、重复迁移、删除保留边界、崩溃后的未完成任务、备份恢复与版本拒绝。SQLite 的提交成功只证明本地事务成功，不证明网页业务动作已完成；数据库恢复不得恢复旧网页引用、控制许可或自动重放外部任务。

## 7. 尚未由本研究证明的事项

- 研究仅写入本文；没有更改应用依赖、运行时或实际数据。根任务提供的内存探测不等于安装包、worker/utility process、WAL 负载或备份恢复实测。
- 最终建表、迁移映射、写入频率与索引选择需由设计草案和针对性验证确定；本文不提供未测量的性能数字。
- 文件权限、凭据加密、敏感正文保护与数据库约束是不同问题；引入 SQLite 不自动把普通工作区内容加密，也不新增云同步授权。
