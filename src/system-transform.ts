import {
  PROBE_THROW_MESSAGE,
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
      throw new Error(PROBE_THROW_MESSAGE);
    }
  }
  if (!gateModel(input.model, ctx.options.models)) return;
  if (input.sessionID === undefined) return;

  const session = await ctx.client.session.get({path: {id: input.sessionID}});
  const key = probeKey(session.directory, session.agent, input.model.modelID);
  const cached = ctx.probeStore.map.get(key);
  if (
    cached?.status === 'failed' &&
    Date.now() - cached.ts < ctx.options.probeTtlMs
  )
    return;

  const beforeLen = output.system.join('\n').length;
  output.system = [MINIMAL_PERSONA];
  ctx.logger.info('system.transform', {
    sessionID: input.sessionID,
    action: 'replace',
    beforeLen,
    afterLen: MINIMAL_PERSONA.length,
  });
}
