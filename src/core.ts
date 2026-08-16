import { gateModel } from "@/gate"
import { probeKey, getOrProbe, type ProbeClient, type ProbeStore } from "@/probe"
import {
  getStage,
  seededRules,
  unlockRules,
  extractSessionDenies,
  STAGE_PERMISSION,
  type Rule,
  type Stage,
} from "@/stage"
import { verifyText, type VerifyTerms } from "@/verify"
import { hasInjectionMarker, buildInjectionPart } from "@/inject"
import { lastCompactionBoundary } from "@/epoch"
import type { Logger } from "@/logger"

export type CoreClient = {
  session: {
    get(opts: { path: { id: string } }): Promise<{
      directory: string
      agent: string
      parentID?: string
      permission: Rule[]
    }>
    update(opts: { path: { id: string }; body: { permission?: Rule[] } }): Promise<unknown>
    messages(opts: { path: { id: string } }): Promise<
      Array<{
        info: { role?: string }
        parts: Array<{ type: string; text?: unknown }>
      }>
    >
  }
  app: {
    agents(): Promise<Array<{ id: string; permission: Rule[] }>>
  }
}

export type EnsureOptions = {
  models: string[]
  whitelist: string[]
  verifyN: number
  verifyTerms: VerifyTerms
  probeTtlMs: number
}

export type EnsureCtx = {
  client: CoreClient & ProbeClient
  options: EnsureOptions
  logger: Logger
  probeStore: ProbeStore
  probeSessions: Set<string>
  giveupOnce: Set<string>
}

export type EnsureInput = {
  sessionID: string
  model: { providerID: string; modelID: string }
  messageID: string
  outputParts: Array<{ type: string; [k: string]: unknown }>
}

export type EnsureResult = {
  action: "none" | "bypass" | "seeded" | "unlock" | "verify" | "giveup" | "pending" | "verified"
  stage: Stage
}

export const MINIMAL_PERSONA = "You are a helpful software engineer assistant."

/**
 * chat.message ensure 全流程（round-7/8 收敛：解锁/判别/注入都在此）：
 * 门控 → 旁路判定 → 阶段判定 → 注入 → 解锁（边界后信号）→ 判别（N=3 窗口）。
 * 所有 session.update 在本函数 await 内完成 → 本次请求生效。
 */
export async function ensureState(ctx: EnsureCtx, input: EnsureInput): Promise<EnsureResult> {
  const { client, options, logger } = ctx
  if (!gateModel(input.model, options.models)) return { action: "none", stage: "pristine" }

  const session = await client.session.get({ path: { id: input.sessionID } })
  const key = probeKey(session.directory, session.agent, input.model.modelID)

  const probe = await getOrProbe(client, ctx.probeStore, key, {
    probeTtlMs: options.probeTtlMs,
    agent: session.agent,
    model: input.model,
    directory: session.directory,
    probeSessions: ctx.probeSessions,
  })
  if (probe.bypass) {
    logger.warn("bypass", { key, reason: "probe failed or ttl" })
    return { action: "bypass", stage: getStage(session.permission) }
  }

  const history = await client.session.messages({ path: { id: input.sessionID } })
  const boundary = lastCompactionBoundary(history)
  const allParts = history.flatMap((m) => m.parts)
  const stage = getStage(session.permission)

  let injected = false
  if (!hasInjectionMarker(allParts) && probe.system) {
    input.outputParts.unshift(buildInjectionPart(probe.system, input.sessionID, input.messageID))
    injected = true
  }
  logger.info("chat.message", {
    sessionID: input.sessionID,
    stage,
    gating: "hit",
    injectSource: injected ? "probe" : "none",
    subagent: session.parentID !== undefined,
  })

  if (stage === "pristine") {
    await client.session.update({
      path: { id: input.sessionID },
      body: { permission: seededRules(options.whitelist) },
    })
    return { action: "seeded", stage: "seeded" }
  }

  if (stage === "seeded" || stage === "unsealed") {
    const post = boundary === -1 ? history : history.slice(boundary + 1)
    const hasSignal = post.some(
      (m) => m.info.role === "assistant" || m.parts.some((p) => p.type === "tool"),
    )
    if (stage === "seeded" && hasSignal) {
      const agents = await client.app.agents()
      const agentRuleset = agents.find((a) => a.id === session.agent)?.permission ?? []
      const denies = extractSessionDenies(session.permission)
      await client.session.update({
        path: { id: input.sessionID },
        body: { permission: unlockRules(agentRuleset, denies) },
      })
      logger.info("unlock", { sessionID: input.sessionID, agent: session.agent })
      return { action: "unlock", stage: "unsealed" }
    }

    const assistants = post.filter((m) => m.info.role === "assistant")
    for (const m of assistants) {
      const text = m.parts
        .filter((p) => p.type === "reasoning" || p.type === "text")
        .map((p) => String(p.text ?? ""))
        .join("\n")
      if (text && verifyText(text, options.verifyTerms)) {
        await client.session.update({
          path: { id: input.sessionID },
          body: { permission: [{ permission: STAGE_PERMISSION, pattern: "verified", action: "allow" }] },
        })
        logger.info("verify.passed", { sessionID: input.sessionID, checked: assistants.length })
        return { action: "verify", stage: "verified" }
      }
    }
    if (assistants.length >= options.verifyN) {
      if (!ctx.giveupOnce.has(input.sessionID)) {
        ctx.giveupOnce.add(input.sessionID)
        logger.warn("verify.giveup", { sessionID: input.sessionID, checked: assistants.length })
      }
      return { action: "giveup", stage }
    }
    return { action: "pending", stage }
  }

  return { action: "verified", stage }
}