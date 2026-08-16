import {
  filterFirstTurnSystem,
  buildInjectionPart,
  injectionMarkerFor,
} from '@/inject';
import {probeKey, type ProbeStore} from '@/probe';
import {savePendingStore, type PendingStore} from '@/pending';
import type {EnsureOptions, ToastFn} from '@/core';
import type {Logger} from '@/logger';

/**
 * 轮 2（真实任务轮，D13 §4.5）：把 pending 的真实消息 + user system（探针
 * 捕获 → 去 persona）作为新 user 消息发出（不带 tools → 不替换 permission；
 * 消息 id 单调 → 排在锚定消息后）。
 * - 防重：发送前先清 pending（内存 + 磁盘），sending 集合防并发——idle/
 *   ensure 多次触发不重复发；
 * - 失败：恢复 pending（ensure 补发兜底）；
 * - 必须在 session 空闲时调用（busy 时 runner 丢弃新 runLoop，research §4.12）
 *   ——正常由 `session.idle` 触发，悬挂场景由 ensure 补发。
 */
export type Round2Ctx = {
  client: {
    session: {
      get(opts: {path: {id: string}}): Promise<{
        directory: string;
        agent: string;
        model?: {id: string; providerID: string};
      }>;
      prompt(opts: {
        path: {id: string};
        body: {
          parts: Array<Record<string, unknown>>;
          agent?: string;
          model?: {providerID: string; modelID: string};
        };
      }): Promise<unknown>;
    };
  };
  options: EnsureOptions;
  logger: Logger;
  probeStore: ProbeStore;
  pendingStore: PendingStore;
  pendingFile: string;
  toast?: ToastFn;
};

export async function sendRound2(
  ctx: Round2Ctx,
  sessionID: string
): Promise<boolean> {
  const {map, sending} = ctx.pendingStore;
  if (sending.has(sessionID)) return false;
  const pending = map.get(sessionID);
  if (!pending) return false;
  // 防重：发送前清 pending（内存 + 磁盘）
  map.delete(sessionID);
  void savePendingStore(ctx.pendingStore, ctx.pendingFile);
  sending.add(sessionID);
  try {
    const session = await ctx.client.session.get({path: {id: sessionID}});
    const parts: Array<Record<string, unknown>> = [];
    if (ctx.options.injectSystem !== false) {
      const key = probeKey(
        session.directory,
        session.agent,
        session.model?.id ?? ''
      );
      const probe = ctx.probeStore.map.get(key);
      if (probe?.status === 'ok') {
        const system = ctx.options.firstTurnFilter
          ? filterFirstTurnSystem(probe.system, ctx.options.firstTurnFilter)
          : probe.system;
        parts.push(
          buildInjectionPart(
            system,
            sessionID,
            pending.messageID,
            injectionMarkerFor(session.agent, session.model?.id ?? '')
          )
        );
      }
    }
    parts.push(...pending.parts);
    await ctx.client.session.prompt({
      path: {id: sessionID},
      body: {
        parts,
        agent: session.agent,
        model: session.model
          ? {providerID: session.model.providerID, modelID: session.model.id}
          : undefined,
      },
    });
    ctx.logger.info('round2.sent', {
      sessionID,
      partCount: parts.length,
      sysInjected: parts.length > pending.parts.length,
    });
    ctx.toast?.({
      title: 'dsv4-anchored',
      message: '轮 2 已自动发出（真实任务 + 完整工具）',
      variant: 'info',
    });
    return true;
  } catch (error) {
    map.set(sessionID, pending);
    void savePendingStore(ctx.pendingStore, ctx.pendingFile);
    ctx.logger.warn('round2.fail', {sessionID, error: String(error)});
    return false;
  } finally {
    sending.delete(sessionID);
  }
}
