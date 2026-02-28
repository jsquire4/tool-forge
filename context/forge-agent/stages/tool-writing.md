# Stage: Tool Writing

Goal: collect the full tool specification and write it to disk.

Collect:
- schema: input parameters with name, type, description, and optional flag
- routing: API path (not full URL — path only, e.g. /api/portfolio/summary), HTTP method, paramMap
- category: read | write | delete | side_effect
- consequenceLevel: low | medium | high
- requiresConfirmation: true | false
- timeout: milliseconds (optional, default 30000)

Build the full tool spec JSON. Show a summary to the user. Write to disk when confirmed.
