import {createOpencodeClient} from '@opencode-ai/sdk';
import type {CoreClient} from '@/core';
import type {ProbeClient} from '@/probe';
import type {LogFn} from '@/logger';

export type SDKClient = ReturnType<typeof createOpencodeClient>;

type SdkResult<T> = {data?: T; error?: unknown};

function unwrap<T>(res: SdkResult<T>): T {
  if (res.error) {
    const message =
      typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
    throw new Error(message);
  }
  return res.data as T;
}

/**
 * SDK client 适配：SDK 方法返回 `{data, error, request, response}`（可失败），
 * 内部接口需要直接值。所有调用都检查 `.error`，避免状态更新失败被静默吞掉。
 * 注意：`session.get` wire 返回 permission/agent/model、
 * `session.update` 接受 permission，但 SDK 类型未声明（research round-8）→
 * 这些点按内部接口形态断言（as any 为已知技术债）。
 */
export function adaptClient(client: SDKClient): CoreClient & ProbeClient {
  return {
    session: {
      get: async opts =>
        unwrap(await client.session.get(opts)) as unknown as Awaited<
          ReturnType<CoreClient['session']['get']>
        >,
      update: async opts =>
        unwrap(
          await client.session.update(opts as never)
        ) as unknown as Awaited<ReturnType<CoreClient['session']['update']>>,
      messages: async opts => unwrap(await client.session.messages(opts)) ?? [],
      create: async opts =>
        unwrap(await client.session.create(opts)) ?? {id: ''},
      prompt: async opts => unwrap(await client.session.prompt(opts as never)),
      delete: async opts => {
        const res = (await client.session.delete(opts as never)) as {
          error?: unknown;
        };
        if (res.error) {
          const message =
            typeof res.error === 'string'
              ? res.error
              : JSON.stringify(res.error);
          throw new Error(message);
        }
      },
    },
    app: {
      agents: async () =>
        (unwrap(await client.app.agents()) ?? []) as unknown as Awaited<
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
