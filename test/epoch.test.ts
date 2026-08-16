import { test } from "node:test"
import assert from "node:assert/strict"
import { lastCompactionBoundary } from "../src/epoch.ts"

const msg = (id: string, parts: Array<{ type: string; state?: unknown }>) => ({
  info: { id },
  parts,
})

const text = () => ({ type: "text", text: "hi" })
const compaction = () => ({ type: "compaction", tail_start_id: "msg_3" })
const tool = () => ({ type: "tool", tool: "bash", state: { time: { compacted: 1700000000000 } } })

test("TC-1-31: 无 CompactionPart → -1（从头）", () => {
  const messages = [msg("msg_1", [text()]), msg("msg_2", [text(), tool()])]
  assert.equal(lastCompactionBoundary(messages), -1)
})

test("TC-1-32: 一条 CompactionPart 在中间 → 返回其索引", () => {
  const messages = [msg("msg_1", [text()]), msg("msg_2", [compaction()]), msg("msg_3", [text()])]
  assert.equal(lastCompactionBoundary(messages), 1)
})

test("TC-1-33: 多条 → 最后一条", () => {
  const messages = [msg("msg_1", [compaction()]), msg("msg_2", [text()]), msg("msg_3", [compaction()])]
  assert.equal(lastCompactionBoundary(messages), 2)
})

test("TC-1-34: 仅 prune 标记（tool part state.time.compacted）→ 不算边界", () => {
  const messages = [msg("msg_1", [tool(), tool()]), msg("msg_2", [text()])]
  assert.equal(lastCompactionBoundary(messages), -1)
})