import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureState, type EnsureCtx, type EnsureInput} from '@/core';
import {sendRound2, type Round2Ctx} from '@/round2';
import {createProbeStore, captureProbeSystem, probeKey} from '@/probe';
import {createPendingStore} from '@/pending';
import {makeLogger} from '@/logger';
import {DEFAULT_TERMS} from '@/verify';
import {injectionMarkerFor} from '@/inject';
import {getStage, type Rule} from '@/stage';
import {
  createFakeClient,
  addSession,
  user,
  assistant,
  reasoning,
  textPart,
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
  ctx: EnsureCtx & Round2Ctx;
  client: ReturnType<typeof createFakeClient>;
} {
  const client = createFakeClient();
  const ctx = {
    client: client as unknown as EnsureCtx['client'],
    options: {...OPTIONS},
    logger: makeLogger(client.app.log.bind(client.app), {debugEnabled: false}),
    probeStore: createProbeStore(),
    probeSessions: new Map<string, string>(),
    giveupOnce: new Set<string>(),
    pendingStore: createPendingStore(),
    pendingFile: '/tmp/dsv4-pending-test.json',
    toast: (opts: {title?: string; message: string; variant: string}) => {
      void client.tui.showToast({body: opts});
    },
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

function seedProbe(
  ctx: EnsureCtx & Round2Ctx,
  directory = '/proj',
  agent = 'build'
): string {
  const key = probeKey(directory, agent, MODEL.modelID);
  captureProbeSystem(ctx.probeStore, key, `SYSTEM-${agent.toUpperCase()}`);
  return key;
}

const sentinel = (pattern: string): Rule => ({
  permission: '__dsv4_stage__',
  pattern,
  action: 'allow',
});

test('build 会话完整结束后，新建 custom 会话仍触发锚定并注入 custom system', async () => {
  const {ctx, client} = makeCtx();
  ctx.options.anchorText = 'ANCHOR';
  seedProbe(ctx, '/proj', 'build');
  seedProbe(ctx, '/proj', 'custom');

  // 1) 第一个会话使用内置 build agent，完整走完锚定流程
  addSession(client, {id: 'ses_build'});
  const buildParts = [textPart('build task')];
  await ensureState(ctx, input('ses_build', buildParts));
  assert.equal(
    (buildParts[0] as {text: string}).text,
    'ANCHOR',
    'build 首轮应锚定'
  );

  // 模拟锚定回复落库 + 用户继续：触发 unlock 与自动轮 2
  client._messages.set('ses_build', [
    user('msg_anchor', [textPart('ANCHOR')]),
    assistant('msg_reply', [reasoning('We need to complete the build.')]),
  ]);
  client.setPromptHandler(async () => ({}));
  const nextBuildParts = [textPart('continue build')];
  await ensureState(ctx, input('ses_build', nextBuildParts));
  await new Promise(r => setImmediate(r));
  assert.equal(
    getStage(client._sessions.get('ses_build')!.permission),
    'verified',
    'build 会话应完成到 verified'
  );
  assert.equal(
    ctx.pendingStore.map.has('ses_build'),
    false,
    'build 会话 pending 应已清空'
  );

  // 2) 第二个会话使用自定义 agent，首轮应重新触发锚定
  addSession(client, {id: 'ses_custom', agent: 'custom'});
  const customParts = [textPart('custom task')];
  const customRes = await ensureState(ctx, input('ses_custom', customParts));
  assert.equal(customRes.action, 'seeded');
  assert.equal(
    (customParts[0] as {text: string}).text,
    'ANCHOR',
    'custom 新会话首轮应锚定'
  );
  assert.ok(
    ctx.pendingStore.map.has('ses_custom'),
    'custom 真实任务应进入 pending'
  );

  // 3) custom 会话轮 2 必须使用 custom agent 并注入 custom system
  const before = client._promptCalls.length;
  const ok = await sendRound2(ctx, 'ses_custom');
  assert.equal(ok, true);
  const customCalls = client._promptCalls.slice(before);
  assert.equal(customCalls.length, 2, '轮 2 应发两条消息');
  const [first, second] = customCalls.map(
    c =>
      c.body as {
        parts: Array<{text?: string}>;
        agent: string;
        model?: {providerID: string; modelID: string};
        noReply?: boolean;
      }
  );
  assert.equal(first.agent, 'custom', '真实任务先入库存 custom agent');
  assert.equal(first.noReply, true);
  assert.equal(String(first.parts[0]!.text), 'custom task');
  assert.equal(second.agent, 'custom', '注入消息使用 custom agent');
  const text = String(second.parts[0]!.text);
  assert.ok(
    text.includes(injectionMarkerFor('custom', MODEL.modelID)),
    '注入标记应包含 custom agent/model'
  );
  assert.ok(
    text.includes('SYSTEM-CUSTOM'),
    '应注入 custom 自己的探针捕获 system'
  );
});

test('动态 AGENTS.md：Read 工具输出中的 Instructions from 不被插件改动', async () => {
  const {ctx, client} = makeCtx();
  seedProbe(ctx, '/proj', 'build');
  addSession(client, {id: 'ses_agents', permission: [sentinel('unsealed')]});

  const dynamicAgentsOutput =
    '<system-reminder>\n' +
    'Instructions from: /tmp/opencode/smoke/e2e/AGENTS.md\n' +
    '# e2e/AGENTS.md\n\n' +
    'When reading files under e2e/, always mention E2E_RULE in your response.\n' +
    '</system-reminder>';
  client._messages.set('ses_agents', [
    user('msg_task', [textPart('read the report')]),
    assistant('msg_read', [
      {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          output: dynamicAgentsOutput,
          metadata: {loaded: ['/tmp/opencode/smoke/e2e/AGENTS.md']},
        },
      },
    ]),
  ]);

  const parts = [textPart('continue')];
  await ensureState(ctx, input('ses_agents', parts));

  const history = client._messages.get('ses_agents')!;
  const tool = history
    .find(m => m.info.role === 'assistant')
    ?.parts.find(p => p.type === 'tool') as {
    state?: {output?: string};
  };
  assert.ok(
    tool.state?.output?.includes(
      'Instructions from: /tmp/opencode/smoke/e2e/AGENTS.md'
    ),
    '历史 Read 工具输出中的 AGENTS.md 指令应保留'
  );
  assert.ok(
    tool.state?.output?.includes('E2E_RULE'),
    '动态 AGENTS.md 内容应保留'
  );
  assert.equal(
    (parts[1] as {text: string}).text,
    'continue',
    '当前真实消息应保留（前面是注入 part）'
  );
});
