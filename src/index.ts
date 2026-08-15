import type {Plugin} from '@opencode-ai/plugin';
import type {Model} from '@opencode-ai/sdk/v2';

const API = {
  id: 'deepseek',
  url: 'https://api.deepseek.com',
  npm: '@ai-sdk/deepseek',
};

const DEEPSEEK_V4_MODELS: Record<string, Model> = {
  'deepseek-v4-flash-free': {
    id: 'deepseek-v4-flash-free',
    providerID: 'deepseek',
    api: API,
    name: 'DeepSeek V4 Flash Free',
    family: 'deepseek-v4',
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: {text: true, audio: false, image: false, video: false, pdf: false},
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {input: 0, output: 0, cache: {read: 0, write: 0}},
    limit: {context: 128_000, output: 8_192},
    status: 'active',
    options: {},
    headers: {},
    release_date: '2026-08-16',
  },
};

export const Dsv4Anchored: Plugin = async ({
  client,
  project,
  directory,
  worktree,
  $,
}) => {
  return {
    provider: {
      id: 'deepseek',
      models: async provider => {
        return DEEPSEEK_V4_MODELS;
      },
    },
  };
};

export default Dsv4Anchored;
