# Extension Points — Where to Plug In Your Stack

Tool-Forge generates pseudo-code that you adapt to your stack. This document maps each extension point to common implementations.

---

## Validation Library (Schema)

The `schema` field on ToolDefinition accepts your validation library's schema type.

| Stack | Library | Schema Type | Example |
|-------|---------|-------------|---------|
| TypeScript | Zod | `z.ZodTypeAny` | `z.object({ city: z.string(), units: z.enum(['metric', 'imperial']).default('metric') })` |
| TypeScript | Joi | `Joi.ObjectSchema` | `Joi.object({ city: Joi.string().required() })` |
| Python | Pydantic | `type[BaseModel]` | `class GetWeatherInput(BaseModel): city: str; units: str = 'metric'` |
| Go | struct tags | `struct` | `type GetWeatherInput struct { City string \`validate:"required"\` }` |
| Any | JSON Schema | `object` | `{ "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }` |

The schema serves three purposes:
1. **Runtime validation** of LLM-generated parameters
2. **JSON Schema generation** for the LLM's tool definition
3. **Type hints** for your IDE

---

## Authentication (context.auth)

Replace the generic `AuthCredentials` with your auth pattern.

| Pattern | Shape | Example |
|---------|-------|---------|
| JWT passthrough | `{ mode: 'user', jwt: string }` | Forward the user's JWT to downstream APIs |
| API key | `{ apiKey: string }` | Static API key from environment |
| OAuth token | `{ accessToken: string, refreshToken?: string }` | OAuth 2.0 access token |
| Dual mode | `{ mode: 'user', jwt } \| { mode: 'service', apiKey }` | Discriminated union for user vs service contexts |
| None | `{}` | Tool doesn't need auth (local computation) |

---

## API Client (context.client)

Replace the generic `ApiClient` with your HTTP/gRPC/SDK client.

| Pattern | Implementation |
|---------|---------------|
| HTTP (fetch/axios) | Singleton wrapper with base URL, timeout, error handling |
| gRPC | Generated client stub with channel management |
| SDK wrapper | Thin adapter around a vendor SDK (e.g., Stripe, Twilio) |
| Database | Direct database client (Prisma, Knex, SQLAlchemy) |

The client should handle:
- Base URL configuration (different for dev/prod)
- Timeout management
- Auth header injection from `context.auth`
- Error normalization (HTTP status → structured error)

---

## HITL (Human-in-the-Loop) for Confirmation Tools

When `requiresConfirmation: true`, the tool must pause for user approval before executing.

| Framework | Pattern |
|-----------|---------|
| **LangGraph** | `interrupt({ toolName, proposedParams, description })` in execute(). Catch block must check `isGraphInterrupt(err)` and re-throw. Resumes via checkpoint. |
| **Custom webhook** | POST proposed action to an approval endpoint. Store pending action with TTL. Poll or wait for callback. |
| **CLI agent** | Print a summary of what will be executed. Wait for y/n input on stdin. |
| **Chat UI** | Send a confirmation card/button to the user. Wait for the button click event. |
| **Auto-approve matrix** | Check `context.autoApproveTools?.has(toolName)`. If present, skip confirmation. Otherwise, use one of the above patterns. |

**Key rule:** `isGraphInterrupt` re-throw (or equivalent) is non-negotiable in frameworks that use exception-based interrupts. Without it, the interrupt is silently swallowed and the agent hangs permanently.

---

## Test Framework

| Stack | Framework | Mock Pattern |
|-------|-----------|-------------|
| TypeScript | Jest | `jest.Mocked<ApiClient>`, `jest.fn()` |
| TypeScript | Vitest | `vi.fn()`, same patterns as Jest |
| Python | pytest | `unittest.mock.MagicMock`, `@pytest.fixture` |
| Go | testing | Interface-based mocks, `testify/mock` |

Minimum test cases for every tool:
1. **Success path** — mock client returns data, assert ToolResult has data, no error
2. **Error path** — mock client throws, assert ToolResult has error, no data
3. **Cancellation** — abortSignal already aborted, assert early return without calling client

---

## Barrel Registration

| Language | Pattern | Auto-Discovery |
|----------|---------|----------------|
| TypeScript | `export { tool } from './file'` in barrel file | `Object.values(imports)` in index.ts |
| Python | `__all__` in `__init__.py` | `import *` pattern |
| Go | `init()` registers in global slice | Package-level `var AllTools []ToolDefinition` |
| Rust | `inventory` crate | Attribute macro auto-registration |

The principle: one file to edit per tool, everything else auto-discovers.

---

## Adding a New Service to ToolContext

When a tool needs a service not in the standard context:

1. **Add the field** to your ToolContext interface:
   ```
   interface ToolContext {
     // ... existing fields ...
     db?: DatabaseService;  // new service (optional so existing tools aren't affected)
   }
   ```

2. **Pass the instance** into tool context construction (single location in your agent service).

3. **Re-run /forge-tool** to generate the tool with the updated context.

Keep the context lean. Most tools should only need `client` + `auth`. If you find yourself adding many services, consider whether the tool is doing too much.
