import {
  probeTerminationError,
  captureProbeSystem,
  probeKey,
  type ProbeStore,
} from '@/probe';
import {MINIMAL_PERSONA, type CoreClient, type EnsureOptions} from '@/core';
import {gateModel} from '@/gate';
import type {Logger} from '@/logger';

export type TransformCtx = {
  client: CoreClient;
  probeStore: ProbeStore;
  probeSessions: Map<string, string>;
  options: EnsureOptions;
  logger: Logger;
};

export type TransformInput = {
  sessionID?: string;
  model: {providerID: string; modelID: string};
};

/**
 * system.transform：
 * 1. 探针会话（sessionID ∈ probeSessions）→ 捕获 system 全文写缓存 → throw
 *    （禁词规避，不触发 retry；request.ts:69 早于 llmClient.stream → 零 token）
 * 2. gate 命中且非 bypass → 替换为纯 Minimal persona
 * 3. bypass / 门控不命中 → 原样放行
 */
export async function systemTransform(
  ctx: TransformCtx,
  input: TransformInput,
  output: {system: string[]}
): Promise<void> {
  if (input.sessionID !== undefined) {
    const key = ctx.probeSessions.get(input.sessionID);
    if (key !== undefined) {
      const system = output.system.join('\n');
      captureProbeSystem(ctx.probeStore, key, system);
      ctx.logger.info('probe.success', {key, sysLen: system.length});
      throw probeTerminationError();
    }
  }
  if (!gateModel(input.model, ctx.options.models)) return;
  if (input.sessionID === undefined) return;

  // 标题生成请求（title agent 的 llm.stream，prompt.ts:224-249）：system 里
  // 含 title.txt 指令（"You are a title generator..." / "Generate a title" /
  // "thread title"）——不替换，否则标题指令丢失导致乱标题（实测 `<tool_calls>`）。
  const systemText = output.system.join('\n');
  if (
    systemText.includes('You are a title generator') ||
    systemText.includes('Generate a title') ||
    systemText.includes('thread title')
  ) {
    ctx.logger.info('system.transform.title-bypass', {
      sessionID: input.sessionID,
      head: systemText.slice(0, 120),
    });
    return;
  }

  const session = await ctx.client.session.get({path: {id: input.sessionID}});
  if (ctx.options.skipSubagents === true && session.parentID !== undefined) {
    ctx.logger.info('system.transform.subagent-skip', {
      sessionID: input.sessionID,
      agent: session.agent,
    });
    return;
  }
  const key = probeKey(session.directory, session.agent, input.model.modelID);
  const cached = ctx.probeStore.map.get(key);
  if (
    cached?.status === 'failed' &&
    Date.now() - cached.ts < ctx.options.probeTtlMs
  )
    return;

  const beforeLen = output.system.join('\n').length;
  // 原地替换数组内容：plugin.trigger 忽略返回值，request.ts 用局部 system
  // 数组（同引用）——重新赋值 output.system 不会生效，必须 splice 原地改。
  output.system.splice(0, output.system.length, MINIMAL_PERSONA);
  ctx.logger.info('system.transform', {
    sessionID: input.sessionID,
    action: 'replace',
    beforeLen,
    afterLen: MINIMAL_PERSONA.length,
  });
}
