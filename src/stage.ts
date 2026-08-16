export const STAGE_PERMISSION = '__dsv4_stage__';
export const COMPACTION_TOOLS = [
  'read',
  'glob',
  'grep',
  'edit',
  'todowrite',
  'question',
];

export type Rule = {
  permission: string;
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
};

export type Stage = 'pristine' | 'seeded' | 'unsealed' | 'verified';

function findLast<T>(items: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i]!)) return items[i];
  }
  return undefined;
}

/** 阶段判定：findLast 取最后一条哨兵规则（后写覆盖语义）。 */
export function getStage(ruleset: Rule[]): Stage {
  const sentinel = findLast(ruleset, r => r.permission === STAGE_PERMISSION);
  return (sentinel?.pattern as Stage) ?? 'pristine';
}

/** seeded 规则（D10 严格 minimal 工具对）：哨兵 → deny * → 白名单 → external_directory。 */
export function seededRules(whitelist: string[]): Rule[] {
  return [
    {permission: STAGE_PERMISSION, pattern: 'seeded', action: 'allow'},
    {permission: '*', pattern: '*', action: 'deny'},
    ...whitelist.map(permission => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
    {permission: 'external_directory', pattern: '*', action: 'allow'},
  ];
}

/** 提取 session 既有 deny 规则，排除插件自身的 deny *（防止解锁时自我覆盖）。 */
export function extractSessionDenies(ruleset: Rule[]): Rule[] {
  return ruleset.filter(
    r => r.action === 'deny' && !(r.permission === '*' && r.pattern === '*')
  );
}

/** 解锁规则：agent ruleset → session denies → 哨兵 unsealed（round-10：假
 * str_replace_editor 工具已移除，无需隐藏 deny）。 */
export function unlockRules(
  agentRuleset: Rule[],
  sessionDenies: Rule[]
): Rule[] {
  return [
    ...agentRuleset,
    ...sessionDenies,
    {permission: STAGE_PERMISSION, pattern: 'unsealed', action: 'allow'},
  ];
}

/** compaction 回退规则（D5 修订：配置白名单 + compactionTools，round-10：
 * 参数化白名单——回退 = 回 seeded 态 + compaction 工具）。 */
export function compactionRules(whitelist: string[]): Rule[] {
  return [
    {permission: STAGE_PERMISSION, pattern: 'seeded', action: 'allow'},
    {permission: '*', pattern: '*', action: 'deny'},
    ...whitelist.map(permission => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
    ...COMPACTION_TOOLS.map(permission => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
    {permission: 'external_directory', pattern: '*', action: 'allow'},
  ];
}
