export const STAGE_PERMISSION = "__dsv4_stage__"
export const MINIMAL_WHITELIST = ["bash", "str_replace_editor"]
export const COMPACTION_TOOLS = ["read", "glob", "grep", "edit", "todowrite", "question"]

export type Rule = {
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

export type Stage = "pristine" | "seeded" | "unsealed" | "verified"

function findLast<T>(items: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i]!)) return items[i]
  }
  return undefined
}

/** 阶段判定：findLast 取最后一条哨兵规则（后写覆盖语义）。 */
export function getStage(ruleset: Rule[]): Stage {
  const sentinel = findLast(ruleset, (r) => r.permission === STAGE_PERMISSION)
  return (sentinel?.pattern as Stage) ?? "pristine"
}

/** seeded 规则（D10 严格 minimal 工具对）：哨兵 → deny * → 白名单 → external_directory。 */
export function seededRules(whitelist: string[]): Rule[] {
  return [
    { permission: STAGE_PERMISSION, pattern: "seeded", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
    ...whitelist.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "external_directory", pattern: "*", action: "allow" },
  ]
}

/** 提取 session 既有 deny 规则，排除插件自身的 deny *（防止解锁时自我覆盖）。 */
export function extractSessionDenies(ruleset: Rule[]): Rule[] {
  return ruleset.filter((r) => r.action === "deny" && !(r.permission === "*" && r.pattern === "*"))
}

/** 解锁规则：agent ruleset → session denies → 隐藏 str_replace_editor → 哨兵 unsealed。 */
export function unlockRules(agentRuleset: Rule[], sessionDenies: Rule[]): Rule[] {
  return [
    ...agentRuleset,
    ...sessionDenies,
    { permission: "str_replace_editor", pattern: "*", action: "deny" },
    { permission: STAGE_PERMISSION, pattern: "unsealed", action: "allow" },
  ]
}

/** compaction 回退规则（D5 修订：minimal 对 + compactionTools），哨兵回 seeded。 */
export function compactionRules(): Rule[] {
  return [
    { permission: STAGE_PERMISSION, pattern: "seeded", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
    ...MINIMAL_WHITELIST.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    ...COMPACTION_TOOLS.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "external_directory", pattern: "*", action: "allow" },
  ]
}