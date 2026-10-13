// OpenCode V2 entrypoint — same five parts as src/plugin.ts (the V1 entrypoint),
// mapped onto the V2 plugin API:
//   (A) per-session goal store        -> GoalStore (shared)
//   (B) /goal command surface        -> ctx.command.transform
//   (C) per-turn objective+audit inj. -> ctx.session.hook("context") (Task 0 primary)
//   (D) model-only completion tools   -> ctx.tool.transform
//   (E) uncapped idle continuation    -> ctx.event.subscribe (turn-completion
//                                          events) + brake on session.execution.failed
//
// UNCAPPED, NO IN-FLIGHT MUTEX (Nadia-1, unchanged): the only gate on the loop is
// status !== "active". turn N finishes -> continuation N+1, forever, until the
// model calls goal_complete/goal_blocked, the user pauses/clears (or interrupts
// the run), or a genuine model/turn error trips the brake.
//
// This module must stay free of runtime imports on the V1 SDKs: tools.ts imports
// `tool()` from `@opencode-ai/plugin` at runtime, which OpenCode 2 hosts do not
// provide. Only `@opencode/plugin` types are imported (erased at transpile time),
// and everything else comes from the dependency-free local modules.
//
// Error brake (V2 shape): V1 classified `session.error` events carrying
// { name, message } error objects. V2 has no session.error event; terminal turn
// failures arrive as session.execution.failed with data.error = { type, message,
// status?, response? } (SessionError.Error — an opaque `type` string). We normalize
// the V2 shape back onto the shared V1 classifier: `type` plays the role of `name`
// (canonicalized: "unknown_error"/"unknown" -> "UnknownError", "output_length"-ish ->
// "MessageOutputLengthError", "aborted" -> "MessageAbortedError"), so genuine
// model/turn failures still trip the brake while transport/infra/unknown shapes —
// including auth failures and 5xx — leave the goal active (uncapped contract).

import type { Plugin } from "@opencode/plugin"
import { appendFileSync, openSync, closeSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { GoalStore, type Goal } from "./state"
import { parseGoalArgs } from "./verbs"
import { renderGoalSystem, CONTINUE_NUDGE } from "./prompt"
import { isModelTurnError } from "./errors"

// --- state directory ---------------------------------------------------------

// GOAL_STATE_DIR overrides (used by tests as the deterministic oracle location);
// otherwise goals live under the project's .opencode/goal directory.
function resolveStateDir(ctx: Plugin.Context): string {
  const override = process.env.GOAL_STATE_DIR
  if (override) return override
  return join(ctx.location.directory, ".opencode", "goal")
}

// --- debug sink (deterministic oracle for Task 7) ----------------------------

// When GOAL_DEBUG_SINK is set, append one JSON line per inject and per continuation.
function sink(entry: Record<string, unknown>): void {
  const path = process.env.GOAL_DEBUG_SINK
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n")
  } catch {
    // Never let observability break the loop.
  }
}

function log(...args: unknown[]): void {
  if (process.env.GOAL_DEBUG) console.error("[goal]", ...args)
}

// When GOAL_EVENT_DUMP is set, append every subscribed event as one JSON line.
// Opt-in observability for debugging the host's event contract (e.g. which
// session.execution.* events fire, what session.created carries). Each line is
// tagged with a per-instance id so duplicate or leaked subscriptions across hot
// reloads are detectable in the dump.
const DUMP_INSTANCE = Math.random().toString(36).slice(2)

function dumpEvent(event: unknown): void {
  const path = process.env.GOAL_EVENT_DUMP
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify({ instance: DUMP_INSTANCE, event }) + "\n")
  } catch {
    // Never let observability break the loop.
  }
}

// --- V2 error-name canonicalization ------------------------------------------

// Map V2's opaque error `type` strings onto the V1 error names the shared
// classifier understands. Unknown shapes pass through in a normalized form that
// matches neither allowlist, so they stay active (the uncapped default).
function canonicalErrorName(type: string): string {
  const stripped = type.replace(/[^a-z0-9]/gi, "").toLowerCase()
  if (stripped.startsWith("messageoutputlength")) return "MessageOutputLengthError"
  if (stripped.startsWith("unknown")) return "UnknownError"
  if (stripped.startsWith("messageaborted")) return "MessageAbortedError"
  return stripped
}

// --- single-actor continuation lock --------------------------------------------

// OpenCode loads one plugin instance per connected client run, and — verified
// live on 2.0.27 — an instance's event subscription can outlive its own cleanup
// when the abort signal alone does not end the stream. If several live instances
// share this location, each would otherwise send its own continuation nudge per
// turn end (N clients -> N nudges -> N-fold turn inflation). The lock is keyed
// by the triggering event's own id, which every instance sees identically: the
// first instance to create the file (O_EXCL) owns the turn, the rest stand down.
// The winner removes the lock once its prompt settles; a winner that dies
// mid-turn leaves a stale lock, but event ids never recur, so orphans are inert.
function tryTurnLock(stateDir: string, key: string): string | null {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "")
  const lockPath = join(stateDir, `.nudge-${safe}.lock`)
  try {
    const fd = openSync(lockPath, "wx")
    closeSync(fd)
    return lockPath
  } catch {
    // EEXIST (another instance owns this turn) or an unusable dir: stand down.
    return null
  }
}

// --- command output helper ---------------------------------------------------

function viewText(goal: Goal | undefined): string {
  if (!goal) return "No goal set for this session. Use `/goal <objective>` to start one."
  return `Goal [${goal.status}] (turn ${goal.turnCount}): ${goal.objective}`
}

// --- plugin ------------------------------------------------------------------

export async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  const stateDir = resolveStateDir(ctx)
  const store = new GoalStore(stateDir)

  // Background subagents (subagent tool, background=true) run as CHILD SESSIONS:
  // their session.created event carries parentID. While any child of a goal
  // session is still running, the orchestrator is deliberately idle — no
  // continuation nudge. When the child finishes, the host steers the parent with
  // a synthetic completion summary, which ends in a fresh parent
  // session.execution.succeeded; the loop resumes from there. No wake-up timer
  // needed (uncapped philosophy: the harness owns the resume).
  const childrenByParent = new Map<string, Set<string>>()

  // (D) model-only completion tools. V2 tools take a plain JSON Schema `input`
  // (not V1's tool.schema builder) and resolve with { content }.
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "goal_complete",
      description:
        "Declare the active goal complete. Only call this after the completion audit proves every requirement is satisfied against current state. See the injected goal system block for the audit you must pass first.",
      input: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Optional short summary of what was accomplished." },
        },
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const args = (input ?? {}) as { summary?: string }
        const goal = store.get(context.sessionID)
        if (!goal) return { content: "No active goal to complete." }
        store.setStatus(context.sessionID, "complete")
        return { content: args.summary ? `Goal marked complete: ${args.summary}` : "Goal marked complete." }
      },
    })

    editor.add({
      name: "goal_blocked",
      description:
        "Declare the active goal blocked. Only call this when the strict blocked audit in the injected goal system block is satisfied (the same blocker has recurred across turns and you cannot make meaningful progress without user input).",
      input: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the goal is blocked and what is needed to unblock it." },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const args = (input ?? {}) as { reason?: string }
        const goal = store.get(context.sessionID)
        if (!goal) return { content: "No active goal to block." }
        store.setStatus(context.sessionID, "blocked")
        return { content: `Goal marked blocked: ${args.reason ?? ""}` }
      },
    })
  })

  // (B) /goal command surface. The executor receives the session, the prompt the
  // user submitted with the command, and the requested delivery mode.
  await ctx.command.transform((editor) => {
    editor.add({
      name: "goal",
      description:
        "Set or control a persistent, self-verifying goal for this session. Usage: /goal <objective> | /goal (view) | /goal pause | /goal resume | /goal clear",
      execute: async ({ sessionID, prompt, delivery }) => {
        // The prompt text is the raw text submitted with the command; depending
        // on the client it may or may not carry the leading "/goal" token. Strip
        // it only when present (the slash is required, so an objective that
        // merely starts with the word "goal" is left intact), then hand the
        // arguments to the shared parser.
        const args = prompt.text.replace(/^\s*\/goal\b/i, "").trim()
        const action = parseGoalArgs(args)
        switch (action.kind) {
          case "set": {
            store.set(sessionID, action.objective)
            // Seed the first turn: the objective + audit ride in via system injection
            // (the goal is now active), so the user part stays minimal.
            await ctx.session.prompt({ ...prompt, sessionID, text: CONTINUE_NUDGE, delivery })
            return
          }
          case "pause": {
            // Honest confirmation: don't claim to have paused a goal that isn't there.
            if (!store.get(sessionID)) {
              await ctx.session.synthetic({ sessionID, text: "No goal set for this session." })
              return
            }
            store.setStatus(sessionID, "paused")
            await ctx.session.synthetic({
              sessionID,
              text: "[goal] paused — automatic continuations stopped; the objective is preserved. `/goal resume` to continue.",
            })
            return
          }
          case "resume": {
            const existing = store.get(sessionID)
            if (!existing) {
              await ctx.session.synthetic({ sessionID, text: "No goal set for this session." })
              return
            }
            const wasComplete = existing.status === "complete"
            store.setStatus(sessionID, "active")
            await ctx.session.synthetic({
              sessionID,
              text: wasComplete
                ? "[goal] resumed — re-opening a completed goal; the continuation loop restarts."
                : "[goal] resumed.",
            })
            return
          }
          case "clear": {
            if (!store.get(sessionID)) {
              await ctx.session.synthetic({ sessionID, text: "No goal set for this session." })
              return
            }
            store.clear(sessionID)
            await ctx.session.synthetic({ sessionID, text: "[goal] cleared." })
            return
          }
          case "view": {
            await ctx.session.synthetic({ sessionID, text: viewText(store.get(sessionID)) })
            return
          }
        }
      },
    })
  })

  // (C) per-turn injection — fires on user AND programmatic continuation turns.
  // V1's experimental.chat.system.transform maps to the "context" hook: the
  // system array is mutable; push the goal block and it rides along on the request.
  await ctx.session.hook("context", (event) => {
    const id = event.sessionID
    const goal = store.get(id)
    if (!goal || goal.status !== "active") return
    const block = renderGoalSystem(goal)
    event.system.push({ type: "text", text: block })
    sink({ kind: "inject", sessionID: id, block })
  })

  // (E) uncapped idle continuation + error brake. Abort the stream on cleanup.
  //
  // Event contract (verified empirically against OpenCode 2.0.27): the public
  // event stream signals the end of a turn with session.execution.succeeded /
  // .failed / .interrupted — each carrying data.sessionID. There is no
  // session.idle event on the wire (the V1 plugin's trigger; the docs' event
  // example is stale), so the V2 continuation trigger is:
  //   - session.execution.succeeded  -> turn N finished -> continuation N+1
  //   - session.execution.failed     -> error brake (below)
  //   - session.execution.interrupted-> the user (or a supersede/shutdown/inactivity
  //                                    policy) stopped the run: no continuation.
  //                                    The goal STAYS active — the loop restarts on
  //                                    the next user message or `/goal resume`.
  const controller = new AbortController()
  // Hold the iterator explicitly: an aborted signal alone does not reliably end
  // a for-await over the public event stream (verified live: after a hot reload,
  // a still-connected client's old instance kept consuming events indefinitely).
  // cleanup() calls iterator.return(), which deterministically terminates the
  // loop below regardless of the stream's signal semantics.
  const stream = ctx.event.subscribe({ signal: controller.signal })
  const iterator = stream[Symbol.asyncIterator]()
  void (async () => {
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        const event = next.value
        dumpEvent(event)
        try {
          // Track subagent children: a session.created with a parentID is a
          // background subagent spawned by that parent (foreground subagents
          // block the parent turn, so they are already covered).
          if (event.type === "session.created") {
            const parentID = event.data.parentID
            const childID = event.data.sessionID
            if (parentID && childID) {
              const siblings = childrenByParent.get(parentID) ?? new Set<string>()
              siblings.add(childID)
              childrenByParent.set(parentID, siblings)
            }
            continue
          }

          if (event.type === "session.execution.succeeded") {
            // Deliberate assumption: one succeeded per completed turn, so each
            // completion drives at most one continuation (uncapped contract).
            const id = event.data.sessionID
            const goal = store.get(id)
            // The ONLY gate. No in-flight mutex on the loop itself (a drop-guard
            // would cap the loop at 1) — but the single-actor lock below still
            // dedupes across live plugin instances sharing this location.
            if (!goal || goal.status !== "active") continue

            // Subagent wait: while any background child session of this
            // orchestrator is still running, skip the nudge. The host's
            // child-completion synthetic steers the next parent turn, and that
            // turn's own execution.succeeded re-enters here with the children
            // gone — the loop resumes with no plugin-side wake-up logic.
            const children = childrenByParent.get(id)
            if (children && children.size > 0) {
              let busy = false
              for (const childID of [...children]) {
                let info: { outcome?: "succeeded" | "failed" | "interrupted" } | undefined
                try {
                  info = await ctx.session.get({ sessionID: childID })
                } catch {
                  info = undefined
                }
                if (!info) {
                  children.delete(childID)
                  continue
                }
                if (info.outcome == null) {
                  busy = true
                  break
                }
                children.delete(childID)
              }
              if (children.size === 0) childrenByParent.delete(id)
              if (busy) {
                sink({ kind: "wait-children", sessionID: id })
                log("background subagent(s) still running — skipping continuation", id)
                continue
              }
            }

            // Single-actor lock: only one live instance continues a given turn.
            const eventKey = String((event as { id?: string }).id ?? (event as { created?: number }).created ?? "")
            const lock = tryTurnLock(stateDir, `${id}-${eventKey}`)
            if (!lock) continue
            // Set the counter BEFORE awaiting (reentrancy-safe).
            store.incrementTurn(id)
            sink({ kind: "continue", sessionID: id, turnCount: store.get(id)?.turnCount })

            try {
              // No model field -> inherit the session model (Task 0.4).
              await ctx.session.prompt({ sessionID: id, text: CONTINUE_NUDGE })
            } catch (err) {
              // Transport/disposal throw: leave active (uncapped contract).
              log("continuation prompt threw (transport/disposal) — leaving goal active", id, err)
            } finally {
              try {
                unlinkSync(lock)
              } catch {
                // Best-effort cleanup; an orphan is inert (event ids never recur).
              }
            }
            continue
          }

          if (event.type === "session.execution.failed") {
            const id = event.data.sessionID
            if (!id) continue
            const goal = store.get(id)
            if (!goal || goal.status !== "active") continue
            const error = event.data.error
            if (isModelTurnError({ name: canonicalErrorName(error.type), message: error.message })) {
              store.setStatus(id, "blocked")
              log("session.execution.failed names an active goal (model/turn error) — goal blocked", id, error)
            } else {
              log("session.execution.failed is a non-model error (transport/infra/unknown) — leaving goal active", id, error)
            }
            continue
          }

          if (event.type === "session.execution.interrupted") {
            // The turn was interrupted (user interrupt, superseded by a newer
            // prompt, shutdown, or inactivity): do NOT auto-continue. The goal
            // stays active; the loop restarts on the next user-driven turn.
            log("turn interrupted — skipping continuation (goal stays active)", event.data.sessionID, event.data.reason)
            continue
          }
        } catch (err) {
          // Never break the subscription on an unexpected throw — matches graceful one-shot.
          log("event handler error (ignored)", err)
        }
      }
    } catch (err) {
      // Stream closed or aborted (cleanup/shutdown): exit quietly.
      log("event subscription ended", err)
    }
  })()

  return () => {
    controller.abort()
    void iterator.return?.().catch(() => {})
  }
}

