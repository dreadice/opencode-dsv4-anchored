import {createOpencodeClient} from '@opencode-ai/sdk';
import type {CoreClient} from '@/core';
import type {ProbeClient} from '@/probe';
import type {LogFn} from '@/logger';

export type SDKClient = ReturnType<typeof createOpencodeClient>;

/**
 * SDK client 适配：SDK 方法返回 `{data, error, request, response}`（可失败），
 * 内部接口需要直接值。注意：`session.get` wire 返回 permission/agent/model、
 * `session.update` 接受 permission，但 SDK 类型未声明（research round-8）→
 * 这些点按内部接口形态断言（as any 为已知技术债）。
 */
export function adaptClient(client: SDKClient): CoreClient & ProbeClient {
  return {
    session: {
      get: async opts =>
        (await client.session.get(opts)).data as unknown as Awaited<
          ReturnType<CoreClient['session']['get']>
        >,
      update: async opts =>
        (await client.session.update(opts as never)).data as unknown as Awaited<
          ReturnType<CoreClient['session']['update']>
        >,
      messages: async opts => (await client.session.messages(opts)).data ?? [],
      create: async opts =>
        (await client.session.create(opts)).data ?? {id: ''},
      prompt: async opts => (await client.session.prompt(opts as never)).data,
      delete: async opts => {
        await client.session.delete(opts);
      },
    },
    app: {
      agents: async () =>
        ((await client.app.agents()).data ?? []) as unknown as Awaited<
          ReturnType<CoreClient['app']['agents']>
        >,
    },
  };
}

/** app.log 适配：SDK `log({body:{service, level, message, extra}})`。 */
export function adaptLog(client: SDKClient): LogFn {
  return (msg, opts) => {
    const {level, ...fields} = opts ?? {};
    client.app.log({
      body: {
        service: 'dsv4-anchored',
        level: (level ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
        message: msg,
        extra: fields as Record<string, unknown>,
      },
    });
  };
}

/** TUI toast 适配：SDK `tui.showToast({body})`（server 事件总线 → TUI 显示）。 */
export type ToastFn = (opts: {
  title?: string;
  message: string;
  variant: 'info' | 'success' | 'warning' | 'error';
}) => void;

export function adaptToast(client: SDKClient): ToastFn {
  return opts => {
    void client.tui.showToast({body: opts});
  };
}
