export type HistoryMessage = {
  info: unknown
  parts: Array<{ type: string; state?: unknown }>
}

/**
 * 压缩边界（epoch）：历史中最后一条含 `CompactionPart`（`type:"compaction"`）
 * 消息的索引；无 → -1（从头扫描）。
 * 注意：prune 给 tool part 打的 `state.time.compacted` 只清输出、**不是**压缩
 * 边界（research round-6）。
 */
export function lastCompactionBoundary(messages: HistoryMessage[]): number {
  let last = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.parts.some((p) => p.type === "compaction")) last = i
  }
  return last
}