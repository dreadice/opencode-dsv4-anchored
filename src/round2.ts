import {
  filterFirstTurnSystem,
  buildInjectionPart,
  injectionMarkerFor,
} from '@/inject';
import {probeKey, type ProbeStore} from '@/probe';
import {savePendingStore, type PendingStore} from '@/pending';
import {getStage, STAGE_PERMISSION, type Rule} from '@/stage';
import {verifyText} from '@/verify';
import {lastCompactionBoundary} from '@/epoch';
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
        parentID?: string;
        model?: {id: string; providerID: string};
        permission?: Rule[];
      }>;
      messages(opts: {path: {id: string}}): Promise<
        Array<{
          info: {role?: string};
          parts: Array<{type: string; text?: unknown}>;
        }>
      >;
      update(opts: {
        path: {id: string};
        body: {permission?: Rule[]};
      }): Promise<unknown>;
      prompt(opts: {
        path: {id: string};
        body: {
          parts: Array<Record<string, unknown>>;
          agent?: string;
          model?: {providerID: string; modelID: string};
          noReply?: boolean;
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

/**
 * 轮 2 完成后立即补一次判别：如果此时已经 `unsealed` 且历史 assistant 消息
 * 命中 `verifyText`，直接追加 `verified` 哨兵并 toast，避免用户必须再发一条
 * 消息才看到 verified。
 */
async function verifyAfterRound2(
  ctx: Round2Ctx,
  sessionID: string
): Promise<void> {
  const session = await ctx.client.session.get({path: {id: sessionID}});
  const stage = getStage(session.permission ?? []);
  if (stage !== 'unsealed') return;
  const history = await ctx.client.session.messages({path: {id: sessionID}});
  const boundary = lastCompactionBoundary(history);
  const post = boundary === -1 ? history : history.slice(boundary + 1);
  const assistants = post.filter(m => m.info.role === 'assistant');
  for (const m of assistants) {
    const text = m.parts
      .filter(p => p.type === 'reasoning' || p.type === 'text')
      .map(p => String(p.text ?? ''))
      .join('\n');
    if (text && verifyText(text, ctx.options.verifyTerms)) {
      await ctx.client.session.update({
        path: {id: sessionID},
        body: {
          permission: [
            {
              permission: STAGE_PERMISSION,
              pattern: 'verified',
              action: 'allow',
            },
          ],
        },
      });
      ctx.logger.info('verify.passed', {
        sessionID,
        checked: assistants.length,
      });
      ctx.toast?.({
        title: 'dsv4-anchored',
        message: '锚定判别通过（verified）',
        variant: 'success',
      });
      return;
    }
  }
  if (assistants.length >= ctx.options.verifyN) {
    ctx.logger.warn('verify.giveup', {sessionID, checked: assistants.length});
  }
}

export async function sendRound2(
  ctx: Round2Ctx,
  sessionID: string
): Promise<boolean> {
  const {map, sending} = ctx.pendingStore;
  if (sending.has(sessionID)) return false;
  const pending = map.get(sessionID);
  if (!pending) return false;
  let firstSent = false;
  try {
    const session = await ctx.client.session.get({path: {id: sessionID}});
    if (ctx.options.skipSubagents === true && session.parentID !== undefined) {
      map.delete(sessionID);
      void savePendingStore(ctx.pendingStore, ctx.pendingFile);
      ctx.logger.info('round2.subagent-skip', {
        sessionID,
        agent: session.agent,
      });
      return false;
    }
    // 防重：发送前清 pending（内存 + 磁盘）
    map.delete(sessionID);
    void savePendingStore(ctx.pendingStore, ctx.pendingFile);
    sending.add(sessionID);
    const model = session.model
      ? {providerID: session.model.providerID, modelID: session.model.id}
      : undefined;
    const systemPart = buildSystemPart(ctx, session, sessionID, pending);

    if (systemPart) {
      // 1) 真实任务先入库（noReply 不跑，标题生成只看这条，看不到 system）
      await ctx.client.session.prompt({
        path: {id: sessionID},
        body: {
          parts: pending.parts,
          agent: session.agent,
          model,
          noReply: true,
        },
      });
      firstSent = true;
      // 2) 注入 system 的消息再跑（synthetic，TUI 隐藏）
      const promptPromise = ctx.client.session.prompt({
        path: {id: sessionID},
        body: {
          parts: [systemPart],
          agent: session.agent,
          model,
        },
      });
      ctx.toast?.({
        title: 'dsv4-anchored',
        message: '轮 2 已自动发出（真实任务 + 完整工具）',
        variant: 'info',
      });
      await promptPromise;
    } else {
      // 没有 system 可注入时，直接跑真实任务
      const promptPromise = ctx.client.session.prompt({
        path: {id: sessionID},
        body: {
          parts: pending.parts,
          agent: session.agent,
          model,
        },
      });
      ctx.toast?.({
        title: 'dsv4-anchored',
        message: '轮 2 已自动发出（真实任务 + 完整工具）',
        variant: 'info',
      });
      await promptPromise;
    }
    ctx.logger.info('round2.sent', {
      sessionID,
      partCount: pending.parts.length + (systemPart ? 1 : 0),
      sysInjected: Boolean(systemPart),
    });
    await verifyAfterRound2(ctx, sessionID);
    return true;
  } catch (error) {
    if (!firstSent) {
      map.set(sessionID, pending);
      void savePendingStore(ctx.pendingStore, ctx.pendingFile);
    }
    ctx.logger.warn('round2.fail', {sessionID, error: String(error)});
    return false;
  } finally {
    sending.delete(sessionID);
  }
}

function buildSystemPart(
  ctx: Round2Ctx,
  session: {
    directory: string;
    agent: string;
    model?: {id: string; providerID: string};
  },
  sessionID: string,
  pending: {messageID: string}
): Record<string, unknown> | undefined {
  if (ctx.options.injectSystem === false) return undefined;
  const key = probeKey(
    session.directory,
    session.agent,
    session.model?.id ?? ''
  );
  const probe = ctx.probeStore.map.get(key);
  if (probe?.status !== 'ok') return undefined;
  const system = ctx.options.firstTurnFilter
    ? filterFirstTurnSystem(probe.system, ctx.options.firstTurnFilter)
    : probe.system;
  return buildInjectionPart(
    system,
    sessionID,
    pending.messageID,
    injectionMarkerFor(session.agent, session.model?.id ?? '')
  );
}
