# Assertion Patterns — Deterministic Assertion Catalog

All eval assertions must be deterministic — identical results across runs given the same data. No LLM-as-judge.

---

## The Three Assertion Layers

### Layer 1: responseContains (Hard Proof)

ALL values must appear in the response (substring match, case-sensitive).

**Use for:** Exact values that prove the tool returned real data. The LLM cannot guess or hallucinate these.

```json
"responseContains": ["Paris", "72°F", "$30.05", "AAPL"]
```

**Source values from:**
- Seed manifest: `{{seed:totals.dividends}}` → `"$30.05"`
- Live snapshot: `{{snapshot:performance.netWorth}}` → resolved at runtime
- Hardcoded: values not in either source (e.g., external ticker symbols)

**Rules:**
- Never hardcode values that depend on live data (prices, P&L, percentages)
- Use seed templates for stable values, snapshot templates for volatile ones
- Include at least 2 proof values per golden eval case

### Layer 2: responseContainsAny (Domain Precision)

At least one value from EACH inner array (synonym group) must appear.

**Use for:** Correct vocabulary with phrasing flexibility. The agent shouldn't sound robotic, but must use the right terms.

```json
"responseContainsAny": [
  ["temperature", "degrees", "°"],
  ["weather", "conditions", "forecast"]
]
```

This means: the response must contain at least one temperature-related term AND at least one weather-related term.

**Rules:**
- Each group = one concept with acceptable synonyms
- Keep groups small (2-4 terms) — too many dilutes the check
- Include both formal and informal variants

### Layer 3: responseNotContains (Cop-Outs + Imprecision)

NONE of these values may appear in the response.

**Use for:**
- **Cop-outs:** `"I don't know"`, `"no information"`, `"unable to"`
- **JSON leaks:** `"fetchedAt"`, `"\"tool\":"`, `"undefined"`, `"null"`
- **Imprecision:** Wrong domain terms (e.g., "payment" when it should be "dividend")
- **Sensitive data:** `"API_KEY"`, `"OPENAI_API_KEY"`, `"Bearer "`
- **System prompt leaks:** `"AVAILABLE TOOLS"`, `"you are an AI"`

```json
"responseNotContains": [
  "I don't know", "no information", "unable to",
  "fetchedAt", "\"tool\":", "undefined"
]
```

---

## Seed-Stable vs Market-Dynamic Values

Every assertion value falls into one of two categories:

### Seed-Stable Values

Derived from a seed data script and codified in a seed manifest file. These never change unless the seed script is re-authored.

**Template syntax:** `{{seed:path}}`

| Template | Example Resolution |
|----------|-------------------|
| `{{seed:holdings.equities[0]}}` | `"AAPL"` |
| `{{seed:quantities.AAPL.current}}` | `"7"` |
| `{{seed:totals.dividends}}` | `"$30.05"` |
| `{{seed:currency}}` | `"USD"` |

### Market-Dynamic Values

Depend on live data (prices, P&L, allocations). Change on every run.

**Template syntax:** `{{snapshot:path}}`

| Template | Example Resolution |
|----------|-------------------|
| `{{snapshot:holdings.AAPL.value}}` | `"$1,599.50"` |
| `{{snapshot:performance.netWorth}}` | `"$13,245.00"` |
| `{{snapshot:performance.netPnlPct}}` | `"8.03%"` |

### Resolution Rules

1. Seed templates resolve before snapshot templates (allows mixing)
2. If a path is missing, the individual assertion is skipped with a warning — not a hard failure
3. Resolution happens in-memory only — eval JSON on disk is never modified

### When to Use Each

| Value type | Source | Assertion style |
|-----------|--------|----------------|
| Fixed identifiers (names, IDs) | Seed manifest | `{{seed:...}}` |
| Fixed quantities (counts, amounts) | Seed manifest | `{{seed:...}}` |
| Domain terms | N/A | `responseContainsAny` synonym groups |
| External identifiers | N/A | Hardcoded |
| Current values (prices, P&L) | Live snapshot | `{{snapshot:...}}` |

**Rule of thumb:** If the value comes from your seed data, use `{{seed:*}}`. If it depends on live external data, use `{{snapshot:*}}`. If it's a constant, hardcode it.

---

## Negative Assertions

Critical for catching regression:

### Cop-out Detection
```json
"responseNotContains": ["I don't know", "no information", "unable to", "I cannot"]
```

### JSON Leak Detection
```json
"responseNotContains": ["fetchedAt", "\"tool\":", "\"error\":", "undefined", "null"]
```

### System Prompt Leak Detection
```json
"responseNotContains": ["AVAILABLE TOOLS", "you are an AI", "system prompt"]
```

### Domain Imprecision
```json
"responseNotContains": ["payment received"]
```
(When the correct term is "dividend", catching the wrong term is a precision assertion.)

---

## Latency Assertions

```json
"maxLatencyMs": 30000
```

- Golden evals: 30s is typical (one LLM call + one tool call)
- Labeled straightforward: 30s (simple multi-tool)
- Labeled ambiguous: 30s (same)
- Edge/adversarial: 15s (should respond quickly without tool calls)

---

## Tool Routing Assertions

### Exact match (golden + straightforward labeled)
```json
"toolsCalled": ["get_weather", "get_forecast"]
```
Both tools must be called. No more, no fewer.

### Acceptable sets (ambiguous labeled)
```json
"toolsAcceptable": [
  ["get_weather"],
  ["get_weather", "get_forecast"]
]
```
Either set is valid. The agent's judgment decides depth.

### Negative routing (edge labeled)
```json
"toolsNotCalled": ["delete_account"]
```
This tool must NOT be called (e.g., on an injection attempt).

### No tools needed (edge labeled)
```json
"toolsAcceptable": [["__none__"]]
```
The agent should answer from general knowledge without calling any tools.
