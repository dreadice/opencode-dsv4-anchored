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

/** 历史 parts 中是否已有指定标记（幂等判定，含 compaction 后重注入判断）。 */
export function hasMarker(
  parts: Array<{type: string; text?: unknown}>,
  marker: string
): boolean {
  return parts.some(
    p =>
      p.type === 'text' && typeof p.text === 'string' && p.text.includes(marker)
  );
}

/** 当前 agent/model 对应的注入标记（切换 agent/model 后旧标记不应阻止新注入）。 */
export function injectionMarkerFor(agent: string, modelID: string): string {
  return `${INJECT_MARKER}:${agent}:${modelID}`;
}

/** 历史 parts 中是否已有当前 agent/model 的注入标记。 */
export function hasInjectionMarkerFor(
  parts: Array<{type: string; text?: unknown}>,
  agent: string,
  modelID: string
): boolean {
  return hasMarker(parts, injectionMarkerFor(agent, modelID));
}

/** 注入 part：synthetic 标记 + 幂等标记文本 + 内容（system 或锚定消息）。 */
export function buildInjectionPart(
  content: string,
  sessionID: string,
  messageID: string,
  marker: string
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
  /** 删掉 opencode 身份声明句（`You are opencode, an interactive CLI tool...`
   * 首句），保留 default.txt 的行为要求（IMPORTANT/工具政策/Code References）
   * 与模型名/env/AGENTS/技能/MCP。 */
  stripPersona?: boolean;
  /** 过滤 AGENTS.md/CLAUDE.md/CONTEXT.md 段（`Instructions from:` 开头，D11）。 */
  stripInstructions?: boolean;
  /** 过滤技能目录段（`Skills provide specialized instructions` 开头，D11）。 */
  stripSkills?: boolean;
};

const SEGMENT_PATTERN =
  /\n(?=Instructions from: |Skills provide specialized instructions|You are opencode,)/;

/** 删除开篇身份声明句（default.txt 第一句到句号），保留同行后续
 * "Use the instructions below ..." 及段内行为要求。 */
function stripIdentity(text: string): string {
  return text.replace(
    /^You are opencode, an interactive CLI tool that helps users with software engineering tasks\. ?/,
    ''
  );
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
      if (filter.stripPersona) return stripIdentity(seg);
      return seg;
    })
    .filter(seg => seg !== '')
    .join('\n');
}
