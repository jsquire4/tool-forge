# Tool-Forge — Project Instructions

## What This Is

Tool-Forge is a production LLM agent sidecar + Claude Code skill library for building, testing, and running tool-calling agents. It has two jobs:

1. **Sidecar runtime** (`lib/`) — deploy alongside your app. Handles the full ReAct loop, HITL gates, verifier pipeline, eval runner, MCP server, multi-provider LLM client (Anthropic, OpenAI, Gemini, DeepSeek), auth, rate limiting, conversation persistence, drift monitoring, and observability. Entry point: `lib/sidecar.js` (library) / `lib/index.js` (TUI + CLI).
2. **Skill library** (`skills/`) — Claude Code skills that generate tools, eval suites, verifiers, and MCP servers via structured 12-phase dialogue. Framework-agnostic and language-agnostic — the skills produce code adapted to the user's stack.

## Conventions

- **Pseudo-code vs real code.** Some templates are pseudo-code (conceptual, adapt to your stack); others are real code (MCP templates, weather example). See `docs/REAL-VS-PSEUDO.md`. Pseudo-code uses `// EXTENSION POINT` comments.
- **Skills reference files, not inline.** SKILL.md files stay under ~400 lines. Detailed specs live in `references/`. Progressive disclosure.
- **`{{placeholder}}` syntax.** Templates use `{{name}}`, `{{description}}`, etc. for values the skill fills in during dialogue. `// EXTENSION POINT` marks where the user's stack-specific code goes.
- **The CLI (`lib/`) is real runnable Node.js code.** Templates and skills are reference material. The `example/` directory has a working tool+verifier setup wired to the CLI. Run `node lib/index.js` or `npm start` from the repo root.

## File Organization

```
lib/             — Production sidecar runtime + TUI + CLI (real runnable Node.js)
skills/          — Claude Code skill definitions (SKILL.md + references/)
templates/       — Annotated pseudo-code templates with extension points
docs/            — Architecture guide, worked examples, API reference
config/          — Optional configuration templates
example/         — Real tool + verifier files wired to the CLI demo
widget/          — <forge-chat> web component (vanilla JS, zero deps)
```

## Editing Rules

- When editing a SKILL.md, keep it under 400 lines. Move detailed specs to `references/`.
- When editing templates, preserve all `// EXTENSION POINT` comments and `{{placeholder}}` tokens.
- **Naming:** `.pseudo.ts` / `.pseudo.py` = conceptual, not runnable. `.example.ts` = runnable example. `.template.ts` / `.template.py` = real code with `{{placeholders}}` (fill to run). JSON templates use `.template.json`.

## Skill Installation

Users install skills by copying the `skills/<skill-name>/` directory into their project's `.claude/skills/` directory or their global `~/.claude/skills/` directory.
