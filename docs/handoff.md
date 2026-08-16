# Handoff: opencode-dsv4-anchored 插件

## 任务

把 dsh-anchored-standard 的方法移植到 opencode 插件，解决 DeepSeek V4 的过拟合问题
（首轮轨迹约束 + 逐步解锁）。

项目目录：`/home/liubohan/opencode/dsv4-adapter`（git 已初始化，`.gitignore` 含
`reference/`、`node_modules/`、`dist/`）。
当前状态：**实现完成（89 测试全绿）、真机验证完成（serve + HTTP API，v4-pro 与
flash-free 均全链路通过）、npm 已发布（`@dreadice/opencode-dsv4-anchored@0.1.0`）**：

- 实现：verify/gate/stage/inject/epoch/cache/probe/logger/core/system-transform/
  compaction/pending/round2/sdk-adapter/index
- 真机（官方 v4-pro + variant max，关键实测）：
  - minimal + **0 工具** → thinking **we 风格**（"We need answer..."）✅
  - minimal + **双工具**（含 bash 描述对齐 dsh 后）→ standard-like ❌
    （opencode 复现不了 dsh Anchored Standard 双工具锚定）
  - 首轮注入任何内容（即使 stripPersona）→ 破坏 we 锚定
  - **splice 修复**：`output.system = [...]` 重赋值不生效（plugin.trigger 忽略
    返回值，request.ts 用局部数组引用）→ 必须 `splice` 原地改——已修复
- **D13 zero-anchored（round-10 已实现 + 真机全链路验证）**：锚定轮（0 工具 +
  纯锚定消息）→ 真实消息推迟（pending 存盘）→ `session.idle` 自动轮 2
  （user system 去 persona + 真实消息）→ 解锁 → 判别 verified
- **round-10（本会话）**：D13 实现（pending/round2/event hook + 默认 zero
  配置）；真机发现并修复 4 项（插件导出全函数 / permission wire 缺省 /
  Agent 用 name / chat.message model 兜底）；serve 全链路验证
  （anchor we → round2 → 工具 → verify.passed）；npm 发布 + 安装方式定稿
  （官方仅本地文件/npm 两种）
- 安装方式（opencode 官方仅两种，已发布 npm）：`"plugin": [["@dreadice/
opencode-dsv4-anchored", {}]]`（推荐）或 `dist/index.js` →
  `.opencode/plugins/`（实测；配置字段 `plugin` 单数；options 用
  `plugin: [["路径", {options}]]` 数组形式）

## 必须首先阅读的文档（已有，勿重复研究）

- `docs/design.md` — **系统设计文档（最新，含目标/行为/日志/使用/配置/验证）**。
  **核心参考**
- `docs/research.md` — 完整研究报告（背景、dsh 方案、官方 Minimal 源码、opencode
  机制映射含文件:行号、探针链路 §4.9、日志机制 §4.10、移植方案、已知限制）。
- `docs/decisions.md` — 决策记录（D1-D13）。**决定清单**（顶部含 round-7 术语表）
- `docs/testing.md` — **测试用例文档**（L1 单元 / L2 fake client 集成 / L3
  真机（serve + HTTP API）；TC-1-x ~ TC-3-x 用例清单）
- `docs/live-testing.md` — **真机测试手册**（serve + HTTP API 为主，构建部署/
  配置/命令模板/日志核对/实测结论/花钱注意）
- `docs/plan.md` — **执行计划**（P0~P5 分阶段；TDD 红须编译通过；每模块含
  函数签名/实现细节/验收）
- 参考仓库（勿提交）：
  - `reference/dsh-anchored-standard/`（xiaobright preset：`preset/agent.cordis.yml`、
    `preset/tool-bootstrap.mjs`、`zero-anchored-standard/anchor-turn.mjs`、
    `zero-anchored-standard/zero-tool-bootstrap.mjs`、`whoami-standard/`）
  - `reference/deepseek-harness/`（官方：`apps/cli/config/agent-presets/minimal/`、
    `standard/`）
  - `reference/opencode/`（v1.18.18，插件机制源码）

## 决策摘要（详见 decisions.md）

- **D1**：全局 hook + 模型门控，不绑定 agent。插件用户自装，安装即生效
- **D2**：解锁后**全量开放**工具；**D6/D7 修订**：不用 `allow *`，解锁 =
  merge 追加 `[...agent.permission, ...sessionDenies, 哨兵 unsealed]`（build 的
  defaults 含 `*: allow` → 等价全量开放；explore/自定义 agent 的 ask/deny 保留；
  subagent 的 task deny 保住）
- **D3**：**minimal system 常驻 + 原 system 以 user part 注入首轮**。system 全程
  替换为纯 Minimal persona（所有 agent 无差别）；**原 system 全部内容** prepend
  到首条 user 消息 parts 前；注入方式 = `chat.message` 原地改 parts
- **D4**：模型门控按通配符 `deepseek*v4*`（匹配 providerID/modelID）
- **D5**：解锁信号 = 边界后 assistant 消息/工具调用（**观察驱动**：请求 #1
  恒为受限目录，信号落库后请求 #2 起完整目录；判定收敛到 chat.message ensure
  扫历史，无需信号 hook）；**compaction 回退（round-5/6/7 修订）**：对齐 dsh
  compactionTools——回退 = minimal 对 + read/glob/grep/edit/todowrite/question
  - 哨兵 `seeded`；**触发点 = `experimental.session.compacting` hook**（无
    `session.compacted` 事件）；epoch 边界 = 历史最后一条 `CompactionPart` 之后；
    **回退后自动重注入 + 重新判别**（round-6/7，用户确认）；
    验证=插件内置日志+grep（可选抓包）
- **D6**：subagent 独立处理（首轮 minimal+注入、自身信号解锁、解锁保留
  task/todowrite deny、父已验证不豁免）
- **D7（Decided）**：自定义 agent 与默认 agent 完全同构（system=纯 minimal
  persona，原 system 全量 user part 注入；解锁用 `client.app.agents()` 取
  agent ruleset）；配置 `{include, exclude}` 通配符，不写=全部
- **D8（round-5）**：探针失败 → 取消自组装兜底，**缓存 key 标 failed + TTL（5 分钟）
  按 key 旁路**——不替换 system、不注入、不 seeded，行为完全原生；状态文件
  `probe-cache.json` 可展示；TTL 后/跨天重试
- **D9（round-5）**：日志两级——info 摘要字段（长度/hash/前 100 字符/阶段/门控/
  来源）、debug 完整字段（全文/ruleset 全量）；debug 短路 = 启动时读一次
  `OPENCODE_LOG_LEVEL === "DEBUG"`，`debug()` 开头 return（避免每轮序列化+HTTP）；
  fire-and-forget；`app.log` 机制研究见 research.md §4.10
- **D10（round-5，round-10 已移除）**：曾注册插件自定义工具 `str_replace_editor`
  （schema 逐字复刻 dsh）+ 假 bash 描述（`tool.definition`），seeded 白名单
  `["bash","str_replace_editor"]`、解锁时 deny 隐藏——round-9 实测双工具复现
  不了 we 锚定，0 工具才是唯一实证形态 → round-10 移除全部假工具（src 删除、
  `unlockRules` 回归纯 agent ruleset；详见 design.md §8.2.2）
- **D11（round-5）**：首轮注入扰动风险备选——首轮 user 消息在場 AGENTS.md/
  技能目录（dsh 首轮剥离，issue #6：技能目录在场 0/9 vs 无 ~81%）；**默认保持
  完整注入**（信息不丢），实测判别不达标才启用**选择性剥离**（按稳定标记切段：
  `Instructions from:` / `Skills provide specialized instructions`，首轮滤掉、
  解锁后补注）
- **D12（round-7/8，状态机 v3）**：术语不用"锚定/晋升"——状态 =
  `pristine`（无哨兵）/ `seeded`（注入成功，**工具已由信号自动解锁**，单轮
  注入无两步）/ `unsealed`（已解锁内部变体）/ `verified`（判别通过）；
  **判别 N=3 常量**：窗口内**任一** assistant 消息符合轨迹标记判别即 verified
  并立即停止；N 条全不符 → giveup（warn 每进程一次）保留当前状态；
  **轨迹标记判别**：`reasoning`+`text` 拼接全文 `idx(we系) < idx(let系)` 即通过
  （词表可配置，中文实验词表不稳定 → giveup 不锁死）；
  compaction → 回 seeded（重注入 + 重判别）
- **D13（round-9 定案，round-10 实现 + 修订）**：锚定轮（minimal + **0 工具** +
  **只有锚定消息**，真实消息推迟）→ 锚定回复落库（晋升信号）→ event 自动
  prompt 轮 2（**user system 去 persona 在前 + 真实消息在后**）→ 解锁 →
  判别；锚定消息/注入块用 `synthetic: true`（TUI 隐藏、模型可见）；
  pending 存盘（sessionID → parts）+ prompt 防重 + 重启悬挂补发；
  完整时序见 design.md §4.5；**round-10 已实现**（触发点改为 `session.idle`——
  busy 窗口会丢 runLoop，research §4.12；锚定消息不加 marker——实测首轮任何
  额外内容破坏 we）
- **round-9 关键 fix**：`system.transform` 必须 `splice` 原地改 output.system
  （重赋值不生效——plugin.trigger 忽略返回值，request.ts:69-78 用局部数组
  引用）；注入时机 = 解锁后（unsealed）——round-10 起 D13 轮 2 由 sendRound2
  携带 user system，ensure 注入为兜底

## ★ round-4 突破（2026-08-16，最后定案）：探针捕获真实 system

**待续问题已解决**：不靠"插件自组装"，也不靠"两轮补发"，而是——
**静默探针请求 + hook 内 throw 零 token 捕获完整真实 system**。

用户原话："捕获为主，或者有没有办法调用opencode组装system方法之类的，总之以
不自主装为前提，再研究一遍有没有更优雅的方法"。研究结论：**没有公开 API 能调用
opencode 的 system 组装**（无渲染端点，见下）；**探针是唯一拿到 100% 真实 system
的路径**，且可做零 token。round-4 定案：探针捕获为主；**round-5 修订：失败也不
自组装，改为按 key 旁路（D8）**。

### 本轮新验证的源码事实（勿再改）

1. **无 system 渲染端点**：全部 HTTP 端点清单（`.../httpapi/groups/*.ts` 的
   `identifier`）里没有渲染 system/instructions 的端点；`config.get` 只有配置、
   `mcp.status` 只有状态。组装逻辑（`SystemPrompt.Service` + `instruction.ts` +
   `Skill/MCP.Service`）是进程内 Effect 服务，插件 API 不可达。
2. **fork 方案已排除**：`session.fork`（`session.ts:693-734`）只复制 messages+
   parts（克隆消息历史），**不复制 system/permission/agent**。system 从不落库 →
   模板会话里根本没有 system 可继承；TUI 会话也无法被插件重定向成 fork（无
   session.create 拦截 hook）。用户提出后被否定。
3. **abort 链路真实且干净**：`client.session.abort` → `SessionPrompt.cancel`
   （`prompt.ts:152`）→ `SessionRunState.cancel`（`run-state.ts:77-86`）→
   `Fiber.interrupt(runLoop)`（`runner.ts:171-178`）→ processor 的
   `Effect.onInterrupt` 把 assistant 消息标 aborted（`processor.ts:648-652`）。
   **但弃用 abort**：有竞态（provider 调用可能已发出才中断）。
4. **改用 hook 内 throw，确定性零 token**：
   - `experimental.chat.system.transform` 在 `request.ts:69` 触发，位于 `prepare`
     内部（`llm.ts:106`），**早于** `llmClient.stream`（`llm.ts:232`）→ throw 后
     模型永不调用；
   - throw 的错误 → `processor.ts:675` `Effect.catch(halt)` → halt 把 assistant
     消息标 error → `processor.ts:680` `if (ctx.blocked || error) return "stop"`
     → `prompt.ts:1319` `outcome === "break"` → **runLoop 终止，不会进入 step2**；
   - 重试防护：throw 的 error message **不能命中** `retry.ts:33-40` 的
     RETRYABLE_MESSAGE_PATTERNS（禁词：429/500/502/fetch failed/timeout/terminated/
     network/connection/rate limit/resource exhausted 等）→ `retryable()` 返回
     undefined → 不重试。建议消息如 `"DSV4 probe: capture complete"`。
5. **探针 runLoop 无阻塞、副作用可避免**：
   - `prompt.ts:1149-1258` 在 system 组装前无 permission.ask/overflow 阻塞；
   - 后台 `title` 生成（`prompt.ts:1133-1139`，小模型调用）：用**自定义会话标题**
     跳过——`session.create` body 带 `title`（`summary.ts:200` 非默认标题早退）；
   - `summary.summarize`（`prompt.ts:1252-1253`）是本地快照 diff，无模型调用
     （`summary.ts:102-127`）；
   - 探针消息自己会触发 `chat.message`/`event` → **按探针 sessionID 集合跳过**。
6. **SDK 类型核实**（`node_modules/@opencode-ai/sdk/dist/gen/`）：
   - `SessionCreateData.body`：`{parentID?, title?}`；query `{directory?}`；
   - `SessionPromptData.body`：`{messageID?, model?{providerID,modelID}, agent?,
noReply?, system?, tools?, parts[]}`——**探针可指定与真实会话相同的
     agent+model**；
   - `SessionUpdateData.body` 仅 `{title?}`（**permission 需 `as any`**，wire 的
     UpdatePayload 支持）；`session.update` 的 permission 是 **merge 追加**
     （`handlers/session.ts:194-197` = `Permission.merge(current, payload)`）→
     append-only 语义成立；
   - `client.session.prompt` **await 整个 runLoop**（`handlers/session.ts:295-309`
     → `promptSvc.prompt` → loop），探针捕获可同一次调用内完成；
   - `client.app.agents()`（`sdk.gen.d.ts:263`）返回 `Agent[]`：含 `permission`
     （config 形，`types.gen.d.ts:1399-1428`）+ `prompt`；
   - `client.session.delete` 存在（可清理探针会话）。
7. **permission 语义核实**（`permission/index.ts:204-215` `disabled()`）：工具仅在
   匹配到 `rule.pattern === "*" && rule.action === "deny"` 时隐藏（非 `*` pattern
   的 deny 只影响 ask）；`edit/write/apply_patch`→`edit`，`read_mcp_*`/`list_mcp_*`
   →`read`。bootstrap 的 `deny *` 才能隐藏非白名单工具。

### 探针捕获设计（最终方案）

```
首轮 chat.message(真实会话 S, 消息 M)   ← chat.message 被 await，时机有保证
  ├─ 阶段 ensure（bootstrap/哨兵，见下）
  ├─ 缓存查询：key = (directory, agent, modelID, 日期)   ← system 含 Today's date
  │    （system.ts:81 日期随天变 → 跨天重探；进程内 Map + 可选持久化）
  ├─ 缓存 miss → 同步探针（chat.message 内 await，含并发去重 Map）：
  │    client.session.create({query:{directory}, body:{title:"dsv4-probe-..."}})
  │    probeSessions.add(探针ID)
  │    await client.session.prompt({path:{id:探针ID}, body:{parts:[{type:"text",
  │      text:"probe"}], agent, model}})   ← agent+model 与真实会话一致
  │      探针 runLoop → 组装真实 system → system.transform hook
  │        (input.sessionID ∈ probeSessions) → 捕获 output.system.join("\n")
  │        → 写 cache → throw 标记错误（禁词规避）
  │      错误 → halt → assistant 标 error → outcome "stop" → runLoop 终止
  │    （prompt() 调用可能 reject，需 try/catch 吞掉——预期行为）
  │    client.session.delete(探针ID)；probeSessions.delete
  └─ 注入：output.parts.unshift({id,messageID,sessionID,type:"text",
       text:捕获的 system 全量 + 幂等标记文本})
```

- **探针会话权限**：无 session permission → 捕获**未过滤的自然 system**（MCP 说明
  全量）——正是"原 system 全部内容"的语义；真实会话 seeded 期的 MCP 过滤反而
  会少内容，故探针捕获值更符合注入目标。
- **失败旁路（round-5 修订，D8）**：探针失败 → 该缓存 key 标 failed + TTL
  （默认 5 分钟）→ TTL 内命中该 key 的会话**整个旁路**（不替换 system、不注入、
  不 seeded，行为 = 原生 opencode）；状态文件可展示；**自组装代码不写**。
- **探针可复用**：同一 (dir,agent,model,date) 只探针一次；跨天重探。

## 已实现的功能（src/，round-10 全部落地）

### 核心机制（源码已验证）

1. **工具可见性**：session permission ruleset 控制，`findLast` 后写覆盖
   （`.../permission/index.ts:204` `disabled()`）
   - seeded（round-10 zero 形态，白名单默认 `[]`）：
     `[{permission:"__dsv4_stage__",pattern:"seeded",action:"allow"},
{permission:"*",pattern:"*",action:"deny"}, ...whitelist.map(allow),
{permission:"external_directory",pattern:"*",action:"allow"}]`
   - 解锁：`[...agent.permission, ...sessionDenies(排除插件自身 deny *),
哨兵 unsealed]`（round-10：假 str_replace_editor 已移除，无隐藏 deny）
   - 工具→权限名映射（`:204`）：`edit/write/apply_patch`→`edit`，`read_mcp_*`→`read`
   - 白名单默认 `[]`（0 工具，D13 zero 形态），可配置
2. **动态切换**：`client.session.update` merge 追加 + DB 持久化（重启不丢）
   （`.../handlers/session.ts:194-199`；`as any` 传 permission）
3. **解锁信号**（round-7：**收敛到 chat.message 扫历史，无信号 hook**）：边界后
   出现 assistant 消息/工具调用——信号持久化在历史里，每轮扫描天然幂等、
   覆盖 resume 与失败重试（与 dsh "从持久 event 推导"一致）。
   （历史信息：原方案 `tool.execute.before` / `event.message.updated`，
   schema `src/v1/session.ts:597`——已弃用）
4. **时机保证**：`chat.message` 在工具解析前触发且被 await
   （`.../session/prompt.ts:999`、`.../plugin/index.ts:292`）→ hook 内 await update
   保证本次请求生效
5. **system 替换**：`experimental.chat.system.transform`（`.../session/llm/request.ts:69`）
   input 含 `model` 可门控；output.system: string[] 可整体替换为 Minimal persona
6. **subagent 独立处理（D6）**：识别 = `client.session.get` 的 wire 返回
   `parentID`（SDK 类型需 `as any`）；解锁追加 agent ruleset 后 session 既有
   deny（task/todowrite/primary_tools，`task.ts:143-155`）重排在末 → 不能开
   subagent；`subagent_depth` 默认 1 为第二道防线
7. **（已弃用）补发消息**：`client.session.prompt` 原为路径 B 的补发机制；D3 统一
   为一次性注入后不再需要（round-10 起 `session.prompt` 承担轮 2 发送，见 §4.5）
8. **注入原 system**：D13 轮 2 由 `sendRound2` 携带 user system part
   （`src/round2.ts`：探针捕获 → 去 persona → synthetic + INJECT_MARKER）；
   ensure 注入（`stage === "unsealed"` 且历史无标记）为后续消息/resume 兜底。
   **不要用** `experimental.chat.messages.transform`（input 为 `{}`，无法按会话/
   模型门控）
9. **D13 锚定轮（round-10 新增）**：`src/pending.ts`（pending 存盘 + sending
   防重）+ ensure 锚定流（首轮替换 parts 为纯锚定消息 + 推迟 / 重锚定 / 悬挂
   补发）+ `event` hook（`session.idle` → `sendRound2`，probeSessions 跳过）；
   触发点用 session.idle 而非 message.updated（busy 窗口丢 runLoop，
   research.md §4.12）

### 阶段判定（无内存状态，靠 DB 持久化的 permission 规则 + 哨兵标记）

- 阶段标记 = 插件自造哨兵规则 `{permission:"__dsv4_stage__", pattern:<阶段>,
action:"allow"}`（任意字符串，不匹配任何真实工具，惰性）；`findLast` 取阶段
- 无哨兵（pristine）→ 注入 + seeded（追加 `deny *` + 白名单 + 哨兵 seeded）
- 哨兵 seeded / unsealed → 扫边界后信号 → 解锁（追加 agent ruleset + 哨兵
  unsealed，防重复解锁）；判别（N=3 窗口，任一符合 → 哨兵 verified）
- 哨兵 verified → 已通过（不再解锁/判别；无注入标记则补注入）
- fresh 判定：session.messages 无 assistant 消息（首轮判定）

### 门控贯穿

- `chat.message` / `chat.system.transform` 的 input 含 `model`，直接判断
  `deepseek*v4*` 通配
- `tool.execute.before` / `event` 无 model：仅对已处理 session 生效（检查
  permission 含哨兵/deny 规则）
- subagent：`client.session.get` 查 `parentID`（wire 有，SDK 类型 `as any`）；
  subagent 默认继承父会话 model（`task.ts:181-184`）→ 门控命中

### 内置验证日志

- 每次请求（chat.message 时）打印：session 阶段、模型门控命中、注入来源
  （probe/bypass/none）、可见工具列表、判别状态
- 用 `client.app.log`（结构化）或 console.log

## 实现顺序建议（round-7 更新，round-10 全部落地，详见 design.md §11）

1. 日志模块（两级 + debug 短路 + 事件清单）——其余模块的观测基础
2. ~~str_replace_editor 工具注册（D10）~~：round-10 已移除（双工具实测复现
   不了 we 锚定；插件不注册工具，design.md §8.2.2）
3. 状态机 + permission 规则（seeded/解锁/判别哨兵 + 白名单 + compaction 工具集）
   ——`permission/index.ts` `disabled()` 语义为根基
4. **探针捕获**：create 带自定义 title → prompt（同 agent+model）→ system.transform
   hook 捕获 + throw → delete 探针；缓存 `(dir,agent,modelID,date)`；并发去重；
   磁盘持久化；**failed TTL + 按 key 旁路（D8，无自组装 fallback）**
5. chat.message ensure（含 subagent 识别）+ 首轮注入（探针捕获值 prepend + 幂等
   标记）+ **解锁判定（边界后信号）** + **特征判别（N=3 窗口）**
6. chat.system.transform：探针会话→捕获+throw；真实会话→替换 minimal
7. compaction 回退（`experimental.session.compacting` hook 触发 → 追加
   配置白名单 + compactionTools + 哨兵 `seeded`；epoch 边界 = 最后一条
   `CompactionPart` 之后；**回退后自动重注入 + 重新判别**）
8. **D13 zero-anchored（round-10 已实现）**：`pending.ts`（pending 存储：
   内存 Map + 磁盘 JSON + sending 防重集合）+ `round2.ts`（sendRound2：
   轮 2 prompt = user system part（探针捕获→stripPersona，INJECT_MARKER，
   synthetic）+ pending 真实 parts；显式 agent+model；不带 tools；发送前清
   pending，失败恢复）+ `core.ts` ensure 锚定流（首轮替换 parts + 推迟 /
   重锚定 / 悬挂补发（当前消息正常放行））+ `index.ts` event hook
   （`session.idle` → sendRound2，probeSessions 跳过）+ 默认配置 zero 形态
   （whitelist `[]`、anchorText 默认 dsh 原文）+ ZH_TERMS 移除

## 已知限制（收敛后，详见 research.md §6）

- **判别效果需实测**（唯一真正待验证项，round-10 D13 实现后的真机复验）：
  0 工具锚定轮已实证出 we（官方 v4-pro）；完整链路（锚定轮 we → 自动轮 2 →
  解锁 → 判别）待真机验证（TC-3-11）
- 判别特征语言依赖：首行 `We…`、`let me`=0 是英文语料特征，中文回复可能误判
  未达成 → 只会 giveup（停止判别，warn）不锁死（round-7 确认；round-10 起
  锚定消息恒英文，ZH_TERMS 已移除）
- 首轮 token 不省（锚定轮后轮 2 注入 = 原 system 全量；收益在 system 位置
  最小化，非省 token）
- seeded 期白名单工具不触发 ask（默认白名单空 = 0 工具），解锁后按
  agent ruleset 恢复
- `client.session.get` 的 permission/agent/model 需 `as any`（`directory`/
  `parentID` 已声明可直接用）；
  `client.config.get` 不含内置 agent（用 `client.app.agents()`）；
  `client.session.update` 传 permission 需 `as any`
- **round-8/10 已核实**（实现时无需再查）：transform 必带 sessionID
  （`request.ts:69-73`）；探针 key 用 `session.get().directory`（`Session` 类型
  含 `directory`/`parentID`）；part id 用 `prt_<hex>`（`id/id.ts`），注入 part
  设 `synthetic: true`；`session.messages` 返回 `{info, parts[]}` 含
  `ReasoningPart`（判别提取 reasoning+text）；`session.idle` 触发轮 2 的 busy
  依据（research.md §4.12）
- `client.session.prompt` 带 `tools` 会整体替换 session.permission（严禁在解锁
  场景携带；探针/轮 2 都不带 tools）；轮 2 必须显式传 agent+model（省略用默认
  agent，prompt.ts:637-641）
- 规则只增不减（append-only）：无热加载前提下无感知；compaction 回退靠追加
  新 deny * + 新哨兵 `seeded` 覆盖（round-7）
- compaction 无 `session.compacted` 事件：触发走 `experimental.session.compacting`
  hook；epoch 边界 = 最后一条 `CompactionPart`；回退后自动重注入 + 重新判别
  （round-6/7）
- giveup 去重为进程内 Map：重启后可能重复打一次 `verify.giveup` warn（无害）
- 探针冷启动：首个会话等一次探针（本地组装+throw，几十 ms 级，无模型调用）
- 探针失败：按 key 旁路（原生行为，TTL 后恢复），**无自组装兜底**（D8）
- 首轮注入扰动（D11）：锚定轮真实消息推迟（pending），扰动面已最小化；轮 2
  注入仍含 AGENTS.md/技能目录（dsh 剥离、issue #6 实测扰动）——验证项，不达标
  启用选择性剥离备选
- 日志：`app.log` 无 trace 级、默认只落盘、服务端按 `OPENCODE_LOG_LEVEL` 过滤
  （默认 INFO）→ debug 内容必须插件侧短路（D9，research.md §4.10）
- 未实测：config hook mutate cfg.agent 时序（D1 已绕开，用全局 hook）

## 技术环境

- 构建：`npm run typecheck`（tsc --noEmit）、`npm run build`
- devDeps 已装：`@opencode-ai/plugin@1.18.18`、`@opencode-ai/sdk@1.18.18`、
  `@types/bun`、`typescript`
- package.json 的 exports `./server` → `./dist/index.js`；engines.opencode `>=1.18.18`
- 插件 API 类型在 `@opencode-ai/plugin`：`Plugin`、`Hooks`、`PluginOptions`；
  Model v2 类型在 `@opencode-ai/sdk/v2`（`Model` 需 `limit/status/options/headers/release_date`）
- git identity 已配置（dreadice/dreadice@hotmail.com）
- **`src/index.ts` 已重写为 Dsv4Anchored 完整逻辑**（round-10）：chat.message
  ensure + system.transform + compacting + event（session.idle → 轮 2）；
  provider hook 不注册（opencode 内置 `opencode/deepseek-v4-flash-free`，
  旧骨架的注册在 ad9d889 已随重写移除，round-9 真机已验证可用）

## 当前 git 状态

- 全部实现与 docs 已提交（HEAD `063db73`）：docs round-10 落档、假工具移除、
  D13 实现、真机修复（4 项）、README/AGENTS/LICENSE、npm 发布支持、
  live-testing 改名、安装方式定稿（两种）
- 已发布 npm：**`@dreadice/opencode-dsv4-anchored@0.1.0`**（官方 registry，
  已验证三种链路：手工 .js / npm 包 / serve 全链路）
- git 已推 GitHub（`origin` = dreadice/opencode-dsv4-anchored，main 同步）
- 剩余：D13 真机验证结果已回填（TC-3-11 ✅）；无未决事项

## Suggested skills

- `customize-opencode`：写插件源码/config 时加载，含 Plugin API 摘要和 schema 指引
- `grill-me` / `grill-with-docs`：如果实现前想再打磨设计
- `tdd`：如果用户要求测试先行（`reference/opencode` 测试在 package 目录跑，勿从仓库根跑）

## 本轮讨论留档（round-4，供新上下文回溯）

用户连提三轮"绕过自组装"，全部研究并定案：

1. **fork 模板方案**（"静默建 minimal 对话，所有 deepseek 会话 fork 它"）：
   排除——fork 不复制 system/permission/agent（`session.ts:693-734`）；system 不落
   库、模板里没有可继承内容；TUI 会话无法强制 fork；捕获探针仍要一次真实请求。
2. **"请求发了直接 cancel 再操作"**：可行但有竞态——`session.abort` 链路真实
   （`session.ts` → `run-state.ts:77-86` → `runner.ts:171-178` Fiber.interrupt），
   但 provider 调用可能已发出才中断，token 有损、时序不确定。
3. **hook 内 throw（最终采用）**：`system.transform` 在 `prepare` 内、早于
   `llmClient.stream`（`llm.ts:106` vs `232`）→ throw 零 token；错误被
   `processor.ts:675` halt 吞掉 → `outcome "stop"` → runLoop 终止不进 step2；
   消息避开 retry 白名单（`retry.ts:33-40`）不重试。**确定性、无竞态**。
4. **"调用 opencode 组装 system 的方法"**：不存在——无渲染端点（全端点清单已查），
   组装是进程内 Effect 服务，插件 API 不可达。探针是唯一真值来源。

## 本轮讨论留档（round-5，2026-08-16）

用户三个问题驱动定案：

1. **session 与失败标记归属**：session 每次 new 独立，但 system 内容由
   `(directory, agent, model)` 决定 → 缓存/失败标记挂在 **key** 而非 session；
   失败标记写状态文件可展示（cat probe-cache.json）。
2. **日志要全**：所有动作（替换前后、promote 追加、bypass、探针）都要可验证。
3. **探针频率**：按 opencode system 组装策略，内容只随 (dir, agent, model, 日期)
   变化 → 每 key 每天一次，进程 Map + 磁盘持久化，跨天重探。
4. **日志研究**（`app.log` 机制，research.md §4.10）：HTTP POST /log → Effect
   logger，级别仅 debug/info/warn/error **无 trace**；默认只落盘
   `~/.local/share/opencode/log/opencode.log`；服务端按 `OPENCODE_LOG_LEVEL`
   过滤（默认 INFO）；插件同进程 → 读 env 一次缓存做 debug 短路，避免每轮
   JSON.stringify 完整 system + HTTP roundtrip；info 只带摘要字段（D9）。
5. **探针失败语义（D8）**：用户"2 如果失败能不能不再执行替换？"→ 失败 = 整个
   旁路（不替换/不注入/不 bootstrap），取消自组装兜底——"要么完整锚定，要么
   完全原生"。
6. **严格 minimal 工具对（D10）**：用户"严格按照minimal模式，只注册两个工具"、
   "A就可以.只是system用一下，后边隐藏就行"——opencode 无配置层工具 alias
   （`tools` 只做权限映射，`config.ts:553-564`）；`tool.definition` 不能改工具名
   且全局生效（`registry.ts:305-333`）；`Hooks.tool` 注册自定义工具可行
   （`registry.ts:196-199` → `fromPlugin`）→ 插件注册 `str_replace_editor`
   （schema 逐字复刻 dsh 原版），bash 内置同名，bootstrap 白名单
   `["bash","str_replace_editor"]`（`deny *` 挡内置编辑族），promote 末尾追加
   deny 隐藏插件工具（研究详见 research.md §4.11）。
7. **dsh README 对照偏差核对**（对照
   https://github.com/xiaobright/dsh-anchored-standard/blob/main/README.zh-CN.md ）：
   - **偏差 1（首轮注入）**：README 复现清单第 3 条要求首轮消息不含
     AGENTS.md/技能目录（dsh `suppressedContextSources` 剥离，请求 #2 起恢复）；
     我们首轮注入完整捕获。用户澄清"HTTP API 角度没有脏上下文"（system 干净、
     注入在 user 侧、与 dsh 晋升后恢复的形态同构）→ **D11**：默认保持完整注入
     作为验证项，实测锚定不达标才启用选择性剥离（稳定标记切段
     `Instructions from:` / `Skills provide specialized instructions`）。
   - **偏差 2（promote 后隐藏）**：dsh 晋升后保留 str_replace_editor 工具对，
     我们 promote 后 deny 隐藏——用户有意为之（"只是system用一下，后边隐藏
     就行"），确认不改。
   - **偏差 3（compaction 回退范围）**：dsh 回退到 minimal 对 + compactionTools
     （read/write/edit/glob/grep/todo_write/ask_user_question），非严格双工具；
     用户"这个可以按他的"→ **D5 修订**：回退 = minimal 对 + opencode 映射
     （read/glob/grep/edit/todowrite/question）+ 独立哨兵 `compacted` + epoch
     判定（只算 compaction 边界之后的信号，避免压缩后旧历史误晋升）。
8. **晋升语义澄清**："晋升不是 system 设置后就有，是观察驱动的"——dsh 首次
   持久晋升信号（tool/call 或 assistant/message 先到为准）落库后才开放完整
   目录；请求 #1 恒 bootstrap、请求 #2 起完整目录。我们同构：`tool.execute.before`
   - `message.updated` 事件 → promote → 下一请求生效（工具集在请求开始时
     resolve，`request.ts:208`）。allow/deny 均为 `findLast` 后写覆盖
     （`permission/index.ts:204-213`），promote 追加 deny 在末位必命中。

产出：`docs/design.md`（系统设计文档：目标/行为/探针/状态机/日志/alias 工具/
使用/验证/限制/实现顺序）+ `docs/decisions.md` D5 修订/D11 + research.md
（§4.5 D11、§5.1/§5.4 D5 修订、§6 扰动项）。

## 本轮讨论留档（round-6，2026-08-16）

核对"还有什么需要澄清/研究的问题"，重新阅读四份文档后核实/定案：

1. **compaction 机制核实（研究项消化）**：
   - **无 `session.compacted` 事件**——回退触发点改走
     `experimental.session.compacting` 插件 hook（`session/compaction.ts:373-377`，
     input 含 `sessionID`，压缩时触发）；
   - **边界标记** = user 消息 parts 里的 `CompactionPart`（`type:"compaction"`，
     schema `packages/schema/src/v1/session.ts:195-202`，含 `tail_start_id`）；
     `Info.compacted` 时间戳（`v1/session.ts:286`）可作辅助；prune 的
     `part.state.time.compacted`（`compaction.ts:311`）只清 tool 输出、**不是**
     压缩边界；
   - 压缩时另建 `mode:"compaction"` 的 assistant 摘要消息（`compaction.ts:358-419`）。
2. **默认 agent permission 已核实**：build defaults 含 `*: allow`（`agent.ts:119-136`，
   D2 已记录），非开放项。
3. **compacted 阶段晋升后重新注入（用户拍板："需要重新注入"）**：注入内容随压缩
   消失 → 新晋升信号时 promote 同时重注入捕获 system（幂等标记被压缩 → 重注
   自然允许；注入判定统一为"历史无幂等标记即注入"；对齐 dsh 每轮注入语义）。
4. **留给实现时对照**：`compaction.ts:480-608` 落库细节（旧消息删除/replay）影响
   epoch 扫描遍历；`str_replace_editor` 原版 execute 行为（fuzzy match、错误
   格式、view 输出细节，`reference/deepseek-harness/.../index.ts` 全文）。

产出：design.md §5/§6/状态机表、decisions.md D5 round-6 修订、research.md
§5.1/§5.4/参考索引、handoff.md D5 摘要/实现顺序第 8 步/已知限制。

## 本轮讨论留档（round-7，2026-08-16）：状态机 v3 定案

用户对照 dsh README 后重构状态机（**术语：不用"锚定/晋升"，promote 也不要**）：

1. **判别来自 README 的模型输出特征**：README 实测标准 = **首行 `We…` 风格 +
   `let me`=0**（"该 schema 5/5 锚定（首行 `We need…`，`let me` 为 0）"；
   zero-anchored 段："锚定请求稳定为 'we' 风格且 let me 为 0"）——判别依据。
2. **状态拆分**：用户"注入失败>注入成功>锚定成功（别叫这个，选个好听的名字，
   晋升也不要）"。最终（用户拍板"可以的"）：`pristine`（无哨兵）→ `seeded`
   （注入成功）→ `unsealed`（已解锁，seeded 内部变体防重复解锁）→ `verified`
   （判别通过）；旁路仍按 key 级判定。
3. **seeded 工具已解锁（用户纠正）**："seeded状态工具已经都解锁了才对啊？
   我们没有两步注入吧"——单轮注入（无 dsh whoami 两步），解锁由信号自动发生
   （请求 #1 受限 → #2 全量），**与判别解耦**；`str_replace_editor: deny` 在
   解锁时追加（不是 verified 时才隐藏）。
4. **判别规则（用户明确）**：**N=3 常量**；seeded/unsealed 阶段每轮扫描边界后
   assistant 消息（最早起）：**任一**符合特征 → 哨兵 `verified` 并**立即停止**
   （第一轮符合则第二轮不再判，以此类推）；窗口内 N 条全部不符合 → 停止判别
   （`verify.giveup` warn，进程内 Map 去重每进程一次），**保留当前状态**
   （不加失败标记）。
5. **解锁/判别收敛到 chat.message ensure（复用注入位置）**：信号（assistant
   消息/工具调用）持久化在历史里，每轮扫历史即可——**`tool.execute.before` /
   `message.updated` 信号 hook 整个移除**（天然幂等、覆盖 resume 与失败重试，
   与 dsh"从持久 event 推导"一致）。
6. **compaction 回退**（round-6/7 汇总）：`experimental.session.compacting` hook →
   追加 `deny *` + minimal 对 + compactionTools + 哨兵 `seeded`（取代旧
   `compacted` 哨兵；epoch 边界仍 = 最后一条 `CompactionPart` 之后）→ 注入判定
   "历史无幂等标记即注入"自动重注入 → 判别窗口重置（重新判别）。
7. **判别标准（round-8 定案）**：用户"检测只检查首行吗？assistant 的 think
   满足条件就行吧？"——dsh 实测 `we`/`let me` 计数远超可见回复数（r1: we=179、
   可见回复 1），特征主要在**思维链**。且"首行太严格"；`reasoning` part =
   `type:"reasoning"`（`v1/session.ts:118-128`）。最终标准 = **首个轨迹标记**：
   `reasoning`+`text` 拼接全文 `idx(we系) < idx(let系)` 即通过（let 系不出现
   =+∞；对 r1 的 let me=1 鲁棒）；备选的"we 比 let 多"并入该标准（we 先出现
   通常也更多）。中文词表实验性（`我们` vs `让我`/`我来`/`我先`，中文主语常
   省略 → 标记不稳定 → giveup 不锁死）。

产出：design.md §1/§2/§3/§5/§6.1/§7.3/§8.2/§8.2.1/§8.2.2/§9/§10/§11、
decisions.md 术语表 + D5 round-7 修订 + D12、research.md §5.1/§5.2/§5.3/
§5.4/§6/§7、handoff.md 摘要/实现顺序/已知限制。

下一会话从"实现顺序建议"第 1 步（日志模块）开始写 `src/index.ts`。

## 本轮讨论留档（round-9，2026-08-16）：zero-anchored 定案与真机实测

1. **splice 修复（根因）**：`experimental.chat.system.transform` 里
   `output.system = [...]` 重赋值**不生效**——`plugin.trigger` 只是
   `fn(input, output)` 后返回 output（`plugin/index.ts:282-296`），request.ts
   （`request.ts:69-78`）忽略返回值、用**局部 system 数组引用**——必须
   `splice` 原地改。修复前模型一直看到原生 opencode persona（自称 "I'm
   opencode, an interactive CLI tool powered by deepseek-v4-pro" 逐字照抄
   default.txt + system.ts:74）。官方 API 对照实验（curl + minimal system）
   确认 v4-pro reasoning 为 we 风格。
2. **实测矩阵（deepseek 官方 v4-pro + variant max）**：0 工具 + minimal →
   we ✅；双工具（bash 描述对齐 dsh 后仍）→ standard-like ❌；首轮注入
   任何内容 → 破坏 we。**0 工具是唯一实证 we 形态** → D13 zero-anchored。
3. **persona 过滤粒度**：stripPersona = 只删身份声明句（`You are opencode,
an interactive CLI tool that helps users with software engineering
tasks.` 到句号，default.txt 第一行有两句——第二句 "Use the instructions
   below..." 保留），行为要求/模型名/env/AGENTS/技能/MCP 均保留。
4. **TUI 关键发现**：`synthetic: true` text part 被 TUI 过滤不显示
   （`tui/src/routes/session/index.tsx:395,636,841`）、模型可见
   （`message-v2.ts:198-201` 只滤 ignored/空文本）→ 锚定消息/注入块用
   synthetic 天然隐藏，无需折叠。
5. **时序定案（design.md §4.5）**：真实消息推迟 = pending 存盘（sessionID →
   parts）+ chat.message 首轮替换 parts 为锚定消息 + `event`
   （message.updated，info.role==="assistant"）自动 `session.prompt` 轮 2
   （user system 去 persona synthetic + 真实消息，不带 tools）→ 轮 2 消息
   触发 ensure → unlock。竞态：bypass 不替换/不存 pending；prompt 防重
   （发前清 pending）；重启悬挂 → ensure 补发。**round-9 定案时未实现；
   round-10 已实现（触发点修订为 session.idle）并真机验证**。

## 待办（新上下文）

1. 实现 D13 时序 —— **已完成（round-10）**，真机全链路验证通过（见下）
2. 默认配置 zero 形态 —— **已完成**（whitelist `[]` + anchorText 默认 + 注入默认去 persona）
3. docs 收尾 —— **已完成**（testing TC-3 回填、plan 进度、P4 结论、live-testing §5.1）
4. 真机验证 D13 全链路 —— **已完成（2026-08-16，`opencode serve` + HTTP API）**：
   锚定轮 we（v4-pro + flash-free）→ 自动轮 2（真实任务 + user system）→ 解锁 →
   工具干活（bash/glob/read）→ `verify.passed`（哨兵 verified 落库）
5. 移除 ZH_TERMS —— **已完成**（verify.ts/design/testing/decisions）
6. npm 发布 —— **已完成**（`@dreadice/opencode-dsv4-anchored@0.1.0`，
   官方 registry + 2FA token；publishConfig 强制官方 registry）
7. 安装方式定稿 —— **已完成**（opencode 官方仅本地文件/npm 两种；git 引用
   不在官方支持范围，README/design §8.1/live-testing 已同步；
   README 补「与其他插件共存」交互点说明）

**真机发现并修复（round-10，详见 live-testing.md §5.1）**：插件导出必须全为函数
（ZERO_ANCHOR_TEXT 具名导出导致加载失败）；`session.permission` wire 可缺省
（serve 新会话）→ `?? []`；wire Agent 用 `name` 标识（非 id）→ agent ruleset
匹配修复；`chat.message` 的 `input.model` 可用 `output.message.model` 兜底。

## 本轮讨论留档（round-10，2026-08-16）：D13 实现前源码核实与修订

实现 D13 前按文档重读源码，发现并定案：

1. **`message.updated` 触发轮 2 不安全（busy 窗口）**：`message.updated` 在
   run 仍在 Running 时发布（processor.ts:456/596 → session.ts:633）；此时
   `session.prompt` 的 `ensureRunning` 在 busy 下**丢弃新 runLoop**——
   runner.ts:120-122 `return [awaitDone(st.run.done), st]`（等当前 run 完成后
   返回其结果，不排队不报错）→ 轮 2 消息入库但永不执行（静默丢失）。
   **改为 `session.idle` 触发**（runner.ts:70-81 → run-state.ts:60-63 →
   status.ts:43 publish Event.Idle，run 完全结束后发布，无竞态）。
2. **`session.prompt` 省略 agent/model 用默认 agent**（createUserMessage
   prompt.ts:637-641 `input.agent ?? agents.defaultInfo()`）→ 轮 2 必须显式传
   会话 agent+model。
3. **pending parts 重发安全**：chat.message 触发时 parts 已 resolve
   （prompt.ts:1005-1014），resolvePart 二次处理 data:/file: URL 幂等
   （prompt.ts:700+），messageID/sessionID 被 assign 覆盖、part id 保留——
   首轮替换后原 part 从未落库 → id 复用无冲突。
4. **锚定消息不加 ANCHOR_MARKER**：round-9"首轮注入任何内容破坏 we"→ 锚定
   part = 纯 dsh 原文；锚定状态判定 = pending 存在性 + 边界后 assistant 消息
   推导（不再扫标记）。
5. **ensure 补发方案 A**：pending 存在 + 锚定回复已落库 → 补发轮 2（pending
   旧消息 + user system），**当前消息正常放行**——不推迟、不 placeholder
   （避免当前消息变空消息 + 空 user run 的坏局面；补发内容作为历史上下文
   可见，当前消息自身 run 正常处理）。
6. **重锚定**：pending 存在 + 回复未落库（锚定中断/重试）→ 当前 parts 追加
   pending、替换为锚定消息。
7. **默认配置 zero 形态定案**：`whitelist: []`、`anchorText` 默认 dsh 原文、
   注入默认 stripPersona；ZH_TERMS 移除（锚定回复恒英文）。

产出：research.md §4.12、decisions.md D13 修订 + 机制表、design.md §2/§4.5/
§5/§6/§7.3/§8.2/§9、handoff.md 本节、plan.md P3/P4、testing.md TC-2-25~32 +
TC-3-11。
