import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendRound2, type Round2Ctx} from '@/round2';
import {ensureState, type EnsureCtx} from '@/core';
import {createProbeStore, captureProbeSystem, probeKey} from '@/probe';
import {createPendingStore, type PendingStore} from '@/pending';
import {makeLogger} from '@/logger';
import {DEFAULT_TERMS} from '@/verify';
import {getStage} from '@/stage';
import {INJECT_MARKER} from '@/inject';
import {createFakeClient, addSession, user} from './fake-client.ts';

const OPTIONS = {
  models: ['deepseek*v4*'],
  whitelist: [],
  verifyN: 3,
  verifyTerms: DEFAULT_TERMS,
  probeTtlMs: 300000,
};

const MODEL = {providerID: 'opencode', modelID: 'deepseek-v4-flash-free'};

function makeCtx(): {
  ctx: Round2Ctx;
  client: ReturnType<typeof createFakeClient>;
  pendingStore: PendingStore;
} {
  const client = createFakeClient();
  const pendingStore = createPendingStore();
  const ctx: Round2Ctx = {
    client: client as unknown as Round2Ctx['client'],
    options: {...OPTIONS},
    logger: makeLogger(client.app.log.bind(client.app), {debugEnabled: false}),
    probeStore: createProbeStore(),
    pendingStore,
    pendingFile: '/tmp/dsv4-pending-test.json',
    toast: opts => {
      void client.tui.showToast({body: opts});
    },
  };
  return {ctx, client, pendingStore};
}

function seedProbe(ctx: Round2Ctx, directory = '/proj', agent = 'build') {
  const key = probeKey(directory, agent, MODEL.modelID);
  captureProbeSystem(ctx.probeStore, key, 'SYSTEM-FULL');
  return key;
}

test('TC-2-28: session.idle → 轮 2 自动发出（user system + pending 真实 parts，清 pending）', async () => {
  const {ctx, client, pendingStore} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1'});
  pendingStore.map.set('ses_1', {
    parts: [{type: 'text', text: 'real task'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  let promptBody: unknown;
  client.setPromptHandler(async (id, body) => {
    promptBody = body;
    return {};
  });
  const ok = await sendRound2(ctx, 'ses_1');
  assert.equal(ok, true);
  assert.equal(
    pendingStore.map.has('ses_1'),
    false,
    '发送前清 pending（防重）'
  );
  assert.ok(
    client._toasts.some(t => t.message.includes('轮 2 已自动发出')),
    '轮 2 应发 TUI toast'
  );
  const body = promptBody as {
    parts: Array<Record<string, unknown>>;
    agent: string;
    model: {providerID: string; modelID: string};
  };
  assert.equal(body.agent, 'build');
  assert.deepEqual(body.model, {
    providerID: 'opencode',
    modelID: MODEL.modelID,
  });
  assert.ok(!('tools' in body), '轮 2 不带 tools（不替换 permission）');
  const texts = body.parts.map(p => String(p.text ?? ''));
  assert.ok(texts[0]!.includes(INJECT_MARKER), 'user system part 在前');
  assert.ok(texts[0]!.includes('SYSTEM-FULL'), '探针捕获 system');
  assert.ok(texts[1]!.includes('real task'), 'pending 真实消息在后');
  assert.ok(
    client._logs.some(l => l.msg.includes('round2.sent')),
    'round2.sent 日志'
  );
});

test('TC-2-28b: firstTurnFilter stripPersona 应用到轮 2 user system', async () => {
  const {ctx, client, pendingStore} = makeCtx();
  seedProbe(ctx);
  ctx.options.firstTurnFilter = {stripPersona: true};
  addSession(client, {id: 'ses_1'});
  pendingStore.map.set('ses_1', {
    parts: [{type: 'text', text: 't'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  let promptBody: unknown;
  client.setPromptHandler(async (id, body) => {
    promptBody = body;
    return {};
  });
  await sendRound2(ctx, 'ses_1');
  const parts = (promptBody as {parts: Array<{text?: string}>}).parts;
  assert.ok(
    !String(parts[0]!.text).includes('You are opencode'),
    '去 persona 首句'
  );
});

test('TC-2-29: 轮 2 prompt 失败 → round2.fail + pending 恢复（ensure 补发兜底）', async () => {
  const {ctx, client, pendingStore} = makeCtx();
  seedProbe(ctx);
  addSession(client, {id: 'ses_1'});
  const entry = {
    parts: [{type: 'text', text: 'real task'}],
    messageID: 'msg_1',
    ts: Date.now(),
  };
  pendingStore.map.set('ses_1', entry);
  client.setPromptHandler(async () => {
    throw new Error('network unreachable');
  });
  const ok = await sendRound2(ctx, 'ses_1');
  assert.equal(ok, false);
  assert.deepEqual(pendingStore.map.get('ses_1'), entry, '失败后恢复 pending');
  assert.ok(client._logs.some(l => l.msg.includes('round2.fail')));
});

test('TC-2-31b: 无 pending / sending 中 → 不发', async () => {
  const {ctx, client, pendingStore} = makeCtx();
  addSession(client, {id: 'ses_1'});
  const ok1 = await sendRound2(ctx, 'ses_1');
  assert.equal(ok1, false, '无 pending 不发');
  assert.equal(client._promptCalls.length, 0);

  pendingStore.map.set('ses_1', {
    parts: [{type: 'text', text: 't'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  pendingStore.sending.add('ses_1');
  const ok2 = await sendRound2(ctx, 'ses_1');
  assert.equal(ok2, false, 'sending 中不重复发');
  assert.ok(pendingStore.map.has('ses_1'), 'pending 保留');
});

test('TC-2-28c: 探针缓存缺（异常态）→ 轮 2 仍发（无 user system part，真实消息不丢）', async () => {
  const {ctx, client, pendingStore} = makeCtx();
  addSession(client, {id: 'ses_1'});
  pendingStore.map.set('ses_1', {
    parts: [{type: 'text', text: 'real task'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  let promptBody: unknown;
  client.setPromptHandler(async (id, body) => {
    promptBody = body;
    return {};
  });
  await sendRound2(ctx, 'ses_1');
  const parts = (promptBody as {parts: Array<{text?: string}>}).parts;
  assert.equal(parts.length, 1, '只有真实消息');
  assert.equal(String(parts[0]!.text), 'real task');
});

test('TC-2-28d: 轮 2 消息入库（fake prompt 持久化）→ ensure 解锁', async () => {
  const {ctx, client, pendingStore} = makeCtx();
  seedProbe(ctx);
  addSession(client, {
    id: 'ses_1',
    permission: [
      {permission: '__dsv4_stage__', pattern: 'seeded', action: 'allow'},
    ],
  });
  client._messages.set('ses_1', [
    user('msg_anchor', [{type: 'text', text: 'anchor', synthetic: true}]),
    {
      info: {id: 'msg_reply', role: 'assistant'},
      parts: [{type: 'reasoning', text: 'We need to answer.'}],
    },
  ]);
  pendingStore.map.set('ses_1', {
    parts: [{type: 'text', text: 'real task'}],
    messageID: 'msg_1',
    ts: Date.now(),
  });
  // fake prompt 模拟 serve：把轮 2 消息持久化到 _messages（触发后续 ensure 能看到）
  client.setPromptHandler(async (id, body) => {
    const existing = client._messages.get(id) ?? [];
    client._messages.set(id, [
      ...existing,
      user('msg_r2', (body as {parts: unknown[]}).parts),
    ]);
    return {};
  });
  await sendRound2(ctx, 'ses_1');
  assert.ok(
    client._messages.get('ses_1')!.some(m => m.info.id === 'msg_r2'),
    '轮 2 消息已入库'
  );
  // 用户下一条消息 → ensure：seeded + 历史 assistant 信号 → 解锁
  const coreCtx = {
    client: client as unknown as EnsureCtx['client'],
    options: OPTIONS,
    logger: ctx.logger,
    probeStore: ctx.probeStore,
    probeSessions: new Map<string, string>(),
    giveupOnce: new Set<string>(),
    pendingStore,
    pendingFile: ctx.pendingFile,
  };
  const parts: unknown[] = [{type: 'text', text: 'hi'}];
  const res = await ensureState(coreCtx, {
    sessionID: 'ses_1',
    model: MODEL,
    messageID: 'msg_next',
    outputParts: parts as never,
  });
  assert.equal(res.action, 'unlock');
  assert.equal(getStage(client._sessions.get('ses_1')!.permission), 'unsealed');
});
