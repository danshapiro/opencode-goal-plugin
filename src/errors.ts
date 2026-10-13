// Error classification for the uncapped continuation loop.
//
// Shared verbatim by the V1 entrypoint (src/plugin.ts) and the V2 entrypoint
// (src/v2.ts): it must not import anything from the OpenCode SDKs so the V2
// module graph stays free of the V1-only `@opencode-ai/plugin` runtime import.
//
// Uncapped contract: only KNOWN model/turn errors block the goal; unknown/infra
// errors keep the goal active (recoverable via the next continuation or `/goal
// resume`). The default is deliberately inverted so an unrecognized error can never
// auto-block the uncapped loop. From the real EventSessionError.error union
// (ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError
// | ApiError): UnknownError and MessageOutputLengthError are genuine turn failures;
// ProviderAuthError (auth) and ApiError (APIError / 5xx) are infra, and
// MessageAbortedError is a transport/abort — all three stay active.
const MODEL_TURN_ERROR_NAMES = new Set(["UnknownError", "MessageOutputLengthError"])

// Belt-and-suspenders stay-active signals (redundant with the allowlist default, but
// explicit): a known transport/abort name, or a transport/disposal-ish message. These
// must NOT block the goal — the loop can resume under the next persistent host.
const TRANSPORT_ERROR_NAMES = new Set(["MessageAbortedError"])
const TRANSPORT_MSG_RE =
  /econnrefused|econnreset|epipe|fetch failed|socket hang up|network|disposed|dispose|aborted|abort|timed?\s?out|instance.*(gone|dispose)/i

function errName(e: unknown): string | undefined {
  if (e && typeof e === "object" && "name" in e) {
    const n = (e as { name?: unknown }).name
    return typeof n === "string" ? n : undefined
  }
  return undefined
}

function errMessage(e: unknown): string {
  if (!e) return ""
  if (typeof e === "string") return e
  if (typeof e === "object") {
    const o = e as { message?: unknown; data?: { message?: unknown } }
    if (typeof o.message === "string") return o.message
    if (o.data && typeof o.data.message === "string") return o.data.message
    try {
      return JSON.stringify(o)
    } catch {
      return String(e)
    }
  }
  return String(e)
}

// True ONLY for positively-identified model/turn errors (-> blocked). Everything
// else — transport/disposal/abort AND any unrecognized/infra error (ProviderAuthError,
// APIError/5xx, unknown shapes) — returns false (stay active), honoring the uncapped
// contract that a non-model error must never auto-block the loop.
export function isModelTurnError(e: unknown): boolean {
  if (!e) return false
  const name = errName(e)
  // Explicit stay-active signals first (belt and suspenders).
  if (name && TRANSPORT_ERROR_NAMES.has(name)) return false
  if (TRANSPORT_MSG_RE.test(errMessage(e))) return false
  // Default is now stay-active: block only on a known model/turn error name.
  return name !== undefined && MODEL_TURN_ERROR_NAMES.has(name)
}
