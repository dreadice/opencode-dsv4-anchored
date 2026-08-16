# 决策记录

> 移植 dsh-anchored-standard 到 opencode 插件的决策记录。背景见 `research.md`。
> 状态：Draft / Decided / Done
>
> **术语表（round-7，最终以最新为准）**：锚定 → 注入/判别；晋升/promote →
> 解锁/unlock；bootstrap（阶段）→ seeded；promoted → unsealed/verified。
> 下文 D1-D11 中的"promote/promoted/晋升/锚定"均为历史措辞，语义以 round-7
> 修订（D5/D12）为准。

## D1: 生效范围 —— 全局 hook + 模型门控（Decided, 2026-08-16）

**决定**：不做 agent 机制结合，插件挂全局 hook，对匹配的模型自动锚定。
插件由用户显式安装，安装即生效。

**理由**：用户选择 B 方案——插件是用户自己装的，全局生效可接受，避免 agent
结合路径的时序不确定性和用户配置负担。

**影响**：

- 所有会话、所有 agent 的请求都会经过门控检查，但只有匹配模型（见 D4）触发锚定；
- Minimal persona 不再依赖 agent prompt 静态配置，改由 `experimental.chat.system.transform`
  hook 按请求动态处理（该 hook 的 input 含 `model`，可做门控）；
- 子会话（subagent）**独立锚定**（见 D6），不再"按 parentID 跳过"。

## D2: 晋升后目录 —— 全量开放（Decided, 2026-08-16）

**决定**：首个晋升信号后开放全部工具（`allow *` 覆盖 bootstrap 的 `deny *`），
不做 dsh 源码里的 resident-set 中间态。

**理由**：opencode 没有 `dev_tool_search` 按需解锁机制，维持中间白名单只能靠模型
read/grep 自行探索，收益不确定。全量开放对应 dsh README 原版行为。

**D6/D7 修订（2026-08-16 round-3 确认）**：promote **不用 `allow *`**，改为
**重排追加 agent 的完整 ruleset + session 既有 deny**（用户 Q3："先获取 allow 了
哪些再具体 allow，opencode 加载后就有了"）：

```ts
promoteRules = [...agent.permission, ...sessionDenies]; // 全部 merge 追加
// sessionDenies = session.permission 中 action==="deny" 的规则（排除插件自己的 deny *）
```

- `client.app.agents()` 返回全部 agent 的 `prompt` 与 `permission`（`agent.ts:44,52`），
  内置 build 的 defaults 即 `{"*":"allow", doom_loop:"ask", question/plan_enter:
"deny", external_directory: ask+白名单 allow, read env 特殊 ask}`（`agent.ts:119-136`）；
- 效果 = **恢复到 opencode 加载后的自然权限状态**：build → 等价全量开放（`*:
allow` 覆盖），且 doom_loop/external_directory 的 ask 保留；explore → 保持只读
  白名单（其 ruleset 本身是 `*: deny`）；自定义 agent → ask/deny/allow 全部保留；
- 派生 deny（subagent 的 task/todowrite/primary_tools、父会话 deny，位于
  session.permission）重排在 agent 规则之后 → **subagent 仍无法开 subagent**；
- **阶段判定改为哨兵规则**（promote 不再保证存在 `allow *`）：追加
  `{permission:"__dsv4_stage__", pattern:"promoted", action:"allow"}`，bootstrap
  时 pattern="bootstrap"（见 research.md §5.1）；
- 残余：agent ruleset 未覆盖的工具仍被 bootstrap 的 `deny *` 隐藏（自然状态为
  ask）；ruleset 是晋升时快照，之后改 agent 配置不自动跟随（resume 时可 re-sync）。
- 默认 build agent 无 deny，行为与 D2 原版（allow *）等价。

## D3: 上下文抑制 —— minimal system 常驻 + 原 system 以 user 消息注入（Decided, 2026-08-16）

**决定**：system 全程保持 Minimal persona（`You are a helpful software engineer
assistant.`），**不恢复原 system**。原 system 内容以**用户消息**形式注入首轮
（对应 dsh 的 user 消息注入语义）。工具首轮受控（minimal 白名单），首个晋升
信号后开放全量（见 D2 修订）。

**实现要点**：

- system 替换走 `experimental.chat.system.transform`：始终把 `output.system`
  整体替换为 `[Minimal persona]`（opencode 的 AGENTS.md/技能在 system 文本，
  不在消息里）；
- 注入（用户确认："只是替换 system 而已"，原内容全进 user）：**原 system 的
  全部内容**（agent.prompt + env + AGENTS.md/CLAUDE.md/CONTEXT.md + MCP 说明 +
  技能清单）由插件自组装，作为 user part **拼在首条 user 消息的 parts 最前**
  （真实消息之前，对应"system 在 user 前"的语义）；请求结构不变——system +
  user 本就在一次请求里一起发，无独立锚定轮；
- 工具：首轮 minimal 白名单（默认 `bash + edit`，见 research.md §5.2；`edit`
  的 edit/write/apply_patch 一族对应 dsh 的 `str_replace_editor`），首个晋升信号后
  开放全量。

**opencode 与 dsh 的机制差异**：dsh 的 AGENTS.md/技能是注入的 user 消息
（`source.kind` 标记剥离/注入），且 dsh 有 `next-turn` 队列支撑独立锚定轮；
opencode 无队列，但 `experimental.chat.messages.transform` 可整体改写请求的
messages 数组，一次请求可携带多条 user 消息，等价于"同一轮内完成注入"。

**实现注意（2026-08-16 深研后修订，§4.8 research.md）**：
`experimental.chat.messages.transform` 的 input 是 `{}`，**无 sessionID/model，
无法按会话门控**——改为在 **`chat.message` 阶段原地改写 `output.parts`**
（`prompt.ts:999-1047`）：hook 触发时消息尚未落库，push 的 text part 随本消息
持久化并进入本次请求；无重入、无并发问题。注入内容由插件自读
AGENTS.md/CLAUDE.md/CONTEXT.md 组装（复刻 `instruction.ts` 查找逻辑，用
`PluginInput.directory`/`worktree` 定位，不依赖捕获 system 运行时值）。
`client.session.prompt` 补发路径弃用（顺序倒置、双循环、会整体替换 permission）。

**round-4/5 修订（探针定案）**：注入内容改为**探针捕获的真实 system 全量**
（见 round-4 突破），不再自组装；round-5 起探针失败也**不再自组装兜底**，
改为**按 key 旁路**（见 D8）。

## D4: 模型门控 —— 按 `deepseek*v4*` 匹配（Decided, 2026-08-16）

**决定**：模型 id 按通配符 `deepseek*v4*` 匹配（覆盖 providerID 与 modelID，
如 `deepseek/deepseek-v4-pro`、`deepseek-v4-flash-free`）。

**实现**：门控贯穿所有 hook 入口：

- `chat.message` / `experimental.chat.system.transform` 的 input 含 `model`，直接判断；
- `tool.execute.before` / `event`（无 model）仅在被锚定的会话上生效——以
  session 内记录的"已锚定"标记为准（锚定在 `chat.message` ensure 时打标）。

## D5: promoteOn / compaction 回退 / 验证方式（Decided, 2026-08-16）

- **promoteOn**：首个 assistant 消息（或 tool-call）落库后晋升——只追加 `allow *`
  开放全量工具（原 system 内容已在**首轮请求**作为 user 消息注入，见 D3）；
  注入的 user 消息需打标（synthetic/标记文本），避免重复注入；
- **compaction 回退**：需要。`session.compacted` 后重置回 bootstrap 阶段
  （零工具或受控白名单），直到新的晋升信号（epoch-aware）；
- **验证方式**：插件内置阶段日志（每次请求打印 session 阶段 + 模型可见工具
  列表 + system 是否被替换），用户 grep 日志验证；可选抓包对照。

**round-5 修订（对照 dsh README 偏差 3，用户确认"可以按他的"）**：
compaction 回退**对齐 dsh 的 `compactionTools`**——回退目录 = minimal 对 +
只读/编辑工具，而非严格双工具（否则压缩后的长会话没有 read/glob/grep，只能
靠 bash 翻文件，效率反降）。opencode 映射（工具 id 已核实）：

```ts
[
  {permission: '__dsv4_stage__', pattern: 'compacted', action: 'allow'}, // 回退哨兵（与首轮 bootstrap 哨兵区分，见下）
  {permission: '*', pattern: '*', action: 'deny'},
  {permission: 'bash', pattern: '*', action: 'allow'},
  {permission: 'str_replace_editor', pattern: '*', action: 'allow'},
  {permission: 'read', pattern: '*', action: 'allow'}, // dsh read
  {permission: 'glob', pattern: '*', action: 'allow'}, // dsh glob
  {permission: 'grep', pattern: '*', action: 'allow'}, // dsh grep
  {permission: 'edit', pattern: '*', action: 'allow'}, // dsh write/edit（edit 权限覆盖 write/apply_patch）
  {permission: 'todowrite', pattern: '*', action: 'allow'}, // dsh todo_write
  {permission: 'question', pattern: '*', action: 'allow'}, // dsh ask_user_question
  {permission: 'external_directory', pattern: '*', action: 'allow'},
];
```

**epoch 判定（回退后不按旧历史误晋升）**：回退哨兵用独立的
`pattern:"compacted"`（与首轮 `pattern:"bootstrap"` 区分）；compacted 阶段的
晋升判定**只算压缩边界之后**的 assistant 消息/工具调用（跨 restart 从历史中
最后一条 `CompactionPart`——`type:"compaction"` 的 part，schema
`v1/session.ts:195-202`，挂在 user 消息 parts、含 `tail_start_id`——之后扫描；
prune 的 `part.state.time.compacted` 只是清 tool 输出，不是压缩边界），否则
压缩后历史仍含旧 assistant 消息会立即误晋升。

**round-6 修订（触发点与重注入，用户确认"需要重新注入"）**：

- **触发点**：无 `session.compacted` 事件；改用 `experimental.session.compacting`
  hook（`session/compaction.ts:373-377`，插件触发、input 含 `sessionID`）触发
  回退追加；
- **重新注入**：compaction 回退后注入判定统一为"历史无幂等标记即注入"——注入
  内容随压缩消失、幂等标记也被压缩 → 回退后自动重注入，信息不丢，对齐 dsh
  每轮注入语义。

**round-7 修订（状态机 v3：命名与判别，用户拍板）**：

- **术语更换**：不用"锚定/晋升/promote/bootstrap"。状态 = `pristine`（无哨兵）/
  `seeded`（注入成功）/ `unsealed`（已解锁，seeded 内部变体）/ `verified`
  （判别通过）；动作 = 注入 / 解锁（原 promote）/ 判别。
- **解锁与判别解耦**：seeded 阶段工具由信号自动解锁（边界后 assistant 消息/
  工具调用 → 追加 agent ruleset + session denies + `str_replace_editor: deny` +
  哨兵 `unsealed`）——**seeded 时工具已解锁**（单轮注入，无两步），str_replace
  _editor 的 deny 在解锁时追加、与 verified 无关。
- **特征判别（验证）**：N=3 **常量**；seeded/unsealed 阶段每轮 `chat.message`
  扫描边界后 assistant 消息（最早起）：**任一**符合特征（首行 `We…` 风格 +
  `let me`=0，dsh README minimal 轨迹特征）→ 哨兵 `verified`（成功标记）并
  立即停止判别（第一轮符合则第二轮不判，以此类推）；窗口内 N 条全部不符合 →
  停止判别（`verify.giveup` warn，进程内 Map 去重每进程一次），**保留当前状态**
  （不加失败标记）。
- **compaction 回退**：`experimental.session.compacting` → 追加 `deny *` +
  minimal 对 + compactionTools + 哨兵 `seeded`（覆盖 verified/unsealed；
  取代 round-5 的独立 `compacted` 哨兵，epoch 边界扫描逻辑不变——最后一条
  `CompactionPart` 之后）→ 重新注入 + 重新判别（新窗口）。

## D6: subagent 独立锚定（Decided, 2026-08-16）

**决定**：subagent 会话**不跳过**，与主会话同机制**独立锚定**（Q2=A）：首轮
minimal system + 受控工具 + AGENTS.md 注入（与主会话相同，Q1 确认"像主代理那样
拦截改成 user 消息"），按自身首个晋升信号 promote。父会话已晋升不豁免子代理
（Q3 确认）。

**补充确认**：

- **晋升保留 deny**（Q2 确认"子代理不能允许唤起子代理"，Q3 确认改具体 allow）：
  promote = 重排追加 agent 完整 ruleset + session 既有 deny（含创建时自带的
  task/todowrite/primary_tools deny，`task.ts:143-155`）→ subagent 无法再开
  subagent（task 工具从可见目录移除）；`subagent_depth`（默认 1）另为第二道防线
  （`task.ts:104-117`）。
- **控制点（Q2 问"有没有注入点控制子代理"）**：session permission ruleset 即
  控制点（插件 merge 追加规则 + findLast 后写覆盖）；子代理自己的配置（prompt/
  permission）经 `client.app.agents()` 可读，无需额外注入点。
- **minimal system 组成（round-3 修订）**：统一为**纯 Minimal persona**，不保留
  agent.prompt（用户："应该和处理默认agent一样用user注入"）；原 system 内容
  （自定义 agent 的 prompt + AGENTS.md + 技能清单）全部走 user part 注入。
- **识别**：`client.session.get(sessionID)` wire 返回 `parentID`（SDK 类型需
  `as any`），DB 兜底重启不丢，优于内存映射；`session.created` 事件可作辅助。

## D7: 自定义 agent 兼容（Decided, 2026-08-16）

**背景**：门控只按模型（`deepseek*v4*`），使用自定义 agent 的会话同样会命中。
纯 `allow *` 晋升与 minimal persona 替换会压掉自定义 agent 的 prompt 与权限设计。

**决定**：

- **minimal system**：与默认 agent **完全同构**（Q1 确认）——system 替换为纯
  Minimal persona；**原 system 内容（agent.prompt + AGENTS.md + 技能清单）以
  user part 注入**（用户："应该和处理默认agent一样用user注入"）；
- **promote**：**获取当前 agent 的 ruleset（`client.app.agents()`）重排追加** +
  session 既有 deny（用户 Q2 确认："就是你去获取当前agent的配置，然后拿来用"）——
  ask/deny/allow 全部保留，自定义 agent 的权限设计不被冲掉（见 D2 修订）；
- **per-agent 排除配置**：`{ include: string[], exclude: string[] }`，支持通配符，
  不写 = 全部（用户 Q4 确认）。

**已知残余**：agent ruleset 未覆盖的工具晋升后仍被 bootstrap `deny *` 隐藏
（自然状态为 ask）；ruleset 为晋升时快照，改 agent 配置后不自动跟随（resume 时
可 re-sync）；规则只增不减（append-only）。

## D8: 探针失败 → 按 key 旁路（Decided, 2026-08-16 round-5）

**背景**：原方案探针失败回退"插件自组装"（读 AGENTS.md + 拼 env + agent.prompt，
~95% 忠实）。用户提出："2 如果失败能不能不再执行替换？"——失败时不替换 system。

**决定**：**取消自组装兜底**。探针失败 → 该缓存 key
`(directory, agent, modelID, 日期)` 标 `failed` + TTL（默认 5 分钟）→ TTL 内
命中该 key 的会话**整个旁路**：

- `system.transform` 不替换（保持原生 system）；
- `chat.message` 不注入、不 bootstrap 权限；
- 行为 = 完全原生 opencode，插件对该 key 透明。

**语义**："要么完整锚定，要么完全原生"，无中间态。失败标记持久化在缓存状态
文件（`probe-cache.json` 的 `status:"failed"` 条目）可展示，日志打 bypass 事件
（warn）。TTL 过后或跨天重试。

**理由**：自组装维护成本高（MCP 说明/技能格式化/opencode 自带 persona 近似），
且失败场景是少数（网络/环境问题），原生降级可接受、可恢复。

## D9: 日志两级 + debug 短路（Decided, 2026-08-16 round-5）

**背景**：验证依赖插件日志；`app.log` 机制研究结论（research.md §4.10）——
HTTP `POST /log` → Effect logger，级别仅 debug/info/warn/error（无 trace），
默认只写 `~/.local/share/opencode/log/opencode.log`，服务端按 `OPENCODE_LOG_LEVEL`
过滤（默认 INFO，debug 不落盘）。即使服务端过滤，插件侧每次调用仍要
JSON.stringify 完整内容 + HTTP roundtrip——每轮白做。

**决定**：

- **两级日志**：info = 摘要字段（长度、hash、前 100 字符、阶段、门控、来源、
  可见工具……）；debug = 完整字段（system 替换前后全文、注入全文、permission
  ruleset 全量、探针捕获原文）。
- **debug 短路**：插件与 opencode 同进程，启动时解析一次
  `process.env.OPENCODE_LOG_LEVEL === "DEBUG"` 缓存为布尔量；`debug()` 方法开头
  直接 return——序列化与 HTTP 只在开启时发生。
- 调用 fire-and-forget 不 await，不阻塞 hook 链路。
- 统一前缀 `dsv4-anchored` + 结构化字段；事件清单见 `design.md` §7.3。

**影响**：默认运行零额外成本（info 摘要极小）；验证时
`OPENCODE_LOG_LEVEL=DEBUG` 开启全量（可加 `OPENCODE_PRINT_LOGS=1` 打 stderr）。

## D10: 严格 minimal 工具对 —— 插件注册 `str_replace_editor`（Decided, 2026-08-16 round-5）

**背景**：工具 schema 身份是首轮锚定的决定变量（research.md §2.2，dsh 5/5 vs
11/11）。原方案白名单 `["bash","edit"]` 按 `edit` 权限名放行 edit/write/
apply_patch **三个**工具 → 首轮可见 4 个工具，且名字/参数与 dsh 的
`str_replace_editor` 不一致。用户定案："严格按照 minimal 模式，只注册两个工具"。

**决定**：

- **插件注册自定义工具 `str_replace_editor`**（`Hooks.tool`，`registry.ts:196-199`
  → `fromPlugin`，id = 对象 key）：名称/描述/参数**逐字复刻 dsh 原版 schema**
  （`tool-str-replace-editor/src/index.ts:19-30,420-462`：`command` enum
  view/create/str_replace/insert + `path` + `file_text`/`insert_line`/`new_str`/
  `old_str`/`view_range`，`maxOutputChars` 16000）；
- **bash 用 opencode 内置**（id 同名 `bash`，dsh e2e 断言工具名即 `bash`）；
- **bootstrap 白名单 = `["bash", "str_replace_editor"]`**：`deny *` 已隐藏内置
  edit/write/apply_patch 等全部非白名单工具（无需额外 deny）；首轮模型可见
  工具 = minimal 的 `[bash, str_replace_editor]`，集合与 dsh 完全一致；
- **promote 时追加 `{permission:"str_replace_editor", pattern:"*",
action:"deny"}` 在规则末尾**（findLast 命中）→ 隐藏插件工具，目录恢复
  opencode 自然状态；插件工具仅锚定期使用（用户："只是system用一下，后边隐藏就行"）；
- **execute 自实现**四命令：`view`（读文件/目录，行号 cat -n 格式，16000 截断）、
  `create`（写文件）、`str_replace`（唯一匹配替换）、`insert`（行插入）；绝对
  路径；**降级点：无 LSP 冲突检测/格式化**（opencode 内置 edit 的优势，锚定期
  用不上）。

**理由**：opencode 无配置层工具 alias（`tools` 配置只做权限映射，
`config.ts:553-564`）；`tool.definition` 只能改 description/parameters、**不能改
工具名**且全局生效（无法门控）——不可用于 alias（research.md §4.11）。

**影响**：首轮锚定对与 dsh 逐字一致（名字/描述/参数），锚定效果实测的前置
条件对齐；promote 后目录干净；自实现编辑工具在锚定期承担编辑职责，bootstrap
期白名单工具（bash/str_replace_editor）免 ask 语义同样适用
（`str_replace_editor: allow` 免询问）。

## D11: 首轮注入的扰动风险与备选方案（Decided, 2026-08-16 round-5）

**背景**：D3 定案首轮把捕获的 system 全量 prepend 到首条 user 消息。对照 dsh
README 复现清单第 3 条（"第一次请求的消息中不应包含 AGENTS.md/CLAUDE.md 摘要
或可用技能目录提醒"）复核发现：我们的首轮 user 消息在場 AGENTS.md 全文 +
技能目录提醒（~9KB `<available_skills>`）——正是 dsh `suppressedContextSources:
[agent-instructions, skill-catalog]` 特意剥离的两类内容。且 issue #6 实测：
**技能目录提醒在首轮在场时锚定 0/9，无目录 ~81%**（dsh 里 skill-catalog 本身
就是 user 消息形态 →"user 形态不脏"的假设在 dsh 数据里不成立）。

**决定（分两步）**：

1. **现状保持**：首轮注入完整捕获（信息不丢，D3 不变）；该风险作为验证项
   而不是预设缺陷——system 干净（minimal）与双工具目录两个决定变量已对齐，
   扰动是可能项而非定论。
2. **备选升级路径（实测不达标时启用）**：**选择性剥离**——注入前按稳定标记
   切段过滤：`Instructions from:` 开头段（AGENTS.md/CLAUDE.md/CONTEXT.md，
   `session/instruction.ts:166`）与 `Skills provide specialized instructions`
   开头段（技能目录，`session/system.ts:111`）；首轮注入**滤掉这两段**，
   promote 后再补注完整捕获。首轮注入变两段式（幂等标记需区分
   部分注入/完整注入）。

**触发条件**：首轮锚定效果实测不达标（首行非 `We…` 风格、`let me` > 0、
header tools 数量异常），则启用备选；达标则维持现状。

**验证**：内置日志可见首轮注入内容与长度；行为清单按 dsh verify 复验
（首行风格、let me 计数）——见 design.md §9。

## D12: 状态机 v3 —— seeded/unsealed/verified + 特征判别（Decided, 2026-08-16 round-7）

**背景**：用户对照 dsh README（模型输出特征 = 首行 `We…` + `let me`=0 即成功）
重构状态机，且明确**不用"锚定/晋升"术语**（"选个好听的名字，晋升也不要"）。

**决定**：

- **术语**：锚定 → 注入/判别；晋升/promote → 解锁/unlock；bootstrap（阶段）→
  seeded；promoted → unsealed/verified。
- **状态**（哨兵 pattern，`findLast` 判定）：
  - `pristine`：无哨兵（首轮未处理）；
  - `seeded`：注入成功（首轮注入 + 受限目录 `[bash, str_replace_editor]`）；
  - `unsealed`：已解锁（seeded 内部变体，防重复解锁——解锁时追加 agent
    ruleset + session denies + `str_replace_editor: deny`）；
  - `verified`：判别通过（成功标记，持久）；
  - 旁路 `bypassed` 按 key 级缓存判定，无哨兵。
- **解锁与判别解耦（用户纠正）**：seeded 状态工具已由信号自动解锁（请求 #1
  受限 → 信号落库 → 请求 #2 全量）——单轮注入无两步；`str_replace_editor: deny`
  在解锁时追加，与 verified 无关。
- **特征判别**：**N=3 常量**；seeded/unsealed 阶段每轮 `chat.message` 扫描
  边界后 assistant 消息（最早起）：**任一**符合 → 追加哨兵 `verified` 并**立即
  停止**判别（第一轮符合则第二轮不再判，以此类推）；窗口内 N 条全部不符合 →
  停止判别（`verify.giveup` warn，进程内 Map 去重每进程一次），**保留当前状态**
  （不加失败标记）。
- **轨迹标记判别（round-7/8 定案）**：判别对象 = `reasoning` part +
  `text` part 拼接全文（`v1/session.ts:118-128`，dsh 特征主要在思维链）。
  标准 = **首个轨迹标记**：`idx(we系) < idx(let系)` 即通过（let 系不出现 =
  +∞，we 系存在即通过；we 系不出现则不通过）——贴合 dsh"首行 `We need…`"
  （思维起步取向），对 `let me` 少量出现鲁棒（dsh r1 let me=1 仍 minimal）。
  词表可配置（`verify.terms`，默认英文 `we:["we need","we"]`、`let:
["let me","let's"]`）；中文词表（`我们` vs `让我`/`我来`/`我先`）实验性：
  标记不稳定，判别失败即 giveup，不锁死。
- **解锁/判别收敛到 `chat.message` ensure**：信号持久化在历史，每轮扫历史即可
  ——`tool.execute.before` / `message.updated` 信号 hook 整个移除（天然幂等、
  覆盖 resume 与失败重试，与 dsh"从持久 event 推导"一致）。
- **compaction 回退**：`experimental.session.compacting` hook → 追加 `deny *` +
  minimal 对 + compactionTools + 哨兵 `seeded`（覆盖 verified/unsealed，取代
  round-5 的 `compacted` 哨兵；epoch 边界仍 = 最后一条 `CompactionPart` 之后）→
  注入判定"历史无幂等标记即注入"自动重注入 → 判别窗口重置。

**影响**：状态线 = `pristine → seeded → unsealed → verified`，compaction 回
`seeded`；判别失败不锁死（仅 stop + warn）；实现从信号 hook 改为 chat.message
统一判定，简化一半逻辑。

## D13: zero-anchored 锚定轮 + 真实消息推迟（Decided, 2026-08-16 round-9）


**背景**：实测（deepseek 官方 v4-pro + variant max）：

- minimal system + **0 工具** → thinking **we 风格**（"We need answer..."）✅
- minimal + **双工具**（含 bash 描述对齐 dsh 后）→ standard-like（"The user
  wants.../Let me"）❌ —— opencode 环境复现不了 dsh Anchored Standard 的
  双工具锚定（bash 参数 schema/消息结构差异），**0 工具是唯一实证出 we 的
  形态**。
- 首轮注入任何内容（即使 stripPersona）→ 破坏 we 锚定。
- opencode persona（`You are opencode, ...`）**曾未替换成功**（`output.system =
  [...]` 重赋值不生效——`plugin.trigger` 忽略返回值，request.ts 用局部数组
  引用；必须 `splice` 原地改）——已修复（D13 前置 fix）。

**决定（对齐 dsh zero-anchored/whoami）**：

- 锚定轮（轮 1）：minimal persona + **0 工具**（`whitelist: []`）+ **只有锚定
  消息**（真实消息推迟）；锚定消息 = `synthetic: true` text part（TUI 隐藏
  `tui/index.tsx:395`、模型可见 `message-v2.ts:198-201`）。
- **真实消息推迟**：首轮 chat.message 把真实 parts 存盘 pending（sessionID →
  parts），parts 替换为锚定消息；锚定回复落库（assistant 消息 = 晋升信号）
  → `event`（message.updated）自动 `session.prompt` 发轮 2：
  `[user system（去 persona，synthetic）+ 真实消息]`（不带 tools）。
- 轮 2 消息触发 chat.message ensure → 解锁（全量工具）+ 注入 user system
  （`filterFirstTurnSystem`：去 `You are opencode, ...` 首句，保留行为要求/
  env/AGENTS/技能/MCP）。
- 竞态：bypass 不替换不存 pending（真实消息原样）；prompt 防重（发前清
  pending）；重启悬挂 → ensure 补发。完整时序见 design.md §4.5。

**影响**：首轮多一轮模型调用（锚定轮），对齐 dsh whoami 的代价；TUI 轮 1
用户消息隐藏、轮 2 真实任务自动出现（系统代发）。

| 机制                                                                                                                                                | 来源                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 工具可见性由 permission ruleset 控制，`findLast` 后写覆盖；`merge` = 按序拼接，agent 规则在前、session 规则在后                                     | `reference/opencode/.../permission/index.ts:28,204`；`session/tools.ts:87` |
| `client.session.update` merge 追加、DB 持久化（重启不丢）                                                                                           | `.../handlers/session.ts:194`                                              |
| `chat.message` 在消息落库前触发、trigger 返回值丢弃但 `output.parts` 同引用可原地改写；hook 后 runLoop 从 DB 重读消息 → 注入进本次请求              | `.../session/prompt.ts:999,1046,1092`；`.../plugin/index.ts:282`           |
| `experimental.chat.messages.transform` input 为 `{}`，无法按会话/模型门控                                                                           | `.../session/prompt.ts:1255`                                               |
| `client.session.prompt` 新消息 id 单调递增（排在本消息后）；带 `tools` 会整体替换 session.permission                                                | `.../id/id.ts:51-70`；`.../session/prompt.ts:1060`                         |
| `experimental.chat.system.transform` 的 input 含 `model`，可按模型门控；触发时 system 已被 join 成单条字符串                                        | `.../session/llm/request.ts:69,58-66`                                      |
| 解锁信号（边界后 assistant 消息/工具调用）持久化在历史，`chat.message` 每轮扫历史即可（round-7：不用 `tool.execute.before`/`message.updated` hook） | `.../session/prompt.ts:999`；schema `.../v1/session.ts:597`                |
| subagent 创建带 `parentID` + 派生 deny（task/todowrite/primary_tools）；`session.created` 对 subagent 同样触发；`subagent_depth` 默认 1 挡嵌套      | `.../tool/task.ts:104-172`；`.../agent/subagent-permissions.ts:14-27`      |
| subagent 默认上下文 = agent.prompt + AGENTS.md + skills（与主会话相同，无 parentID 分支）；模型继承父会话                                           | `.../session/prompt.ts:1257-1269`；`.../tool/task.ts:181-184`              |
| `client.session.get` wire 返回全量 `Session.Info`（parentID/permission/agent/model），SDK 类型未声明需 `as any`                                     | `.../session/session.ts:224-244`                                           |
| `client.app.agents()` 返回全部 agent（含内置）的 `prompt` 与 `permission`；`client.config.get` 不含内置 agent                                       | `.../handlers/instance.ts:80-81`；`.../agent/agent.ts:44,52`               |
| dsh 零工具锚定轮实现：`anchor-turn.mjs`（prepend 锚定消息）+ `zero-tool-bootstrap.mjs`（剥全目录 + pre-step 按 `source.kind` 剥离上下文）           | `reference/dsh-anchored-standard/zero-anchored-standard/`                  |

## 已确认的机制前提（实现时依赖）

| 机制 | 来源 |
| --- | --- |
| 工具可见性由 permission ruleset 控制，`findLast` 后写覆盖；`merge` = 按序拼接，agent 规则在前、session 规则在后 | `reference/opencode/.../permission/index.ts:28,204`；`session/tools.ts:87` |
| `client.session.update` merge 追加、DB 持久化（重启不丢） | `.../handlers/session.ts:194` |
| `chat.message` 在消息落库前触发、trigger 返回值丢弃但 `output.parts` 同引用可原地改写；hook 后 runLoop 从 DB 重读消息 → 注入进本次请求 | `.../session/prompt.ts:999,1046,1092`；`.../plugin/index.ts:282` |
| `experimental.chat.messages.transform` input 为 `{}`，无法按会话/模型门控 | `.../session/prompt.ts:1255` |
| `client.session.prompt` 新消息 id 单调递增（排在本消息后）；带 `tools` 会整体替换 session.permission | `.../id/id.ts:51-70`；`.../session/prompt.ts:1060` |
| `experimental.chat.system.transform` 的 input 含 `model`，可按模型门控；触发时 system 已被 join 成单条字符串；**output.system 必须 splice 原地改**（trigger 忽略返回值，request.ts:69-78 用局部数组引用） | `.../session/llm/request.ts:69,58-66`；`.../plugin/index.ts:282-296` |
| 解锁信号（边界后 assistant 消息/工具调用）持久化在历史，`chat.message` 每轮扫历史即可（round-7：不用 `tool.execute.before`/`message.updated` hook 做信号） | `.../session/prompt.ts:999`；schema `.../v1/session.ts:597` |
| `event` hook 存在：`message.updated` payload `{type, properties:{info: Message}}`（含 role）——D13 用于锚定回复落库后自动 prompt 轮 2 | plugin `index.d.ts:175`；sdk `types.gen.d.ts:129-134` |
| synthetic text part：TUI 过滤（不显示），模型可见（message-v2.ts 只滤 ignored/空文本）——D13 锚定消息/注入块用 synthetic 隐藏 | `tui/src/routes/session/index.tsx:395,636,841`；`session/message-v2.ts:198-201` |
| subagent 创建带 `parentID` + 派生 deny（task/todowrite/primary_tools）；`session.created` 对 subagent 同样触发；`subagent_depth` 默认 1 挡嵌套 | `.../tool/task.ts:104-172`；`.../agent/subagent-permissions.ts:14-27` |
| subagent 默认上下文 = agent.prompt + AGENTS.md + skills（与主会话相同，无 parentID 分支）；模型继承父会话 | `.../session/prompt.ts:1257-1269`；`.../tool/task.ts:181-184` |
| `client.session.get` wire 返回全量 `Session.Info`（parentID/permission/agent/model），SDK 类型未声明需 `as any` | `.../session/session.ts:224-244` |
| `client.app.agents()` 返回全部 agent（含内置）的 `prompt` 与 `permission`；`client.config.get` 不含内置 agent | `.../handlers/instance.ts:80-81`；`.../agent/agent.ts:44,52` |
| dsh 零工具锚定轮实现：`anchor-turn.mjs`（prepend 锚定消息）+ `zero-tool-bootstrap.mjs`（剥全目录 + pre-step 按 `source.kind` 剥离上下文） | `reference/dsh-anchored-standard/zero-anchored-standard/` |
