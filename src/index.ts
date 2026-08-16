import type {Plugin, PluginOptions} from '@opencode-ai/plugin';
import {ensureState, type EnsureOptions} from '@/core';
import {systemTransform} from '@/system-transform';
import {compacting} from '@/compaction';
import {strReplaceEditor} from '@/str-replace-editor';
import {loadProbeStore, saveProbeStore} from '@/probe';
import {makeLogger} from '@/logger';
import {DEFAULT_TERMS, type VerifyTerms} from '@/verify';
import type {FirstTurnFilter} from '@/inject';
import {adaptClient, adaptLog} from '@/sdk-adapter';
import {join} from 'node:path';
import {homedir} from 'node:os';

const DEFAULT_CACHE_FILE = join(
  homedir(),
  '.local/share/opencode/dsv4-anchored/probe-cache.json'
);

type Dsv4Options = {
  models?: string[];
  whitelist?: string[];
  verifyN?: number;
  verifyTerms?: VerifyTerms;
  probeTtlMs?: number;
  cacheDir?: string;
  firstTurnFilter?: FirstTurnFilter;
};

function resolveOptions(options?: PluginOptions): EnsureOptions {
  const opts = (options ?? {}) as Dsv4Options;
  return {
    models: opts.models ?? ['deepseek*v4*'],
    whitelist: opts.whitelist ?? ['bash', 'str_replace_editor'],
    verifyN: opts.verifyN ?? 3,
    verifyTerms: opts.verifyTerms ?? DEFAULT_TERMS,
    probeTtlMs: opts.probeTtlMs ?? 300_000,
    firstTurnFilter: opts.firstTurnFilter,
  };
}

export const Dsv4Anchored: Plugin = async ({client}, options) => {
  const sdk = adaptClient(client);
  const eopts = resolveOptions(options);
  const cacheFile =
    ((options ?? {}) as Dsv4Options).cacheDir ?? DEFAULT_CACHE_FILE;
  const probeStore = await loadProbeStore(cacheFile);
  const probeSessions = new Map<string, string>();
  const giveupOnce = new Set<string>();
  const logger = makeLogger(adaptLog(client));

  return {
    tool: {
      str_replace_editor: strReplaceEditor,
    },
    'chat.message': async (input, output) => {
      if (!input.model) return;
      await ensureState(
        {
          client: sdk,
          options: eopts,
          logger,
          probeStore,
          probeSessions,
          giveupOnce,
        },
        {
          sessionID: input.sessionID,
          model: input.model,
          messageID: output.message.id,
          outputParts: output.parts,
        }
      );
      void saveProbeStore(probeStore, cacheFile);
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
      await compacting({client: sdk, logger}, input.sessionID);
    },
  };
};

export default Dsv4Anchored;
