import {gateModel} from '@/gate';
import {probeKey, getOrProbe, type ProbeClient, type ProbeStore} from '@/probe';
import {
  getStage,
  seededRules,
  unlockRules,
  extractSessionDenies,
  STAGE_PERMISSION,
  type Rule,
  type Stage,
} from '@/stage';
import {verifyText, type VerifyTerms} from '@/verify';
import {
  hasInjectionMarker,
  buildInjectionPart,
  filterFirstTurnSystem,
  newPartId,
  type FirstTurnFilter,
} from '@/inject';
import {savePendingStore, type PendingStore} from '@/pending';
import {sendRound2, type Round2Ctx} from '@/round2';
import {lastCompactionBoundary} from '@/epoch';
import type {Logger} from '@/logger';

export type CoreClient = {
  session: {
    get(opts: {path: {id: string}}): Promise<{
      directory: string;
      agent: string;
      parentID?: string;
      model?: {id: string; providerID: string};
      /** wire 兼容：新会话可能无 permission 字段（serve 实测）→ 调用方需 `?? []`。 */
      permission?: Rule[];
    }>;
    update(opts: {
      path: {id: string};
      body: {permission?: Rule[]};
    }): Promise<unknown>;
    messages(opts: {path: {id: string}}): Promise<
      Array<{
        info: {role?: string};
        parts: Array<{type: string; text?: unknown}>;
      }>
    >;
  };
  app: {
    /** wire Agent 用 `name` 标识（serve 实测 `/agent` 无 id 字段；permission
     * 为 Rule[] 形，可能缺省）。 */
    agents(): Promise<Array<{name: string; permission?: Rule[]}>>;
  };
};

export type EnsureOptions = {
  models: string[];
  whitelist: string[];
  verifyN: number;
  verifyTerms: VerifyTerms;
  probeTtlMs: number;
  /** 首轮注入选择性剥离（D11 备选；默认全量注入）。 */
  firstTurnFilter?: FirstTurnFilter;
  /** 关闭首轮 user 注入（零注入形态：首轮纯 minimal + 真实消息）。 */
  injectSystem?: boolean;
  /** 零工具锚定轮（zero-anchored）：首轮 prepend 固定锚定消息，不注入 system；
   * 优先于 injectSystem。 */
  anchorText?: string;
  /** TUI toast 提示开关（触发/生效的可见标记；默认开启）。 */
  toast?: boolean;
};

/** TUI toast：fire-and-forget，不阻塞 hook 链路。 */
export type ToastFn = (opts: {
  title?: string;
  message: string;
  variant: 'info' | 'success' | 'warning' | 'error';
}) => void;

export type EnsureCtx = {
  client: CoreClient & ProbeClient;
  options: EnsureOptions;
  logger: Logger;
  probeStore: ProbeStore;
  probeSessions: Map<string, string>;
  giveupOnce: Set<string>;
  pendingStore: PendingStore;
  pendingFile: string;
  toast?: ToastFn;
};

export type EnsureInput = {
  sessionID: string;
  model: {providerID: string; modelID: string};
  messageID: string;
  outputParts: Array<{type: string; [k: string]: unknown}>;
};

export type EnsureResult = {
  action:
    | 'none'
    | 'bypass'
    | 'seeded'
    | 'unlock'
    | 'verify'
    | 'giveup'
    | 'pending'
    | 'verified';
  stage: Stage;
};

export const MINIMAL_PERSONA = 'You are a helpful software engineer assistant.';

/** 锚定 part：纯 dsh 原文（round-9 实测首轮任何额外内容都破坏 we 锚定，不拼
 * 幂等标记）；synthetic → TUI 隐藏、模型可见。 */
function anchorPart(
  input: EnsureInput,
  anchorText: string
): EnsureInput['outputParts'][number] {
  return {
    id: newPartId(),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: 'text',
    text: anchorText,
    synthetic: true,
  };
}

/** output.parts 原地替换为锚定消息（同数组引用，splice）。 */
function replaceWithAnchor(input: EnsureInput, anchorText: string): void {
  input.outputParts.splice(
    0,
    input.outputParts.length,
    anchorPart(input, anchorText)
  );
}

/**
 * chat.message ensure 全流程（round-7/8 收敛：解锁/判别/注入都在此）：
 * 门控 → 旁路判定 → 阶段判定 → 注入 → 解锁（边界后信号）→ 判别（N=3 窗口）。
 * 所有 session.update 在本函数 await 内完成 → 本次请求生效。
 */
export async function ensureState(
  ctx: EnsureCtx,
  input: EnsureInput
): Promise<EnsureResult> {
  const {client, options, logger} = ctx;
  // 探针会话的消息跳过：探针 runLoop 内触发 chat.message，若再走 ensureState
  // 会在 getOrProbe 的 inFlight 上自等（与探针 prompt 互等死锁）。
  if (ctx.probeSessions.has(input.sessionID))
    return {action: 'none', stage: 'pristine'};
  if (!gateModel(input.model, options.models))
    return {action: 'none', stage: 'pristine'};

  const session = await client.session.get({path: {id: input.sessionID}});
  const key = probeKey(session.directory, session.agent, input.model.modelID);

  const probe = await getOrProbe(client, ctx.probeStore, key, {
    probeTtlMs: options.probeTtlMs,
    agent: session.agent,
    model: input.model,
    directory: session.directory,
    probeSessions: ctx.probeSessions,
  });
  if (probe.bypass) {
    logger.warn('bypass', {key, reason: 'probe failed or ttl'});
    // wire 兼容：新会话 GET /session/:id 可能无 permission 字段（serve 实测）
    ctx.toast?.({
      title: 'dsv4-anchored',
      message: '探针失败，本次按原生处理（bypass）',
      variant: 'warning',
    });
    return {action: 'bypass', stage: getStage(session.permission ?? [])};
  }

  const history = await client.session.messages({path: {id: input.sessionID}});
  const boundary = lastCompactionBoundary(history);
  const allParts = history.flatMap(m => m.parts);
  const stage = getStage(session.permission ?? []);
  const post = boundary === -1 ? history : history.slice(boundary + 1);
  const anchorDone = post.some(m => m.info.role === 'assistant');

  let injected = false;
  let anchored = false;
  // zero-anchored 锚定轮（D13 §4.5）：真实消息推迟 pending，首轮只有锚定消息。
  // 状态推导 = pending 存在性 + 边界后 assistant 消息（锚定回复），不用标记。
  const anchorText = options.anchorText;
  const anchorMode =
    Boolean(anchorText) && (stage === 'pristine' || stage === 'seeded');
  if (anchorMode && anchorText) {
    const pending = ctx.pendingStore.map.get(input.sessionID);
    if (pending) {
      if (anchorDone) {
        // 悬挂补发（重启/轮 2 失败后）：pending 已存 + 锚定回复已落库 →
        // 补发轮 2（sendRound2 发前清 pending 防重）；当前消息正常放行
        // （不推迟——避免当前消息变空 placeholder + 空 user run）。
        void sendRound2(ctx as Round2Ctx, input.sessionID);
      } else {
        // 锚定轮进行中/中断重试：当前消息继续推迟
        pending.parts.push(...input.outputParts);
        void savePendingStore(ctx.pendingStore, ctx.pendingFile);
        replaceWithAnchor(input, anchorText);
        anchored = true;
      }
    } else if (!anchorDone) {
      // 首轮锚定：真实 parts 存盘 pending，parts 替换为锚定消息
      ctx.pendingStore.map.set(input.sessionID, {
        parts: input.outputParts.map(p => ({...p})),
        messageID: input.messageID,
        ts: Date.now(),
      });
      void savePendingStore(ctx.pendingStore, ctx.pendingFile);
      replaceWithAnchor(input, anchorText);
      anchored = true;
      ctx.toast?.({
        title: 'dsv4-anchored',
        message: '锚定轮：真实任务推迟，下一轮自动发出',
        variant: 'info',
      });
    }
    // pending 无 + 锚定已落库（旧会话/轮 2 已发出）→ 正常放行
  } else if (
    stage === 'unsealed' &&
    options.injectSystem !== false &&
    !hasInjectionMarker(allParts) &&
    probe.system
  ) {
    // 注入 user system（D13 轮 2 由 sendRound2 携带；此路径为后续消息/resume
    // 兜底）：去 opencode persona（default.txt 段），保留行为要求/env/AGENTS/
    // 技能/MCP；工具已由 unlock 恢复全量。
    const system = options.firstTurnFilter
      ? filterFirstTurnSystem(probe.system, options.firstTurnFilter)
      : probe.system;
    input.outputParts.unshift(
      buildInjectionPart(system, input.sessionID, input.messageID)
    );
    injected = true;
  }
  logger.info('chat.message', {
    sessionID: input.sessionID,
    stage,
    gating: 'hit',
    injectSource: anchored ? 'anchor' : injected ? 'probe' : 'none',
    subagent: session.parentID !== undefined,
  });

  if (stage === 'pristine') {
    await client.session.update({
      path: {id: input.sessionID},
      body: {permission: seededRules(options.whitelist)},
    });
    return {action: 'seeded', stage: 'seeded'};
  }

  if (stage === 'seeded' || stage === 'unsealed') {
    const hasSignal = post.some(
      m => m.info.role === 'assistant' || m.parts.some(p => p.type === 'tool')
    );
    if (stage === 'seeded' && hasSignal) {
      const agents = await client.app.agents();
      const agentRuleset =
        agents.find(a => a.name === session.agent)?.permission ?? [];
      const denies = extractSessionDenies(session.permission ?? []);
      await client.session.update({
        path: {id: input.sessionID},
        body: {permission: unlockRules(agentRuleset, denies)},
      });
      logger.info('unlock', {sessionID: input.sessionID, agent: session.agent});
      ctx.toast?.({
        title: 'dsv4-anchored',
        message: '工具已解锁（agent ruleset 恢复）',
        variant: 'success',
      });
      return {action: 'unlock', stage: 'unsealed'};
    }

    const assistants = post.filter(m => m.info.role === 'assistant');
    for (const m of assistants) {
      const text = m.parts
        .filter(p => p.type === 'reasoning' || p.type === 'text')
        .map(p => String(p.text ?? ''))
        .join('\n');
      if (text && verifyText(text, options.verifyTerms)) {
        await client.session.update({
          path: {id: input.sessionID},
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
        logger.info('verify.passed', {
          sessionID: input.sessionID,
          checked: assistants.length,
        });
        ctx.toast?.({
          title: 'dsv4-anchored',
          message: '锚定判别通过（verified）',
          variant: 'success',
        });
        return {action: 'verify', stage: 'verified'};
      }
    }
    if (assistants.length >= options.verifyN) {
      if (!ctx.giveupOnce.has(input.sessionID)) {
        ctx.giveupOnce.add(input.sessionID);
        logger.warn('verify.giveup', {
          sessionID: input.sessionID,
          checked: assistants.length,
        });
      }
      return {action: 'giveup', stage};
    }
    return {action: 'pending', stage};
  }

  return {action: 'verified', stage};
}
