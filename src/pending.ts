import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

/** pending 条目：被推迟的真实消息 parts（D13 §4.5）。 */
export type PendingEntry = {
  parts: Array<Record<string, unknown>>;
  /** 首轮消息 id（轮 2 user system part 的 messageID 参考，serve 端会覆盖）。 */
  messageID: string;
  ts: number;
};

/** pending 存储：内存 Map + sending 防重集合（发送中并发去重）。 */
export type PendingStore = {
  map: Map<string, PendingEntry>;
  sending: Set<string>;
};

export function createPendingStore(): PendingStore {
  return {map: new Map(), sending: new Set()};
}

/** 从磁盘加载 pending（重启悬挂补发的数据来源）；无文件/损坏 → 空。 */
export async function loadPendingStore(
  filePath: string
): Promise<PendingStore> {
  const store = createPendingStore();
  try {
    const raw = await readFile(filePath, 'utf8');
    const entries = JSON.parse(raw) as Array<[string, PendingEntry]>;
    for (const [id, value] of entries) store.map.set(id, value);
  } catch {
    // 首次运行或文件损坏：空
  }
  return store;
}

/** 保存 pending 到磁盘（fire-and-forget 调用）。 */
export async function savePendingStore(
  store: PendingStore,
  filePath: string
): Promise<void> {
  await mkdir(dirname(filePath), {recursive: true});
  await writeFile(filePath, JSON.stringify([...store.map.entries()], null, 2));
}
