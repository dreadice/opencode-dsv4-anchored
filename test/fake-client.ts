import {PROBE_THROW_MESSAGE} from '@/probe';
import type {Rule} from '@/stage';

export type FakeSession = {
  id: string;
  directory: string;
  parentID?: string;
  agent: string;
  /** wire Session 形（round-10：sendRound2 用 session.model.id）。 */
  model: {id: string; providerID: string; variant?: string};
  permission: Rule[];
  title?: string;
};

export type FakeMessage = {
  info: {id: string; role: string};
  parts: Array<{type: string; [k: string]: unknown}>;
};

export type FakeAgent = {
  id: string;
  prompt: string;
  permission: Rule[];
};

export type FakeLog = {msg: string; level?: string; [k: string]: unknown};

export type FakeClient = {
  session: {
    get(opts: {path: {id: string}}): Promise<FakeSession>;
    update(opts: {
      path: {id: string};
      body?: {permission?: Rule[]; title?: string};
    }): Promise<FakeSession>;
    messages(opts: {path: {id: string}}): Promise<FakeMessage[]>;
    create(opts: {
      query?: {directory?: string};
      body?: {title?: string};
    }): Promise<{id: string}>;
    prompt(opts: {path: {id: string}; body?: unknown}): Promise<unknown>;
    delete(opts: {path: {id: string}}): Promise<void>;
  };
  app: {
    agents(): Promise<FakeAgent[]>;
    log(msg: string, opts?: {level?: string; [k: string]: unknown}): void;
  };
  config: {
    get(): Promise<Record<string, never>>;
  };
  _logs: FakeLog[];
  _sessions: Map<string, FakeSession>;
  _messages: Map<string, FakeMessage[]>;
  _promptCalls: Array<{id: string; body: unknown}>;
  _promptHandler: ((id: string, body: unknown) => Promise<unknown>) | undefined;
  setPromptHandler(h: (id: string, body: unknown) => Promise<unknown>): void;
};

export const BUILD_AGENT: FakeAgent = {
  id: 'build',
  prompt: 'You are a helpful software engineer assistant.',
  permission: [
    {permission: '*', pattern: '*', action: 'allow'},
    {permission: 'doom_loop', pattern: '*', action: 'ask'},
  ],
};

export const EXPLORE_AGENT: FakeAgent = {
  id: 'explore',
  prompt: 'You are a read-only explorer.',
  permission: [
    {permission: '*', pattern: '*', action: 'deny'},
    {permission: 'read', pattern: '*', action: 'allow'},
    {permission: 'glob', pattern: '*', action: 'allow'},
    {permission: 'grep', pattern: '*', action: 'allow'},
    {permission: 'bash', pattern: '*', action: 'allow'},
  ],
};

export function createFakeClient(opts?: {
  model?: {id: string; providerID: string};
}): FakeClient {
  const model = opts?.model ?? {
    id: 'deepseek-v4-flash-free',
    providerID: 'opencode',
  };
  const sessions = new Map<string, FakeSession>();
  const messages = new Map<string, FakeMessage[]>();
  const logs: FakeLog[] = [];
  const promptCalls: Array<{id: string; body: unknown}> = [];
  let promptHandler: FakeClient['_promptHandler'];

  const session = (id: string): FakeSession => {
    const s = sessions.get(id);
    if (!s) throw new Error(`fake: session not found: ${id}`);
    return s;
  };

  return {
    session: {
      async get({path}) {
        return session(path.id);
      },
      async update({
        path,
        body,
      }: {
        path: {id: string};
        body?: {permission?: Rule[]; title?: string};
      }) {
        const s = session(path.id);
        if (body?.permission)
          s.permission = [...s.permission, ...body.permission];
        if (body?.title !== undefined) s.title = body.title;
        return s;
      },
      async messages({path}) {
        return messages.get(path.id) ?? [];
      },
      async create({query, body}) {
        const id = `ses_probe_${sessions.size + 1}`;
        sessions.set(id, {
          id,
          directory: query?.directory ?? '/proj',
          agent: 'build',
          model,
          permission: [],
          title: body?.title,
        });
        return {id};
      },
      async prompt({path, body}) {
        promptCalls.push({id: path.id, body});
        if (promptHandler) return promptHandler(path.id, body);
        throw new Error(PROBE_THROW_MESSAGE);
      },
      async delete({path}) {
        sessions.delete(path.id);
      },
    },
    app: {
      async agents() {
        return [BUILD_AGENT, EXPLORE_AGENT];
      },
      log(msg, opts) {
        logs.push({msg, ...opts});
      },
    },
    config: {
      async get() {
        return {};
      },
    },
    _logs: logs,
    _sessions: sessions,
    _messages: messages,
    _promptCalls: promptCalls,
    _promptHandler: undefined,
    setPromptHandler(h) {
      promptHandler = h;
    },
  };
}

/** 建一个含指定 permission 的会话（默认 build agent + flash-free）。 */
export function addSession(
  client: FakeClient,
  opts: Partial<FakeSession> & {id: string}
): FakeSession {
  const s: FakeSession = {
    id: opts.id,
    directory: opts.directory ?? '/proj',
    agent: opts.agent ?? 'build',
    model: opts.model ?? {
      id: 'deepseek-v4-flash-free',
      providerID: 'opencode',
    },
    permission: opts.permission ?? [],
    parentID: opts.parentID,
    title: opts.title,
  };
  client._sessions.set(s.id, s);
  return s;
}

export const reasoning = (text: string) => ({type: 'reasoning', text});
export const textPart = (text: string) => ({type: 'text', text});
export const toolPart = (tool: string) => ({type: 'tool', tool});
export const compactionPart = (tailStartId?: string) => ({
  type: 'compaction',
  ...(tailStartId ? {tail_start_id: tailStartId} : {}),
});

export const assistant = (id: string, parts: unknown[]): FakeMessage => ({
  info: {id, role: 'assistant'},
  parts: parts as FakeMessage['parts'],
});

export const user = (id: string, parts: unknown[]): FakeMessage => ({
  info: {id, role: 'user'},
  parts: parts as FakeMessage['parts'],
});
