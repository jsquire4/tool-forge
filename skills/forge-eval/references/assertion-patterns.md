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

---

## Parameter Assertions

Checks that the model passed correct arguments to the tool. This catches a failure class that routing assertions miss entirely: the model calls the right tool but passes wrong, missing, or hallucinated parameters.

### Why This Matters

BFCL and Google ADK both test parameter-level accuracy. Without it, your evals only prove the model picked the right tool — not that it used it correctly. A model that calls `get_weather` with `city: "the weather"` instead of `city: "Paris"` passes all routing assertions and all response assertions (if the tool errors gracefully and the model recovers). The parameter assertion catches it.

### Assertion Types

```json
"toolParams": [
  { "tool": "get_weather", "paramName": "city", "assertion": "contains", "value": "Paris" },
  { "tool": "get_weather", "paramName": "units", "assertion": "oneOf", "value": ["metric", "imperial"] }
]
```

| Assertion | Use When | Example |
|-----------|----------|---------|
| `equals` | Exact value known | `city` = `"Paris"` |
| `contains` | Model may normalize | `city` contains `"Tokyo"` (could be `"Tokyo"` or `"Tokyo, JP"`) |
| `oneOf` | Multiple valid values | `units` is `"metric"` or `"imperial"` |
| `exists` | Parameter must be provided | `city` was sent (any value) |
| `notExists` | Catch hallucinated params | `country_code` should not be sent if schema doesn't define it |
| `matches` | Format validation | `date` matches `^\d{4}-\d{2}-\d{2}$` |

### Golden Eval Example

```json
{
  "id": "gs-get-weather-001",
  "description": "trigger phrase — direct weather question",
  "input": { "message": "What's the weather in Paris?" },
  "expect": {
    "toolsCalled": ["get_weather"],
    "toolParams": [
      { "tool": "get_weather", "paramName": "city", "assertion": "contains", "value": "Paris" }
    ],
    "noToolErrors": true,
    "responseNonEmpty": true,
    "responseContains": ["Paris"],
    "responseContainsAny": [["temperature", "degrees", "°"]],
    "maxLatencyMs": 30000
  }
}
```

### Multi-Tool Labeled Example

```json
{
  "id": "ls-get-weather-001",
  "description": "straightforward — weather + forecast synthesis",
  "difficulty": "straightforward",
  "input": { "message": "What's the weather in Tokyo today and what should I expect this week?" },
  "expect": {
    "toolsCalled": ["get_weather", "get_forecast"],
    "toolParams": [
      { "tool": "get_weather", "paramName": "city", "assertion": "contains", "value": "Tokyo" },
      { "tool": "get_forecast", "paramName": "city", "assertion": "contains", "value": "Tokyo" }
    ],
    "noToolErrors": true,
    "responseNonEmpty": true,
    "responseContains": ["Tokyo"],
    "maxLatencyMs": 30000
  }
}
```

### Rules

- Use `contains` over `equals` by default — models normalize inputs in unpredictable ways
- Use `oneOf` for enum fields where defaults may vary by context
- Use `exists` sparingly — it's weak (any value passes). Prefer `contains` or `equals`.
- Parameter assertions are SKIPPED if the tool wasn't called (routing already failed)
- When `toolsAcceptable` is used, only assert params for tools that were actually called
- Use `{{seed:*}}` in values for data-dependent parameters: `{ "assertion": "equals", "value": "{{seed:holdings.equities[0].symbol}}" }`
