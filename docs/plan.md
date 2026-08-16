# 执行计划（opencode-dsv4-anchored）

## 0. 项目速览与工作方式（空白上下文先读这里）

**项目**：opencode 插件，把 dsh-anchored-standard 的"首轮轨迹约束 + 逐步解锁"
移植到 opencode，解决 DeepSeek V4 过拟合（模型见完整 system 就抢跑：首轮狂开
工具、多步并行）。

**一句话方案**：探针捕获真实 system → 锚定轮（`system=Minimal persona` + **0 工具**

- 锚定消息，真实消息推迟 pending）→ 锚定回复落库后 `session.idle` 自动发轮 2
  （user system + 真实消息）→ 解锁全量工具 → 判别模型输出特征（`idx(we系)<idx(let系)`，
  N=3）→ `verified`。状态持久化在 session permission 哨兵
  （`pristine→seeded→unsealed→verified`）。round-10 起默认 zero 形态
  （whitelist `[]`），假工具（str_replace_editor/假 bash）已移除。

**必读文档（按序，勿重复研究）**：

1. `docs/handoff.md` — **当前状态/决策摘要/讨论留档（先读拿进度）**
2. `docs/plan.md`（本文件）— 执行规格
3. 需要依据时：`docs/design.md`（设计）、`docs/decisions.md`（D1-D12）、
   `docs/research.md`（源码事实：文件:行号）、`docs/testing.md`（用例 TC-1~3）

**环境**：node v24（TS type stripping + `node --test`，**bun 未装**）；opencode
CLI 1.18.18（`opencode run` headless）；集成测试模型
`opencode/deepseek-v4-flash-free`（**不用 pro**；v4 pro API key 待用户提供）。
依赖 devDeps：`@opencode-ai/plugin`/`@opencode-ai/sdk` 1.18.18、typescript、
eslint、prettier。

**命令**：`npm run typecheck` / `npm run lint` / `npm run build` /
`npm run test`（=`node --test "test/*.test.ts"`）。

> **node --test 陷阱（已核实）**：目录参数 `node --test test/` 在 node 24
> **不可用**（当作模块路径报错）；无参数会递归误扫 `reference/` 下的测试——
> **必须用 glob** `node --test "test/*.test.ts"`。

**当前进度**（更新于每次推进后）：

- P0~P2：完成（82 测试全绿，L1 纯函数 + L2 fake client 集成）
- P3：完成（插件入口 + SDK 适配 + 死锁/messageID 修复 + build/lint/typecheck
  干净 + CLI 冒烟通过）
- P4：主体完成（TC-3-1~6、TC-3-9 ✅；TC-3-7 compaction / TC-3-8 探针失败 /
  TC-3-10 中文 待验证）
- P5：进行中（docs 同步中）

## Definition of Done（整体完成标准）

- P1/P2 全部用例绿 + `npm run typecheck` 通过
- P3 build/lint/typecheck 全干净 + CLI 冒烟通过
- P4 用 flash-free 跑通 TC-3-1~3-10 并**如实记录**结果（flash-free 判别
  giveup 属预期，可接受）
- P5 文档同步（design/handoff/testing 回填实测结果）+ git 提交

---

## 阶段总览

```
P0 基础设施 ─▶ P1 L1 纯函数+TDD ─▶ P2 L2 fake client 集成 ─▶ P3 插件入口 ─▶ P4 L3 真机 ─▶ P5 收尾
```

依赖：P1 → P2 → P3 → P4（前一阶段产物被下一阶段消费）。
各阶段独立可执行，开工前按 §0 阅读顺序确认状态。

> **TDD 约定**：红 = 测试运行且**断言失败**，但 `npm run typecheck` 与
> `node --test` 的**编译/加载均须通过**（不允许编译错误）；绿 = 断言全过。
> 每阶段收尾：`npm run typecheck` + `node --test` 全绿 + `npm run lint` 干净。
> 术语（round-7/8）：`pristine → seeded → unsealed → verified`；判别 =
> `idx(we系) < idx(let系)`，N=3 常量。

---

## P0：基础设施

### 0.1 测试运行器确认

- bun 未装 → 用 node 内置：node 24 默认支持 TS type stripping + `node --test`。
- 验证：`node --test test/` 能发现 `*.test.ts` 并运行；import 相对路径须带
  `.ts` 扩展名（nodenext 风格）。
- 冒烟：临时写一个 `test/hello.test.ts` 跑通后删除。

### 0.2 package.json

- `scripts.test = "node --test test/"`（已加）。
- 不动 typecheck/build（tsc）。

### 0.3 eslint 基线

- 当前 `src/index.ts` 旧骨架 6 个 no-unused-vars（client/project/directory/
  worktree/$/provider）——P3 重写时消除，先不处理。

**验收**：`node --test test/` 能跑 .ts；`npm run typecheck` 通过。

---

## P1：L1 纯函数 + TDD

> 模块无运行时 SDK 依赖（纯逻辑），测试直接 `import ../src/*.ts`。
> 依据：design §5/§6/§8.2、research §5.1-5.2、decisions D4/D10/D12、testing §3。

### 1.1 `src/verify.ts` + `test/verify.test.ts`（TC-1-17~27）

状态：**完成**（verify.ts + verify.test.ts 已绿，13 用例，typecheck 过）。

实现细节（verify.ts 现有）：

- `verifyText(text, terms=DEFAULT_TERMS): boolean`
  - 输入 = assistant 消息 `reasoning` part text + `text` part text 拼接（判别方
    由调用方拼接传入）
  - `text.toLowerCase()` → 找 we 系/let 系**最早出现位置**：
    - 词含非 ASCII（中文）→ `indexOf`（无词边界）
    - ASCII 词 → 正则 `(?<![a-z])<escaped>(?![a-z'])`（排除前/后字母与撇号：
      `weave`/`we've` 不命中，`we`/`let's` 正常）
  - `weIdx===-1` → false；`letIdx===-1` → true；否则 `weIdx < letIdx`
- `DEFAULT_TERMS = { we:["we need","we"], let:["let me","let's"] }`
- `ZH_TERMS = { we:["我们"], let:["让我","我来","我先"] }`（实验）

测试（TC-1-17~27，含大小写/词边界/中文/混合拼接）：

- 17 通过（we 先）、18 不通过（let 先）、19 不通过（let 先于 we）、20 通过
  （we 先、let 在后容忍）、21 仅 let 不通过、22 仅 we 通过、23 无标记不通过、
  24 中文 we 通过、25 中文 let 不通过、26 大小写不敏感、27 词边界
  （we've/weaver/let them 不命中）、拼接语义（thinking we + text let → 通过）

### 1.2 `src/gate.ts` + `test/gate.test.ts`（TC-1-1~5）

- `matchesModel(model: string, patterns: string[]): boolean`
  - `model` 已是完整标识（如 `"deepseek/deepseek-v4-pro"` 或 `"deepseek-v4-flash-free"`）
  - 通配转正则：`*` → `.*`，转义其余；`patterns` 任一匹配即 true；空 → false
- `gateModel(model: {providerID, modelID}, patterns): boolean`
  - 对 `\`${providerID}/${modelID}\``和`modelID` 各跑一次 matchesModel，任一命中
  - 语义（D4）：**匹配所有 deepseek*v4***（pro/flash 均命中）
- 测试：TC-1-1 pro → true、1-2 flash 无前缀 → true、1-3 claude → false、
  1-4 v3 → false、1-5 空 patterns → false；补充 `deepseek/deepseek-v3` 不命中、
  `opencode/deepseek-v4-flash-free` 命中

### 1.3 `src/stage.ts` + `test/stage.test.ts`（TC-1-6~16）

- 常量：`STAGE_PERMISSION = "__dsv4_stage__"`、`COMPACTION_TOOLS =
["read","glob","grep","edit","todowrite","question"]`
- `type Rule = { permission: string; pattern: string; action: "allow"|"deny"|"ask" }`
- `getStage(ruleset: Rule[]): "pristine"|"seeded"|"unsealed"|"verified"`
  - `ruleset.findLast(r => r.permission === STAGE_PERMISSION)?.pattern ?? "pristine"`
- `seededRules(whitelist): Rule[]`：
  `[{STAGE,seeded,allow},{*,*,deny},...whitelist.map(permission allow),
 {external_directory,*,allow}]`（round-10 zero 形态默认 `[]`）
- `extractSessionDenies(ruleset): Rule[]`：filter `action==="deny"` 且**排除**
  `permission==="*" && pattern==="*"`（插件自身 deny *，防止 promote 时自我覆盖）
- `unlockRules(agentRuleset, sessionDenies): Rule[]`：
  `[...agentRuleset, ...sessionDenies, {STAGE,unsealed,allow}]`
  （round-10：假 str_replace_editor 已移除，无隐藏 deny）
- `compactionRules(whitelist): Rule[]`：`[{STAGE,seeded,allow},{*,*,deny},
 ...whitelist allow, ...COMPACTION_TOOLS allow, {external_directory,*,allow}]`
- 测试：TC-1-6 空→pristine、1-7~9 各哨兵、1-10 findLast 后写覆盖、
  1-11 无哨兵但有 deny * → pristine；1-12 seeded 规则内容断言（顺序/字段，
  zero 白名单空）；1-13 sessionDenies 排除 deny *；1-14 解锁规则顺序
  （agent→denies→哨兵）；1-15 explore 保留只读；1-16 compaction 规则含
  白名单 + compactionTools + 哨兵 seeded

### 1.4 `src/inject.ts` + `test/inject.test.ts`（TC-1-28~30）

- `INJECT_MARKER = "[dsv4-anchored:injected]"`
- `hasInjectionMarker(parts): boolean`：任一 `type==="text"` 的 part 的 `text`
  含 INJECT_MARKER
- `buildInjectionPart(system, sessionID, messageID): Part`：
  `{ id: newPartId(), sessionID, messageID, type:"text",
text: \`${INJECT_MARKER}\n${system}\`, synthetic: true }`
- `newPartId(): string`：`"prt_" + Date.now().toString(16) + 随机 hex`（参考
  `id/id.ts` 的 `prt_<hex>` 格式，保证唯一）
- 测试：1-28 含标记→true、1-29 无→false、1-30 part 字段断言（type/synthetic/
  id 前缀 prt_/text 含标记与 system）

### 1.5 `src/epoch.ts` + `test/epoch.test.ts`（TC-1-31~34）

- `lastCompactionBoundary(messages): number`
  - messages: `Array<{info, parts}>`；找**最后一条**含 `type==="compaction"`
    part 的消息索引；无 → `-1`（=从头）
  - **不算**：tool part 的 `state.time.compacted`（prune 标记，非压缩边界）
- 测试：1-31 无→-1、1-32 一条在中间→其索引、1-33 多条→最后一条、
  1-34 仅 prune 标记→-1

### 1.6 `src/cache.ts` + `test/cache.test.ts`（TC-1-35~37）

- `cacheKey(directory, agent, modelID, date): string`
  - 稳定拼接：`JSON.stringify([directory, agent, modelID, date])`（无需 hash，
    保证可读/稳定）
- 测试：1-35 稳定、1-36 日期变→不同、1-37 agent 变→不同

### 1.7 `src/probe.ts`（常量部分，TC-1-38）

- `PROBE_THROW_MESSAGE = "DSV4 probe: capture complete"`（避开 retry 禁词：
  429/500/502/fetch failed/timeout/terminated/network/connection/rate limit/
  resource exhausted）
- 测试：1-38 断言该字符串不含任一禁词

**验收**：`node --test` 全绿 + `npm run typecheck` 通过。

---

## P2：L2 fake client 集成

> 依据：design §4/§5/§7、research §4.8-4.11、decisions D5/D6/D8/D9、testing §4。

### 2.1 `test/fake-client.ts`

内存实现 SDK client 子集（类型宽松，`as any` 风格）：

- 状态：`sessions: Map<id, {directory,parentID,agent,model,permission: Rule[]}>`、
  `messages: Map<id, {info,parts}[]>`、`probes`、`agents`、`logs: any[]`
- `session.get(id)` → 含 permission/agent/model（模拟 wire 全量）
- `session.update(id, {permission})` → **merge 追加**（append-only，验证 findLast）
- `session.messages(id)` → 消息数组（样例含 reasoning/text/CompactionPart）
- `session.create({query:{directory},body:{title}})` → 记录探针，返回 id
- `session.prompt({path:{id},body})` → 记录调用；注入可配置 handler 模拟探针
  runLoop（默认：触发 transform 捕获 → 抛 PROBE_THROW_MESSAGE → reject）
- `session.delete(id)`、`app.agents()`（build/explore/custom）、
  `app.log(msg,{level,...})` → push logs、`config.get()`
- 样例：build ruleset（`*:allow`+doom_loop ask）、explore（`*:deny`+只读）、
  消息（reasoning "We need..." + text、let 系文本、CompactionPart）

### 2.2 `src/logger.ts`（TC-2-24）

- `makeLogger(log: (msg, opts) => void, opts): {info,warn,debug}`
- `debug` 短路：启动解析一次 `process.env.OPENCODE_LOG_LEVEL==="DEBUG"` 缓存；
  非 DEBUG 时 debug() 直接 return（不序列化不调用）
- info 只带摘要字段；debug 带全量
- 事件名（design §7.3）：chat.message / probe.start / probe.success / probe.fail
  / bypass / system.transform / unlock / verify.passed / verify.giveup /
  compaction.rollback；统一前缀 `dsv4-anchored`
- 测试：debug 关时 debug() 不调用 log（fake 计数）

### 2.3 `src/core.ts`（ensureState 全流程，TC-2-1~11 主逻辑）

`ensureState(ctx)` 编排：

```
ctx = { client, options, probe: {cache, inFlight}, logger, probeSessions }
1. gate = gateModel(input.model, options.models)   // 不命中 → {action:"none"}
2. key = cacheKey(session.directory, agent, modelID, date)
   probe 缓存 hit → sys = cached.system
   miss → runProbe(...)（2.4）；failed → {action:"bypass"}
3. session = client.session.get(sessionID)         // directory/parentID/permission
4. stage = getStage(session.permission)
5. 注入：hasInjectionMarker(历史 parts) === false → outputParts.unshift(
   buildInjectionPart(sys, sessionID, messageID))  // pristine 与 compaction 重注入
6. stage==="pristine" → 追加 seededRules → 哨兵 seeded；日志 chat.message
7. stage==="seeded" || "unsealed"：
   a. 解锁：边界后存在 assistant 消息/工具调用 && stage==="seeded" →
      unlockRules(agents 的 ruleset, extractSessionDenies) 追加；日志 unlock
   b. 判别：边界后 assistant 消息按序取，逐条 verifyText（reasoning+text 拼接）
      → 任一通过 → 追加 verified 哨兵；日志 verify.passed（停止）
      → 累计 N 条未通过 → 日志 verify.giveup（进程 Map 去重，一次）；保留
8. stage==="verified" → 仅日志
```

- 边界 = lastCompactionBoundary(messages)；解锁/判别只看边界后消息
- 全部 session.update 在 chat.message 的 await 内完成（本次请求生效）

### 2.4 `src/probe.ts`（探针执行，TC-2-2~4、11）

- `runProbe(client, key, {agent, model, directory})`：
  - create(`{query:{directory}, body:{title:"dsv4-probe-"+hash(key)}}`) → id
  - probeSessions.add(id)；`await client.session.prompt({path:{id},
body:{parts:[{type:"text",text:"probe"}], agent, model}})`（**无 tools**）
  - 探针 runLoop → system.transform（sessionID∈probeSessions）→ 捕获
    output.system.join("\n") 写缓存 → throw PROBE_THROW_MESSAGE → halt →
    outcome stop → prompt() reject → try/catch 吞掉（预期）
  - finally：`client.session.delete(id)`；probeSessions.delete(id)
- 缓存：`Map<key, {status:"ok", system, ts} | {status:"failed", error, ts}>` +
  磁盘 JSON（probe.cacheDir，跨天重探：日期在 key 内）
- failed TTL：options.probe.ttlMs（默认 300000）内命中 → bypass
- 并发去重：`inFlight: Map<key, Promise>`，同 key 并发只探一次
- 测试：2-2 成功（缓存写入 + 会话清理）、2-3 失败（failed + TTL 旁路）、
  2-4 并发去重（两次调用只 create 一次）

### 2.5 `src/system-transform.ts`（TC-2-17~19）

`systemTransform(input, output, ctx)`：

1. `input.sessionID ∈ probeSessions` → 捕获 `output.system.join("\n")` → 写探针
   缓存 → throw PROBE_THROW_MESSAGE（不触发 retry）
2. bypass（key failed）→ 原样放行
3. gate 命中 → `output.system = [MINIMAL_PERSONA]`（`"You are a helpful software
engineer assistant."`）；日志 system.transform（before/after 摘要）
4. 其余 → 放行

### 2.6 `src/compaction.ts`（TC-2-13~14）

`compacting(input, ctx)`：`experimental.session.compacting` 触发（input 含
sessionID）→ 该会话 gate 命中（或含插件哨兵）→ 追加 `compactionRules()` →
日志 compaction.rollback。重注入/重判别由 chat.message 的 ensureState 自然完成
（无幂等标记即注入；判别窗口重置）。

### 2.7 ~~`src/str-replace-editor.ts`~~（round-10 已移除）

D10 曾计划插件注册 `str_replace_editor`（schema 逐字复刻 dsh）+ 假 bash 描述
（`tool.definition`）。round-9 实测双工具复现不了 we 锚定（standard-like）、
0 工具才是唯一实证形态（D13）→ round-10 删除 `src/str-replace-editor.ts` /
`src/bash-description.ts` 及其测试（TC-2-20~23），插件不注册任何工具。
移除理由与实现见 design.md §8.2.2、decisions.md D10 修订。

### 2.8 场景矩阵测试（TC-2-1~24 + D13 补充）

用 fake client + 直接调用 core/probe/system-transform/compaction 函数：

- 2-1 pristine 首轮（注入 prepend + seeded 规则）、2-5 二次不重复注入、
  2-6 解锁（历史有 assistant）、2-7 解锁幂等、2-8 判别通过 verified、
  2-9 判别 giveup（3 条不符 + 进程去重）、2-10 verified 稳定、
  2-11 bypass、2-12 resume（重启模拟：读 ruleset 续跑）、2-13/2-14 compaction、
  2-15 subagent（parentID）、2-16 门控不命中、2-17~~19 system.transform、
  2-24 日志短路
- **round-10 D13 补充（TC-2-25~32，见 testing.md）**：锚定轮替换 parts +
  pending 推迟、bypass 不推迟、重锚定、session.idle 轮 2 自动发出（防重/
  失败恢复/无 user system 降级）、ensure 悬挂补发（当前消息正常放行）、
  sending 防并发、轮 2 后解锁

**验收**：TC-2-1~32 全绿；typecheck 通过。

---

## P3：插件入口 `src/index.ts`

> 依据：design §2/§3/§8、research §4.1-4.4、decisions D1/D4；类型签名见
> `node_modules/@opencode-ai/plugin/dist/index.d.ts`（chat.message /
> system.transform / session.compacting / tool / provider 均已核实存在）。

- 3.1 **保留 provider hook**：deepseek-v4-flash-free（Model v2 完整定义，旧骨架
  原样搬入），provider id 维持现状
- 3.2 组装 hooks：
  - `chat.message(input, output)` → `ensureState({...})`（await，保证本次生效）
  - `experimental.chat.system.transform(input, output)` → 探针捕获/替换/放行
  - `experimental.session.compacting(input)` → 回退
  - **`event(input)` → `session.idle` → `sendRound2`**（D13 轮 2 自动发送；
    触发点用 session.idle 而非 message.updated——busy 窗口会丢 runLoop，
    research §4.12；probeSessions 跳过）
  - `config(cfg)`（可选）→ 只读记录，不 mutate
- 3.3 插件 options（round-10 默认 zero 形态）：`models`（默认
  `["deepseek*v4*"]`）、`whitelist`（**默认 `[]`** 0 工具）、`anchorText`
  （**默认 dsh 原文**，设 `""` 关闭锚定轮）、`injectSystem`（默认启用）、
  `firstTurnFilter`（默认 `{stripPersona: true}`）、`verify.n`（默认 3）、
  `verify.terms`（默认英文词表；**ZH_TERMS 已移除**）、`probe.ttlMs`、
  `probe.cacheDir`、`log.level`
- 3.4 模块化引入：index 只做组装，逻辑全在 P1/P2 模块（可测）
- 3.5 质量门：`npm run build` + `npm run lint` + `npm run typecheck` 全干净
  （消除旧骨架 6 个 unused）
- 3.6 本地冒烟：插件装到 opencode（plugin 目录），`opencode run --model
opencode/deepseek-v4-flash-free "你好"` 正常应答、无插件报错

**验收**：dist 产出正确；lint/typecheck 0 error；CLI 冒烟通过。

---

## P4：L3 真机集成（opencode run + opencode/deepseek-v4-flash-free）

> 不用 pro（用户明确）。参考 dsh `verify/`（`verify-runner.mjs`）的方式：
> 一次性任务驱动，只测**首条 assistant 消息**（reasoning + text 块），
> `reasoningEffort=max`。free 小模型判别可能 giveup，如实记录。

- 4.1 前置：插件安装到 opencode；测试目录（临时项目，含 1-2 个文件 +
  可选 AGENTS.md 观察注入）；日志 `OPENCODE_LOG_LEVEL=DEBUG` + `--print-logs`
- 4.2 基准命令（英文 prompt + 思考级别 max，对应 dsh `--task "Understand
this project."` + `reasoningEffort=max`）：
  ```bash
  cd <testdir> && OPENCODE_LOG_LEVEL=DEBUG opencode run \
    --model opencode/deepseek-v4-flash-free --variant max --thinking --auto \
    --print-logs "Understand this project and summarize what it does."
  ```
- 4.3 TC-3-1 首轮：日志 stage=seeded、injectSource=anchor（锚定轮）、
  真实消息进 pending、parts=纯锚定消息、0 工具
- 4.4 TC-3-2 判别：锚定回复 `--thinking` 输出 reasoning 块 → 人工按 verifyText
  判据核对（`idx(we系) < idx(let系)`）；插件侧期望 verify.passed 或 giveup
  （flash-free 特征可能缺失 → giveup 也符合预期，记录 thinking 片段）
- 4.5 TC-3-3 解锁：第二轮日志 unlock；后续可见工具恢复 agent ruleset
- 4.6 TC-3-4 状态文件：`cat probe-cache.json` 含 `{key,status,ts}`
- 4.7 TC-3-5 真实任务：`--auto "Create a file in this project and read it."`
  → 首轮工具可用
- 4.8 TC-3-6 resume：`opencode run -s <sessionID> "Continue."` → 状态从
  ruleset 恢复
- 4.9 TC-3-7 compaction：长对话/大文件触发压缩 → compaction.rollback warn →
  回 seeded + 重注入 + 重判别
- 4.10 TC-3-8 探针失败旁路：模拟（如临时不可达/超时）→ bypass warn、原生
  行为（视环境可行性，可降级为文档说明）
- 4.11 TC-3-9 门控对照：`--model` 非 v4（如 `opencode/hy3-free`）→ 无插件处理
- 4.12 TC-3-10 中文判别：**已移除**（round-9/10：zero 方案锚定消息/回复恒英文，
  中文实验词表 ZH_TERMS 删除）

**round-9 真机结论（已回填 testing.md）**：官方端点 v4-pro + variant max 实测
——minimal + **0 工具** → thinking we 风格 ✅；minimal + 双工具 → standard-like
❌；首轮注入任何内容 → 破坏 we。→ **D13 zero-anchored**（0 工具锚定轮 + 真实
消息推迟）成为唯一实证形态；flash-free 判别 giveup（标准 like，不锁死）。

**验收**：日志链路 `probe → seeded(chat.message) → unlock → verify.*` 至少走到
判别；首轮工具=两个；每项结果（含 giveup）如实记录回 plan/testing。

---

## P5：收尾

- 5.1 同步 docs：design.md（实现状态）、handoff.md（进度/结果/留档）、
  testing.md（L3 实测结果回填 TC-3-x 表格）
- 5.2 `git add docs/ src/ test/ package.json tsconfig.json eslint.config.js`，
  提交（**reference/、node_modules/、dist/ 不提交**）；commit 消息按
  conventional commits（如 `feat: anchored bootstrap plugin core`）

---

## 风险与备注

- **判别模型差异**：flash-free 免费小模型思维链风格可能与 v4-pro 不同，
  giveup 属预期；pro 验证留待用户提供 key 后补跑（P4 不依赖 pro）
- **node --test TS**：node 24 strip types 需 import 带 `.ts` 扩展名；若遇坑
  退回安装 bun（`bun test`）
- **compaction 触发**：`experimental.session.compacting` 为压缩前置事件，
  flash-free 上下文小（128K）长会话更易触发
- **`session.update` merge 追加**：unlock 重复触发会重复追加 → 靠 unsealed
  哨兵幂等（getStage 已覆盖）
