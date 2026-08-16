import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {cacheKey} from '@/cache';
/** 探针终止消息：必须避开 opencode retry 禁词（`retry.ts:33-40`），否则会被重试。 */
export const PROBE_THROW_MESSAGE = 'DSV4 probe: capture complete';

/**
 * 探针终止错误：`DOMException(..., "AbortError")`——processor 的 fromError
 * 会把它映射成 `AbortedError`（name = "MessageAbortedError"），TUI 对
 * MessageAbortedError 的 session.error **跳过不弹 toast**（tui/app.tsx:1022，
 * 官方预留的静默错误类型）；message 仍是 PROBE_THROW_MESSAGE（retry 禁词规避
 * 不变）。环境无 DOMException（非标准环境）时回退普通 Error。
 */
export function probeTerminationError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(PROBE_THROW_MESSAGE, 'AbortError');
  }
  return new Error(PROBE_THROW_MESSAGE);
}

/** `retry.ts` RETRYABLE_MESSAGE_PATTERNS 的关键词（小写比对）。 */
export const RETRY_BANNED_TERMS = [
  '429',
  '500',
  '502',
  'fetch failed',
  'timeout',
  'terminated',
  'network',
  'connection',
  'rate limit',
  'resource exhausted',
];

export type ProbeCacheEntry =
  | {status: 'ok'; system: string; ts: number}
  | {status: 'failed'; error: string; ts: number};

export type ProbeStore = {
  map: Map<string, ProbeCacheEntry>;
  inFlight: Map<string, Promise<void>>;
};

export function createProbeStore(): ProbeStore {
  return {map: new Map(), inFlight: new Map()};
}

export type ProbeClient = {
  session: {
    create(opts: {
      query?: {directory?: string};
      body?: {title?: string};
    }): Promise<{id: string}>;
    prompt(opts: {
      path: {id: string};
      body: {
        parts: Array<{type: string; text: string}>;
        agent?: string;
        model?: {providerID: string; modelID: string};
      };
    }): Promise<unknown>;
    delete(opts: {path: {id: string}}): Promise<void>;
  };
};
export type ProbeOptions = {
  probeTtlMs: number;
};

/**
 * 同步探针：create（自定义 title 跳过标题生成）→ prompt（同 agent+model，
 * 无 tools）→ 探针 runLoop 在 system.transform 捕获后 throw → prompt reject
 * （预期，try/catch 吞掉）→ delete。
 * 捕获值由 system.transform 侧写入缓存（`captureProbeSystem`）。
 */
export async function runProbe(
  client: ProbeClient,
  key: string,
  opts: {
    agent: string;
    model: {providerID: string; modelID: string};
    directory: string;
    probeSessions: Map<string, string>;
  }
): Promise<void> {
  const {id} = await client.session.create({
    query: {directory: opts.directory},
    body: {title: `dsv4-probe-${key.length}`},
  });
  opts.probeSessions.set(id, key);
  try {
    await client.session.prompt({
      path: {id},
      body: {
        parts: [{type: 'text', text: 'probe'}],
        agent: opts.agent,
        model: opts.model,
      },
    });
  } catch {
    // 预期：PROBE_THROW_MESSAGE 终止 runLoop；捕获值已写缓存
  } finally {
    await client.session.delete({path: {id}}).catch(() => {});
    opts.probeSessions.delete(id);
  }
}

/**
 * 探针缓存查询 + 执行（并发去重 + failed TTL 旁路，D8）：
 * - ok 缓存命中 → 返回 system
 * - failed 且 TTL 内 → bypass（不替换/不注入/不 bootstrap）
 * - miss → 同步探针（inFlight 去重），探针后重读缓存判定 ok/failed
 */
export async function getOrProbe(
  client: ProbeClient,
  store: ProbeStore,
  key: string,
  opts: ProbeOptions & {
    agent: string;
    model: {providerID: string; modelID: string};
    directory: string;
    probeSessions: Map<string, string>;
  }
): Promise<{system?: string; bypass: boolean}> {
  const cached = store.map.get(key);
  if (cached?.status === 'ok') return {system: cached.system, bypass: false};
  if (cached?.status === 'failed' && Date.now() - cached.ts < opts.probeTtlMs) {
    return {bypass: true};
  }
  const existing = store.inFlight.get(key);
  if (existing) {
    await existing.catch(() => {});
  } else {
    const p = runProbe(client, key, opts).catch(error => {
      store.map.set(key, {
        status: 'failed',
        error: String(error),
        ts: Date.now(),
      });
    });
    store.inFlight.set(key, p);
    await p;
    store.inFlight.delete(key);
  }
  const after = store.map.get(key);
  if (after?.status === 'ok') return {system: after.system, bypass: false};
  return {bypass: true};
}

/** system.transform 侧：探针会话捕获 system 后写入缓存（由 transform hook 调用）。 */
export function captureProbeSystem(
  store: ProbeStore,
  key: string,
  system: string
): void {
  store.map.set(key, {status: 'ok', system, ts: Date.now()});
}

/** 当天零点（本地时区）——跨天条目自动失效（key 含日期，跨天重探）。 */
function todayCutoff(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 从磁盘加载探针缓存（跨重启不重探；无文件/损坏 → 空缓存）。只保留当天条目，防无限堆积。 */
export async function loadProbeStore(filePath: string): Promise<ProbeStore> {
  const store = createProbeStore();
  const cutoff = todayCutoff();
  try {
    const raw = await readFile(filePath, 'utf8');
    const entries = JSON.parse(raw) as Array<[string, ProbeCacheEntry]>;
    for (const [key, value] of entries) {
      if (value.ts >= cutoff) store.map.set(key, value);
    }
  } catch {
    // 首次运行或文件损坏：空缓存
  }
  return store;
}

/**
 * 保存探针缓存到磁盘（fire-and-forget 调用）。
 * 只写当天条目（ts >= 当天零点）——旧日期条目随每次 save 自动清理，
 * 文件大小 ≈ 当天活跃 (directory, agent, modelID) 数 × system 全文。
 */
export async function saveProbeStore(
  store: ProbeStore,
  filePath: string
): Promise<void> {
  const cutoff = todayCutoff();
  const entries = [...store.map.entries()].filter(
    ([, value]) => value.ts >= cutoff
  );
  await mkdir(dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify(entries, null, 2));
}

/** 探针 key：复用 cacheKey 语义（directory/agent/modelID/日期）。 */
export function probeKey(
  directory: string,
  agent: string,
  modelID: string,
  date: string = new Date().toISOString().slice(0, 10)
): string {
  return cacheKey(directory, agent, modelID, date);
}
