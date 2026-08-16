# 设计文档：opencode-dsv4-anchored 插件

> 状态：Decided（2026-08-16 round-5 定案，含探针捕获、失败旁路、两级日志）
> 机制级源码依据见 `research.md`；逐项决策见 `decisions.md`（D1-D9）。

## 1. 目标

把 dsh-anchored-standard（xiaobright preset）的"首轮轨迹约束 + 逐步解锁"方法
移植为 opencode 插件，解决 DeepSeek V4 系列的过拟合问题：模型一见完整 system
就抢跑（首轮狂开工具、多步并行、话痨式 show off），把首轮轨迹带偏。

**成功标准**：首轮行为被约束（纯 persona + **0 工具**锚定轮），信号出现后恢复
自然状态（工具解锁），特征判别通过后打成功标记（verified）；除首轮注入外
不改变模型可见信息总量；用户可验证（日志）、可回退（卸载插件即原生）。

## 2. 方案总览

多个 hook 协作，形成"锚定轮 → 真实任务轮 → 特征验证"闭环：

```
轮 1（模型门控命中 deepseek*v4*，zero-anchored 锚定轮）：
  ├─ 探针：静默捕获真实 system → 缓存（供轮 2 注入；失败按 key 旁路）
  ├─ system.transform：整体替换为纯 Minimal persona（每轮持续）
  ├─ chat.message：真实消息存盘 pending → parts 替换为锚定消息
  │   （synthetic → TUI 隐藏、模型可见）→ seeded 规则（0 工具）
  └─ 锚定回复落库（assistant 消息 = 晋升信号）
       → event（session.idle，run 结束后）自动 session.prompt 发轮 2
轮 2（真实任务轮）：
  ├─ chat.message ensure：解锁（agent ruleset + session denies + 哨兵 unsealed）
  ├─ 注入 user system（探针捕获 → 去 opencode persona 首句）在前
  │   + 真实任务消息在后（synthetic 隐藏 system 块）
  └─ 模型带全量工具处理真实任务
  └─ 特征判别（N=3 轮内：idx(we系) < idx(let系)）→ 达成：哨兵 verified
```

- **锚定轮**：system 只有一行 persona；**0 工具**（对齐 dsh zero-anchored，
  实测 v4-pro + minimal + 0 工具 → we 风格首答 ✓）；真实消息推迟（§4.5）。
- **解锁后（轮 2）**：工具按 agent ruleset 全量恢复（round-10：假
  str_replace_editor 已移除，无隐藏 deny，§8.2.2）；注入去 persona 的原始
  system（信息不丢：行为要求/env/AGENTS/技能/MCP 保留）；system 仍保持
  minimal。
- **verified（判别通过）**：模型输出特征达成（we 系先于 let 系）的成功标记
  （哨兵持久化）；未达成 N=3 轮 → giveup（warn 一次，不锁死）。
- **旁路（探针失败）**：不替换、不锚定、不注入、不 seeded，会话完全原生。
- **状态**：全部持久化（permission 哨兵 + 缓存文件），重启/resume/compaction
  可还原。

## 3. 模型门控（D4）

- 匹配 `providerID/modelID` 通配符 `deepseek*v4*`（可配置）。
- `chat.message` / `chat.system.transform` 的 input 含 `model`，直接判断。
- `tool.execute.before` / `event` 无 model：只对已处理会话生效（检查
  session permission 含插件哨兵/deny 规则）。
- subagent 继承父会话模型 → 门控同样命中，独立处理（D6）。

## 4. 探针捕获真实 system（round-4 定案）

### 4.1 为什么需要探针

opencode 的 system 组装（`SystemPrompt.Service` + `instruction.ts` +
Skill/MCP.Service）是进程内 Effect 服务，无 HTTP 渲染端点，插件 API 不可达；
fork 不复制 system（system 从不落库）。**探针是唯一拿到 100% 真实 system 的
路径**，且可零 token。

### 4.2 流程

```
chat.message（真实会话 S，首轮）
  ├─ 缓存查询：key = (directory, agent, modelID, 日期)
  │   （system 含 Today's date，跨天重探；进程内 Map + 磁盘 JSON 缓存）
  ├─ miss → 同步探针（chat.message 内 await；并发去重 Map 防重复探）：
  │    client.session.create({query:{directory}, body:{title:"dsv4-probe-…"}})
  │      （自定义 title 跳过后台小模型标题生成）
  │    probeSessions.add(探针ID)
  │    await client.session.prompt({path:{id}, body:{
  │      parts:[{type:"text", text:"probe"}], agent, model}})   ← 与真实会话一致
  │      探针 runLoop → 组装真实 system → system.transform hook
  │        input.sessionID ∈ probeSessions → 捕获 output.system.join("\n")
  │        → 写缓存 → throw 标记错误（消息避开 retry 禁词，如
  │          "DSV4 probe: capture complete"）
  │      错误 → halt → assistant 标 error → outcome "stop" → runLoop 终止
  │        （零 token：system.transform 在 prepare 内、早于 llmClient.stream）
  │    prompt() 可能 reject → try/catch 吞掉（预期行为）
  │    client.session.delete(探针ID)；probeSessions.delete
  └─ 注入：output.parts.unshift(text part = 捕获的 system 全量 + 幂等标记)
```

- 探针请求体**不带 tools**（`session.prompt` 带 tools 会整体替换
  session.permission）。
- 探针会话无 session permission → 捕获**未过滤的自然 system**（MCP 说明全量），
  正是"原 system 全部内容"的语义。
- 探针消息自身触发 `chat.message`/`event` → 按 probeSessions 集合跳过。

### 4.3 缓存与频率

- key = `(directory, agent, modelID, 日期)`；system 内容只随这四者变化。
- 进程内 Map + 磁盘持久化（JSON，`~/.local/share/opencode/dsv4-anchored/`），
  重启不重探。
- 频率 = **每 key 每天一次**（首个会话触发，几十 ms、零 token）；
  跨天自动重探。

### 4.4 失败旁路（round-5 定案，替代自组装 fallback）

- 探针失败（无 key/网络/超时）→ **该 key 标 failed + TTL（默认 5 分钟）**；
  TTL 内所有命中该 key 的会话**整个旁路**：
  - `system.transform` 不替换（保持原生 system）
  - `chat.message` 不注入、不 seeded 权限
  - 行为 = 完全原生 opencode，插件对该 key 透明
- TTL 过后或跨天 → 重试探针。
- 失败标记可展示：状态文件 `probe-cache.json` 含 `{key, status:"failed",
error, ts}` 条目，可 cat 查看；日志打 bypass 事件。
- **自组装 fallback 取消**：不再维护 ~95% 忠实的近似组装。

## 4.5 时序：zero-anchored 锚定轮 + 真实消息推迟（round-9 定案，round-10 修订）

> 对齐 dsh whoami/zero-anchored：真实消息**不参与首轮**（首轮只有锚定消息），
> 锚定回复落库（晋升信号）后**自动发出**轮 2（user system + 真实消息）。
> opencode 无 next-turn 队列 → 用"pending 存盘 + event 自动 prompt"实现。

```
轮 1（用户首条消息）：
  chat.message（落库前，prompt.ts:999-1047）
    ├─ 探针捕获 system（缓存 key，供轮 2 注入；零 token）
    ├─ 真实消息 parts → 存盘 pending（sessionID → parts JSON，probe-cache 同目录）
    ├─ output.parts 替换为 [锚定消息 part（synthetic: true，纯 dsh 原文，
    │    不加幂等标记——round-9 实测首轮任何额外内容都破坏 we 锚定）]
    │    · synthetic：TUI 过滤不显示、模型可见（serve 端 message-v2 只滤
    │      ignored/空文本）→ 模型只看到锚定消息 → we 风格回复（实测 ✓）
    └─ seeded 规则（whitelist: [] → 0 工具）
  锚定回复落库（assistant 消息 = 晋升信号）
  event hook（session.idle，run 完全结束后发布）
    └─ 查 pending：存在 → client.session.prompt 自动发轮 2：
       parts = [user system part（探针捕获 → filterFirstTurnSystem 去 persona，
       synthetic: true，带 INJECT_MARKER 幂等）+ ...pending 真实消息 parts]
       （不带 tools → 不替换 permission；显式传 agent+model——省略时
       createUserMessage 用默认 agent；新消息 id 单调 id/id.ts:51-70 →
       排在锚定消息后）→ 发送前清 pending（内存 + 磁盘）
轮 2（prompt 消息入库，自动触发 chat.message ensure）：
    ├─ stage=seeded + 历史有 assistant 信号 → unlock（全量工具 + 哨兵 unsealed）
    └─ 模型带全量工具处理真实任务
```

**触发点修订（round-10，实现前源码核实）**：D13 原定 `event`（message.updated，
info.role === "assistant"）触发轮 2，但 busy 窗口下不安全：

- `message.updated` 在 run **仍在 Running** 时发布（processor.ts:456/596 →
  `sessions.updateMessage` → `Session.Event.MessageUpdated`，session.ts:633）；
- 此时 `session.prompt`（→ `loop` → `ensureRunning`，prompt.ts:1346）在 runner
  busy 状态下**等待当前 run 完成后丢弃新 work**（runner.ts:120-122
  `return [awaitDone(st.run.done), st]`——不排队、不报错）→ 轮 2 消息已入库
  但 runLoop 永不执行（静默丢失）；
- `session.idle`（`{type:"session.idle", properties:{sessionID}}`，
  sdk types.gen.d.ts:413-417）由 runner 完成时发布（runner.ts:70-81 finishRun
  → onIdle → run-state.ts:60-63 → status.ts:43 `publish(Event.Idle)`）→
  **run 完全结束、无 busy 竞态** → 用它触发轮 2。

**竞态与边界**：

- **bypass（探针失败）**：不替换 parts、不存 pending——真实消息原样发出
  （原生行为，锚定不生效）。
- **prompt 防重**：发送前先清 pending（内存 + 磁盘）+ sending 集合（进程内
  防并发）；idle 对探针会话、轮 2 及后续 run 重复触发不重复发（pending 已清）。
- **重锚定（锚定回复未落库）**：pending 存在 + 边界后无 assistant 消息
  （锚定中断/失败/用户重试）→ 当前消息 parts **追加** pending，parts 替换为
  锚定消息重试锚定轮。
- **重启悬挂（ensure 补发）**：pending 落盘但 event 不重放历史 → ensure 时
  若 pending 存在且边界后已有 assistant 消息（锚定已完成）→ 补发 prompt；
  **当前消息正常放行（不推迟）**——pending 旧内容经轮 2 作为历史上下文可见，
  当前消息自身 run 正常处理（避免"当前消息变空 placeholder + 空 user run"）。
- **prompt 失败**：恢复 pending（内存 + 磁盘）→ 下次 ensure 补发兜底。
- **prompt 触发 chain**：session.prompt 消息入库 → chat.message 触发 → ensure
  （探针会话跳过逻辑只认 probeSessions，真实会话正常）→ unlock 在本次生效
  （await 内）。
- **并发 run 竞态（可接受）**：补发 prompt 与当前消息的 run 竞争 ensureRunning，
  先到者启动、后到者被丢弃——被丢的消息仍在历史，后续轮模型可见，内容不丢。
- **TUI 显示**：轮 1 用户消息 = synthetic 锚定 → 隐藏；轮 2 = [synthetic
  user system（隐藏）+ 真实任务（正常显示）]——用户看到真实任务自动发出
  （系统代发，对齐 dsh whoami 体验）。
- **会话标题（意外收益，round-10 源码核实）**：`ensureTitle`
  （prompt.ts:193-224）按"含非 synthetic part 的 user 消息"判定真实消息——
  锚定轮首条消息全 synthetic → 不算真实 → **标题生成自动跳过锚定内容**；
  轮 2 消息含真实任务 part → 标题基于**真实任务**生成。无需额外处理。

## 5. 阶段状态机（哨兵 + DB 持久化）

无内存状态，靠 session permission 规则判定：

| 阶段     | 判定          | 行为                                                                             |
| -------- | ------------- | -------------------------------------------------------------------------------- |
| pristine | 无哨兵规则    | `chat.message` ensure → 注入 + seeded（追加规则）                                |
| seeded   | 哨兵 `seeded` | 注入成功；解锁信号（边界后 assistant 消息/工具调用）→ 解锁；判别进行中（N=3 轮） |

- 注（zero 形态，§4.5）：seeded 即锚定轮已完成（锚定消息已发、真实消息在
  pending）；锚定回复落库后由 event/sendRound2 发轮 2，轮 2 消息的 ensure
  完成解锁。
  | unsealed | 哨兵 `unsealed` | 已解锁（seeded 的内部变体，防重复解锁）；判别进行中 |
  | verified | 哨兵 `verified` | 判别通过（模型输出特征达成，成功标记）；不再解锁/判别 |
  | bypass | key failed（缓存） | 全部 hook 原样放行（key 级判定，无哨兵） |

- 哨兵 = 插件自造规则 `{permission:"__dsv4_stage__", pattern:<阶段>,
action:"allow"}`（不匹配任何真实工具，惰性；`findLast` 取阶段）。
- seeded 规则（**D10：严格 minimal 工具对**；round-10 起默认白名单 = `[]`，
  **zero 形态：0 工具**，见 §8.2）：
  `[{permission:"__dsv4_stage__",pattern:"seeded",action:"allow"},
 {permission:"*",pattern:"*",action:"deny"},
 ...whitelist.map(allow), {permission:"external_directory",pattern:"*",action:"allow"}]`
  （白名单可配置，zero 形态默认 `[]`；`deny *` 已隐藏全部内置工具——
  `disabled()` 只在 `pattern==="*" && action==="deny"` 时隐藏工具）。
- 解锁（原 promote；D2/D6/D7 修订；round-10：假 str_replace_editor 已移除，
  无隐藏 deny）：
  `[...agent.permission, ...sessionDenies(排除插件自身 deny *), 哨兵 unsealed]`
  ——merge 追加语义（`session.update` append-only），build 的 `*: allow` 等价
  全量开放；explore/自定义 agent 的 ask/deny 保留；subagent 的 task deny 保住；
  目录恢复 opencode 自然状态（插件不注册任何工具，§8.2.2）。
- **特征判别（验证，N=3 常量）**：seeded/unsealed 阶段每轮 `chat.message`
  扫描**边界后** assistant 消息（从最早起）：**任一**消息符合**轨迹标记判别**
  （见下）→ 追加哨兵 `verified`（成功标记，持久）并**立即停止判别**（第一轮
  符合则第二轮不再判，以此类推）；窗口内 N 条全部不符合 → 停止判别
  （`verify.giveup` warn 日志，进程内 Map 去重每进程一次），**保留当前状态**
  （不加失败标记）。
- **轨迹标记判别（round-7/8 定案）**：判别对象 = assistant 消息的
  `reasoning` part（`type:"reasoning"`，`v1/session.ts:118-128`，思维链）+
  `text` part 拼接全文（dsh 实测 `we`/`let me` 计数远超可见回复数 → 特征主要
  在思维链里）。标准 = **首个轨迹标记**：找全文第一个 we 系词（`we need`/
  `we`）与 let 系词（`let me`/`let's`）的位置；**`idx(we系) < idx(let系)` 即
  通过**（let 系不出现 = +∞，we 系存在即通过；we 系不出现则不通过）。贴合
  dsh"首行 `We need…`"语义（思维起步取向），对 `let me` 少量出现鲁棒（dsh
  r1 实测 let me=1 仍为 minimal 轨迹）。词表可配置（§8.2 `verify.terms`）；
  中文词表曾为实验项——round-9 起 zero 方案锚定回复恒英文、中文词表移除
  （`ZH_TERMS` 已删，round-10）。
- compaction 回退（**D5 修订，对齐 dsh compactionTools**）：`experimental.session.compacting`
  hook（`compaction.ts:373`，input 含 `sessionID`，无 session.compacted 事件）
  触发 → 追加 `deny *` + minimal 对 + **compactionTools**（read/glob/grep/edit/
  todowrite/question）+ 哨兵 `seeded`（覆盖 verified/unsealed，append-only）→
  **重新注入**（幂等标记已被压缩 → 重注自然允许，对齐 dsh 每轮注入语义）→
  **重新判别**（新窗口）。
- **epoch 边界**：解锁信号与判别窗口的起点 = 历史中最后一条含 `CompactionPart`
  （`type:"compaction"`，schema `v1/session.ts:195-202`）的 user 消息（其
  `tail_start_id` 起），无则从头；跨 restart 可扫（消息持久化）；prune 的
  `part.state.time.compacted` 只是清 tool 输出，**不是**压缩边界，不触发回退。
- fresh 判定：session.messages 无 assistant 消息。

## 6. 注入与幂等（D3 修订 + round-10 修订）

- 注入点：`chat.message` 原地 `output.parts.unshift(...)`（`prompt.ts:999-1047`：
  落库前触发、parts 同引用、本消息持久化且进入本次请求、排在真实消息 parts 前）。
- **zero 形态（默认，§4.5）**：注入由 **sendRound2 直接携带**——轮 2 的
  `session.prompt` parts = [user system part（探针捕获 → `filterFirstTurnSystem`
  去 persona，synthetic，带 `INJECT_MARKER`）+ pending 真实 parts]；ensure 的
  `stage === "unsealed"` 注入分支为后续消息 / resume 兜底（历史无幂等标记即
  注入）。
- 注入内容 = **探针捕获的 system 全量** + 幂等标记文本（如
  `[dsv4-anchored:injected]`）。
- resume 判定：扫 session 历史 parts 中是否已有标记 → 已注入则不再注入。
- **compaction 后重注入**：注入内容被压缩掉 → 回退 seeded 后注入判定统一为
  "历史无幂等标记即注入" → 自动重注入（对齐 dsh 每轮注入的语义，信息不丢）。
- 不用 `experimental.chat.messages.transform`（input 为 `{}`，无法按会话/模型门控）。

### 6.1 首轮注入的扰动风险与备选（D11）

- **风险**：首轮 user 消息在場 AGENTS.md 全文 + 技能目录提醒（~9KB
  `<available_skills>`）——dsh 复现清单第 3 条要求首轮消息不含这两类内容，
  issue #6 实测技能目录提醒在场时锚定 0/9、无目录 ~81%（dsh 里 skill-catalog
  本就是 user 消息形态）。
- **现状（默认）**：首轮注入完整捕获（信息不丢，D3）；system 干净 + 双工具
  目录两个决定变量已对齐，扰动为**验证项**而非预设缺陷。
- **备选升级路径（实测不达标时启用）**：选择性剥离——注入前按稳定标记切段
  过滤：`Instructions from:` 开头段（AGENTS.md/CLAUDE.md/CONTEXT.md）与
  `Skills provide specialized instructions` 开头段（技能目录）；首轮滤掉这两段，
  解锁后补注完整捕获（幂等标记区分部分/完整注入）。
- **触发条件**：首轮判别不达标（首行非 `We…` 风格、`let me` > 0，即 N 轮内
  未达成 verified）才启用。

## 7. 日志设计（round-5 定案）

### 7.1 app.log 机制（源码核实）

- `client.app.log` = HTTP `POST /log` → Effect `logDebug/logInfo/logWarning/
logError`（`handlers/control.ts:28-39`）；级别仅 debug/info/warn/error，
  **无 trace**，debug 即最细。
- 默认只写文件（`~/.local/share/opencode/log/opencode.log`）；
  `OPENCODE_PRINT_LOGS=1` 才额外打 stderr（`core/observability/logging.ts:68`）。
- 过滤在服务端：`minimumLogLevel()` 读 `OPENCODE_LOG_LEVEL`，默认 **INFO**
  → debug 默认不落盘（`logging.ts:56-65`）。
- 格式：结构化 `key=value` 扁平化（嵌套对象展开；长字符串整体 JSON 化）。

### 7.2 插件侧设计

- **debug 开关**：插件与 opencode 同进程，启动时解析一次
  `process.env.OPENCODE_LOG_LEVEL === "DEBUG"` 缓存为布尔量。
- **两级日志**：
  - info：摘要字段（长度、hash、前 100 字符、阶段、门控、来源……）
  - debug：完整字段（system 替换前后全文、注入全文、permission ruleset 全量、
    探针捕获原文），`debug()` 方法开头短路——**序列化与 HTTP 只在开启时发生**
    （避免每轮请求白做 JSON.stringify 完整 system + roundtrip）。
- 调用 fire-and-forget，不 await，不阻塞 hook 链路。

### 7.3 日志事件清单

| 事件                | 级别 | 摘要字段（info）                                                                    | 全量字段（debug）     |
| ------------------- | ---- | ----------------------------------------------------------------------------------- | --------------------- |
| chat.message        | info | sessionID、stage、gating、injectSource(inject/bypass/none)、injectLen、visibleTools | 注入全文              |
| probe.start         | info | key、sessionID                                                                      | —                     |
| probe.success       | info | key、sysLen、sysHash                                                                | 捕获的 system 全文    |
| probe.fail          | info | key、error、TTL 生效                                                                | 完整 error stack      |
| bypass              | warn | key、reason                                                                         | —                     |
| system.transform    | info | sessionID、gating、action(replace/passthrough)、beforeLen、afterLen、beforeHash     | 替换前后全文          |
| unlock              | info | sessionID、agentRuleset 条数、排除 denies、哨兵 unsealed                            | 完整 ruleset 追加列表 |
| round2.sent         | info | sessionID、partCount、sysInjected(是否含 user system part)                          | 轮 2 完整 parts       |
| round2.fail         | warn | sessionID、error（pending 已恢复，ensure 补发兜底）                                 | —                     |
| verify.passed       | info | sessionID、判别消息 id、特征摘要（首行、letMe 计数）                                | 判别消息全文          |
| verify.giveup       | warn | sessionID、已检轮数 N                                                               | —                     |
| compaction.rollback | warn | sessionID                                                                           | —                     |

统一前缀 `dsv4-anchored`，用 `client.app.log(msg, {level, ...fields})` 结构化解构。

### 7.4 TUI toast 提示（round-10）

关键事件发 TUI toast（`client.tui.showToast` → 事件总线 → TUI 显示，
默认开启，`toast: false` 关闭）：

| 事件           | toast 文案                             | variant |
| -------------- | -------------------------------------- | ------- |
| 锚定轮（首轮） | 锚定轮：真实任务推迟，下一轮自动发出   | info    |
| round2.sent    | 轮 2 已自动发出（真实任务 + 完整工具） | info    |
| unlock         | 工具已解锁（agent ruleset 恢复）       | success |
| verify.passed  | 锚定判别通过（verified）               | success |
| bypass         | 探针失败，本次按原生处理（bypass）     | warning |

## 8. 配置与使用

### 8.1 安装

opencode 官方支持两种插件加载方式（本地文件 / npm 包），互斥使用：

- **npm 包（推荐，已发布）**：opencode.json 配置
  `"plugin": [["@dreadice/opencode-dsv4-anchored", {}]]`（首次加载自动安装，
  `engines.opencode` 兼容检查，入口走 `exports["./server"]`）。
- **本地文件**：`npm run build` 产出自包含 `dist/index.js`（esbuild bundle，
  运行时零外部依赖）→ 复制到项目的 `.opencode/plugins/dsv4-anchored.js`
  （opencode 自动发现 `.opencode/plugins/*.{ts,js}`，`ConfigPlugin.load`）；
  或全局 `~/.config/opencode/plugins/`。
  - 注意：opencode.json 的配置字段是 **`plugin`**（单数数组），不是 `plugins`。
- 插件由用户显式安装，安装即生效（D1），无需 agent 配置；
  `engines.opencode >= 1.18.18`。
- git 引用不在官方支持范围（v1.18.18 文档仅本地文件/npm 两种），勿用。

### 8.2 配置项（插件 options）

| 项                | 默认                                                                              | 说明                                                                              |
| ----------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `models`          | `["deepseek*v4*"]`                                                                | 门控模型通配符                                                                    |
| `whitelist`       | `[]`                                                                              | seeded 期白名单（**round-10 起 zero 形态：0 工具**，对齐 dsh zero-anchored 实测） |
| `anchorText`      | `"This round is a test. Tools are not open yet; all tools will open next round."` | zero-anchored 锚定消息（dsh 原文；设为 `""` 关闭锚定轮，退回旧形态）              |
| `injectSystem`    | 启用                                                                              | 轮 2 注入 user system（`false` 关闭，仅锚定 + 真实消息）                          |
| `firstTurnFilter` | `{stripPersona: true}`                                                            | 注入前选择性剥离（D11；默认去 opencode persona 首句）                             |
| `verify.n`        | `3`                                                                               | 判别窗口（常量）                                                                  |
| `verify.terms`    | 英文：we `["we need","we"]`、let `["let me","let's"]`                             | 轨迹标记词表（round-10：中文实验词表 `ZH_TERMS` 已移除——锚定回复恒英文）          |
| `toast`           | 启用                                                                              | TUI toast 提示（触发/生效的可见标记；`false` 关闭）                               |

### 8.2.1 白名单 permission 名 ↔ 工具映射

白名单按 **permission 名**配置（源码 `permission/index.ts:204-213`
`disabled()`）：

| permission 名 | 覆盖工具                                                                         | 说明                                  |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| `bash`        | `bash`                                                                           | opencode 内置，id 与 dsh minimal 同名 |
| `edit`        | `edit`、`write`、`apply_patch`                                                   | 内置编辑族（seeded 期默认**不放行**） |
| `read`        | `read`、`read_mcp_resource`、`list_mcp_resources`、`list_mcp_resource_templates` | —                                     |
| 其他          | 同名工具                                                                         | —                                     |

**round-10 起默认 `[]`**：实测 0 工具才是唯一实证出 we 形态的配置（§2、D13）；
白名单作为显式配置项保留（如需解锁后额外保留某工具）。

### 8.2.2 ~~alias 工具：`str_replace_editor`~~（round-10 已移除）

D10（round-5）曾注册插件自定义工具 `str_replace_editor`（schema 逐字复刻
dsh）并替换 bash 描述（`tool.definition`），意图复现 dsh minimal 双工具锚定。
round-9 实测**双工具在 opencode 环境复现不了 we 锚定**（standard-like），
0 工具才是唯一实证形态（D13）→ **round-10 移除**：

- 删 `src/str-replace-editor.ts` / `src/bash-description.ts` / `Hooks.tool` /
  `tool.definition` hook；
- 解锁规则不再追加 `str_replace_editor: deny`（`unlockRules` 回归纯
  agent ruleset + session denies + 哨兵）；
- 移除理由：zero 形态下两处污染——插件工具在旁路/未门控/探针会话可见
  （无 `deny *`）；假 bash 描述在解锁后覆盖 opencode 原生描述（违背
  "恢复自然状态"）。
  | `agents.include` / `agents.exclude` | 全部 | 自定义 agent 通配符过滤（D7） |
  | `probe.ttlMs` | 300000 | 探针失败旁路 TTL |
  | `probe.cacheDir` | `~/.local/share/opencode/dsv4-anchored/` | 缓存与状态文件目录 |
  | `log.level` | 跟随 OPENCODE_LOG_LEVEL | 预留显式覆盖 |

### 8.3 启用 debug 日志

```bash
OPENCODE_LOG_LEVEL=DEBUG opencode          # 完整日志（默认只落盘）
OPENCODE_LOG_LEVEL=DEBUG OPENCODE_PRINT_LOGS=1 opencode   # 同时打 stderr
grep dsv4-anchored ~/.local/share/opencode/log/opencode.log
```

## 9. 验证方式

1. **日志验证**（每次请求）：`chat.message` 打阶段/门控/注入来源/可见工具；
   `system.transform` 打替换前后摘要——grep `dsv4-anchored` 即可核对。
2. **行为清单**（zero 形态，§4.5）：
   - 轮 1（锚定轮）：可见工具 = **0 个**；system = minimal persona；真实消息
     进 pending（落盘）；用户消息 parts = 纯锚定消息（synthetic）。
   - 锚定回复落库 → `session.idle` → `round2.sent` 日志；轮 2 自动发出
     （user system + 真实消息）；轮 2 消息 ensure → `unlock` 日志（哨兵
     unsealed）；可见工具恢复 agent ruleset；判别进行（N=3 窗口）。
   - 判别：窗口内任一 assistant 消息符合特征 → verified 日志，此后不再判别
     （第一轮符合则第二轮不判）；N 条全不符合 → giveup warn（每进程一次），
     保留当前状态。
   - 探针失败场景：bypass 日志；system 保持原生；工具全量（未 seeded、
     未锚定——真实消息原样发出）。
   - 重启 resume：pending 悬挂 → ensure 补发 `round2.sent`；verified 会话
     不再注入；seeded/unsealed 会话按边界后信号解锁、按窗口判别。
   - compaction 后：回退 seeded（重新注入 + 重新判别）。
3. **判别效果实测（round-10 已达成 ✅）**：按 dsh verify 清单复验——锚定轮
   header tools 数量（0 个）、锚定回复 we 风格、`verify.passed`（v4-pro 与
   flash-free 均实测，哨兵 verified 落库）。
   **不达标时的升级路径：D11 选择性剥离**（§6.1）。

## 10. 已知限制

- 判别特征（首行 `We…`、`let me`=0）是 dsh 英文语料的特征，非英文/中文回复
  可能误判未达成 → 只会停止判别（warn）不锁死（round-10 起锚定消息恒英文）。
- 首轮 token 不省：注入 = 原 system 全量；收益在 system 位置最小化。
- seeded 期白名单工具不触发 ask；解锁后按 agent ruleset 恢复。
- 规则只增不减（append-only）：无热加载前提下无感知；compaction 回退靠追加。
- 探针冷启动：首个会话等一次探针（本地组装+throw，几十 ms 级，无模型调用）。
- `client.session.get` 的 permission/agent/model 需 `as any`（wire 有、SDK 类型
  未声明；`directory`/`parentID` 已声明可直接用）；`session.update`
  传 permission 需 `as any`；`client.config.get` 不含内置 agent（用
  `client.app.agents()`）。
- `session.prompt` 严禁带 tools（整体替换 permission）；探针也不带。
- 探针失败期间该 key 旁路（原生行为），TTL 后自动恢复处理。

## 11. 实现顺序

1. 日志模块（两级 + debug 短路 + 事件清单）——其余模块的观测基础
2. ~~str_replace_editor 工具注册（D10）~~：round-10 已移除（实测双工具
   复现不了 we 锚定；插件不注册工具，§8.2.2）
3. 状态机 + permission 规则（seeded/解锁/判别哨兵，白名单与 compaction
   工具集）
4. 探针捕获（create/title → prompt → transform 捕获+throw → delete；缓存
   key/并发去重/磁盘持久化/failed TTL/旁路）
5. chat.message ensure（subagent 识别）+ 首轮注入（幂等标记）+ 解锁判定
   （边界后信号）+ 特征判别（N=3 轮窗口）
6. chat.system.transform（探针捕获 + 真实会话替换 minimal）
7. compaction 回退（`experimental.session.compacting` → 回 seeded）、resume
   re-sync、agent include/exclude 配置
8. **D13 zero-anchored（round-10 定案，§4.5）**：
   - `src/pending.ts`：pending 存储（内存 Map + 磁盘 JSON，`pending.json` 与
     probe-cache 同目录 + sending 防重集合）
   - `src/round2.ts`：`sendRound2`——轮 2 prompt（user system part +
     pending 真实 parts，显式 agent+model，不带 tools；发送前清 pending，
     失败恢复 pending 交 ensure 补发）
   - `src/core.ts` ensure 锚定流：首轮替换 parts + 推迟 / 重锚定 /
     悬挂补发（当前消息正常放行）
   - `src/index.ts`：`event` hook（`session.idle` → `sendRound2`，
     probeSessions 跳过）+ pending 装载/保存 + 默认 zero 配置
   - 移除 `ANCHOR_MARKER`（锚定消息纯净）与 `ZH_TERMS`（verify.ts）

## 12. 相关文档

- `research.md`：完整研究报告（机制源码：文件:行号）
- `decisions.md`：D1-D9 决策记录
- `handoff.md`：跨会话状态与讨论留档
