# Verifier Factory and Registry

The forge-verifier skill detects tools without verifier coverage and generates verifier stubs. Verifiers are **one-to-many** — one verifier can apply to many tools.

---

## Registry Pattern (from GFAF)

Same as tools: barrel file + auto-discovery.

```
verifiers.exports.ts   ← one export per verifier (ONLY file to edit)
verification/index.ts  ← derives ALL_VERIFIERS from exports
```

**Order categories:** A (attribution), C (compliance), I (interface), R (risk), U (uncertainty)

---

## Flow

1. **Gap report** — Run `node cli/index.js --verifiers` for a quick report
2. **Or run `/forge-verifier`** in Claude for full dialogue
3. Skill loads tools, infers output groups, loads verifiers
4. Reports: "X tools have no verifier coverage"
5. User selects verifiers to create
6. Skill generates stubs + barrel registration

---

## Output Groups

Tools are grouped by output type. Verifiers apply to groups:

| Output Group | Example Tools | Verifier |
|--------------|---------------|----------|
| holdings | get_holdings, portfolio_summary | concentration_risk |
| dividends | get_dividends | — |
| performance | portfolio_summary | stale_data |
| quotes | market_data | stale_data |
| * (all) | — | source_attribution |

---

## Configuration

```json
"verification": {
  "enabled": true,
  "verifiersDir": "src/verification",
  "barrelsFile": "src/verification/verifiers.exports.ts"
}
```

---

## Templates

- `templates/verifier-definition.pseudo.ts` — Verifier interface
- `templates/verifiers-barrel.pseudo.ts` — Barrel pattern
- `skills/forge-verifier/references/verifier-stubs.md` — Stub code (source_attribution, concentration_risk, stale_data)
