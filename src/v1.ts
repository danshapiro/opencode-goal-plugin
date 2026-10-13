// Legacy V1 entrypoint. OpenCode 1 hosts load the plugin as a default-exported
// function; OpenCode >= 1.18.29 also accepts the object entrypoint exposed at the
// package root (index.ts). Point V1 hosts that need the function shape at this
// module (package export "./v1") — the default export here is the original
// GoalPlugin function, unchanged.
export { GoalPlugin as default } from "./plugin"
