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

## 安装

三种方式任选其一（**互斥，勿同时使用**——`.opencode/plugins/*.js` 与
`plugin` 配置同时存在会双加载，chat.message 触发两次）：

**1. npm 包（推荐，开箱即用）**——opencode.json：

```json
{
  "plugin": [["@dreadice/opencode-dsv4-anchored", {}]]
}
```

**2. 本地**：

```bash
npm run build                 # esbuild bundle → dist/index.js
cp dist/index.js <项目>/.opencode/plugins/dsv4-anchored.js
# 或把仓库路径写进配置：
# "plugin": [["/path/to/opencode-dsv4-anchored", {}]]
```

**3. Git 引用**——先跑一次预装脚本，再用配置引用：

```bash
bash scripts/install-git-cache.sh          # clone + 构建 + 预装到 opencode 缓存
```

```json
{
  "plugin": [["github:dreadice/opencode-dsv4-anchored", {}]]
}
```

> 说明（2026-08-16 实测）：opencode v1.18.18 的插件安装器（`Npm.add`/Arborist）
> 对 git spec 安装失败——缓存目录创建但为空、插件静默不加载（其运行时为
> `bun build --compile`，Arborist 的 git 安装路径在其编译产物中失效；registry
> 安装正常）。**加载环节本身没问题**，预装到缓存目录后即可正常使用。
> 更新版本时重跑脚本即可。

> 要求：opencode `>= 1.18.18`（`engines.opencode` 兼容检查）。

## 配置

| 选项              | 默认                                     | 说明                                                |
| ----------------- | ---------------------------------------- | --------------------------------------------------- |
| `models`          | `["deepseek*v4*"]`                       | 门控模型通配符（providerID/modelID）                |
| `whitelist`       | `[]`                                     | seeded 期白名单（**0 工具**，实证唯一出 we 的形态） |
| `anchorText`      | dsh 原文（"This round is a test..."）    | zero 锚定消息；设 `""` 关闭锚定轮                   |
| `injectSystem`    | 启用                                     | 轮 2 注入去 persona 的真实 system                   |
| `firstTurnFilter` | `{stripPersona: true}`                   | 注入前选择性剥离（D11）                             |
| `verify.n`        | `3`                                      | 判别窗口（常量）                                    |
| `verify.terms`    | 英文 we/let 词表                         | 轨迹标记词表                                        |
| `probe.ttlMs`     | `300000`                                 | 探针失败旁路 TTL                                    |
| `probe.cacheDir`  | `~/.local/share/opencode/dsv4-anchored/` | 缓存与状态文件目录                                  |

## 验证

```bash
OPENCODE_LOG_LEVEL=DEBUG opencode          # 插件日志（默认只落盘）
grep dsv4-anchored ~/.local/share/opencode/log/opencode.log
cat ~/.local/share/opencode/dsv4-anchored/probe-cache.json   # 探针缓存/状态
```

事件链：`probe.success → chat.message(seeded) → round2.sent → unlock →
verify.passed/giveup`。

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
