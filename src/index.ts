import type {Plugin, PluginOptions} from '@opencode-ai/plugin';
import type {Event} from '@opencode-ai/sdk';
import {ensureState, type EnsureOptions} from '@/core';
import {systemTransform} from '@/system-transform';
import {compacting} from '@/compaction';
import {loadProbeStore, saveProbeStore} from '@/probe';
import {loadPendingStore, savePendingStore} from '@/pending';
import {sendRound2, type Round2Ctx} from '@/round2';
import {makeLogger} from '@/logger';
import {DEFAULT_TERMS, type VerifyTerms} from '@/verify';
import type {FirstTurnFilter} from '@/inject';
import {adaptClient, adaptLog, adaptToast} from '@/sdk-adapter';
import {join} from 'node:path';
import {homedir} from 'node:os';
import pkg from '@package';

const PLUGIN_VERSION = pkg.version;

const DEFAULT_CACHE_DIR = join(
  homedir(),
  '.local/share/opencode/dsv4-anchored'
);

/** zero-anchored 锚定消息（dsh zero-anchored-standard 原文）。注意：不得具名
 * 导出（opencode 插件加载器要求模块所有导出都是函数，
 * `plugin/index.ts:94-109` getLegacyPlugins）。 */
const ZERO_ANCHOR_TEXT =
  'This round is a test. Tools are not open yet; all tools will open next round.';

type Dsv4Options = {
  models?: string[];
  whitelist?: string[];
  verifyN?: number;
  verifyTerms?: VerifyTerms;
  probeTtlMs?: number;
  cacheDir?: string;
  injectSystem?: boolean;
  anchorText?: string;
  firstTurnFilter?: FirstTurnFilter;
  /** TUI toast 提示（触发/生效的可见标记）；false 关闭。 */
  toast?: boolean;
};

function resolveOptions(options?: PluginOptions): EnsureOptions {
  const opts = (options ?? {}) as Dsv4Options;
  return {
    models: opts.models ?? ['deepseek*v4*'],
    // round-10 zero 形态：0 工具（round-9 实测双工具复现不了 we 锚定）
    whitelist: opts.whitelist ?? [],
    verifyN: opts.verifyN ?? 3,
    verifyTerms: opts.verifyTerms ?? DEFAULT_TERMS,
    probeTtlMs: opts.probeTtlMs ?? 300_000,
    // 默认注入去 opencode persona 的原始 system（dsh 思路：晋升信号后注入）
    firstTurnFilter: opts.firstTurnFilter ?? {stripPersona: true},
    injectSystem: opts.injectSystem,
    // zero-anchored 锚定轮默认启用；空字符串关闭（退回旧形态）
    anchorText:
      opts.anchorText === ''
        ? undefined
        : (opts.anchorText ?? ZERO_ANCHOR_TEXT),
    toast: opts.toast,
  };
}

export const Dsv4Anchored: Plugin = async ({client}, options) => {
  // 进程级单例：防止全局插件、项目插件、npm 配置同时加载导致双实例。
  // 第二个实例直接返回空 hooks，不参与任何事件/toast。
  const g = globalThis as unknown as {__dsv4AnchoredActive?: boolean};
  if (g.__dsv4AnchoredActive) return {};
  g.__dsv4AnchoredActive = true;

  const sdk = adaptClient(client);
  const eopts = resolveOptions(options);
  const cacheDir =
    ((options ?? {}) as Dsv4Options).cacheDir ?? DEFAULT_CACHE_DIR;
  const cacheFile = join(cacheDir, 'probe-cache.json');
  const pendingFile = join(cacheDir, 'pending.json');
  const probeStore = await loadProbeStore(cacheFile);
  const pendingStore = await loadPendingStore(pendingFile);
  const probeSessions = new Map<string, string>();
  const giveupOnce = new Set<string>();
  const logger = makeLogger(adaptLog(client));
  logger.info('plugin.loaded', {cacheDir, version: PLUGIN_VERSION});
  const toast = eopts.toast !== false ? adaptToast(client) : undefined;

  const ctx = {
    client: sdk,
    options: eopts,
    logger,
    probeStore,
    probeSessions,
    giveupOnce,
    pendingStore,
    pendingFile,
    toast,
  };

  return {
    'chat.message': async (input, output) => {
      // 健壮性（serve HTTP 实测）：POST /session/:id/message 不带 model 时
      // input.model 为 undefined——用 output.message.model（已解析）兜底。
      const model = input.model ?? output.message.model;
      if (!model) return;
      await ensureState(ctx, {
        sessionID: input.sessionID,
        model,
        messageID: output.message.id,
        outputParts: output.parts,
      });
      void saveProbeStore(probeStore, cacheFile);
      void savePendingStore(pendingStore, pendingFile);
    },
    'experimental.chat.system.transform': async (input, output) => {
      await systemTransform(
        {client: sdk, probeStore, probeSessions, options: eopts, logger},
        {
          sessionID: input.sessionID,
          model: {providerID: input.model.providerID, modelID: input.model.id},
        },
        output
      );
    },
    'experimental.session.compacting': async input => {
      await compacting({client: sdk, logger}, input.sessionID, eopts.whitelist);
    },
    event: async input => {
      // D13 轮 2 触发（round-10 修订）：session.idle 在 run 完全结束后发布
      // （runner → status.ts:43），无 busy 窗口（runner busy 会丢弃新 runLoop）；
      // message.updated 在 run Running 时发布，不可用（research.md §4.12）。
      const ev = input.event as Event;
      if (ev.type !== 'session.idle') return;
      const sessionID = ev.properties.sessionID;
      if (probeSessions.has(sessionID)) return;
      await sendRound2(ctx as Round2Ctx, sessionID);
    },
  };
};

export default Dsv4Anchored;
