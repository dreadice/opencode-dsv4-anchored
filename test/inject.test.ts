import {test} from 'node:test';
import assert from 'node:assert/strict';
import {INJECT_MARKER, hasInjectionMarker, buildInjectionPart} from '@/inject';

const textPart = (text: string, extra: object = {}) => ({
  id: 'prt_x',
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
  ...extra,
});

test('TC-1-28: 含幂等标记 → true', () => {
  const parts = [
    textPart('hello'),
    textPart(`${INJECT_MARKER}\nsystem content`),
  ];
  assert.equal(hasInjectionMarker(parts), true);
});

test('TC-1-29: 无幂等标记 → false', () => {
  const parts = [textPart('hello'), textPart('world')];
  assert.equal(hasInjectionMarker(parts), false);
});

test('TC-1-30: 注入 part 字段完整（type/synthetic/id 前缀/标记+system）', () => {
  const system = 'line1\nline2';
  const part = buildInjectionPart(system, 'ses_1', 'msg_1');
  assert.equal(part.type, 'text');
  assert.equal(part.synthetic, true);
  assert.ok(part.id.startsWith('prt_'), `id 应以 prt_ 开头: ${part.id}`);
  assert.equal(part.sessionID, 'ses_1');
  assert.equal(part.messageID, 'msg_1');
  assert.ok(part.text.startsWith(INJECT_MARKER));
  assert.ok(part.text.includes(system));
});

test('TC-1-30b: 注入 part id 唯一（两次生成不同）', () => {
  const a = buildInjectionPart('s', 'ses_1', 'msg_1');
  const b = buildInjectionPart('s', 'ses_1', 'msg_1');
  assert.notEqual(a.id, b.id);
});
