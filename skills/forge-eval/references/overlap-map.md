# Tool Overlap Map — Format and Usage

The overlap map declares which tools are **close neighbors** — tools that could plausibly be confused by a natural language prompt. It serves two purposes:

1. **Eval generation** — The eval factory reads the map to target ambiguous cases at real overlaps
2. **Coverage gap detection** — Cross-reference the map with existing evals to find untested overlaps

---

## Structure

```json
{
  "get_weather": {
    "overlaps": ["get_forecast", "get_air_quality"],
    "clusters": [
      ["get_weather", "get_forecast", "get_air_quality"]
    ],
    "reason": "Weather queries are broad — 'what's it like outside' could route to current conditions, forecast, or air quality"
  },
  "get_forecast": {
    "overlaps": ["get_weather"],
    "clusters": [
      ["get_weather", "get_forecast", "get_air_quality"]
    ],
    "reason": "Future-oriented weather questions could route to forecast or current weather with extrapolation"
  }
}
```

### Fields

- **`overlaps`** — Pairwise close neighbors. Tools that could be confused 1:1.
- **`clusters`** — Groups of 3+ tools that frequently appear together in complex prompts. A cluster means "these tools naturally co-occur in multi-step tasks."
- **`reason`** — Human-readable explanation of why these tools overlap. Useful for onboarding and debugging.

---

## Rules

### When to declare an overlap
Two tools overlap when a natural language prompt could reasonably route to either one.
- `get_weather` and `get_forecast` overlap on "what's the weather like"
- `get_weather` and `delete_account` do NOT overlap

### Clusters capture natural groupings
When a user asks a broad question ("tell me everything about the weather"), which tools naturally get called together? That's a cluster. Cluster members don't need to be pairwise confusable — they just co-occur in multi-step tasks.

### Sparse, not exhaustive
At 50 tools, most tools should have 2-4 overlaps and 0-2 clusters. Hub tools may have more. The map is NOT an NxN matrix.

### Symmetric by convention
If A lists B as an overlap, B should list A.

### The tool factory adds the entry
When a new tool is created, the factory identifies close neighbors and clusters, then updates the overlap map. The eval factory reads it.

### Coverage check surfaces gaps
A coverage check should report:
- (a) tools with no golden evals
- (b) tools with no labeled evals
- (c) declared overlaps with no ambiguous eval testing both tools together
- (d) declared clusters with no labeled eval exercising the full group

---

## When NOT to Add an Overlap

- Tools in different categories serving obviously different purposes (read vs write)
- Tools whose descriptions have zero shared trigger conditions
- Tools where confusion would require a badly malformed prompt

---

## Growth Management

As the registry scales, periodically review the map for stale entries. If two tools' descriptions have been refined to eliminate confusion, remove the overlap. The coverage check confirms they're no longer tested together — which is correct if they genuinely don't overlap.

---

## How the Eval Factory Uses the Map

1. **Read the map** before generating labeled evals
2. **Count overlaps (O) and clusters (C)** for the scaling formula
3. **Target ambiguous cases at declared overlaps** — every overlap pair gets at least one ambiguous eval
4. **Use clusters for multi-tool cases** — clusters drive 3-tool and 4+ tool labeled cases
5. **After generation**, verify every declared overlap has coverage

The map turns ambiguous eval generation from guesswork into a directed process.
