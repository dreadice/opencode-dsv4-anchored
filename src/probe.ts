/** 探针终止消息：必须避开 opencode retry 禁词（`retry.ts:33-40`），否则会被重试。 */
export const PROBE_THROW_MESSAGE = "DSV4 probe: capture complete"

/** `retry.ts` RETRYABLE_MESSAGE_PATTERNS 的关键词（小写比对）。 */
export const RETRY_BANNED_TERMS = [
  "429",
  "500",
  "502",
  "fetch failed",
  "timeout",
  "terminated",
  "network",
  "connection",
  "rate limit",
  "resource exhausted",
]