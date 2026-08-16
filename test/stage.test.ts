import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_PERMISSION,
  getStage,
  seededRules,
  extractSessionDenies,
  unlockRules,
  compactionRules,
  type Rule,
} from '@/stage';

const r = (
  permission: string,
  pattern: string,
  action: Rule['action']
): Rule => ({
  permission,
  pattern,
  action,
});

const sentinel = (pattern: string): Rule => ({
  permission: STAGE_PERMISSION,
  pattern,
  action: 'allow',
});

test('TC-1-6: 空 ruleset → pristine', () => {
  assert.equal(getStage([]), 'pristine');
});

test('TC-1-7: 哨兵 seeded → seeded', () => {
  assert.equal(getStage([sentinel('seeded')]), 'seeded');
});

test('TC-1-8: 哨兵 unsealed → unsealed', () => {
  assert.equal(getStage([sentinel('unsealed')]), 'unsealed');
});

test('TC-1-9: 哨兵 verified → verified', () => {
  assert.equal(getStage([sentinel('verified')]), 'verified');
});

test('TC-1-10: findLast 后写覆盖（seeded → verified 取最后）', () => {
  assert.equal(
    getStage([sentinel('seeded'), r('*', '*', 'deny'), sentinel('verified')]),
    'verified'
  );
});

test('TC-1-11: 有 deny * 但无哨兵 → pristine（非插件会话）', () => {
  assert.equal(
    getStage([r('*', '*', 'deny'), r('bash', '*', 'allow')]),
    'pristine'
  );
});

test('TC-1-12: seededRules 结构（哨兵→deny*→白名单→external_directory），zero 形态白名单空', () => {
  const rules = seededRules([]);
  assert.deepEqual(rules, [
    sentinel('seeded'),
    r('*', '*', 'deny'),
    r('external_directory', '*', 'allow'),
  ]);
  const withBash = seededRules(['bash']);
  assert.deepEqual(withBash[2], r('bash', '*', 'allow'));
});

test('TC-1-13: extractSessionDenies 只取 deny 且排除插件自身 deny *', () => {
  const rules = [
    r('*', '*', 'deny'),
    r('bash', '*', 'allow'),
    r('task', '*', 'deny'),
    r('doom_loop', '*', 'ask'),
    sentinel('seeded'),
  ];
  assert.deepEqual(extractSessionDenies(rules), [r('task', '*', 'deny')]);
});

test('TC-1-14: unlockRules 顺序 = agent ruleset → sessionDenies → 哨兵 unsealed', () => {
  const agent = [r('*', '*', 'allow'), r('doom_loop', '*', 'ask')];
  const denies = [r('task', '*', 'deny')];
  assert.deepEqual(unlockRules(agent, denies), [
    ...agent,
    ...denies,
    sentinel('unsealed'),
  ]);
});

test('TC-1-15: unlockRules 保留 explore 只读 ruleset', () => {
  const explore = [
    r('*', '*', 'deny'),
    r('read', '*', 'allow'),
    r('bash', '*', 'allow'),
  ];
  const out = unlockRules(explore, []);
  assert.deepEqual(out.slice(0, 3), explore);
  assert.equal(out[out.length - 1].pattern, 'unsealed');
});

test('TC-1-16: compactionRules 含白名单 + compactionTools + 哨兵 seeded', () => {
  const rules = compactionRules([]);
  const allowed = rules
    .filter(x => x.action === 'allow')
    .map(x => x.permission);
  assert.ok(allowed.includes(STAGE_PERMISSION));
  assert.ok(!allowed.includes('bash'), '空白名单不应放行 bash');
  for (const tool of [
    'read',
    'glob',
    'grep',
    'edit',
    'todowrite',
    'question',
  ]) {
    assert.ok(allowed.includes(tool), `missing ${tool}`);
  }
  assert.ok(rules.some(x => x.permission === '*' && x.action === 'deny'));
  assert.ok(
    rules.some(
      x => x.permission === 'external_directory' && x.action === 'allow'
    )
  );
  assert.equal(rules[0].pattern, 'seeded');
  const withBash = compactionRules(['bash']);
  assert.ok(withBash.some(x => x.permission === 'bash' && x.action === 'allow'));
});
