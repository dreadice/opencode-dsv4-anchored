import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PROBE_THROW_MESSAGE,
  RETRY_BANNED_TERMS,
  probeTerminationError,
} from '@/probe';

test('TC-1-38: 探针 throw 文本避开 retry 禁词', () => {
  const lower = PROBE_THROW_MESSAGE.toLowerCase();
  for (const banned of RETRY_BANNED_TERMS) {
    assert.ok(!lower.includes(banned), `消息含禁词: ${banned}`);
  }
});

test('TC-1-38b: 探针终止错误 = DOMException AbortError（TUI 静默类型，round-10）', () => {
  const e = probeTerminationError();
  assert.equal(e.message, PROBE_THROW_MESSAGE);
  assert.ok(
    typeof DOMException !== 'undefined' && e instanceof DOMException,
    '应为 DOMException'
  );
  assert.equal(e.name, 'AbortError');
});
