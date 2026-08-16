import { test } from "node:test"
import assert from "node:assert/strict"
import { PROBE_THROW_MESSAGE, RETRY_BANNED_TERMS } from "../src/probe.ts"

test("TC-1-38: 探针 throw 文本避开 retry 禁词", () => {
  const lower = PROBE_THROW_MESSAGE.toLowerCase()
  for (const banned of RETRY_BANNED_TERMS) {
    assert.ok(!lower.includes(banned), `消息含禁词: ${banned}`)
  }
})