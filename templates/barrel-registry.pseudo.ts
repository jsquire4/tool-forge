// ============================================================================
// Barrel Registry — The drop-in tool registration pattern.
//
// This file is the ONLY file you edit when adding a new tool. One export per
// tool. Git auto-merges non-adjacent single-line additions cleanly, so
// multiple developers can add tools in parallel without conflicts.
// ============================================================================

// ── tools.exports.ts (or equivalent in your language) ───────────────────────
//
// THE ONLY FILE TO EDIT WHEN ADDING A TOOL.
// One export per tool. Alphabetical order recommended but not required.

export { getWeatherTool } from './get-weather.tool';
export { searchDocsTool } from './search-docs.tool';
// export { yourNewTool } from './your-new-tool.tool';   ← add one line here


// ── tools/index.ts (auto-derives ALL_TOOLS — NEVER edit manually) ──────────
//
// import * as toolExports from './tools.exports';
// export const ALL_TOOLS: ToolDefinition[] = Object.values(toolExports);
//
// This pattern gives you:
//   1. Drop-in registration — add one line, tool appears everywhere
//   2. Auto-discovery — ALL_TOOLS is always the complete set
//   3. No module registration — no DI decorators, no provider arrays
//   4. Merge-friendly — single-line additions rarely conflict


// ── How ALL_TOOLS flows through the system ──────────────────────────────────
//
// ALL_TOOLS is the single source of truth for the tool registry. It feeds:
//
//   1. System prompt builder — auto-generates the AVAILABLE TOOLS section
//      The LLM sees each tool's name, description, and category.
//
//   2. Agent loop — registers tools as callable functions
//      The LLM can invoke any tool in ALL_TOOLS.
//
//   3. API endpoint (optional) — exposes tool metadata for frontends
//      Schema → JSON Schema conversion for UI form generation.
//
// No manual wiring. Add the export line, everything else is automatic.


// ── EXTENSION POINT: Adapt to your language ─────────────────────────────────
//
// TypeScript:  export { tool } from './file';  +  Object.values(imports)
// Python:      __all__ = [...] in __init__.py  +  import * pattern
// Go:          init() function registers tools in a global slice
// Rust:        inventory crate for auto-registration
//
// The principle is the same: one file to edit, everything else auto-discovers.
