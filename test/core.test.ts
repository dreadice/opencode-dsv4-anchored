import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureState, type EnsureCtx, type EnsureInput} from '@/core';
import {createProbeStore, captureProbeSystem, probeKey} from '@/probe';
import {makeLogger} from '@/logger';
import {STAGE_PERMISSION, type Rule} from '@/stage';
import {DEFAULT_TERMS} from '@/verify';
import {INJECT_MARKER, ANCHOR_MARKER} from '@/inject';
import {
  createFakeClient,
  addSession,
  assistant,
  user,
  reasoning,
  textPart,
  toolPart,
} from './fake-client.ts';

const OPTIONS = {
  models: ['deepseek*v4*'],
  whitelist: ['bash', 'str_replace_editor'],
  verifyN: 3,
  verifyTerms: DEFAULT_TERMS,
  probeTtlMs: 300000,
};

const MODEL = {providerID: 'opencode', modelID: 'deepseek-v4-flash-free'};

function makeCtx(): {
  ctx: EnsureCtx;
  client: ReturnType<typeof createFakeClient>;
} {
  const client = createFakeClient();
  const ctx: EnsureCtx = {
    client: client as unknown as EnsureCtx['client'],
    options: OPTIONS,
    logger: makeLogger(client.app.log.bind(client.app), {debugEnabled: false}),
    probeStore: createProbeStore(),
    probeSessions: new Map(),
    giveupOnce: new Set(),
  };
  return {ctx, client};
}

function input(
  sessionID: string,
  parts: unknown[] = [{type: 'text', text: 'hi'}]
): EnsureInput {
  return {
    sessionID,
    model: MODEL,
    messageID: 'msg_user',
    outputParts: parts as EnsureInput['outputParts'],
  };
}

/** 预置探针缓存（捕获值），避免测试里跑探针。 */
function seedProbe(
  ctx: EnsureCtx,
  directory = '/proj',
  agent = 'build'
): string {
  const key = probeKey(directory, agent, MODEL.modelID);
  captureProbeSystem(ctx.probeStore, key, 'SYSTEM-FULL');
  return key;
}

const sentinel = (pattern: string): Rule => ({
  permission: STAGE_PERMISSION,
  pattern,
  action: 'allow',
});

test('TC-2-1: pristine 首轮 → seeded（首轮不注入，解锁后才注入）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1'});
  const parts: unknown[] = [{type: 'text', text: 'hello'}];
  const res = await ensureState(ctx, input('ses_1', parts));
  assert.equal(res.action, 'seeded');
  assert.equal(res.stage, 'seeded');
  assert.equal(parts.length, 1, '首轮不注入 system（dsh：晋升信号后注入）');
  const s = client._sessions.get('ses_1')!;
  assert.ok(
    s.permission.some(r => r.permission === '*' && r.action === 'deny')
  );
  assert.ok(
    s.permission.some(
      r => r.permission === STAGE_PERMISSION && r.pattern === 'seeded'
    )
  );
});

test('TC-2-2: 探针成功（缓存写入 + 会话清理）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  client.setProbeHandler(async () => {
    const key = probeKey('/proj', 'build', MODEL.modelID);
    captureProbeSystem(ctx.probeStore, key, 'CAPTURED-SYSTEM');
    throw new Error('DSV4 probe: capture complete');
  });
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'seeded');
  assert.ok(client._probeCalls.length === 1);
  const call = client._probeCalls[0]!;
  assert.ok(!('tools' in (call.body as object)), '探针请求不得带 tools');
  assert.equal((call.body as {agent: string}).agent, 'build');
  const key = probeKey('/proj', 'build', MODEL.modelID);
  assert.equal(ctx.probeStore.map.get(key)?.status, 'ok');
  assert.equal(client._sessions.has('ses_probe_1'), false, '探针会话应已删除');
});

test('TC-2-3: 探针失败 → 旁路（不注入不 seeded）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  client.setProbeHandler(async () => {
    throw new Error('network unreachable');
  });
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'bypass');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.length, 0, '旁路不应 bootstrap');
});

test('TC-2-4: 探针并发去重（两次调用只 create 一次）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  addSession(client, {id: 'ses_2'});
  let creates = 0;
  const orig = client.session.create.bind(client.session);
  client.session.create = async opts => {
    creates++;
    return orig(opts);
  };
  client.setProbeHandler(async () => {
    captureProbeSystem(
      ctx.probeStore,
      probeKey('/proj', 'build', MODEL.modelID),
      'S'
    );
    throw new Error('DSV4 probe: capture complete');
  });
  await Promise.all([
    ensureState(ctx, input('ses_1')),
    ensureState(ctx, input('ses_2')),
  ]);
  assert.equal(creates, 1, '并发 miss 只应创建一次探针会话');
});

test('TC-2-5: 注入幂等（seeded 后再来不重复注入）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('seeded')]});
  client._messages.set('ses_1', [
    user('msg_1', [textPart(`${INJECT_MARKER}\nSYSTEM`)]),
  ]);
  const parts: unknown[] = [{type: 'text', text: 'second'}];
  await ensureState(ctx, input('ses_1', parts));
  assert.equal(parts.length, 1, '已有标记不应再注入');
});

test('TC-2-6: seeded + 历史 assistant 消息 → 解锁', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('seeded')]});
  client._messages.set('ses_1', [
    user('msg_1', [textPart('q')]),
    assistant('msg_2', [reasoning('We need to check.'), textPart('OK')]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'unlock');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.at(-1)!.pattern, 'unsealed');
  assert.ok(
    s.permission.some(
      r => r.permission === 'str_replace_editor' && r.action === 'deny'
    )
  );
  assert.ok(
    s.permission.some(r => r.permission === '*' && r.action === 'allow'),
    'agent ruleset 应覆盖'
  );
});

test('TC-2-7: 解锁幂等（unsealed 不再重复追加；判别独立进行）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  client._messages.set('ses_1', [
    assistant('msg_1', [reasoning('Let me check the config.')]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'pending', '判别未通过应保持 pending');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.length, 1, 'unsealed 不应重复解锁追加');
});

test('TC-2-8: 判别通过 → verified', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  client._messages.set('ses_1', [
    assistant('msg_1', [reasoning('We need to fix the build.')]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'verify');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.at(-1)!.pattern, 'verified');
});

test('TC-2-9: 判别 giveup（N=3 条不符，warn 一次）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  client._messages.set('ses_1', [
    assistant('msg_1', [reasoning('Let me check.')]),
    assistant('msg_2', [reasoning('I will look.')]),
    assistant('msg_3', [reasoning('ok.')]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'giveup');
  assert.equal(
    client._logs.filter(l => l.msg.includes('verify.giveup')).length,
    1
  );
  const res2 = await ensureState(ctx, input('ses_1'));
  assert.equal(res2.action, 'giveup');
  assert.equal(
    client._logs.filter(l => l.msg.includes('verify.giveup')).length,
    1,
    'giveup 去重只 warn 一次'
  );
});

test('TC-2-10: verified 稳定（不再动作）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('verified')]});
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'verified');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.length, 1);
});

test('TC-2-11: bypass 稳定（failed TTL 内全旁路）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const key = probeKey('/proj', 'build', MODEL.modelID);
  ctx.probeStore.map.set(key, {
    status: 'failed',
    error: 'boom',
    ts: Date.now(),
  });
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'bypass');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.length, 0);
});

test('TC-2-12: resume——重启后从 ruleset 恢复（seeded + 历史信号 → 解锁）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('seeded')]});
  client._messages.set('ses_1', [
    assistant('msg_1', [reasoning('We need to.')]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'unlock');
});

test('TC-2-13: compaction 边界后信号才解锁（旧历史不解锁）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('seeded')]});
  client._messages.set('ses_1', [
    assistant('msg_old', [reasoning('We need to.')]),
    user('msg_c', [{type: 'compaction'}]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'pending', '边界前的旧 assistant 消息不应触发解锁');
});

test('TC-2-15: subagent（parentID）独立处理', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_sub', parentID: 'ses_parent'});
  const res = await ensureState(ctx, input('ses_sub'));
  assert.equal(res.action, 'seeded');
  assert.ok(
    client._logs.some(l => l.subagent === true),
    '日志应标记 subagent'
  );
});

test('TC-2-16: 门控不命中 → 全旁路（原生）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const res = await ensureState(ctx, {
    ...input('ses_1'),
    model: {providerID: 'anthropic', modelID: 'claude-3.5'},
  });
  assert.equal(res.action, 'none');
  const s = client._sessions.get('ses_1')!;
  assert.equal(s.permission.length, 0);
});

test('TC-2-14: compaction 后重注入（无幂等标记即注入）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  // 历史含 CompactionPart，边界后无注入标记 → 应重新注入
  client._messages.set('ses_1', [user('msg_c', [{type: 'compaction'}])]);
  const parts: unknown[] = [{type: 'text', text: 'continue'}];
  await ensureState(ctx, input('ses_1', parts));
  assert.equal(parts.length, 2, 'compaction 后应重新注入');
  assert.ok(String((parts[0] as {text: string}).text).includes(INJECT_MARKER));
});

test('TC-2-14b: 边界后已有注入标记则不重复注入', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  client._messages.set('ses_1', [
    user('msg_c', [{type: 'compaction'}]),
    user('msg_2', [textPart(`${INJECT_MARKER}\nSYSTEM`)]),
  ]);
  const parts: unknown[] = [{type: 'text', text: 'continue'}];
  await ensureState(ctx, input('ses_1', parts));
  assert.equal(parts.length, 1, '已有标记不重复注入');
});

test('TC-2-8b: reasoning 无标记、text 有 we → 拼接后通过', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('unsealed')]});
  client._messages.set('ses_1', [
    assistant('msg_1', [
      reasoning('Hmm, need to inspect the repo.'),
      textPart('We need to do it.'),
    ]),
  ]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'verify');
});

test('tool part 也算解锁信号', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1', permission: [sentinel('seeded')]});
  client._messages.set('ses_1', [assistant('msg_1', [toolPart('bash')])]);
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'unlock');
});

test('injectSystem:false 时首轮不注入', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  ctx.options.injectSystem = false;
  addSession(client, {id: 'ses_noinj'});
  const parts: unknown[] = [{type: 'text', text: 'hello'}];
  const res = await ensureState(ctx, input('ses_noinj', parts));
  assert.equal(res.action, 'seeded');
  assert.equal(parts.length, 1, '关闭注入时首轮不应 prepend 注入 part');
});

test('anchorText：首轮 prepend 固定锚定消息（优先于 system 注入）', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  ctx.options.anchorText =
    'This round is a test. Tools are not open yet; all tools will open next round.';
  addSession(client, {id: 'ses_anchor'});
  const parts: unknown[] = [{type: 'text', text: 'real task'}];
  await ensureState(ctx, input('ses_anchor', parts));
  assert.equal(parts.length, 2, '应 prepend 锚定消息');
  const first = parts[0] as {text: string};
  assert.ok(first.text.includes('This round is a test'), '锚定消息在最前');
  assert.ok(!first.text.includes('SYSTEM-FULL'), '不注入 system');
  assert.ok(first.text.includes(ANCHOR_MARKER), '锚定 part 带 ANCHOR 标记');
});
