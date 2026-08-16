# DSV4 Anchored Standard —— 移植研究报告

> 在 opencode 中复现 dsh-anchored-standard 方法的调研结论、源码依据与移植方案。
> 参考仓库（均已 clone 到 `reference/`，见 `.gitignore`）：
>
> - `reference/dsh-anchored-standard`：xiaobright 的 preset 项目（本方案来源）
> - `reference/deepseek-harness`：DeepSeek Harness 官方仓库（Minimal/Standard preset 定义）
> - `reference/opencode`：opencode 官方仓库 v1.18.18（插件机制源码）

---

## 1. 问题背景：DeepSeek V4 Pro 的过拟合

DeepSeek V4 Pro 会**强烈依赖 API 请求中可见的工具目录来选择执行轨迹**。实测数据
（dsh README，Project2 V4.1b、`reasoningEffort=max`）：

| 配置                       | Project2 得分 | 行为特征                                                           |
| -------------------------- | ------------- | ------------------------------------------------------------------ |
| Standard（全工具目录）     | 91 / 92       | standard-like 轨迹（首行 `The user wants…/Let me`，`let me` 高频） |
| PTC                        | 92            | standard-like                                                      |
| 官方 **Minimal**（双工具） | **99 / 96**   | minimal 轨迹（首行 `We need…`，`let me` 为 0）                     |

问题：全程停在 Minimal 会丢失 Standard 的大部分工具能力，但全程 Standard 又会让
V4 陷入过拟合的轨迹。**工具目录是首轮锚定的决定变量**（issue #11 实测：256000
maxTokens 下 Minimal 工具 schema 5/5 锚定，而所有 standard 系 schema 11/11 落入
standard-like）。

## 2. dsh-anchored-standard 方案

把"首次轨迹选择"和"后续完整工具能力"拆开：

1. **保持 Minimal 的完整 system prompt**（persona `You are a helpful software engineer
assistant.`，`complete: true`，`includeRuntimeContext: false`）；
2. **首次模型请求暴露 Minimal 的真实工具 schema**——持久 `bash` + `str_replace_editor`
   两工具，与官方 Minimal 逐字节一致；
3. **首次请求剥离自动注入上下文**——AGENTS.md/CLAUDE.md 摘要（`agent-instructions`）
   和技能目录提醒（`skill-catalog`），真正的 Minimal 不挂载这两个插件；
4. **首个持久晋升信号后开放全量能力**——信号为首次 `tool/call` 或首个
   `assistant/message`，先到者为准（`promoteOn: either`）；
5. **阶段从持久 session 事件推导**，resume / reload 不丢状态。

### 2.1 preset 关键配置（`preset/agent.cordis.yml`）

```yaml
- id: tool-bootstrap
  name: ./tool-bootstrap.mjs
  config:
    bootstrapTools: [bash, str_replace_editor]
    promoteOn: either
    suppressedContextSources: [agent-instructions, skill-catalog]
    compactionTools:
      [read, write, edit, glob, grep, todo_write, ask_user_question]
```

**两个源码里才有的关键修正**（README 主文没写全）：

- **晋升后不是 25 工具全量 dump**（local addition）：保持
  `bootstrap 对 + 3 个发现工具（dev_tool_search / skill_search / skill_load）`，重型
  工具靠 `dev_tool_search` 按需解锁。注释明确说明原因："25-tool dump 会把轨迹拉回
  standard-like 行为"。
- **compaction 后回退**到受控阶段（bootstrap 对 + `compactionTools`），直到越过
  compaction 边界出现新的晋升信号（epoch-aware）。

### 2.2 实测结论（移植的对照基线）

- `We` 风格首答（r1/r2 各 1 条可见回复，`let me` 0/1），两轮只出现两份工具目录快照
  （首轮 2 工具 → 随后完整目录）。
- **工具 schema 身份在 256000 maxTokens 下是首轮锚定的决定变量，无需输出封顶**
  （`bootstrapMaxTokens` 仅为 standard 系 schema 的 opt-in）。

## 3. 官方 DeepSeek Harness Minimal preset（源码）

`apps/cli/config/agent-presets/minimal/`（`reference/deepseek-harness`）：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true # 系统提示就这么一句，host 无法再追加任何 prompt 文本
    includeRuntimeContext: false # 不注入 runtime 上下文快照
```

- 工具仅两个：`persistent-bash`（PTY 持久 bash，300s 超时，固定 description）+
  `str-replace-editor`（裸本地 fs，非沙箱，`maxOutputChars: 16000`）。
- 无 instructions、无 skill-catalog、无 compaction。

与 Standard 对比：

|          | persona                                          | runtime context | 工具                              |
| -------- | ------------------------------------------------ | --------------- | --------------------------------- |
| Minimal  | 固定一句 + `complete`                            | 关闭            | 2 个（bash + str_replace_editor） |
| Standard | `You are a coding agent powered by {{model}}...` | 注入            | 全量（25 项）                     |

## 4. opencode 插件机制映射（源码依据）

以下全部基于 `reference/opencode`（v1.18.18）。

### 4.1 工具目录可见性 = permission ruleset

- 每次 LLM 请求构建工具目录时，`session/llm/request.ts:208` `resolveTools()` 用
  `Permission.merge(agent.permission, session.permission)` 过滤：规则
  `{permission, pattern: "*", action: "deny"}` 的工具会从请求中**隐藏**。
- 判定逻辑 `permission/index.ts:204` `disabled()`：对每个工具用
  `ruleset.findLast(...)` 找最后一条匹配规则，`pattern === "*" && action === "deny"`
  则隐藏。**`findLast` + 后写覆盖 → 追加规则即可动态改变可见性**。
- `evaluate()`（`permission/index.ts:28`）同样是 `findLast`，同一套规则同时决定工具
  执行的权限询问（ask/allow/deny）。

### 4.2 动态切换 = SDK `client.session.update`（merge 追加）

- 插件输入 `PluginInput` 自带 SDK client（`packages/plugin/src/index.ts:56`），有
  `client.session.get / update / messages`（`sdk/js/src/gen/sdk.gen.ts:431-620`）。
- HTTP `PATCH /session/{id}` 的 permission 是 **merge 追加**到 session 现有 ruleset
  （`server/.../handlers/session.ts:194-199`，`Permission.merge(current, payload)`）。
- session permission **持久化在 DB**（`session/session.ts:110,153`）→ 重启后规则仍在，
  天然满足"阶段从持久状态推导、resume/reload 不丢"。
- 内部 `session.setPermission` 是整体替换（`session.ts:780-784`），但 SDK 只暴露 merge
  版 `update`，因此**晋升只能追加，不能删除**（见 §6 tradeoff）。

### 4.3 晋升信号

- 工具被调用：`tool.execute.before` hook（`session/tools.ts:106-110` trigger）；
- 首个 assistant 消息：`event` hook 监听 `message.updated`（payload
  `{ sessionID, info }`，`schema/src/v1/session.ts:597`，`info.role === "assistant"`）。

### 4.4 时机保证

- `chat.message` hook 在消息入库、工具解析之前触发（`session/prompt.ts:999`），且
  `plugin.trigger` 会 **await hook promise**（`packages/opencode/src/plugin/index.ts:292`）
  → 在 hook 内 await `client.session.update` 可保证本次请求的目录已生效。
- 状态判定所需的会话信息：`client.session.get` / `client.session.messages`。

### 4.5 上下文抑制（D3 修订：system 常驻 minimal + user 消息注入）

- `experimental.chat.system.transform` hook（`session/llm/request.ts:69`）在 system 文本
  发送前可改写 `output.system: string[]`。
- **限制（原 best-effort 文本过滤方案）**：触发时 `agent.prompt + env + instructions +
mcp + skills + user.system` 已被 join 成**单条**字符串（`request.ts:58-66`），无法按
  来源分离，只能文本级过滤。可用稳定标记：AGENTS.md 段以 `Instructions from: ` 开头
  （`session/instruction.ts:166`），技能目录段以 `Skills provide specialized
instructions` 开头（`session/system.ts:111`）。
- **D3 修订（用户确认 2026-08-16）**：不再做文本过滤/恢复，改为 **system 常驻
  Minimal persona（`You are a helpful software engineer assistant.`）+ 原 system
  内容以 user 消息注入**。opencode 单次请求 messages 是数组、支持多条 user 消息，
  首轮即构造 `[minimal system] + [原 system 内容(user 消息)] + [用户真实消息]`。
  dsh 的 AGENTS.md/技能本就是 user 消息（`source.kind` 标记），此方案与之同构。
- **D11（round-5 备选）**：首轮注入把 AGENTS.md 全文 + 技能目录提醒（~9KB）
  也带进了首轮 user 消息——dsh 复现清单第 3 条要求首轮不含这两类
  （`suppressedContextSources`），issue #6 实测技能目录提醒在场时锚定 0/9、无
  目录 ~81%（dsh 里 skill-catalog 就是 user 消息形态）。**备选升级路径**：注入
  前按上面两个稳定标记切段过滤（`Instructions from:` / `Skills provide
specialized instructions`），首轮滤掉这两段、解锁后补注完整捕获。
  默认保持完整注入，实测判别不达标才启用（详见 `decisions.md` D11）。

### 4.6 subagent（task 工具子会话）机制（2026-08-16 深研）

**创建**：task 工具（`tool/task.ts:24`）→ `sessions.create({parentID, agent,
permission})`（`task.ts:156-172`）；`session.created` 对 subagent 同样触发，payload
`{sessionID, info}` 含 `info.parentID`（`session.ts:537`、`schema/src/v1/session.ts:543-568`）。

**默认上下文（与主会话无差异，无 parentID 分支）**：

- system = `agent.prompt`（若 agent 无 prompt 则用 `SystemPrompt.provider(model)`
  兜底）+ env + **AGENTS.md/CLAUDE.md/CONTEXT.md**（`instruction.ts:110-169`）+
  MCP 指令 + skills 清单（`system.ts:105-117`，仅清单非正文）——subagent 首轮
  一样背着全套 AGENTS.md/技能（`prompt.ts:1257-1269`、`request.ts:58-66`）。
- 父会话历史**不继承**（`prompt.ts:1262` 只读本会话消息）；`parentSessionID` 仅进
  HTTP header（`request.ts:199`）。唯一通道 = task 描述文本 + 引用的文件。
- **模型默认继承父会话**触发 task 那条消息的 model（`task.ts:181-184`）→
  deepseek v4 门控会命中 subagent。
- **权限**：创建时快照 = 父会话的 deny + external_directory 规则（父的 allow 不
  继承，`agent/subagent-permissions.ts:14-27`）+ 子代理自身 ruleset 缺 task/
  todowrite 权限时补 deny + `primary_tools` 一律 deny（`task.ts:143-155`）。
- **嵌套限制**：`subagent_depth` 默认 1（`task.ts:104-117`），按 parentID 链计深，
  与权限无关直接挡死——即使 permission 全 allow 也无法嵌套（除非用户调高配置）。

**插件识别 subagent 的可行路径**：

- `event`（`session.created`）：原生携带 parentID，但 `info.model` 此时为空；
- `client.session.get(sessionID)`：wire 上返回全量 `Session.Info`（含 `parentID`/
  `agent`/`permission`/`model`，`session.ts:224-244`），SDK 类型未声明需 `as any`；
  DB 兜底，重启不丢。推荐此路径替代内存映射。
- `chat.message` / `system.transform` input 只有 `sessionID`，无 parentID；
  `messages.transform` input 为 `{}`，**完全无法区分会话**。

**内置 agent 权限**（`agent/agent.ts:140-265`，默认 merge `defaults` + 各 agent
专属规则 + 用户配置）：build 无专属 deny；plan deny `edit *`/`task general`；
general deny `todowrite`；explore = `*: deny` + grep/glob/list/bash/webfetch/
websearch/read 白名单（只读性质）；compaction/title/summary = `*: deny`。自定义
agent 规则同样 merge（`agent.ts:267-294`）。**这些 deny 在
`merge(agent.permission, session.permission)`（`tools.ts:87`）中被 session 规则
(findLast) 覆盖**——插件晋升 `allow *` 会压掉 agent 自身权限设计。

### 4.7 与自定义 agent 机制结合（静态承载 persona 与初始目录）

- agent 由 `config` 的 `agent` 字段构建（`agent/agent.ts:267-294`），`prompt` 会替换
  默认 `SystemPrompt.provider()`（`request.ts:60`），`permission` 与 session 规则 merge
  后参与工具过滤（`request.ts:209`）。
- 插件 `config` hook 收到 live 合并配置（`packages/opencode/src/plugin/index.ts:243-251`
  对每个 plugin 调用 `hook.config(cfg)`），可 mutate `cfg.agent` / `cfg.permission`。
- **可行性待验证**：`config` hook 在插件加载时调用，Agent service 的 `InstanceState`
  惰性构建（`agent.ts:355-358`），若构建发生在 hook 之后则 mutate 生效——实现阶段需
  实测确认；不依赖此路径时，用户也可在 `opencode.json` 手动配置 agent，插件只做动态
  晋升。
- **取 agent prompt/permission 的正确途径**：`client.app.agents()`（`GET /agent`，
  `sdk.gen.ts:858` → `handlers/instance.ts:80-81`）返回**全部** agent（含内置），
  `Agent.Info` 含 `prompt?` 与 `permission`（`agent.ts:44,52`）。注意
  `client.config.get` **不含内置 agent**（只含用户配置合并结果），不要走这条路。

### 4.8 注入合成内容到本次请求的三条路径（2026-08-16 深研，改 D3 实现方式）

| 路径                                          | 触发点               | 特性                                                                                                                                                                                                                                                           | 结论                                                                                                       |
| --------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **A. `chat.message` 原地改 parts**（推荐）    | `prompt.ts:999-1009` | hook 触发时消息**尚未落库**（落库在 `prompt.ts:1046-1047`）；trigger 返回值被忽略，但 `output.parts === resolvedParts` 同引用，**原地 push/splice 生效**（整体替换不生效）；runLoop 在 `prompt.ts:1092` 从 DB **重读**全部消息 → push 的 part 必然进入本次请求 | 无重入、无并发、持久化、`lastUser` 不变。新 part 需带 `id`(prt 开头)/`messageID`/`sessionID`/`type:"text"` |
| **B. `experimental.chat.messages.transform`** | `prompt.ts:1255`     | **input 是 `{}`，无 sessionID/model**，无法区分会话/门控                                                                                                                                                                                                       | 不能用于会话级注入（注入必须按 session 判定）                                                              |
| **C. `client.session.prompt` 补发**           | 插件侧 API           | 新消息 id 严格单调（`id/id.ts:51-70`）→ **排在本消息之后**（顺序反了）；`noReply` 缺省会启动嵌套 runLoop（双循环）；合成消息也会再触发 chat.message（需防重入）；带 `tools` 会**整体替换** session.permission（`prompt.ts:1060-1067`）                         | 坑多，弃用                                                                                                 |

另确认：`chat.params` 只能改 temperature 等参数（`request.ts:114-132`），不能改内容；
不存在 `chat.params.transform` / `chat.message.transform`。`plugin.trigger` 对每个
hook await 但返回值一律丢弃（`plugin/index.ts:282-295`）。

**对 D3 的影响**：注入点从 `messages.transform` 改为 **A（chat.message 原地
push text part）**。注入内容 = **原 system 的全部内容**（agent.prompt + env +
AGENTS.md/CLAUDE.md/CONTEXT.md + MCP 说明 + 技能清单；用户确认"只是替换
system 而已，原内容全进 user"），取值方式 = **探针捕获（§4.9）**，不再自组装；
注入 part **prepend 到首条 user 消息的 parts 最前**（真实消息之前，对应
"system 在 user 前"的语义）。`toModelMessagesEffect` 会把同消息多个 text part
作为该 user 消息内容块发出（`message-v2.ts:195-241`），provider 侧连续 user
消息本就会合并。

**为什么不能"把 system 挪进 user 再拼个 system"（用户疑问 2026-08-16）**：
opencode 请求 = `{system: string（每次现场组装，不落库、不在 messages 里）,
messages: [...], tools}`。能碰内容的三个 hook 时序错开，没有一个同时具备
"看到组装后 system + 能改 messages"：

```
chat.message @999        ← 能改 user parts，但 system 未组装（看不到内容）
messages.transform @1255 ← 能改 messages，但 input {} 无 sessionID；system 仍
                           未组装（1257 才组装）
system 组装 @1257-1269
system.transform @69     ← 看到 system 全貌，但只能改 system，不能碰 messages
```

故"先捕获原 system、同请求注入"不可行；"下一请求再注入"= 被否决的补发路径
（首轮缺失）。**round-4 突破：探针捕获（§4.9）**——静默请求 + `system.transform`
hook 内 throw 零 token 拿到 100% 真实 system，取代插件自组装；round-5 起探针
失败也**不再自组装兜底**，改为按 key 旁路（D8）。

### 4.9 探针捕获真实 system（round-4 定案，源码事实）

**问题**：能否调用 opencode 的 system 组装方法、或 fork 模板会话继承 system？

- **无 system 渲染端点**：全部 HTTP 端点（`httpapi/groups/*.ts` 的
  `identifier`）里没有渲染 system/instructions 的端点；`config.get` 只有配置、
  `mcp.status` 只有状态。组装逻辑（`SystemPrompt.Service` + `instruction.ts` +
  Skill/MCP.Service）是进程内 Effect 服务，插件 API 不可达。
- **fork 已排除**：`session.fork`（`session.ts:693-734`）只复制 messages+parts
  （克隆消息历史），**不复制 system/permission/agent**；system 从不落库 → 模板
  会话里根本没有 system 可继承；TUI 会话也无法被插件重定向成 fork（无
  session.create 拦截 hook）。
- **abort 已弃用**：`client.session.abort` → `SessionPrompt.cancel`
  （`prompt.ts:152`）→ `SessionRunState.cancel`（`run-state.ts:77-86`）→
  `Fiber.interrupt(runLoop)`（`runner.ts:171-178`）链路真实，但**有竞态**
  （provider 调用可能已发出才中断）。

**定案：hook 内 throw，确定性零 token**：

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

**探针 runLoop 无阻塞、副作用可避免**：

- `prompt.ts:1149-1258` 在 system 组装前无 permission.ask/overflow 阻塞；
- 后台 `title` 生成（`prompt.ts:1133-1139`，小模型调用）：用**自定义会话标题**
  跳过——`session.create` body 带 `title`（`summary.ts:200` 非默认标题早退）；
- `summary.summarize`（`prompt.ts:1252-1253`）是本地快照 diff，无模型调用
  （`summary.ts:102-127`）；
- 探针消息自己会触发 `chat.message`/`event` → 按探针 sessionID 集合跳过。

**SDK 类型核实**（`@opencode-ai/sdk/dist/gen/`）：

- `SessionCreateData.body`：`{parentID?, title?}`；query `{directory?}`；
- `SessionPromptData.body`：`{messageID?, model?{providerID,modelID}, agent?,
noReply?, system?, tools?, parts[]}`——**探针可指定与真实会话相同的
  agent+model**；
- `SessionUpdateData.body` 仅 `{title?}`（permission 需 `as any`，wire 的
  UpdatePayload 支持）；`session.update` 的 permission 是 **merge 追加**
  （`handlers/session.ts:194-197`）→ append-only 语义成立；
- `client.session.prompt` **await 整个 runLoop**（`handlers/session.ts:295-309`）
  → 探针捕获可在同一次调用内完成；
- `client.app.agents()`（`sdk.gen.d.ts:263`）返回 `Agent[]`：含 `permission`
  （config 形）+ `prompt`；
- `client.session.delete` 存在（可清理探针会话）。

**round-8 补充核实**（`types.gen.d.ts` + `request.ts` + `id/id.ts`）：

- `Session` 类型含 **`directory`**（`:468`）与 **`parentID?`**（`:469`）——探针
  key 的 directory 直接用 `session.get().directory`（跨目录精确），parentID 判
  subagent 也无需 `as any`；需 `as any` 的只剩 `permission/agent/model`；
- `experimental.chat.system.transform` 实参**必带 sessionID**
  （`request.ts:69-73` `{sessionID, model}`，类型 `sessionID?` 仅声明保守）——
  探针识别可靠；
- part id 格式 `prt_<hex>`（`id/id.ts:51-70`，时间戳+计数器单调递增）——注入
  part 自造同格式即可；`TextPart` 含 **`synthetic?: boolean`**（`:148`）——
  注入 part 设 `synthetic: true` + 幂等标记文本双保险；
- `session.messages` 返回 `Array<{info: Message, parts: Part[]}>`（
  `SessionMessagesResponses:200`），`Part` 含 `ReasoningPart`（`type:
"reasoning"`）与 `TextPart`——判别提取二者 `text` 字段拼接。

**permission 语义核实**（`permission/index.ts:204-215` `disabled()`）：工具仅在
匹配到 `rule.pattern === "*" && rule.action === "deny"` 时隐藏（非 `*` pattern
的 deny 只影响 ask）；`edit/write/apply_patch`→`edit`，`read_mcp_*`/`list_mcp_*`
→`read`。bootstrap 的 `deny *` 才能隐藏非白名单工具。

**探针流程与缓存**（详见 `design.md` §4）：

```
chat.message(真实会话 S, M)   ← chat.message 被 await，时机有保证
  ├─ 缓存查询：key = (directory, agent, modelID, 日期)
  │    （system.ts:81 日期随天变 → 跨天重探；进程内 Map + 磁盘 JSON）
  ├─ miss → 同步探针（并发去重 Map）：
  │    session.create({query:{directory}, body:{title:"dsv4-probe-…"}})
  │    probeSessions.add(探针ID)
  │    await session.prompt({path:{id}, body:{parts:[text:"probe"],
  │      agent, model}})   ← agent+model 与真实会话一致，不带 tools
  │      探针 runLoop → 组装真实 system → system.transform
  │        (input.sessionID ∈ probeSessions) → 捕获 system 全文 → 写缓存
  │        → throw（禁词规避）→ halt → outcome "stop" → runLoop 终止
  │    prompt() 可能 reject → try/catch 吞掉（预期行为）
  │    session.delete(探针ID)；probeSessions.delete
  └─ 注入：output.parts.unshift(捕获 system 全量 + 幂等标记)
```

- **探针会话权限**：无 session permission → 捕获**未过滤的自然 system**（MCP
  说明全量）——正是"原 system 全部内容"的语义。
- **失败旁路（round-5）**：探针失败 → 该缓存 key 标 `failed` + TTL（默认 5 分钟）
  → TTL 内命中该 key 的会话**整个旁路**（不替换 system、不注入、不 bootstrap，
  行为 = 原生 opencode）；TTL 过后或跨天重探。**自组装 fallback 取消**。

### 4.10 日志机制（round-5 研究，`app.log` 源码事实）

- `client.app.log` = HTTP `POST /log` → Effect `logDebug/logInfo/logWarning/
logError`（`httpapi/handlers/control.ts:28-39`）；级别仅 **debug/info/warn/
  error，无 trace**（`httpapi/groups/control.ts:17-29`）。
- 输出：默认只写文件（`Global.Path.log/opencode.log`，`core/observability/
logging.ts:49-52,67-69`）；`OPENCODE_PRINT_LOGS=1` 才额外打 stderr；格式为
  结构化 `key=value` 扁平化（嵌套对象展开、长字符串 JSON 化）。
- 级别过滤在服务端：`minimumLogLevel()` 读 `OPENCODE_LOG_LEVEL`，默认
  **INFO**（`logging.ts:56-65`）→ debug 默认不落盘。
- **插件侧含义**：插件与 opencode 同进程，读 `process.env.OPENCODE_LOG_LEVEL
=== "DEBUG"` 一次缓存即可判断 debug 开关；debug 内容（完整 system/全文）必须
  短路后才序列化 + HTTP，避免每轮白做（日志设计见 `design.md` §7）。

### 4.11 工具注册与 alias 研究（round-5，D10 依据）

**opencode 无配置层工具 alias**：`tools` 配置只做权限映射（`config.ts:553-564`
把 write/edit/patch 统一转 `edit` 权限），不能改名/改 schema。

**插件层两条路径**：

| 路径                        | 机制                                                                                                                                                                                                         | 能力                                                                              | 结论                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------- |
| `Hooks.tool` 注册自定义工具 | `registry.ts:196-199` 循环 `p.tool` → `fromPlugin()`（`registry.ts:120-176`），id = 对象 key；zod args → jsonSchema 发给 LLM；execute 经 EffectBridge 桥接（含 ask/truncate/agent 查询），受 permission 过滤 | **名字/描述/参数完全可控**（逐字复刻）                                            | **可用（D10 采用）** |
| `tool.definition` 改写      | `registry.ts:305-333` 组装目录时每工具触发，可改 `description`/`parameters`                                                                                                                                  | **id 不可改**；全局生效（无 sessionID/模型门控）；参数改了 execute 不匹配会 break | 不可用于 alias       |

**dsh 原版 schema 来源**（`reference/deepseek-harness/packages/fs/
tool-str-replace-editor/src/index.ts`）：

- 描述 `DEFAULT_DESCRIPTION`（`:19-30`）："Custom editing tool for viewing,
  creating and editing files …"（含 view 语义、create 不能覆盖已存在文件、
  str_replace 唯一匹配要求、16000 截断提示）；
- 参数（`:425-458`）：`command`（enum view/create/str_replace/insert，必填）、
  `path`（必填，绝对路径）、`file_text`、`insert_line`、`new_str`、`old_str`、
  `view_range`（[start,end] 行号数组）；
- `maxOutputChars: 16000`（`:507`）。
- minimal 工具集合 = `['bash', 'str_replace_editor']`（e2e 断言
  `apps/cli/tests/web-agent-presets.e2e.ts:227,248`）——**工具名就叫 `bash`**，
  opencode 内置 bash id 同名，无需 alias。

**execute 自实现**（D10）：view = 读文件/目录（cat -n 行号格式、view_range、
16000 截断 + `<response clipped>` 标记）；create = 写文件（已存在报错）；
str_replace = 唯一匹配替换（多匹配/无匹配报错）；insert = 按行号插入。
降级点：无 LSP 冲突检测/格式化（`tool/edit.ts` 内置能力，seeded 期用不上）。

**解锁时隐藏**：解锁规则末尾追加 `{permission:"str_replace_editor",
pattern:"*", action:"deny"}`（findLast 命中）→ 目录恢复 opencode 自然状态；
插件工具仅 seeded 期使用（用户："只是system用一下，后边隐藏就行"）。

### 4.12 D13 轮 2 自动发送的源码事实（round-10 研究，实现依据）

**1. `message.updated` 不能触发轮 2 —— busy 窗口会静默丢弃 runLoop**：

- `message.updated` 在 run **仍在 Running** 时发布：processor 每条/每步落库
  `sessions.updateMessage(ctx.assistantMessage)`（`processor.ts:456,596`）→
  `Session.Event.MessageUpdated`（`session.ts:633`）；
- `session.prompt` 走 `SessionPrompt.prompt` → `loop` → `state.ensureRunning`
  （`prompt.ts:1052-1056,1344-1347`）；
- **`ensureRunning` 在 session busy 时丢弃新 work**（`effect/runner.ts:115-138`）：
  state = Running 时 `return [awaitDone(st.run.done), st]`——只等待当前 run
  完成并返回其结果，**不排队、不报错、不执行新 runLoop**。此时 prompt 的
  用户消息已入库（`createUserMessage` 在 loop 之前）→ 轮 2 消息落库但
  runLoop 永不执行（静默丢失）。
- 结论：轮 2 必须在 session **空闲**时发 → 触发点 = `session.idle`。

**2. `session.idle` 发布链路（run 完全结束后）**：

- `runner.ts:70-81` `finishRun`（run 结束/中断都触发）→ onIdle（run-state.ts:
  60-63 `data.runners.delete` + `status.set(idle)`）→ `status.ts:43`
  `if (status.type === "idle") publish(Event.Idle, {sessionID})`；
- SDK 类型：`EventSessionIdle = {type:"session.idle", properties:
  {sessionID}}`（`types.gen.d.ts:413-417`）；`EventMessageUpdated = {type:
  "message.updated", properties:{info: Message}}`（`:129-134`，Message 含
  role/sessionID/parts）；
- plugin `event` hook input = `{event: Event}`（plugin `index.d.ts:175-177`，
  触发是 fire-and-forget：`void hook["event"]?.(...)`，plugin/index.ts:257）→
  hook 内异步长任务安全。

**3. `session.prompt` 不带 agent/model 的推断**（`prompt.ts:637-641`
`createUserMessage`）：`agent = input.agent ?? agents.defaultInfo()`（**默认
agent，不是会话当前 agent**）；`model = input.model ?? ag.model ?? currentModel
(sessionID)`。→ 轮 2 必须显式传会话的 agent + model（否则可能切默认 agent，
runLoop 按 lastUser.agent 取 agent prompt，语义漂移）。

**4. prompt 的 parts 会经 `resolvePart` 二次处理**（`prompt.ts:700-970`，
chat.message 触发前已 resolve 完——`prompt.ts:1005-1014`）：

- file part：`data:` URL 原样保留（非 text/plain）；`file:` URL 重新读文件；
  MCP resource 展开为 synthetic 文本段；
- `messageID/sessionID` 由 `assign` 覆盖（`prompt.ts:693-697`），part id 保留
  ——首轮替换后原 part 从未落库 → 轮 2 重发 pending parts（含原 id）无冲突；
- `TextPartInput` 支持 `id?/synthetic?/ignored?`（`types.gen.d.ts:1231-1250`）
  → user system part 可直接带 `synthetic: true`；
- `SessionPromptData.body = {messageID?, model?{providerID,modelID}, agent?,
  noReply?, system?, tools?, parts[]}`（`types.gen.d.ts:2244+`）。

**5. chat.message 时机（消息在 hook 之后才落库）**：`createUserMessage` =
resolvePart → `plugin.trigger("chat.message")` → `updateMessage(info)` +
`updatePart`（`prompt.ts:1005-1047`）。→ ensure 内此时当前消息尚未入库：
首轮替换 parts（真实消息进 pending）安全；补发轮 2 时当前消息的 run 尚未
开始（ensureRunning 在 prompt() 返回前）。

**6. 锚定消息不加幂等标记**：round-9 实测"首轮注入任何内容（即使 stripPersona）
破坏 we 锚定"→ 锚定 part 文本 = dsh 原文（`ZERO_ANCHOR_TEXT`），不拼
`ANCHOR_MARKER`；锚定状态判定改由 **pending 存在性 + 边界后 assistant 消息**
推导（不再扫标记），幂等标记（`INJECT_MARKER`）只用于轮 2 的 user system part。

## 5. 移植方案设计
### 5.1 状态机（round-7 定案：seeded/unsealed/verified）

```
                chat.message（await 内 ensure）
  pristine ──注入+seeded──▶ seeded ──解锁信号──▶ unsealed ──判别通过──▶ verified
                              │   ▲                    │
                              └───┴──── compaction 回退（重注入+重判别）──┘
```

- 状态存于 session permission 本身（持久化），**阶段标记 = 插件自造的哨兵规则**
  `{permission: "__dsv4_stage__", pattern: <阶段>, action: "allow"}`——任意
  permission 名字段，Wildcard 不会与任何真实工具匹配（惰性，不影响工具过滤/
  执行），`findLast` 取阶段：
  - 无哨兵（pristine）→ 注入 + apply seeded（追加 `deny *` + 白名单 + 哨兵
    seeded）；
  - 哨兵 `seeded` → 注入成功。**解锁与判别解耦**：解锁信号（边界后 assistant
    消息/工具调用）→ 追加 agent ruleset + 哨兵 `unsealed`（防重复解锁）；
    判别（N=3 常量）进行中——**轨迹标记判别**：`reasoning` part（
    `v1/session.ts:118-128`）+ `text` part 拼接全文，`idx(we系) < idx(let系)`
    即通过（round-7/8 定案，词表可配置）；
  - 哨兵 `unsealed` → 已解锁（seeded 内部变体）；判别进行中；
  - 哨兵 `verified` → 判别通过（成功标记），跳过；
  - **epoch 边界**：解锁信号与判别窗口起点 = 历史最后一条 `CompactionPart`
    （`type:"compaction"`，schema `v1/session.ts:195-202`，挂在 user 消息、
    含 `tail_start_id`）之后，无则从头；prune 的 `part.state.time.compacted`
    只清 tool 输出，**不是**压缩边界——否则压缩后旧历史仍含 assistant 消息
    会立即误解锁/误判（epoch-aware）；
  - **compaction 回退**（round-6/7 修订）：无 `session.compacted` 事件；触发 =
    `experimental.session.compacting` hook（`session/compaction.ts:373-377`，
    插件触发、input 含 `sessionID`）；追加 `deny *` + minimal 对 +
    compactionTools + 哨兵 `seeded`（覆盖 verified/unsealed，append-only）；
    注入判定"历史无幂等标记即注入" → 自动重注入；判别窗口重置（重新判别）。

### 5.2 规则设计

seeded 规则（`client.session.update` merge，**D10 修订：严格 minimal 工具对**）：

```ts
[
  {permission: '__dsv4_stage__', pattern: 'seeded', action: 'allow'}, // 阶段哨兵
  {permission: '*', pattern: '*', action: 'deny'}, // 隐藏全部
  {permission: 'bash', pattern: '*', action: 'allow'}, // 白名单：bash（内置，id 同名）
  {permission: 'str_replace_editor', pattern: '*', action: 'allow'}, // 插件注册工具（§4.11，D10）
  {permission: 'external_directory', pattern: '*', action: 'allow'},
];
```

解锁（merge 追加，**D6/D7 round-3 修订：不用 allow \*；round-7 改名**）：

```ts
[
  ...agent.permission,
  ...sessionDenies,
  {permission: 'str_replace_editor', pattern: '*', action: 'deny'}, // D10：隐藏插件工具
  {permission: '__dsv4_stage__', pattern: 'unsealed', action: 'allow'},
];
// agent ruleset（client.app.agents() 取）在前；sessionDenies = session.permission 中
// action==="deny" 的规则（排除插件自己的 deny *）；哨兵换为 unsealed（防重复解锁）
```

要点：

- `findLast` 语义下，deny 规则在前、白名单 allow 在后 → 白名单可见且免询问；
  解锁追加的 agent ruleset 在最后 → 覆盖 seeded 全部规则，**恢复到 opencode
  自然权限状态**：build 的 defaults 是 `{"*":"allow", doom_loop:"ask",
question/plan_enter:"deny", external_directory:"ask"+白名单allow, read env
"ask"}`（`agent.ts:119-136`）→ build 会话解锁后等价全量开放；explore 的
  ruleset 是 `{"*":"deny", grep/glob/list/bash/webfetch/websearch/read:"allow"}`
  → 解锁后保持只读；自定义 agent 的 ask/deny/allow 全部保留。
- **派生 deny 重排**：subagent 创建时 session.permission 自带 task/todowrite/
  primary_tools deny（`task.ts:143-155`）与父会话 deny——把其中
  `action==="deny"` 的规则放在 agent ruleset **之后** → subagent 无法再开
  subagent（task 被 deny 且从可见目录隐藏，`permission/index.ts:204` `disabled()`）；
  `subagent_depth` 默认 1 为第二道防线（`task.ts:104-117`）。
- 残余：agent ruleset 未覆盖的工具仍被 seeded `deny *` 隐藏（自然状态为
  ask）；ruleset 为解锁时快照，之后改 agent 配置不自动跟随（resume 时可 re-sync）；
  规则只增不减（append-only），session 权限会被重复追加的增长。
- 工具名 → permission 名映射（`permission/index.ts:204`）：`edit/write/apply_patch`
  统一映射到 `edit`，`read_mcp_*` 映射到 `read`，其余用工具 id。
- `bash` 执行外部目录时另 ask `external_directory`（`tool/shell.ts:270-284`），
  seeded 期间需 allow 白名单内工具的 external_directory，否则被 `deny *` 阻断。
- 默认白名单 `["bash", "str_replace_editor"]`（**D10**）：严格复刻 dsh minimal
  工具对——`bash` 用 opencode 内置（id 同名），`str_replace_editor` 为插件注册
  自定义工具（§4.11），名称/描述/参数与 dsh 逐字一致；首轮模型可见工具 =
  `[bash, str_replace_editor]` 两个（`deny *` 已隐藏内置 edit/write/apply_patch，
  无需额外 deny）。

### 5.3 Hook 职责

| hook                                 | 职责                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config(cfg)`                        | （可选）注入/补全 agent 定义：Minimal persona + 初始 permission；记录用户配置                                                                                                                                                                                                                                                                                               |
| `chat.message`                       | 统一状态机入口（**round-7：解锁/判别收敛到此，无需信号 hook**）：await `session.get` 判定状态（含 `parentID` 判 subagent）→ pristine 则注入 + seeded；seeded/unsealed 则扫边界后信号 → 解锁（追加 agent ruleset + 哨兵 unsealed）、判特征（N=3，任一符合 → 哨兵 verified，全不符 → giveup）；注入判定"历史无幂等标记即注入"（含 compaction 重注入）；探针失败 → 按 key 旁路 |
| `experimental.chat.system.transform` | 门控命中时把 `output.system` 整体替换为**纯 Minimal persona**（所有 agent 无差别；原 system 全部内容已作为 user part prepend 注入首轮）；探针会话 → 捕获 + throw                                                                                                                                                                                                            |
| `experimental.session.compacting`    | 回退：追加 `deny *` + minimal 对 + compactionTools + 哨兵 seeded（重注入 + 重判别由 chat.message 自然完成）                                                                                                                                                                                                                                                                 |
| `event`（`session.created`）         | （可选，识别 subagent 的辅助路径；推荐直接 `session.get` 查 parentID）                                                                                                                                                                                                                                                                                                      |

> round-7：`tool.execute.before` / `message.updated` 不再承担信号职责——信号
> （assistant 消息/工具调用）本就持久化在历史里，chat.message 每轮扫描即可
> （与 dsh "从持久 session event 推导" 语义一致），天然幂等、天然覆盖 resume
> 与解锁失败重试。

**D6 修订（subagent 独立处理）**：不再"跳过有 parentID 的会话"。subagent 会话
与主会话同机制：首轮 minimal system + 受控工具 + 注入 AGENTS.md（作为 user
part），按自身信号解锁、按自身窗口判别（解锁重排追加 agent ruleset + session
既有 deny，见 §5.2）。父会话已 verified 不豁免子代理（D6 已确认）。

**D7（Decided, 2026-08-16）自定义 agent 兼容**：门控命中的自定义 agent 会话
与默认 agent **完全同构**——minimal system = 纯 Minimal persona，原 system 内容
（agent.prompt + AGENTS.md + 技能清单）以 user part 注入；解锁重排追加
agent ruleset（`client.app.agents()` 取）+ session deny；提供 include/exclude
配置（通配符，不写 = 全部）。

**D3 修订（user 消息注入，替代原"system 恢复"）**：首轮请求即构造
`[minimal system] + [原 system 全部内容作为 user part（prepend 到首条 user
消息）] + [用户真实消息]`，无需 dsh 的 next-turn 队列、也无需路径 A/B 补发。
注入内容在 `chat.message` 阶段（`prompt.ts:999`）取得：**探针捕获的真实 system
全量**（§4.9）；探针失败 → 该 key 旁路（D8）。

### 5.4 已定案 / 可选增强

- **compaction 回退（D5 修订已定案）**：监听 `experimental.session.compacting`
  hook（`compaction.ts:373-377`，无 `session.compacted` 事件），追加
  `deny *` + minimal 对 + compactionTools（read/glob/grep/edit/todowrite/
  question）+ 哨兵 `seeded`（§5.1，round-7 取代旧 `compacted` 哨兵）；epoch
  判定 = 最后一条 `CompactionPart` 之后（§5.1/decisions.md D5/D12）；回退后
  自动重注入 + 重新判别（round-6/7）。
  实现时确认 `compaction.ts:480-608` 落库细节（旧消息删除/replay）影响扫描遍历。
- **模型门控**：`chat.message` 的 `input.model` 可用于限定只对 deepseek-v4 系模型处理。
- **resume re-sync**：重启后 resume 的已解锁会话，如 session.permission 末尾与
  当前 `client.app.agents()` 的 ruleset 不一致，可重新追加对齐（ruleset 快照
  语义与 opencode 无热加载一致，此项为可选增强）。

## 6. 已知限制与待验证项（2026-08-16 收敛，round-7 术语）

**已排除的"伪限制"（用户确认）**：首轮 ask 覆盖/工具受限是**seeded 轮的自动
行为，无用户交互窗口**（首轮全自动跑完即解锁）；自定义工具与内置工具一样在
配置加载，build 的 `*: allow` 解锁后全覆盖；ruleset 快照与 opencode **无热加载**
的配置语义一致（改配置需重启）；env/MCP 说明等**全部随 user part 注入**，
信息不丢。

剩余项：

1. **判别效果需实测（唯一真正的待验证项）**：dsh 的 5/5 结论基于 Harness 的
   工具 schema；D10 已把 `str_replace_editor` 逐字复刻（名字/描述/参数），
   `bash` 为 opencode 原生（工具名与 dsh minimal 一致，description 不同），
   首轮集合 = `[bash, str_replace_editor]` 与 dsh minimal 对一致，仍需按 dsh verify
   清单复验（首轮 header tools 数量、首行风格、`let me` 计数），插件据此自动
   判别（N=3 窗口 → verified/giveup）。**附带扰动项（D11）**：首轮 user 消息
   在場 AGENTS.md/技能目录（dsh 首轮剥离），实测不达标时启用选择性剥离升级
   路径。
2. **判别标记的语言依赖**：`idx(we系) < idx(let系)` 是 dsh 英文语料特征
   （思维起步取向）；中文词表曾为实验项（`我们` vs `让我`/`我来`/`我先`）——
   round-9 起 zero 方案锚定回复恒英文（锚定消息固定英文），**中文词表已移除**
   （round-10，`ZH_TERMS` 删除；判别对象 = 锚定轮/真实任务的英文回复）。
3. **首轮 token 不省**：注入 = 原 system 全部内容 → 首轮上下文体积与原来相当
   （收益在 system 位置内容最小化，非省 token）。用户已接受。
4. **seeded 期白名单工具不触发 ask**（行为说明，非缺陷）：首轮内 bash/
   str_replace_editor 直接执行不询问；解锁后按 agent ruleset 恢复 ask。
5. **`client.session.get` SDK 类型缺口**：wire 返回含 `permission/agent/model/
parentID`，但 SDK 类型未声明，需 `as any`（技术债，无用户感知）。
6. **规则只增不减（append-only）**：seeded/解锁/compaction 回退均追加；
   无热加载前提下用户无感知；compaction 回退靠追加新 deny * + 新哨兵 seeded
   覆盖（取代旧 unsealed/verified）。
7. **探针冷启动**：每缓存 key 每天首个会话等一次探针（本地组装 + throw，几十
   ms 级，无模型调用）；探针失败期间该 key 旁路（原生行为），TTL 后自动恢复。
8. **giveup 去重为进程内**（Map）：重启后可能重复打一次 `verify.giveup` warn
   （无害）。

## 7. 实现建议顺序（round-7 更新）

1. 日志模块（两级 + debug 短路 + 事件清单，§4.10）——其余模块的观测基础
2. `str_replace_editor` 工具注册（D10：`Hooks.tool`，schema 逐字复刻 dsh，
   execute 自实现 view/create/str_replace/insert）
3. 核心状态机 + permission 规则（§5.1–5.3，seeded/解锁/判别哨兵）
4. 探针捕获（§4.9：create 带 title → prompt 同 agent+model → transform 捕获 +
   throw → delete；缓存 key/并发去重/磁盘持久化/failed TTL/旁路）
5. `chat.message` ensure（含 subagent 识别）+ 首轮注入（探针值 prepend + 幂等
   标记）+ 解锁判定（边界后信号）+ 特征判别（N=3 窗口）
6. system transform（探针捕获 + 真实会话替换 minimal）
7. compaction 回退（`experimental.session.compacting` → 回 seeded）、resume
   re-sync、自定义 agent include/exclude
8. 按 §6-1 的清单编写验证脚本

## 参考文件索引

- dsh preset：`reference/dsh-anchored-standard/preset/agent.cordis.yml`
- Harness Minimal：`reference/deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml`
- Harness Standard：`reference/deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml`
- opencode 插件 API：`reference/opencode/packages/plugin/src/index.ts`
- opencode 目录过滤：`reference/opencode/packages/opencode/src/session/llm/request.ts:208`
- opencode 规则求值：`reference/opencode/packages/opencode/src/permission/index.ts:28,204`
- opencode session update：`reference/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:194`
- opencode agent 构建：`reference/opencode/packages/opencode/src/agent/agent.ts:267`
- opencode task 工具/subagent：`reference/opencode/packages/opencode/src/tool/task.ts`、
  `src/agent/subagent-permissions.ts`
- opencode 内置 agent：`reference/opencode/packages/opencode/src/agent/agent.ts:130-265`
- opencode chat.message 注入（parts 原地改写）：`src/session/prompt.ts:999-1047`、
  `src/plugin/index.ts:282-295`、`src/id/id.ts:51-70`
- opencode agent API：`reference/opencode/packages/opencode/src/server/opencode/handlers/instance.ts:80`、
  `sdk/js/src/gen/sdk.gen.ts:858`
- 探针捕获（round-4）：system.transform 触发点 `src/session/llm/request.ts:69`、
  prepare 内 `src/session/llm/llm.ts:106,232`、halt/stop 链路
  `src/session/processor.ts:675-680`、runLoop 终止 `src/session/prompt.ts:1319`、
  重试禁词 `src/session/retry.ts:33-40`、标题早退 `src/session/summary.ts:200`
- 日志机制（round-5）：`src/server/routes/instance/httpapi/handlers/control.ts:28-39`、
  `src/server/routes/instance/httpapi/groups/control.ts:17-29`、
  `packages/core/src/observability/logging.ts:49-69`
- compaction（round-6）：触发点 `src/session/compaction.ts:373-377`
  （`experimental.session.compacting`）、`CompactionPart` schema
  `packages/schema/src/v1/session.ts:195-202`、`Info.compacted` 时间戳
  `v1/session.ts:286`、prune 标记 `compaction.ts:311`、落库细节 `compaction.ts:480-608`
- D13 轮 2（round-10）：runner busy 丢弃 runLoop `src/effect/runner.ts:115-138`
  （`ensureRunning`）、`message.updated` 发布时间 `src/session/processor.ts:456,596`
  + `src/session/session.ts:633`、`session.idle` 发布链路 `runner.ts:70-81` +
  `src/session/run-state.ts:60-63` + `src/session/status.ts:43`、
  `createUserMessage` agent/model 推断 `src/session/prompt.ts:637-641,693-697`、
  parts 重解析 `prompt.ts:700-970`、chat.message 时机 `prompt.ts:1005-1047`、
  `EventSessionIdle` sdk `types.gen.d.ts:413-417`、`TextPartInput`
  `types.gen.d.ts:1231-1250`、event hook fire-and-forget
  `src/plugin/index.ts:257`
