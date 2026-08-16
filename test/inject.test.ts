import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  INJECT_MARKER,
  injectionMarkerFor,
  hasInjectionMarkerFor,
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

test('TC-1-28: 含当前 agent/model 幂等标记 → true', () => {
  const marker = injectionMarkerFor('build', 'deepseek-v4-flash-free');
  const parts = [textPart('hello'), textPart(`${marker}\nsystem content`)];
  assert.equal(
    hasInjectionMarkerFor(parts, 'build', 'deepseek-v4-flash-free'),
    true
  );
});

test('TC-1-29: 无当前 agent/model 幂等标记 → false', () => {
  const parts = [textPart('hello'), textPart('world')];
  assert.equal(
    hasInjectionMarkerFor(parts, 'build', 'deepseek-v4-flash-free'),
    false
  );
});

test('TC-1-30: 注入 part 字段完整（type/synthetic/id 前缀/标记+system）', () => {
  const system = 'line1\nline2';
  const marker = injectionMarkerFor('build', 'deepseek-v4-flash-free');
  const part = buildInjectionPart(system, 'ses_1', 'msg_1', marker);
  assert.equal(part.type, 'text');
  assert.equal(part.synthetic, true);
  assert.ok(part.id.startsWith('prt_'), `id 应以 prt_ 开头: ${part.id}`);
  assert.equal(part.sessionID, 'ses_1');
  assert.equal(part.messageID, 'msg_1');
  assert.ok(part.text.startsWith(INJECT_MARKER));
  assert.ok(part.text.includes(system));
});

test('TC-1-30b: 注入 part id 唯一（两次生成不同）', () => {
  const marker = injectionMarkerFor('build', 'deepseek-v4-flash-free');
  const a = buildInjectionPart('s', 'ses_1', 'msg_1', marker);
  const b = buildInjectionPart('s', 'ses_1', 'msg_1', marker);
  assert.notEqual(a.id, b.id);
});

const REAL_SYSTEM = [
  'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
  'Use the instructions below to assist the user.',
  '',
  'IMPORTANT: You must NEVER generate or guess URLs.',
  '',
  'You are powered by the model named deepseek-v4-pro.',
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

test('filterFirstTurnSystem：stripPersona 只删身份声明句（保留行为要求/env/AGENTS/Skills）', () => {
  const out = filterFirstTurnSystem(REAL_SYSTEM, {stripPersona: true});
  assert.ok(
    !out.includes('You are opencode, an interactive CLI tool'),
    '身份声明句应被滤掉'
  );
  assert.ok(
    out.includes('Use the instructions below to assist the user.'),
    '首句后的内容保留'
  );
  assert.ok(
    out.includes('IMPORTANT: You must NEVER generate'),
    '行为要求应保留'
  );
  assert.ok(out.includes('You are powered by the model named'), '模型名行保留');
  assert.ok(out.includes('<env>working dir /proj</env>'), 'env 应保留');
  assert.ok(
    out.includes('Instructions from: /proj/AGENTS.md'),
    'AGENTS 段保留'
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
  assert.ok(out.includes('<env>'), 'env 仍保留');
});

test('filterFirstTurnSystem：无过滤配置原样返回', () => {
  assert.equal(filterFirstTurnSystem(REAL_SYSTEM, {}), REAL_SYSTEM);
});
