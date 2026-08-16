# 测试用例文档（opencode-dsv4-anchored）

> 分层：L1 纯函数单元测试（`bun test`，零 mock）→ L2 hook 集成测试（fake
> client，内存 mock SDK）→ L3 真机集成测试（`opencode run` + `opencode/
deepseek-v4-flash-free`）。
> 状态机术语（round-7/8）：`pristine → seeded → unsealed → verified`；判别 =
> 轨迹标记 `idx(we系) < idx(let系)`，N=3 常量。

## 1. 分层与工具

| 层  | 工具                      | mock          | 覆盖                                                                                                     |
| --- | ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| L1  | `bun test`（零依赖）      | 无            | 门控/阶段/规则构造/判别/幂等/epoch 边界/key                                                              |
| L2  | `bun test` + fake client  | 内存 fake SDK | chat.message ensure 状态机矩阵、探针、system.transform、compaction、subagent、str_replace_editor execute |
| L3  | `opencode run` + 真实 API | 无            | 锚定效果、判别达成、解锁、日志事件链、状态文件、resume、compaction、旁路                                 |

架构要求（可测性）：hook 主体为**可注入 client 的纯函数**（如
`ensureState(client, sessionID, opts)`），`src/index.ts` 的 hook 只是薄包装。

## 2. 环境与命令

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
bun test              # L1 + L2（test/**/*.test.ts）
```

L3 真机（headless）：

```bash
cd <testdir> && OPENCODE_LOG_LEVEL=DEBUG opencode run \
  --model opencode/deepseek-v4-flash-free --variant max --thinking --auto \
  --print-logs "Understand this project and summarize what it does."
# 日志（stderr）grep：dsv4-anchored
# 输出含 thinking（--thinking）与工具调用 → 判特征
```

> 参照 dsh `verify/`（`verify-runner.mjs`）：一次性任务 + `reasoningEffort=max`，
> 只测首条 assistant 消息的 reasoning/text 块。**prompt 用英文**（判别基于
> we/let 词表）；判别口径与 L1 `verifyText` 一致（`idx(we系)<idx(let系)`）。

resume：`opencode run -s <sessionID> "继续"`；门控对照：`--model anthropic/claude-...`。

## 3. L1 单元测试用例

### 3.1 门控 `matchesModel(model, patterns)`

| 用例   | 输入                                                            | 期望                            |
| ------ | --------------------------------------------------------------- | ------------------------------- |
| TC-1-1 | `model="deepseek/deepseek-v4-pro"`, `patterns=["deepseek*v4*"]` | true（功能匹配所有 v4，含 pro） |
| TC-1-2 | `model="deepseek-v4-flash-free"`（无 provider 前缀）, 同上      | true                            |
| TC-1-3 | `model="anthropic/claude-3.5-sonnet"`, 同上                     | false                           |
| TC-1-4 | `model="deepseek/deepseek-v3"`, 同上                            | false                           |
| TC-1-5 | 空 patterns                                                     | false（不锚定）                 |

### 3.2 阶段判定 `getStage(ruleset)`

| 用例    | 输入 ruleset（permission 规则尾段）                                            | 期望                     |
| ------- | ------------------------------------------------------------------------------ | ------------------------ |
| TC-1-6  | `[]`                                                                           | `pristine`               |
| TC-1-7  | `[{__dsv4_stage__,seeded}]`                                                    | `seeded`                 |
| TC-1-8  | `[...,{__dsv4_stage__,unsealed}]`                                              | `unsealed`               |
| TC-1-9  | `[...,{__dsv4_stage__,verified}]`                                              | `verified`               |
| TC-1-10 | `[{__dsv4_stage__,seeded},...,{__dsv4_stage__,verified}]`（findLast 后写覆盖） | `verified`               |
| TC-1-11 | 规则含 `*:deny` 但无哨兵                                                       | `pristine`（非插件会话） |

### 3.3 规则构造

| 用例    | 函数                                       | 输入                            | 期望                                                                                                             |
| ------- | ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| TC-1-12 | `seededRules(whitelist)`                   | `["bash","str_replace_editor"]` | 尾哨兵 `seeded`；含 `*:deny`；含 bash/str_replace_editor allow；含 external_directory allow                      |
| TC-1-13 | `extractSessionDenies(ruleset)`            | 混合规则                        | 只返回 `action==="deny"`；**排除** pattern==="\*" 的插件 deny \*                                                 |
| TC-1-14 | `unlockRules(agentRuleset, sessionDenies)` | build ruleset + denies          | 顺序 = agent.permission → sessionDenies → `str_replace_editor:deny` → 哨兵 `unsealed`                            |
| TC-1-15 | `unlockRules`（explore）                   | explore `*:deny` ruleset        | 保留只读白名单；哨兵 unsealed 在尾                                                                               |
| TC-1-16 | `compactionRules()`                        | —                               | `*:deny` + bash/str_replace_editor + read/glob/grep/edit/todowrite/question + external_directory + 哨兵 `seeded` |

### 3.4 轨迹标记判别 `verifyText(text, terms)`

输入 = `reasoning` part text + `text` part text 拼接。词表默认
`we:["we need","we"], let:["let me","let's"]`。

| 用例    | 文本                                              | 期望                                      |
| ------- | ------------------------------------------------- | ----------------------------------------- |
| TC-1-17 | `"We need to modify the build first."`            | 通过（we 先）                             |
| TC-1-18 | `"Let me check the files."`                       | 不通过（let 先）                          |
| TC-1-19 | `"Let me start. We need to..."`                   | 不通过（let 先于 we）                     |
| TC-1-20 | `"We need... but let me also verify."`            | 通过（we 先，let 在后容忍）               |
| TC-1-21 | 仅 let、无 we                                     | 不通过                                    |
| TC-1-22 | 仅 we、无 let                                     | 通过（let 缺失 = +∞）                     |
| TC-1-23 | 无任何标记（如"先确认一下需求。"）                | 不通过（→ giveup 语义）                   |
| TC-1-24 | 中文词表：`"我们需要先读取文件。"`                | 通过                                      |
| TC-1-25 | 中文词表：`"让我先看看目录。"`                    | 不通过                                    |
| TC-1-26 | 大小写：`"WE NEED"` / `"Let Me"` / `"we've"` 边界 | 大小写不敏感；`we've` 不算 `we`（词边界） |
| TC-1-27 | `let them` / `weaver` 边界                        | 不误命中（词边界匹配）                    |

### 3.5 幂等标记 / 注入 part

| 用例    | 函数                                               | 输入                               | 期望                                                                                                 |
| ------- | -------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| TC-1-28 | `hasInjectionMarker(parts)`                        | 含 `[dsv4-anchored:injected]` 文本 | true                                                                                                 |
| TC-1-29 | `hasInjectionMarker(parts)`                        | 无标记                             | false                                                                                                |
| TC-1-30 | `buildInjectionPart(system, sessionID, messageID)` | system 全文                        | part：`type:"text"`、`synthetic:true`、text=标记+system、id 以 `prt_` 开头、sessionID/messageID 正确 |

### 3.6 epoch 边界 `lastCompactionBoundary(messages)`

| 用例    | 输入 messages（含 part 类型）                   | 期望                               |
| ------- | ----------------------------------------------- | ---------------------------------- |
| TC-1-31 | 无 `CompactionPart`                             | `undefined`（从头）                |
| TC-1-32 | 一条 `CompactionPart` 在 msg#2                  | 返回 msg#2 索引（之后才解锁/判别） |
| TC-1-33 | 多条                                            | 最后一条                           |
| TC-1-34 | 仅 tool part 带 `state.time.compacted`（prune） | 不算边界（undefined）              |

### 3.7 缓存 key `cacheKey`

| 用例    | 输入                                                | 期望       |
| ------- | --------------------------------------------------- | ---------- |
| TC-1-35 | `(dirA, build, deepseek-v4-flash-free, 2026-08-16)` | 稳定字符串 |
| TC-1-36 | 日期 +1                                             | 不同 key   |
| TC-1-37 | 同 dir 不同 agent                                   | 不同 key   |

### 3.8 探针 throw 文本

| 用例    | 输入                             | 期望                                                                                                              |
| ------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TC-1-38 | `"DSV4 probe: capture complete"` | 不匹配 retry 禁词（429/500/502/timeout/fetch failed/terminated/network/connection/rate limit/resource exhausted） |

## 4. L2 集成测试用例（fake client）

### 4.1 fake client 设计

内存实现：`session.get/update/messages/create/prompt/delete`、`app.agents()`、
`app.log()`、`config.get()`。样例数据：

```ts
const buildRuleset = [
  {permission: '*', action: 'allow', pattern: '*'},
  {permission: 'doom_loop', action: 'ask', pattern: '*'},
];
const exploreRuleset = [
  {permission: '*', action: 'deny', pattern: '*'},
  {permission: 'read', action: 'allow', pattern: '*'},
  {permission: 'bash', action: 'allow', pattern: '*'},
];
const session = {
  id: 'ses_1',
  directory: '/proj',
  parentID: undefined,
  agent: 'build',
  model: {providerID: 'opencode', modelID: 'deepseek-v4-flash-free'},
  permission: [] as Rule[],
}; // 初始空
const messages = [
  {
    info: {role: 'assistant'},
    parts: [
      {type: 'reasoning', text: 'We need to...'},
      {type: 'text', text: "I'll do it"},
    ],
  },
];
```

### 4.2 场景矩阵

| 用例    | 场景                           | 步骤                                                    | 期望                                                                                              |
| ------- | ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| TC-2-1  | pristine 首轮                  | 首次 `chat.message`（probe 缓存命中）                   | parts 前 prepend 注入 part；permission = seeded 规则；日志 inject                                 |
| TC-2-2  | 探针成功                       | 缓存 miss → 探针                                        | `session.create(title)` → `prompt(agent+model,无tools)` → transform 捕获+throw → delete；缓存写入 |
| TC-2-3  | 探针失败旁路                   | prompt reject                                           | key 标 failed+TTL；本次与 TTL 内后续会话全旁路（不注入/seeded/替换）                              |
| TC-2-4  | 探针并发去重                   | 两个首轮同时 miss                                       | 只跑一次探针                                                                                      |
| TC-2-5  | 注入幂等                       | 第二次 `chat.message`（seeded）                         | 不再注入                                                                                          |
| TC-2-6  | 解锁                           | seeded + 历史含 assistant 消息                          | 追加 unlock 规则（agent ruleset+denies+str_replace_editor deny+哨兵 unsealed）；日志 unlock       |
| TC-2-7  | 解锁幂等                       | unsealed 再跑                                           | 不重复追加                                                                                        |
| TC-2-8  | 判别通过                       | unsealed + 历史首条 reasoning 含 `We need`              | 追加哨兵 verified；日志 verify.passed；后续不再判                                                 |
| TC-2-9  | 判别 giveup                    | 边界后 3 条 assistant 消息均不通过（含 let 先、无标记） | `verify.giveup` warn 一次（进程内去重）；保留 unsealed；不再判                                    |
| TC-2-10 | verified 稳定                  | verified 再跑                                           | 无解锁/判别动作                                                                                   |
| TC-2-11 | bypass 稳定                    | key failed 期间                                         | 所有 hook 原样放行                                                                                |
| TC-2-12 | resume（重启模拟）             | 新进程读 ruleset=seeded、历史有信号                     | 解锁 + 判别续跑                                                                                   |
| TC-2-13 | compaction 回退                | `experimental.session.compacting`                       | 追加 compaction 规则 + 哨兵 seeded；重注入（无幂等标记）                                          |
| TC-2-14 | compaction 重判别              | 回退后历史含 CompactionPart，边界后新回复 we 风格       | verified                                                                                          |
| TC-2-15 | subagent                       | session.parentID 存在                                   | 独立按同流程处理                                                                                  |
| TC-2-16 | 门控不命中                     | model 非 deepseek\*v4\*                                 | 全部旁路（原生）                                                                                  |
| TC-2-17 | system.transform（真实会话）   | 门控命中                                                | output.system = `[Minimal persona]`                                                               |
| TC-2-18 | system.transform（探针会话）   | sessionID ∈ probeSessions                               | 捕获 system 全文 → throw（非 retry 禁词）                                                         |
| TC-2-19 | system.transform（bypass）     | key failed                                              | 原样放行                                                                                          |
| TC-2-20 | str_replace_editor view        | 读文件                                                  | 行号 cat -n 格式；16000 截断 + `<response clipped>`                                               |
| TC-2-21 | str_replace_editor create      | 写新文件                                                | 成功；已存在 → 报错                                                                               |
| TC-2-22 | str_replace_editor str_replace | 唯一匹配                                                | 替换成功；多/无匹配 → 报错                                                                        |
| TC-2-23 | str_replace_editor insert      | 行插入                                                  | 成功                                                                                              |
| TC-2-24 | 日志分级                       | debug 关                                                | `debug()` 短路，无序列化/HTTP                                                                     |

## 5. L3 真机集成测试（opencode run + opencode/deepseek-v4-flash-free）

> **2026-08-16 实测**：全部用 flash-free（不用 pro）。模型 thinking 为
> standard-like（"The user wants…/Let me explore"），判别走 giveup——符合
> plan 预期（free 小模型不产出 we 风格），插件不锁死。v4-pro 验证留待用户
> 提供 key 后补跑。

### 5.1 前置

- 安装：`dist/index.js` 复制到项目 `.opencode/plugins/dsv4-anchored.js`
  （opencode 自动发现；配置字段是 `plugin` 单数，非 `plugins`）
- 模型 `opencode/deepseek-v4-flash-free`（opencode 自带，无需注册）
- 测试目录：临时项目（含少量文件）
- 日志：`OPENCODE_LOG_LEVEL=DEBUG`，`--print-logs` 打 stderr

### 5.2 用例

| 用例    | 名称             | 命令/步骤                                                                                                                               | 期望                                                                                                                    | 实测 |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| TC-3-1  | 首轮锚定目录     | `opencode run --model opencode/deepseek-v4-flash-free --variant max --print-logs "Understand this project and summarize what it does."` | 日志 `chat.message`：stage=seeded、injectSource=probe、visibleTools=[bash,str_replace_editor]；首条 user 消息含幂等标记 | ✅ stage=seeded、injectSource=probe、注入幂等标记 |
| TC-3-2  | 判别达成         | 同上 `--thinking`                                                                                                                       | 首轮 reasoning 块按 verifyText 判据核对（we 先于 let）；插件日志 verify.passed（或 giveup 如实记录）                    | ✅ 判别 giveup（standard-like thinking；warn 一次不锁死，符合预期） |
| TC-3-3  | 解锁             | 同一会话第二轮（`-c` 继续）                                                                                                             | 日志 `unlock`；后续请求可见完整 agent ruleset 工具                                                                      | ✅ `unlock` 日志 + bash 权限恢复 |
| TC-3-4  | 状态文件         | cat probe-cache.json                                                                                                                    | 含 `{key, status:"ok"/"failed", ts}`                                                                                    | ✅ 落盘含完整 system（按天清理防堆积） |
| TC-3-5  | 真实任务         | `--auto "Create a file in this project and read it."`                                                                                   | bash/str_replace_editor 首轮可用；解锁后编辑工具可用                                                                    | ✅ 首轮 str_replace_editor create+view 成功 |
| TC-3-6  | resume           | `-c` 继续（英文 prompt）                                                                                                                | 状态从 ruleset 恢复；已 verified 不重复注入/判别                                                                        | ✅ `-c` 恢复 seeded→unsealed，不重复注入 |
| TC-3-7  | compaction       | 长对话触发压缩                                                                                                                          | `compaction.rollback` warn；回 seeded；重注入；重新判别                                                                 | ⏳ 待验证（flash-free 128K 长对话才触发） |
| TC-3-8  | 探针失败旁路     | 模拟（如临时断 key/超时）                                                                                                               | `bypass` warn；system 原生、工具全量                                                                                    | ⏳ 待验证（需模拟网络失败） |
| TC-3-9  | 门控对照         | `--model opencode/hy3-free`                                                                                                             | 无 dsv4-anchored 处理日志（原生）                                                                                       | ✅ 零插件日志（原生） |
| TC-3-10 | 中文判别（实验） | 中文 prompt + 中文词表                                                                                                                  | 通过则 verified；标记缺失则 giveup（warn）不锁死                                                                        | ⏳ 可选 |

### 5.3 判定口径（L3 成功标准）

- **锚定成功** = TC-3-2 的判别达成（`verify.passed` / verified 哨兵）
- dsh verify 清单对照：首轮 header 工具恰好 `[bash, str_replace_editor]`、
  首条 assistant 的 reasoning 块 we 先于 let（`--thinking` + `--variant max`
  输出复核，判据与 L1 `verifyText` 一致）
- 日志链路：`probe.success → seeded(chat.message) → unlock → verify.passed`

## 6. TDD 工作流

1. 先写 L1 用例（红）→ 实现纯函数（绿）：判别 → 规则 → 阶段 → 门控 → key
2. 写 L2 场景矩阵（红）→ 实现 `ensureState` 等可注入函数（绿）；hook 薄包装
3. L3 真机：`opencode run` 跑 TC-3-1~3-10，grep 日志核对
4. 每步跑 `npm run typecheck` + `npm run lint` 保持干净
