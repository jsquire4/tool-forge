# Description Contract — The Routing Contract Format

The tool's `description` field is the **single source of truth** for how the LLM decides when to use this tool. It flows directly into the system prompt. The LLM reads this description and uses it to decide which tool to call for a given user message.

**A vague description = wrong tool routing = failed evals.**

---

## Format

```
<What it does>. Use when <trigger condition>. <Disambiguation if needed>.
```

### Components

1. **What it does** — The action, not what it returns.
   - Good: "Retrieves the user's dividend payment history"
   - Bad: "Returns dividend data"

2. **When to use it** — The trigger condition that distinguishes it from every other tool.
   - Good: "Use when the user asks about dividends, income, or yield"
   - Bad: (omitted — LLM guesses)

3. **When NOT to use it** — Disambiguation hint if there's common confusion with another tool.
   - Good: "For overall portfolio performance, use portfolio_summary instead"
   - Bad: (omitted when there IS an obvious overlap)

4. **Data source** — Which API or computation backs it.
   - Good: "Queries the OpenWeather API for current conditions"
   - Bad: (omitted — LLM doesn't know if data is real or hallucinated)

---

## Examples

### Good Descriptions

```
Retrieves a pre-formatted portfolio summary. Use when the user asks for a
portfolio overview, summary, or general "how am I doing" questions.
```

```
Fetches the user's dividend payment history with dates and amounts. Use when
the user asks about dividends, income, or yield. For overall portfolio
performance, use portfolio_summary instead.
```

```
Fetches current weather conditions for a city from the OpenWeather API. Use
when the user asks about current weather, temperature, or conditions for a
specific location. For weather forecasts, use get_forecast instead.
```

```
Places a buy or sell order for a security. Use when the user explicitly
requests to buy or sell shares. Always confirm with the user before executing.
```

```
Searches the documentation knowledge base using semantic similarity. Use when
the user asks a question about product features, configuration, or
troubleshooting. For API reference lookups, use search_api_docs instead.
```

### Bad Descriptions (and why)

| Description | Problem |
|-------------|---------|
| `Gets portfolio data` | Too vague — overlaps with every portfolio tool |
| `Analyzes holdings` | Doesn't say when to use it vs portfolio_summary |
| `Returns JSON from the holdings endpoint` | Describes implementation, not purpose |
| `A tool for weather` | No trigger condition, no disambiguation |
| `Helpful tool for users` | Says nothing actionable |
| `Handles financial data` | Every tool in a finance agent handles financial data |

---

## Testing Your Description

Before locking a description, apply these checks:

1. **Swap test:** Could you swap this description with another tool's description and have the same routing? If yes, the descriptions are too vague.

2. **Keyword test:** Does the description contain the keywords a user would naturally use? "dividends", "income", "yield" for a dividend tool — not just "financial data".

3. **Negative test:** If a user asks something that should NOT route here, does the description make that clear? If there's a common confusion, add "For X, use Y instead."

4. **Completeness test:** Could an LLM with no other context correctly route a user message to this tool based solely on the description? If it needs to read the schema or implementation to decide, the description is incomplete.

---

## Common Pitfalls

- **Hub tools** (like `portfolio_summary`) need extra disambiguation because they attract broad queries. Be more specific about what makes a query route HERE vs to a specific tool.

- **Overlapping verbs** — "get", "fetch", "retrieve" all mean the same thing to an LLM. Differentiate by the WHAT and WHEN, not the verb.

- **Missing "use when"** — The trigger condition is the most important part. Without it, the LLM pattern-matches on nouns alone, which is brittle.

- **Too long** — Keep it to 1-2 sentences. The LLM processes all tool descriptions at once. Walls of text dilute signal.
