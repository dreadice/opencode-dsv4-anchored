import {randomBytes} from 'node:crypto';

export const INJECT_MARKER = '[dsv4-anchored:injected]';

export type InjectionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic: true;
};

/** part id：参考 opencode `id/id.ts` 的 `prt_<hex>` 格式（时间戳+随机，保证唯一）。 */
export function newPartId(): string {
  return `prt_${Date.now().toString(16)}${randomBytes(8).toString('hex')}`;
}

/** 历史 parts 中是否已有注入标记（幂等判定，含 compaction 后重注入判断）。 */
export function hasInjectionMarker(
  parts: Array<{type: string; text?: unknown}>
): boolean {
  return parts.some(
    p =>
      p.type === 'text' &&
      typeof p.text === 'string' &&
      p.text.includes(INJECT_MARKER)
  );
}

/** 注入 part：synthetic 标记 + 幂等标记文本 + 捕获的 system 全量。 */
export function buildInjectionPart(
  system: string,
  sessionID: string,
  messageID: string
): InjectionPart {
  return {
    id: newPartId(),
    sessionID,
    messageID,
    type: 'text',
    text: `${INJECT_MARKER}\n${system}`,
    synthetic: true,
  };
}
