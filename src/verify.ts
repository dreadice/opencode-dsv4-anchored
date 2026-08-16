export type VerifyTerms = {
  we: string[]
  let: string[]
}

export const DEFAULT_TERMS: VerifyTerms = {
  we: ["we need", "we"],
  let: ["let me", "let's"],
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function earliestMatch(text: string, term: string): number {
  const escaped = escapeRe(term)
  if (/[^\x00-\x7F]/.test(term)) {
    return text.indexOf(term)
  }
  const re = new RegExp(`(?<![a-z])${escaped}(?![a-z'])`)
  const m = re.exec(text)
  return m ? m.index : -1
}

function earliest(text: string, terms: string[]): number {
  let best = -1
  for (const term of terms) {
    const idx = earliestMatch(text, term)
    if (idx !== -1 && (best === -1 || idx < best)) best = idx
  }
  return best
}

/**
 * 轨迹标记判别（round-8 定案）：
 * reasoning + text 拼接全文，`idx(we系) < idx(let系)` 即通过。
 * let 系不出现 = +∞，we 系存在即通过；we 系不出现则不通过。
 */
export function verifyText(text: string, terms: VerifyTerms = DEFAULT_TERMS): boolean {
  const lower = text.toLowerCase()
  const weIdx = earliest(lower, terms.we)
  if (weIdx === -1) return false
  const letIdx = earliest(lower, terms.let)
  if (letIdx === -1) return true
  return weIdx < letIdx
}

export const ZH_TERMS: VerifyTerms = {
  we: ["我们"],
  let: ["让我", "我来", "我先"],
}