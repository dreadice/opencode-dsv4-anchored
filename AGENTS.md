# AGENTS.md

opencode 插件：把 dsh-anchored-standard 的「首轮轨迹约束 + 逐步解锁」移植到
opencode，解决 DeepSeek V4 过拟合（一见完整 system 就抢跑）。**实现与真机
验证均已完成（round-10，2026-08-16）**。

## 必读文档（docs/ 是唯一真相，先读再动手）

- `docs/design.md` — 系统设计（zero-anchored 时序 §4.5、状态机 §5、注入 §6、
  配置 §8）——**核心参考**
- `docs/research.md` — opencode 机制源码事实（文件:行号），含 §4.12 D13 轮 2
  触发（busy 丢 runLoop）
- `docs/decisions.md` — 决策记录 D1-D13（含 round-10 修订）
- `docs/testing.md` / `docs/live-testing.md` — 用例清单 / 真机验证手册
- `docs/handoff.md` — 跨会话状态与讨论留档
- `reference/` — 上游源码**只读参考，不提交**（opencode v1.18.18 /
  deepseek-harness / dsh-anchored-standard）

## 命令

```bash
npm run typecheck    # tsc --noEmit
npm run test         # tsx --test "test/*.test.ts"（89 用例）
npm run lint         # eslint
npm run build        # esbuild bundle → dist/index.js
                     # 注意：prebuild 会 prettier --write .（含 docs/，可能产生格式 commit）
```

## 目录结构

- `src/index.ts` — 插件入口：chat.message ensure / system.transform /
  compacting / event（session.idle → 轮 2）；**模块所有导出必须是函数**
- `src/core.ts` — ensureState 编排（门控 → 探针 → 锚定/注入 → 解锁 → 判别）
- `src/stage.ts` — 哨兵/规则（seededRules / unlockRules / compactionRules）
- `src/probe.ts` — 探针捕获真实 system（零 token：transform 捕获后 throw）
- `src/round2.ts` — sendRound2（轮 2 自动 prompt：user system + pending 真实消息）
- `src/pending.ts` — 推迟消息存盘（`pending.json`）+ sending 防重
- `src/system-transform.ts` — system 替换 minimal / 探针捕获
- `src/compaction.ts` / `src/epoch.ts` — 压缩回退 / 边界
- `src/inject.ts` / `src/verify.ts` / `src/gate.ts` / `src/logger.ts` —
  注入 part 与幂等标记 / 轨迹判别 / 模型门控 / 两级日志
- `test/` — node:test + fake client（`fake-client.ts` 模拟 SDK）

## 核心架构（速览）

- **D13 时序**（design §4.5）：首轮真实消息推迟（pending）→ 模型只见锚定消息
  - 0 工具（`whitelist: []`）→ 锚定回复（we 风格）→ `session.idle` →
    `sendRound2`（user system 去 persona + 真实消息，不带 tools，显式
    agent+model）→ 解锁（agent ruleset + 哨兵 unsealed）→ 判别
    （`idx(we系) < idx(let系)`，N=3 任一通过 → verified）
- **状态持久化**：session permission 哨兵（`__dsv4_stage__`：seeded/unsealed/
  verified）+ 探针缓存/probe-cache.json + pending.json——重启/resume/compaction
  可还原
- **探针**：按 (directory, agent, modelID, 日期) 缓存；失败按 key + TTL 旁路
  （不替换/不锚定/不注入 = 完全原生）

## 关键陷阱（真机验证发现，改代码时务必遵守）

1. **插件模块所有导出必须是函数**（`getLegacyPlugins` 遍历全部导出）——
   常量不要 `export`（如 `ZERO_ANCHOR_TEXT`）
2. **`system.transform` 必须 `splice` 原地改 `output.system`**（重赋值不生效，
   plugin.trigger 忽略返回值）
3. **wire 兼容**（serve 实测）：
   - `session.get().permission` 可能 undefined（新会话无该字段）→ 必须 `?? []`
   - `client.app.agents()` 的 Agent 用 **`name`** 标识（无 `id` 字段）
   - `chat.message` 的 `input.model` 可能 undefined（POST 不带 model）→ 用
     `output.message.model` 兜底
4. **`session.prompt` 带 `tools` 会整体替换 permission**（严禁携带）；轮 2 必须
   显式传 agent+model（省略用默认 agent）
5. **runner busy 会丢弃新 runLoop**（`ensureRunning` 只 await 不排队）——
   轮 2 触发必须用 `session.idle`（不是 `message.updated`），且 `opencode run`
   单次模式跑不完轮 2（CLI dispose 会 cancel runner）——真机验证用
   `opencode serve` + HTTP API（live-testing.md）
6. 锚定消息保持 dsh 原文纯净（**不加幂等标记**——实测首轮任何额外内容破坏
   we 锚定）；幂等标记只用于轮 2 的 user system part（`INJECT_MARKER`）
7. 不要在 ensure 里 `await` 轮 2 发送（fire-and-forget，防重靠发前清 pending
   - sending 集合；失败恢复 pending 交 ensure 补发）

## 提交规范

- conventional commits（`feat:` / `fix:` / `docs:` / `style:` / `refactor:` / `test:`）
- **不提交**：`reference/`、`node_modules/`、`dist/`（.gitignore 已含）
- 做完一个任务提交一个；docs 与代码改动可分开提交
- 提交前跑 `npm run typecheck` + `npm run test` + `npm run lint`
