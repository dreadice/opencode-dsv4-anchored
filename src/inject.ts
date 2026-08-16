import {randomBytes} from 'node:crypto';

export const INJECT_MARKER = '[dsv4-anchored:injected]';
export const ANCHOR_MARKER = '[dsv4-anchored:anchor]';

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

/** 历史 parts 中是否已有指定标记（幂等判定，含 compaction 后重注入判断）。 */
export function hasMarker(
  parts: Array<{type: string; text?: unknown}>,
  marker: string
): boolean {
  return parts.some(
    p =>
      p.type === 'text' &&
      typeof p.text === 'string' &&
      p.text.includes(marker)
  );
}

/** 历史 parts 中是否已有注入标记（system 注入幂等）。 */
export function hasInjectionMarker(
  parts: Array<{type: string; text?: unknown}>
): boolean {
  return hasMarker(parts, INJECT_MARKER);
}

/** 历史 parts 中是否已有锚定消息标记。 */
export function hasAnchorMarker(
  parts: Array<{type: string; text?: unknown}>
): boolean {
  return hasMarker(parts, ANCHOR_MARKER);
}

/** 注入 part：synthetic 标记 + 幂等标记文本 + 内容（system 或锚定消息）。 */
export function buildInjectionPart(
  content: string,
  sessionID: string,
  messageID: string,
  marker: string = INJECT_MARKER
): InjectionPart {
  return {
    id: newPartId(),
    sessionID,
    messageID,
    type: 'text',
    text: `${marker}\n${content}`,
    synthetic: true,
  };
}

export type FirstTurnFilter = {
  /** 去掉 opencode 的 default.txt persona 段（`You are opencode, ...` 到
   * `You are powered by the model named` 之前），保留模型名/env/AGENTS/
   * 技能/MCP 等其余内容。 */
  stripPersona?: boolean;
  /** 过滤 AGENTS.md/CLAUDE.md/CONTEXT.md 段（`Instructions from:` 开头，D11）。 */
  stripInstructions?: boolean;
  /** 过滤技能目录段（`Skills provide specialized instructions` 开头，D11）。 */
  stripSkills?: boolean;
};

const SEGMENT_PATTERN =
  /\n(?=Instructions from: |Skills provide specialized instructions|You are opencode,)/;

/** 去掉整个 default.txt persona 段：`You are opencode,` 到
 * `\nYou are powered by the model named` 之前（default.txt 全文，system.ts
 * env 的模型名行是 persona 段边界）。 */
function stripPersonaSection(text: string): string {
  const start = text.indexOf('You are opencode,');
  if (start === -1) return text;
  const end = text.indexOf('\nYou are powered by the model named');
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end);
}

/** 首轮注入前的选择性剥离（D11 备选）：按稳定标记切段，滤掉指定段。 */
export function filterFirstTurnSystem(
  system: string,
  filter: FirstTurnFilter
): string {
  if (!filter.stripPersona && !filter.stripInstructions && !filter.stripSkills)
    return system;
  return system
    .split(SEGMENT_PATTERN)
    .map(seg => {
      if (filter.stripInstructions && seg.startsWith('Instructions from:'))
        return '';
      if (
        filter.stripSkills &&
        seg.startsWith('Skills provide specialized instructions')
      )
        return '';
      if (filter.stripPersona) return stripPersonaSection(seg);
      return seg;
    })
    .filter(seg => seg !== '')
    .join('\n');
}