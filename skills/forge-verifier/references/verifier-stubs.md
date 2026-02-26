# Verifier Stubs — Code Templates

When forge-verifier generates a verifier, use these templates. Adapt to the user's stack (TypeScript/NestJS, Python, etc.).

---

## source_attribution

Applies to: all tools. Ensures every claim in the response maps to a tool call result.

```typescript
export class SourceAttributionVerifier implements Verifier {
  name = 'source_attribution';
  order = 'A-0001';

  async verify(
    response: string,
    toolCalls: ToolCallRecord[],
    _channel?: string
  ): Promise<VerificationResult> {
    // EXTENSION POINT: Define patterns for claims that need sourcing
    // Example: dollar amounts, percentages, numbers
    const dollarPattern = /\$[\d,]+\.?\d*/g;
    const percentPattern = /\d+\.?\d*%/g;
    const claims = [...(response.match(dollarPattern) ?? []), ...(response.match(percentPattern) ?? [])];

    if (claims.length === 0) return { pass: true, warnings: [], flags: [] };
    if (toolCalls.length === 0) {
      return { pass: false, warnings: ['Response contains claims with no tool calls'], flags: [] };
    }

    const combinedResults = toolCalls.filter(tc => tc.success).map(tc => tc.result).join(' ');
    const unsourced = claims.filter(claim => !combinedResults.includes(claim));

    return {
      pass: unsourced.length === 0,
      warnings: unsourced.length > 0 ? [`Unsourced claims: ${unsourced.join(', ')}`] : [],
      flags: []
    };
  }
}
```

---

## concentration_risk

Applies to: holdings output group. Flags positions above threshold.

```typescript
export class ConcentrationRiskVerifier implements Verifier {
  name = 'concentration_risk';
  order = 'R-0001';

  async verify(
    _response: string,
    toolCalls: ToolCallRecord[],
    _channel?: string
  ): Promise<VerificationResult> {
    const THRESHOLD = 0.2; // EXTENSION POINT: e.g. 20%
    const allocations: { symbol: string; allocation: number }[] = [];

    for (const tc of toolCalls) {
      if (!tc.success) continue;
      try {
        const parsed = JSON.parse(tc.result) as { data?: { holdings?: { symbol?: string; allocationInPercentage?: number }[] } };
        for (const h of parsed?.data?.holdings ?? []) {
          if (h.symbol != null && typeof h.allocationInPercentage === 'number') {
            allocations.push({ symbol: h.symbol, allocation: h.allocationInPercentage });
          }
        }
      } catch { continue; }
    }

    const flags = allocations
      .filter(a => a.allocation > THRESHOLD)
      .map(a => `Concentration: ${a.symbol} is ${(a.allocation * 100).toFixed(1)}%`);

    return { pass: flags.length === 0, warnings: [], flags };
  }
}
```

---

## stale_data

Applies to: holdings, performance, quotes. Warns when tool data is older than threshold.

```typescript
export class StaleDataVerifier implements Verifier {
  name = 'stale_data';
  order = 'A-0003';

  async verify(
    _response: string,
    toolCalls: ToolCallRecord[],
    _channel?: string
  ): Promise<VerificationResult> {
    const THRESHOLD_MS = 24 * 60 * 60 * 1000; // EXTENSION POINT: e.g. 24h
    const warnings: string[] = [];

    for (const tc of toolCalls) {
      if (!tc.success) continue;
      try {
        const parsed = JSON.parse(tc.result) as { fetchedAt?: string };
        if (!parsed?.fetchedAt) continue;
        const age = Date.now() - new Date(parsed.fetchedAt).getTime();
        if (age > THRESHOLD_MS) {
          warnings.push(`Stale data: ${tc.toolName} is ${Math.floor(age / 3600000)}h old`);
        }
      } catch { continue; }
    }

    return { pass: true, warnings, flags: [] };
  }
}
```

---

## Generic Stub

For custom verifiers:

```typescript
export class {{PascalName}}Verifier implements Verifier {
  name = '{{snake_name}}';
  order = '{{X-xxxx}}';

  async verify(
    response: string,
    toolCalls: ToolCallRecord[],
    channel?: string
  ): Promise<VerificationResult> {
    const warnings: string[] = [];
    const flags: string[] = [];

    // EXTENSION POINT: Implement your verification logic
    // Parse toolCalls[*].result (JSON) for structured data
    // Check response string for claims
    // Add to warnings (informational) or flags (hard fail)

    return { pass: flags.length === 0, warnings, flags };
  }
}
```
