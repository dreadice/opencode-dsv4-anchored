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

export type FirstTurnFilter = {
  /** 过滤 opencode 自带 persona/系统指令段（`You are opencode, ...` 开头）。 */
  stripPersona?: boolean;
  /** 过滤 AGENTS.md/CLAUDE.md/CONTEXT.md 段（`Instructions from:` 开头，D11）。 */
  stripInstructions?: boolean;
  /** 过滤技能目录段（`Skills provide specialized instructions` 开头，D11）。 */
  stripSkills?: boolean;
};

const SEGMENT_PATTERN =
  /\n(?=Instructions from: |Skills provide specialized instructions|You are opencode,)/;

/** 首轮注入前的选择性剥离（D11 备选）：按稳定标记切段，滤掉指定段。 */
export function filterFirstTurnSystem(
  system: string,
  filter: FirstTurnFilter
): string {
  if (!filter.stripPersona && !filter.stripInstructions && !filter.stripSkills)
    return system;
  return system
    .split(SEGMENT_PATTERN)
    .filter(seg => {
      if (filter.stripPersona && seg.startsWith('You are opencode,'))
        return false;
      if (filter.stripInstructions && seg.startsWith('Instructions from:'))
        return false;
      if (
        filter.stripSkills &&
        seg.startsWith('Skills provide specialized instructions')
      )
        return false;
      return true;
    })
    .join('\n');
}
