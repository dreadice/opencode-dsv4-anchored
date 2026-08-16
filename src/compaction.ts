import {compactionRules, getStage} from '@/stage';
import type {CoreClient} from '@/core';
import type {Logger} from '@/logger';

export type CompactingCtx = {
  client: CoreClient;
  logger: Logger;
};

/**
 * `experimental.session.compacting`（压缩前置事件）：会话含插件哨兵（已处理）
 * → 追加 compaction 回退规则（deny * + 配置白名单 + compactionTools + 哨兵
 * seeded，D5 修订；round-10：白名单参数化——回退 = 回 seeded 态 + compaction
 * 工具）。重注入/重判别由 chat.message ensureState 自然完成（无幂等标记即
 * 注入、判别窗口重置）。
 */
export async function compacting(
  ctx: CompactingCtx,
  sessionID: string,
  whitelist: string[]
): Promise<void> {
  const session = await ctx.client.session.get({path: {id: sessionID}});
  const stage = getStage(session.permission);
  if (stage === 'pristine') return;
  await ctx.client.session.update({
    path: {id: sessionID},
    body: {permission: compactionRules(whitelist)},
  });
  ctx.logger.warn('compaction.rollback', {sessionID});
}
