# Weather API — Complete Worked Example

This walkthrough shows what the `/forge-tool` → `/forge-eval` → `/forge-mcp` pipeline produces for a simple weather API tool.

---

## Files in This Example

| File | Source Skill | Purpose |
|------|-------------|---------|
| `get-weather.tool.pseudo.ts` | `/forge-tool` | Tool implementation (pseudo-code) |
| `get-weather.mcp.example.ts` | `/forge-mcp` | MCP server — **real runnable code** |
| `get-weather.golden.json` | `/forge-eval` | 6 golden eval cases (single-tool routing) |
| `get-weather.labeled.json` | `/forge-eval` | 9 labeled eval cases (multi-tool + adversarial) |

---

## The Dialogue (What Happened in Each Phase)

### Phase 0: Read Current State

```
Existing tools:
  - get_forecast — Fetches 5-day weather forecast from OpenWeather API...
  - get_air_quality — Retrieves air quality index from OpenWeather API...

Adding a new tool.
```

### Phase 1: Creative Exploration

> **User:** "I want a tool that gets the current weather for a city."
>
> **Claude:** "Makes sense — your agent has forecasts and air quality but no current conditions. Would it be useful to include humidity and wind speed, or just temperature and conditions? Also, should it support both Celsius and Fahrenheit?"
>
> **User:** "All of that — temperature, conditions, humidity, wind. And yes, support metric/imperial units."

### Phase 2: Skeptic Gate

> **Claude:** "Before we build this — could get_forecast cover current weather too? Most forecast APIs include the current hour's data."
>
> **User:** "Different use case. 'What's the weather right now' is the most common question and should route to a lightweight, fast endpoint. Forecasts are heavier."
>
> **Claude:** "Fair. The agent would lose immediate weather answers without this tool. It's distinct from get_forecast (current vs future) and get_air_quality (weather vs pollution). Scope is right — one thing, done well."

### Phase 3: Lock the Routing Contract

> **Claude:** "Here's the description I'd write:
>
> *Fetches current weather conditions for a city from the OpenWeather API. Use when the user asks about current weather, temperature, or conditions for a specific location. For weather forecasts, use get_forecast instead.*
>
> Does this clearly distinguish from get_forecast and get_air_quality?"
>
> **User:** "Yes, that's clear."
>
> **Claude:** "Name: `get_weather`. Trigger phrases:
> 1. What's the weather in Paris?
> 2. Is it cold outside?
> 3. Current temperature in Tokyo
> 4. What are the conditions in London?
> 5. How hot is it in Dubai?"

### Phase 4-6: Fields, Dependencies, Spec Confirmation

```
Tool Spec — ready to generate:

  name:                 get_weather
  description:          Fetches current weather conditions for a city...
  category:             read
  consequenceLevel:     low
  requiresConfirmation: false
  timeout:              15000ms
  tags:                 [weather, external-api]
  schema:
    city:  string (required) — City name or "city, country code"
    units: enum [metric, imperial, kelvin] (default: metric)
  trigger phrases:      5 phrases listed above

Shall I proceed?
```

### Phase 7-8: Generate and Test

Tool implementation, test file, and barrel registration generated. Tests pass:
- Success path: mock API returns weather data, verify ToolResult shape
- Error path: mock API throws, verify error in ToolResult
- Cancellation: aborted signal, verify early return

### Phase 9: Generate Evals

Golden: 6 cases (see `get-weather.golden.json`)
- 3 trigger phrase variants
- 2 rephrased variants
- 1 JSON leak check
- 1 disambiguation (current vs forecast)

Labeled: 9 cases (see `get-weather.labeled.json`)
- 3 straightforward (2-tool and 3-tool combinations)
- 3 ambiguous (umbrella question, "what's it like", trip planning)
- 3 edge (prompt injection, general knowledge, off-topic)

---

## How to Use This Example

1. **Study the description** — Notice how it answers what/when/when-not/source in one sentence.

2. **Study the assertions** — Golden evals use `responseContains` for proof values (city names), `responseContainsAny` for domain terms (temperature synonyms), and `responseNotContains` for cop-outs and leaks.

3. **Study the ambiguous cases** — The `toolsAcceptable` field allows multiple valid strategies. "Should I bring an umbrella" could use weather alone, forecast alone, or both. All are correct.

4. **Study the MCP server** — Compare `get-weather.tool.pseudo.ts` with `get-weather.mcp.example.ts` to see how the same spec produces both formats. The MCP example is real runnable code.

5. **Adapt to your domain** — Replace "weather" with your domain. The patterns are the same: description contract, deterministic assertions, overlap-driven ambiguity testing.
