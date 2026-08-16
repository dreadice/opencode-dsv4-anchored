import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  INJECT_MARKER,
  hasInjectionMarker,
  buildInjectionPart,
  filterFirstTurnSystem,
} from '@/inject';

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

const REAL_SYSTEM = [
  'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
  'Use the instructions below to assist the user.',
  '',
  'Here is some useful information about the environment:',
  '<env>working dir /proj</env>',
  '',
  'Instructions from: /proj/AGENTS.md',
  'Do the thing according to AGENTS.',
  '',
  'Skills provide specialized instructions for specific tasks.',
  '<available_skills>skill list</available_skills>',
].join('\n');

test('filterFirstTurnSystem：过滤 opencode persona 段（保留 Instructions/Skills）', () => {
  const out = filterFirstTurnSystem(REAL_SYSTEM, {stripPersona: true});
  assert.ok(!out.includes('You are opencode,'), 'persona 段应被过滤');
  assert.ok(
    out.includes('Instructions from: /proj/AGENTS.md'),
    'Instructions 段保留'
  );
  assert.ok(out.includes('Skills provide specialized'), 'Skills 段保留');
});

test('filterFirstTurnSystem：D11 全滤（persona+instructions+skills）', () => {
  const out = filterFirstTurnSystem(REAL_SYSTEM, {
    stripPersona: true,
    stripInstructions: true,
    stripSkills: true,
  });
  assert.ok(!out.includes('You are opencode,'));
  assert.ok(!out.includes('Instructions from:'));
  assert.ok(!out.includes('Skills provide specialized'));
  assert.ok(out.trim() === '', '全滤后仅剩空段');
});

test('filterFirstTurnSystem：无过滤配置原样返回', () => {
  assert.equal(filterFirstTurnSystem(REAL_SYSTEM, {}), REAL_SYSTEM);
});
