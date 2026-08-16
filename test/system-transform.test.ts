import {test} from 'node:test';
import assert from 'node:assert/strict';
import {systemTransform} from '@/system-transform';
import {compacting} from '@/compaction';
import {createProbeStore, probeKey, type ProbeStore} from '@/probe';
import {makeLogger} from '@/logger';
import {MINIMAL_PERSONA} from '@/core';
import {STAGE_PERMISSION, type Rule} from '@/stage';
import {DEFAULT_TERMS} from '@/verify';
import {createFakeClient, addSession} from './fake-client.ts';

const OPTIONS = {
  models: ['deepseek*v4*'],
  whitelist: [],
  verifyN: 3,
  verifyTerms: DEFAULT_TERMS,
  probeTtlMs: 300000,
};

const MODEL = {providerID: 'opencode', modelID: 'deepseek-v4-flash-free'};

function makeCtx() {
  const client = createFakeClient();
  const probeStore: ProbeStore = createProbeStore();
  const logger = makeLogger(client.app.log.bind(client.app), {
    debugEnabled: false,
  });
  return {
    client,
    probeStore,
    logger,
    ctx: {
      client: client as never,
      probeStore,
      probeSessions: new Map<string, string>(),
      options: OPTIONS,
      logger,
    },
  };
}

const sentinel = (pattern: string): Rule => ({
  permission: STAGE_PERMISSION,
  pattern,
  action: 'allow',
});

test('TC-2-18: 探针会话 → 捕获 + throw（禁词规避）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_probe_1'});
  const key = probeKey('/proj', 'build', MODEL.modelID);
  ctx.probeSessions.set('ses_probe_1', key);
  const output = {system: ['agent prompt\nAGENTS.md content']};
  let thrown = '';
  try {
    await systemTransform(
      ctx,
      {sessionID: 'ses_probe_1', model: MODEL},
      output
    );
  } catch (e) {
    thrown = String(e instanceof Error ? e.message : e);
  }
  assert.ok(
    thrown.includes('capture complete'),
    `应 throw 探针消息: ${thrown}`
  );
  const cached = ctx.probeStore.map.get(key);
  assert.equal(cached?.status, 'ok');
  assert.equal(cached?.system, 'agent prompt\nAGENTS.md content');
});

test('TC-2-17: 真实会话 → 替换 minimal', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const output = {system: ['long original system content']};
  await systemTransform(ctx, {sessionID: 'ses_1', model: MODEL}, output);
  assert.deepEqual(output.system, [MINIMAL_PERSONA]);
});

test('TC-2-19: bypass（probe failed TTL 内）→ 原样放行', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const key = probeKey('/proj', 'build', MODEL.modelID);
  ctx.probeStore.map.set(key, {
    status: 'failed',
    error: 'boom',
    ts: Date.now(),
  });
  const output = {system: ['native system']};
  await systemTransform(ctx, {sessionID: 'ses_1', model: MODEL}, output);
  assert.deepEqual(output.system, ['native system']);
});

test('TC-2-19b: 门控不命中 → 放行', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const output = {system: ['native']};
  await systemTransform(
    ctx,
    {
      sessionID: 'ses_1',
      model: {providerID: 'anthropic', modelID: 'claude-3.5'},
    },
    output
  );
  assert.deepEqual(output.system, ['native']);
});

test('compaction 回退：含哨兵会话 → 追加回退规则 + warn', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  await compacting(ctx, 'ses_1', OPTIONS.whitelist);
  const s = client._sessions.get('ses_1')!;
  assert.ok(
    s.permission.some(
      r => r.permission === STAGE_PERMISSION && r.pattern === 'seeded'
    )
  );
  assert.ok(
    s.permission.some(r => r.permission === '*' && r.action === 'deny')
  );
  for (const tool of [
    'read',
    'glob',
    'grep',
    'edit',
    'todowrite',
    'question',
  ]) {
    assert.ok(
      s.permission.some(r => r.permission === tool && r.action === 'allow'),
      `missing ${tool}`
    );
  }
  assert.ok(client._logs.some(l => l.msg.includes('compaction.rollback')));
});

test('compaction 回退：pristine 会话不动作', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  await compacting(ctx, 'ses_1', OPTIONS.whitelist);
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.length, 0);
});

test('system.transform 原地替换（splice）——同数组引用生效', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const original = ['long original system content'];
  const output = {system: original};
  await systemTransform(ctx, {sessionID: 'ses_1', model: MODEL}, output);
  assert.equal(output.system.length, 1);
  assert.equal(output.system[0], MINIMAL_PERSONA);
  assert.equal(
    original.length,
    1,
    '原数组引用应被原地修改（trigger 忽略返回值）'
  );
  assert.equal(original[0], MINIMAL_PERSONA);
});
