/** 探针缓存 key：`(directory, agent, modelID, 日期)`——system 内容只随这四者变化。 */
export function cacheKey(
  directory: string,
  agent: string,
  modelID: string,
  date: string
): string {
  return JSON.stringify([directory, agent, modelID, date]);
}
