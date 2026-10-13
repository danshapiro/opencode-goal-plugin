// Plugin entry point.
//
// Dual-shape default export: one package loads on both OpenCode generations.
//   - OpenCode 2 calls  setup(ctx)      (V2 plugin API, src/v2.ts)
//   - OpenCode >= 1.18.29 calls server(input)  (V1 hooks contract, src/plugin.ts)
//   - OpenCode < 1.18.29 hosts load the function shape from the "./v1" export
//     (src/v1.ts) — or via scripts/install.sh, which wires src/plugin.ts directly.
//
// `server` is lazy on purpose: src/plugin.ts pulls src/tools.ts, which imports
// `tool()` from the V1 `@opencode-ai/plugin` package at runtime. OpenCode 2 hosts
// do not provide that module, so statically importing it here would fail the whole
// plugin on V2; the dynamic import only runs when a V1 host actually calls server().
//
// Plugin.define (V2) is the identity function, so a plain object with { id, setup }
// satisfies the V2 plugin contract without importing "@opencode/plugin" at runtime
// (its types are imported type-only in src/v2.ts and erased at transpile time).

import { setup } from "./src/v2"

import type { PluginInput } from "@opencode-ai/plugin"

export { isModelTurnError } from "./src/errors"
export { setup as setupV2 } from "./src/v2"

export default {
  id: "goal",
  server: (input: PluginInput) =>
    import("./src/plugin").then((m) => m.GoalPlugin(input)) as Promise<unknown>,
  setup,
}

