# ADR-0003：跨模块最小权限——授权上下文、模块出口与投影

日期 2026-10-01。状态：**候选 r2**（Codex 第 1 轮 REQUEST CHANGES 后修订；通过后随 A7 首个切片生效）。编号接续私有档案的 ADR-0001（原架构 v0.1，只读原件）与 ADR-0002（Phase 0 实施细化）；本文件是公开仓库中的第一份 ADR。

依据（业务规则已由 Owner 确认，本 ADR 只定执行方式）：DG-05 / DG-06 共用设计段 `authorized-projection.md`（随 DG-06 v0.5 确认，K20）、授权管理最低政策 `authorized-projection-policy.md`（Owner 2026-10-01 默认政策 P1–P3 与四个触发条件）、独立技术评议（2026-10-01，Codex）、OD17 / OD18 / OD20 / OD23、经验 L22。三份设计文件在私有档案 `docs/design/dg06-opportunity/`；本 ADR 不复制其中的业务字段表，只引用条款号。

## 1. 背景

- 现状（`packages/domain/src/store-kit.ts`）：每个请求在 `inTransaction` 内从验证后的 Entra 身份找到 `LoginAccount`，要求**至少一条有效的日报角色会员**（`PROJECT_MANAGER` 或 `EXECUTIVE_READER`），得到 `Actor{orgId, accountId, personId}`，再按项目用 `projectAccess` 判 `write`（PROJECT_MANAGER）或 `read`（EXECUTIVE_READER，按项目或全组织）；同时持有两种角色时 `write` 优先。现场设备（`FieldDevice` 令牌）是第二类主体：范围固定为一个项目、一个自然人，身份是 `FieldDevice.id`（幂等重放也按它分键），工头身份由 `CrewAssignment` 在决策时刻判断。
- 已有的投影雏形：`reader-view.ts` 对只读账号的日报只给已提交版本（OD18）、不给照片精确坐标（OD20）；`/days` 对只读账号不列草稿日；只读账号**可以**看确认的计划版本、项目主数据项、问题的实时状态与备注（这些不受提交门限）；照片按其所属项目判断可见，无权项目的照片在读取路径一律 `NOT_FOUND`（不区分“无权”和“不存在”）；同字节文件重传到另一项目或另一天返回 `PHOTO_ELSEWHERE`（“同一文件是一个事实”，OD20），这是一个存在性披露；图片字节只经服务端流式转发，没有 SAS 或预签名链接；错误响应只含 `code` 与每次新生成的 `correlationId`（`ALREADY_CHECKED_IN` 另带 `existing`）。
- 缺口：这些规则分散在各 store 的 SQL 和 if 分支里，没有一处声明“哪个读取面给谁看什么”，也没有机械检查能发现新入口漏了投影；已有跨模块直读（`IssueStore.lag` 自己读 `DailyClose` / `Revision` / `PlanVersion`），包的 barrel 导出全部 store。DG-05 与 DG-06 两个设计包在写入路径上两次（第三次在汇总 / 条款文字）漏掉“方向 × 范围”的反向检查（L22）。A7 要做多项目首页与项目状态，读取面从单项目扩到跨项目聚合（状态计数、过期天数、缺报、未关闭上报、关注项），即使不含金额，也会通过计数与派生提示泄露受限事实。
- 边界：不建通用权限引擎、不建授权管理界面、不设计分包商账号流程（政策 §3 的触发条件出现后另开设计包）。

## 2. 决定

### D1 授权上下文（AuthorizationContext）

- 由服务端在事务内、从验证后的身份与会员关系建立；客户端提交的 `orgId`、角色、授权版本一律不信任（AGENTS 已有规则，此处落为结构）。
- 字段：`principal`（`account` 或 `fieldDevice`）、`orgId`、`accountId`（设备主体为 null）、`deviceId`（账号主体为 null）、`personId`、生效中的授权列表、`authzVersion`（账号主体：`LoginAccount.authzVersion`，见 D5；设备主体：`FieldDevice.generation` 与 A6 决策时刻判断，不变）、决策时刻 `decidedAt`（数据库时钟，不用主机时钟）。
- 每一条授权 = `{能力, 范围, 方向, 有效期, 依据, 授予人/系统}`（设计段 §3）。能力带模块命名空间，同名动作在不同模块是不同能力。
- **过渡映射（封闭，逐模块，等于现状；不新增可见范围或授予权）**。现有 `Membership.role` 视为隐式授权记录，有效访问按 `projectAccess` 现规则取：任一 `PROJECT_MANAGER@project` ⇒ `write`，否则 `EXECUTIVE_READER@project|org` ⇒ `read`。

| 模块                                                   | 有效访问 `write`（PROJECT_MANAGER）                                                                                                           | 有效访问 `read`（EXECUTIVE_READER）                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| report                                                 | `report.view`（草稿、已提交、计划草稿与版本、主数据项）、`report.write`（facts / submit / no-work / correction / plan draft+confirm / items） | `report.view-submitted`（已提交版本、确认的计划版本、主数据项；不见草稿事实、草稿计划、未冻结照片、草稿日的存在）     |
| issue                                                  | `issue.view`（实时状态与备注）、`issue.write`（create / note / escalate / close / reopen / dismissLag）；**无 `issue.reply`**                 | `issue.view`（实时状态与备注，不受提交门限）、`issue.reply`（只读身份的唯一写入；`access !== 'read'` 即拒绝，现规则） |
| photo                                                  | `photo.view`、`photo.write`（upload / link / unlink）                                                                                         | `photo.view-frozen`（只见已冻结照片，无精确坐标）                                                                     |
| field 管理（名单、设备、入口码、签到设置、工地参考点） | `field.admin.view`、`field.admin.write`                                                                                                       | **无**（现为 writer-only）                                                                                            |
| project-status（A7 新建）                              | `project.status.view`、`project.status.declare`、`project.status.reply`、`project.master.write`（主工作项、应报期间）                         | `project.status.view`、`project.status.reply`                                                                         |
| 现场设备主体                                           | `field.device.*`（本人签到、自拍；工头：本组报量、代签）按 A6 设计，不变                                                                      | —                                                                                                                     |

- 首次需要显式授权记录的模块（DG-05 合同）在其首个 PR 追加表，字段按政策 §2 的最小结构（账号 / 会员 / 自然人分离、授权 id、能力、范围对象、方向、期间、授予与撤销事件、来源与模板版本、代岗 / 代录关系）。A7 不新建授权表。
- 独立性判断按 `personId`（自然人）与交易关系，不按账号。设备主体不能持有账号主体的能力；两类主体走同一套出口。

### D2 模块出口与投影 DTO

- 原始实体、Prisma 行和仓储只在所属模块内部可见。跨模块读取只有一种形式：所属模块导出 `xxxReader.forContext(ctx)`，返回**投影 DTO**，DTO 里每个字段都在该模块的字段分层表登记（D3）。
- 控制器、首页 / 收件箱聚合、导出（DG-08）、Worker / 定时任务都只消费投影；不得直接 `SELECT` 另一模块的表做汇总。关联对象由其所属模块投影（设计段 §6）：日报引用的问题由 issue 模块投影，项目卡片引用的最新状态由 project-status 模块投影。
- 机械边界（四件事，各自只能抓到一类旁路，合在一起覆盖 §1 列出的失败形态）：
  1. **受保护的入口接口与原始访问限制**：新模块（A7 起：`project-status/`，以及 A7-0 迁入的 `report/`、`issue/`、`photo/`）只导出 `Reader` / `Commands` / 规则；`pg` 的 `PoolClient` 与 `store-kit` 只允许在模块目录内引用（ESLint `no-restricted-imports` 按目录配置）；barrel `index.ts` 对新模块只导出这三类。旧 store（field、checkin、foreman、alpha）保持现状导出。**跨模块直读 SQL 的遗留清单** `authz/legacy-adapters.ts` 逐条登记（首批：`IssueStore.lag` 读 `DailyClose` / `Revision` / `PlanVersion`；`photo-store` 的 `isFrozen` 读 `Revision`），每条写明替代出口与移除切片；清单之外的跨模块表名出现在非所属模块的 SQL 字符串里即测试失败（SQL 文本扫描，按模块目录 × 表名）。
  2. **实际消费路径检查**：`authz/surface.ts` 登记每个 HTTP 路由与 Worker 入口（`apps/worker`、`apps/api/src/cleanup-*.ts`）的 `{入口, 读/写, 能力, 范围来源, 时间可见性, 投影函数或命令声明, 并发模式, 披露}`；路由枚举测试列出 NestJS 全部路由、Worker 入口枚举测试列出入口文件，未登记即失败；集成测试里投影函数带调用记录，每个登记的读取入口被调用一次并断言其投影函数确实被该请求执行（证明处理器走了出口，不只是登记）。
  3. **递归字段分层**：`authz/fields.ts` 按路径模式分层并递归进入嵌套对象与数组；`Record<string, unknown>` 这类不透明值必须登记显式投影器（现有 `readerSnapshot` 即为日报快照的投影器），未登记的不透明字段编译失败；新模块的 DTO 不使用 `unknown`。
  4. **依赖规则**：`packages/domain` 不依赖 HTTP、React、Azure SDK（已有）；模块目录之间只允许引用对方的 `Reader` / `Commands` / 规则。
- 行级安全（RLS）继续保护租户隔离，不承担字段级权限。

### D3 字段、派生信息与存在性

- 字段分层按设计段 §4；A7 新增三层：**草稿事实**（OD18：只读主体在提交前连存在都看不到）、**坐标**（OD20：只读主体只见“有 / 无位置”与声称精度）、**项目公开文字**（日报叙述、问题标题与备注、状态声明的情况 / 措施 / 说明：对该项目的所有可查看者可见，现状如此；“受限文字”层只在 DG-05 / DG-06 模块出现）。
- 投影按字段语义作用于所有嵌套值：当前值、历史旧值 / 新值、修订快照、事件前后快照、附件元数据、错误与冲突响应。当前看不到的，历史里也看不到（设计段 §5）。
- **不可见对象与受限字段分开**：
  - **不可见对象**（读者无查看权的对象）对读者**没有任何可观察效应**：不进入任何数字、分类、排序、标记或计数；聚合函数的输入类型就是投影 DTO，不可见对象根本不在输入里。
  - **可见对象的受限字段**（读者能看对象但看不到某字段或某关联）：聚合结果带**覆盖状态**，与现有 `carryMaterial` 的 `{value, complete}` 同形，扩为 `{value, complete, restricted}`，受限 / 未知 / 空白 / 明确零分别保留，不合并；“含受限项”标记只由可见对象的受限字段或受限关联产生（DG-06 R4-1 的“存在读者看不到的关联”属此类：合同可见、关联受限）。
  - 不可反推：含受限分量的合计隐藏数字、标“含受限项”；全局合计另行计算，对该读者同样适用。
- **存在性**：
  - 读取路径不披露：对无查看权的对象，响应与“不存在”相同——相同的 HTTP 状态与响应体，比较时排除每次独立生成的传输元数据（`correlationId`）；列表不列、计数不计、`/days` 不出现。
  - 写入路径的拒绝码只在可见性检查之后发出（`READ_ONLY` 现规则：先 `visible` 再判 `write`），因此不构成披露。
  - **已登记的例外**：`PHOTO_ELSEWHERE`（同字节重传到另一项目 / 日被拒）披露“该文件已在他处存在”；这是 OD20“同一文件是一个事实”的已确认规则，本 ADR 不改变它，在 `surface.ts` 以 `discloses: 'existence'` 登记；新入口要披露存在性必须同样登记并引用确认依据。
  - 冲突响应：现状只含 `code` 与 `correlationId`，“你输入的 X，现在是 Y”由客户端重新读取后拼出（#45）。**将来**若冲突响应携带当前值，该载荷经投影。
- 受限自由文字整段遮蔽为固定提示，不按关键词删改；无法判断是否含受限内容的文字按受限处理（只适用于有“受限文字”层的模块）。
- 系统提示（OD17 规则 3）是派生信息，只能由投影后的已提交事实计算；对只读主体，派生提示不得暗示草稿存在（“今天尚未填写”与“今天无记录”对只读主体必须同一表述）。

### D4 写入按操作声明

- 每个命令在 `surface.ts` 声明：所需能力、目标方向（无方向维度的模块声明 `n/a`）、范围来源（路径参数 / 载荷中的对象 id / 关联对象）、前提能力、影响字段（含连带字段）、是否属金额写入、**并发模式**。不得统一套“维护 + 全部读取能力”。
- 范围检查做两次：提交前（对象当前所属范围）与提交后（命令结果所属范围），防止把对象移到无权项目、借状态变更影响受限字段。
- **并发模式**（三种，每个命令选一种并写明它保护的依赖与推进它的写入者）：
  - `cas`：带基准（聚合 `expectedVersion` 或子记录修订号），任一不符整体冲突、什么都不写，缺基准即拒绝；
  - `append`：只追加，不带基准，但须校验目标存在、状态允许（如问题未关闭）与范围；
  - `create`：创建，用唯一键或序号（如 `expectedN`）防重。
- 现有命令的模式（现状，不改契约）：facts 保存 / submit / no-work / correction start+cancel = `cas`（日 `expectedVersion`）；link / unlink = `cas`（照片 `expectedVersion`）；plan draft = `append`-类（项目 / 日锁下最新覆盖，无基准）；plan confirm = `create`（锁下从草稿生成版本，`PLAN_NO_CHANGE` 防重）；items 保存 = 锁下整表替换（无基准，**登记为已知缺口**，A7 不改）；issue create = `create`；note / reply / escalate / close / reopen / dismissLag = `append`（问题状态校验）。A7 新命令：`declareStatus` = `create`（`expectedN`）；`StatusNote` = `append`；`setPrimaryWorkItem` / `registerExpectation` = `cas`（`Project.version`）/ `create`。
- 基准只在“每个会改变该依赖的写入者都推进它”时才有效（D7）；`surface.ts` 每条写入声明 `advances: [版本名]`，测试据此检查每个版本至少有一个推进者且没有未声明的写入者改它。
- 只读主体的写入：`issue.reply`（现状）与 `project.status.reply`（A7，`project-status` 模块自己的能力与范围，不复用 issue 的授权）。

### D5 撤权、事务与重放

- **授权版本来源**：迁移追加 `LoginAccount.authzVersion int NOT NULL DEFAULT 1`；触发器在 `Membership` 的 INSERT / UPDATE / DELETE 以及 `LoginAccount.active` / `personId` 变化时，在**同一事务**内 `UPDATE "LoginAccount" SET "authzVersion"="authzVersion"+1`（因此所有授予 / 撤销写入者自动参与，不靠约定）。将来显式授权表的写入同样挂此触发器。
- **事务协议**（写在 `inTransaction`，首次执行与幂等重放都在其中）：
  1. `BEGIN`（READ COMMITTED）→ 设置 `app.*` 会话变量；
  2. `SELECT … FROM "LoginAccount" … FOR SHARE` 取账号与 `authzVersion`（**第一把锁**，整事务持有；撤权写入者要 `FOR UPDATE` 同一行，会等到本事务结束，反之本事务开始时撤权已提交则读到新版本）；随后在同一语句集合里读会员，建立上下文；
  3. 幂等锁 → 项目 / 日锁（现有顺序不变；账号行锁总在最前，不会与撤权写入者形成环）；
  4. 回调（含 `idempotent()`：**资源授权在重放查找之前**，现状如此；重放时存储响应**经本次上下文的投影函数再投影**后返回，不原样回放）；
  5. `COMMIT`。锁等待用 `lock_timeout`（5 s）→ 与死锁同样映射为 `RETRY`（503）。
- 时间有效期（`activeFrom` / `activeUntil`）在步骤 2 以 `decidedAt` 评估一次；事务内到期不再重判（事务很短，可接受，写明）。
- 设备主体：身份 `FieldDevice.id`，重放按 `d.id` 分键（现状）；授权版本 = `generation` + A6 的决策时刻与高水位时钟判断（`memberUntil`、`state`），不改 A6 的锁顺序与行为。
- 排队与后台任务（A8 重传、DG-08 导出、清理 job）在执行时与领取结果时各重新授权一次；队列项只存引用，不存投影结果。
- 附件：继续只经服务端流式转发，不签发预签名链接；若将来引入，须在此 ADR 追加 TTL 与残余访问声明，不得声称“下一请求即撤权”。

### D6 验证契约（经验 L22 的机械化）

- **有限规则模式**：`surface.ts` 每条 = `{entry, kind: read|write, capability[], scopeSource, direction: n/a|revenue|cost|all, temporal: live|submitted|frozen, layers: 能力集合 → 可见层集合, concurrency, discloses, advances}`；`fields.ts` 每个 DTO 字段路径 → 层。两者一起足以让一个**最小解释器**对任意 TEST 上下文（能力、范围、方向）算出 `{allowed, visibleKeys}`。解释器与生产授权函数不共享代码，另有固定夹具：若干手写的典型场景与期望输出（`authz/anchors.test.ts`），不由解释器生成。
- 生成器从规则表展开 TEST 场景，针对**真实消费路径**（HTTP 路由或聚合函数）执行：
  - 方向：只对声明了方向的模块展开（report / project-status 为 `n/a`，不展开，不计通过）；
  - 范围：覆盖 / 不覆盖（同组织他项目）/ 他组织 / 多项目共享与未分配（只对声明了共享范围的模块）；
  - 授权：有效 / 撤销 / 到期 / 缺前提 / 设备主体；
  - 路径：按登记逐条。
- **不可排除的必需用例**（每个入口）：允许且范围匹配；同组织他项目拒绝；他组织拒绝；撤权后拒绝；只读主体对草稿不可见（report）；幂等重放经投影。`deferred.ts` 单独列出延后维度及其引入切片（本轮：合同份额 → DG-05；方向 → DG-05），不混入 `unmodelled`。
- 两类性质检查：只改读者不可见的状态或数值，读者看到的响应（排除 `correlationId`）相同；只改方向或范围使其越权，写入被拒且无副作用（无审计行、无版本递增、无出站任务）。
- 每个落地 PR 必须含真实消费路径（至少一个控制器或聚合改为经出口读取）与负向证据；只合入无人调用的框架视为未完成。

### D7 并发基准类别

| 类别           | 最少覆盖                                                        |
| -------------- | --------------------------------------------------------------- |
| 直接修改值     | 金额、数量、日期、文字、值状态（空白 / 明确零 / 未知 / 不适用） |
| 完整复合记录   | 获授记录的金额、币种、税口径、来源、引用、依据、修订号          |
| 连带修改       | 当前主路径、计划有效性、结果、关联或分配关系                    |
| 决策依赖       | 判断本次动作是否允许的当前状态、有效份额、关联版本              |
| 授权与身份依赖 | 会员有效性、`authzVersion`；涉及独立性时的自然人与关系依据      |

不变量：某个版本只能作为基准，当且仅当每个改变它所保护依赖的写入者都推进它（D4 `advances`）。

### D8 A7 读取面政策与落地顺序

**A7 读取面政策表**（引用私有已确认规则，不复制内容；“来源层”指允许进入该读取面的事实层）：

| 入口                                         | 能力                             | 范围             | 时间可见性                                 | 来源层                                | 关联对象                                                    | 并发                    |
| -------------------------------------------- | -------------------------------- | ---------------- | ------------------------------------------ | ------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| `report.projects`                            | `report.view` / `view-submitted` | 会员范围         | 主数据                                     | 结构与身份                            | —                                                           | 读                      |
| `report.days / day / revision`               | 同上                             | 项目             | write：live；read：submitted               | 已提交快照（read）；草稿事实（write） | 问题、照片按各自模块投影                                    | 读                      |
| `report.plan / items`                        | 同上                             | 项目             | 确认版本对双方；草稿只对 write             | 结构与身份                            | —                                                           | 读                      |
| `issue.list / get / lag`                     | `issue.view`                     | 项目             | live（双方）                               | 项目公开文字、结构                    | `lag` 的历史改经 `reportReader.lagHistory`（A7-0 移除直读） | 读                      |
| `project.status.history`                     | `project.status.view`            | 项目             | live（声明无草稿）                         | 结构、项目公开文字                    | 回复由同模块投影                                            | 读                      |
| `project.home / overview / attention`        | 各模块 view 的交集               | 会员范围内的项目 | 已提交快照 + 最新声明 + 实时问题（上报类） | 派生数字只由前列来源计算              | 三模块投影拼接                                              | 读                      |
| `project.status.declare`                     | `project.status.declare`         | 项目             | —                                          | —                                     | —                                                           | `create`（`expectedN`） |
| `project.status.reply`                       | `project.status.reply`           | 项目             | —                                          | —                                     | —                                                           | `append`                |
| `project.master.write`（主工作项、应报期间） | `project.master.write`           | 项目             | —                                          | —                                     | —                                                           | `cas` / `create`        |

未决业务行为（命名为前置条件，不在 ADR 里裁定）：缺报计算的日历来源（OD22 C14，A7 设计 D4 默认值待 PM 确认）；“需要您关注”是否需已阅（A7 设计 Q2）。

**落地顺序**：

1. **A7-0a（无行为变化的基础层）**：`authz/surface.ts`、`fields.ts`、`legacy-adapters.ts`、`deferred.ts`、`anchors.test.ts`；路由与 Worker 入口枚举测试；消费路径调用记录测试；`report` 模块出口 `reportReader.forContext` 并入 `reader-view.ts`，`report.projects / days / day / revision / plan / items` 改为经出口；`IssueStore.lag` 改经 `reportReader.lagHistory`；barrel 调整；ESLint 目录规则与 SQL 表名扫描。证据：现有 `test:report` / `test:issues` / `test:photos` / `test:field` 不回退；OD18 全路径负向测试（`/days` 计数、缺报提示、冲突响应、`lag`）。
2. **A7-0b（事务协议）**：迁移 `LoginAccount.authzVersion` + 触发器；`inTransaction` 的账号 `FOR SHARE` 第一锁与 `lock_timeout`；重放再投影；受控时序测试：撤权与写入交错（撤权先提交 → 拒绝；撤权等待 → 撤权在本事务后生效）、重放前撤权 → 拒绝、重放经投影；`test:field` 不回退（设备路径不变）。
3. **A7-1 / A7-2 / A7-3 / A7-4**：按 A7 设计 §10（迁移与 `project-status` 命令 → 快照 C19 / C20 与派生数字与首页端点 → 界面）。
4. **A8**：离线缓存按主体 + `authzVersion` 隔离；重连后先刷新上下文再放行重传；重传队列项只存命令与基准。
5. **DG-05 首个 PR**：追加显式授权表与授予 / 撤销事件（触发器挂 `authzVersion`）；接入合同方向、份额、条款与金额策略；DG-06 实现时逐条独立复核 §22 的 R4-1 / R4-2 / R4-3。
6. 其后每个模块的新读取面与新命令必须先登记 `surface.ts`，否则 CI 失败（自 A7-0a 起生效）。

## 3. 不采用的方案

| 方案                                   | 不采用的原因                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| 通用权限引擎 / 策略语言 / 独立授权服务 | 各模块会用例外旁路；AGENTS 禁止无 ADR 引入新基础设施；A7 只需要四个模块的最小契约   |
| 只在控制器入口鉴权，投影交给前端隐藏   | 首页聚合、历史、附件、冲突响应会旁路；前端隐藏不是边界（OD18 已证明需要服务端强制） |
| 用 RLS 做字段级权限                    | RLS 只保护行与租户；字段、派生数字与历史需要应用层投影                              |
| 现在就建授权管理界面与分包商流程       | 政策 §3：四个触发条件未出现；人员未定时设计价值低                                   |
| 每个字段独立客户端基准参数             | 聚合版本 + 子记录修订号已覆盖 D7 五类；逐字段参数增加载荷又不增加保护               |
| 事务末尾再读一次授权版本作栅栏         | 读取不阻止并发撤权提交，仍有窗口；账号行 `FOR SHARE` 作第一锁更简单且无环           |

## 4. 后果

- A7 的工作量增加一个基础层（出口、清单、生成器、事务协议），但 OD18 服务端强制与首页聚合本来就需要同样的读取控制；不做这一层，A7 的负向测试只能逐条手写。
- 旧 store 文件不一次搬迁；过渡期内 `*-store.ts` 同时承担命令与读取，只要求新入口经出口、`report` 的读取面在 A7-0a 内改完、遗留直读登记在清单里并有移除切片。
- 隐式授权（角色即授权）在 DG-05 之前继续有效；显式授权表引入后，角色映射改为迁移时生成的授权记录，不删角色字段。
- 账号行 `FOR SHARE` 让撤权写入等待在途事务结束（秒级）；长事务已被 `lock_timeout` 与现有测试超时约束。
- 本 ADR 不改变任何业务规则，不新增可见范围、授予权或代录行为；D1 的过渡映射逐模块等于现状。

## 5. 验收

- 本 ADR：Codex 技术审核 APPROVE 或 APPROVE WITH NITS 且 nit 已修 / 已记录；文档 PR 预算 2 轮。
- A7-0a 合并条件：D2 四项机械检查在 CI 生效并覆盖 report / issue / photo / project-status（入口登记）；`report` 读取面全部经出口；OD18 全路径负向测试通过；`test:report` / `test:issues` / `test:photos` / `test:field` 不回退。
- A7-0b 合并条件：撤权交错与重放再投影的受控时序测试通过（旧实现失败、新实现通过）；`test:field` 不回退。
- A7 全部切片合并条件：D6 生成器对 report / project-status 的范围 × 授权 × 路径矩阵（方向为 `n/a`）全部通过，必需用例无排除，`deferred.ts` 列出延后维度。
- 测试通过不等于现场事实已核实，也不等于 AT/LR 应用验收通过（AGENTS）。

## 6. 来源与追溯

| 规则                                                                                | 来源                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 单一投影、字段分层、历史与嵌套、关联对象、汇总不可反推、不依赖不可见状态            | 共用设计段 §1、§4–§7（DG-05 v0.4 §5′ / §17′；DG-06 R1-1、R2-1、R3-1、R4-1） |
| 按操作声明写入、连带字段基准                                                        | 共用设计段 §8（DG-05 R1-1、R2r-1；DG-06 R2-5、R3-2、R3-3、R4-2、R4-3）      |
| 派生标签与判定输入同一投影                                                          | 共用设计段 §9（DG-05 R1-4、R2r-2）                                          |
| 逐路径反向检查、正向对照、并发矩阵                                                  | 共用设计段 §10；经验 L22                                                    |
| 职称不是权限、模板生成显式授权、代岗 / 代录边界、最小授权结构、触发条件             | 政策 P1–P3、§3                                                              |
| 上下文 / 出口 / 派生信息 / 撤权与重放 / 机械生成 / 首个落地在 A7                    | 独立技术评议 2026-10-01 §1、§3                                              |
| 只读主体不见草稿、不见坐标；只读可回复                                              | OD18、OD20、OD16 第 7 条；`reader-view.ts`、`issue-store.ts`                |
| 同一文件是一个事实（`PHOTO_ELSEWHERE`）                                             | OD20；`photo-store.ts`                                                      |
| 状态由经理声明、系统提示只作参考                                                    | OD17 规则 1、3                                                              |
| 节点主数据与主工作项键冻结进快照、快照对草稿只冻结状态                              | OD22 C19、C20                                                               |
| 跨模块通过明确服务接口、禁止随意跨模块写表、服务端处理权限 / 幂等 / expectedVersion | AGENTS 技术规范                                                             |
