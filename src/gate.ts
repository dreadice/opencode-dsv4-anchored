export function matchesModel(model: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some(p => wildcardToRegExp(p).test(model));
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(/\\\*/g, '.*');
  return new RegExp(`^${re}$`);
}

/**
 * 模型门控（D4）：对 `providerID/modelID` 拼接串与 modelID 各跑一次通配匹配，
 * 任一命中即通过——覆盖带/不带 provider 前缀两种形态。
 */
export function gateModel(
  model: {providerID: string; modelID: string},
  patterns: string[]
): boolean {
  const joined = `${model.providerID}/${model.modelID}`;
  return (
    matchesModel(joined, patterns) || matchesModel(model.modelID, patterns)
  );
}
