import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureState, type EnsureCtx, type EnsureInput} from '@/core';
import {createProbeStore, captureProbeSystem, probeKey} from '@/probe';
import {makeLogger} from '@/logger';
import {STAGE_PERMISSION, type Rule} from '@/stage';
import {DEFAULT_TERMS} from '@/verify';
import {INJECT_MARKER} from '@/inject';
import {createPendingStore} from '@/pending';
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
  whitelist: [],
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
    options: {...OPTIONS},
    logger: makeLogger(client.app.log.bind(client.app), {debugEnabled: false}),
    probeStore: createProbeStore(),
    probeSessions: new Map(),
    giveupOnce: new Set(),
    pendingStore: createPendingStore(),
    pendingFile: '/tmp/dsv4-pending-test.json',
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
  client.setPromptHandler(async () => {
    const key = probeKey('/proj', 'build', MODEL.modelID);
    captureProbeSystem(ctx.probeStore, key, 'CAPTURED-SYSTEM');
    throw new Error('DSV4 probe: capture complete');
  });
  const res = await ensureState(ctx, input('ses_1'));
  assert.equal(res.action, 'seeded');
  assert.ok(client._promptCalls.length === 1);
  const call = client._promptCalls[0]!;
  assert.ok(!('tools' in (call.body as object)), '探针请求不得带 tools');
  assert.equal((call.body as {agent: string}).agent, 'build');
  const key = probeKey('/proj', 'build', MODEL.modelID);
  assert.equal(ctx.probeStore.map.get(key)?.status, 'ok');
  assert.equal(client._sessions.has('ses_probe_1'), false, '探针会话应已删除');
});

test('TC-2-3: 探针失败 → 旁路（不注入不 seeded）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_1'});
  client.setPromptHandler(async () => {
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
  client.setPromptHandler(async () => {
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
    s.permission.some(r => r.permission === '*' && r.action === 'allow'),
    'agent ruleset 应覆盖'
  );
  assert.ok(
    !s.permission.some(
      r => r.permission === 'str_replace_editor' && r.action === 'deny'
    ),
    'round-10：假 str_replace_editor 已移除，解锁不再隐藏 deny'
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

test('TC-2-25: 锚定轮——首轮 parts 替换为纯锚定消息，真实 parts 进 pending', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  ctx.options.anchorText =
    'This round is a test. Tools are not open yet; all tools will open next round.';
  addSession(client, {id: 'ses_anchor'});
  const parts: unknown[] = [{type: 'text', text: 'real task'}];
  const res = await ensureState(ctx, input('ses_anchor', parts));
  assert.equal(res.action, 'seeded');
  assert.equal(parts.length, 1, 'parts 应替换为锚定消息（真实消息推迟）');
  const anchor = parts[0] as {text: string; synthetic: boolean};
  assert.equal(
    anchor.text,
    'This round is a test. Tools are not open yet; all tools will open next round.',
    '锚定 part = 纯 dsh 原文（不加幂等标记）'
  );
  assert.equal(anchor.synthetic, true);
  assert.ok(!anchor.text.includes('SYSTEM-FULL'), '不注入 system');
  const pending = ctx.pendingStore.map.get('ses_anchor')!;
  assert.ok(pending, '真实 parts 应存盘 pending');
  assert.equal(pending.parts.length, 1);
  assert.equal(
    (pending.parts[0] as {text: string}).text,
    'real task',
    'pending 保存真实消息内容'
  );
});

test('TC-2-26: 锚定轮 bypass——不替换 parts、不存 pending（原生）', async () => {
  const {ctx, client} = makeCtx();
  addSession(client, {id: 'ses_bypass'});
  ctx.options.anchorText = 'ANCHOR';
  const key = probeKey('/proj', 'build', MODEL.modelID);
  ctx.probeStore.map.set(key, {
    status: 'failed',
    error: 'boom',
    ts: Date.now(),
  });
  const parts: unknown[] = [{type: 'text', text: 'real task'}];
  const res = await ensureState(ctx, input('ses_bypass', parts));
  assert.equal(res.action, 'bypass');
  assert.equal(parts.length, 1);
  assert.equal((parts[0] as {text: string}).text, 'real task', '原样放行');
  assert.equal(ctx.pendingStore.map.has('ses_bypass'), false);
});

test('TC-2-27: 重锚定——pending 存在 + 无 assistant 回复 → 追加推迟 + 替换锚定', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  ctx.options.anchorText = 'ANCHOR';
  addSession(client, {id: 'ses_retry', permission: [sentinel('seeded')]});
  ctx.pendingStore.map.set('ses_retry', {
    parts: [{type: 'text', text: 'first'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  const parts: unknown[] = [{type: 'text', text: 'second'}];
  const res = await ensureState(ctx, input('ses_retry', parts));
  assert.equal(res.action, 'pending', '无信号不解锁');
  assert.equal(parts.length, 1);
  assert.equal((parts[0] as {text: string}).text, 'ANCHOR');
  const pending = ctx.pendingStore.map.get('ses_retry')!;
  assert.equal(pending.parts.length, 2, '当前消息应追加到 pending');
  assert.equal((pending.parts[1] as {text: string}).text, 'second');
});

test('TC-2-30: ensure 悬挂补发——pending 存在 + 锚定回复已落库 → 补发轮 2，当前消息正常放行', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  ctx.options.anchorText = 'ANCHOR';
  addSession(client, {id: 'ses_dangling', permission: [sentinel('seeded')]});
  ctx.pendingStore.map.set('ses_dangling', {
    parts: [{type: 'text', text: 'first'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  // 锚定回复已落库（晋升信号）
  client._messages.set('ses_dangling', [
    assistant('msg_a', [reasoning('We need to.')]),
  ]);
  client.setPromptHandler(async () => ({}));
  const parts: unknown[] = [{type: 'text', text: 'second'}];
  await ensureState(ctx, input('ses_dangling', parts));
  await new Promise(r => setImmediate(r));
  assert.equal(parts.length, 1, '当前消息正常放行（不推迟不替换）');
  assert.equal((parts[0] as {text: string}).text, 'second');
  assert.ok(client._promptCalls.length === 1, '补发一次轮 2');
  const body = client._promptCalls[0]!.body as {
    parts: Array<Record<string, unknown>>;
    agent: string;
    model?: {providerID: string; modelID: string};
  };
  assert.ok(!('tools' in body), '轮 2 不带 tools（不替换 permission）');
  assert.equal(body.agent, 'build');
  assert.deepEqual(body.model, {
    providerID: 'opencode',
    modelID: MODEL.modelID,
  });
  const texts = body.parts.map(p => String(p.text ?? ''));
  assert.ok(
    texts[0]!.includes(INJECT_MARKER),
    'user system part 在前（带幂等标记）'
  );
  assert.ok(texts[0]!.includes('SYSTEM-FULL'), '注入探针捕获 system');
  assert.ok(texts[1]!.includes('first'), 'pending 真实消息在后');
  assert.equal(
    ctx.pendingStore.map.has('ses_dangling'),
    false,
    '发送前清 pending'
  );
});

test('TC-2-31: ensure 悬挂补发防重——sending 中的会话不重复发', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx);
  ctx.options.anchorText = 'ANCHOR';
  addSession(client, {id: 'ses_d', permission: [sentinel('seeded')]});
  ctx.pendingStore.map.set('ses_d', {
    parts: [{type: 'text', text: 'first'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  client._messages.set('ses_d', [assistant('msg_a', [reasoning('ok.')])]);
  ctx.pendingStore.sending.add('ses_d');
  client.setPromptHandler(async () => ({}));
  const parts: unknown[] = [{type: 'text', text: 'second'}];
  await ensureState(ctx, input('ses_d', parts));
  await new Promise(r => setImmediate(r));
  assert.equal(client._promptCalls.length, 0, 'sending 中不重复发');
  assert.ok(
    ctx.pendingStore.map.has('ses_d'),
    'pending 保留（等待首次发送完成）'
  );
});
