# opencode-dsv4-anchored

> 把 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
> 的「首轮轨迹约束 + 逐步解锁」方法移植为 opencode 插件，解决 **DeepSeek V4 系列
> 的过拟合问题**：模型一见完整 system 就抢跑（首轮狂开工具、多步并行、话痨式
> show off），把首轮轨迹带偏。

## 工作原理

`zero-anchored` 锚定轮 + 真实消息推迟（对齐 dsh zero-anchored/whoami）：

```
轮 1（锚定轮）：
  ├─ 探针：静默捕获真实 system（零 token，缓存按 directory/agent/model/天）
  ├─ system 整体替换为纯 Minimal persona
  ├─ 真实消息推迟（存盘 pending）→ 模型只看到固定锚定消息 + 0 工具
  └─ 锚定回复落库（"we" 风格 = 成功信号）
       → event（session.idle）自动发轮 2
轮 2（真实任务轮）：
  ├─ 解锁：工具按 agent ruleset 全量恢复
  ├─ 注入去 persona 的真实 system（synthetic，TUI 隐藏）
  └─ 模型带全量工具处理真实任务
后续：特征判别（N=3 轮内：reasoning+text 拼接 idx(we系) < idx(let系)）
      → 达成：哨兵 verified；未达成：giveup（warn 一次，不锁死）
```

- **0 工具是唯一实证出 "we" 锚定形态的配置**（官方 v4-pro 实测：minimal + 0
  工具 → "We need answer..."；双工具 → standard-like）
- 状态全部持久化（session permission 哨兵 + 缓存文件），重启/resume/compaction
  可还原
- 探针失败 → 该 key 按 TTL 旁路，会话完全原生（不替换/不锚定/不注入）

## 中途切换 agent / model

同会话中途切换 agent 或门控模型时，插件会在下一条 `chat.message` 自动：

1. 用 `__dsv4_agent__` / `__dsv4_model__` 哨兵检测到变化；
2. 重同步权限：把当前 agent 的 ruleset 追加到 session permission 末尾，
   覆盖旧 agent 的权限（例如 explore 的 `*: deny` 会压住之前 build 的
   `*: allow`）；
3. 重新注入当前 agent/model 的原始 system（带 agent/model 指纹的幂等标记）；
4. 切换到非门控模型（如 `hy3-free`）时，不替换 system、不注入，但会把
   权限恢复成原生状态（日志 `native.restore`）。

日志关键词：`resync`、`native.restore`、`injectSource=resync`。

## 安装

opencode 支持两种插件加载方式（官方文档：本地文件 / npm 包），任选其一
（**互斥，勿同时使用**——全局 `~/.config/opencode/plugins/`、项目
`.opencode/plugins/*.js`、`plugin` 配置同时存在会双加载，chat.message 触发
两次、探针重复、toast 重复；插件内有单例兜底，但应避免）：

**1. npm 包（推荐，开箱即用）**——opencode.json：

```json
{
  "plugin": [["@dreadice/opencode-dsv4-anchored", {}]]
}
```

**2. 本地文件**：

```bash
npm run build                 # esbuild bundle → dist/index.js
cp dist/index.js <项目>/.opencode/plugins/dsv4-anchored.js
```

> 要求：opencode `>= 1.18.18`（`engines.opencode` 兼容检查）。

## 配置

| 选项              | 默认                                     | 说明                                                                 |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `models`          | `["deepseek*v4*"]`                       | 门控模型通配符（providerID/modelID）                                 |
| `whitelist`       | `[]`                                     | seeded 期白名单（**0 工具**，实证唯一出 we 的形态）                  |
| `anchorText`      | dsh 原文（"This round is a test..."）    | zero 锚定消息；设 `""` 关闭锚定轮                                    |
| `injectSystem`    | 启用                                     | 轮 2 注入去 persona 的真实 system                                    |
| `firstTurnFilter` | `{stripPersona: true}`                   | 注入前选择性剥离（D11）                                              |
| `verify.n`        | `3`                                      | 判别窗口（常量）                                                     |
| `verify.terms`    | 英文 we/let 词表                         | 轨迹标记词表                                                         |
| `toast`           | 启用                                     | TUI toast 提示（锚定轮/轮 2/解锁/判别/旁路，见 docs/design.md §7.4） |
| `probe.ttlMs`     | `300000`                                 | 探针失败旁路 TTL                                                     |
| `probe.cacheDir`  | `~/.local/share/opencode/dsv4-anchored/` | 缓存与状态文件目录                                                   |

## 验证

```bash
OPENCODE_LOG_LEVEL=DEBUG opencode          # 插件日志（默认只落盘）
grep dsv4-anchored ~/.local/share/opencode/log/opencode.log
cat ~/.local/share/opencode/dsv4-anchored/probe-cache.json   # 探针缓存/状态
```

事件链：`plugin.loaded(version) → probe.success → chat.message(seeded) →
round2.sent → unlock → verify.passed/giveup`。

## 与其他插件共存

命名空间全部隔离（哨兵 permission `__dsv4_stage__`、幂等标记
`[dsv4-anchored:injected]`、状态文件 `~/.local/share/opencode/dsv4-anchored/`、
日志前缀 `dsv4-anchored`），互不干扰。已知交互点：

- **`experimental.chat.system.transform` 是共享输出**：多个插件都改同一个
  `output.system` 数组，**后注册者生效**——本插件会把 system 整体替换为
  minimal persona。与同样替换 system 的插件并存时，行为取决于注册顺序。
- **锚定轮 `deny *` 会暂时隐藏其他插件注册的工具**：解锁后按 agent ruleset
  恢复（build 的 `*: allow` 会放行一切，与原生一致），不影响长期行为。
- chat.message 的 parts 注入是叠加的（本插件 prepend 自己的 part），不删除
  其他插件的内容。

## 文档

- `docs/design.md` — 系统设计（目标/行为/时序/状态机/配置/验证）
- `docs/research.md` — 完整研究报告（opencode 机制源码：文件:行号）
- `docs/decisions.md` — 决策记录（D1-D13）
- `docs/testing.md` — 测试用例（L1 单元 / L2 fake client / L3 真机）
- `docs/live-testing.md` — 真机测试手册（`opencode serve` + HTTP API）
- `docs/plan.md` — 执行计划
- `docs/handoff.md` — 跨会话状态与讨论留档

## License

[MIT](LICENSE)。引用内容版权归各自作者所有：opencode（2025）、DeepSeek
（2026）、xiaobright（2026），详见 LICENSE 的版权归属声明。
