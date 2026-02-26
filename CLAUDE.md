# Tool-Forge — Project Instructions

## What This Is

Tool-Forge is a collection of Claude Code skills and templates for building LLM agent tools with structured dialogue workflows. It is framework-agnostic and language-agnostic — the skills produce pseudo-code that the LLM adapts to the user's stack.

## Conventions

- **Pseudo-code, not real code.** All templates use language-agnostic pseudo-code with `// EXTENSION POINT` comments. Never add framework-specific imports or decorators to templates.
- **Skills reference files, not inline.** SKILL.md files stay under ~400 lines. Detailed specs live in `references/`. Progressive disclosure.
- **`{{placeholder}}` syntax.** Templates use `{{name}}`, `{{description}}`, etc. for values the skill fills in during dialogue. `// EXTENSION POINT` marks where the user's stack-specific code goes.
- **No runnable code in the repo.** This is a skill + template library, not an npm package or CLI tool. There is no `package.json`, no `tsconfig.json`, no build step.

## File Organization

```
skills/          — Claude Code skill definitions (SKILL.md + references/)
templates/       — Annotated pseudo-code templates with extension points
docs/            — Architecture guide, blog post, worked examples
config/          — Optional configuration templates
```

## Editing Rules

- When editing a SKILL.md, keep it under 400 lines. Move detailed specs to `references/`.
- When editing templates, preserve all `// EXTENSION POINT` comments and `{{placeholder}}` tokens.
- Templates use `.pseudo.ts` or `.pseudo.py` extensions to signal they are not runnable code.
- JSON templates use `.template.json` extension.

## Skill Installation

Users install skills by copying the `skills/<skill-name>/` directory into their project's `.claude/skills/` directory or their global `~/.claude/skills/` directory.
