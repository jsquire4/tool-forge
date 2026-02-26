# Verifier Pattern — Registry and Interface

Verifiers run after the agent responds. They check the response and tool call history for quality, safety, and compliance. One verifier can apply to many tools (one-to-many).

---

## Verifier Interface

```typescript
interface ToolCallRecord {
  toolName: string;
  params: unknown;
  result: string;      // JSON.stringify(ToolResult)
  calledAt: string;
  durationMs: number;
  success: boolean;
}

interface VerificationResult {
  pass: boolean;      // false if flags.length > 0
  warnings: string[]; // informational, never block
  flags: string[];    // hard failures, short-circuit pipeline
}

interface Verifier {
  name: string;       // identifier
  order: string;      // lexicographic for execution order (e.g. "A-0001")
  verify: (
    response: string,
    toolCalls: ToolCallRecord[],
    channel?: string
  ) => Promise<VerificationResult>;
}
```

---

## Order Categories

| Prefix | Category | Examples |
|--------|----------|----------|
| A-xxxx | Attribution | Source citation, data provenance |
| C-xxxx | Compliance | Regulatory checks, policy |
| I-xxxx | Interface | Format validation, length limits |
| R-xxxx | Risk | Concentration, exposure |
| U-xxxx | Uncertainty | Confidence scoring |

---

## Registry Pattern (Barrel)

Same as tools: one file to edit, auto-discovery.

```
verifiers.exports.ts   ← one export per verifier
verification/index.ts  ← derives ALL_VERIFIERS from exports
```

**verifiers.exports.ts:**
```typescript
// THE ONLY FILE TO EDIT WHEN ADDING A VERIFIER.
export { SourceAttributionVerifier } from './source-attribution.verifier';
export { ConcentrationRiskVerifier } from './concentration-risk.verifier';
export { StaleDataVerifier } from './stale-data.verifier';
```

**verification/index.ts:**
```typescript
// NEVER edit manually — ALL_VERIFIERS derived from verifiers.exports.ts
import * as verifierExports from './verifiers.exports';
export const ALL_VERIFIERS: Verifier[] = Object.values(verifierExports)
  .filter((V): V is new () => Verifier => typeof V === 'function')
  .map((V) => new V());
```

---

## Pipeline Behavior

- Verifiers run in `order` (lexicographic)
- **Warnings** — appended to response, never block
- **Flags** — short-circuit; later verifiers are skipped
- Each verifier must not throw; catch and return in result
